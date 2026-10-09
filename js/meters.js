import { meterStore } from './meter-store.js';
import { METER_RESOURCES, meterSeries, periodLabel, normalizeMeterReading, validateMeterChanges, apartmentHeatCalculation, integerReading, decimalValue, heatTariffForPeriod } from './meter-core.js';
import { enhanceMeterInputs, syncMeterDial } from './meter-dial.js';
import { db, currentApt } from './firebase.js';
import { doc, getDocFromServer } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js';
import { escapeHtml, toast, setBusy, formatMoney } from './ui.js';

let context = { revision: 0, records: [] };
let loaded = false, saving = false;
const dirty = new Set();
const drafts = new Map();
const views = { admin: { period: '' }, resident: { period: '' } };
let heatRequest = 0;
const num = value => Number(value).toLocaleString('uk-UA', { maximumFractionDigits: 6 });
const todayPeriod = () => new Date().toLocaleDateString('sv-SE').slice(0, 7);

function renderEntry({ remember = true } = {}) {
    const host = document.getElementById('meterEntry');
    if (!host) return;
    if (remember && host.dataset.period && dirty.size) {
        const previousDraft = drafts.get(host.dataset.period) || new Map();
        host.querySelectorAll('.meter-entry-card').forEach(card => {
            if (dirty.has(card.dataset.resource)) previousDraft.set(card.dataset.resource, { ...readCard(card), period: host.dataset.period });
        });
        drafts.set(host.dataset.period, previousDraft);
    }
    dirty.clear();
    const period = document.getElementById('meterPeriod').value;
    const periodDrafts = drafts.get(period) || new Map();
    periodDrafts.forEach((_, resource) => dirty.add(resource));
    host.dataset.period = period;
    host.innerHTML = Object.entries(METER_RESOURCES).map(([key, resource]) => {
        const series = meterSeries(context.records, key);
        const saved = series.find(row => row.period === period);
        const current = periodDrafts.has(key) ? { ...saved, ...periodDrafts.get(key) } : saved;
        const prior = series.filter(row => row.period < period).at(-1);
        const reset = current?.reset === true;
        const unit = current?.unit || prior?.unit || resource.units[0];
        const scheduled = key === 'heat' && unit === 'Гкал' ? heatTariffForPeriod(context.heatTariffs || [], period) : null;
        const midMonth = key === 'heat' && (context.heatTariffs || []).some(row => row.effectiveFrom.startsWith(period) && row.effectiveFrom > `${period}-01`);
        return `<fieldset class="meter-entry-card" data-resource="${key}">
            <legend><span class="meter-dot" style="background:${resource.color}"></span>${resource.label}</legend>
            <div class="meter-entry-grid">
                <label class="field meter-reading-field meter-previous-field"><span class="field-label">Попередній показник</span>
                    <input class="field-input" data-field="baseline" inputmode="numeric" value="${escapeHtml(reset ? current.baseline : prior?.reading ?? current?.baseline ?? '')}"
                        ${prior && !reset ? 'readonly' : ''} placeholder="Початок обліку"></label>
                <label class="field meter-reading-field meter-new-field"><span class="field-label">Новий показник</span>
                    <input class="field-input" data-field="reading" inputmode="numeric" value="${escapeHtml(current?.reading ?? '')}" placeholder="Нові показання"></label>
                <label class="field"><span class="field-label" data-meter-tariff-label>Тариф, грн/${escapeHtml(unit)}</span>
                    <input class="field-input" data-field="tariff" inputmode="decimal" value="${escapeHtml(current?.tariff ?? scheduled?.tariff ?? prior?.tariff ?? '')}" placeholder="Тариф цього місяця"></label>
                <label class="field"><span class="field-label">Одиниця вимірювання</span>
                    <select class="field-input field-select" data-field="unit" ${prior && !reset ? 'disabled' : ''}>
                        ${resource.units.map(value => `<option ${value === unit ? 'selected' : ''}>${value}</option>`).join('')}</select></label>
            </div>
            ${key === 'heat' ? `<p class="field-hint">Загальна площа з бази: ${context.totalArea ? `${num(context.totalArea)} м²` : 'площу внесено не для всіх квартир'}. Вкажіть тариф за ${escapeHtml(unit)} з рахунку постачальника. Вартість за м² розраховується автоматично. <a href="https://www.teplo.od.ua" target="_blank" rel="noopener noreferrer">ТГО Одеси</a></p>` : ''}
            ${midMonth ? '<p class="field-hint">Тариф змінюється всередині цього місяця. Перевірте тариф за місяць у рахунку постачальника.</p>' : ''}
            <label class="meter-reset"><input type="checkbox" data-field="reset" ${reset ? 'checked' : ''}> Заміна / обнулення лічильника</label>
            <label class="field"><span class="field-label">Примітка (за потреби)</span>
                <input class="field-input" data-field="note" maxlength="500" value="${escapeHtml(current?.note || '')}" placeholder="Номер приладу, заміна, уточнення"></label>
            <p class="meter-preview" aria-live="polite"></p>
        </fieldset>`;
    }).join('');
    enhanceMeterInputs(host);
    host.querySelectorAll('.meter-entry-card').forEach(updatePreview);
}

