'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const payroll = require('./payroll-core');
const reports = require('./reports-core');
const dps = require('./dps-xml');
const leave = require('./leave-core');
const budget = require('./budget-core');
const { reconcile } = require('./reconciliation-core');
const { fopReport } = require('./fop-report-core');

const org = { edrpou: '40562894', name: 'ОСББ «ТЕСТ»', katottg: 'UA51100270010069184', address: 'м. Одеса, вул. Тестова, 1', zip: '65101',
    kved: '81.10', sti: { reg: 15, raj: 53, code: 1553, name: 'Одеська ДПІ' }, headName: 'Голова Тестовий', headTin: '3124567809' };
const person = (extra = {}) => ({ id: 'e1', name: 'Працівник Тестовий Іванович', kind: 'employee', salaryKop: 432350, fte: 0.5, mainJob: true,
    from: '2026-01-01', rnokpp: '3124567809', iban: 'UA223052990000026001234567890', gender: 'Ч', taxNotified: true, ...extra });
const packageFor = (p, input = {}, extra = {}) => {
    const people = new Map([[p.id, p]]);
    const run = payroll.buildRun({ people: [p], period: '2026-10', inputs: { [p.id]: input } });
    const report = reports.payrollReport({ period: '2026-10', stored: { status: 'approved', run }, people, payments: extra.payments || [] });
    return { run, report, out: dps.buildPackage({ period: '2026-10', org, run, report, people, fillDate: '2026-11-12', ...extra }) };
};
const fields = (xml, tag) => [...xml.matchAll(new RegExp(`<${tag} ROWNUM="(\\d+)">([^<]+)</${tag}>`, 'g'))].map(m => ({ row: Number(m[1]), value: m[2] }));
const field = (xml, tag, row) => fields(xml, tag).find(f => f.row === row)?.value;
const total = (xml, tag) => Math.round(Number((xml.match(new RegExp(`<${tag}>([^<]+)</${tag}>`)) || [])[1]) * 100);

test('кошторис: кожна сума факту дорівнює сумі розшифровки, з поверненням торішньої комісії', () => {
    const bankOut = [
        { id: 'fee', period: '2026-12', direction: 'out', kind: 'expense', category: 'bank_fee', status: 'done', amountKop: 500 },
        { id: 'return', period: '2027-01', direction: 'in', kind: 'refund', status: 'done', refundOf: 'fee', amountKop: 300 },
        { id: 'new', period: '2027-01', direction: 'out', kind: 'expense', category: 'bank_fee', status: 'done', amountKop: 900 }
    ];
    const fact = budget.factByItem({ bankOut, year: '2027' });
    const ops = budget.operationsByItem({ bankOut, year: '2027' });
    assert.equal(fact.get('bank'), 600);
    assert.equal(ops.bank.reduce((s, r) => s + r.amountKop, 0), 600);
    assert.ok(ops.bank.some(r => r.amountKop === -300));
});

test('середня для щорічної відпустки включає попередні відпускні й лікарняні, для лікарняного — виключає лікарняні', () => {
    const history = [{ period: '2026-09', calendarDays: 30, regularKop: 400000, vacationKop: 300000, vacationDays: 10, sickKop: 100000, sickDays: 5 }];
    assert.deepEqual(leave.averageDaily({ mode: 'vacation', period: '2026-10', history }), { avgKop: 26667, earningsKop: 800000, days: 30, months: 1 });
    assert.deepEqual(leave.averageDaily({ mode: 'sick', period: '2026-10', history }), { avgKop: 28000, earningsKop: 700000, days: 25, months: 1 });
});

test('немає даних для середньої лікарняного — проблема; низька фактична середня не підмінюється МЗП', () => {
    const p = person({ insuranceYears: 10 });
    const abs = { type: 'sick', from: '2026-10-05', to: '2026-10-06' };
    const rate = payroll.rateFor('2026-10');
    const missing = leave.leaveFor({ person: p, absences: [abs], period: '2026-10', rate });
    assert.ok(missing.problems.some(p => /середньоденн/.test(p)));
    const low = leave.leaveFor({ person: p, absences: [{ ...abs, avgDailyKop: 1000 }], period: '2026-10', rate });
    assert.equal(low.sickKop, 2000);
});

test('дати відсутності й початку випадку — справжні календарні дати', () => {
    assert.match(leave.checkAbsences([{ type: 'sick', from: '2026-02-30', to: '2026-02-30' }], '2026-02'), /дат/);
    assert.match(leave.checkAbsences([{ type: 'sick', from: '2026-10-01', to: '2026-10-03', caseStart: '2026-09-31' }], '2026-10'), /дат|початок/);
});

test('мінімальна база ЄСВ: повний календарний місяць, а не збіг робочих днів; лікарняні не зменшують місячну МЗП', () => {
    const rate = payroll.rateFor('2026-11');
    const hired = payroll.calcRow(person({ from: '2026-11-02' }), {}, '2026-11', rate);
    assert.equal(hired.esvBaseKop, 432350); // 1 листопада — неділя; трудові відносини не весь місяць.
    const sick = payroll.calcRow(person({ insuranceYears: 10 }), { absences: [{ type: 'sick', from: '2026-10-05', to: '2026-10-07', avgDailyKop: 10000 }] }, '2026-10', rate);
    assert.equal(sick.esvBaseKop, 864700);
});

