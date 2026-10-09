'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const privat = require('./privat');

const sample = {
    AUT_MY_ACC: 'UA213052990000026001234567890', AUT_MY_NAM: 'ОСББ УСПІХ-25',
    AUT_CNTR_ACC: 'UA453052990000029244825509100', AUT_CNTR_NAM: 'ШЕВЧЕНКО ІРИНА МИКОЛАЇВНА', AUT_CNTR_CRF: '1234567890',
    OSND: 'Внесок ОСББ кв.45 жовтень', SUM: '1250.40', CCY: 'UAH', TRANTYPE: 'C', FL_REAL: 'r', PR_PR: 'r',
    DAT_OD: '09.10.2026', TIM_P: '10:12', DATE_TIME_DAT_OD_TIM_P: '09.10.2026 10:12:31', ID: '987654321', REF: 'ABC', REFN: '1'
};

test('надходження з виписки', () => {
    const t = privat.normalizeTransaction(sample);
    assert.equal(t.bankId, 'ABC_1');
    assert.equal(t.direction, 'in');
    assert.equal(t.amountKop, 125040);
    assert.equal(t.account, 'UA213052990000026001234567890');
    assert.equal(t.counterparty.name, 'ШЕВЧЕНКО ІРИНА МИКОЛАЇВНА');
    assert.equal(t.purpose, 'Внесок ОСББ кв.45 жовтень');
    // 10:12 за Києвом (літній час, +03:00) — 07:12 UTC.
    assert.equal(t.at.toISOString(), '2026-10-09T07:12:31.000Z');
    assert.equal(t.final, true);
});

test('списання, зимовий час і запасний ідентифікатор', () => {
    const t = privat.normalizeTransaction({ ...sample, TRANTYPE: 'D', SUM: '150.00', REF: '', DATE_TIME_DAT_OD_TIM_P: '', DAT_OD: '15.12.2026', TIM_P: '23:59' });
    assert.equal(t.direction, 'out');
    assert.equal(t.amountKop, 15000);
    assert.equal(t.bankId, '987654321');
    assert.equal(t.at.toISOString(), '2026-12-15T21:59:00.000Z');
});

test('неостаточна й зіпсована операції', () => {
    assert.equal(privat.normalizeTransaction({ ...sample, FL_REAL: 'i' }).final, false);
    assert.equal(privat.normalizeTransaction({ ...sample, PR_PR: 'p' }).final, false);
    assert.equal(privat.normalizeTransaction({ ...sample, PR_PR: 't' }).void, true);
    assert.equal(privat.normalizeTransaction({ ...sample, TRANTYPE: 'X' }), null);
    assert.equal(privat.normalizeTransaction({ ...sample, SUM: '' }), null);
});

test('дата запиту — за Києвом', () => {
    assert.equal(privat.apiDate(new Date('2026-09-30T22:30:00Z')), '01-10-2026');
});

test('залишок рахунку', () => {
    const b = privat.normalizeBalance({ acc: 'UA21 3052 9900 0002 6001 2345 6789 0', currency: 'UAH', balanceIn: '100.00', balanceOut: '128450.00', nameACC: 'ОСББ' });
    assert.deepEqual([b.iban, b.balanceKop, b.name], ['UA213052990000026001234567890', 12845000, 'ОСББ']);
});

test('тіло платежу для Автоклієнта: усі поля — рядки', () => {
    const body = privat.paymentBody({ docNumber: 'AB12', account: 'ua21 3052', recipient: { name: 'ТОВ Ліфт', iban: 'UA90 6543 2100 0000 0260 3230 1202 4', code: '12345678' },
        amountKop: 425050, purpose: 'Ліфти за жовтень 2026' }, new Date('2026-10-09T10:00:00Z'));
    assert.deepEqual(body, {
        document_number: 'AB12', document_type: 'cr', payer_account: 'UA213052', recipient_account: 'UA906543210000000260323012024',
        recipient_nceo: '12345678', payment_naming: 'ТОВ Ліфт', payment_amount: '4250.50', payment_destination: 'Ліфти за жовтень 2026',
        payment_ccy: 'UAH', payment_date: '09.10.2026', payment_accept_date: '09.10.2026'
    });
    assert.ok(Object.values(body).every(v => typeof v === 'string'));
});

test('створення й видалення платежу: запити й відповіді банку', async () => {
    const calls = [];
    const real = global.fetch;
    global.fetch = async (url, init) => {
        calls.push([String(url), init.method, init.headers['Content-Type']]);
        if (String(url).endsWith('/create')) return new Response(JSON.stringify({ payment_ref: 'R1', payment_pack_ref: 'P1', payment_data: { payment_status: 'new' } }), { status: 201 });
        if (String(url).includes('/delete')) return new Response(null, { status: 204 });
        return new Response(JSON.stringify({ status: 'ERROR', message: 'invalid document number', serviceCode: 'PMTSRV0112' }), { status: 400 });
    };
    try {
        const created = await privat.createPayment('t', { docNumber: '1', account: 'UA1', recipient: { name: 'X', iban: 'UA2', code: '12345678' }, amountKop: 100, purpose: 'Тест платежу' });
        assert.deepEqual(created, { bankRef: 'P1', paymentRef: 'R1', status: 'new' });
        assert.equal(await privat.deletePayment('t', 'R1'), true);
        assert.deepEqual(calls[0], ['https://acp.privatbank.ua/api/proxy/payment/create', 'POST', 'application/json;charset=utf8']);
        assert.equal(calls[1][0], 'https://acp.privatbank.ua/api/proxy/payment/delete?ref=R1');
        global.fetch = async () => new Response(JSON.stringify({ status: 'ERROR', code: 400, message: 'invalid document number', serviceCode: 'PMTSRV0112' }), { status: 400 });
        await assert.rejects(privat.createPayment('t', { docNumber: '1', account: 'UA1', recipient: { name: 'X', iban: 'UA2', code: '1' }, amountKop: 1, purpose: 'x' }), /invalid document number \(PMTSRV0112\)/);
    } finally { global.fetch = real; }
});
