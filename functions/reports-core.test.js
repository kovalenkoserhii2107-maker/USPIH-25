'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const r = require('./reports-core');
const payroll = require('./payroll-core');

const emp = { id: 'e1', name: 'Працівник Тестовий', kind: 'employee', position: 'двірник', salaryKop: 864700, fte: 1, mainJob: true,
    iban: 'UA213052990000026001234567890', rnokpp: '3124567809', taxNotified: true, from: '2026-10-16' };
const gph = { id: 'g1', name: 'Виконавець Тестовий', kind: 'gph', iban: 'UA213052990000026001234567891', rnokpp: '', to: '2026-10-31' };

test('ключі календаря й місяць звіту', () => {
    assert.ok(r.validKey('j0500111-2026-10') && r.validKey('esv-2027-1') && r.validKey('npo-2026'));
    assert.ok(!r.validKey('j0500111-2026-13') && !r.validKey('j0500111-2026-010') && !r.validKey('../x'));
    assert.equal(r.periodOf('j0500111-2027-1'), '2027-01');
    assert.equal(r.periodOf('npo-2026'), null);
    assert.equal(r.keyFor('j0500111', '2027-01'), 'j0500111-2027-1');
    assert.equal(r.dueDate('2026-12'), '2027-01-20');
});

test('розрахунок за місяць: 4ДФ, ЄСВ, прийом і кінець договору, сплачене за платежами', () => {
    const run = payroll.buildRun({ people: [emp, gph], inputs: { g1: { actKop: 800000 } }, period: '2026-10' });
    const people = new Map([[emp.id, emp], [gph.id, gph]]);
    // Аванс працівнику й податки з нього проведено банком; остаточний розрахунок ще на підписі.
    const payments = [
        { stage: 'advance', key: 'e1', status: 'paid', amountKop: run.rows[0].advance.netKop }, { stage: 'advance', key: 'pdfo', status: 'paid', amountKop: run.totals.advance.pdfoKop }, { stage: 'advance', key: 'vz', status: 'paid', amountKop: run.totals.advance.vzKop },
        { stage: 'advance', key: 'esv', status: 'paid', amountKop: run.totals.advance.esvKop }, { stage: 'final', key: 'e1', status: 'sent' }, { stage: 'final', key: 'esv', status: 'sent' }
    ];
    const rep = r.payrollReport({ period: '2026-10', stored: { status: 'approved', run }, people, payments });
    const e = rep.income.find(x => x.personId === 'e1');
    const g = rep.income.find(x => x.personId === 'g1');
    // Прийом 16.10: 11 робочих днів з 22 — оклад пропорційно.
    assert.equal(e.grossKop, Math.round(864700 * 11 / 22));
    assert.equal(e.sign, '101');
    assert.equal(g.sign, '102');
    assert.equal(e.paidKop, run.rows[0].advance.grossKop);
    assert.equal(e.pdfoPaidKop, run.rows[0].advance.pdfoKop);
    assert.equal(g.pdfoPaidKop, 0);
    assert.equal(rep.summary.esvPaidKop, run.totals.advance.esvKop);
    // Неповний місяць — ЄСВ з фактичної бази, без доплати до мінімальної.
    const es = rep.esv.find(x => x.personId === 'e1');
    assert.deepEqual([es.days, es.normDays, es.topUpKop], [16, 31, 0]);
    assert.deepEqual(rep.relations.map(x => [x.personId, x.event, x.date]), [['e1', 'start', '2026-10-16'], ['g1', 'end', '2026-10-31']]);
    assert.deepEqual(rep.checks.map(c => c.level), ['block', 'block', 'block', 'warn', 'warn', 'info']);
    assert.match(rep.checks[0].text, /Виконавець Тестовий: немає правильного РНОКПП/);
    assert.equal(rep.summary.due, '2026-11-20');
});

test('без авансу остаточний розрахунок сплачує все нараховане', () => {
    const run = payroll.buildRun({ people: [{ ...emp, from: '2026-01-01' }], period: '2026-10' });
    const amounts = { e1: 665819, pdfo: 155646, vz: 43235, esv: 190234 };
    const payments = Object.entries(amounts).map(([key, amountKop]) => ({ stage: 'final', key, status: 'paid', amountKop }));
    const s = r.payrollReport({ period: '2026-10', stored: { status: 'approved', run }, people: new Map([[emp.id, emp]]), payments }).summary;
    assert.deepEqual([s.paidKop, s.pdfoPaidKop, s.vzPaidKop, s.esvPaidKop], [864700, 155646, 43235, 190234]);
});

test('без затвердженої відомості цифр немає, лише перешкода', () => {
    const draft = r.payrollReport({ period: '2026-11', stored: { status: 'draft', run: { rows: [{ grossKop: 1 }] } } });
    assert.deepEqual([draft.income.length, draft.summary.grossKop, draft.checks[0].level], [0, 0, 'block']);
    assert.match(r.payrollReport({ period: '2026-11', stored: null }).checks[0].text, /не складено/);
});

