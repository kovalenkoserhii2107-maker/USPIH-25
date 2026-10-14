'use strict';

/**
 * Клієнт API «Приват24 Автоклієнт» (версія 3.0.0) для ОСББ «Успіх-25».
 *
 * Реалізує:
 * 1. Отримання серверних дат і статусу регламенту (/api/statements/settings)
 * 2. Баланси та транзакції: за інтервал, проміжні (interim) та підсумкові (final)
 * 3. Створення платежів (/api/proxy/payment/create та /create_pred), у т.ч. податкових (МФО 899998, struct_code)
 * 4. Перевірка статусу підписів (/api/proxy/payment/get), накладання КЕП (/api/proxy/payment/add-sign) та видалення (/api/proxy/payment/delete, HTTP 204)
 * 5. Завантаження офіційних PDF-квитанцій за платежами (/api/paysheets/print_receipt)
 * 6. Перевірка контрагентів та ФОП через ЄДР/УБКІ (/api/ubki/check)
 * 7. Вивантаження XML/ZIP звітів ДПС в «Електронну звітність» Приват24 (/api/proxy/eo/documents/create-b64)
 * 8. Електронний документообіг (ЕДО: рахунки до сплати та створення платежу з рахунка-фактури)
 * 9. Виписки за корпоративними картками / «Ключ до рахунку» (/api/corpcards/v2/*)
 */

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

