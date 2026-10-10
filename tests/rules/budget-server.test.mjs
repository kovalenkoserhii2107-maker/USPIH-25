// Кошторис на емуляторі Firestore: чернетка, затвердження зборами,
// зміни, план/факт, контроль документів витрат і звіт для мешканців.
import test, { after, afterEach, before } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(new URL('../../functions/package.json', import.meta.url));
const { initializeApp, deleteApp } = require('firebase-admin/app');
const { getFirestore, FieldValue, Timestamp } = require('firebase-admin/firestore');
const budgetFunctions = require('./budget.js');
const expenseFunctions = require('./expenses.js');

const YEAR = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Kyiv' }).format(new Date()).slice(0, 4);
let app, db, bud, ex;
before(() => {
    app = initializeApp({ projectId: 'uspih-25-rules-test' }, 'budget-server-test');
    db = getFirestore(app);
    const deps = { db, FieldValue, Timestamp, requireAdmin: async () => '900', staffRole: async () => 'accountant', notify: async () => {} };
    bud = budgetFunctions(deps);
    ex = expenseFunctions({ ...deps, budget: bud });
});
const wipe = async () => {
    for (const name of ['apartments', 'bank', 'bank_tx', 'audit_log', 'suppliers', 'contracts', 'expenses', 'budgets', 'finance', 'finance_ops', 'finance_settings', 'charges']) {
        const snap = await db.collection(name).get();
        await Promise.all(snap.docs.map(d => db.recursiveDelete(d.ref)));
    }
};
afterEach(wipe);
after(async () => { await wipe(); await deleteApp(app); });

const A = ['900', 'accountant'];
const lines = [{ item: 'lift', title: '', planKop: 5_100_000 }, { item: 'bank', title: '', planKop: 180_000 }, { item: 'capital', title: 'Заміна ліфта', planKop: 20_000_000 }];

test('чернетка → затвердження зборами → зміни лише з новим рішенням', async () => {
    await assert.rejects(bud.actions.save(...A, { year: YEAR, lines: [{ item: 'nope', planKop: 1 }] }), /стаття/);
    await bud.actions.save(...A, { year: YEAR, lines, income: [{ source: 'contributions', planKop: 30_000_000 }] });
    await assert.rejects(bud.actions.approve(...A, { year: YEAR, decision: '' }), /загальні збори/);
    await bud.actions.approve(...A, { year: YEAR, decision: 'Протокол загальних зборів № 4 від 20.12.2025', files: [] });
    await assert.rejects(bud.actions.save(...A, { year: YEAR, lines }), /уже затверджено/);
    await assert.rejects(bud.actions.amend(...A, { year: YEAR, lines, decision: '' }), /протокол/);
    await bud.actions.amend(...A, { year: YEAR, lines: [...lines, { item: 'office', title: '', planKop: 60_000 }], income: [], decision: 'Протокол № 5 від 01.03' });
    const b = (await db.doc(`budgets/${YEAR}`).get()).data();
    assert.deepEqual([b.status, b.lines.length, b.revisions.length, b.revisions[1].previous.lines.length], ['approved', 4, 2, 3]);
    await bud.actions.copy(...A, { year: String(Number(YEAR) + 1), fromYear: YEAR });
    assert.equal((await db.doc(`budgets/${Number(YEAR) + 1}`).get()).data().status, 'draft');
    const log = (await db.collection('audit_log').get()).docs.map(d => d.data().action).sort();
    assert.deepEqual(log, ['budget.amend', 'budget.approve', 'budget.copy', 'budget.save']);
});

