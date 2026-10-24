// ============================================================
// «Платежі»: шлях грошей від погодження до виписки.
//
// Угорі — смуга «погодження → до оплати → на підписі голови →
// проведено» з коштами на рахунку й головною підказкою. Нижче —
// вкладки: що оплатити (погоджені документи, відомість зарплати,
// авансові звіти, регулярні платежі), що чекає КЕП голови в Приват24
// та історія. Кожен рядок показує, з чим звʼязаний платіж (документ,
// договір, відомість, звіт, операція у виписці); картка платежу —
// ланцюжок (buh-chain.js). Новий платіж — бічна форма з перевіркою
// дублів, погоджених документів і YouControl.
// Розрахунки — payments-view-core.js.
// ============================================================
import { session } from './firebase.js';
import { escapeHtml, toast, setBusy, confirmDialog, promptDialog } from './ui.js';
import {
    loadPayments, loadPaymentContext, loadExpenses, loadPayroll, loadAdvance, payAct, expAct, skippedProposals, skipProposal,
    money, when, maskIban, PAYMENT_KINDS, ACCOUNT_PURPOSES
} from './buh-data.js';
import { payExpense, openExpenses } from './buh-expenses.js';
import { openPayroll } from './buh-payroll.js';
import { openAdvance, reimburseReport } from './buh-advance.js';
import { paidByDocuments, coveredByDocuments } from './docs-core.js';
import { openPaymentSheet } from './buh-chain.js';
import { dossierView } from './bank-view-core.js';
import { validIban } from './nbu-qr.js';
import { toKop as kop } from './charges-core.js';
import {
    TABS, HISTORY_FILTERS, KINDS, PROBLEM_TEXT, kindOf, problemOf, paymentTags, isSigning, docsToPay, payrollDue, advanceToPay,
    toPayList, riskOf, supplierFor, flow, funds, nextStep, historyGroups, draftWarnings, monthName, payWord, approvalText
} from './payments-view-core.js';

/** Рахунок для списання за замовчуванням — поточний. */
export const defaultAccount = accounts => (accounts.find(a => a.purpose === 'current') || accounts[0])?.iban || '';

/**
 * Пропозиції, які ще актуальні: не відкладені, не відправлені й не тому,
 * кому платимо за документами (одне правило для «Рішень» і «Платежів»).
 */
export async function activeProposals() {
    const [context, payments, expenses] = await Promise.all([loadPaymentContext(), loadPayments(), loadExpenses().catch(() => null)]);
    const skipped = skippedProposals();
    const sentKeys = new Set(payments.filter(p => ['sending', 'unknown', 'sent', 'paid'].includes(p.status)).map(p => p.proposalKey).filter(Boolean));
    const byDocs = paidByDocuments(expenses);
    return { context, list: context.proposals.filter(p => !skipped.has(p.proposalKey) && !sentKeys.has(p.proposalKey) && !coveredByDocuments(p, byDocs)) };
}

/** Відправити пропозицію в банк — і з «Платежів», і з «Рішень». */
export async function sendProposal(p, account) {
    await payAct({ action: 'create', kind: 'supplier', recipient: p.recipient, amountKop: p.amountKop, purpose: p.purpose, account, proposalKey: p.proposalKey });
    toast(`${p.recipient.name}: платіж у Приват24 на підпис`, 'success');
}

// ------------------------------------------------------------
// СТАН
// ------------------------------------------------------------
let tab = null;                 // null — обрати за станом
let tabPicked = false;          // людина сама обрала вкладку
let histQuery = '', histKind = 'all';
let data = { payments: [], ctx: { proposals: [], recipients: [], accounts: [] }, ex: null, items: [], proposals: [] };
let extra = null;               // { payroll: [due…], approvalPayroll, advance: [звіти], advancePending, payrollIbans } — догружається
let extraLoading = null;
let form = null;                // { draft, meta, warnings, yc: { code, view, busy } }

const isChair = () => session.role === 'chair';
const grn = k => money(k);
const prevPeriod = p => { const [y, m] = p.split('-').map(Number); const d = new Date(y, m - 2, 1); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; };

const ICONS = {
    supplier: '<rect x="4" y="7" width="16" height="13" rx="2"/><path d="M9 7V5h6v2"/>',
    salary: '<circle cx="12" cy="8" r="4"/><path d="M4 21c1-4 4-6 8-6s7 2 8 6"/>',
    tax: '<path d="M3 10h18L12 4z"/><path d="M5 10v8M10 10v8M14 10v8M19 10v8M3 21h18"/>',
    advance: '<path d="M6 3h12v18l-3-2-3 2-3-2-3 2z"/><path d="M9 8h6M9 12h6"/>',
    regular: '<path d="M4 12a8 8 0 0 1 14-5.3L20 9"/><path d="M20 4v5h-5"/><path d="M20 12a8 8 0 0 1-14 5.3L4 15"/><path d="M4 20v-5h5"/>',
    other: '<circle cx="12" cy="12" r="8"/><path d="M12 8v8M8 12h8"/>',
    doc: '<path d="M7 3h7l5 5v13H7z"/><path d="M14 3v5h5M10 13h6M10 17h6"/>',
    payroll: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.8-3.4 3.3-5 6.5-5s5.7 1.6 6.5 5"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7M18 15c2 .6 3.2 2.3 3.5 5"/>'
};
const ICON_CLS = { supplier: 'supplier', doc: 'supplier', regular: 'supplier', salary: 'people', payroll: 'people', tax: 'tax', advance: 'people', other: 'bank' };
const icon = (k, extraCls = '') => `<span class="bn-ico is-${ICON_CLS[k] || 'bank'} ${extraCls}" aria-hidden="true"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONS[k] || ICONS.other}</svg></span>`;
const chip = (text, cls = '') => `<span class="bn-chip ${cls}">${escapeHtml(text)}</span>`;
const TAG_CLS = { doc: 'is-doc', contract: 'is-doc', payroll: 'is-people', advance: 'is-people', regular: 'is-supplier', manual: '', tx: '' };

