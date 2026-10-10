// Повнота обліку на емуляторі: вхідна ОСВ, рахунок + акт однієї послуги,
// сторно, повернення списаного (постачальник, банк), повернення переплати
// співвласнику й повторна зарплатна виплата. Справжні функції; банк —
// лише записи виписки, платежі — заглушка.
import test, { after, afterEach, before } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(new URL('../../functions/package.json', import.meta.url));
const { initializeApp, deleteApp } = require('firebase-admin/app');
const { getFirestore, FieldValue, Timestamp } = require('firebase-admin/firestore');

const OWN = 'UA213052990000026001234567890';
const SUP_IBAN = 'UA906543210000000260323012024';
let app, db, ex, bank, journal, payroll, created;
before(() => {
    app = initializeApp({ projectId: 'uspih-25-rules-test' }, 'completeness-server-test');
    db = getFirestore(app);
    const deps = { db, FieldValue, Timestamp, requireAdmin: async () => '900', staffRole: async () => 'accountant', notify: async () => {} };
    const lock = require('./period-lock.js')(db);
    const charges = require('./charges.js')({ ...deps, lock });
    const payments = { actions: { create: async (actor, role, p) => { created.push(p); const ref = db.collection('payments').doc(); await ref.set({ ...p, status: 'sent' }); return { id: ref.id }; } } };
    ex = require('./expenses.js')({ ...deps, payments, lock });
    bank = require('./bank.js')({ ...deps, balances: charges, expenses: ex, lock });
    journal = require('./journal.js')({ ...deps, lock, now: () => new Date('2026-11-15T10:00:00Z') });
    payroll = require('./payroll.js')({ ...deps, payments, lock });
});
const wipe = async () => {
    created = [];
    for (const name of ['apartments', 'bank', 'bank_tx', 'audit_log', 'payments', 'suppliers', 'expenses', 'expense_settings', 'journal_opening', 'journal_periods',
        'charges', 'charges_runs', 'payroll_people', 'payroll_runs', 'payroll_settings']) {
        const snap = await db.collection(name).get();
        await Promise.all(snap.docs.map(d => db.recursiveDelete(d.ref)));
    }
};
afterEach(wipe);
after(async () => { await wipe(); await deleteApp(app); });

const A = ['900', 'accountant'];
const C = ['10', 'chair'];
const out = (id, extra) => db.doc(`bank_tx/${id}`).set({ account: OWN, at: Timestamp.fromDate(new Date('2026-10-20T10:00:00Z')), period: '2026-10', direction: 'out',
    kind: 'expense', status: 'review', amountKop: 100000, purpose: 'Оплата', counterparty: { name: 'ТОВ ТЕСТ-РЕМОНТ', account: SUP_IBAN, code: '14360570' }, ...extra });
const inc = (id, extra) => out(id, { direction: 'in', kind: 'payment', purpose: 'Повернення коштів', ...extra });

test('вхідна ОСВ: чернетка, підказка з банку, затвердження головою, після закриття — не змінюється', async () => {
    await db.doc('bank/settings').set({ accounts: { [OWN]: { purpose: 'current', currency: 'UAH', balanceKop: 2500000, balanceAt: Timestamp.now() } } });
    let o = await journal.actions.openingContext();
    assert.equal(o.status, 'none');
    assert.equal(o.banks[0].suggestKop, 2500000);
    await assert.rejects(journal.actions.saveOpening(...A, { lines: [{ acc: '377', side: 'dr', kop: 1 }] }), /автоматично/);
    await journal.actions.saveOpening(...A, { lines: [{ acc: '311', a: OWN, side: 'dr', kop: 2500000 }, { acc: '48', side: 'cr', kop: 2400000 }] });
    await assert.rejects(journal.actions.approveOpening(...C), /різниця 1000\.00/);
    await journal.actions.saveOpening(...A, { lines: [{ acc: '311', a: OWN, side: 'dr', kop: 2500000 }, { acc: '48', side: 'cr', kop: 2500000 }] });
    await assert.rejects(journal.actions.approveOpening(...A), /голова/);
    await journal.actions.approveOpening(...C);
    o = await journal.actions.openingContext();
    assert.equal(o.status, 'approved');
    const ctx = await journal.actions.context({ period: '2026-10' });
    assert.equal(ctx.tb.rows.find(r => r.acc === '00'), undefined);
    assert.equal(ctx.tb.rows.find(r => r.acc === '311').openDr, 2500000);
    assert.ok(!ctx.checks.some(c => /оборотно-сальдову на 30\.09/.test(c.text)));
    assert.ok(ctx.checks.some(c => /311 збігається із залишками банку/.test(c.text)));
    await db.doc('journal_periods/2026-10').set({ status: 'closed' });
    await assert.rejects(journal.actions.saveOpening(...A, { lines: [] }), /закритий місяць/);
});

