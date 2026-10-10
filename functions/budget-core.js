'use strict';
// ============================================================
// Кошторис ОСББ: план на рік, виконання (план/факт) і що бачать
// співвласники.
//
// СТАТУТ (редакція 2021 р.)
//   • п. 4.12.2 — кошторис затверджують загальні збори щороку до 01 січня;
//     якщо не затвердили — діє попередній.
//   • п. 4.12.3 — обовʼязкові статті: утримання й ремонт спільного майна,
//     комунальні та інші послуги, витрати фондів, інші витрати.
//   • п. 4.12.4 — окремі кошториси ремонтного й резервного фондів.
//   • п. 4.12.5 — річний звіт про виконання кошторису: ревізійній комісії,
//     потім загальним зборам.
//   • п. 5.1.1 — співвласник має право знати всі фінансові звіти.
//
// Факт витрат — за документами (рахунки, акти) за місяцем послуги, а
// списання без документа (комісія банку, зарплата, податки) — за датою
// списання. Тут немає ні мережі, ні бази: тести — budget-core.test.js.
// ============================================================
const { ITEMS } = require('./expenses-core');

/** Кошториси за п. 4.12.4: основний і окремі для фондів. */
const SECTIONS = { main: 'Кошторис утримання будинку', repair: 'Ремонтний фонд', reserve: 'Резервний фонд' };

/** Стаття витрат → кошторис. */
const ITEM_SECTION = { capital: 'repair', reserve: 'reserve' };
const sectionOf = item => ITEM_SECTION[item] || 'main';

/** Групи обовʼязкових статей за п. 4.12.3 статуту. */
const GROUPS = {
    upkeep: { title: 'Утримання й ремонт спільного майна', items: ['lift', 'cleaning', 'waste', 'systems', 'repair'] },
    utilities: { title: 'Комунальні та інші послуги', items: ['power', 'water'] },
    funds: { title: 'Витрати фондів', items: ['capital', 'reserve'] },
    other: { title: 'Інші витрати', items: ['services', 'bank', 'office', 'salary', 'other'] }
};
const groupOf = item => Object.keys(GROUPS).find(g => GROUPS[g].items.includes(item)) || 'other';

const INCOME_SOURCES = {
    contributions: 'Внески співвласників', rent: 'Оренда приміщень', equipment: 'Розміщення обладнання й реклами', interest: 'Відсотки банку',
    grant: 'Гранти, співфінансування', refund: 'Повернення коштів', other: 'Інші надходження'
};

/** Списання без документа → стаття (категорії банку, bank.js). */
const BANK_ITEM = { bank_fee: 'bank', salary: 'salary', taxes: 'salary', supplier: 'other', other: 'other' };

const MAX_KOP = 100_000_000_000;

// ------------------------------------------------------------
// ПЕРЕВІРКА
// ------------------------------------------------------------
const validYear = y => /^\d{4}$/.test(String(y)) && Number(y) >= 2020 && Number(y) <= 2100;

function checkBudget(b) {
    if (!validYear(b.year)) return 'Невідомий рік';
    const lines = b.lines || [];
    if (!Array.isArray(lines) || lines.length > 120) return 'Забагато статей';
    const seen = new Set();
    for (const l of lines) {
        if (!ITEMS[l.item]) return 'Невідома стаття витрат';
        const title = String(l.title || '').trim();
        if (title.length > 120) return 'Назва рядка задовга (до 120 символів)';
        if (!Number.isInteger(l.planKop) || l.planKop < 0 || l.planKop > MAX_KOP) return `«${title || ITEMS[l.item]}»: сума плану некоректна`;
        const key = `${l.item}|${title.toLowerCase()}`;
        if (seen.has(key)) return `Рядок «${title || ITEMS[l.item]}» повторюється`;
        seen.add(key);
    }
    for (const i of b.income || []) {
        if (!INCOME_SOURCES[i.source]) return 'Невідоме джерело надходжень';
        if (!Number.isInteger(i.planKop) || i.planKop < 0 || i.planKop > MAX_KOP) return `${INCOME_SOURCES[i.source]}: сума некоректна`;
    }
    if (new Set((b.income || []).map(i => i.source)).size !== (b.income || []).length) return 'Джерело надходжень повторюється';
    return null;
}

