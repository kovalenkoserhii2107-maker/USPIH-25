// ============================================================
// «Банк» (рахунки й операції за днями) і «Налаштування» (5 підвкладок:
//   1. Організація та реквізити
//   2. Банк та інтеграції
//   3. Облік, податки та правила
//   4. Тарифи та довідники (дублюючі)
//   5. Стартові дані та база).
// Відбори, групування й рішення в один дотик — bank-view-core.js.
// ============================================================
import { escapeHtml, toast, setBusy, confirmDialog, promptDialog } from './ui.js';
import { db, session } from './firebase.js';
import { doc, setDoc, writeBatch } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js';
import {
    loadSettings, loadPage, loadQueue, loadPayments, loadExpenses, loadRequisites,
    loadCharges, loadPayroll, loadBudget,
    expAct, act, chargeAct, payrollAct, budgetAct, reportsQuery, reportsAct,
    money, signed, when, dateOnly, tagOf, maskIban,
    ACCOUNT_PURPOSES, METHOD, loadStaffNames, authorLabel
} from './buh-data.js';
import { toKop, fmtKop, periodName, parseOpeningLines, openingSummary } from './charges-core.js';
import { registryHtml, saveRegistry } from './buh-registry.js';
import { TABS, byDay, quickAssign, filterTx } from './bank-view-core.js';
import { openTxSheet, openPaymentSheet } from './buh-chain.js';
import { openExpenses } from './buh-expenses.js';
import { openCharges } from './buh-charges.js';
import { openPayrollPerson, getPayMethod, setPayMethod, DEFAULT_TAXES, withDefaultTaxes } from './buh-payroll.js';
import { loadOpening, openingAction, openingInput } from './buh-opening.js';
import { loadAccountingSettings } from './buh-accounting-settings.js';
import { mountMigration } from './buh-migration.js';
import { mountDatabaseReset, databaseResetStatus } from './buh-database-reset.js';

let requisites = {};

let rows = [];
let queue = [];
let last = null;
let more = false;
let tab = 'all';
let query = '';
let opened = null;
const busy = new Set();

const opsWord = n => (n % 10 === 1 && n % 100 !== 11 ? 'операція' : [2, 3, 4].includes(n % 10) && ![12, 13, 14].includes(n % 100) ? 'операції' : 'операцій');
const timeOf = ts => (ts?.toDate ? ts.toDate() : new Date(ts)).toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit' });

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

function detailHtml(tx) {
    const lines = [
        ['Дата', dateOnly(tx.at)],
        ['Рахунок ОСББ', maskIban(tx.account)],
        ['Контрагент', [tx.counterparty?.name, tx.counterparty?.code ? `код ${tx.counterparty.code}` : '', tx.counterparty?.account].filter(Boolean).join(' · ')],
        ['Призначення', tx.purpose],
        tx.kind === 'payment' && tx.method ? ['Рознесено', `${METHOD[tx.method] || ''}${tx.resolvedBy ? ` · ${tx.resolvedBy}` : ''}`] : null,
        (tx.allocations || []).length > 1 ? ['Частини', tx.allocations.map(a => `кв. ${a.apt}: ${money(a.amountKop)}`).join(' · ')] : null
    ].filter(l => l && l[1]);
    const undo = tx.status === 'done' && tx.kind !== 'internal' && !tx.bankConflict && !tx.bankVoided;
    return `<div class="bk-detail"><dl class="dc-fields">${lines.map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd>`).join('')}</dl>
        <div class="bk-detail-actions">
            ${tx.status === 'review' || tx.bankConflict ? '<button type="button" class="sv-btn" data-go="inbox">Розібрати в «Рішеннях»</button>' : ''}
            ${tx.paymentId ? `<button type="button" class="sv-btn is-soft" data-open="payment" data-id="${escapeHtml(tx.paymentId)}">Платіж із кабінету ›</button>` : ''}
            ${tx.expenseId ? `<button type="button" class="sv-btn is-soft" data-open="doc" data-id="${escapeHtml(tx.expenseId)}">Документ ›</button>` : ''}
            <button type="button" class="sv-btn is-soft" data-open="tx" data-id="${escapeHtml(tx.id)}">Усі звʼязки ›</button>
            ${undo ? '<button type="button" class="sv-btn is-soft" data-act="undo">Повернути в «Рішення»</button>' : ''}
        </div></div>`;
}

function chipHtml(tx) {
    if (tx.status !== 'review') {
        const tag = tagOf(tx);
        return `<span class="bk-done">✓ ${escapeHtml(tag.text)}</span>`;
    }
    const q = quickAssign(tx);
    if (busy.has(tx.id)) return '<span class="bk-done">Зберігаю…</span>';
    if (q) return `<button type="button" class="bk-yes${q.sure ? '' : ' is-ask'}" data-act="quick">${q.sure ? `Так, кв. ${escapeHtml(q.apt)}` : `Це кв. ${escapeHtml(q.apt)}?`}</button>`;
    return '<button type="button" class="bk-yes is-ask" data-go="inbox">Розібрати ›</button>';
}

function rowHtml(tx) {
    const out = tx.direction === 'out';
    return `<div class="bk-row${opened === tx.id ? ' is-open' : ''}" data-id="${escapeHtml(tx.id)}" tabindex="0" role="button" aria-expanded="${opened === tx.id}">
            <span class="bk-ico${tx.status === 'review' ? ' is-wait' : ''}" aria-hidden="true">${out ? '↑' : '↓'}</span>
            <span class="bk-main"><b>${escapeHtml(tx.counterparty?.name || '—')}</b><small>${escapeHtml(tx.purpose || '')}</small></span>
            <span class="bk-right"><b class="bk-sum${out ? '' : ' is-in'}">${signed(tx)} грн</b>${chipHtml(tx)}</span>
        </div>${opened === tx.id ? detailHtml(tx) : ''}`;
}

function renderList() {
    const host = document.getElementById('bankList');
    if (!host) return;
    const source = tab === 'review' ? queue : rows;
    const list = filterTx(source, tab, query);
    document.getElementById('bankMore').hidden = !more || tab === 'review';
    host.innerHTML = list.length ? byDay(list).map(d => `<div class="bk-day">${escapeHtml(d.label)}</div>${d.rows.map(rowHtml).join('')}`).join('')
        : `<p class="py-empty">${query ? 'Нічого не знайдено' : tab === 'review' ? 'Усі операції розподілено' : 'Операцій ще немає'}</p>`;
}

export async function loadBankView() {
    const [settings, page, q, payments] = await Promise.all([loadSettings(), loadPage(), loadQueue().catch(() => []), loadPayments().catch(() => [])]);
    rows = page.rows; last = page.last; more = page.full;
    queue = q;
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
                <h2>Операції</h2>
                <div class="bk-tabs" role="tablist">${Object.entries(TABS).map(([k, v]) =>
                    `<button type="button" class="bk-tab${k === tab ? ' active' : ''}" role="tab" aria-selected="${k === tab}" data-tab="${k}">${v}${k === 'review' && queue.length ? ` <span>${queue.length}</span>` : ''}</button>`).join('')}</div>
            </div>
            <label class="fl-search dc-search bk-search"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>
                <input type="search" id="bankQuery" placeholder="Квартира, платник, сума або призначення" value="${escapeHtml(query)}" aria-label="Пошук операції"></label>
            <div id="bankList"></div>
            <button type="button" id="bankMore" class="sv-btn is-soft is-wide" hidden>Показати ще</button>
        </section>`;
    renderList();
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

export function initBankView() {
    const host = document.getElementById('viewBank');
    host.addEventListener('input', e => { if (e.target.id === 'bankQuery') { query = e.target.value; renderList(); } });
    host.addEventListener('click', async e => {
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
        if (e.target.closest('[data-act="undo"]')) {
            const tx = rows.find(x => x.id === opened) || queue.find(x => x.id === opened);
            if (!tx || !await confirmDialog('Повернути в «Рішення»?', tx.kind === 'payment'
                ? 'Оплату буде прибрано з історії квартири, операція знову чекатиме рішення.' : 'Категорію буде знято.', 'Повернути')) return;
            try { await act({ action: 'unassign', txId: tx.id }); toast('Повернуто в «Рішення»', 'success'); }
            catch (err) { toast(err.message, 'error'); }
            return;
        }
        if (e.target.closest('[data-go]')) return;
        const row = e.target.closest('.bk-row');
        if (row) { opened = opened === row.dataset.id ? null : row.dataset.id; renderList(); }
    });
    host.addEventListener('keydown', e => {
        const row = e.target.closest('.bk-row');
        if (row && e.target === row && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); opened = opened === row.dataset.id ? null : row.dataset.id; renderList(); }
    });
}

// ============================================================
// НАЛАШТУВАННЯ (5 ПІДВКЛАДОК)
// ============================================================
export const SETTINGS_TABS = {
    org: 'Організація та реквізити',
    bank: 'Банк та інтеграції',
    policy: 'Облік, податки та правила',
    directories: 'Тарифи та довідники',
    startup: 'Стартові дані та база'
};

let settingsTab = 'org';
let stOpeningSign = 'overpaid';
let stAnnualYear = String(new Date().getFullYear());
let stChargesCtx = null;
let stPayrollCtx = null;
let stProjectCtx = null;
let stExpensesCtx = null;
let stXmlCtx = null;
let stBudgetCtx = null;
let stAnnualReport = null;
let stStaffNames = {};

export function setSettingsTab(nextTab) {
    if (SETTINGS_TABS[nextTab]) {
        settingsTab = nextTab;
        try { sessionStorage.removeItem('buh_settings_tab'); } catch { /* ignore */ }
    }
}

export function openSettings(nextTab = 'org') {
    if (SETTINGS_TABS[nextTab]) settingsTab = nextTab;
    try { sessionStorage.removeItem('buh_settings_tab'); } catch { /* ignore */ }
    if (location.hash !== '#settings') location.hash = 'settings';
    else loadSettingsView();
}

