// ============================================================
// «Платежі»: система пропонує регулярні платежі й оплату погоджених
// документів, бухгалтер підтверджує — платіж зʼявляється в Приват24 й
// чекає підпису КЕП голови. Проведення видно з виписки: статус
// змінюється сам. Ліворуч — що на підписі, що варто створити й що
// виконано; праворуч — форма нового платежу.
// ============================================================
import { session } from './firebase.js';
import { escapeHtml, toast, setBusy, confirmDialog, promptDialog } from './ui.js';
import {
    loadPayments, loadPaymentContext, loadExpenses, payAct, skippedProposals, skipProposal, money, when, maskIban,
    PAYMENT_KINDS, PAYMENT_STATUS, ACCOUNT_PURPOSES
} from './buh-data.js';
import { payExpense, openExpenses } from './buh-expenses.js';
import { remaining, paidByDocuments, coveredByDocuments } from './docs-core.js';
import { openPaymentSheet } from './buh-chain.js';
import { validIban } from './nbu-qr.js';
import { toKop as kop } from './charges-core.js';

let ctx = { proposals: [], recipients: [], accounts: [] };
let formOpen = false;
let pendingFill = null;
let formMetadata = {};
let showHistory = false;
let docs = [];            // погоджені документи, за якими ще немає платежу

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

/** Відправити пропозицію в банк — і з «Платежів», і з «Вхідних». */
export async function sendProposal(p, account) {
    await payAct({ action: 'create', kind: 'supplier', recipient: p.recipient, amountKop: p.amountKop, purpose: p.purpose, account, proposalKey: p.proposalKey });
    toast(`${p.recipient.name}: платіж у Приват24 на підпис`, 'success');
}

const isChair = () => session.role === 'chair';
const paymentsWord = n => (n % 10 === 1 && n % 100 !== 11 ? 'платіж' : [2, 3, 4].includes(n % 10) && ![12, 13, 14].includes(n % 100) ? 'платежі' : 'платежів');
const tsOf = ts => (ts?.toMillis ? ts.toMillis() : Date.parse(ts) || 0);

function chipHtml(p) {
    const [text] = PAYMENT_STATUS[p.status] || [p.status];
    const cls = p.status === 'paid' ? 'is-done' : ['failed', 'unknown'].includes(p.status) ? 'is-bad' : p.status === 'sent' ? '' : 'is-work';
    return `<span class="sv-chip ${cls}">${escapeHtml(text)}</span>`;
}

function formHtml() {
    const accounts = ctx.accounts;
    return `<section class="py-card py-form${formOpen ? '' : ' is-closed'}" id="payForm" aria-label="Новий платіж">
        <div class="py-card-head"><h2>Новий платіж</h2><button type="button" class="sv-btn is-soft py-close" data-act="close-form">Закрити</button></div>
        <label class="py-field"><span>Кому</span>
            <input id="pfName" list="pfRecipients" autocomplete="off" placeholder="Почніть вводити — підставимо реквізити"></label>
        <datalist id="pfRecipients">${ctx.recipients.map(r => `<option value="${escapeHtml(r.name)}">${escapeHtml(maskIban(r.iban))}</option>`).join('')}</datalist>
        <div class="py-pair">
            <label class="py-field"><span>IBAN</span><input id="pfIban" autocomplete="off" placeholder="UA…"></label>
            <label class="py-field"><span>ЄДРПОУ або РНОКПП</span><input id="pfCode" inputmode="numeric" maxlength="10"></label>
        </div>
        <label class="py-field py-amount"><span>Сума, грн</span><input id="pfAmount" inputmode="decimal" placeholder="0,00"></label>
        <label class="py-field"><span>Призначення</span><textarea id="pfPurpose" rows="3" maxlength="420" placeholder="За що платимо, номер договору чи рахунку, період"></textarea></label>
        <div class="py-pair">
            <label class="py-field"><span>Вид</span><select id="pfKind">${Object.entries(PAYMENT_KINDS).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></label>
            <label class="py-field"><span>З рахунку</span><select id="pfAccount">${accounts.map(a =>
                `<option value="${escapeHtml(a.iban)}"${a.iban === defaultAccount(accounts) ? ' selected' : ''}>${escapeHtml(ACCOUNT_PURPOSES[a.purpose] || 'Рахунок')} · ${escapeHtml(maskIban(a.iban))}${typeof a.balanceKop === 'number' ? ` · ${money(a.balanceKop)}` : ''}</option>`).join('')}</select></label>
        </div>
        <p class="py-note">Платіж зʼявиться в Приват24 і чекатиме підпису КЕП голови. Без підпису гроші не рухаються.</p>
        <button type="button" class="sv-btn is-wide" data-act="submit">Створити в Приват24</button>
    </section>`;
}

