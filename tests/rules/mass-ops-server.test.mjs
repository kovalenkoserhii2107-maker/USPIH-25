// Масові операції й невизначені платежі на емуляторі: перерване
// нарахування дописується за збереженим планом, доти місяць не
// закривається; голова фіксує, що платежу в Приват24 немає (чи він є);
// відомість з відпусткою й середньоденною з попередньої відомості.
import test, { after, afterEach, before } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(new URL('../../functions/package.json', import.meta.url));
const { initializeApp, deleteApp } = require('firebase-admin/app');
const { getFirestore, FieldValue, Timestamp } = require('firebase-admin/firestore');

let app, db, charges, journal, payments, payroll;
before(() => {
    app = initializeApp({ projectId: 'uspih-25-rules-test' }, 'mass-ops-server-test');
    db = getFirestore(app);
    const deps = { db, FieldValue, Timestamp, requireAdmin: async () => '900', staffRole: async () => 'accountant', notify: async () => {} };
    const lock = require('./period-lock.js')(db);
    charges = require('./charges.js')({ ...deps, lock });
    journal = require('./journal.js')({ ...deps, lock, now: () => new Date('2026-11-15T10:00:00Z') });
    payments = require('./payments.js')(deps);
    const stub = { actions: { create: async () => ({ id: 'x' }) } };
    payroll = require('./payroll.js')({ ...deps, payments: stub, lock });
});
const wipe = async () => {
    for (const name of ['apartments', 'audit_log', 'charges', 'charges_runs', 'journal_periods', 'payments', 'payroll_people', 'payroll_runs', 'payroll_settings']) {
        const snap = await db.collection(name).get();
        await Promise.all(snap.docs.map(d => db.recursiveDelete(d.ref)));
    }
};
afterEach(wipe);
after(async () => { await wipe(); await deleteApp(app); });

const A = ['900', 'accountant'];
const C = ['10', 'chair'];

test('нарахування перервано посередині: план лишається, місяць не закривається, «Завершити операцію» дописує решту', async () => {
    for (const apt of ['1', '2', '3']) await db.doc(`apartments/${apt}`).set({ area: 50, balance: 0 });
    await charges.actions.addTariff(...A, { group: 'res', rate: '8,00', from: '2026-10', decision: 'Протокол зборів № 3' });
    await charges.actions.setOpening(...A, { rows: [{ apt: '1', amountKop: -5000 }] });
    assert.equal((await db.doc('charges/opening_plan').get()).exists, false);
    await charges.actions.run(...A, { period: '2026-10' });
    let run = (await db.doc('charges_runs/2026-10').get()).data();
    assert.equal(run.status, 'complete');
    assert.equal((await db.doc('charges_runs/2026-10/plan/main').get()).exists, false);

    // Імітуємо обрив: план є, позначка «записується», один запис історії не встиг.
    const rows = ['1', '2', '3'].map(apt => ({ id: apt, data: { period: '2026-10', kind: 'charge', amount: 400, amountKop: 40000, source: 'charges', parts: [{ component: 'main', amountKop: 40000 }] } }));
    await db.doc('charges_runs/2026-10/plan/main').set({ rows });
    await db.doc('charges_runs/2026-10').update({ status: 'writing' });
    await db.doc('apartments/3/ledger/charge-2026-10').delete();
    let ctx = await journal.actions.context({ period: '2026-10' });
    assert.ok(ctx.checks.some(c => c.level === 'block' && /перервано посередині/.test(c.text)));
    await assert.rejects(charges.actions.setOpening(...A, { rows: [{ apt: '1', amountKop: -1 }] }), /Спершу завершіть перервану операцію/);
    assert.deepEqual((await charges.actions.context()).unfinished, [{ kind: 'run', period: '2026-10' }]);

    const r = await charges.actions.resume(...A);
    assert.equal(r.resumed, 1);
    assert.equal((await db.doc('apartments/3/ledger/charge-2026-10').get()).data().amountKop, 40000);
    run = (await db.doc('charges_runs/2026-10').get()).data();
    assert.equal(run.status, 'complete');
    ctx = await journal.actions.context({ period: '2026-10' });
    assert.ok(!ctx.checks.some(c => /перервано посередині/.test(c.text)));

    // Перерване внесення вхідних залишків — теж видно й дописується.
    await db.doc('charges/opening_plan').set({ by: '900', summary: { count: 1, debtKop: -5000, overpaidKop: 0 }, rows: [{ id: '1', kop: -5000 }, { id: '2', kop: 0 }, { id: '3', kop: 0 }] });
    ctx = await journal.actions.context({ period: '2026-10' });
    assert.ok(ctx.checks.some(c => /вхідних залишків квартир перервано/.test(c.text)));
    await charges.actions.resume(...A);
    assert.equal((await db.doc('apartments/1/ledger/opening').get()).data().amountKop, -5000);
    assert.equal((await db.doc('charges/opening_plan').get()).exists, false);
});

