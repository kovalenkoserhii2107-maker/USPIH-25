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
import { opsListHtml, opsFilterHtml, opsInMonth, opsTotalKop, opsMonthTitle } from './finance-ops.js';

const el = id => document.getElementById(id);
const num = (value, digits = 3) => Number(value).toLocaleString('uk-UA', { maximumFractionDigits: digits });
const TABS = ['money', 'resources'];
const TAB_KEY = 'finance_tab';
const ITEMS_SHOWN = 6;

// undefined — ще вантажиться, null — правління нічого не опублікувало.
let report, reportFailed = false, months, monthsFailed = false;
let tab = 'money', period = null, allItems = false, allExpenses = false, loadRequest = 0;
// Відкрита розшифровка: { key, title, income } або { debt: true }; вибраний місяць, порядок боржників.
let openItem = null, opsMonth = '', debtSort = 'address';
// Операції статей вантажаться при відкритті (finance_ops/{ключ}): key → список | 'loading' | 'error'.
const opsCache = new Map();
const EXPENSES_SHOWN = 8;
const kop = value => formatMoney((Number(value) || 0) / 100);
const CHEVRON = '<svg class="hf-chev" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="9 6 15 12 9 18"></polyline></svg>';

/** Рядок статті: якщо є операції — відкривається розшифровка (expense — ключ exp-…, надходження — inc-…). */
const opensOps = key => Boolean(key && report?.opsIndex?.[key]?.count);
const itemLi = (key, title, inner) => (opensOps(key)
    ? `<li><button type="button" class="hf-open" data-hf-key="${escapeHtml(key)}" data-hf-title="${escapeHtml(title)}">${inner}${CHEVRON}</button></li>`
    : `<li>${inner}</li>`);
const incomeKey = i => (i.source === 'contributions' ? null : `inc-${i.source}`);

/** Надходження: джерела, а внески — за складовими (як «Надходження» в сервісі). */
function incomeListHtml(list) {
    return `<ul class="hf-items">${list.map(i => `${itemLi(incomeKey(i), i.title, `<span class="hf-line"><span class="hf-item-head"><span>${escapeHtml(i.title)}</span><b>${kop(i.factKop)} грн</b></span></span>`)}
        ${(i.parts || []).map(p => itemLi(`inc-c-${p.component}`, p.title, `<span class="hf-line hf-part"><span class="hf-item-head"><span>${escapeHtml(p.title)}</span><b>${kop(p.factKop)} грн</b></span></span>`)).join('')}`).join('')}</ul>`;
}

/**
 * Виконання кошторису: план на рік, «план на сьогодні» й факт за кожною
 * статтею. Звіт формує бухгалтерія застосунку (budgetAction), мешканець
 * бачить лише цифри ОСББ.
 */
function budgetHtml(b) {
    const share = (fact, plan) => (plan > 0 ? Math.round(fact / plan * 100) : null);
    const line = l => {
        const p = share(l.factKop, l.toDateKop);
        return itemLi(`exp-${l.item}`, l.title, `<span class="hf-line"><span class="hf-item-head"><span>${escapeHtml(l.title)}${l.outside ? ' <small class="hf-tag">поза кошторисом</small>' : ''}</span><b>${kop(l.factKop)} грн</b></span>
            ${l.planKop ? `<span class="hf-bar${p > 100 ? ' is-over' : ''}"><i style="width:${Math.min(100, p || 0)}%"></i></span>
            <small>${p === null ? '' : `${p}% від плану на сьогодні · `}план на рік ${kop(l.planKop)} грн</small>` : ''}</span>`);
    };
    return `<section class="card">
        <p class="am-heat-kicker">Кошторис ${escapeHtml(b.year)} року${b.carried ? ' (діє попередній)' : ''}</p>
        <h3 class="am-card-title">Виконання кошторису</h3>
        ${b.sections.map(s => {
            // Статті без витрат за період — одним рядком: довгий список нулів не читається.
            const spent = s.lines.filter(l => l.factKop), idle = s.lines.filter(l => !l.factKop);
            return `<p class="hf-sub">${escapeHtml(s.title)} · ${kop(s.factKop)} з ${kop(s.planKop)} грн</p>
            <ul class="hf-items">${spent.map(line).join('')}</ul>
            ${idle.length ? `<p class="hf-idle">Ще без витрат: ${idle.map(l => escapeHtml(l.title)).join(', ')}</p>` : ''}`;
        }).join('')}
        ${(b.income || []).length ? `<p class="hf-sub">Надходження · ${kop(b.income.reduce((s, i) => s + i.factKop, 0))} грн</p>
            ${incomeListHtml(b.income)}` : ''}
        <p class="hf-footnote is-inside">${b.decision ? `Затверджено: ${escapeHtml(b.decision)}. ` : ''}«План на сьогодні» — частка річного плану за ${b.months} міс. обліку.</p>
    </section>`;
}