test('документ понад кошторис статті затверджує голова, навіть за договором', async () => {
    await bud.actions.save(...A, { year: YEAR, lines: [{ item: 'lift', title: '', planKop: 500_000 }] });
    await bud.actions.approve(...A, { year: YEAR, decision: 'Протокол № 4', files: [] });
    const { id: sid } = await ex.actions.saveSupplier(...A, { name: 'ТОВ Ліфт-Сервіс', kind: 'company', code: '14360570' });
    const { id: cid } = await ex.actions.saveContract('10', 'chair', { supplierId: sid, number: '1', date: `${YEAR}-01-01`, subject: 'Ліфти', type: 'monthly',
        monthlyKop: 425000, validFrom: `${YEAR}-01-01`, validTo: `${YEAR}-03-31`, item: 'lift', files: [] });
    const doc = n => ({ supplierId: sid, contractId: cid, docType: 'act', number: n, date: `${YEAR}-0${n}-28`, amountKop: 425000, period: `${YEAR}-0${n}`, item: 'lift', description: 'Обслуговування ліфтів', files: [] });
    assert.equal((await ex.actions.saveExpense(...A, doc('1'))).status, 'approved');
    const second = await ex.actions.saveExpense(...A, doc('2'));
    assert.equal(second.status, 'pending');
    assert.match(second.approval.reason, /понад кошторис/);
    const office = await ex.actions.saveExpense(...A, { ...doc('3'), contractId: null, item: 'office', description: 'Папір' });
    assert.match(office.approval.reason, /без договору/);
});

test('план/факт і звіт для мешканців без прізвищ', async () => {
    await db.doc('apartments/45').set({ area: 64, balance: -1250.4, personalAccount: '1045' });
    await db.doc('apartments/46').set({ area: 48, balance: 210 });
    await db.doc('apartments/45/owners/o1').set({ name: 'Шевченко Ірина Миколаївна' });
    await db.doc('bank/settings').set({ accounts: { UA1: { balanceKop: 12_845_000, currency: 'UAH', balanceAt: Timestamp.now() } } });
    await bud.actions.save(...A, { year: YEAR, lines, income: [{ source: 'contributions', planKop: 30_000_000 }] });
    await bud.actions.approve(...A, { year: YEAR, decision: 'Протокол № 4', files: [] });
    await db.doc('expenses/e1').set({ supplierName: 'ТОВ Ліфт-Сервіс', item: 'lift', status: 'paid', period: `${YEAR}-01`, date: `${YEAR}-01-31`, amountKop: 425000,
        docType: 'act', number: '101', description: 'Ліфти за січень', files: [{ name: 'akt.pdf', url: 'https://x', path: 'expenses/a' }] });
    await db.doc('expenses/e2').set({ supplierName: 'ТОВ Х', item: 'lift', status: 'pending', period: `${YEAR}-02`, date: `${YEAR}-02-01`, amountKop: 1, docType: 'act', number: '1' });
    await db.doc('bank_tx/t1').set({ direction: 'out', kind: 'expense', status: 'done', category: 'bank_fee', period: `${YEAR}-01`, amountKop: 15000 });
    await db.doc('bank_tx/t2').set({ direction: 'in', kind: 'payment', status: 'done', period: `${YEAR}-01`, amountKop: 100000, purpose: 'кв 45 Шевченко' });
    const ctx = await bud.actions.context({ year: YEAR });
    const main = ctx.execution.sections.find(s => s.id === 'main');
    assert.equal(main.lines.find(l => l.item === 'lift').factKop, 425000);
    assert.equal(main.lines.find(l => l.item === 'bank').factKop, 15000);
    assert.equal(ctx.execution.income[0].factKop, 100000);
    assert.deepEqual(ctx.debt, { totalKop: 125040, count: 1 });
    assert.equal(ctx.publish.stale, true);

    await bud.actions.publish(...A, { year: YEAR });
    const pub = (await db.doc('finance/current').get()).data();
    assert.equal(pub.source, 'ledger');
    assert.equal(pub.funds, 128450);
    assert.deepEqual(pub.debt, { totalKop: 125040, count: 1 });
    assert.deepEqual(pub.expenses.map(e => [e.supplier, e.amountKop, e.files[0].name]), [['ТОВ Ліфт-Сервіс', 425000, 'akt.pdf']]);
    // Ні прізвищ мешканців, ні номерів квартир, ні призначень оплат.
    const text = JSON.stringify(pub);
    assert.ok(!/Шевченко|1045|кв 45/.test(text));
    assert.ok((await db.doc(`finance/${YEAR}`).get()).exists);
    assert.equal((await bud.actions.context({ year: YEAR })).publish.stale, false);
    // Нова оплата — звіт не «застаріває» щогодини: нагадування не частіше ніж раз на тиждень.
    await db.doc('bank_tx/t3').set({ direction: 'in', kind: 'payment', status: 'done', period: `${YEAR}-01`, amountKop: 5000 });
    assert.equal((await bud.actions.context({ year: YEAR })).publish.stale, false);
    // Зміни до кошторису — одразу.
    await bud.actions.amend(...A, { year: YEAR, lines: lines.slice(0, 2), income: [], decision: 'Протокол № 5' });
    assert.equal((await bud.actions.context({ year: YEAR })).publish.stale, true);
});

