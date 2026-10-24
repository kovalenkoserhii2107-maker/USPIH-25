// «Платежі»: шлях грошей, «до оплати», звʼязки платежу, кошти й підказки форми.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    kindOf, problemOf, paymentTags, docsToPay, payrollDue, advanceToPay, toPayList, riskOf, supplierFor,
    flow, funds, nextStep, historyGroups, draftWarnings
} from '../../js/payments-view-core.js';

const NOW = new Date('2026-10-24T12:00:00Z');
const IBAN_A = 'UA213052990000026007054321001';
const IBAN_B = 'UA903052990000026004011111111';
const ex = {
    docTypes: { invoice: 'Рахунок', act: 'Акт' },
    suppliers: [
        { id: 's1', name: 'Ліфт-Сервіс (демо)', code: '12345678', iban: IBAN_A },
        { id: 's2', name: 'Борг-Груп (демо)', code: '87654321', iban: IBAN_B, taxDebtTotal: 1200 }
    ],
    contracts: [{ id: 'c1', number: '7', supplierId: 's1' }],
    expenses: [
        { id: 'e1', supplierId: 's1', supplierName: 'Ліфт-Сервіс (демо)', contractId: 'c1', docType: 'act', number: '15', date: '2026-10-05', status: 'approved', amountKop: 500000, paidKop: 0 },
        { id: 'e2', supplierId: 's2', supplierName: 'Борг-Груп (демо)', docType: 'invoice', number: '3', date: '2026-10-01', status: 'approved', amountKop: 100000, paidKop: 40000 },
        { id: 'e3', supplierId: 's1', supplierName: 'Ліфт-Сервіс (демо)', docType: 'act', number: '16', date: '2026-10-10', status: 'pending', amountKop: 70000 },
        { id: 'e4', supplierId: 's1', supplierName: 'Ліфт-Сервіс (демо)', docType: 'act', number: '14', date: '2026-09-05', status: 'approved', amountKop: 500000, paidKop: 500000 }
    ]
};

test('вид платежу: відомість, авансовий звіт, постачальник', () => {
    assert.equal(kindOf({ kind: 'salary', payroll: { key: 'p1', recipientType: 'person' } }), 'salary');
    assert.equal(kindOf({ kind: 'tax', payroll: { key: 'esv' } }), 'tax');
    assert.equal(kindOf({ kind: 'advance', advanceReportId: 'a1' }), 'advance');
    assert.equal(kindOf({ kind: 'supplier' }), 'supplier');
    assert.equal(kindOf({ kind: 'дивне' }), 'other');
});

test('проблеми: банк не прийняв, не підтвердив, зависло, повернув', () => {
    const now = NOW.getTime();
    assert.equal(problemOf({ status: 'failed' }, now), 'failed');
    assert.equal(problemOf({ status: 'unknown' }, now), 'unknown');
    assert.equal(problemOf({ status: 'sending', createdAt: new Date(now - 11 * 60000) }, now), 'stale');
    assert.equal(problemOf({ status: 'sending', createdAt: new Date(now - 60000) }, now), null);
    assert.equal(problemOf({ status: 'sent', canceling: { at: new Date(now - 20 * 60000).toISOString() } }, now), 'stale');
    assert.equal(problemOf({ status: 'paid', payroll: { key: 'p1' }, returnedKop: 100 }, now), 'returned');
    assert.equal(problemOf({ status: 'paid', payroll: { key: 'p1' }, returnedKop: 100, repaidBy: ['x'] }, now), null);
    assert.equal(problemOf({ status: 'paid', returnedKop: 100 }, now), null, 'постачальнику — документ знову до оплати');
    assert.equal(problemOf({ status: 'sent' }, now), null);
});

test('звʼязки платежу: документ, договір, виписка; ручний і регулярний', () => {
    assert.deepEqual(paymentTags({ expenseId: 'e1', txId: 't1', status: 'paid' }, ex).map(t => t.text), ['Акт № 15', 'Договір № 7', 'У виписці']);
    assert.deepEqual(paymentTags({ payroll: { period: '2026-10', stage: 'advance' }, status: 'sent' }).map(t => t.text), ['Відомість · аванс жовт 2026']);
    assert.deepEqual(paymentTags({ proposalKey: 'manual:x', status: 'paid' }).map(t => [t.text, t.state]), [['Вручну', undefined], ['Без операції у виписці', 'warn']]);
    assert.equal(paymentTags({ proposalKey: 'abc-2026-10', status: 'sent' })[0].type, 'regular');
    assert.equal(paymentTags({ advanceReportId: 'a1', status: 'sent' })[0].type, 'advance');
});

