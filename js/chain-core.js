// ============================================================
// Ланцюжок грошей: договір → документи → платежі → операції банку.
// Тут немає ні мережі, ні DOM: тести — tests/unit/chain-core.test.mjs.
//
// Звʼязки зберігає сервер: платіж — expenseId і txId (коли виписка
// знайшла списання), операція банку — paymentId і expenseId, документ —
// contractId і txIds.
// ============================================================

const ms = v => (v?.toMillis ? v.toMillis() : v instanceof Date ? v.getTime() : v ? Date.parse(v) || 0 : 0);
const LIVE = ['sending', 'unknown', 'sent', 'paid'];

/** Залишок до сплати за документом. */
export const docLeft = e => Math.max(0, e.amountKop - (e.stornoKop || 0) - (e.paidKop || 0));

/**
 * Шлях платежу: [{ key, title, at, state: done|current|next|bad, note }].
 * Створено → у Приват24 на підписі голови → проведено банком.
 */
export function paymentSteps(p) {
    const failed = p.status === 'failed', canceled = p.status === 'canceled', unknown = p.status === 'unknown';
    const sent = Boolean(p.sentAt) || ['sent', 'paid'].includes(p.status);
    const paid = p.status === 'paid';
    const steps = [
        { key: 'created', title: 'Створено в кабінеті', at: p.createdAt || null, state: 'done', note: '' },
        { key: 'sent', title: 'У Приват24 на підписі голови', at: p.sentAt || null,
            state: sent ? 'done' : failed || unknown ? 'bad' : canceled ? 'next' : 'current',
            note: failed ? `банк не прийняв${p.error ? `: ${p.error}` : ''}` : unknown ? 'банк не підтвердив — перевірте у Приват24' : p.bankRef ? `номер у банку ${p.bankRef}` : '' },
        { key: 'paid', title: 'Підписано й проведено банком', at: p.paidAt || null,
            state: paid ? 'done' : canceled ? 'bad' : sent ? 'current' : 'next',
            note: canceled ? 'платіж скасовано' : paid ? (p.returnedKop ? 'банк повернув кошти' : 'списання знайдено у виписці') : sent ? 'чекаємо підпису КЕП і виписку' : '' }
    ];
    return steps;
}

/** Документ, договір і постачальник платежу (з контексту «Документів»). */
export function paymentLinks(p, ex) {
    const expense = p.expenseId ? ex?.expenses?.find(e => e.id === p.expenseId) || null : null;
    const contract = expense?.contractId ? ex?.contracts?.find(c => c.id === expense.contractId) || null : null;
    const supplier = expense ? ex?.suppliers?.find(s => s.id === expense.supplierId) || null : null;
    return { expense, contract, supplier };
}

/** Платежі за документом — від новіших. */
export const docPayments = (e, payments) => payments.filter(p => p.expenseId === e.id).sort((a, b) => ms(b.createdAt) - ms(a.createdAt));

/**
 * Підсумок договору: документи (без скасованих і підтвердних), сума за
 * документами, сплачено, залишок до сплати; для разового — скільки ще
 * лишилось від суми договору; для щомісячного — документи за місяцями.
 */
export function contractSummary(c, ex, payments = []) {
    const docs = (ex?.expenses || []).filter(e => e.contractId === c.id && !['canceled', 'linked', 'rejected'].includes(e.status))
        .sort((a, b) => String(b.date).localeCompare(String(a.date)));
    const billedKop = docs.reduce((s, e) => s + e.amountKop - (e.stornoKop || 0), 0);
    const paidKop = docs.reduce((s, e) => s + (e.paidKop || 0), 0);
    const ids = new Set(docs.map(e => e.id));
    const inBankKop = payments.filter(p => ids.has(p.expenseId) && ['sending', 'unknown', 'sent'].includes(p.status)).reduce((s, p) => s + p.amountKop, 0);
    const months = new Map();
    for (const e of docs) months.set(e.period, [...(months.get(e.period) || []), e]);
    return {
        docs, billedKop, paidKop, inBankKop, dueKop: Math.max(0, billedKop - paidKop),
        capKop: c.type === 'monthly' ? null : c.amountKop || null,
        capLeftKop: c.type === 'monthly' || !c.amountKop ? null : Math.max(0, c.amountKop - billedKop),
        months: [...months.entries()].sort((a, b) => b[0].localeCompare(a[0])).map(([period, list]) => ({ period, docs: list, kop: list.reduce((s, e) => s + e.amountKop - (e.stornoKop || 0), 0) }))
    };
}

/** Чи є в платежу хоч якийсь живий звʼязок (для підказки «без документа»). */
export const isLive = p => LIVE.includes(p.status);
