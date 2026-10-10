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
const { toKop } = require('./bank-core');

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
    other: { title: 'Інші витрати', items: ['services', 'bank', 'office', 'salary', 'esv', 'other'] }
};
const groupOf = item => Object.keys(GROUPS).find(g => GROUPS[g].items.includes(item)) || 'other';

const INCOME_SOURCES = {
    contributions: 'Внески співвласників', rent: 'Оренда приміщень', equipment: 'Розміщення обладнання й реклами', interest: 'Відсотки банку',
    grant: 'Гранти, співфінансування', refund: 'Повернення коштів', other: 'Інші надходження'
};

/** Списання без документа → стаття (категорії банку, bank.js). */
const BANK_ITEM = { bank_fee: 'bank', salary: 'salary', taxes: 'salary', esv: 'esv', supplier: 'other', other: 'other' };

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
function factByItem({ expenses = [], bankOut = [], payrollRuns = [], payrollPayments = new Map(), year }) {
    const fact = new Map();
    const add = (item, kop) => fact.set(item, (fact.get(item) || 0) + kop);
    for (const e of expenses) {
        if (['approved', 'paid', 'storno'].includes(e.status) && inYear(e.period, year)) add(e.item, e.amountKop);
    }
    const byId = new Map(bankOut.filter(t => t.id).map(t => [t.id, t]));
    const direct = t => t.direction === 'out' && t.kind === 'expense' && t.status === 'done' && !t.expenseId
        && !['supplier', 'resident_refund'].includes(t.category) && !payrollPayments.has(t.paymentId);
    for (const t of bankOut) {
        if (!inYear(t.period, year)) continue;
        if (direct(t)) add(BANK_ITEM[t.category] || 'other', t.amountKop);
        // Повернення прямої витрати банку (комісії, іншої) зменшує її статтю; документи — через сторно.
        const o = t.kind === 'refund' && t.status === 'done' ? byId.get(t.refundOf) : null;
        if (o && direct(o)) add(BANK_ITEM[o.category] || 'other', -t.amountKop);
    }
    for (const p of payrollRuns) {
        if (p.status !== 'approved' || !inYear(p.period, year)) continue;
        add('salary', p.run?.totals?.grossKop || 0);
        add('esv', p.run?.totals?.esvKop || 0);
    }
    return fact;
}

// ------------------------------------------------------------
// РОЗШИФРОВКА СТАТТІ
// ------------------------------------------------------------
const LEGAL = /(^|[\s«"'(])(тов|тзов|пп|прат|пат|ат|кп|дп|комунальн[а-яіїєґ]*|державн[а-яіїєґ]*|гу|дпс|казначейств[а-яіїєґ]*|управлінн[а-яіїєґ]*|банк|осбб|фонд)([\s»"'.,)]|$)/i;
const FOP = /(^|[\s«"'(])(фоп|спд|фізична особа[-\s]підприємець)([\s»"'.,)]|$)/i;

/**
 * Хто отримав гроші: юрособа, ФОП чи фізособа без ФОП. За кодом
 * (8 цифр — ЄДРПОУ) і назвою; для документа — за видом постачальника.
 */
function payeeKind(name, code, supplierKind) {
    if (['company', 'fop', 'person'].includes(supplierKind)) return supplierKind;
    if (FOP.test(name || '')) return 'fop';
    if (/^\d{8}$/.test(String(code || '')) || LEGAL.test(name || '')) return 'company';
    return 'person';
}

const kyivDate = v => {
    const d = v?.toDate ? v.toDate() : v instanceof Date ? v : v ? new Date(v) : null;
    return d && !Number.isNaN(d.getTime()) ? new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Kyiv' }).format(d) : '';
};

/**
 * Операції за статтями — ті самі, що дають факт (factByItem), тож сума
 * списку дорівнює факту статті. { item: [{ date, who, kind, amountKop, … }] },
 * новіші вгорі.
 *
 * publicView — для мешканців: фізособу без ФОП не називаємо (працівник,
 * виконавець за договором ЦПД) і не показуємо призначення платежу, лише
 * опис документа. Юрособи й ФОП — назвою (п. 5.1.1 статуту).
 */
function operationsByItem({ expenses = [], bankOut = [], payrollRuns = [], payrollPayments = new Map(), year, suppliers = new Map(), docTypes = {}, publicView = false, limit = Infinity }) {
    const out = {};
    const add = (item, op) => (out[item] ||= []).push(op);
    const hide = (item, kind) => publicView && kind === 'person' ? (['salary', 'esv'].includes(item) ? 'Працівник ОСББ' : 'Фізична особа') : null;
    for (const e of expenses) {
        if (!['approved', 'paid', 'storno'].includes(e.status) || !inYear(e.period, year)) continue;
        const kind = payeeKind(e.supplierName, '', suppliers.get(e.supplierId)?.kind);
        add(e.item, { date: e.date || '', who: hide(e.item, kind) || e.supplierName || '', kind, amountKop: e.amountKop,
            what: e.description || '', doc: `${docTypes[e.docType] || 'Документ'} № ${e.number}`, paid: e.status === 'paid',
            ...((e.files || []).length ? { files: e.files.map(f => ({ name: f.name, url: f.url })) } : {}) });
    }
    for (const t of bankOut) {
        if (t.direction !== 'out' || t.kind !== 'expense' || t.status !== 'done' || t.expenseId || !inYear(t.period, year)) continue;
        if (['supplier', 'resident_refund'].includes(t.category) || payrollPayments.has(t.paymentId)) continue;
        const item = BANK_ITEM[t.category] || 'other';
        const cp = t.counterparty || {};
        // Зарплату отримує людина, хоч би як банк назвав отримувача («ПРАЦІВНИК ОСББ …»).
        const kind = t.category === 'bank_fee' ? 'fee' : t.category === 'salary' && !/^\d{8}$/.test(String(cp.code || '')) ? 'person' : payeeKind(cp.name, cp.code);
        add(item, { date: kyivDate(t.at), who: hide(item, kind) || cp.name || '', kind, amountKop: t.amountKop,
            ...(publicView ? {} : { what: t.purpose || '' }) });
    }
    for (const p of payrollRuns) {
        if (p.status !== 'approved' || !inYear(p.period, year)) continue;
        const date = `${p.period}-${new Date(Date.UTC(Number(p.period.slice(0, 4)), Number(p.period.slice(5, 7)), 0)).getUTCDate()}`;
        for (const r of p.run?.rows || []) {
            for (const [item, amountKop] of [['salary', r.grossKop], ['esv', r.esvKop]]) {
                if (amountKop) add(item, { date, who: publicView ? 'Працівник ОСББ' : r.name, kind: 'person', amountKop, what: 'Нараховано за відомістю', paid: false });
            }
        }
    }
    for (const item of Object.keys(out)) {
        out[item].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : b.amountKop - a.amountKop));
        if (out[item].length > limit) out[item] = out[item].slice(0, limit);
    }
    return out;
}

/**
 * Як назвати приміщення мешканцям: «Під'їзд 2, Квартира 177» — якщо
 * правління вирішило показувати номери (як у сервісі), інакше «Співвласник».
 */
function aptLabel(apt, { entrance, nonres } = {}, show = false) {
    if (!show) return 'Співвласник';
    return `${entrance ? `Під'їзд ${entrance}, ` : ''}${nonres ? 'Нежитлове приміщення' : 'Квартира'} ${apt}`;
}

/**
 * Інші надходження (оренда, обладнання, відсотки…) за джерелами — ті
 * самі, що дають факт (incomeFact). Платник-мешканець (оренда комори) —
 * приміщенням, юрособа й ФОП — назвою, інша фізособа — без імені.
 */
function incomeOpsBySource({ bankIn = [], year, label = () => 'Співвласник', publicView = false, limit = Infinity }) {
    const out = {};
    for (const t of bankIn) {
        if (t.direction !== 'in' || t.status !== 'done' || t.kind !== 'income' || !inYear(t.period, year)) continue;
        const source = INCOME_SOURCES[t.category] ? t.category : 'other';
        const cp = t.counterparty || {};
        const kind = t.relatedApt ? 'apt' : payeeKind(cp.name, cp.code);
        const who = t.relatedApt ? label(t.relatedApt) : publicView && kind === 'person' ? 'Фізична особа' : cp.name || '';
        (out[source] ||= []).push({ date: kyivDate(t.at), who, kind, amountKop: t.amountKop, ...(publicView ? {} : { what: t.purpose || '' }) });
    }
    for (const k of Object.keys(out)) {
        out[k].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : b.amountKop - a.amountKop));
        if (out[k].length > limit) out[k] = out[k].slice(0, limit);
    }
    return out;
}

