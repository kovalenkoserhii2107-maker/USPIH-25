'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const p = require('./payroll-core');

const rate = p.rateFor('2026-10');
const emp = (extra = {}) => ({ id: 'e1', name: 'Працівник Тестовий', kind: 'employee', salaryKop: 864700, fte: 1, mainJob: true, iban: 'UA223052990000026001234567890', rnokpp: '3124567809', taxNotified: true, ...extra });

test('ставки й норма днів', () => {
    assert.deepEqual([rate.pdfo, rate.vz, rate.esv, rate.minWageKop], [1800, 500, 2200, 864700]);
    assert.equal(p.rateFor('2025-12'), null);
    assert.equal(p.rateFor('2027-01'), null);
    assert.deepEqual([p.workingDays('2026-09'), p.workingDays('2026-10'), p.workingDays('2026-11')], [22, 22, 21]);
});

test('зарплата на рівні мінімальної: утримання, ЄСВ, аванс і решта', () => {
    const r = p.calcRow(emp(), {}, '2026-10', rate);
    assert.deepEqual([r.grossKop, r.pdfoKop, r.vzKop, r.netKop, r.esvKop], [864700, 155646, 43235, 665819, 190234]);
    // Аванс 50 %: ПДФО й ВЗ — у день виплати, решта — з остаточним розрахунком.
    assert.deepEqual(r.advance, { grossKop: 432350, pdfoKop: 77823, vzKop: 21618, netKop: 332909, esvKop: 95117 });
    assert.deepEqual(r.final, { grossKop: 432350, pdfoKop: 77823, vzKop: 21617, netKop: 332910, esvKop: 95117 });
    assert.equal(r.advance.netKop + r.final.netKop, r.netKop);
    assert.deepEqual(r.warnings, []);
});

test('ЄСВ з мінімальної бази й попередження про оклад нижче МЗП', () => {
    const low = p.calcRow(emp({ salaryKop: 400000 }), {}, '2026-10', rate);
    assert.equal(low.esvBaseKop, 864700);
    assert.equal(low.esvKop, 190234);
    assert.ok(low.warnings.some(w => /менший за мінімальну/.test(w)));
    // Пів ставки за основним місцем — повна мінімальна база незалежно від ставки.
    const half = p.calcRow(emp({ salaryKop: 432350, fte: 0.5 }), {}, '2026-10', rate);
    assert.deepEqual([half.esvBaseKop, half.esvKop, half.warnings.length], [864700, 190234, 1]);
    // Сумісник — без мінімальної бази.
    assert.equal(p.calcRow(emp({ salaryKop: 400000, mainJob: false }), {}, '2026-10', rate).esvBaseKop, 400000);
    // Менше відпрацьованих днів за повний місяць трудових відносин: мінімальна база не зменшується.
    const part = p.calcRow(emp(), { workedDays: 11 }, '2026-10', rate);
    assert.deepEqual([part.grossKop, part.esvBaseKop], [432350, 864700]);
});

test('договір ЦПД: сума акта, ПДФО, ВЗ і ЄСВ без мінімальної бази, без авансу', () => {
    const r = p.calcRow({ kind: 'gph' }, { actKop: 800000 }, '2026-10', rate);
    assert.deepEqual([r.grossKop, r.pdfoKop, r.vzKop, r.netKop, r.esvKop, r.advance.grossKop], [800000, 144000, 40000, 616000, 176000, 0]);
});

