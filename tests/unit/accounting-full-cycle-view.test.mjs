// Проверки интерфейса на схеме данных настоящих серверных ответов.
import test from 'node:test';
import assert from 'node:assert/strict';
import { monthSteps } from '../../js/month-core.js';
import { payrollTotals, personState } from '../../js/payroll-view-core.js';
import { financeSummary } from '../../js/finance-core.js';

test('серверные ключи зарплаты: человек и налог, проведение и частичный возврат', () => {
    const run = { totals: { grossKop: 100000, netKop: 77000, pdfoKop: 18000, vzKop: 5000, esvKop: 22000 }, rows: [{ personId: 'e1', kind: 'employee', netKop: 77000 }] };
    const payments = [{ stage: 'final', key: 'e1', status: 'paid', amountKop: 77000, returnedKop: 10000 }, { stage: 'final', key: 'pdfo', status: 'sent', amountKop: 18000 },
        { stage: 'final', key: 'vz', status: 'paid', amountKop: 5000 }, { stage: 'final', key: 'esv', status: 'paid', amountKop: 22000 }];
    const ctx = { status: 'approved', stages: { final: { complete: true } }, run, payments };
    assert.deepEqual([payrollTotals(ctx).netPaidKop, payrollTotals(ctx).taxPaidKop, payrollTotals(ctx).taxSigningKop], [67000, 27000, 18000]);
    assert.equal(personState(ctx, 'e1')[0], 'банк не прийняв');
    assert.equal(monthSteps({ period: '2026-10', payroll: ctx }).find(s => s.key === 'payroll').state, 'work');
    payments[0].returnedKop = 0; payments[1].status = 'paid';
    assert.equal(personState(ctx, 'e1')[0], 'виплачено');
    assert.equal(monthSteps({ period: '2026-10', payroll: ctx }).find(s => s.key === 'payroll').state, 'done');
});

test('итог документов месяца не удваивает акт и не вычитает сторно два раза', () => {
    const expenses = { expenses: [{ id: 'invoice', period: '2026-10', status: 'paid', amountKop: 100000, paidKop: 90000, stornoKop: 10000 },
        { id: 'act', period: '2026-10', status: 'linked', linkedTo: 'invoice', amountKop: 100000 },
        { id: 'storno', period: '2026-10', status: 'storno', stornoOf: 'invoice', amountKop: -10000 },
        { id: 'canceled', period: '2026-10', status: 'canceled', amountKop: 40000 }] };
    const step = monthSteps({ period: '2026-10', expenses }).find(s => s.key === 'docs');
    assert.deepEqual(step.facts, [['Документів', '1'], ['На суму', '900,00 грн']]);
});

test('отрицательная статья возврата остаётся в расходах и суммах для жильца', () => {
    const r = financeSummary({ income: 1000, funds: 3500, total: 600, items: [{ item: 'power', label: 'Електроенергія', amount: 900 }, { item: 'bank', label: 'Повернення комісії', amount: -300 }] });
    assert.deepEqual([r.spent, r.difference, r.spentShare, r.items.length], [600, 400, 60, 2]);
    const onlyRefund = financeSummary({ income: 1000, items: [{ label: 'Повернення', amount: -100 }] });
    assert.deepEqual([onlyRefund.spent, onlyRefund.difference, onlyRefund.spentShare], [-100, 1100, null]);
});
