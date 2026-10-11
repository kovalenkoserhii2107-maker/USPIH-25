// «Зарплата»: стан виплати людини й підсумки місяця.
import test from 'node:test';
import assert from 'node:assert/strict';
import { initials, personState, payrollTotals } from '../../js/payroll-view-core.js';

const run = { totals: { grossKop: 1664700, netKop: 1281819, pdfoKop: 299646, vzKop: 83235, esvKop: 366234 },
    rows: [{ personId: 'p1', kind: 'employee' }, { personId: 'g1', kind: 'gph' }] };
const payments = [
    { key: 'final:p1', status: 'sent', amountKop: 665819 },
    { key: 'final:g1', status: 'paid', amountKop: 616000 },
    { key: 'final:pdfo', status: 'paid', amountKop: 299646 },
    { key: 'final:esv', status: 'sent', amountKop: 366234 },
    { key: 'advance:p1', status: 'failed', amountKop: 1 }
];

test('ініціали', () => {
    assert.equal(initials('Працівник Перший Тестович'), 'ПП');
    assert.equal(initials(''), '·');
});

test('стан людини: на підписі, виплачено, банк не прийняв, за станом відомості', () => {
    assert.deepEqual(personState({ status: 'approved', payments: payments.slice(0, 4) }, 'p1'), ['на підписі', 'is-work']);
    assert.deepEqual(personState({ status: 'approved', payments }, 'g1'), ['виплачено', 'is-done']);
    assert.deepEqual(personState({ status: 'approved', payments }, 'p1'), ['банк не прийняв', 'is-bad']);
    assert.deepEqual(personState({ status: 'approved', payments: [{ key: 'advance:p1', status: 'paid', amountKop: 1 }] }, 'p1'), ['аванс виплачено', 'is-done']);
    assert.deepEqual(personState({ status: 'approved', payments: [] }, 'p1'), ['до виплати', 'is-work']);
    assert.deepEqual(personState({ status: 'draft' }, 'p1'), ['чекає голову', '']);
    assert.deepEqual(personState({ status: 'none' }, 'p1'), ['не складено', '']);
    assert.deepEqual(personState({ status: 'approved' }, 'x', false), ['не в цьому місяці', 'is-locked']);
});

test('підсумки: людям і податки окремо, невдалі платежі не рахуємо', () => {
    assert.deepEqual(payrollTotals({ run, payments }), {
        employees: 1, contractors: 1, grossKop: 1664700, netKop: 1281819, taxKop: 749115,
        netPaidKop: 616000, netSigningKop: 665819, taxPaidKop: 299646, taxSigningKop: 366234
    });
});