const RULES = [
    ['Рознесення оплат мешканців', 'Система сама; сумнівні — бухгалтер', 'ст. 9 Закону № 996-XIV'],
    ['Інші надходження (оренда, відсотки, гранти)', 'Бухгалтер', 'п. 133.4.2 ПКУ: облік за джерелами'],
    ['Платежі постачальникам', 'Бухгалтер; підпис КЕП у Приват24 — голова', 'п. 3.4.15 статуту: перший підпис — голова'],
    ['Договори', 'Голова (погодження правління)', 'п. 3.4.15 статуту'],
    ['Рахунки й акти за договором у межах суми', 'Бухгалтер', 'договір уже затвердив голова'],
    ['Витрати без договору чи понад договір', 'Голова (дрібні до порогу — бухгалтер)', 'рішення правління, жовтень 2026'],
    ['Договори понад 50 000 грн', 'Рішення загальних зборів', 'п. 3.4.15 статуту'],
    ['Податкова й фінансова звітність', 'Бухгалтер готує, КЕП — голова (і бухгалтер, якщо він відповідальний за облік у ДПС)', 'пп. 48.5.1 ПКУ']
];

const XML_INPUTS = [
    ['katottg', 'Код КАТОТТГ (UA і 17 цифр, з витягу ЄДР)', 'maxlength="19" spellcheck="false"'],
    ['zip', 'Поштовий індекс', 'inputmode="numeric" maxlength="5"'],
    ['address', 'Податкова адреса'],
    ['phone', 'Телефон', 'inputmode="tel"'],
    ['email', 'Ел. пошта', 'type="email"'],
    ['headName', 'Керівник: власне імʼя та прізвище'],
    ['headTin', 'РНОКПП керівника', 'inputmode="numeric" maxlength="10"'],
    ['accName', 'Бухгалтер: власне імʼя та прізвище (якщо є)'],
    ['accTin', 'РНОКПП бухгалтера', 'inputmode="numeric" maxlength="10"']
];

function testModeHtml() {
    return `<section class="buh-card"><div class="buh-card-head"><h2>Тестова бухгалтерія</h2></div>
        <p class="buh-note">Окремий навчальний будинок: нарахування, імітована виписка, зарплата, проводки та звірка звітів. Продовження з будь-якого пристрою під вашим входом.</p>
        <div style="display:flex;gap:10px;flex-wrap:wrap"><a class="sv-btn" style="width:auto" href="platform.html">Платформа управління ОСББ (Super-Admin) ›</a><a class="sv-btn is-soft" style="width:auto" href="accounting-test.html">Відкрити тестовий полігон ›</a></div>
        <p class="buh-note">Попередні тестові дані у робочій базі автоматично не видаляються. За потреби голова може використати повне очищення з резервною копією вище.</p></section>`;
}

function updateAiKeyUi(info) {
    const set = Boolean(info?.set), tail = info?.tail || '';
    const badge = document.getElementById('aiKeyBadge');
    if (badge) {
        badge.className = `buh-tag ${set ? 'is-payment' : 'is-soft'}`;
        badge.textContent = set ? `✓ AI Vision підключено (…${tail})` : 'AI не підключено';
    }
    const note = document.getElementById('aiKeyStatusNote');
    if (note) note.textContent = aiKeyNote(set, tail);
    const input = document.getElementById('aiKeyInput');
    if (input) { input.value = ''; input.placeholder = set ? `Новий ключ, щоб замінити …${tail}` : 'Gemini API Key (AIzaSy...)'; }
    const clearBtn = document.getElementById('aiKeyClearBtn');
    if (clearBtn) clearBtn.hidden = !set;
}

const aiKeyNote = (set, tail) => set
    ? `Ключ (…${tail}) зберігається лише на сервері. Скани, фото й PDF розпізнаються через Google Gemini.`
    : 'Без ключа читаються лише електронні документи M.E.Doc / Вчасно (XML, ZIP, .p7s). Для сканів і фото потрібен ключ.';

const money2 = kop => (kop ? (kop / 100).toFixed(2).replace('.', ',') : '');
const rateFmt = r4 => (r4 / 10000).toLocaleString('uk-UA', { minimumFractionDigits: 2, maximumFractionDigits: 4 });
const unitLabel = base => (base === 'fixed' ? 'грн з прим.' : base === 'residents' ? 'грн/прож.' : 'грн/м²');

// ------------------------------------------------------------
// 1. ОРГАНІЗАЦІЯ ТА РЕКВІЗИТИ
// ------------------------------------------------------------
function renderOrgTab(settings) {
    const accounts = Object.entries(settings.accounts || {});
    const currentAcc = accounts.find(([, a]) => (a.purpose || 'current') === 'current')?.[0] || accounts[0]?.[0] || '';
    const reg = requisites.registry || {};
    const payeeName = requisites.payeeName || reg.legalName || 'ОСББ «Успіх-25»';
    const edrpou = requisites.edrpou || reg.code || '40562894';
    const iban = requisites.iban || currentAcc || '';
    const houseAddress = requisites.houseAddress || 'вул. Інглезі, 3/3, м. Одеса';
    const purposeTemplate = requisites.purposeTemplate || 'Внески на утримання будинку, кв. {apt}, особовий рахунок {account}';

    const xml = stXmlCtx || { settings: {}, offices: [], org: {} };
    const v = xml.settings || {};
    const offices = xml.offices || [];

    return `
        <section class="buh-card">
            <div class="buh-card-head">
                <h2>Платіжні реквізити ОСББ та адреса будинку</h2>
                <span class="buh-tag ${iban ? 'is-payment' : 'is-review'}">${iban ? 'налаштовано' : 'вкажіть IBAN'}</span>
            </div>
            <p class="buh-note">Використовуються у квитанціях мешканців, QR-коді НБУ для швидкої оплати, довідках про відсутність заборгованості та процесуальних документах (претензіях, судових наказах і позовах).</p>
            <div class="pay-grid" id="stPayRequisitesForm">
                <label class="field"><span class="field-label">Назва отримувача (для платіжок і квитанцій)</span>
                    <input id="stReqPayee" class="field-input" maxlength="160" value="${escapeHtml(payeeName)}" placeholder="ОСББ «Успіх-25»"></label>
                <label class="field"><span class="field-label">Код ЄДРПОУ (8 цифр)</span>
                    <input id="stReqEdrpou" class="field-input" inputmode="numeric" maxlength="8" value="${escapeHtml(edrpou)}" placeholder="40562894"></label>
                <label class="field pay-wide"><span class="field-label">Основний поточний рахунок IBAN для внесків</span>
                    <div style="display:flex;gap:8px;flex-wrap:wrap">
                        <input id="stReqIban" class="field-input" style="flex:1 1 260px" maxlength="34" spellcheck="false" value="${escapeHtml(iban)}" placeholder="UA…">
                        ${accounts.length ? `<select id="stReqIbanPick" class="field-input field-select" style="width:auto;min-width:210px" aria-label="Обрати з підключених рахунків">
                            <option value="">Підставити з ПриватБанку…</option>
                            ${accounts.map(([accIban, a]) => `<option value="${escapeHtml(accIban)}">${escapeHtml(maskIban(accIban))} · ${escapeHtml(ACCOUNT_PURPOSES[a.purpose] || 'Поточний')}</option>`).join('')}
                        </select>` : ''}
                    </div>
                </label>
                <label class="field pay-wide"><span class="field-label">Адреса багатоквартирного будинку</span>
                    <input id="stReqAddress" class="field-input" maxlength="200" value="${escapeHtml(houseAddress)}" placeholder="вул. Інглезі, 3/3, м. Одеса"></label>
                <label class="field pay-wide"><span class="field-label">Шаблон призначення платежу в квитанції ({apt} — квартира, {account} — о/р, {period} — місяць)</span>
                    <input id="stReqPurpose" class="field-input" maxlength="220" value="${escapeHtml(purposeTemplate)}"></label>
            </div>
            <div class="pay-form-actions"><button type="button" class="btn-primary btn-compact" data-act="save-pay-requisites">Зберегти платіжні реквізити</button></div>
        </section>

        <section class="buh-card">
            <div class="buh-card-head">
                <h2>Реквізити для податкової звітності та XML (ДПС)</h2>
                <span class="buh-tag ${v.katottg && v.headTin ? 'is-payment' : 'is-review'}">${v.katottg && v.headTin ? 'заповнено' : 'потрібно для XML'}</span>
            </div>
            <p class="buh-note">Підставляються у файли XML Податкового розрахунку (J0500111 + Д1, 4ДФ, Д5) для Електронного кабінету ДПС. РНОКПП керівника та бухгалтера бачать лише голова й бухгалтер.</p>
            <div class="pay-grid" id="stXmlSettingsForm">
                <label class="field pay-wide"><span class="field-label">Податкова інспекція ДПС (куди подається звіт)</span>
                    <select class="field-input field-select" name="sti">${offices.map(o => `<option value="${o.code}"${o.code === Number(v.sti) ? ' selected' : ''}>${escapeHtml(`${o.code} — ${o.name}`)}</option>`).join('')}</select></label>
                ${XML_INPUTS.map(([k, label, extra = '']) => `<label class="field${k === 'address' ? ' pay-wide' : ''}"><span class="field-label">${label}</span>
                    <input class="field-input" name="${k}" value="${escapeHtml(v[k] || '')}" ${extra}></label>`).join('')}
            </div>
            <div class="pay-form-actions">
                <button type="button" class="btn-primary btn-compact" data-act="save-xml-settings">Зберегти реквізити звітності</button>
                <button type="button" class="btn-ghost-small" data-go="reports">Перейти у «Звіти» ›</button>
            </div>
        </section>

        ${registryHtml(requisites.registry, requisites.houseAddress)}
    `;
}

