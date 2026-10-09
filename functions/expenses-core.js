'use strict';
// ============================================================
// Витрати й договори: постачальники, договори, первинні документи
// (рахунки, акти, накладні), хто затверджує і звірка зі списаннями.
//
// ХТО ЗАТВЕРДЖУЄ (п. 3.4.15 статуту; рішення правління, жовтень 2026)
//   • Договір підписує голова. Договір понад 50 000 грн — лише за
//     рішенням загальних зборів: без протоколу система його не прийме.
//   • Документ за затвердженим чинним договором у межах його суми —
//     бухгалтер (Enter). Без договору чи понад договір — голова.
//   • Дрібні витрати без договору до порогу, який задає голова
//     (за замовчуванням 0 — тобто все без договору йде голові).
//
// Тут немає ні мережі, ні бази. Тести — functions/expenses-core.test.js.
// ============================================================
const { normIban, fromKop } = require('./bank-core');
const { validIban } = require('./payments-core');

const CONTRACT_LIMIT_KOP = 5_000_000;    // 50 000 грн — п. 3.4.15 статуту
const MAX_KOP = 100_000_000_000;

/** Статті витрат за п. 4.12.3 статуту; кошторис (частина 4) спиратиметься на них. */
const ITEMS = {
    lift: 'Ліфти',
    cleaning: 'Прибирання',
    waste: 'Вивіз сміття',
    power: 'Електроенергія місць загального користування',
    water: 'Вода й водовідведення МЗК',
    systems: 'Обслуговування інженерних систем',
    repair: 'Поточний ремонт',
    capital: 'Капітальний ремонт (ремонтний фонд)',
    reserve: 'Резервний фонд',
    services: 'Бухгалтерські й юридичні послуги',
    bank: 'Банк і РКО',
    office: 'Канцтовари, звʼязок, програми',
    salary: 'Оплата праці',
    other: 'Інше'
};

const DOC_TYPES = { invoice: 'Рахунок', act: 'Акт', waybill: 'Видаткова накладна', receipt: 'Чек, квитанція', other: 'Інший документ' };
const DOC_GEN = { invoice: 'рахунком', act: 'актом', waybill: 'накладною', receipt: 'чеком', other: 'документом' };
const SUPPLIER_KINDS = { company: 'Юрособа', fop: 'ФОП', person: 'Фізособа без ФОП' };

// ------------------------------------------------------------
// КОДИ
// ------------------------------------------------------------
/** ЄДРПОУ: 8 цифр і контрольна цифра (методика Держстату). */
function validEdrpou(value) {
    const code = String(value ?? '').trim();
    if (!/^\d{8}$/.test(code)) return false;
    const d = code.split('').map(Number);
    const n = Number(code);
    const base = n < 30000000 || n > 60000000 ? [1, 2, 3, 4, 5, 6, 7] : [7, 1, 2, 3, 4, 5, 6];
    let sum = base.reduce((s, w, i) => s + w * d[i], 0) % 11;
    if (sum === 10) sum = base.map(w => w + 2).reduce((s, w, i) => s + w * d[i], 0) % 11;
    return (sum === 10 ? 0 : sum) === d[7];
}

/** РНОКПП фізособи: 10 цифр і контрольна цифра. */
function validRnokpp(value) {
    const code = String(value ?? '').trim();
    if (!/^\d{10}$/.test(code)) return false;
    const d = code.split('').map(Number);
    const sum = [-1, 5, 7, 9, 4, 6, 10, 5, 7].reduce((s, w, i) => s + w * d[i], 0);
    return ((sum % 11) + 11) % 11 % 10 === d[9];
}

// ------------------------------------------------------------
// ДАТИ
// ------------------------------------------------------------
const validDate = d => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(d || ''))) return false;
    const date = new Date(`${d}T00:00:00Z`);
    return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === d;
};
const validPeriod = p => /^\d{4}-(0[1-9]|1[0-2])$/.test(String(p || ''));
/** «2026-10-09» → «09.10.2026». */
const humanDate = d => String(d).split('-').reverse().join('.');

/** Кількість місяців договору включно: 2026-10-01…2027-09-30 → 12. */
function monthsBetween(from, to) {
    const [y1, m1] = from.split('-').map(Number);
    const [y2, m2] = to.split('-').map(Number);
    return Math.max(1, (y2 - y1) * 12 + (m2 - m1) + 1);
}

