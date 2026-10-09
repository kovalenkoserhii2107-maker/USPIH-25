// Серверна логіка банку на емуляторі Firestore: збереження виписки,
// рознесення, розділення, повернення в «Розібрати» й журнал дій.
import test, { after, afterEach, before } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(new URL('../../functions/package.json', import.meta.url));
const { initializeApp, deleteApp } = require('firebase-admin/app');
const { getFirestore, FieldValue, Timestamp } = require('firebase-admin/firestore');
const bankFunctions = require('./bank.js');

let app, db, bank;
before(() => {
    app = initializeApp({ projectId: 'uspih-25-rules-test' }, 'bank-server-test');
    db = getFirestore(app);
    bank = bankFunctions({ db, FieldValue, Timestamp, requireAdmin: async () => '900', staffRole: async () => 'accountant' });
});
const wipe = async () => {
    for (const name of ['apartments', 'bank', 'bank_tx', 'bank_links', 'audit_log']) {
        const snap = await db.collection(name).get();
        await Promise.all(snap.docs.map(d => db.recursiveDelete(d.ref)));
    }
};
afterEach(wipe);
after(async () => { await wipe(); await deleteApp(app); });

async function seed() {
    await db.doc('apartments/45').set({ area: 64, personalAccount: '1045' });
    await db.doc('apartments/46').set({ area: 48 });
    await db.doc('apartments/46/owners/o1').set({ name: 'Бондар Ганна Сергіївна' });
    await db.doc('apartments/900').set({ isAdmin: true });
    await db.doc('bank/settings').set({ startDate: '2026-10-01', accounts: { UA213052990000026001234567890: { purpose: 'current' } } });
}
const tx = (bankId, purpose, extra = {}) => ({
    bankId, account: 'UA213052990000026001234567890', at: new Date('2026-10-09T07:12:00Z'), direction: 'in',
    amountKop: 125040, purpose, counterparty: { name: 'Бондар Ганна Сергіївна', account: 'UA00TRANSIT', code: '' }, ...extra
});

test('виписка: автоматичне рознесення, черга, дублікати й операції до початку обліку', async () => {
    await seed();
    const ctx = await bank.loadContext();
    const first = await bank.storeTransactions([
        tx('1', 'внесок о/р 1045'),
        tx('2', 'комунальні'),
        tx('3', 'кв 45', { at: new Date('2026-09-20T10:00:00Z') }),
        tx('4', 'переказ', { counterparty: { name: 'ОСББ', account: 'UA213052990000026001234567890' } })
    ], 'privat', ctx);
    assert.deepEqual(first, { added: 4, matched: 1 });
    const t1 = (await db.doc('bank_tx/UA213052990000026001234567890_1').get()).data();
    assert.deepEqual([t1.status, t1.kind, t1.method, t1.allocations[0].apt], ['done', 'payment', 'account', '45']);
    const ledger = (await db.doc('apartments/45/ledger/bank-UA213052990000026001234567890_1').get()).data();
    assert.deepEqual([ledger.kind, ledger.amount, ledger.source, ledger.period], ['payment', 1250.4, 'bank', '2026-10']);
    const t2 = (await db.doc('bank_tx/UA213052990000026001234567890_2').get()).data();
    assert.deepEqual([t2.status, t2.suggestions[0].apt], ['review', '46']);
    // До 01.10.2026 — лише показ, в історію квартири не пишемо.
    assert.equal((await db.doc('apartments/45/ledger/bank-UA213052990000026001234567890_3').get()).exists, false);
    assert.equal((await db.doc('bank_tx/UA213052990000026001234567890_4').get()).data().kind, 'internal');
    // Повторна синхронізація нічого не дублює.
    assert.deepEqual(await bank.storeTransactions([tx('1', 'внесок о/р 1045')], 'privat', ctx), { added: 0, matched: 0 });
});

test('ручне рознесення із запамʼятовуванням розносить інші платежі того ж платника', async () => {
    await seed();
    await bank.storeTransactions([tx('10', 'комунальні'), tx('11', 'жовтень', { amountKop: 50000 })], 'privat', await bank.loadContext());
    const result = await bank.actions.assign('900', 'accountant', {
        txId: 'UA213052990000026001234567890_10', allocations: [{ apt: '46', amountKop: 125040 }], remember: true
    });
    assert.equal(result.alsoMatched, 1);
    const other = (await db.doc('bank_tx/UA213052990000026001234567890_11').get()).data();
    assert.deepEqual([other.status, other.method, other.allocations[0].apt], ['done', 'link', '46']);
    assert.equal((await db.collection('bank_links').get()).size, 1);
    const log = (await db.collection('audit_log').get()).docs.map(d => d.data());
    assert.deepEqual(log.map(e => [e.actor, e.role, e.action]), [['900', 'accountant', 'bank.assign']]);
});

test('розділення між квартирами: сума частин має дорівнювати платежу; повернення прибирає історію', async () => {
    await seed();
    await bank.storeTransactions([tx('20', 'кв 45 і кв 46')], 'privat', await bank.loadContext());
    const id = 'UA213052990000026001234567890_20';
    await assert.rejects(bank.actions.assign('900', 'accountant', { txId: id, allocations: [{ apt: '45', amountKop: 100000 }, { apt: '46', amountKop: 100 }] }), /разом/);
    await bank.actions.assign('900', 'accountant', { txId: id, allocations: [{ apt: '45', amountKop: 100000 }, { apt: '46', amountKop: 25040 }] });
    const part = (await db.doc(`apartments/46/ledger/bank-${id}-1`).get()).data();
    assert.deepEqual([part.amount, part.note], [250.4, 'Частина спільного платежу']);
    await assert.rejects(bank.actions.assign('900', 'accountant', { txId: id, allocations: [{ apt: '45', amountKop: 125040 }] }), /вже розібрано/);
    await bank.actions.unassign('900', 'accountant', { txId: id });
    assert.equal((await db.doc(`apartments/45/ledger/bank-${id}`).get()).exists, false);
    assert.equal((await db.doc(`bank_tx/${id}`).get()).data().status, 'review');
});

test('інше надходження: категорія лише з дозволеного списку', async () => {
    await seed();
    await bank.storeTransactions([tx('30', 'поповнення', { counterparty: { name: 'Хтось', account: 'UA1' } })], 'privat', await bank.loadContext());
    const id = 'UA213052990000026001234567890_30';
    await assert.rejects(bank.actions.classifyTx('900', 'accountant', { txId: id, kind: 'income', category: 'salary' }), /категорія/);
    await assert.rejects(bank.actions.classifyTx('900', 'accountant', { txId: id, kind: 'expense', category: 'other' }), /надходження/);
    await bank.actions.classifyTx('900', 'accountant', { txId: id, kind: 'income', category: 'refund' });
    assert.deepEqual(Object.values((({ kind, category, status }) => ({ kind, category, status }))((await db.doc(`bank_tx/${id}`).get()).data())), ['income', 'refund', 'done']);
});
