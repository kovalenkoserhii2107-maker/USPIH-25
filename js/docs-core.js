// ============================================================
// «Документи»: вкладки, позначки стану й підказки для рахунків, актів і
// накладних. Тут немає ні мережі, ні DOM: тести —
// tests/unit/docs-core.test.mjs.
//
// «Витрати» — те, що ще потребує дії (затвердити, сплатити, виправити);
// «Архів» — оплачене, підтвердні документи, сторно й скасоване.
// ============================================================

export const TABS = { work: 'Витрати', archive: 'Архів', contracts: 'Договори', suppliers: 'Постачальники' };

const LIVE = ['pending', 'approved', 'paid'];

/** Скільки ще сплатити за документом (з урахуванням сторно й оплат). */
export const remaining = e => e.amountKop - (e.stornoKop || 0) - (e.paidKop || 0);

/** Вкладка документа. */
export function bucketOf(e) {
    if (e.status === 'pending' || e.status === 'rejected') return 'work';
    if (e.status === 'approved' && remaining(e) > 0) return 'work';
    return 'archive';
}

/**
 * Позначка стану: [текст, клас]. Жовтим — що чекає дії того, хто дивиться;
 * paying — платіж уже в Приват24 на підписі голови.
 */
export function chipOf(e, { chair = false, paying = false } = {}) {
    if (e.status === 'pending') return chair ? ['Затвердити', 'is-work'] : ['Чекає голову', ''];
    if (e.status === 'approved') {
        if (remaining(e) <= 0) return ['Сторновано', ''];
        if (paying) return ['На підписі', ''];
        return [e.paidKop > 0 ? 'Доплатити' : 'Сплатити', 'is-work'];
    }
    return {
        paid: ['Оплачено', 'is-done'], rejected: ['Відхилено', 'is-bad'], linked: ['Підтвердний', ''],
        storno: ['Сторно', 'is-bad'], canceled: ['Скасовано', 'is-locked']
    }[e.status] || [e.status, ''];
}

/** Документи вкладки з пошуком: спершу ті, що чекають дії, далі — від новіших. */
export function filterDocs(list, tab = 'work', query = '') {
    const q = String(query).trim().toLowerCase();
    const rank = e => (e.status === 'pending' ? 0 : e.status === 'approved' ? 1 : 2);
    return list.filter(e => bucketOf(e) === tab && (!q || `${e.supplierName} ${e.number} ${e.description}`.toLowerCase().includes(q)))
        .sort((a, b) => (tab === 'work' ? rank(a) - rank(b) : 0) || String(b.date).localeCompare(String(a.date)));
}

/** Лічильники вкладок документів (скасовані в архіві не рахуємо). */
export function docCounts(list) {
    return {
        work: list.filter(e => bucketOf(e) === 'work').length,
        archive: list.filter(e => bucketOf(e) === 'archive' && e.status !== 'canceled').length
    };
}

/**
 * Основні документи того самого постачальника, до яких можна привʼязати
 * doc як підтвердний (рахунок і акт однієї послуги — одна витрата).
 */
export function mainsFor(doc, expenses) {
    return expenses.filter(x => x.id !== doc.id && x.supplierId === doc.supplierId && LIVE.includes(x.status) && !x.linkedTo
        && x.amountKop > 0 && x.amountKop >= (doc.amountKop || 0));
}

/**
 * Схожий документ тієї самої послуги: той самий постачальник, місяць і
 * сума, інший вид документа (рахунок ↔ акт). Тоді пропонуємо обʼєднати.
 */
export function twinOf(doc, expenses) {
    if (!['pending', 'approved', 'rejected'].includes(doc.status) || doc.paidKop > 0 || doc.linkedIds?.length || doc.stornoIds?.length) return null;
    return mainsFor(doc, expenses).find(x => x.period === doc.period && x.amountKop === doc.amountKop && x.docType !== doc.docType) || null;
}

