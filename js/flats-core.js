// ============================================================
// «Квартири»: список з боргами й переплатами, пошук, історія квартири
// з сальдо після кожного запису й акт звірки. Тут немає ні мережі, ні
// DOM: тести — tests/unit/flats-core.test.mjs.
//
// Знак балансу як у всьому застосунку: мінус — борг, плюс — переплата.
// Записи історії (apartments/{кв}/ledger): charge — нараховано, payment
// — сплачено, refund — повернуто переплату, opening — вхідний залишок
// (мінус — борг), сума завжди в гривнях.
// ============================================================

export const FILTERS = { debt: 'З боргом', long: 'Понад 3 місяці', over: 'Переплата', all: 'Усі' };
export const KINDS = { charge: 'Нараховано', payment: 'Оплата', refund: 'Повернення переплати', opening: 'Вхідний залишок' };

const kop = grn => Math.round((Number(grn) || 0) * 100);
const byApt = (a, b) => String(a.apt).localeCompare(String(b.apt), 'uk', { numeric: true });

/**
 * Рядки списку. apartments — з контексту нарахувань ({ apt, area, balance,
 * personalAccount }), monthly — Map(кв → внесок за місяць у копійках),
 * owners — Map(кв → імʼя першого власника).
 * months — скільки місячних внесків становить борг (оцінка для списку;
 * точна дата останньої оплати — у картці квартири).
 */
export function flatRows({ apartments = [], monthly = new Map(), owners = new Map() }) {
    return apartments.map(a => {
        const balanceKop = kop(a.balance);
        const monthlyKop = monthly.get(String(a.apt)) || 0;
        const debtKop = balanceKop < 0 ? -balanceKop : 0;
        const months = debtKop && monthlyKop ? Math.max(1, Math.round(debtKop / monthlyKop)) : 0;
        return { apt: String(a.apt), area: a.area || null, personalAccount: a.personalAccount || '', owner: owners.get(String(a.apt)) || '',
            balanceKop, debtKop, monthlyKop, months };
    }).sort(byApt);
}

const matches = filter => r => (filter === 'debt' ? r.debtKop > 0 : filter === 'long' ? r.months > 3 : filter === 'over' ? r.balanceKop > 0 : true);

/** Скільки квартир у кожному відборі. */
export function flatCounts(rows) {
    return Object.fromEntries(Object.keys(FILTERS).map(k => [k, rows.filter(matches(k)).length]));
}

/**
 * Відбір і пошук: цифри — номер квартири (з початку), інакше — імʼя
 * власника. Боржники — від найбільшого боргу, решта — за номером.
 */
export function filterFlats(rows, filter = 'debt', query = '') {
    const q = String(query).trim().toLowerCase();
    let list = rows.filter(matches(FILTERS[filter] ? filter : 'all'));
    if (q) list = rows.filter(r => (/^\d/.test(q) ? r.apt.toLowerCase().startsWith(q) : r.owner.toLowerCase().includes(q)));
    if (!q && (filter === 'debt' || filter === 'long')) list = [...list].sort((a, b) => b.debtKop - a.debtKop || byApt(a, b));
    return list;
}

/**
 * Історія з сальдо після кожного запису — від найновішого.
 * entries — записи ledger ({ kind, amount, at: Date, note, period }).
 */
export function ledgerRows(entries = []) {
    const asc = [...entries].filter(e => KINDS[e.kind] && e.at).sort((a, b) => a.at - b.at);
    let balance = 0;
    const out = asc.map(e => {
        const amount = kop(e.amount);
        if (e.kind === 'opening') balance = amount;
        else if (e.kind === 'payment') balance += amount;
        else balance -= amount;
        const signed = e.kind === 'payment' ? amount : e.kind === 'opening' ? amount : -amount;
        return { at: e.at, kind: e.kind, label: KINDS[e.kind], signedKop: signed, balanceKop: balance, note: e.note || '', period: e.period || '' };
    });
    return out.reverse();
}

/** Остання оплата (дата й сума) або null. */
export function lastPayment(entries = []) {
    const pays = entries.filter(e => e.kind === 'payment' && e.at).sort((a, b) => b.at - a.at);
    return pays.length ? { at: pays[0].at, amountKop: kop(pays[0].amount) } : null;
}

const day = d => `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${d.getFullYear()}`;
const money = k => (k / 100).toFixed(2).replace('.', ',');
const cell = v => (/[;"\r\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));

/** Акт звірки квартири: CSV для Excel (крапка з комою, BOM). */
export function reconciliationCsv(apt, rows) {
    const lines = [['Квартира', apt], [], ['Дата', 'Операція', 'Нараховано', 'Сплачено', 'Сальдо (мінус — борг)', 'Примітка']];
    for (const r of [...rows].reverse()) {
        const charged = r.kind === 'charge' || r.kind === 'refund' ? money(-r.signedKop) : '';
        const paid = r.kind === 'payment' ? money(r.signedKop) : '';
        lines.push([day(r.at), r.label, charged, paid, money(r.balanceKop), r.note]);
    }
    return `﻿${lines.map(l => l.map(cell).join(';')).join('\r\n')}`;
}
