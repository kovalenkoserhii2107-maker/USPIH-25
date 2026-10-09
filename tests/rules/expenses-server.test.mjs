// Витрати й договори на емуляторі Firestore: постачальники, ліміт
// статуту, хто затверджує, оплата документа через API банку, звірка
// зі списанням і повернення.
import test, { after, afterEach, before } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(new URL('../../functions/package.json', import.meta.url));
const { initializeApp, deleteApp } = require('firebase-admin/app');
const { getFirestore, FieldValue, Timestamp } = require('firebase-admin/firestore');
const expenseFunctions = require('./expenses.js');
const paymentFunctions = require('./payments.js');
const bankFunctions = require('./bank.js');

const OWN = 'UA213052990000026001234567890';
const LIFT_IBAN = 'UA906543210000000260323012024';
let app, db, ex, bank, notified;
before(() => {
    app = initializeApp({ projectId: 'uspih-25-rules-test' }, 'expenses-server-test');
    db = getFirestore(app);
    notified = [];
    const deps = { db, FieldValue, Timestamp, requireAdmin: async () => '900', staffRole: async () => 'accountant', notify: async m => { notified.push(m); } };
    const payments = paymentFunctions(deps);
    ex = expenseFunctions({ ...deps, payments });
    bank = bankFunctions({ ...deps, expenses: ex });
});
const wipe = async () => {
    for (const name of ['apartments', 'bank', 'bank_tx', 'bank_secrets', 'audit_log', 'payments', 'suppliers', 'contracts', 'expenses', 'expense_settings']) {
        const snap = await db.collection(name).get();
        await Promise.all(snap.docs.map(d => db.recursiveDelete(d.ref)));
    }
    notified.length = 0;
};
afterEach(wipe);
after(async () => { await wipe(); await deleteApp(app); });

const a = () => ex.actions;
const A = ['900', 'accountant'];
const C = ['10', 'chair'];
const contract = (supplierId, extra = {}) => ({ supplierId, number: '12/26', date: '2026-09-20', subject: 'Обслуговування ліфтів', type: 'monthly',
    monthlyKop: 425000, validFrom: '2026-10-01', validTo: '2027-09-30', item: 'lift', files: [], ...extra });
const act = (supplierId, contractId, extra = {}) => ({ supplierId, contractId, docType: 'act', number: '101', date: '2026-10-31', amountKop: 425000,
    period: '2026-10', item: 'lift', description: 'Обслуговування ліфтів за жовтень 2026', files: [], ...extra });

async function setup() {
    await db.doc('bank/settings').set({ startDate: '2026-10-01', accounts: { [OWN]: { purpose: 'current' } } });
    const { id: sid } = await a().saveSupplier(...A, { name: 'ТОВ Ліфт-Сервіс', kind: 'company', code: '14360570', iban: LIFT_IBAN });
    return sid;
}

test('постачальники: перевірка коду й дублікати', async () => {
    const sid = await setup();
    await assert.rejects(a().saveSupplier(...A, { name: 'ТОВ Ліфт', kind: 'company', code: '14360571' }), /ЄДРПОУ/);
    await assert.rejects(a().saveSupplier(...A, { name: 'Інша назва', kind: 'company', code: '14360570' }), /уже є/);
    const r = await a().saveSupplier(...A, { id: sid, name: 'ТОВ «Ліфт-Сервіс»', kind: 'company', code: '14360570', iban: LIFT_IBAN });
    assert.equal(r.id, sid);
    assert.equal((await db.doc(`suppliers/${sid}`).get()).data().name, 'ТОВ «Ліфт-Сервіс»');
});

test('договір понад 50 000 грн — лише з рішенням зборів; бухгалтер подає, голова затверджує', async () => {
    const sid = await setup();
    await assert.rejects(a().saveContract(...A, contract(sid)), /загальних зборів/);
    const { id, status } = await a().saveContract(...A, contract(sid, { meetingDecision: 'Протокол зборів № 3 від 12.09.2026' }));
    assert.equal(status, 'pending');
    assert.equal(notified.at(-1).roles[0], 'chair');
    await assert.rejects(a().decideContract(...A, { id, approve: true }), /голова/);
    await a().decideContract(...C, { id, approve: true });
    assert.equal((await db.doc(`contracts/${id}`).get()).data().status, 'approved');
    // Затверджений договір бухгалтер уже не змінює.
    await assert.rejects(a().saveContract(...A, { ...contract(sid, { meetingDecision: 'x x x' }), id }), /лише голова/);
});

