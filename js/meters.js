import { meterStore } from './meter-store.js';
import { METER_RESOURCES, meterSeries, periodLabel, normalizeMeterReading, validateMeterChanges, apartmentHeatShare, integerReading } from './meter-core.js';
import { enhanceMeterInputs, syncMeterDial } from './meter-dial.js';
import { db, currentApt } from './firebase.js';
import { doc, getDocFromServer } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js';
import { escapeHtml, toast, setBusy, formatMoney } from './ui.js';

let context = { revision: 0, records: [] };
let loaded = false, saving = false;
const dirty = new Set();
const drafts = new Map();
const views = { admin: { period: '' }, resident: { period: '' } };
let apartmentArea = null;
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
        return `<fieldset class="meter-entry-card" data-resource="${key}">
            <legend><span class="meter-dot" style="background:${resource.color}"></span>${resource.label}</legend>
            <div class="meter-entry-grid">
                <label class="field meter-reading-field meter-previous-field"><span class="field-label">Попередній показник</span>
                    <input class="field-input" data-field="baseline" inputmode="numeric" value="${escapeHtml(reset ? current.baseline : prior?.reading ?? current?.baseline ?? '')}"
                        ${prior && !reset ? 'readonly' : ''} placeholder="Початок обліку"></label>
                <label class="field meter-reading-field meter-new-field"><span class="field-label">Новий показник</span>
                    <input class="field-input" data-field="reading" inputmode="numeric" value="${escapeHtml(current?.reading ?? '')}" placeholder="Нові показання"></label>
                <label class="field"><span class="field-label">Тариф, грн за одиницю</span>
                    <input class="field-input" data-field="tariff" inputmode="decimal" value="${escapeHtml(current?.tariff ?? prior?.tariff ?? '')}" placeholder="Тариф цього місяця"></label>
                <label class="field"><span class="field-label">Одиниця вимірювання</span>
                    <select class="field-input field-select" data-field="unit" ${prior && !reset ? 'disabled' : ''}>
                        ${resource.units.map(value => `<option ${value === unit ? 'selected' : ''}>${value}</option>`).join('')}</select></label>
            </div>
            ${key === 'heat' ? `<p class="field-hint">Загальна площа з бази: ${context.totalArea ? `${num(context.totalArea)} м²` : 'площу внесено не для всіх квартир'}. Частка тепла рахується за площею квартири.</p>` : ''}
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

function renderHeatSummary() {
    const host = document.getElementById('apartmentHeatEstimate');
    if (!host) return;
    const row = meterSeries(context.records, 'heat').find(row => row.period === views.resident.period);
    const share = apartmentHeatShare(row, apartmentArea, context.totalArea);
    host.innerHTML = `<h3>Тепло для вашої квартири</h3>${!row ? '<p class="field-hint">За цей місяць показників тепла ще немає.</p>'
        : share === null ? '<p class="field-hint">Для розрахунку потрібна площа квартири та загальна площа будинку з бази.</p>'
        : `<div class="heat-share"><strong>${formatMoney(share)} грн</strong><span>${escapeHtml(periodLabel(row.period))}</span></div><p class="field-hint">${num(apartmentArea)} м² квартири / ${num(context.totalArea)} м² будинку × ${formatMoney(row.cost)} грн за тепло.</p>`}`;
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
            <div><b><span class="meter-dot" style="background:${resource.color}"></span>${resource.label}</b><p>${!row ? 'Ще не внесено' : row.error ? escapeHtml(row.error) : `${num(row.consumption)} ${escapeHtml(row.unit)} · тариф ${num(row.tariff)} грн`}</p></div>
            <strong>${row && !row.error ? `${formatMoney(row.cost)} грн` : '—'}</strong>
            ${row ? `<details><summary>Показники${row.note ? ' та примітка' : ''}</summary><p>${num(row.effectiveBaseline)} → ${num(row.reading)} ${escapeHtml(row.unit)}${row.reset ? ' · новий лічильник' : ''}</p>${row.note ? `<p>${escapeHtml(row.note)}</p>` : ''}${view === 'admin' ? `<button type="button" class="btn-soft btn-compact" data-meter-edit="${row.period}">Редагувати</button>` : ''}</details>` : ''}
        </article>`).join('')}</div><div class="house-summary-total"><span>Разом за внесеними ресурсами</span><b>${formatMoney(total)} грн</b></div>`;
    if (view === 'resident') renderHeatSummary();
}

async function load(view) {
    const host = document.getElementById(view === 'admin' ? 'meterStatistics' : 'residentMeterStatistics');
    try {
        if (view === 'admin') await meterStore.syncTotalArea();
        context = await meterStore.load();
        loaded = true;
        if (view === 'admin') renderEntry();
        renderStats(view);
        return true;
    } catch (error) {
        if (host) host.innerHTML = '<p class="list-empty">Не вдалося завантажити показники. Спробуйте оновити.</p>';
        toast(error.message || 'Помилка завантаження показників', 'error');
        loaded = false;
        return false;
    }
}
export const loadAdminMeters = () => load('admin');
export const loadResidentMeters = () => load('resident');

export async function loadHouseActivity() {
    const host = document.getElementById('apartmentHeatEstimate');
    apartmentArea = null;
    try {
        const [fresh, snap] = await Promise.all([loadResidentMeters(), getDocFromServer(doc(db, 'apartments', currentApt()))]);
        if (!fresh) throw new Error('Показники недоступні');
        apartmentArea = snap.data()?.area;
        renderHeatSummary();
    } catch {
        if (host) host.innerHTML = '<p class="field-hint">Не вдалося прочитати дані для розрахунку тепла.</p>';
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
        context = await meterStore.save(context, changes);
        drafts.delete(document.getElementById('meterPeriod').value);
        dirty.clear();
        renderEntry({ remember: false }); renderStats('admin');
        toast('Показники й тарифи збережено', 'success');
    } catch (error) { toast(error.message || 'Не вдалося зберегти показники', 'error'); }
    finally { saving = false; document.getElementById('meterInputFields').disabled = false; setBusy(btn, false); }
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
        });
        document.getElementById('meterSaveBtn').addEventListener('click', function () { save(this); });
        document.getElementById('meterRefreshBtn').addEventListener('click', () => { if (!saving) loadAdminMeters(); });
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
