'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const bank = require('./bank-core');
const charges = require('./charges-core');
const budget = require('./budget-core');
const journal = require('./journal-core');
const payroll = require('./payroll-core');
const payments = require('./payments-core');

test('decimal money and legacy ledger amounts do not lose cents or accept partial numbers', () => {
    for (const [input, expected] of [['1.005', 101], [-1.005, -101], ['1 250,40 грн', 125040], ['−0,005', -1], ['0', 0]]) {
        assert.equal(bank.toKop(input), expected);
        assert.equal(charges.entryKop({ amount: input }), expected);
    }
    for (const invalid of ['', null, '500abc', '1,2,3', '1.000.50', Infinity, '9007199254740992']) assert.ok(Number.isNaN(bank.toKop(invalid)));
});

test('fixed and per-resident tariffs have their own limits', () => {
    const base = { group: 'res', from: '2026-10', decision: 'Протокол № 1' };
    assert.equal(charges.parseRate('10000'), 100000000);
    assert.equal(charges.checkTariff({ ...base, base: 'residents', rate4: charges.parseRate('250') }, charges.DEFAULT_GROUPS), null);
    assert.equal(charges.checkTariff({ ...base, base: 'fixed', rate4: charges.parseRate('1200') }, charges.DEFAULT_GROUPS), null);
    assert.match(charges.checkTariff({ ...base, base: 'area', rate4: charges.parseRate('250') }, charges.DEFAULT_GROUPS), /100 грн/);
});

test('budget allocation conserves money and never makes the rounding remainder negative', () => {
    for (let n = 2; n <= 12; n++) {
        for (let actual = 0; actual <= 30; actual++) {
            const lines = Array.from({ length: n }, (_, i) => ({ item: 'repair', title: String(i), planKop: 1 }));
            const result = budget.execution({ budget: { lines }, fact: new Map([['repair', actual]]), income: new Map(), months: 1 });
            const portions = result.sections[0].lines;
            assert.equal(portions.reduce((s, l) => s + l.factKop, 0), actual);
            assert.ok(portions.every(l => Number.isInteger(l.factKop) && l.factKop >= 0));
        }
    }
});

test('approved payroll is accrued once, its bank payments and supplier advances are not expenses again', () => {
    const input = { year: '2026', expenses: [], payrollRuns: [{ period: '2026-10', status: 'approved', run: { totals: { grossKop: 1000000, esvKop: 220000 }, rows: [{ name: 'Працівник', grossKop: 1000000, esvKop: 220000 }] } }],
        payrollPayments: new Map([['salary', {}], ['tax', {}]]), bankOut: [
            { direction: 'out', kind: 'expense', status: 'done', period: '2026-10', category: 'salary', paymentId: 'salary', amountKop: 770000 },
            { direction: 'out', kind: 'expense', status: 'done', period: '2026-10', category: 'taxes', paymentId: 'tax', amountKop: 230000 },
            { direction: 'out', kind: 'expense', status: 'done', period: '2026-10', category: 'supplier', amountKop: 400000 }
        ] };
    const fact = budget.factByItem(input);
    assert.deepEqual([...fact], [['salary', 1000000], ['esv', 220000]]);
    const ops = budget.operationsByItem(input);
    for (const [item, kop] of fact) assert.equal(ops[item].reduce((s, x) => s + x.amountKop, 0), kop);
});

test('receivables and overpayments are shown separately in the trial balance', () => {
    const input = { ledgers: new Map([['1', [{ kind: 'opening', amountKop: -10000 }]], ['2', [{ kind: 'opening', amountKop: 6000 }]]]) };
    const tb = journal.trialBalance(journal.journal(input, '2026-10'), '2026-10');
    const row = tb.rows.find(r => r.acc === '377');
    assert.deepEqual([row.openDr, row.openCr, row.closeDr, row.closeCr], [10000, 6000, 10000, 6000]);
    assert.equal(tb.balanced, true);
    const entries = journal.journal(input, '2026-10');
    assert.notEqual(journal.entriesKey(entries, '2026-10'), journal.entriesKey(entries.map(e => ({ ...e, kop: e.kop + 1 })), '2026-10'));
});

test('ESV minimum applies to a full month at the main job, not to part of the minimum wage', () => {
    const rate = payroll.rateFor('2026-10');
    const person = { kind: 'employee', salaryKop: 432350, fte: 0.5, mainJob: true };
    const full = payroll.calcRow(person, {}, '2026-10', rate);
    assert.deepEqual([full.grossKop, full.esvBaseKop, full.esvKop], [432350, 864700, 190234]);
    const hired = payroll.calcRow({ ...person, salaryKop: 864700, from: '2026-10-16' }, {}, '2026-10', rate);
    assert.deepEqual([hired.grossKop, hired.esvBaseKop, hired.esvKop], [432350, 432350, 95117]);
    const unpaid = payroll.calcRow(person, { workedDays: 0 }, '2026-10', rate);
    assert.equal(unpaid.esvKop, 0);
    assert.equal(full.advance.esvKop + full.final.esvKop, full.esvKop);
});

test('a shared bank pack reference cannot settle a different amount, source account or recipient', () => {
    const p = { status: 'sent', bankRef: 'PACK', account: 'OWN', amountKop: 10000, recipient: { iban: 'PAYEE' }, sentAt: new Date('2026-10-10') };
    const tx = { direction: 'out', dlr: 'PACK', account: 'OWN', amountKop: 10000, counterparty: { account: 'PAYEE' }, at: new Date('2026-10-10') };
    assert.equal(payments.matchesPayment(tx, p), true);
    for (const changed of [{ amountKop: 10001 }, { account: 'OTHER' }, { counterparty: { account: 'OTHER' } }, { dlr: 'OTHER' }]) assert.equal(payments.matchesPayment({ ...tx, ...changed }, p), false);
});
