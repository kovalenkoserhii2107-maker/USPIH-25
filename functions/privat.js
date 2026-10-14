'use strict';
// ===================================================
// ПриватБанк, API «Автоклієнт» v3.0.0 (acp.privatbank.ua):
//   • виписка й залишки (/api/statements/*: settings, balance, transactions, interim, final);
//   • створення, перевірка статусу підписів, КЕП-підпис та видалення платежів (/api/proxy/payment/*);
//   • податкові платежі на Казначейство (МФО 899998: ліміт 140 символів, struct_code);
//   • отримання офіційних PDF-квитанцій за платежами (/api/paysheets/print_receipt);
//   • перевірка контрагентів і ФОП через ЄДР/УБКІ (/api/ubki/check);
//   • вивантаження XML-звітів ДПС в «Електронну звітність» Приват24 (/api/proxy/eo/documents/create-b64);
//   • електронний документообіг ЕДО (/api/proxy/edoc/*) та корпоративні картки (/api/corpcards/v2/*).
// ===================================================
const { toKop, normIban } = require('./bank-core');

const HOST = 'https://acp.privatbank.ua';
const BASE = `${HOST}/api/statements`;
const PAY_BASE = `${HOST}/api/proxy/payment`;
const EDOC_BASE = `${HOST}/api/proxy/edoc`;
const EO_BASE = `${HOST}/api/proxy/eo`;
const UBKI_URL = `${HOST}/api/ubki/check`;
const RECEIPT_URL = `${HOST}/api/paysheets/print_receipt`;
const CORPCARDS_BASE = `${HOST}/api/corpcards/v2`;

const PAGE = 100;
const MAX_PAGES = 50;
const TREASURY_MFO = '899998';

/** «09-10-2026» — формат дат у запитах Автоклієнта. */
function apiDate(date) {
  if (typeof date === 'string' && /^\d{2}-\d{2}-\d{4}$/.test(date.trim())) {
    return date.trim();
  }
  const d = date instanceof Date ? date : new Date(date);
  const parts = new Intl.DateTimeFormat('uk-UA', { timeZone: 'Europe/Kyiv', day: '2-digit', month: '2-digit', year: 'numeric' })
    .formatToParts(d);
  const get = type => parts.find(p => p.type === type).value;
  return `${get('day')}-${get('month')}-${get('year')}`;
}

/** «09.10.2026» — формат дат із крапками (для платіжних інструкцій та карток). */
function dotDate(date) {
  if (typeof date === 'string' && /^\d{2}\.\d{2}\.\d{4}$/.test(date.trim())) {
    return date.trim();
  }
  return apiDate(date).replace(/-/g, '.');
}

/** «09.10.2026 14:05:31» або «09.10.2026» + «14:05» -> Date (київський час). */
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
 * Операція банку -> формат bank.js.
 * TRANTYPE: C — надходження (кредит), D — списання (дебет).
 * FL_REAL: r — проведена; інші значення — ще не остаточна.
 * Підтримує додаткові поля НБУ кінцевого платника/одержувача (PAYER_ULTMT_*, RECIPIENT_ULTMT_*).
 */
