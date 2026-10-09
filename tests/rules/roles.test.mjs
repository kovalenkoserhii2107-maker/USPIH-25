// Ролі правління: голова, член правління, бухгалтер і перехідний спільний запис.
import test, { after, afterEach, before } from 'node:test';
import { readFile } from 'node:fs/promises';
import { initializeTestEnvironment, assertFails, assertSucceeds } from '@firebase/rules-unit-testing';
import { doc, getDoc, getDocs, collection, setDoc, updateDoc, deleteDoc, serverTimestamp } from 'firebase/firestore';
import { ref, uploadString } from 'firebase/storage';

let env;
before(async () => {
    env = await initializeTestEnvironment({
        // Той самий проєкт, що й у емулятора: правила Storage читають ролі
        // з Firestore саме цього проєкту. Файли тестів ідуть по черзі.
        projectId: 'uspih-25-rules-test',
        firestore: { rules: await readFile('firestore.rules', 'utf8') },
        storage: { rules: await readFile('storage.rules', 'utf8') }
    });
});
afterEach(async () => env.clearFirestore());
after(async () => env.cleanup());

const as = login => env.authenticatedContext(`uid-${login}`, { email: `${login}@uspih-25.com` });
const staff = (role, extra = {}) => ({ role, name: role, active: true, updatedBy: 'seed', updatedAt: new Date(), ...extra });

async function seed() {
    await env.withSecurityRulesDisabled(async context => {
        const db = context.firestore();
        await setDoc(doc(db, 'apartments/45'), { isAdmin: false, area: 64, balance: -100 });
        for (const apt of ['10', '11', '13']) await setDoc(doc(db, `apartments/${apt}`), { isAdmin: false, area: 50 });
        // Бухгалтер без квартири — службовий запис, якого немає в довіднику.
        await setDoc(doc(db, 'apartments/900'), { isAdmin: true });
        // Старий спільний запис правління без документа в staff.
        await setDoc(doc(db, 'apartments/board'), { isAdmin: true });
        await setDoc(doc(db, 'staff/10'), staff('chair'));
        await setDoc(doc(db, 'staff/11'), staff('board'));
        await setDoc(doc(db, 'staff/900'), staff('accountant'));
        await setDoc(doc(db, 'staff/13'), staff('board', { active: false }));
        await setDoc(doc(db, 'apartments/45/ledger/20261001-charge-120000'), { at: new Date('2026-10-01'), period: '2026-10', kind: 'charge', amount: 1200, note: '' });
    });
}

test('член правління веде збори й довідник, але не гроші', async () => {
    await seed();
    const db = as('11').firestore();
    await assertSucceeds(getDoc(doc(db, 'apartments/45')));
    await assertSucceeds(setDoc(doc(db, 'polls/p1'), { title: 'Опитування', status: 'active', options: ['Так'] }));
    await assertSucceeds(updateDoc(doc(db, 'apartments/45'), { area: 65 }));
    await assertFails(updateDoc(doc(db, 'apartments/45'), { balance: 0 }));
    await assertFails(setDoc(doc(db, 'finance/current'), { period: 'Жовтень', items: [] }));
    await assertFails(setDoc(doc(db, 'apartments/45/ledger/x'), { at: new Date(), kind: 'payment', amount: 10 }));
    await assertFails(setDoc(doc(db, 'osbb_settings/finance'), { iban: 'UA' }));
    await assertSucceeds(setDoc(doc(db, 'status/power'), { on: true }));
    await assertFails(setDoc(doc(db, 'status/meter_heat_2026-10'), { reading: 1 }));
});

test('бухгалтер веде гроші й облік, але не збори та не дані квартир', async () => {
    await seed();
    const db = as('900').firestore();
    await assertSucceeds(getDoc(doc(db, 'apartments/45')));
    await assertSucceeds(updateDoc(doc(db, 'apartments/45'), { balance: 0, balanceUpdatedAt: serverTimestamp() }));
    await assertSucceeds(setDoc(doc(db, 'finance/current'), { period: 'Жовтень', items: [] }));
    await assertSucceeds(setDoc(doc(db, 'osbb_settings/finance'), { iban: 'UA' }));
    await assertSucceeds(setDoc(doc(db, 'status/meter_heat_2026-10'), { reading: 1 }));
    await assertSucceeds(setDoc(doc(db, 'status/tariff_water_2026-10-01'), { tariff: 30 }));
    await assertFails(setDoc(doc(db, 'status/power'), { on: false }));
    await assertFails(updateDoc(doc(db, 'apartments/45'), { area: 70 }));
    await assertFails(setDoc(doc(db, 'polls/p1'), { title: 'Збори', status: 'active', options: [] }));
    await assertFails(setDoc(doc(db, 'osbb_settings/osbb'), { name: 'ОСББ' }));
});

test('облік лише поповнюється: суму минулої операції не змінити, видаляє лише голова', async () => {
    await seed();
    const accountant = as('900').firestore();
    const entry = doc(accountant, 'apartments/45/ledger/20261001-charge-120000');
    await assertSucceeds(setDoc(doc(accountant, 'apartments/45/ledger/20261002-payment-50000'),
        { at: new Date('2026-10-02'), period: '2026-10', kind: 'payment', amount: 500, note: '' }));
    await assertSucceeds(updateDoc(entry, { note: 'уточнення', updatedAt: serverTimestamp() }));
    await assertFails(updateDoc(entry, { amount: 1 }));
    await assertFails(deleteDoc(entry));
    await assertSucceeds(deleteDoc(doc(as('10').firestore(), 'apartments/45/ledger/20261001-charge-120000')));
});