/** Як показати файл: зображення — картинкою, PDF — вбудовано, решта — посиланням. */
export function scanKind(file) {
    const type = String(file?.type || '').toLowerCase();
    const name = String(file?.name || '').toLowerCase();
    if (type.startsWith('image/') || /\.(jpe?g|png|webp|gif)$/.test(name)) return 'image';
    if (type === 'application/pdf' || name.endsWith('.pdf')) return 'pdf';
    return 'file';
}

const normIban = v => String(v || '').replace(/\s+/g, '').toUpperCase();

/**
 * IBAN постачальників, яким платимо за документами: є затверджений
 * щомісячний договір або документ, ще не оплачений повністю (затверджений
 * чи на затвердженні, зокрема з платежем у дорозі). Таким отримувачам
 * регулярний платіж «за історією» не пропонуємо — інакше одну послугу
 * сплатять двічі: за документом і регулярною пропозицією.
 */
export function paidByDocuments(ex) {
    if (!ex) return new Set();
    const ibanOf = id => normIban(ex.suppliers?.find(s => s.id === id)?.iban);
    const ids = new Set([
        ...(ex.contracts || []).filter(c => c.status === 'approved' && c.type === 'monthly').map(c => c.supplierId),
        ...(ex.expenses || []).filter(e => ['pending', 'approved'].includes(e.status) && remaining(e) > 0).map(e => e.supplierId)
    ]);
    return new Set([...ids].map(ibanOf).filter(Boolean));
}

/** Чи пропозицію отримувачу закриває оплата за документами. */
export const coveredByDocuments = (proposal, ibans) => ibans.has(normIban(proposal?.recipient?.iban));

// ------------------------------------------------------------
// Підсумки розділу, стан договору й картка постачальника
// ------------------------------------------------------------
const SPENT = ['approved', 'paid'];

/**
 * Картки вгорі розділу: що затвердити, що сплатити, що на підписі,
 * скільки оплачено цього місяця. paying — id документів з платежем у Приват24.
 */
export function docKpis(expenses, { paying = new Set(), today = '' } = {}) {
    const sum = list => list.reduce((s, e) => s + Math.max(0, remaining(e)), 0);
    const pending = expenses.filter(e => e.status === 'pending');
    const toPay = expenses.filter(e => e.status === 'approved' && remaining(e) > 0 && !paying.has(e.id));
    const signing = expenses.filter(e => e.status === 'approved' && remaining(e) > 0 && paying.has(e.id));
    const month = String(today).slice(0, 7);
    const paidMonth = expenses.filter(e => e.status === 'paid' && String(e.paidAt || e.date || '').slice(0, 7) === month);
    return {
        pending: { n: pending.length, kop: pending.reduce((s, e) => s + e.amountKop, 0) },
        toPay: { n: toPay.length, kop: sum(toPay) },
        signing: { n: signing.length, kop: sum(signing) },
        paidMonth: { n: paidMonth.length, kop: paidMonth.reduce((s, e) => s + e.amountKop - (e.stornoKop || 0), 0) }
    };
}

const addDays = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);

/**
 * Стан договору: pending (чекає голову) · rejected · future (ще не почав
 * діяти) · ending (закінчується протягом 30 днів) · active · ended.
 */
export function contractState(c, today) {
    if (c.status === 'pending') return 'pending';
    if (c.status === 'rejected') return 'rejected';
    if (c.validFrom && c.validFrom > today) return 'future';
    if (c.validTo && c.validTo < today) return 'ended';
    if (c.validTo && c.validTo <= addDays(today, 30)) return 'ending';
    return 'active';
}

export const CONTRACT_STATES = {
    pending: ['Чекає голову', 'is-work'], rejected: ['Відхилено', 'is-bad'], future: ['Ще не діє', ''],
    ending: ['Закінчується', 'is-work'], active: ['Діє', 'is-done'], ended: ['Завершено', 'is-locked']
};

