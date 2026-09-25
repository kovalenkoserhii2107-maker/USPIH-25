import test, { after, afterEach, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { initializeTestEnvironment, assertFails, assertSucceeds } from '@firebase/rules-unit-testing';
import { doc, getDoc, setDoc, updateDoc } from 'firebase/firestore';
import { ref, uploadString } from 'firebase/storage';

let env;
before(async () => {
    env = await initializeTestEnvironment({
        projectId: 'uspih-25-rules-test',
        firestore: { rules: await readFile('firestore.rules', 'utf8') },
        storage: { rules: await readFile('storage.rules', 'utf8') }
    });
});
afterEach(async () => env.clearFirestore());
after(async () => env.cleanup());

async function seed() {
    await env.withSecurityRulesDisabled(async context => {
        const db = context.firestore();
        await setDoc(doc(db, 'apartments/45'), { isAdmin: false, balance: -100 });
        await setDoc(doc(db, 'apartments/board'), { isAdmin: true });
    });
}

test('мешканець читає свою квартиру, але не змінює баланс', async () => {
    await seed();
    const db = env.authenticatedContext('resident', { email: '45@uspih-25.com' }).firestore();
    await assertSucceeds(getDoc(doc(db, 'apartments/45')));
    await assertFails(updateDoc(doc(db, 'apartments/45'), { balance: 0 }));
});

test('мешканець завантажує файл лише у власну папку звернень', async () => {
    await seed();
    const storage = env.authenticatedContext('resident', { email: '45@uspih-25.com' }).storage();
    await assertSucceeds(uploadString(ref(storage, 'requests/45/a.txt'), 'ok'));
    await assertFails(uploadString(ref(storage, 'requests/46/a.txt'), 'no'));
});

test('правління публікує документ ОСББ', async () => {
    await seed();
    const storage = env.authenticatedContext('admin', { email: 'board@uspih-25.com' }).storage();
    const result = await assertSucceeds(uploadString(ref(storage, 'osbb_docs/protocol.pdf'), 'pdf', 'raw', {
        contentType: 'application/pdf'
    }));
    assert.ok(result.ref);
});