function statusChip(p) {
    const problem = problemOf(p);
    if (problem && problem !== 'returned') return chip(problem === 'failed' ? 'не прийнято' : 'перевірити', 'is-risk-bad');
    if (p.status === 'paid') return chip(p.returnedKop ? 'повернено банком' : 'проведено', p.returnedKop ? 'is-risk-warn' : 'is-ok');
    if (p.status === 'canceled') return chip('скасовано');
    if (p.canceling) return chip('скасування…', 'is-wait');
    return chip(p.status === 'sending' ? 'відправляється' : 'на підписі', 'is-wait');
}

const tagsHtml = p => paymentTags(p, data.ex).map(t => chip(t.text, t.type === 'tx' ? (t.state === 'ok' ? 'is-ok' : 'is-risk-warn') : TAG_CLS[t.type] || '')).join('');

// ------------------------------------------------------------
// ЗАВАНТАЖЕННЯ
// ------------------------------------------------------------
async function loadExtra() {
    const [payroll, advance] = await Promise.all([loadPayroll(null).catch(() => null), loadAdvance(null).catch(() => null)]);
    const dues = [];
    let approvalPayroll = false;
    if (payroll) {
        // Остаточний розрахунок за минулий місяць платять на початку поточного.
        const prev = (payroll.runs || []).find(r => r.period === prevPeriod(payroll.period));
        if (prev?.status === 'approved' && !prev.final) {
            const prevCtx = await loadPayroll(prev.period).catch(() => null);
            const due = payrollDue(prevCtx);
            if (due) dues.push(due);
        }
        const due = payrollDue(payroll);
        if (due) dues.push(due);
        approvalPayroll = payroll.status === 'draft' && (payroll.run?.rows || []).length > 0;
    }
    const payrollIbans = [...(payroll?.people || []).map(p => p.iban), ...Object.values(payroll?.settings?.taxes || {}).map(t => t?.iban)].filter(Boolean);
    return { payroll: dues, approvalPayroll, advance: advance?.reports || [], advancePending: advance?.summary?.pendingCount || 0, payrollIbans };
}

export async function loadPaymentsView() {
    const [{ context, list }, payments, ex] = await Promise.all([activeProposals(), loadPayments(), loadExpenses().catch(() => null)]);
    data = { payments, ctx: context, ex, proposals: list };
    // Зарплата й авансові звіти рахуються довше — домальовуємо, коли прийдуть (кеш скидає будь-яка дія).
    if (!extraLoading) {
        const before = JSON.stringify(extra);
        extraLoading = loadExtra().then(r => { extra = r; }).catch(() => { extra ||= { payroll: [], advance: [], payrollIbans: [] }; })
            .finally(() => { extraLoading = null; if (JSON.stringify(extra) !== before && location.hash === '#payments') render(); });
    }
    render();
}

/** Шлях грошей з усіх джерел — одне правило для «Платежів» і «Сьогодні». */
function summarize({ payments, ex, proposals, extra: more, accounts }) {
    const items = toPayList({
        docs: docsToPay(ex, payments), proposals, docTypes: ex?.docTypes || {}, contracts: ex?.contracts || [], suppliers: ex?.suppliers || [],
        payroll: more?.payroll || [], advance: advanceToPay({ reports: more?.advance || [] }, payments)
    });
    const pendingDocs = (ex?.expenses || []).filter(e => e.status === 'pending');
    const f = flow({ payments, toPay: items, approval: { docs: pendingDocs, payroll: more?.approvalPayroll, advance: more?.advancePending || 0 } });
    const problems = payments.filter(p => problemOf(p));
    return { items, f, problems, money: funds(accounts || [], f.signing.kop, f.todo.kop) };
}

const compute = () => summarize({ ...data, extra, accounts: data.ctx.accounts });

/** Для «Сьогодні»: той самий підсумок платежів, з відомістю зарплати й авансовими звітами. */
export async function paymentsOverview() {
    const [{ context, list }, payments, ex, more] = await Promise.all([activeProposals(), loadPayments(), loadExpenses().catch(() => null), loadExtra().catch(() => null)]);
    return summarize({ payments, ex, proposals: list, extra: more, accounts: context.accounts });
}

// ------------------------------------------------------------
// РОЗМІТКА
// ------------------------------------------------------------
function render() {
    const host = document.getElementById('viewPayments');
    if (!host) return;
    const s = compute();
    if (!tabPicked && (extra || !tab)) tab = s.f.todo.count && !isChair() ? 'todo' : s.f.signing.count ? 'signing' : s.f.todo.count ? 'todo' : 'history';
    data.items = s.items;
    host.innerHTML = `
        <div class="pm-top">${heroHtml(s)}${nextHtml(s)}</div>
        ${s.problems.length ? problemsHtml(s.problems) : ''}
        <div class="pm-bar">
            <div class="bn-tabs" role="tablist">${Object.entries(TABS).map(([k, v]) => {
                const n = k === 'todo' ? s.f.todo.count : k === 'signing' ? s.f.signing.count : 0;
                return `<button type="button" class="bn-tab${tab === k ? ' is-active' : ''}${k === 'signing' && n ? ' is-warn' : ''}" role="tab" aria-selected="${tab === k}" data-pm-tab="${k}">${v}${n ? ` <small>${n}</small>` : ''}</button>`;
            }).join('')}</div>
            ${isChair() ? '' : '<button type="button" class="sv-btn pm-new" data-act="new">+ Новий платіж</button>'}
        </div>
        <section class="py-card pm-pane">${tab === 'todo' ? todoHtml(s) : tab === 'signing' ? signingHtml(s) : historyHtml()}</section>`;
}

