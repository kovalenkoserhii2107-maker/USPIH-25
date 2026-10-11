// ============================================================
// «Зарплата»: підсумки місяця для карток зверху й стан виплати кожної
// людини. Тут немає ні мережі, ні DOM: тести —
// tests/unit/payroll-view-core.test.mjs.
//
// Платежі відомості мають ключ «етап:хто»: для людей — «advance:p1»,
// «final:p1», для податків — «final:pdfo», «final:vz», «final:esv».
// ============================================================

const TAXES = new Set(['pdfo', 'vz', 'esv']);
// Сервер повертає stage і key окремо; старі знімки містять «stage:key».
export const paymentWho = p => String(p.key || '').includes(':') ? String(p.key).split(':')[1] : String(p.key || '');
const whoOf = paymentWho;
const live = p => !['failed', 'canceled'].includes(p.status) && !(p.returnedKop >= p.amountKop && p.status === 'paid');

/** Ініціали для кружечка: «Іваненко Петро» → «ІП». */
export const initials = name => String(name || '').trim().split(/\s+/).slice(0, 2).map(w => w[0] || '').join('').toUpperCase() || '·';

/** Платежі однієї людини за відомістю. */
export const personPayments = (payments, personId) => payments.filter(p => whoOf(p) === personId);

/**
 * Стан людини в місяці: [текст, клас позначки].
 * Банк не прийняв → «не прийнято»; усе проведено → «виплачено»; є на
 * підписі → «на підписі»; далі — за станом відомості.
 */
export function personState({ status, payments = [], closed = false }, personId, inRun = true) {
    if (!inRun) return ['не в цьому місяці', 'is-locked'];
    const mine = personPayments(payments, personId);
    if (mine.some(p => p.status === 'failed' || (p.returnedKop && !p.repaid))) return ['банк не прийняв', 'is-bad'];
    if (mine.some(p => ['sent', 'sending', 'unknown'].includes(p.status))) return ['на підписі', 'is-work'];
    if (mine.length && mine.every(p => p.status === 'paid' || p.status === 'canceled') && mine.some(p => p.status === 'paid')) {
        return [mine.some(p => p.stage === 'final' || p.key?.startsWith('final:')) ? 'виплачено' : 'аванс виплачено', 'is-done'];
    }
    if (closed) return ['місяць закрито', 'is-locked'];
    if (status === 'approved') return ['до виплати', 'is-work'];
    if (status === 'draft') return ['чекає голову', ''];
    return ['не складено', ''];
}

/** Підсумки для карток: людям і податки — скільки всього, скільки проведено, скільки на підписі. */
export function payrollTotals({ run, payments = [] }) {
    const t = run?.totals || {};
    const sum = list => list.reduce((s, p) => s + (p.amountKop || 0) - (p.status === 'paid' ? p.returnedKop || 0 : 0), 0);
    const toPeople = payments.filter(p => whoOf(p) && !TAXES.has(whoOf(p)) && live(p));
    const toTax = payments.filter(p => TAXES.has(whoOf(p)) && live(p));
    const rows = run?.rows || [];
    return {
        employees: rows.filter(r => r.kind !== 'gph').length,
        contractors: rows.filter(r => r.kind === 'gph').length,
        grossKop: t.grossKop || 0,
        netKop: t.netKop || 0,
        taxKop: (t.pdfoKop || 0) + (t.vzKop || 0) + (t.esvKop || 0),
        netPaidKop: sum(toPeople.filter(p => p.status === 'paid')),
        netSigningKop: sum(toPeople.filter(p => p.status !== 'paid')),
        taxPaidKop: sum(toTax.filter(p => p.status === 'paid')),
        taxSigningKop: sum(toTax.filter(p => p.status !== 'paid'))
    };
}
