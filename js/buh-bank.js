// ============================================================
// «Банк» (рахунки, згортаємі фільтри, операції за днями з простими
// значками вхідних/вихідних платежів, позначкою способу розподілу
// «Автоматично / Вручну», окреме модальне вікно деталей платежу
// з інтерактивними переходами на контрагента, договір, квартиру
// та проводку в ОСВ, а також компактна кнопка «← Назад»).
// «Налаштування» — buh-settings.js.
// Відбори, групування й рішення в один дотик — bank-view-core.js.
// ============================================================
import { escapeHtml, toast, setBusy, confirmDialog } from './ui.js';
import {
    loadSettings, loadPage, loadQueue, loadPayments, loadExpenses,
    act, money, signed, when, maskIban, ACCOUNT_PURPOSES
} from './buh-data.js';
import { toKop, fmtKop, periodName } from './charges-core.js';
import {
    TABS, DIRECTION_FILTERS, DATE_PRESETS, BANK_CATEGORY_OPTIONS,
    byDay, quickAssign, filterTx, txCategoryInfo, txDistributionInfo,
    describeTxAccountingEntry, resolveTxLinks
} from './bank-view-core.js';
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
let tab = 'all';
let query = '';
let filtersOpen = false; // За замовчуванням панель фільтрів згорнута
let opened = null; // ID операції, відкритої в окремому модальному вікні
let highlightedTxId = null;
let bankSettingsCache = {};
let bankExpensesCache = { expenses: [], contracts: [], suppliers: [] };
let bankPaymentsCache = [];
const busy = new Set();

const DEFAULT_FILTERS = () => ({
    direction: 'all',
    category: 'all',
    counterparty: '',
    account: '',
    datePreset: 'all',
    dateFrom: '',
    dateTo: '',
    amountMin: '',
    amountMax: ''
});
let filters = DEFAULT_FILTERS();

// Стан повернення на точнісінько те саме місце в «Банку» після переходу на іншу сторінку
let bankNavReturnState = null;

export function hasBankReturnState() {
    return Boolean(bankNavReturnState);
}

export function clearBankReturnBanner() {
    bankNavReturnState = null;
    document.getElementById('buhBackNavBanner')?.remove();
}

export function renderBankReturnBanner(currentView) {
    const existing = document.getElementById('buhBackNavBanner');
    if (!bankNavReturnState || currentView === 'bank') {
        existing?.remove();
        return;
    }
    const main = document.querySelector('.buh-main');
    if (!main) return;
    const html = `<div id="buhBackNavBanner" class="buh-back-nav-wrap" role="region" aria-label="Повернення в Банк">
        <button type="button" class="buh-back-nav-btn" id="buhBackNavGo">
            <span class="buh-back-nav-arrow" aria-hidden="true">←</span>
            <span>Назад</span>
        </button>
    </div>`;
    if (existing) {
        existing.outerHTML = html;
    } else {
        main.insertAdjacentHTML('afterbegin', html);
    }
    document.getElementById('buhBackNavGo')?.addEventListener('click', () => {
        returnToBankPosition();
    });
}

export function returnToBankPosition() {
    if (!bankNavReturnState) return;
    bankNavReturnState.restoring = true;
    document.getElementById('buhBackNavBanner')?.remove();
    if (location.hash !== '#bank') {
        location.hash = 'bank';
    } else {
        loadBankView();
    }
}

function navigateFromBankModal(tx, targetLabel, navigateFn) {
    bankNavReturnState = {
        txId: tx.id,
        txTitle: `${tx.counterparty?.name || 'Платіж'} · ${signed(tx)} грн`,
        targetLabel,
        tab,
        query,
        filtersOpen,
        filters: { ...filters },
        scrollY: window.scrollY,
        reopenModal: true,
        restoring: false
    };
    closeTxModal();
    navigateFn();
    setTimeout(() => {
        const curView = location.hash.replace('#', '') || 'today';
        renderBankReturnBanner(curView);
    }, 30);
}

const opsWord = n => (n % 10 === 1 && n % 100 !== 11 ? 'операція' : [2, 3, 4].includes(n % 10) && ![12, 13, 14].includes(n % 100) ? 'операції' : 'операцій');
const timeOf = ts => (ts?.toDate ? ts.toDate() : new Date(ts)).toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit' });
const humanDate = d => {
    const s = String(d || '');
    return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s.split('-').reverse().join('.') : s;
};

/** Лаконічні значки: зелений + у кружку (надходження), чорний − у квадраті з плавними кутами (списання). */
function directionIconHtml(tx, large = false) {
    const out = tx.direction === 'out';
    const wait = tx.status === 'review' || Boolean(tx.bankConflict);
    const cls = `bk-ico ${out ? 'is-out' : 'is-in'}${wait ? ' is-wait' : ''}${large ? ' is-lg' : ''}`;
    const label = out ? 'Вихідний платіж (списання з рахунку)' : 'Вхідний платіж (надходження на рахунок)';
    return `<span class="${cls}" title="${label}" aria-label="${label}">${out ? '−' : '+'}</span>`;
}

function accountBalance(a) {
    if (typeof a.balanceKop !== 'number') return '—';
    return a.currency && a.currency !== 'UAH'
        ? `${(a.balanceKop / 100).toLocaleString('uk-UA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${escapeHtml(a.currency)}`
        : money(a.balanceKop);
}

