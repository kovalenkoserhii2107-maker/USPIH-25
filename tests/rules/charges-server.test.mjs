// Серверна логіка нарахувань на емуляторі Firestore: тарифи, вхідні
// залишки, нарахування за місяць, перерахунок балансу після оплати,
// скасування й відомість.
import test, { after, afterEach, before } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(new URL('../../functions/package.json', import.meta.url));
const { initializeApp, deleteApp } = require('firebase-admin/app');
const { getFirestore, FieldValue, Timestamp } = require('firebase-admin/firestore');
const chargeFunctions = require('./charges.js');
const bankFunctions = require('./bank.js');

let app, db, charges, bank;
before(() => {
    app = initializeApp({ projectId: 'uspih-25-rules-test' }, 'charges-server-test');
    db = getFirestore(app);
    const deps = { db, FieldValue, Timestamp, requireAdmin: async () => '900', staffRole: async () => 'accountant' };
    charges = chargeFunctions(deps);
    bank = bankFunctions({ ...deps, balances: charges });
});
const wipe = async () => {
    for (const name of ['apartments', 'bank', 'bank_tx', 'bank_links', 'audit_log', 'charges', 'charges_runs']) {
        const snap = await db.collection(name).get();
        await Promise.all(snap.docs.map(d => db.recursiveDelete(d.ref)));
    }
};
afterEach(wipe);
after(async () => { await wipe(); await deleteApp(app); });

async function seed() {
    await db.doc('apartments/10').set({ area: 72.4, balance: 0, personalAccount: '1010' });
    await db.doc('apartments/45').set({ area: '64', balance: -1250.4, personalAccount: '1045' });
    await db.doc('apartments/н1').set({ area: '30,5' });
    await db.doc('apartments/7').set({ area: '' });
    await db.doc('apartments/900').set({ isAdmin: true });
    await db.doc('apartments/45/ledger/old').set({ kind: 'charge', period: '2026-08', amount: 600, at: new Date('2026-08-01') });
    await db.doc('bank/settings').set({ startDate: '2026-10-01', accounts: { UA213052990000026001234567890: { purpose: 'current' } } });
}
const balance = async apt => (await db.doc(`apartments/${apt}`).get()).data().balance;
const a = charges.actions;

test('тарифи: перевірка, групи, приміщення', async () => {
    await seed();
    await assert.rejects(a.addTariff('900', 'accountant', { group: 'res', rate: '8,50', from: '2026-10', decision: '' }), /рішення/);
    await a.addTariff('900', 'accountant', { group: 'res', rate: '8,50', from: '2026-10', decision: 'Протокол зборів № 3' });
    await assert.rejects(a.addTariff('900', 'accountant', { group: 'res', rate: '9', from: '2026-10', decision: 'Ще раз' }), /вже є/);
    await a.addTariff('900', 'accountant', { group: 'nonres', rate: '12', from: '2026-10', decision: 'Протокол зборів № 3' });
    await a.setPremises('900', 'accountant', { apts: ['н1'], group: 'nonres' });
    await assert.rejects(a.setPremises('900', 'accountant', { apts: ['999'], group: 'nonres' }), /999/);
    const { id } = await a.addGroup('900', 'accountant', { name: 'Паркінг' });
    const ctx = await a.context();
    assert.deepEqual(ctx.groups.map(g => g.name), ['Квартири', 'Нежитлові приміщення', 'Паркінг']);
    assert.ok(ctx.groups.some(g => g.id === id));
    assert.deepEqual(ctx.premises, { 'н1': 'nonres' });
    assert.equal(ctx.apartments.length, 4);
    assert.equal(ctx.preview.period, ctx.due[0] || ctx.current);
    // 72,4 × 8,50 + 64 × 8,50 + 30,5 × 12; у кв. 7 немає площі.
    assert.equal(ctx.preview.totalKop, 61540 + 54400 + 36600);
    assert.deepEqual(ctx.preview.problems, [{ apt: '7', reason: 'немає площі' }]);
});

