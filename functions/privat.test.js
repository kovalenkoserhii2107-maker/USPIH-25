'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
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
} = require('./privat');

function withMockFetch(handler, fn) {
  const originalFetch = global.fetch;
  const calls = [];
  global.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    return handler(String(url), options, calls);
  };
  return Promise.resolve()
    .then(() => fn(calls))
    .finally(() => {
      global.fetch = originalFetch;
    });
}

function jsonResponse(body, status = 200) {
  const text = body === null || body === undefined ? '' : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => text,
    json: async () => JSON.parse(text),
    arrayBuffer: async () => Buffer.from(text)
  };
}

test('apiDate та dotDate форматують дату за київським часом (ДД-ММ-РРРР / ДД.ММ.РРРР)', () => {
  const d = new Date('2026-10-14T08:00:00Z');
  assert.equal(apiDate(d), '14-10-2026');
  assert.equal(dotDate(d), '14.10.2026');
  assert.equal(apiDate('09-10-2026'), '09-10-2026');
});

test('parseBankDate коректно парсить дату й час ПриватБанку', () => {
  const dt = parseBankDate('07.01.2026 02:58:00', '07.01.2026', '02:58');
  assert.ok(dt instanceof Date);
  assert.equal(apiDate(dt), '07-01-2026');
  assert.equal(parseBankDate('invalid', '', ''), null);
});

test('normalizeTransaction розбирає реальну структуру Автоклієнта v3.0.0 (вхідний та вихідний платіж + DLR + ULTMT)', () => {
  // Вхідний платіж від мешканця (TRANTYPE = C)
  const rawIn = {
    AUT_MY_CRF: '45638148',
    AUT_MY_MFO: '305299',
    AUT_MY_ACC: 'UA943052990000026000050001037',
    AUT_MY_NAM: 'ОСББ УСПІХ-25',
    AUT_CNTR_CRF: '3145128899',
    AUT_CNTR_MFO: '305299',
    AUT_CNTR_ACC: 'UA113052990000026200000009999',
    AUT_CNTR_NAM: 'ІВАНОВ ІВАН ІВАНОВИЧ',
    PAYER_ULTMT_NAME: 'ПЕТРЕНКО ОЛЕНА ІВАНІВНА',
    PAYER_ULTMT_NCEO: '2987654321',
    CCY: 'UAH',
    FL_REAL: 'r',
    PR_PR: 'r',
    NUM_DOC: 'K0108B1WKX',
    DAT_OD: '14.10.2026',
    TIM_P: '10:15',
    DATE_TIME_DAT_OD_TIM_P: '14.10.2026 10:15:00',
    OSND: 'Сплата внесків за жовтень 2026, кв. 45',
    SUM: '850.50',
    REF: 'DNCHK0108B1WKX',
    REFN: '1',
    TRANTYPE: 'C',
    UETR: 'b23aeadc-1ab7-4c34-a005-0f005a059948'
  };

  const txIn = normalizeTransaction(rawIn);
  assert.equal(txIn.bankId, 'DNCHK0108B1WKX_1');
  assert.equal(txIn.direction, 'in');
  assert.equal(txIn.amountKop, 85050);
  assert.equal(txIn.payerIban, 'UA113052990000026200000009999');
  assert.equal(txIn.payerName, 'ПЕТРЕНКО ОЛЕНА ІВАНІВНА');
  assert.equal(txIn.payerCode, '2987654321');
  assert.equal(txIn.recipientIban, 'UA943052990000026000050001037');
  assert.equal(txIn.recipientName, 'ОСББ УСПІХ-25');
  assert.equal(txIn.recipientCode, '45638148');
  assert.equal(txIn.final, true);
  assert.equal(txIn.void, false);
  assert.equal(txIn.uetr, 'b23aeadc-1ab7-4c34-a005-0f005a059948');

  // Вихідний податковий платіж (TRANTYPE = D) зі структурованим призначенням та DLR
  const rawOut = {
    AUT_MY_CRF: '45638148',
    AUT_MY_ACC: 'UA943052990000026000050001037',
    AUT_MY_NAM: 'ОСББ УСПІХ-25',
    AUT_CNTR_CRF: '37607526',
    AUT_CNTR_ACC: 'UA478999980313060198000015001',
    AUT_CNTR_NAM: 'ГУ ДКСУ в Одеській області',
    CCY: 'UAH',
    FL_REAL: 'r',
    PR_PR: 'r',
    NUM_DOC: '42',
    DAT_OD: '14.10.2026',
    TIM_P: '11:20',
    OSND: '101 ПДФО із заробітної плати за першу половину жовтня 2026 р.',
    SUM: '1556.46',
    REF: 'TAXREF001',
    REFN: '2',
    TRANTYPE: 'D',
    DLR: 'J63DNDSM0XHY5',
    STRUCT_CODE: '101',
    STRUCT_TYPE: '11010100',
    STRUCT_CATEGORY: 'ПДФО'
  };

  const txOut = normalizeTransaction(rawOut);
  assert.equal(txOut.direction, 'out');
  assert.equal(txOut.amountKop, 155646);
  assert.equal(txOut.payerIban, 'UA943052990000026000050001037');
  assert.equal(txOut.recipientIban, 'UA478999980313060198000015001');
  assert.equal(txOut.recipientName, 'ГУ ДКСУ в Одеській області');
  assert.equal(txOut.recipientCode, '37607526');
  assert.equal(txOut.dlr, 'J63DNDSM0XHY5');
  assert.equal(txOut.structCode, '101');
});