test('рахунок і акт однієї послуги: підказка, привʼязка, одна витрата; сторно й повернення від постачальника', async () => {
    const { id: sid } = await ex.actions.saveSupplier(...A, { name: 'ТОВ ТЕСТ-РЕМОНТ', kind: 'company', code: '14360570', iban: SUP_IBAN });
    const base = { supplierId: sid, period: '2026-10', item: 'repair', description: 'Ремонт ґанку', files: [] };
    const { id: inv } = await ex.actions.saveExpense(...C, { ...base, docType: 'invoice', number: '15', date: '2026-10-05', amountKop: 100000 });
    // Акт на ту саму суму — сервер підказує, що це та сама послуга.
    const err = await ex.actions.saveExpense(...A, { ...base, docType: 'act', number: 'A-7', date: '2026-10-28', amountKop: 100000 }).catch(e => e);
    assert.equal(err.code, 'already-exists');
    assert.equal(err.details.similar.id, inv);
    const { id: act, status } = await ex.actions.saveExpense(...A, { ...base, docType: 'act', number: 'A-7', date: '2026-10-28', amountKop: 100000, linkedTo: inv });
    assert.equal(status, 'linked');
    assert.deepEqual((await db.doc(`expenses/${inv}`).get()).data().linkedIds, [act]);
    // Окрема послуга — свідомо, з distinct; потім виявилось, що це та сама: привʼязуємо.
    const { id: dup } = await ex.actions.saveExpense(...C, { ...base, docType: 'waybill', number: 'N-3', date: '2026-10-29', amountKop: 100000, distinct: true });
    await ex.actions.linkExisting(...A, { id: dup, to: inv });
    assert.equal((await db.doc(`expenses/${dup}`).get()).data().status, 'linked');
    let ctx = await journal.actions.context({ period: '2026-10' });
    assert.equal(ctx.entries.filter(e => e.src === 'expense').length, 1);

    // Оплата 1 000, потім сторно 300 і повернення 300 від постачальника.
    await out('o1', {});
    await ex.actions.linkTx(...A, { txId: 'o1', expenseId: inv });
    await assert.rejects(ex.actions.storno(...A, { id: inv, amountKop: 30000, date: '2026-10-30', number: 'КА-1', reason: 'ні' }), /причину/);
    const r = await ex.actions.storno(...A, { id: inv, amountKop: 30000, date: '2026-10-30', number: 'КА-1', reason: 'частину робіт не виконано' });
    assert.equal(r.overpaidKop, 30000);
    await inc('r1', { amountKop: 30000 });
    await bank.actions.refund(...A, { txId: 'r1', refundOf: 'o1', reason: 'supplier' });
    assert.equal((await db.doc('bank_tx/o1').get()).data().refundedKop, 30000);
    await assert.rejects(bank.actions.unassign(...A, { txId: 'o1' }), /повернення/);
    ctx = await journal.actions.context({ period: '2026-10' });
    const sup = ctx.tb.rows.find(x => x.acc === '631').byA.find(x => x.a === 'ТОВ ТЕСТ-РЕМОНТ');
    assert.deepEqual([sup.closeDr, sup.closeCr], [0, 0]);
    assert.equal(ctx.tb.rows.find(x => x.acc === '92').dr, 70000);
    assert.ok(!ctx.checks.some(c => c.level === 'block' && /Документ витрат|Повернення|Списання o1/.test(c.text)), JSON.stringify(ctx.checks));
});

