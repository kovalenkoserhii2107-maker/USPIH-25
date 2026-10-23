// ============================================================
// «Банк»: гроші ОСББ на рахунках ПриватБанку.
//
// Вгорі — залишки й що потребує уваги (рішення, підпис голови, нові
// контрагенти, ризики YouControl), рух коштів за період: звідки прийшли
// й куди пішли. Нижче — три вкладки: операції за днями, операції, що
// чекають рішення, і контрагенти з виписки з досьє YouControl.
//
// Операція й контрагент відкриваються збоку; з них — переходи до квартири,
// договору, документа, проводки, платіжного доручення. Кнопка «← Назад»
// повертає на те саме місце. Логіка — bank-view-core.js.
// «Налаштування» банку — buh-settings.js.
// ============================================================
import { escapeHtml, toast, setBusy, confirmDialog } from './ui.js';
import {
    loadSettings, loadPage, loadQueue, loadPayments, loadExpenses,
    act, expAct, money, signed, when, dateOnly, maskIban, ACCOUNT_PURPOSES
} from './buh-data.js';
import { toKop, fmtKop, periodName } from './charges-core.js';
import {
    DATE_PRESETS, BANK_CATEGORY_OPTIONS, CP_FILTERS, CP_ROLES,
    byDay, quickAssign, filterTx, txCategoryKey, txCategoryInfo, txDistributionInfo,
    describeTxAccountingEntry, resolveTxLinks, bankSummary, counterpartyKey, counterparties,
    filterCounterparties, dossierView, supplierDraft
} from './bank-view-core.js';
import { supplierFlags } from './docs-core.js';
import { openTxSheet, openPaymentSheet } from './buh-chain.js';
import { openExpenses } from './buh-expenses.js';
import { openFlat } from './buh-flats.js';
import { openJournal } from './buh-journal.js';
import { openAdvance } from './buh-advance.js';
import { openPayroll } from './buh-payroll.js';

let rows = [];
let queue = [];
let last = null;
let more = false;
let tab = 'ops';            // ops | review | cps
let query = '';
let cpQuery = '';
let cpFilter = 'all';
let extraOpen = false;      // додаткові фільтри
let settings = {};
let exp = { expenses: [], contracts: [], suppliers: [] };
let payments = [];
let detail = null;          // { kind: 'tx', id } | { kind: 'cp', key }
let stack = [];             // попередні картки — «‹» повертає до них
let highlighted = null;
const busy = new Set();
const dossiers = new Map(); // код → відповідь YouScore за цей сеанс
const checking = new Set();

const DEFAULT_FILTERS = () => ({ direction: 'all', category: 'all', counterparty: '', cpKey: '', account: '', datePreset: 'month', dateFrom: '', dateTo: '', amountMin: '', amountMax: '' });
let filters = DEFAULT_FILTERS();

// ------------------------------------------------------------
// «← НАЗАД» ПІСЛЯ ПЕРЕХОДУ З КАРТКИ В ІНШИЙ РОЗДІЛ
// ------------------------------------------------------------
let returnState = null;

export function hasBankReturnState() {
    return Boolean(returnState);
}

export function clearBankReturnBanner() {
    returnState = null;
    document.getElementById('buhBackNavBanner')?.remove();
}

export function renderBankReturnBanner(currentView) {
    const existing = document.getElementById('buhBackNavBanner');
    if (!returnState || currentView === 'bank') { existing?.remove(); return; }
    const main = document.querySelector('.buh-main');
    if (!main) return;
    const html = `<div id="buhBackNavBanner" class="buh-back-nav-wrap" role="region" aria-label="Повернення в Банк">
        <button type="button" class="buh-back-nav-btn" id="buhBackNavGo"><span class="buh-back-nav-arrow" aria-hidden="true">←</span><span>Назад до «Банку»</span></button></div>`;
    if (existing) existing.outerHTML = html;
    else main.insertAdjacentHTML('afterbegin', html);
    document.getElementById('buhBackNavGo')?.addEventListener('click', returnToBankPosition);
}

export function returnToBankPosition() {
    if (!returnState) return;
    document.getElementById('buhBackNavBanner')?.remove();
    if (location.hash !== '#bank') location.hash = 'bank';
    else loadBankView();
}

function leaveTo(navigate) {
    returnState = { tab, query, cpQuery, cpFilter, extraOpen, filters: { ...filters }, detail, stack: [...stack], scrollY: window.scrollY };
    closeSheet();
    navigate();
    setTimeout(() => renderBankReturnBanner(location.hash.replace('#', '') || 'today'), 30);
}