/** «09-10-2026» — формат дат у запитах Автоклієнта (ДД-ММ-РРРР). */
function apiDate(date) {
  if (typeof date === 'string' && /^\d{2}-\d{2}-\d{4}$/.test(date.trim())) {
    return date.trim();
  }
  const d = date instanceof Date ? date : new Date(date);
  const parts = new Intl.DateTimeFormat('uk-UA', {
    timeZone: 'Europe/Kyiv',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric'
  }).formatToParts(d);
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

/** «09.10.2026 14:05:31» або «09.10.2026» + «14:05» → Date (київський час). */
function parseBankDate(dateTime, date, time) {
  const source = String(dateTime || '').trim() || `${String(date || '').trim()} ${String(time || '00:00').trim()}`;
  const m = source.match(/^(\d{2})\.(\d{2})\.(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (!m) return null;
  const [, dd, mm, yyyy, hh = '0', mi = '0', ss = '0'] = m;
  if (+hh > 23 || +mi > 59 || +ss > 59 || +mm < 1 || +mm > 12 || +dd < 1 || +dd > 31) return null;

  const guess = new Date(Date.UTC(+yyyy, +mm - 1, +dd, +hh, +mi, +ss));
  const kyiv = new Date(guess.toLocaleString('en-US', { timeZone: 'Europe/Kyiv' }));
  const diffMs = guess.getTime() - kyiv.getTime();
  return new Date(guess.getTime() + diffMs);
}

/**
 * Нормалізація транзакції з виписки Приват24 Автоклієнт v3.0.0.
 * Підтримує як актуальні поля API v3.0.0 (AUT_MY_*, AUT_CNTR_*, PAYER_ULTMT_*, RECIPIENT_ULTMT_*, DLR, STRUCT_*),
 * так і застарілі поля тестових фікстур (NAM_A, OKPO_A, ACC_B, NAM_B, OKPO_B).
 */
function normalizeTransaction(raw) {
  const direction = raw.TRANTYPE === 'C' ? 'in' : raw.TRANTYPE === 'D' ? 'out' : null;
  const amountKop = Math.abs(toKop(raw.SUM ?? raw.SUM_E));
  const at = parseBankDate(raw.DATE_TIME_DAT_OD_TIM_P, raw.DAT_OD || raw.DAT_KL, raw.TIM_P);
  const bankId = raw.REF ? `${raw.REF}_${raw.REFN || 0}` : (raw.ID || raw.TECHNICAL_TRANSACTION_ID || null);

  const myAcc = normIban(raw.AUT_MY_ACC);
  const cntrAcc = normIban(raw.AUT_CNTR_ACC);
  const myName = String(raw.AUT_MY_NAM || '').trim();
  const cntrName = String(raw.AUT_CNTR_NAM || '').trim();
  const myCode = String(raw.AUT_MY_CRF || '').trim();
  const cntrCode = String(raw.AUT_CNTR_CRF || '').trim();

  const ultmtPayerName = String(raw.PAYER_ULTMT_NAME || '').trim();
  const ultmtPayerCode = String(raw.PAYER_ULTMT_NCEO || '').trim();
  const ultmtRecipientName = String(raw.RECIPIENT_ULTMT_NAME || '').trim();
  const ultmtRecipientCode = String(raw.RECIPIENT_ULTMT_NCEO || '').trim();

  let payerIban;
  let payerName;
  let payerCode;
  let recipientIban;
  let recipientName;
  let recipientCode;

  if (direction === 'in') {
    // Вхідний платіж (TRANTYPE === 'C'): платник — контрагент (мешканець/орендар), одержувач — ОСББ
    payerIban = normIban(raw.ACC_A || cntrAcc || myAcc);
    payerName = String(raw.NAM_A || ultmtPayerName || cntrName || '').trim();
    payerCode = String(raw.OKPO_A || ultmtPayerCode || cntrCode || '').trim();
    recipientIban = normIban(raw.ACC_B || myAcc);
    recipientName = String(raw.NAM_B || myName || '').trim();
    recipientCode = String(raw.OKPO_B || myCode || '').trim();
  } else if (direction === 'out') {
    // Вихідний платіж (TRANTYPE === 'D'): платник — ОСББ, одержувач — контрагент (постачальник/ФОП/бюджет)
    payerIban = normIban(raw.ACC_A || myAcc);
    payerName = String(raw.NAM_A || myName || '').trim();
    payerCode = String(raw.OKPO_A || myCode || '').trim();
    recipientIban = normIban(raw.ACC_B || cntrAcc || myAcc);
    recipientName = String(raw.NAM_B || ultmtRecipientName || cntrName || '').trim();
    recipientCode = String(raw.OKPO_B || ultmtRecipientCode || cntrCode || '').trim();
  } else {
    payerIban = normIban(raw.ACC_A || myAcc || cntrAcc);
    payerName = String(raw.NAM_A || ultmtPayerName || cntrName || '').trim();
    payerCode = String(raw.OKPO_A || ultmtPayerCode || cntrCode || '').trim();
    recipientIban = normIban(raw.ACC_B || cntrAcc || myAcc);
    recipientName = String(raw.NAM_B || ultmtRecipientName || cntrName || '').trim();
    recipientCode = String(raw.OKPO_B || ultmtRecipientCode || cntrCode || '').trim();
  }

  return {
    bankId,
    direction,
    amountKop,
    currency: raw.CCY || 'UAH',
    at,
    payerIban,
    payerName,
    payerCode,
    recipientIban,
    recipientName,
    recipientCode,
    purpose: String(raw.OSND || '').trim(),
    docNumber: String(raw.NUM_DOC || '').trim(),
    final: raw.FL_REAL === 'r' && raw.PR_PR === 'r',
    void: raw.PR_PR === 't' || raw.PR_PR === 'n',
    ref: raw.REF ? String(raw.REF).trim() : null,
    refn: raw.REFN !== undefined && raw.REFN !== null ? String(raw.REFN).trim() : null,
    dlr: raw.DLR ? String(raw.DLR).trim() : null,
    uetr: raw.UETR ? String(raw.UETR).trim() : null,
    structCode: raw.STRUCT_CODE ? String(raw.STRUCT_CODE).trim() : null,
    structType: raw.STRUCT_TYPE ? String(raw.STRUCT_TYPE).trim() : null,
    structCategory: raw.STRUCT_CATEGORY ? String(raw.STRUCT_CATEGORY).trim() : null,
    raw
  };
}

function normalizeBalance(raw) {
  const iban = normIban(raw.acc);
  const balance = raw.balanceOut ?? raw.balanceIn;
  return {
    iban,
    currency: raw.currency || 'UAH',
    balanceKop: toKop(balance),
    balanceInKop: raw.balanceIn !== undefined ? toKop(raw.balanceIn) : undefined,
    balanceOutKop: raw.balanceOut !== undefined ? toKop(raw.balanceOut) : undefined,
    turnoverDebtKop: raw.turnoverDebt !== undefined ? toKop(raw.turnoverDebt) : undefined,
    turnoverCredKop: raw.turnoverCred !== undefined ? toKop(raw.turnoverCred) : undefined,
    isFinalBal: Boolean(raw.is_final_bal),
    name: String(raw.nameACC || '').trim(),
    at: new Date()
  };
}

function resolveUrl(path, defaultBase = BASE) {
  if (/^https?:\/\//i.test(path)) return path;
  if (path.startsWith('/api/')) return `${HOST}${path}`;
  return `${defaultBase}${path}`;
}

async function call(token, path, params = {}, retry = true, baseUrl = BASE) {
  const url = new URL(resolveUrl(path, baseUrl));
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) url.searchParams.append(k, String(v));
  }
  const res = await fetch(url.toString(), {
    headers: {
      'User-Agent': 'OSBB-Uspih-25',
      token,
      'Content-Type': 'application/json;charset=utf8'
    }
  });

  if (res.status === 429 && retry) {
    await new Promise(r => setTimeout(r, 2000));
    return call(token, path, params, false, baseUrl);
  }

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`ПриватБанк API ${res.status}: ${text.slice(0, 200)}`);
  }

  if (res.status === 204) return {};
  const text = await res.text();
  return text.trim() ? JSON.parse(text) : {};
}

