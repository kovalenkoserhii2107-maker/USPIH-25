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