function readCard(card) {
    const field = name => card.querySelector(`[data-field="${name}"]`);
    return { resource: card.dataset.resource, period: document.getElementById('meterPeriod').value,
        reading: field('reading').value, baseline: field('baseline').value, tariff: field('tariff').value,
        unit: field('unit').value, reset: field('reset').checked, note: field('note').value,
        ...(card.dataset.resource === 'heat' ? { totalArea: context.totalArea } : {}) };
}

function updatePreview(card) {
    const host = card.querySelector('.meter-preview');
    if (!card.querySelector('[data-field="reading"]').value.trim()) {
        host.textContent = 'Витрата = поточний − попередній показник. Вартість = витрата × тариф.';
        host.classList.remove('is-error');
        return;
    }
    try {
        const input = normalizeMeterReading(readCard(card));
        if (integerReading(input.reading) === null) throw new Error('Новий показник вводиться лише цілим числом');
        const next = context.records.filter(row => !(row.resource === input.resource && row.period === input.period));
        next.push(input);
        const row = meterSeries(next, input.resource).find(row => row.period === input.period);
        if (row.error) throw new Error(row.error);
        host.textContent = `Витрата: ${num(row.consumption)} ${row.unit} · Вартість: ${formatMoney(row.cost)} грн`;
        host.classList.remove('is-error');
    } catch (error) { host.textContent = error.message; host.classList.add('is-error'); }
}

function renderHeatSummary(period, data, area) {
    const host = document.getElementById('apartmentHeatEstimate');
    if (!host) return;
    const row = meterSeries(data.records, 'heat').find(row => row.period === period);
    const calculation = apartmentHeatCalculation(row, area, data.totalArea);
    const title = `<h3>Тепло за площею</h3><p class="field-hint">${escapeHtml(periodLabel(period))}</p>`;
    if (!row) { host.innerHTML = title + '<p class="field-hint">За цей місяць правління ще не внесло показники тепла.</p>'; return; }
    if (row.error) { host.innerHTML = title + `<p class="meter-error">${escapeHtml(row.error)}</p>`; return; }
    if (!calculation) {
        host.innerHTML = title + `<p class="field-hint">${decimalValue(area) > 0 ? 'Потрібно оновити загальну площу будинку: правління має заповнити відсутні площі у Довіднику. Сума оновиться автоматично.' : 'Площа вашої квартири ще не внесена до бази. Зверніться до правління.'}</p>`;
        return;
    }
    const { cost, volume, perSquareMeter, totalArea, apartmentArea } = calculation;
    host.innerHTML = title + `<div class="heat-share"><strong>${formatMoney(cost)} грн</strong><span>за вашу квартиру</span></div>
        <dl class="heat-breakdown"><div><dt>Площа квартири</dt><dd>${num(apartmentArea)} м²</dd></div>
        <div><dt>Вартість 1 м² за місяць</dt><dd>${Number(perSquareMeter).toLocaleString('uk-UA', { maximumFractionDigits: 4 })} грн/м²</dd></div>
        <div><dt>Частка споживання</dt><dd>${num(volume)} ${escapeHtml(row.unit)}</dd></div>
        <div><dt>Тариф у записі правління</dt><dd>${num(row.tariff)} грн/${escapeHtml(row.unit)}</dd></div></dl>
        <details class="meter-extra"><summary>Як розраховано</summary><p class="field-hint">${num(row.consumption)} ${escapeHtml(row.unit)} × ${num(row.tariff)} грн/${escapeHtml(row.unit)} × ${num(apartmentArea)} м² / ${num(totalArea)} м² загальної площі будинку.</p><a href="https://www.teplo.od.ua" target="_blank" rel="noopener noreferrer">Тарифи ТГО Одеси</a></details>`;
}