/** Витрати з документами: мешканець відкриває рахунок чи акт сам (п. 5.1.1 статуту). */
function expensesHtml(list) {
    const shown = allExpenses ? list : list.slice(0, EXPENSES_SHOWN);
    return `<section class="card">
        <h3 class="am-card-title">Витрати з документами</h3>
        <ul class="hf-docs">${shown.map(e => `<li>
            <div class="hf-item-head"><span><b>${escapeHtml(e.supplier)}</b></span><b>${kop(e.amountKop)} грн</b></div>
            <small>${escapeHtml(String(e.date).split('-').reverse().join('.'))} · ${escapeHtml(e.description)} · ${escapeHtml(e.item)}${e.paid ? '' : ' · до оплати'}</small>
            ${(e.files || []).length ? `<p class="hf-files">${e.files.map(f => `<a href="${escapeHtml(f.url)}" target="_blank" rel="noopener">${escapeHtml(e.doc)}: ${escapeHtml(f.name)}</a>`).join('')}</p>` : ''}
        </li>`).join('')}</ul>
        ${list.length > shown.length ? `<button type="button" class="btn-ghost am-more-btn" data-hf-allexp>Показати всі (${list.length})</button>` : ''}
    </section>`;
}

const skeleton = () => '<section class="card am-skeleton" aria-busy="true" aria-label="Завантаження"><i></i><i></i><i></i></section>';
const notice = text => `<section class="card"><p class="am-empty">${text}</p></section>`;

const backHtml = `<button type="button" class="hf-back" data-hf-back>${CHEVRON}<span>Усі статті</span></button>`;

/** Операції статті з finance_ops: вантажимо раз, при першому відкритті. */
function loadOps(key) {
    if (opsCache.has(key) && opsCache.get(key) !== 'error') return;
    opsCache.set(key, 'loading');
    getDoc(doc(db, 'finance_ops', key)).then(snap => {
        opsCache.set(key, snap.exists() ? snap.data().ops || [] : []);
    }, error => {
        console.error('Розшифровка статті:', error);
        opsCache.set(key, 'error');
    }).then(() => { if (openItem?.key === key && tab === 'money') render(); });
}

/**
 * Розшифровка статті: хто й коли отримав (або заплатив) гроші, з фільтром
 * за місяцем. Фізособи — без імені; квартири — номером лише за рішенням
 * правління: так публікує сервер.
 */
function itemHtml() {
    const { key, title, income } = openItem;
    const state = opsCache.get(key);
    const ready = Array.isArray(state);
    const list = ready ? state : [];
    const shown = opsInMonth(list, opsMonth);
    const index = report.opsIndex?.[key] || {};
    const total = ready ? opsTotalKop(shown) : index.totalKop;
    return `<section class="card hf-op-head">
        ${backHtml}
        <p class="am-heat-kicker">${income ? 'Надходження' : 'Стаття витрат'}</p>
        <h2 class="hf-period">${escapeHtml(title)}</h2>
        <p class="am-heat-amount">${kop(total)}<span> грн</span></p>
        <p class="hf-asof">${opsMonth ? escapeHtml(opsMonthTitle(opsMonth)) : escapeHtml(report.period || '')} · операцій: ${ready ? shown.length : index.count || 0}</p>
        ${ready ? opsFilterHtml(list, opsMonth) : ''}
    </section>
    <section class="card">${state === 'error' ? '<p class="am-empty">Не вдалося завантажити операції. <button type="button" class="btn-ghost" data-hf-retry>Спробувати ще</button></p>'
        : ready ? opsListHtml(shown, { income }) : '<div class="am-skeleton" aria-busy="true" aria-label="Завантаження"><i></i><i></i><i></i></div>'}</section>
    <p class="hf-footnote">${income ? 'Оплати мешканців — за розподілом між статтями, як у квитанції.' : 'Документи (рахунки, акти) — за датою документа, списання без документа — за датою банку.'} Прізвищ не публікуємо.</p>`;
}

