import { meterStore } from './meter-store.js';
import { METER_RESOURCES, meterSeries, periodLabel, normalizeMeterReading, validateMeterChanges, integerReading, decimalValue, readingTariff } from './meter-core.js';
import { enhanceMeterInputs, syncMeterDial } from './meter-dial.js';
import { escapeHtml, toast, setBusy, formatMoney } from './ui.js';

let context = { revision: 0, records: [] };
let loaded = false, saving = false;
const dirty = new Set();
const drafts = new Map();
const views = { admin: { period: '' } };
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
        const midMonth = (context.tariffs || []).some(row => (row.resource || 'heat') === key && row.effectiveFrom.startsWith(period) && row.effectiveFrom > `${period}-01`);
        return `<fieldset class="meter-entry-card" data-resource="${key}">
            <legend><span class="meter-dot" style="background:${resource.color}"></span>${resource.label}</legend>
            <div class="meter-entry-grid">
                <label class="field meter-reading-field meter-previous-field"><span class="field-label">Попередній показник</span>
                    <input class="field-input" data-field="baseline" inputmode="numeric" value="${escapeHtml(reset ? current.baseline : prior?.reading ?? current?.baseline ?? '')}"
                        ${prior && !reset ? 'readonly' : ''} placeholder="Початок обліку"></label>
                <label class="field meter-reading-field meter-new-field"><span class="field-label">Новий показник</span>
                    <input class="field-input" data-field="reading" inputmode="numeric" value="${escapeHtml(current?.reading ?? '')}" placeholder="Нові показання"></label>
                <label class="field meter-unit-field"><span class="field-label">Одиниця вимірювання</span>
                    <select class="field-input field-select" data-field="unit" ${prior && !reset ? 'disabled' : ''}>
                        ${resource.units.map(value => `<option ${value === unit ? 'selected' : ''}>${value}</option>`).join('')}</select></label>
            </div>
            ${key === 'heat' ? `<p class="field-hint">Загальна площа будинку: ${context.totalArea ? `${num(context.totalArea)} м²` : 'вкажіть у полі вище'}. Вартість за м² розраховується автоматично. <a href="https://www.teplo.od.ua" target="_blank" rel="noopener noreferrer">ТГО Одеси</a></p>` : ''}
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
    const resource = card.dataset.resource, period = document.getElementById('meterPeriod').value;
    const series = meterSeries(context.records, resource);
    const tariff = readingTariff(context.tariffs || [], resource, period, field('unit').value,
        series.find(row => row.period === period), series.filter(row => row.period < period).at(-1));
    return { resource, period,
        reading: field('reading').value, baseline: field('baseline').value, tariff: tariff ?? '',
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
        const values = readCard(card);
        if (decimalValue(values.tariff) === null) throw new Error(`Внесіть тариф і дату його дії для «${METER_RESOURCES[values.resource].label}» у блоці «Тарифи ресурсів будинку»`);
        const input = normalizeMeterReading(values);
        if (integerReading(input.reading) === null) throw new Error('Новий показник вводиться лише цілим числом');
        const next = context.records.filter(row => !(row.resource === input.resource && row.period === input.period));
        next.push(input);
        const row = meterSeries(next, input.resource).find(row => row.period === input.period);
        if (row.error) throw new Error(row.error);
        host.textContent = `Витрата: ${num(row.consumption)} ${row.unit} · Вартість: ${formatMoney(row.cost)} грн`;
        host.classList.remove('is-error');
    } catch (error) { host.textContent = error.message; host.classList.add('is-error'); }
}

function renderStats(view) {
    const host = document.getElementById('meterStatistics');
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
    const host = document.getElementById('meterStatistics');
    try {
        if (view === 'admin') await meterStore.syncTotalArea();
        context = await meterStore.load();
        loaded = true;
        if (view === 'admin') { renderEntry(); renderSettings(); }
        renderStats(view);
        return true;
    } catch (error) {
        if (host) host.innerHTML = '<p class="list-empty">Не вдалося завантажити показники. Спробуйте оновити.</p>';
        toast(error.message || 'Помилка завантаження показників', 'error');
        loaded = false;
        if (view === 'admin') renderSettings();
        return false;
    }
}
export const loadAdminMeters = () => load('admin');

function disableSettings(disabled) {
    for (const id of ['meterTariffFields', 'houseAreaFields']) document.getElementById(id).disabled = disabled;
}

function renderSettings() {
    const host = document.getElementById('meterTariffEntry');
    if (!host.children.length) host.innerHTML = Object.entries(METER_RESOURCES).map(([key, resource]) => `
        <div class="meter-tariff-card" data-tariff-resource="${key}">
            <h4><span class="meter-dot" style="background:${resource.color}"></span>${resource.label}</h4>
            <div class="admin-document-grid"><label class="field"><span class="field-label">Тариф, грн/${resource.units[0]}</span>
                <input class="field-input" data-tariff-value inputmode="decimal" placeholder="З рахунку постачальника"></label>
                <label class="field"><span class="field-label">Діє з</span><input class="field-input" data-tariff-from type="date" value="${todayPeriod()}-01"></label></div>
            <button type="button" class="btn-soft btn-compact" data-tariff-save>Зберегти тариф</button>
        </div>`).join('');
    const history = [], today = new Date().toLocaleDateString('sv-SE');
    for (const [key, resource] of Object.entries(METER_RESOURCES)) {
        const rows = (context.tariffs || []).filter(row => (row.resource || 'heat') === key)
            .sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom));
        const card = host.querySelector(`[data-tariff-resource="${key}"]`);
        if (!card.dataset.dirty && rows.length) {
            const current = rows.find(row => row.effectiveFrom <= today) || rows.at(-1);
            card.querySelector('[data-tariff-value]').value = current.tariff;
            card.querySelector('[data-tariff-from]').value = current.effectiveFrom;
        }
        for (const row of rows) history.push(`<p>${resource.label}: ${num(row.tariff)} грн/${resource.units[0]} · діє з ${escapeHtml(row.effectiveFrom.split('-').reverse().join('.'))}</p>`);
    }
    document.getElementById('meterTariffHistory').innerHTML = history.length
        ? `<details class="meter-extra"><summary>Збережені тарифи · ${history.length}</summary>${history.join('')}</details>`
        : '<p class="field-hint">До внесення датованих тарифів використовуються ціни з попередніх записів.</p>';
    const area = document.getElementById('houseTotalArea');
    if (!area.dataset.dirty) area.value = context.totalArea ?? '';
    document.getElementById('houseAreaHint').textContent = context.areaSource === 'manual'
        ? 'Площу вказало правління. Оновлення Довідника її не змінює.'
        : 'Початкове значення — сума площ квартир із Довідника. Ви можете вказати загальну площу вручну.';
    disableSettings(!loaded || saving);
}

async function saveSetting(button, operation, success) {
    if (!loaded || saving) return;
    try {
        saving = true; setBusy(button, true, 'Збереження…'); disableSettings(true);
        document.getElementById('meterInputFields').disabled = true;
        context = await operation();
        renderEntry(); renderSettings(); renderStats('admin');
        toast(success, 'success');
    } catch (error) { toast(error.message || 'Не вдалося зберегти', 'error'); }
    finally {
        saving = false; disableSettings(!loaded);
        document.getElementById('meterInputFields').disabled = false; setBusy(button, false);
    }
}

async function save(btn) {
    if (!loaded || saving) return;
    try {
        const changes = [...document.querySelectorAll('.meter-entry-card')].map(readCard).filter(input => {
            if (dirty.has(input.resource)) return true;
            const saved = context.records.find(row => row.resource === input.resource && row.period === input.period);
            return saved && (decimalValue(input.tariff) !== decimalValue(saved.tariff)
                || input.resource === 'heat' && decimalValue(input.totalArea) !== decimalValue(saved.totalArea));
        });
        if (changes.some(input => decimalValue(input.tariff) === null)) throw new Error('Внесіть тариф і дату його дії у блоці «Тарифи ресурсів будинку»');
        validateMeterChanges(context.records, changes);
        if (!changes.length) return toast('Внесіть нові показники або змініть запис', 'error');
        saving = true;
        setBusy(btn, true, 'Збереження…');
        document.getElementById('meterInputFields').disabled = true;
        disableSettings(true);
        context = await meterStore.save(context, changes);
        drafts.delete(document.getElementById('meterPeriod').value);
        dirty.clear();
        renderEntry({ remember: false }); renderStats('admin');
        toast('Показники збережено', 'success');
    } catch (error) { toast(error.message || 'Не вдалося зберегти показники', 'error'); }
    finally { saving = false; document.getElementById('meterInputFields').disabled = false; disableSettings(!loaded); setBusy(btn, false); }
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
        document.getElementById('meterTariffEntry').addEventListener('input', event => {
            const card = event.target.closest('[data-tariff-resource]');
            if (card) card.dataset.dirty = '1';
        });
        document.getElementById('meterTariffEntry').addEventListener('click', event => {
            const button = event.target.closest('[data-tariff-save]');
            if (!button) return;
            const card = button.closest('[data-tariff-resource]');
            saveSetting(button, () => meterStore.saveTariff(context, { resource: card.dataset.tariffResource,
                tariff: card.querySelector('[data-tariff-value]').value,
                effectiveFrom: card.querySelector('[data-tariff-from]').value }), 'Тариф і дату початку дії збережено');
        });
        document.getElementById('houseTotalArea').addEventListener('input', function () { this.dataset.dirty = '1'; });
        document.getElementById('houseAreaSaveBtn').addEventListener('click', function () {
            saveSetting(this, () => meterStore.saveTotalArea(context, document.getElementById('houseTotalArea').value), 'Загальну площу будинку збережено');
        });
        renderSettings();
    }
    for (const [view, id] of [['admin', 'meterStatistics']]) {
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
