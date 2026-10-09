'use strict';
// ============================================================
// Нарахування внесків: тарифи за м², щомісячне нарахування й баланс
// квартири з історії.
//
// Тут немає ні мережі, ні бази — лише розрахунки, які перевіряють
// тести (functions/charges-core.test.js).
//
// ЯК РАХУЄМО
//   • Внесок = площа × тариф групи приміщень (квартири, нежитлові…),
//     чинний у цьому місяці. Тариф діє з місяця `from`, доки не
//     зʼявиться новіший для тієї самої групи.
//   • Площа — у сотих м², тариф — у десятитисячних гривні, сума — у
//     копійках: усе цілими числами, округлення одне й у кінці.
//   • Баланс = вхідний залишок на 30.09.2026 + оплати − нарахування від
//     жовтня 2026. Від'ємний — борг, додатний — переплата (як у банку).
//     Записи історії до початку обліку в баланс не входять: вони вже
//     враховані у вхідному залишку.
// ============================================================

const START_PERIOD = '2026-10';
const OPENING_PERIOD = '2026-09';
const OPENING_ID = 'opening';

const DEFAULT_GROUPS = [
    { id: 'res', name: 'Квартири' },
    { id: 'nonres', name: 'Нежитлові приміщення' }
];

const MONTHS = ['січень', 'лютий', 'березень', 'квітень', 'травень', 'червень',
    'липень', 'серпень', 'вересень', 'жовтень', 'листопад', 'грудень'];

// ------------------------------------------------------------
// ЧИСЛА
// ------------------------------------------------------------
/** Десятковий рядок або число → ціле в 1/scale одиницях; null, якщо це не число. */
function scaled(value, digits) {
    if (value === null || value === undefined || value === '') return null;
    const text = String(value).replace(/\s+/g, '').replace(',', '.');
    if (!/^\d+(\.\d+)?$/.test(text)) return null;
    const [whole, frac = ''] = text.split('.');
    if (frac.length > digits && /[1-9]/.test(frac.slice(digits))) return null;
    return Number(whole) * 10 ** digits + Number((frac + '0'.repeat(digits)).slice(0, digits));
}

/** Площа «72,4» → 7240 (сотих м²). null — площі немає або вона дивна. */
function parseArea(value) {
    const v = scaled(value, 2);
    return v && v > 0 && v < 10_000_000 ? v : null;
}

/** Тариф «8,50» грн/м² → 85000 (десятитисячних гривні). */
function parseRate(value) {
    const v = scaled(value, 4);
    return v && v > 0 && v < 10_000_000 ? v : null;
}

/** 85000 → «8,50», 83750 → «8,375». */
function formatRate(rate4) {
    const text = (rate4 / 10000).toFixed(4).replace(/0{1,2}$/, '');
    return text.replace('.', ',');
}

/** 7240 → «72,4». */
const formatArea = centi => String(centi / 100).replace('.', ',');

/** Внесок у копійках: площа (соті м²) × тариф (1/10000 грн). */
const chargeKop = (areaCenti, rate4) => Math.round(areaCenti * rate4 / 10000);