function renderStats(view) {
    const host = document.getElementById(view === 'admin' ? 'meterStatistics' : 'residentMeterStatistics');
    if (!host) return;
    const periods = [...new Set(context.records.map(row => row.period))].sort().reverse();
    const options = views[view];
    if (!periods.includes(options.period)) options.period = periods[0] || '';
    if (!periods.length) { host.innerHTML = '<p class="list-empty">Загальнобудинкові показники ще не внесено.</p>'; return; }
    const rows = Object.entries(METER_RESOURCES).map(([key, resource]) => ({ key, resource,
        row: meterSeries(context.records, key).find(row => row.period === options.period) }));
    const total = rows.reduce((sum, { row }) => sum + (row && !row.error ? row.cost : 0), 0);
    host.innerHTML = `<label class="field"><span class="field-label">Місяць</span><select class="field-input field-select" data-house-period>${periods.map(period => `<option value="${period}" ${period === options.period ? 'selected' : ''}>${escapeHtml(periodLabel(period))}</option>`).join('')}</select></label>
        <div class="house-summary">${rows.map(({ key, resource, row }) => `<article class="house-summary-row">
            <div><b><span class="meter-dot" style="background:${resource.color}"></span>${resource.label}</b><p>${!row ? 'Ще не внесено' : row.error ? escapeHtml(row.error) : `${num(row.consumption)} ${escapeHtml(row.unit)} · тариф ${num(row.tariff)} грн/${escapeHtml(row.unit)}`}</p></div>
            <strong>${row && !row.error ? `${formatMoney(row.cost)} грн` : '—'}</strong>
            ${row ? `<details><summary>Показники${row.note ? ' та примітка' : ''}</summary><p>${num(row.effectiveBaseline)} → ${num(row.reading)} ${escapeHtml(row.unit)}${row.reset ? ' · новий лічильник' : ''}</p>${row.note ? `<p>${escapeHtml(row.note)}</p>` : ''}${view === 'admin' ? `<button type="button" class="btn-soft btn-compact" data-meter-edit="${row.period}">Редагувати</button>` : ''}</details>` : ''}
        </article>`).join('')}</div><div class="house-summary-total"><span>Разом за внесеними ресурсами</span><b>${formatMoney(total)} грн</b></div>`;
}

async function load(view) {
    const host = document.getElementById(view === 'admin' ? 'meterStatistics' : 'residentMeterStatistics');
    try {
        if (view === 'admin') await meterStore.syncTotalArea();
        context = await meterStore.load();
        loaded = true;
        if (view === 'admin') { renderEntry(); renderHeatTariffs(); }
        renderStats(view);
        return true;
    } catch (error) {
        if (host) host.innerHTML = '<p class="list-empty">Не вдалося завантажити показники. Спробуйте оновити.</p>';
        toast(error.message || 'Помилка завантаження показників', 'error');
        loaded = false;
        if (view === 'admin') renderHeatTariffs();
        return false;
    }
}
export const loadAdminMeters = () => load('admin');
export const loadResidentMeters = () => load('resident');

function renderHeatTariffs() {
    const rows = (context.heatTariffs || []).slice().sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom));
    const host = document.getElementById('heatTariffHistory');
    if (!host) return;
    host.innerHTML = rows.length ? `<details class="meter-extra"><summary>Збережені тарифи · ${rows.length}</summary>${rows.map(row => `<p>${num(row.tariff)} грн/Гкал · діє з ${escapeHtml(row.effectiveFrom.split('-').reverse().join('.'))}</p>`).join('')}</details>` : '<p class="field-hint">Датований тариф ще не внесено. Показники використовують тариф свого запису.</p>';
    const fieldset = document.getElementById('heatTariffFields');
    if (fieldset) {
        fieldset.disabled = !loaded || saving;
        if (!fieldset.dataset.dirty && rows.length) {
            const today = new Date().toLocaleDateString('sv-SE');
            const current = rows.find(row => row.effectiveFrom <= today) || rows.at(-1);
            document.getElementById('heatTariffValue').value = current.tariff;
            document.getElementById('heatTariffFrom').value = current.effectiveFrom;
        }
    }
}

async function saveHeatTariff(button) {
    if (!loaded || saving) return;
    try {
        saving = true; setBusy(button, true, 'Збереження…');
        document.getElementById('heatTariffFields').disabled = true;
        document.getElementById('meterInputFields').disabled = true;
        context = await meterStore.saveHeatTariff(context, { tariff: document.getElementById('heatTariffValue').value,
            effectiveFrom: document.getElementById('heatTariffFrom').value });
        renderEntry(); renderHeatTariffs(); renderStats('admin');
        toast('Тариф і дату початку дії збережено', 'success');
    } catch (error) { toast(error.message || 'Не вдалося зберегти тариф', 'error'); }
    finally {
        saving = false; document.getElementById('heatTariffFields').disabled = !loaded;
        document.getElementById('meterInputFields').disabled = false; setBusy(button, false);
    }
}