function accountsHtml(settings) {
    const accounts = Object.entries(settings.accounts || {})
        .sort(([, a], [, b]) => ((a.purpose || 'current') === 'current' ? -1 : 0) - ((b.purpose || 'current') === 'current' ? -1 : 0));
    if (!accounts.length) return `<section class="bk-card bk-hero"><span class="bk-label">Банк не підключено</span>
        <button type="button" class="sv-btn" data-go="settings" data-settings-tab="bank">Підключити ПриватБанк</button></section>`;
    const sync = settings.lastSync;
    const state = sync?.waiting ? '<span class="bk-sync">Банк зараз оновлює дані. Виписку перевіримо пізніше.</span>'
        : sync?.ok === false ? `<span class="bk-sync is-bad">${sync.partial ? 'Оновлено частково' : 'Виписка не оновилась'}: ${escapeHtml(sync.error || 'помилка')}</span>`
        : sync ? `<span class="bk-sync is-good">Виписка оновлена о ${escapeHtml(timeOf(sync.at))}</span>` : '<span class="bk-sync">Виписку ще не отримано</span>';
    return accounts.map(([iban, a], i) => `<section class="bk-card ${i ? 'bk-acc' : 'bk-hero'}">
            <span class="bk-label">${escapeHtml(ACCOUNT_PURPOSES[a.purpose] || 'Рахунок')} · ПриватБанк${a.available === false ? ' · немає доступу' : ''}</span>
            <b class="bk-balance">${accountBalance(a)}</b>
            <span class="bk-iban">${escapeHtml(maskIban(iban))}${a.balanceAt ? ` · залишок на ${escapeHtml(when(a.balanceAt))}` : ''}</span>
            ${i ? '' : state}
            ${a.available !== false && a.lastSync?.ok === false ? `<span class="bk-sync is-bad">Рахунок не оновлено: ${escapeHtml(a.lastSync.error)}</span>` : ''}
        </section>`).join('');
}

function normalizedFilters() {
    const minKop = filters.amountMin ? toKop(filters.amountMin) : null;
    const maxKop = filters.amountMax ? toKop(filters.amountMax) : null;
    return {
        direction: filters.direction,
        category: filters.category,
        counterparty: filters.counterparty,
        account: filters.account,
        datePreset: filters.datePreset,
        dateFrom: filters.dateFrom,
        dateTo: filters.dateTo,
        amountMinKop: Number.isFinite(minKop) && minKop > 0 ? minKop : null,
        amountMaxKop: Number.isFinite(maxKop) && maxKop > 0 ? maxKop : null
    };
}

function countActivePanelFilters() {
    let count = 0;
    if (filters.direction !== 'all') count++;
    if (filters.category !== 'all') count++;
    if (filters.counterparty.trim()) count++;
    if (filters.account) count++;
    if (filters.datePreset !== 'all' || filters.dateFrom || filters.dateTo) count++;
    if (filters.amountMin.trim() || filters.amountMax.trim()) count++;
    return count;
}

function hasActiveFilters() {
    return Boolean(query.trim() || countActivePanelFilters() > 0);
}

function updateFilterToggleBtn() {
    const btn = document.getElementById('bankFilterToggle');
    if (!btn) return;
    const activeCount = countActivePanelFilters();
    btn.classList.toggle('is-open', filtersOpen);
    btn.classList.toggle('has-active', activeCount > 0);
    btn.setAttribute('aria-expanded', String(filtersOpen));
    const labelEl = btn.querySelector('.bk-filter-toggle-label');
    if (labelEl) labelEl.textContent = activeCount > 0 ? `Фільтр (${activeCount})` : 'Фільтр';
    const caretEl = btn.querySelector('.bk-filter-caret');
    if (caretEl) caretEl.textContent = filtersOpen ? '▴' : '▾';
}

function collectCounterpartySuggestions() {
    const names = new Set();
    for (const s of bankExpensesCache.suppliers || []) {
        if (s.name) names.add(s.name);
    }
    for (const tx of [...rows, ...queue]) {
        if (tx.counterparty?.name) names.add(tx.counterparty.name);
    }
    return [...names].slice(0, 120);
}