async function post(token, path, body, options = {}) {
  const {
    baseUrl = BASE,
    contentType = 'application/json;charset=utf8',
    accept = 'application/json',
    rawResponse = false
  } = options;

  const url = resolveUrl(path, baseUrl);
  const headers = {
    'User-Agent': 'OSBB-Uspih-25',
    token,
    'Content-Type': contentType
  };
  if (accept) headers.Accept = accept;

  const fetchOptions = { method: 'POST', headers };
  if (body !== undefined && body !== null) {
    fetchOptions.body = typeof body === 'string' || Buffer.isBuffer(body)
      ? body
      : JSON.stringify(body);
  }

  const res = await fetch(url, fetchOptions);

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`ПриватБанк API POST ${res.status}: ${text.slice(0, 200)}`);
  }

  if (rawResponse) {
    const arrayBuffer = await res.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }

  if (res.status === 204) return {};
  const text = await res.text();
  return text.trim() ? JSON.parse(text) : {};
}

async function pages(token, path, params, key) {
  const out = [];
  let followId = undefined;
  const seen = new Set();

  for (let i = 0; i < MAX_PAGES; i++) {
    const body = await call(token, path, { ...params, limit: PAGE, followId });
    const arr = Array.isArray(body?.[key])
      ? body[key]
      : (key === 'transactions' && Array.isArray(body?.statements))
        ? body.statements
        : (key === 'statements' && Array.isArray(body?.transactions))
          ? body.transactions
          : null;

    if (!arr) {
      throw new Error(`ПриватБанк повернув невідому структуру: немає масиву ${key}`);
    }
    out.push(...arr);

    if (String(body.exist_next_page) !== 'true') return out;
    if (!body.next_page_id || seen.has(body.next_page_id)) {
      throw new Error('Банк повернув неповну виписку: сторінка без ID або цикл');
    }
    seen.add(body.next_page_id);
    followId = body.next_page_id;
  }
  return out;
}

/**
 * Перевірка готовності API виписок (/api/statements/settings).
 * Враховує структуру v3.0.0 ({ settings: { phase: 'WRK', work_balance: 'N' } })
 * та плоску структуру для зворотної сумісності з емулятором.
 */
async function isReady(token) {
  const body = await call(token, '/settings');
  const s = body?.settings || body;
  const phase = s?.phase;
  const workBalance = s?.work_balance;
  return phase === 'WRK' && workBalance === 'N';
}

/** Отримання повного об'єкта серверних дат (/api/statements/settings). */
async function fetchSettings(token) {
  const body = await call(token, '/settings');
  return body?.settings || body || {};
}

/** Отримання балансів за дату або інтервал дат (/api/statements/balance). */
async function fetchBalances(token, date, endDate) {
  const start = apiDate(date || new Date());
  const end = endDate ? apiDate(endDate) : start;
  const list = await pages(token, '/balance', { startDate: start, endDate: end }, 'balances')
    .catch(async () => {
      const single = await call(token, '/balance', { startDate: start, endDate: end });
      return Array.isArray(single?.balances) ? single.balances : Array.isArray(single) ? single : [];
    });
  return list.map(normalizeBalance);
}