function heroHtml(s) {
    const { f } = s;
    const m = s.money;
    const step = (key, label, n, kopSum, note, attr) => `<button type="button" class="pm-step${tab === key ? ' is-active' : ''}${n ? '' : ' is-zero'}" ${attr}>
        <span>${label}</span><b>${n ? grn(kopSum) : '—'}</b><small>${escapeHtml(note)}</small></button>`;
    const monthLabel = monthName(new Date().toISOString().slice(0, 7)).split(' ')[0];
    const approvalNote = f.approval.count ? approvalText(f.approval) : 'нічого не чекає голову';
    return `<section class="pm-hero">
        <div class="pm-hero-top"><span class="pm-hero-label">Шлях грошей</span>
            ${m.known ? `<span class="pm-bal">На рахунку ${grn(m.balanceKop)}</span>` : ''}</div>
        <div class="pm-flow">
            ${step('approval', 'Погодження', f.approval.count, f.approval.kop, approvalNote, 'data-go="inbox"')}
            ${step('todo', 'До оплати', f.todo.count, f.todo.kop, f.todo.count ? `${f.todo.count} ще не створено` : 'усе створено', 'data-pm-tab="todo"')}
            ${step('signing', 'На підписі голови', f.signing.count, f.signing.kop, f.signing.count ? `${f.signing.count} ${payWord(f.signing.count)} у Приват24` : 'нічого не чекає КЕП', 'data-pm-tab="signing"')}
            ${step('history', 'Проведено', f.paid.count, f.paid.kop, f.paid.count ? `${monthLabel} · ${f.paid.count} за випискою` : `${monthLabel} — ще немає`, 'data-pm-tab="history"')}
        </div>
        ${m.known ? fundsHtml(m, f) : ''}
    </section>`;
}

function fundsHtml(m, f) {
    if (!f.signing.count && !f.todo.count) return '';
    const bad = m.shortKop > 0;
    return `<div class="pm-funds${bad ? ' is-short' : ''}">
        ${f.signing.count ? `<span>Після підписаних лишиться <b>${m.afterSigningKop < 0 ? '−' : ''}${grn(Math.abs(m.afterSigningKop))}</b></span>` : ''}
        ${f.todo.count ? `<span>${bad ? `Коштів не вистачить: бракує <b>${grn(m.shortKop)}</b>` : `Після всього до оплати — <b>${grn(m.afterAllKop)}</b>`}</span>` : ''}
    </div>`;
}

function nextHtml(s) {
    // Відхилене банком виправляє бухгалтер, а чи є платіж у Приват24 — перевіряє голова.
    const mine = s.problems.filter(p => (isChair() ? ['unknown', 'stale'] : ['failed', 'returned']).includes(problemOf(p)));
    const n = nextStep({ ...s.f, problems: mine.length }, session.role, mine[0] || null);
    const btn = n.btn ? (n.go ? `<button type="button" class="sv-btn" data-go="${n.go}">${escapeHtml(n.btn)}</button>`
        : `<button type="button" class="sv-btn" data-act="${n.act}">${escapeHtml(n.btn)}</button>`) : '';
    return `<section class="pm-next is-${n.tone}">
        <span class="pm-next-label">${n.tone === 'done' ? 'Усе гаразд' : n.tone === 'wait' ? 'Чекаємо' : n.tone === 'bad' ? 'Потрібна увага' : 'Що зробити зараз'}</span>
        <b>${escapeHtml(n.title)}</b>
        ${n.hint ? `<p>${escapeHtml(n.hint)}</p>` : ''}
        ${btn ? `<div class="pm-next-actions">${btn}</div>` : ''}
    </section>`;
}

function payRow(p, { sub = '', actions = '' } = {}) {
    const k = kindOf(p);
    return `<div class="pm-row" data-pay="${escapeHtml(p.id)}" tabindex="0" role="button" aria-label="Картка платежу: ${escapeHtml(p.recipient?.name || '')}">
        ${icon(k)}
        <span class="pm-main"><b>${escapeHtml(p.recipient?.name || 'Платіж')}</b><small>${escapeHtml(p.purpose || '')}</small>
            <span class="bn-tags">${chip(KINDS[k], '')}${tagsHtml(p)}</span>
            ${sub ? `<small class="pm-sub">${sub}</small>` : ''}</span>
        <span class="pm-right"><b class="pm-sum">${grn(p.amountKop)}</b>${statusChip(p)}</span>
        ${actions ? `<span class="pm-actions">${actions}</span>` : ''}
    </div>`;
}

/** Що робити з проблемним платежем — бухгалтер виправляє відхилене, голова підтверджує стан у Приват24. */
function problemActions(p) {
    const problem = problemOf(p);
    const id = escapeHtml(p.id);
    if (problem === 'failed') return isChair() ? '<small class="pm-sub">Бухгалтер виправить реквізити й повторить</small>'
        : `<button type="button" class="sv-btn" data-act="retry" data-id="${id}">Виправити й повторити</button>
           <button type="button" class="sv-btn is-soft" data-act="cancel" data-id="${id}">Прибрати</button>`;
    if (problem === 'returned') return `<button type="button" class="sv-btn is-soft" data-act="open" data-id="${id}">Деталі повернення</button>`;
    if (!isChair()) return '<small class="pm-sub">Голова перевіряє цей платіж у Приват24</small>';
    return `<button type="button" class="sv-btn is-soft" data-act="resolve-missing" data-id="${id}">У Приват24 його немає</button>
        <button type="button" class="sv-btn is-soft" data-act="resolve-found" data-id="${id}">Він є в Приват24</button>`;
}

