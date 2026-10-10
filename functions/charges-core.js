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

/**
 * Складові внеску: «Утримання будинку» за м² — обовʼязкова; інші
 * (освітлення МЗК, ліфти, вивезення ТПВ…) — за м² або фіксовано з
 * приміщення. Складова без тарифу для групи цій групі не нараховується
 * (напр. ліфти — нежитловим на першому поверсі). item — стаття
 * кошторису, яку складова фінансує.
 */
const DEFAULT_COMPONENTS = [{ id: 'main', name: 'Утримання будинку', base: 'area', item: 'other' }];
const BASES = { area: 'за м²', fixed: 'з приміщення', residents: 'з проживаючого' };

/** Кількість проживаючих: ціле від 0 (порожня квартира) до 30; null — не внесено. */
function parseResidents(value) {
    if (value === null || value === undefined || value === '') return null;
    const n = Number(value);
    return Number.isInteger(n) && n >= 0 && n <= 30 ? n : null;
}

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

/** Останній день місяця: 2026-02 → 28. */
const lastDay = period => { const [y, m] = period.split('-').map(Number); return new Date(Date.UTC(y, m, 0)).getUTCDate(); };

/**
 * Дата нарахування — останній день місяця (як у сервісі бухгалтера:
 * «Нарахування від 30.09.2026 за вересень»), полудень за Києвом: так
 * дата однакова в будь-якому часовому поясі телефона мешканця.
 */
function chargeDate(period) {
    const [y, m] = period.split('-').map(Number);
    return kyivDate(y, m, lastDay(period), 12);
}

/** Вхідний залишок — 30.09.2026: раніше за будь-яке нарахування. */
const openingDate = () => kyivDate(2026, 9, 30, 12);

/** Місяці, за які ще не нараховано: від початку обліку до поточного включно. */
/**
 * Місяці, за які пора нараховувати: минулі ще не нараховані, а поточний —
 * з його останнього дня (today — «РРРР-ММ-ДД» за Києвом).
 */
function duePeriods({ startPeriod = START_PERIOD, current, done, today }) {
    const out = [];
    const endOfMonth = today && Number(today.slice(8, 10)) >= lastDay(current);
    for (let p = startPeriod; (p < current || (p === current && (endOfMonth || !today))) && out.length < 36; p = shiftPeriod(p, 1)) {
        if (!done.has(p)) out.push(p);
    }
    return out;
}

// ------------------------------------------------------------
// ТАРИФИ
// ------------------------------------------------------------
/** Тариф групи (і складової), чинний у місяці: найновіший з `from` ≤ місяця. */
function tariffFor(tariffs, group, period, component = 'main') {
    return (tariffs || [])
        .filter(t => t.group === group && (t.component || 'main') === component && t.from <= period)
        .sort((a, b) => (a.from < b.from ? 1 : a.from > b.from ? -1 : 0))[0] || null;
}

/** Перевірка нового тарифу. Повертає текст помилки українською або null. */
function checkTariff(t, groups, tariffs = []) {
    if (!(groups || []).some(g => g.id === t.group)) return 'Невідома група приміщень';
    if (!Number.isInteger(t.rate4) || t.rate4 <= 0) return 'Вкажіть тариф більший за нуль, до 4 знаків після коми';
    if (t.base !== 'fixed' && t.rate4 > 1_000_000) return 'Тариф понад 100 грн за м² — перевірте число';
    if (t.base === 'fixed' && t.rate4 > 100_000_000) return 'Понад 10 000 грн з приміщення — перевірте число';
    if (t.base === 'residents' && t.rate4 > 10_000_000) return 'Понад 1 000 грн з проживаючого — перевірте число';
    if (!validPeriod(t.from)) return 'Вкажіть місяць, з якого діє тариф';
    if (t.from < '2020-01') return 'Занадто ранній місяць';
    const decision = String(t.decision || '').trim();
    if (decision.length < 3) return 'Вкажіть рішення, яким затверджено тариф (протокол зборів, кошторис)';
    if (decision.length > 200) return 'Опис рішення задовгий (до 200 символів)';
    if ((tariffs || []).some(x => x.group === t.group && (x.component || 'main') === (t.component || 'main') && x.from === t.from)) return 'Для цієї групи й складової вже є тариф з цього місяця';
    return null;
}