// ------------------------------------------------------------
// 2. БАНК ТА ІНТЕГРАЦІЇ
// ------------------------------------------------------------
function renderBankTab(settings, ex) {
    const connected = settings.tokenSet === true;
    const lastSync = settings.lastSync;
    const accounts = Object.entries(settings.accounts || {});
    const aiKey = ex?.settings?.aiKey || { set: false, tail: '' };
    const payMethod = getPayMethod();
    const pCtx = stPayrollCtx || { people: [], settings: {} };
    const pr = pCtx.settings?.project || {};
    const groups = stProjectCtx?.groups || pr.groups || [];
    const curGroup = groups.find(g => g.id === (pr.groupId || groups[0]?.id));
    const receivers = stProjectCtx?.receivers || [];
    const activeEmployees = (pCtx.people || []).filter(p => p.active !== false && p.kind === 'employee');

    return `
        <section class="buh-card">
            <div class="buh-card-head"><h2>ПриватБанк («Автоклієнт» API)</h2><span class="buh-tag ${connected ? 'is-payment' : 'is-review'}">${connected ? `підключено · токен …${escapeHtml(settings.tokenHint || '')}` : 'не підключено'}</span></div>
            <p class="buh-note">${!connected ? 'Після підключення виписка й залишки завантажуватимуться щогодини.'
                : lastSync?.ok === false ? `Остання спроба ${escapeHtml(when(lastSync.at))}: ${escapeHtml(lastSync.error || 'помилка')}`
                : lastSync?.waiting ? 'Банк зараз оновлює дані — виписку перевіримо пізніше.'
                : lastSync ? `Оновлено ${escapeHtml(when(lastSync.at))}${lastSync.added ? ` · нових операцій: ${lastSync.added}` : ''}` : 'Перша виписка — протягом години.'}</p>
            <ol class="buh-steps">
                <li>Приват24 для бізнесу → «Інтеграція (Автоклієнт)» → «Підключити додаток» → тип «API», назва «Бухгалтерія ОСББ».</li>
                <li>Дозвольте виписки, залишки й створення платежів. Платіж із застосунку банк однаково проводить лише після підпису КЕП голови в Приват24.</li>
                <li>«API для розробників» → скопіюйте <b>token</b>. «Обмеження за IP-адресою» лишіть порожнім.</li>
            </ol>
            <div class="buh-inline-form">
                <input id="tokenInput" class="field-input" type="password" autocomplete="off" spellcheck="false" placeholder="${connected ? 'Новий токен, щоб замінити' : 'Вставте токен'}">
                <button type="button" class="btn-primary btn-compact" data-act="token-save">Перевірити й зберегти</button>
                ${connected ? '<button type="button" class="btn-ghost-small" data-act="token-remove">Відключити</button>' : ''}
            </div>
            <p class="buh-note">Токен зберігається лише на сервері — у браузері й базі його не видно.</p>
        </section>

        ${accounts.length ? `<section class="buh-card">
            <div class="buh-card-head"><h2>Банківські рахунки ОСББ та їхнє призначення</h2><span>${accounts.length} рах.</span></div>
            <p class="buh-note">Призначення визначає бухгалтерський субрахунок (311 поточний / ремонтний / резервний або 313/351 депозитний) та рахунок за замовчуванням для оплати рахунків і зарплати.</p>
            <table class="buh-table"><tbody>${accounts.map(([iban, a]) => `<tr data-iban="${escapeHtml(iban)}">
                <td class="t-main"><b>${escapeHtml(iban)}</b><small>${escapeHtml(a.name || '')}${a.available === false ? ' · історичний, немає доступу за токеном' : ''}${a.currency && a.currency !== 'UAH' ? ` · ${escapeHtml(a.currency)}, недоступний для гривневих платежів` : ''}</small></td>
                <td><select class="field-input field-select acc-purpose-select" aria-label="Призначення">${Object.entries(ACCOUNT_PURPOSES).map(([k, v]) =>
                    `<option value="${k}"${k === (a.purpose || 'current') ? ' selected' : ''}>${v}</option>`).join('')}</select></td>
                <td class="t-sum">${accountBalance(a)}</td></tr>`).join('')}</tbody></table>
        </section>` : ''}

        <section class="buh-card">
            <div class="buh-card-head">
                <h2>Розумне розпізнавання документів (AI OCR)</h2>
                <span id="aiKeyBadge" class="buh-tag ${aiKey.set ? 'is-payment' : 'is-soft'}">${aiKey.set ? `✓ AI Vision підключено (…${escapeHtml(aiKey.tail)})` : 'AI не підключено'}</span>
            </div>
            <p class="buh-note">Електронні документи M.E.Doc і Вчасно (XML, ZIP, підписані .p7s) читаються без AI і безкоштовно. Скани, фото з телефону й PDF розпізнає Google Gemini — для цього потрібен ключ Google AI Studio. Після розпізнавання система підказує, що варто перевірити: контрольну цифру коду, IBAN, ПДВ, дату.</p>
            <div class="buh-inline-form">
                <input id="aiKeyInput" class="field-input" type="password" autocomplete="off" spellcheck="false" placeholder="${aiKey.set ? `Новий ключ, щоб замінити …${escapeHtml(aiKey.tail)}` : 'Gemini API Key (AIzaSy...)'}">
                <button type="button" class="btn-primary btn-compact" data-act="ai-key-save">Перевірити й зберегти</button>
                <button type="button" class="btn-ghost-small" data-act="ai-key-clear" id="aiKeyClearBtn"${aiKey.set ? '' : ' hidden'}>Видалити ключ</button>
            </div>
            <p class="buh-note" id="aiKeyStatusNote">${escapeHtml(aiKeyNote(aiKey.set, aiKey.tail))}</p>
            <p class="buh-note"><a href="https://aistudio.google.com/app/apikey" target="_blank" rel="noopener">Отримати безкоштовний ключ у Google AI Studio ↗</a> (до 1 500 запитів на добу безкоштовно).</p>
        </section>

        <section class="buh-card">
            <div class="buh-card-head">
                <h2>Зарплатний проект ПриватБанку та спосіб виплати зарплати</h2>
                <span class="buh-tag ${payMethod === 'project' ? 'is-payment' : 'is-soft'}">${payMethod === 'project' ? 'Зарплатний проект' : 'По IBAN (окремі платіжки)'}</span>
            </div>
            <p class="buh-note">Оберіть основний спосіб перерахування зарплати у вкладці «Зарплата». Виплати за договорами ЦПД завжди відправляються окремими платіжками за IBAN.</p>
            <div class="pay-grid">
                <label class="field"><span class="field-label">Спосіб виплати зарплати за замовчуванням</span>
                    <select id="stPayMethod" class="field-input field-select">
                        <option value="iban"${payMethod === 'iban' ? ' selected' : ''}>По IBAN (окремі платіжки на картки)</option>
                        <option value="project"${payMethod === 'project' ? ' selected' : ''}>Зарплатний проект ПриватБанку (однією відомістю)</option>
                    </select>
                </label>
                <label class="field"><span class="field-label">Зарплатний проект у Приват24</span>
                    <div style="display:flex;gap:8px;align-items:center">
                        <select id="stPayGroup" class="field-input field-select" style="flex:1">${groups.length ? groups.map(g => `<option value="${escapeHtml(g.id)}"${g.id === curGroup?.id ? ' selected' : ''}>${escapeHtml(g.name)} (${escapeHtml(g.id)})</option>`).join('') : '<option value="">Не завантажено</option>'}</select>
                        <button type="button" class="btn-soft btn-compact" data-act="st-project-sync">Оновити з банку</button>
                    </div>
                </label>
            </div>
            ${activeEmployees.length ? `<table class="buh-table is-compact" style="margin-top:10px">
                <thead><tr><th>Штатний працівник</th><th>Отримувач у зарплатному проекті Приват24</th></tr></thead>
                <tbody>${activeEmployees.map(p => {
                    const chosen = p.salaryProject || '';
                    const opts = receivers.map(x => `<option value='${escapeHtml(JSON.stringify(x))}'${chosen.receiverId === x.receiverId && chosen.account === x.account ? ' selected' : ''}>${escapeHtml(x.name)} · ${escapeHtml(x.account)}</option>`).join('');
                    return `<tr><td><b>${escapeHtml(p.name)}</b><small class="t-muted"> ${escapeHtml(p.position || '')}</small></td>
                        <td><select class="field-input field-select st-pay-receiver" data-person="${escapeHtml(p.id)}">
                            <option value="">${chosen.account ? `Обрано: ${escapeHtml(chosen.name)} · ${escapeHtml(chosen.account)}` : 'Оберіть отримувача з проекту…'}</option>${opts}
                        </select></td></tr>`;
                }).join('')}</tbody>
            </table>` : '<p class="buh-note" style="margin-top:8px">Штатних працівників ще не додано в довідник.</p>'}
        </section>
    `;
}