function problemsHtml(list) {
    return `<section class="py-card pm-problems" id="pmProblems">
        <div class="py-card-head"><h2>Потребують уваги · ${list.length}</h2><span>банк не прийняв або не підтвердив</span></div>
        ${list.map(p => payRow(p, { sub: escapeHtml([PROBLEM_TEXT[problemOf(p)], p.error].filter(Boolean).join(': ')), actions: problemActions(p) })).join('')}
    </section>`;
}

// ---------- До оплати ----------
function todoRow(i, account) {
    const dis = account ? '' : ' disabled';
    const k = escapeHtml(i.key);
    const base = (ic, tags, actions, note = '') => `<div class="pm-row is-todo${i.state === 'bad' ? ' is-bad' : ''}" data-item="${k}">
        ${icon(ic)}
        <span class="pm-main"><b>${escapeHtml(i.title)}</b>${i.sub ? `<small>${escapeHtml(i.sub)}</small>` : ''}
            <span class="bn-tags">${tags}</span>${note ? `<small class="pm-sub">${escapeHtml(note)}</small>` : ''}</span>
        <span class="pm-right"><b class="pm-sum">${grn(i.amountKop)}</b>${i.partial ? `<small class="pm-sub">сплачено ${grn(i.partial)}</small>` : ''}</span>
        ${isChair() ? '' : `<span class="pm-actions">${actions}</span>`}
    </div>`;
    if (i.type === 'doc') return base('doc', `${chip(i.doc, 'is-doc')}${i.contract ? chip(i.contract, 'is-doc') : ''}${i.risk ? chip(i.risk.text, `is-risk-${i.risk.level}`) : ''}`,
        `<button type="button" class="sv-btn" data-act="pay-doc"${dis}>Створити платіж</button>
         <button type="button" class="sv-btn is-soft" data-act="open-doc">Документ</button>
         ${i.supplier ? '<button type="button" class="sv-btn is-soft" data-act="open-supplier">Постачальник</button>' : ''}`);
    if (i.type === 'payroll') return base('payroll', `${chip(`Відомість · ${monthName(i.ref.period)}`, 'is-people')}${i.state === 'bad' ? chip(i.note, 'is-risk-bad') : ''}`,
        `<button type="button" class="sv-btn" data-act="open-payroll">До відомості</button>`, 'Платежі людям і податки створює «Зарплата» — за відомістю, яку затвердив голова');
    if (i.type === 'advance') return base('advance', chip(`Авансовий звіт № ${i.ref.number || ''}`.trim(), 'is-people'),
        `<button type="button" class="sv-btn" data-act="pay-advance"${dis}>Відшкодувати</button>
         <button type="button" class="sv-btn is-soft" data-act="open-advance">Звіт</button>`);
    return base('regular', `${chip('Регулярний', 'is-supplier')}${chip(maskIban(i.ref.recipient?.iban || ''), '')}`,
        `<button type="button" class="sv-btn" data-act="send-proposal"${dis}>Відправити</button>
         <button type="button" class="sv-btn is-soft" data-act="edit-proposal">Змінити</button>
         <button type="button" class="sv-btn is-soft" data-act="skip">Не цього місяця</button>`, i.note);
}

function todoHtml(s) {
    const account = defaultAccount(data.ctx.accounts);
    const groups = [
        ['payroll', 'Зарплата й податки'], ['doc', 'За погодженими документами'], ['advance', 'Авансові звіти'], ['regular', 'Регулярні платежі']
    ].map(([type, title]) => [title, s.items.filter(i => i.type === type)]).filter(([, list]) => list.length);
    const head = `<div class="py-card-head"><h2>До оплати${s.items.length ? ` · ${grn(s.f.todo.kop)}` : ''}</h2>
        <span>${isChair() ? 'бухгалтер створить платежі — вони зʼявляться у вас у Приват24' : 'система пропонує — ви створюєте, голова підписує'}</span></div>`;
    const noBank = !account && !isChair() ? '<div class="pm-hint is-warn">Банк не підключено — платежі не створяться. <button type="button" class="sv-btn is-soft" data-go="settings" data-settings-tab="bank">Підключити</button></div>' : '';
    const loading = extraLoading && !extra ? '<p class="pm-loading">Перевіряю відомість зарплати й авансові звіти…</p>' : '';
    if (!groups.length) return `${head}${noBank}${loading}<p class="py-empty">Усе потрібне вже створено. Нове зʼявиться з погодженими документами, відомістю зарплати й регулярними платежами.</p>`;
    return `${head}${noBank}${groups.map(([title, list]) => `<div class="pm-group"><h3>${title} <span>${list.length} · ${grn(list.reduce((a, i) => a + i.amountKop, 0))}</span></h3>
        ${list.map(i => todoRow(i, account)).join('')}</div>`).join('')}${loading}`;
}