test('до оплати: документи без платежу в банку, зарплата, авансові звіти', () => {
    const payments = [{ id: 'p1', expenseId: 'e2', status: 'sent', amountKop: 60000 }];
    assert.deepEqual(docsToPay(ex, payments).map(e => e.id), ['e1']);
    assert.deepEqual(docsToPay(ex, []).map(e => e.id), ['e1', 'e2']);

    const run = { rows: [{}], totals: { netKop: 1000000, pdfoKop: 200000, vzKop: 50000, esvKop: 250000, advance: { netKop: 400000 }, final: { netKop: 600000 } } };
    assert.equal(payrollDue({ status: 'draft', run }), null, 'не затверджено — платити ще не можна');
    assert.deepEqual(payrollDue({ period: '2026-10', status: 'approved', run, stages: {} }),
        { period: '2026-10', stage: 'advance', amountKop: 400000, taxKop: 0, state: 'todo', note: 'за першу половину місяця' });
    const fin = payrollDue({ period: '2026-10', status: 'approved', run, stages: { advance: { plan: [] } }, payments: [{ stage: 'advance', status: 'paid' }] });
    assert.equal(fin.stage, 'final');
    assert.equal(fin.amountKop, 600000);
    assert.equal(fin.taxKop, 500000);
    assert.equal(payrollDue({ status: 'approved', run, stages: { advance: {}, final: {} }, payments: [{ stage: 'advance', status: 'paid' }, { stage: 'final', status: 'sent' }] }), null);
    assert.equal(payrollDue({ status: 'approved', run, stages: { advance: { complete: false } } }).state, 'bad');

    const adv = { reports: [
        { id: 'a1', status: 'approved', personName: 'Підзвітний (демо)', number: '4', totals: { pendingReimburseKop: 12000 } },
        { id: 'a2', status: 'approved', totals: { pendingReimburseKop: 5000 } },
        { id: 'a3', status: 'pending', totals: { pendingReimburseKop: 7000 } }
    ] };
    assert.deepEqual(advanceToPay(adv, [{ advanceReportId: 'a2', status: 'sent' }]).map(r => r.id), ['a1']);
    assert.deepEqual(advanceToPay(adv, [{ advanceReportId: 'a2', status: 'failed' }]).map(r => r.id), ['a1', 'a2']);

    const list = toPayList({ docs: docsToPay(ex, []), docTypes: ex.docTypes, contracts: ex.contracts, suppliers: ex.suppliers,
        proposals: [{ proposalKey: 'k', recipient: { name: 'Вода (демо)' }, purpose: 'Вода', amountKop: 30000, months: 3, day: 10 }],
        payroll: [{ period: '2026-10', stage: 'final', amountKop: 600000, taxKop: 500000 }], advance: advanceToPay(adv, []) });
    assert.deepEqual(list.map(i => i.type), ['payroll', 'doc', 'doc', 'regular', 'advance', 'advance']);
    assert.equal(list[0].amountKop, 1100000);
    assert.equal(list[1].ref.id, 'e2', 'старіший документ — першим');
    assert.equal(list[1].amountKop, 60000, 'лишок після часткової оплати');
    assert.equal(list[1].risk.level, 'bad');
    assert.equal(list[2].contract, 'Договір № 7');
    assert.equal(list[2].doc, 'Акт № 15 від 05.10.2026');
});

test('ризик і постачальник платежу', () => {
    assert.equal(riskOf(ex.suppliers[0]), null);
    assert.deepEqual(riskOf(ex.suppliers[1]), { level: 'bad', text: 'податковий борг 1200 грн' });
    assert.equal(supplierFor({ expenseId: 'e1' }, ex).id, 's1');
    assert.equal(supplierFor({ recipient: { code: '87654321' } }, ex).id, 's2');
    assert.equal(supplierFor({ recipient: { iban: IBAN_A.toLowerCase() } }, ex).id, 's1');
    assert.equal(supplierFor({ recipient: { code: '11111111' } }, ex), null);
});

