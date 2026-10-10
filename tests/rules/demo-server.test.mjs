// Демо-прогін на емуляторі: справжні функції системи проходять повний
// місяць обліку, а «Прибрати демо» повертає квартири до попереднього стану.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(new URL('../../functions/package.json', import.meta.url));
const { initializeApp, deleteApp } = require('firebase-admin/app');
const { getFirestore, FieldValue, Timestamp } = require('firebase-admin/firestore');

let app, db, demo;
const COLLECTIONS = ['apartments', 'staff', 'bank', 'bank_tx', 'bank_links', 'audit_log', 'payments', 'suppliers', 'contracts', 'expenses',
    'expense_settings', 'budgets', 'finance', 'finance_ops', 'finance_settings', 'charges', 'charges_runs', 'demo'];
const wipe = async () => {
    for (const name of COLLECTIONS) {
        const snap = await db.collection(name).get();
        await Promise.all(snap.docs.map(d => db.recursiveDelete(d.ref)));
    }
};
before(async () => {
    app = initializeApp({ projectId: 'uspih-25-rules-test' }, 'demo-server-test');
    db = getFirestore(app);
    const deps = { db, FieldValue, Timestamp, requireAdmin: async () => '10', staffRole: async () => 'chair', notify: async () => {} };
    const charges = require('./charges.js')(deps);
    const payments = require('./payments.js')(deps);
    const budget = require('./budget.js')(deps);
    const expenses = require('./expenses.js')({ ...deps, payments, budget });
    const bank = require('./bank.js')({ ...deps, balances: charges, expenses });
    demo = require('./demo.js')({ ...deps, charges, bank, expenses, budget });
    await wipe();
});
after(async () => { await wipe(); await deleteApp(app); });