test('документи: за договором — бухгалтер, понад договір чи без нього — голова', async () => {
    const sid = await setup();
    const { id: cid } = await a().saveContract(...C, contract(sid, { validTo: '2026-12-31' }));    // голова — одразу затверджено
    const first = await a().saveExpense(...A, act(sid, cid));
    assert.deepEqual([first.status, first.approval.level], ['approved', 'accountant']);
    await assert.rejects(a().saveExpense(...A, act(sid, cid)), /вже внесено/);
    const second = await a().saveExpense(...A, act(sid, cid, { number: '102', amountKop: 10000, description: 'Заміна кнопки виклику' }));
    assert.deepEqual([second.status, second.approval.level], ['pending', 'chair']);
    assert.match(second.approval.reason, /понад суму договору/);
    const loose = await a().saveExpense(...A, act(sid, null, { number: 'Ч-7', docType: 'receipt', amountKop: 35000, item: 'office', description: 'Канцтовари' }));
    assert.equal(loose.status, 'pending');
    await assert.rejects(a().decideExpense(...C, { id: loose.id, approve: false }), /чому/);
    await a().decideExpense(...C, { id: loose.id, approve: false, comment: 'Немає накладної' });
    await a().decideExpense(...C, { id: second.id, approve: true });
    const ctx = await a().context();
    assert.deepEqual(ctx.expenses.map(e => e.status).sort(), ['approved', 'approved', 'rejected']);
    // Поріг дрібних витрат задає лише голова.
    await assert.rejects(a().setSettings(...A, { smallKop: 50000 }), /голова/);
    await a().setSettings(...C, { smallKop: 50000 });
    const small = await a().saveExpense(...A, act(sid, null, { number: 'Ч-8', docType: 'receipt', amountKop: 35000, item: 'office', description: 'Канцтовари' }));
    assert.equal(small.status, 'approved');
});

test('оплата документа через API, виписка закриває його; повернення списання — документ знову до оплати', async () => {
    const sid = await setup();
    await db.doc('bank_secrets/privat').set({ token: 'secret-token' });
    const { id: cid } = await a().saveContract(...C, contract(sid, { validTo: '2026-12-31' }));
    const { id } = await a().saveExpense(...A, act(sid, cid));
    const real = global.fetch;
    let body;
    global.fetch = async (url, init) => { body = JSON.parse(init.body); return new Response(JSON.stringify({ payment_ref: 'R1', payment_pack_ref: 'PACK9', payment_data: { payment_status: 'new' } }), { status: 201 }); };
    let paymentId;
    try {
        ({ id: paymentId } = await a().pay(...A, { id, account: OWN }));
        await assert.rejects(a().pay(...A, { id, account: OWN }), /уже відправлено/);
    } finally { global.fetch = real; }
    assert.equal(body.payment_destination, 'Оплата за актом № 101 від 31.10.2026, Обслуговування ліфтів за жовтень 2026, без ПДВ');
    assert.equal(body.recipient_nceo, '14360570');
    assert.equal((await db.doc(`payments/${paymentId}`).get()).data().expenseId, id);
    await assert.rejects(a().cancelExpense(...A, { id }), /на підписі/);

    await bank.storeTransactions([{ bankId: 'OUT1', account: OWN, at: new Date('2026-11-03T09:00:00Z'), direction: 'out', amountKop: 425000, dlr: 'PACK9',
        purpose: body.payment_destination, counterparty: { name: 'ТОВ Ліфт-Сервіс', account: LIFT_IBAN, code: '14360570' } }], 'privat', await bank.loadContext());
    const paid = (await db.doc(`expenses/${id}`).get()).data();
    assert.deepEqual([paid.status, paid.paidKop, paid.txIds], ['paid', 425000, [`${OWN}_OUT1`]]);
    assert.equal((await db.doc(`bank_tx/${OWN}_OUT1`).get()).data().expenseId, id);

    await bank.actions.unassign('900', 'accountant', { txId: `${OWN}_OUT1` });
    const back = (await db.doc(`expenses/${id}`).get()).data();
    assert.deepEqual([back.status, back.paidKop, back.txIds], ['approved', 0, []]);
    assert.equal((await db.doc(`bank_tx/${OWN}_OUT1`).get()).data().expenseId, null);
});

test('списання без платежу через API: точна сума — само, інакше підказка й ручна привʼязка', async () => {
    const sid = await setup();
    const { id: cid } = await a().saveContract(...C, contract(sid, { validTo: '2026-12-31' }));
    const { id: e1 } = await a().saveExpense(...A, act(sid, cid));
    const { id: e2 } = await a().saveExpense(...C, act(sid, cid, { number: '102', amountKop: 50000, description: 'Ремонт дверей ліфта' }));
    const out = (bankId, amountKop) => ({ bankId, account: OWN, at: new Date('2026-11-03T09:00:00Z'), direction: 'out', amountKop,
        purpose: 'Оплата', counterparty: { name: 'ТОВ Ліфт-Сервіс', account: LIFT_IBAN, code: '14360570' } });
    await bank.storeTransactions([out('A', 425000), out('B', 30000)], 'privat', await bank.loadContext());
    const ta = (await db.doc(`bank_tx/${OWN}_A`).get()).data();
    assert.deepEqual([ta.kind, ta.status, ta.expenseId, ta.method], ['expense', 'done', e1, 'document']);
    const tb = (await db.doc(`bank_tx/${OWN}_B`).get()).data();
    assert.deepEqual([tb.status, tb.expenseSuggestions], ['review', [e2]]);
    // Часткова оплата: документ лишається до оплати на решту.
    await a().linkTx(...A, { txId: `${OWN}_B`, expenseId: e2 });
    const part = (await db.doc(`expenses/${e2}`).get()).data();
    assert.deepEqual([part.status, part.paidKop], ['approved', 30000]);
    await bank.storeTransactions([out('C', 25000)], 'privat', await bank.loadContext());
    await assert.rejects(a().linkTx(...A, { txId: `${OWN}_C`, expenseId: e2 }), /більше за залишок/);
    const log = (await db.collection('audit_log').get()).docs.map(d => d.data().action);
    assert.ok(log.includes('expenses.link'));
});