test('позначку службового запису змінює лише голова', async () => {
    await seed();
    await assertFails(updateDoc(doc(as('11').firestore(), 'apartments/45'), { isAdmin: true }));
    await assertFails(updateDoc(doc(as('900').firestore(), 'apartments/45'), { isAdmin: true }));
    await assertSucceeds(updateDoc(doc(as('10').firestore(), 'apartments/45'), { isAdmin: true }));
    // Імпорт довідника створює квартиру з явним isAdmin: false — це не зміна позначки.
    await assertSucceeds(setDoc(doc(as('11').firestore(), 'apartments/77'), { isAdmin: false, area: 40 }));
});

test('вимкнений член правління та мешканець не мають службового доступу', async () => {
    await seed();
    for (const login of ['13', '45']) {
        const db = as(login).firestore();
        await assertFails(getDoc(doc(db, 'apartments/10')));
        await assertFails(setDoc(doc(db, 'polls/p2'), { title: 'x', status: 'active', options: [] }));
        await assertFails(getDocs(collection(db, 'staff')));
        await assertFails(getDocs(collection(db, 'audit_log')));
    }
    // Свій документ ролі читати можна — так застосунок дізнається, що ролі немає.
    await assertSucceeds(getDoc(doc(as('45').firestore(), 'staff/45')));
    await assertFails(getDoc(doc(as('45').firestore(), 'staff/10')));
});

test('ролі призначає лише голова, лише іншим і з підписом', async () => {
    await seed();
    const role = (login, extra = {}) => ({ role: 'board', name: 'Новий член', active: true, updatedBy: login, updatedAt: serverTimestamp(), ...extra });
    await assertSucceeds(setDoc(doc(as('10').firestore(), 'staff/45'), role('10')));
    await assertFails(setDoc(doc(as('10').firestore(), 'staff/10'), role('10', { role: 'accountant' })));
    await assertFails(setDoc(doc(as('10').firestore(), 'staff/46'), role('11')));
    await assertFails(setDoc(doc(as('10').firestore(), 'staff/46'), role('10', { role: 'admin' })));
    await assertFails(setDoc(doc(as('11').firestore(), 'staff/46'), role('11')));
    await assertFails(setDoc(doc(as('900').firestore(), 'staff/46'), role('900')));
    await assertFails(deleteDoc(doc(as('10').firestore(), 'staff/11')));
    await assertSucceeds(getDocs(collection(as('900').firestore(), 'staff')));
});

test('спільний запис правління діє як голова, доки голова його не вимкне', async () => {
    await seed();
    const legacy = as('board').firestore();
    await assertSucceeds(setDoc(doc(legacy, 'finance/current'), { period: 'Жовтень', items: [] }));
    await assertSucceeds(setDoc(doc(legacy, 'staff/45'), { role: 'board', name: 'Член', active: true, updatedBy: 'board', updatedAt: serverTimestamp() }));
    await assertSucceeds(setDoc(doc(as('10').firestore(), 'staff/board'),
        { role: 'chair', name: 'Спільний запис', active: false, updatedBy: '10', updatedAt: serverTimestamp() }));
    await assertFails(setDoc(doc(legacy, 'finance/current'), { period: 'Листопад', items: [] }));
    await assertFails(getDoc(doc(legacy, 'apartments/45')));
});

test('журнал дій лише поповнюється, автор і роль — той, хто увійшов', async () => {
    await seed();
    const entry = (actor, role, extra = {}) => ({ actor, role, action: 'balances.import', target: 'apartments', summary: 'Баланси 3 квартир', details: { count: 3 }, at: serverTimestamp(), ...extra });
    const accountant = as('900').firestore();
    await assertSucceeds(setDoc(doc(accountant, 'audit_log/a1'), entry('900', 'accountant')));
    await assertFails(setDoc(doc(accountant, 'audit_log/a2'), entry('10', 'accountant')));
    await assertFails(setDoc(doc(accountant, 'audit_log/a3'), entry('900', 'chair')));
    await assertFails(setDoc(doc(accountant, 'audit_log/a4'), entry('900', 'accountant', { at: new Date('2020-01-01') })));
    await assertFails(setDoc(doc(as('45').firestore(), 'audit_log/a5'), entry('45', 'none')));
    await assertFails(updateDoc(doc(accountant, 'audit_log/a1'), { summary: 'інше' }));
    await assertFails(deleteDoc(doc(as('10').firestore(), 'audit_log/a1')));
    await assertSucceeds(getDocs(collection(as('11').firestore(), 'audit_log')));
});

test('файли: квитанції — бухгалтеру, матеріали зборів — правлінню', async () => {
    await seed();
    await assertSucceeds(uploadString(ref(as('900').storage(), 'receipts/45/oct.pdf'), 'pdf', 'raw', { contentType: 'application/pdf' }));
    await assertFails(uploadString(ref(as('900').storage(), 'polls/agenda.pdf'), 'pdf', 'raw', { contentType: 'application/pdf' }));
    await assertSucceeds(uploadString(ref(as('11').storage(), 'polls/agenda.pdf'), 'pdf', 'raw', { contentType: 'application/pdf' }));
    await assertFails(uploadString(ref(as('11').storage(), 'receipts/45/oct.pdf'), 'pdf', 'raw', { contentType: 'application/pdf' }));
    await assertFails(uploadString(ref(as('13').storage(), 'polls/agenda.pdf'), 'pdf', 'raw', { contentType: 'application/pdf' }));
});
