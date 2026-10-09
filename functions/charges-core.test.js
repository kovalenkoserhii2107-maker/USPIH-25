'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const c = require('./charges-core');

test('площа й тариф — цілими числами', () => {
    assert.equal(c.parseArea('72,4'), 7240);
    assert.equal(c.parseArea(54.1), 5410);
    assert.equal(c.parseArea(' 64 '), 6400);
    assert.equal(c.parseArea('64.125'), null);       // третій знак — це вже помилка в базі
    assert.equal(c.parseArea('--'), null);
    assert.equal(c.parseArea(''), null);
    assert.equal(c.parseArea(0), null);
    assert.equal(c.parseRate('8,50'), 85000);
    assert.equal(c.parseRate('8.375'), 83750);
    assert.equal(c.parseRate('8,12345'), null);
    assert.equal(c.parseRate('-1'), null);
    assert.equal(c.formatRate(85000), '8,50');
    assert.equal(c.formatRate(83750), '8,375');
    assert.equal(c.formatRate(80000), '8,00');
    assert.equal(c.formatArea(7240), '72,4');
});

test('внесок: площа × тариф, округлення до копійки', () => {
    assert.equal(c.chargeKop(7240, 85000), 61540);       // 72,4 × 8,50 = 615,40
    assert.equal(c.chargeKop(5410, 83750), 45309);       // 54,1 × 8,375 = 453,0875 → 453,09
    assert.equal(c.chargeKop(4805, 85000), 40843);       // 48,05 × 8,50 = 408,425 → 408,43
});

test('періоди й дати за Києвом', () => {
    assert.equal(c.shiftPeriod('2026-12', 1), '2027-01');
    assert.equal(c.shiftPeriod('2027-01', -1), '2026-12');
    assert.equal(c.currentPeriod(new Date('2026-10-31T21:30:00Z')), '2026-10');   // 23:30 за Києвом
    assert.equal(c.currentPeriod(new Date('2026-10-31T22:30:00Z')), '2026-11');   // 00:30 вже листопада
    assert.equal(c.periodName('2026-10'), 'жовтень 2026');
    assert.equal(c.chargeDate('2026-10').toISOString(), '2026-10-01T09:00:00.000Z');   // літній час
    assert.equal(c.chargeDate('2026-12').toISOString(), '2026-12-01T10:00:00.000Z');   // зимовий
    assert.ok(c.openingDate() < c.chargeDate('2026-10'));
    assert.deepEqual(c.duePeriods({ current: '2026-12', done: new Set(['2026-10']) }), ['2026-11', '2026-12']);
    assert.deepEqual(c.duePeriods({ current: '2026-09', done: new Set() }), []);
});

test('чинний тариф — найновіший з початком не пізніше місяця', () => {
    const tariffs = [
        { id: 'a', group: 'res', rate4: 80000, from: '2026-01' },
        { id: 'b', group: 'res', rate4: 85000, from: '2026-11' },
        { id: 'n', group: 'nonres', rate4: 120000, from: '2026-01' }
    ];
    assert.equal(c.tariffFor(tariffs, 'res', '2026-10').id, 'a');
    assert.equal(c.tariffFor(tariffs, 'res', '2026-11').id, 'b');
    assert.equal(c.tariffFor(tariffs, 'res', '2025-12'), null);
    assert.equal(c.tariffFor(tariffs, 'parking', '2026-11'), null);
});

test('перевірка тарифу', () => {
    const groups = c.DEFAULT_GROUPS;
    const ok = { group: 'res', rate4: 85000, from: '2026-10', decision: 'Протокол зборів № 3 від 12.09.2026' };
    assert.equal(c.checkTariff(ok, groups), null);
    assert.match(c.checkTariff({ ...ok, group: 'x' }, groups), /група/);
    assert.match(c.checkTariff({ ...ok, rate4: null }, groups), /тариф/i);
    assert.match(c.checkTariff({ ...ok, from: '2026-13' }, groups), /місяць/);
    assert.match(c.checkTariff({ ...ok, decision: '' }, groups), /рішення/);
    assert.match(c.checkTariff(ok, groups, [{ group: 'res', from: '2026-10' }]), /вже є/);
    assert.equal(c.checkGroupName('Паркінг', groups), null);
    assert.match(c.checkGroupName('квартири', groups), /вже є/);
});