test('normalizeTransaction зберігає зворотну сумісність із застарілими полями NAM_A / OKPO_A / ACC_B', () => {
  const legacyRaw = {
    TRANTYPE: 'C',
    AUT_MY_ACC: 'UA943052990000026000050001037',
    NAM_A: 'Коваленко С. П.',
    OKPO_A: '1234567890',
    ACC_B: 'UA943052990000026000050001037',
    NAM_B: 'ОСББ Успіх-25',
    OKPO_B: '45638148',
    SUM: '640.00',
    OSND: 'кв. 298',
    FL_REAL: 'r',
    PR_PR: 't',
    REF: 'REF123',
    REFN: '1'
  };
  const tx = normalizeTransaction(legacyRaw);
  assert.equal(tx.payerName, 'Коваленко С. П.');
  assert.equal(tx.payerCode, '1234567890');
  assert.equal(tx.final, false);
  assert.equal(tx.void, true);
});

test('isReady та fetchSettings працюють як із вкладеним settings (v3.0.0), так і з плоским об’єктом', async () => {
  await withMockFetch(
    async () => jsonResponse({
      status: 'SUCCESS',
      type: 'settings',
      settings: {
        phase: 'WRK',
        work_balance: 'N',
        today: '14.10.2026 00:00:00',
        date_final_statement: '13.10.2026 00:00:00'
      }
    }),
    async (calls) => {
      assert.equal(await isReady('tok-1'), true);
      const s = await fetchSettings('tok-1');
      assert.equal(s.date_final_statement, '13.10.2026 00:00:00');
      assert.ok(calls[0].url.endsWith('/api/statements/settings'));
    }
  );
});

test('fetchTransactions підтримує масив transactions (v3.0.0), пагінацію followId та interim/final', async () => {
  await withMockFetch(
    async (url) => {
      const u = new URL(url);
      if (!u.searchParams.get('followId')) {
        return jsonResponse({
          status: 'SUCCESS',
          type: 'transactions',
          exist_next_page: true,
          next_page_id: 'page_2_cursor',
          transactions: [
            { REF: 'R1', REFN: '1', TRANTYPE: 'C', SUM: '100.00', FL_REAL: 'r', PR_PR: 'r', AUT_MY_ACC: 'UA943052990000026000050001037' }
          ]
        });
      }
      return jsonResponse({
        status: 'SUCCESS',
        type: 'transactions',
        exist_next_page: false,
        transactions: [
          { REF: 'R2', REFN: '1', TRANTYPE: 'D', SUM: '50.00', FL_REAL: 'r', PR_PR: 'r', AUT_MY_ACC: 'UA943052990000026000050001037' }
        ]
      });
    },
    async (calls) => {
      const list = await fetchTransactions('tok-1', {
        iban: 'UA94 305299 0000026000050001037',
        from: new Date('2026-10-01T00:00:00Z'),
        to: new Date('2026-10-14T00:00:00Z')
      });
      assert.equal(list.length, 2);
      assert.equal(list[0].bankId, 'R1_1');
      assert.equal(list[1].bankId, 'R2_1');
      assert.equal(calls.length, 2);
      assert.ok(calls[1].url.includes('followId=page_2_cursor'));
    }
  );

  await withMockFetch(
    async () => jsonResponse({
      status: 'SUCCESS',
      exist_next_page: false,
      transactions: [{ REF: 'INT1', REFN: '1', TRANTYPE: 'C', SUM: '200.00', FL_REAL: 'r', PR_PR: 'r' }]
    }),
    async (calls) => {
      const interim = await fetchInterimTransactions('tok-1', { iban: 'UA943052990000026000050001037' });
      const finalList = await fetchFinalTransactions('tok-1', { iban: 'UA943052990000026000050001037' });
      assert.equal(interim.length, 1);
      assert.equal(finalList.length, 1);
      assert.ok(calls[0].url.includes('/api/statements/transactions/interim'));
      assert.ok(calls[1].url.includes('/api/statements/transactions/final'));
    }
  );
});