test('XML Д1: ЦПД — категорія 26; мінімальна різниця — окремий рядок типу 13', () => {
    const gph = packageFor(person({ kind: 'gph', fte: null }), { actKop: 123456 });
    assert.deepEqual(gph.out.problems, []);
    assert.equal(field(gph.out.files[1].xml, 'T1RXXXXG8', 1), '26');
    const half = packageFor(person());
    assert.deepEqual(half.out.problems, []);
    const xml = half.out.files[1].xml;
    const top = fields(xml, 'T1RXXXXG9').find(x => x.value === '13');
    assert.ok(top, 'мінімальна база має власний тип нарахувань');
    assert.equal(field(xml, 'T1RXXXXG16', top.row), undefined);
    assert.equal(field(xml, 'T1RXXXXG18', top.row), '4323.50');
    assert.equal(field(xml, 'T1RXXXXG20', top.row), '951.17');
    assert.equal(field(xml, 'T1RXXXXG20', 1), '951.17');
    assert.equal(total(xml, 'R01G20'), 190234);
});

test('XML: відпускні — тип 10, максимальна база спільна для зарплати й лікарняного, ЄСВ не відʼємний', () => {
    const lv = packageFor(person(), { absences: [{ type: 'vacation', from: '2026-10-12', to: '2026-10-25', avgDailyKop: 12000 }] });
    assert.deepEqual(lv.out.problems, []);
    assert.ok(fields(lv.out.files[1].xml, 'T1RXXXXG9').some(x => x.value === '10'));
    const high = packageFor(person({ salaryKop: 30000000, fte: 1, insuranceYears: 10 }), {
        absences: [{ type: 'sick', from: '2026-10-05', to: '2026-10-09', avgDailyKop: 1000000 }]
    });
    assert.deepEqual(high.out.problems, []);
    const main = high.out.files[0].xml, d1 = high.out.files[1].xml;
    assert.equal(total(main, 'R0102G3'), 17294000);
    assert.equal(total(d1, 'R01G17') + total(d1, 'R01G18'), 17294000);
    assert.ok(fields(d1, 'T1RXXXXG20').every(x => Number(x.value) >= 0));
    assert.equal(total(main, 'R0103G3'), total(main, 'R01031G3') + total(main, 'R01035G3'));
    assert.equal(total(d1, 'R01G20'), high.run.totals.esvKop);
});

test('XML не обходить блокувальні перевірки звіту та не підставляє змінений РНОКПП', () => {
    const p = person(), people = new Map([[p.id, p]]);
    const run = payroll.buildRun({ people: [p], period: '2026-10' });
    run.rows[0].payee.rnokpp = '';
    const report = reports.payrollReport({ period: '2026-10', stored: { status: 'approved', run }, people });
    let out = dps.buildPackage({ period: '2026-10', org, run, report, people, fillDate: '2026-11-12' });
    assert.equal(out.files.length, 0);
    assert.ok(out.problems.some(x => /РНОКПП/.test(x)));
    const broken = packageFor(p, {}, { payments: [{ status: 'paid', stage: 'final', key: p.id, amountKop: 1 }] });
    assert.equal(broken.out.files.length, 0);
    assert.ok(broken.out.problems.some(x => /виплат/.test(x)));
});

test('уточнення, перерахунок за минулий місяць і ПФУ без місяця хвороби потребують окремих рядків, а не повного звітного XML', () => {
    for (const [input, extra, match] of [
        [{}, { stan: 3 }, /уточн/i],
        [{}, { stan: 2 }, /новий|кориг/i],
        [{ correctionKop: -10000, correctionFor: '2026-09' }, {}, /перерахунок|минул/i],
        [{ fundSickKop: 12000 }, {}, /ПФУ|лікарнян/]
    ]) {
        const { out } = packageFor(person(), input, extra);
        assert.equal(out.files.length, 0);
        assert.ok(out.problems.some(x => match.test(x)), JSON.stringify(out.problems));
    }
});

test('Д5 із подіями без виплати теж потребує правильного РНОКПП', () => {
    const p = person({ kind: 'gph', from: '2026-10-01', to: '2026-10-10', rnokpp: '' });
    const run = payroll.buildRun({ people: [p], period: '2026-10' });
    run.rows = []; // акт ще не нараховано, але відносини були.
    const report = reports.payrollReport({ period: '2026-10', stored: { status: 'approved', run }, people: new Map([[p.id, p]]) });
    assert.ok(report.checks.some(x => x.level === 'block' && /РНОКПП/.test(x.text)));
});

