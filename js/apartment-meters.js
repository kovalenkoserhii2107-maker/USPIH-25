// ============================================================
// «Мої лічильники»: подання показників світла й води та розрахунок
// тепла для мешканця. Кожен ресурс подається окремо, незбережене
// введення живе в чернетці свого місяця й ресурсу.
// Унизу — список поданих показників квартир для правління.
// ============================================================
import { apartmentMeterStore } from './apartment-meter-store.js';
import { WATER_CHANNELS, apartmentChannels, apartmentChannelName, apartmentChannelSeries,
    apartmentSeries, normalizeApartmentChannel, validateApartmentChanges, consumptionInsight } from './apartment-meter-core.js';
import { METER_RESOURCES, meterSeries, decimalValue, integerReading, apartmentHeatHistory } from './meter-core.js';
import { meterStore } from './meter-store.js';
import { openMeterPicker } from './meter-dial.js';
import { escapeHtml, toast, setBusy, formatDateTime, formatMoney, confirmDialog } from './ui.js';
import { db, currentApt, session } from './firebase.js';
import { ICONS, monthTitle, monthLocative, shiftMonth, chartHtml } from './resident-ui.js';
import { doc, getDocFromServer } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js';

const el = id => document.getElementById(id);
const currentMonth = () => new Date().toLocaleDateString('sv-SE').slice(0, 7);
const num = (value, digits = 6) => Number(value).toLocaleString('uk-UA', { maximumFractionDigits: digits });
const TABS = ['electricity', 'water', 'heat'];
const TAB_KEY = 'meters_tab';
const COPY = {
    electricity: { title: 'Електроенергія', submit: 'Подати показники світла', done: 'Показники світла подано' },
    water: { title: 'Вода', submit: 'Подати показники води', done: 'Показники води подано' }
};
const DIGIT_STRIP = Array.from({ length: 10 }, (_, digit) => `<span>${digit}</span>`).join('');

let context = null, heat = null, heatFailed = false, metersFailed = false;
let period = currentMonth(), tab = 'electricity', saving = false, loadRequest = 0;
let submissionsRequest = 0, submitted = [];
const drafts = new Map(), expandedHistory = new Set();

// ------------------------------------------------------------
// МІСЯЦІ
// ------------------------------------------------------------
function earliestMonth() {
    const recorded = (context?.records || []).map(row => row.period).sort()[0];
    const yearAgo = shiftMonth(currentMonth(), -12);
    return recorded && recorded < yearAgo ? recorded : yearAgo;
}

// ------------------------------------------------------------
// ЧЕРНЕТКИ: один ресурс одного місяця
// ------------------------------------------------------------
const unitOf = resource => METER_RESOURCES[resource].units[0];
const draftKey = resource => `${period}|${resource}`;
const savedRow = (resource, at = period) => context.records.find(row => row.resource === resource && row.period === at) || null;
const previousEntry = (resource, channel, at = period) => apartmentChannelSeries(context.records, resource, channel)
    .filter(row => row.period < at).at(-1) || null;

function channelValue(resource, channel, stored = {}, fallbackName, at = period) {
    const previous = previousEntry(resource, channel, at), reset = stored.reset === true;
    return {
        name: stored.name ?? fallbackName ?? apartmentChannelName(resource, channel),
        reading: stored.reading ?? previous?.reading ?? '',
        baseline: reset ? stored.baseline ?? 0 : previous?.reading ?? stored.baseline ?? '',
        reset, note: stored.note || ''
    };
}

function baseGroup(resource, at = period) {
    const rows = context.records.filter(row => row.resource === resource).sort((a, b) => a.period.localeCompare(b.period));
    const saved = rows.find(row => row.period === at), prior = rows.filter(row => row.period < at).at(-1);
    const stored = saved ? apartmentChannels(saved) : {};
    const layout = saved ? stored : prior ? apartmentChannels(prior) : { main: { name: apartmentChannelName(resource, 'main') } };
    return { channels: Object.fromEntries(Object.entries(layout).map(([channel, settings]) =>
        [channel, channelValue(resource, channel, stored[channel], settings?.name, at)])) };
}

const group = resource => drafts.get(draftKey(resource)) || baseGroup(resource);
function editGroup(resource, mutate) {
    const next = JSON.parse(JSON.stringify(group(resource)));
    mutate(next);
    drafts.set(draftKey(resource), next);
    return next;
}
const changed = (resource, at = period) => {
    const draft = drafts.get(`${at}|${resource}`);
    return Boolean(draft) && JSON.stringify(draft.channels) !== JSON.stringify(baseGroup(resource, at).channels);
};