test('paymentBody обмежує призначення податкового платежу (МФО 899998) до 140 символів та додає struct_code', () => {
  const longPurpose = '101;45638148;Сплата ПДФО із заробітної плати штатних працівників ОСББ Успіх-25 за жовтень 2026 року згідно відомості нарахування та без затримок понад ліміт 140 символів';
  const taxPayment = {
    docNumber: '105',
    account: 'UA943052990000026000050001037',
    amountKop: 155646,
    purpose: longPurpose,
    recipient: {
      iban: 'UA478999980313060198000015001',
      code: '37607526',
      name: 'ГУ ДКСУ в Одеській області'
    },
    structCategory: 'ПДФО за жовтень 2026'
  };

  assert.equal(isTreasuryAccount(taxPayment.recipient.iban), true);
  const body = paymentBody(taxPayment, new Date('2026-10-14T08:00:00Z'));
  assert.equal(body.struct_code, '101');
  assert.equal(body.struct_category, 'ПДФО за жовтень 2026');
  assert.equal(body.payment_destination.length, 140);
  assert.equal(body.payment_amount, '1556.46');
});

test('createPayment, getPayment, addPaymentSign та deletePayment викликають /api/proxy/payment/* та обробляють HTTP 204', async () => {
  await withMockFetch(
    async (url) => {
      if (url.includes('/api/proxy/payment/create')) {
        return jsonResponse({ payment_ref: '1123828417658092296', payment_pack_ref: 'PACK999' }, 201);
      }
      if (url.includes('/api/proxy/payment/get')) {
        return jsonResponse({
          id: '1123828417658092296',
          payment_ref: '1123828417658092296',
          level_sign: { '1_sign_level': true, '2_sign_level': false }
        });
      }
      if (url.includes('/api/proxy/payment/add-sign')) {
        return jsonResponse({
          id: '1123828417658092296',
          payment_ref: '1123828417658092296',
          level_sign: { '1_sign_level': true, '2_sign_level': true }
        });
      }
      if (url.includes('/api/proxy/payment/delete')) {
        return jsonResponse(null, 204);
      }
      throw new Error(`Unexpected URL: ${url}`);
    },
    async (calls) => {
      const created = await createPayment('tok-1', {
        docNumber: '12',
        account: 'UA943052990000026000050001037',
        amountKop: 500000,
        purpose: 'Оплата за обслуговування ліфтів згідно акту №12',
        recipient: {
          iban: 'UA213052990000026001111111111',
          code: '12345678',
          name: 'ТОВ ОДЕСАЛІФТ'
        }
      });
      assert.equal(created.paymentRef, '1123828417658092296');
      assert.equal(created.bankRef, 'PACK999');

      const info = await getPayment('tok-1', created.paymentRef);
      assert.equal(info.level_sign['1_sign_level'], true);

      const signed = await addPaymentSign('tok-chair', created.paymentRef, 'BASE64_SIGNATURE_DATA');
      assert.equal(signed.level_sign['2_sign_level'], true);

      const deleted = await deletePayment('tok-1', created.paymentRef);
      assert.equal(deleted, true);
      assert.equal(calls.length, 4);
      assert.ok(calls[0].url.startsWith('https://acp.privatbank.ua/api/proxy/payment/create'));
      assert.ok(calls[3].url.startsWith('https://acp.privatbank.ua/api/proxy/payment/delete?ref=1123828417658092296'));
    }
  );
});

