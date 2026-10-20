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
//
// Підтримує прозору маршрутизацію за ключем (токеном Автоклієнта):
//   • Якщо введено тестовий ключ (SANDBOX_TOKEN = 'PRIVAT24_TEST_KEY_USPIH25_SANDBOX_V3'
//     або будь-який ключ із префіксом PRIVAT24_TEST_KEY_ / PRIVAT24_SANDBOX_),
//     усі запити call() та post() адресуються на ізольоване тестове середовище банку
//     (_privat24_sandbox*), яке керується з вікна Супер-Адміна (platform.html#bank).
//   • Якщо введено реальний токен ПриватБанку, усі запити йдуть напряму на
//     промисловий сервер https://acp.privatbank.ua.
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

// Тестовий ключ Автоклієнта Приват24 (для роботи з тестовим середовищем банку)
const SANDBOX_TOKEN = 'PRIVAT24_TEST_KEY_USPIH25_SANDBOX_V3';

const DEFAULT_SANDBOX_ACCOUNTS = [
  {
    iban: 'UA213052990000026007054321001',
    purpose: 'current',
    name: 'Поточний рахунок ОСББ (311 · ПриватБанк)',
    currency: 'UAH',
    balanceKop: 28540000
  },
  {
    iban: 'UA893052990000026007233567891',
    purpose: 'reserve',
    name: 'Резервний / ремонтний фонд ОСББ (311 · ПриватБанк)',
    currency: 'UAH',
    balanceKop: 9400000
  }
];

let sandboxRootDb = null;

function setSandboxDb(dbInstance) {
  sandboxRootDb = dbInstance;
}

function isSandboxToken(token) {
  const s = String(token || '').trim();
  return s === SANDBOX_TOKEN || /^PRIVAT24_(?:TEST_KEY|SANDBOX)_[A-Z0-9_~-]{4,90}$/i.test(s);
}

function tokenForTenant(tenantId) {
  const clean = String(tenantId || 'uspih-25').trim();
  if (!clean || clean === 'uspih-25' || clean === 'default') return SANDBOX_TOKEN;
  if (clean.startsWith('sandbox~')) {
    const uid = clean.slice('sandbox~'.length).replace(/[^A-Za-z0-9_-]/g, '');
    return `PRIVAT24_TEST_KEY_SANDBOX_${uid}_V3`;
  }
  const slug = clean.toUpperCase().replace(/[^A-Z0-9]/g, '_').slice(0, 32);
  return `PRIVAT24_TEST_KEY_TENANT_${slug}_V3`;
}

function getSandboxDb(token) {
  const root = sandboxRootDb || require('firebase-admin/firestore').getFirestore();
  const s = String(token || '').trim();
  const mSandbox = s.match(/^PRIVAT24_TEST_KEY_SANDBOX_([A-Za-z0-9_-]+)_V3$/);
  if (mSandbox) {
    const scopedDatabase = require('./accounting-test-db');
    return scopedDatabase(root, mSandbox[1]);
  }
  const mTenant = s.match(/^PRIVAT24_TEST_KEY_TENANT_([A-Z0-9_]+)_V3$/i);
  if (mTenant) {
    const slug = mTenant[1].toLowerCase().replace(/_/g, '-');
    if (slug && slug !== 'uspih-25' && slug !== 'default') {
      const scopedDatabase = require('./accounting-test-db');
      return scopedDatabase(root, `tenant_${slug}`);
    }
  }
  return root;
}