function checkComponent(c, components) {
    const n = String(c.name || '').trim();
    if (n.length < 2 || n.length > 60) return 'Назва складової — від 2 до 60 символів';
    if (!BASES[c.base]) return 'Оберіть, як рахувати: за м² чи з приміщення';
    if ((components || []).some(x => x.name.toLowerCase() === n.toLowerCase())) return 'Така складова вже є';
    return null;
}

/** Сума складової: за м² — площа × тариф; з приміщення — сам тариф (у 1/10000 грн). */
const partKop = (base, areaCenti, rate4, residents = 0) => (base === 'fixed' ? Math.round(rate4 / 100)
    : base === 'residents' ? Math.round(residents * rate4 / 100) : chargeKop(areaCenti, rate4));

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
function computeCharges({ apartments, premises = {}, tariffs, groups = DEFAULT_GROUPS, components = DEFAULT_COMPONENTS, period }) {
    const rows = [], problems = [];
    const names = new Map(groups.map(g => [g.id, g.name]));
    const comps = components?.length ? components : DEFAULT_COMPONENTS;
    for (const a of apartments) {
        const group = names.has(premises[a.apt]) ? premises[a.apt] : 'res';
        const areaCenti = parseArea(a.area);
        const main = tariffFor(tariffs, group, period, 'main');
        if (!main) { problems.push({ apt: a.apt, reason: `немає тарифу «${names.get(group)}»` }); continue; }
        const residents = parseResidents(a.residents);
        const parts = [];
        let missing = null;
        for (const c of comps) {
            const t = c.id === 'main' ? main : tariffFor(tariffs, group, period, c.id);
            if (!t) continue;
            if (c.base === 'area' && !areaCenti) { missing = 'немає площі'; break; }
            if (c.base === 'residents' && residents === null) { missing = 'не внесено кількість проживаючих'; break; }
            parts.push({ component: c.id, name: c.name, base: c.base, rate4: t.rate4, tariffId: t.id || null,
                ...(c.base === 'residents' ? { residents } : {}), amountKop: partKop(c.base, areaCenti, t.rate4, residents) });
        }
        if (missing) { problems.push({ apt: a.apt, reason: missing }); continue; }
        rows.push({ apt: a.apt, group, areaCenti, residents, rate4: main.rate4, tariffId: main.id || null, parts,
            amountKop: parts.reduce((s, p) => s + p.amountKop, 0) });
    }
    const byApt = (x, y) => String(x.apt).localeCompare(String(y.apt), 'uk', { numeric: true });
    rows.sort(byApt);
    problems.sort(byApt);
    return { rows, problems, totalKop: rows.reduce((s, r) => s + r.amountKop, 0) };
}

/** Примітка запису в історії: мешканець бачить, з чого склалася сума. */
function chargeNote(row, period) {
    const parts = row.parts?.length ? row.parts : [{ base: 'area', rate4: row.rate4 }];
    const one = p => (p.base === 'fixed' ? `${formatRate(p.rate4)} грн`
        : p.base === 'residents' ? `${p.residents} прож. × ${formatRate(p.rate4)} грн` : `${formatArea(row.areaCenti)} м² × ${formatRate(p.rate4)} грн`);
    if (parts.length === 1) return `Внесок за ${periodName(period)}: ${one(parts[0])}`;
    return `Внески за ${periodName(period)}: ${parts.map(p => `${p.name.toLowerCase()} ${one(p)}`).join('; ')}`;
}

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
        if (r.parts) {
            const vals = Object.values(r.parts);
            if (!vals.every(Number.isInteger)) return `Квартира ${r.apt}: незрозуміла сума за складовою`;
            if (vals.reduce((s, v) => s + v, 0) !== r.amountKop) return `Квартира ${r.apt}: складові разом не дорівнюють залишку`;
        }
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