/** Споживання одного лічильника за обраний місяць або причина, чому його не порахувати. */
function evaluate(resource, channel, value) {
    if (String(value.reading).trim() === '' || String(value.baseline).trim() === '') return { pending: true };
    const unit = unitOf(resource);
    try {
        const clean = normalizeApartmentChannel({ ...value, resource, channel, period, unit });
        const rows = apartmentChannelSeries(context.records, resource, channel).filter(row => row.period !== period);
        const current = meterSeries([...rows, { ...clean, resource, period, tariff: 0, unit }], resource)
            .find(row => row.period === period);
        return current.error ? { error: current.error } : { consumption: current.consumption };
    } catch (error) { return { error: error.message }; }
}

function evaluateGroup(resource) {
    const channels = group(resource).channels;
    const results = Object.entries(channels).map(([channel, value]) => ({ channel, ...evaluate(resource, channel, value) }));
    const ready = results.every(result => result.consumption !== undefined);
    const total = ready ? Math.round(results.reduce((sum, result) => sum + result.consumption, 0) * 1e6) / 1e6 : null;
    return { results, ready, total };
}

// ------------------------------------------------------------
// РОЗМІТКА: введення
// ------------------------------------------------------------
function odometerHtml(reading) {
    const number = integerReading(reading), text = number === null ? '' : String(number);
    const length = Math.max(6, text.length), padded = text.padStart(length, '0'), lead = length - text.length;
    return `<span class="am-digits${number === null ? ' is-empty' : ''}" aria-hidden="true">${[...padded].map((digit, index) =>
        `<span class="am-digit${index < lead ? ' is-lead' : ''}"><span class="am-strip" style="--d:${digit}">${DIGIT_STRIP}</span></span>`).join('')}</span>`;
}

/** Цифри не перемальовуються, а прокручуються: змінюється лише зсув стрічки. */
function updateOdometer(button, reading) {
    const number = integerReading(reading), text = number === null ? '' : String(number);
    const cells = [...button.querySelectorAll('.am-digit')];
    const length = Math.max(6, text.length);
    if (cells.length !== length) { button.querySelector('.am-digits').outerHTML = odometerHtml(reading); return; }
    const padded = text.padStart(length, '0'), lead = length - text.length;
    button.querySelector('.am-digits').classList.toggle('is-empty', number === null);
    cells.forEach((cell, index) => {
        cell.classList.toggle('is-lead', index < lead);
        cell.firstElementChild.style.setProperty('--d', padded[index]);
    });
}

function statusHtml(resource) {
    const saved = savedRow(resource);
    if (saved) {
        const when = saved.updatedAt?.toMillis ? new Date(saved.updatedAt.toMillis()) : null;
        const date = when ? when.toLocaleDateString('uk-UA', { day: 'numeric', month: 'short' }) : '';
        return `<span class="am-status is-done">${ICONS.check}Подано${date ? ` ${escapeHtml(date)}` : ''}</span>`;
    }
    return period === currentMonth() ? '<span class="am-status is-due">Очікує показників</span>' : '<span class="am-status">Не подано</span>';
}

function meterHtml(resource, channel, value, count) {
    const unit = unitOf(resource), previous = previousEntry(resource, channel), locked = previous && !value.reset;
    const title = resource === 'water'
        ? `<input class="am-name" data-am-name value="${escapeHtml(value.name)}" maxlength="60" placeholder="Назва, наприклад «Кухня»" aria-label="Назва водоміра" autocomplete="off">`
        : `<span class="am-meter-name">${escapeHtml(count > 1 ? apartmentChannelName(resource, channel) : 'Показник')}</span>`;
    return `<article class="am-meter" data-am-channel="${channel}">
        <header class="am-meter-head">${title}<span class="am-unit">${escapeHtml(unit)}</span>
            ${resource === 'water' && count > 1 ? `<button type="button" class="am-icon-btn" data-am-remove aria-label="Прибрати водомір «${escapeHtml(value.name)}»">${ICONS.trash}</button>` : ''}</header>
        <button type="button" class="am-odometer" data-am-pick="reading">${odometerHtml(value.reading)}</button>
        <div class="am-stepper">
            <button type="button" class="am-step" data-am-step="-1" aria-label="Зменшити показник на 1">−</button>
            <div class="am-delta" data-am-delta aria-live="polite"></div>
            <button type="button" class="am-step" data-am-step="1" aria-label="Збільшити показник на 1">+</button>
        </div>
        <p class="am-error" data-am-error role="alert" hidden></p>
        <div class="am-prev"><span>Попередній показник${locked ? ` · ${escapeHtml(monthTitle(previous.period).toLowerCase())}` : ''}</span>
            ${locked ? `<b>${num(value.baseline)}</b>` : `<button type="button" class="am-link" data-am-pick="baseline" data-am-baseline></button>`}</div>
        <details class="am-more"${value.reset || value.note ? ' open' : ''}><summary>Заміна лічильника або примітка</summary>
            <label class="am-check"><input type="checkbox" data-am-reset${value.reset ? ' checked' : ''}><span>Лічильник замінено чи обнулено — почати облік заново</span></label>
            <input class="field-input am-note" data-am-note maxlength="500" value="${escapeHtml(value.note)}" placeholder="Примітка для правління" aria-label="Примітка для правління">
        </details>
    </article>`;
}

