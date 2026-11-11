'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const j = require('./journal-core');

const OWN = 'UA213052990000026001234567890';
const RES = 'UA563052990000026005000012345';
const at = s => new Date(`${s}T10:00:00Z`);

const input = () => ({
    ledgers: new Map([
        ['45', [
            { kind: 'opening', period: '2026-09', amountKop: -125040 },
            { kind: 'charge', period: '2026-10', amountKop: 39182, parts: [{ component: 'main', amountKop: 29248 }, { component: 'light', amountKop: 3072 }, { component: 'lift', amountKop: 4032 }, { component: 'waste', amountKop: 2830 }] },
            { kind: 'payment', period: '2026-10', amountKop: 40000 }          // з виписки — у проводки не йде вдруге
        ]],
        ['298', [{ kind: 'opening', period: '2026-09', amountKop: 586305 }, { kind: 'charge', period: '2026-10', amountKop: 39182 }]]
    ]),
    bankTx: [
        { id: 'p1', account: OWN, at: at('2026-10-08'), period: '2026-10', direction: 'in', kind: 'payment', status: 'done', amountKop: 40000, allocations: [{ apt: '45', amountKop: 40000 }] },
        { id: 'r1', account: OWN, at: at('2026-10-05'), period: '2026-10', direction: 'in', kind: 'income', category: 'rent', status: 'done', amountKop: 36000 },
        { id: 'q1', account: OWN, at: at('2026-10-06'), period: '2026-10', direction: 'in', kind: 'payment', status: 'review', amountKop: 5000 },
        { id: 'd1', account: OWN, at: at('2026-10-03'), period: '2026-10', direction: 'out', kind: 'expense', category: 'supplier', status: 'done', expenseId: 'e1', amountKop: 1082237, counterparty: { name: 'ТОВ ЛІФТ' } },
        { id: 'f1', account: OWN, at: at('2026-10-03'), period: '2026-10', direction: 'out', kind: 'expense', category: 'bank_fee', status: 'done', amountKop: 500 },
        { id: 'a1', account: OWN, at: at('2026-10-04'), period: '2026-10', direction: 'out', kind: 'expense', category: 'supplier', status: 'done', amountKop: 100000, counterparty: { name: 'ТОВ АВАНС' } },
        { id: 'i1', account: OWN, at: at('2026-10-08'), period: '2026-10', direction: 'out', kind: 'internal', status: 'done', amountKop: 3091720, counterparty: { account: RES } },
        { id: 'i2', account: RES, at: at('2026-10-08'), period: '2026-10', direction: 'in', kind: 'internal', status: 'done', amountKop: 3091720 },
        { id: 'old', account: OWN, at: at('2026-09-20'), period: '2026-09', direction: 'in', kind: 'payment', status: 'done', amountKop: 999 }
    ],
    expenses: [
        { id: 'e1', status: 'paid', period: '2026-09', date: '2026-09-30', amountKop: 1082237, item: 'lift', supplierName: 'ТОВ ЛІФТ', number: 'L-9' },
        { id: 'e2', status: 'approved', period: '2026-10', date: '2026-10-31', amountKop: 279400, item: 'repair', supplierName: 'ТОВ ДАХ', number: 'Д-17' },
        { id: 'e3', status: 'pending', period: '2026-10', date: '2026-10-20', amountKop: 1, item: 'other', supplierName: 'X', number: '1' }
    ]
});

