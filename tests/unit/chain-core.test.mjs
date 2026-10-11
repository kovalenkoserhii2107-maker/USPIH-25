// Ланцюжок: шлях платежу, звʼязки з документом і договором, підсумок договору.
import test from 'node:test';
import assert from 'node:assert/strict';
import { paymentSteps, paymentLinks, docPayments, contractSummary, docLeft } from '../../js/chain-core.js';

const at = d => new Date(`2026-10-${d}T10:00:00Z`);
const st = p => paymentSteps(p).map(s => s.state);

test('шлях платежу', () => {
    assert.deepEqual(st({ status: 'sending', createdAt: at(10) }), ['done', 'current', 'next']);
    assert.deepEqual(st({ status: 'sent', createdAt: at(10), sentAt: at(10) }), ['done', 'done', 'current']);
    assert.deepEqual(st({ status: 'paid', createdAt: at(10), sentAt: at(10), paidAt: at(11) }), ['done', 'done', 'done']);
    const failed = paymentSteps({ status: 'failed', createdAt: at(10), error: 'невірний IBAN' });
    assert.deepEqual(failed.map(s => s.state), ['done', 'bad', 'next']);
    assert.match(failed[1].note, /невірний IBAN/);
    assert.deepEqual(st({ status: 'canceled', createdAt: at(10), sentAt: at(10) }), ['done', 'done', 'bad']);
    assert.equal(paymentSteps({ status: 'unknown', createdAt: at(10) })[1].state, 'bad');
});

const ex = {
    suppliers: [{ id: 's1', name: 'Постачальник' }],
    contracts: [{ id: 'c1', supplierId: 's1', type: 'fixed', amountKop: 1000000 }, { id: 'c2', supplierId: 's1', type: 'monthly', monthlyKop: 425000 }],
    expenses: [
        { id: 'e1', supplierId: 's1', contractId: 'c1', amountKop: 300000, paidKop: 300000, status: 'paid', date: '2026-09-30', period: '2026-09' },
        { id: 'e2', supplierId: 's1', contractId: 'c1', amountKop: 500000, stornoKop: 100000, paidKop: 0, status: 'approved', date: '2026-10-31', period: '2026-10' },
        { id: 'e3', supplierId: 's1', contractId: 'c1', amountKop: 500000, status: 'linked', date: '2026-10-31', period: '2026-10' },
        { id: 'e4', supplierId: 's1', contractId: 'c2', amountKop: 425000, status: 'approved', date: '2026-10-31', period: '2026-10' }
    ]
};
const payments = [
    { id: 'p1', expenseId: 'e1', status: 'paid', amountKop: 300000, createdAt: at(1) },
    { id: 'p2', expenseId: 'e2', status: 'sent', amountKop: 400000, createdAt: at(5) },
    { id: 'p3', expenseId: 'e2', status: 'failed', amountKop: 400000, createdAt: at(3) }
];

test('звʼязки платежу й платежі документа', () => {
    const l = paymentLinks(payments[1], ex);
    assert.deepEqual([l.expense.id, l.contract.id, l.supplier.id], ['e2', 'c1', 's1']);
    assert.deepEqual(paymentLinks({ status: 'sent' }, ex), { expense: null, contract: null, supplier: null });
    assert.deepEqual(docPayments(ex.expenses[1], payments).map(p => p.id), ['p2', 'p3']);
    assert.equal(docLeft(ex.expenses[1]), 400000);
});

test('підсумок договору: за документами, сплачено, у банку, залишок суми договору', () => {
    const s = contractSummary(ex.contracts[0], ex, payments);
    assert.deepEqual(s.docs.map(e => e.id), ['e2', 'e1']);
    assert.deepEqual([s.billedKop, s.paidKop, s.inBankKop, s.dueKop, s.capKop, s.capLeftKop], [700000, 300000, 400000, 400000, 1000000, 300000]);
    assert.deepEqual(s.months.map(m => [m.period, m.kop]), [['2026-10', 400000], ['2026-09', 300000]]);
    const m = contractSummary(ex.contracts[1], ex, payments);
    assert.deepEqual([m.billedKop, m.capKop, m.capLeftKop], [425000, null, null]);
});