test('нарахування за місяць: групи, проблеми, сума', () => {
    const tariffs = [
        { id: 'r', group: 'res', rate4: 85000, from: '2026-10' },
        { id: 'n', group: 'nonres', rate4: 120000, from: '2026-10' }
    ];
    const groups = [...c.DEFAULT_GROUPS, { id: 'parking', name: 'Паркінг' }];
    const r = c.computeCharges({
        apartments: [{ apt: '10', area: 72.4 }, { apt: '2', area: '54,1' }, { apt: 'н1', area: 30 }, { apt: '7', area: '--' }, { apt: 'p1', area: 15 }],
        premises: { 'н1': 'nonres', p1: 'parking', '2': 'unknown-group' }, tariffs, groups, period: '2026-10'
    });
    assert.deepEqual(r.rows.map(x => [x.apt, x.group, x.amountKop]), [['2', 'res', 45985], ['10', 'res', 61540], ['н1', 'nonres', 36000]]);
    assert.deepEqual(r.problems, [{ apt: '7', reason: 'немає площі' }, { apt: 'p1', reason: 'немає тарифу «Паркінг»' }]);
    assert.equal(r.totalKop, 45985 + 61540 + 36000);
    assert.equal(c.chargeNote(r.rows[1], '2026-10'), 'Внесок за жовтень 2026: 72,4 м² × 8,50 грн');
});

test('вхідні залишки', () => {
    const known = new Set(['10', '11']);
    assert.equal(c.checkOpening([{ apt: '10', amountKop: -125040 }, { apt: '11', amountKop: 0 }], known), null);
    assert.match(c.checkOpening([{ apt: '99', amountKop: 1 }], known), /99/);
    assert.match(c.checkOpening([{ apt: '10', amountKop: 1 }, { apt: '10', amountKop: 2 }], known), /двічі/);
    assert.match(c.checkOpening([{ apt: '10', amountKop: 1.5 }], known), /сума/);
    assert.match(c.checkOpening([], known), /рядка/);
    assert.match(c.openingNote(-1), /Борг/);
    assert.match(c.openingNote(1), /Переплата/);
});

test('баланс з історії: залишок + оплати − нарахування від початку обліку', () => {
    const entries = [
        { kind: 'charge', period: '2026-08', amount: 600 },          // до обліку — уже у вхідному залишку
        { kind: 'payment', period: '2026-09', amount: 600 },
        { kind: 'opening', period: '2026-09', amountKop: -32050 },
        { kind: 'charge', period: '2026-10', amountKop: 61540 },
        { kind: 'payment', period: '2026-10', amount: 500.5 },       // старий запис лише з гривнями
        { kind: 'charge', period: '2026-11', amountKop: 61540 }
    ];
    assert.equal(c.balanceFromLedger(entries), -32050 - 61540 + 50050 - 61540);
    assert.equal(c.balanceFromLedger([]), 0);
});

test('відомість за місяць', () => {
    const ledgers = new Map([
        ['10', [{ kind: 'opening', period: '2026-09', amountKop: -10000 }, { kind: 'charge', period: '2026-10', amountKop: 61540 },
            { kind: 'payment', period: '2026-10', amountKop: 71540 }, { kind: 'charge', period: '2026-11', amountKop: 61540 }]],
        ['2', [{ kind: 'opening', period: '2026-09', amountKop: 5000 }, { kind: 'charge', period: '2026-10', amountKop: 45985 }]]
    ]);
    const oct = c.statement(ledgers, '2026-10');
    assert.deepEqual(oct.rows.map(r => [r.apt, r.opening, r.charged, r.paid, r.closing]),
        [['2', 5000, 45985, 0, -40985], ['10', -10000, 61540, 71540, 0]]);
    assert.deepEqual(oct.totals, { opening: -5000, charged: 107525, paid: 71540, closing: -40985, debt: -40985, debtors: 1 });
    const nov = c.statement(ledgers, '2026-11');
    assert.deepEqual(nov.rows.map(r => [r.apt, r.opening, r.closing]), [['2', -40985, -40985], ['10', 0, -61540]]);
});