test('printReceiptsPdf формує запит до /api/paysheets/print_receipt і повертає Buffer із PDF', async () => {
  const fakePdfBytes = '%PDF-1.4 FAKE RECEIPT';
  await withMockFetch(
    async () => ({
      ok: true,
      status: 200,
      arrayBuffer: async () => Buffer.from(fakePdfBytes)
    }),
    async (calls) => {
      const buf = await printReceiptsPdf('tok-1', [
        { account: 'UA943052990000026000050001037', bankId: 'REGPO0000B0NW0_1' }
      ], { perPage: 4 });
      assert.ok(Buffer.isBuffer(buf));
      assert.equal(buf.toString('utf8'), fakePdfBytes);
      assert.equal(calls[0].url, 'https://acp.privatbank.ua/api/paysheets/print_receipt');
      const reqBody = JSON.parse(calls[0].options.body);
      assert.deepEqual(reqBody, {
        transactions: [{
          account: 'UA943052990000026000050001037',
          reference: 'REGPO0000B0NW0',
          refn: '1'
        }],
        perPage: 4
      });
    }
  );
});

test('checkCounterparty аналізує досьє ЄДР/УБКІ (/api/ubki/check), КВЕДи ФОП та фактори ризику', async () => {
  await withMockFetch(
    async () => jsonResponse({
      reqid: 'req-123',
      dossier: {
        found: '1',
        inn: '2688001363',
        curstate: '1',
        curstatetxt: 'зареєстровано',
        record: [{
          names: { name: 'ФОП КОВАЛЬ НЕЛЯ МИКОЛАЇВНА', display: 'ФОП КОВАЛЬ Н. М.' },
          primaryactivitykind: { code: '69.20', name: 'Діяльність у сфері бухгалтерського обліку й аудиту' },
          activitykinds: [
            { code: '63.99', name: 'Надання інших інформаційних послуг', isprimary: '0' },
            { code: '81.10', name: 'Комплексне обслуговування об’єктів', isprimary: '0' }
          ],
          address: { address: 'м. Одеса, вул. Юхима Фесенка, буд. 15' }
        }]
      },
      warnings: {
        edrpou: '2688001363',
        bancruptcy: { value: 0 },
        penalties: { value: 0 },
        taxDebts: { total: 0 },
        wageDebt: { debt: 0 },
        singletaxRisk: { valueis: false },
        aggressor: { isAggressor: 0 },
        sanctions: { value: false }
      }
    }),
    async (calls) => {
      const res = await checkCounterparty('tok-1', '2688001363');
      assert.equal(res.found, true);
      assert.equal(res.isRegistered, true);
      assert.equal(res.isSafe, true);
      assert.equal(res.hasKved('69.20'), true);
      assert.equal(res.hasKved('81.10'), true);
      assert.equal(res.hasKved('43.21'), false);
      assert.equal(res.riskFlags.length, 0);
      assert.equal(calls[0].url, 'https://acp.privatbank.ua/api/ubki/check');
    }
  );
});

test('uploadTaxReportB64, fetchEdocJournal, createPaymentFromInvoice та fetchCorpCardStatements викликають коректні URL v3.0.0', async () => {
  await withMockFetch(
    async () => jsonResponse({ result: 'success', STATUS: 'SUCCESS' }),
    async (calls) => {
      await uploadTaxReportB64('tok-1', {
        uploadedFileB64: 'PD94bWwgdmVyc2lvbj0iMS4wIj8+',
        uploadedFileName: '155345638148J05001111000000001320261014.XML',
        okpo: '45638148',
        duplicate: 'remove'
      });
      assert.equal(calls[0].url, 'https://acp.privatbank.ua/api/proxy/eo/documents/create-b64');
      assert.ok(calls[0].options.body.includes('okpo=45638148'));

      await fetchEdocJournal('tok-1', {
        folder: 'to-pay',
        dateBegin: '2026-10-01',
        dateEnd: '2026-10-14',
        okpo: '45638148'
      });
      assert.equal(calls[1].url, 'https://acp.privatbank.ua/api/proxy/edoc/journal/to-pay');

      await createPaymentFromInvoice('tok-1', {
        id: '1332185843',
        okpo: '45638148',
        payerAccount: 'UA943052990000026000050001037'
      });
      assert.ok(calls[2].url.startsWith('https://acp.privatbank.ua/api/proxy/edoc/create-payment-from-invoice/1332185843'));

      await fetchCorpCardsList('tok-1', { panState: 'o' });
      assert.equal(calls[3].url, 'https://acp.privatbank.ua/api/corpcards/v2/cards/list');

      await fetchCorpCardStatements('tok-1', {
        id: '1004410776',
        code: '45638148WE',
        type: 'ACCKEY',
        dateStart: '01-10-2026',
        dateEnd: '14-10-2026'
      });
      assert.equal(calls[4].url, 'https://acp.privatbank.ua/api/corpcards/v2/corp/statements?dateStart=01.10.2026&dateEnd=14.10.2026');
    }
  );
});
