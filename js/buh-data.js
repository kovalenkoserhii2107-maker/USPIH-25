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
    rent: 'Оренда', interest: 'Відсотки банку', grant: 'Грант, співфінансування', refund: 'Повернення коштів', other: 'Інше надходження'
};
export const EXPENSE_CATEGORIES = {
    bank_fee: 'Комісія банку', salary: 'Зарплата', taxes: 'Податки й внески', other: 'Витрата'
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