function entryHtml(resource) {
    const channels = group(resource).channels, keys = Object.keys(channels), resourceInfo = METER_RESOURCES[resource];
    const dual = resource === 'electricity' && keys.includes('day');
    return `<section class="card am-entry" data-am-resource="${resource}" style="--am-color:${resourceInfo.color}">
        <div class="am-entry-head"><h2 class="am-entry-title">${COPY[resource].title}</h2>${statusHtml(resource)}</div>
        ${resource === 'electricity' ? `<div class="segmented am-mode" role="radiogroup" aria-label="Тип електролічильника">
            <button type="button" class="segmented-item${dual ? '' : ' active'}" role="radio" aria-checked="${!dual}" data-am-mode="single">Один тариф</button>
            <button type="button" class="segmented-item${dual ? ' active' : ''}" role="radio" aria-checked="${dual}" data-am-mode="dual">День і ніч</button></div>` : ''}
        <div class="am-meters">${keys.map(channel => meterHtml(resource, channel, channels[channel], keys.length)).join('')}</div>
        ${resource === 'water' && keys.length < WATER_CHANNELS.length ? `<button type="button" class="am-add" data-am-add>${ICONS.plus}Додати водомір</button>` : ''}
        <div class="am-summary" data-am-summary></div>
        <button type="button" class="btn-primary am-submit" data-am-submit></button>
    </section>`;
}

/** Оновлює все, що залежить від значень, не чіпаючи розмітку й фокус. */
function refreshEntry(resource) {
    const section = el('amPanel').querySelector(`[data-am-resource="${resource}"]`);
    if (!section) return;
    const channels = group(resource).channels, unit = unitOf(resource);
    const evaluation = evaluateGroup(resource), multiple = evaluation.results.length > 1;
    evaluation.results.forEach(result => {
        const meter = section.querySelector(`[data-am-channel="${result.channel}"]`), value = channels[result.channel];
        const odometer = meter.querySelector('.am-odometer');
        updateOdometer(odometer, value.reading);
        odometer.setAttribute('aria-label', `Новий показник ${resource === 'water' ? value.name : apartmentChannelName(resource, result.channel)}: ${integerReading(value.reading) ?? 'не вказано'} ${unit}. Змінити`);
        const delta = meter.querySelector('[data-am-delta]'), error = meter.querySelector('[data-am-error]');
        const noBaseline = String(value.baseline).trim() === '';
        delta.innerHTML = result.error ? `<b>—</b><span>${escapeHtml(unit)} за місяць</span>`
            : result.pending ? `<span>${noBaseline ? 'Спочатку вкажіть попередній показник' : 'Торкніться цифр, щоб вказати показник'}</span>`
            : `<b>+${num(result.consumption)}</b><span>${escapeHtml(unit)} за місяць</span>`;
        error.hidden = !result.error; error.textContent = result.error || '';
        const baseline = meter.querySelector('[data-am-baseline]');
        if (baseline) baseline.textContent = noBaseline ? 'Вказати' : `${num(value.baseline)} · змінити`;
        meter.querySelector('[data-am-step="-1"]').disabled = saving || integerReading(value.reading) === null || integerReading(value.reading) === 0;
        meter.querySelector('[data-am-step="1"]').disabled = saving;
    });

    const saved = savedRow(resource), dirty = changed(resource), valid = evaluation.ready;
    // Поки нічого не введено, «на 100% менше» лише лякало б: порівнюємо введене чи вже подане.
    const insight = valid && (saved || dirty) ? consumptionInsight(apartmentSeries(context.records, resource), period, evaluation.total) : null;
    const lines = [];
    if (multiple && valid && (saved || dirty)) lines.push(`<div class="am-total"><span>Разом за ${escapeHtml(monthTitle(period).toLowerCase())}</span><b>${num(evaluation.total)} ${escapeHtml(unit)}</b></div>`);
    if (insight?.unusual) {
        lines.push(`<p class="am-insight is-warn">Це значно більше, ніж зазвичай (у середньому ${num(insight.average, 0)} ${escapeHtml(unit)} на місяць). Перевірте, чи правильно введено цифри.</p>`);
    } else if (insight?.change !== null && insight?.change !== undefined) {
        const same = Math.abs(insight.change) < 3, less = insight.change < 0;
        lines.push(`<p class="am-insight ${same ? '' : less ? 'is-good' : 'is-more'}">${same ? '' : less ? ICONS.down : ICONS.up}${same
            ? `Майже як у ${escapeHtml(monthLocative(insight.previousPeriod))}`
            : `На ${Math.abs(insight.change)}% ${less ? 'менше' : 'більше'}, ніж у ${escapeHtml(monthLocative(insight.previousPeriod))}`}</p>`);
    }
    section.querySelector('[data-am-summary]').innerHTML = lines.join('');

    const button = section.querySelector('[data-am-submit]');
    if (!button.dataset.busy) {
        button.disabled = saving || !valid || (saved && !dirty);
        button.classList.toggle('is-done', Boolean(saved && !dirty));
        button.innerHTML = saved && !dirty ? `${ICONS.check} ${COPY[resource].done}` : saved ? 'Зберегти зміни' : COPY[resource].submit;
    }
    renderTabs();
}

