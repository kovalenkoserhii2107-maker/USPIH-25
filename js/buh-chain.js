// ============================================================
// Картка ланцюжка грошей: платіж, договір, операція банку — збоку на
// компʼютері, знизу на телефоні. З кожної картки можна перейти далі по
// ланцюжку (платіж → документ → договір → інші документи й платежі;
// операція банку → платіж чи документ → …) і повернутися «Назад».
// Розрахунки — chain-core.js.
// ============================================================
import { escapeHtml, toast, confirmDialog } from './ui.js';
import {
    loadPayment, loadTx, loadPayments, loadExpenses, payAct, money, signed, when, dateOnly, tagOf, maskIban,
    PAYMENT_KINDS, PAYMENT_STATUS, CONTRACT_STATUS
} from './buh-data.js';
import { fmtKop, periodName } from './charges-core.js';
import { paymentSteps, paymentLinks, docPayments, contractSummary, docLeft } from './chain-core.js';
import { openExpenses } from './buh-expenses.js';
import { openPayroll } from './buh-payroll.js';
import { openFlat } from './buh-flats.js';

let stack = [];                 // [{ kind: 'payment'|'tx'|'contract', id }]
const CHECK = '<svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="11" fill="currentColor"/><path d="M7.5 12.5l3 3 6-6" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const human = d => (d ? String(d).split('-').reverse().join('.') : '');
const grn = k => `${fmtKop(k)} грн`;
const EXP_STATUS = { pending: ['чекає голову', ''], approved: ['до оплати', 'is-work'], paid: ['оплачено', 'is-done'], rejected: ['відхилено', 'is-bad'], canceled: ['скасовано', 'is-locked'], linked: ['підтвердний', ''], storno: ['сторно', 'is-bad'] };
const chip = ([t, c]) => `<span class="sv-chip ${c}">${escapeHtml(t)}</span>`;
const payChip = p => { const [t, c] = PAYMENT_STATUS[p.status] || [p.status, '']; return chip([t, c === 'is-payment' ? 'is-done' : c === 'is-error' ? 'is-bad' : c === 'is-review' ? 'is-work' : '']); };

export const openPaymentSheet = id => push({ kind: 'payment', id });
export const openTxSheet = id => push({ kind: 'tx', id });
export const openContractSheet = id => push({ kind: 'contract', id });

function host() {
    let el = document.getElementById('chainSheet');
    if (el) return el;
    el = document.createElement('div');
    el.id = 'chainSheet';
    el.className = 'chs-wrap';
    el.hidden = true;
    document.body.appendChild(el);
    el.addEventListener('click', onClick);
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && !el.hidden && !document.querySelector('.confirm-overlay')) close(); });
    return el;
}

function push(item) {
    const el = host();
    if (el.hidden) stack = [];
    stack.push(item);
    render();
}

function close() {
    const el = host();
    el.hidden = true;
    el.innerHTML = '';
    stack = [];
    document.body.classList.remove('chs-open');
}

async function render() {
    const el = host();
    const top = stack.at(-1);
    el.hidden = false;
    document.body.classList.add('chs-open');
    const frame = (title, body) => `<div class="chs-backdrop" data-ch="close"></div>
        <aside class="chs-sheet" role="dialog" aria-modal="true" aria-label="${escapeHtml(title)}">
            <div class="chs-bar">${stack.length > 1 ? '<button type="button" class="chs-icon" data-ch="back" aria-label="Назад">‹</button>' : '<span></span>'}
                <span class="chs-bar-title">${escapeHtml(title)}</span>
                <button type="button" class="chs-icon" data-ch="close" aria-label="Закрити">×</button></div>
            <div class="chs-body">${body}</div>
        </aside>`;
    el.innerHTML = frame('Завантаження…', '<p class="py-note">Завантажую…</p>');
    try {
        const [title, body] = top.kind === 'payment' ? await paymentBody(top.id) : top.kind === 'tx' ? await txBody(top.id) : await contractBody(top.id);
        if (stack.at(-1) !== top) return;
        el.innerHTML = frame(title, body);
        el.querySelector('.chs-sheet')?.focus?.();
    } catch (e) {
        el.innerHTML = frame('Помилка', `<p class="py-note">${escapeHtml(e.message || 'Не вдалося завантажити')}</p>`);
    }
}