// ------------------------------------------------------------
// ПОСТАЧАЛЬНИКИ
// ------------------------------------------------------------
function checkSupplier(s) {
    const name = String(s.name || '').trim();
    if (name.length < 2 || name.length > 200) return 'Вкажіть назву постачальника';
    if (!SUPPLIER_KINDS[s.kind]) return 'Оберіть, хто постачальник: юрособа, ФОП чи фізособа';
    const code = String(s.code || '').trim();
    if (s.kind === 'company' && !validEdrpou(code)) return 'ЄДРПОУ — 8 цифр; контрольна цифра не збігається, перевірте код';
    if (s.kind !== 'company' && !validRnokpp(code)) return 'РНОКПП — 10 цифр; контрольна цифра не збігається, перевірте код';
    if (s.iban && !validIban(s.iban)) return 'IBAN некоректний — перевірте цифри';
    return null;
}

/**
 * Застереження щодо виплати, що не блокують: фізособі без ФОП —
 * це виплата за ЦПД з утриманнями; ФОП — без утримань лише з
 * витягом з ЄДР і відповідним КВЕД (п. 177.8 ПКУ).
 */
function supplierWarnings(s) {
    const out = [];
    if (s?.kind === 'person') out.push('Фізособа без ФОП: це виплата за ЦПД — ПДФО 18 %, військовий збір 5 % і ЄСВ 22 % (частина «Зарплата й виплати»). Через «Витрати» не сплачуйте.');
    if (s?.kind === 'fop' && !s.fopChecked) out.push('ФОП: перед оплатою перевірте витяг з ЄДР і КВЕД — інакше ОСББ має утримати ПДФО (п. 177.8 ПКУ).');
    return out;
}

// ------------------------------------------------------------
// ДОГОВОРИ
// ------------------------------------------------------------
/** Сума договору для ліміту статуту: разовий — сума, щомісячний — місяці × сума (безстроковий — рік). */
function contractTotal(c) {
    if (c.type === 'monthly') {
        const to = c.validTo || `${Number(c.validFrom.slice(0, 4)) + 1}-${c.validFrom.slice(5, 7)}-01`;
        const months = c.validTo ? monthsBetween(c.validFrom, to) : 12;
        return c.monthlyKop * months;
    }
    return c.amountKop;
}

function checkContract(c) {
    if (!c.supplierId) return 'Оберіть постачальника';
    if (!String(c.number || '').trim()) return 'Вкажіть номер договору';
    if (!validDate(c.date)) return 'Вкажіть дату договору';
    const subject = String(c.subject || '').trim();
    if (subject.length < 3 || subject.length > 300) return 'Вкажіть предмет договору';
    if (!['fixed', 'monthly'].includes(c.type)) return 'Оберіть вид договору';
    const kop = c.type === 'monthly' ? c.monthlyKop : c.amountKop;
    if (!Number.isInteger(kop) || kop <= 0 || kop > MAX_KOP) return c.type === 'monthly' ? 'Вкажіть суму на місяць' : 'Вкажіть суму договору';
    if (!validDate(c.validFrom)) return 'Вкажіть, з якої дати діє договір';
    if (c.validTo && (!validDate(c.validTo) || c.validTo < c.validFrom)) return 'Дата закінчення раніше за початок';
    if (!ITEMS[c.item]) return 'Оберіть статтю витрат';
    if (contractTotal(c) > CONTRACT_LIMIT_KOP && String(c.meetingDecision || '').trim().length < 3) {
        return `Договір на ${fromKop(contractTotal(c)).toLocaleString('uk-UA')} грн — понад 50 000 грн: його укладають лише за рішенням загальних зборів (п. 3.4.15 статуту). Вкажіть протокол.`;
    }
    return null;
}

/** Чи чинний договір на дату документа. */
const contractActive = (c, date) => c.status === 'approved' && date >= c.validFrom && (!c.validTo || date <= c.validTo);