/** Затвердження (і зміни до затвердженого) — лише з рішенням загальних зборів. */
function checkDecision(decision) {
    return String(decision || '').trim().length < 3 ? 'Кошторис затверджують загальні збори (п. 4.12.2 статуту): вкажіть протокол і дату' : null;
}

/**
 * Чинний кошторис на рік: затверджений цього року, а якщо його немає —
 * останній затверджений раніше (п. 4.12.2 статуту: діє попередній).
 */
function effectiveBudget(budgets, year) {
    const approved = budgets.filter(b => b.status === 'approved' && Number(b.year) <= Number(year))
        .sort((a, b) => Number(b.year) - Number(a.year));
    const b = approved[0];
    if (!b) return null;
    return { ...b, carried: Number(b.year) !== Number(year) };
}

// ------------------------------------------------------------
// ВИКОНАННЯ
// ------------------------------------------------------------
const inYear = (period, year) => String(period || '').slice(0, 4) === String(year);

/**
 * Факт витрат за статтями за рік: документи (затверджені й оплачені)
 * за місяцем послуги + списання без документа за місяцем списання.
 * Повертає Map<item, kop>.
 */
function factByItem({ expenses = [], bankOut = [], year }) {
    const fact = new Map();
    const add = (item, kop) => fact.set(item, (fact.get(item) || 0) + kop);
    for (const e of expenses) {
        if (['approved', 'paid'].includes(e.status) && inYear(e.period, year)) add(e.item, e.amountKop);
    }
    for (const t of bankOut) {
        if (t.direction !== 'out' || t.kind !== 'expense' || t.status !== 'done' || t.expenseId || !inYear(t.period, year)) continue;
        add(BANK_ITEM[t.category] || 'other', t.amountKop);
    }
    return fact;
}

/** Факт надходжень за джерелами: внески (оплати мешканців) та інше з виписки. */
function incomeFact({ bankIn = [], year }) {
    const fact = new Map();
    for (const t of bankIn) {
        if (t.direction !== 'in' || t.status !== 'done' || !inYear(t.period, year)) continue;
        const source = t.kind === 'payment' ? 'contributions' : t.kind === 'income' ? (INCOME_SOURCES[t.category] ? t.category : 'other') : null;
        if (source) fact.set(source, (fact.get(source) || 0) + t.amountKop);
    }
    return fact;
}

/**
 * Скільки місяців року вже минуло в обліку застосунку: від початку
 * року або від початку обліку (01.10.2026) до поточного місяця включно.
 * Потрібно, щоб «план на сьогодні» порівнювати з фактом чесно.
 */
function monthsElapsed(year, today, startPeriod = '2026-10') {
    const from = `${year}-01` > startPeriod ? `${year}-01` : startPeriod;
    const to = today.slice(0, 7) < `${year}-12` ? today.slice(0, 7) : `${year}-12`;
    if (to < from || from.slice(0, 4) !== String(year)) return 0;
    return (Number(to.slice(0, 4)) - Number(from.slice(0, 4))) * 12 + Number(to.slice(5, 7)) - Number(from.slice(5, 7)) + 1;
}

/**
 * План/факт за кошторисом. Рядки однієї статті ділять факт пропорційно
 * плану (у статті може бути кілька рядків, напр. «Ремонт покрівлі» і
 * «Ремонт підʼїзду»). Факт за статтею, якої в кошторисі немає, — окремий
 * рядок «поза кошторисом».
 */