// ------------------------------------------------------------
// ВМІСТ КАРТОК
// ------------------------------------------------------------
const linkRow = (attrs, label, title, sub, right = '') => `<button type="button" class="chs-link" ${attrs}>
    <span class="chs-link-label">${escapeHtml(label)}</span>
    <span class="chs-link-main"><b>${escapeHtml(title)}</b>${sub ? `<small>${escapeHtml(sub)}</small>` : ''}</span>
    <span class="chs-link-right">${right}<span aria-hidden="true">›</span></span></button>`;

const docTitle = (e, ex) => `${ex?.docTypes?.[e.docType] || 'Документ'} № ${e.number} від ${human(e.date)}`;
const docRow = (e, ex, label = 'Документ') => linkRow(`data-ch="doc" data-id="${escapeHtml(e.id)}"`, label, docTitle(e, ex),
    `${e.supplierName || ''}${e.description ? ` · ${e.description}` : ''}`, `<b>${grn(e.amountKop - (e.stornoKop || 0))}</b>${chip(EXP_STATUS[e.status] || [e.status, ''])}`);
const contractRow = c => linkRow(`data-ch="contract" data-id="${escapeHtml(c.id)}"`, 'Договір', `№ ${c.number} від ${human(c.date)}`, `${c.supplierName || ''} · ${c.subject || ''}`);
const payRow = (p, label = 'Платіж') => linkRow(`data-ch="payment" data-id="${escapeHtml(p.id)}"`, label, p.recipient?.name || 'Платіж',
    `${p.createdAt ? when(p.createdAt) : ''}${p.purpose ? ` · ${p.purpose}` : ''}`, `<b>${grn(p.amountKop)}</b>${payChip(p)}`);
const txRow = (tx, label = 'Операція банку') => linkRow(`data-ch="tx" data-id="${escapeHtml(tx.id)}"`, label, `${dateOnly(tx.at)} · ${tx.counterparty?.name || ''}`,
    tx.purpose || '', `<b>${signed(tx)} грн</b>`);

function stepsHtml(steps) {
    return `<ol class="rp-steps chs-steps">${steps.map(s => `<li class="is-${s.state}"><span class="rp-dot" aria-hidden="true">${s.state === 'done' ? CHECK : ''}</span>
        <span class="rp-step"><b>${escapeHtml(s.title)}</b><small>${escapeHtml([s.at ? when(s.at) : '', s.note].filter(Boolean).join(' · '))}</small></span></li>`).join('')}</ol>`;
}

