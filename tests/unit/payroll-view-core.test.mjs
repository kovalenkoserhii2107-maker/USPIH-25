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
test('salary and tax sharing a key remain separate in person status and payment totals', () => {
    const payments=[{key:'esv',recipientType:'person',stage:'final',status:'paid',amountKop:665819},
        {key:'esv',recipientType:'tax',stage:'final',status:'sent',amountKop:190234}];
    const totals=payrollTotals({run:{rows:[],totals:{}},payments});
    assert.equal(totals.netPaidKop,665819);assert.equal(totals.taxSigningKop,190234);assert.equal(totals.netSigningKop,0);
    assert.equal(personState({status:'approved',payments},'esv')[0],'виплачено');
});

test('a canceled final payment does not make a paid advance look like fully paid wages', () => {
    const payments=[{key:'p1',stage:'advance',status:'paid',amountKop:332909},{key:'p1',stage:'final',status:'canceled',amountKop:332910}];
    assert.equal(personState({status:'approved',payments},'p1')[0],'аванс виплачено');
    assert.equal(payrollTotals({run:{rows:[],totals:{}},payments}).netPaidKop,332909);
});

test('хід місяця й головна підказка: від табеля до виплати', async () => {
    const { flowSteps, nextPayrollAction, bankStep, stageState } = await import('../../js/payroll-view-core.js');
    const people = [{ id: 'p1' }];
    const totals = { grossKop: 864700, netKop: 665819, esvKop: 190234, advance: { netKop: 332909 }, final: { netKop: 332910 } };
    const base = { people, run: { totals, rows: [{ personId: 'p1', name: 'Працівник Тестовий', netKop: 665819, problems: [] }] }, stages: {}, payments: [], settings: { payMethod: 'iban' } };
    assert.equal(nextPayrollAction({ ...base, people: [] }, 'accountant').act, 'person-new');
    assert.equal(nextPayrollAction({ ...base, status: 'none' }, 'accountant').act, 'save');
    assert.equal(nextPayrollAction({ ...base, status: 'draft' }, 'chair').act, 'approve');
    assert.equal(nextPayrollAction({ ...base, status: 'draft' }, 'accountant').tone, 'wait');
    const approved = { ...base, status: 'approved' };
    assert.equal(nextPayrollAction(approved, 'accountant').act, 'pay-advance');
    assert.deepEqual(flowSteps(approved).map(s => s.state), ['done', 'done', 'current', 'todo']);
    const advSent = { ...approved, stages: { advance: { complete: true } }, payments: [{ stage: 'advance', key: 'p1', status: 'sent', amountKop: 1 }] };
    assert.equal(stageState(advSent, 'advance'), 'signing');
    assert.equal(nextPayrollAction(advSent, 'accountant').act, 'pay-final');
    const building = { ...approved, stages: { advance: { complete: false, project: { status: 'building' } } } };
    assert.equal(nextPayrollAction(building, 'accountant').btn, 'Продовжити');
    const broken = { ...base, status: 'draft', run: { totals, rows: [{ name: 'Працівник Тестовий', netKop: 1, problems: ['немає IBAN для виплати'] }] } };
    assert.equal(nextPayrollAction(broken, 'chair').tab, 'people');
    assert.equal(nextPayrollAction({ ...base, status: 'approved', pendingLeaves: 1 }, 'accountant').act, 'save');
    assert.deepEqual([bankStep('W').step, bankStep('S', 'S$').done, bankStep('F', 'R').bad, bankStep('R').bad], [2, true, true, true]);
});
