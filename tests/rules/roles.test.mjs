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

test('банк: читають голова й бухгалтер, пише лише сервер, токен не читає ніхто', async () => {
    await seed();
    await env.withSecurityRulesDisabled(async context => {
        const db = context.firestore();
        await setDoc(doc(db, 'bank/settings'), { tokenSet: true });
        await setDoc(doc(db, 'bank_tx/t1'), { amountKop: 100, status: 'review' });
        await setDoc(doc(db, 'bank_secrets/privat'), { token: 'secret' });
    });
    for (const login of ['10', '900']) {
        const db = as(login).firestore();
        await assertSucceeds(getDoc(doc(db, 'bank/settings')));
        await assertSucceeds(getDocs(collection(db, 'bank_tx')));
        await assertFails(setDoc(doc(db, 'bank_tx/t2'), { amountKop: 1 }));
        await assertFails(updateDoc(doc(db, 'bank_tx/t1'), { status: 'matched' }));
        await assertFails(getDoc(doc(db, 'bank_secrets/privat')));
        await assertFails(setDoc(doc(db, 'bank_secrets/privat'), { token: 'x' }));
    }
    for (const login of ['11', '45']) {
        await assertFails(getDoc(doc(as(login).firestore(), 'bank/settings')));
        await assertFails(getDocs(collection(as(login).firestore(), 'bank_tx')));
    }
});

test('платежі пише лише сервер; push-токен — лише своя квартира й справжня роль', async () => {
    await seed();
    await env.withSecurityRulesDisabled(async context => {
        await setDoc(doc(context.firestore(), 'payments/p1'), { status: 'sent', amountKop: 100 });
    });
    for (const login of ['10', '900']) {
        await assertSucceeds(getDoc(doc(as(login).firestore(), 'payments/p1')));
        await assertFails(setDoc(doc(as(login).firestore(), 'payments/p2'), { status: 'sent' }));
        await assertFails(updateDoc(doc(as(login).firestore(), 'payments/p1'), { status: 'paid' }));
    }
    await assertFails(getDoc(doc(as('11').firestore(), 'payments/p1')));
    await assertFails(getDoc(doc(as('45').firestore(), 'payments/p1')));

    const token = (login, role, extra = {}) => ({ apt: login, role, token: `tok-${login}`, ua: 'test', at: serverTimestamp(), ...extra });
    await assertSucceeds(setDoc(doc(as('10').firestore(), 'push_tokens/tok-10'), token('10', 'chair')));
    await assertSucceeds(setDoc(doc(as('45').firestore(), 'push_tokens/tok-45'), token('45', 'none')));
    await assertFails(setDoc(doc(as('45').firestore(), 'push_tokens/tok-x'), token('45', 'chair', { token: 'tok-x' })));
    await assertFails(setDoc(doc(as('45').firestore(), 'push_tokens/tok-y'), token('10', 'chair', { token: 'tok-y' })));
    await assertFails(setDoc(doc(as('45').firestore(), 'push_tokens/other'), token('45', 'none')));
    await assertFails(getDoc(doc(as('10').firestore(), 'push_tokens/tok-10')));
    await assertSucceeds(deleteDoc(doc(as('10').firestore(), 'push_tokens/tok-10')));
});

test('нарахування пише лише сервер; після вхідних залишків баланс руками не змінити', async () => {
    await seed();
    await env.withSecurityRulesDisabled(async context => {
        await setDoc(doc(context.firestore(), 'charges/settings'), { tariffs: [] });
        await setDoc(doc(context.firestore(), 'charges_runs/2026-10'), { period: '2026-10', totalKop: 100 });
    });
    for (const login of ['10', '900']) {
        const db = as(login).firestore();
        await assertSucceeds(getDoc(doc(db, 'charges/settings')));
        await assertSucceeds(getDocs(collection(db, 'charges_runs')));
        await assertFails(setDoc(doc(db, 'charges/settings'), { tariffs: [{ rate4: 1 }] }));
        await assertFails(setDoc(doc(db, 'charges_runs/2026-11'), { period: '2026-11' }));
    }
    for (const login of ['11', '45']) {
        await assertFails(getDoc(doc(as(login).firestore(), 'charges/settings')));
        await assertFails(getDocs(collection(as(login).firestore(), 'charges_runs')));
    }
    // Поки залишків немає — бухгалтер веде баланс вручну.
    await assertSucceeds(updateDoc(doc(as('900').firestore(), 'apartments/45'), { balance: -50, balanceUpdatedAt: serverTimestamp() }));
    await env.withSecurityRulesDisabled(async context => {
        await setDoc(doc(context.firestore(), 'charges/settings'), { opening: { set: true } }, { merge: true });
    });
    for (const login of ['10', '900']) {
        await assertFails(updateDoc(doc(as(login).firestore(), 'apartments/45'), { balance: 0, balanceUpdatedAt: serverTimestamp() }));
        // Особовий рахунок і далі веде бухгалтерія.
        await assertSucceeds(updateDoc(doc(as(login).firestore(), 'apartments/45'), { personalAccount: '1045' }));
    }
});

