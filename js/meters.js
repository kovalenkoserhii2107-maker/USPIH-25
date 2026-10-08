import { meterStore } from './meter-store.js';
import { METER_RESOURCES, meterSeries, periodLabel, normalizeMeterReading, validateMeterChanges } from './meter-core.js';
import { escapeHtml, toast, setBusy, formatMoney } from './ui.js';

let context = { revision: 0, records: [] };
let loaded = false, saving = false;
const dirty = new Set();
const drafts = new Map();
const views = { admin: { resource: 'electricity', year: '', metric: 'consumption' },
    resident: { resource: 'electricity', year: '', metric: 'consumption' } };
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
                <label class="field"><span class="field-label">Попередній / початковий показник</span>
                    <input class="field-input" data-field="baseline" inputmode="decimal" value="${escapeHtml(reset ? current.baseline : prior?.reading ?? current?.baseline ?? '')}"
                        ${prior && !reset ? 'readonly' : ''} placeholder="Початок обліку"></label>
                <label class="field"><span class="field-label">Поточний показник</span>
                    <input class="field-input" data-field="reading" inputmode="decimal" value="${escapeHtml(current?.reading ?? '')}" placeholder="Нові показання"></label>
                <label class="field"><span class="field-label">Тариф, грн за одиницю</span>
                    <input class="field-input" data-field="tariff" inputmode="decimal" value="${escapeHtml(current?.tariff ?? prior?.tariff ?? '')}" placeholder="Тариф цього місяця"></label>
                <label class="field"><span class="field-label">Одиниця вимірювання</span>
                    <select class="field-input field-select" data-field="unit" ${prior && !reset ? 'disabled' : ''}>
                        ${resource.units.map(value => `<option ${value === unit ? 'selected' : ''}>${value}</option>`).join('')}</select></label>
            </div>
            <label class="meter-reset"><input type="checkbox" data-field="reset" ${reset ? 'checked' : ''}> Заміна / обнулення лічильника</label>
            <label class="field"><span class="field-label">Примітка (за потреби)</span>
                <input class="field-input" data-field="note" maxlength="500" value="${escapeHtml(current?.note || '')}" placeholder="Номер приладу, заміна, уточнення"></label>
            <p class="meter-preview" aria-live="polite"></p>
        </fieldset>`;
    }).join('');
    host.querySelectorAll('.meter-entry-card').forEach(updatePreview);
}

function readCard(card) {
    const field = name => card.querySelector(`[data-field="${name}"]`);
    return { resource: card.dataset.resource, period: document.getElementById('meterPeriod').value,
        reading: field('reading').value, baseline: field('baseline').value, tariff: field('tariff').value,
        unit: field('unit').value, reset: field('reset').checked, note: field('note').value };
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
        const next = context.records.filter(row => !(row.resource === input.resource && row.period === input.period));
        next.push(input);
        const row = meterSeries(next, input.resource).find(row => row.period === input.period);
        if (row.error) throw new Error(row.error);
        host.textContent = `Витрата: ${num(row.consumption)} ${row.unit} · Вартість: ${formatMoney(row.cost)} грн`;
        host.classList.remove('is-error');
    } catch (error) { host.textContent = error.message; host.classList.add('is-error'); }
}

function renderStats(view) {
    const host = document.getElementById(view === 'admin' ? 'meterStatistics' : 'residentMeterStatistics');
    if (!host) return;
    const options = views[view];
    const resource = METER_RESOURCES[options.resource];
    const all = meterSeries(context.records, options.resource);
    const years = [...new Set(all.map(row => row.period.slice(0, 4)))].sort().reverse();
    if (options.year && !years.includes(options.year)) options.year = '';
    const selected = (options.year ? all.filter(row => row.period.startsWith(options.year)) : all.slice(-12));
    const unit = selected.at(-1)?.unit || all.at(-1)?.unit || resource.units[0];
    const comparable = selected.filter(row => !row.error && row.unit === unit);
    const consumption = comparable.reduce((sum, row) => sum + row.consumption, 0);
    const cost = selected.filter(row => !row.error).reduce((sum, row) => sum + row.cost, 0);
    const chartRows = options.metric === 'cost' ? selected.filter(row => !row.error) : comparable;
    const max = Math.max(1, ...chartRows.map(row => row[options.metric]));
    host.innerHTML = `<div class="meter-stats-controls">
        <label class="field"><span class="field-label">Ресурс</span><select class="field-input field-select" data-meter-resource>
            ${Object.entries(METER_RESOURCES).map(([key, data]) => `<option value="${key}" ${key === options.resource ? 'selected' : ''}>${data.label}</option>`).join('')}
        </select></label>
        <label class="field"><span class="field-label">Період</span><select class="field-input field-select" data-meter-year>
            <option value="">Останні 12 записів</option>${years.map(year => `<option ${year === options.year ? 'selected' : ''}>${year}</option>`).join('')}
        </select></label>
    </div>
    ${!all.length ? '<p class="list-empty">Показники цього ресурсу ще не внесено.</p>' : `
        <div class="meter-totals"><div><small>Витрата за вибраний період</small><b>${num(consumption)} ${unit}</b></div>
            <div><small>Розрахункова вартість</small><b>${formatMoney(cost)} грн</b></div></div>
        <div class="segmented meter-metric">${[['consumption', 'Витрата'], ['cost', 'Вартість']].map(([key, label]) =>
            `<button type="button" data-meter-metric="${key}" aria-pressed="${key === options.metric}" class="segmented-item ${key === options.metric ? 'active' : ''}">${label}</button>`).join('')}</div>
        <div class="meter-chart" role="img" aria-label="${resource.label}: ${options.metric === 'cost' ? 'вартість у гривнях' : `витрата у ${unit}`} між внесеннями показників">
            ${chartRows.map(row => `<div class="meter-bar-column" title="${escapeHtml(`${periodLabel(row.period)}: ${num(row[options.metric])} ${options.metric === 'cost' ? 'грн' : row.unit}`)}">
                <span>${num(row[options.metric])}</span><div class="meter-bar-track"><i style="height:${Math.max(1, row[options.metric] / max * 100)}%;background:${resource.color}"></i></div>
                <small>${row.period.slice(5)}/${row.period.slice(2, 4)}</small></div>`).join('')}
        </div>
        <p class="field-hint">Витрата між внесеннями показників. Тариф зберігається для кожного місяця.${
            new Set(selected.map(row => row.unit)).size > 1 ? ` Витрату показано в ${unit}; вартість охоплює всі одиниці.` : ''}</p>
        <div class="meter-history">${selected.slice().reverse().map(row => `<article class="meter-history-row">
            <div class="meter-history-head"><b>${escapeHtml(periodLabel(row.period))}</b><strong>${row.error ? 'Перевірте дані' : `${formatMoney(row.cost)} грн`}</strong></div>
            <p>${num(row.effectiveBaseline)} → ${num(row.reading)} ${escapeHtml(row.unit)}${row.error ? '' : ` · витрата ${num(row.consumption)} ${escapeHtml(row.unit)}`}</p>
            <small>Тариф ${num(row.tariff)} грн/${escapeHtml(row.unit)}${row.previousPeriod ? ` · від ${escapeHtml(periodLabel(row.previousPeriod))}` : ' · початок обліку'}${row.reset ? ' · новий лічильник' : ''}</small>
            ${row.note ? `<p>${escapeHtml(row.note)}</p>` : ''}${row.error ? `<p class="meter-error">${escapeHtml(row.error)}</p>` : ''}
            ${view === 'admin' ? `<button class="btn-soft btn-compact" type="button" data-meter-edit="${row.period}">Редагувати показники</button>` : ''}
        </article>`).join('')}</div>`}`;
}

async function load(view) {
    const host = document.getElementById(view === 'admin' ? 'meterStatistics' : 'residentMeterStatistics');
    try {
        context = await meterStore.load();
        loaded = true;
        if (view === 'admin') renderEntry();
        renderStats(view);
    } catch (error) {
        if (host) host.innerHTML = '<p class="list-empty">Не вдалося завантажити показники. Спробуйте оновити.</p>';
        toast(error.message || 'Помилка завантаження показників', 'error');
    }
}
export const loadAdminMeters = () => load('admin');
export const loadResidentMeters = () => load('resident');

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
            if (event.target.matches('[data-meter-resource]')) views[view].resource = event.target.value;
            if (event.target.matches('[data-meter-year]')) views[view].year = event.target.value;
            renderStats(view);
        });
        host.addEventListener('click', event => {
            const metric = event.target.closest('[data-meter-metric]');
            if (metric) { views[view].metric = metric.dataset.meterMetric; renderStats(view); }
            const edit = event.target.closest('[data-meter-edit]');
            if (view === 'admin' && edit && !saving) {
                period.value = edit.dataset.meterEdit; renderEntry();
                document.getElementById('meterEntry').scrollIntoView({ behavior: 'smooth', block: 'start' });
            }
        });
    }
}
