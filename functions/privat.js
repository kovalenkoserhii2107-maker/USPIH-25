'use strict';
// ============================================================
// ПриватБанк, API «Автоклієнт» (acp.privatbank.ua): виписка й залишки.
//
// Токен створюється в Приват24 для бізнесу (Інтеграція (Автоклієнт) →
// додаток типу API). Модуль читає виписку й створює чернетки платежів.
// Банк не проводить їх без підпису КЕП у кабінеті.
//
// Опис API v3: https://api.privatbank.ua/ → «Опис API для взаємодії з
// серверною частиною Автоклієнта». Ключові правила звідти:
//   • унікальність операції — конкатенація REF + REFN;
//   • операція остаточна, коли FL_REAL = r і PR_PR = r
//     (p — проводиться, t — сторнована, n — забракована);
//   • запити можна робити, коли /settings: phase = WRK, work_balance = N;
//   • без charset=utf8 відповідь приходить у cp1251.
//
// Відповідь банку розбирає normalizeTransaction — окремо від мережі,
// щоб формат перевіряли тести (functions/privat.test.js).
// ============================================================
const { toKop, normIban } = require('./bank-core');

const BASE = 'https://acp.privatbank.ua/api/statements';
const PAGE = 100;
const MAX_PAGES = 50;

/** «09-10-2026» — формат дат у запитах Автоклієнта. */
function apiDate(date) {
    const parts = new Intl.DateTimeFormat('uk-UA', { timeZone: 'Europe/Kyiv', day: '2-digit', month: '2-digit', year: 'numeric' })
        .formatToParts(date);
    const get = type => parts.find(p => p.type === type).value;
    return `${get('day')}-${get('month')}-${get('year')}`;
}