function filtersBarHtml(settings) {
    const accounts = Object.entries(settings.accounts || {});
    const cpSuggestions = collectCounterpartySuggestions();
    return `<div class="bk-filters-panel" id="bankFiltersPanel"${filtersOpen ? '' : ' hidden'}>
        <div class="bk-filter-pills-row">
            <div class="bk-pill-group" role="group" aria-label="Напрямок платежу">
                ${Object.entries(DIRECTION_FILTERS).map(([k, v]) =>
                    `<button type="button" class="bk-pill${filters.direction === k ? ' active' : ''} is-dir-${k}" data-filter-dir="${k}">${escapeHtml(v)}</button>`
                ).join('')}
            </div>
            <div class="bk-pill-group" role="group" aria-label="Швидкий вибір періоду">
                ${Object.entries(DATE_PRESETS).map(([k, v]) =>
                    `<button type="button" class="bk-pill${filters.datePreset === k && !filters.dateFrom && !filters.dateTo ? ' active' : ''}" data-filter-preset="${k}">${escapeHtml(v)}</button>`
                ).join('')}
            </div>
        </div>
        <div class="bk-filter-inputs-grid">
            <label class="bk-filter-field">
                <span>Категорія платежу</span>
                <select id="bfCategory" class="field-input field-select">
                    ${Object.entries(BANK_CATEGORY_OPTIONS).map(([k, v]) =>
                        `<option value="${escapeHtml(k)}"${filters.category === k ? ' selected' : ''}>${escapeHtml(v)}</option>`
                    ).join('')}
                </select>
            </label>
            <label class="bk-filter-field">
                <span>Контрагент / платник</span>
                <input id="bfCounterparty" list="bfCounterpartyList" class="field-input" placeholder="Назва, код ЄДРПОУ або кв." value="${escapeHtml(filters.counterparty)}">
                <datalist id="bfCounterpartyList">
                    ${cpSuggestions.map(n => `<option value="${escapeHtml(n)}"></option>`).join('')}
                </datalist>
            </label>
            <label class="bk-filter-field">
                <span>Дата з</span>
                <input id="bfDateFrom" type="date" class="field-input" value="${escapeHtml(filters.dateFrom)}">
            </label>
            <label class="bk-filter-field">
                <span>Дата по</span>
                <input id="bfDateTo" type="date" class="field-input" value="${escapeHtml(filters.dateTo)}">
            </label>
            <label class="bk-filter-field">
                <span>Сума від, грн</span>
                <input id="bfAmountMin" inputmode="decimal" class="field-input" placeholder="0,00" value="${escapeHtml(filters.amountMin)}">
            </label>
            <label class="bk-filter-field">
                <span>Сума до, грн</span>
                <input id="bfAmountMax" inputmode="decimal" class="field-input" placeholder="без межі" value="${escapeHtml(filters.amountMax)}">
            </label>
            ${accounts.length > 1 ? `<label class="bk-filter-field">
                <span>Рахунок ОСББ</span>
                <select id="bfAccount" class="field-input field-select">
                    <option value="">Усі рахунки ОСББ</option>
                    ${accounts.map(([iban, a]) => `<option value="${escapeHtml(iban)}"${filters.account === iban ? ' selected' : ''}>${escapeHtml(maskIban(iban))} · ${escapeHtml(ACCOUNT_PURPOSES[a.purpose] || 'Поточний')}</option>`).join('')}
                </select>
            </label>` : ''}
        </div>
        <div id="bankFilterSummary" class="bk-filter-summary"></div>
    </div>`;
}

function renderFilterSummary(list) {
    const box = document.getElementById('bankFilterSummary');
    if (!box) return;
    const inKop = list.filter(t => t.direction === 'in').reduce((s, t) => s + (t.amountKop || 0), 0);
    const outKop = list.filter(t => t.direction === 'out').reduce((s, t) => s + (t.amountKop || 0), 0);
    const active = hasActiveFilters();
    box.innerHTML = `
        <div class="bk-summary-stats">
            <span>Знайдено: <b>${list.length} ${opsWord(list.length)}</b></span>
            ${inKop ? `<span class="bk-stat-in">+ Надходження: <b>+${fmtKop(inKop)} грн</b></span>` : ''}
            ${outKop ? `<span class="bk-stat-out">− Списання: <b>−${fmtKop(outKop)} грн</b></span>` : ''}
        </div>
        ${active ? '<button type="button" class="btn-ghost-small bk-reset-btn" data-act="reset-filters">Скинути фільтри ✕</button>' : ''}
        ${more && tab !== 'review' ? `<p class="buh-note">Пошук і суми враховують лише завантажені операції (${rows.length}). Старіші — кнопкою «Показати ще» внизу.</p>` : ''}
    `;
    updateFilterToggleBtn();
}