// ------------------------------------------------------------
// РОЗМІТКА: історія й графік
// ------------------------------------------------------------

function listHtml(key, rows) {
    const limit = expandedHistory.has(key) ? rows.length : 6;
    return `<ul class="am-list">${rows.slice(0, limit).map(row => `<li><button type="button" class="am-row${row.period === period ? ' is-current' : ''}" data-am-period="${row.period}"${row.period === period ? ' aria-current="true"' : ''}>
            <span class="am-row-main"><b>${escapeHtml(monthTitle(row.period))}</b>${row.detail ? `<small>${row.detail}</small>` : ''}</span>
            <span class="am-row-value${row.error ? ' is-error' : ''}">${row.value}</span>${ICONS.chevron}</button></li>`).join('')}</ul>
        ${rows.length > limit ? `<button type="button" class="btn-ghost am-more-btn" data-am-expand="${key}">Показати всі місяці (${rows.length})</button>` : ''}`;
}

function historyHtml(resource) {
    const series = apartmentSeries(context.records, resource), unit = unitOf(resource);
    if (!series.length) return '';
    const items = series.slice(-12).map(row => ({ period: row.period, value: row.error ? 0 : row.consumption }));
    const rows = series.slice().reverse().map(row => ({
        period: row.period, error: Boolean(row.error),
        value: row.error ? 'Перевірте' : `${num(row.consumption)} ${escapeHtml(unit)}`,
        detail: row.channelReadings.length > 1
            ? row.channelReadings.map(value => `${escapeHtml(value.name || apartmentChannelName(resource, value.channel))} ${value.error ? '—' : num(value.consumption)}`).join(' · ')
            : `${num(row.channelReadings[0].effectiveBaseline)} → ${num(row.channelReadings[0].reading)}${row.reset ? ' · новий лічильник' : ''}`
    }));
    return `<section class="card am-history"><h3 class="am-card-title">Споживання за місяцями</h3>
        ${chartHtml(items, METER_RESOURCES[resource].color, (value, short) => short ? num(value, 0) : `${num(value)} ${unit}`, period)}
        ${listHtml(resource, rows)}</section>`;
}