// ------------------------------------------------------------
// ДОПОМІЖНЕ
// ------------------------------------------------------------
const opsWord = n => (n % 10 === 1 && n % 100 !== 11 ? 'операція' : [2, 3, 4].includes(n % 10) && ![12, 13, 14].includes(n % 100) ? 'операції' : 'операцій');
const timeOf = ts => (ts?.toDate ? ts.toDate() : new Date(ts)).toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit' });
const humanDate = d => (/^\d{4}-\d{2}-\d{2}$/.test(String(d || '')) ? String(d).split('-').reverse().join('.') : String(d || ''));
const grn = kop => `${fmtKop(kop)} грн`;
const initials = name => (String(name || '').replace(/\(демо\)/gi, '').replace(/[«»"']/g, '').replace(/^(ТОВ|ФОП|АТ|КБ|ПП|ПрАТ|ГУ|КП)\s+/gi, '')
    .split(/\s+/).filter(w => /^[\p{L}\d]/u.test(w)).slice(0, 2).map(w => w[0]).join('').toUpperCase() || '•');
const linksOf = tx => resolveTxLinks(tx, { expenses: exp.expenses, contracts: exp.contracts, suppliers: exp.suppliers, payments });
const txById = id => rows.find(x => x.id === id) || queue.find(x => x.id === id);
const chip = (text, cls = '') => `<span class="bn-chip ${cls}">${escapeHtml(text)}</span>`;

const ICONS = {
    resident: '<path d="M4 20V10l8-6 8 6v10"/><path d="M10 20v-6h4v6"/>',
    income: '<path d="M17 7 7 17"/><path d="M15 17H7V9"/>',
    supplier: '<rect x="4" y="7" width="16" height="13" rx="2"/><path d="M9 7V5h6v2"/>',
    people: '<circle cx="12" cy="8" r="4"/><path d="M4 21c1-4 4-6 8-6s7 2 8 6"/>',
    tax: '<path d="M3 10h18L12 4z"/><path d="M5 10v8M10 10v8M14 10v8M19 10v8M3 21h18"/>',
    bank: '<rect x="3" y="6" width="18" height="12" rx="2"/><path d="M3 10h18M7 15h3"/>',
    internal: '<path d="M7 7h12l-3-3M17 17H5l3 3"/>',
    refund: '<path d="M9 14 4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-3"/>',
    review: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .8-1 1.5V14M12 17h.01"/>'
};
const GROUP = {
    apt_payment: 'resident', rent: 'income', equipment: 'income', grant: 'income', sick_fund: 'income', income_other: 'income',
    interest: 'bank', bank_fee: 'bank', supplier: 'supplier', expense_other: 'supplier', salary: 'people', advance: 'people',
    taxes: 'tax', esv: 'tax', resident_refund: 'refund', supplier_refund: 'refund', internal: 'internal', review: 'review'
};
const groupOf = tx => GROUP[txCategoryKey(tx)] || (tx.direction === 'out' ? 'supplier' : 'income');
const icon = (g, cls = '') => `<span class="bn-ico is-${g} ${cls}" aria-hidden="true"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONS[g] || ICONS.review}</svg></span>`;

/** Ризик контрагента: досьє YouControl цього сеансу, інакше збережене в картці постачальника. */
function riskOf(code, supplier) {
    const d = code ? dossiers.get(code) : null;
    const v = d ? dossierView(d, d.expectedName) : null;
    if (v && v.level !== 'wait') return { level: v.level === 'ok' ? '' : v.level, text: v.level === 'ok' ? 'YouControl: ризиків немає' : v.flags[0]?.text || v.title, source: 'yc' };
    const flags = supplier ? supplierFlags(supplier).filter(f => !/IBAN|ЦПД|КВЕД/.test(f.text)) : [];
    if (flags.length) return { level: flags.some(f => f.level === 'bad') ? 'bad' : 'warn', text: flags[0].text, source: 'card' };
    return { level: '', text: '', source: '' };
}

function cpList() {
    return counterparties(rows, exp.suppliers).map(c => ({ ...c, risk: riskOf(c.code, c.supplier).level }));
}

// ------------------------------------------------------------
// ВЕРХ: РАХУНКИ Й ЩО ПОТРЕБУЄ УВАГИ
// ------------------------------------------------------------
function accountBalance(a) {
    if (typeof a.balanceKop !== 'number') return '—';
    return a.currency && a.currency !== 'UAH'
        ? `${(a.balanceKop / 100).toLocaleString('uk-UA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${escapeHtml(a.currency)}`
        : money(a.balanceKop);
}

function heroHtml() {
    const accounts = Object.entries(settings.accounts || {})
        .sort(([, a], [, b]) => ((a.purpose || 'current') === 'current' ? -1 : 0) - ((b.purpose || 'current') === 'current' ? -1 : 0));
    if (!accounts.length) {
        return `<section class="bn-hero is-empty">
            <span class="bn-hero-label">Банк не підключено</span>
            <b class="bn-hero-sum">Підключіть ПриватБанк</b>
            <p>Виписка й залишки завантажуватимуться щогодини, оплати мешканців розноситимуться самі.</p>
            <button type="button" class="sv-btn is-white" data-go="settings" data-settings-tab="bank">Підключити ›</button></section>`;
    }
    const uah = accounts.filter(([, a]) => !a.currency || a.currency === 'UAH');
    const total = uah.reduce((s, [, a]) => s + (typeof a.balanceKop === 'number' ? a.balanceKop : 0), 0);
    const sync = settings.lastSync;
    const state = sync?.waiting ? ['Банк оновлює дані — виписку перевіримо пізніше', 'is-wait']
        : sync?.ok === false ? [`${sync.partial ? 'Оновлено частково' : 'Виписка не оновилась'}: ${sync.error || 'помилка'}`, 'is-bad']
        : sync ? [`Виписка оновлена о ${timeOf(sync.at)}`, 'is-good'] : ['Виписку ще не отримано', 'is-wait'];
    return `<section class="bn-hero">
        <div class="bn-hero-top"><span class="bn-hero-label">На рахунках ОСББ</span><span class="bn-sync ${state[1]}">${escapeHtml(state[0])}</span></div>
        <b class="bn-hero-sum">${money(total)}</b>
        <div class="bn-accs">${accounts.map(([iban, a]) => `<button type="button" class="bn-acc${filters.account === iban ? ' is-active' : ''}" data-account="${escapeHtml(iban)}" title="Показати операції цього рахунку">
            <span>${escapeHtml(ACCOUNT_PURPOSES[a.purpose] || 'Рахунок')}${a.available === false ? ' · немає доступу' : ''}</span>
            <b>${accountBalance(a)}</b>
            <small>${escapeHtml(maskIban(iban))}${a.lastSync?.ok === false && a.available !== false ? ' · не оновлено' : ''}</small></button>`).join('')}</div>
    </section>`;
}

function alertsHtml(cps) {
    const signing = payments.filter(p => p.status === 'sent');
    const unknown = cps.filter(c => !c.supplier && c.role === 'supplier').length;
    const risky = cps.filter(c => c.risk).length;
    const cards = [
        queue.length && ['review', 'is-warn', 'Потрібне рішення', `${queue.length} ${opsWord(queue.length)}`, 'Розподілити ›', 'data-bn-tab="review"'],
        signing.length && ['sign', 'is-info', 'На підписі голови', `${signing.length} ${signing.length === 1 ? 'платіж' : 'платежі'}`, 'До платежів ›', 'data-go="payments"'],
        unknown && ['new', '', 'Нові постачальники', `${unknown} без картки`, 'Переглянути ›', 'data-bn-cps="unknown"'],
        risky && ['risk', 'is-bad', 'Ризики контрагентів', `${risky} ${risky === 1 ? 'контрагент' : 'контрагенти'}`, 'Переглянути ›', 'data-bn-cps="risk"']
    ].filter(Boolean);
    if (!cards.length) return `<div class="bn-alerts"><div class="bn-alert is-ok"><span>Усе розібрано</span><b>Нових рішень немає</b><small>Оплати мешканців розносяться автоматично</small></div></div>`;
    return `<div class="bn-alerts">${cards.map(([k, cls, label, value, go, attr]) => `<button type="button" class="bn-alert ${cls}" ${attr} data-alert="${k}">
        <span>${label}</span><b>${escapeHtml(value)}</b><small>${go}</small></button>`).join('')}</div>`;
}

// ------------------------------------------------------------
// РУХ КОШТІВ ЗА ПЕРІОД
// ------------------------------------------------------------
const PERIODS = { today: 'Сьогодні', week: '7 днів', month: 'Цей місяць', all: 'Усе завантажене' };
function periodLabel() {
    if (filters.dateFrom || filters.dateTo) return `${filters.dateFrom ? humanDate(filters.dateFrom) : '…'} — ${filters.dateTo ? humanDate(filters.dateTo) : '…'}`;
    if (filters.datePreset === 'month') return periodName(new Date().toISOString().slice(0, 7));
    return (PERIODS[filters.datePreset] || DATE_PRESETS[filters.datePreset] || 'Усе завантажене').toLowerCase();
}

function flowHtml() {
    const list = filterTx(rows, 'all', '', { datePreset: filters.datePreset, dateFrom: filters.dateFrom, dateTo: filters.dateTo, account: filters.account });
    const s = bankSummary(list);
    const bars = (cats, dir) => cats.length ? cats.slice(0, 4).map(c => `<button type="button" class="bn-bar${filters.category === c.key ? ' is-active' : ''}" data-cat="${escapeHtml(c.key)}">
            <span class="bn-bar-top"><span>${escapeHtml(c.label)}</span><b>${grn(c.kop)}</b></span>
            <span class="bn-bar-track"><i class="is-${dir}" style="width:${Math.max(3, Math.round(c.share * 100))}%"></i></span>
            <small>${c.n} ${opsWord(c.n)} · ${Math.round(c.share * 100)}%</small></button>`).join('') : '<p class="bn-muted">Немає операцій</p>';
    return `<section class="py-card bn-flow">
        <div class="bn-flow-head"><h2>Рух коштів <span>${escapeHtml(periodLabel())}</span></h2>
            <div class="bn-seg" role="group" aria-label="Період">${Object.entries(PERIODS).map(([k, v]) =>
                `<button type="button" class="${filters.datePreset === k && !filters.dateFrom && !filters.dateTo ? 'is-active' : ''}" data-period="${k}">${v}</button>`).join('')}</div></div>
        <div class="bn-flow-tiles">
            <button type="button" class="bn-tile${filters.direction === 'in' ? ' is-active' : ''}" data-dir="in"><span>Надійшло</span><b class="is-in">+${grn(s.inKop)}</b><small>${s.inCats.reduce((a, c) => a + c.n, 0)} ${opsWord(s.inCats.reduce((a, c) => a + c.n, 0))}</small></button>
            <button type="button" class="bn-tile${filters.direction === 'out' ? ' is-active' : ''}" data-dir="out"><span>Списано</span><b class="is-out">−${grn(s.outKop)}</b><small>${s.outCats.reduce((a, c) => a + c.n, 0)} ${opsWord(s.outCats.reduce((a, c) => a + c.n, 0))}</small></button>
            <div class="bn-tile is-static"><span>Різниця</span><b class="${s.netKop < 0 ? 'is-out' : 'is-in'}">${s.netKop < 0 ? '−' : '+'}${grn(Math.abs(s.netKop))}</b><small>${s.internal ? `без ${s.internal} переказ${s.internal === 1 ? 'у' : 'ів'} між своїми рахунками` : 'надійшло мінус списано'}</small></div>
        </div>
        <div class="bn-flow-cats">
            <div><h3>Звідки</h3>${bars(s.inCats, 'in')}</div>
            <div><h3>Куди</h3>${bars(s.outCats, 'out')}</div>
        </div>
    </section>`;
}

// ------------------------------------------------------------
// ОПЕРАЦІЇ
// ------------------------------------------------------------
function normalizedFilters() {
    const minKop = filters.amountMin ? toKop(filters.amountMin) : null;
    const maxKop = filters.amountMax ? toKop(filters.amountMax) : null;
    return {
        ...filters,
        amountMinKop: Number.isFinite(minKop) && minKop > 0 ? minKop : null,
        amountMaxKop: Number.isFinite(maxKop) && maxKop > 0 ? maxKop : null
    };
}

function activeChips() {
    const out = [];
    if (filters.direction !== 'all') out.push(['direction', filters.direction === 'in' ? 'Надходження' : 'Списання']);
    if (filters.category !== 'all') out.push(['category', BANK_CATEGORY_OPTIONS[filters.category] || filters.category]);
    if (filters.cpKey) out.push(['cpKey', `Контрагент: ${cpList().find(c => c.key === filters.cpKey)?.name || '…'}`]);
    if (filters.account) out.push(['account', `Рахунок ${maskIban(filters.account)}`]);
    if (filters.dateFrom || filters.dateTo) out.push(['dates', periodLabel()]);
    if (filters.amountMin || filters.amountMax) out.push(['amount', `Сума ${filters.amountMin || '0'} — ${filters.amountMax || '∞'} грн`]);
    if (filters.counterparty) out.push(['counterparty', `Платник: ${filters.counterparty}`]);
    return out;
}

function toolbarHtml() {
    const chips = activeChips();
    const extra = [filters.category !== 'all', filters.dateFrom || filters.dateTo, filters.amountMin || filters.amountMax, filters.counterparty].filter(Boolean).length;
    return `<div class="bn-tools">
        <label class="fl-search bn-search"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>
            <input type="search" id="bankQuery" placeholder="Квартира, платник, ЄДРПОУ, договір, сума" value="${escapeHtml(query)}" aria-label="Пошук операції"></label>
        <div class="bn-seg" role="group" aria-label="Напрямок">${[['all', 'Усі'], ['in', 'Надходження'], ['out', 'Списання']].map(([k, v]) =>
            `<button type="button" class="${filters.direction === k ? 'is-active' : ''}" data-dir="${k}">${v}</button>`).join('')}</div>
        <button type="button" class="bn-more-btn${extraOpen ? ' is-open' : ''}" data-act="extra" aria-expanded="${extraOpen}">Фільтри${extra ? ` <i>${extra}</i>` : ''}</button>
    </div>
    <div class="bn-extra"${extraOpen ? '' : ' hidden'}>
        <label class="py-field"><span>Категорія</span><select id="bfCategory">${Object.entries(BANK_CATEGORY_OPTIONS).map(([k, v]) =>
            `<option value="${escapeHtml(k)}"${filters.category === k ? ' selected' : ''}>${escapeHtml(k === 'all' ? 'Усі категорії' : v)}</option>`).join('')}</select></label>
        <label class="py-field"><span>Платник / одержувач</span><input id="bfCounterparty" value="${escapeHtml(filters.counterparty)}" placeholder="Назва, код або кв."></label>
        <label class="py-field"><span>Дата з</span><input id="bfDateFrom" type="date" value="${escapeHtml(filters.dateFrom)}"></label>
        <label class="py-field"><span>Дата по</span><input id="bfDateTo" type="date" value="${escapeHtml(filters.dateTo)}"></label>
        <label class="py-field"><span>Сума від, грн</span><input id="bfAmountMin" inputmode="decimal" value="${escapeHtml(filters.amountMin)}" placeholder="0,00"></label>
        <label class="py-field"><span>Сума до, грн</span><input id="bfAmountMax" inputmode="decimal" value="${escapeHtml(filters.amountMax)}" placeholder="без межі"></label>
    </div>
    ${chips.length ? `<div class="bn-active">${chips.map(([k, v]) => `<button type="button" class="bn-active-chip" data-clear="${k}">${escapeHtml(v)} <span aria-hidden="true">×</span></button>`).join('')}
        <button type="button" class="bn-link" data-act="reset">Скинути все</button></div>` : ''}`;
}

function statusHtml(tx) {
    if (busy.has(tx.id)) return '<span class="bn-status">Зберігаю…</span>';
    if (tx.status === 'review' || tx.bankConflict) {
        const q = quickAssign(tx);
        return q ? `<button type="button" class="bn-quick${q.sure ? '' : ' is-ask'}" data-act="quick">${q.sure ? `Так, кв. ${escapeHtml(q.apt)}` : `Це кв. ${escapeHtml(q.apt)}?`}</button>`
            : '<button type="button" class="bn-quick is-ask" data-go="inbox">Розібрати ›</button>';
    }
    const d = txDistributionInfo(tx);
    return `<span class="bn-status">${escapeHtml(d.shortLabel)} · ${escapeHtml(timeOf(tx.at))}</span>`;
}

function rowHtml(tx) {
    const out = tx.direction === 'out';
    const cat = txCategoryInfo(tx);
    const links = linksOf(tx);
    // Договір лише справжній: з довідника або з номером у призначенні.
    const con = links.contractLink && (links.contractLink.inDatabase || links.contractLink.number !== 'б/н') ? links.contractLink : null;
    const cp = links.counterpartyLink;
    const risk = cp?.kind === 'supplier' ? riskOf(String(tx.counterparty?.code || ''), links.matchedSupplier) : null;
    return `<div class="bn-row${detail?.kind === 'tx' && detail.id === tx.id ? ' is-current' : ''}${highlighted === tx.id ? ' is-flash' : ''}" data-tx="${escapeHtml(tx.id)}" tabindex="0" role="button" aria-haspopup="dialog">
        ${icon(tx.status === 'review' || tx.bankConflict ? 'review' : groupOf(tx))}
        <span class="bn-main">
            <b>${escapeHtml(tx.counterparty?.name || '—')}</b>
            <small>${escapeHtml(tx.purpose || '')}</small>
            <span class="bn-tags">${tx.status === 'review' || tx.bankConflict ? chip('Чекає рішення', 'is-wait') : chip(cat.shortLabel, `is-${groupOf(tx)}`)}${con ? chip(con.number && con.number !== 'б/н' ? `Договір № ${con.number}` : con.subject, 'is-doc') : ''}${risk?.level ? chip(risk.level === 'bad' ? 'ризик' : 'увага', `is-risk-${risk.level}`) : ''}</span>
        </span>
        <span class="bn-right"><b class="bn-sum ${out ? 'is-out' : 'is-in'}">${signed(tx)}</b>${statusHtml(tx)}</span>
    </div>`;
}

function opsHtml(source, emptyText) {
    // Нерозібране показуємо за весь час: старе рішення не має ховатися за періодом.
    const f = tab === 'review' ? { ...normalizedFilters(), datePreset: 'all', dateFrom: '', dateTo: '' } : normalizedFilters();
    const list = filterTx(source, tab === 'review' ? 'review' : 'all', query, f);
    if (!list.length) return `<p class="py-empty">${emptyText}</p>`;
    const inKop = list.filter(t => t.direction === 'in').reduce((s, t) => s + (t.amountKop || 0), 0);
    const outKop = list.filter(t => t.direction === 'out').reduce((s, t) => s + (t.amountKop || 0), 0);
    return `<p class="bn-found">${list.length} ${opsWord(list.length)}${inKop ? ` · <span class="is-in">+${grn(inKop)}</span>` : ''}${outKop ? ` · <span class="is-out">−${grn(outKop)}</span>` : ''}</p>
        ${byDay(list).map(d => {
            const dIn = d.rows.filter(t => t.direction === 'in').reduce((s, t) => s + (t.amountKop || 0), 0);
            const dOut = d.rows.filter(t => t.direction === 'out').reduce((s, t) => s + (t.amountKop || 0), 0);
            return `<div class="bn-day"><div class="bn-day-head"><b>${escapeHtml(d.label)}</b><span>${dIn ? `<i class="is-in">+${fmtKop(dIn)}</i>` : ''}${dOut ? `<i class="is-out">−${fmtKop(dOut)}</i>` : ''}</span></div>
                ${d.rows.map(rowHtml).join('')}</div>`;
        }).join('')}`;
}

// ------------------------------------------------------------
// КОНТРАГЕНТИ
// ------------------------------------------------------------
function cpsToolbar() {
    const all = cpList();
    const counts = Object.fromEntries(Object.keys(CP_FILTERS).map(k => [k, filterCounterparties(all, k).length]));
    return `<div class="bn-tools">
            <label class="fl-search bn-search"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>
                <input type="search" id="bankCpQuery" placeholder="Назва, ЄДРПОУ або IBAN" value="${escapeHtml(cpQuery)}" aria-label="Пошук контрагента"></label>
            <div class="bn-chips" role="group" aria-label="Відбір">${Object.entries(CP_FILTERS).map(([k, v]) =>
                `<button type="button" class="bn-chip-btn${cpFilter === k ? ' is-active' : ''}" data-cpfilter="${k}">${v} <small>${counts[k]}</small></button>`).join('')}</div>
        </div>
        <p class="bn-found">Контрагенти із завантаженої виписки. Співвласники — у «Квартирах», працівники — у «Зарплаті».</p>`;
}

function cpsHtml() {
    const list = filterCounterparties(cpList(), cpFilter, cpQuery);
    return `${list.length ? `<div class="bn-cps">${list.map(c => {
            const r = riskOf(c.code, c.supplier);
            return `<button type="button" class="bn-cp${detail?.kind === 'cp' && detail.key === c.key ? ' is-current' : ''}" data-cp="${escapeHtml(c.key)}">
                <span class="bn-ava is-${c.role}">${escapeHtml(initials(c.name))}</span>
                <span class="bn-main"><b>${escapeHtml(c.name)}</b><small>${escapeHtml([c.code ? `код ${c.code}` : 'без коду', CP_ROLES[c.role]].join(' · '))}</small>
                    <span class="bn-tags">${c.supplier ? chip('у довіднику', 'is-ok') : c.role === 'supplier' ? chip('немає картки', 'is-warn') : ''}${r.level ? chip(r.text, `is-risk-${r.level}`) : r.source === 'yc' ? chip('YouControl ✓', 'is-ok') : ''}${c.review ? chip(`${c.review} чекає рішення`, 'is-wait') : ''}</span></span>
                <span class="bn-right">${c.outKop ? `<b class="bn-sum is-out">−${fmtKop(c.outKop)}</b>` : ''}${c.inKop ? `<b class="bn-sum is-in">+${fmtKop(c.inKop)}</b>` : ''}<span class="bn-status">${c.n} ${opsWord(c.n)} · ${escapeHtml(dateOnly(c.lastAt))}</span></span>
            </button>`;
        }).join('')}</div>` : '<p class="py-empty">Нікого не знайдено</p>'}`;
}

// ------------------------------------------------------------
// БІЧНІ КАРТКИ: ОПЕРАЦІЯ Й КОНТРАГЕНТ
// ------------------------------------------------------------
function ycBlock(c) {
    const d = c.code ? dossiers.get(c.code) : null;
    const v = dossierView(d, c.name);
    const isChecking = checking.has(c.code);
    const fromCard = c.supplier ? supplierFlags(c.supplier).filter(f => !/IBAN|ЦПД|КВЕД/.test(f.text)) : [];
    const head = `<div class="bn-yc-head"><span class="bn-yc-logo" aria-hidden="true">YC</span><div><b>YouControl</b><small>ЄДР, податковий борг, виконавчі провадження, суди</small></div>
        ${v?.sandbox ? chip('тестові дані', 'is-wait') : ''}</div>`;
    if (!c.checkable) {
        return `<section class="bn-yc">${head}<p class="bn-muted">Банк не передав код ЄДРПОУ чи РНОКПП — перевірити неможливо. ${c.supplier ? 'Код можна вписати в картці постачальника.' : ''}</p></section>`;
    }
    if (!v) {
        return `<section class="bn-yc">${head}
            ${fromCard.length ? `<ul class="bn-flags">${fromCard.map(f => `<li class="is-${f.level}">${escapeHtml(f.text)} <small>з картки постачальника</small></li>`).join('')}</ul>` : ''}
            <p class="bn-muted">Перед оплатою варто переконатися, що контрагент діє і не має боргів перед бюджетом.</p>
            <button type="button" class="sv-btn" data-act="yc-check" data-code="${escapeHtml(c.code)}"${isChecking ? ' disabled' : ''}>${isChecking ? 'Запитую реєстри…' : `Перевірити ${escapeHtml(c.code)}`}</button></section>`;
    }
    return `<section class="bn-yc is-${v.level}">${head}
        <div class="bn-yc-verdict"><i aria-hidden="true">${v.level === 'ok' ? '✓' : v.level === 'wait' ? '…' : '!'}</i><b>${escapeHtml(v.title)}</b></div>
        ${v.name ? `<p class="bn-yc-name">${escapeHtml(v.name)}</p>` : ''}
        ${v.flags.length ? `<ul class="bn-flags">${v.flags.map(f => `<li class="is-${f.level}">${escapeHtml(f.text)}</li>`).join('')}</ul>` : ''}
        ${v.facts.length ? `<dl class="bn-facts">${v.facts.map(([k, val]) => `<div><dt>${escapeHtml(k)}</dt><dd>${escapeHtml(val)}</dd></div>`).join('')}</dl>` : ''}
        <div class="bn-yc-actions">
            ${d.found ? `<button type="button" class="sv-btn${c.supplier ? ' is-soft' : ''}" data-act="cp-card-from-yc" data-key="${escapeHtml(c.key)}">${c.supplier ? 'Оновити картку з YouControl' : 'Створити картку з цих даних'}</button>` : ''}
            <button type="button" class="sv-btn is-soft" data-act="yc-check" data-code="${escapeHtml(c.code)}"${isChecking ? ' disabled' : ''}>${isChecking ? 'Запитую…' : 'Перевірити ще раз'}</button>
        </div></section>`;
}

function cpSheet(key) {
    const c = cpList().find(x => x.key === key);
    if (!c) return ['Контрагент', '<p class="py-empty">Контрагента немає в завантаженій виписці</p>'];
    const ops = c.txIds.map(txById).filter(Boolean).slice(0, 8);
    return [c.name, `<div class="bn-cp-head"><span class="bn-ava is-${c.role} is-lg">${escapeHtml(initials(c.name))}</span>
            <div><b class="chs-title">${escapeHtml(c.name)}</b>
            <div class="bn-tags">${chip(CP_ROLES[c.role])}${c.code ? chip(`код ${c.code}`) : ''}${c.supplier ? chip('у довіднику', 'is-ok') : c.role === 'supplier' ? chip('немає картки', 'is-warn') : ''}</div>
            ${c.iban ? `<small class="bn-muted">IBAN ${escapeHtml(c.iban)}</small>` : ''}</div></div>
        <div class="chs-tiles">
            <div><span>Сплатили ми</span><b class="${c.outKop ? 'is-out' : ''}">${c.outKop ? `−${grn(c.outKop)}` : '—'}</b></div>
            <div><span>Отримали від них</span><b class="${c.inKop ? 'is-in' : ''}">${c.inKop ? `+${grn(c.inKop)}` : '—'}</b></div>
            <div><span>Операцій</span><b>${c.n}</b>${c.review ? `<small>${c.review} чекає рішення</small>` : ''}</div>
            <div><span>Остання</span><b>${escapeHtml(dateOnly(c.lastAt))}</b></div>
        </div>
        ${ycBlock(c)}
        <h3 class="chs-h">Операції</h3>
        <div class="bn-mini">${ops.map(tx => `<button type="button" class="bn-mini-row" data-open-tx="${escapeHtml(tx.id)}">
            <span>${escapeHtml(dateOnly(tx.at))}</span><span class="bn-mini-what">${escapeHtml(txCategoryInfo(tx).shortLabel)}<small>${escapeHtml(tx.purpose || '')}</small></span>
            <b class="bn-sum ${tx.direction === 'out' ? 'is-out' : 'is-in'}">${signed(tx)}</b></button>`).join('')}</div>
        <div class="chs-actions bn-sheet-actions">
            <button type="button" class="sv-btn is-soft" data-act="cp-ops" data-key="${escapeHtml(c.key)}">Усі операції в списку</button>
            ${c.supplier ? `<button type="button" class="sv-btn is-soft" data-act="cp-supplier" data-key="${escapeHtml(c.key)}">Картка в «Документах» ›</button>`
                : c.role === 'supplier' ? `<button type="button" class="sv-btn" data-act="cp-card-from-yc" data-key="${escapeHtml(c.key)}">Створити картку постачальника</button>` : ''}
        </div>`];
}

function txSheet(id) {
    const tx = txById(id);
    if (!tx) return ['Операція', '<p class="py-empty">Операцію не знайдено</p>'];
    const out = tx.direction === 'out';
    const cat = txCategoryInfo(tx);
    const dist = txDistributionInfo(tx);
    const links = linksOf(tx);
    const cp = links.counterpartyLink || {};
    const con = links.contractLink;
    const entry = describeTxAccountingEntry(tx, { expenses: exp.expenses, accounts: settings.accounts });
    const acc = settings.accounts?.[tx.account] || {};
    const review = tx.status === 'review' || tx.bankConflict;
    const q = quickAssign(tx);
    const undo = tx.status === 'done' && tx.kind !== 'internal' && !tx.bankConflict && !tx.bankVoided;
    const key = counterpartyKey(tx.counterparty);
    const isCp = cp.kind === 'supplier' && key && cpList().some(c => c.key === key);
    const code = String(tx.counterparty?.code || '');
    const risk = cp.kind === 'supplier' ? riskOf(code, links.matchedSupplier) : null;
    const link = (act, label, main, sub, right = '›', extra = '') => `<button type="button" class="chs-link" data-nav="${act}"${extra}>
        <span class="chs-link-label">${escapeHtml(label)}</span><span class="chs-link-main"><b>${escapeHtml(main)}</b>${sub ? `<small>${escapeHtml(sub)}</small>` : ''}</span><span class="chs-link-right">${right}</span></button>`;

    return [out ? 'Списання' : 'Надходження', `<div class="bn-tx-head">
            ${icon(review ? 'review' : groupOf(tx), 'is-lg')}
            <div><span class="bn-muted">${out ? 'Списання' : 'Надходження'} · ${escapeHtml(when(tx.at))}</span>
            <b class="chs-sum ${out ? 'is-out' : 'is-in'}">${signed(tx)} грн</b>
            <div class="bn-tags">${chip(cat.label, `is-${groupOf(tx)}`)}${chip(dist.shortLabel, dist.mode === 'review' ? 'is-wait' : '')}</div></div>
        </div>
        ${review ? `<section class="bn-callout">
            <b>Потрібне рішення</b><span>${escapeHtml(cat.label)}</span>
            <div class="chs-actions">${q ? `<button type="button" class="sv-btn" data-act="quick" data-tx="${escapeHtml(tx.id)}">${q.sure ? `Так, це кв. ${escapeHtml(q.apt)}` : `Це кв. ${escapeHtml(q.apt)}?`}</button>` : ''}
                <button type="button" class="sv-btn${q ? ' is-soft' : ''}" data-nav="inbox">Розібрати в «Рішеннях» ›</button></div></section>` : ''}
        <section class="bn-who">
            <span class="bn-ava is-${cp.kind === 'flat' ? 'resident' : 'supplier'}">${escapeHtml(initials(tx.counterparty?.name || cp.name))}</span>
            <div class="bn-who-main"><span class="bn-muted">${out ? 'Одержувач' : 'Платник'}</span><b>${escapeHtml(tx.counterparty?.name || cp.name || 'Невідомо')}</b>
                <small>${escapeHtml([code ? `код ${code}` : '', tx.counterparty?.account ? maskIban(tx.counterparty.account) : ''].filter(Boolean).join(' · ') || 'Банк не передав реквізити')}</small>
                ${risk?.text ? `<span class="bn-who-risk is-${risk.level || 'ok'}">${escapeHtml(risk.text)}</span>` : ''}</div>
            ${isCp ? `<button type="button" class="sv-btn is-soft" data-open-cp="${escapeHtml(key)}">Досьє ›</button>`
                : cp.kind === 'flat' && cp.apt ? `<button type="button" class="sv-btn is-soft" data-nav="counterparty">Квартира ${escapeHtml(cp.apt)} ›</button>` : ''}
        </section>
        <section class="bn-purpose"><span class="bn-muted">Призначення платежу</span><p>${escapeHtml(tx.purpose || 'Без призначення')}</p></section>
        <div class="chs-links">
            ${cp.kind === 'advance' || cp.kind === 'payroll' ? link('counterparty', cp.kind === 'advance' ? 'Підзвітна особа' : 'Зарплата', cp.name, cp.badge) : ''}
            ${(tx.allocations || []).length ? `<div class="bn-apts"><span class="chs-link-label">Розподілено на квартири</span>${tx.allocations.map(a => `<button type="button" class="bn-apt" data-nav="flat" data-apt="${escapeHtml(String(a.apt))}">Кв. ${escapeHtml(String(a.apt))} · ${money(a.amountKop)} ›</button>`).join('')}</div>` : ''}
            ${con ? link('contract', con.inDatabase ? 'Договір' : 'Договір (з призначення)', `${con.subject}`, `№ ${con.number}${con.date ? ` від ${humanDate(con.date)}` : ''}${con.inDatabase ? '' : ' · у довіднику не знайдено'}`) : ''}
            ${links.expenseDoc ? link('expense', 'Документ', `№ ${links.expenseDoc.number || links.expenseDoc.id}`, links.expenseDoc.date ? `від ${humanDate(links.expenseDoc.date)}` : '', '›', ` data-doc="${escapeHtml(links.expenseDoc.id)}"`) : ''}
            ${tx.paymentId ? `<button type="button" class="chs-link" data-open="payment" data-id="${escapeHtml(tx.paymentId)}"><span class="chs-link-label">Платіжне доручення</span><span class="chs-link-main"><b>Створене в застосунку</b><small>підпис, статус у банку</small></span><span class="chs-link-right">›</span></button>` : ''}
            ${entry ? link('journal', 'Проводка в обліку', `Дт ${entry.dr} — Кт ${entry.cr}`, `${entry.drTitle} ← ${entry.crTitle}`, 'ОСВ ›') : ''}
        </div>
        <dl class="bn-facts">
            <div><dt>Рахунок ОСББ</dt><dd>${escapeHtml(ACCOUNT_PURPOSES[acc.purpose] || 'Поточний')} · ${escapeHtml(maskIban(tx.account))}</dd></div>
            <div><dt>Як розподілено</dt><dd>${escapeHtml(dist.label)} — ${escapeHtml(dist.reason)}</dd></div>
        </dl>
        <div class="chs-actions bn-sheet-actions">
            <button type="button" class="sv-btn is-soft" data-open="tx" data-id="${escapeHtml(tx.id)}">Увесь ланцюжок ›</button>
            ${undo ? `<button type="button" class="sv-btn is-soft" data-act="undo" data-tx="${escapeHtml(tx.id)}">Повернути в «Рішення»</button>` : ''}
        </div>`];
}

function sheetHost() {
    let el = document.getElementById('bnSheet');
    if (!el) {
        el = document.createElement('div');
        el.id = 'bnSheet';
        el.className = 'chs-wrap bn-sheet';
        el.hidden = true;
        document.body.appendChild(el);
        el.addEventListener('click', onClick);
        el.addEventListener('keydown', onKey);
        document.addEventListener('keydown', e => { if (e.key === 'Escape' && !el.hidden && !document.querySelector('.confirm-overlay')) closeSheet(); });
        window.addEventListener('hashchange', () => { if (location.hash !== '#bank') closeSheet(); });
    }
    return el;
}

function renderSheet() {
    const el = sheetHost();
    if (!detail) { el.hidden = true; el.innerHTML = ''; document.body.classList.remove('chs-open'); return; }
    const keep = el.dataset.key === JSON.stringify(detail) ? el.querySelector('.chs-body')?.scrollTop || 0 : 0;
    const [title, body] = detail.kind === 'cp' ? cpSheet(detail.key) : txSheet(detail.id);
    el.dataset.key = JSON.stringify(detail);
    el.innerHTML = `<div class="chs-backdrop" data-act="sheet-close"></div>
        <aside class="chs-sheet" role="dialog" aria-modal="true" aria-label="${escapeHtml(title)}" tabindex="-1">
            <div class="chs-bar">${stack.length ? '<button type="button" class="chs-icon" data-act="sheet-back" aria-label="Назад">‹</button>' : '<span></span>'}
                <span class="chs-bar-title">${escapeHtml(title)}</span>
                <button type="button" class="chs-icon" data-act="sheet-close" aria-label="Закрити">×</button></div>
            <div class="chs-body">${body}</div>
        </aside>`;
    el.hidden = false;
    document.body.classList.add('chs-open');
    if (keep) el.querySelector('.chs-body').scrollTop = keep;
    else el.querySelector('.chs-sheet')?.focus({ preventScroll: true });
}

function openDetail(next, push = false) {
    if (push && detail) stack.push(detail);
    else if (!push) stack = [];
    detail = next;
    renderSheet();
    markCurrent();
}

function closeSheet() {
    const was = detail;
    detail = null;
    stack = [];
    renderSheet();
    markCurrent();
    if (was?.kind === 'tx') document.querySelector(`#bnPane [data-tx="${CSS.escape(was.id)}"]`)?.focus({ preventScroll: true });
}

function markCurrent() {
    document.querySelectorAll('#bnPane [data-tx]').forEach(r => r.classList.toggle('is-current', detail?.kind === 'tx' && r.dataset.tx === detail.id));
    document.querySelectorAll('#bnPane [data-cp]').forEach(r => r.classList.toggle('is-current', detail?.kind === 'cp' && r.dataset.cp === detail.key));
}

// ------------------------------------------------------------
// РЕНДЕР РОЗДІЛУ
// ------------------------------------------------------------
function paneHtml() {
    if (tab === 'cps') return cpsHtml();
    if (tab === 'review') return opsHtml(queue, 'Усі операції розподілено — рішень не потрібно');
    return opsHtml(rows, activeChips().length || query ? 'За цими умовами операцій немає' : 'Операцій ще немає');
}

function renderPane() {
    const pane = document.getElementById('bnPane');
    if (!pane) return;
    pane.innerHTML = `${tab === 'cps' ? cpsToolbar() : toolbarHtml()}<div id="bnList">${paneHtml()}</div>
        ${tab === 'ops' && more ? '<button type="button" id="bankMore" class="sv-btn is-soft is-wide">Завантажити старіші операції</button>' : ''}`;
}

function renderList() {
    const list = document.getElementById('bnList');
    if (list) list.innerHTML = paneHtml();
}

function render() {
    const cps = cpList();
    const host = document.getElementById('viewBank');
    host.innerHTML = `<div class="bn-top">${heroHtml()}${alertsHtml(cps)}</div>
        ${rows.length ? flowHtml() : ''}
        <div class="bn-tabs" role="tablist">${[['ops', 'Операції', ''], ['review', 'Потрібне рішення', queue.length || ''], ['cps', 'Контрагенти', cps.length || '']].map(([k, v, n]) =>
            `<button type="button" class="bn-tab${tab === k ? ' is-active' : ''}${k === 'review' && n ? ' is-warn' : ''}" role="tab" aria-selected="${tab === k}" data-bn-tab="${k}">${v}${n ? ` <small>${n}</small>` : ''}</button>`).join('')}</div>
        <section class="py-card bn-pane" id="bnPane"></section>`;
    renderPane();
}

export async function loadBankView() {
    const [s, page, q, pays, e] = await Promise.all([
        loadSettings(),
        loadPage(),
        loadQueue().catch(() => []),
        loadPayments().catch(() => []),
        loadExpenses().catch(() => ({ expenses: [], contracts: [], suppliers: [] }))
    ]);
    settings = s || {};
    exp = e || { expenses: [], contracts: [], suppliers: [] };
    payments = pays || [];
    rows = page.rows; last = page.last; more = page.full;
    queue = q;

    const restore = returnState;
    if (restore) {
        ({ tab, query, cpQuery, cpFilter, extraOpen } = restore);
        filters = { ...DEFAULT_FILTERS(), ...restore.filters };
        returnState = null;
        document.getElementById('buhBackNavBanner')?.remove();
        highlighted = restore.detail?.kind === 'tx' ? restore.detail.id : null;
    }
    render();
    if (restore) {
        window.scrollTo({ top: restore.scrollY || 0, behavior: 'instant' });
        if (restore.detail) { stack = restore.stack || []; detail = restore.detail; renderSheet(); markCurrent(); }
        setTimeout(() => { highlighted = null; document.querySelectorAll('#bnPane .is-flash').forEach(el => el.classList.remove('is-flash')); }, 2500);
    } else if (detail) renderSheet();
}

// ------------------------------------------------------------
// ДІЇ
// ------------------------------------------------------------
async function quick(tx) {
    const q = quickAssign(tx);
    if (!q) return;
    if (!q.sure && !await confirmDialog(`Це оплата кв. ${q.apt}?`, `${tx.counterparty?.name || 'Платник'}: ${money(tx.amountKop)}. «${tx.purpose || ''}». Система не впевнена — перевірте призначення.`, `Так, кв. ${q.apt}`)) return;
    busy.add(tx.id);
    renderList();
    try {
        await act({ action: 'assign', txId: tx.id, allocations: [{ apt: q.apt, amountKop: tx.amountKop }], remember: q.sure });
        toast(`Рознесено: кв. ${q.apt}`, 'success');
        busy.delete(tx.id);
        if (detail?.kind === 'tx' && detail.id === tx.id) closeSheet();
        await loadBankView();
    } catch (err) { toast(err.message, 'error'); busy.delete(tx.id); renderList(); }
}

async function ycCheck(code, expectedName = '') {
    if (checking.has(code)) return;
    checking.add(code);
    renderSheet();
    try {
        const d = await expAct({ action: 'checkSupplier', code });
        dossiers.set(code, { ...d, expectedName });
        const v = dossierView(d, expectedName);
        toast(v.level === 'ok' ? 'YouControl: ризиків не виявлено' : v.level === 'wait' ? 'Реєстр ще готує відповідь' : `YouControl: ${v.title.toLowerCase()}`, v.level === 'ok' ? 'success' : 'info');
    } catch (err) {
        toast(err.message, 'error');
    } finally {
        checking.delete(code);
        renderSheet();
        renderList();
    }
}

function cardFromYc(key) {
    const c = cpList().find(x => x.key === key);
    if (!c) return;
    const d = c.code ? dossiers.get(c.code) : null;
    const data = d?.found ? supplierDraft(d, c, c.supplier) : { ...(c.supplier || {}), name: c.supplier?.name || c.name, code: c.supplier?.code || c.code, iban: c.supplier?.iban || c.iban, kind: c.code.length === 10 ? 'fop' : 'company' };
    leaveTo(() => openExpenses('suppliers', { kind: 'supplier', data }));
}

function navigate(btn) {
    const tx = txById(detail?.id);
    if (!tx) return;
    const links = linksOf(tx);
    const kind = btn.dataset.nav;
    if (kind === 'counterparty') {
        const cp = links.counterpartyLink || {};
        if (cp.kind === 'flat') leaveTo(() => openFlat(cp.apt || null));
        else if (cp.kind === 'advance') leaveTo(() => openAdvance('all', cp.id || null));
        else if (cp.kind === 'payroll') leaveTo(() => openPayroll(cp.period || null));
        else leaveTo(() => openExpenses('suppliers', null, null, { kind: 'supplier', id: cp.id || '', name: cp.name || '', code: cp.code || '', iban: cp.iban || '' }));
    } else if (kind === 'contract') {
        const con = links.contractLink || {};
        leaveTo(() => openExpenses('contracts', null, null, {
            kind: 'contract', id: con.id || '', number: con.number || 'б/н', date: con.date || '', subject: con.subject || '',
            supplierId: con.supplierId || '', supplierName: con.supplierName || tx.counterparty?.name || '',
            code: tx.counterparty?.code || '', iban: tx.counterparty?.account || '', amountKop: tx.amountKop || 0
        }));
    } else if (kind === 'journal') {
        const entry = describeTxAccountingEntry(tx, { expenses: exp.expenses, accounts: settings.accounts });
        if (entry) leaveTo(() => openJournal(entry.period || null, { acc: entry.focusAcc, cashAcc: entry.cashAcc, ref: tx.id }));
    } else if (kind === 'flat') {
        leaveTo(() => openFlat(btn.dataset.apt));
    } else if (kind === 'expense') {
        leaveTo(() => openExpenses('docs', null, btn.dataset.doc));
    } else if (kind === 'inbox') {
        leaveTo(() => { location.hash = 'inbox'; });
    }
}

async function onClick(e) {
    const t = e.target;
    const btn = t.closest('[data-act]');
    const a = btn?.dataset.act;
    if (a === 'sheet-close') { closeSheet(); return; }
    if (a === 'sheet-back') { detail = stack.pop() || null; renderSheet(); markCurrent(); return; }
    if (t.closest('[data-go]')) return; // перехід у розділ — buh-main.js

    const tabBtn = t.closest('[data-bn-tab]');
    if (tabBtn) { tab = tabBtn.dataset.bnTab; render(); document.getElementById('bnPane')?.scrollIntoView({ behavior: 'smooth', block: 'start' }); return; }
    const cpsBtn = t.closest('[data-bn-cps]');
    if (cpsBtn) { tab = 'cps'; cpFilter = cpsBtn.dataset.bnCps; render(); document.getElementById('bnPane')?.scrollIntoView({ behavior: 'smooth', block: 'start' }); return; }
    const period = t.closest('[data-period]');
    if (period) { filters.datePreset = period.dataset.period; filters.dateFrom = ''; filters.dateTo = ''; render(); return; }
    const dir = t.closest('[data-dir]');
    if (dir) { filters.direction = filters.direction === dir.dataset.dir && dir.closest('.bn-flow') ? 'all' : dir.dataset.dir; if (tab === 'cps') tab = 'ops'; render(); return; }
    const cat = t.closest('[data-cat]');
    if (cat) { filters.category = filters.category === cat.dataset.cat ? 'all' : cat.dataset.cat; tab = 'ops'; render(); document.getElementById('bnPane')?.scrollIntoView({ behavior: 'smooth', block: 'start' }); return; }
    const accBtn = t.closest('[data-account]');
    if (accBtn) { filters.account = filters.account === accBtn.dataset.account ? '' : accBtn.dataset.account; render(); return; }
    const clear = t.closest('[data-clear]');
    if (clear) {
        const k = clear.dataset.clear;
        if (k === 'dates') { filters.dateFrom = ''; filters.dateTo = ''; }
        else if (k === 'amount') { filters.amountMin = ''; filters.amountMax = ''; }
        else filters[k] = DEFAULT_FILTERS()[k];
        render();
        return;
    }
    const cpf = t.closest('[data-cpfilter]');
    if (cpf) { cpFilter = cpf.dataset.cpfilter; renderPane(); return; }
    const openTx = t.closest('[data-open-tx]');
    if (openTx) { openDetail({ kind: 'tx', id: openTx.dataset.openTx }, true); return; }
    const openCp = t.closest('[data-open-cp]');
    if (openCp) {
        openDetail({ kind: 'cp', key: openCp.dataset.openCp }, true);
        return;
    }
    const nav = t.closest('[data-nav]');
    if (nav) { navigate(nav); return; }
    const link = t.closest('[data-open]');
    if (link) {
        // Ланцюжок і платіжне доручення — окремі картки поверх «Банку».
        const id = link.dataset.id;
        closeSheet();
        if (link.dataset.open === 'payment') openPaymentSheet(id);
        else openTxSheet(id);
        return;
    }

    if (btn && !btn.disabled) {
        if (a === 'extra') { extraOpen = !extraOpen; renderPane(); return; }
        if (a === 'reset') { query = ''; filters = { ...DEFAULT_FILTERS(), datePreset: filters.datePreset }; render(); return; }
        if (a === 'quick') {
            const id = btn.dataset.tx || btn.closest('[data-tx]')?.dataset.tx;
            const tx = txById(id);
            if (tx) await quick(tx);
            return;
        }
        if (a === 'undo') {
            const tx = txById(btn.dataset.tx);
            if (!tx || !await confirmDialog('Повернути в «Рішення»?', tx.kind === 'payment'
                ? 'Оплату буде прибрано з історії квартири, операція знову чекатиме рішення.' : 'Категорію буде знято.', 'Повернути')) return;
            setBusy(btn, true);
            try {
                await act({ action: 'unassign', txId: tx.id });
                toast('Повернуто в «Рішення»', 'success');
                closeSheet();
                await loadBankView();
            } catch (err) { toast(err.message, 'error'); } finally { if (btn.isConnected) setBusy(btn, false); }
            return;
        }
        if (a === 'yc-check') { await ycCheck(btn.dataset.code, cpList().find(c => c.code === btn.dataset.code)?.name || ''); return; }
        if (a === 'cp-card-from-yc') { cardFromYc(btn.dataset.key); return; }
        if (a === 'cp-supplier') {
            const c = cpList().find(x => x.key === btn.dataset.key);
            if (c) leaveTo(() => openExpenses('suppliers', null, null, { kind: 'supplier', id: c.supplier.id, name: c.name, code: c.code, iban: c.iban }));
            return;
        }
        if (a === 'cp-ops') { filters = { ...DEFAULT_FILTERS(), datePreset: 'all', cpKey: btn.dataset.key }; tab = 'ops'; closeSheet(); render(); document.getElementById('bnPane')?.scrollIntoView({ behavior: 'smooth', block: 'start' }); return; }
    }

    if (t.closest('#bankMore')) {
        const more_ = t.closest('#bankMore');
        setBusy(more_, true);
        try { const page = await loadPage(last); rows = rows.concat(page.rows); last = page.last; more = page.full; filters.datePreset = 'all'; render(); }
        catch (err) { toast(err.message, 'error'); }
        return;
    }
    const cpRow = t.closest('[data-cp]');
    if (cpRow) {
        openDetail({ kind: 'cp', key: cpRow.dataset.cp });
        return;
    }
    const row = t.closest('[data-tx]');
    if (row && row.closest('#bnPane')) openDetail({ kind: 'tx', id: row.dataset.tx });
}

function onKey(e) {
    const row = e.target.closest?.('.bn-row');
    if (row && e.target === row && (e.key === 'Enter' || e.key === ' ')) {
        e.preventDefault();
        openDetail({ kind: 'tx', id: row.dataset.tx });
    }
}

export function initBankView() {
    const host = document.getElementById('viewBank');
    host.addEventListener('click', onClick);
    host.addEventListener('keydown', onKey);
    host.addEventListener('input', e => {
        const t = e.target;
        const set = (k, v) => { filters[k] = v; renderList(); };
        if (t.id === 'bankQuery') { query = t.value; renderList(); }
        else if (t.id === 'bankCpQuery') { cpQuery = t.value; renderList(); }
        else if (t.id === 'bfCounterparty') set('counterparty', t.value);
        else if (t.id === 'bfAmountMin') set('amountMin', t.value);
        else if (t.id === 'bfAmountMax') set('amountMax', t.value);
    });
    host.addEventListener('change', e => {
        const t = e.target;
        if (t.id === 'bfCategory') { filters.category = t.value; render(); }
        else if (t.id === 'bfDateFrom' || t.id === 'bfDateTo') { filters[t.id === 'bfDateFrom' ? 'dateFrom' : 'dateTo'] = t.value; filters.datePreset = 'all'; render(); }
    });
}