// ------------------------------------------------------------
// 3. ОБЛІК, ПОДАТКИ ТА ПРАВИЛА
// ------------------------------------------------------------
function renderPolicyTab(settings, ex) {
    const chair = session.role === 'chair';
    const small = ex?.settings?.smallKop || 0;
    const pCtx = stPayrollCtx || { settings: {} };
    const taxes = withDefaultTaxes(pCtx.settings?.taxes || {});
    const advPct = pCtx.settings?.advancePct || 50;
    const rates = pCtx.settings?.rates || [];
    const showApartments = stBudgetCtx?.showApartments === true;
    const isMartialLaw = requisites?.martialLaw !== false;

    const taxRow = (key, title, hint) => {
        const v = taxes[key] || {};
        return `<div class="pr-tax"><b>${title}</b><small>${hint}</small>
            <div class="pay-grid" style="margin-top:6px">
                <label class="field"><span class="field-label">Отримувач (Казначейство)</span><input class="field-input" data-st-tax="${key}.name" value="${escapeHtml(v.name || '')}" placeholder="ГУК в Одеській обл. / м. Одеса"></label>
                <label class="field"><span class="field-label">ЄДРПОУ Казначейства</span><input class="field-input" data-st-tax="${key}.code" inputmode="numeric" maxlength="8" value="${escapeHtml(v.code || '')}" placeholder="37607526"></label>
                <label class="field pay-wide"><span class="field-label">IBAN бюджетного рахунку</span><input class="field-input" data-st-tax="${key}.iban" maxlength="34" spellcheck="false" value="${escapeHtml(v.iban || '')}" placeholder="UA…"></label>
            </div></div>`;
    };

    const rateLine = r => `<tr>
        <td><input class="field-input st-rate-from" type="month" value="${escapeHtml(r.from || '2026-01')}"></td>
        <td><input class="field-input st-rate-pdfo" inputmode="decimal" value="${((r.pdfoBps || 1800) / 100).toFixed(2)}"></td>
        <td><input class="field-input st-rate-vz" inputmode="decimal" value="${((r.vzBps || 500) / 100).toFixed(2)}"></td>
        <td><input class="field-input st-rate-esv" inputmode="decimal" value="${((r.esvBps || 2200) / 100).toFixed(2)}"></td>
        <td><input class="field-input st-rate-min" inputmode="decimal" value="${((r.minWageKop || 800000) / 100).toFixed(2)}"></td>
        <td><input class="field-input st-rate-max" inputmode="numeric" value="${r.maxBaseMinWages || 15}"></td>
        <td><input class="field-input st-rate-sub" inputmode="decimal" value="${((r.subsistenceKop || 302800) / 100).toFixed(2)}"></td>
    </tr>`;

    return `
        <div id="accountingSettings"><section class="buh-card"><p class="list-empty">Завантаження параметрів облікової політики…</p></section></div>

        <section class="buh-card" id="stPayrollTaxesBox">
            <div class="buh-card-head">
                <h2>Податки й аванс із зарплати (бюджетні рахунки)</h2>
                <button type="button" class="btn-soft btn-compact" data-act="st-fill-odesa-taxes">Підставити рахунки Одеси (ГУК)</button>
            </div>
            <p class="buh-note">Бюджетні рахунки Казначейства в м. Одесі (Київський р-н) для автоматичного формування платіжок на сплату ПДФО, військового збору та ЄСВ під час виплати авансу й зарплати.</p>
            ${taxRow('pdfo', 'ПДФО 18 %', 'Сплачується в день виплати доходу (пп. 168.1.2 ПКУ). Код 11010100 — із зарплати, 11010400 — із ЦПД.')}
            ${taxRow('vz', 'Військовий збір 5 %', 'Сплачується в день виплати доходу (п. 16¹ підрозд. 10 розд. XX ПКУ). Код 11011000.')}
            ${taxRow('esv', 'ЄСВ 22 %', 'Нараховується на фонд оплати праці та винагороди за ЦПД, сплачується під час виплати або до 20 числа (ч. 8 ст. 9 Закону № 2464). Символ 201.')}
            <div class="buh-inline-form" style="margin-top:10px">
                <label class="py-field" style="max-width:260px"><span>Частка авансу (1–15 числа), % від окладу</span>
                    <input id="stAdvPct" class="field-input" inputmode="numeric" maxlength="2" value="${advPct}"></label>
                <button type="button" class="btn-primary btn-compact" data-act="st-save-taxes">Зберегти реквізити й аванс</button>
                <button type="button" class="btn-ghost-small" data-go="payroll">Перейти в «Зарплату» ›</button>
            </div>
        </section>

        <section class="buh-card">
            <div class="buh-card-head">
                <h2>Ставки податків та законодавчі межі з датами дії</h2>
                ${chair ? '<span class="buh-tag is-payment">редагує голова</span>' : '<span class="buh-tag is-soft">лише перегляд (змінює голова)</span>'}
            </div>
            <p class="buh-note">Відомість зарплати кожного місяця бере рядок ставок, чинний на цей місяць. Попередні закриті періоди при додаванні нового рядка не переписуються.</p>
            <div class="jr-scroll">
                <table class="buh-table is-compact" id="stRatesTable">
                    <thead><tr><th>Діє з</th><th>ПДФО, %</th><th>ВЗ, %</th><th>ЄСВ, %</th><th>Мін. зарплата, грн</th><th>Макс. база ЄСВ, МЗП</th><th>Прожитк. мінімум, грн</th></tr></thead>
                    <tbody>${(rates.length ? rates : [{}]).map(rateLine).join('')}</tbody>
                </table>
            </div>
            ${chair ? `<div class="buh-inline-form" style="margin-top:10px">
                <input id="stRatesBasis" class="field-input" maxlength="200" placeholder="Підстава: закон про Держбюджет, дата набрання чинності">
                <button type="button" class="btn-soft btn-compact" data-act="st-rate-add">+ Період дії</button>
                <button type="button" class="btn-primary btn-compact" data-act="st-rates-save">Зберегти ставки податків</button>
            </div>` : ''}
        </section>

        <section class="buh-card">
            <div class="buh-card-head"><h2>Правила погодження, публічність звітності та правовий режим</h2></div>
            <table class="buh-table"><thead><tr><th>Операція</th><th>Підтверджує</th><th>Підстава</th></tr></thead>
            <tbody>${RULES.map(([op, who, why]) => `<tr><td>${escapeHtml(op)}</td><td>${escapeHtml(who)}</td><td class="t-muted">${escapeHtml(why)}</td></tr>`).join('')}</tbody></table>
            <div class="buh-inline-form ex-small" style="margin-top:12px">
                <span>Витрати без договору до</span>
                <input id="smallInput" class="field-input" inputmode="decimal" value="${(small / 100).toFixed(2).replace('.', ',')}"${chair ? '' : ' disabled'} aria-label="Поріг, грн">
                <span>грн затверджує бухгалтер</span>
                ${chair ? '<button type="button" class="btn-soft btn-compact" data-act="small-save">Зберегти поріг</button>' : '<span class="t-muted">змінює голова</span>'}
            </div>
            <hr style="margin:14px 0;border:0;border-top:1px solid var(--sv-line,#e2e8f0)">
            <label class="bd-switch" style="margin-bottom:12px">
                <input type="checkbox" data-act="st-visibility"${showApartments ? ' checked' : ''}${chair ? '' : ' disabled'}>
                <span><b>Показувати мешканцям номери квартир у звіті про виконання кошторису («Фінанси будинку»)</b>
                <small>У надходженнях («Під'їзд 2, Квартира 177 — 28,30 грн») і в списку боржників. Прізвищ — ніколи. Номер квартири теж персональні дані: вмикайте за рішенням правління чи загальних зборів. Змінює голова.</small></span>
            </label>
            <label class="bd-switch">
                <input type="checkbox" data-act="st-martial-law"${isMartialLaw ? ' checked' : ''}>
                <span><b>Діє воєнний стан (Постанова КМУ № 206 / № 1405 від 29.12.2023) — для претензій та позовів</b>
                <small>Судове стягнення основної заборгованості за внесками ОСББ у м. Одеса дозволено (ст. 161, 274 ЦПК), але нарахування пені та штрафів населенню вимкнено (0 грн). Після скасування воєнного стану вимкніть цей прапорець для автоматичного розрахунку пені та інфляційних за ст. 625 ЦК України.</small></span>
            </label>
            <p class="buh-note" style="margin-top:10px">Облік у застосунку ведеться з ${escapeHtml(settings.startDate || '2026-10-01')}: раніші операції лише показуються.</p>
        </section>
    `;
}

