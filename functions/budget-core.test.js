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

test('розшифровка статті: ті самі операції, що й факт; фізособу мешканцям не називаємо', () => {
    const expenses = [
        { item: 'lift', status: 'paid', period: '2027-02', date: '2027-02-28', amountKop: 1_082_237, supplierId: 's1', supplierName: 'ТОВ «Ліфт»', docType: 'act', number: 'Л-2', description: 'ТО ліфтів за лютий' },
        { item: 'lift', status: 'pending', period: '2027-02', date: '2027-02-28', amountKop: 1, supplierId: 's1', supplierName: 'ТОВ «Ліфт»', docType: 'act', number: 'Л-3' },
        { item: 'cleaning', status: 'approved', period: '2027-01', date: '2027-01-31', amountKop: 800_000, supplierId: 's2', supplierName: 'Петренко Ганна Іванівна', docType: 'act', number: '1', description: 'Прибирання (ЦПД)' }
    ];
    const bankOut = [
        { direction: 'out', kind: 'expense', status: 'done', category: 'esv', period: '2027-01', at: new Date('2027-01-20T10:00:00Z'), amountKop: 96_677,
            purpose: '*;101;ЄСВ за грудень', counterparty: { name: 'ГУ ДПС В ОДЕСЬКІЙ ОБЛ.', code: '44069166' } },
        { direction: 'out', kind: 'expense', status: 'done', category: 'salary', period: '2027-01', at: new Date('2027-01-31T10:00:00Z'), amountKop: 206_920,
            purpose: 'Заробітна плата Савченку О. за січень', counterparty: { name: 'САВЧЕНКО ОЛЕГ', code: '' } },
        { direction: 'out', kind: 'expense', status: 'done', category: 'salary', period: '2027-01', at: new Date('2027-01-15T10:00:00Z'), amountKop: 182_195,
            purpose: 'Аванс', counterparty: { name: 'ПРАЦІВНИК ОСББ', code: '' } },
        { direction: 'out', kind: 'expense', status: 'done', category: 'bank_fee', period: '2027-01', at: new Date('2027-01-31T22:30:00Z'), amountKop: 500,
            purpose: 'Комісія за платіж', counterparty: { name: 'АТ КБ ПРИВАТБАНК', code: '14360570' } },
        { direction: 'out', kind: 'expense', status: 'done', category: 'supplier', period: '2027-01', amountKop: 1_082_237, expenseId: 'e1', counterparty: {} }
    ];
    const suppliers = new Map([['s1', { kind: 'company' }], ['s2', { kind: 'person' }]]);
    const full = b.operationsByItem({ expenses, bankOut, year: '2027', suppliers, docTypes: { act: 'Акт' } });
    const fact = b.factByItem({ expenses, bankOut, year: '2027' });
    for (const [item, kop] of fact) assert.equal(full[item].reduce((s, o) => s + o.amountKop, 0), kop, item);
    assert.equal(full.salary[0].who, 'САВЧЕНКО ОЛЕГ');
    assert.equal(full.bank[0].date, '2027-02-01');                 // дата — київська
    assert.equal(full.lift[0].doc, 'Акт № Л-2');
    const pub = b.operationsByItem({ expenses, bankOut, year: '2027', suppliers, docTypes: { act: 'Акт' }, publicView: true });
    assert.deepEqual([pub.salary[0].who, pub.salary[0].what], ['Працівник ОСББ', undefined]);
    assert.ok(pub.salary.every(o => o.who === 'Працівник ОСББ'));
    assert.deepEqual([pub.cleaning[0].who, pub.cleaning[0].kind], ['Фізична особа', 'person']);
    assert.deepEqual([pub.esv[0].who, pub.esv[0].kind], ['ГУ ДПС В ОДЕСЬКІЙ ОБЛ.', 'company']);
    assert.equal(pub.lift[0].who, 'ТОВ «Ліфт»');
    assert.equal(b.payeeKind('ФОП Коваль І. І.', '3124567809'), 'fop');
    assert.equal(b.payeeKind('РЕМБУД ДЕМО ТОВ', ''), 'company');
    assert.equal(b.payeeKind('КОВАЛЬЧУК ІВАН ПЕТРОВИЧ', ''), 'person');
});

test('надходження й боржники: приміщення — номером лише за рішенням правління', () => {
    assert.equal(b.aptLabel('177', { entrance: '2' }, true), "Під'їзд 2, Квартира 177");
    assert.equal(b.aptLabel('302', { entrance: '1', nonres: true }, true), "Під'їзд 1, Нежитлове приміщення 302");
    assert.equal(b.aptLabel('177', { entrance: '2' }, false), 'Співвласник');
    const bankIn = [
        { direction: 'in', kind: 'income', category: 'rent', status: 'done', period: '2027-01', at: new Date('2027-01-05T10:00:00Z'), amountKop: 36000, relatedApt: '59', counterparty: { name: 'ІВАНЕНКО' } },
        { direction: 'in', kind: 'income', category: 'equipment', status: 'done', period: '2027-01', at: new Date('2027-01-06T10:00:00Z'), amountKop: 43235, counterparty: { name: 'ПрАТ "ЗВʼЯЗОК-ДЕМО"', code: '' } },
        { direction: 'in', kind: 'income', category: 'refund', status: 'done', period: '2027-01', at: new Date('2027-01-07T10:00:00Z'), amountKop: 41500, counterparty: { name: 'ПЕТРЕНКО ОЛЕГ' } },
        { direction: 'in', kind: 'payment', status: 'done', period: '2027-01', amountKop: 40000 }
    ];
    const pub = b.incomeOpsBySource({ bankIn, year: '2027', label: apt => b.aptLabel(apt, { entrance: '1' }, true), publicView: true });
    assert.deepEqual(Object.keys(pub).sort(), ['equipment', 'refund', 'rent']);
    assert.deepEqual([pub.rent[0].who, pub.equipment[0].who, pub.refund[0].who], ["Під'їзд 1, Квартира 59", 'ПрАТ "ЗВʼЯЗОК-ДЕМО"', 'Фізична особа']);
    const apts = [{ apt: '7', entrance: '1', balance: -6229.67 }, { apt: '191', entrance: '3', balance: -37321.47 }, { apt: '3А', entrance: '1', balance: -742.21 }, { apt: '9', balance: 10 }];
    assert.equal(b.houseDebt(apts).list, undefined);
    const debt = b.houseDebt(apts, apt => `Квартира ${apt}`);
    assert.deepEqual(debt.list.map(d => [d.apt, d.kop]), [['3А', 74221], ['7', 622967], ['191', 3732147]]);
    assert.equal(debt.totalKop, 74221 + 622967 + 3732147);
});
