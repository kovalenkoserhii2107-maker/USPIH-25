import { completeClosingPrerequisites, clearAccounting } from './accounting-fixture.mjs';
// Сквозная сверка реальных серверных модулей. Подменён только внешний
// ответ ПриватБанка: реальных денег, токенов и подачи в ДПС здесь нет.
import test, { before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
import { initializeTestEnvironment, assertSucceeds, assertFails } from '@firebase/rules-unit-testing';
import { getDoc, getDocs, doc, collection } from 'firebase/firestore';
import { financeSummary } from '../../js/finance-core.js';
import { monthSteps } from '../../js/month-core.js';
import { payrollTotals, personState } from '../../js/payroll-view-core.js';

const require = createRequire(new URL('../../functions/package.json', import.meta.url));
const { initializeApp, deleteApp } = require('firebase-admin/app');
const { getFirestore, FieldValue, Timestamp } = require('firebase-admin/firestore');
const bankCore = require('./bank-core.js');
const privat = require('./privat.js');
const originalCreate = privat.createPayment;
const iban = n => { const bban = `305299000002600123456789${n}`; return `UA${String(98n - BigInt(`${bban}301000`) % 97n).padStart(2, '0')}${bban}`; };
const OWN = iban(0), RESERVE = iban(1), COMPANY = iban(2), FOP = iban(3), EMPLOYEE = iban(4), CONTRACTOR = iban(5), TAX = iban(6);
const A = ['900', 'accountant'], C = ['901', 'chair'], PERIOD = '2026-10';
const at = day => Timestamp.fromDate(new Date(`${day}T12:00:00Z`));
const names = ['apartments', 'staff', 'charges', 'charges_runs', 'bank', 'bank_tx', 'bank_links', 'bank_secrets', 'payments', 'suppliers',
    'contracts', 'expenses', 'expense_settings', 'budgets', 'finance', 'finance_ops', 'finance_settings', 'audit_log', 'journal_periods', 'journal_opening',
    'payroll_people', 'payroll_runs', 'payroll_settings', 'reports', 'report_settings', 'osbb_settings'];
let app, db, env, charges, bank, payments, expenses, budget, payroll, journal, reports, apiCalls;
async function wipe() {
    await clearAccounting(db);
    for (const name of names) await Promise.all((await db.collection(name).get()).docs.map(d => db.recursiveDelete(d.ref)));
    apiCalls = [];
}
before(async () => {
    app = initializeApp({ projectId: 'uspih-25-rules-test' }, 'accounting-full-cycle');
    db = getFirestore(app);
    env = await initializeTestEnvironment({ projectId: 'uspih-25-rules-test', firestore: { rules: readFileSync(new URL('../../firestore.rules', import.meta.url), 'utf8') } });
    const lock = require('./period-lock.js')(db);
    const deps = { db, FieldValue, Timestamp, requireAdmin: async () => '900', staffRole: async () => 'accountant', notify: async () => {}, lock };
    charges = require('./charges.js')(deps);
    payments = require('./payments.js')(deps);
    budget = require('./budget.js')(deps);
    expenses = require('./expenses.js')({ ...deps, payments, budget });
    bank = require('./bank.js')({ ...deps, balances: charges, expenses });
    payroll = require('./payroll.js')({ ...deps, payments });
    journal = require('./journal.js')({ ...deps, now: () => new Date('2026-11-01T12:00:00Z') });
    reports = require('./reports.js')(deps);
    privat.createPayment = async (token, payment) => {
        assert.equal(token, 'LOCAL-TEST-ONLY');
        apiCalls.push(payment);
        return { bankRef: `test-${payment.docNumber}`, paymentRef: `pack-${payment.docNumber}`, status: 'created' };
    };
    await wipe();
});
afterEach(wipe);
after(async () => { privat.createPayment = originalCreate; await env.cleanup(); await deleteApp(app); });

async function ingest(id, direction, amountKop, purpose, cp = {}, account = OWN, extra = {}) {
    const raw = { bankId: id, account, at: new Date('2026-10-30T12:00:00Z'), direction, amountKop, currency: 'UAH', purpose, counterparty: cp, ...extra };
    await bank.storeTransactions([raw], 'full-cycle-test', await bank.loadContext());
    return { id: bankCore.safeId(`${account}_${id}`), raw };
}
async function settle(id) {
    const p = (await db.doc(`payments/${id}`).get()).data();
    assert.equal(p.status, 'sent');
    const t = await ingest(`pay-${id}`, 'out', p.amountKop, p.purpose, { name: p.recipient.name, account: p.recipient.iban, code: p.recipient.code }, p.account, { dlr: p.bankRef });
    assert.deepEqual([(await db.doc(`payments/${id}`).get()).data().status, (await db.doc(`bank_tx/${t.id}`).get()).data().paymentId], ['paid', id]);
    return t;
}
async function readRows(name) { return (await db.collection(name).get()).docs.map(d => ({ id: d.id, ...d.data() })); }
const sum = (rows, field) => rows.reduce((s, r) => s + (r[field] || 0), 0);
const balance = async id => Math.round((await db.doc(`apartments/${id}`).get()).data().balance * 100);

test('полный месяц: начисления → банк → все проводки → отчёт правления → кабинет жильца → XML и квитанции', async () => {
    for (const [id, area, residents] of [['1', 64, 2], ['2', '48,2', 1], ['3', 80, 3]]) {
        await db.doc(`apartments/${id}`).set({ area, residents, balance: 0, personalAccount: `40123000${id}`, entrance: 1 });
        await db.doc(`apartments/${id}/owners/one`).set({ name: `Співвласник Тестовий ${id}` });
    }
    for (const [id, role] of [['900', 'accountant'], ['901', 'chair'], ['902', 'board']]) {
        await db.doc(`apartments/${id}`).set({ isAdmin: true });
        await db.doc(`staff/${id}`).set({ active: true, role });
    }
    await db.doc('bank/settings').set({ accounts: { [OWN]: { name: 'Поточний', purpose: 'current', balanceKop: 2000000, currency: 'UAH', balanceAt: at('2026-09-30') },
        [RESERVE]: { name: 'Резерв', purpose: 'reserve', balanceKop: 0, currency: 'UAH', balanceAt: at('2026-09-30') } } });
    await db.doc('bank_secrets/privat').set({ token: 'LOCAL-TEST-ONLY' });
    await db.doc('osbb_settings/finance').set({ edrpou: '40562894', registry: { legalName: 'ОСББ «ТЕСТ»', kved: '81.10' } });
    await charges.actions.addTariff(...C, { group: 'res', component: 'main', rate: '4,57', from: PERIOD, decision: 'Протокол зборів № 1' });
    for (const [name, base, item, rate] of [['Освітлення', 'area', 'power', '0,48'], ['Ліфти', 'area', 'lift', '0,63'], ['Вивезення відходів', 'residents', 'garbage', '14,15']]) {
        const { id } = await charges.actions.addComponent(...C, { name, base, item });
        await charges.actions.addTariff(...C, { group: 'res', component: id, rate, from: PERIOD, decision: 'Протокол зборів № 1' });
    }
    await charges.actions.setOpening(...A, { rows: [{ apt: '1', amountKop: -10000 }, { apt: '2', amountKop: 20000 }, { apt: '3', amountKop: 0 }] });
    const preview = await charges.actions.preview({ period: PERIOD });
    assert.deepEqual(preview.rows.map(r => [r.apt, r.amountKop]), [['1', 39182], ['2', 28793], ['3', 49685]]);
    assert.equal(preview.totalKop, 117660);
    await charges.actions.run(...A, { period: PERIOD, expectTotalKop: 117660 });
    assert.deepEqual(await Promise.all(['1', '2', '3'].map(balance)), [-49182, -8793, -49685]);

    const one = await ingest('one', 'in', 40000, 'О/р 00401230001, оплата внесків', { name: 'Співвласник Тестовий 1' });
    await ingest('two', 'in', 40000, 'Кв. 2, внески ОСББ', { name: 'Співвласник Тестовий 2' });
    assert.deepEqual(await Promise.all(['1', '2'].map(balance)), [-9182, 31207]);
    const shared = await ingest('shared', 'in', 39182, 'Спільна оплата', { name: 'Інший Тестовий Платник' });
    await bank.actions.assign(...A, { txId: shared.id, allocations: [{ apt: '1', amountKop: 9182 }, { apt: '3', amountKop: 30000 }] });
    assert.deepEqual(await Promise.all(['1', '2', '3'].map(balance)), [0, 31207, -19685]);
    assert.deepEqual(await bank.storeTransactions([one.raw, shared.raw], 'full-cycle-test', await bank.loadContext()), { added: 0, matched: 0 });

    const residentOut = await ingest('resident-out', 'out', 10000, 'Повернення переплати', { name: 'Співвласник Тестовий 2', account: EMPLOYEE });
    await bank.actions.refundResident(...A, { txId: residentOut.id, apt: '2' });
    assert.equal(await balance('2'), 21207);
    const residentBack = await ingest('resident-back', 'in', 10000, 'Уточнення банку', { name: 'Банк' });
    await bank.actions.refund(...A, { txId: residentBack.id, refundOf: residentOut.id, reason: 'bounce' });
    assert.equal(await balance('2'), 31207);
    const rent = await ingest('rent', 'in', 20000, 'Орендна плата', { name: 'ТОВ Тестовий Орендар', code: '14360570' });
    if ((await db.doc(`bank_tx/${rent.id}`).get()).data().status === 'review') await bank.actions.classifyTx(...A, { txId: rent.id, kind: 'income', category: 'rent' });
    const interest = await ingest('interest', 'in', 1000, 'Відсотки на залишок рахунку', { name: 'ПриватБанк', code: '14360570' });
    if ((await db.doc(`bank_tx/${interest.id}`).get()).data().status === 'review') await bank.actions.classifyTx(...A, { txId: interest.id, kind: 'income', category: 'interest' });

    await budget.actions.save(...A, { year: '2026', lines: ['power', 'cleaning', 'salary', 'esv', 'bank'].map(item => ({ item, title: item, planKop: 6000000 })),
        income: [{ source: 'contributions', planKop: 1000000 }, { source: 'rent', planKop: 100000 }, { source: 'interest', planKop: 10000 }] });
    await budget.actions.approve(...C, { year: '2026', decision: 'Протокол загальних зборів № 1', files: [] });
    const company = await expenses.actions.saveSupplier(...A, { name: 'ТОВ Тестовий Постачальник', kind: 'company', code: '14360570', iban: COMPANY });
    const fop = await expenses.actions.saveSupplier(...A, { name: 'ФОП Тестовий Постачальник', kind: 'fop', code: '3124567880', iban: FOP, fopChecked: true });
    const contract = await expenses.actions.saveContract(...A, { supplierId: company.id, number: 'C-1', date: '2026-10-01', subject: 'Послуги будинку', type: 'fixed', amountKop: 10000,
        validFrom: '2026-10-01', validTo: '2026-10-31', item: 'power', boardDecision: 'Протокол правління № 1', files: [] });
    await assert.rejects(expenses.actions.decideContract(...A, { id: contract.id, approve: true }), /голова/);
    await expenses.actions.decideContract(...C, { id: contract.id, approve: true });
    const power = await expenses.actions.saveExpense(...C, { supplierId: company.id, contractId: contract.id, number: 'P-1', date: '2026-10-02', description: 'Електроенергія будинку', period: PERIOD,
        docType: 'invoice', item: 'power', amountKop: 10000, files: [] });
    await expenses.actions.saveExpense(...A, { supplierId: company.id, number: 'A-1', date: '2026-10-30', description: 'Підтвердження послуги', period: PERIOD,
        docType: 'act', item: 'power', amountKop: 10000, linkedTo: power.id, files: [] });
    const cleaning = await expenses.actions.saveExpense(...C, { supplierId: fop.id, number: 'F-1', date: '2026-10-02', description: 'Прибирання будинку', period: PERIOD,
        docType: 'act', item: 'cleaning', amountKop: 5000, files: [] });
    for (const eid of [power.id, cleaning.id]) {
        const result = await expenses.actions.pay(...A, { id: eid, account: OWN });
        await assert.rejects(expenses.actions.pay(...A, { id: eid, account: OWN }), /уже|Приват24/);
        await settle(result.id);
        assert.equal((await db.doc(`expenses/${eid}`).get()).data().status, 'paid');
    }
    await expenses.actions.storno(...C, { id: power.id, amountKop: 1000, date: '2026-10-30', number: 'S-1', reason: 'Уточнення рахунку постачальника', files: [] });
    const powerData = (await db.doc(`expenses/${power.id}`).get()).data();
    const supplierBack = await ingest('supplier-back', 'in', 1000, 'Уточнення документа P-1', { name: 'ТОВ Тестовий Постачальник', account: COMPANY, code: '14360570' });
    await bank.actions.refund(...A, { txId: supplierBack.id, refundOf: powerData.txIds[0], reason: 'supplier' });
    const afterReturn = (await db.doc(`expenses/${power.id}`).get()).data();
    assert.deepEqual([afterReturn.amountKop, afterReturn.stornoKop, afterReturn.paidKop], [10000, 1000, 9000]);

    const employee = await payroll.actions.savePerson(...A, { name: 'Працівник Тестовий Іванович', kind: 'employee', salaryKop: 864700, fte: 1, mainJob: true, rnokpp: '3124567809', iban: EMPLOYEE,
        from: '2026-01-01', active: true, taxNotified: true, gender: 'Ч', position: 'двірник', kpCode: '9141', hireDoc: 'Наказ № 1' });
    const gph = await payroll.actions.savePerson(...A, { name: 'Виконавець Тестовий', kind: 'gph', rnokpp: '3124567821', iban: CONTRACTOR, from: '2026-10-01', to: '2026-10-31', gender: 'Ч', contract: 'ЦПД № 1' });
    await payroll.actions.saveSettings(...A, { advancePct: 50, taxes: Object.fromEntries(['pdfo', 'vz', 'esv'].map(k => [k, { name: `Податок ${k}`, iban: TAX, code: '40562894' }])) });
    await payroll.actions.saveRun(...A, { period: PERIOD, inputs: { [gph.id]: { actKop: 50000 } } });
    await assert.rejects(payroll.actions.approve(...A, { period: PERIOD }), /голова/);
    await payroll.actions.approve(...C, { period: PERIOD });
    let pctx = await payroll.actions.context({ period: PERIOD });
    assert.deepEqual([pctx.run.totals.grossKop, pctx.run.totals.netKop, pctx.run.totals.pdfoKop, pctx.run.totals.vzKop, pctx.run.totals.esvKop], [914700, 704319, 164646, 45735, 201234]);
    for (const stage of ['advance', 'final']) {
        await payroll.actions.pay(...A, { period: PERIOD, stage });
        await assert.rejects(payroll.actions.pay(...A, { period: PERIOD, stage }), /відправлено/);
        pctx = await payroll.actions.context({ period: PERIOD });
        if (stage === 'final') {
            const step = monthSteps({ period: PERIOD, payroll: pctx }).find(s => s.key === 'payroll');
            // Надіслані на підпис виплати закриттю не заважають: їх закриє виписка.
            assert.equal(step.state, 'wait');
            assert.match(step.short, /банком/);
        }
        for (const p of await readRows('payments')) if (p.payroll?.stage === stage && p.status === 'sent') await settle(p.id);
    }
    pctx = await payroll.actions.context({ period: PERIOD });
    assert.deepEqual(personState(pctx, employee.id), ['виплачено', 'is-done']);
    assert.deepEqual([payrollTotals(pctx).netPaidKop, payrollTotals(pctx).taxPaidKop], [704319, 411615]);
    assert.equal(monthSteps({ period: PERIOD, payroll: pctx }).find(s => s.key === 'payroll').state, 'done');
    await ingest('fee', 'out', 200, 'Комісія банку', { name: 'ПриватБанк', code: '14360570' });
    await ingest('reserve-out', 'out', 50000, 'Переказ між власними рахунками', { account: RESERVE });
    await ingest('reserve-in', 'in', 50000, 'Переказ між власними рахунками', { account: OWN }, RESERVE);

    const txs = await readRows('bank_tx');
    assert.ok(txs.every(t => t.status === 'done'), JSON.stringify(txs.filter(t => t.status !== 'done')));
    const ending = 2000000 + sum(txs.filter(t => t.direction === 'in'), 'amountKop') - sum(txs.filter(t => t.direction === 'out'), 'amountKop');
    assert.equal(ending, 1010048);
    for (const [iban, kop] of [[OWN, 960048], [RESERVE, 50000]]) await db.doc('bank/settings').update({ [`accounts.${iban}.balanceKop`]: kop, [`accounts.${iban}.balanceAt`]: at('2026-10-30') });
    await journal.actions.saveOpening(...A, { lines: [{ acc: '311', a: OWN, side: 'dr', kop: 2000000 }, { acc: '48', a: 'Вхідний залишок', side: 'cr', kop: 1990000 }] });
    await journal.actions.approveOpening(...C);
    await completeClosingPrerequisites(journal, db, PERIOD);
    const j = await journal.actions.context({ period: PERIOD });
    assert.ok(j.tb.balanced);
    assert.ok(!j.checks.some(c => ['block', 'warn'].includes(c.level)), JSON.stringify(j.checks));
    const account = number => j.tb.rows.find(r => r.acc === number);
    assert.equal(account('311').closeDr - account('311').closeCr, ending);
    for (const apt of ['1', '2', '3']) {
        const a = account('377').byA.find(r => r.a === apt);
        assert.equal((a?.closeCr || 0) - (a?.closeDr || 0), await balance(apt), apt);
    }
    for (const number of ['631', '661', '641', '651', '00', '79', '92']) assert.equal((account(number)?.closeDr || 0) + (account(number)?.closeCr || 0), 0, number);
    const statement = await charges.actions.getStatement({ period: PERIOD });
    assert.deepEqual(statement.rows.map(r => [r.apt, r.charged, r.paid, r.closing]), [['1', 39182, 49182, 0], ['2', 28793, 40000, 31207], ['3', 49685, 30000, -19685]]);
    const contexts = { charges: await charges.actions.context(), payroll: pctx, expenses: await expenses.actions.context(), journal: j, bank: { count: 0, sumKop: 0 } };
    const docStep = monthSteps({ period: PERIOD, ...contexts }).find(s => s.key === 'docs');
    assert.equal(docStep.facts.find(([title]) => title === 'На суму')[1], '140,00 грн');

    await budget.actions.publish(...A, { year: '2026' });
    const published = (await db.doc('finance/current').get()).data();
    const publicOps = Object.fromEntries((await readRows('finance_ops')).map(d => [d.id, d.ops]));
    assert.deepEqual([published.total, published.income, published.funds, published.debt.totalKop], [11301.34, 1401.82, 10100.48, 19685]);
    assert.deepEqual([financeSummary(published).spent, financeSummary(published).income, financeSummary(published).funds], [11301.34, 1401.82, 10100.48]);
    for (const s of published.budget.sections) for (const line of s.lines) {
        assert.equal(sum(publicOps[`exp-${line.item}`] || [], 'amountKop'), line.factKop, line.item);
    }
    assert.equal(sum(published.items.map(i => ({ kop: Math.round(i.amount * 100) })), 'kop'), Math.round(published.total * 100));
    const incomeLine = published.budget.income.find(r => r.source === 'contributions');
    assert.equal(incomeLine.factKop, 119182);
    assert.equal(sum(incomeLine.parts, 'factKop'), 119182);
    for (const part of incomeLine.parts) assert.equal(sum(publicOps[`inc-c-${part.component}`] || [], 'amountKop'), part.factKop, part.component);
    assert.ok(!JSON.stringify({ published, publicOps }).includes('Співвласник Тестовий'));
    assert.ok(!JSON.stringify(publicOps).includes('Працівник Тестовий'));

    await db.doc('osbb_settings/finance').set({ edrpou: '40562894', registry: { legalName: 'ОСББ «ТЕСТ»', kved: '81.10' } });
    await reports.actions.saveXmlSettings(...A, { sti: 1553, katottg: 'UA51100270010069184', zip: '65101', address: 'м. Одеса, вул. Тестова, 1', headName: 'Голова Тестовий', headTin: '3124567809' });
    const report = await reports.actions.payrollData({ period: PERIOD });
    assert.deepEqual(report.checks, []);
    assert.deepEqual([report.summary.grossKop, report.summary.paidKop, report.summary.pdfoPaidKop, report.summary.vzPaidKop, report.summary.esvPaidKop], [919700, 919700, 164646, 45735, 201234]);
    assert.deepEqual(report.income.map(r => r.sign), ['101', '102', '157']);
    const xml = await reports.actions.xml(...A, { period: PERIOD });
    assert.deepEqual(xml.problems, []);
    assert.equal(xml.files.length, 4);
    const value = (file, tag) => Math.round(Number(Buffer.from(file.data, 'base64').toString('latin1').match(new RegExp(`<${tag}>([^<]+)</${tag}>`))[1]) * 100);
    assert.equal(value(xml.files[0], 'R0107G3'), report.summary.esvKop);
    assert.equal(value(xml.files[1], 'R01G20'), report.summary.esvKop);
    assert.equal(value(xml.files[2], 'R01G03A'), report.summary.grossKop);
    assert.equal(value(xml.files[2], 'R01G03'), report.summary.paidKop);
    await reports.actions.mark(...A, { key: report.key, status: 'submitted', addFiles: [{ name: 'квитанція1.pdf', kind: 'receipt1', path: `reports/${report.key}/kv1.pdf` }] });
    await assert.rejects(reports.actions.mark(...A, { key: report.key, status: 'accepted' }), /квитанцію № 2/);
    await reports.actions.mark(...A, { key: report.key, status: 'accepted', addFiles: [{ name: 'квитанція2.pdf', kind: 'receipt2', path: `reports/${report.key}/kv2.pdf` }] });
    const reportCtx = await reports.actions.context();
    assert.equal(reportCtx.statuses[report.key].files.length, 2);
    assert.equal(reportCtx.statuses['esv-2026-10'].status, 'paid');

    const resident = env.authenticatedContext('resident-1', { email: '1@uspih-25.com' }).firestore();
    const chair = env.authenticatedContext('chair-901', { email: '901@uspih-25.com' }).firestore();
    const board = env.authenticatedContext('board-902', { email: '902@uspih-25.com' }).firestore();
    assert.equal((await assertSucceeds(getDoc(doc(resident, 'apartments/1')))).data().balance, 0);
    assert.equal((await assertSucceeds(getDocs(collection(resident, 'apartments/1/ledger')))).size, 4);
    assert.equal((await assertSucceeds(getDoc(doc(resident, 'finance/current')))).data().funds, ending / 100);
    await assertSucceeds(getDocs(collection(resident, 'finance_ops')));
    await assertSucceeds(getDoc(doc(board, 'finance/current')));
    await assertSucceeds(getDoc(doc(chair, `reports/${report.key}`)));
    await assertSucceeds(getDocs(collection(chair, 'bank_tx')));
    await assertFails(getDoc(doc(resident, 'apartments/2')));
    await assertFails(getDocs(collection(resident, 'bank_tx')));
    await assertFails(getDoc(doc(resident, `reports/${report.key}`)));
    await assertFails(getDoc(doc(board, 'bank_secrets/privat')));
    await completeClosingPrerequisites(journal,db,PERIOD);
    await journal.actions.close(...A, { period: PERIOD });
    assert.equal((await journal.actions.context({ period: PERIOD })).status, 'closed');
    await assert.rejects(charges.actions.run(...A, { period: PERIOD, expectTotalKop: 117660 }), /закрит|Закрит/);
    await assert.rejects(bank.actions.unassign(...A, { txId: one.id }), /закрит|Закрит/);
    await assert.rejects(journal.actions.reopen(...A, { period: PERIOD, reason: 'Тестове повторне відкриття' }), /голова/);
    await journal.actions.reopen(...C, { period: PERIOD, reason: 'Тестове повторне відкриття' });
    assert.ok(!(await journal.actions.context({ period: PERIOD })).checks.some(c => c.level === 'block'));
    if (process.env.USPIH_AUDIT_FIXTURE_PATH) {
        const collections = Object.fromEntries(await Promise.all(names.filter(n => n !== 'bank_secrets').map(async n => [n, await readRows(n)])));
        for (const a of collections.apartments) {
            collections[`apartments/${a.id}/ledger`] = await readRows(`apartments/${a.id}/ledger`);
            collections[`apartments/${a.id}/owners`] = await readRows(`apartments/${a.id}/owners`);
        }
        writeFileSync(process.env.USPIH_AUDIT_FIXTURE_PATH, JSON.stringify({ contexts, statement, report, reportCtx, published, publicOps,
            apartments: collections.apartments, bankTx: txs, payments: collections.payments, collections }, null, 2));
    }
});

test('401 квартира: все пакеты начислений и балансов, повторный запуск и отмена не теряют строки', async () => {
    for (let offset = 0; offset < 401; offset += 200) {
        const b = db.batch();
        for (let i = offset; i < Math.min(offset + 200, 401); i++) b.set(db.doc(`apartments/${i + 1}`), { area: 64, residents: 2, balance: 0 });
        await b.commit();
    }
    await charges.actions.addTariff(...C, { group: 'res', component: 'main', rate: '4,57', from: PERIOD, decision: 'Протокол зборів № 1' });
    await charges.actions.setOpening(...A, { rows: Array.from({ length: 401 }, (_, i) => ({ apt: String(i + 1), amountKop: -10000 })) });
    const run = await charges.actions.run(...A, { period: PERIOD, expectTotalKop: 11728448 });
    assert.equal(run.count, 401);
    const s = await charges.actions.getStatement({ period: PERIOD });
    assert.equal(s.rows.length, 401);
    assert.equal(sum(s.rows, 'charged'), 11728448);
    assert.ok((await readRows('apartments')).every(a => a.balance === -392.48));
    const replay = await charges.actions.run(...A, { period: PERIOD, expectTotalKop: 11728448 });
    assert.equal(replay.changed, 0);
    assert.equal((await db.collectionGroup('ledger').where('kind', '==', 'charge').get()).size, 401);
    await charges.actions.revert(...A, { period: PERIOD });
    assert.equal((await db.collectionGroup('ledger').where('kind', '==', 'charge').get()).size, 0);
    assert.ok((await readRows('apartments')).every(a => a.balance === -100));
});