// ------------------------------------------------------------
// 4. ТАРИФИ ТА ДОВІДНИКИ (ДУБЛЮЮЧІ БЛОКИ)
// ------------------------------------------------------------
function renderDirectoriesTab() {
    const c = stChargesCtx || { groups: [], components: [], tariffs: [], premises: {}, apartments: [], current: '2026-10' };
    const comps = c.components || [];
    const groups = c.groups || [];
    const groupName = id => groups.find(g => g.id === id)?.name || 'Квартири';
    const compName = id => comps.find(x => x.id === (id || 'main'))?.name || 'Утримання будинку';
    const nowTariff = (g, compId) => (c.tariffs || []).filter(x => x.group === g && (x.component || 'main') === compId && x.from <= c.current).sort((a, b) => (a.from < b.from ? 1 : -1))[0];
    const sortedTariffs = [...(c.tariffs || [])].sort((a, b) => (a.from < b.from ? 1 : a.from > b.from ? -1 : 0));
    const groupCounts = groups.map(g => `${escapeHtml(g.name)}: ${(c.apartments || []).filter(a => (c.premises?.[a.apt] || 'res') === g.id).length}`).join(' · ');
    const withPersonalAcc = (c.apartments || []).filter(a => a.personalAccount).length;

    const people = stPayrollCtx?.people || [];
    const suppliers = stExpensesCtx?.suppliers || [];
    const contracts = stExpensesCtx?.contracts || [];
    const kinds = stExpensesCtx?.kinds || { company: 'Юрособа (ТОВ, ПП, КП)', fop: 'ФОП', person: 'Фізособа (ЦПД)' };

    return `
        <section class="buh-card">
            <div class="buh-card-head">
                <div><h2>Тарифи внесків, складові та групи приміщень</h2><small class="t-muted">Дублює вкладку «Нарахування → Тарифи»</small></div>
                <button type="button" class="btn-soft btn-compact" data-act="st-go-charges-tariffs">Відкрити в «Нарахуваннях» ›</button>
            </div>
            ${groups.length && comps.length ? `<table class="buh-table ch-matrix"><thead><tr><th>Складова внеску (на ${escapeHtml(periodName(c.current))})</th>${groups.map(g => `<th class="t-sum">${escapeHtml(g.name)}</th>`).join('')}</tr></thead>
                <tbody>${comps.map(comp => `<tr><td><b>${escapeHtml(comp.name)}</b><small class="t-muted"> ${escapeHtml(unitLabel(comp.base))}</small></td>${groups.map(g => {
                    const t = nowTariff(g.id, comp.id);
                    return `<td class="t-sum">${t ? rateFmt(t.rate4) : '<span class="t-muted">—</span>'}</td>`;
                }).join('')}</tr>`).join('')}</tbody></table>` : ''}

            <h3 class="ch-sub">Усі діючі та історичні тарифи (${sortedTariffs.length})</h3>
            ${sortedTariffs.length ? `<table class="buh-table is-compact"><thead><tr><th>Складова</th><th>Група</th><th>Тариф</th><th>Діє з</th><th>Рішення</th><th></th></tr></thead>
                <tbody>${sortedTariffs.map(t => `<tr><td>${escapeHtml(compName(t.component))}</td><td>${escapeHtml(groupName(t.group))}</td><td><b>${rateFmt(t.rate4)}</b> <small class="t-muted">${unitLabel(t.base)}</small></td><td>${escapeHtml(periodName(t.from))}</td>
                    <td class="t-muted">${escapeHtml(t.decision)}</td><td class="t-act"><button type="button" class="btn-ghost-small" data-act="st-tariff-remove" data-id="${escapeHtml(t.id)}">Прибрати</button></td></tr>`).join('')}</tbody></table>`
                : '<p class="list-empty">Тарифів ще немає</p>'}

            <h3 class="ch-sub">Додати новий тариф</h3>
            <div class="buh-inline-form ch-form">
                <select id="stTfComp" class="field-input field-select" aria-label="Складова">${comps.map(comp => `<option value="${escapeHtml(comp.id)}">${escapeHtml(comp.name)}</option>`).join('')}</select>
                <select id="stTfGroup" class="field-input field-select" aria-label="Група">${groups.map(g => `<option value="${escapeHtml(g.id)}">${escapeHtml(g.name)}</option>`).join('')}</select>
                <input id="stTfRate" class="field-input ch-narrow" inputmode="decimal" placeholder="Тариф, грн" aria-label="Тариф">
                <input id="stTfFrom" class="field-input ch-narrow" type="month" value="${escapeHtml(c.current)}" aria-label="Діє з місяця">
                <input id="stTfDecision" class="field-input" maxlength="200" placeholder="Рішення: протокол зборів № …, дата" aria-label="Рішення">
                <button type="button" class="btn-primary btn-compact" data-act="st-tariff-add">Додати тариф</button>
            </div>

            <div class="pay-grid" style="margin-top:12px">
                <div>
                    <h3 class="ch-sub" style="margin-top:0">Складові внеску</h3>
                    <p class="ch-chips">${comps.map(comp => `<span class="buh-tag">${escapeHtml(comp.name)} · ${escapeHtml(unitLabel(comp.base))}</span>`).join(' ')}</p>
                    <div class="buh-inline-form ch-form">
                        <input id="stCpName" class="field-input" maxlength="60" placeholder="Напр. «Освітлення МЗК», «Ліфти»">
                        <select id="stCpBase" class="field-input field-select"><option value="area">за м²</option><option value="fixed">з приміщення</option><option value="residents">з проживаючого</option></select>
                        <button type="button" class="btn-soft btn-compact" data-act="st-component-add">+ Складова</button>
                    </div>
                </div>
                <div>
                    <h3 class="ch-sub" style="margin-top:0">Групи приміщень</h3>
                    <p class="ch-chips">${groups.map(g => `<span class="buh-tag">${escapeHtml(g.name)}</span>`).join(' ')}</p>
                    <div class="buh-inline-form ch-form">
                        <input id="stGrName" class="field-input" maxlength="60" placeholder="Напр. «Паркінг» або «Комори»">
                        <button type="button" class="btn-soft btn-compact" data-act="st-group-add">+ Група</button>
                    </div>
                </div>
            </div>
        </section>

        <section class="buh-card">
            <div class="buh-card-head">
                <div><h2>Приміщення, групи, проживаючі та особові рахунки</h2><small class="t-muted">${groupCounts} · особових рахунків: ${withPersonalAcc} з ${(c.apartments || []).length}</small></div>
                <div style="display:flex;gap:8px;flex-wrap:wrap">
                    <button type="button" class="btn-soft btn-compact" data-act="st-go-charges-premises">Таблиця приміщень ›</button>
                    <button type="button" class="btn-ghost-small" data-go="flats">Картки квартир ›</button>
                </div>
            </div>
            <div class="buh-inline-form ch-form">
                <input id="stPrBulk" class="field-input" placeholder="Приміщення через кому: н1, н2, 101" aria-label="Приміщення">
                <select id="stPrBulkGroup" class="field-input field-select" aria-label="Група">${groups.map(g => `<option value="${escapeHtml(g.id)}">${escapeHtml(g.name)}</option>`).join('')}</select>
                <button type="button" class="btn-soft btn-compact" data-act="st-premises-bulk">Призначити групу</button>
            </div>
            <div class="buh-inline-form ch-form">
                <input id="stResBulk" class="field-input" placeholder="Кількість проживаючих списком: «298;2» або «298 2», через кому чи з нового рядка" aria-label="Проживаючі">
                <button type="button" class="btn-soft btn-compact" data-act="st-residents-bulk">Внести проживаючих</button>
            </div>
            <div class="buh-inline-form ch-form">
                <input id="stPaBulk" class="field-input" placeholder="Особові рахунки списком: «45;00045» або «101 250101», через кому чи з нового рядка" aria-label="Особові рахунки">
                <button type="button" class="btn-soft btn-compact" data-act="st-personal-accounts-bulk">Зберегти особові рахунки</button>
            </div>
            <p class="buh-note">Площі та ПІБ співвласників синхронізуються з реєстром правління (<a href="admin.html">Панель правління → Квартири</a>) та початковим переносом бази.</p>
        </section>

        <section class="buh-card">
            <div class="buh-card-head">
                <div><h2>Довідник працівників та підрядників ЦПД (${people.length})</h2><small class="t-muted">Дублює блок «Люди» у вкладці «Зарплата»</small></div>
                <div style="display:flex;gap:8px;flex-wrap:wrap">
                    <button type="button" class="btn-primary btn-compact" data-act="st-person-new">+ Додати працівника / ЦПД</button>
                    <button type="button" class="btn-soft btn-compact" data-go="payroll">Відкрити «Зарплату» ›</button>
                </div>
            </div>
            ${people.length ? `<div class="jr-scroll"><table class="buh-table is-compact">
                <thead><tr><th>ПІБ</th><th>Вид</th><th>Посада / предмет ЦПД</th><th>РНОКПП</th><th class="t-sum">Оклад / сума, грн</th><th>IBAN</th><th>Стан</th><th></th></tr></thead>
                <tbody>${people.map(p => `<tr>
                    <td class="t-main"><b>${escapeHtml(p.name)}</b></td>
                    <td>${p.kind === 'gph' ? 'Договір ЦПД' : 'Штатний'}</td>
                    <td>${escapeHtml(p.position || p.contractSubject || '—')}</td>
                    <td>${escapeHtml(p.rnokpp || '—')}</td>
                    <td class="t-sum">${fmtKop(p.rateKop || 0)}</td>
                    <td class="t-muted">${escapeHtml(maskIban(p.iban || '')) || '—'}</td>
                    <td><span class="buh-tag ${p.active !== false ? 'is-payment' : 'is-soft'}">${p.active !== false ? 'працює' : 'архів'}</span></td>
                    <td class="t-act"><button type="button" class="btn-ghost-small" data-act="st-person-open" data-id="${escapeHtml(p.id)}">Картка ›</button></td>
                </tr>`).join('')}</tbody>
            </table></div>` : '<p class="list-empty">Працівників і підрядників ЦПД ще не додано.</p>'}
        </section>

        <section class="buh-card">
            <div class="buh-card-head">
                <div><h2>Довідник постачальників (${suppliers.length}) та договорів (${contracts.length})</h2><small class="t-muted">Дублює вкладки «Постачальники» та «Договори» в розділі «Документи»</small></div>
                <div style="display:flex;gap:8px;flex-wrap:wrap">
                    <button type="button" class="btn-primary btn-compact" data-act="st-supplier-new">+ Постачальник</button>
                    <button type="button" class="btn-soft btn-compact" data-act="st-contract-new">+ Договір</button>
                    <button type="button" class="btn-ghost-small" data-act="st-contracts-open">Усі договори (${contracts.length}) ›</button>
                </div>
            </div>
            ${suppliers.length ? `<div class="jr-scroll"><table class="buh-table is-compact">
                <thead><tr><th>Назва</th><th>Вид</th><th>Код ЄДРПОУ / РНОКПП</th><th>IBAN</th><th>Перевірка ЄДР</th><th></th></tr></thead>
                <tbody>${suppliers.map(s => `<tr>
                    <td class="t-main"><b>${escapeHtml(s.name)}</b></td>
                    <td>${escapeHtml(kinds[s.kind] || s.kind)}</td>
                    <td>${escapeHtml(s.code)}</td>
                    <td class="t-muted">${escapeHtml(maskIban(s.iban || '')) || '—'}</td>
                    <td>${s.kind === 'fop' ? (s.fopChecked ? '<span class="buh-tag is-payment">витяг перевірено</span>' : '<span class="buh-tag is-review">перевірте витяг ЄДР</span>') : s.kind === 'person' ? '<span class="buh-tag is-error">лише через ЦПД</span>' : '<span class="buh-tag is-soft">юрособа</span>'}</td>
                    <td class="t-act"><button type="button" class="btn-ghost-small" data-act="st-supplier-edit" data-id="${escapeHtml(s.id)}">Змінити ›</button></td>
                </tr>`).join('')}</tbody>
            </table></div>` : '<p class="list-empty">Постачальників ще не додано.</p>'}
        </section>
    `;
}

// ------------------------------------------------------------
// 5. СТАРТОВІ ДАНІ ТА БАЗА
// ------------------------------------------------------------
function stOpeningPreview() {
    const host = document.getElementById('stOpPreview');
    if (!host || !stChargesCtx) return;
    const { rows: parsed, errors } = parseOpeningLines(document.getElementById('stOpText')?.value, stOpeningSign);
    if (!parsed.length && !errors.length) { host.innerHTML = ''; return; }
    const known = new Set((stChargesCtx.apartments || []).map(a => a.apt));
    const unknown = parsed.filter(r => !known.has(r.apt)).map(r => r.apt);
    const s = openingSummary(parsed);
    const missing = (stChargesCtx.apartments || []).length - parsed.filter(r => known.has(r.apt)).length;
    host.innerHTML = `<div class="kpi-grid ch-kpi" style="margin-top:8px">
            <div class="kpi"><span>Рядків</span><b>${s.count}</b><small>${missing > 0 ? `${missing} прим. без рядка — буде 0` : 'усі приміщення'}</small></div>
            <div class="kpi"><span>Борг</span><b class="is-out">${fmtKop(s.debtKop)}</b><small>${s.debtors} кв.</small></div>
            <div class="kpi"><span>Переплата</span><b class="is-in">${fmtKop(s.overpaidKop)}</b><small>${parsed.filter(r => r.amountKop > 0).length} кв.</small></div>
        </div>
        ${unknown.length ? `<p class="buh-note ch-warn">Немає в довіднику: ${unknown.slice(0, 10).map(escapeHtml).join(', ')} — виправте перед збереженням</p>` : ''}
        ${errors.length ? `<p class="buh-note ch-warn">Незрозумілі рядки: ${errors.slice(0, 6).map(e => `№${e.line} «${escapeHtml(e.raw.slice(0, 30))}»`).join(', ')}</p>` : ''}
        <p class="buh-note">Перевірте знак: ${parsed.slice(0, 3).map(r => `кв. ${escapeHtml(r.apt)} — ${r.amountKop < 0 ? 'борг' : r.amountKop > 0 ? 'переплата' : 'розраховано'} ${fmtKop(Math.abs(r.amountKop))}`).join('; ')}</p>`;
}