// ---------- На підписі ----------
function signingHtml(s) {
    const list = data.payments.filter(p => isSigning(p) && !problemOf(p));
    const head = `<div class="py-card-head"><h2>На підписі голови${list.length ? ` · ${grn(list.reduce((a, p) => a + p.amountKop, 0))}` : ''}</h2>
        <span>гроші не рухаються без КЕП голови · виписка сама позначить проведені</span></div>`;
    if (!list.length) return `${head}<p class="py-empty">Нічого не чекає підпису</p>`;
    const footer = isChair() ? '<p class="pm-hint">Приват24 для бізнесу → «Платежі» → «На підписі»: підпишіть КЕП. Після виписки платежі перейдуть в «Історію».</p>'
        : list.some(p => p.status === 'sent') ? '<button type="button" class="sv-btn is-soft pm-wide" data-act="remind">Нагадати голові</button>' : '';
    return `${head}${list.map(p => payRow(p, {
        sub: [p.createdAt ? `створено ${escapeHtml(when(p.createdAt))}` : '', p.bankRef ? `№ ${escapeHtml(p.bankRef)}` : '', p.bankStatus ? `Приват24: ${escapeHtml(p.bankStatus)}` : ''].filter(Boolean).join(' · '),
        actions: p.canceling ? '<small class="pm-sub">Скасування в банку…</small>'
            : `${p.paymentRef || p.bankRef ? `<button type="button" class="sv-btn is-soft" data-act="check-sign" data-id="${escapeHtml(p.id)}">Перевірити підпис</button>` : ''}
               ${p.status === 'sent' ? `<button type="button" class="sv-btn is-soft" data-act="cancel" data-id="${escapeHtml(p.id)}">Скасувати</button>` : ''}`
    })).join('')}${footer}`;
}

// ---------- Історія ----------
function historyHtml() {
    const groups = historyGroups(data.payments, { query: histQuery, kind: histKind });
    return `<div class="py-card-head"><h2>Історія</h2><span>проведені банком і скасовані</span></div>
        <div class="pm-tools">
            <label class="fl-search pm-search"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>
                <input type="search" id="pmQuery" placeholder="Отримувач, призначення, ЄДРПОУ, IBAN" value="${escapeHtml(histQuery)}" aria-label="Пошук платежу"></label>
            <div class="bn-chips" role="group" aria-label="Вид">${Object.entries(HISTORY_FILTERS).map(([k, v]) =>
                `<button type="button" class="bn-chip-btn${histKind === k ? ' is-active' : ''}" data-kind="${k}">${v}</button>`).join('')}</div>
        </div>
        <div id="pmHistory">${historyListHtml(groups)}</div>`;
}

function historyListHtml(groups) {
    if (!groups.length) return `<p class="py-empty">${histQuery || histKind !== 'all' ? 'Нічого не знайдено' : 'Проведених платежів ще немає'}</p>`;
    return groups.map(g => `<div class="pm-month"><div class="pm-month-head"><b>${escapeHtml(monthName(g.period))}</b><span>${g.list.length} · ${grn(g.kop)}</span></div>
        ${g.list.map(p => payRow(p, { sub: p.status === 'paid' ? `проведено ${escapeHtml(when(p.paidAt || p.createdAt))}` : `скасовано${p.createdAt ? ` · створено ${escapeHtml(when(p.createdAt))}` : ''}` })).join('')}</div>`).join('');
}

// ------------------------------------------------------------
// ФОРМА НОВОГО ПЛАТЕЖУ — БІЧНА КАРТКА
// ------------------------------------------------------------
function sheetHost() {
    let el = document.getElementById('pmSheet');
    if (el) return el;
    el = document.createElement('div');
    el.id = 'pmSheet';
    el.className = 'chs-wrap pm-sheet';
    el.hidden = true;
    document.body.appendChild(el);
    el.addEventListener('click', onSheetClick);
    el.addEventListener('input', onSheetInput);
    el.addEventListener('change', onSheetChange);
    el.addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.matches('input')) { e.preventDefault(); submit(el.querySelector('[data-pf="submit"]')); } });
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && !el.hidden && !document.querySelector('.confirm-overlay')) closeForm(); });
    window.addEventListener('hashchange', () => { if (!el.hidden) closeForm(); });
    return el;
}

/** Відкрити форму (і з «Рішень») — заповнену пропозицією чи невдалим платежем. */
export async function openForm(prefill) {
    if (prefill?.payroll) { openPayroll(prefill.payroll.period); toast('Повторіть відправку з відомості зарплати — суми залишаться затвердженими', 'info'); return; }
    if (location.hash !== '#payments') {
        // Спершу перехід у розділ (він закриває бічні картки), потім форма.
        const moved = new Promise(r => { window.addEventListener('hashchange', r, { once: true }); setTimeout(r, 400); });
        location.hash = 'payments';
        await moved;
    }
    const ctx = await loadPaymentContext();
    data.ctx = ctx;
    form = {
        meta: { proposalKey: prefill?.proposalKey || `manual:${crypto.randomUUID()}`, ...(prefill?.expenseId ? { expenseId: prefill.expenseId } : {}), ...(prefill?.status === 'failed' && prefill?.id ? { replaceId: prefill.id } : {}) },
        retry: prefill?.status === 'failed' ? prefill : null, yc: null
    };
    renderForm();
    fill(prefill || {});
    refreshWarnings();
    document.getElementById(prefill?.recipient?.name ? 'pfAmount' : 'pfName')?.focus({ preventScroll: true });
}

function closeForm() {
    const el = document.getElementById('pmSheet');
    if (!el) return;
    el.hidden = true;
    el.innerHTML = '';
    form = null;
    document.body.classList.remove('chs-open');
}