/** Факт надходжень за джерелами: внески (оплати мешканців) та інше з виписки. */
function incomeFact({ bankIn = [], year }) {
    const fact = new Map();
    for (const t of bankIn) {
        if (t.status !== 'done' || !inYear(t.period, year)) continue;
        // Повернена співвласнику переплата зменшує надходження внесків.
        if (t.direction === 'out' && t.category === 'resident_refund') { fact.set('contributions', (fact.get('contributions') || 0) - t.amountKop); continue; }
        if (t.direction !== 'in') continue;
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
    const allocations = new Map();
    for (const [item, plan] of planByItem) {
        const siblings = lines.filter(l => l.item === item);
        const actual = fact.get(item) || 0;
        const denominator = BigInt(plan || siblings.length);
        const portions = siblings.map(l => {
            const numerator = BigInt(actual) * BigInt(plan ? l.planKop : 1);
            return { l, kop: Number(numerator / denominator), remainder: numerator % denominator };
        });
        let left = actual - portions.reduce((sum, p) => sum + p.kop, 0);
        const ranked = portions.slice().sort((a, b) => a.remainder > b.remainder ? -1 : a.remainder < b.remainder ? 1 : a.l.i - b.l.i);
        for (let i = 0; i < left; i++) ranked[i].kop++;
        portions.forEach(p => allocations.set(p.l, p.kop));
    }
    const out = lines.map(l => {
        const factKop = allocations.get(l);
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

/**
 * Загальний борг будинку. Без прізвищ завжди; список приміщень з боргом
 * (як «Заборгованість» у сервісі) — лише якщо label заданий, тобто
 * правління вирішило показувати номери. Порядок — за адресою.
 */
function houseDebt(apartments, label = null) {
    const debtors = apartments.filter(a => !a.isAdmin && Number(a.balance) < 0);
    const out = { totalKop: debtors.reduce((s, a) => s - toKop(a.balance), 0), count: debtors.length };
    if (label) {
        out.list = debtors.map(a => ({ apt: String(a.apt), label: label(a.apt), entrance: String(a.entrance || ''), kop: -toKop(a.balance) }))
            .sort((x, y) => x.entrance.localeCompare(y.entrance, 'uk', { numeric: true }) || x.apt.localeCompare(y.apt, 'uk', { numeric: true }));
    }
    return out;
}

module.exports = {
    SECTIONS, GROUPS, INCOME_SOURCES, BANK_ITEM, sectionOf, groupOf, validYear,
    checkBudget, checkDecision, effectiveBudget, factByItem, operationsByItem, payeeKind, kyivDate, aptLabel, incomeOpsBySource, incomeFact, monthsElapsed, execution, itemOverrun, houseDebt
};