function renderStartupTab(settings) {
    const chair = session.role === 'chair';
    const c = stChargesCtx || { opening: null, startPeriod: '2026-10', startDate: '2026-10-01', apartments: [] };
    const o = c.opening;
    const cutoffDate = new Date(Date.parse(`${c.startDate || `${c.startPeriod || '2026-10'}-01`}T12:00:00Z`) - 86400000)
        .toISOString().slice(0, 10).split('-').reverse().join('.');
    const startYr = Number((settings.startDate || '2026-10-01').slice(0, 4)) || new Date().getFullYear();
    const years = Array.from({ length: Math.max(1, new Date().getFullYear() - startYr + 2) }, (_, i) => startYr + i).reverse();
    if (!years.includes(Number(stAnnualYear))) years.push(Number(stAnnualYear));
    const rep = stAnnualReport;

    return `
        <section class="buh-card">
            <div class="buh-card-head">
                <h2>Вхідні залишки по квартирах на ${escapeHtml(cutoffDate)} (рахунок 377)</h2>
                ${o?.set ? '<span class="buh-tag is-payment">внесено</span>' : '<span class="buh-tag is-review">не внесено</span>'}
            </div>
            ${c.startDate && !c.startDate.endsWith('-01') && chair ? `<div class="buh-toolbar" style="margin-bottom:10px">
                <span class="buh-note">Місяць переходу вже нараховано в попередній системі? Завантажте його історію та підтвердьте перенос, щоб не нараховувати двічі.</span>
                <button type="button" class="btn-soft btn-compact" data-act="st-imported-month">Підтвердити перенесений місяць</button>
            </div>` : ''}
            ${o?.set ? `<p class="buh-note">${o.count} кв. · борг ${fmtKop(o.debtKop)} · переплата ${fmtKop(o.overpaidKop)} грн · ${escapeHtml(authorLabel(stStaffNames, o.by))}${o.at ? `, ${escapeHtml(dateOnly(o.at))}` : ''}.
                Баланс у кабінетах мешканців рахує система: вхідний залишок + оплати − нарахування.</p>
                <div class="inbox-actions"><button type="button" class="btn-ghost-small" data-act="st-recompute">Перерахувати баланси з історії</button></div>`
            : `<p class="buh-note">Борги й переплати кожної квартири на кінець ${escapeHtml(cutoffDate)} — з попереднього обліку. Після внесення система почне рахувати баланс мешканців автоматично.</p>`}
            <h3 class="ch-sub">${o?.set ? 'Виправити вхідні залишки по квартирах' : 'Внести вхідні залишки по квартирах'}</h3>
            <p class="buh-note">Рядок — «квартира;сума» (можна вставити два стовпці з Excel). Приміщення без рядка отримає 0. Повторне збереження замінює весь список (поки немає закритих місяців).</p>
            <div class="buh-seg ch-sign">
                <button type="button" class="buh-seg-item${stOpeningSign === 'overpaid' ? ' active' : ''}" data-st-sign="overpaid">Мінус — борг (як у застосунку)</button>
                <button type="button" class="buh-seg-item${stOpeningSign === 'debt' ? ' active' : ''}" data-st-sign="debt">Плюс — борг (дебетове сальдо)</button>
            </div>
            <textarea id="stOpText" class="field-input ch-textarea" rows="6" spellcheck="false" placeholder="45;-1250,40&#10;46;210,00&#10;н1;0"></textarea>
            <div id="stOpPreview"></div>
            <div class="inbox-actions">
                <button type="button" class="btn-primary btn-compact" data-act="st-opening-save">Зберегти залишки квартир</button>
                <button type="button" class="btn-ghost-small" data-act="st-opening-fill">Заповнити з поточних балансів</button>
            </div>
        </section>

        <div id="stOpeningHost"><section class="buh-card"><p class="list-empty">Завантаження вхідної оборотно-сальдової відомості (ОСВ)…</p></section></div>

        <section class="buh-card">
            <div class="buh-card-head">
                <h2>Порівняльні дані попереднього року та перенесення обліку до дати переходу</h2>
                <label class="py-field" style="margin:0;flex-direction:row;align-items:center;gap:8px"><span>Звітний рік:</span>
                    <select id="stAnnualYear" class="field-input field-select" style="width:auto">${years.map(y => `<option value="${y}"${String(y) === String(stAnnualYear) ? ' selected' : ''}>${y}</option>`).join('')}</select>
                </label>
            </div>
            <p class="buh-note">Для фінансової звітності (Форма № 2-м) потрібна колонка за попередній (${Number(stAnnualYear) - 1}) рік. Якщо облік у застосунку почато не з 1 січня, сюди також завантажується JSON-історія проводок від початку року до дати переходу.</p>
            <div class="pay-grid">
                <label class="field"><span class="field-label">Доходи за ${Number(stAnnualYear) - 1} рік, грн</span>
                    <input id="stPriorIncome" class="field-input" inputmode="decimal" value="${rep?.previousIncome?.incomeKop !== undefined ? (rep.previousIncome.incomeKop / 100).toFixed(2) : ''}" placeholder="0,00"${chair ? '' : ' disabled'}></label>
                <label class="field"><span class="field-label">Витрати за ${Number(stAnnualYear) - 1} рік, грн</span>
                    <input id="stPriorCost" class="field-input" inputmode="decimal" value="${rep?.previousIncome?.costKop !== undefined ? (rep.previousIncome.costKop / 100).toFixed(2) : ''}" placeholder="0,00"${chair ? '' : ' disabled'}></label>
                <label class="field pay-wide"><span class="field-label">Прийнятий звіт / підстава</span>
                    <input id="stPriorBasis" class="field-input" maxlength="500" value="${escapeHtml(rep?.previousIncome?.basis || '')}" placeholder="Фінансовий звіт за попередній рік, квитанція № 2"${chair ? '' : ' disabled'}></label>
            </div>
            ${chair ? `<div class="pay-form-actions"><button type="button" class="btn-soft btn-compact" data-act="st-annual-comparative">Погодити порівняльні дані</button></div>` : '<p class="buh-note">Порівняльні дані погоджує голова правління.</p>'}
            <hr style="margin:14px 0;border:0;border-top:1px solid var(--sv-line,#e2e8f0)">
            <h3 class="ch-sub" style="margin-top:0">Перенесення журналу обліку з початку року до дати переходу (JSON)</h3>
            <p class="buh-note">Залишки на 1 січня й повний журнал проводок до дати переходу (суми у копійках). Перенос має точно збігтися з вхідною ОСВ. <a href="docs/accounting/MIGRATION.md" download>Інструкція та формат JSON ↗</a></p>
            <div class="pay-grid">
                <label class="field"><span class="field-label">Файл переносу JSON</span>
                    <input id="stAnnualImportFile" class="field-input" type="file" accept=".json,application/json"></label>
                <label class="field"><span class="field-label">Джерело / підстава звірки</span>
                    <input id="stAnnualImportBasis" class="field-input" maxlength="500" placeholder="Назва попередньої системи, дата звірки"></label>
            </div>
            <div class="pay-form-actions">
                <button type="button" class="btn-soft btn-compact" data-act="st-annual-import">Перевірити й завантажити історію</button>
                ${chair ? '<button type="button" class="btn-primary btn-compact" data-act="st-annual-approve">Погодити перенос історії</button>' : ''}
            </div>
        </section>

        <div id="migrationSettings"></div>
        <div id="resetSettings"></div>
        ${testModeHtml()}
    `;
}

// ------------------------------------------------------------
// ЗАВАНТАЖЕННЯ ТА РЕНДЕР НАЛАШТУВАНЬ
// ------------------------------------------------------------
export async function loadSettingsView() {
    const hostEl = document.getElementById('viewSettings');
    if (!hostEl) return;
    try {
        const wantedTab = sessionStorage.getItem('buh_settings_tab');
        if (wantedTab && SETTINGS_TABS[wantedTab]) {
            settingsTab = wantedTab;
            sessionStorage.removeItem('buh_settings_tab');
        }
    } catch { /* ignore */ }

    const savedScrollY = window.scrollY;
    const hadContent = Boolean(hostEl.innerHTML.trim());

    if (session.role === 'chair') {
        const reset = await databaseResetStatus().catch(() => null);
        if (reset?.job?.active) {
            hostEl.innerHTML = '<div id="resetSettings"></div>';
            await mountDatabaseReset(document.getElementById('resetSettings'), reset);
            return;
        }
    }

    const [settings, ex, req] = await Promise.all([
        loadSettings(),
        loadExpenses().catch(() => null),
        loadRequisites().catch(() => ({}))
    ]);
    requisites = req || {};
    stExpensesCtx = ex;
    const accounts = Object.entries(settings.accounts || {});

    if (settingsTab === 'org') {
        stXmlCtx = await reportsQuery({ action: 'xmlSettings' }).catch(() => ({ settings: {}, offices: [], org: {} }));
    } else if (settingsTab === 'bank') {
        stPayrollCtx = await loadPayroll(null).catch(() => ({ people: [], settings: {} }));
    } else if (settingsTab === 'policy') {
        const curYear = String(new Date().getFullYear());
        [stPayrollCtx, stBudgetCtx] = await Promise.all([
            loadPayroll(null).catch(() => ({ people: [], settings: {} })),
            loadBudget(curYear).catch(() => ({ showApartments: false }))
        ]);
    } else if (settingsTab === 'directories') {
        [stChargesCtx, stPayrollCtx] = await Promise.all([
            loadCharges().catch(() => null),
            loadPayroll(null).catch(() => ({ people: [], settings: {} }))
        ]);
    } else if (settingsTab === 'startup') {
        [stChargesCtx, stStaffNames, stAnnualReport] = await Promise.all([
            loadCharges().catch(() => null),
            loadStaffNames().catch(() => ({})),
            reportsQuery({ action: 'annual', year: stAnnualYear }).catch(() => null)
        ]);
    }

    const navHtml = `<div class="fl-filters dc-tabs st-subtabs" role="tablist" aria-label="Підрозділи налаштувань">
        ${Object.entries(SETTINGS_TABS).map(([k, label]) =>
            `<button type="button" class="fl-filter${k === settingsTab ? ' active' : ''}" role="tab" aria-selected="${k === settingsTab}" data-st-tab="${k}">${escapeHtml(label)}</button>`
        ).join('')}
    </div>`;

    let bodyHtml = '';
    if (settingsTab === 'org') bodyHtml = renderOrgTab(settings);
    else if (settingsTab === 'bank') bodyHtml = renderBankTab(settings, ex);
    else if (settingsTab === 'policy') bodyHtml = renderPolicyTab(settings, ex);
    else if (settingsTab === 'directories') bodyHtml = renderDirectoriesTab();
    else bodyHtml = renderStartupTab(settings);

    hostEl.innerHTML = `${navHtml}<div class="st-tab-body">${bodyHtml}</div>`;

    if (settingsTab === 'policy') {
        const accEl = document.getElementById('accountingSettings');
        if (accEl) {
            await loadAccountingSettings(accEl, accounts).catch(err => {
                if (accEl.isConnected) accEl.textContent = err.message;
            });
        }
    } else if (settingsTab === 'startup') {
        const migEl = document.getElementById('migrationSettings');
        if (migEl) mountMigration(migEl);
        const openEl = document.getElementById('stOpeningHost');
        const resetEl = document.getElementById('resetSettings');
        await Promise.allSettled([
            openEl ? loadOpening(openEl).catch(err => { if (openEl.isConnected) openEl.textContent = err.message; }) : Promise.resolve(),
            resetEl ? mountDatabaseReset(resetEl).catch(err => { if (resetEl.isConnected) resetEl.textContent = err.message; }) : Promise.resolve()
        ]);
    }

    if (hadContent && savedScrollY > 0) {
        window.scrollTo({ top: savedScrollY });
    }
}

