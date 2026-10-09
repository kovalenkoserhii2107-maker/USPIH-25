'use strict';
// ============================================================
// ПриватБанк, API «Автоклієнт» (acp.privatbank.ua): виписка й залишки.
//
// Токен створюється в Приват24 для бізнесу (Інтеграція (Автоклієнт) →
// додаток типу API). Модуль лише читає: жодного виклику, що створює
// платіж, тут немає й не буде. Навіть створений через API платіж банк
// не проводить без підпису КЕП у кабінеті.
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
        final: raw.FL_REAL === 'r' && raw.PR_PR === 'r',
        // Сторнована чи забракована — її ніби й не було.
        void: raw.PR_PR === 't' || raw.PR_PR === 'n'
    };
}

function normalizeBalance(raw) {
    const iban = normIban(raw.acc);
    if (!iban) return null;
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
    if (res.status === 401) throw new Error('Токен недійсний або відкликаний');
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
        out.push(...(body[key] || []));
        // exist_next_page буває і булевим, і рядком 'true'.
        if (String(body.exist_next_page) !== 'true' || !body.next_page_id || seen.has(body.next_page_id)) break;
        seen.add(body.next_page_id);
        followId = body.next_page_id;
    }
    return out;
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
    return rows.map(normalizeBalance).filter(Boolean);
}

/** Операції рахунку за період, нормалізовані. Неостаточні пропускаємо — підхопимо наступного разу. */
async function fetchTransactions(token, { iban, from, to }) {
    const rows = await pages(token, '/transactions', { acc: iban, startDate: apiDate(from), endDate: apiDate(to) }, 'transactions');
    // Рахунок беремо з запиту: у старих відповідях AUT_MY_ACC — не IBAN.
    return rows.map(normalizeTransaction).filter(t => t && t.final && !t.void).map(t => ({ ...t, account: normIban(iban) }));
}

module.exports = { apiDate, parseBankDate, normalizeTransaction, normalizeBalance, isReady, fetchBalances, fetchTransactions };
