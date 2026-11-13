// Демо-будинок: база в памʼяті з API Firestore (admin і клієнтський SDK).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createDb, Timestamp, FieldValue } from '../../js/demo/memdb.js';

test('admin: запис, merge, update з крапками й службові значення', async () => {
    const db = createDb().admin;
    const ref = db.doc('apartments/7');
    await ref.set({ area: 44.5, owners: ['a'], meta: { a: 1, b: 2 }, at: new Date('2026-01-01T10:00:00Z') });
    await ref.set({ meta: { b: 3 }, n: FieldValue.increment(2), when: FieldValue.serverTimestamp() }, { merge: true });
    await ref.update({ 'meta.c': 4, owners: FieldValue.arrayUnion('b', 'a'), area: FieldValue.delete() });
    const d = (await ref.get()).data();
    assert.deepEqual(d.meta, { a: 1, b: 3, c: 4 });
    assert.deepEqual(d.owners, ['a', 'b']);
    assert.equal(d.n, 2);
    assert.equal('area' in d, false);
    assert.ok(d.at instanceof Timestamp && d.when instanceof Timestamp);
    assert.equal(d.at.toDate().toISOString(), '2026-01-01T10:00:00.000Z');
    await assert.rejects(db.doc('apartments/8').update({ x: 1 }), /не знайдено/);
    await assert.rejects(ref.create({}), /уже існує/);
});

test('admin: запити, групи колекцій, лічильник і час зміни', async () => {
    const db = createDb().admin;
    for (const [id, period, kop] of [['a', '2025-10', 300], ['b', '2025-11', 100], ['c', '2025-11', 200], ['d', '2025-12', 50]]) {
        await db.doc(`apartments/${id}/ledger/x`).set({ period, kop, tags: [period] });
        await db.collection('bank_tx').doc(id).set({ period, kop });
    }
    const q = await db.collection('bank_tx').where('period', 'in', ['2025-11', '2025-12']).orderBy('kop', 'desc').limit(2).get();
    assert.deepEqual(q.docs.map(d => d.id), ['c', 'b']);
    const after = await db.collection('bank_tx').orderBy('kop').startAfter(q.docs[1]).get();
    assert.deepEqual(after.docs.map(d => d.id), ['c', 'a']);
    assert.equal((await db.collectionGroup('ledger').where('tags', 'array-contains', '2025-11').get()).size, 2);
    assert.equal((await db.collection('bank_tx').where('kop', '>=', 200).count().get()).data().count, 2);
    const before = (await db.doc('bank_tx/a').get()).updateTime;
    await db.doc('bank_tx/a').update({ kop: 1 });
    assert.equal((await db.doc('bank_tx/a').get()).updateTime.isEqual(before), false);
});

test('admin: транзакція й пакет записують разом, помилка — нічого', async () => {
    const db = createDb().admin;
    await db.runTransaction(async t => { await t.get(db.doc('x/1')); t.set(db.doc('x/1'), { v: 1 }); t.set(db.doc('x/2'), { v: 2 }); });
    assert.equal((await db.collection('x').get()).size, 2);
    await assert.rejects(db.runTransaction(async t => { t.set(db.doc('x/3'), { v: 3 }); throw new Error('стоп'); }), /стоп/);
    assert.equal((await db.doc('x/3').get()).exists, false);
    const b = db.batch();
    b.delete(db.doc('x/1'));
    b.update(db.doc('x/2'), 'v', 5);
    await b.commit();
    assert.deepEqual((await db.collection('x').get()).docs.map(d => [d.id, d.data().v]), [['2', 5]]);
});

test('клієнт: модульний SDK, живі підписки, збереження й відновлення бази', async () => {
    const store = createDb();
    const c = store.client;
    const fs = c.getFirestore();
    await c.setDoc(c.doc(fs, 'chat', 'm1'), { text: 'Привіт', at: c.serverTimestamp() });
    const ref = await c.addDoc(c.collection(fs, 'chat'), { text: 'Ще', at: Timestamp.fromMillis(Date.now() + 1000) });
    assert.equal((await c.getDoc(ref)).exists(), true);
    const seen = [];
    const off = c.onSnapshot(c.query(c.collection(fs, 'chat'), c.orderBy('at', 'desc'), c.limit(5)), s => seen.push(s.docs.map(d => d.data().text)));
    await new Promise(r => setTimeout(r, 0));
    await c.updateDoc(c.doc(fs, 'chat/m1'), { text: 'Привіт!' });
    await new Promise(r => setTimeout(r, 0));
    off();
    assert.deepEqual(seen.at(-1), ['Ще', 'Привіт!']);
    assert.equal((await c.getCountFromServer(c.query(c.collection(fs, 'chat'), c.where('text', '==', 'Ще')))).data().count, 1);

    const copy = createDb();
    copy.load(JSON.parse(JSON.stringify(store.dump())));
    const back = (await copy.admin.doc('chat/m1').get()).data();
    assert.equal(back.text, 'Привіт!');
    assert.ok(back.at instanceof Timestamp);
});
