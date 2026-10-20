'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('./platform-core');
const privat = require('./privat');
const bankCore = require('./bank-core');
const paymentsCore = require('./payments-core');

test('validEdrpouChecksum та normalizeTenantSlug коректно перевіряють код ЄДРПОУ і генерують slug', () => {
    assert.equal(core.validEdrpouChecksum('40562894'), true);
    assert.equal(core.validEdrpouChecksum('12345679'), false);
    assert.equal(core.normalizeTenantSlug('ОСББ «Успіх-25»'), 'osbb-uspikh-25');
    assert.equal(core.normalizeTenantSlug('ОСББ Сонячний Квартал'), 'osbb-soniachnyi-kvartal');
});

test('validateTenantInput валідує реквізити нового ОСББ та рівень ізоляції БД', () => {
    const valid = core.validateTenantInput({
        name: 'ОСББ «Морський Бриз»',
        edrpou: '40562894',
        city: 'м. Одеса',
        address: 'вул. Французький бульвар, 10',
        apartmentsCount: 140,
        isolationMode: 'namespace_prefix',
        status: 'active'
    });
    assert.equal(valid.ok, true);
    assert.equal(valid.tenant.id, 'osbb-morskyi-bryz');
    assert.equal(valid.tenant.isolationMode, 'namespace_prefix');

    const badEdrpou = core.validateTenantInput({
        name: 'ОСББ «Тест»',
        edrpou: '11111111'
    });
    assert.equal(badEdrpou.ok, false);
    assert.match(badEdrpou.error, /ЄДРПОУ/);
});

test('computePatchDiff та validateManualPatch захищають системні поля і вимагають підставу для аудиту', () => {
    const noReason = core.validateManualPatch({
        collection: 'apartments',
        docId: '25',
        patch: { area: 64.5 },
        reason: 'ок'
    });
    assert.equal(noReason.ok, false);
    assert.match(noReason.error, /підставу/);

    const validPatch = core.validateManualPatch({
        collection: 'apartments',
        docId: '25',
        patch: { id: '999', _sandboxUid: 'hack', area: 64.5, personalAccount: '0025' },
        reason: 'Уточнення площі за технічним паспортом БТІ'
    });
    assert.equal(validPatch.ok, true);
    assert.equal('id' in validPatch.cleanPatch, false);
    assert.equal('_sandboxUid' in validPatch.cleanPatch, false);
    assert.equal(validPatch.cleanPatch.area, 64.5);

    const diffs = core.computePatchDiff(
        { area: 60.0, personalAccount: '0025', balance: -1200 },
        validPatch.cleanPatch
    );
    assert.equal(diffs.length, 1);
    assert.deepEqual(diffs[0], { field: 'area', before: 60.0, after: 64.5 });
});

test('evaluateAccountingInvariants виявляє розбіжності між балансом квартири та історією ledger', () => {
    const apartments = [
        { id: '1', balance: -500, balanceSource: 'ledger' },
        { id: '2', balance: 200, balanceSource: 'ledger' }
    ];
    const ledgersByApt = new Map([
        ['1', [
            { kind: 'opening', amountKop: 0 },
            { kind: 'charge', amountKop: 100000 },
            { kind: 'payment', amountKop: 50000 }
        ]],
        ['2', [
            { kind: 'opening', amountKop: 20000 }
        ]]
    ]);
    const okRes = core.evaluateAccountingInvariants({
        apartments,
        ledgersByApt,
        bankTx: [{ id: 'tx1', status: 'done' }],
        payments: [{ id: 'p1', status: 'sent', txId: 'tx1' }],
        closedPeriods: [{ id: '2026-10', status: 'closed', totalDrKop: 150000, totalCrKop: 150000 }]
    });
    assert.equal(okRes.allOk, true);
    assert.equal(okRes.failedCount, 0);

    apartments[0].balance = 0;
    const failRes = core.evaluateAccountingInvariants({
        apartments,
        ledgersByApt,
        bankTx: [],
        payments: [],
        closedPeriods: []
    });
    assert.equal(failRes.allOk, false);
    assert.equal(failRes.checks[0].ok, false);
});