/** Отримання транзакцій за інтервал дат (/api/statements/transactions). */
async function fetchTransactions(token, { iban, from, to, groupClientId } = {}) {
  const params = {
    startDate: apiDate(from),
    endDate: apiDate(to)
  };
  if (iban) params.acc = normIban(iban);
  if (groupClientId) params.id = String(groupClientId);
  const list = await pages(token, '/transactions', params, 'transactions');
  return list.map(normalizeTransaction);
}

/** Отримання проміжних транзакцій з lastday до today (/api/statements/transactions/interim). */
async function fetchInterimTransactions(token, { iban } = {}) {
  const params = {};
  if (iban) params.acc = normIban(iban);
  const list = await pages(token, '/transactions/interim', params, 'transactions');
  return list.map(normalizeTransaction);
}

/** Отримання транзакцій за останній підсумковий день (/api/statements/transactions/final). */
async function fetchFinalTransactions(token, { iban } = {}) {
  const params = {};
  if (iban) params.acc = normIban(iban);
  const list = await pages(token, '/transactions/final', params, 'transactions');
  return list.map(normalizeTransaction);
}

/** Чи є рахунок одержувача бюджетним рахунком Казначейства (МФО 899998). */
function isTreasuryAccount(iban, mfo) {
  if (String(mfo || '').trim() === TREASURY_MFO) return true;
  const clean = normIban(iban);
  return clean.startsWith('UA') && clean.length === 29 && clean.slice(4, 10) === TREASURY_MFO;
}

/**
 * Формує плоский JSON-об'єкт реквізитів платежу згідно з розд. 4 Автоклієнта v3.0.0.
 * Усі значення — типу string. Для податкових платежів (МФО 899998) обмежує призначення 140 символами
 * та додає поля struct_code, struct_category, struct_type.
 */
function paymentBody(p, today = new Date()) {
  const date = dotDate(p.paymentDate || today);
  const acceptDate = dotDate(p.paymentAcceptDate || p.paymentDate || today);
  const recipientIban = p.recipient?.iban ? normIban(p.recipient.iban) : '';
  const recipientCard = p.recipient?.card ? String(p.recipient.card).replace(/\s+/g, '') : '';
  const recipientMfo = p.recipient?.mfo || p.recipientIfi || '';
  const isTax = Boolean(p.structCode || p.struct_code || isTreasuryAccount(recipientIban, recipientMfo));
  const maxPurposeLen = isTax ? 140 : 420;

  const body = {
    document_number: String(p.docNumber),
    document_type: String(p.documentType || 'cr'),
    payer_account: normIban(p.account),
    recipient_nceo: String(p.recipient?.code || '0000000000'),
    payment_naming: String(p.recipient?.name || '').slice(0, 140),
    payment_amount: (p.amountKop / 100).toFixed(2),
    payment_destination: String(p.purpose || '').slice(0, maxPurposeLen),
    payment_ccy: String(p.currency || 'UAH'),
    payment_date: date,
    payment_accept_date: acceptDate
  };

  if (recipientCard && !recipientIban) {
    body.recipient_card = recipientCard;
  } else {
    body.recipient_account = recipientIban;
  }

  if (recipientMfo) body.recipient_ifi = String(recipientMfo);
  if (p.recipient?.bankName || p.recipientIfiText) {
    body.recipient_ifi_text = String(p.recipient?.bankName || p.recipientIfiText);
  }

  // Паспортні дані або ID-картка, якщо одержувач без ЄДРПОУ/ІПН (0000000000)
  if (p.recipient?.documentIdNumber) {
    body.recipient_document_id_number = String(p.recipient.documentIdNumber);
  } else {
    if (p.recipient?.documentSeries) body.recipient_document_series = String(p.recipient.documentSeries);
    if (p.recipient?.documentNumber) body.recipient_document_number = String(p.recipient.documentNumber);
  }

  // Структуроване призначення для податкових платежів (ПДФО, ВЗ, ЄСВ тощо)
  const structCode = p.structCode ?? p.struct_code ?? (isTax ? '101' : undefined);
  const structCategory = p.structCategory ?? p.struct_category;
  const structType = p.structType ?? p.struct_type;
  if (structCode !== undefined && structCode !== null && structCode !== '') {
    body.struct_code = String(structCode).slice(0, 3);
  }
  if (structCategory !== undefined && structCategory !== null && structCategory !== '') {
    body.struct_category = String(structCategory).slice(0, 140);
  }
  if (structType !== undefined && structType !== null && structType !== '') {
    body.struct_type = String(structType).slice(0, 10);
  }

  // Додаткові опціональні поля НБУ (фактичний платник / одержувач, коментарі підписанту)
  const optionalMap = {
    signer_msg: p.signerMsg,
    odb_msg: p.odbMsg,
    copy_from_ref: p.copyFromRef,
    payment_cb_ref: p.paymentCbRef,
    payer_ultmt_nceo: p.payerUltmt?.code,
    payer_ultmt_name: p.payerUltmt?.name,
    payer_ultmt_document_series: p.payerUltmt?.documentSeries,
    payer_ultmt_document_number: p.payerUltmt?.documentNumber,
    payer_ultmt_document_id_number: p.payerUltmt?.documentIdNumber,
    recipient_ultmt_nceo: p.recipientUltmt?.code,
    recipient_ultmt_name: p.recipientUltmt?.name,
    recipient_ultmt_document_series: p.recipientUltmt?.documentSeries,
    recipient_ultmt_document_number: p.recipientUltmt?.documentNumber,
    recipient_ultmt_document_id_number: p.recipientUltmt?.documentIdNumber
  };
  for (const [k, v] of Object.entries(optionalMap)) {
    if (v !== undefined && v !== null && v !== '') body[k] = String(v);
  }

  return body;
}

