// ============================================================
// «Платежі»: система пропонує регулярні платежі, бухгалтер
// підтверджує — платіж зʼявляється в Приват24 й чекає підпису КЕП
// голови. Проведення видно з виписки: статус змінюється сам.
// ============================================================
import { escapeHtml, toast, setBusy, confirmDialog } from './ui.js';
import {
    loadPayments, loadPaymentContext, payAct, skippedProposals, skipProposal, money, when, maskIban,
    PAYMENT_KINDS, PAYMENT_STATUS, ACCOUNT_PURPOSES
} from './buh-data.js';
import { validIban } from './nbu-qr.js';
import { toKop as kop } from './charges-core.js';

let ctx = { proposals: [], recipients: [], accounts: [] };
let formOpen = false;
let pendingFill = null;
let formMetadata = {};

/** Рахунок для списання за замовчуванням — поточний. */
export const defaultAccount = accounts => (accounts.find(a => a.purpose === 'current') || accounts[0])?.iban || '';

/** Пропозиції, які ще актуальні: не відкладені й не відправлені. */
export async function activeProposals() {
    const [context, payments] = await Promise.all([loadPaymentContext(), loadPayments()]);
    const skipped = skippedProposals();
    const sentKeys = new Set(payments.filter(p => ['sending', 'unknown', 'sent', 'paid'].includes(p.status)).map(p => p.proposalKey).filter(Boolean));
    return { context, list: context.proposals.filter(p => !skipped.has(p.proposalKey) && !sentKeys.has(p.proposalKey)) };
}

/** Відправити пропозицію в банк — і з «Платежів», і з «Вхідних». */
export async function sendProposal(p, account) {
    await payAct({ action: 'create', kind: 'supplier', recipient: p.recipient, amountKop: p.amountKop, purpose: p.purpose, account, proposalKey: p.proposalKey });
    toast(`${p.recipient.name}: платіж у Приват24 на підпис`, 'success');
}

function statusTag(p) {
    const [text, cls] = PAYMENT_STATUS[p.status] || [p.status, ''];
    return `<span class="buh-tag ${cls}">${escapeHtml(text)}</span>`;
}

