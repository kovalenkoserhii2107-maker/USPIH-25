import test, { before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(new URL('../../functions/package.json', import.meta.url));
const { initializeApp, deleteApp } = require('firebase-admin/app');
const { getFirestore, FieldValue, Timestamp } = require('firebase-admin/firestore');
const bankFunctions = require('./bank');
const chargeFunctions = require('./charges');
const expenseFunctions = require('./expenses');
const paymentFunctions = require('./payments');
const payrollFunctions = require('./payroll');
const budgetFunctions = require('./budget');
const periodLock = require('./period-lock');
const OWN = 'UA213052990000026001234567890';
const PAYEE = 'UA906543210000000260323012024';
const A = ['900', 'accountant'];
const C = ['10', 'chair'];
let app, db, deps;
before(() => {
    app = initializeApp({ projectId: 'uspih-25-rules-test' }, 'accounting-audit');
    db = getFirestore(app);
    deps = { db, FieldValue, Timestamp, requireAdmin: async () => '900', staffRole: async () => 'accountant', lock: periodLock(db) };
});
const collections = ['apartments', 'bank', 'bank_secrets', 'bank_tx', 'bank_links', 'audit_log', 'payments', 'charges', 'charges_runs', 'expenses', 'expense_settings', 'suppliers', 'journal_periods', 'payroll_people', 'payroll_runs', 'payroll_settings', 'osbb_settings', 'budgets', 'finance', 'finance_ops', 'finance_settings'];
async function wipe() {
    for (const name of collections) for (const d of (await db.collection(name).get()).docs) await db.recursiveDelete(d.ref);
}
afterEach(wipe);
after(async () => { await wipe(); await deleteApp(app); });
async function seedBank() {
    await db.doc('bank/settings').set({ startDate: '2026-10-01', accounts: { [OWN]: { purpose: 'current' } } });
    await db.doc('bank_secrets/privat').set({ token: 'mock-token' });
}
const payment = { account: OWN, recipient: { name: 'ТОВ Тест', iban: PAYEE, code: '12345678' }, amountKop: 10000, purpose: 'Оплата послуг', proposalKey: 'audit-unique' };
const tx = (id, extra = {}) => ({ bankId: id, account: OWN, at: new Date('2026-10-10T09:00:00Z'), direction: 'in', amountKop: 10000, purpose: 'кв. 45', counterparty: { name: 'Тест', account: PAYEE }, ...extra });

test('concurrent bank imports and balance recomputation do not overwrite payments or lose money', async () => {
    await seedBank();
    await db.doc('apartments/45').set({ area: 64 });
    const charges = chargeFunctions(deps);
    await charges.actions.setOpening(...A, { rows: [{ apt: '45', amountKop: -50000 }] });
    const bank = bankFunctions({ ...deps, balances: charges });
    const contexts = await Promise.all([bank.loadContext(), bank.loadContext()]);
    const imported = await Promise.all(contexts.map(ctx => bank.storeTransactions([tx('same')], 'mock', ctx)));
    assert.equal(imported.reduce((s, r) => s + r.added, 0), 1);
    assert.equal((await db.collection('apartments/45/ledger').get()).size, 2);
    await Promise.all([bank.storeTransactions([tx('second')], 'mock', await bank.loadContext()), bank.storeTransactions([tx('third')], 'mock', await bank.loadContext())]);
    assert.equal((await db.doc('apartments/45').get()).data().balance, -200);
});

test('two concurrent withdrawals cannot settle the same expense twice; release is atomic', async () => {
    await seedBank();
    await db.doc('suppliers/s').set({ name: 'ТОВ Тест', code: '12345678', iban: PAYEE });
    await db.doc('expenses/e').set({ supplierId: 's', supplierName: 'ТОВ Тест', status: 'approved', amountKop: 10000, paidKop: 0, txIds: [], period: '2026-10' });
    const expenses = expenseFunctions(deps);
    const bank = bankFunctions({ ...deps, expenses });
    const contexts = await Promise.all([bank.loadContext(), bank.loadContext()]);
    await Promise.all(contexts.map((ctx, i) => bank.storeTransactions([tx(`expense${i}`, { direction: 'out', purpose: 'Послуги' })], 'mock', ctx)));
    const expense = (await db.doc('expenses/e').get()).data();
    assert.deepEqual([expense.paidKop, expense.txIds.length], [10000, 1]);
    await bank.actions.unassign(...A, { txId: expense.txIds[0] });
    assert.deepEqual([...(Object.values((({ paidKop, status }) => ({ paidKop, status }))((await db.doc('expenses/e').get()).data())))], [0, 'approved']);
});

test('the bank API is called once under concurrent sending; a failed cancellation preserves sent status', async () => {
    await seedBank();
    const payments = paymentFunctions(deps);
    const original = global.fetch;
    let calls = 0;
    global.fetch = async () => { calls++; await new Promise(resolve => setTimeout(resolve, 25)); return new Response(JSON.stringify({ payment_ref: 'R1', payment_pack_ref: 'PACK' }), { status: 201 }); };
    try {
        const results = await Promise.allSettled([payments.actions.create(...A, payment), payments.actions.create(...A, payment)]);
        assert.equal(calls, 1);
        assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
        const id = results.find(r => r.status === 'fulfilled').value.id;
        global.fetch = async () => new Response(JSON.stringify({ status: 'ERROR', message: 'already signed' }), { status: 400 });
        await assert.rejects(payments.actions.cancel(...A, { id }), /не підтвердив видалення/);
        assert.equal((await db.doc(`payments/${id}`).get()).data().status, 'sent');
        global.fetch = async () => new Response(null, { status: 204 });
        await payments.actions.cancel(...A, { id });
        assert.equal((await db.doc(`payments/${id}`).get()).data().status, 'canceled');
    } finally { global.fetch = original; }
});

test('an ambiguous bank response blocks resending and can be reconciled by the statement', async () => {
    await seedBank();
    const payments = paymentFunctions(deps);
    const original = global.fetch;
    let calls = 0;
    global.fetch = async () => { calls++; throw new Error('connection reset after sending'); };
    try {
        await assert.rejects(payments.actions.create(...A, payment), /не підтвердив результат/);
        await assert.rejects(payments.actions.create(...A, payment), /уже відправлено/);
        assert.equal(calls, 1);
    } finally { global.fetch = original; }
    const p = (await db.collection('payments').get()).docs[0];
    assert.equal(p.data().status, 'unknown');
    const bank = bankFunctions(deps);
    await bank.storeTransactions([tx('reconcile', { at: new Date(), direction: 'out', purpose: 'Оплата послуг' })], 'mock', await bank.loadContext());
    assert.equal((await p.ref.get()).data().status, 'paid');
});

test('component debts survive the year boundary and the annual forecast applies each dated tariff', async () => {
    await db.doc('apartments/45').set({ area: 10, balance: -70 });
    await db.doc('charges/settings').set({ opening: { set: true }, components: [{ id: 'main', name: 'Утримання', base: 'area' }, { id: 'lift', name: 'Ліфт', base: 'fixed' }],
        tariffs: [{ group: 'res', from: '2027-01', rate4: 20000 }, { group: 'res', from: '2027-07', rate4: 30000 }] });
    await db.doc('apartments/45/ledger/opening').set({ kind: 'opening', period: '2026-09', at: new Date('2026-09-30'), amountKop: -5000, parts: { lift: -5000 } });
    await db.doc('apartments/45/ledger/charge').set({ kind: 'charge', period: '2026-12', at: new Date('2026-12-31'), amountKop: 2000, parts: [{ component: 'lift', amountKop: 2000 }] });
    await db.doc('apartments/45/ledger/payment').set({ kind: 'payment', period: '2027-01', at: new Date('2027-01-10'), amountKop: 3000 });
    await db.doc('bank_tx/payment').set({ direction: 'in', kind: 'payment', status: 'done', period: '2027-01', amountKop: 3000 });
    const budget = budgetFunctions(deps);
    const ctx = await budget.actions.context({ year: '2027' });
    assert.deepEqual(ctx.execution.income.find(l => l.source === 'contributions').parts.map(p => [p.component, p.factKop]), [['lift', 3000]]);
    assert.equal(ctx.contributionsYearKop, 30000);
    await budget.actions.publish(...A, { year: '2027' });
    assert.equal((await db.doc('finance_ops/inc-c-lift').get()).data().ops[0].amountKop, 3000);
});

async function seedPayroll(create) {
    await seedBank();
    await db.doc('osbb_settings/finance').set({ edrpou: '40562894' });
    const payroll = payrollFunctions({ ...deps, payments: { actions: { create } } });
    const tax = { name: 'ГУК', iban: PAYEE, code: '37607526' };
    await payroll.actions.saveSettings(...A, { advancePct: 50, taxes: { pdfo: tax, vz: tax, esv: tax } });
    const { id } = await payroll.actions.savePerson(...A, { name: 'Працівник Тестовий', kind: 'employee', salaryKop: 864700, fte: 1, iban: PAYEE, rnokpp: '3124567809', taxNotified: true });
    await payroll.actions.saveRun(...A, { period: '2026-10', inputs: {} });
    await payroll.actions.approve(...C, { period: '2026-10' });
    return { payroll, id };
}

test('an approved payroll freezes amounts and recipients; the payment agrees with the saved accrual', async () => {
    const sent = [];
    const { payroll, id } = await seedPayroll(async (...args) => { sent.push(args[2]); return { id: `p${sent.length}` }; });
    await db.doc(`payroll_people/${id}`).update({ salaryKop: 2000000, name: 'Змінена Людина', iban: OWN });
    const ctx = await payroll.actions.context({ period: '2026-10' });
    assert.equal(ctx.run.totals.grossKop, 864700);
    await payroll.actions.pay(...A, { period: '2026-10', stage: 'final' });
    assert.equal(sent[0].recipient.iban, PAYEE);
    assert.equal(sent[0].amountKop, 665819);
    assert.equal(sent.reduce((s, p) => s + p.amountKop, 0), 864700 + 190234);
});

test('partial payroll sending resumes only the missing payments and refuses changes meanwhile', async () => {
    const sent = [];
    let rejectOnce = true;
    const { payroll } = await seedPayroll(async (...args) => {
        const p = args[2];
        if (p.payroll.key === 'pdfo' && rejectOnce) { rejectOnce = false; throw new Error('temporary rejection'); }
        sent.push(p); return { id: `p${sent.length}` };
    });
    const first = await payroll.actions.pay(...A, { period: '2026-10', stage: 'final' });
    assert.equal(first.ok, false);
    assert.equal(sent.length, 1);
    await assert.rejects(payroll.actions.saveRun(...A, { period: '2026-10', inputs: {} }), /не змінюється/);
    const resumed = await payroll.actions.pay(...A, { period: '2026-10', stage: 'final' });
    assert.equal(resumed.ok, true);
    assert.equal(sent.length, 4);
    assert.equal(new Set(sent.map(p => p.proposalKey)).size, 4);
});

test('late payments in a closed period wait for review and leave the resident balance unchanged', async () => {
    await seedBank();
    await db.doc('apartments/45').set({ area: 10, balance: -500 });
    await db.doc('journal_periods/2026-10').set({ status: 'closed' });
    const bank = bankFunctions(deps);
    await bank.storeTransactions([tx('late')], 'mock', await bank.loadContext());
    const row = (await db.doc(`bank_tx/${OWN}_late`).get()).data();
    assert.equal(row.status, 'review');
    assert.equal(row.allocations.length, 0);
    assert.equal((await db.collection('apartments/45/ledger').get()).size, 0);
    await db.doc('journal_periods/2026-10').set({ status: 'open' });
    assert.deepEqual(await bank.storeTransactions([tx('late')], 'mock', await bank.loadContext()), { added: 0, matched: 1 });
    assert.equal((await db.doc(`bank_tx/${OWN}_late`).get()).data().status, 'done');
    assert.equal((await db.collection('apartments/45/ledger').get()).size, 1);
});

test('concurrent automatic expense approvals respect the budget and existing bank expenses', async () => {
    const budget = budgetFunctions(deps);
    const expenses = expenseFunctions({ ...deps, budget });
    const { id: supplierId } = await expenses.actions.saveSupplier(...A, { name: 'ТОВ Тест', kind: 'company', code: '14360570', iban: PAYEE });
    await db.doc('expense_settings/main').set({ smallKop: 400000 });
    await db.doc('budgets/2026').set({ year: '2026', status: 'approved', lines: [{ item: 'bank', title: 'Банк', planKop: 600000 }] });
    await db.doc('bank_tx/fee').set({ direction: 'out', kind: 'expense', status: 'done', period: '2026-10', category: 'bank_fee', amountKop: 100000 });
    const results = await Promise.all([1, 2].map(i => expenses.actions.saveExpense(...A, { supplierId, docType: 'act', number: `A${i}`, date: '2026-10-10', period: '2026-10', item: 'bank', amountKop: 300000, description: 'Обслуговування рахунку' })));
    assert.deepEqual(results.map(r => r.status).sort(), ['approved', 'pending']);
    assert.match(results.find(r => r.status === 'pending').approval.reason, /кошторис/);
});

test('confirmed payroll payment cancellation makes only that frozen payment available for resending', async () => {
    const payments = paymentFunctions(deps);
    const { payroll } = await seedPayroll(payments.actions.create);
    const original = global.fetch;
    let creates = 0;
    global.fetch = async url => {
        if (String(url).includes('/delete')) return new Response(null, { status: 204 });
        creates++;
        return new Response(JSON.stringify({ payment_ref: `R${creates}`, payment_pack_ref: `P${creates}` }), { status: 201 });
    };
    try {
        await payroll.actions.pay(...A, { period: '2026-10', stage: 'final' });
        const list = await db.collection('payments').get();
        const salary = list.docs.find(d => d.data().kind === 'salary');
        assert.equal(creates, 4);
        await payments.actions.cancel(...A, { id: salary.id });
        const stage = (await db.doc('payroll_runs/2026-10').get()).data().stages.final;
        assert.equal(stage.complete, false);
        assert.equal(Object.keys(stage.completed).length, 3);
        await payroll.actions.pay(...A, { period: '2026-10', stage: 'final' });
        assert.equal(creates, 5);
        assert.equal((await db.collection('payments').get()).size, 4);
        assert.equal((await db.doc('payroll_runs/2026-10').get()).data().stages.final.complete, true);
    } finally { global.fetch = original; }
});

test('removing a supplier payment classification permits correction without reopening the actual bank payment', async () => {
    const bank = bankFunctions(deps);
    await db.doc('payments/p').set({ status: 'paid', amountKop: 10000, kind: 'supplier', txId: 'out' });
    await db.doc('bank_tx/out').set({ period: '2026-10', direction: 'out', kind: 'expense', status: 'done', category: 'supplier', amountKop: 10000, paymentId: 'p' });
    await bank.actions.unassign(...A, { txId: 'out' });
    await bank.actions.classifyTx(...A, { txId: 'out', kind: 'expense', category: 'bank_fee' });
    assert.equal((await db.doc('payments/p').get()).data().status, 'paid');
    assert.equal((await db.doc('bank_tx/out').get()).data().paymentId, null);
});

test('a payroll bank withdrawal cannot also settle a supplier document', async () => {
    const expenses = expenseFunctions(deps);
    await db.doc('payments/p').set({ status: 'paid', payroll: { period: '2026-10', stage: 'final', key: 'person' } });
    await db.doc('bank_tx/out').set({ period: '2026-10', direction: 'out', kind: 'expense', status: 'done', amountKop: 10000, paymentId: 'p' });
    await db.doc('expenses/e').set({ period: '2026-10', amountKop: 10000, paidKop: 0, status: 'approved' });
    await assert.rejects(expenses.actions.linkTx(...A, { txId: 'out', expenseId: 'e' }), /Зарплатний платіж/);
    assert.equal((await db.doc('expenses/e').get()).data().paidKop, 0);
});
