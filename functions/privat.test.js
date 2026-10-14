'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const privat = require('./privat');

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
    headers: { get: () => null },
    text: async () => text,
    json: async () => JSON.parse(text),
    arrayBuffer: async () => Buffer.from(text)
  };
}

test('apiDate formats Kyiv calendar day as DD-MM-YYYY', () => {
  const d = new Date('2026-10-09T14:05:00Z');
  assert.equal(privat.apiDate(d), '09-10-2026');
});

test('parseBankDate handles full ISO-like bank date and separate fields in Kyiv time', () => {
  const dt = privat.parseBankDate('09.10.2026 14:05:31');
  assert.equal(dt.toISOString(), '2026-10-09T11:05:31.000Z');

  const sep = privat.parseBankDate(null, '09.10.2026', '14:05');
  assert.equal(sep.toISOString(), '2026-10-09T11:05:00.000Z');

  assert.equal(privat.parseBankDate('invalid'), null);
});

test('normalizeTransaction maps credit and debit operations and rejects malformed rows', () => {
  const rawCredit = {
    REF: 'REF123',
    REFN: '1',
    TRANTYPE: 'C',
    SUM: '1500.50',
    DATE_TIME_DAT_OD_TIM_P: '09.10.2026 10:00:00',
    AUT_MY_ACC: 'UA123456789012345678901234567',
    AUT_CNTR_NAM: 'ПП "Тест"',
    AUT_CNTR_ACC: 'UA987654321098765432109876543',
    AUT_CNTR_CRF: '12345678',
    OSND: 'Оплата послуг',
    FL_REAL: 'r',
    PR_PR: 'r',
    CCY: 'UAH'
  };

  const norm = privat.normalizeTransaction(rawCredit);
  assert.deepEqual(norm, {
    bankId: 'REF123_1',
    statementRef: 'REF123',
    statementRefn: '1',
    account: 'UA123456789012345678901234567',
    at: new Date('2026-10-09T07:00:00.000Z'),
    direction: 'in',
    amountKop: 150050,
    currency: 'UAH',
    purpose: 'Оплата послуг',
    counterparty: {
      name: 'ПП "Тест"',
      account: 'UA987654321098765432109876543',
      code: '12345678'
    },
    dlr: null,
    final: true,
    void: false
  });

  // Якщо вказано кінцевого платника PAYER_ULTMT_NAME / PAYER_ULTMT_NCEO (вимога НБУ в API v3.0.0)
  const rawUltmt = {
    ...rawCredit,
    PAYER_ULTMT_NAME: 'Коваленко Сергій Пилипович',
    PAYER_ULTMT_NCEO: '2987654321'
  };
  const normUltmt = privat.normalizeTransaction(rawUltmt);
  assert.equal(normUltmt.counterparty.name, 'Коваленко Сергій Пилипович');
  assert.equal(normUltmt.counterparty.code, '2987654321');

  // Некоректна сума повертає null
  assert.equal(privat.normalizeTransaction({ ...rawCredit, SUM: '100oops' }), null);
});

test('a malformed final bank transaction aborts fetchTransactions instead of silently losing money', async () => {
  const raw = {
    REF: 'one',
    REFN: '1',
    TRANTYPE: 'C',
    SUM: '100oops',
    DATE_TIME_DAT_OD_TIM_P: '10.10.2026 12:00',
    FL_REAL: 'r',
    PR_PR: 'r',
    CCY: 'UAH'
  };
  await withMockFetch(
    async () => jsonResponse({ transactions: [raw], exist_next_page: false }),
    async () => {
      await assert.rejects(
        privat.fetchTransactions('mock', {
          iban: 'UA123456789012345678901234567',
          from: new Date('2026-10-01'),
          to: new Date('2026-10-10')
        }),
        /некоректну проведену операцію/
      );
    }
  );
});

test('normalizeBalance parses account balance correctly', () => {
  const raw = {
    acc: 'UA123456789012345678901234567',
    balanceOut: '2500.00',
    currency: 'UAH',
    nameACC: 'Основнии рахунок'
  };

  const norm = privat.normalizeBalance(raw);
  assert.equal(norm.iban, 'UA123456789012345678901234567');
  assert.equal(norm.balanceKop, 250000);
  assert.equal(norm.currency, 'UAH');
  assert.equal(norm.name, 'Основнии рахунок');
});

