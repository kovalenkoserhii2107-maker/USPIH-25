'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const charges = require('./charges-core');
const journal = require('./journal-core');
const reports = require('./reports-core');
const payroll = require('./payroll-core');
const privat = require('./privat');
const { reconcile } = require('./reconciliation-core');

test('independent monthly reconciliation: formulas, component allocations, balances and account 377 agree', () => {
    let seed = 12345;
    const random = n => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % n; };
    const rounded = (a, b, denominator) => Number((BigInt(a) * BigInt(b) + BigInt(denominator / 2)) / BigInt(denominator));
    for (let sample = 0; sample < 100; sample++) {
        const entries = [{ kind: 'opening', period: '2026-09', amountKop: -31000, at: new Date('2026-09-30'), parts: { main: -15000, lift: -10000, light: -6000 } }];
        const bankTx = [];
        let expected = -31000;
        for (const period of ['2026-10', '2026-11', '2026-12']) {
            const area = 4800 + random(6000), rate = 45000 + random(50001), fixed = 123 + random(3000);
            const main = rounded(area, rate, 10000), light = rounded(area, 12100, 10000);
            const amountKop = main + light + fixed;
            const actual = charges.computeCharges({ period, apartments: [{ apt: '45', area: area / 100 }], components: [{ id: 'main', base: 'area' }, { id: 'light', base: 'area' }, { id: 'lift', base: 'fixed' }], tariffs: [{ group: 'res', from: period, rate4: rate }, { group: 'res', from: period, component: 'light', rate4: 12100 }, { group: 'res', from: period, component: 'lift', rate4: fixed * 100 }] });
            assert.equal(actual.totalKop, amountKop);
            const parts = [{ component: 'main', amountKop: main }, { component: 'light', amountKop: light }, { component: 'lift', amountKop: fixed }];
            entries.push({ kind: 'charge', period, amountKop, parts, at: charges.chargeDate(period) });
            expected -= amountKop;
            for (let i = 0; i < 3; i++) {
                const payment = 1 + random(60000);
                const at = new Date(`${period}-${String(5 + i * 7).padStart(2, '0')}T10:00:00Z`);
                entries.push({ kind: 'payment', period, amountKop: payment, at });
                bankTx.push({ id: `${period}-${i}`, period, at, direction: 'in', kind: 'payment', status: 'done', amountKop: payment, account: 'bank', allocations: [{ apt: '45', amountKop: payment }] });
                expected += payment;
            }
            const statement = charges.statement(new Map([['45', entries]]), period, charges.START_PERIOD, ['main', 'light', 'lift']);
            assert.equal(statement.totals.closing, expected);
            assert.equal(Object.values(statement.byComponent).reduce((s, v) => s + v.closing, 0), expected);
            const tb = journal.trialBalance(journal.journal({ ledgers: new Map([['45', entries]]), bankTx }, period), period);
            const row = tb.rows.find(r => r.acc === '377');
            assert.equal(row.closeCr - row.closeDr, expected);
            assert.equal(tb.balanced, true);
        }
        const { steps, balances } = charges.replay(entries, { order: ['main', 'light', 'lift'] });
        for (const { entry, parts } of steps) if (entry.kind === 'payment') assert.equal(Object.values(parts).reduce((s, v) => s + v, 0), entry.amountKop);
        assert.equal(Object.values(balances).reduce((s, v) => s + v, 0), expected);
    }
});

const employee = { id: 'e1', name: 'Працівник Тестовий', kind: 'employee', salaryKop: 864700, fte: 1, mainJob: true, rnokpp: '3124567809', iban: 'UA906543210000000260323012024', taxNotified: true, from: '2026-10-16' };
test('D1 uses calendar relationship days from the frozen payroll, not working days or a changed card', () => {
    const run = payroll.buildRun({ people: [employee], period: '2026-10' });
    const changed = { ...employee, from: '2026-10-01', rnokpp: '9999999999' };
    const report = reports.payrollReport({ period: '2026-10', stored: { status: 'approved', run }, people: new Map([['e1', changed]]) });
    assert.equal(report.esv[0].days, 16);
    assert.equal(report.income[0].rnokpp, employee.rnokpp);
    assert.deepEqual(report.relations.map(r => r.date), ['2026-10-16']);
});

test('a tiny confirmed tax payment is not reported as the whole calculated tax', () => {
    const run = payroll.buildRun({ people: [{ ...employee, from: '2026-01-01' }], period: '2026-10' });
    const report = reports.payrollReport({ period: '2026-10', stored: { status: 'approved', run }, payments: [{ stage: 'final', key: 'esv', status: 'paid', amountKop: 1 }] });
    assert.equal(report.summary.esvPaidKop, 1);
    assert.ok(report.checks.some(c => /ЄСВ сплачено не повністю/.test(c.text)));
});

test('a malformed final bank transaction aborts the statement instead of silently losing money', async () => {
    const original = global.fetch;
    const raw = { REF: 'one', REFN: '1', TRANTYPE: 'C', SUM: '100oops', DATE_TIME_DAT_OD_TIM_P: '10.10.2026 12:00', FL_REAL: 'r', PR_PR: 'r', CCY: 'UAH' };
    global.fetch = async () => new Response(JSON.stringify({ transactions: [raw], exist_next_page: false }), { status: 200 });
    try { await assert.rejects(privat.fetchTransactions('mock', { iban: employee.iban, from: new Date('2026-10-01'), to: new Date('2026-10-10') }), /некоректну проведену операцію/); }
    finally { global.fetch = original; }
});

