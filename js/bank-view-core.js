// ============================================================
// «Банк»: операції за днями, відбори й швидке рішення в один дотик.
// Тут немає ні мережі, ні DOM: тести — tests/unit/bank-view-core.test.mjs.
// ============================================================

export const TABS = { all: 'Усі', review: 'Потрібне рішення', done: 'Розподілені' };

/** Впевненість підказки «чия це оплата» — та сама шкала, що в «Рішеннях». */
const SURE = { 'імʼя власника': true, 'прізвище власника': true };

const asDate = at => (at?.toDate ? at.toDate() : at instanceof Date ? at : new Date(at));
const dayKey = d => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;

/** «Сьогодні», «Учора» або «10 листопада» (рік — лише якщо не поточний). */
export function dayLabel(at, now = new Date()) {
    const d = asDate(at);
    const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
    if (dayKey(d) === dayKey(now)) return 'Сьогодні';
    if (dayKey(d) === dayKey(yesterday)) return 'Учора';
    return d.toLocaleDateString('uk-UA', { day: 'numeric', month: 'long', ...(d.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}) });
}

/** Операції, згруповані за днями (порядок — як у списку, від новіших). */
export function byDay(list, now = new Date()) {
    const out = [];
    for (const tx of list) {
        const label = dayLabel(tx.at, now);
        const last = out[out.length - 1];
        if (last?.label === label) last.rows.push(tx);
        else out.push({ label, rows: [tx] });
    }
    return out;
}

/**
 * Рішення в один дотик: надходження, для якого система знайшла рівно одну
 * квартиру. sure — підказка за іменем чи прізвищем власника («Так, кв. 7»),
 * інакше — питання («Це кв. 7?», з підтвердженням). Решта — у «Рішеннях».
 */
export function quickAssign(tx) {
    if (tx.status !== 'review' || tx.direction !== 'in' || tx.kind === 'income' || ['several', 'possible-refund'].includes(tx.reason) || tx.bankConflict || tx.bankVoided) return null;
    const s = tx.suggestions || [];
    if (s.length !== 1 || !s[0].apt) return null;
    return { apt: String(s[0].apt), sure: SURE[s[0].reason] === true };
}

/** Відбір і пошук: квартира («кв 12» або «12»), платник, призначення, сума. */
export function filterTx(list, tab = 'all', query = '') {
    const q = String(query).trim().toLowerCase();
    const apt = q.replace(/^кв\.?\s*/, '');
    return list.filter(tx => (tab === 'review' ? tx.status === 'review' || tx.bankConflict : tab === 'done' ? tx.status !== 'review' && !tx.bankConflict : true)
        && (!q || (tx.allocations || []).some(a => a.apt === apt)
            || String(tx.counterparty?.name || '').toLowerCase().includes(q)
            || String(tx.purpose || '').toLowerCase().includes(q)
            || String(tx.amountKop / 100).includes(q.replace(',', '.'))));
}