test('невизначений платіж: голова фіксує результат перевірки в Приват24', async () => {
    const base = { kind: 'salary', amountKop: 50000, purpose: 'Зарплата', recipient: { name: 'Працівник Тестовий', iban: 'UA273052990000026001234567800', code: '' } };
    await db.doc('payroll_runs/2026-10').set({ status: 'approved', stages: { final: { complete: true, completed: { 'final:e1': 'p1' }, plan: [] } } });
    await db.doc('payments/p1').set({ ...base, status: 'unknown', createdAt: Timestamp.now(), payroll: { period: '2026-10', stage: 'final', key: 'e1' } });
    await assert.rejects(payments.actions.resolve(...A, { id: 'p1', outcome: 'not_created', reason: 'немає у Приват24' }), /голова/);
    await assert.rejects(payments.actions.resolve(...C, { id: 'p1', outcome: 'not_created', reason: 'ні' }), /Опишіть/);
    await payments.actions.resolve(...C, { id: 'p1', outcome: 'not_created', reason: 'перевірила 14.11 — у Приват24 немає' });
    const p = (await db.doc('payments/p1').get()).data();
    assert.equal(p.status, 'failed');
    const stage = (await db.doc('payroll_runs/2026-10').get()).data().stages.final;
    assert.deepEqual([stage.complete, stage.completed], [false, {}]);
    await assert.rejects(payments.actions.resolve(...C, { id: 'p1', outcome: 'created', reason: 'ще раз перевірила' }), /вже відомий/);

    // Свіжий «відправляється» — ще рано; завислий понад 10 хв — можна; знайдений у банку стає «чекає підпису».
    await db.doc('payments/p2').set({ ...base, status: 'sending', createdAt: Timestamp.now() });
    await assert.rejects(payments.actions.resolve(...C, { id: 'p2', outcome: 'created', reason: 'є у Приват24' }), /10 хвилин/);
    await db.doc('payments/p2').update({ createdAt: Timestamp.fromMillis(Date.now() - 11 * 60 * 1000) });
    await payments.actions.resolve(...C, { id: 'p2', outcome: 'created', reason: 'є у Приват24, № 123', bankRef: '123' });
    assert.deepEqual([(await db.doc('payments/p2').get()).data().status, (await db.doc('payments/p2').get()).data().bankRef], ['sent', '123']);
});

test('відомість з відпусткою: середньоденна з попередньої відомості, відпускні — з авансом', async () => {
    await db.doc('payroll_people/e1').set({ name: 'Працівник Тестовий', kind: 'employee', salaryKop: 864700, fte: 1, mainJob: true, from: '2026-01-01', active: true,
        rnokpp: '3124567809', iban: 'UA273052990000026001234567800', taxNotified: true, insuranceYears: 10,
        priorEarnings: { '2026-08': { kop: 864700, days: 31 } } });
    // Вересень — затверджена відомість застосунку.
    await db.doc('payroll_runs/2026-09').set({ status: 'approved', run: { rows: [{ personId: 'e1', kind: 'employee', grossKop: 864700, regularKop: 864700, calendarDays: 30 }] } });
    await assert.rejects(payroll.actions.saveRun(...A, { period: '2026-10', inputs: { e1: { absences: [{ type: 'vacation', from: '2026-10-28', to: '2026-11-03' }] } } }), /кожну відомість/);
    await payroll.actions.saveRun(...A, { period: '2026-10', inputs: { e1: { absences: [{ type: 'vacation', from: '2026-10-19', to: '2026-10-25' }] } } });
    const row = (await payroll.actions.context({ period: '2026-10' })).run.rows[0];
    const avg = Math.round(864700 * 2 / 61);
    assert.deepEqual([row.vacationKop, row.vacationDays, row.workedDays], [avg * 7, 7, 17]);
    assert.equal(row.advance.grossKop, Math.round(row.regularKop / 2) + row.vacationKop);
});