test('звірка повернень: пізніший місяць не ламає попередній, пошкоджений зворотний звʼязок блокує', () => {
    const bankTx = [
        { id: 'o', period: '2026-10', direction: 'out', kind: 'expense', status: 'done', category: 'bank_fee', amountKop: 1000, refundedKop: 500, refundTxIds: ['r1', 'r2'] },
        { id: 'r1', period: '2026-10', direction: 'in', kind: 'refund', status: 'done', amountKop: 200, refundOf: 'o' },
        { id: 'r2', period: '2026-11', direction: 'in', kind: 'refund', status: 'done', amountKop: 300, refundOf: 'o' }
    ];
    assert.deepEqual(reconcile({ period: '2026-10', bankTx }), []);
    bankTx[2].refundOf = 'another';
    assert.ok(reconcile({ period: '2026-10', bankTx }).some(x => /повернен|Повернення|Списання/.test(x.text)));
});

test('4ДФ ФОП: ознака 157, один дохід для рахунку й акта, фактична дата оплати, збережений код', () => {
    const supplierSnapshot = { kind: 'fop', code: '3124567809', name: 'ФОП Тестовий', fopChecked: true };
    const expenses = [
        { id: 'inv', supplierId: 's', supplierSnapshot, period: '2026-10', amountKop: 100000, status: 'paid' },
        { id: 'act', supplierId: 's', supplierSnapshot, period: '2026-10', amountKop: 100000, status: 'linked', linkedTo: 'inv' }
    ];
    const suppliers = new Map([['s', { ...supplierSnapshot, code: '0000000000', name: 'Змінена картка' }]]);
    const bankTx = [{ id: 'pay', period: '2026-11', direction: 'out', status: 'done', kind: 'expense', category: 'supplier', paymentId: 'p1', expenseId: 'inv', amountKop: 100000,
        counterparty: { code: '3124567809' } }];
    const october = fopReport({ period: '2026-10', expenses, suppliers, bankTx });
    const november = fopReport({ period: '2026-11', expenses, suppliers, bankTx });
    assert.deepEqual(october.income.map(r => [r.rnokpp, r.sign, r.grossKop, r.paidKop, r.pdfoKop, r.vzKop]), [['3124567809', '157', 100000, 0, 0, 0]]);
    assert.deepEqual(november.income.map(r => [r.grossKop, r.paidKop]), [[0, 100000]]);
    assert.deepEqual([...october.checks, ...november.checks], []);
    const empty = payroll.buildRun({ people: [], period: '2026-10' });
    const report = reports.payrollReport({ period: '2026-10', stored: { status: 'approved', run: empty }, otherIncome: october.income });
    assert.equal(report.summary.grossKop, 100000);
    assert.equal(report.summary.esvKop, 0);
    const out = dps.buildPackage({ period: '2026-10', org, run: empty, report, fillDate: '2026-11-12' });
    assert.deepEqual(out.problems, []);
    assert.equal(field(out.files[2].xml, 'T1RXXXXG05', 1), '157');
    assert.equal(total(out.files[2].xml, 'R01G03A'), 100000);
});

test('4ДФ: відомість з неправильними підсумками не дозволяє XML; РНОКПП без виплат з Д5 теж перевіряється', () => {
    const p = person(), run = payroll.buildRun({ people: [p], period: '2026-10' });
    run.totals.esvKop++;
    const report = reports.payrollReport({ period: '2026-10', stored: { status: 'approved', run } });
    assert.ok(report.checks.some(c => c.level === 'block' && /підсумк/.test(c.text)));
    assert.equal(dps.buildPackage({ period: '2026-10', org, run, report, people: new Map([[p.id, p]]), fillDate: '2026-11-12' }).files.length, 0);
});

test('XML: 100 незалежних сум — база, ЄСВ і підсумки Д1/розрахунку точні до копійки', () => {
    let seed = 41237;
    const random = max => { seed = (seed * 48271) % 2147483647; return seed % max; };
    for (let i = 0; i < 100; i++) {
        const { run, out } = packageFor(person({ salaryKop: 1 + random(35000000), fte: 1, insuranceYears: 10 }), {
            absences: [
                { type: 'vacation', from: '2026-10-12', to: '2026-10-16', avgDailyKop: 1 + random(50000) },
                { type: 'sick', from: '2026-10-19', to: '2026-10-21', avgDailyKop: 1 + random(50000) }
            ]
        });
        assert.deepEqual(out.problems, [], `sample ${i}`);
        const main = out.files[0].xml, d1 = out.files[1].xml;
        assert.equal(total(d1, 'R01G16'), run.totals.grossKop);
        assert.equal(total(d1, 'R01G20'), run.totals.esvKop);
        assert.equal(total(main, 'R0102G3'), run.rows[0].esvBaseKop);
        assert.equal(total(main, 'R0103G3'), total(main, 'R01031G3') + total(main, 'R01035G3'));
        const bases = [...fields(d1, 'T1RXXXXG17'), ...fields(d1, 'T1RXXXXG18')];
        const contributions = fields(d1, 'T1RXXXXG20');
        assert.equal(bases.reduce((s, r) => s + Math.round(Number(r.value) * 100), 0), run.rows[0].esvBaseKop);
        for (const r of bases) assert.equal(Math.round(Number(field(d1, 'T1RXXXXG20', r.row)) * 100), Number((BigInt(Math.round(Number(r.value) * 100)) * 22n + 50n) / 100n));
        assert.ok(contributions.every(r => Number(r.value) >= 0));
    }
});