/**
 * Створити платіж у Приват24 (/api/proxy/payment/create або /create_pred);
 * повертає { bankRef (payment_pack_ref), paymentRef (payment_ref), status }.
 */
async function createPayment(token, p) {
  const endpoint = p?.predict ? '/create_pred' : '/create';
  const data = await post(token, endpoint, paymentBody(p), { baseUrl: PAY_BASE });
  const ref = data.payment_ref || data.payment_data?.payment_ref || null;
  const pack = data.payment_pack_ref || data.payment_data?.payment_pack_ref || null;
  if (!ref && !pack) throw new Error('Банк не повернув номер платежу');
  return { bankRef: pack, paymentRef: ref, status: data.payment_data?.payment_status || 'new' };
}

/**
 * Отримати інформацію за платежем та стан рівнів підпису (розд. 4, п. 1: GET /api/proxy/payment/get?ref=...).
 * Повертає об'єкт із полями payment_ref, payment_status, level_sign: { 1_sign_level, 2_sign_level }, fields_for_sign.
 */
async function getPayment(token, paymentRef) {
  if (!paymentRef) throw new Error('Не вказано референс платежу');
  return call(token, '/get', { ref: String(paymentRef) }, true, PAY_BASE);
}

/**
 * Надіслати КЕП-підпис платежу на збереження (розд. 4, п. 2: POST /api/proxy/payment/add-sign?ref=...).
 * Для різних рівнів підпису (бухгалтер / голова правління) використовується токен відповідної особи.
 */
async function addPaymentSign(token, paymentRef, signBase64) {
  if (!paymentRef) throw new Error('Не вказано референс платежу');
  if (!signBase64) throw new Error('Не передано BASE64 підпис КЕП');
  return post(
    token,
    `/add-sign?ref=${encodeURIComponent(String(paymentRef))}`,
    { sign: String(signBase64) },
    { baseUrl: PAY_BASE }
  );
}

/**
 * Видалити ще не підписаний платіж (розд. 4, п. 3: POST /api/proxy/payment/delete?ref=...).
 * Сервер повертає HTTP 204 без body.
 */
async function deletePayment(token, paymentRef) {
  if (!paymentRef) return false;
  await post(token, `/delete?ref=${encodeURIComponent(String(paymentRef))}`, null, { baseUrl: PAY_BASE });
  return true;
}