function normalizeTransaction(raw) {
  const direction = raw.TRANTYPE === 'C' ? 'in' : raw.TRANTYPE === 'D' ? 'out' : null;
  const amountKop = Math.abs(toKop(raw.SUM));
  const at = parseBankDate(raw.DATE_TIME_DAT_OD_TIM_P, raw.DAT_OD || raw.DAT_KL, raw.TIM_P);
  const bankId = raw.REF ? `${raw.REF}_${raw.REFN || 0}` : (raw.ID || null);
  if (!direction || !Number.isSafeInteger(amountKop) || !amountKop || !at || !bankId) return null;

  const ultmtName = direction === 'in' ? raw.PAYER_ULTMT_NAME : raw.RECIPIENT_ULTMT_NAME;
  const ultmtCode = direction === 'in' ? raw.PAYER_ULTMT_NCEO : raw.RECIPIENT_ULTMT_NCEO;

  return {
    bankId: String(bankId),
    statementRef: raw.REF ? String(raw.REF) : null,
    statementRefn: raw.REF ? String(raw.REFN || 0) : null,
    account: normIban(raw.AUT_MY_ACC),
    at, direction, amountKop,
    currency: raw.CCY || 'UAH',
    purpose: String(raw.OSND || '').trim(),
    counterparty: {
      name: String(ultmtName || raw.AUT_CNTR_NAM || '').trim(),
      account: normIban(raw.AUT_CNTR_ACC),
      code: String(ultmtCode || raw.AUT_CNTR_CRF || '').trim()
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

async function call(token, path, params, retry = true, baseUrl = BASE) {
  const url = new URL(`${baseUrl}${path}`);
  Object.entries(params || {}).forEach(([k, v]) => { if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v); });
  const res = await fetch(url, {
    headers: { 'User-Agent': 'OSBB-Uspih-25', token, 'Content-Type': 'application/json;charset=utf8' },
    signal: AbortSignal.timeout(30000)
  });
  if (res.status === 429 && retry) {
    const wait = Math.min(30, Number(res.headers?.get?.('Retry-After')) || 5);
    await new Promise(resolve => setTimeout(resolve, wait * 1000));
    return call(token, path, params, false, baseUrl);
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

/** Усі сторінки відповіді (exist_next_page / next_page_id -> followId). */
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
  const settings = body.settings || body || {};
  return settings.phase === 'WRK' && settings.work_balance === 'N';
}

/** Отримання об'єкта серверних дат (/api/statements/settings). */
async function fetchSettings(token) {
  const body = await call(token, '/settings');
  return body.settings || body || {};
}

/** Поточні залишки всіх рахунків, до яких має доступ токен. */
async function fetchBalances(token) {
  const today = apiDate(new Date());
  const rows = await pages(token, '/balance', { startDate: today, endDate: today }, 'balances');
  const balances = rows.map(normalizeBalance);
  if (balances.some(b => !b)) throw new Error('Банк повернув некоректний залишок рахунку: синхронізацію не завершено');
  return balances;
}

function mapStatementRows(rows, iban) {
  return rows.filter(raw => (raw.FL_REAL === 'r' && raw.PR_PR === 'r') || ['t', 'n'].includes(raw.PR_PR)).map(raw => {
    const transaction = normalizeTransaction(raw);
    if (!transaction) throw new Error('Банк повернув некоректну проведену операцію: синхронізацію не завершено');
    return iban ? { ...transaction, account: normIban(iban) } : transaction;
  });
}

/** Операції рахунку за період, нормалізовані. Неостаточні пропускаємо — підхопимо наступного разу. */
async function fetchTransactions(token, { iban, from, to }) {
  const rows = await pages(token, '/transactions', { acc: iban, startDate: apiDate(from), endDate: apiDate(to) }, 'transactions');
  // Рахунок беремо з запиту: у старих відповідях AUT_MY_ACC — не IBAN.
  return mapStatementRows(rows, iban);
}

/** Проміжні транзакції з lastday до today (/api/statements/transactions/interim). */
async function fetchInterimTransactions(token, { iban } = {}) {
  const rows = await pages(token, '/transactions/interim', { acc: iban }, 'transactions');
  return mapStatementRows(rows, iban);
}

/** Підсумкові транзакції за останній закритий опердень (/api/statements/transactions/final). */
async function fetchFinalTransactions(token, { iban } = {}) {
  const rows = await pages(token, '/transactions/final', { acc: iban }, 'transactions');
  return mapStatementRows(rows, iban);
}

// ---------------------------------------------------
// ПЛАТЕЖІ (POST /api/proxy/payment/...)
// ---------------------------------------------------

async function post(token, path, body, options = {}) {
  const {
    baseUrl = PAY_BASE,
    contentType = 'application/json;charset=utf8',
    accept,
    rawResponse = false
  } = options;

  const targetUrl = /^https?:\/\//i.test(path) ? path : `${baseUrl}${path}`;
  const headers = { 'User-Agent': 'OSBB-Uspih-25', token, 'Content-Type': contentType };
  if (accept) headers.Accept = accept;

  const serializedBody = body === undefined || body === null
    ? undefined
    : (typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));

  const res = await fetch(targetUrl, {
    method: 'POST',
    headers,
    body: serializedBody,
    signal: AbortSignal.timeout(30000)
  });
  if (res.status === 401) throw Object.assign(new Error('Токен недійсний або відкликаний'), { bankRejected: true });

  if (rawResponse) {
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`HTTP ${res.status}: ${errText.slice(0, 200)}`);
    }
    const arrayBuffer = await res.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }

  if (res.status === 204) return {};
  const text = await res.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { throw new Error(`Банк повернув не JSON (HTTP ${res.status})`); }
  if (!res.ok || data.status === 'ERROR' || data.result === 'error') {
    const code = data.serviceCode || data.code ? ` (${data.serviceCode || data.code})` : '';
    const msg = data.message || data.error_message || `HTTP ${res.status}`;
    throw Object.assign(new Error(`${msg}${code}`), { bankRejected: res.status < 500 && ![408, 429].includes(res.status) });
  }
  return data;
}