test('проводки з операцій: Дт = Кт, 377 = баланс співвласника, 311 = рух за випискою', () => {
    const entries = j.journal(input(), '2026-10');
    const tb = j.trialBalance(entries, '2026-10');
    assert.equal(tb.balanced, true);
    const acc = a => tb.rows.find(r => r.acc === a);
    // кв. 45: борг 1 250,40 + 391,82 − 400 = 1 242,22; кв. 298: переплата 5 863,05 − 391,82.
    const r377 = acc('377');
    assert.deepEqual(r377.byA.find(x => x.a === '45'), { a: '45', openDr: 125040, openCr: 0, dr: 39182, cr: 40000, closeDr: 124222, closeCr: 0 });
    assert.equal(r377.byA.find(x => x.a === '298').closeCr, 586305 - 39182);
    // 311 поточний: +400 +360 +50 (нерозібране) −10 822,37 −5 −1 000 −30 917,20; резервний: +30 917,20.
    const own = acc('311').byA.find(x => x.a === OWN);
    assert.equal(own.dr - own.cr, 40000 + 36000 + 5000 - 1082237 - 500 - 100000 - 3091720);
    assert.equal(acc('311').byA.find(x => x.a === RES).dr, 3091720);
    // Нерозібране — на 685; аванс без документа — Дт 631.
    assert.equal(acc('685').closeCr, 5000);
    assert.equal(acc('631').byA.find(x => x.a === 'ТОВ АВАНС').closeDr, 100000);
    // Внески за складовими — Кт 48.
    assert.deepEqual(acc('48').byA.filter(x => x.cr).map(x => x.a).sort(), ['lift', 'light', 'main', 'waste']);
    // Документ: акт вересня — у вхідному сальдо 92→ закрито; ремонт жовтня — Дт 92 Кт 631, затверджений, ще не сплачений.
    assert.equal(acc('631').byA.find(x => x.a === 'ТОВ ДАХ').closeCr, 279400);
    // Кінець місяця: 92 і 79 закрито, витрати покрито з 48; оренда — теж цільове (Кт 48), результат 0 — як у звітності ОСББ.
    assert.equal(acc('92').closeDr + acc('92').closeCr, 0);
    assert.equal(acc('79').closeDr + acc('79').closeCr, 0);
    assert.equal(acc('44'), undefined);
    assert.ok(acc('48').byA.find(x => x.a === 'main').cr >= 36000);
    assert.ok(!entries.some(e => e.ref === 'old' || e.ref === 'i2' || e.ref === 'e3'));
});

test('вхідні залишки — на технічному 00, вересневий документ — у вхідному сальдо', () => {
    const tb = j.trialBalance(j.journal(input(), '2026-10'), '2026-10');
    const r00 = tb.rows.find(r => r.acc === '00');
    assert.equal(r00.openDr - r00.openCr, 586305 - 125040 + 1082237);
    // Акт за вересень (до початку обліку) — вхідний борг Кт 631; оплата в жовтні його закриває, авансу немає.
    const lift = tb.rows.find(r => r.acc === '631').byA.find(x => x.a === 'ТОВ ЛІФТ');
    assert.deepEqual([lift.openCr, lift.dr, lift.closeDr, lift.closeCr], [1082237, 1082237, 0, 0]);
});

test('вхідна ОСВ: рядки проти 00, баланс з автоматичними залишками, 00 закривається в нуль', () => {
    const data = input();
    const auto = j.buildEntries(data).filter(e => e.src === 'opening');
    const lines = [{ acc: '311', a: OWN, side: 'dr', kop: 2000000 }, { acc: '48', a: 'main', side: 'cr', kop: 456498, memo: 'Залишок цільового фінансування' }];
    assert.equal(j.checkOpening(lines), null);
    assert.deepEqual(j.openingTotals(auto, lines), { autoDr: 125040, autoCr: 586305 + 1082237, dr: 2125040, cr: 2125040, diff: 0 });
    assert.match(j.checkOpening([{ acc: '377', side: 'dr', kop: 1 }]), /автоматично/);
    assert.match(j.checkOpening([{ acc: '311', a: 'каса', side: 'dr', kop: 1 }]), /IBAN/);
    assert.match(j.checkOpening([{ acc: '631', side: 'cr', kop: 1 }]), /постачальника/);
    assert.match(j.checkOpening([{ acc: '48', side: 'cr', kop: 1 }, { acc: '48', side: 'dr', kop: 2 }]), /обʼєднайте/);

    // Чернетка не потрапляє в проводки; затверджена — закриває 00 і дає залишок 311 на 01.10.
    const draft = j.trialBalance(j.journal({ ...data, opening: { status: 'draft', lines } }, '2026-10'), '2026-10');
    assert.ok(draft.rows.find(r => r.acc === '00'));
    const tb = j.trialBalance(j.journal({ ...data, opening: { status: 'approved', lines } }, '2026-10'), '2026-10');
    assert.equal(tb.rows.find(r => r.acc === '00'), undefined);
    assert.equal(tb.rows.find(r => r.acc === '311').byA.find(x => x.a === OWN).openDr, 2000000);
    assert.ok(tb.balanced);
    const checks = j.closeChecks({ period: '2026-10', today: '2026-11-02', chargedPeriods: new Set(['2026-10']), tb, openingStatus: 'approved' });
    assert.ok(!checks.some(c => /оборотно-сальдову|рахунку 00/.test(c.text)));
    // Затверджена ОСВ, але 00 не в нулі (змінились залишки квартир) — закрити не можна.
    const off = j.trialBalance(j.journal({ ...data, opening: { status: 'approved', lines: lines.slice(0, 1) } }, '2026-10'), '2026-10');
    assert.ok(j.closeChecks({ period: '2026-10', today: '2026-11-02', chargedPeriods: new Set(['2026-10']), tb: off, openingStatus: 'approved' })
        .some(c => c.level === 'block' && /лишилось 4564\.98 грн за кредитом/.test(c.text)));
});