/** Сума запису історії в копійках: нові записи мають amountKop, старі — лише amount у гривнях. */
function entryKop(e) {
    if (Number.isInteger(e?.amountKop)) return e.amountKop;
    const n = Number(e?.amount);
    return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

// ------------------------------------------------------------
// ПЕРІОДИ
// ------------------------------------------------------------
const validPeriod = p => /^\d{4}-(0[1-9]|1[0-2])$/.test(String(p || ''));

function shiftPeriod(p, months) {
    const [y, m] = p.split('-').map(Number);
    const total = y * 12 + (m - 1) + months;
    return `${Math.floor(total / 12)}-${String(total % 12 + 1).padStart(2, '0')}`;
}

/** Поточний місяць за київським часом. */
function currentPeriod(now = new Date()) {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Kyiv', year: 'numeric', month: '2-digit' }).formatToParts(now);
    const get = type => parts.find(x => x.type === type).value;
    return `${get('year')}-${get('month')}`;
}

/** «2026-10» → «жовтень 2026». */
function periodName(p) {
    const [y, m] = String(p).split('-').map(Number);
    return MONTHS[m - 1] ? `${MONTHS[m - 1]} ${y}` : String(p);
}

/** Дата за київським часом → Date (UTC). */
function kyivDate(y, m, d, hh = 0, mi = 0) {
    const guess = Date.UTC(y, m - 1, d, hh, mi);
    const kyiv = new Date(new Date(guess).toLocaleString('en-US', { timeZone: 'Europe/Kyiv' }));
    const utc = new Date(new Date(guess).toLocaleString('en-US', { timeZone: 'UTC' }));
    return new Date(guess - (kyiv - utc));
}

/**
 * Дата нарахування — перше число місяця, полудень за Києвом: так
 * дата однакова в будь-якому часовому поясі телефона мешканця.
 */
function chargeDate(period) {
    const [y, m] = period.split('-').map(Number);
    return kyivDate(y, m, 1, 12);
}

/** Вхідний залишок — 30.09.2026: раніше за будь-яке нарахування. */
const openingDate = () => kyivDate(2026, 9, 30, 12);

/** Місяці, за які ще не нараховано: від початку обліку до поточного включно. */
function duePeriods({ startPeriod = START_PERIOD, current, done }) {
    const out = [];
    for (let p = startPeriod; p <= current && out.length < 36; p = shiftPeriod(p, 1)) {
        if (!done.has(p)) out.push(p);
    }
    return out;
}

// ------------------------------------------------------------
// ТАРИФИ
// ------------------------------------------------------------
/** Тариф групи, чинний у місяці: найновіший з `from` ≤ місяця. */
function tariffFor(tariffs, group, period) {
    return (tariffs || [])
        .filter(t => t.group === group && t.from <= period)
        .sort((a, b) => (a.from < b.from ? 1 : a.from > b.from ? -1 : 0))[0] || null;
}

/** Перевірка нового тарифу. Повертає текст помилки українською або null. */
function checkTariff(t, groups, tariffs = []) {
    if (!(groups || []).some(g => g.id === t.group)) return 'Невідома група приміщень';
    if (!Number.isInteger(t.rate4) || t.rate4 <= 0) return 'Вкажіть тариф більший за нуль, до 4 знаків після коми';
    if (t.rate4 > 1_000_000) return 'Тариф понад 100 грн за м² — перевірте число';
    if (!validPeriod(t.from)) return 'Вкажіть місяць, з якого діє тариф';
    if (t.from < '2020-01') return 'Занадто ранній місяць';
    const decision = String(t.decision || '').trim();
    if (decision.length < 3) return 'Вкажіть рішення, яким затверджено тариф (протокол зборів, кошторис)';
    if (decision.length > 200) return 'Опис рішення задовгий (до 200 символів)';
    if ((tariffs || []).some(x => x.group === t.group && x.from === t.from)) return 'Для цієї групи вже є тариф з цього місяця';
    return null;
}

function checkGroupName(name, groups) {
    const n = String(name || '').trim();
    if (n.length < 2 || n.length > 60) return 'Назва групи — від 2 до 60 символів';
    if ((groups || []).some(g => g.name.toLowerCase() === n.toLowerCase())) return 'Така група вже є';
    return null;
}

// ------------------------------------------------------------
// НАРАХУВАННЯ
// ------------------------------------------------------------
/**
 * Нарахування за місяць по всіх приміщеннях.
 * apartments: [{ apt, area }] (службові записи вже прибрано)
 * premises: { [apt]: groupId } — без запису приміщення вважається квартирою.
 * Повертає { rows: [{ apt, group, areaCenti, rate4, tariffId, amountKop }],
 *            problems: [{ apt, reason }], totalKop }.
 */
function computeCharges({ apartments, premises = {}, tariffs, groups = DEFAULT_GROUPS, period }) {
    const rows = [], problems = [];
    const names = new Map(groups.map(g => [g.id, g.name]));
    for (const a of apartments) {
        const group = names.has(premises[a.apt]) ? premises[a.apt] : 'res';
        const areaCenti = parseArea(a.area);
        if (!areaCenti) { problems.push({ apt: a.apt, reason: 'немає площі' }); continue; }
        const tariff = tariffFor(tariffs, group, period);
        if (!tariff) { problems.push({ apt: a.apt, reason: `немає тарифу «${names.get(group)}»` }); continue; }
        rows.push({ apt: a.apt, group, areaCenti, rate4: tariff.rate4, tariffId: tariff.id || null, amountKop: chargeKop(areaCenti, tariff.rate4) });
    }
    const byApt = (x, y) => String(x.apt).localeCompare(String(y.apt), 'uk', { numeric: true });
    rows.sort(byApt);
    problems.sort(byApt);
    return { rows, problems, totalKop: rows.reduce((s, r) => s + r.amountKop, 0) };
}

/** Примітка запису в історії: мешканець бачить, з чого склалася сума. */
const chargeNote = (row, period) =>
    `Внесок за ${periodName(period)}: ${formatArea(row.areaCenti)} м² × ${formatRate(row.rate4)} грн`;

// ------------------------------------------------------------
// ВХІДНІ ЗАЛИШКИ
// ------------------------------------------------------------
/**
 * Перевірка вхідних залишків: квартира існує, сума ціла в копійках,
 * квартира не повторюється. Нуль дозволено (розраховано повністю).
 */
function checkOpening(rows, knownApts) {
    if (!Array.isArray(rows) || !rows.length) return 'Немає жодного рядка';
    if (rows.length > 2000) return 'Забагато рядків';
    const seen = new Set();
    for (const r of rows) {
        if (!knownApts.has(r.apt)) return `Квартири ${r.apt} немає в довіднику`;
        if (seen.has(r.apt)) return `Квартира ${r.apt} вказана двічі`;
        if (!Number.isInteger(r.amountKop) || Math.abs(r.amountKop) > 100_000_000) return `Квартира ${r.apt}: незрозуміла сума`;
        seen.add(r.apt);
    }
    return null;
}

const openingNote = kop => kop < 0 ? 'Борг на 30.09.2026 (вхідний залишок)'
    : kop > 0 ? 'Переплата на 30.09.2026 (вхідний залишок)' : 'Розраховано на 30.09.2026';

// ------------------------------------------------------------
// БАЛАНС І ВІДОМІСТЬ
// ------------------------------------------------------------
/** Баланс квартири з її історії, у копійках. */
function balanceFromLedger(entries, startPeriod = START_PERIOD) {
    let kop = 0;
    for (const e of entries) {
        if (e.kind === 'opening') kop += entryKop(e);
        else if (String(e.period || '') < startPeriod) continue;
        else if (e.kind === 'charge') kop -= entryKop(e);
        else if (e.kind === 'payment') kop += entryKop(e);
    }
    return kop;
}

/**
 * Відомість розрахунків з мешканцями за місяць: залишок на початок,
 * нараховано, сплачено, залишок на кінець — по кожній квартирі.
 * ledgers: Map<apt, entries[]>.
 */
function statement(ledgers, period, startPeriod = START_PERIOD) {
    const rows = [];
    for (const [apt, entries] of ledgers) {
        const before = entries.filter(e => e.kind === 'opening' || String(e.period || '') < period);
        const during = entries.filter(e => e.kind !== 'opening' && e.period === period && period >= startPeriod);
        const opening = balanceFromLedger(before, startPeriod);
        const charged = during.filter(e => e.kind === 'charge').reduce((s, e) => s + entryKop(e), 0);
        const paid = during.filter(e => e.kind === 'payment').reduce((s, e) => s + entryKop(e), 0);
        rows.push({ apt, opening, charged, paid, closing: opening - charged + paid });
    }
    rows.sort((a, b) => String(a.apt).localeCompare(String(b.apt), 'uk', { numeric: true }));
    const sum = key => rows.reduce((s, r) => s + r[key], 0);
    return {
        rows,
        totals: { opening: sum('opening'), charged: sum('charged'), paid: sum('paid'), closing: sum('closing'),
            debt: rows.reduce((s, r) => s + Math.min(0, r.closing), 0), debtors: rows.filter(r => r.closing < 0).length }
    };
}

module.exports = {
    START_PERIOD, OPENING_PERIOD, OPENING_ID, DEFAULT_GROUPS,
    parseArea, parseRate, formatRate, formatArea, chargeKop, entryKop,
    validPeriod, shiftPeriod, currentPeriod, periodName, kyivDate, chargeDate, openingDate, duePeriods,
    tariffFor, checkTariff, checkGroupName, computeCharges, chargeNote,
    checkOpening, openingNote, balanceFromLedger, statement
};
