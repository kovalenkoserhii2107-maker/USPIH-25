'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const advance = require('./advance-core');
const journal = require('./journal-core');

test('валідація авансового звіту: підзвітна особа, чеки, суми та дати', () => {
    assert.match(advance.checkAdvanceReport(null), /Немає даних/);
    assert.match(advance.checkAdvanceReport({ personName: '' }), /ПІБ підзвітної особи/);
    assert.match(advance.checkAdvanceReport({ personName: 'Іваненко І.І.', date: 'не-дата' }), /дату/);
    assert.match(advance.checkAdvanceReport({ personName: 'Іваненко І.І.', date: '2026-10-15', period: '2026-10', purpose: '' }), /призначення/);

    const validBase = {
        personName: 'Коваленко Сергій Миколайович',
        date: '2026-10-15',
        period: '2026-10',
        purpose: 'Купівля палива для генератора та лампочок',
        advanceKop: 0,
        lines: []
    };
    assert.match(advance.checkAdvanceReport(validBase), /хоча б один підтвердний документ/);

    const reportWithFutureCheck = {
        ...validBase,
        lines: [
            { docType: 'fiscal_receipt', number: '1234', date: '2026-10-16', amountKop: 50000, postingAcc: '92', item: 'office' }
        ]
    };
    assert.match(advance.checkAdvanceReport(reportWithFutureCheck), /не може бути пізнішою за дату звіту/);

    const okReport = {
        ...validBase,
        lines: [
            { docType: 'fiscal_receipt', number: 'Ч-8901', date: '2026-10-14', amountKop: 150000, postingAcc: '92', item: 'systems' },
            { docType: 'fiscal_receipt', number: 'Ч-8902', date: '2026-10-15', amountKop: 85000, postingAcc: '20', assetId: 'ТМЦ-001' }
        ]
    };
    assert.equal(advance.checkAdvanceReport(okReport), null);
});

test('розрахунок підсумків: перевитрата до компенсації та невикористаний аванс', () => {
    const r1 = advance.calculateReportTotals({
        advanceKop: 0,
        lines: [
            { amountKop: 150000 },
            { amountKop: 85000 }
        ]
    });
    assert.equal(r1.spentKop, 235000);
    assert.equal(r1.advanceKop, 0);
    assert.equal(r1.reimburseKop, 235000);
    assert.equal(r1.returnKop, 0);
    assert.equal(r1.pendingReimburseKop, 235000);

    const r2 = advance.calculateReportTotals({
        advanceKop: 300000,
        lines: [
            { amountKop: 235000 }
        ]
    });
    assert.equal(r2.spentKop, 235000);
    assert.equal(r2.advanceKop, 300000);
    assert.equal(r2.reimburseKop, 0);
    assert.equal(r2.returnKop, 65000);
    assert.equal(r2.pendingReturnKop, 65000);

    const r3 = advance.calculateReportTotals({
        advanceKop: 200000,
        reimbursedKop: 50000,
        lines: [
            { amountKop: 250000 }
        ]
    });
    assert.equal(r3.reimburseKop, 50000);
    assert.equal(r3.pendingReimburseKop, 0);
    assert.equal(r3.isFullySettled, true);
});

test('побудова проводок за авансовим звітом (Дт 92/20/22 Кт 372) та закриття цільового фінансування (Дт 48 Кт 719)', () => {
    const report = {
        id: 'АЗ-2026-10/01',
        number: 'АЗ-2026-10/01',
        date: '2026-10-18',
        period: '2026-10',
        personName: 'Коваленко Сергій Миколайович',
        fundId: 'main',
        status: 'approved',
        advanceKop: 0,
        lines: [
            { docType: 'fiscal_receipt', number: 'Ч-1', date: '2026-10-17', amountKop: 120000, postingAcc: '92', item: 'systems', desc: 'Заміна запобіжників щитової' },
            { docType: 'fiscal_receipt', number: 'Ч-2', date: '2026-10-18', amountKop: 80000, postingAcc: '20', assetId: 'ТМЦ-005', desc: 'Мастило для генератора' }
        ]
    };
    const entries = advance.buildAdvanceEntries(report, 'main');
    assert.equal(entries.length, 2);

    const bankTx = [
        {
            id: 'tx-reimburse',
            period: '2026-10',
            at: new Date('2026-10-20T10:00:00Z'),
            account: 'UA213052990000026001234567890',
            direction: 'out',
            kind: 'expense',
            status: 'done',
            category: 'advance',
            advanceReportId: 'АЗ-2026-10/01',
            amountKop: 200000,
            counterparty: { name: 'Коваленко Сергій Миколайович' }
        }
    ];

    const input = {
        start: '2026-10',
        startDate: '2026-10-01',
        policy: { startDate: '2026-10-01', status: 'approved', defaultFund: 'main', funds: [{ id: 'main', name: 'Основний' }], incomeAccounts: {} },
        opening: { status: 'approved', lines: [{ acc: '311', a: 'UA213052990000026001234567890', side: 'dr', kop: 500000 }, { acc: '48', a: 'main', side: 'cr', kop: 500000 }] },
        bankTx,
        advanceReports: [report]
    };

    const jEntries = journal.journal(input, '2026-10');
    const tb = journal.trialBalance(jEntries, '2026-10');
    assert.equal(tb.balanced, true);

    const r372 = tb.rows.find(r => r.acc === '372');
    assert.ok(r372);
    assert.equal(r372.dr, 200000);
    assert.equal(r372.cr, 200000);
    assert.equal(r372.closeDr - r372.closeCr, 0);

    const r48 = tb.rows.find(r => r.acc === '48');
    assert.equal(r48.dr, 120000);
});
