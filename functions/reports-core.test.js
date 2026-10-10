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
        { stage: 'advance', key: 'e1', status: 'paid' }, { stage: 'advance', key: 'pdfo', status: 'paid' }, { stage: 'advance', key: 'vz', status: 'paid' },
        { stage: 'advance', key: 'esv', status: 'paid' }, { stage: 'final', key: 'e1', status: 'sent' }, { stage: 'final', key: 'esv', status: 'sent' }
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
    assert.deepEqual([es.days, es.normDays, es.topUpKop], [11, 22, 0]);
    assert.deepEqual(rep.relations.map(x => [x.personId, x.event, x.date]), [['e1', 'start', '2026-10-16'], ['g1', 'end', '2026-10-31']]);
    assert.deepEqual(rep.checks.map(c => c.level), ['block', 'warn', 'warn', 'info']);
    assert.match(rep.checks[0].text, /Виконавець Тестовий: немає правильного РНОКПП/);
    assert.equal(rep.summary.due, '2026-11-20');
});

test('без авансу остаточний розрахунок сплачує все нараховане', () => {
    const run = payroll.buildRun({ people: [{ ...emp, from: '2026-01-01' }], period: '2026-10' });
    const payments = ['e1', 'pdfo', 'vz', 'esv'].map(key => ({ stage: 'final', key, status: 'paid' }));
    const s = r.payrollReport({ period: '2026-10', stored: { status: 'approved', run }, people: new Map([[emp.id, emp]]), payments }).summary;
    assert.deepEqual([s.paidKop, s.pdfoPaidKop, s.vzPaidKop, s.esvPaidKop], [864700, 155646, 43235, 190234]);
});

test('без затвердженої відомості цифр немає, лише перешкода', () => {
    const draft = r.payrollReport({ period: '2026-11', stored: { status: 'draft', run: { rows: [{ grossKop: 1 }] } } });
    assert.deepEqual([draft.income.length, draft.summary.grossKop, draft.checks[0].level], [0, 0, 'block']);
    assert.match(r.payrollReport({ period: '2026-11', stored: null }).checks[0].text, /не складено/);
});