// ------------------------------------------------------------
// ТЕПЛО
// ------------------------------------------------------------
function heatHtml() {
    if (heatFailed) return '<section class="card am-heat"><p class="am-empty">Не вдалося прочитати дані для розрахунку тепла. Потягніть екран донизу, щоб оновити.</p></section>';
    if (!heat) return skeletonHtml();
    const history = apartmentHeatHistory(heat.records, heat.area, heat.totalArea);
    const entry = history.find(item => item.row.period === period);
    const latest = history.filter(item => item.calculation).at(-1);
    if (!entry) {
        return `<section class="card am-heat"><p class="am-heat-kicker">Опалення · ${escapeHtml(monthTitle(period).toLowerCase())}</p>
            <p class="am-empty">Правління ще не внесло показники будинкового лічильника тепла за цей місяць.</p>
            ${latest ? `<button type="button" class="btn-soft am-jump" data-am-period="${latest.row.period}">Показати ${escapeHtml(monthTitle(latest.row.period).toLowerCase())}</button>` : ''}</section>`;
    }
    const { row, calculation } = entry;
    if (row.error) return `<section class="card am-heat"><p class="am-heat-kicker">Опалення · ${escapeHtml(monthTitle(period).toLowerCase())}</p><p class="am-empty is-error">${escapeHtml(row.error)}</p></section>`;
    if (!calculation) {
        return `<section class="card am-heat"><p class="am-heat-kicker">Опалення · ${escapeHtml(monthTitle(period).toLowerCase())}</p>
            <p class="am-empty">${decimalValue(heat.area) > 0 ? 'Правління ще не вказало загальну площу будинку, тому частку квартири не порахувати.' : 'Площу вашої квартири ще не внесено до бази. Зверніться до правління.'}</p>
            <div class="am-steps"><div class="am-step-row"><span class="am-step-text">Опалення всього будинку</span><b>${formatMoney(row.cost)} грн</b></div></div></section>`;
    }
    const { cost, perSquareMeter, totalArea, apartmentArea } = calculation;
    const share = Math.min(100, apartmentArea / totalArea * 100);
    const tariff = row.tariff > 0 ? `${num(row.consumption, 3)} ${escapeHtml(row.unit)} × ${formatMoney(row.tariff)} грн` : '';
    return `<section class="card am-heat">
        <p class="am-heat-kicker">Ваша частка за опалення · ${escapeHtml(monthTitle(period).toLowerCase())}</p>
        <p class="am-heat-amount">${formatMoney(cost)}<span> грн</span></p>
        <p class="am-heat-lead">Рахунок за тепло всього будинку ділиться між квартирами пропорційно площі.</p>
        <div class="am-area"><span>Ваша квартира</span><b>${num(apartmentArea)} м²</b><span>з ${num(totalArea)} м² будинку · ${num(share, share < 10 ? 2 : 1)}%</span></div>
        <ol class="am-steps">
            <li class="am-step-row"><span class="am-step-num">1</span><span class="am-step-text">Опалення всього будинку</span><b>${formatMoney(row.cost)} грн</b>${tariff ? `<small>${tariff}</small>` : ''}</li>
            <li class="am-step-row"><span class="am-step-num">2</span><span class="am-step-text">Припадає на 1 м²</span><b>${formatMoney(perSquareMeter)} грн</b><small>${formatMoney(row.cost)} грн ÷ ${num(totalArea)} м²</small></li>
            <li class="am-step-row is-result"><span class="am-step-num">3</span><span class="am-step-text">Ваша квартира</span><b>${formatMoney(cost)} грн</b><small>${formatMoney(perSquareMeter)} грн × ${num(apartmentArea)} м²</small></li>
        </ol>
        <p class="am-footnote">Розрахунок за будинковим лічильником. Остаточна сума — у вашій квитанції.</p>
    </section>`;
}

function heatHistoryHtml() {
    if (!heat) return '';
    const history = apartmentHeatHistory(heat.records, heat.area, heat.totalArea).filter(item => item.calculation);
    if (!history.length) return '';
    const items = history.slice(-12).map(item => ({ period: item.row.period, value: item.calculation.cost }));
    const rows = history.slice().reverse().map(item => ({ period: item.row.period,
        value: `${formatMoney(item.calculation.cost)} грн`,
        detail: `${formatMoney(item.calculation.perSquareMeter)} грн за м²` }));
    return `<section class="card am-history"><h3 class="am-card-title">Опалення за місяцями</h3>
        ${chartHtml(items, METER_RESOURCES.heat.color, (value, short) => short ? num(Math.round(value), 0) : `${formatMoney(value)} грн`, period)}
        ${listHtml('heat', rows)}</section>`;
}

// ------------------------------------------------------------
// ЕКРАН
// ------------------------------------------------------------
const skeletonHtml = () => '<section class="card am-skeleton" aria-busy="true" aria-label="Завантаження"><i></i><i></i><i></i></section>';

function renderTabs() {
    document.querySelectorAll('[data-am-tab]').forEach(button => {
        const active = button.dataset.amTab === tab;
        button.classList.toggle('active', active);
        button.setAttribute('aria-selected', String(active));
        button.tabIndex = active ? 0 : -1;
        const dot = context && button.dataset.amTab !== 'heat' && changed(button.dataset.amTab);
        button.classList.toggle('has-draft', Boolean(dot));
    });
    el('amMonthLabel').textContent = monthTitle(period);
    el('amPrevMonth').disabled = period <= earliestMonth();
    el('amNextMonth').disabled = period >= currentMonth();
}