/** Модальне вікно з повною інформацією про платіж та інтерактивними посиланнями. */
function txModalHtml(tx, topOffsetPx = 88) {
    if (!tx) return '';
    const out = tx.direction === 'out';
    const cat = txCategoryInfo(tx);
    const dist = txDistributionInfo(tx);
    const entry = describeTxAccountingEntry(tx, {
        expenses: bankExpensesCache.expenses,
        accounts: bankSettingsCache.accounts
    });
    const links = resolveTxLinks(tx, {
        expenses: bankExpensesCache.expenses,
        contracts: bankExpensesCache.contracts,
        suppliers: bankExpensesCache.suppliers,
        payments: bankPaymentsCache
    });
    const accObj = bankSettingsCache.accounts?.[tx.account] || {};
    const accPurpose = ACCOUNT_PURPOSES[accObj.purpose] || 'Поточний рахунок ОСББ';
    const undo = tx.status === 'done' && tx.kind !== 'internal' && !tx.bankConflict && !tx.bankVoided;

    const cp = links.counterpartyLink || {};
    const cpRequisites = [
        tx.counterparty?.code ? `Код ЄДРПОУ / РНОКПП: ${tx.counterparty.code}` : '',
        tx.counterparty?.account ? `IBAN: ${tx.counterparty.account}` : ''
    ].filter(Boolean).join(' · ');

    const con = links.contractLink;
    const contractTitle = con
        ? `${con.subject || 'Договір'} · № ${con.number || 'б/н'}${con.date ? ` від ${humanDate(con.date)}` : ''}`
        : '';

    return `<div class="modal-backdrop bk-modal-backdrop" id="bankTxModalBackdrop" data-act="close-modal"></div>
    <div class="modal-dialog bk-modal-dialog" id="bankTxModal" role="dialog" tabindex="-1" aria-modal="true" aria-labelledby="bankTxModalTitle" style="--bk-top-offset: ${topOffsetPx}px">
        <div class="bk-modal-head ${out ? 'is-out' : 'is-in'}">
            <div class="bk-modal-head-top">
                <div class="bk-modal-dir-wrap">
                    ${directionIconHtml(tx, true)}
                    <div>
                        <div class="bk-modal-badges-line">
                            <span class="bk-modal-dir-badge ${out ? 'is-out' : 'is-in'}">
                                ${out ? 'Вихідний платіж (списання)' : 'Вхідний платіж (надходження)'}
                            </span>
                            <span class="bk-dist-badge ${dist.badgeCls}" title="${escapeHtml(dist.reason)}">
                                ${escapeHtml(dist.label)}
                            </span>
                        </div>
                        <div class="bk-modal-date">Дата і час проведення: <b>${escapeHtml(when(tx.at))}</b></div>
                    </div>
                </div>
                <button type="button" class="sheet-close bk-modal-close" data-act="close-modal" aria-label="Закрити вікно">✕</button>
            </div>
            <div class="bk-modal-amount-row">
                <h2 id="bankTxModalTitle" class="bk-modal-amount ${out ? 'is-out' : 'is-in'}">${signed(tx)} грн</h2>
                <span class="buh-tag ${cat.badgeCls}">${escapeHtml(cat.label)}</span>
            </div>
        </div>

        <div class="bk-modal-body">
            <div class="bk-modal-section">
                <span class="bk-modal-label">Контрагент та його реквізити (натисніть для переходу в картку)</span>
                <button type="button" class="bk-interactive-card" data-bank-nav="counterparty" data-tx-id="${escapeHtml(tx.id)}">
                    <div class="bk-ic-main">
                        <div class="bk-ic-title-row">
                            <b class="bk-ic-title">${escapeHtml(tx.counterparty?.name || cp.name || 'Невідомий контрагент')}</b>
                            <span class="bk-ic-pill">${escapeHtml(cp.badge || 'Контрагент')}</span>
                        </div>
                        <span class="bk-ic-sub">${escapeHtml(cpRequisites || 'Реквізити рахунку або коду не передані банком')}</span>
                        <span class="bk-ic-hint">${escapeHtml(cp.hint || 'Перейти на сторінку контрагента в системі')}</span>
                    </div>
                    <span class="bk-ic-arrow" aria-hidden="true">Перейти ›</span>
                </button>
            </div>

            ${con ? `<div class="bk-modal-section">
                <span class="bk-modal-label">Договір (натисніть для переходу до договору в системі)</span>
                <button type="button" class="bk-interactive-card is-contract" data-bank-nav="contract" data-tx-id="${escapeHtml(tx.id)}">
                    <div class="bk-ic-main">
                        <div class="bk-ic-title-row">
                            <b class="bk-ic-title">${escapeHtml(contractTitle)}</b>
                            <span class="bk-ic-pill">${con.inDatabase ? 'У реєстрі договорів' : 'За призначенням платежу'}</span>
                        </div>
                        <span class="bk-ic-sub">Контрагент: ${escapeHtml(con.supplierName || tx.counterparty?.name || '—')}${con.number ? ` · № ${escapeHtml(con.number)}` : ''}${con.date ? ` · від ${escapeHtml(humanDate(con.date))}` : ''}</span>
                        <span class="bk-ic-hint">Відкрити договір у розділі «Документи → Договори»</span>
                    </div>
                    <span class="bk-ic-arrow" aria-hidden="true">До договору ›</span>
                </button>
            </div>` : ''}

            ${entry ? `<div class="bk-modal-section">
                <span class="bk-modal-label">Проводка в обліку (ОСВ) — попередній вигляд, точна — в «ОСВ»</span>
                <button type="button" class="bk-interactive-card is-journal" data-bank-nav="journal" data-tx-id="${escapeHtml(tx.id)}">
                    <div class="bk-ic-main">
                        <div class="bk-ic-title-row">
                            <b class="bk-ic-title">${escapeHtml(entry.codeText)} · ${fmtKop(tx.amountKop)} грн</b>
                            <span class="bk-ic-pill">Період: ${escapeHtml(entry.period ? periodName(entry.period) : 'поточний')}</span>
                        </div>
                        <span class="bk-ic-sub"><b>Дебет ${escapeHtml(entry.dr)}:</b> ${escapeHtml(entry.drTitle)}${entry.drAnalytics ? ` (${escapeHtml(entry.drAnalytics)})` : ''}</span>
                        <span class="bk-ic-sub"><b>Кредит ${escapeHtml(entry.cr)}:</b> ${escapeHtml(entry.crTitle)}${entry.crAnalytics ? ` (${escapeHtml(entry.crAnalytics)})` : ''}</span>
                        <span class="bk-ic-hint">Перейти до цієї проводки в «ОСВ / Проводки» (рахунок ${escapeHtml(entry.focusAcc)})</span>
                    </div>
                    <span class="bk-ic-arrow" aria-hidden="true">В ОСВ ›</span>
                </button>
            </div>` : ''}

            <dl class="bk-modal-grid">
                <div class="bk-modal-field is-wide">
                    <dt>Призначення платежу</dt>
                    <dd class="bk-purpose-box">${escapeHtml(tx.purpose || 'Без призначення')}</dd>
                </div>
                <div class="bk-modal-field">
                    <dt>Категорія платежу</dt>
                    <dd><b>${escapeHtml(cat.label)}</b></dd>
                </div>
                <div class="bk-modal-field">
                    <dt>Спосіб розподілу</dt>
                    <dd>
                        <span class="bk-dist-badge ${dist.badgeCls}">${escapeHtml(dist.label)}</span>
                        <small class="bk-dist-sub">${escapeHtml(dist.reason)}</small>
                    </dd>
                </div>
                <div class="bk-modal-field is-wide">
                    <dt>Рахунок ОСББ (${out ? 'списано з' : 'зараховано на'})</dt>
                    <dd><b>${escapeHtml(accPurpose)}</b> · <code class="bk-code-iban">${escapeHtml(tx.account || '—')}</code> <small class="t-muted">(${escapeHtml(maskIban(tx.account))})</small></dd>
                </div>
                ${(tx.allocations || []).length > 0 ? `<div class="bk-modal-field is-wide">
                    <dt>Розподіл за квартирами (особовими рахунками)</dt>
                    <dd class="bk-apt-pills">
                        ${tx.allocations.map(a => `<button type="button" class="bk-apt-link" data-bank-nav="flat" data-apt="${escapeHtml(String(a.apt))}" data-tx-id="${escapeHtml(tx.id)}">
                            Квартира № ${escapeHtml(String(a.apt))} · <b>${money(a.amountKop)}</b> ›
                        </button>`).join(' ')}
                    </dd>
                </div>` : ''}
                ${links.expenseDoc ? `<div class="bk-modal-field is-wide">
                    <dt>Первинний документ витрат</dt>
                    <dd>
                        <button type="button" class="bk-apt-link" data-bank-nav="expense" data-doc-id="${escapeHtml(links.expenseDoc.id)}" data-tx-id="${escapeHtml(tx.id)}">
                            Документ № ${escapeHtml(links.expenseDoc.number || links.expenseDoc.id)}${links.expenseDoc.date ? ` від ${escapeHtml(humanDate(links.expenseDoc.date))}` : ''} · Відкрити документ ›
                        </button>
                    </dd>
                </div>` : ''}
            </dl>
        </div>

        <div class="bk-modal-foot">
            ${tx.status === 'review' || tx.bankConflict ? `<button type="button" class="sv-btn" data-bank-nav="inbox" data-tx-id="${escapeHtml(tx.id)}">Розібрати в «Рішеннях»</button>` : ''}
            ${tx.paymentId ? `<button type="button" class="sv-btn is-soft" data-open="payment" data-id="${escapeHtml(tx.paymentId)}">Платіжне доручення ›</button>` : ''}
            <button type="button" class="sv-btn is-soft" data-open="tx" data-id="${escapeHtml(tx.id)}">Усі звʼязки ланцюжка ›</button>
            ${undo ? `<button type="button" class="sv-btn is-soft" data-act="undo" data-tx-id="${escapeHtml(tx.id)}">Повернути в «Рішення»</button>` : ''}
            <button type="button" class="btn-ghost-small" data-act="close-modal" style="margin-left:auto">Закрити</button>
        </div>
    </div>`;
}