test('прогін лишає слід у всіх розділах, «Прибрати» повертає як було', async () => {
    for (let i = 1; i <= 40; i++) {
        await db.doc(`apartments/${i}`).set({ area: i % 4 ? 50 + i : '', balance: i % 5 ? 0 : -100, personalAccount: `10${i}`, ...(i === 2 ? { area: 64, residents: 2 } : {}) });
        if (i % 3 === 0) await db.doc(`apartments/${i}/owners/o1`).set({ name: `Власник Тестовий ${i}` });
    }
    await db.doc('apartments/900').set({ isAdmin: true });
    await db.doc('staff/900').set({ role: 'accountant', active: true });

    assert.deepEqual((await demo.actions.status()).blockers, []);
    const r = await demo.actions.run('10');
    assert.equal(r.steps.length, 9);
    assert.equal(r.summary.apartments, 40);

    // Нарахування: 4 складові, сума ~ річні надходження / 12.
    const settings = (await db.doc('charges/settings').get()).data();
    assert.deepEqual(settings.components.map(c => c.name), ['Обслуговування будинку та прибудинкової території', 'Освітлення З. М',
        'Внесок на обслуговування ліфтів', 'Вивезення побутових відходів']);
    const run = (await db.doc('charges_runs/2026-10').get()).data();
    assert.equal(run.count, 40);
    // Квартира як у реальній квитанції (64 м², 2 проживають) — рівно 391,82 грн.
    assert.equal(run.amounts['2'], 39182);
    // Уже внесений баланс став вхідним залишком.
    assert.equal((await db.doc('apartments/5/ledger/opening').get()).data().amountKop, -10000);
    // Оплати повним форматом сервісу («О/р 000…, кв. N, за комунальні послуги») рознесено за особовим рахунком.
    const long = (await db.collection('bank_tx').where('source', '==', 'demo').get()).docs.map(d => d.data()).filter(t => /^О\/р 0/.test(t.purpose));
    assert.ok(long.length && long.every(t => t.status === 'done' && t.method === 'account'), JSON.stringify(long.map(t => [t.purpose, t.status, t.method])));
    const entry = (await db.doc('apartments/1/ledger/charge-2026-10').get()).data();
    assert.equal(entry.parts.length, 4);
    // Площу внесено лише там, де її не було.
    assert.equal((await db.doc('apartments/4/ledger/charge-2026-10').get()).exists, true);

    // Виписка: частина оплат рознесена сама, частина — у «Вхідних»; оренда й обладнання — доходи.
    const tx = (await db.collection('bank_tx').where('source', '==', 'demo').get()).docs.map(d => d.data());
    assert.ok(tx.filter(t => t.kind === 'payment' && t.status === 'done').length > 0);
    assert.ok(tx.some(t => t.status === 'review'));
    assert.equal(tx.filter(t => t.kind === 'income' && t.category === 'rent').length, 5);
    assert.ok(tx.every(t => t.category !== 'rent' || t.relatedApt));
    assert.equal(tx.filter(t => t.category === 'equipment').length, 1);
    assert.equal(tx.filter(t => t.kind === 'internal').length, 1);
    // Акти за вересень і ремонт з резервного фонду закриті списаннями, дах — чекає голову.
    const ex = (await db.collection('expenses').get()).docs.map(d => d.data());
    assert.equal(ex.filter(e => e.status === 'paid').length, 5);
    // ЄСВ — окремою статтею; за кожен платіж — комісія банку.
    assert.equal(tx.filter(t => t.category === 'esv').length, 1);
    assert.equal(tx.filter(t => t.category === 'taxes').length, 1);
    assert.ok(tx.filter(t => t.category === 'bank_fee').length >= 8);
    assert.equal(ex.filter(e => e.status === 'pending').length, 1);
    // Кошторис затверджено, звіт для мешканців — без прізвищ.
    assert.equal((await db.doc('budgets/2026').get()).data().status, 'approved');
    const pub = (await db.doc('finance/current').get()).data();
    assert.ok(pub.debt.totalKop > 0);
    assert.ok(!JSON.stringify(pub).includes('Власник Тестовий'));
    // Розшифровка статей: сума операцій = факт рядка; працівника мешканцям не називаємо.
    const ops = async key => (await db.doc(`finance_ops/${key}`).get()).data().ops;
    const lines = pub.budget.sections.flatMap(s => s.lines);
    for (const item of ['lift', 'power', 'esv', 'bank', 'reserve']) {
        const line = lines.find(l => l.item === item);
        assert.equal(pub.opsIndex[`exp-${item}`].totalKop, line.factKop, item);
        assert.equal((await ops(`exp-${item}`)).reduce((s, o) => s + o.amountKop, 0), line.factKop, item);
    }
    assert.equal((await ops('exp-lift'))[0].who, 'ТОВ «Ліфт-Сервіс» (демо)');
    assert.ok((await ops('exp-salary')).every(o => o.who !== 'ПРАЦІВНИК ОСББ (ДЕМО)' && !o.what));
    // Надходження: внески за складовими = частини рядка «Внески»; боржники — з номерами (демо вмикає).
    const contrib = pub.budget.income.find(i => i.source === 'contributions');
    for (const p of contrib.parts) assert.equal((await ops(`inc-c-${p.component}`)).reduce((s, o) => s + o.amountKop, 0), p.factKop, p.title);
    assert.match((await ops('inc-c-main'))[0].who, /^(Під'їзд \d+, )?Квартира \S+$/);
    assert.equal(pub.showApartments, true);
    assert.equal(pub.debt.list.length, pub.debt.count);
    assert.ok(!JSON.stringify(pub.debt).includes('Власник Тестовий'));
    assert.ok((await db.collection('audit_log').where('action', '==', 'demo.run').get()).size === 1);
    // Повторно — не можна.
    await assert.rejects(demo.actions.run('10'), /вже прогнано/);

    await demo.actions.remove('10');
    assert.equal((await db.collection('bank_tx').get()).size, 0);
    assert.equal((await db.collection('expenses').get()).size, 0);
    assert.equal((await db.collection('charges_runs').get()).size, 0);
    assert.equal((await db.doc('budgets/2026').get()).exists, false);
    assert.equal((await db.collection('finance_ops').get()).size, 0);
    assert.equal((await db.doc('finance_settings/public').get()).exists, false);
    assert.equal((await db.doc('charges/settings').get()).exists, false);
    const a4 = (await db.doc('apartments/4').get()).data();
    const a5 = (await db.doc('apartments/5').get()).data();
    assert.deepEqual([a4.area, a4.residents, a5.balance, a5.balanceSource], ['', undefined, -100, undefined]);
    assert.equal((await db.doc('apartments/2').get()).data().residents, 2);
    assert.equal((await db.collection('apartments/1/ledger').get()).size, 0);
    assert.deepEqual((await demo.actions.status()).blockers, []);
});

test('квартира-зразок: залишок і оплата за статтями — як у квитанції сервісу', async () => {
    await wipe();
    for (let i = 1; i <= 30; i++) await db.doc(`apartments/${i}`).set({ area: 40 + i, balance: 0, personalAccount: `10${i}` });
    await db.doc('apartments/45').set({ area: 50, personalAccount: '401230045' });
    await db.doc('apartments/45/owners/o1').set({ name: 'Петренко Іван Іванович' });
    const history = 'Квартира;Дата;Тип;Сума;Примітка\n45;31.08.2026;нарахування;392,46;Нарахування за серпень\n45;15.09.2026;оплата;400,00;О/р 00401230045\n45;30.09.2026;нарахування;391,82;Нарахування за вересень\n45;01.10.2026;оплата;1,00;вже в обліку застосунку';
    const r = await demo.actions.run('10', { showcase: { apt: '45', area: '64', residents: '2', openingKop: 586305, history } });
    assert.ok(r.steps.some(s => s.startsWith('Квартира-зразок 45: 64 м², проживає 2, залишок на 30.09.2026 5') && s.endsWith('записів: 3')));

    // Історія з сервісу — лише до жовтня 2026.
    const hist = (await db.collection('apartments/45/ledger').where('source', '==', 'demo-import').get()).docs.map(d => d.data().kind);
    assert.deepEqual(hist.sort(), ['charge', 'charge', 'payment']);
    // Залишок 30.09 за статтями: інші статті винні вересень, решта — обслуговування будинку.
    const comps = (await db.doc('charges/settings').get()).data().components;
    const id = name => comps.find(c => c.name.startsWith(name)).id;
    const opening = (await db.doc('apartments/45/ledger/opening').get()).data();
    assert.deepEqual(opening.parts, { [id('Освітлення')]: -3072, [id('Внесок')]: -4032, [id('Вивезення')]: -2830, main: 596239 });
    assert.equal((await db.doc('apartments/45/ledger/charge-2026-10').get()).data().amountKop, 39182);
    // Оплата 400 за особовим рахунком: спершу борги інших статей, решта — на обслуговування.
    const tx = (await db.collection('bank_tx').where('source', '==', 'demo').get()).docs.map(d => ({ id: d.id, ...d.data() }))
        .filter(t => (t.allocations || []).some(a => a.apt === '45'));
    const main = tx.find(t => t.amountKop === 40000);
    assert.equal(main.method, 'account');
    const pay = (await db.doc(`apartments/45/ledger/bank-${main.id}`).get()).data();
    assert.deepEqual(pay.alloc.map(a => [a.name, a.amountKop]), [['Освітлення З. М', 3072], ['Внесок на обслуговування ліфтів', 4032],
        ['Вивезення побутових відходів', 2830], ['Обслуговування будинку та прибудинкової території', 30066]]);
    // Ручне рознесення із запамʼятовуванням — наступна оплата того самого платника вже сама.
    assert.deepEqual(tx.filter(t => t.amountKop !== 40000).map(t => [t.amountKop, t.method]).sort(), [[2500, 'link'], [5000, 'manual']]);
    assert.equal((await db.collection('bank_links').get()).size, 1);
    // Баланс за статтями в картці квартири; разом — як загальний баланс.
    const apt = (await db.doc('apartments/45').get()).data();
    assert.equal(Math.round(apt.balanceParts.reduce((s, p) => s + p.amountKop, 0)), Math.round(apt.balance * 100));
    assert.equal(apt.balance, (586305 + 40000 + 5000 + 2500 - 39182) / 100);

    await demo.actions.remove('10');
    assert.equal((await db.collection('apartments/45/ledger').get()).size, 0);
    assert.equal((await db.collection('bank_links').get()).size, 0);
    const back = (await db.doc('apartments/45').get()).data();
    assert.deepEqual([back.area, back.residents, back.balance], [50, undefined, null]);
});
