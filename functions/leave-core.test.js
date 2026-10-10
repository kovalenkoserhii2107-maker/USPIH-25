'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const leave = require('./leave-core');
const payroll = require('./payroll-core');

const rate = payroll.rateFor('2026-10');
const emp = (extra = {}) => ({ id: 'e1', name: 'Працівник Тестовий', kind: 'employee', salaryKop: 864700, fte: 1, mainJob: true, insuranceYears: 6,
    iban: 'UA223052990000026001234567890', rnokpp: '3124567809', taxNotified: true, from: '2026-01-01', ...extra });
// Три місяці в застосунку: липень–вересень, повний оклад.
const history = [['2026-07', 31], ['2026-08', 31], ['2026-09', 30]].map(([period, calendarDays]) => ({ period, regularKop: 864700, calendarDays }));

test('середньоденна: історія застосунку, заробіток до застосунку, виключення днів', () => {
    assert.equal(leave.averageDaily({ mode: 'vacation', period: '2026-10', history }).avgKop, Math.round(864700 * 3 / 92));
    // Відпустка у вересні: для відпускних її дні й суми виключаються, для лікарняних — враховуються.
    const withVacation = [...history.slice(0, 2), { period: '2026-09', regularKop: 500000, vacationKop: 400000, vacationDays: 14, calendarDays: 30 }];
    assert.equal(leave.averageDaily({ mode: 'vacation', period: '2026-10', history: withVacation }).avgKop, Math.round((864700 * 2 + 500000) / (62 + 16)));
    assert.equal(leave.averageDaily({ mode: 'sick', period: '2026-10', history: withVacation }).avgKop, Math.round((864700 * 2 + 900000) / 92));
    const prior = { '2026-06': { kop: 800000, days: 30 } };
    assert.deepEqual(leave.averageDaily({ mode: 'vacation', period: '2026-10', history, prior }).months, 4);
});

test('відпустка: відпускні за календарні дні, оклад — за робочі дні без відпустки, відпускні — з авансом', () => {
    const r = payroll.calcRow(emp(), { absences: [{ type: 'vacation', from: '2026-10-12', to: '2026-10-25' }] }, '2026-10', rate, { history });
    const avg = Math.round(864700 * 3 / 92);
    assert.equal(r.vacationKop, avg * 14);
    assert.equal(r.workedDays, 12);
    assert.equal(r.regularKop, Math.round(864700 * 12 / 22));
    assert.equal(r.grossKop, r.regularKop + r.vacationKop);
    assert.equal(r.advance.grossKop, Math.round(r.regularKop / 2) + r.vacationKop);
    assert.ok(r.warnings.some(w => /за 3 дні до відпустки/.test(w)));
});

test('лікарняний: 70 % за стажем, перші 5 днів — ОСББ, решта — ПФУ; кошти ПФУ — окремо', () => {
    const r = payroll.calcRow(emp(), { absences: [{ type: 'sick', from: '2026-10-05', to: '2026-10-14' }] }, '2026-10', rate, { history });
    const perDay = Math.round(864700 * 3 / 92) * 70 / 100;
    assert.deepEqual([r.sickDays, r.sickEmployerDays, r.fundDays], [10, 5, 5]);
    assert.equal(r.sickKop, Math.round(perDay * 5));
    assert.equal(r.fundExpectKop, Math.round(perDay * 5));
    assert.equal(r.workedDays, 22 - 8);
    // Випадок почався 29.09 (2 дні у вересні): у жовтні ОСББ платить 3-й–5-й дні, решту — ПФУ.
    const cont = payroll.calcRow(emp(), { absences: [{ type: 'sick', from: '2026-10-01', to: '2026-10-06', caseStart: '2026-09-29' }] }, '2026-10', rate, { history });
    assert.deepEqual([cont.sickEmployerDays, cont.fundDays], [3, 3]);
    // Кошти ПФУ надійшли — у доході й базі ЄСВ.
    const paid = payroll.calcRow(emp(), { fundSickKop: 98690 }, '2026-11', payroll.rateFor('2026-11'), { history });
    assert.equal(paid.grossKop, 864700 + 98690);
    assert.equal(paid.fundSickKop, 98690);
    // Немає заробітку — лікарняний з мінімальної зарплати; відпустка — проблема.
    const fresh = payroll.calcRow(emp(), { absences: [{ type: 'sick', from: '2026-10-05', to: '2026-10-06' }, { type: 'vacation', from: '2026-10-20', to: '2026-10-21' }] }, '2026-10', rate, {});
    assert.equal(fresh.sickKop, Math.round(Math.round(864700 / 31) * 70 / 100 * 2));
    assert.equal(leave.leaveFor({ person: emp(), absences: [{ type: 'vacation', from: '2026-10-20', to: '2026-10-21' }], period: '2026-10', rate }).problems.length, 1);
});

test('перевірка відсутностей', () => {
    assert.equal(leave.checkAbsences([{ type: 'vacation', from: '2026-10-01', to: '2026-10-05' }], '2026-10'), null);
    assert.match(leave.checkAbsences([{ type: 'vacation', from: '2026-10-25', to: '2026-11-05' }], '2026-10'), /у кожну відомість/);
    assert.match(leave.checkAbsences([{ type: 'sick', from: '2026-10-01', to: '2026-10-05' }, { type: 'vacation', from: '2026-10-05', to: '2026-10-06' }], '2026-10'), /перетинаються/);
    assert.match(leave.checkAbsences([{ type: 'x', from: '2026-10-01', to: '2026-10-02' }], '2026-10'), /оберіть/);
    assert.deepEqual([leave.sickPercent(2), leave.sickPercent(3), leave.sickPercent(5), leave.sickPercent(8)], [50, 60, 70, 100]);
});

test('ПСП: зменшує базу ПДФО, межа доходу, пільга на дітей', () => {
    const half = emp({ salaryKop: 432350, fte: 0.5, psp: { kind: '169.1.1', from: '2026-01-10' } });
    const r = payroll.calcRow(half, {}, '2026-10', rate, {});
    assert.equal(r.pspKop, 166400);
    assert.equal(r.pspCode, '01');
    assert.equal(r.pdfoKop, Math.round((432350 - 166400) * 0.18));
    assert.equal(r.vzKop, Math.round(432350 * 0.05));
    // Дохід понад 4 660 грн — пільги немає; на трьох дітей — межа × 3.
    assert.equal(payroll.calcRow(emp({ psp: { kind: '169.1.1', from: '2026-01-10' } }), {}, '2026-10', rate, {}).pspKop, 0);
    const kids = payroll.calcRow(emp({ salaryKop: 1300000, psp: { kind: '169.1.2', children: 3, from: '2026-01-10' } }), {}, '2026-10', rate, {});
    assert.deepEqual([kids.pspKop, kids.pspCode], [166400 * 3, '02']);
    assert.match(payroll.checkPerson(emp({ psp: { kind: '169.1.2', children: 1, from: '2026-01-10' } })), /двох дітей/);
    assert.match(payroll.checkPerson(emp({ mainJob: false, psp: { kind: '169.1.1', from: '2026-01-10' } })), /основним/);
});