function openTxModal(txId) {
    opened = txId;
    const host = document.getElementById('bankModalHost');
    if (!host) return;
    const tx = rows.find(x => x.id === txId) || queue.find(x => x.id === txId);
    if (!tx) {
        opened = null;
        host.innerHTML = '';
        return;
    }
    const topBarRect = document.querySelector('.buh-top')?.getBoundingClientRect();
    const topOffsetPx = Math.max(76, Math.ceil((topBarRect?.bottom || 74) + 12));
    host.innerHTML = txModalHtml(tx, topOffsetPx);
    // Фокус у вікно: Esc і Tab працюють одразу, а не лише після кліку всередині.
    document.getElementById('bankTxModal')?.focus({ preventScroll: true });
    document.querySelectorAll('#bankList .bk-row').forEach(r => {
        r.classList.toggle('is-open', r.dataset.id === txId);
    });
}

function closeTxModal() {
    const wasOpen = opened;
    opened = null;
    const host = document.getElementById('bankModalHost');
    if (host) host.innerHTML = '';
    document.querySelectorAll('#bankList .bk-row.is-open').forEach(r => r.classList.remove('is-open'));
    if (wasOpen) [...document.querySelectorAll('#bankList .bk-row')].find(r => r.dataset.id === wasOpen)?.focus({ preventScroll: true });
}

function chipHtml(tx) {
    const cat = txCategoryInfo(tx);
    const dist = txDistributionInfo(tx);
    if (tx.status !== 'review') {
        return `<span class="bk-right-chips">
            <span class="bk-done ${cat.badgeCls}" title="${escapeHtml(cat.label)}">✓ ${escapeHtml(cat.shortLabel)}</span>
            <span class="bk-dist-chip ${dist.badgeCls}" title="${escapeHtml(`${dist.label}: ${dist.reason}`)}">${escapeHtml(dist.shortLabel)}</span>
        </span>`;
    }
    const q = quickAssign(tx);
    if (busy.has(tx.id)) return '<span class="bk-done">Зберігаю…</span>';
    if (q) return `<button type="button" class="bk-yes${q.sure ? '' : ' is-ask'}" data-act="quick">${q.sure ? `Так, кв. ${escapeHtml(q.apt)}` : `Це кв. ${escapeHtml(q.apt)}?`}</button>`;
    return '<button type="button" class="bk-yes is-ask" data-go="inbox">Розібрати ›</button>';
}