async function ensureSandboxState(sDb) {
  const stateRef = sDb.doc('_privat24_sandbox/state');
  const snap = await stateRef.get();
  if (snap.exists && snap.data()?.accounts && Object.keys(snap.data().accounts).length > 0) {
    return { ref: stateRef, state: snap.data() };
  }

  // Підхоплюємо існуючі IBAN ОСББ, якщо вони вже були налаштовані раніше
  const [bankSnap, finSnap] = await Promise.all([
    sDb.doc('bank/settings').get().catch(() => ({ exists: false })),
    sDb.doc('osbb_settings/finance').get().catch(() => ({ exists: false }))
  ]);
  const existingAccs = bankSnap.exists ? (bankSnap.data()?.accounts || {}) : {};
  const finIban = finSnap.exists ? normIban(finSnap.data()?.iban || '') : '';

  const accounts = {};
  for (const [iban, a] of Object.entries(existingAccs)) {
    const clean = normIban(iban);
    if (/^UA\d{27}$/.test(clean)) {
      const kop = Number.isInteger(a.balanceKop) ? a.balanceKop : DEFAULT_SANDBOX_ACCOUNTS[0].balanceKop;
      accounts[clean] = {
        iban: clean,
        purpose: a.purpose || 'current',
        name: a.name || 'Поточний рахунок ОСББ (311 · ПриватБанк)',
        currency: a.currency || 'UAH',
        balanceInKop: kop,
        balanceKop: kop,
        turnoverDebtKop: 0,
        turnoverCredKop: 0,
        active: a.active !== false
      };
    }
  }

  if (Object.keys(accounts).length === 0) {
    const primaryIban = /^UA\d{27}$/.test(finIban) ? finIban : DEFAULT_SANDBOX_ACCOUNTS[0].iban;
    accounts[primaryIban] = {
      ...DEFAULT_SANDBOX_ACCOUNTS[0],
      iban: primaryIban,
      balanceInKop: DEFAULT_SANDBOX_ACCOUNTS[0].balanceKop
    };
    const reserveIban = DEFAULT_SANDBOX_ACCOUNTS[1].iban;
    if (reserveIban !== primaryIban) {
      accounts[reserveIban] = {
        ...DEFAULT_SANDBOX_ACCOUNTS[1],
        balanceInKop: DEFAULT_SANDBOX_ACCOUNTS[1].balanceKop
      };
    }
  }

  const initial = {
    phase: 'WRK',
    work_balance: 'N',
    accounts,
    updatedAt: new Date().toISOString()
  };
  await stateRef.set(initial, { merge: true });
  return { ref: stateRef, state: initial };
}

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

// ===================================================
// ОБРОБНИК ЗАПИТІВ ТЕСТОВОГО СЕРЕДОВИЩА БАНКУ (SANDBOX)
// ===================================================
async function sandboxCall(token, path, params = {}, baseUrl = BASE) {
  const sDb = getSandboxDb(token);
  const { state } = await ensureSandboxState(sDb);

  if (baseUrl === BASE && path === '/settings') {
    const now = new Date();
    return {
      status: 'SUCCESS',
      settings: {
        phase: state.phase || 'WRK',
        work_balance: state.work_balance || 'N',
        server_date_time: `${dotDate(now)} ${now.toTimeString().slice(0, 8)}`,
        today: dotDate(now),
        lastday: dotDate(new Date(now.getTime() - 86400000))
      }
    };
  }

  if (baseUrl === BASE && path === '/balance') {
    const balances = Object.values(state.accounts || {})
      .filter(a => a && a.active !== false && normIban(a.iban))
      .map(a => ({
        acc: normIban(a.iban),
        currency: a.currency || 'UAH',
        balanceIn: (Number(a.balanceInKop ?? a.balanceKop ?? 0) / 100).toFixed(2),
        balanceOut: (Number(a.balanceKop ?? 0) / 100).toFixed(2),
        turnoverDebt: (Number(a.turnoverDebtKop ?? 0) / 100).toFixed(2),
        turnoverCred: (Number(a.turnoverCredKop ?? 0) / 100).toFixed(2),
        nameACC: String(a.name || 'Поточний рахунок ОСББ (311 · ПриватБанк)')
      }));
    return {
      status: 'SUCCESS',
      exist_next_page: false,
      balances
    };
  }

  if (baseUrl === BASE && (path === '/transactions' || path === '/transactions/interim' || path === '/transactions/final')) {
    const snap = await sDb.collection('_privat24_sandbox_tx').get();
    const targetAcc = params.acc ? normIban(params.acc) : '';
    const rows = snap.docs
      .map(d => d.data())
      .filter(raw => {
        if (!raw || !raw.REF) return false;
        if (targetAcc && normIban(raw.AUT_MY_ACC) !== targetAcc) return false;
        return true;
      })
      .sort((a, b) => String(a.createdAtIso || a.DATE_TIME_DAT_OD_TIM_P || '').localeCompare(String(b.createdAtIso || b.DATE_TIME_DAT_OD_TIM_P || '')));
    return {
      status: 'SUCCESS',
      exist_next_page: false,
      transactions: rows
    };
  }

  if (baseUrl === PAY_BASE && path === '/get') {
    const ref = String(params.ref || '').trim();
    let docSnap = await sDb.doc(`_privat24_sandbox_payments/${ref}`).get();
    if (!docSnap.exists) {
      const byPack = await sDb.collection('_privat24_sandbox_payments').where('bankRef', '==', ref).limit(1).get();
      if (!byPack.empty) docSnap = byPack.docs[0];
    }
    if (!docSnap.exists) {
      const byPayRef = await sDb.collection('_privat24_sandbox_payments').where('paymentRef', '==', ref).limit(1).get();
      if (!byPayRef.empty) docSnap = byPayRef.docs[0];
    }
    if (!docSnap.exists) {
      throw Object.assign(new Error('Платіж у Приват24 не знайдено (404)'), { bankRejected: true });
    }
    const d = docSnap.data();
    return {
      status: 'SUCCESS',
      payment_ref: d.paymentRef,
      payment_pack_ref: d.bankRef,
      payment_status: d.payment_status || 'new',
      signers: d.signers || [],
      payment_data: {
        ...(d.body || {}),
        payment_ref: d.paymentRef,
        payment_pack_ref: d.bankRef,
        payment_status: d.payment_status || 'new',
        signers: d.signers || []
      }
    };
  }

  return { status: 'SUCCESS' };
}