// ------------------------------------------------------------
// БАЛАНС ЗА СКЛАДОВИМИ (як у сервісі бухгалтера)
// ------------------------------------------------------------
const msOf = at => (at?.toMillis ? at.toMillis() : at?.toDate ? at.toDate().getTime() : at instanceof Date ? at.getTime() : (Date.parse(at) || 0));
const KIND_ORDER = { opening: 0, charge: 1, payment: 2 };

/**
 * Розподіл оплати між складовими — як у сервісі бухгалтера: спершу
 * повністю закриваються борги інших складових (освітлення, ліфти,
 * вивезення…), решта йде на основну («Обслуговування будинку»), навіть
 * у переплату. Якщо оплати не вистачає на ці борги — ділимо пропорційно.
 * Квитанція за вересень 2026: 400 = 28,30 + 31,36 + 40,32 + 300,02.
 * balances — у знаку застосунку (мінус — борг). Повертає { складова: коп }.
 */
function allocatePayment(kop, balances, order) {
    const alloc = {};
    const others = order.filter(c => c !== 'main');
    const debts = others.map(c => Math.max(0, -(balances[c] || 0)));
    const totalDebt = debts.reduce((s, d) => s + d, 0);
    if (totalDebt > 0 && kop < totalDebt) {
        let given = 0;
        others.forEach((c, i) => { if (debts[i]) { alloc[c] = Math.floor(kop * debts[i] / totalDebt); given += alloc[c]; } });
        const biggest = others[debts.indexOf(Math.max(...debts))];
        alloc[biggest] += kop - given;
        return alloc;
    }
    let left = kop;
    others.forEach((c, i) => { if (debts[i]) { alloc[c] = debts[i]; left -= debts[i]; } });
    if (left) alloc.main = left;
    return alloc;
}

/**
 * Історія квартири по кроках: залишок кожної складової після кожного
 * запису. Вхідний залишок — за його складовими (без них — на основну),
 * нарахування — за частинами, оплата — розподілом allocatePayment.
 * order — порядок складових (з налаштувань). Записи до початку обліку
 * не беруться: вони вже у вхідному залишку.
 */
function replay(entries, { startPeriod = START_PERIOD, order = ['main'] } = {}) {
    const list = entries.map((e, i) => ({ e, i }))
        .filter(({ e }) => e.kind === 'opening' || (['charge', 'payment'].includes(e.kind) && String(e.period || '') >= startPeriod))
        .sort((a, b) => (msOf(a.e.at) - msOf(b.e.at)) || (KIND_ORDER[a.e.kind] - KIND_ORDER[b.e.kind]) || a.i - b.i);
    const balances = {};
    const add = (c, v) => { balances[c] = (balances[c] || 0) + v; };
    const steps = [];
    for (const { e } of list) {
        let parts;
        if (e.kind === 'opening') parts = e.parts && Object.keys(e.parts).length ? { ...e.parts } : { main: entryKop(e) };
        else if (e.kind === 'charge') parts = Object.fromEntries((e.parts?.length ? e.parts : [{ component: 'main', amountKop: entryKop(e) }]).map(p => [p.component, -p.amountKop]));
        else parts = allocatePayment(entryKop(e), balances, [...new Set([...order, ...Object.keys(balances)])]);
        Object.entries(parts).forEach(([c, v]) => add(c, v));
        steps.push({ entry: e, parts });
    }
    return { balances, steps };
}

/** Залишки за складовими на початок і кінець місяця, нараховано й сплачено за складовими. */
function componentStatement(entries, period, opts = {}) {
    const { steps } = replay(entries, opts);
    const opening = {}, charged = {}, paid = {}, closing = {};
    const add = (m, c, v) => { m[c] = (m[c] || 0) + v; };
    for (const { entry, parts } of steps) {
        const before = entry.kind === 'opening' || String(entry.period || '') < period;
        const during = !before && entry.period === period;
        for (const [c, v] of Object.entries(parts)) {
            if (before) add(opening, c, v);
            if (before || during) add(closing, c, v);
            if (during && entry.kind === 'charge') add(charged, c, -v);
            if (during && entry.kind === 'payment') add(paid, c, v);
        }
    }
    return { opening, charged, paid, closing };
}