function rowHtml(tx) {
    const out = tx.direction === 'out';
    const isHighlighted = highlightedTxId === tx.id;
    const links = resolveTxLinks(tx, {
        expenses: bankExpensesCache.expenses,
        contracts: bankExpensesCache.contracts,
        suppliers: bankExpensesCache.suppliers,
        payments: bankPaymentsCache
    });
    const conBadge = links.contractLink
        ? `<span class="bk-row-subpill">📑 ${escapeHtml(links.contractLink.number && links.contractLink.number !== 'б/н' ? `Договір № ${links.contractLink.number}` : links.contractLink.subject)}</span>`
        : '';
    return `<div class="bk-row${opened === tx.id ? ' is-open' : ''}${isHighlighted ? ' buh-nav-target-highlight' : ''}" data-id="${escapeHtml(tx.id)}" tabindex="0" role="button" aria-haspopup="dialog" aria-expanded="${opened === tx.id}">
            ${directionIconHtml(tx)}
            <span class="bk-main">
                <span class="bk-main-top">
                    <b>${escapeHtml(tx.counterparty?.name || '—')}</b>
                    ${conBadge}
                </span>
                <small>${escapeHtml(tx.purpose || '')}</small>
            </span>
            <span class="bk-right">
                <b class="bk-sum ${out ? 'is-out' : 'is-in'}">${signed(tx)} грн</b>
                ${chipHtml(tx)}
            </span>
        </div>`;
}

function dayGroupHtml(d) {
    const dayIn = d.rows.filter(t => t.direction === 'in').reduce((s, t) => s + (t.amountKop || 0), 0);
    const dayOut = d.rows.filter(t => t.direction === 'out').reduce((s, t) => s + (t.amountKop || 0), 0);
    return `<div class="bk-day-group">
        <div class="bk-day">
            <span class="bk-day-title">${escapeHtml(d.label)} <small>(${d.rows.length})</small></span>
            <span class="bk-day-totals">
                ${dayIn ? `<span class="is-in">+${fmtKop(dayIn)} грн</span>` : ''}
                ${dayOut ? `<span class="is-out">−${fmtKop(dayOut)} грн</span>` : ''}
            </span>
        </div>
        <div class="bk-day-rows">${d.rows.map(rowHtml).join('')}</div>
    </div>`;
}

function renderList() {
    const host = document.getElementById('bankList');
    if (!host) return;
    const source = tab === 'review' ? queue : rows;
    const list = filterTx(source, tab, query, normalizedFilters());
    const moreBtn = document.getElementById('bankMore');
    if (moreBtn) moreBtn.hidden = !more || tab === 'review';
    renderFilterSummary(list);
    host.innerHTML = list.length
        ? byDay(list).map(dayGroupHtml).join('')
        : `<p class="py-empty">${hasActiveFilters() ? 'За обраними фільтрами операцій не знайдено' : tab === 'review' ? 'Усі операції розподілено' : 'Операцій ще немає'}</p>`;
    if (opened) openTxModal(opened);
}

export async function loadBankView() {
    const [settings, page, q, payments, expData] = await Promise.all([
        loadSettings(),
        loadPage(),
        loadQueue().catch(() => []),
        loadPayments().catch(() => []),
        loadExpenses().catch(() => ({ expenses: [], contracts: [], suppliers: [] }))
    ]);
    bankSettingsCache = settings || {};
    bankExpensesCache = expData || { expenses: [], contracts: [], suppliers: [] };
    bankPaymentsCache = payments || [];
    rows = page.rows; last = page.last; more = page.full;
    queue = q;

    // Якщо повертаємось за кнопкою «← Назад» — відновлюємо фільтри та обраний платіж
    let restoreSnapshot = null;
    if (bankNavReturnState) {
        restoreSnapshot = { ...bankNavReturnState };
        tab = restoreSnapshot.tab || 'all';
        query = restoreSnapshot.query || '';
        filtersOpen = Boolean(restoreSnapshot.filtersOpen);
        filters = { ...DEFAULT_FILTERS(), ...(restoreSnapshot.filters || {}) };
        opened = restoreSnapshot.reopenModal ? restoreSnapshot.txId : null;
        highlightedTxId = restoreSnapshot.txId;
        bankNavReturnState = null;
        document.getElementById('buhBackNavBanner')?.remove();
    }

    const activeCount = countActivePanelFilters();
    const signing = payments.filter(p => p.status === 'sent');
    const host = document.getElementById('viewBank');
    host.innerHTML = `${signing.length ? `<div class="bk-links"><button type="button" class="bk-link" data-go="payments">Платежі на підписі голови · ${signing.length} ›</button></div>` : ''}
        <div class="bk-top">
            ${accountsHtml(settings)}
            ${queue.length ? `<button type="button" class="bk-card bk-need" data-go="inbox">
                <span class="bk-label">Потрібне ваше рішення</span>
                <b class="bk-balance">${queue.length} ${opsWord(queue.length)}</b>
                <span class="bk-need-go">Розподілити ›</span>
            </button>` : ''}
        </div>
        <section class="bk-card bk-ops">
            <div class="bk-ops-head">
                <h2>Операції за випискою</h2>
                <div class="bk-ops-controls">
                    <div class="bk-tabs" role="tablist">${Object.entries(TABS).map(([k, v]) =>
                        `<button type="button" class="bk-tab${k === tab ? ' active' : ''}" role="tab" aria-selected="${k === tab}" data-tab="${k}">${v}${k === 'review' && queue.length ? ` <span>${queue.length}</span>` : ''}</button>`).join('')}</div>
                    <button type="button" class="bk-filter-toggle${filtersOpen ? ' is-open' : ''}${activeCount ? ' has-active' : ''}" id="bankFilterToggle" data-act="toggle-filters" aria-expanded="${filtersOpen}" aria-controls="bankFiltersPanel">
                        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/></svg>
                        <span class="bk-filter-toggle-label">${activeCount ? `Фільтр (${activeCount})` : 'Фільтр'}</span>
                        <span class="bk-filter-caret" aria-hidden="true">${filtersOpen ? '▴' : '▾'}</span>
                    </button>
                </div>
            </div>
            <label class="fl-search dc-search bk-search"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>
                <input type="search" id="bankQuery" placeholder="Квартира, платник, ЄДРПОУ, договір, сума або призначення" value="${escapeHtml(query)}" aria-label="Пошук операції"></label>
            ${filtersBarHtml(settings)}
            <div id="bankList"></div>
            <button type="button" id="bankMore" class="sv-btn is-soft is-wide" hidden>Показати ще</button>
        </section>
        <div id="bankModalHost"></div>`;
    renderList();

    if (restoreSnapshot) {
        setTimeout(() => {
            if (typeof restoreSnapshot.scrollY === 'number') {
                window.scrollTo({ top: restoreSnapshot.scrollY, behavior: 'instant' });
            } else {
                const rowEl = document.querySelector(`#bankList .bk-row[data-id="${CSS.escape(restoreSnapshot.txId)}"]`);
                rowEl?.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }
            setTimeout(() => {
                highlightedTxId = null;
                document.querySelectorAll('#bankList .bk-row.buh-nav-target-highlight').forEach(el => el.classList.remove('buh-nav-target-highlight'));
            }, 3000);
        }, 40);
    }
}