function buildSandboxReceiptPdf(transactions) {
  const lines = transactions.map((t, idx) =>
    `#${idx + 1} IBAN: ${t.account} | REF: ${t.reference}/${t.refn}`
  ).join(' ; ');
  const streamText = `BT /F1 11 Tf 40 750 Td (PrivatBank Official Payment Instruction Receipt - Sandbox) Tj 0 -20 Td (${lines.replace(/[()\\]/g, '')}) Tj ET`;
  const pdf = [
    '%PDF-1.4',
    '1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj',
    '2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj',
    '3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >> endobj',
    `4 0 obj << /Length ${streamText.length} >> stream\n${streamText}\nendstream endobj`,
    '5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj',
    'xref\n0 6\n0000000000 65535 f \n',
    'trailer << /Size 6 /Root 1 0 R >>\nstartxref\n0\n%%EOF'
  ].join('\n');
  return Buffer.from(pdf, 'utf8');
}

async function sandboxPost(token, path, body, options = {}) {
  const sDb = getSandboxDb(token);
  await ensureSandboxState(sDb);
  const { baseUrl = PAY_BASE, rawResponse = false } = options;

  // 1. Створення платіжної інструкції (POST /api/proxy/payment/create або /create_pred)
  if (baseUrl === PAY_BASE && (path === '/create' || path === '/create_pred')) {
    const payload = typeof body === 'string' ? JSON.parse(body) : (body || {});
    const rawDocNum = String(payload.document_number || Date.now().toString().slice(-8)).trim();
    const safeDocNum = rawDocNum.replace(/[^\w-]/g, '') || Date.now().toString().slice(-8);
    const paymentRef = `P24DOC-${safeDocNum}`;
    const bankRef = `P24PACK-${safeDocNum}`;
    const nowIso = new Date().toISOString();

    await sDb.doc(`_privat24_sandbox_payments/${paymentRef}`).set({
      id: paymentRef,
      paymentRef,
      bankRef,
      docNumber: rawDocNum,
      endpoint: `${PAY_BASE}${path}`,
      status: 'wait_sign',
      payment_status: 'new',
      body: payload,
      account: normIban(payload.payer_account),
      recipient: {
        name: String(payload.payment_naming || ''),
        iban: normIban(payload.recipient_account || ''),
        card: String(payload.recipient_card || ''),
        code: String(payload.recipient_nceo || '')
      },
      amountKop: toKop(payload.payment_amount),
      currency: String(payload.payment_ccy || 'UAH'),
      purpose: String(payload.payment_destination || ''),
      structCode: payload.struct_code || null,
      signers: [],
      createdAt: nowIso,
      updatedAt: nowIso
    }, { merge: true });

    return {
      status: 'SUCCESS',
      payment_ref: paymentRef,
      payment_pack_ref: bankRef,
      payment_data: {
        payment_ref: paymentRef,
        payment_pack_ref: bankRef,
        payment_status: 'new'
      }
    };
  }

  // 2. Додавання КЕП-підпису через API (POST /api/proxy/payment/add-sign?ref=...)
  if (baseUrl === PAY_BASE && path.startsWith('/add-sign')) {
    const u = new URL(`https://sandbox.local${path}`);
    const ref = String(u.searchParams.get('ref') || '').trim();
    const docRef = sDb.doc(`_privat24_sandbox_payments/${ref}`);
    const snap = await docRef.get();
    const nowIso = new Date().toISOString();
    const signerEntry = {
      level: '1',
      fio: 'Голова правління ОСББ (КЕП)',
      state: 'Підписано КЕП',
      date: nowIso
    };
    if (snap.exists) {
      const prevSigns = Array.isArray(snap.data().signers) ? snap.data().signers : [];
      await docRef.update({
        signers: [...prevSigns, signerEntry],
        updatedAt: nowIso
      });
    }
    return { status: 'SUCCESS', payment_ref: ref };
  }

  // 3. Видалення непідписаного платежу (POST /api/proxy/payment/delete?ref=...)
  if (baseUrl === PAY_BASE && path.startsWith('/delete')) {
    const u = new URL(`https://sandbox.local${path}`);
    const ref = String(u.searchParams.get('ref') || '').trim();
    let docSnap = await sDb.doc(`_privat24_sandbox_payments/${ref}`).get();
    if (!docSnap.exists) {
      const byPack = await sDb.collection('_privat24_sandbox_payments').where('bankRef', '==', ref).limit(1).get();
      if (!byPack.empty) docSnap = byPack.docs[0];
    }
    if (docSnap.exists) {
      const d = docSnap.data();
      if (d.status === 'signed' || d.payment_status === 'signed' || d.payment_status === 'r') {
        throw Object.assign(new Error('already signed: платіж вже підписано КЕП та проведено банком'), { bankRejected: true });
      }
      await docSnap.ref.update({
        status: 'deleted',
        payment_status: 'deleted',
        updatedAt: new Date().toISOString()
      });
    }
    return { status: 'SUCCESS' };
  }

  // 4. Друк PDF-квитанцій (POST /api/paysheets/print_receipt)
  if (path === RECEIPT_URL || rawResponse) {
    const payload = typeof body === 'string' ? JSON.parse(body) : (body || {});
    return buildSandboxReceiptPdf(payload.transactions || []);
  }

  // 5. Перевірка контрагента в ЄДР/УБКІ (POST /api/ubki/check)
  if (path === UBKI_URL) {
    const payload = typeof body === 'string' ? JSON.parse(body) : (body || {});
    const code = String(payload.edrpou || '').trim();
    let matchedSup = null;
    try {
      const supSnap = await sDb.collection('suppliers').where('code', '==', code).limit(1).get();
      if (!supSnap.empty) matchedSup = supSnap.docs[0].data();
    } catch { /* ignore */ }

    const isFop = code.length === 10;
    const defaultName = matchedSup?.name || (isFop ? `ФОП Ковальчук Олександр Іванович (${code})` : `ТОВ «Сервіс-Південь Одеса» (${code})`);
    const resp = {
      dossier: {
        found: '1',
        okpo: code,
        curstate: '1',
        curstatetxt: 'зареєстровано',
        record: [{
          names: {
            display: defaultName,
            shortname: defaultName,
            name: defaultName
          },
          address: {
            address: '65000, Одеська обл., м. Одеса, вул. Інглезі, буд. 3'
          },
          state: { state: '1', statetext: 'зареєстровано' },
          primaryactivitykind: {
            code: isFop ? '43.22' : '81.10',
            name: isFop ? 'Монтаж водопровідних мереж, систем опалення та кондиціонування' : 'Комплексне обслуговування об’єктів'
          },
          activitykinds: [
            { code: '81.10', name: 'Комплексне обслуговування об’єктів', isprimary: isFop ? '0' : '1' },
            { code: '43.21', name: 'Електромонтажні роботи', isprimary: '0' },
            { code: '43.22', name: 'Монтаж водопровідних мереж, систем опалення та кондиціонування', isprimary: isFop ? '1' : '0' },
            { code: '81.29', name: 'Інші види діяльності із прибирання', isprimary: '0' }
          ]
        }]
      },
      warnings: {
        taxDebts: { total: 0 },
        wageDebt: { debt: 0 },
        penalties: { value: 0 },
        bancruptcy: { value: 0 },
        singletaxRisk: { valueis: false },
        aggressor: { isAggressor: '0' },
        sanctions: { value: false }
      }
    };

    await sDb.doc(`_privat24_sandbox_edr/${code || Date.now()}`).set({
      code,
      name: defaultName,
      isFop,
      at: new Date().toISOString()
    }).catch(() => {});

    return resp;
  }

  // 6. Вивантаження XML-звіту ДПС в «Електронну звітність» Приват24 (POST /api/proxy/eo/documents/create-b64)
  if (baseUrl === EO_BASE && path === '/documents/create-b64') {
    const params = new URLSearchParams(typeof body === 'string' ? body : '');
    const uploadedFileName = params.get('uploadedFileName') || 'report.xml';
    const okpo = params.get('okpo') || '';
    const duplicate = params.get('duplicate') || 'remove';
    const b64 = params.get('uploadedFileB64') || '';
    const buf = Buffer.from(b64, 'base64');
    const reportId = `P24EO-${Date.now().toString(36).toUpperCase()}`;

    await sDb.doc(`_privat24_sandbox_reports/${reportId}`).set({
      id: reportId,
      uploadedFileName,
      okpo,
      duplicate,
      sizeBytes: buf.length,
      preview: buf.toString('utf8').slice(0, 400),
      status: 'ACCEPTED',
      createdAt: new Date().toISOString()
    });

    return {
      status: 'SUCCESS',
      id: reportId,
      fileName: uploadedFileName,
      okpo,
      message: 'Звіт прийнято в «Електронну звітність» Приват24 (тестове середовище)'
    };
  }

  return { status: 'SUCCESS', list: [], statements: [], cards: [] };
}

