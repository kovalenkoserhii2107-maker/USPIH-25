'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const b = require('./budget-core');

const budget = (extra = {}) => ({
    year: '2027', status: 'approved', decision: 'Протокол № 4 від 20.12.2026',
    lines: [
        { item: 'lift', title: '', planKop: 5_100_000 },
        { item: 'repair', title: 'Ремонт підʼїзду № 1', planKop: 3_000_000 },
        { item: 'repair', title: 'Ремонт покрівлі', planKop: 1_000_000 },
        { item: 'capital', title: 'Заміна ліфта', planKop: 20_000_000 },
        { item: 'bank', title: '', planKop: 180_000 }
    ],
    income: [{ source: 'contributions', planKop: 30_000_000 }, { source: 'rent', planKop: 3_600_000 }],
    ...extra
});

test('перевірка кошторису й рішення зборів', () => {
    assert.equal(b.checkBudget(budget()), null);
    assert.match(b.checkBudget(budget({ year: '19' })), /рік/);
    assert.match(b.checkBudget(budget({ lines: [{ item: 'x', planKop: 1 }] })), /стаття/);
    assert.match(b.checkBudget(budget({ lines: [{ item: 'lift', planKop: -1 }] })), /некоректна/);
    assert.match(b.checkBudget(budget({ lines: [{ item: 'lift', title: 'А', planKop: 1 }, { item: 'lift', title: 'а', planKop: 2 }] })), /повторюється/);
    assert.match(b.checkBudget(budget({ income: [{ source: 'rent', planKop: 1 }, { source: 'rent', planKop: 2 }] })), /повторюється/);
    assert.match(b.checkDecision(''), /загальні збори/);
    assert.equal(b.checkDecision('Протокол № 4'), null);
});

test('чинний кошторис: якщо новий не затвердили — діє попередній (п. 4.12.2)', () => {
    const list = [budget({ year: '2026' }), budget({ year: '2027', status: 'draft' })];
    assert.deepEqual([b.effectiveBudget(list, '2027').year, b.effectiveBudget(list, '2027').carried], ['2026', true]);
    assert.equal(b.effectiveBudget(list, '2026').carried, false);
    assert.equal(b.effectiveBudget(list, '2025'), null);
});

test('статті — у групах статуту й окремих кошторисах фондів', () => {
    assert.equal(b.sectionOf('capital'), 'repair');
    assert.equal(b.sectionOf('reserve'), 'reserve');
    assert.equal(b.sectionOf('lift'), 'main');
    assert.equal(b.groupOf('power'), 'utilities');
    assert.equal(b.groupOf('capital'), 'funds');
    assert.equal(b.groupOf('salary'), 'other');
});

test('факт: документи за місяцем послуги, списання без документа — за категорією', () => {
    const fact = b.factByItem({ year: '2027',
        expenses: [
            { item: 'lift', status: 'paid', period: '2027-01', amountKop: 425000 },
            { item: 'lift', status: 'approved', period: '2027-02', amountKop: 425000 },
            { item: 'lift', status: 'pending', period: '2027-02', amountKop: 1 },
            { item: 'lift', status: 'paid', period: '2026-12', amountKop: 425000 },
            { item: 'repair', status: 'paid', period: '2027-03', amountKop: 2_000_001 }
        ],
        bankOut: [
            { direction: 'out', kind: 'expense', status: 'done', category: 'bank_fee', period: '2027-01', amountKop: 15000 },
            { direction: 'out', kind: 'expense', status: 'done', category: 'supplier', period: '2027-01', amountKop: 425000, expenseId: 'e1' },
            { direction: 'out', kind: 'expense', status: 'review', category: null, period: '2027-01', amountKop: 999 },
            { direction: 'out', kind: 'internal', status: 'done', period: '2027-01', amountKop: 50000 },
            { direction: 'out', kind: 'expense', status: 'done', category: 'taxes', period: '2027-02', amountKop: 30000 }
        ] });
    assert.deepEqual([...fact.entries()].sort(), [['bank', 15000], ['lift', 850000], ['repair', 2_000_001], ['salary', 30000]]);
    const income = b.incomeFact({ year: '2027', bankIn: [
        { direction: 'in', kind: 'payment', status: 'done', period: '2027-01', amountKop: 100000 },
        { direction: 'in', kind: 'payment', status: 'review', period: '2027-01', amountKop: 5 },
        { direction: 'in', kind: 'income', status: 'done', category: 'rent', period: '2027-01', amountKop: 300000 },
        { direction: 'in', kind: 'internal', status: 'done', period: '2027-01', amountKop: 7 }
    ] });
    assert.deepEqual([...income.entries()].sort(), [['contributions', 100000], ['rent', 300000]]);
});

test('місяці обліку в році', () => {
    assert.equal(b.monthsElapsed('2026', '2026-10-09'), 1);       // облік з жовтня 2026
    assert.equal(b.monthsElapsed('2026', '2027-03-01'), 3);       // жовтень–грудень
    assert.equal(b.monthsElapsed('2027', '2027-03-15'), 3);
    assert.equal(b.monthsElapsed('2027', '2026-12-01'), 0);
});

test('план/факт: частки рядків однієї статті, поза кошторисом, підсумки', () => {
    const fact = new Map([['lift', 850000], ['repair', 2_000_001], ['salary', 30000]]);
    const income = new Map([['contributions', 100000], ['rent', 300000]]);
    const r = b.execution({ budget: budget(), fact, income, months: 3 });
    const main = r.sections.find(s => s.id === 'main');
    const repair = main.lines.filter(l => l.item === 'repair');
    // 3 000 000 і 1 000 000 плану ділять 2 000 001 факту як 3:1, сума частин — рівно факт.
    assert.deepEqual(repair.map(l => l.factKop), [1_500_001, 500_000]);
    assert.equal(main.lines.find(l => l.item === 'lift').toDateKop, 1_275_000);
    const outside = main.lines.find(l => l.outside);
    assert.deepEqual([outside.item, outside.factKop, outside.planKop], ['salary', 30000, 0]);
    assert.equal(r.sections.find(s => s.id === 'repair').title, 'Ремонтний фонд');
    assert.equal(r.totals.factKop, 850000 + 2_000_001 + 30000);
    assert.deepEqual(r.income.map(i => [i.source, i.planKop, i.factKop]), [['contributions', 30_000_000, 100000], ['rent', 3_600_000, 300000]]);
});

test('контроль кошторису для документа', () => {
    assert.equal(b.itemOverrun(null, 'lift', 0, 1), null);
    assert.equal(b.itemOverrun(budget(), 'lift', 4_675_000, 425_000), null);
    assert.match(b.itemOverrun(budget(), 'lift', 4_675_001, 425_000), /понад кошторис/);
    assert.match(b.itemOverrun(budget(), 'office', 0, 100), /немає в кошторисі/);
});

test('борг будинку — без прізвищ і номерів', () => {
    assert.deepEqual(b.houseDebt([{ balance: -1250.4 }, { balance: 210 }, { balance: -0.6 }, { balance: null }, { isAdmin: true, balance: -5 }]),
        { totalKop: 125100, count: 2 });
});