/** Чи є рахунок одержувача бюджетним рахунком Казначейства (МФО 899998). */
function isTreasuryAccount(iban, mfo) {
  if (String(mfo || '').trim() === TREASURY_MFO) return true;
  const clean = normIban(iban);
  return clean.startsWith('UA') && clean.length === 29 && clean.slice(4, 10) === TREASURY_MFO;
}

/**
 * Поля платежу в форматі Автоклієнта v3.0.0: усі значення — рядки.
 * Для податкових платежів на Казначейство (МФО 899998) обмежує призначення до 140 символів
 * та підтримує поля структурованого призначення struct_code, struct_category, struct_type.
 */
function paymentBody(p, today = new Date()) {
  const date = dotDate(today);
  const recipientIban = normIban(p.recipient.iban);
  const recipientMfo = p.recipient?.mfo || p.recipientIfi || '';
  const isTax = Boolean(p.structCode || p.struct_code || isTreasuryAccount(recipientIban, recipientMfo));
  const maxPurposeLen = isTax ? 140 : 420;

  const body = {
    document_number: String(p.docNumber),
    document_type: 'cr',
    payer_account: normIban(p.account),
    recipient_account: recipientIban,
    recipient_nceo: String(p.recipient.code),
    payment_naming: String(p.recipient.name).slice(0, 140),
    payment_amount: (p.amountKop / 100).toFixed(2),
    payment_destination: String(p.purpose).slice(0, maxPurposeLen),
    payment_ccy: 'UAH',
    payment_date: date,
    payment_accept_date: date
  };

  if (recipientMfo) body.recipient_ifi = String(recipientMfo);
  if (p.recipient?.bankName || p.recipientIfiText) {
    body.recipient_ifi_text = String(p.recipient?.bankName || p.recipientIfiText);
  }

  if (p.recipient?.documentIdNumber) {
    body.recipient_document_id_number = String(p.recipient.documentIdNumber);
  } else {
    if (p.recipient?.documentSeries) body.recipient_document_series = String(p.recipient.documentSeries);
    if (p.recipient?.documentNumber) body.recipient_document_number = String(p.recipient.documentNumber);
  }

  const structCode = p.structCode ?? p.struct_code ?? (isTax ? '101' : undefined);
  const structCategory = p.structCategory ?? p.struct_category;
  const structType = p.structType ?? p.struct_type;
  if (structCode !== undefined && structCode !== null && structCode !== '') {
    body.struct_code = String(structCode).slice(0, 3);
  }
  if (structCategory !== undefined && structCategory !== null && structCategory !== '') {
    body.struct_category = String(structCategory).slice(0, 140);
  }
  if (structType !== undefined && structType !== null && structCategory !== '') {
    body.struct_type = String(structType).slice(0, 10);
  } else if (structType !== undefined && structType !== null && structType !== '') {
    body.struct_type = String(structType).slice(0, 10);
  }

  if (p.signerMsg) body.signer_msg = String(p.signerMsg);
  if (p.odbMsg) body.odb_msg = String(p.odbMsg);

  return body;
}

/** Створити платіж; повертає { bankRef (payment_pack_ref), paymentRef (payment_ref), status }. */
async function createPayment(token, p) {
  const endpoint = p?.predict ? '/create_pred' : '/create';
  const data = await post(token, endpoint, paymentBody(p));
  const ref = data.payment_ref || data.payment_data?.payment_ref || null;
  const pack = data.payment_pack_ref || data.payment_data?.payment_pack_ref || null;
  if (!ref && !pack) throw new Error('Банк не повернув номер платежу');
  return { bankRef: pack, paymentRef: ref, status: data.payment_data?.payment_status || 'new' };
}