test('paymentBody formats regular and tax (Treasury MFO 899998) payout payloads correctly', () => {
  const payout = {
    docNumber: '101',
    account: 'UA111111111111111111111111111',
    recipient: {
      iban: 'UA222222222222222222222222222',
      code: '87654321',
      name: 'ТОВ "Постачальник"'
    },
    amountKop: 35000,
    purpose: 'За матеріали'
  };

  const body = privat.paymentBody(payout, new Date('2026-10-09T00:00:00Z'));
  assert.deepEqual(body, {
    document_number: '101',
    document_type: 'cr',
    payer_account: 'UA111111111111111111111111111',
    recipient_account: 'UA222222222222222222222222222',
    recipient_nceo: '87654321',
    payment_naming: 'ТОВ "Постачальник"',
    payment_amount: '350.00',
    payment_destination: 'За матеріали',
    payment_ccy: 'UAH',
    payment_date: '09.10.2026',
    payment_accept_date: '09.10.2026'
  });

  // Податковий платіж на Казначейство (МФО 899998): ліміт 140 символів та struct_code = 101
  const longPurpose = '101;45638148;Сплата ПДФО із заробітної плати штатних працівників ОСББ Успіх-25 за жовтень 2026 року згідно відомості нарахування та без затримок понад ліміт 140 символів';
  const taxBody = privat.paymentBody({
    docNumber: '105',
    account: 'UA111111111111111111111111111',
    recipient: {
      iban: 'UA478999980313060198000015001',
      code: '37607526',
      name: 'ГУ ДКСУ в Одеській області'
    },
    amountKop: 155646,
    purpose: longPurpose,
    structCategory: 'ПДФО за жовтень 2026'
  }, new Date('2026-10-09T00:00:00Z'));

  assert.equal(taxBody.struct_code, '101');
  assert.equal(taxBody.struct_category, 'ПДФО за жовтень 2026');
  assert.equal(taxBody.payment_destination.length, 140);
});

test('getPayment, addPaymentSign, printReceiptsPdf, checkCounterparty and uploadTaxReportB64 work per API v3.0.0', async () => {
  await withMockFetch(
    async (url) => {
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
      if (url.includes('/api/paysheets/print_receipt')) {
        return {
          ok: true,
          status: 200,
          arrayBuffer: async () => Buffer.from('%PDF-1.4 RECEIPT')
        };
      }
      if (url.includes('/api/ubki/check')) {
        return jsonResponse({
          reqid: 'req-1',
          dossier: {
            found: '1',
            inn: '2688001363',
            curstate: '1',
            curstatetxt: 'зареєстровано',
            record: [{
              names: { name: 'ФОП КОВАЛЬ НЕЛЯ МИКОЛАЇВНА', display: 'ФОП КОВАЛЬ Н. М.' },
              primaryactivitykind: { code: '69.20', name: 'Діяльність у сфері бухгалтерського обліку й аудиту' },
              activitykinds: [{ code: '81.10', name: 'Комплексне обслуговування об’єктів', isprimary: '0' }]
            }]
          },
          warnings: {
            bancruptcy: { value: 0 },
            penalties: { value: 0 },
            taxDebts: { total: 0 },
            wageDebt: { debt: 0 },
            singletaxRisk: { valueis: false },
            aggressor: { isAggressor: 0 },
            sanctions: { value: false }
          }
        });
      }
      if (url.includes('/api/proxy/eo/documents/create-b64')) {
        return jsonResponse({ result: 'success', documents: [{ id: 'doc-1', result: 'success' }] });
      }
      throw new Error(`Unexpected URL: ${url}`);
    },
    async () => {
      const info = await privat.getPayment('tok-1', '1123828417658092296');
      assert.equal(info.level_sign['1_sign_level'], true);

      const signed = await privat.addPaymentSign('tok-chair', '1123828417658092296', 'BASE64_SIG');
      assert.equal(signed.level_sign['2_sign_level'], true);

      const pdfBuf = await privat.printReceiptsPdf('tok-1', [
        { account: 'UA123456789012345678901234567', bankId: 'REF123_1' }
      ]);
      assert.equal(pdfBuf.toString('utf8'), '%PDF-1.4 RECEIPT');

      const cp = await privat.checkCounterparty('tok-1', '2688001363');
      assert.equal(cp.isSafe, true);
      assert.equal(cp.hasKved('69.20'), true);
      assert.equal(cp.hasKved('81.10'), true);

      const eo = await privat.uploadTaxReportB64('tok-1', {
        uploadedFileB64: 'PD94bWw+',
        uploadedFileName: 'report.xml',
        okpo: '45638148'
      });
      assert.equal(eo.result, 'success');
    }
  );
});
