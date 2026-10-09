// ============================================================
// «Фінанси будинку»: звіт правління про гроші ОСББ і витрати
// ресурсів будинку. Дві вкладки, кожна вантажиться незалежно й
// показується, щойно прийшли її дані.
// ============================================================
import { db } from './firebase.js';
import { doc, getDoc } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js';
import { meterStore } from './meter-store.js';
import { METER_RESOURCES } from './meter-core.js';
import { financeSummary, houseResourceMonths, costChange } from './finance-core.js';
import { escapeHtml, formatMoney, formatDateTime } from './ui.js';
import { ICONS, monthTitle, monthGenitive, chartHtml } from './resident-ui.js';

const el = id => document.getElementById(id);
const num = (value, digits = 3) => Number(value).toLocaleString('uk-UA', { maximumFractionDigits: digits });
const TABS = ['money', 'resources'];
const TAB_KEY = 'finance_tab';
const ITEMS_SHOWN = 6;

// undefined — ще вантажиться, null — правління нічого не опублікувало.
let report, reportFailed = false, months, monthsFailed = false;
let tab = 'money', period = null, allItems = false, loadRequest = 0;

const skeleton = () => '<section class="card am-skeleton" aria-busy="true" aria-label="Завантаження"><i></i><i></i><i></i></section>';
const notice = text => `<section class="card"><p class="am-empty">${text}</p></section>`;

// ------------------------------------------------------------
// ФІНАНСИ
// ------------------------------------------------------------
function moneyHtml() {
    if (reportFailed) return notice('Не вдалося завантажити звіт. Потягніть екран донизу, щоб оновити.');
    if (report === undefined) return skeleton();
    if (report === null) return notice('Правління ще не опублікувало фінансовий звіт.');
    const summary = financeSummary(report);
    const updated = report.updatedAt ? formatDateTime(report.updatedAt) : '';
    const parts = [];

    if (summary.funds !== null) {
        parts.push(`<section class="card hf-hero">
            <p class="am-heat-kicker">На рахунку ОСББ</p>
            <p class="am-heat-amount">${formatMoney(summary.funds)}<span> грн</span></p>
            ${summary.fundsDate ? `<p class="hf-asof">станом на ${escapeHtml(summary.fundsDate)}</p>` : ''}
        </section>`);
    }

    const over = summary.difference !== null && summary.difference < 0;
    parts.push(`<section class="card">
        <p class="am-heat-kicker">Звіт за період</p>
        <h2 class="hf-period">${escapeHtml(summary.period || 'Поточний період')}</h2>
        <div class="hf-flows">
            ${summary.income === null ? '' : `<div class="hf-flow is-in"><span>Надійшло</span><b>${formatMoney(summary.income)}</b><small>грн</small></div>`}
            <div class="hf-flow is-out"><span>Витрачено</span><b>${formatMoney(summary.spent)}</b><small>грн</small></div>
        </div>
        ${summary.spentShare === null ? '' : `<div class="hf-meter${over ? ' is-over' : ''}" role="img" aria-label="Витрачено ${num(summary.spentShare, 0)}% надходжень"><i style="width:${Math.min(100, summary.spentShare)}%"></i></div>
        <p class="hf-meter-note${over ? ' is-over' : ''}">${over
            ? `Витрати перевищили надходження на ${formatMoney(-summary.difference)} грн`
            : `Витрачено ${num(summary.spentShare, 0)}% зібраного · лишилося ${formatMoney(summary.difference)} грн`}</p>`}
    </section>`);

    if (summary.items.length) {
        const shown = allItems ? summary.items : summary.items.slice(0, ITEMS_SHOWN);
        const max = summary.items[0].amount;
        parts.push(`<section class="card">
            <h3 class="am-card-title">Куди пішли гроші</h3>
            <ul class="hf-items">${shown.map(item => `<li>
                <div class="hf-item-head"><span>${escapeHtml(item.label)}</span><b>${formatMoney(item.amount)} грн</b></div>
                <div class="hf-bar"><i style="width:${item.amount / max * 100}%"></i></div>
                <small>${num(item.share, 1)}% усіх витрат</small></li>`).join('')}</ul>
            ${summary.items.length > shown.length ? `<button type="button" class="btn-ghost am-more-btn" data-hf-all>Показати всі статті (${summary.items.length})</button>` : ''}
        </section>`);
    }
    parts.push(`<p class="hf-footnote">Звіт публікує правління${updated ? ` · оновлено ${escapeHtml(updated)}` : ''}.</p>`);
    return parts.join('');
}