function render() {
    renderTabs();
    const panel = el('amPanel'), history = el('amHistory');
    if (tab === 'heat') { panel.innerHTML = heatHtml(); history.innerHTML = heatHistoryHtml(); return; }
    if (!context) {
        panel.innerHTML = metersFailed ? '<section class="card"><p class="am-empty">Не вдалося прочитати ваші показники. Потягніть екран донизу, щоб оновити.</p></section>' : skeletonHtml();
        history.innerHTML = ''; return;
    }
    panel.innerHTML = entryHtml(tab);
    refreshEntry(tab);
    history.innerHTML = historyHtml(tab);
}

function setPeriod(next, { scroll = false } = {}) {
    if (saving || next > currentMonth() || next === period) return;
    period = next; render();
    if (scroll) el('metersSection').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function setTab(next) {
    if (!TABS.includes(next) || next === tab) return;
    tab = next;
    try { localStorage.setItem(TAB_KEY, tab); } catch { /* вкладка — лише зручність */ }
    render();
}

async function apartmentArea(apt) {
    if (decimalValue(session.area) > 0) return session.area;
    const snap = await getDocFromServer(doc(db, 'apartments', apt));
    return snap.data()?.area;
}

export async function loadApartmentMeters() {
    const request = ++loadRequest, apt = String(currentApt() || '');
    if (context && context.apt !== apt) { context = null; heat = null; drafts.clear(); expandedHistory.clear(); }
    metersFailed = false; heatFailed = false;
    render();
    const heatTask = Promise.all([meterStore.load(), apartmentArea(apt)]).then(([data, area]) => {
        if (request !== loadRequest) return;
        heat = { ...data, area };
        if (tab === 'heat') render();
    }, () => {
        if (request !== loadRequest) return;
        heatFailed = true; if (tab === 'heat') render();
    });
    try {
        const fresh = await apartmentMeterStore.load();
        if (request !== loadRequest || fresh.apt !== String(currentApt() || '')) return;
        context = fresh;
        if (tab !== 'heat') render(); else renderTabs();
    } catch (error) {
        if (request !== loadRequest) return;
        metersFailed = true; if (tab !== 'heat') render();
        toast(error.code === 'permission-denied' ? 'Особисті показники поки недоступні. Зверніться до правління' : error.message, 'error');
    } finally { await heatTask; }
}

// ------------------------------------------------------------
// ДІЇ
// ------------------------------------------------------------
function setValue(resource, channel, field, value) {
    editGroup(resource, next => { next.channels[channel][field] = value; });
    refreshEntry(resource);
}

function pick(resource, channel, field, returnFocus) {
    const value = group(resource).channels[channel], unit = unitOf(resource);
    const name = resource === 'water' ? value.name : apartmentChannelName(resource, channel);
    const reading = field === 'reading';
    openMeterPicker({
        value: reading ? (value.reading === '' ? value.baseline : value.reading) : value.baseline,
        title: name || 'Водомір',
        subtitle: reading ? `Новий показник${String(value.baseline).trim() !== '' ? ` · попередній ${num(value.baseline)} ${unit}` : ''}` : 'Попередній показник',
        preview: number => {
            const result = evaluate(resource, channel, { ...value, [field]: number });
            return result.error || (result.pending ? '' : `Спожито за місяць: ${num(result.consumption)} ${unit}`);
        },
        onApply: number => setValue(resource, channel, field, number),
        returnFocus
    });
}

function step(button, size = 1) {
    const resource = button.closest('[data-am-resource]').dataset.amResource, channel = button.closest('[data-am-channel]').dataset.amChannel;
    const value = group(resource).channels[channel];
    const current = integerReading(value.reading) ?? integerReading(value.baseline) ?? 0;
    const next = Math.max(0, Math.min(1e10, current + Number(button.dataset.amStep) * size));
    if (next !== current) setValue(resource, channel, 'reading', next);
}

/** Утримання «+»/«−» прискорює крок, як у системних лічильниках. */
function holdStep(button) {
    let timer = null, ticks = 0;
    const stop = () => { clearTimeout(timer); ['pointerup', 'pointercancel', 'pointerleave'].forEach(type => button.removeEventListener(type, stop)); };
    const repeat = () => { ticks += 1; step(button, ticks > 25 ? 10 : 1); timer = setTimeout(repeat, Math.max(45, 160 - ticks * 8)); };
    step(button);
    timer = setTimeout(repeat, 420);
    ['pointerup', 'pointercancel', 'pointerleave'].forEach(type => button.addEventListener(type, stop));
}

function switchMode(mode) {
    const keys = mode === 'dual' ? ['day', 'night'] : ['main'];
    const current = group('electricity').channels;
    if (Object.keys(current).join() === keys.join()) return;
    const saved = savedRow('electricity'), stored = saved ? apartmentChannels(saved) : {};
    editGroup('electricity', next => {
        next.channels = Object.fromEntries(keys.map(key => [key, current[key] || channelValue('electricity', key, stored[key])]));
    });
    render();
}

function addWater() {
    let added = null;
    editGroup('water', next => {
        added = WATER_CHANNELS.find(channel => !(channel in next.channels));
        if (added) next.channels[added] = channelValue('water', added);
    });
    render();
    const name = el('amPanel').querySelector(`[data-am-channel="${added}"] [data-am-name]`);
    name?.focus(); name?.select();
}

async function removeWater(channel) {
    const name = group('water').channels[channel]?.name || 'Водомір';
    if (!await confirmDialog('Прибрати водомір?', `«${name}» не буде в показниках за ${monthTitle(period).toLowerCase()}. Попередні місяці не зміняться.`, 'Прибрати')) return;
    editGroup('water', next => { if (Object.keys(next.channels).length > 1) delete next.channels[channel]; });
    render();
}

function toggleReset(resource, channel, checked) {
    const previous = previousEntry(resource, channel), saved = savedRow(resource);
    editGroup(resource, next => {
        const value = next.channels[channel];
        value.reset = checked;
        value.baseline = checked ? 0 : previous?.reading ?? (saved ? apartmentChannels(saved)[channel]?.baseline : '') ?? '';
    });
    const meter = el('amPanel').querySelector(`[data-am-resource="${resource}"] [data-am-channel="${channel}"]`);
    const channels = group(resource).channels;
    meter.outerHTML = meterHtml(resource, channel, channels[channel], Object.keys(channels).length);
    refreshEntry(resource);
    el('amPanel').querySelector(`[data-am-channel="${channel}"] [data-am-reset]`)?.focus();
}

async function submit(resource, button) {
    if (saving || !context) return;
    const change = { resource, period, unit: unitOf(resource), channels: group(resource).channels };
    try {
        validateApartmentChanges(context.records, [change]);
        saving = true; setBusy(button, true, 'Надсилаємо…');
        el('amPanel').querySelectorAll('button, input').forEach(control => { if (control !== button) control.disabled = true; });
        context = await apartmentMeterStore.save(context, [change]);
        drafts.delete(draftKey(resource));
        saving = false; render();
        el('amPanel').querySelector('.am-status')?.classList.add('is-new');
        toast(COPY[resource].done, 'success');
    } catch (error) {
        saving = false; setBusy(button, false);
        if (tab === resource) render();
        toast(error.code === 'permission-denied' ? 'Правлінню потрібно опублікувати оновлений файл firestore.rules для нових лічильників' : error.message, 'error');
    } finally { saving = false; }
}

function initResident() {
    const panel = el('amPanel');
    if (!panel || panel.dataset.initialized) return;
    panel.dataset.initialized = '1';
    try { const stored = localStorage.getItem(TAB_KEY); if (TABS.includes(stored)) tab = stored; } catch { /* немає сховища */ }

    const tabs = el('amTabs');
    tabs.addEventListener('click', event => { const button = event.target.closest('[data-am-tab]'); if (button) setTab(button.dataset.amTab); });
    tabs.addEventListener('keydown', event => {
        if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
        event.preventDefault();
        const next = TABS[(TABS.indexOf(tab) + (event.key === 'ArrowRight' ? 1 : TABS.length - 1)) % TABS.length];
        setTab(next); tabs.querySelector(`[data-am-tab="${next}"]`).focus();
    });
    el('amPrevMonth').addEventListener('click', () => setPeriod(shiftMonth(period, -1)));
    el('amNextMonth').addEventListener('click', () => setPeriod(shiftMonth(period, 1)));

    panel.addEventListener('pointerdown', event => {
        const button = event.target.closest('[data-am-step]');
        if (!button || button.disabled || saving || event.button > 0) return;
        event.preventDefault(); holdStep(button);
    });
    panel.addEventListener('click', event => {
        const section = event.target.closest('[data-am-resource]'), meter = event.target.closest('[data-am-channel]');
        const resource = section?.dataset.amResource, channel = meter?.dataset.amChannel;
        const target = event.target.closest('[data-am-step], [data-am-pick], [data-am-mode], [data-am-add], [data-am-remove], [data-am-submit], [data-am-period]');
        if (!target || saving) return;
        if (target.matches('[data-am-step]')) {
            // Мишу й дотик обробляє pointerdown; сюди доходить клавіатура.
            if (event.detail === 0) step(target);
        } else if (target.matches('[data-am-pick]')) pick(resource, channel, target.dataset.amPick, target);
        else if (target.matches('[data-am-mode]')) switchMode(target.dataset.amMode);
        else if (target.matches('[data-am-add]')) addWater();
        else if (target.matches('[data-am-remove]')) removeWater(channel);
        else if (target.matches('[data-am-submit]')) submit(resource, target);
        else if (target.matches('[data-am-period]')) setPeriod(target.dataset.amPeriod);
    });
    panel.addEventListener('input', event => {
        const section = event.target.closest('[data-am-resource]'), meter = event.target.closest('[data-am-channel]');
        if (!section || !meter || saving) return;
        if (event.target.matches('[data-am-name]')) setValue(section.dataset.amResource, meter.dataset.amChannel, 'name', event.target.value);
        if (event.target.matches('[data-am-note]')) setValue(section.dataset.amResource, meter.dataset.amChannel, 'note', event.target.value);
    });
    panel.addEventListener('change', event => {
        if (!event.target.matches('[data-am-reset]') || saving) return;
        toggleReset(event.target.closest('[data-am-resource]').dataset.amResource, event.target.closest('[data-am-channel]').dataset.amChannel, event.target.checked);
    });
    el('amHistory').addEventListener('click', event => {
        const expand = event.target.closest('[data-am-expand]');
        if (expand) { expandedHistory.add(expand.dataset.amExpand); render(); return; }
        const row = event.target.closest('[data-am-period]');
        if (row) setPeriod(row.dataset.amPeriod, { scroll: true });
    });
}

// ------------------------------------------------------------
// ПРАВЛІННЯ: подані показники квартир
// ------------------------------------------------------------
function channelHistory(row) {
    return row.channelReadings.map(value => `<p><b>${escapeHtml(value.name || apartmentChannelName(row.resource, value.channel))}:</b>
        ${num(value.effectiveBaseline)} → ${num(value.reading)} ${escapeHtml(row.unit)} · ${value.error ? escapeHtml(value.error) : `спожито ${num(value.consumption)} ${escapeHtml(row.unit)}`}${value.reset ? ' · новий лічильник' : ''}</p>
        ${value.note ? `<p>${escapeHtml(value.note)}</p>` : ''}`).join('')
        + (row.channelReadings.length > 1 ? `<p><b>Разом спожито: ${num(row.consumption)} ${escapeHtml(row.unit)}</b></p>` : '');
}

function renderSubmissions() {
    const host = el('apartmentSubmissions'), term = el('apartmentSubmissionsSearch').value.trim().toLowerCase();
    const filtered = submitted.filter(row => row.apt.toLowerCase().includes(term)).sort((a, b) => a.apt.localeCompare(b.apt, 'uk', { numeric: true }) || a.resource.localeCompare(b.resource));
    host.innerHTML = `<p class="field-hint">Подано записів: ${submitted.length}</p>` + (filtered.length ? filtered.map(row => {
        const summary = apartmentSeries([row], row.resource)[0];
        return `<article class="meter-history-row"><div class="meter-history-head"><b>Кв. ${escapeHtml(row.apt)} · ${METER_RESOURCES[row.resource]?.label || escapeHtml(row.resource)}</b></div>
            ${channelHistory(summary)}<small>${escapeHtml(formatDateTime(row.updatedAt))}</small></article>`;
    }).join('') : '<p class="list-empty">Поданих показників за цей місяць немає.</p>');
}

export async function loadApartmentSubmissions() {
    const request = ++submissionsRequest, host = el('apartmentSubmissions');
    submitted = []; host.innerHTML = '<p class="list-empty">Завантаження…</p>';
    try {
        const rows = await apartmentMeterStore.submissions(el('apartmentSubmissionsPeriod').value);
        if (request !== submissionsRequest) return;
        submitted = rows; renderSubmissions();
    } catch (error) { if (request !== submissionsRequest) return; submitted = []; host.innerHTML = '<p class="list-empty">Не вдалося прочитати показники квартир.</p>'; toast(error.message, 'error'); }
}

function initAdmin() {
    const period = el('apartmentSubmissionsPeriod');
    if (!period || period.dataset.initialized) return;
    period.dataset.initialized = '1'; period.value = currentMonth();
    period.addEventListener('change', loadApartmentSubmissions);
    el('apartmentSubmissionsSearch').addEventListener('input', renderSubmissions);
    el('apartmentSubmissionsRefreshBtn').addEventListener('click', loadApartmentSubmissions);
}

export function initApartmentMeters() {
    initResident();
    initAdmin();
}

