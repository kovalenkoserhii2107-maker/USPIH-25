'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const p = require('./payroll-core');

const rate = p.rateFor('2026-10');
const emp = (extra = {}) => ({ id: 'e1', name: 'Працівник Тестовий', kind: 'employee', salaryKop: 864700, fte: 1, mainJob: true, iban: 'UA213052990000026001234567890', rnokpp: '3124567809', taxNotified: true, ...extra });

test('ставки й норма днів', () => {
    assert.deepEqual([rate.pdfo, rate.vz, rate.esv, rate.minWageKop], [1800, 500, 2200, 864700]);
    assert.equal(p.rateFor('2025-12'), null);
    assert.deepEqual([p.workingDays('2026-09'), p.workingDays('2026-10'), p.workingDays('2026-11')], [22, 22, 21]);
});

test('зарплата на рівні мінімальної: утримання, ЄСВ, аванс і решта', () => {
    const r = p.calcRow(emp(), {}, '2026-10', rate);
    assert.deepEqual([r.grossKop, r.pdfoKop, r.vzKop, r.netKop, r.esvKop], [864700, 155646, 43235, 665819, 190234]);
    // Аванс 50 %: ПДФО й ВЗ — у день виплати, решта — з остаточним розрахунком.
    assert.deepEqual(r.advance, { grossKop: 432350, pdfoKop: 77823, vzKop: 21618, netKop: 332909 });
    assert.deepEqual(r.final, { grossKop: 432350, pdfoKop: 77823, vzKop: 21617, netKop: 332910 });
    assert.equal(r.advance.netKop + r.final.netKop, r.netKop);
    assert.deepEqual(r.warnings, []);
});

test('ЄСВ з мінімальної бази й попередження про оклад нижче МЗП', () => {
    const low = p.calcRow(emp({ salaryKop: 400000 }), {}, '2026-10', rate);
    assert.equal(low.esvBaseKop, 864700);
    assert.equal(low.esvKop, 190234);
    assert.ok(low.warnings.some(w => /менший за мінімальну/.test(w)));
    // Пів ставки за основним місцем — мінімальна база пропорційна ставці.
    const half = p.calcRow(emp({ salaryKop: 432350, fte: 0.5 }), {}, '2026-10', rate);
    assert.deepEqual([half.esvBaseKop, half.esvKop, half.warnings.length], [432350, 95117, 0]);
    // Сумісник — без мінімальної бази.
    assert.equal(p.calcRow(emp({ salaryKop: 400000, mainJob: false }), {}, '2026-10', rate).esvBaseKop, 400000);
    // Неповний місяць: оклад і мінімальна база — пропорційно дням.
    const part = p.calcRow(emp(), { workedDays: 11 }, '2026-10', rate);
    assert.deepEqual([part.grossKop, part.esvBaseKop], [432350, 432350]);
});

test('договір ЦПД: сума акта, ПДФО, ВЗ і ЄСВ без мінімальної бази, без авансу', () => {
    const r = p.calcRow({ kind: 'gph' }, { actKop: 800000 }, '2026-10', rate);
    assert.deepEqual([r.grossKop, r.pdfoKop, r.vzKop, r.netKop, r.esvKop, r.advance.grossKop], [800000, 144000, 40000, 616000, 176000, 0]);
});

test('відомість місяця, платежі етапів і перевірки', () => {
    const people = [emp(), { id: 'g1', name: 'Виконавець Тестовий', kind: 'gph', iban: 'UA213052990000026001234567891', rnokpp: '' },
        emp({ id: 'old', name: 'Звільнений Тестовий', to: '2026-09-30' }), emp({ id: 'new', name: 'Новий Тестовий', from: '2026-11-03', taxNotified: false })];
    const run = p.buildRun({ people, inputs: { g1: { actKop: 800000 } }, period: '2026-10' });
    assert.deepEqual(run.rows.map(r => r.personId), ['e1', 'g1']);
    assert.equal(run.totals.grossKop, 1664700);
    assert.equal(run.totals.costKop, 1664700 + 190234 + 176000);
    assert.deepEqual(run.rows[1].problems, ['немає РНОКПП (потрібен для звіту ДПС)']);
    const taxes = { pdfo: { name: 'ГУК', iban: 'UA213052990000026001234567892', code: '37607526' }, vz: { name: 'ГУК', iban: 'UA213052990000026001234567893', code: '37607526' } };
    const map = new Map(people.map(x => [x.id, x]));
    const adv = p.stagePayments(run, 'advance', { code: '40562894', taxes, people: map });
    assert.deepEqual(adv.map(x => [x.key, x.amountKop]), [['advance:e1', 332909], ['advance:pdfo', 77823], ['advance:vz', 21618]]);
    assert.match(adv[1].purpose, /^\*;101;40562894;ПДФО із заробітної плати з авансу за жовтень 2026;;;$/);
    const fin = p.stagePayments(run, 'final', { code: '40562894', taxes, people: map });
    assert.deepEqual(fin.map(x => x.key), ['final:e1', 'final:g1', 'final:pdfo', 'final:vz', 'final:esv']);
    assert.equal(fin.find(x => x.key === 'final:esv').amountKop, 366234);
    assert.deepEqual(p.paymentProblems(fin), ['немає рахунку для «ESV» — внесіть у «Зарплата → Податки»']);
    // Аванс + решта = усе нараховане до виплати й утримане.
    const total = k => adv.concat(fin).filter(x => x.key.endsWith(k)).reduce((s, x) => s + x.amountKop, 0);
    assert.equal(total(':pdfo'), run.totals.pdfoKop);
    assert.equal(total(':vz'), run.totals.vzKop);
});

test('картка людини', () => {
    assert.equal(p.checkPerson(emp()), null);
    assert.match(p.checkPerson(emp({ name: 'Іван' })), /повністю/);
    assert.match(p.checkPerson(emp({ rnokpp: '1234567890' })), /контрольна/);
    assert.match(p.checkPerson(emp({ salaryKop: 0 })), /оклад/);
    assert.equal(p.checkPerson({ name: 'Виконавець Тестовий', kind: 'gph' }), null);
});