async function quick(tx, btn) {
    const q = quickAssign(tx);
    if (!q) return;
    if (!q.sure && !await confirmDialog(`Це оплата кв. ${q.apt}?`, `${tx.counterparty?.name || 'Платник'}: ${money(tx.amountKop)}. «${tx.purpose || ''}». Система не впевнена — перевірте призначення.`, `Так, кв. ${q.apt}`)) return;
    busy.add(tx.id);
    renderList();
    try {
        await act({ action: 'assign', txId: tx.id, allocations: [{ apt: q.apt, amountKop: tx.amountKop }], remember: q.sure });
        toast(`Рознесено: кв. ${q.apt}`, 'success');
    } catch (err) { toast(err.message, 'error'); }
    finally { busy.delete(tx.id); if (btn.isConnected) renderList(); }
}

function handleBankModalNavigation(navBtn) {
    const kind = navBtn.dataset.bankNav;
    const txId = navBtn.dataset.txId || opened;
    const tx = rows.find(x => x.id === txId) || queue.find(x => x.id === txId);
    if (!tx) return;

    const links = resolveTxLinks(tx, {
        expenses: bankExpensesCache.expenses,
        contracts: bankExpensesCache.contracts,
        suppliers: bankExpensesCache.suppliers,
        payments: bankPaymentsCache
    });
    const entry = describeTxAccountingEntry(tx, {
        expenses: bankExpensesCache.expenses,
        accounts: bankSettingsCache.accounts
    });

    if (kind === 'counterparty') {
        const cp = links.counterpartyLink || {};
        if (cp.kind === 'flat') {
            navigateFromBankModal(tx, cp.apt ? `Квартира № ${cp.apt}` : 'Квартири', () => {
                openFlat(cp.apt || null);
            });
        } else if (cp.kind === 'advance') {
            navigateFromBankModal(tx, `Авансовий звіт (${cp.name})`, () => {
                openAdvance('all', cp.id || null);
            });
        } else if (cp.kind === 'payroll') {
            navigateFromBankModal(tx, `Зарплата (${cp.name})`, () => {
                openPayroll(cp.period || null);
            });
        } else {
            navigateFromBankModal(tx, `Контрагент «${cp.name || tx.counterparty?.name || 'Контрагент'}»`, () => {
                openExpenses('suppliers', null, null, {
                    kind: 'supplier',
                    id: cp.id || '',
                    name: cp.name || tx.counterparty?.name || '',
                    code: cp.code || tx.counterparty?.code || '',
                    iban: cp.iban || tx.counterparty?.account || '',
                    contract: links.contractLink ? { ...links.contractLink, amountKop: tx.amountKop || 0 } : null
                });
            });
        }
    } else if (kind === 'contract') {
        const con = links.contractLink || {};
        navigateFromBankModal(tx, `Договір № ${con.number || 'б/н'}`, () => {
            openExpenses('contracts', null, null, {
                kind: 'contract',
                id: con.id || '',
                number: con.number || 'б/н',
                date: con.date || '',
                subject: con.subject || '',
                supplierId: con.supplierId || '',
                supplierName: con.supplierName || tx.counterparty?.name || '',
                code: tx.counterparty?.code || '',
                iban: tx.counterparty?.account || '',
                amountKop: tx.amountKop || 0
            });
        });
    } else if (kind === 'journal' && entry) {
        navigateFromBankModal(tx, `Проводка ${entry.codeText} в ОСВ`, () => {
            openJournal(entry.period || null, {
                acc: entry.focusAcc,
                cashAcc: entry.cashAcc,
                ref: tx.id
            });
        });
    } else if (kind === 'flat') {
        const apt = navBtn.dataset.apt;
        navigateFromBankModal(tx, `Квартира № ${apt}`, () => {
            openFlat(apt);
        });
    } else if (kind === 'expense') {
        const docId = navBtn.dataset.docId;
        navigateFromBankModal(tx, 'Первинний документ витрат', () => {
            openExpenses('docs', null, docId);
        });
    } else if (kind === 'inbox') {
        navigateFromBankModal(tx, 'Розбір операції у «Рішеннях»', () => {
            location.hash = 'inbox';
        });
    }
}

