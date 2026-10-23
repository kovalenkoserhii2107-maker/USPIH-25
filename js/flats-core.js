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

// ------------------------------------------------------------
// Будинок цілком: глибина боргу, підсумки, «шахматка», графік сальдо
// ------------------------------------------------------------

/** Глибина боргу в місячних внесках — для кольору плитки й діаграми. */
export const DEPTHS = {
    over: ['Переплата', 'is-over'], ok: ['Без боргу', 'is-ok'], m1: ['До 1 внеску', 'is-m1'], m3: ['1–3 внески', 'is-m3'],
    m6: ['3–6 внесків', 'is-m6'], m12: ['6–12 внесків', 'is-m12'], m12p: ['Понад рік', 'is-m12p']
};

export function depthOf(r) {
    if (r.balanceKop > 0) return 'over';
    if (!r.debtKop) return 'ok';
    // Ті самі округлені місяці, що й у списку («≈ 12 міс.»).
    const m = r.months || 0;
    if (m <= 1) return 'm1';
    if (m <= 3) return 'm3';
    if (m <= 6) return 'm6';
    if (m <= 12) return 'm12';
    return 'm12p';
}

/** Розподіл квартир за глибиною боргу: { ключ: { n, kop } }. */
export function depthBuckets(rows) {
    const out = Object.fromEntries(Object.keys(DEPTHS).map(k => [k, { n: 0, kop: 0 }]));
    for (const r of rows) {
        const b = out[depthOf(r)];
        b.n += 1;
        b.kop += r.balanceKop > 0 ? r.balanceKop : r.debtKop;
    }
    return out;
}

/** Підсумки будинку для карток угорі. */
export function houseKpis(rows) {
    const debtors = rows.filter(r => r.debtKop > 0);
    const long = rows.filter(r => r.months > 3);
    const over = rows.filter(r => r.balanceKop > 0);
    const monthly = rows.reduce((s, r) => s + r.monthlyKop, 0);
    return {
        total: rows.length, debtors: debtors.length, debtKop: debtors.reduce((s, r) => s + r.debtKop, 0),
        long: long.length, longKop: long.reduce((s, r) => s + r.debtKop, 0),
        over: over.length, overKop: over.reduce((s, r) => s + r.balanceKop, 0),
        monthlyKop: monthly, debtMonths: monthly ? Math.round(debtors.reduce((s, r) => s + r.debtKop, 0) / monthly * 10) / 10 : 0,
        claims: rows.filter(r => r.claimStep && !['start', 'closed'].includes(r.claimStep)).length,
        unverified: rows.filter(r => r.ownersStatus && r.ownersStatus !== 'confirmed').length
    };
}

/** Додаткові відбори: претензія в роботі, власників не звірено, глибина боргу, підʼїзд. */
export const MORE_FILTERS = { claims: 'Претензія в роботі', unverified: 'Власників не звірено' };

/**
 * Відбір для нового екрана: відбір (FILTERS, MORE_FILTERS або ключ DEPTHS),
 * підʼїзд, пошук і сортування ('apt' | 'debt' | 'months' | 'balance').
 */
export function selectFlats(rows, { filter = 'all', entrance = '', query = '', sort = 'apt' } = {}) {
    const q = String(query).trim().toLowerCase();
    const keep = DEPTHS[filter] ? r => depthOf(r) === filter
        : filter === 'claims' ? r => r.claimStep && !['start', 'closed'].includes(r.claimStep)
        : filter === 'unverified' ? r => r.ownersStatus && r.ownersStatus !== 'confirmed'
        : matches(FILTERS[filter] ? filter : 'all');
    let list = rows.filter(r => keep(r) && (!entrance || String(r.entrance) === String(entrance)));
    if (q) list = list.filter(r => (/^\d/.test(q) ? r.apt.toLowerCase().startsWith(q) || String(r.personalAccount).startsWith(q) : r.owner.toLowerCase().includes(q)));
    const by = { debt: (a, b) => b.debtKop - a.debtKop, months: (a, b) => b.months - a.months || b.debtKop - a.debtKop, balance: (a, b) => b.balanceKop - a.balanceKop }[sort];
    return [...list].sort((a, b) => (by ? by(a, b) : 0) || byApt(a, b));
}

/** Квартири за підʼїздами — для «шахматки» будинку. */
export function byEntrance(rows) {
    const map = new Map();
    for (const r of [...rows].sort(byApt)) {
        const key = String(r.entrance || '—');
        if (!map.has(key)) map.set(key, []);
        map.get(key).push(r);
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0], 'uk', { numeric: true }));
}

/**
 * Точки графіка сальдо (від старого до нового) для SVG-лінії:
 * { points: [{ x, y, balanceKop, at }], min, max }. width/height — розмір полотна.
 */
export function balanceSeries(history, width = 520, height = 120, pad = 8) {
    const asc = [...history].reverse();
    if (asc.length < 2) return { points: [], min: 0, max: 0 };
    const vals = asc.map(h => h.balanceKop);
    const min = Math.min(0, ...vals), max = Math.max(0, ...vals);
    const span = max - min || 1;
    const t0 = asc[0].at.getTime(), t1 = asc.at(-1).at.getTime(), dt = t1 - t0 || 1;
    const points = asc.map(h => ({ at: h.at, balanceKop: h.balanceKop,
        x: Math.round((pad + (h.at.getTime() - t0) / dt * (width - pad * 2)) * 10) / 10,
        y: Math.round((pad + (max - h.balanceKop) / span * (height - pad * 2)) * 10) / 10 }));
    return { points, min, max, zeroY: Math.round((pad + max / span * (height - pad * 2)) * 10) / 10 };
}