function renderForm() {
    const el = sheetHost();
    const accounts = data.ctx.accounts || [];
    el.hidden = false;
    document.body.classList.add('chs-open');
    el.innerHTML = `<div class="chs-backdrop" data-pf="close"></div>
        <aside class="chs-sheet" role="dialog" aria-modal="true" aria-label="Новий платіж">
            <div class="chs-bar"><span></span><span class="chs-bar-title">${form.retry ? 'Виправити й повторити' : 'Новий платіж'}</span>
                <button type="button" class="chs-icon" data-pf="close" aria-label="Закрити">×</button></div>
            <div class="chs-body">
                ${form.retry ? `<div class="pm-hint is-bad">Банк не прийняв попередній платіж${form.retry.error ? `: ${escapeHtml(form.retry.error)}` : ''}. Виправте реквізити — старий буде замінено.</div>` : ''}
                <section class="py-card pm-form">
                    <label class="py-field"><span>Кому</span>
                        <input id="pfName" list="pfRecipients" autocomplete="off" placeholder="Почніть вводити — підставимо реквізити"></label>
                    <datalist id="pfRecipients">${[...(data.ex?.suppliers || []).filter(s => s.iban).map(s => ({ name: s.name, iban: s.iban })), ...(data.ctx.recipients || [])]
                        .filter((r, i, a) => a.findIndex(x => x.name === r.name) === i).map(r => `<option value="${escapeHtml(r.name)}">${escapeHtml(maskIban(r.iban))}</option>`).join('')}</datalist>
                    <div class="py-pair">
                        <label class="py-field"><span>IBAN</span><input id="pfIban" autocomplete="off" placeholder="UA…"></label>
                        <label class="py-field"><span>ЄДРПОУ або РНОКПП</span><input id="pfCode" inputmode="numeric" maxlength="10"></label>
                    </div>
                    <div id="pfYc"></div>
                    <label class="py-field py-amount"><span>Сума, грн</span><input id="pfAmount" inputmode="decimal" placeholder="0,00"></label>
                    <label class="py-field"><span>Призначення</span><textarea id="pfPurpose" rows="3" maxlength="420" placeholder="За що платимо, номер договору чи рахунку, період"></textarea></label>
                    <div class="py-pair">
                        <label class="py-field"><span>Вид</span><select id="pfKind">${Object.entries(PAYMENT_KINDS).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></label>
                        <label class="py-field"><span>З рахунку</span><select id="pfAccount">${accounts.map(a =>
                            `<option value="${escapeHtml(a.iban)}"${a.iban === defaultAccount(accounts) ? ' selected' : ''}>${escapeHtml(ACCOUNT_PURPOSES[a.purpose] || 'Рахунок')} · ${escapeHtml(maskIban(a.iban))}${typeof a.balanceKop === 'number' ? ` · ${money(a.balanceKop)}` : ''}</option>`).join('')}</select></label>
                    </div>
                </section>
                <div id="pfWarn" class="pm-warns"></div>
                <p class="pm-hint">Платіж зʼявиться в Приват24 і чекатиме підпису КЕП голови. Без підпису гроші не рухаються. Оплата за документом звʼязується з обліком сама — для неї краще кнопка «Створити платіж» у вкладці «До оплати».</p>
                <div class="chs-actions"><button type="button" class="sv-btn is-wide" data-pf="submit">Створити в Приват24</button></div>
            </div>
        </aside>`;
}

function fill(p) {
    const set = (id, v) => { const el = document.getElementById(id); if (el && v !== undefined) el.value = v; };
    set('pfName', p.recipient?.name || '');
    set('pfIban', p.recipient?.iban || '');
    set('pfCode', p.recipient?.code || '');
    set('pfAmount', p.amountText ?? (p.amountKop ? (p.amountKop / 100).toFixed(2).replace('.', ',') : ''));
    set('pfPurpose', p.purpose || '');
    if (p.kind && PAYMENT_KINDS[p.kind]) set('pfKind', p.kind);
    if (p.account) set('pfAccount', p.account);
}

function readForm() {
    const value = id => document.getElementById(id)?.value.trim() || '';
    return {
        action: 'create', kind: value('pfKind'),
        recipient: { name: value('pfName'), iban: value('pfIban').replace(/\s+/g, '').toUpperCase(), code: value('pfCode') },
        amountKop: kop(value('pfAmount')), purpose: value('pfPurpose'), account: value('pfAccount'), ...form.meta
    };
}

/** Та сама перевірка, що на сервері, — щоб помилку видно було одразу. */
function formError(p) {
    if (!p.recipient.name) return 'Вкажіть отримувача';
    if (!validIban(p.recipient.iban)) return 'IBAN некоректний — перевірте цифри';
    if (!/^\d{8}$|^\d{10}$/.test(p.recipient.code)) return 'Код — 8 цифр ЄДРПОУ або 10 цифр РНОКПП';
    if (!Number.isInteger(p.amountKop) || p.amountKop <= 0) return 'Вкажіть суму';
    if (p.purpose.length < 5) return 'Вкажіть призначення платежу';
    if (!p.account) return 'Підключіть банк у «Налаштуваннях»';
    return null;
}

function refreshWarnings() {
    const box = document.getElementById('pfWarn');
    if (!box || !form) return;
    const draft = readForm();
    const list = draftWarnings({ ...draft, amountKop: Number.isInteger(draft.amountKop) ? draft.amountKop : 0 },
        { payments: data.payments.filter(p => p.id !== form.meta.replaceId), ex: data.ex, payrollIbans: extra?.payrollIbans || [] });
    box.innerHTML = list.map(w => `<div class="pm-warn is-${w.level}"><span>${escapeHtml(w.text)}</span>
        ${w.act === 'open-payment' ? `<button type="button" class="sv-btn is-soft" data-pf="open-payment" data-id="${escapeHtml(w.id)}">Відкрити</button>`
        : w.act === 'pay-doc' ? `<button type="button" class="sv-btn" data-pf="pay-doc" data-id="${escapeHtml(w.id)}">Оплатити за документом</button>`
        : w.act === 'go-payroll' ? '<button type="button" class="sv-btn is-soft" data-pf="go-payroll">До «Зарплати»</button>'
        : w.act === 'check-yc' && !form.yc ? '<button type="button" class="sv-btn is-soft" data-pf="check-yc">Перевірити в YouControl</button>' : ''}</div>`).join('');
    renderYc();
}