function readForm() {
    const value = id => document.getElementById(id).value.trim();
    return {
        action: 'create', kind: value('pfKind'),
        recipient: { name: value('pfName'), iban: value('pfIban').replace(/\s+/g, '').toUpperCase(), code: value('pfCode') },
        amountKop: kop(value('pfAmount')), purpose: value('pfPurpose'), account: value('pfAccount'), ...formMetadata
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

/** Введене у формі — щоб перемальовування розділу його не стерло. */
function draftOf() {
    if (!document.getElementById('pfName')) return null;
    const value = id => document.getElementById(id).value;
    const draft = { recipient: { name: value('pfName'), iban: value('pfIban'), code: value('pfCode') }, amountText: value('pfAmount'), purpose: value('pfPurpose'), kind: value('pfKind'), account: value('pfAccount') };
    return draft.recipient.name || draft.recipient.iban || draft.amountText || draft.purpose ? draft : null;
}

/**
 * Банк не підтвердив результат (або відправка зависла понад 10 хв): голова
 * перевіряє в Приват24 і фіксує — платежу немає (можна відправити знову)
 * чи він там є (далі його закриє виписка). Бухгалтер бачить підказку.
 */
function uncertainActions(p) {
    const stale = p.status === 'unknown' || (p.status === 'sending' && Date.now() - (tsOf(p.createdAt) || Date.now()) > 10 * 60 * 1000);
    if (!stale) return '';
    if (!isChair()) return '<small class="py-muted">Голова перевіряє цей платіж у Приват24</small>';
    return `<button type="button" class="sv-btn is-soft" data-act="resolve-missing" data-id="${escapeHtml(p.id)}">У Приват24 його немає</button>
        <button type="button" class="sv-btn is-soft" data-act="resolve-found" data-id="${escapeHtml(p.id)}">Він є в Приват24</button>`;
}

function rowHtml(p, { sub = '', actions = '', chip = true } = {}) {
    return `<div class="py-row is-link" data-pay="${escapeHtml(p.id)}" tabindex="0" role="button" aria-label="Деталі платежу: ${escapeHtml(p.recipient?.name || '')}">
        <span class="py-main"><b>${escapeHtml(p.recipient?.name || '')}</b><small>${escapeHtml(p.purpose || '')}</small>
            ${sub ? `<small class="py-muted">${sub}</small>` : ''}</span>
        <span class="py-right"><b class="py-sum">${money(p.amountKop)}</b>${chip ? chipHtml(p) : ''}</span>
        ${actions ? `<span class="py-actions">${actions}</span>` : ''}
    </div>`;
}

function suggestHtml(list, account) {
    const docRows = docs.map(e => `<div class="py-row" data-doc="${escapeHtml(e.id)}">
        <span class="py-main"><b>${escapeHtml(e.supplierName)}</b><small>${escapeHtml(e.description || '')}</small>
            <small class="py-muted">${escapeHtml(e.docTypeName || 'Документ')} № ${escapeHtml(e.number)} погоджено${e.paidKop > 0 ? ` · сплачено ${money(e.paidKop)}` : ''}</small></span>
        <span class="py-right"><b class="py-sum">${money(remaining(e))}</b></span>
        <span class="py-actions"><button type="button" class="sv-btn" data-act="pay-doc"${account ? '' : ' disabled'}>Створити платіж</button>
            <button type="button" class="sv-btn is-soft" data-act="open-doc">Документ</button></span>
    </div>`);
    const regular = list.map(p => `<div class="py-row" data-key="${escapeHtml(p.proposalKey)}">
        <span class="py-main"><b>${escapeHtml(p.recipient.name)}</b><small>${escapeHtml(p.purpose)}</small>
            <small class="py-muted">щомісяця ${p.months} міс. поспіль · зазвичай ${p.day}-го · ${escapeHtml(maskIban(p.recipient.iban))}</small></span>
        <span class="py-right"><b class="py-sum">${money(p.amountKop)}</b></span>
        <span class="py-actions"><button type="button" class="sv-btn" data-act="send-proposal"${account ? '' : ' disabled'}>Відправити</button>
            <button type="button" class="sv-btn is-soft" data-act="edit-proposal">Заповнити</button>
            <button type="button" class="sv-btn is-soft" data-act="skip">Не цього місяця</button></span>
    </div>`);
    return [...docRows, ...regular].join('') || '<p class="py-empty">Усе потрібне вже створено. Нові пропозиції зʼявляться з погодженими документами й регулярними платежами.</p>';
}

export async function loadPaymentsView() {
    const [{ context, list }, payments, expenses] = await Promise.all([activeProposals(), loadPayments(), loadExpenses().catch(() => null)]);
    ctx = context;
    const inBank = new Set(payments.filter(p => p.expenseId && ['sending', 'unknown', 'sent'].includes(p.status)).map(p => p.expenseId));
    docs = (expenses?.expenses || []).filter(e => e.status === 'approved' && remaining(e) > 0 && !inBank.has(e.id))
        .map(e => ({ ...e, docTypeName: expenses.docTypes?.[e.docType] }));
    const waiting = payments.filter(p => ['sent', 'sending', 'unknown'].includes(p.status));
    const failed = payments.filter(p => p.status === 'failed');
    const now = new Date();
    const thisMonth = p => { const d = new Date(tsOf(p.paidAt || p.createdAt)); return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth(); };
    const done = payments.filter(p => p.status === 'paid' && thisMonth(p));
    const older = payments.filter(p => (p.status === 'paid' && !thisMonth(p)) || p.status === 'canceled').slice(0, 40);
    const total = waiting.reduce((s, p) => s + p.amountKop, 0);
    const account = defaultAccount(ctx.accounts);
    const draft = pendingFill ? null : draftOf();

    document.getElementById('viewPayments').innerHTML = `
        <div class="py-top">
            <button type="button" class="sv-btn py-new" data-act="open-form">+ Новий платіж</button>
        </div>
        <div class="py-grid">
            <div class="py-col">
                ${failed.length ? `<section class="py-card is-alert"><div class="py-card-head"><h2>Банк не прийняв · ${failed.length}</h2></div>
                    ${failed.map(p => rowHtml(p, { sub: escapeHtml(p.error || ''), actions: `<button type="button" class="sv-btn" data-act="retry" data-id="${escapeHtml(p.id)}">Виправити й повторити</button>
                        <button type="button" class="sv-btn is-soft" data-act="cancel" data-id="${escapeHtml(p.id)}">Прибрати</button>` })).join('')}</section>` : ''}
                <section class="py-card${waiting.length ? ' is-wait' : ''}">
                    <div class="py-card-head"><h2>Чекають підпису голови${waiting.length ? ` · ${waiting.length}` : ''}</h2>${waiting.length ? `<b class="py-total">${money(total)}</b>` : ''}</div>
                    ${waiting.length ? waiting.map(p => rowHtml(p, {
                        sub: `${p.createdAt ? `створено ${escapeHtml(when(p.createdAt))}` : ''}${PAYMENT_KINDS[p.kind] ? ` · ${escapeHtml(PAYMENT_KINDS[p.kind].toLowerCase())}` : ''}`,
                        actions: p.status === 'sent' ? `<button type="button" class="sv-btn is-soft" data-act="cancel" data-id="${escapeHtml(p.id)}">Скасувати</button>` : uncertainActions(p),
                        chip: p.status !== 'sent'
                    })).join('') + (isChair() ? '<p class="py-note">Підпишіть їх у Приват24 для бізнесу — виписка сама позначить платежі виконаними.</p>'
                        : waiting.some(p => p.status === 'sent') ? '<button type="button" class="sv-btn is-soft is-wide" data-act="remind">Нагадати голові</button>' : '')
                    : '<p class="py-empty">Нічого не чекає підпису</p>'}
                </section>
                <section class="py-card">
                    <div class="py-card-head"><h2>Варто створити</h2><span>за погодженими документами й регулярними платежами</span></div>
                    ${suggestHtml(list, account)}
                </section>
                <section class="py-card">
                    <div class="py-card-head"><h2>Виконані цього місяця${done.length ? ` · ${done.length}` : ''}</h2>${done.length ? `<b class="py-total is-muted">${money(done.reduce((s, p) => s + p.amountKop, 0))}</b>` : ''}</div>
                    ${done.length ? done.map(p => rowHtml(p, { sub: p.paidAt ? `виконано банком ${escapeHtml(when(p.paidAt))}` : 'виконано банком' })).join('') : '<p class="py-empty">Цього місяця виконаних платежів ще немає</p>'}
                    ${older.length ? `<button type="button" class="sv-btn is-soft is-wide" data-act="history">${showHistory ? 'Сховати давніші' : `Давніші й скасовані · ${older.length}`}</button>
                        ${showHistory ? older.map(p => rowHtml(p, { sub: p.createdAt ? escapeHtml(when(p.createdAt)) : '' })).join('') : ''}` : ''}
                </section>
            </div>
            ${formHtml()}
        </div>`;
    if (draft) fill(draft);
    afterRender();
}

function fill(p) {
    document.getElementById('pfName').value = p.recipient?.name || '';
    document.getElementById('pfIban').value = p.recipient?.iban || '';
    document.getElementById('pfCode').value = p.recipient?.code || '';
    document.getElementById('pfAmount').value = p.amountText ?? (p.amountKop ? (p.amountKop / 100).toFixed(2).replace('.', ',') : '');
    document.getElementById('pfPurpose').value = p.purpose || '';
    if (p.kind) document.getElementById('pfKind').value = p.kind;
    if (p.account) document.getElementById('pfAccount').value = p.account;
}

/** Відкрити форму (з «Вхідних» теж) — заповнену пропозицією чи невдалим платежем. */
export async function openForm(prefill) {
    if (prefill?.payroll) { location.hash = 'payroll'; toast('Повторіть відправку з відомості зарплати — суми залишаться затвердженими', 'info'); return; }
    formOpen = true;
    formMetadata = { proposalKey: prefill?.proposalKey || `manual:${crypto.randomUUID()}`, ...(prefill?.expenseId ? { expenseId: prefill.expenseId } : {}) };
    pendingFill = prefill || { recipient: {}, purpose: '', amountKop: 0 };
    await loadPaymentsView();
}

function afterRender() {
    if (!formOpen || !pendingFill) return;
    fill(pendingFill);
    document.getElementById(pendingFill.recipient?.name ? 'pfAmount' : 'pfName')?.focus({ preventScroll: true });
    document.getElementById('payForm')?.scrollIntoView({ block: 'start', behavior: 'smooth' });
    pendingFill = null;
}

async function submit(button) {
    const payload = readForm();
    const error = formError(payload);
    if (error) { toast(error, 'error'); return; }
    if (!await confirmDialog('Створити платіж у Приват24?', `${payload.recipient.name}: ${money(payload.amountKop)}. У Приват24 він чекатиме підпису голови.`, 'Так, створити')) return;
    setBusy(button, true, 'Відправляю…');
    try {
        await payAct(payload);
        formOpen = false;
        formMetadata = {};
        pendingFill = { recipient: {}, purpose: '', amountKop: 0 };   // очистити форму після перемальовування
        toast('Платіж у Приват24 — чекає підпису голови', 'success');
    } catch (e) { toast(e.message, 'error'); }
    finally { setBusy(button, false); }
}

export function initPaymentsView() {
    const host = document.getElementById('viewPayments');
    host.addEventListener('click', async e => {
        const btn = e.target.closest('[data-act]');
        if (!btn) {
            const row = e.target.closest('[data-pay]');
            if (row && !e.target.closest('a, input, select, textarea, label')) openPaymentSheet(row.dataset.pay);
            return;
        }
        const act = btn.dataset.act;
        const row = btn.closest('[data-key]');
        const proposal = row && ctx.proposals.find(p => p.proposalKey === row.dataset.key);
        const doc = docs.find(x => x.id === btn.closest('[data-doc]')?.dataset.doc);
        if (act === 'open-form') openForm();
        else if (act === 'close-form') { formOpen = false; loadPaymentsView(); }
        else if (act === 'history') { showHistory = !showHistory; loadPaymentsView(); }
        else if (act === 'open-doc' && doc) openExpenses('docs', null, doc.id);
        else if (act === 'pay-doc' && doc) {
            if (!await confirmDialog('Створити платіж за документом?', `${doc.supplierName}: ${money(remaining(doc))}. Призначення складе система за документом; у Приват24 платіж чекатиме підпису голови.`, 'Створити')) return;
            setBusy(btn, true, 'Відправляю…');
            try { await payExpense(doc); } catch (err) { toast(err.message, 'error'); setBusy(btn, false); }
        } else if (act === 'remind') {
            setBusy(btn, true, 'Надсилаю…');
            try { const r = await payAct({ action: 'remind' }); toast(`Голові надіслано нагадування: на підписі ${r.count} ${paymentsWord(r.count)}`, 'success'); }
            catch (err) { toast(err.message, 'error'); setBusy(btn, false); }
        }
        else if (act === 'submit') submit(btn);
        else if (act === 'edit-proposal' && proposal) openForm(proposal);
        else if (act === 'skip' && proposal) { skipProposal(proposal.proposalKey); toast('Відкладено до наступного місяця', 'success'); }
        else if (act === 'send-proposal' && proposal) {
            setBusy(btn, true, 'Відправляю…');
            try { await sendProposal(proposal, defaultAccount(ctx.accounts)); }
            catch (err) { toast(err.message, 'error'); setBusy(btn, false); }
        } else if (act === 'cancel') {
            if (!await confirmDialog('Скасувати платіж?', 'Якщо голова ще не підписав, платіж буде видалено й у Приват24 (або видаліть його там вручну).', 'Скасувати платіж')) return;
            try { const r = await payAct({ action: 'cancel', id: btn.dataset.id }); toast(r?.deletedInBank ? 'Скасовано й видалено в банку' : 'Скасовано. Перевірте, чи видалено його в Приват24', 'success'); }
            catch (err) { toast(err.message, 'error'); }
        } else if (act === 'resolve-missing' || act === 'resolve-found') {
            const missing = act === 'resolve-missing';
            const reason = await promptDialog(missing ? 'Платежу в Приват24 немає?' : 'Платіж є в Приват24?',
                missing ? 'Перевірте список платежів у Приват24 (зокрема «Чернетки» й «На підписі»). Після позначки його можна буде відправити знову — дубля не буде, лише якщо в банку його справді немає.'
                    : 'Платіж позначиться «чекає підпису»; виписка закриє його, коли голова підпише.',
                { confirmLabel: missing ? 'Платежу немає' : 'Платіж є', placeholder: missing ? 'Напр.: перевірила 14.11, у Приват24 немає' : 'Номер чи дата в Приват24', maxLength: 300 });
            if (!reason) return;
            try {
                await payAct({ action: 'resolve', id: btn.dataset.id, outcome: missing ? 'not_created' : 'created', reason });
                toast(missing ? 'Позначено: у банку немає. Платіж можна відправити знову' : 'Позначено: платіж чекає підпису в Приват24', 'success');
            } catch (err) { toast(err.message, 'error'); }
        } else if (act === 'retry') {
            const p = (await loadPayments()).find(x => x.id === btn.dataset.id);
            if (p) openForm(p);
        }
    });
    // Обрали відомого отримувача — підставляємо реквізити й останнє призначення.
    host.addEventListener('change', e => {
        if (e.target.id !== 'pfName') return;
        const r = ctx.recipients.find(x => x.name === e.target.value);
        if (!r) return;
        fill({ recipient: r, purpose: r.purpose, amountKop: r.amountKop });
        document.getElementById('pfAmount').focus();
        document.getElementById('pfAmount').select();
    });
    host.addEventListener('keydown', e => {
        if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('[data-pay]')) { e.preventDefault(); openPaymentSheet(e.target.dataset.pay); return; }
        if (e.key === 'Enter' && e.target.closest('#payForm') && e.target.matches('input')) { e.preventDefault(); submit(host.querySelector('[data-act="submit"]')); }
    });
}