test('4ДФ: аванс і своєчасний остаточний розрахунок 05.11 лишаються у жовтні', () => {
    const card = { ...emp, from: '2026-01-01' };
    const oct = payroll.buildRun({ people: [card], period: '2026-10' });
    const nov = payroll.buildRun({ people: [card], period: '2026-11' });
    const people = new Map([[emp.id, card]]);
    const runs = new Map([['2026-10', { status: 'approved', run: oct }], ['2026-11', { status: 'approved', run: nov }]]);
    const pay = (period, stage, key, amountKop, paidOn) => ({ period, stage, key, status: 'paid', amountKop, paidOn });
    const payments = [
        pay('2026-10', 'advance', 'e1', oct.rows[0].advance.netKop, '2026-10-20'), pay('2026-10', 'advance', 'pdfo', oct.totals.advance.pdfoKop, '2026-10-20'),
        pay('2026-10', 'advance', 'vz', oct.totals.advance.vzKop, '2026-10-20'), pay('2026-10', 'final', 'vz', oct.totals.final.vzKop, '2026-11-05'),
        pay('2026-10', 'final', 'e1', oct.rows[0].final.netKop, '2026-11-05'), pay('2026-10', 'final', 'pdfo', oct.totals.final.pdfoKop, '2026-11-05'),
        pay('2026-11', 'advance', 'e1', nov.rows[0].advance.netKop, '2026-11-20')
    ];
    const o = r.payrollReport({ period: '2026-10', stored: runs.get('2026-10'), people, payments, runs });
    const n = r.payrollReport({ period: '2026-11', stored: runs.get('2026-11'), people, payments, runs });
    assert.equal(o.income[0].grossKop, oct.rows[0].grossKop);
    assert.equal(o.income[0].paidKop, oct.rows[0].grossKop);
    assert.equal(o.income[0].pdfoPaidKop, oct.totals.pdfoKop);
    // У листопаді своєчасна зарплата жовтня вдруге не рахується.
    assert.equal(n.income.length, 1);
    assert.equal(n.income[0].grossKop, nov.rows[0].grossKop);
    assert.equal(n.income[0].paidKop, nov.rows[0].advance.grossKop);
    assert.equal(n.income[0].pdfoPaidKop, 0);
    assert.equal(n.summary.earlierKop, 0);
    // Контроль сплати ПДФО — за відомістю місяця: жовтневий сплачено повністю.
    assert.ok(!o.checks.some(c => /Не всі ПДФО/.test(c.text)), JSON.stringify(o.checks));
    // Виплата за місяць без затвердженої відомості — перешкода.
    const lost = r.payrollReport({ period: '2026-11', stored: runs.get('2026-11'), people, payments, runs: new Map([['2026-11', runs.get('2026-11')]]) });
    assert.ok(lost.checks.some(c => c.level === 'block' && /2026-10/.test(c.text)));
});

test('ФОП: нарахування з документа, виплата за банком, повернення потребує уточнення XML', () => {
    const { fopReport } = require('./fop-report-core');
    const suppliers = new Map([['s1', { name: 'ФОП Тестовий', kind: 'fop', code: '3124567809', iban: 'UA213052990000026001234567890', fopChecked: true }],
        ['s2', { name: 'ТОВ Тест', kind: 'company', code: '14360570', iban: 'UA213052990000026001234567891' }]]);
    const expenses = [{ id: 'e1', supplierId: 's1', period: '2026-10', amountKop: 300000, status: 'paid' }, { id: 'e2', supplierId: 's2', period: '2026-10', amountKop: 150000, status: 'paid' }];
    const t = (id, extra) => ({ id, period: '2026-10', direction: 'out', kind: 'expense', status: 'done', category: 'supplier', amountKop: 150000, counterparty: {}, ...extra });
    const tx = [t('a', { expenseId: 'e1' }), t('b', { expenseId: 'e2' }), t('c', { counterparty: { account: 'UA21 3052 9900 0002 6001 2345 6789 0' } }),
        t('d', { category: 'bank_fee', amountKop: 500, counterparty: { code: '3124567809' } }),
        { id: 'r', period: '2026-10', direction: 'in', kind: 'refund', status: 'done', refundOf: 'a', amountKop: 20000 }];
    const fop = fopReport({ period: '2026-10', bankTx: tx, expenses, suppliers });
    assert.deepEqual(fop.income.map(x => [x.rnokpp, x.grossKop, x.paidKop]), [['3124567809', 300000, 280000]]);
    assert.ok(fop.checks.some(c => c.level === 'block' && /повернення/i.test(c.text)));
    const run = payroll.buildRun({ people: [{ ...emp, from: '2026-01-01' }], period: '2026-10' });
    const rep = r.payrollReport({ period: '2026-10', stored: { status: 'approved', run }, people: new Map([[emp.id, emp]]), otherIncome: fop.income });
    const f = rep.income.find(x => x.sign === '157');
    assert.deepEqual([f.grossKop, f.paidKop, f.pdfoKop, f.vzKop], [300000, 280000, 0, 0]);
    assert.equal(rep.summary.fopKop, 300000);
    assert.ok(r.payrollReport({ period: '2026-10', stored: { status: 'approved', run }, otherIncome: [{ ...fop.income[0], rnokpp: '' }] }).checks.some(c => /ФОП/.test(c.text)));
});