test('summarizeUserActivity рахує активацію кабінетів, боржників і активність за журналом аудиту', () => {
    const nowMs = Date.parse('2026-10-20T12:00:00Z');
    const summary = core.summarizeUserActivity({
        apartments: [
            { id: '1', passwordChanged: true, balance: -450.5 },
            { id: '2', passwordChanged: false, balance: 120 },
            { id: '3', passwordChanged: true, balance: 0 },
            { id: '999', isAdmin: true }
        ],
        staff: [
            { id: 'chair1', active: true, role: 'chair' },
            { id: 'buh1', active: true, role: 'accountant' }
        ],
        auditLogs: [
            { actor: 'buh1', action: 'charges.run', at: '2026-10-20T10:00:00Z' },
            { actor: 'chair1', action: 'platform.manualPatch', at: '2026-10-19T18:00:00Z' }
        ],
        nowMs
    });
    assert.equal(summary.totalApartments, 3);
    assert.equal(summary.activatedApartments, 2);
    assert.equal(summary.debtorsCount, 1);
    assert.equal(summary.overpaidCount, 1);
    assert.equal(summary.zeroBalanceCount, 1);
    assert.equal(summary.staffByRole.chair, 1);
    assert.equal(summary.staffByRole.accountant, 1);
    assert.equal(summary.events24h, 2);
});

test('buildPrivatRawTransaction та buildPrivatPaymentApiLifecycle повністю сумісні з privat.normalizeTransaction і bank-core', () => {
    // 1. Перевірка вхідного платежу мешканця (TRANTYPE: 'C')
    const rawIn = core.buildPrivatRawTransaction({
        account: 'UA213052990000026007054321001',
        direction: 'in',
        amountKop: 85000,
        counterpartyName: 'Коваленко Олена Василівна',
        counterpartyCode: '3124567890',
        counterpartyIban: 'UA213052990000026201234567891',
        purpose: 'Внески на утримання будинку, кв. 12, особовий рахунок 0012',
        date: '2026-10-20',
        time: '14:25',
        ref: 'P24SIM001',
        refn: '1'
    });
    assert.equal(rawIn.TRANTYPE, 'C');
    assert.equal(rawIn.FL_REAL, 'r');
    assert.equal(rawIn.PR_PR, 'r');
    assert.equal(rawIn.SUM, '850.00');
    assert.equal(rawIn.DAT_OD, '20.10.2026');

    const normIn = privat.normalizeTransaction(rawIn);
    assert.ok(normIn);
    assert.equal(normIn.direction, 'in');
    assert.equal(normIn.amountKop, 85000);
    assert.equal(normIn.final, true);
    assert.equal(normIn.void, false);

    const decision = bankCore.classify(normIn, {
        known: {
            apts: new Set(['12', '14']),
            accounts: new Map([['0012', '12']])
        },
        owners: [{ apt: '12', name: 'Коваленко Олена Василівна' }],
        links: new Map(),
        ownAccounts: new Set(['UA213052990000026007054321001'])
    });
    assert.equal(decision.status, 'matched');
    assert.equal(decision.apt, '12');

    // 2. Перевірка підписання вихідного платежу (TRANTYPE: 'D', DLR == payment.bankRef)
    const samplePayment = {
        id: 'pay-exp-1',
        kind: 'supplier',
        account: 'UA213052990000026007054321001',
        amountKop: 420000,
        purpose: 'Оплата за тех. обслуговування ліфтів згідно з актом № 18 від 15.10.2026, без ПДВ',
        recipient: {
            name: 'ТОВ «Одесаліфт-Сервіс»',
            code: '34512890',
            iban: 'UA553052990000026007778889991'
        },
        docNumber: 'A1B2C3D4E5',
        bankRef: 'P24PACK-A1B2C3D4E5',
        paymentRef: 'P24DOC-A1B2C3D4E5',
        status: 'sent',
        sentAt: new Date('2026-10-20T10:00:00Z')
    };

    const lifecycle = core.buildPrivatPaymentApiLifecycle(samplePayment, {
        date: '2026-10-20',
        time: '15:10'
    });
    assert.equal(lifecycle.createPayload.document_number, 'A1B2C3D4E5');
    assert.equal(lifecycle.statementTx.TRANTYPE, 'D');
    assert.equal(lifecycle.statementTx.DLR, 'P24PACK-A1B2C3D4E5');

    const normOut = privat.normalizeTransaction(lifecycle.statementTx);
    assert.ok(normOut);
    assert.equal(normOut.direction, 'out');
    assert.equal(normOut.amountKop, 420000);
    assert.equal(normOut.dlr, 'P24PACK-A1B2C3D4E5');
    assert.equal(paymentsCore.matchesPayment(normOut, samplePayment), true);
});