/** Отримати інформацію за платежем та стан рівнів підпису (GET /api/proxy/payment/get?ref=...). */
async function getPayment(token, paymentRef) {
  if (!paymentRef) throw new Error('Не вказано референс платежу');
  return call(token, '/get', { ref: String(paymentRef) }, true, PAY_BASE);
}

/** Надіслати КЕП-підпис платежу на збереження (POST /api/proxy/payment/add-sign?ref=...). */
async function addPaymentSign(token, paymentRef, signBase64) {
  if (!paymentRef) throw new Error('Не вказано референс платежу');
  if (!signBase64) throw new Error('Не передано BASE64 підпис КЕП');
  return post(token, `/add-sign?ref=${encodeURIComponent(String(paymentRef))}`, { sign: String(signBase64) });
}

/** Видалити ще не підписаний платіж. true — видалено. */
async function deletePayment(token, paymentRef) {
  if (!paymentRef) return false;
  await post(token, `/delete?ref=${encodeURIComponent(paymentRef)}`);
  return true;
}

/**
 * Отримання квитанцій (платіжних інструкцій) за проведеними платежами у PDF-форматі
 * (розд. 11: POST /api/paysheets/print_receipt). За один запит — до 45 транзакцій, perPage: 1..4.
 */
async function printReceiptsPdf(token, transactions, { perPage = 4 } = {}) {
  if (!Array.isArray(transactions) || transactions.length === 0) {
    throw new Error('Передайте масив транзакцій для формування PDF-квитанцій');
  }
  if (transactions.length > 45) {
    throw new Error('За один запит можна отримати не більше 45 платіжних інструкцій');
  }
  const safePerPage = Math.min(4, Math.max(1, Number(perPage) || 4));
  const formatted = transactions.map(t => {
    const account = normIban(t.account || t.iban);
    const reference = String(t.reference || t.statementRef || t.ref || (t.bankId ? String(t.bankId).split('_')[0] : '')).trim();
    const refn = String(t.refn ?? t.statementRefn ?? (t.bankId && String(t.bankId).includes('_') ? String(t.bankId).split('_')[1] : '1')).trim();
    if (!account || !reference) {
      throw new Error('Кожна транзакція для print_receipt повинна мати account та reference (REF)');
    }
    return { account, reference, refn };
  });

  return post(
    token,
    RECEIPT_URL,
    { transactions: formatted, perPage: safePerPage },
    { contentType: 'application/json', accept: 'application/octet-stream', rawResponse: true }
  );
}