/** Заборгованість за приміщеннями (якщо правління вирішило показувати номери): за адресою або за розміром. */
function debtHtml() {
    const list = [...report.debt.list];
    if (debtSort === 'amount') list.sort((a, b) => b.kop - a.kop);
    const sortBtn = (value, label) => `<button type="button" class="fo-chip${debtSort === value ? ' is-active' : ''}" data-hf-debtsort="${value}" aria-pressed="${debtSort === value}">${label}</button>`;
    return `<section class="card hf-op-head">
        ${backHtml}
        <p class="am-heat-kicker">Заборгованість співвласників</p>
        <p class="am-heat-amount">${kop(report.debt.totalKop)}<span> грн</span></p>
        <p class="hf-asof">борг мають ${list.length} прим. · без прізвищ</p>
        <div class="fo-chips" role="group" aria-label="Порядок">${sortBtn('address', 'За адресою')}${sortBtn('amount', 'За розміром боргу')}</div>
    </section>
    <section class="card"><ul class="fo-list">${list.map(d => `<li class="fo-op is-debt">
        <span class="fo-main"><b class="fo-who">${escapeHtml(d.label.replace(/^Під'їзд [^,]+, /, ''))}</b>${d.entrance ? `<small class="fo-note">Під'їзд ${escapeHtml(d.entrance)}</small>` : ''}</span>
        <span class="fo-amount">${kop(d.kop)}<small> грн</small></span></li>`).join('')}</ul></section>`;
}

// ------------------------------------------------------------
// ФІНАНСИ
// ------------------------------------------------------------
function moneyHtml() {
    if (reportFailed) return notice('Не вдалося завантажити звіт. Потягніть екран донизу, щоб оновити.');
    if (report === undefined) return skeleton();
    if (report === null) return notice('Правління ще не опублікувало фінансовий звіт.');
    if (openItem?.debt && report.debt?.list?.length) return debtHtml();
    if (openItem?.key && opensOps(openItem.key)) return itemHtml();
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

    if (report.budget?.sections?.length) parts.push(budgetHtml(report.budget));
    else if (report.incomeItems?.length) {
        parts.push(`<section class="card"><h3 class="am-card-title">Звідки гроші</h3>${incomeListHtml(report.incomeItems)}</section>`);
    }

    if (summary.items.length) {
        const shown = allItems ? summary.items : summary.items.slice(0, ITEMS_SHOWN);
        const max = summary.items[0].amount;
        parts.push(`<section class="card">
            <h3 class="am-card-title">Куди пішли гроші</h3>
            <ul class="hf-items">${shown.map(item => itemLi(item.item && `exp-${item.item}`, item.label, `<span class="hf-line">
                <span class="hf-item-head"><span>${escapeHtml(item.label)}</span><b>${formatMoney(item.amount)} грн</b></span>
                <span class="hf-bar"><i style="width:${item.amount / max * 100}%"></i></span>
                <small>${num(item.share, 1)}% усіх витрат</small></span>`)).join('')}</ul>
            ${summary.items.length > shown.length ? `<button type="button" class="btn-ghost am-more-btn" data-hf-all>Показати всі статті (${summary.items.length})</button>` : ''}
        </section>`);
    }
    if (report.expenses?.length) parts.push(expensesHtml(report.expenses));
    if (report.debt) {
        const list = report.debt.list?.length;
        const body = `<p class="am-heat-kicker">Заборгованість співвласників</p>
            <p class="am-heat-amount">${kop(report.debt.totalKop)}<span> грн</span></p>
            <p class="hf-asof">${report.debt.count ? `борг мають ${report.debt.count} ${report.debt.count === 1 ? 'квартира' : report.debt.count < 5 ? 'квартири' : 'квартир'} — без прізвищ${list ? '' : ' і номерів'}` : 'боргів немає'}</p>`;
        parts.push(list
            ? `<section class="card"><button type="button" class="hf-open hf-debt-open" data-hf-debt><span class="hf-line">${body}</span>${CHEVRON}</button></section>`
            : `<section class="card">${body}</section>`);
    }
    parts.push(`<p class="hf-footnote">Звіт ${report.source === 'ledger' ? 'формує бухгалтерія застосунку' : 'публікує правління'}${updated ? ` · оновлено ${escapeHtml(updated)}` : ''}.</p>`);
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
        if (event.target.closest('[data-hf-allexp]')) { allExpenses = true; render(); return; }
        const open = event.target.closest('[data-hf-key]');
        if (open) {
            const key = open.dataset.hfKey;
            openItem = { key, title: open.dataset.hfTitle, income: key.startsWith('inc-') }; opsMonth = '';
            loadOps(key); render(); window.scrollTo({ top: 0 }); return;
        }
        if (event.target.closest('[data-hf-debt]')) { openItem = { debt: true }; render(); window.scrollTo({ top: 0 }); return; }
        const sort = event.target.closest('[data-hf-debtsort]');
        if (sort) { debtSort = sort.dataset.hfDebtsort; render(); return; }
        if (event.target.closest('[data-hf-retry]')) { loadOps(openItem.key); render(); return; }
        if (event.target.closest('[data-hf-back]')) {
            const back = openItem; openItem = null; render();
            (back?.debt ? panel.querySelector('[data-hf-debt]') : panel.querySelector(`[data-hf-key="${CSS.escape(back?.key || '')}"]`))?.focus();
            return;
        }
        const chip = event.target.closest('[data-fo-month]');
        if (chip) { opsMonth = chip.dataset.foMonth; render(); return; }
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
        opsCache.clear();
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