const val = id => document.getElementById(id)?.value?.trim() || '';

export function initSettingsView() {
    const host = document.getElementById('viewSettings');

    host.addEventListener('input', e => {
        if (e.target.id === 'stOpText') stOpeningPreview();
        if (e.target.closest('#stOpeningHost') && e.target.classList.contains('ob-sum')) {
            openingInput(document.getElementById('stOpeningHost'));
        }
    });

    host.addEventListener('click', async e => {
        const tabBtn = e.target.closest('[data-st-tab]');
        if (tabBtn) {
            settingsTab = tabBtn.dataset.stTab;
            await loadSettingsView();
            return;
        }

        const signBtn = e.target.closest('[data-st-sign]');
        if (signBtn) {
            stOpeningSign = signBtn.dataset.stSign;
            host.querySelectorAll('[data-st-sign]').forEach(b => b.classList.toggle('active', b === signBtn));
            stOpeningPreview();
            return;
        }

        const ob = e.target.closest('[data-ob]');
        if (ob && !ob.disabled) {
            const openEl = document.getElementById('stOpeningHost');
            if (openEl) await openingAction(ob, openEl);
            return;
        }

        const btn = e.target.closest('[data-act]');
        if (!btn || btn.disabled) return;
        const a = btn.dataset.act;

        try {
            if (a === 'save-pay-requisites') {
                const payeeName = val('stReqPayee');
                const edrpou = val('stReqEdrpou');
                const iban = val('stReqIban').replace(/\s+/g, '').toUpperCase();
                const houseAddress = val('stReqAddress');
                const purposeTemplate = val('stReqPurpose');
                if (!payeeName) { toast('Вкажіть назву ОСББ', 'error'); return; }
                if (edrpou && !/^\d{8}$/.test(edrpou)) { toast('Код ЄДРПОУ має містити 8 цифр', 'error'); return; }
                if (iban && !/^UA\d{27}$/.test(iban)) { toast('IBAN має починатися з UA і містити 29 символів', 'error'); return; }
                setBusy(btn, true, 'Зберігаю…');
                await setDoc(doc(db, 'osbb_settings', 'finance'), {
                    payeeName, edrpou, iban, houseAddress, purposeTemplate
                }, { merge: true });
                toast('Платіжні реквізити ОСББ збережено', 'success');
                await loadSettingsView();
            } else if (a === 'save-xml-settings') {
                const box = document.getElementById('stXmlSettingsForm');
                if (!box) return;
                const data = Object.fromEntries([...box.querySelectorAll('[name]')].map(i => [i.name, i.value.trim()]));
                setBusy(btn, true, 'Зберігаю…');
                await reportsAct({ action: 'saveXmlSettings', ...data, sti: Number(data.sti) });
                await setDoc(doc(db, 'osbb_settings', 'finance'), {
                    ...(data.phone ? { phone: data.phone } : {}),
                    ...(data.email ? { email: data.email } : {}),
                    ...(data.headName ? { headName: data.headName } : {})
                }, { merge: true }).catch(() => {});
                toast('Реквізити для звітності та XML збережено', 'success');
                await loadSettingsView();
            } else if (a === 'registry-save') {
                await saveRegistry(btn, requisites.registry);
            } else if (a === 'token-save') {
                const token = val('tokenInput');
                if (!token) { toast('Вставте токен', 'error'); return; }
                setBusy(btn, true, 'Перевіряю в банку…');
                const r = await act({ action: 'saveToken', token }, 60000);
                toast(`Підключено. Рахунків: ${r?.accounts ?? 0}`, 'success');
                await loadSettingsView();
            } else if (a === 'token-remove') {
                if (!await confirmDialog('Відключити банк?', 'Токен буде видалено з сервера. Завантажені операції лишаться.', 'Відключити')) return;
                await act({ action: 'removeToken' });
                toast('Банк відключено', 'success');
                await loadSettingsView();
            } else if (a === 'ai-key-save') {
                const inputEl = document.getElementById('aiKeyInput');
                const key = inputEl?.value.trim() || '';
                if (!key) { toast('Вставте ключ Google AI Studio у поле', 'error'); inputEl?.focus(); return; }
                setBusy(btn, true, 'Перевіряю в Google…');
                const r = await expAct({ action: 'aiKey', key });
                updateAiKeyUi(r.aiKey);
                toast(`AI-ключ збережено (…${r.aiKey.tail}) — розпізнавання сканів і фото увімкнено`, 'success');
            } else if (a === 'ai-key-clear') {
                if (!await confirmDialog('Видалити ключ AI?', 'Скани й фото перестануть розпізнаватися; файли M.E.Doc і Вчасно — читатимуться далі.', 'Видалити')) return;
                setBusy(btn, true, 'Видаляю…');
                const r = await expAct({ action: 'aiKey', key: '' });
                updateAiKeyUi(r.aiKey);
                toast('Ключ AI видалено', 'info');
            } else if (a === 'st-project-sync') {
                setBusy(btn, true, 'Запитую банк…');
                stProjectCtx = await payrollAct({ action: 'projectContext', groupId: val('stPayGroup') });
                toast(`Проектів: ${stProjectCtx.groups.length}, отримувачів: ${stProjectCtx.receivers.length}`, 'success');
                await loadSettingsView();
            } else if (a === 'st-fill-odesa-taxes') {
                for (const [k, def] of Object.entries(DEFAULT_TAXES)) {
                    for (const f of ['name', 'code', 'iban']) {
                        const input = document.querySelector(`[data-st-tax="${k}.${f}"]`);
                        if (input) input.value = def[f];
                    }
                }
                toast('Підставлено реквізити ГУК в Одеській обл. (м. Одеса, Київський р-н) — натисніть «Зберегти»', 'info');
            } else if (a === 'st-save-taxes') {
                const taxes = {};
                document.querySelectorAll('[data-st-tax]').forEach(i => {
                    const [k, f] = i.dataset.stTax.split('.');
                    (taxes[k] ||= {})[f] = i.value.trim();
                });
                setBusy(btn, true, 'Зберігаю…');
                await payrollAct({ action: 'settings', advancePct: Number(val('stAdvPct')), taxes });
                toast('Податкові реквізити та аванс збережено', 'success');
                await loadSettingsView();
            } else if (a === 'st-rate-add') {
                const tbody = document.querySelector('#stRatesTable tbody');
                const lastRow = tbody?.lastElementChild?.cloneNode(true);
                if (lastRow) tbody.appendChild(lastRow);
            } else if (a === 'st-rates-save') {
                const rateRows = [...document.querySelectorAll('#stRatesTable tbody tr')].map(tr => ({
                    from: tr.querySelector('.st-rate-from').value,
                    pdfoBps: Math.round(Number(tr.querySelector('.st-rate-pdfo').value.replace(',', '.')) * 100),
                    vzBps: Math.round(Number(tr.querySelector('.st-rate-vz').value.replace(',', '.')) * 100),
                    esvBps: Math.round(Number(tr.querySelector('.st-rate-esv').value.replace(',', '.')) * 100),
                    minWageKop: toKop(tr.querySelector('.st-rate-min').value),
                    maxBaseMinWages: Number(tr.querySelector('.st-rate-max').value),
                    subsistenceKop: toKop(tr.querySelector('.st-rate-sub').value)
                }));
                setBusy(btn, true, 'Зберігаю…');
                await payrollAct({ action: 'rates', rates: rateRows, basis: val('stRatesBasis') });
                toast('Таблицю ставок податків збережено', 'success');
                await loadSettingsView();
            } else if (a === 'small-save') {
                const kop = toKop(val('smallInput'));
                if (kop === null || kop < 0) { toast('Вкажіть суму в гривнях', 'error'); return; }
                setBusy(btn, true, 'Зберігаю…');
                await expAct({ action: 'settings', smallKop: kop });
                toast('Поріг збережено', 'success');
            } else if (a === 'st-go-charges-tariffs') {
                openCharges('tariffs');
            } else if (a === 'st-go-charges-premises') {
                openCharges('premises');
            } else if (a === 'st-tariff-add') {
                setBusy(btn, true, 'Додаю…');
                await chargeAct({ action: 'addTariff', component: val('stTfComp'), group: val('stTfGroup'), rate: val('stTfRate'), from: val('stTfFrom'), decision: val('stTfDecision') });
                toast('Тариф додано', 'success');
                await loadSettingsView();
            } else if (a === 'st-tariff-remove') {
                if (!await confirmDialog('Прибрати тариф?', 'Це можливо, лише поки за ним нічого не нараховано.', 'Прибрати')) return;
                setBusy(btn, true);
                await chargeAct({ action: 'removeTariff', id: btn.dataset.id });
                toast('Тариф прибрано', 'success');
                await loadSettingsView();
            } else if (a === 'st-component-add') {
                setBusy(btn, true);
                await chargeAct({ action: 'addComponent', name: val('stCpName'), base: val('stCpBase') });
                toast('Складову додано — внесіть для неї тарифи', 'success');
                await loadSettingsView();
            } else if (a === 'st-group-add') {
                setBusy(btn, true);
                await chargeAct({ action: 'addGroup', name: val('stGrName') });
                toast('Групу приміщень додано', 'success');
                await loadSettingsView();
            } else if (a === 'st-premises-bulk') {
                const apts = val('stPrBulk').split(/[,;\s]+/).map(x => x.trim().toLowerCase()).filter(Boolean);
                if (!apts.length) { toast('Вкажіть приміщення', 'error'); return; }
                setBusy(btn, true);
                await chargeAct({ action: 'setPremises', apts, group: val('stPrBulkGroup') });
                toast(`Збережено: ${apts.length} прим.`, 'success');
                await loadSettingsView();
            } else if (a === 'st-residents-bulk') {
                const resRows = val('stResBulk').split(/[\n,]+/).map(x => x.trim()).filter(Boolean).map(x => {
                    const [apt, residents] = x.split(/[;\t\s]+/);
                    return { apt: String(apt || '').toLowerCase(), residents: residents ?? '' };
                });
                if (!resRows.length) { toast('Вкажіть квартири й кількість', 'error'); return; }
                setBusy(btn, true);
                const r = await chargeAct({ action: 'setResidents', rows: resRows });
                toast(`Збережено: ${r.count} кв.`, 'success');
                await loadSettingsView();
            } else if (a === 'st-personal-accounts-bulk') {
                const pairs = val('stPaBulk').split(/[\n,]+/).map(x => x.trim()).filter(Boolean).map(x => {
                    const [apt, pa] = x.split(/[;\t\s]+/);
                    return { apt: String(apt || '').trim().toLowerCase(), personalAccount: String(pa || '').trim() };
                }).filter(p => p.apt);
                if (!pairs.length) { toast('Вкажіть квартири та особові рахунки (напр. 45;00045)', 'error'); return; }
                const known = new Set((stChargesCtx?.apartments || []).map(x => String(x.apt).toLowerCase()));
                const unknown = pairs.filter(p => known.size && !known.has(p.apt));
                if (unknown.length) { toast(`Квартири немає в довіднику: ${unknown[0].apt}`, 'error'); return; }
                setBusy(btn, true, 'Зберігаю…');
                let batch = writeBatch(db), ops = 0;
                for (const p of pairs) {
                    batch.set(doc(db, 'apartments', p.apt), { personalAccount: p.personalAccount }, { merge: true });
                    if (++ops >= 400) { await batch.commit(); batch = writeBatch(db); ops = 0; }
                }
                if (ops) await batch.commit();
                toast(`Особові рахунки збережено: ${pairs.length} прим.`, 'success');
                await loadSettingsView();
            } else if (a === 'st-person-new') {
                openPayrollPerson('new');
            } else if (a === 'st-person-open') {
                openPayrollPerson(btn.dataset.id);
            } else if (a === 'st-supplier-new') {
                openExpenses('suppliers', { kind: 'supplier', data: {} });
            } else if (a === 'st-supplier-edit') {
                const sup = (stExpensesCtx?.suppliers || []).find(s => s.id === btn.dataset.id);
                if (sup) openExpenses('suppliers', { kind: 'supplier', data: sup });
            } else if (a === 'st-contract-new') {
                openExpenses('contracts', { kind: 'contract', data: {} });
            } else if (a === 'st-contracts-open') {
                openExpenses('contracts');
            } else if (a === 'st-imported-month') {
                const note = await promptDialog('Підтвердити вже нарахований місяць?', 'Потрібна повна історія по всіх приміщеннях. Суми вже включені у вхідні залишки; повторного нарахування не буде.', { confirmLabel: 'Підтвердити', placeholder: 'Попередня система та підстава звірки' });
                if (!note) return;
                setBusy(btn, true);
                await chargeAct({ action: 'confirmImportedStartMonth', note });
                toast('Повний перенос місяця підтверджено', 'success');
                await loadSettingsView();
            } else if (a === 'st-recompute') {
                setBusy(btn, true, 'Рахую…');
                const r = await chargeAct({ action: 'recompute' });
                toast(r.updated ? `Оновлено балансів: ${r.updated}` : 'Баланси вже збігаються з історією', 'success');
                await loadSettingsView();
            } else if (a === 'st-opening-fill') {
                const lines = (stChargesCtx?.apartments || []).filter(x => x.balance !== null && x.balance !== '' && x.balance !== undefined)
                    .map(x => `${x.apt};${String(Number(x.balance).toFixed(2)).replace('.', ',')}`);
                stOpeningSign = 'overpaid';
                host.querySelectorAll('[data-st-sign]').forEach(b => b.classList.toggle('active', b.dataset.stSign === 'overpaid'));
                const opEl = document.getElementById('stOpText');
                if (opEl) opEl.value = lines.join('\n');
                stOpeningPreview();
                toast(lines.length ? `Взято балансів: ${lines.length}. Звірте з попереднім обліком.` : 'У картках квартир балансів немає', lines.length ? 'success' : 'error');
            } else if (a === 'st-opening-save') {
                const { rows: parsed, errors } = parseOpeningLines(val('stOpText'), stOpeningSign);
                if (!parsed.length) { toast('Немає жодного рядка', 'error'); return; }
                if (errors.length) { toast(`Спершу виправте рядок №${errors[0].line}`, 'error'); return; }
                const s = openingSummary(parsed);
                if (!await confirmDialog('Зберегти вхідні залишки?', `${s.count} кв.: борг ${fmtKop(s.debtKop)} грн, переплата ${fmtKop(s.overpaidKop)} грн. Після цього баланс мешканців рахує система, ручне редагування балансу вимкнеться.`, 'Зберегти')) return;
                setBusy(btn, true, 'Зберігаю…');
                const r = await chargeAct({ action: 'setOpening', rows: parsed });
                toast(`Залишки внесено. Оновлено балансів: ${r.balances}`, 'success');
                await loadSettingsView();
            } else if (a === 'st-annual-comparative') {
                setBusy(btn, true, 'Зберігаю…');
                await reportsAct({
                    action: 'annualComparative',
                    year: stAnnualYear,
                    incomeKop: toKop(val('stPriorIncome')),
                    costKop: toKop(val('stPriorCost')),
                    basis: val('stPriorBasis')
                });
                toast('Порівняльні дані попереднього року погоджено', 'success');
                await loadSettingsView();
            } else if (a === 'st-annual-import') {
                const file = document.getElementById('stAnnualImportFile')?.files?.[0];
                if (!file) { toast('Оберіть файл переносу JSON', 'error'); return; }
                if (file.size > 6 * 1024 * 1024) { toast('Файл завеликий: до 6 МБ', 'error'); return; }
                setBusy(btn, true, 'Перевіряю…');
                const imported = JSON.parse(await file.text());
                await reportsAct({ ...imported, action: 'importAnnualHistory', year: stAnnualYear, basis: val('stAnnualImportBasis') });
                toast('Історію перевірено й збережено для погодження', 'success');
                await loadSettingsView();
            } else if (a === 'st-annual-approve') {
                setBusy(btn, true, 'Погоджую…');
                await reportsAct({ action: 'approveAnnualHistory', year: stAnnualYear });
                toast('Перенос історії погоджено', 'success');
                await loadSettingsView();
            }
        } catch (err) {
            toast(err.message, 'error');
        } finally {
            if (btn.isConnected) setBusy(btn, false);
        }
    });

    host.addEventListener('change', async e => {
        if (e.target.id === 'stReqIbanPick' && e.target.value) {
            const input = document.getElementById('stReqIban');
            if (input) input.value = e.target.value;
            return;
        }
        if (e.target.id === 'stPayMethod') {
            setPayMethod(e.target.value);
            toast(e.target.value === 'project' ? 'Обрано виплату через Зарплатний проект' : 'Обрано виплату окремими платіжками за IBAN', 'success');
            await loadSettingsView();
            return;
        }
        if (e.target.classList.contains('st-pay-receiver')) {
            const receiver = e.target.value ? JSON.parse(e.target.value) : null;
            if (!receiver) return;
            try {
                await payrollAct({ action: 'projectReceiver', groupId: val('stPayGroup'), id: e.target.dataset.person, receiver });
                toast('Отримувача зарплатного проекту збережено', 'success');
            } catch (err) { toast(err.message, 'error'); }
            return;
        }
        if (e.target.dataset?.act === 'st-visibility') {
            const show = e.target.checked;
            if (!await confirmDialog(
                show ? 'Показувати номери квартир?' : 'Приховати номери квартир?',
                show ? 'Мешканці побачать номери квартир у надходженнях і список боржників із сумами (без прізвищ). Звіт оновиться одразу.' : 'У звіті замість квартир буде «Співвласник», список боржників зникне.',
                show ? 'Показувати' : 'Приховати'
            )) { e.target.checked = !show; return; }
            try {
                await budgetAct({ action: 'visibility', showApartments: show });
                toast(show ? 'Номери квартир мешканцям показано' : 'Номери квартир приховано', 'success');
            } catch (err) { e.target.checked = !show; toast(err.message, 'error'); }
            return;
        }
        if (e.target.dataset?.act === 'st-martial-law') {
            const checked = e.target.checked;
            try {
                await setDoc(doc(db, 'osbb_settings', 'finance'), { martialLaw: checked }, { merge: true });
                requisites.martialLaw = checked;
                toast(checked ? 'Увімкнено режим воєнного стану (без пені населенню)' : 'Увімкнено режим мирного часу (повне нарахування пені та ст. 625 ЦК)', 'success');
            } catch (err) { e.target.checked = !checked; toast(err.message, 'error'); }
            return;
        }
        if (e.target.id === 'stAnnualYear') {
            stAnnualYear = e.target.value;
            await loadSettingsView();
            return;
        }
        const select = e.target.closest('.acc-purpose-select');
        if (!select) return;
        try {
            await act({ action: 'setAccount', iban: select.closest('[data-iban]').dataset.iban, purpose: select.value });
            toast('Призначення рахунку збережено', 'success');
        } catch (err) { toast(err.message, 'error'); }
    });
}