/** Розбір досьє контрагента з ЄДР/УБКІ (розд. 10: /api/ubki/check). */
function summarizeCounterpartyDossier(resp) {
  const dossier = resp?.dossier || {};
  const warnings = resp?.warnings || {};
  const foundCode = String(dossier.found ?? '0');

  if (foundCode === '-1') {
    return {
      found: false,
      needRetry: true,
      edrpou: dossier.okpo || dossier.inn || warnings.edrpou || null,
      raw: resp
    };
  }

  const record = Array.isArray(dossier.record) && dossier.record.length > 0 ? dossier.record[0] : {};
  const kveds = [];
  if (record.primaryactivitykind?.code) {
    kveds.push({
      code: String(record.primaryactivitykind.code).trim(),
      name: String(record.primaryactivitykind.name || '').trim(),
      isPrimary: true
    });
  }
  if (Array.isArray(record.activitykinds)) {
    for (const k of record.activitykinds) {
      const code = String(k.code || '').trim();
      if (code && !kveds.some(existing => existing.code === code)) {
        kveds.push({
          code,
          name: String(k.name || '').trim(),
          isPrimary: String(k.isprimary) === '1'
        });
      }
    }
  }

  const curState = String(dossier.curstate ?? record.state?.state ?? record.state ?? '');
  const curStateText = String(dossier.curstatetxt || record.state?.statetext || record.statetext || '').trim();
  const isRegistered = curState === '1' || /зареєстрован/i.test(curStateText);

  const taxDebtTotal = Number(warnings.taxDebts?.total || 0);
  const wageDebtTotal = Number(warnings.wageDebt?.debt || 0);
  const openPenalties = Number(warnings.penalties?.value || 0);
  const bankruptcyCount = Number(warnings.bancruptcy?.value || 0);
  const singleTaxRisk = Boolean(warnings.singletaxRisk?.valueis);
  const isAggressor = String(warnings.aggressor?.isAggressor || '0') === '1' || Boolean(warnings.aggressor?.isAggressor === true);
  const hasSanctions = Boolean(warnings.sanctions?.value);
  const wantedMvs = Boolean(warnings.wantedMVS?.value);
  const wantedSbu = Boolean(warnings.wantedSBU?.value);
  const wantedTerrorist = Boolean(warnings.wantedterrorist?.value);

  const riskFlags = [];
  if (!isRegistered && foundCode === '1') riskFlags.push(`Статус ЄДР: ${curStateText || curState}`);
  if (taxDebtTotal > 0) riskFlags.push(`Податковий борг: ${taxDebtTotal} грн`);
  if (wageDebtTotal > 0) riskFlags.push(`Борг із зарплати: ${wageDebtTotal} грн`);
  if (singleTaxRisk) riskFlags.push('Ризик втрати єдиного податку');
  if (openPenalties > 0) riskFlags.push(`Активні виконавчі провадження: ${openPenalties}`);
  if (bankruptcyCount > 0) riskFlags.push('Процедура банкрутства');
  if (isAggressor) riskFlags.push('Зв’язок із країнами-агресорами');
  if (hasSanctions) riskFlags.push('Санкції');
  if (wantedMvs || wantedSbu || wantedTerrorist) riskFlags.push('Особа у розшуку МВС/СБУ');

  return {
    found: foundCode === '1',
    needRetry: false,
    edrpou: String(dossier.okpo || dossier.inn || warnings.edrpou || '').trim(),
    name: String(record.names?.display || record.names?.shortname || record.names?.name || '').trim(),
    fullName: String(record.names?.name || record.names?.display || '').trim(),
    address: String(record.address?.address || '').trim(),
    heads: Array.isArray(record.heads) ? record.heads : [],
    isRegistered,
    stateText: curStateText,
    kveds,
    hasKved(code) {
      const target = String(code || '').trim();
      return kveds.some(k => k.code === target);
    },
    taxDebtTotal,
    wageDebtTotal,
    openPenalties,
    bankruptcyCount,
    singleTaxRisk,
    isAggressor,
    hasSanctions,
    isSafe: foundCode === '1' && riskFlags.length === 0,
    riskFlags,
    raw: resp
  };
}

/** Перевірка контрагента / ФОП за кодом ЄДРПОУ або ІПН (розд. 10: POST /api/ubki/check). */
async function checkCounterparty(token, edrpou, { edrpouSel, retryOnPending = true } = {}) {
  const code = String(edrpou || '').trim();
  if (!/^\d{8,10}$/.test(code)) {
    throw new Error('Код ЄДРПОУ або ІПН контрагента має містити 8 або 10 цифр');
  }
  const payload = { edrpou: code };
  if (edrpouSel) payload.edrpou_sel = String(edrpouSel).trim();

  let resp = await post(token, UBKI_URL, payload, { contentType: 'application/json', accept: 'application/json' });
  let summary = summarizeCounterpartyDossier(resp);
  if (summary.needRetry && retryOnPending) {
    await new Promise(r => setTimeout(r, 1500));
    resp = await post(token, UBKI_URL, payload, { contentType: 'application/json', accept: 'application/json' });
    summary = summarizeCounterpartyDossier(resp);
  }
  return summary;
}

/** Вивантаження XML-звіту ДПС або ZIP-архіву в «Електронну звітність» Приват24 (розд. 6: POST /api/proxy/eo/documents/create-b64). */
async function uploadTaxReportB64(token, { uploadedFileB64, uploadedFileName, okpo, duplicate = 'remove' }) {
  if (!uploadedFileB64 || !uploadedFileName || !okpo) {
    throw new Error('Для вивантаження звіту в Приват24 необхідні uploadedFileB64, uploadedFileName та okpo');
  }
  const form = new URLSearchParams();
  form.set('uploadedFileB64', String(uploadedFileB64));
  form.set('uploadedFileName', String(uploadedFileName));
  form.set('okpo', String(okpo).trim());
  form.set('duplicate', duplicate === 'remove' ? 'remove' : 'error');

  return post(token, '/documents/create-b64', form.toString(), {
    baseUrl: EO_BASE,
    contentType: 'application/x-www-form-urlencoded'
  });
}

