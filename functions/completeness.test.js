'use strict';
// Повнота обліку: підтвердні документи (рахунок + акт), сторно,
// повернення списаного й переплати співвласнику — у балансі, проводках, кошторисі.
const test = require('node:test');
const assert = require('node:assert/strict');
const ex = require('./expenses-core');
const charges = require('./charges-core');
const j = require('./journal-core');
const budget = require('./budget-core');

const OWN = 'UA213052990000026001234567890';
const doc = (o = {}) => ({ id: 'inv', supplierId: 's1', supplierName: 'ТОВ ТЕСТ', docType: 'invoice', number: '15', date: '2026-10-05', amountKop: 500000,
    period: '2026-10', item: 'repair', status: 'approved', paidKop: 0, ...o });

test('рахунок і акт однієї послуги: схожий документ, привʼязка, межі', () => {
    const act = { supplierId: 's1', docType: 'act', number: 'A-7', date: '2026-10-28', amountKop: 500000 };
    assert.equal(ex.similarDocument(act, [doc()])?.id, 'inv');
    assert.equal(ex.similarDocument({ ...act, amountKop: 499999 }, [doc()]), null);
    assert.equal(ex.similarDocument({ ...act, docType: 'invoice' }, [doc()]), null);
    assert.equal(ex.similarDocument({ ...act, date: '2027-01-10' }, [doc()]), null);
    assert.equal(ex.similarDocument(act, [doc({ status: 'canceled' })]), null);
    assert.equal(ex.checkLink(act, doc()), null);
    assert.match(ex.checkLink({ ...act, supplierId: 's2' }, doc()), /різних постачальників/);
    assert.match(ex.checkLink({ ...act, amountKop: 600000 }, doc()), /більша/);
    assert.match(ex.checkLink({ ...act, paidKop: 100 }, doc()), /оплачено/);
    assert.match(ex.checkLink(act, doc({ linkedTo: 'x' })), /основного/);
});

test('сторно: залишок до сплати, межі суми й дати', () => {
    const d = doc({ paidKop: 200000, stornoKop: 100000 });
    assert.equal(ex.remaining(d), 200000);
    const s = { amountKop: 100000, date: '2026-11-03', number: 'КА-1', reason: 'неякісна послуга' };
    assert.equal(ex.checkStorno(d, s), null);
    assert.match(ex.checkStorno(d, { ...s, amountKop: 400001 }), /до 4000/);
    assert.match(ex.checkStorno(d, { ...s, date: '2026-10-01' }), /не раніше/);
    assert.match(ex.checkStorno(doc({ status: 'pending' }), s), /затверджений/);
    assert.match(ex.checkStorno(doc({ stornoOf: 'x', amountKop: -1 }), s), /не сторнують/);
});

test('повернення переплати співвласнику: баланс, складові, сплачено за місяць', () => {
    const entries = [
        { kind: 'opening', period: '2026-09', amountKop: 0, at: '2026-09-30T10:00:00Z' },
        { kind: 'charge', period: '2026-10', amountKop: 40000, parts: [{ component: 'main', amountKop: 30000 }, { component: 'lift', amountKop: 10000 }], at: '2026-10-31T10:00:00Z' },
        { kind: 'payment', period: '2026-10', amountKop: 100000, at: '2026-10-05T10:00:00Z' },
        { kind: 'refund', period: '2026-10', amountKop: 50000, at: '2026-11-01T10:00:00Z' }
    ];
    assert.equal(charges.balanceFromLedger(entries), 10000);
    const { balances } = charges.replay(entries, { order: ['main', 'lift'] });
    assert.equal(Object.values(balances).reduce((s, v) => s + v, 0), 10000);
    // Оплата до нарахування пішла на основну складову (як у сервісі); повернення забирає переплату саме з неї.
    assert.deepEqual([balances.main, balances.lift], [20000, -10000]);
    const st = charges.statement(new Map([['5', entries]]), '2026-10');
    assert.deepEqual([st.rows[0].paid, st.rows[0].closing], [50000, 10000]);
});