export async function loadApartmentHeat(period) {
    const host = document.getElementById('apartmentHeatEstimate');
    if (!host) return;
    const request = ++heatRequest, apt = currentApt();
    host.innerHTML = '<h3>Тепло за площею</h3><p class="list-empty">Завантаження…</p>';
    try {
        const [data, snap] = await Promise.all([meterStore.load(), getDocFromServer(doc(db, 'apartments', apt))]);
        if (request !== heatRequest || apt !== currentApt()) return;
        renderHeatSummary(period, data, snap.data()?.area);
    } catch {
        if (request === heatRequest && apt === currentApt()) host.innerHTML = '<h3>Тепло за площею</h3><p class="field-hint">Не вдалося прочитати дані для розрахунку тепла. Натисніть «Оновити».</p>';
    }
}

async function save(btn) {
    if (!loaded || saving) return;
    try {
        const changes = [...document.querySelectorAll('.meter-entry-card')]
            .filter(card => dirty.has(card.dataset.resource)).map(readCard);
        validateMeterChanges(context.records, changes);
        if (!changes.length) return toast('Внесіть нові показники або змініть запис', 'error');
        saving = true;
        setBusy(btn, true, 'Збереження…');
        document.getElementById('meterInputFields').disabled = true;
        document.getElementById('heatTariffFields').disabled = true;
        context = await meterStore.save(context, changes);
        drafts.delete(document.getElementById('meterPeriod').value);
        dirty.clear();
        renderEntry({ remember: false }); renderStats('admin');
        toast('Показники й тарифи збережено', 'success');
    } catch (error) { toast(error.message || 'Не вдалося зберегти показники', 'error'); }
    finally { saving = false; document.getElementById('meterInputFields').disabled = false; document.getElementById('heatTariffFields').disabled = !loaded; setBusy(btn, false); }
}

export function initMeters() {
    const period = document.getElementById('meterPeriod');
    if (period && !period.dataset.initialized) {
        period.dataset.initialized = '1'; period.value = todayPeriod();
        period.addEventListener('change', () => { if (!saving) renderEntry(); });
        document.getElementById('meterEntry').addEventListener('input', event => {
            const card = event.target.closest('.meter-entry-card');
            if (!card || saving) return;
            dirty.add(card.dataset.resource);
            if (event.target.dataset.field === 'reset') {
                const reset = event.target.checked;
                const prior = meterSeries(context.records, card.dataset.resource).filter(row => row.period < period.value).at(-1);
                const baseline = card.querySelector('[data-field="baseline"]');
                baseline.readOnly = !!prior && !reset;
                const current = context.records.find(row => row.resource === card.dataset.resource && row.period === period.value);
                baseline.value = reset ? '0' : prior?.reading ?? current?.baseline ?? '';
                syncMeterDial(baseline);
                card.querySelector('[data-field="unit"]').disabled = !!prior && !reset;
            }
            updatePreview(card);
            card.querySelector('[data-meter-tariff-label]').textContent = `Тариф, грн/${card.querySelector('[data-field="unit"]').value}`;
        });
        document.getElementById('meterSaveBtn').addEventListener('click', function () { save(this); });
        document.getElementById('meterRefreshBtn').addEventListener('click', () => { if (!saving) loadAdminMeters(); });
        document.getElementById('heatTariffFrom').value = `${todayPeriod()}-01`;
        document.getElementById('heatTariffFields').addEventListener('input', function () { this.dataset.dirty = '1'; });
        document.getElementById('heatTariffSaveBtn').addEventListener('click', function () { saveHeatTariff(this); });
    }
    for (const [view, id] of [['admin', 'meterStatistics'], ['resident', 'residentMeterStatistics']]) {
        const host = document.getElementById(id);
        if (!host || host.dataset.initialized) continue;
        host.dataset.initialized = '1';
        host.addEventListener('change', event => {
            if (event.target.matches('[data-house-period]')) views[view].period = event.target.value;
            renderStats(view);
        });
        host.addEventListener('click', event => {
            const edit = event.target.closest('[data-meter-edit]');
            if (view === 'admin' && edit && !saving) {
                period.value = edit.dataset.meterEdit; renderEntry();
                document.getElementById('meterEntry').scrollIntoView({ behavior: 'smooth', block: 'start' });
            }
        });
    }
}