/** «09.10.2026 14:05:31» або «09.10.2026» + «14:05» → Date (київський час). */
function parseBankDate(dateTime, date, time) {
    const source = String(dateTime || '').trim() || `${String(date || '').trim()} ${String(time || '00:00').trim()}`;
    const m = source.match(/^(\d{2})\.(\d{2})\.(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
    if (!m) return null;
    const [, dd, mm, yyyy, hh = '0', mi = '0', ss = '0'] = m;
    if (+hh > 23 || +mi > 59 || +ss > 59 || +mm < 1 || +mm > 12 || +dd < 1 || +dd > new Date(Date.UTC(+yyyy, +mm, 0)).getUTCDate()) return null;
    // Київ: +02:00 взимку, +03:00 влітку. Визначаємо зсув для цієї дати.
    const guess = new Date(Date.UTC(+yyyy, +mm - 1, +dd, +hh, +mi, +ss));
    const kyiv = new Date(guess.toLocaleString('en-US', { timeZone: 'Europe/Kyiv' }));
    const utc = new Date(guess.toLocaleString('en-US', { timeZone: 'UTC' }));
    return new Date(guess.getTime() - (kyiv - utc));
}

/**
 * Операція банку → формат bank.js.
 * TRANTYPE: C — надходження (кредит), D — списання (дебет).
 * FL_REAL: r — проведена; інші значення — ще не остаточна.
 */
function normalizeTransaction(raw) {
    const direction = raw.TRANTYPE === 'C' ? 'in' : raw.TRANTYPE === 'D' ? 'out' : null;
    const amountKop = Math.abs(toKop(raw.SUM));
    const at = parseBankDate(raw.DATE_TIME_DAT_OD_TIM_P, raw.DAT_OD || raw.DAT_KL, raw.TIM_P);
    const bankId = raw.REF ? `${raw.REF}_${raw.REFN || 0}` : (raw.ID || null);
    if (!direction || !Number.isInteger(amountKop) || !amountKop || !at || !bankId) return null;
    return {
        bankId: String(bankId),
        account: normIban(raw.AUT_MY_ACC),
        at, direction, amountKop,
        currency: raw.CCY || 'UAH',
        purpose: String(raw.OSND || '').trim(),
        counterparty: {
            name: String(raw.AUT_CNTR_NAM || '').trim(),
            account: normIban(raw.AUT_CNTR_ACC),
            code: String(raw.AUT_CNTR_CRF || '').trim()
        },
        // Референс пачки для платежів, створених через API (payment_pack_ref).
        dlr: raw.DLR ? String(raw.DLR) : null,
        final: raw.FL_REAL === 'r' && raw.PR_PR === 'r',
        // Сторнована чи забракована — її ніби й не було.
        void: raw.PR_PR === 't' || raw.PR_PR === 'n'
    };
}

function normalizeBalance(raw) {
    const iban = normIban(raw.acc);
    if (!iban || !Number.isSafeInteger(toKop(raw.balanceOut ?? raw.balanceIn))) return null;
    const balance = raw.balanceOut ?? raw.balanceIn;
    return {
        iban, currency: raw.currency || 'UAH', balanceKop: toKop(balance),
        name: String(raw.nameACC || '').trim(), at: new Date()
    };
}

async function call(token, path, params, retry = true) {
    const url = new URL(`${BASE}${path}`);
    Object.entries(params || {}).forEach(([k, v]) => { if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v); });
    const res = await fetch(url, {
        headers: { 'User-Agent': 'OSBB-Uspih-25', token, 'Content-Type': 'application/json;charset=utf8' },
        signal: AbortSignal.timeout(30000)
    });
    if (res.status === 429 && retry) {
        const wait = Math.min(30, Number(res.headers.get('Retry-After')) || 5);
        await new Promise(resolve => setTimeout(resolve, wait * 1000));
        return call(token, path, params, false);
    }
    if (res.status === 401) throw Object.assign(new Error('Токен недійсний або відкликаний'), { bankRejected: true });
    const text = await res.text();
    let body;
    try { body = JSON.parse(text); } catch { throw new Error(`Банк повернув не JSON (HTTP ${res.status})`); }
    if (!res.ok || (body.status && body.status !== 'SUCCESS')) {
        const message = body.message || body.error || body.status || `HTTP ${res.status}`;
        throw new Error(typeof message === 'string' ? message : JSON.stringify(message).slice(0, 200));
    }
    return body;
}

/** Усі сторінки відповіді (exist_next_page / next_page_id → followId). */
async function pages(token, path, params, key) {
    const out = [];
    const seen = new Set();
    let followId;
    for (let i = 0; i < MAX_PAGES; i++) {
        const body = await call(token, path, { ...params, limit: PAGE, followId });
        if (!Array.isArray(body[key])) throw new Error('Банк повернув некоректний список операцій або залишків');
        out.push(...body[key]);
        // exist_next_page буває і булевим, і рядком 'true'.
        if (String(body.exist_next_page) !== 'true') return out;
        if (!body.next_page_id || seen.has(body.next_page_id)) throw new Error('Банк повернув неповну виписку: сторінка повторюється або відсутня');
        seen.add(body.next_page_id);
        followId = body.next_page_id;
    }
    throw new Error('Виписка перевищує ліміт сторінок: синхронізацію не завершено');
}

/**
 * Чи можна зараз питати банк. У нічний регламент (phase ≠ WRK або
 * work_balance = Y) запити повертають помилки — тоді просто чекаємо
 * наступної години.
 */
async function isReady(token) {
    const body = await call(token, '/settings');
    const settings = body.settings || {};
    return settings.phase === 'WRK' && settings.work_balance !== 'Y';
}

/** Поточні залишки всіх рахунків, до яких має доступ токен. */
async function fetchBalances(token) {
    const today = apiDate(new Date());
    const rows = await pages(token, '/balance', { startDate: today, endDate: today }, 'balances');
    const balances = rows.map(normalizeBalance);
    if (balances.some(b => !b)) throw new Error('Банк повернув некоректний залишок рахунку: синхронізацію не завершено');
    return balances;
}

/** Операції рахунку за період, нормалізовані. Неостаточні пропускаємо — підхопимо наступного разу. */
async function fetchTransactions(token, { iban, from, to }) {
    const rows = await pages(token, '/transactions', { acc: iban, startDate: apiDate(from), endDate: apiDate(to) }, 'transactions');
    // Рахунок беремо з запиту: у старих відповідях AUT_MY_ACC — не IBAN.
    return rows.filter(raw => raw.FL_REAL === 'r' && raw.PR_PR === 'r').map(raw => {
        const transaction = normalizeTransaction(raw);
        if (!transaction) throw new Error('Банк повернув некоректну проведену операцію: синхронізацію не завершено');
        return { ...transaction, account: normIban(iban) };
    });
}

// ------------------------------------------------------------
// ПЛАТЕЖІ (POST /api/proxy/payment/…)
// Створений через API платіж має статус new і не рухає гроші, доки
// його не підпише КЕП людина в Приват24 для бізнесу. Підпису через
// API застосунок не робить. У виписці такий платіж має DLR, що
// дорівнює payment_pack_ref — за ним і закриваємо платіж.
// Джерела полів — docs/accounting/research/2026-10-payments.md.
// ------------------------------------------------------------
const PAY_BASE = 'https://acp.privatbank.ua/api/proxy/payment';

async function post(token, path, body) {
    const res = await fetch(`${PAY_BASE}${path}`, {
        method: 'POST',
        headers: { 'User-Agent': 'OSBB-Uspih-25', token, 'Content-Type': 'application/json;charset=utf8' },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(30000)
    });
    if (res.status === 401) throw Object.assign(new Error('Токен недійсний або відкликаний'), { bankRejected: true });
    if (res.status === 204) return {};
    const text = await res.text();
    let data = {};
    try { data = text ? JSON.parse(text) : {}; } catch { throw new Error(`Банк повернув не JSON (HTTP ${res.status})`); }
    if (!res.ok || data.status === 'ERROR') {
        const code = data.serviceCode ? ` (${data.serviceCode})` : '';
        throw Object.assign(new Error(`${data.message || `HTTP ${res.status}`}${code}`), { bankRejected: res.status < 500 && ![408, 429].includes(res.status) });
    }
    return data;
}

/** Поля платежу в форматі Автоклієнта: усі значення — рядки. */
function paymentBody(p, today = new Date()) {
    const date = apiDate(today).replace(/-/g, '.');            // дд.мм.рррр
    return {
        document_number: String(p.docNumber),
        document_type: 'cr',
        payer_account: normIban(p.account),
        recipient_account: normIban(p.recipient.iban),
        recipient_nceo: String(p.recipient.code),
        payment_naming: String(p.recipient.name).slice(0, 140),
        payment_amount: (p.amountKop / 100).toFixed(2),
        payment_destination: String(p.purpose),
        payment_ccy: 'UAH',
        payment_date: date,
        payment_accept_date: date
    };
}

/** Створити платіж; повертає { bankRef (payment_pack_ref), paymentRef (payment_ref), status }. */
async function createPayment(token, p) {
    const data = await post(token, '/create', paymentBody(p));
    const ref = data.payment_ref || data.payment_data?.payment_ref || null;
    const pack = data.payment_pack_ref || data.payment_data?.payment_pack_ref || null;
    if (!ref && !pack) throw new Error('Банк не повернув номер платежу');
    return { bankRef: pack, paymentRef: ref, status: data.payment_data?.payment_status || 'new' };
}

/** Видалити ще не підписаний платіж. true — видалено. */
async function deletePayment(token, paymentRef) {
    if (!paymentRef) return false;
    await post(token, `/delete?ref=${encodeURIComponent(paymentRef)}`);
    return true;
}

module.exports = { apiDate, parseBankDate, normalizeTransaction, normalizeBalance, isReady, fetchBalances, fetchTransactions,
    paymentBody, createPayment, deletePayment };