/**
 * Отримання квитанцій (платіжних інструкцій) за проведеними платежами у PDF-форматі
 * (розд. 11: POST /api/paysheets/print_receipt).
 * За один запит можна отримати від 1 до 45 платіжних інструкцій, perPage: від 1 до 4.
 * Повертає Buffer із PDF-файлом.
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
    const account = normIban(t.account || t.iban || t.payerIban);
    const reference = String(t.reference || t.ref || (t.bankId ? String(t.bankId).split('_')[0] : '')).trim();
    const refn = String(t.refn ?? (t.bankId && String(t.bankId).includes('_') ? String(t.bankId).split('_')[1] : '1')).trim();
    if (!account || !reference) {
      throw new Error('Кожна транзакція для print_receipt повинна мати account та reference (REF)');
    }
    return { account, reference, refn };
  });

  return post(
    token,
    RECEIPT_URL,
    { transactions: formatted, perPage: safePerPage },
    {
      contentType: 'application/json',
      accept: 'application/octet-stream',
      rawResponse: true
    }
  );
}

/**
 * Розбір досьє контрагента з ЄДР/УБКІ (допоміжна функція для checkCounterparty).
 * Перевіряє статус реєстрації, КВЕДи (важливо для виплат ФОП без утримання 18% ПДФО + 5% ВЗ),
 * податковий борг, ризик втрати єдиного податку, виконавчі провадження, банкрутство та санкції.
 */
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

/**
 * Перевірка контрагента / ФОП за кодом ЄДРПОУ або ІПН (розд. 10: POST /api/ubki/check).
 * Перші 100 запитів у Приват24 для бізнесу («Досьє ділової репутації») безкоштовні.
 */
async function checkCounterparty(token, edrpou, { edrpouSel, retryOnPending = true } = {}) {
  const code = String(edrpou || '').trim();
  if (!/^\d{8,10}$/.test(code)) {
    throw new Error('Код ЄДРПОУ або ІПН контрагента має містити 8 або 10 цифр');
  }
  const payload = { edrpou: code };
  if (edrpouSel) payload.edrpou_sel = String(edrpouSel).trim();

  let resp = await post(token, UBKI_URL, payload, {
    contentType: 'application/json',
    accept: 'application/json'
  });
  let summary = summarizeCounterpartyDossier(resp);

  // Згідно з документацією: якщо "found": "-1", потрібно надіслати запит повторно
  if (summary.needRetry && retryOnPending) {
    await new Promise(r => setTimeout(r, 1500));
    resp = await post(token, UBKI_URL, payload, {
      contentType: 'application/json',
      accept: 'application/json'
    });
    summary = summarizeCounterpartyDossier(resp);
  }

  return summary;
}

/**
 * Завантаження XML-звіту ДПС (або ZIP-архіву об'єднаної звітності) у форматі Base64
 * напряму в «Приват24 для бізнесу -> Електронна звітність» (розд. 6: POST /api/proxy/eo/documents/create-b64).
 */
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

/**
 * Журнал електронного документообігу (розд. 5: POST /api/proxy/edoc/journal/{inbox|outbox|in-process|all|to-pay}).
 */
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
  if (okpo) {
    body.okpo = Array.isArray(okpo) ? okpo.map(String) : [String(okpo)];
  }
  return post(token, `/journal/${targetFolder}`, body, { baseUrl: EDOC_BASE });
}

/**
 * Створення платежу на основі вхідного рахунка-фактури з ЕДО
 * (розд. 5: POST /api/proxy/edoc/create-payment-from-invoice/{id}?okpo=...&payerAccount=...).
 */
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

/**
 * Отримання списку корпоративних карток та карток «Ключ до рахунку»
 * (розд. 9, п. 1: POST /api/corpcards/v2/cards/list).
 */
async function fetchCorpCardsList(token, { panState = 'o', corpCod } = {}) {
  const body = {};
  if (panState) body.panState = String(panState);
  if (corpCod) body.corpCod = String(corpCod);
  return post(token, '/cards/list', body, { baseUrl: CORPCARDS_BASE });
}

/**
 * Отримання виписки за корпоративними картками / «Ключ до рахунку»
 * (розд. 9, п. 3-4: POST /api/corpcards/v2/corp/statements або /card/statements).
 */
async function fetchCorpCardStatements(token, { id, code, type = 'ACCKEY', dateStart, dateEnd, clientCard }) {
  if (!id || !code || !dateStart || !dateEnd) {
    throw new Error('Необхідні параметри id, code, dateStart та dateEnd');
  }
  const query = new URLSearchParams({
    dateStart: dotDate(dateStart),
    dateEnd: dotDate(dateEnd)
  }).toString();
  const payload = {
    corporation: {
      id: String(id),
      code: String(code),
      type: String(type)
    }
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