test('перевірки перед закриттям', () => {
    const data = input();
    const tb = j.trialBalance(j.journal(data, '2026-10'), '2026-10');
    const checks = j.closeChecks({ period: '2026-10', today: '2026-10-20', bankTx: data.bankTx, expenses: data.expenses, chargedPeriods: new Set(['2026-10']), closed: [], tb });
    const blocks = checks.filter(c => c.level === 'block').map(c => c.text);
    assert.equal(blocks.length, 4);
    assert.match(blocks[0], /ще не скінчився/);
    assert.match(blocks[1], /чекають рішення.*1/);
    assert.match(blocks[2], /Документи чекають затвердження/);
    assert.match(blocks[3], /Вхідну оборотно-сальдову/);
    assert.ok(checks.some(c => c.level === 'warn' && /ТОВ АВАНС/.test(c.text)));
    data.bankTx = data.bankTx.filter(t => t.status !== 'review');
    data.expenses = data.expenses.filter(e => e.status !== 'pending');
    const ok = j.closeChecks({ period: '2026-10', today: '2026-11-01', bankTx: data.bankTx, expenses: data.expenses, chargedPeriods: new Set(['2026-10']), closed: [], tb, strictOpening:false });
    assert.equal(ok.at(-1).level, 'ok');
    const nov = j.closeChecks({ period: '2026-11', today: '2026-12-01', bankTx: [], expenses: [], chargedPeriods: new Set(), closed: [], tb, strictOpening:false });
    assert.deepEqual(nov.filter(c => c.level === 'block').map(c => c.text.slice(0, 20)), ['Спершу закрийте попе', 'Внески за цей місяць']);
});

test('відбиток місяця змінюється, коли змінюються операції', () => {
    const data = input();
    const a = j.entriesKey(j.journal(data, '2026-10'), '2026-10');
    data.bankTx[1].amountKop = 37000;
    assert.notEqual(j.entriesKey(j.journal(data, '2026-10'), '2026-10'), a);
    assert.deepEqual(j.periodsUpTo('2027-01'), ['2026-10', '2026-11', '2026-12', '2027-01']);
    assert.equal(j.lastDay('2026-02'), '2026-02-28');
});

