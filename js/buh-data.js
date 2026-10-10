// ============================================================
// Дані кабінету бухгалтера: один кеш на всі розділи.
//
// Огляд, «Вхідні» й «Банк» показують ті самі операції — читаємо їх
// раз, а після кожної дії (через серверну функцію) скидаємо кеш і
// кажемо розділам перемалюватись. Клієнт у bank_* нічого не пише:
// правила це забороняють, усе йде через bankAction.
// ============================================================
import { db } from './firebase.js';
import {
    collection, doc, getDoc, getDocs, query, where, orderBy, limit, startAfter, Timestamp
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { callBackend } from './backend.js';
import { fetchDirectory, invalidateDirectory } from './directory.js';
import { formatMoney } from './ui.js';

export const ACCOUNT_PURPOSES = {
    current: 'Поточний', repair: 'Ремонтний фонд', reserve: 'Резервний фонд', deposit: 'Депозит', grant: 'Грантовий'
};
export const INCOME_CATEGORIES = {
    rent: 'Оренда приміщень', equipment: 'Розміщення обладнання й реклами', interest: 'Відсотки банку', grant: 'Грант, співфінансування', refund: 'Повернення коштів', other: 'Інше надходження'
};
export const EXPENSE_CATEGORIES = {
    bank_fee: 'Комісія банку', salary: 'Зарплата', taxes: 'Податки (ПДФО, військовий збір)', esv: 'ЄСВ', other: 'Витрата'
};
export const METHOD = {
    account: 'за особовим рахунком', marked: 'за номером квартири', link: 'за запамʼятованим платником', manual: 'вручну'
};

// ------------------------------------------------------------
// ФОРМАТИ
// ------------------------------------------------------------
export const money = kop => `${kop < 0 ? '−' : ''}${formatMoney(kop / 100)} грн`;
export const signed = tx => `${tx.direction === 'out' ? '−' : '+'}${formatMoney(tx.amountKop / 100)}`;
const toDate = ts => ts?.toDate ? ts.toDate() : new Date(ts);
export const when = ts => toDate(ts).toLocaleString('uk-UA', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
export const dateOnly = ts => toDate(ts).toLocaleDateString('uk-UA', { day: '2-digit', month: '2-digit', year: 'numeric' });
export const maskIban = iban => iban ? `${iban.slice(0, 4)} … ${iban.slice(-4)}` : '';

/** Короткий ярлик рішення щодо операції. */
export function tagOf(tx) {
    if (tx.status === 'review') return { text: 'Чекає рішення', cls: 'is-review' };
    if (tx.kind === 'payment') {
        const apts = (tx.allocations || []).map(a => a.apt);
        return { text: apts.length ? `кв. ${apts.join(', ')}` : 'Внесок', cls: 'is-payment' };
    }
    if (tx.kind === 'internal') return { text: 'Між рахунками', cls: 'is-internal' };
    if (tx.kind === 'income') return { text: INCOME_CATEGORIES[tx.category] || 'Надходження', cls: 'is-income' };
    return { text: EXPENSE_CATEGORIES[tx.category] || 'Витрата', cls: 'is-expense' };
}

// ------------------------------------------------------------
// ЧИТАННЯ
// ------------------------------------------------------------
let cache = {};
const listeners = new Set();

/** Розділи підписуються, щоб перемалюватися після будь-якої дії. */
export function onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
export function invalidate() { cache = {}; listeners.forEach(fn => fn()); }

const once = (key, load) => (cache[key] ||= load().catch(error => { delete cache[key]; throw error; }));

export const loadSettings = () => once('settings', async () => {
    const snap = await getDoc(doc(db, 'bank', 'settings'));
    return snap.exists() ? snap.data() : {};
});

/** Усе, що чекає рішення людини. Без orderBy — не потрібен складений індекс. */
export const loadQueue = () => once('queue', async () => {
    const snap = await getDocs(query(collection(db, 'bank_tx'), where('status', '==', 'review'), limit(300)));
    return snap.docs.map(d => ({ id: d.id, ...d.data() }))
        .sort((a, b) => (b.at?.toMillis?.() || 0) - (a.at?.toMillis?.() || 0));
});

/** Операції від дати (для підсумків місяця). */
export function loadSince(date) {
    return once(`since:${date.toISOString()}`, async () => {
        const snap = await getDocs(query(collection(db, 'bank_tx'), where('at', '>=', Timestamp.fromDate(date)), orderBy('at', 'desc'), limit(1000)));
        return snap.docs.map(d => ({ id: d.id, ...d.data() }));
    });
}

/** Сторінка журналу операцій. */
export async function loadPage(after = null, size = 80) {
    const parts = [collection(db, 'bank_tx'), orderBy('at', 'desc')];
    if (after) parts.push(startAfter(after));
    parts.push(limit(size));
    const snap = await getDocs(query(...parts));
    return { rows: snap.docs.map(d => ({ id: d.id, ...d.data() })), last: snap.docs[snap.docs.length - 1] || null, full: snap.docs.length === size };
}

export const loadDirectory = () => once('directory', () => fetchDirectory().catch(() => []));

/** Імʼя першого власника квартири — для підказок. */
export async function ownerOf(apt) {
    const dir = await loadDirectory();
    return dir.find(a => a.apt === apt)?.owners?.[0]?.name || '';
}

// ------------------------------------------------------------
// ДІЇ
// ------------------------------------------------------------
/** Будь-яка дія з банком: на сервері, з журналом. Після неї — свіжі дані. */
export async function act(payload, timeoutMs) {
    try {
        return await callBackend('bankAction', payload, timeoutMs);
    } finally {
        if (payload.action === 'assign' || payload.action === 'unassign') invalidateDirectory();
        invalidate();
    }
}

// ------------------------------------------------------------
// ПЛАТЕЖІ
// ------------------------------------------------------------
export const PAYMENT_KINDS = { supplier: 'Постачальнику', tax: 'Податок, ЄСВ', salary: 'Зарплата', other: 'Інше' };
export const PAYMENT_STATUS = {
    sending: ['Відправляється', 'is-review'], sent: ['Чекає підпису голови', 'is-review'], paid: ['Проведено', 'is-payment'],
    failed: ['Банк не прийняв', 'is-error'], canceled: ['Скасовано', '']
};

/** Платежі, найновіші вгорі. */
export const loadPayments = () => once('payments', async () => {
    const snap = await getDocs(query(collection(db, 'payments'), orderBy('createdAt', 'desc'), limit(200)));
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
});

/** Пропозиції системи (регулярні платежі), довідник отримувачів і рахунки — із сервера. */
export const loadPaymentContext = () => once('paymentContext', () =>
    callBackend('paymentAction', { action: 'context' }).catch(() => ({ proposals: [], recipients: [], accounts: [] })));

/** Пропозиції, які людина відклала «не цього місяця», — лише на цьому пристрої. */
const SKIP_KEY = 'buh_skipped_proposals';
export const skippedProposals = () => { try { return new Set(JSON.parse(localStorage.getItem(SKIP_KEY) || '[]')); } catch { return new Set(); } };
export function skipProposal(key) {
    const set = skippedProposals();
    set.add(key);
    try { localStorage.setItem(SKIP_KEY, JSON.stringify([...set].slice(-200))); } catch { /* лише зручність */ }
    invalidate();
}

/** Дія з платежем — на сервері, з журналом і сповіщенням голові. */
export async function payAct(payload) {
    try {
        return await callBackend('paymentAction', payload, 60000);
    } finally {
        invalidate();
    }
}

// ------------------------------------------------------------
// НАРАХУВАННЯ
// ------------------------------------------------------------
/** Тарифи, приміщення, вхідні залишки, нараховані місяці й готове нарахування — із сервера. */
export const loadCharges = () => once('charges', () => callBackend('chargesAction', { action: 'context' }));

/** Відомість розрахунків з мешканцями за місяць. */
export const loadStatement = period => once(`statement:${period}`, () => callBackend('chargesAction', { action: 'statement', period }));

/** Реквізити ОСББ для квитанцій (ті самі, що бачить мешканець у «Сплатити»). */
export const loadRequisites = () => once('requisites', async () => {
    const snap = await getDoc(doc(db, 'osbb_settings', 'finance'));
    return snap.exists() ? snap.data() : {};
});

/** Дія з нарахуваннями — на сервері, з журналом; після неї баланси й історія свіжі. */
export async function chargeAct(payload, timeoutMs = 120000) {
    try {
        return await callBackend('chargesAction', payload, timeoutMs);
    } finally {
        invalidateDirectory();
        invalidate();
    }
}

// ------------------------------------------------------------
// ВИТРАТИ Й ДОГОВОРИ
// ------------------------------------------------------------
export const EXPENSE_STATUS = {
    pending: ['Чекає голову', 'is-review'], approved: ['До оплати', 'is-income'], paid: ['Оплачено', 'is-payment'],
    rejected: ['Відхилено', 'is-error'], canceled: ['Скасовано', '']
};
export const CONTRACT_STATUS = { pending: ['Чекає голову', 'is-review'], approved: ['Затверджено', 'is-payment'], rejected: ['Відхилено', 'is-error'] };

/** Постачальники, договори, документи, поріг і нагадування — із сервера. */
export const loadExpenses = () => once('expenses', () => callBackend('expenseAction', { action: 'context' }));

/** Дія з витратами — на сервері, з журналом; голові — push, коли потрібне його рішення. */
export async function expAct(payload, timeoutMs = 60000) {
    try {
        return await callBackend('expenseAction', payload, timeoutMs);
    } finally {
        invalidate();
    }
}

/** Файли документа — у сховище (теку expenses/); у базу їх записує сервер. */
export async function uploadExpenseFiles(files) {
    const { storage } = await import('./firebase.js');
    const { ref, uploadBytes, getDownloadURL } = await import('https://www.gstatic.com/firebasejs/10.14.1/firebase-storage.js');
    const month = new Date().toISOString().slice(0, 7);
    const out = [];
    for (const file of files) {
        if (file.size > 20 * 1024 * 1024) throw new Error(`${file.name}: файл понад 20 МБ`);
        const path = `expenses/${month}/${Date.now()}_${file.name.replace(/[^\wа-яіїєґ.\-]+/gi, '_').slice(-80)}`;
        const fileRef = ref(storage, path);
        await uploadBytes(fileRef, file, { contentType: file.type || 'application/octet-stream' });
        out.push({ name: file.name, url: await getDownloadURL(fileRef), path, size: file.size, type: file.type || '' });
    }
    return out;
}

// ------------------------------------------------------------
// КОШТОРИС
// ------------------------------------------------------------
/** Кошторис року, план/факт, борг будинку й стан звіту для мешканців — із сервера. */
export const loadBudget = year => once(`budget:${year}`, () => callBackend('budgetAction', { action: 'context', year }));

/** Дія з кошторисом — на сервері, з журналом. */
export async function budgetAct(payload, timeoutMs = 60000) {
    try {
        return await callBackend('budgetAction', payload, timeoutMs);
    } finally {
        invalidate();
    }
}

// ------------------------------------------------------------
// ПРОВОДКИ Й ЗАКРИТТЯ МІСЯЦЯ
// ------------------------------------------------------------
/** Оборотно-сальдова, проводки й перевірки за місяць (null — місяць, який пропонує сервер). */
export const loadJournal = period => once(`journal:${period || ''}`, () => callBackend('journalAction', { action: 'context', period: period || null }, 90000));

/** Закрити чи відкрити місяць — на сервері, з журналом дій. */
export async function journalAct(payload) {
    try {
        return await callBackend('journalAction', payload, 90000);
    } finally {
        invalidate();
    }
}

// ------------------------------------------------------------
// ДЕМО-ПРОГІН (тестовий акаунт)
// ------------------------------------------------------------
export const loadDemo = () => once('demo', () => callBackend('demoAction', { action: 'status' }).catch(() => null));
export async function demoAct(action, extra = {}) {
    try {
        return await callBackend('demoAction', { action, ...extra }, 540000);
    } finally {
        invalidateDirectory();
        invalidate();
    }
}