function formHtml() {
    const accounts = ctx.accounts;
    return `<section class="buh-card pay-form" id="payForm">
        <div class="buh-card-head"><h2>Новий платіж</h2><button type="button" class="btn-ghost-small" data-act="close-form">Закрити</button></div>
        <div class="pay-grid">
            <label class="field pay-wide"><span class="field-label">Отримувач</span>
                <input id="pfName" class="field-input" list="pfRecipients" autocomplete="off" placeholder="Назва або почніть вводити — підставимо реквізити"></label>
            <datalist id="pfRecipients">${ctx.recipients.map(r => `<option value="${escapeHtml(r.name)}">${escapeHtml(maskIban(r.iban))}</option>`).join('')}</datalist>
            <label class="field"><span class="field-label">IBAN</span><input id="pfIban" class="field-input" autocomplete="off" placeholder="UA…"></label>
            <label class="field"><span class="field-label">ЄДРПОУ або РНОКПП</span><input id="pfCode" class="field-input" inputmode="numeric" maxlength="10"></label>
            <label class="field"><span class="field-label">Сума, грн</span><input id="pfAmount" class="field-input" inputmode="decimal" placeholder="0,00"></label>
            <label class="field"><span class="field-label">Вид</span><select id="pfKind" class="field-input field-select">${Object.entries(PAYMENT_KINDS).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></label>
            <label class="field pay-wide"><span class="field-label">Призначення</span><input id="pfPurpose" class="field-input" maxlength="420" placeholder="За що платимо, номер договору чи рахунку, період"></label>
            <label class="field"><span class="field-label">З рахунку</span><select id="pfAccount" class="field-input field-select">${accounts.map(a =>
                `<option value="${escapeHtml(a.iban)}"${a.iban === defaultAccount(accounts) ? ' selected' : ''}>${escapeHtml(ACCOUNT_PURPOSES[a.purpose] || 'Рахунок')} · ${escapeHtml(maskIban(a.iban))}${typeof a.balanceKop === 'number' ? ` · ${money(a.balanceKop)}` : ''}</option>`).join('')}</select></label>
        </div>
        <p class="buh-note" id="pfHint">Після «Відправити» платіж зʼявиться в Приват24 для бізнесу й чекатиме підпису КЕП голови. Без підпису гроші не рухаються.</p>
        <div class="pay-form-actions"><button type="button" class="btn-primary" data-act="submit">Відправити в банк на підпис<kbd>Enter</kbd></button></div>
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

export async function loadPaymentsView() {
    const [{ context, list }, payments] = await Promise.all([activeProposals(), loadPayments()]);
    ctx = context;
    const waiting = payments.filter(p => ['sent', 'sending', 'unknown'].includes(p.status));
    const failed = payments.filter(p => p.status === 'failed');
    const history = payments.filter(p => ['paid', 'canceled'].includes(p.status)).slice(0, 40);
    const total = waiting.reduce((s, p) => s + p.amountKop, 0);
    const account = defaultAccount(ctx.accounts);

    document.getElementById('viewPayments').innerHTML = `
        <div class="pay-top">
            <button type="button" class="btn-primary btn-compact" data-act="open-form">+ Новий платіж</button>
            ${waiting.length ? `<span class="pay-waiting">Незавершені платежі: <b>${waiting.length}</b> · ${money(total)}</span>` : ''}
        </div>
        ${formOpen ? formHtml() : ''}
        ${failed.length ? `<section class="buh-card is-alert"><div class="buh-card-head"><h2>Банк не прийняв</h2></div>
            ${failed.map(p => rowHtml(p, `<button type="button" class="btn-ghost-small" data-act="retry" data-id="${escapeHtml(p.id)}">Виправити й повторити</button>
                <button type="button" class="btn-ghost-small" data-act="cancel" data-id="${escapeHtml(p.id)}">Прибрати</button>`)).join('')}</section>` : ''}
        <section class="buh-card">
            <div class="buh-card-head"><h2>Пропозиції на цей місяць</h2><span>за історією регулярних платежів</span></div>
            ${list.length ? list.map(p => `<div class="pay-row" data-key="${escapeHtml(p.proposalKey)}">
                <span class="pay-main"><b>${escapeHtml(p.recipient.name)}</b><small>${escapeHtml(p.purpose)}</small>
                    <small class="t-muted">${p.months} міс. поспіль · зазвичай ${p.day}-го · ${escapeHtml(maskIban(p.recipient.iban))}</small></span>
                <span class="pay-sum">${money(p.amountKop)}</span>
                <span class="pay-actions">
                    <button type="button" class="btn-primary btn-compact" data-act="send-proposal"${account ? '' : ' disabled'}>Відправити</button>
                    <button type="button" class="btn-ghost-small" data-act="edit-proposal">Змінити</button>
                    <button type="button" class="btn-ghost-small" data-act="skip">Не цього місяця</button>
                </span></div>`).join('')
            : '<p class="list-empty">Регулярні платежі цього місяця вже відправлено або їх ще немає в історії</p>'}
        </section>
        <section class="buh-card">
            <div class="buh-card-head"><h2>Відправляються, перевіряються або чекають підпису</h2></div>
            ${waiting.length ? waiting.map(p => rowHtml(p, p.status === 'sent' ? `<button type="button" class="btn-ghost-small" data-act="cancel" data-id="${escapeHtml(p.id)}">Скасувати</button>` : '')).join('')
            : '<p class="list-empty">Нічого не чекає підпису</p>'}
        </section>
        <section class="buh-card">
            <div class="buh-card-head"><h2>Історія</h2></div>
            ${history.length ? history.map(p => rowHtml(p, '')).join('') : '<p class="list-empty">Платежів через застосунок ще не було</p>'}
        </section>`;
    afterRender();
}

function rowHtml(p, actions) {
    return `<div class="pay-row">
        <span class="pay-main"><b>${escapeHtml(p.recipient?.name || '')}</b><small>${escapeHtml(p.purpose || '')}</small>
            <small class="t-muted">${p.createdAt ? escapeHtml(when(p.createdAt)) : ''} · ${escapeHtml(PAYMENT_KINDS[p.kind] || '')}${p.error ? ` · ${escapeHtml(p.error)}` : ''}</small></span>
        <span class="pay-sum">${money(p.amountKop)}</span>
        <span class="pay-actions">${statusTag(p)}${actions}</span>
    </div>`;
}

function fill(p) {
    document.getElementById('pfName').value = p.recipient?.name || '';
    document.getElementById('pfIban').value = p.recipient?.iban || '';
    document.getElementById('pfCode').value = p.recipient?.code || '';
    document.getElementById('pfAmount').value = p.amountKop ? (p.amountKop / 100).toFixed(2).replace('.', ',') : '';
    document.getElementById('pfPurpose').value = p.purpose || '';
    if (p.kind) document.getElementById('pfKind').value = p.kind;
}

/** Відкрити форму (з «Вхідних» теж) — заповнену пропозицією чи невдалим платежем. */
export async function openForm(prefill) {
    if (prefill?.payroll) { location.hash = 'payroll'; toast('Повторіть відправку з відомості зарплати — суми залишаться затвердженими', 'info'); return; }
    formOpen = true;
    formMetadata = { proposalKey: prefill?.proposalKey || `manual:${crypto.randomUUID()}`, ...(prefill?.expenseId ? { expenseId: prefill.expenseId } : {}) };
    pendingFill = prefill || null;
    await loadPaymentsView();
}

function afterRender() {
    if (!formOpen) return;
    if (pendingFill) fill(pendingFill);
    document.getElementById(pendingFill ? 'pfAmount' : 'pfName')?.focus();
    document.getElementById('payForm')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    pendingFill = null;
}

async function submit(button) {
    const payload = readForm();
    const error = formError(payload);
    if (error) { toast(error, 'error'); return; }
    if (!await confirmDialog('Відправити платіж у банк?', `${payload.recipient.name}: ${money(payload.amountKop)}. У Приват24 він чекатиме підпису голови.`, 'Так, відправити')) return;
    setBusy(button, true, 'Відправляю…');
    try {
        await payAct(payload);
        formOpen = false;
        toast('Платіж у Приват24 — чекає підпису голови', 'success');
    } catch (e) { toast(e.message, 'error'); }
    finally { setBusy(button, false); }
}

export function initPaymentsView() {
    const host = document.getElementById('viewPayments');
    host.addEventListener('click', async e => {
        const btn = e.target.closest('[data-act]');
        if (!btn) return;
        const act = btn.dataset.act;
        const row = btn.closest('[data-key]');
        const proposal = row && ctx.proposals.find(p => p.proposalKey === row.dataset.key);
        if (act === 'open-form') openForm();
        else if (act === 'close-form') { formOpen = false; loadPaymentsView(); }
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
        if (e.key === 'Enter' && e.target.closest('#payForm') && e.target.matches('input')) { e.preventDefault(); submit(host.querySelector('[data-act="submit"]')); }
    });
}