/** Надходження внесків за складовими за рік (розподіл оплат усіх квартир) — «Надходження по статтях». */
function paidByComponent(ledgers, year, opts = {}) {
    const out = {};
    for (const entries of ledgers.values()) {
        for (const { entry, parts } of replay(entries, opts).steps) {
            if (entry.kind !== 'payment' || !String(entry.period || '').startsWith(String(year))) continue;
            for (const [c, v] of Object.entries(parts)) out[c] = (out[c] || 0) + v;
        }
    }
    return out;
}

/**
 * Оплати мешканців за складовими — по кожній оплаті (розшифровка
 * «Надходження → Внесок на обслуговування ліфтів»: квартира, дата, сума).
 * Той самий розподіл, що й paidByComponent, тож суми збігаються.
 * Повертає [{ apt, at, component, kop }].
 */
function paymentOps(ledgers, year, opts = {}) {
    const out = [];
    for (const [apt, entries] of ledgers) {
        for (const { entry, parts } of replay(entries, opts).steps) {
            if (entry.kind !== 'payment' || !String(entry.period || '').startsWith(String(year))) continue;
            for (const [component, kop] of Object.entries(parts)) if (kop) out.push({ apt, at: entry.at, component, kop });
        }
    }
    return out;
}

/**
 * Відомість розрахунків з мешканцями за місяць: залишок на початок,
 * нараховано, сплачено, залишок на кінець — по кожній квартирі.
 * ledgers: Map<apt, entries[]>.
 */
function statement(ledgers, period, startPeriod = START_PERIOD, order = ['main']) {
    const rows = [];
    const byComponent = {};
    for (const [apt, entries] of ledgers) {
        const before = entries.filter(e => e.kind === 'opening' || String(e.period || '') < period);
        const during = entries.filter(e => e.kind !== 'opening' && e.period === period && period >= startPeriod);
        const opening = balanceFromLedger(before, startPeriod);
        const charged = during.filter(e => e.kind === 'charge').reduce((s, e) => s + entryKop(e), 0);
        const paid = during.filter(e => e.kind === 'payment').reduce((s, e) => s + entryKop(e), 0);
        const parts = componentStatement(entries, period, { startPeriod, order });
        for (const key of ['opening', 'charged', 'paid', 'closing']) {
            for (const [c, v] of Object.entries(parts[key])) {
                byComponent[c] ||= { opening: 0, charged: 0, paid: 0, closing: 0 };
                byComponent[c][key] += v;
            }
        }
        rows.push({ apt, opening, charged, paid, closing: opening - charged + paid, parts });
    }
    rows.sort((a, b) => String(a.apt).localeCompare(String(b.apt), 'uk', { numeric: true }));
    const sum = key => rows.reduce((s, r) => s + r[key], 0);
    return {
        rows, byComponent,
        totals: { opening: sum('opening'), charged: sum('charged'), paid: sum('paid'), closing: sum('closing'),
            debt: rows.reduce((s, r) => s + Math.min(0, r.closing), 0), debtors: rows.filter(r => r.closing < 0).length }
    };
}

module.exports = {
    START_PERIOD, OPENING_PERIOD, OPENING_ID, DEFAULT_GROUPS, DEFAULT_COMPONENTS, BASES, checkComponent, partKop, parseResidents,
    parseArea, parseRate, formatRate, formatArea, chargeKop, entryKop,
    validPeriod, shiftPeriod, currentPeriod, periodName, kyivDate, lastDay, chargeDate, openingDate, duePeriods,
    tariffFor, checkTariff, checkGroupName, computeCharges, chargeNote,
    checkOpening, openingNote, balanceFromLedger, statement, allocatePayment, replay, componentStatement, paidByComponent, paymentOps
};