// ------------------------------------------------------------
// РЕСУРСИ БУДИНКУ
// ------------------------------------------------------------
function resourcesHtml() {
    if (monthsFailed) return notice('Не вдалося завантажити показники будинку. Потягніть екран донизу, щоб оновити.');
    if (months === undefined) return skeleton();
    if (!months.length) return notice('Правління ще не вносило показники будинкових лічильників.');
    const index = months.findIndex(month => month.period === period), month = months[index];
    const filled = month.rows.filter(({ row }) => row && !row.error && row.cost > 0);

    const rows = month.rows.map(({ resource, label, row }) => {
        const unit = row?.unit || METER_RESOURCES[resource].units[0], change = costChange(months, period, resource);
        const detail = !row ? 'Ще не внесено' : row.error ? escapeHtml(row.error)
            : `${num(row.consumption)} ${escapeHtml(unit)}${row.tariff > 0 ? ` × ${formatMoney(row.tariff)} грн` : ''}`;
        const trend = change && Math.abs(change.change) >= 3
            ? `<small class="${change.change < 0 ? 'is-good' : 'is-more'}">${change.change < 0 ? ICONS.down : ICONS.up}${Math.abs(change.change)}% до ${escapeHtml(monthGenitive(change.period))}</small>` : '';
        return `<li class="hf-res${!row || row.error ? ' is-missing' : ''}" style="--am-color:${METER_RESOURCES[resource].color}">
            <span class="hf-res-dot" aria-hidden="true"></span>
            <span class="hf-res-main"><b>${label}</b><small class="${row?.error ? 'is-error' : ''}">${detail}</small></span>
            <span class="hf-res-value">${row && !row.error ? `<b>${formatMoney(row.cost)} грн</b>${trend}` : '<b>—</b>'}</span></li>`;
    }).join('');

    const items = months.slice(-12).map(item => ({ period: item.period, value: item.total }));
    return `<div class="am-month" role="group" aria-label="Місяць">
            <button type="button" class="am-month-step" data-hf-step="-1" aria-label="Попередній місяць"${index <= 0 ? ' disabled' : ''}>${ICONS.chevron.replace('class="am-chevron"', 'class="hf-flip"')}</button>
            <span class="am-month-label" aria-live="polite">${escapeHtml(monthTitle(period))}</span>
            <button type="button" class="am-month-step" data-hf-step="1" aria-label="Наступний місяць"${index >= months.length - 1 ? ' disabled' : ''}>${ICONS.chevron.replace('class="am-chevron"', '')}</button>
        </div>
        <section class="card">
            <p class="am-heat-kicker">Ресурси будинку за місяць</p>
            <p class="am-heat-amount">${formatMoney(month.total)}<span> грн</span></p>
            ${filled.length > 1 ? `<div class="hf-stack" role="img" aria-label="Частки ресурсів у сумі">${filled.map(({ resource, row }) =>
                `<i style="flex:${row.cost} 1 0;--am-color:${METER_RESOURCES[resource].color}"></i>`).join('')}</div>` : ''}
            <ul class="hf-resources">${rows}</ul>
            <p class="hf-footnote is-inside">За будинковими лічильниками й тарифами, які вносить правління. Вашу частку за тепло видно в «Мої лічильники».</p>
        </section>
        ${items.length > 1 ? `<section class="card am-history"><h3 class="am-card-title">Ресурси за місяцями</h3>
            ${chartHtml(items, '#007AFF', (value, short) => short ? num(Math.round(value), 0) : `${formatMoney(value)} грн`, period)}</section>` : ''}`;
}

// ------------------------------------------------------------
// ЕКРАН
// ------------------------------------------------------------
function render() {
    document.querySelectorAll('[data-hf-tab]').forEach(button => {
        const active = button.dataset.hfTab === tab;
        button.classList.toggle('active', active);
        button.setAttribute('aria-selected', String(active));
        button.tabIndex = active ? 0 : -1;
    });
    el('hfPanel').innerHTML = tab === 'money' ? moneyHtml() : resourcesHtml();
}

function setTab(next) {
    if (!TABS.includes(next) || next === tab) return;
    tab = next;
    try { localStorage.setItem(TAB_KEY, tab); } catch { /* вкладка — лише зручність */ }
    render();
}

function init() {
    const panel = el('hfPanel');
    if (!panel || panel.dataset.initialized) return;
    panel.dataset.initialized = '1';
    try { const stored = localStorage.getItem(TAB_KEY); if (TABS.includes(stored)) tab = stored; } catch { /* немає сховища */ }
    const tabs = el('hfTabs');
    tabs.addEventListener('click', event => { const button = event.target.closest('[data-hf-tab]'); if (button) setTab(button.dataset.hfTab); });
    tabs.addEventListener('keydown', event => {
        if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
        event.preventDefault();
        setTab(tab === 'money' ? 'resources' : 'money');
        tabs.querySelector(`[data-hf-tab="${tab}"]`).focus();
    });
    panel.addEventListener('click', event => {
        if (event.target.closest('[data-hf-all]')) { allItems = true; render(); return; }
        const step = event.target.closest('[data-hf-step]');
        if (step && months?.length) {
            const index = months.findIndex(month => month.period === period) + Number(step.dataset.hfStep);
            if (months[index]) { period = months[index].period; render(); }
            return;
        }
        const bar = event.target.closest('[data-am-period]');
        if (bar && months?.some(month => month.period === bar.dataset.amPeriod)) { period = bar.dataset.amPeriod; render(); }
    });
}

/** Обидві частини вантажаться паралельно й малюються, щойно готові. */
export async function loadHouseFinance({ tab: openTab } = {}) {
    init();
    if (TABS.includes(openTab)) tab = openTab;
    const request = ++loadRequest;
    reportFailed = false; monthsFailed = false;
    render();
    const reportTask = getDoc(doc(db, 'finance', 'current')).then(snap => {
        if (request !== loadRequest) return;
        report = snap.exists() ? snap.data() : null;
        if (tab === 'money') render();
    }, error => {
        if (request !== loadRequest) return;
        console.error('Фінанси ОСББ:', error);
        reportFailed = report === undefined; if (tab === 'money') render();
    });
    const monthsTask = meterStore.load().then(data => {
        if (request !== loadRequest) return;
        months = houseResourceMonths(data.records);
        if (!months.some(month => month.period === period)) period = months.at(-1)?.period ?? null;
        if (tab === 'resources') render();
    }, error => {
        if (request !== loadRequest) return;
        console.error('Ресурси будинку:', error);
        monthsFailed = months === undefined; if (tab === 'resources') render();
    });
    await Promise.all([reportTask, monthsTask]);
}