/** Скільки місяців договору минуло в межах року today (для щомісячного — очікувана сума). */
function monthsElapsed(c, today) {
    const year = today.slice(0, 4);
    const from = [c.validFrom || c.date || `${year}-01-01`, `${year}-01-01`].sort().at(-1).slice(0, 7);
    const to = [c.validTo || '9999-12-31', today].sort()[0].slice(0, 7);
    if (to < from) return 0;
    return (Number(to.slice(0, 4)) - Number(from.slice(0, 4))) * 12 + Number(to.slice(5, 7)) - Number(from.slice(5, 7)) + 1;
}

/**
 * Виконання договору: документи за ним, витрачено (затверджене й оплачене,
 * без сторно), сплачено, очікувано (щомісячний — за минулі місяці року;
 * разовий — уся сума) і частка часу дії, що минула.
 */
export function contractUsage(c, expenses, today) {
    const docs = expenses.filter(e => e.contractId === c.id && !['canceled', 'rejected'].includes(e.status));
    const live = docs.filter(e => SPENT.includes(e.status) && !e.linkedTo);
    const spentKop = live.reduce((s, e) => s + e.amountKop - (e.stornoKop || 0), 0);
    const paidKop = live.reduce((s, e) => s + (e.status === 'paid' ? e.amountKop - (e.stornoKop || 0) : e.paidKop || 0), 0);
    const expectedKop = c.type === 'monthly' ? (c.monthlyKop || 0) * monthsElapsed(c, today) : c.amountKop || 0;
    let timePct = null;
    if (c.validFrom && c.validTo && c.validTo > c.validFrom) {
        const span = Date.parse(c.validTo) - Date.parse(c.validFrom);
        timePct = Math.max(0, Math.min(100, Math.round((Date.parse(today) - Date.parse(c.validFrom)) / span * 100)));
    }
    const periods = docs.map(e => e.period).filter(Boolean).sort();
    return { docs: docs.length, spentKop, paidKop, expectedKop, timePct, lastPeriod: periods.at(-1) || '' };
}

/** Картка постачальника: документи, витрачено цього року, борг (затверджене й не сплачене), договори, останній документ. */
export function supplierStats(s, expenses, contracts, today) {
    const year = String(today).slice(0, 4);
    const docs = expenses.filter(e => e.supplierId === s.id && e.status !== 'canceled');
    const spentYearKop = docs.filter(e => SPENT.includes(e.status) && !e.linkedTo && String(e.date).startsWith(year))
        .reduce((s2, e) => s2 + e.amountKop - (e.stornoKop || 0), 0);
    const debtKop = docs.filter(e => e.status === 'approved').reduce((s2, e) => s2 + Math.max(0, remaining(e)), 0);
    const own = contracts.filter(c => c.supplierId === s.id);
    const activeContracts = own.filter(c => ['active', 'ending'].includes(contractState(c, today))).length;
    const dates = docs.map(e => e.date).filter(Boolean).sort();
    return { docs: docs.length, pending: docs.filter(e => e.status === 'pending').length, spentYearKop, debtKop, contracts: own.length, activeContracts, lastDate: dates.at(-1) || '' };
}

/** Що варто перевірити в картці постачальника: [{ level: 'bad'|'warn', text }]. */
export function supplierFlags(s) {
    const out = [];
    if (!s.iban) out.push({ level: 'bad', text: 'немає IBAN — платіж не створиться' });
    if (Number(s.taxDebtTotal || 0) > 0) out.push({ level: 'bad', text: `податковий борг ${s.taxDebtTotal} грн` });
    if (Number(s.openPenalties || 0) > 0) out.push({ level: 'warn', text: `відкритих виконавчих проваджень: ${s.openPenalties}` });
    if (/припинен|банкрут|скасовано/i.test(s.registrationStatus || '') && !/не перебуває/i.test(s.registrationStatus || '')) out.push({ level: 'bad', text: `стан у ЄДР: ${s.registrationStatus}` });
    if (s.kind === 'fop' && !s.fopChecked) out.push({ level: 'warn', text: 'ФОП: звірте КВЕД з послугою (п. 177.8 ПКУ)' });
    if (s.kind === 'person') out.push({ level: 'warn', text: 'фізособа без ФОП — лише договір ЦПД через «Зарплату»' });
    return out;
}