test('розшифровка статей і боржники: номери квартир — лише за рішенням голови', async () => {
    await db.doc('apartments/45').set({ area: 64, entrance: '3', balance: -1250.4, personalAccount: '1045' });
    await db.doc('apartments/45/owners/o1').set({ name: 'Шевченко Ірина Миколаївна' });
    await db.doc('bank_tx/r1').set({ direction: 'in', kind: 'income', category: 'rent', status: 'done', period: `${YEAR}-01`, at: new Date(`${YEAR}-01-05T10:00:00Z`),
        amountKop: 7000, relatedApt: '45', purpose: 'Оренда комори, кв. 45', counterparty: { name: 'ШЕВЧЕНКО ІРИНА', code: '' } });
    await db.doc('bank_tx/r2').set({ direction: 'in', kind: 'income', category: 'equipment', status: 'done', period: `${YEAR}-01`, at: new Date(`${YEAR}-01-06T10:00:00Z`),
        amountKop: 1000000, purpose: 'Розміщення обладнання', counterparty: { name: 'ТОВ "ТЕЛЕКОМ-ДЕМО"', code: '12345678' } });
    await db.doc('bank_tx/x1').set({ direction: 'out', kind: 'expense', category: 'salary', status: 'done', period: `${YEAR}-01`, at: new Date(`${YEAR}-01-15T10:00:00Z`),
        amountKop: 182195, purpose: 'Аванс Петренку', counterparty: { name: 'ПЕТРЕНКО ОЛЕГ', code: '' } });
    await bud.actions.publish(...A, { year: YEAR });
    const ops = async key => (await db.doc(`finance_ops/${key}`).get()).data()?.ops;
    const pub = (await db.doc('finance/current').get()).data();
    assert.equal(pub.showApartments, false);
    assert.deepEqual(pub.opsIndex['inc-equipment'], { count: 1, totalKop: 1000000 });
    assert.deepEqual((await ops('inc-equipment'))[0].who, 'ТОВ "ТЕЛЕКОМ-ДЕМО"');
    assert.deepEqual((await ops('inc-rent'))[0].who, 'Співвласник');
    assert.deepEqual((await ops('exp-salary'))[0].who, 'Працівник ОСББ');
    assert.equal(pub.debt.list, undefined);
    for (const key of Object.keys(pub.opsIndex)) assert.ok(!/Шевченко|ШЕВЧЕНКО|ПЕТРЕНКО|1045|кв\. 45|Квартира 45/.test(JSON.stringify(await ops(key))), key);

    // Бухгалтер не вирішує, голова — так; звіт оновлюється одразу.
    await assert.rejects(bud.actions.visibility(...A, { showApartments: true }), /голова/);
    await bud.actions.visibility('10', 'chair', { showApartments: true });
    const shown = (await db.doc('finance/current').get()).data();
    assert.equal(shown.showApartments, true);
    assert.deepEqual(shown.debt.list, [{ apt: '45', label: "Під'їзд 3, Квартира 45", entrance: '3', kop: 125040 }]);
    assert.equal((await ops('inc-rent'))[0].who, "Під'їзд 3, Квартира 45");
    assert.equal((await ops('exp-salary'))[0].who, 'Працівник ОСББ');
    assert.ok(!/Шевченко|ШЕВЧЕНКО|ПЕТРЕНКО/.test(JSON.stringify(shown)));
    // Бухгалтер у кабінеті бачить усе, з призначенням.
    const ctx = await bud.actions.context({ year: YEAR });
    assert.equal(ctx.ops['exp-salary'][0].who, 'ПЕТРЕНКО ОЛЕГ');
    assert.equal(ctx.ops['inc-rent'][0].what, 'Оренда комори, кв. 45');
});