test('зарплата: нараховано 92/661, утримано 661/641, ЄСВ 92/651; виплати за відомістю закривають рахунки', () => {
    const OWN = 'UA213052990000026001234567890';
    const at = s => new Date(`${s}T10:00:00Z`);
    const run = { rows: [{ name: 'Працівник Т.', kind: 'employee', grossKop: 864700, pdfoKop: 155646, vzKop: 43235, esvKop: 190234 }] };
    const pays = [['p1', 'e1', 332909], ['p2', 'pdfo', 77823], ['p3', 'vz', 21618], ['p4', 'e1', 332910], ['p5', 'pdfo', 77823], ['p6', 'vz', 21617], ['p7', 'esv', 190234]];
    const input = {
        payrollRuns: [{ period: '2026-10', status: 'approved', run }, { period: '2026-11', status: 'draft', run }],
        payrollPayments: new Map(pays.map(([id, key]) => [id, { key, name: key === 'e1' ? 'Працівник Т.' : 'ГУК' }])),
        bankTx: pays.map(([id, , kop], i) => ({ id: `t${i}`, account: OWN, at: at(i < 3 ? '2026-10-15' : '2026-10-30'), period: '2026-10', direction: 'out', kind: 'expense',
            category: id === 'p7' ? 'esv' : 'salary', status: 'done', paymentId: id, amountKop: kop }))
    };
    const tb = j.trialBalance(j.journal(input, '2026-10'), '2026-10');
    const acc = a => tb.rows.find(r => r.acc === a);
    assert.equal(tb.balanced, true);
    for (const a of ['661', '641', '651']) assert.equal(acc(a).closeDr + acc(a).closeCr, 0, a);
    // Витрати місяця: зарплата + ЄСВ, покриті цільовим фінансуванням.
    assert.equal(acc('92').dr, 864700 + 190234);
    assert.deepEqual(acc('641').byA.map(x => [x.a, x.cr]).sort(), [['pdfo', 155646], ['vz', 43235]]);
    // Чернетка відомості в проводки не йде.
    assert.equal(j.journal(input, '2026-11').filter(e => e.period === '2026-11' && e.src === 'payroll').length, 0);
});

test('закриття: перевитрата фонду 48 і витрата за рахунком без акта — попередження, не блокування', () => {
    const input = {
        start: '2026-10', startDate: '2026-10-01', opening: { status: 'approved', lines: [] },
        policy: { defaultFund: 'main', funds: [{ id: 'main', name: 'Основний' }, { id: 'repair', name: 'Ремонтний фонд' }], componentFunds: { main: 'main', repair: 'repair' } },
        ledgers: new Map([['1', [{ kind: 'charge', period: '2026-10', amountKop: 300000, parts: [{ component: 'main', amountKop: 200000 }, { component: 'repair', amountKop: 100000 }] }]]]),
        expenses: [
            { id: 'e1', status: 'approved', period: '2026-10', date: '2026-10-12', docType: 'act', number: '7', amountKop: 500000, item: 'capital', fundId: 'repair', supplierName: 'Підрядник (демо)' },
            { id: 'e2', status: 'paid', period: '2026-10', date: '2026-10-14', docType: 'invoice', number: 'Р-1', amountKop: 10000, item: 'office', supplierName: 'Канцтовари (демо)' },
            { id: 'e3', status: 'paid', period: '2026-10', date: '2026-10-15', docType: 'invoice', number: 'Р-2', amountKop: 20000, item: 'office', supplierName: 'Канцтовари (демо)' },
            { id: 'e4', status: 'linked', linkedTo: 'e3', period: '2026-10', date: '2026-10-16', docType: 'waybill', number: 'ВН-2', amountKop: 20000, supplierName: 'Канцтовари (демо)' }
        ]
    };
    const tb = j.trialBalance(j.journal(input, '2026-10'), '2026-10');
    assert.deepEqual(tb.rows.find(r => r.acc === '48').byA.map(a => [a.a, a.closeDr, a.closeCr]), [['main', 0, 170000], ['repair', 400000, 0]]);
    const fundNames = { main: 'Основний', repair: 'Ремонтний фонд' };
    const checks = j.closeChecks({ period: '2026-10', today: '2026-11-02', expenses: input.expenses, chargedPeriods: new Set(['2026-10']), tb, openingStatus: 'approved', fundNames });
    const warns = checks.filter(c => c.level === 'warn').map(c => c.text);
    assert.equal(warns.length, 2);
    assert.match(warns[0], /дебетовий залишок 48\): Ремонтний фонд — 4000\.00 грн/);
    assert.match(warns[1], /за рахунком без акта чи накладної: 1 \(№ Р-1\)/);
    assert.ok(!checks.some(c => c.level === 'block'));
    // Вхідний залишок 48 без коду фонду належить основному фонду: витрати основного ним покриті — попередження немає.
    const main = { ...input, ledgers: new Map(), opening: { status: 'approved', lines: [{ acc: '311', a: 'UA213052990000026007054321001', side: 'dr', kop: 900000 }, { acc: '48', a: '', side: 'cr', kop: 900000 }] },
        expenses: [{ id: 'm1', status: 'approved', period: '2026-10', date: '2026-10-12', docType: 'act', number: '9', amountKop: 500000, item: 'lift', supplierName: 'Ліфт (демо)' }] };
    const tbMain = j.trialBalance(j.journal(main, '2026-10'), '2026-10');
    assert.deepEqual(tbMain.rows.find(r => r.acc === '48').byA.map(a => [a.a, a.closeDr, a.closeCr]), [['', 0, 900000], ['main', 500000, 0]]);
    const calm = j.closeChecks({ period: '2026-10', today: '2026-11-02', expenses: main.expenses, chargedPeriods: new Set(['2026-10']), tb: tbMain, openingStatus: 'approved', fundNames });
    assert.ok(!calm.some(c => c.level === 'warn'), JSON.stringify(calm));
});