/** Короткий висновок YouControl під кодом отримувача. */
function renderYc() {
    const box = document.getElementById('pfYc');
    if (!box || !form) return;
    const code = document.getElementById('pfCode')?.value.trim() || '';
    const valid = /^\d{8}$|^\d{10}$/.test(code);
    const yc = form.yc?.code === code ? form.yc : null;
    if (!valid) { box.innerHTML = ''; return; }
    if (yc?.busy) { box.innerHTML = '<div class="pm-yc"><span class="bn-yc-logo">YC</span><span>Перевіряю в YouControl…</span></div>'; return; }
    if (yc?.view) {
        const v = yc.view;
        box.innerHTML = `<div class="pm-yc is-${v.level}"><span class="bn-yc-logo">YC</span>
            <span class="pm-yc-main"><b>${escapeHtml(v.title)}</b><small>${escapeHtml([v.name, ...v.flags.slice(0, 2).map(f => f.text.replace('з платником у виписці', 'з отримувачем у формі'))].filter(Boolean).join(' · '))}</small></span></div>`;
        return;
    }
    box.innerHTML = `<button type="button" class="pm-yc is-ask" data-pf="check-yc"><span class="bn-yc-logo">YC</span><span class="pm-yc-main"><b>Перевірити отримувача в YouControl</b><small>стан у ЄДР, податковий борг, санкції</small></span></button>`;
}

async function checkYc() {
    const code = document.getElementById('pfCode')?.value.trim() || '';
    if (!/^\d{8}$|^\d{10}$/.test(code)) { toast('Код — 8 цифр ЄДРПОУ або 10 цифр РНОКПП', 'error'); return; }
    form.yc = { code, busy: true };
    renderYc();
    try {
        const d = await expAct({ action: 'checkSupplier', code });
        if (!form || form.yc?.code !== code) return;
        form.yc = { code, view: dossierView(d, document.getElementById('pfName')?.value.trim() || '') };
        if (d?.found && !document.getElementById('pfName').value.trim()) document.getElementById('pfName').value = d.shortName || d.name || '';
    } catch (err) { toast(err.message, 'error'); if (form) form.yc = null; }
    refreshWarnings();
}

let warnTimer = 0;
function onSheetInput(e) {
    if (!e.target.closest('.pm-form')) return;
    clearTimeout(warnTimer);
    warnTimer = setTimeout(refreshWarnings, 200);
}

// Обрали відомого отримувача — підставляємо реквізити й останнє призначення.
function onSheetChange(e) {
    if (e.target.id !== 'pfName') return;
    const name = e.target.value;
    const s = (data.ex?.suppliers || []).find(x => x.name === name && x.iban);
    const r = (data.ctx.recipients || []).find(x => x.name === name);
    if (!s && !r) return;
    fill({ recipient: { name, iban: s?.iban || r.iban, code: s?.code || r?.code || '' }, purpose: r?.purpose || '', amountKop: r?.amountKop || 0 });
    refreshWarnings();
    document.getElementById('pfAmount').focus();
    document.getElementById('pfAmount').select();
}

async function onSheetClick(e) {
    const t = e.target.closest('[data-pf]');
    if (!t) return;
    const a = t.dataset.pf;
    if (a === 'close') closeForm();
    else if (a === 'submit') submit(t);
    else if (a === 'check-yc') checkYc();
    else if (a === 'open-payment') openPaymentSheet(t.dataset.id);
    else if (a === 'go-payroll') { closeForm(); openPayroll(); }
    else if (a === 'pay-doc') {
        const doc = (data.ex?.expenses || []).find(x => x.id === t.dataset.id);
        if (doc) { closeForm(); payDoc(doc); }
    }
}

async function submit(button) {
    if (!button || !form) return;
    const payload = readForm();
    const error = formError(payload);
    if (error) { toast(error, 'error'); return; }
    const blocking = draftWarnings(payload, { payments: data.payments.filter(p => p.id !== form.meta.replaceId), ex: data.ex, payrollIbans: extra?.payrollIbans || [] })
        .filter(w => w.level !== 'info');
    const extraText = blocking.length ? ` Зверніть увагу: ${blocking.map(w => w.text).join('; ')}.` : '';
    if (!await confirmDialog('Створити платіж у Приват24?', `${payload.recipient.name}: ${money(payload.amountKop)}. У Приват24 він чекатиме підпису голови.${extraText}`, 'Так, створити')) return;
    setBusy(button, true, 'Відправляю…');
    try {
        await payAct(payload);
        closeForm();
        tab = 'signing';
        tabPicked = true;
        toast('Платіж у Приват24 — чекає підпису голови', 'success');
    } catch (err) { toast(err.message, 'error'); setBusy(button, false); }
}

// ------------------------------------------------------------
// ДІЇ
// ------------------------------------------------------------
async function payDoc(doc, btn = null) {
    const supplier = supplierFor({ expenseId: doc.id }, data.ex);
    const risk = riskOf(supplier);
    if (!await confirmDialog('Створити платіж за документом?', `${doc.supplierName}: ${money(doc.amountKop - (doc.stornoKop || 0) - (doc.paidKop || 0))}. Призначення складе система за документом; у Приват24 платіж чекатиме підпису голови.${risk ? ` Увага: ${risk.text}.` : ''}`, 'Створити')) return;
    if (btn) setBusy(btn, true, 'Відправляю…');
    try { await payExpense(doc); tab = 'signing'; tabPicked = true; } catch (err) { toast(err.message, 'error'); if (btn) setBusy(btn, false); }
}