async function call(token, path, params, retry = true, baseUrl = BASE) {
  if (isSandboxToken(token)) {
    return sandboxCall(token, path, params, baseUrl);
  }
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
  if (isSandboxToken(token)) {
    return sandboxPost(token, path, body, options);
  }
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

  const recipientCard = p.recipient?.card ? String(p.recipient.card).replace(/\s+/g, '') : '';
  const body = {
    document_number: String(p.docNumber),
    document_type: String(p.documentType || 'cr'),
    payer_account: normIban(p.account),
    ...(recipientCard && !recipientIban
      ? { recipient_card: recipientCard }
      : { recipient_account: recipientIban }),
    recipient_nceo: String(p.recipient?.code ?? '0000000000'),
    payment_naming: String(p.recipient?.name || '').slice(0, 140),
    payment_amount: (p.amountKop / 100).toFixed(2),
    payment_destination: String(p.purpose || '').slice(0, maxPurposeLen),
    payment_ccy: String(p.currency || 'UAH'),
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
  if (structType !== undefined && structType !== null && structType !== '') {
    body.struct_type = String(structType).slice(0, 10);
  }

  const optionalMap = {
    attach: p.attach,
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
    { contentType: 'application/json;charset=utf8', accept: 'application/octet-stream', rawResponse: true }
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

  let resp = await post(token, UBKI_URL, payload, { contentType: 'application/json;charset=utf8', accept: 'application/json' });
  let summary = summarizeCounterpartyDossier(resp);
  if (summary.needRetry && retryOnPending) {
    await new Promise(r => setTimeout(r, 1500));
    resp = await post(token, UBKI_URL, payload, { contentType: 'application/json;charset=utf8', accept: 'application/json' });
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
  SANDBOX_TOKEN,
  isSandboxToken,
  tokenForTenant,
  setSandboxDb,
  getSandboxDb,
  ensureSandboxState,
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