test('відомість місяця, платежі етапів і перевірки', () => {
    const people = [emp(), { id: 'g1', name: 'Виконавець Тестовий', kind: 'gph', iban: 'UA923052990000026001234567891', rnokpp: '' },
        emp({ id: 'old', name: 'Звільнений Тестовий', to: '2026-09-30' }), emp({ id: 'new', name: 'Новий Тестовий', from: '2026-11-03', taxNotified: false })];
    const run = p.buildRun({ people, inputs: { g1: { actKop: 800000 } }, period: '2026-10' });
    assert.deepEqual(run.rows.map(r => r.personId), ['e1', 'g1']);
    assert.equal(run.totals.grossKop, 1664700);
    assert.equal(run.totals.costKop, 1664700 + 190234 + 176000);
    assert.deepEqual(run.rows[1].problems, ['немає РНОКПП (потрібен для звіту ДПС)']);
    const taxes = { pdfo: { name: 'ГУК', iban: 'UA653052990000026001234567892', code: '37607526' }, vz: { name: 'ГУК', iban: 'UA383052990000026001234567893', code: '37607526' } };
    const map = new Map(people.map(x => [x.id, x]));
    assert.match(p.paymentProblems(p.stagePayments(run, 'advance', { code: '40562894', taxes, people: map }))[0], /ESV/);
    taxes.esv = { name: 'ГУК', iban: 'UA906543210000000260323012024', code: '37607526' };
    const adv = p.stagePayments(run, 'advance', { code: '40562894', taxes, people: map });
    assert.deepEqual(adv.map(x => [x.key, x.amountKop]), [['advance:person:e1', 332909], ['advance:tax:pdfo', 77823], ['advance:tax:vz', 21618], ['advance:tax:esv', 95117]]);
    assert.match(adv[1].purpose, /^\*;101;40562894;ПДФО із заробітної плати з авансу за жовтень 2026;;;$/);
    const fin = p.stagePayments(run, 'final', { code: '40562894', taxes, people: map });
    assert.deepEqual(fin.map(x => x.key), ['final:person:e1', 'final:person:g1', 'final:tax:pdfo', 'final:tax:vz', 'final:tax:esv']);
    assert.equal(fin.find(x => x.key === 'final:tax:esv').amountKop, 271117);
    assert.match(p.paymentProblems(fin)[0], /Код отримувача/); // ЦПД без РНОКПП не можна відправити.
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

test('ЄСВ: спільна межа і мінімальна база за трудовим договором та ЦПД однієї фізособи', () => {
    const gph = { ...emp({ id: 'g1' }), kind: 'gph' };
    const large = p.buildRun({ people: [emp({ salaryKop: 20000000 }), gph], inputs: { g1: { actKop: 5000000 } }, period: '2026-10' });
    assert.equal(large.rows.reduce((s, r) => s + r.esvBaseKop, 0), rate.minWageKop * rate.maxBaseMult);
    assert.equal(large.rows[1].esvBaseKop, 0);
    assert.equal(large.totals.esvKop, Math.round(rate.minWageKop * rate.maxBaseMult * .22));
    const small = p.buildRun({ people: [emp({ salaryKop: 200000 }), gph], inputs: { g1: { actKop: 300000 } }, period: '2026-10' });
    assert.equal(small.rows.reduce((s, r) => s + r.esvBaseKop, 0), rate.minWageKop);
    assert.equal(small.rows.reduce((s, r) => s + r.esvParts.filter(p => p.kind === 'topup').reduce((n, p) => n + p.baseKop, 0), 0), 364700);
    for (const r of small.rows) assert.equal(r.advance.esvKop + r.final.esvKop, r.esvKop);
});

test('перед виплатою перевіряються всі реквізити, не лише IBAN', () => {
    const list = p.stagePayments(p.buildRun({ people: [emp()], period: '2026-10' }), 'final', { code: '40562894', taxes: {
        pdfo: { iban: 'UA653052990000026001234567892' }, vz: { iban: 'UA383052990000026001234567893', name: 'ГУК', code: '' },
        esv: { iban: 'UA906543210000000260323012024', name: 'ГУК', code: '37607526' }
    } });
    assert.ok(p.paymentProblems(list).some(s => /ПДФО|PDFO/.test(s) && /отримувача/.test(s)));
    assert.ok(p.paymentProblems(list).some(s => /VZ/.test(s) && /Код/.test(s)));
});
test('дві трудові картки однієї фізособи не допускають подвійної ПСП або неузгодженого табеля',()=>{
    const run=p.buildRun({people:[emp(),emp({id:'internal'})],period:'2026-10'});
    assert.match(run.error,/однієї фізособи в одну картку/);
});

test('withDefaultTaxes заповнює бюджетні рахунки ПДФО, ВЗ і ЄСВ за замовчуванням без помилок валідації', () => {
    const run = p.buildRun({ people: [emp()], period: '2026-10' });
    const taxes = p.withDefaultTaxes({});
    const adv = p.stagePayments(run, 'advance', { code: '40562894', taxes });
    assert.deepEqual(p.paymentProblems(adv), []);
});

test('withDefaultTaxes не змішує свій IBAN із типовими назвою й кодом: типовий отримувач — лише замість порожнього', () => {
    const own = { name: '', iban: 'UA538999980313010101000099999', code: '' };
    const taxes = p.withDefaultTaxes({ pdfo: own });
    assert.equal(taxes.pdfo.iban, own.iban);
    assert.equal(taxes.pdfo.name, '');
    assert.equal(taxes.pdfo.code, '');
    assert.deepEqual(taxes.vz, p.DEFAULT_TAXES.vz);
});
