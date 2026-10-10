// Звітність на емуляторі Firestore: дані розрахунку з затвердженої
// відомості, позначки «подано / прийнято», ЄСВ за платежами, перевірки.
import test, { after, afterEach, before } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(new URL('../../functions/package.json', import.meta.url));
const { initializeApp, deleteApp } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const payroll = require('./payroll-core.js');

let app, db, reports;
before(() => {
    app = initializeApp({ projectId: 'uspih-25-rules-test' }, 'reports-server-test');
    db = getFirestore(app);
    reports = require('./reports.js')({ db, FieldValue, requireAdmin: async () => '900', staffRole: async () => 'accountant' });
});
const wipe = async () => {
    for (const name of ['reports', 'payroll_people', 'payroll_runs', 'payments', 'audit_log', 'osbb_settings']) {
        const snap = await db.collection(name).get();
        await Promise.all(snap.docs.map(d => db.recursiveDelete(d.ref)));
    }
};
afterEach(wipe);
after(async () => { await wipe(); await deleteApp(app); });

const a = () => reports.actions;
const A = ['900', 'accountant'];
const C = ['10', 'chair'];

test('розрахунок за жовтень: суми за людьми, сплачене за платежами, ЄСВ «сплачено» само', async () => {
    const person = { name: 'Працівник Тестовий', kind: 'employee', salaryKop: 864700, fte: 1, mainJob: true, rnokpp: '3124567809',
        iban: 'UA213052990000026001234567891', taxNotified: true, from: '2026-01-01', active: true };
    await db.doc('payroll_people/e1').set(person);
    await db.doc('osbb_settings/finance').set({ edrpou: '40562894' });
    const run = payroll.buildRun({ people: [{ id: 'e1', ...person }], period: '2026-10' });
    await db.doc('payroll_runs/2026-10').set({ period: '2026-10', status: 'approved', run: JSON.parse(JSON.stringify(run)) });
    for (const [key, status] of [['e1', 'paid'], ['pdfo', 'paid'], ['vz', 'paid'], ['esv', 'paid']]) {
        await db.collection('payments').add({ status, amountKop: 1, payroll: { period: '2026-10', stage: 'final', key } });
    }
    const d = await a().payrollData({ period: '2026-10' });
    assert.equal(d.key, 'j0500111-2026-10');
    assert.equal(d.edrpou, '40562894');
    assert.deepEqual([d.summary.grossKop, d.summary.pdfoKop, d.summary.pdfoPaidKop, d.summary.esvKop, d.summary.esvPaidKop], [864700, 155646, 155646, 190234, 190234]);
    assert.deepEqual(d.income.map(r => [r.rnokpp, r.sign]), [['3124567809', '101']]);
    assert.deepEqual(d.checks, []);

    const ctx = await a().context();
    assert.equal(ctx.start, '2026-10');
    assert.equal(ctx.hasPeople, true);
    assert.deepEqual(ctx.payrollMonths.map(m => [m.period, m.status, m.grossKop]), [['2026-10', 'approved', 864700]]);
    assert.equal(ctx.statuses['esv-2026-10'].status, 'paid');
    assert.equal(ctx.statuses['esv-2026-10'].auto, true);
});

test('позначки: подано, прийнято з квитанцією, перевірки й зняття', async () => {
    const key = 'j0500111-2026-10';
    await assert.rejects(a().mark(...A, { key: '../x', status: 'submitted' }), /Невідомий звіт/);
    await assert.rejects(a().mark(...A, { key: 'j0500111-2026-9', status: 'submitted' }), /сервіс бухгалтера/);
    await assert.rejects(a().mark(...A, { key, status: 'paid' }), /лише для платежів/);
    await assert.rejects(a().mark(...A, { key, status: 'submitted', date: '2999-01-01' }), /не пізніше/);
    await assert.rejects(a().mark(...A, { key, status: 'submitted', files: [{ name: 'x', path: 'reports/npo-2026/x.pdf' }] }), /теці цього звіту/);
    await assert.rejects(a().mark(...A, { key, status: 'accepted' }), /квитанцію № 2/);

    await a().mark(...A, { key, status: 'submitted', date: '2026-10-10', files: [{ name: 'kv1.pdf', path: `reports/${key}/1_kv1.pdf`, kind: 'receipt1' }] });
    await a().mark(...A, { key, status: 'accepted', date: '2026-10-10', regNumber: '9123456789',
        files: [{ name: 'kv1.pdf', path: `reports/${key}/1_kv1.pdf`, kind: 'receipt1' }, { name: 'kv2.pdf', path: `reports/${key}/2_kv2.pdf`, kind: 'receipt2' }] });
    const saved = (await a().context()).statuses[key];
    assert.deepEqual([saved.status, saved.regNumber, saved.files.map(f => f.kind)], ['accepted', '9123456789', ['receipt1', 'receipt2']]);

    // Прийнятий звіт розпозначає лише голова; журнал дій — з обох змін.
    await assert.rejects(a().mark(...A, { key, status: 'open' }), /лише голова/);
    await a().mark(...C, { key, status: 'open' });
    assert.equal((await db.doc(`reports/${key}`).get()).exists, false);
    const log = (await db.collection('audit_log').get()).docs.map(x => x.data().action).sort();
    assert.deepEqual(log, ['reports.mark', 'reports.mark', 'reports.reopen']);
});