// ------------------------------------------------------------
// ДОКУМЕНТИ ВИТРАТ
// ------------------------------------------------------------
function checkExpense(e) {
    if (!e.supplierId) return 'Оберіть постачальника';
    if (!DOC_TYPES[e.docType]) return 'Оберіть вид документа';
    if (!String(e.number || '').trim()) return 'Вкажіть номер документа';
    if (!validDate(e.date)) return 'Вкажіть дату документа';
    if (!Number.isInteger(e.amountKop) || e.amountKop <= 0 || e.amountKop > MAX_KOP) return 'Вкажіть суму документа';
    if (e.vatKop && (!Number.isInteger(e.vatKop) || e.vatKop < 0 || e.vatKop >= e.amountKop)) return 'ПДВ має бути меншим за суму';
    if (!validPeriod(e.period)) return 'Вкажіть, за який місяць послуга';
    if (!ITEMS[e.item]) return 'Оберіть статтю витрат';
    const d = String(e.description || '').trim();
    if (d.length < 3 || d.length > 300) return 'Опишіть, за що документ';
    return null;
}

/**
 * Хто затверджує документ. spentKop — уже затверджені документи за
 * цим договором (для разового договору — уся сума, для щомісячного —
 * за той самий місяць).
 */
function approvalLevel(e, contract, spentKop, settings = {}) {
    if (contract) {
        if (!contractActive(contract, e.date)) return { level: 'chair', reason: 'договір не затверджено або він не діє на дату документа' };
        const limit = contract.type === 'monthly' ? contract.monthlyKop : contract.amountKop;
        if (spentKop + e.amountKop > limit) {
            return { level: 'chair', reason: `понад суму договору: ${fromKop(spentKop + e.amountKop)} з ${fromKop(limit)} грн${contract.type === 'monthly' ? ' за місяць' : ''}` };
        }
        return { level: 'accountant', reason: `за договором № ${contract.number}` };
    }
    if (e.amountKop <= (settings.smallKop || 0)) return { level: 'accountant', reason: 'дрібна витрата без договору' };
    return { level: 'chair', reason: 'без договору' };
}

const remaining = e => e.amountKop - (e.paidKop || 0);

/**
 * Списання → документ витрат. Постачальника шукаємо за кодом або
 * IBAN, документ — серед затверджених і ще не сплачених. Рівно один
 * документ з тією самою сумою до сплати — привʼязуємо самі; інакше
 * це лише підказки для людини.
 */
function matchExpense(tx, expenses, suppliers) {
    if (tx.direction !== 'out') return { auto: null, suggestions: [] };
    const code = String(tx.counterparty?.code || '').trim();
    const iban = normIban(tx.counterparty?.account);
    const ids = new Set(suppliers.filter(s => (code && s.code === code) || (iban && normIban(s.iban) === iban)).map(s => s.id));
    if (!ids.size) return { auto: null, suggestions: [] };
    const open = expenses.filter(e => ids.has(e.supplierId) && e.status === 'approved' && remaining(e) > 0);
    const exact = open.filter(e => remaining(e) === tx.amountKop);
    if (exact.length === 1) return { auto: exact[0].id, suggestions: [exact[0].id] };
    return { auto: null, suggestions: (exact.length ? exact : open).slice(0, 5).map(e => e.id) };
}

/** Призначення платежу за документом. */
function purposeFor(e) {
    const vat = e.vatKop ? `, у т.ч. ПДВ ${fromKop(e.vatKop).toFixed(2)} грн` : ', без ПДВ';
    const text = `Оплата за ${DOC_GEN[e.docType] || 'документом'} № ${String(e.number).trim()} від ${humanDate(e.date)}, ${String(e.description).trim()}`;
    return (text.slice(0, 380 - vat.length) + vat).replace(/\s+/g, ' ');
}

/**
 * Щомісячні договори, по яких бракує документа за минулий місяць
 * (після 5-го числа): система нагадує внести акт.
 */
function missingDocs(contracts, expenses, today) {
    if (Number(today.slice(8, 10)) < 5) return [];
    const [y, m] = today.split('-').map(Number);
    const prev = m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
    const lastDay = `${prev}-31`;
    return contracts
        .filter(c => c.type === 'monthly' && c.status === 'approved' && c.validFrom <= lastDay && (!c.validTo || c.validTo >= `${prev}-01`))
        .filter(c => !expenses.some(e => e.contractId === c.id && e.period === prev && !['rejected', 'canceled'].includes(e.status)))
        .map(c => ({ contractId: c.id, period: prev }));
}

module.exports = {
    CONTRACT_LIMIT_KOP, ITEMS, DOC_TYPES, SUPPLIER_KINDS,
    validEdrpou, validRnokpp, validDate, validPeriod, humanDate, monthsBetween,
    checkSupplier, supplierWarnings, contractTotal, checkContract, contractActive,
    checkExpense, approvalLevel, remaining, matchExpense, purposeFor, missingDocs
};