test('проводки: сторно червоним, повернення — на рахунок оплати, переплата — 377', () => {
    const expenses = [doc({ id: 'e1', status: 'paid', paidKop: 500000, txIds: ['o1'], stornoKop: 100000 }),
        { ...doc({ id: 'st', status: 'storno', amountKop: -100000, stornoOf: 'e1', number: 'КА-1', date: '2026-10-30' }) }];
    const bankTx = [
        { id: 'o1', account: OWN, period: '2026-10', at: new Date('2026-10-10T10:00:00Z'), direction: 'out', kind: 'expense', status: 'done', category: 'supplier', expenseId: 'e1', amountKop: 500000, counterparty: { name: 'ТОВ ТЕСТ' }, refundedKop: 100000, refundTxIds: ['r1'] },
        { id: 'r1', account: OWN, period: '2026-10', at: new Date('2026-10-31T10:00:00Z'), direction: 'in', kind: 'refund', status: 'done', refundOf: 'o1', refundReason: 'supplier', amountKop: 100000, counterparty: { name: 'ТОВ ТЕСТ' } },
        { id: 'o2', account: OWN, period: '2026-10', at: new Date('2026-10-12T10:00:00Z'), direction: 'out', kind: 'expense', status: 'done', category: 'bank_fee', amountKop: 500, refundedKop: 500, refundTxIds: ['r2'] },
        { id: 'r2', account: OWN, period: '2026-10', at: new Date('2026-10-13T10:00:00Z'), direction: 'in', kind: 'refund', status: 'done', refundOf: 'o2', refundReason: 'other', amountKop: 500 },
        { id: 'o3', account: OWN, period: '2026-10', at: new Date('2026-10-20T10:00:00Z'), direction: 'out', kind: 'expense', status: 'done', category: 'resident_refund', amountKop: 50000, allocations: [{ apt: '5', amountKop: 50000, ledgerId: 'refund-o3' }] }
    ];
    const entries = j.buildEntries({ bankTx, expenses });
    const tb = j.trialBalance(j.journal({ bankTx, expenses }, '2026-10'), '2026-10');
    const acc = a => tb.rows.find(r => r.acc === a);
    assert.ok(tb.balanced);
    // Документ 5 000, сторно −1 000, оплачено 5 000, постачальник повернув 1 000 → розрахунки з ним закрито.
    const sup = acc('631').byA.find(x => x.a === 'ТОВ ТЕСТ');
    assert.deepEqual([sup.closeDr, sup.closeCr], [0, 0]);
    assert.ok(entries.some(e => e.ref === 'st' && e.dr === '92' && e.kop === -100000));
    // Повернена комісія зменшує витрату на банк; повернення переплати — Дт 377 кв. 5.
    assert.ok(entries.some(e => e.ref === 'r2' && e.dr === '311' && e.cr === '92' && e.cA === 'bank'));
    assert.ok(entries.some(e => e.ref === 'o3' && e.dr === '377' && e.dA === '5' && e.cr === '311'));
    // Кошторис: стаття «Ремонт» — 5 000 − 1 000; комісія — 0 (повернена); переплата не витрата, а мінус внесків.
    const fact = budget.factByItem({ expenses, bankOut: bankTx, year: '2026' });
    assert.deepEqual([fact.get('repair'), fact.get('bank') || 0, fact.get('other') || 0], [400000, 0, 0]);
    assert.equal(budget.incomeFact({ bankIn: bankTx, year: '2026' }).get('contributions'), -50000);
});

test('звірка: повернення без оригіналу й запис повернення без списання — перешкода', () => {
    const { reconcile } = require('./reconciliation-core');
    const issues = reconcile({ period: '2026-10',
        bankTx: [{ id: 'r9', period: '2026-10', direction: 'in', kind: 'refund', status: 'done', refundOf: 'nope', amountKop: 100 }],
        ledgers: new Map([['5', [{ _id: 'refund-x', kind: 'refund', period: '2026-10', amountKop: 100 }]]]) }).map(i => i.text);
    assert.ok(issues.some(t => /Повернення r9/.test(t)));
    assert.ok(issues.some(t => /Повернення 2026-10, прим. 5/.test(t)));
});