/** Журнал електронного документообігу (розд. 5: POST /api/proxy/edoc/journal/{inbox|outbox|in-process|all|to-pay}). */
async function fetchEdocJournal(token, { folder = 'to-pay', dateBegin, dateEnd, okpo, limit = 50, offset = 0 } = {}) {
  const allowedFolders = ['inbox', 'outbox', 'in-process', 'all', 'to-pay'];
  const targetFolder = allowedFolders.includes(folder) ? folder : 'to-pay';
  if (!dateBegin || !dateEnd) {
    throw new Error('Для запиту журналу ЕДО необхідні параметри dateBegin та dateEnd у форматі YYYY-MM-DD');
  }
  const body = {
    dateBegin: String(dateBegin),
    dateEnd: String(dateEnd),
    limit: String(limit),
    offset: String(offset)
  };
  if (okpo) body.okpo = Array.isArray(okpo) ? okpo.map(String) : [String(okpo)];
  return post(token, `/journal/${targetFolder}`, body, { baseUrl: EDOC_BASE });
}

/** Створення платежу на основі рахунка-фактури з ЕДО (розд. 5: POST /api/proxy/edoc/create-payment-from-invoice/{id}). */
async function createPaymentFromInvoice(token, { id, okpo, payerAccount }) {
  if (!id || !okpo || !payerAccount) {
    throw new Error('Для створення платежу з рахунка-фактури необхідні id, okpo та payerAccount');
  }
  const query = new URLSearchParams({
    okpo: String(okpo).trim(),
    payerAccount: normIban(payerAccount)
  }).toString();
  return post(token, `/create-payment-from-invoice/${encodeURIComponent(String(id))}?${query}`, null, {
    baseUrl: EDOC_BASE
  });
}

/** Отримання списку корпоративних карток та карток «Ключ до рахунку» (розд. 9: POST /api/corpcards/v2/cards/list). */
async function fetchCorpCardsList(token, { panState = 'o', corpCod } = {}) {
  const body = {};
  if (panState) body.panState = String(panState);
  if (corpCod) body.corpCod = String(corpCod);
  return post(token, '/cards/list', body, { baseUrl: CORPCARDS_BASE });
}

/** Виписка за корпоративними картками / «Ключ до рахунку» (розд. 9: POST /api/corpcards/v2/corp/statements або /card/statements). */
async function fetchCorpCardStatements(token, { id, code, type = 'ACCKEY', dateStart, dateEnd, clientCard }) {
  if (!id || !code || !dateStart || !dateEnd) {
    throw new Error('Необхідні параметри id, code, dateStart та dateEnd');
  }
  const query = new URLSearchParams({
    dateStart: dotDate(dateStart),
    dateEnd: dotDate(dateEnd)
  }).toString();
  const payload = {
    corporation: { id: String(id), code: String(code), type: String(type) }
  };
  let endpoint = `/corp/statements?${query}`;
  if (clientCard) {
    payload.clientCard = String(clientCard);
    endpoint = `/card/statements?${query}`;
  }
  return post(token, endpoint, payload, { baseUrl: CORPCARDS_BASE });
}

module.exports = {
  apiDate,
  dotDate,
  parseBankDate,
  normalizeTransaction,
  normalizeBalance,
  isReady,
  fetchSettings,
  fetchBalances,
  fetchTransactions,
  fetchInterimTransactions,
  fetchFinalTransactions,
  isTreasuryAccount,
  paymentBody,
  createPayment,
  getPayment,
  addPaymentSign,
  deletePayment,
  printReceiptsPdf,
  summarizeCounterpartyDossier,
  checkCounterparty,
  uploadTaxReportB64,
  fetchEdocJournal,
  createPaymentFromInvoice,
  fetchCorpCardsList,
  fetchCorpCardStatements
};