test('шлях грошей, кошти й головна підказка', () => {
    const payments = [
        { id: 'p1', status: 'sent', amountKop: 100000, createdAt: NOW },
        { id: 'p2', status: 'paid', amountKop: 50000, paidAt: new Date('2026-10-03'), returnedKop: 1000, repaidBy: ['x'] },
        { id: 'p3', status: 'paid', amountKop: 70000, paidAt: new Date('2026-09-28') },
        { id: 'p4', status: 'failed', amountKop: 9000, createdAt: NOW, recipient: { name: 'Вода (демо)' } }
    ];
    const f = flow({ payments, toPay: [{ amountKop: 30000 }], approval: { docs: [{ amountKop: 70000 }], payroll: true }, now: NOW });
    assert.deepEqual(f.approval, { count: 2, kop: 70000, docs: 1, payroll: true, advance: 0 });
    assert.deepEqual(f.todo, { count: 1, kop: 30000 });
    assert.deepEqual(f.signing, { count: 1, kop: 100000 });
    assert.deepEqual(f.paid, { count: 1, kop: 49000 });
    assert.equal(f.problems, 1);

    assert.deepEqual(funds([{ iban: IBAN_A, purpose: 'current', balanceKop: 120000 }], 100000, 30000),
        { known: true, iban: IBAN_A, balanceKop: 120000, afterSigningKop: 20000, afterAllKop: -10000, shortKop: 10000 });
    assert.equal(funds([{ iban: IBAN_A, balanceKop: null }], 1, 1).known, false);

    assert.equal(nextStep(f, 'accountant', payments[3]).act, 'open-problem');
    const calm = { ...f, problems: 0 };
    assert.equal(nextStep(calm, 'chair').act, 'tab-signing');
    assert.equal(nextStep(calm, 'accountant').act, 'tab-todo');
    assert.equal(nextStep({ ...calm, todo: { count: 0, kop: 0 } }, 'accountant').act, 'remind');
    const idle = { ...calm, todo: { count: 0, kop: 0 }, signing: { count: 0, kop: 0 } };
    assert.equal(nextStep(idle, 'accountant').go, 'inbox');
    assert.equal(nextStep({ ...idle, approval: { count: 0 } }, 'accountant').tone, 'done');
});

test('історія: пошук, вид, групи по місяцях', () => {
    const payments = [
        { id: 'a', status: 'paid', kind: 'supplier', amountKop: 1000, paidAt: new Date('2026-10-02'), recipient: { name: 'Вода (демо)' }, purpose: 'Вода за вересень' },
        { id: 'b', status: 'paid', kind: 'tax', payroll: { key: 'esv' }, amountKop: 2000, paidAt: new Date('2026-09-20'), recipient: { name: 'ДПС (демо)' } },
        { id: 'c', status: 'canceled', kind: 'supplier', amountKop: 3000, createdAt: new Date('2026-10-05'), recipient: { name: 'Ліфт (демо)' } },
        { id: 'd', status: 'sent', amountKop: 4000, createdAt: NOW }
    ];
    const all = historyGroups(payments);
    assert.deepEqual(all.map(g => [g.period, g.kop, g.list.map(p => p.id)]), [['2026-10', 1000, ['c', 'a']], ['2026-09', 2000, ['b']]]);
    assert.deepEqual(historyGroups(payments, { kind: 'tax' }).map(g => g.list.map(p => p.id)), [['b']]);
    assert.deepEqual(historyGroups(payments, { query: 'вересень' }).map(g => g.list.map(p => p.id)), [['a']]);
});

test('форма: дубль, погоджений документ, ризик, зарплата, новий отримувач', () => {
    const payments = [{ id: 'p1', status: 'sent', amountKop: 30000, recipient: { iban: IBAN_B } }];
    const w = draftWarnings({ kind: 'supplier', amountKop: 30000, recipient: { iban: IBAN_B, code: '87654321' } }, { payments, ex });
    assert.deepEqual(w.map(x => [x.level, x.act || '']), [['bad', 'open-payment'], ['info', 'pay-doc'], ['bad', '']]);
    assert.match(w[1].text, /№ 3 на 600,00 грн/);
    assert.deepEqual(draftWarnings({ kind: 'supplier', recipient: { iban: '', code: '' } }, { payments, ex }), []);
    assert.equal(draftWarnings({ kind: 'salary', recipient: { iban: 'UA00 1' } }, { payrollIbans: ['UA001'] })[0].act, 'go-payroll');
    assert.equal(draftWarnings({ kind: 'supplier', recipient: { code: '11112222' } }, { ex })[0].act, 'check-yc');
    const paid = [{ id: 'p9', status: 'paid', amountKop: 500, paidAt: new Date(NOW.getTime() - 5 * 864e5), recipient: { code: '11112222' } }];
    assert.equal(draftWarnings({ kind: 'other', amountKop: 500, recipient: { code: '11112222' } }, { payments: paid, now: NOW.getTime() })[0].level, 'warn');
});