test('historical payroll still accrues an employee terminated in that month and records the calendar event', () => {
    const fired = { ...employee, from: '2026-01-01', to: '2026-10-16', active: false };
    const run = payroll.buildRun({ people: [fired], period: '2026-10' });
    assert.equal(run.rows.length, 1);
    assert.equal(run.rows[0].grossKop, 471655);
    assert.equal(payroll.buildRun({ people: [fired], period: '2026-11' }).rows.length, 0);
    const report = reports.payrollReport({ period: '2026-10', stored: { status: 'approved', run }, people: new Map() });
    assert.equal(report.esv[0].days, 16);
    assert.deepEqual(report.relations.map(r => [r.event, r.date]), [['end', '2026-10-16']]);
});

test('actual tax payments are allocated in whole kopecks, canceled advances do not reduce final reporting', () => {
    const run = payroll.buildRun({ people: [employee, { ...employee, id: 'e2', name: 'Другий Працівник', salaryKop: 1010000 }], period: '2026-10' });
    const payments = [{ stage: 'advance', key: 'pdfo', status: 'canceled', amountKop: 100 }, { stage: 'final', key: 'pdfo', status: 'paid', amountKop: 11111 }];
    const report = reports.payrollReport({ period: '2026-10', stored: { status: 'approved', run }, payments });
    assert.equal(report.income.reduce((s, p) => s + p.pdfoPaidKop, 0), 11111);
    assert.equal(report.summary.pdfoPaidKop, 11111);
    assert.ok(report.income.every(p => Number.isInteger(p.pdfoPaidKop) && p.pdfoPaidKop <= p.pdfoKop));
});

test('source reconciliation detects missing/duplicate bank allocations and component amounts, beyond balanced journal entries', () => {
    const charge = { _id: 'charge-2026-10', source: 'charges', period: '2026-10', kind: 'charge', amountKop: 5000, parts: [{ component: 'main', amountKop: 5000 }] };
    const payment = { _id: 'bank-one', txId: 'one', source: 'bank', period: '2026-10', kind: 'payment', amountKop: 2500 };
    const input = { period: '2026-10', runs: [{ period: '2026-10', count: 1, totalKop: 5000, amounts: { 45: 5000 } }], ledgers: new Map([['45', [charge, payment]]]),
        bankTx: [{ id: 'one', direction: 'in', kind: 'payment', status: 'done', period: '2026-10', amountKop: 2500, allocations: [{ apt: '45', ledgerId: 'bank-one', amountKop: 2500 }] }] };
    assert.deepEqual(reconcile(input), []);
    assert.ok(reconcile({ ...input, ledgers: new Map([['45', [charge]]]) }).some(c => /відсутній/.test(c.text)));
    assert.ok(reconcile({ ...input, bankTx: [] }).some(c => /не підтверджено/.test(c.text)));
    assert.ok(reconcile({ ...input, ledgers: new Map([['45', [{ ...charge, parts: [{ component: 'main', amountKop: 1 }] }, payment]]]) }).some(c => /складових/.test(c.text)));
    assert.ok(reconcile({ ...input, runs: [{ ...input.runs[0], complete: false }] }).some(c => /Неповне/.test(c.text)));
    assert.ok(reconcile({ ...input, ledgers: new Map([['45', [charge, { ...charge, _id: 'imported', source: 'file' }, payment]]]) }).some(c => /імпорт історії/.test(c.text)));
});

test('reporting keeps an originally empty taxpayer ID and does not invent a full month for an undated civil contract', () => {
    const gph = { ...employee, id: 'g1', kind: 'gph', from: '', rnokpp: '' };
    const run = payroll.buildRun({ people: [gph], inputs: { g1: { actKop: 10000 } }, period: '2026-10' });
    const report = reports.payrollReport({ period: '2026-10', stored: { status: 'approved', run }, people: new Map([['g1', { ...gph, from: '2026-10-01', rnokpp: employee.rnokpp }]]) });
    assert.equal(report.income[0].rnokpp, '');
    assert.equal(report.esv[0].days, null);
    assert.ok(report.checks.some(c => c.level === 'block' && /дати початку/.test(c.text)));
});

test('expense and payroll totals reconcile to original source records, not just bank categories', () => {
    const input = { period: '2026-10', bankTx: [{ id: 'one', direction: 'out', kind: 'expense', status: 'done', period: '2026-10', amountKop: 5000, expenseId: 'e1', paymentId: 'p1' }],
        expenses: [{ id: 'e1', status: 'paid', period: '2026-10', amountKop: 5000, paidKop: 5000, txIds: ['one'] }],
        payments: [{ id: 'p1', status: 'paid', amountKop: 5000, txId: 'one' }] };
    assert.deepEqual(reconcile(input), []);
    assert.ok(reconcile({ ...input, expenses: [{ ...input.expenses[0], paidKop: 1 }] }).some(c => /сума оплат/.test(c.text)));
    assert.ok(reconcile({ ...input, payments: [{ ...input.payments[0], amountKop: 1 }] }).some(c => /не відповідає платіжному/.test(c.text)));
    const run = payroll.buildRun({ people: [employee], period: '2026-10' });
    assert.deepEqual(reconcile({ period: '2026-10', payrollRuns: [{ period: '2026-10', status: 'approved', run }] }), []);
    assert.ok(reconcile({ period: '2026-10', payrollRuns: [{ period: '2026-10', status: 'approved', run: { ...run, totals: { ...run.totals, grossKop: 1 } } }] }).some(c => /підсумки/.test(c.text)));
});