const fields = rows => `<dl class="dc-fields">${rows.filter(([, v]) => v).map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd>`).join('')}</dl>`;

async function paymentBody(id) {
    const [p, ex] = await Promise.all([loadPayment(id), loadExpenses().catch(() => null)]);
    if (!p) throw new Error('Платіж не знайдено');
    const { expense, contract } = paymentLinks(p, ex);
    const tx = p.txId ? await loadTx(p.txId).catch(() => null) : null;
    const others = expense ? docPayments(expense, await loadPayments().catch(() => [])).filter(x => x.id !== p.id) : [];
    const links = [
        expense ? docRow(expense, ex) : '',
        contract ? contractRow(contract) : '',
        tx ? txRow(tx, 'Списання у виписці') : '',
        p.payroll?.period ? linkRow(`data-ch="payroll" data-period="${escapeHtml(p.payroll.period)}"`, 'Зарплата', `Відомість за ${periodName(p.payroll.period)}`, p.payroll.stage === 'advance' ? 'аванс' : 'остаточний розрахунок') : '',
        ...others.map(x => payRow(x, 'Інший платіж за документом'))
    ].filter(Boolean);
    return [`Платіж · ${PAYMENT_KINDS[p.kind] || ''}`, `
        <div class="chs-head"><span class="bk-label">${escapeHtml(p.recipient?.name || '')}</span><b class="chs-sum">${grn(p.amountKop)}</b>${payChip(p)}</div>
        ${stepsHtml(paymentSteps(p))}
        <h3 class="chs-h">Реквізити</h3>
        ${fields([['Отримувач', p.recipient?.name], ['IBAN', p.recipient?.iban], ['ЄДРПОУ / РНОКПП', p.recipient?.code], ['Призначення', p.purpose],
            ['З рахунку ОСББ', maskIban(p.account || '')], ['Номер у банку', p.bankRef || p.docNumber || ''], ['Повернено банком', p.returnedKop ? grn(p.returnedKop) : '']])}
        <h3 class="chs-h">Повʼязано</h3>
        ${links.length ? `<div class="chs-links">${links.join('')}</div>` : '<p class="py-note">Платіж створено вручну — без документа витрат. Щоб звʼязати оплату з документом, створюйте платіж із картки документа.</p>'}
        ${p.status === 'sent' ? `<div class="chs-actions"><button type="button" class="sv-btn is-soft" data-ch="cancel" data-id="${escapeHtml(p.id)}">Скасувати платіж</button></div>` : ''}`];
}

async function txBody(id) {
    const [tx, ex] = await Promise.all([loadTx(id), loadExpenses().catch(() => null)]);
    if (!tx) throw new Error('Операцію не знайдено');
    const pay = tx.paymentId ? await loadPayment(tx.paymentId).catch(() => null) : null;
    const expense = tx.expenseId ? ex?.expenses?.find(e => e.id === tx.expenseId) : null;
    const contract = expense?.contractId ? ex?.contracts?.find(c => c.id === expense.contractId) : null;
    const tag = tagOf(tx);
    const links = [
        pay ? payRow(pay, 'Платіж із кабінету') : '',
        expense ? docRow(expense, ex) : '',
        contract ? contractRow(contract) : '',
        ...(tx.allocations || []).filter(a => a.apt).map(a => linkRow(`data-ch="flat" data-apt="${escapeHtml(a.apt)}"`, 'Квартира', `Квартира ${a.apt}`, 'оплату записано в історію квартири', `<b>${grn(a.amountKop)}</b>`))
    ].filter(Boolean);
    return [tx.direction === 'out' ? 'Списання' : 'Надходження', `
        <div class="chs-head"><span class="bk-label">${escapeHtml(tx.counterparty?.name || '—')}</span><b class="chs-sum${tx.direction === 'out' ? '' : ' is-in'}">${signed(tx)} грн</b>
            ${chip([tx.status === 'review' ? 'чекає рішення' : tag.text, tx.status === 'review' ? 'is-work' : 'is-done'])}</div>
        ${fields([['Дата', dateOnly(tx.at)], ['Контрагент', tx.counterparty?.name], ['Рахунок контрагента', tx.counterparty?.account], ['Код', tx.counterparty?.code],
            ['Призначення', tx.purpose], ['Рахунок ОСББ', maskIban(tx.account || '')]])}
        <h3 class="chs-h">Повʼязано</h3>
        ${links.length ? `<div class="chs-links">${links.join('')}</div>` : `<p class="py-note">${tx.status === 'review' ? 'Операцію ще не розібрано — зробіть це в «Рішеннях».' : 'Операцію рознесено без документа чи платежу.'}</p>`}
        ${tx.status === 'review' ? '<div class="chs-actions"><button type="button" class="sv-btn" data-ch="inbox">Розібрати в «Рішеннях»</button></div>' : ''}`];
}

async function contractBody(id) {
    const [ex, payments] = await Promise.all([loadExpenses(), loadPayments().catch(() => [])]);
    const c = ex.contracts.find(x => x.id === id);
    if (!c) throw new Error('Договір не знайдено');
    const s = contractSummary(c, ex, payments);
    const ids = new Set(s.docs.map(e => e.id));
    const pays = payments.filter(p => ids.has(p.expenseId));
    const files = (c.files || []).map(f => `<a class="chs-file" href="${escapeHtml(f.url)}" target="_blank" rel="noopener">${escapeHtml(f.name)}</a>`).join('');
    const tiles = [['За документами', s.billedKop], ['Сплачено', s.paidKop], ['На підписі в банку', s.inBankKop], ['Лишилось сплатити', s.dueKop],
        ...(s.capLeftKop !== null ? [['Лишилось від суми договору', s.capLeftKop]] : [])].filter(([, v], i) => i < 2 || v);
    return [`Договір № ${c.number}`, `
        <div class="chs-head"><span class="bk-label">${escapeHtml(c.supplierName || '')}</span><b class="chs-title">${escapeHtml(c.subject || '')}</b>${chip(((([t, cl]) => [t, cl === 'is-payment' ? 'is-done' : cl === 'is-error' ? 'is-bad' : 'is-work']))(CONTRACT_STATUS[c.status] || [c.status, '']))}</div>
        ${fields([['Номер і дата', `№ ${c.number} від ${human(c.date)}`], ['Сума', c.type === 'monthly' ? `${grn(c.monthlyKop)} на місяць` : grn(c.amountKop || 0)],
            ['Діє', `${human(c.validFrom)} — ${c.validTo ? human(c.validTo) : 'безстроково'}`], ['Погодження правління', c.boardDecision], ['Рішення зборів', c.meetingDecision]])}
        ${files ? `<div class="dc-files">${files}</div>` : ''}
        <div class="chs-tiles">${tiles.map(([k, v]) => `<div><span>${k}</span><b>${grn(v)}</b></div>`).join('')}</div>
        <h3 class="chs-h">Документи за договором${s.docs.length ? ` · ${s.docs.length}` : ''}</h3>
        ${s.months.length ? s.months.map(m => `<div class="chs-month"><span>${escapeHtml(periodName(m.period))}</span><b>${grn(m.kop)}</b></div>
            <div class="chs-links">${m.docs.map(e => docRow(e, ex, docLeft(e) && e.status === 'approved' ? `Документ · до сплати ${grn(docLeft(e))}` : 'Документ')).join('')}</div>`).join('')
            : '<p class="py-note">Документів за договором ще немає.</p>'}
        ${pays.length ? `<h3 class="chs-h">Платежі · ${pays.length}</h3><div class="chs-links">${pays.map(p => payRow(p)).join('')}</div>` : ''}`];
}

// ------------------------------------------------------------
// ПЕРЕХОДИ
// ------------------------------------------------------------
async function onClick(e) {
    const t = e.target.closest('[data-ch]');
    if (!t) return;
    const a = t.dataset.ch;
    if (a === 'close') { close(); return; }
    if (a === 'back') { stack.pop(); render(); return; }
    if (a === 'payment' || a === 'tx' || a === 'contract') { push({ kind: a, id: t.dataset.id }); return; }
    if (a === 'doc') { close(); openExpenses('docs', null, t.dataset.id); return; }
    if (a === 'payroll') { close(); openPayroll(t.dataset.period); return; }
    if (a === 'flat') { close(); location.hash = 'flats'; setTimeout(() => openFlat(t.dataset.apt), 0); return; }
    if (a === 'inbox') { close(); location.hash = 'inbox'; return; }
    if (a === 'cancel') {
        if (!await confirmDialog('Скасувати платіж?', 'Якщо голова ще не підписав, платіж буде видалено й у Приват24 (або видаліть його там вручну).', 'Скасувати платіж')) return;
        try { const r = await payAct({ action: 'cancel', id: t.dataset.id }); toast(r?.deletedInBank ? 'Скасовано й видалено в банку' : 'Скасовано. Перевірте, чи видалено його в Приват24', 'success'); render(); }
        catch (err) { toast(err.message, 'error'); }
    }
}
