import test, { before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(new URL('../../functions/package.json', import.meta.url));
const { initializeApp, deleteApp } = require('firebase-admin/app');
const { getFirestore, FieldValue, Timestamp } = require('firebase-admin/firestore');
const core = require('./payroll-core');
const privat = require('./privat');
const OWN = 'UA213052990000026001234567890';
const OLD = 'UA273052990000026001234567800';
const NEW = 'UA973052990000026001234567801';
const A = ['900', 'accountant'], C = ['10', 'chair'];
let app, db, reports, bank, charges, expenses, journal, payments, payroll, createPayment;
before(() => {
    app = initializeApp({ projectId: 'uspih-25-rules-test' }, 'reporting-audit-server-test');
    db = getFirestore(app);
    const deps = { db, FieldValue, Timestamp, requireAdmin: async () => '900', staffRole: async () => 'accountant', notify: async () => {} };
    const lock = require('./period-lock')(db);
    charges = require('./charges')( { ...deps, lock });
    payments = require('./payments')(deps);
    expenses = require('./expenses')({ ...deps, payments, lock });
    bank = require('./bank')({ ...deps, balances: charges, expenses, lock });
    reports = require('./reports')(deps);
    journal = require('./journal')({ ...deps, lock, now: () => new Date('2026-12-15T10:00:00Z') });
    payroll = require('./payroll')({ ...deps, payments, lock });
    createPayment = privat.createPayment;
});
async function wipe() {
    privat.createPayment = createPayment;
    for (const name of ['apartments', 'charges', 'charges_runs', 'bank', 'bank_secrets', 'bank_tx', 'payments', 'expenses', 'suppliers', 'contracts', 'expense_settings',
        'payroll_people', 'payroll_runs', 'payroll_settings', 'reports', 'report_settings', 'osbb_settings', 'audit_log', 'journal_opening', 'journal_periods']) {
        // One throttled writer per collection instead of 6,000 simultaneous deletes.
        await db.recursiveDelete(db.collection(name));
    }
}
afterEach(wipe);
after(async () => { await wipe(); await deleteApp(app); });
const at = day => Timestamp.fromDate(new Date(`${day}T10:00:00Z`));
const person = (extra = {}) => ({ id: 'e1', name: 'Працівник Тестовий', kind: 'employee', salaryKop: 864700, fte: 1, mainJob: true,
    from: '2026-01-01', rnokpp: '3124567809', iban: OLD, gender: 'Ч', taxNotified: true, active: true, ...extra });
async function seedReport(p = person()) {
    await db.doc('payroll_people/e1').set(p);
    const run = core.buildRun({ people: [p], period: '2026-10', inputs: p.kind === 'gph' ? { e1: { actKop: 864700 } } : {} });
    await db.doc('payroll_runs/2026-10').set({ status: 'approved', run });
    await db.doc('osbb_settings/finance').set({ edrpou: '40562894', registry: { legalName: 'ОСББ «ТЕСТ»', kved: '81.10' } });
    await reports.actions.saveXmlSettings(...A, { sti: 1553, katottg: 'UA51100270010069184', zip: '65101', address: 'м. Одеса, вул. Тестова, 1', headName: 'Голова Тестовий', headTin: '3124567809' });
    return run;
}
async function paid(id, key, amountKop, day, extra = {}) {
    const txId = `tx-${id}`;
    await db.doc(`payments/${id}`).set({ kind: ['pdfo', 'vz', 'esv'].includes(key) ? 'tax' : 'salary', status: 'paid', amountKop, txId,
        payroll: { period: '2026-10', stage: 'final', key }, ...extra });
    await db.doc(`bank_tx/${txId}`).set({ account: OWN, direction: 'out', kind: 'expense', status: 'done', amountKop, paymentId: id,
        period: day.slice(0, 7), at: at(day), category: key === 'esv' ? 'esv' : key === 'e1' ? 'salary' : 'taxes' });
}
async function fullPay(run, day) {
    for (const [key, amountKop] of Object.entries({ e1: run.totals.netKop, pdfo: run.totals.pdfoKop, vz: run.totals.vzKop, esv: run.totals.esvKop })) await paid(key, key, amountKop, day);
}
const tx = (id, amountKop, direction = 'out', day = '2026-10-20', extra = {}) => db.doc(`bank_tx/${id}`).set({ account: OWN, period: day.slice(0, 7), at: at(day), direction,
    kind: direction === 'out' ? 'expense' : 'payment', status: 'review', amountKop, counterparty: { name: 'Тестовий отримувач', account: NEW }, ...extra });

test('4ДФ/Д1/XML: проведена випискою зарплата й податки; пошкоджене підтвердження не експортується', async () => {
    const run = await seedReport();
    await fullPay(run, '2026-10-30');
    let d = await reports.actions.payrollData({ period: '2026-10' });
    assert.deepEqual(d.checks, []);
    assert.deepEqual([d.summary.paidKop, d.summary.esvPaidKop], [864700, 190234]);
    let xml = await reports.actions.xml(...A, { period: '2026-10' });
    assert.equal(xml.files.length, 3);
    await db.doc('bank_tx/tx-e1').update({ amountKop: run.totals.netKop - 1 });
    xml = await reports.actions.xml(...A, { period: '2026-10' });
    assert.equal(xml.files.length, 0);
    assert.ok(xml.problems.some(p => /виписко|виписк/.test(p)));
});

test('4ДФ: своєчасна зарплата — за нарахуванням; прострочена й ЦПД — за фактичним періодом', async () => {
    const run = await seedReport();
    await fullPay(run, '2026-11-06');
    let d = await reports.actions.payrollData({ period: '2026-10' });
    assert.equal(d.summary.paidKop, 864700);
    assert.deepEqual(d.checks, []);
    await db.doc('bank_tx/tx-e1').update({ at: at('2026-11-12') });
    d = await reports.actions.payrollData({ period: '2026-10' });
    assert.equal(d.summary.paidKop, 0);
    assert.ok(!d.checks.some(c => c.level === 'block'), JSON.stringify(d.checks));
    assert.equal((await reports.actions.payrollData({ period: '2026-11' })).summary.paidKop, 864700);
    await wipe();
    const gph = await seedReport(person({ kind: 'gph', from: '2026-10-01', to: '2026-10-31', contract: 'ЦПД № 1' }));
    await fullPay(gph, '2026-11-06');
    d = await reports.actions.payrollData({ period: '2026-10' });
    assert.equal(d.summary.paidKop, 0);
    assert.ok(!d.checks.some(c => c.level === 'block'), JSON.stringify(d.checks));
    assert.equal((await reports.actions.payrollData({ period: '2026-11' })).summary.paidKop, gph.totals.grossKop);
});

test('4ДФ: пізня остаточна зарплата враховує аванс старого місяця без окремо збереженої стадії', async () => {
    const run = await seedReport();
    const advance = { rows: run.rows.map(r => r.advance), totals: run.totals.advance };
    const final = { rows: run.rows.map(r => r.final), totals: run.totals.final };
    for (const [stage, part, day] of [['advance', advance, '2026-10-22'], ['final', final, '2026-11-12']]) {
        for (const [key, amount] of [['e1', part.rows[0].netKop], ['pdfo', part.totals.pdfoKop], ['vz', part.totals.vzKop], ['esv', part.totals.esvKop]]) {
            if (amount) await paid(`${stage}-${key}`, key, amount, day, { payroll: { period: '2026-10', stage, key } });
        }
    }
    await db.doc('payroll_runs/2026-11').set({ status: 'approved', run: core.buildRun({ people: [], period: '2026-11' }) });
    const oct = await reports.actions.payrollData({ period: '2026-10' });
    const nov = await reports.actions.payrollData({ period: '2026-11' });
    assert.ok(!nov.checks.some(c => c.level === 'block'), JSON.stringify(nov.checks));
    assert.equal(oct.summary.paidKop + nov.summary.paidKop, run.totals.grossKop);
    assert.equal(nov.summary.paidKop, final.rows[0].grossKop);
    assert.equal(nov.summary.pdfoPaidKop, final.totals.pdfoKop);
});

test('банк: однакові платежі залишаються на розборі, обраний платіж проводиться рівно один раз', async () => {
    await db.doc('bank/settings').set({ startDate: '2026-10-01', accounts: { [OWN]: { purpose: 'current' } } });
    for (const id of ['same-1', 'same-2']) await db.doc(`payments/${id}`).set({ kind: 'salary', status: 'sent', amountKop: 10000,
        account: OWN, recipient: { name: 'Тестовий працівник', iban: OLD }, sentAt: at('2026-10-19'),
        payroll: { period: '2026-10', stage: 'final', key: id } });
    await bank.storeTransactions([{ bankId: 'equal', account: OWN, at: new Date('2026-10-20T10:00:00Z'), direction: 'out', amountKop: 10000,
        currency: 'UAH', purpose: 'Виплата зарплати', counterparty: { name: 'Працівник', account: OLD } }], 'audit', await bank.loadContext());
    const [row] = (await db.collection('bank_tx').get()).docs;
    assert.equal(row.data().status, 'review');
    assert.equal(row.data().reason, 'ambiguous-payment');
    assert.deepEqual(row.data().paymentSuggestions.sort(), ['same-1', 'same-2']);
    const attempts = await Promise.allSettled(['same-1', 'same-2'].map(paymentId => bank.actions.matchPayment(...A, { txId: row.id, paymentId })));
    assert.equal(attempts.filter(r => r.status === 'fulfilled').length, 1);
    const saved = (await row.ref.get()).data();
    assert.equal(saved.status, 'done');
    assert.equal(saved.category, 'salary');
    const p = (await db.doc(`payments/${saved.paymentId}`).get()).data();
    assert.equal(p.status, 'paid');
    assert.equal(p.txId, row.id);
    assert.equal((await db.doc(`payments/${saved.paymentId === 'same-1' ? 'same-2' : 'same-1'}`).get()).data().status, 'sent');
    await assert.rejects(bank.actions.matchPayment(...A, { txId: row.id, paymentId: saved.paymentId }), /розібран|проведен/);
});

test('4ДФ ФОП: рахунок і акт — один дохід; оплата — за місяцем банку; відсутність податкової перевірки блокує XML', async () => {
    await seedReport();
    const { id: sid } = await expenses.actions.saveSupplier(...A, { name: 'ФОП Тестовий', kind: 'fop', code: '3124567809', iban: NEW, fopChecked: true });
    const base = { supplierId: sid, period: '2026-10', item: 'cleaning', description: 'Прибирання будинку', files: [], amountKop: 100000 };
    const { id: inv } = await expenses.actions.saveExpense(...C, { ...base, docType: 'invoice', number: 'F-1', date: '2026-10-02' });
    await expenses.actions.saveExpense(...A, { ...base, docType: 'act', number: 'A-1', date: '2026-10-30', linkedTo: inv });
    await tx('fp', 100000, 'out', '2026-11-02', { counterparty: { name: 'ФОП Тестовий', account: NEW, code: '3124567809' } });
    await expenses.actions.linkTx(...A, { txId: 'fp', expenseId: inv });
    const october = await reports.actions.payrollData({ period: '2026-10' });
    assert.deepEqual(october.income.filter(r => r.kind === 'fop').map(r => [r.sign, r.grossKop, r.paidKop]), [['157', 100000, 0]]);
    const november = await reports.actions.payrollData({ period: '2026-11' });
    assert.deepEqual(november.income.filter(r => r.kind === 'fop').map(r => [r.grossKop, r.paidKop]), [[0, 100000]]);
    let xml = await reports.actions.xml(...A, { period: '2026-10' });
    assert.equal(xml.files.length, 3);
    assert.match(Buffer.from(xml.files[2].data, 'base64').toString('latin1'), /<T1RXXXXG05 ROWNUM="2">157<\/T1RXXXXG05>/);
    await db.doc(`expenses/${inv}`).update({ 'supplierSnapshot.fopChecked': false });
    await db.doc(`suppliers/${sid}`).update({ fopChecked: false });
    xml = await reports.actions.xml(...A, { period: '2026-10' });
    assert.equal(xml.files.length, 0);
    assert.ok(xml.problems.some(p => /ознаки 157/.test(p)));
});

test('квитанції: паралельні вкладки не втрачають файли; зняття позначки залишає повний архів у журналі', async () => {
    const key = 'j0500111-2026-10';
    const file = n => ({ name: `${n}.pdf`, path: `reports/${key}/${n}.pdf`, kind: n === 'kv2' ? 'receipt2' : 'receipt1' });
    await Promise.all(['kv1', 'kv2'].map(n => reports.actions.mark(...A, { key, status: 'submitted', files: [file(n)] })));
    const saved = (await db.doc(`reports/${key}`).get()).data();
    assert.deepEqual(saved.files.map(f => f.name).sort(), ['kv1.pdf', 'kv2.pdf']);
    await reports.actions.mark(...A, { key, status: 'accepted', files: [] });
    await assert.rejects(reports.actions.mark(...A, { key, status: 'rejected' }), /лише голова/);
    await reports.actions.mark(...C, { key, status: 'open' });
    const logs = (await db.collection('audit_log').where('action', '==', 'reports.reopen').get()).docs;
    assert.equal(logs[0].data().details.before.files.length, 2);
    await assert.rejects(reports.actions.mark(...A, { key: 'esv-2026-10', status: 'accepted', regNumber: '123' }), /виду/);
});

test('повернення переплати: історія важливіша за застарілий баланс; два одночасні повернення резервують залишок', async () => {
    await db.doc('apartments/5').set({ area: 50, balance: 999 });
    await db.doc('charges/settings').set({ opening: { set: true } });
    await db.doc('apartments/5/ledger/opening').set({ kind: 'opening', period: '2026-09', amountKop: 50000, at: at('2026-09-30') });
    await tx('excess', 60000);
    await assert.rejects(bank.actions.refundResident(...A, { txId: 'excess', apt: '5' }), /більше не можна/);
    await tx('r1', 30000); await tx('r2', 30000);
    const result = await Promise.allSettled(['r1', 'r2'].map(txId => bank.actions.refundResident(...A, { txId, apt: '5' })));
    assert.equal(result.filter(r => r.status === 'fulfilled').length, 1);
    assert.equal((await db.doc('apartments/5').get()).data().balance, 200);
    assert.equal((await db.collection('apartments/5/ledger').where('kind', '==', 'refund').get()).size, 1);
});

test('банк повернув переплату співвласнику: баланс, 377 і звіт про внески відновлюються; зняття повернення — теж', async () => {
    await db.doc('apartments/5').set({ area: 50, balance: 500 });
    await db.doc('charges/settings').set({ opening: { set: true } });
    await db.doc('apartments/5/ledger/opening').set({ kind: 'opening', period: '2026-09', amountKop: 50000, at: at('2026-09-30') });
    await tx('out', 30000);
    await bank.actions.refundResident(...A, { txId: 'out', apt: '5' });
    await tx('back', 30000, 'in');
    await bank.actions.refund(...A, { txId: 'back', refundOf: 'out', reason: 'bounce' });
    assert.equal((await db.doc('apartments/5').get()).data().balance, 500);
    assert.equal((await db.doc('apartments/5/ledger/payment-back').get()).data().amountKop, 30000);
    const context = await journal.actions.context({ period: '2026-10' });
    const ledger = context.tb.rows.find(r => r.acc === '377').byA.find(r => r.a === '5');
    assert.equal(ledger.closeCr, 50000);
    assert.ok(!context.checks.some(c => c.level === 'block' && /Повернення|Оплата back|Оплата 2026/.test(c.text)), JSON.stringify(context.checks));
    const budgetCore = require('./budget-core');
    const bankTx = (await db.collection('bank_tx').get()).docs.map(d => ({ id: d.id, ...d.data() }));
    assert.equal(budgetCore.incomeFact({ bankIn: bankTx, year: '2026' }).get('contributions'), 0);
    await bank.actions.unassign(...A, { txId: 'back' });
    assert.equal((await db.doc('apartments/5').get()).data().balance, 200);
    await bank.actions.unassign(...A, { txId: 'out' });
    assert.equal((await db.doc('apartments/5').get()).data().balance, 500);
});

test('сторно і повернення постачальника: оплата документа — за мінусом повернення, борг і переплата не вигадуються', async () => {
    const { id: sid } = await expenses.actions.saveSupplier(...A, { name: 'ТОВ Тестовий', kind: 'company', code: '14360570', iban: NEW });
    const { id } = await expenses.actions.saveExpense(...C, { supplierId: sid, period: '2026-10', item: 'repair', description: 'Ремонт дверей', files: [],
        docType: 'act', number: '9', date: '2026-10-10', amountKop: 100000 });
    await tx('sout', 100000);
    await expenses.actions.linkTx(...A, { txId: 'sout', expenseId: id });
    await expenses.actions.storno(...A, { id, amountKop: 30000, date: '2026-11-01', number: 'S-1', reason: 'Зменшення вартості робіт' });
    await tx('sback', 30000, 'in', '2026-11-02');
    await bank.actions.refund(...A, { txId: 'sback', refundOf: 'sout', reason: 'supplier' });
    const e = (await db.doc(`expenses/${id}`).get()).data();
    assert.deepEqual([e.paidKop, e.stornoKop, e.status, require('./expenses-core').remaining(e)], [70000, 30000, 'paid', 0]);
    for (const period of ['2026-10', '2026-11']) {
        const ctx = await journal.actions.context({ period });
        assert.ok(!ctx.checks.some(c => c.level === 'block' && /повернен|Повернення|Документ витрат|Списання sout/.test(c.text)), JSON.stringify(ctx.checks));
    }
});

test('повтор зарплати: транзакція резервує оригінал до виклику банку, паралельний запит не створює другу виплату', async () => {
    await db.doc('bank/settings').set({ accounts: { [OWN]: { purpose: 'current' } } });
    await db.doc('bank_secrets/privat').set({ token: 'local-test-token' });
    const base = { kind: 'salary', amountKop: 50000, purpose: 'Зарплата за жовтень 2026, без ПДВ', account: OWN, recipient: { name: 'Працівник Тестовий', iban: OLD, code: '3124567809' },
        status: 'paid', returnedKop: 50000, payroll: { period: '2026-10', stage: 'final', key: 'e1' } };
    await db.doc('payments/old').set(base);
    let sends = 0;
    privat.createPayment = async () => { sends++; return { bankRef: 'test' }; };
    const data = { ...base, recipient: { ...base.recipient, iban: NEW }, payroll: { ...base.payroll, repayOf: 'old', retry: 1 } };
    const result = await Promise.allSettled(['a', 'b'].map(key => payments.actions.create(...A, { ...data, proposalKey: `repay-${key}` })));
    assert.equal(result.filter(r => r.status === 'fulfilled').length, 1);
    assert.equal(sends, 1);
    assert.equal((await db.doc('payments/old').get()).data().repaidBy.length, 1);
});

test('журнал понад 6000 проводок: весь місяць доступний для CSV, суми списку відповідають оборотам', async () => {
    const count = 6011;
    for (let start = 0; start < count; start += 400) {
        const batch = db.batch();
        for (let i = start; i < Math.min(count, start + 400); i++) batch.set(db.doc(`bank_tx/fee-${String(i).padStart(5, '0')}`), {
            account: OWN, direction: 'out', kind: 'expense', category: 'bank_fee', status: 'done', period: '2026-10', at: at('2026-10-30'), amountKop: 1
        });
        await batch.commit();
    }
    const ctx = await journal.actions.context({ period: '2026-10' });
    const fees = ctx.entries.filter(e => e.src === 'bank');
    assert.equal(fees.length, count);
    assert.equal(fees.reduce((s, e) => s + e.kop, 0), count);
    assert.equal(ctx.entries.reduce((s, e) => s + e.kop, 0), ctx.tb.totals.dr);
});
