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
    // Кінець місяця: 92 і 79 закрито, витрати покрито з 48, оренда — результат на 44.
    assert.equal(acc('92').closeDr + acc('92').closeCr, 0);
    assert.equal(acc('79').closeDr + acc('79').closeCr, 0);
    assert.equal(acc('44').closeCr, 36000);
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

test('перевірки перед закриттям', () => {
    const data = input();
    const tb = j.trialBalance(j.journal(data, '2026-10'), '2026-10');
    const checks = j.closeChecks({ period: '2026-10', today: '2026-10-20', bankTx: data.bankTx, expenses: data.expenses, chargedPeriods: new Set(['2026-10']), closed: [], tb });
    const blocks = checks.filter(c => c.level === 'block').map(c => c.text);
    assert.equal(blocks.length, 2);
    assert.match(blocks[0], /ще не скінчився/);
    assert.match(blocks[1], /чекають рішення.*1/);
    assert.ok(checks.some(c => c.level === 'warn' && /ТОВ АВАНС/.test(c.text)));
    data.bankTx = data.bankTx.filter(t => t.status !== 'review');
    const ok = j.closeChecks({ period: '2026-10', today: '2026-11-01', bankTx: data.bankTx, expenses: data.expenses, chargedPeriods: new Set(['2026-10']), closed: [], tb });
    assert.equal(ok.at(-1).level, 'ok');
    const nov = j.closeChecks({ period: '2026-11', today: '2026-12-01', bankTx: [], expenses: [], chargedPeriods: new Set(), closed: [], tb });
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