test('банк повернув оплату документа: документ знову до сплати; зняття повернення відновлює оплату', async () => {
    const { id: sid } = await ex.actions.saveSupplier(...A, { name: 'ТОВ ТЕСТ-РЕМОНТ', kind: 'company', code: '14360570', iban: SUP_IBAN });
    const { id } = await ex.actions.saveExpense(...C, { supplierId: sid, period: '2026-10', item: 'repair', description: 'Ремонт ґанку', files: [], docType: 'act', number: '9', date: '2026-10-05', amountKop: 100000 });
    await out('o2', {});
    await ex.actions.linkTx(...A, { txId: 'o2', expenseId: id });
    await inc('r2', { amountKop: 100000 });
    await assert.rejects(bank.actions.refund(...A, { txId: 'r2', refundOf: 'o2', reason: 'щось' }), /Оберіть/);
    await bank.actions.refund(...A, { txId: 'r2', refundOf: 'o2', reason: 'bounce' });
    let e = (await db.doc(`expenses/${id}`).get()).data();
    assert.deepEqual([e.status, e.paidKop], ['approved', 0]);
    await inc('r3', { amountKop: 1 });
    await assert.rejects(bank.actions.refund(...A, { txId: 'r3', refundOf: 'o2', reason: 'other' }), /більше за неповернений/);
    const ctx = await journal.actions.context({ period: '2026-10' });
    assert.ok(!ctx.checks.some(c => c.level === 'block' && /Документ витрат|Повернення|Списання o2/.test(c.text)), JSON.stringify(ctx.checks));
    await bank.actions.unassign(...A, { txId: 'r2' });
    e = (await db.doc(`expenses/${id}`).get()).data();
    assert.deepEqual([e.status, e.paidKop], ['paid', 100000]);
    assert.equal((await db.doc('bank_tx/o2').get()).data().refundedKop, 0);
});

test('повернення переплати співвласнику: не більше переплати, запис в історії квартири', async () => {
    await db.doc('apartments/5').set({ area: 50, balance: 500 });
    await db.doc('apartments/5/ledger/opening').set({ kind: 'opening', period: '2026-09', amountKop: 50000, amount: 500, at: Timestamp.fromDate(new Date('2026-09-30T10:00:00Z')) });
    await out('o3', { amountKop: 60000, counterparty: { name: 'Власник Тестовий', account: 'UA973052990000026001234567801' } });
    await assert.rejects(bank.actions.refundResident(...A, { txId: 'o3', apt: '5' }), /більше не можна/);
    await out('o4', { amountKop: 20000, counterparty: { name: 'Власник Тестовий', account: 'UA973052990000026001234567801' } });
    await bank.actions.refundResident(...A, { txId: 'o4', apt: '5' });
    const entry = (await db.doc('apartments/5/ledger/refund-o4').get()).data();
    assert.deepEqual([entry.kind, entry.amountKop, entry.txId], ['refund', 20000, 'o4']);
    const tx = (await db.doc('bank_tx/o4').get()).data();
    assert.deepEqual([tx.category, tx.allocations[0].apt], ['resident_refund', '5']);
    const ctx = await journal.actions.context({ period: '2026-10' });
    assert.ok(ctx.entries.some(e => e.ref === 'o4' && e.dr === '377' && e.dA === '5'));
    // Повернення в «Розібрати» прибирає й запис історії.
    await bank.actions.unassign(...A, { txId: 'o4' });
    assert.equal((await db.doc('apartments/5/ledger/refund-o4').get()).exists, false);
});

test('зарплату повернув банк: повторна виплата на виправлений IBAN, лише один раз', async () => {
    await db.doc('payroll_people/e1').set({ name: 'Працівник Тестовий', kind: 'employee', iban: 'UA273052990000026001234567800', active: true });
    await db.doc('payments/p1').set({ kind: 'salary', status: 'paid', amountKop: 50000, returnedKop: 0, account: OWN, purpose: 'Зарплата за жовтень 2026',
        recipient: { name: 'Працівник Тестовий', iban: 'UA273052990000026001234567800', code: '' }, payroll: { period: '2026-10', stage: 'final', key: 'e1' } });
    await assert.rejects(payroll.actions.repay(...A, { paymentId: 'p1' }), /ще не повернув/);
    await db.doc('payments/p1').update({ returnedKop: 50000 });
    await assert.rejects(payroll.actions.repay(...A, { paymentId: 'p1' }), /той самий/);
    await db.doc('payroll_people/e1').update({ iban: 'UA973052990000026001234567801' });
    await payroll.actions.repay(...A, { paymentId: 'p1' });
    assert.deepEqual([created[0].recipient.iban, created[0].payroll.repayOf, created[0].amountKop], ['UA973052990000026001234567801', 'p1', 50000]);
    await assert.rejects(payroll.actions.repay(...A, { paymentId: 'p1' }), /уже відправлено/);
});