test('витрати й договори: читають голова й бухгалтер, пише лише сервер', async () => {
    await seed();
    await env.withSecurityRulesDisabled(async context => {
        const db = context.firestore();
        await setDoc(doc(db, 'suppliers/s1'), { name: 'ТОВ Ліфт', code: '14360570' });
        await setDoc(doc(db, 'contracts/c1'), { supplierId: 's1', status: 'approved' });
        await setDoc(doc(db, 'expenses/e1'), { supplierId: 's1', status: 'pending', amountKop: 100 });
        await setDoc(doc(db, 'expense_settings/main'), { smallKop: 0 });
    });
    for (const login of ['10', '900']) {
        const db = as(login).firestore();
        for (const path of ['suppliers/s1', 'contracts/c1', 'expenses/e1', 'expense_settings/main']) await assertSucceeds(getDoc(doc(db, path)));
        await assertFails(updateDoc(doc(db, 'expenses/e1'), { status: 'approved' }));
        await assertFails(setDoc(doc(db, 'contracts/c2'), { status: 'approved' }));
        await assertFails(setDoc(doc(db, 'expense_settings/main'), { smallKop: 999999 }));
    }
    for (const login of ['11', '45']) {
        await assertFails(getDoc(doc(as(login).firestore(), 'expenses/e1')));
        await assertFails(getDocs(collection(as(login).firestore(), 'suppliers')));
    }
});

test('кошторис читають голова й бухгалтер, пише лише сервер; звіт для мешканців читають усі', async () => {
    await seed();
    await env.withSecurityRulesDisabled(async context => {
        await setDoc(doc(context.firestore(), 'budgets/2027'), { year: '2027', status: 'draft', lines: [] });
        await setDoc(doc(context.firestore(), 'finance/current'), { source: 'ledger', items: [] });
    });
    for (const login of ['10', '900']) {
        await assertSucceeds(getDoc(doc(as(login).firestore(), 'budgets/2027')));
        await assertFails(setDoc(doc(as(login).firestore(), 'budgets/2027'), { status: 'approved' }));
    }
    for (const login of ['11', '45']) await assertFails(getDoc(doc(as(login).firestore(), 'budgets/2027')));
    await assertSucceeds(getDoc(doc(as('45').firestore(), 'finance/current')));
    await assertFails(setDoc(doc(as('45').firestore(), 'finance/current'), { items: [] }));
});

test('зарплату (персональні дані) читають лише голова й бухгалтер, пише лише сервер', async () => {
    await seed();
    await env.withSecurityRulesDisabled(async context => {
        await setDoc(doc(context.firestore(), 'payroll_people/p1'), { name: 'Працівник Тестовий', rnokpp: '3124567809', salaryKop: 864700 });
        await setDoc(doc(context.firestore(), 'payroll_runs/2026-10'), { status: 'draft' });
    });
    for (const login of ['10', '900']) {
        await assertSucceeds(getDoc(doc(as(login).firestore(), 'payroll_people/p1')));
        await assertFails(setDoc(doc(as(login).firestore(), 'payroll_runs/2026-10'), { status: 'approved' }));
    }
    for (const login of ['11', '45']) {
        await assertFails(getDoc(doc(as(login).firestore(), 'payroll_people/p1')));
        await assertFails(getDoc(doc(as(login).firestore(), 'payroll_runs/2026-10')));
    }
});

test('закриті місяці читають голова й бухгалтер, пише лише сервер', async () => {
    await seed();
    await env.withSecurityRulesDisabled(async context => {
        await setDoc(doc(context.firestore(), 'journal_periods/2026-10'), { status: 'closed' });
    });
    for (const login of ['10', '900']) {
        await assertSucceeds(getDoc(doc(as(login).firestore(), 'journal_periods/2026-10')));
        await assertFails(setDoc(doc(as(login).firestore(), 'journal_periods/2026-10'), { status: 'open' }));
    }
    for (const login of ['11', '45']) await assertFails(getDoc(doc(as(login).firestore(), 'journal_periods/2026-10')));
});

test('розшифровку статей читають усі, пише лише сервер; рішення про номери квартир — лише сервер', async () => {
    await seed();
    await env.withSecurityRulesDisabled(async context => {
        await setDoc(doc(context.firestore(), 'finance_ops/exp-lift'), { year: '2027', ops: [] });
        await setDoc(doc(context.firestore(), 'finance_settings/public'), { showApartments: false });
    });
    await assertSucceeds(getDoc(doc(as('45').firestore(), 'finance_ops/exp-lift')));
    for (const login of ['45', '10', '900']) await assertFails(setDoc(doc(as(login).firestore(), 'finance_ops/exp-lift'), { ops: [] }));
    for (const login of ['10', '900']) {
        await assertSucceeds(getDoc(doc(as(login).firestore(), 'finance_settings/public')));
        await assertFails(setDoc(doc(as(login).firestore(), 'finance_settings/public'), { showApartments: true }));
    }
    await assertFails(getDoc(doc(as('45').firestore(), 'finance_settings/public')));
});
