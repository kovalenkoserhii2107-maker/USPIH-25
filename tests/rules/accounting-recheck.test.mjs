import test, { before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(new URL('../../functions/package.json', import.meta.url));
const { initializeApp, deleteApp } = require('firebase-admin/app');
const { getFirestore, FieldValue, Timestamp } = require('firebase-admin/firestore');
const chargesModule = require('./charges');
const bankModule = require('./bank');
const journalModule = require('./journal');
const reportsModule = require('./reports');
const payroll = require('./payroll-core');
const periodLock = require('./period-lock');
const A = ['900', 'accountant'];
const OWN = 'UA213052990000026001234567890';
let app, db, deps, charges, bank, journal, reports;
before(() => {
    app = initializeApp({ projectId: 'uspih-25-rules-test' }, 'accounting-recheck');
    db = getFirestore(app);
    deps = { db, FieldValue, Timestamp, requireAdmin: async () => '900', staffRole: async () => 'accountant', lock: periodLock(db) };
    charges = chargesModule(deps);
    bank = bankModule({ ...deps, balances: charges });
    journal = journalModule({ ...deps, now: () => new Date('2026-11-02T10:00:00Z') });
    reports = reportsModule(deps);
});
async function wipe() {
    for (const name of ['apartments', 'bank', 'bank_tx', 'bank_links', 'audit_log', 'charges', 'charges_runs', 'journal_periods', 'payroll_people', 'payroll_runs', 'payments', 'reports', 'expenses', 'suppliers']) {
        for (const d of (await db.collection(name).get()).docs) await db.recursiveDelete(d.ref);
    }
}
afterEach(wipe);
after(async () => { await wipe(); await deleteApp(app); });
const get = async path => (await db.doc(path).get()).data();
const tx = (id, extra = {}) => ({ bankId: id, account: OWN, at: new Date('2026-10-10T09:00:00Z'), direction: 'in', amountKop: 2500, purpose: 'кв. 45', counterparty: { name: 'Тест' }, ...extra });
async function seed(secondArea = 12) {
    await db.doc('apartments/45').set({ area: 10, personalAccount: '1045' });
    await db.doc('apartments/46').set({ area: secondArea, personalAccount: '1046' });
    await db.doc('bank/settings').set({ startDate: '2026-10-01', accounts: { [OWN]: { purpose: 'current' } } });
    await charges.actions.addTariff(...A, { group: 'res', from: '2026-10', rate: '5', decision: 'Протокол № 1' });
    await charges.actions.setOpening(...A, { rows: [{ apt: '45', amountKop: -50000 }] });
}

test('partial accrual needs explicit confirmation, stays incomplete and preserves previous amounts on invalid data', async () => {
    await seed(null);
    await assert.rejects(charges.actions.run(...A, { period: '2026-10' }), /Нарахування неповне/);
    assert.equal((await db.doc('apartments/45/ledger/charge-2026-10').get()).exists, false);
    const partial = await charges.actions.run(...A, { period: '2026-10', allowPartial: true });
    assert.deepEqual([partial.complete, partial.count, partial.totalKop], [false, 1, 5000]);
    assert.equal((await charges.actions.context()).preview.done, false);
    await assert.rejects(journal.actions.close(...A, { period: '2026-10' }), /Неповне нарахування/);
    assert.equal((await get('journal_periods/2026-10')).status, 'open');
    await db.doc('apartments/46').update({ area: 12 });
    const full = await charges.actions.run(...A, { period: '2026-10' });
    assert.deepEqual([full.complete, full.count, full.totalKop], [true, 2, 11000]);
    await db.doc('apartments/45').update({ area: null });
    const preserved = await charges.actions.run(...A, { period: '2026-10', allowPartial: true });
    assert.deepEqual([preserved.count, preserved.totalKop, preserved.preserved], [2, 11000, ['45']]);
    assert.equal((await get('apartments/45/ledger/charge-2026-10')).amountKop, 5000);
    assert.equal((await get('charges_runs/2026-10')).byComponent.main, 11000);
    assert.equal((await get('apartments/45')).balance, -550);
    assert.equal((await journal.actions.context({ period: '2026-10' })).canClose, false);
});

test('balanced trial balance cannot close a period with a missing charge or payment ledger record', async () => {
    await seed();
    await charges.actions.run(...A, { period: '2026-10' });
    await bank.storeTransactions([tx('one')], 'mock', await bank.loadContext());
    assert.equal((await journal.actions.context({ period: '2026-10' })).canClose, true);
    await db.doc('apartments/45/ledger/charge-2026-10').delete();
    let ctx = await journal.actions.context({ period: '2026-10' });
    assert.equal(ctx.tb.balanced, true);
    assert.equal(ctx.canClose, false);
    assert.ok(ctx.checks.some(c => /сума в історії не відповідає відомості/.test(c.text)));
    await charges.actions.run(...A, { period: '2026-10' });
    await db.doc('apartments/45/ledger/imported').set({ kind: 'charge', source: 'file', period: '2026-10', amountKop: 5000 });
    await assert.rejects(journal.actions.close(...A, { period: '2026-10' }), /імпорт історії/);
    await db.doc('apartments/45/ledger/imported').delete();
    const row = await get(`bank_tx/${OWN}_one`);
    await db.doc(`apartments/45/ledger/${row.allocations[0].ledgerId}`).delete();
    ctx = await journal.actions.context({ period: '2026-10' });
    assert.equal(ctx.tb.balanced, true);
    await assert.rejects(journal.actions.close(...A, { period: '2026-10' }), /запис історії відсутній/);
});

test('receipts retain the saved area and rate after the dictionary and tariff change', async () => {
    await seed();
    await charges.actions.run(...A, { period: '2026-10' });
    await db.doc('apartments/45').update({ area: 20 });
    await charges.actions.addTariff(...A, { group: 'res', from: '2026-11', rate: '10', decision: 'Протокол № 2' });
    const row = (await charges.actions.getStatement({ period: '2026-10' })).rows.find(r => r.apt === '45');
    assert.deepEqual([row.charged, row.charge.areaCenti, row.charge.rate4], [5000, 1000, 50000]);
});

test('duplicate personal accounts never post to the last apartment or a remembered payer automatically', async () => {
    await seed();
    await db.doc('apartments/46').update({ personalAccount: '001045' });
    const ctx = await bank.loadContext();
    const raw = tx('ambiguous', { purpose: 'внесок о/р 1045' });
    ctx.links.set(require('./bank-core').payerKey('Тест', ''), '46');
    await bank.storeTransactions([raw], 'mock', ctx);
    const row = await get(`bank_tx/${OWN}_ambiguous`);
    assert.deepEqual([row.status, row.reason, row.allocations], ['review', 'ambiguous-account', []]);
    await bank.actions.assign(...A, { txId: `${OWN}_ambiguous`, allocations: [{ apt: '45', amountKop: 2500 }] });
    assert.equal((await get('apartments/45')).balance, -475);
    assert.equal((await get('apartments/46')).balance, 0);
});

test('bank allocation and release use the actual document ID of a lettered apartment', async () => {
    await db.doc('apartments/45А').set({ area: 10 });
    await charges.actions.setOpening(...A, { rows: [{ apt: '45а', amountKop: -50000 }] });
    await bank.storeTransactions([tx('letter', { purpose: 'кв. 45А' })], 'mock', await bank.loadContext());
    assert.equal((await get('apartments/45А')).balance, -475);
    assert.equal((await db.doc('apartments/45а').get()).exists, false);
    await bank.actions.unassign(...A, { txId: `${OWN}_letter` });
    assert.equal((await get('apartments/45А')).balance, -500);
    assert.equal((await db.collection('apartments/45А/ledger').get()).size, 1);
});

test('a payment cannot create orphan ledger records after the apartment was deleted from a stale recognition context', async () => {
    await seed();
    const ctx = await bank.loadContext();
    await db.doc('apartments/45').delete();
    await bank.storeTransactions([tx('deleted')], 'mock', ctx);
    assert.equal((await get(`bank_tx/${OWN}_deleted`)).status, 'review');
    assert.equal((await db.collection('apartments/45/ledger').get()).size, 1); // лише старий вхідний залишок
});

test('retrying an already stored bank payment repairs a failed balance update without duplicate money', async () => {
    await seed();
    let first = true;
    const failing = bankModule({ ...deps, balances: { recompute: async apts => {
        if (first) { first = false; return { error: true }; }
        return charges.recompute(apts);
    } } });
    await assert.rejects(failing.storeTransactions([tx('retry')], 'mock', await failing.loadContext()), /баланси не перераховано/);
    assert.equal((await get('apartments/45')).balance, -500);
    assert.deepEqual(await failing.storeTransactions([tx('retry')], 'mock', await failing.loadContext()), { added: 0, matched: 0 });
    assert.equal((await get('apartments/45')).balance, -475);
    assert.equal((await db.collection('apartments/45/ledger').get()).size, 2);
});

test('advance-only ESV is not a completed monthly payment; actual sums must cover approved accrual', async () => {
    const person = { id: 'e1', name: 'Працівник Тестовий', kind: 'employee', salaryKop: 864700, fte: 1, mainJob: true, rnokpp: '3124567809', taxNotified: true };
    const run = payroll.buildRun({ people: [person], period: '2026-10' });
    await db.doc('payroll_runs/2026-10').set({ period: '2026-10', status: 'approved', run });
    await db.doc('payments/advance').set({ status: 'paid', amountKop: 95117, payroll: { period: '2026-10', stage: 'advance', key: 'esv' } });
    assert.equal((await reports.actions.context()).statuses['esv-2026-10'], undefined);
    await db.doc('payments/final').set({ status: 'sent', amountKop: 95117, payroll: { period: '2026-10', stage: 'final', key: 'esv' } });
    assert.equal((await reports.actions.context()).statuses['esv-2026-10'], undefined);
    await db.doc('payments/final').update({ status: 'paid' });
    assert.equal((await reports.actions.context()).statuses['esv-2026-10'].auto, true);
});

test('accepted reports cannot be downgraded by an accountant and omitted files retain the receipts', async () => {
    const key = 'j0500111-2026-10';
    await assert.rejects(reports.actions.mark(...A, { key, status: 'submitted', date: '2026-02-31' }), /правильну дату/);
    await reports.actions.mark(...A, { key, status: 'submitted', files: [{ name: 'kv1.pdf', path: `reports/${key}/1.pdf`, kind: 'receipt1' }] });
    await reports.actions.mark(...A, { key, status: 'accepted', regNumber: '12345' });
    assert.equal((await get(`reports/${key}`)).files.length, 1);
    await assert.rejects(reports.actions.mark(...A, { key, status: 'submitted' }), /лише голова/);
    assert.equal((await get(`reports/${key}`)).status, 'accepted');
});

test('missing payroll accrual blocks closure for a historically active employee, including termination that month', async () => {
    await seed();
    await charges.actions.run(...A, { period: '2026-10' });
    await db.doc('payroll_people/e1').set({ name: 'Звільнений Працівник', kind: 'employee', active: false, from: '2026-01-01', to: '2026-10-16' });
    await assert.rejects(journal.actions.close(...A, { period: '2026-10' }), /Відомість зарплати за місяць не затверджено/);
    await db.doc('payroll_people/e1').update({ from: '2026-11-01', to: '2026-11-16' });
    assert.equal((await journal.actions.context({ period: '2026-10' })).canClose, true);
});

test('a pending expense prevents incomplete closure; an expired closure reservation can be retried safely', async () => {
    await seed();
    await charges.actions.run(...A, { period: '2026-10' });
    await db.doc('expenses/pending').set({ status: 'pending', period: '2026-10', amountKop: 10000 });
    await assert.rejects(journal.actions.close(...A, { period: '2026-10' }), /затвердьте або відхиліть/);
    let ctx = await journal.actions.context({ period: '2026-10' });
    assert.equal(ctx.checks.some(c => c.level === 'ok' && /Можна закривати/.test(c.text)), false);
    await db.doc('expenses/pending').update({ status: 'rejected' });
    await db.doc('journal_periods/2026-10').set({ status: 'closing', closingToken: 'interrupted', closingUntil: Date.now() - 1000 });
    ctx = await journal.actions.context({ period: '2026-10' });
    assert.equal(ctx.canClose, true);
    await journal.actions.close(...A, { period: '2026-10' });
    assert.equal((await get('journal_periods/2026-10')).status, 'closed');
});

test('overlapping accrual batches and month closure are blocked while a house-wide charge operation is running', async () => {
    await seed();
    let release, entered;
    const gate = new Promise(resolve => { release = resolve; });
    const started = new Promise(resolve => { entered = resolve; });
    const held = new Proxy(db, { get(target, key) {
        if (key === 'batch') return () => { const batch = target.batch(); const commit = batch.commit.bind(batch); batch.commit = async () => { entered(); await gate; return commit(); }; return batch; };
        const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
    } });
    const running = chargesModule({ ...deps, db: held }).actions.run(...A, { period: '2026-10' });
    try {
        await started;
        await assert.rejects(charges.actions.run(...A, { period: '2026-10' }), /Інша операція/);
        await assert.rejects(journal.actions.close(...A, { period: '2026-10' }), /операція нарахувань/);
    } finally { release(); }
    await running;
    assert.equal((await get('charges_runs/2026-10')).totalKop, 11000);
    assert.equal((await journal.actions.context({ period: '2026-10' })).canClose, true);
});

test('closing reserves the period before reading source data; new bank operations wait for review and charges stay fixed', async () => {
    await seed();
    await charges.actions.run(...A, { period: '2026-10' });
    let release, entered;
    const gate = new Promise(resolve => { release = resolve; });
    const started = new Promise(resolve => { entered = resolve; });
    let calls = 0;
    const held = new Proxy(db, { get(target, key) {
        if (key === 'runTransaction') return (fn, options) => {
            const finalSnapshot = ++calls === 2;
            return target.runTransaction(t => fn(new Proxy(t, { get(transaction, property) {
                if (property === 'get') return async ref => { if (finalSnapshot) { entered(); await gate; } return transaction.get(ref); };
                const value = Reflect.get(transaction, property); return typeof value === 'function' ? value.bind(transaction) : value;
            } })), options);
        };
        const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
    } });
    const closing = journalModule({ ...deps, db: held, now: () => new Date('2026-11-02T10:00:00Z') }).actions.close(...A, { period: '2026-10' });
    // Attach the rejection handler while the delayed source query is pending.
    const outcome = assert.rejects(closing, /чекають рішення/);
    try {
        await started;
        await assert.rejects(charges.actions.run(...A, { period: '2026-10' }), /закрито/);
        await bank.storeTransactions([tx('during-close')], 'mock', await bank.loadContext());
        const row = await get(`bank_tx/${OWN}_during-close`);
        assert.deepEqual([row.status, row.reason, row.allocations.length], ['review', 'closed-period', 0]);
    } finally { release(); }
    await outcome;
    assert.equal((await get('journal_periods/2026-10')).status, 'open');
    assert.equal((await get('apartments/45')).balance, -550);
});