test('підзвітні кошти: 372 закривається за імʼям зі звіту, хоч би як банк назвав отримувача', () => {
    const at = d => new Date(`${d}T10:00:00Z`);
    const input = {
        start: '2026-10', startDate: '2026-10-01', opening: { status: 'approved', lines: [] },
        advanceReports: [{ id: 'a1', number: 'АЗ-1', status: 'approved', period: '2026-10', date: '2026-10-15', personName: 'Підзвітний Тестовий',
            lines: [{ postingAcc: '92', item: 'systems', amountKop: 120000 }, { postingAcc: '20', assetId: 'ТМЦ-001', amountKop: 30000 }] }],
        bankTx: [{ id: 't1', period: '2026-10', at: at('2026-10-20'), direction: 'out', kind: 'expense', status: 'done', category: 'advance', advanceReportId: 'a1',
            amountKop: 150000, account: 'UA1', counterparty: { name: 'ПІДЗВІТНИЙ Т. І.' } }]
    };
    const tb = j.trialBalance(j.journal(input, '2026-10'), '2026-10');
    const r372 = tb.rows.find(r => r.acc === '372');
    assert.deepEqual(r372.byA.map(a => [a.a, a.dr, a.cr, a.closeDr, a.closeCr]), [['Підзвітний Тестовий', 150000, 150000, 0, 0]]);
    assert.equal(tb.rows.find(r => r.acc === '20').closeDr, 30000, 'запаси оприбутковано, витрати — лише 92');
    assert.equal(tb.balanced, true);
});

test('закриття: зарплата з виписки прямо на витрати при чинній відомості — попередження про подвоєння', () => {
    const at = new Date('2026-10-30T10:00:00Z');
    const payrollRuns = [{ period: '2026-10', status: 'approved', run: { rows: [{ personId: 'e1', name: 'Працівник Тестовий', kind: 'employee', grossKop: 864700, pdfoKop: 155646, vzKop: 43235, esvKop: 190234 }] } }];
    const bankTx = [
        { id: 'direct', period: '2026-10', at, direction: 'out', kind: 'expense', status: 'done', category: 'salary', amountKop: 665819, account: 'UA1' },
        { id: 'linked', period: '2026-10', at, direction: 'out', kind: 'expense', status: 'done', category: 'esv', paymentId: 'pay-esv', amountKop: 190234, account: 'UA1' }
    ];
    const payrollPayments = new Map([['pay-esv', { period: '2026-10', key: 'esv', kind: 'tax' }]]);
    const input = { start: '2026-10', startDate: '2026-10-01', opening: { status: 'approved', lines: [] }, bankTx, payrollRuns, payrollPayments };
    const tb = j.trialBalance(j.journal(input, '2026-10'), '2026-10');
    // Подвоєння видно й у відомості: 661 лишається кредитовим на суму «на руки».
    assert.equal(tb.rows.find(r => r.acc === '661').closeCr, 665819);
    const args = { period: '2026-10', today: '2026-11-02', bankTx, chargedPeriods: new Set(['2026-10']), tb, openingStatus: 'approved' };
    const direct = list => list.filter(c => c.level === 'warn' && /прямо на витрати/.test(c.text));
    const warn = direct(j.closeChecks({ ...args, payrollRuns, payrollPayments }));
    assert.equal(warn.length, 1);
    assert.match(warn[0].text, /: 1 на 6658\.19 грн/);
    assert.equal(direct(j.closeChecks({ ...args, payrollRuns: [], payrollPayments })).length, 0, 'без відомості пряма витрата — звичайний облік');
});