async function onClick(e) {
    const tabBtn = e.target.closest('[data-pm-tab]');
    if (tabBtn) { tab = tabBtn.dataset.pmTab; tabPicked = true; render(); return; }
    const kindBtn = e.target.closest('[data-kind]');
    if (kindBtn) { histKind = kindBtn.dataset.kind; render(); return; }
    const btn = e.target.closest('[data-act]');
    if (!btn) {
        const row = e.target.closest('[data-pay]');
        if (row && !e.target.closest('a, input, select, textarea, label')) openPaymentSheet(row.dataset.pay);
        return;
    }
    if (btn.disabled) return;
    const act = btn.dataset.act;
    const item = data.items.find(i => i.key === btn.closest('[data-item]')?.dataset.item);
    const id = btn.dataset.id;
    if (act === 'new') openForm();
    else if (act === 'open') openPaymentSheet(id);
    else if (act === 'tab-todo' || act === 'tab-signing') { tab = act.slice(4); tabPicked = true; render(); document.querySelector('.pm-bar')?.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
    else if (act === 'open-problem') document.getElementById('pmProblems')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    else if (act === 'open-doc' && item) openExpenses('docs', null, item.ref.id);
    else if (act === 'open-supplier' && item?.supplier) openExpenses('suppliers', null, null, { kind: 'supplier', id: item.supplier.id, name: item.supplier.name, code: item.supplier.code || '', iban: item.supplier.iban || '' });
    else if (act === 'pay-doc' && item) payDoc(item.ref, btn);
    else if (act === 'open-payroll' && item) openPayroll(item.ref.period);
    else if (act === 'open-advance' && item) openAdvance('all', item.ref.id);
    else if (act === 'pay-advance' && item) {
        if (!await confirmDialog('Відшкодувати перевитрату?', `${item.title}: ${money(item.amountKop)} на особисту картку. У Приват24 платіж чекатиме підпису голови.`, 'Створити платіж')) return;
        setBusy(btn, true, 'Відправляю…');
        try { await reimburseReport(item.ref); tab = 'signing'; tabPicked = true; } catch (err) { toast(err.message, 'error'); setBusy(btn, false); }
    } else if (act === 'send-proposal' && item) {
        setBusy(btn, true, 'Відправляю…');
        try { await sendProposal(item.ref, defaultAccount(data.ctx.accounts)); tab = 'signing'; tabPicked = true; } catch (err) { toast(err.message, 'error'); setBusy(btn, false); }
    } else if (act === 'edit-proposal' && item) openForm(item.ref);
    else if (act === 'skip' && item) { skipProposal(item.ref.proposalKey); toast('Відкладено до наступного місяця', 'success'); }
    else if (act === 'remind') {
        setBusy(btn, true, 'Надсилаю…');
        try { const r = await payAct({ action: 'remind' }); toast(`Голові надіслано нагадування: на підписі ${r.count} ${payWord(r.count)}`, 'success'); }
        catch (err) { toast(err.message, 'error'); setBusy(btn, false); }
    } else if (act === 'check-sign') {
        setBusy(btn, true, 'Перевіряю…');
        try { const r = await payAct({ action: 'checkSignStatus', id }); toast(`Статус у Приват24: ${r?.bankStatus || 'перевірено'}`, 'success'); }
        catch (err) { toast(err.message, 'error'); setBusy(btn, false); }
    } else if (act === 'cancel') {
        if (!await confirmDialog('Скасувати платіж?', 'Якщо голова ще не підписав, платіж буде видалено й у Приват24 (або видаліть його там вручну).', 'Скасувати платіж')) return;
        try { const r = await payAct({ action: 'cancel', id }); toast(r?.deletedInBank ? 'Скасовано й видалено в банку' : 'Скасовано. Перевірте, чи видалено його в Приват24', 'success'); }
        catch (err) { toast(err.message, 'error'); }
    } else if (act === 'resolve-missing' || act === 'resolve-found') {
        const missing = act === 'resolve-missing';
        const reason = await promptDialog(missing ? 'Платежу в Приват24 немає?' : 'Платіж є в Приват24?',
            missing ? 'Перевірте список платежів у Приват24 (зокрема «Чернетки» й «На підписі»). Після позначки його можна буде відправити знову — дубля не буде, лише якщо в банку його справді немає.'
                : 'Платіж позначиться «чекає підпису»; виписка закриє його, коли голова підпише.',
            { confirmLabel: missing ? 'Платежу немає' : 'Платіж є', placeholder: missing ? 'Напр.: перевірила 14.11, у Приват24 немає' : 'Номер чи дата в Приват24', maxLength: 300 });
        if (!reason) return;
        try {
            await payAct({ action: 'resolve', id, outcome: missing ? 'not_created' : 'created', reason });
            toast(missing ? 'Позначено: у банку немає. Платіж можна відправити знову' : 'Позначено: платіж чекає підпису в Приват24', 'success');
        } catch (err) { toast(err.message, 'error'); }
    } else if (act === 'retry') {
        const p = data.payments.find(x => x.id === id);
        if (p) openForm(p);
    }
}

export function initPaymentsView() {
    const host = document.getElementById('viewPayments');
    host.addEventListener('click', onClick);
    host.addEventListener('input', e => {
        if (e.target.id !== 'pmQuery') return;
        histQuery = e.target.value;
        const box = document.getElementById('pmHistory');
        if (box) box.innerHTML = historyListHtml(historyGroups(data.payments, { query: histQuery, kind: histKind }));
    });
    host.addEventListener('keydown', e => {
        if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('[data-pay]')) { e.preventDefault(); openPaymentSheet(e.target.dataset.pay); }
    });
}
