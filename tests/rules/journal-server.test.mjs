// Проводки й закриття місяця на емуляторі Firestore: оборотно-сальдова з
// реальних операцій, перевірки, закриття, блокування змін у закритому
// місяці й повторне відкриття головою.
import test, { after, afterEach, before } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(new URL('../../functions/package.json', import.meta.url));
const { initializeApp, deleteApp } = require('firebase-admin/app');
const { getFirestore, FieldValue, Timestamp } = require('firebase-admin/firestore');
const chargeFunctions = require('./charges.js');
const bankFunctions = require('./bank.js');
const journalFunctions = require('./journal.js');
const periodLock = require('./period-lock.js');

const OWN = 'UA213052990000026001234567890';
let app, db, charges, bank, journal, clock = new Date('2026-11-02T09:00:00Z');
before(() => {
    app = initializeApp({ projectId: 'uspih-25-rules-test' }, 'journal-server-test');
    db = getFirestore(app);
    const lock = periodLock(db);
    const deps = { db, FieldValue, Timestamp, requireAdmin: async () => '900', staffRole: async () => 'accountant', lock };
    charges = chargeFunctions(deps);
    bank = bankFunctions({ ...deps, balances: charges });
    journal = journalFunctions({ ...deps, now: () => clock });
});
const wipe = async () => {
    for (const name of ['apartments', 'bank', 'bank_tx', 'bank_links', 'audit_log', 'charges', 'charges_runs', 'journal_periods', 'expenses', 'suppliers']) {
        const snap = await db.collection(name).get();
        await Promise.all(snap.docs.map(d => db.recursiveDelete(d.ref)));
    }
};
afterEach(wipe);
after(async () => { await wipe(); await deleteApp(app); });

const A = ['900', 'accountant'];
const C = ['10', 'chair'];

async function seed() {
    await db.doc('apartments/10').set({ area: 72.4, balance: 0, personalAccount: '1010' });
    await db.doc('apartments/45').set({ area: '64', balance: 0, personalAccount: '1045' });
    await db.doc('apartments/900').set({ isAdmin: true });
    await db.doc('bank/settings').set({ startDate: '2026-10-01', accounts: { [OWN]: { purpose: 'current' } } });
    await charges.actions.addTariff(...A, { group: 'res', rate: '4,57', from: '2026-10', decision: 'Протокол зборів № 3' });
    await charges.actions.setOpening(...A, { rows: [{ apt: '45', amountKop: -125040 }] });
    await charges.actions.run(...A, { period: '2026-10' });
    const at = d => new Date(`2026-10-${d}T09:00:00Z`);
    await bank.storeTransactions([
        { bankId: '1', account: OWN, at: at('08'), direction: 'in', amountKop: 40000, purpose: 'О/р 1045 за комунальні послуги', counterparty: { name: 'ПЛАТНИК', account: '', code: '' }, currency: 'UAH' },
        { bankId: '2', account: OWN, at: at('09'), direction: 'in', amountKop: 5000, purpose: 'Поповнення', counterparty: { name: 'НЕВІДОМИЙ', account: '', code: '' }, currency: 'UAH' },
        { bankId: '3', account: OWN, at: at('06'), direction: 'out', amountKop: 500, purpose: 'Комісія за платіж', counterparty: { name: 'АТ КБ ПРИВАТБАНК', account: '', code: '14360570' }, currency: 'UAH' }
    ], 'test', await bank.loadContext());
}

test('оборотно-сальдова з операцій, перевірки й закриття місяця', async () => {
    await seed();
    clock = new Date('2026-10-20T09:00:00Z');
    let ctx = await journal.actions.context({ period: '2026-10' });
    assert.equal(ctx.tb.balanced, true);
    assert.match(ctx.checks.filter(c => c.level === 'block').map(c => c.text).join(' | '), /ще не скінчився.*чекають рішення.*1/);
    assert.equal(ctx.tb.rows.find(r => r.acc === '685').closeCr, 5000);
    // 377 = баланси співвласників.
    assert.ok(ctx.checks.some(c => /377 збігається/.test(c.text)), JSON.stringify(ctx.checks));

    clock = new Date('2026-11-02T09:00:00Z');
    await assert.rejects(journal.actions.close(...A, { period: '2026-10' }), /чекають рішення/);
    const review = (await db.collection('bank_tx').where('status', '==', 'review').get()).docs[0];
    await bank.actions.assign(...A, { txId: review.id, allocations: [{ apt: '10', amountKop: 5000 }] });
    ctx = await journal.actions.context({});
    assert.equal(ctx.period, '2026-10');
    assert.equal(ctx.canClose, true, JSON.stringify(ctx.checks));
    const r377 = ctx.tb.rows.find(r => r.acc === '377');
    assert.equal(r377.byA.find(x => x.a === '45').closeDr, 125040 + 29248 - 40000);
    await journal.actions.close(...A, { period: '2026-10' });
    const stored = (await db.doc('journal_periods/2026-10').get()).data();
    assert.equal(stored.status, 'closed');
    assert.equal(stored.totals.dr, stored.totals.cr);

    // Закритий місяць не змінюється: ні нарахування, ні виписка, ні вхідні залишки.
    await assert.rejects(charges.actions.run(...A, { period: '2026-10' }), /закрито/);
    await assert.rejects(charges.actions.setOpening(...A, { rows: [{ apt: '45', amountKop: -1 }] }), /закритий місяць/);
    await assert.rejects(bank.actions.unassign(...A, { txId: review.id }), /закрито/);
    ctx = await journal.actions.context({ period: '2026-10' });
    assert.equal(ctx.status, 'closed');
    assert.match(ctx.checks[0].text, /не змінювались/);
    // Пізня виписка в закритий місяць — розбіжність видно.
    await db.doc('bank_tx/late').set({ account: OWN, period: '2026-10', at: new Date('2026-10-31T20:00:00Z'), direction: 'out', kind: 'expense', category: 'bank_fee', status: 'done', amountKop: 500 });
    assert.match((await journal.actions.context({ period: '2026-10' })).checks[0].text, /змінились операції/);

    // Відкрити знову — лише голова й з причиною.
    await assert.rejects(journal.actions.reopen(...A, { period: '2026-10', reason: 'Пізня комісія банку' }), /голова/);
    await assert.rejects(journal.actions.reopen(...C, { period: '2026-10', reason: '' }), /причину/);
    await journal.actions.reopen(...C, { period: '2026-10', reason: 'Пізня комісія банку' });
    await bank.actions.unassign(...A, { txId: review.id });
    const log = (await db.collection('audit_log').where('action', 'in', ['journal.close', 'journal.reopen']).get()).docs.map(d => d.data().action).sort();
    assert.deepEqual(log, ['journal.close', 'journal.reopen']);
});
