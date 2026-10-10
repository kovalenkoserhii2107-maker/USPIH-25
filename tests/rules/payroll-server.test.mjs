// Зарплата на емуляторі Firestore: картки, відомість, затвердження
// головою, платежі авансу й остаточного розрахунку, закритий місяць.
// Банк замінено заглушкою: платежі лише записуються.
import test, { after, afterEach, before } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(new URL('../../functions/package.json', import.meta.url));
const { initializeApp, deleteApp } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const payrollFunctions = require('./payroll.js');
const periodLock = require('./period-lock.js');

const testIban = bban => `UA${String(98 - Number(BigInt(bban + '301000') % 97n)).padStart(2, '0')}${bban}`;
const OWN = 'UA223052990000026001234567890';
let app, db, payroll, sent = [];
before(() => {
    app = initializeApp({ projectId: 'uspih-25-rules-test' }, 'payroll-server-test');
    db = getFirestore(app);
    const payments = { actions: { create: async (actor, role, p) => { sent.push(p); return { id: `pay${sent.length}` }; } } };
    payroll = payrollFunctions({ db, FieldValue, requireAdmin: async () => '900', staffRole: async () => 'accountant', payments, lock: periodLock(db) });
});
const wipe = async () => {
    sent = [];
    for (const name of ['payroll_people', 'payroll_runs', 'payroll_settings', 'audit_log', 'bank', 'osbb_settings', 'journal_periods']) {
        const snap = await db.collection(name).get();
        await Promise.all(snap.docs.map(d => db.recursiveDelete(d.ref)));
    }
};
afterEach(wipe);
after(async () => { await wipe(); await deleteApp(app); });

const A = ['900', 'accountant'];
const C = ['10', 'chair'];
const a = () => payroll.actions;

test('відомість: працівник і ЦПД, затвердження головою, аванс і остаточний розрахунок', async () => {
    await assert.rejects(a().savePerson(...A, { name: 'Іван', kind: 'employee', salaryKop: 864700 }), /повністю/);
    const { id: e } = await a().savePerson(...A, { name: 'Працівник Тестовий', kind: 'employee', position: 'двірник', salaryKop: 864700, fte: 1,
        rnokpp: '3124567809', iban: 'UA923052990000026001234567891', taxNotified: true, from: '2026-01-01' });
    const { id: g } = await a().savePerson(...A, { name: 'Виконавець Тестовий', kind: 'gph', rnokpp: '3124567809', iban: 'UA653052990000026001234567892', contract: '№ 5 від 01.10.2026' });
    // Журнал дій — без прізвищ і сум окладу.
    assert.ok(!JSON.stringify((await db.collection('audit_log').get()).docs.map(d => d.data())).includes('Тестовий'));

    await a().saveRun(...A, { period: '2026-10', inputs: { [g]: { actKop: 800000 } } });
    let ctx = await a().context({ period: '2026-10' });
    assert.equal(ctx.status, 'draft');
    assert.deepEqual([ctx.run.totals.grossKop, ctx.run.totals.esvKop], [1664700, 190234 + 176000]);
    await assert.rejects(a().pay(...A, { period: '2026-10', stage: 'advance' }), /затвердити/);
    await assert.rejects(a().approve(...A, { period: '2026-10' }), /голова/);
    await a().approve(...C, { period: '2026-10' });

    // Без коду ОСББ, рахунку й рахунків податків платежів немає.
    await assert.rejects(a().pay(...A, { period: '2026-10', stage: 'advance' }), /ЄДРПОУ/);
    await db.doc('osbb_settings/finance').set({ edrpou: '40562894' });
    await assert.rejects(a().pay(...A, { period: '2026-10', stage: 'advance' }), /Підключіть банк/);
    await db.doc('bank/settings').set({ accounts: { [OWN]: { purpose: 'current' } } });
    await assert.rejects(a().pay(...A, { period: '2026-10', stage: 'advance' }), /PDFO/);
    const tax = n => ({ name: 'ГУК в Од. обл.', iban: testIban(`305299000002600123456789${n}`), code: '37607526' });
    await a().saveSettings(...A, { advancePct: 50, taxes: { pdfo: tax(3), vz: tax(4), esv: tax(5) } });

    await a().pay(...A, { period: '2026-10', stage: 'advance' });
    assert.deepEqual(sent.map(p => [p.payroll.key, p.amountKop]), [['e1'.replace('e1', e), 332909], ['pdfo', 77823], ['vz', 21618], ['esv', 95117]]);
    assert.ok(sent.every(p => p.account === OWN && p.proposalKey.startsWith('payroll:2026-10:advance:')));
    await assert.rejects(a().pay(...A, { period: '2026-10', stage: 'advance' }), /уже відправлено/);

    // Табель змінено після авансу: знову чекає голову, аванс не перераховується.
    await a().saveRun(...A, { period: '2026-10', inputs: { [g]: { actKop: 800000 }, [e]: { workedDays: 20 } } });
    ctx = await a().context({ period: '2026-10' });
    assert.equal(ctx.status, 'draft');
    const row = ctx.run.rows.find(r => r.personId === e);
    assert.equal(row.advance.netKop, 332909);
    assert.equal(row.grossKop, Math.round(864700 * 20 / 22));
    await a().approve(...C, { period: '2026-10' });
    sent = [];
    await a().pay(...A, { period: '2026-10', stage: 'final' });
    assert.deepEqual(sent.map(p => p.payroll.key), [e, g, 'pdfo', 'vz', 'esv']);
    assert.equal(sent.find(p => p.payroll.key === e).amountKop, row.netKop - 332909);
    assert.match(sent.find(p => p.payroll.key === 'esv').purpose, /^\*;101;40562894;ЄСВ за жовтень 2026;;;$/);
    await assert.rejects(a().saveRun(...A, { period: '2026-10', inputs: {} }), /не змінюється/);
});

test('закритий місяць: відомість не змінюється', async () => {
    await a().savePerson(...A, { name: 'Працівник Тестовий', kind: 'employee', salaryKop: 864700, fte: 1 });
    await db.doc('journal_periods/2026-10').set({ status: 'closed' });
    await assert.rejects(a().saveRun(...A, { period: '2026-10', inputs: {} }), /закрито/);
});

test('зарплата без авансу: остаточний розрахунок платить усе, аванс після нього — ні', async () => {
    await db.doc('osbb_settings/finance').set({ edrpou: '40562894' });
    await db.doc('bank/settings').set({ accounts: { [OWN]: { purpose: 'current' } } });
    const tax = n => ({ name: 'ГУК', iban: testIban(`305299000002600123456789${n}`), code: '37607526' });
    await a().saveSettings(...A, { advancePct: 50, taxes: { pdfo: tax(3), vz: tax(4), esv: tax(5) } });
    const { id } = await a().savePerson(...A, { name: 'Працівник Тестовий', kind: 'employee', salaryKop: 864700, fte: 1, iban: 'UA923052990000026001234567891', rnokpp: '3124567809', taxNotified: true });
    await a().saveRun(...A, { period: '2026-10', inputs: {} });
    await a().approve(...C, { period: '2026-10' });
    await a().pay(...A, { period: '2026-10', stage: 'final' });
    assert.deepEqual(sent.map(p => [p.payroll.key, p.amountKop]), [[id, 665819], ['pdfo', 155646], ['vz', 43235], ['esv', 190234]]);
    await assert.rejects(a().pay(...A, { period: '2026-10', stage: 'advance' }), /повністю/);
});