function updatePillActiveStates(host) {
    host.querySelectorAll('[data-filter-dir]').forEach(b => {
        b.classList.toggle('active', b.dataset.filterDir === filters.direction);
    });
    host.querySelectorAll('[data-filter-preset]').forEach(b => {
        b.classList.toggle('active', b.dataset.filterPreset === filters.datePreset && !filters.dateFrom && !filters.dateTo);
    });
}

export function initBankView() {
    const host = document.getElementById('viewBank');
    host.addEventListener('input', e => {
        const t = e.target;
        if (t.id === 'bankQuery') { query = t.value; renderList(); }
        else if (t.id === 'bfCounterparty') { filters.counterparty = t.value; renderList(); }
        else if (t.id === 'bfAmountMin') { filters.amountMin = t.value; renderList(); }
        else if (t.id === 'bfAmountMax') { filters.amountMax = t.value; renderList(); }
    });
    host.addEventListener('change', e => {
        const t = e.target;
        if (t.id === 'bfCategory') { filters.category = t.value; renderList(); }
        else if (t.id === 'bfAccount') { filters.account = t.value; renderList(); }
        else if (t.id === 'bfDateFrom') { filters.dateFrom = t.value; filters.datePreset = 'all'; updatePillActiveStates(host); renderList(); }
        else if (t.id === 'bfDateTo') { filters.dateTo = t.value; filters.datePreset = 'all'; updatePillActiveStates(host); renderList(); }
    });
    host.addEventListener('click', async e => {
        if (e.target.closest('[data-act="close-modal"]')) {
            closeTxModal();
            return;
        }
        if (e.target.closest('[data-act="toggle-filters"]')) {
            filtersOpen = !filtersOpen;
            const panel = document.getElementById('bankFiltersPanel');
            if (panel) panel.hidden = !filtersOpen;
            updateFilterToggleBtn();
            return;
        }
        const navBtn = e.target.closest('[data-bank-nav]');
        if (navBtn) {
            handleBankModalNavigation(navBtn);
            return;
        }
        const dirBtn = e.target.closest('[data-filter-dir]');
        if (dirBtn) {
            filters.direction = dirBtn.dataset.filterDir;
            updatePillActiveStates(host);
            renderList();
            return;
        }
        const presetBtn = e.target.closest('[data-filter-preset]');
        if (presetBtn) {
            filters.datePreset = presetBtn.dataset.filterPreset;
            filters.dateFrom = '';
            filters.dateTo = '';
            const df = document.getElementById('bfDateFrom');
            const dt = document.getElementById('bfDateTo');
            if (df) df.value = '';
            if (dt) dt.value = '';
            updatePillActiveStates(host);
            renderList();
            return;
        }
        if (e.target.closest('[data-act="reset-filters"]')) {
            query = '';
            filters = DEFAULT_FILTERS();
            loadBankView();
            return;
        }
        const t = e.target.closest('[data-tab]');
        if (t) {
            tab = t.dataset.tab;
            host.querySelectorAll('[data-tab]').forEach(b => { b.classList.toggle('active', b === t); b.setAttribute('aria-selected', b === t); });
            renderList();
            return;
        }
        if (e.target.closest('#bankMore')) {
            const btn = e.target.closest('#bankMore');
            setBusy(btn, true);
            try { const page = await loadPage(last); rows = rows.concat(page.rows); last = page.last; more = page.full; renderList(); }
            catch (err) { toast(err.message, 'error'); }
            finally { setBusy(btn, false); }
            return;
        }
        const link = e.target.closest('[data-open]');
        if (link) {
            const id = link.dataset.id;
            closeTxModal();
            if (link.dataset.open === 'payment') openPaymentSheet(id);
            else if (link.dataset.open === 'doc') openExpenses('docs', null, id);
            else openTxSheet(id);
            return;
        }
        const quickBtn = e.target.closest('[data-act="quick"]');
        if (quickBtn) {
            const id = quickBtn.closest('[data-id]').dataset.id;
            const tx = queue.find(x => x.id === id) || rows.find(x => x.id === id);
            if (tx) await quick(tx, quickBtn);
            return;
        }
        const undoBtn = e.target.closest('[data-act="undo"]');
        if (undoBtn) {
            const targetId = undoBtn.dataset.txId || opened;
            const tx = rows.find(x => x.id === targetId) || queue.find(x => x.id === targetId);
            if (!tx || !await confirmDialog('Повернути в «Рішення»?', tx.kind === 'payment'
                ? 'Оплату буде прибрано з історії квартири, операція знову чекатиме рішення.' : 'Категорію буде знято.', 'Повернути')) return;
            try {
                await act({ action: 'unassign', txId: tx.id });
                closeTxModal();
                toast('Повернуто в «Рішення»', 'success');
            } catch (err) { toast(err.message, 'error'); }
            return;
        }
        if (e.target.closest('[data-go]')) return;
        const row = e.target.closest('.bk-row');
        if (row) {
            openTxModal(row.dataset.id);
        }
    });
    host.addEventListener('keydown', e => {
        if (e.key === 'Escape' && opened) {
            e.preventDefault();
            closeTxModal();
            return;
        }
        const row = e.target.closest('.bk-row');
        if (row && e.target === row && (e.key === 'Enter' || e.key === ' ')) {
            e.preventDefault();
            openTxModal(row.dataset.id);
        }
    });
}
