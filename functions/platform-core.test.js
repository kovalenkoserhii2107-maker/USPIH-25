'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('./platform-core');

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

    // Тепер зіпсуємо баланс кв. 1 вручну без запису в ledger
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