test('вхідні залишки, нарахування, оплата з виписки, перерахунок і скасування', async () => {
    await seed();
    await a.addTariff('900', 'accountant', { group: 'res', rate: '8,50', from: '2026-10', decision: 'Протокол зборів № 3' });
    // Нежитлове без власного тарифу — у проблемах, а не за тарифом квартир.
    await a.setPremises('900', 'accountant', { apts: ['н1'], group: 'nonres' });
    await assert.rejects(a.setOpening('900', 'accountant', { rows: [{ apt: '999', amountKop: 1 }] }), /999/);
    // Поки залишків немає — баланс не чіпаємо.
    assert.deepEqual(await charges.recompute(['45']), { skipped: true, updated: 0 });
    await a.setOpening('900', 'accountant', { rows: [{ apt: '45', amountKop: -125040 }, { apt: '10', amountKop: 20000 }] });
    assert.equal(await balance('45'), -1250.4);     // старий запис за серпень уже у вхідному залишку
    assert.equal(await balance('10'), 200);
    assert.equal(await balance('7'), 0);
    assert.equal((await db.doc('apartments/7/ledger/opening').get()).data().amountKop, 0);
    assert.equal((await db.doc('apartments/900').get()).data().balance, undefined);

    // Сума, яку бачив бухгалтер, має збігтися з тим, що запишемо.
    await assert.rejects(a.run('900', 'accountant', { period: '2026-10', expectTotalKop: 1 }), /змінилися/);
    await assert.rejects(a.run('900', 'accountant', { period: '2026-09' }), /починається/);
    await assert.rejects(a.run('900', 'accountant', { period: '2099-01' }), /наперед/);
    const r = await a.run('900', 'accountant', { period: '2026-10', expectTotalKop: 61540 + 54400 });
    assert.equal(r.count, 2);
    assert.deepEqual(r.problems.map(p => p.apt), ['7', 'н1']);
    const entry = (await db.doc('apartments/10/ledger/charge-2026-10').get()).data();
    assert.deepEqual([entry.kind, entry.amountKop, entry.amount, entry.note], ['charge', 61540, 615.4, 'Внесок за жовтень 2026: 72,4 м² × 8,50 грн']);
    assert.equal(await balance('10'), 200 - 615.4);
    assert.equal(await balance('45'), -1250.4 - 544);

    // Оплата з виписки одразу зменшує борг.
    await bank.storeTransactions([{ bankId: '1', account: 'UA213052990000026001234567890', at: new Date('2026-10-09T07:12:00Z'),
        direction: 'in', amountKop: 179440, purpose: 'внесок о/р 1045', counterparty: { name: 'Шевченко', account: '', code: '' } }],
        'privat', await bank.loadContext());
    assert.equal(await balance('45'), 0);

    // Тариф, за яким уже нараховано, не прибрати.
    const tariffId = (await a.context()).tariffs[0].id;
    await assert.rejects(a.removeTariff('900', 'accountant', { id: tariffId }), /уже нараховано/);

    // Площа змінилася — перерахунок за той самий місяць оновлює суму.
    await db.doc('apartments/10').update({ area: 70 });
    const again = await a.run('900', 'accountant', { period: '2026-10' });
    assert.equal(again.changed, 1);
    assert.equal((await db.doc('apartments/10/ledger/charge-2026-10').get()).data().amountKop, 59500);
    assert.equal(await balance('10'), 200 - 595);

    // Відомість за жовтень.
    const st = await a.getStatement({ period: '2026-10' });
    const row = st.rows.find(x => x.apt === '45');
    assert.deepEqual([row.opening, row.charged, row.paid, row.closing], [-125040, 54400, 179440, 0]);
    assert.equal(st.totals.debtors, 1);

    // Скасування прибирає нарахування й повертає баланси.
    await a.revert('900', 'accountant', { period: '2026-10' });
    assert.equal((await db.doc('apartments/10/ledger/charge-2026-10').get()).exists, false);
    assert.equal(await balance('10'), 200);
    assert.equal(await balance('45'), -1250.4 + 1794.4);

    const log = (await db.collection('audit_log').get()).docs.map(d => d.data().action).sort();
    assert.deepEqual(log, ['charges.opening', 'charges.premises', 'charges.recalc', 'charges.revert', 'charges.run', 'charges.tariff']);
});