function execution({ budget, fact, income, months, incomeParts = [] }) {
    // Порядок — як у статуті: група п. 4.12.3, далі порядок рядків кошторису.
    const order = Object.keys(GROUPS);
    const lines = (budget?.lines || []).map((l, i) => ({ ...l, i, section: sectionOf(l.item), group: groupOf(l.item) }))
        .sort((a, b) => order.indexOf(a.group) - order.indexOf(b.group) || a.i - b.i);
    const planByItem = new Map();
    lines.forEach(l => planByItem.set(l.item, (planByItem.get(l.item) || 0) + l.planKop));
    const out = lines.map(l => {
        const itemPlan = planByItem.get(l.item);
        const itemFact = fact.get(l.item) || 0;
        const sameItem = lines.filter(x => x.item === l.item);
        const share = itemPlan ? l.planKop / itemPlan : 1 / sameItem.length;
        // Останній рядок статті забирає залишок округлення — сума частин дорівнює факту.
        const isLast = sameItem[sameItem.length - 1] === l;
        const factKop = isLast ? itemFact - sameItem.slice(0, -1).reduce((s, x) => s + Math.round(itemFact * (itemPlan ? x.planKop / itemPlan : 1 / sameItem.length)), 0) : Math.round(itemFact * share);
        return { item: l.item, title: l.title || ITEMS[l.item], section: l.section, group: l.group, planKop: l.planKop,
            toDateKop: Math.round(l.planKop * months / 12), factKop };
    });
    for (const [item, kop] of fact) {
        if (!planByItem.has(item) && kop) out.push({ item, title: ITEMS[item] || item, section: sectionOf(item), group: groupOf(item), planKop: 0, toDateKop: 0, factKop: kop, outside: true });
    }
    // Рядки «поза кошторисом» — у своїй групі, щоб заголовки груп не повторювались (сортування стабільне).
    out.sort((a, b) => order.indexOf(a.group) - order.indexOf(b.group));
    const incomeLines = Object.keys(INCOME_SOURCES).map(source => {
        const plan = (budget?.income || []).find(i => i.source === source)?.planKop || 0;
        const line = { source, title: INCOME_SOURCES[source], planKop: plan, toDateKop: Math.round(plan * months / 12), factKop: income.get(source) || 0 };
        // Внески — за складовими (як «Надходження» в сервісі бухгалтера).
        if (source === 'contributions' && incomeParts.length) line.parts = incomeParts;
        return line;
    }).filter(l => l.planKop || l.factKop);
    const sum = (list, key) => list.reduce((s, l) => s + l[key], 0);
    const sections = Object.keys(SECTIONS).map(id => {
        const list = out.filter(l => l.section === id);
        return { id, title: SECTIONS[id], lines: list, planKop: sum(list, 'planKop'), toDateKop: sum(list, 'toDateKop'), factKop: sum(list, 'factKop') };
    }).filter(s => s.lines.length);
    return {
        sections, income: incomeLines, months,
        totals: { planKop: sum(out, 'planKop'), toDateKop: sum(out, 'toDateKop'), factKop: sum(out, 'factKop'),
            incomePlanKop: sum(incomeLines, 'planKop'), incomeFactKop: sum(incomeLines, 'factKop') }
    };
}

/**
 * Чи не виходить документ за кошторис. Повертає причину (тоді
 * затверджує голова) або null. Без затвердженого кошторису — null:
 * контролювати нема з чим.
 */
function itemOverrun(budget, item, spentKop, amountKop) {
    if (!budget) return null;
    const plan = (budget.lines || []).filter(l => l.item === item).reduce((s, l) => s + l.planKop, 0);
    if (!(budget.lines || []).some(l => l.item === item)) return `статті «${ITEMS[item] || item}» немає в кошторисі`;
    if (spentKop + amountKop > plan) return `понад кошторис за статтею «${ITEMS[item] || item}»: ${((spentKop + amountKop) / 100).toFixed(2)} з ${(plan / 100).toFixed(2)} грн на рік`;
    return null;
}

/** Загальний борг будинку без прізвищ і номерів квартир. */
function houseDebt(apartments) {
    const debtors = apartments.filter(a => !a.isAdmin && Number(a.balance) < 0);
    return { totalKop: debtors.reduce((s, a) => s + Math.round(-Number(a.balance) * 100), 0), count: debtors.length };
}

module.exports = {
    SECTIONS, GROUPS, INCOME_SOURCES, BANK_ITEM, sectionOf, groupOf, validYear,
    checkBudget, checkDecision, effectiveBudget, factByItem, incomeFact, monthsElapsed, execution, itemOverrun, houseDebt
};
