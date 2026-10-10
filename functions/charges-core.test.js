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
    // Нарахування — останнім днем місяця, як у сервісі бухгалтера.
    assert.equal(c.chargeDate('2026-09').toISOString(), '2026-09-30T09:00:00.000Z');   // літній час
    assert.equal(c.chargeDate('2026-12').toISOString(), '2026-12-31T10:00:00.000Z');   // зимовий
    assert.equal(c.chargeDate('2027-02').toISOString(), '2027-02-28T10:00:00.000Z');
    assert.ok(c.openingDate() < c.chargeDate('2026-10'));
    assert.deepEqual(c.duePeriods({ current: '2026-12', done: new Set(['2026-10']) }), ['2026-11', '2026-12']);
    assert.deepEqual(c.duePeriods({ current: '2026-09', done: new Set() }), []);
    // Поточний місяць — лише з його останнього дня.
    assert.deepEqual(c.duePeriods({ current: '2026-11', done: new Set(), today: '2026-11-10' }), ['2026-10']);
    assert.deepEqual(c.duePeriods({ current: '2026-11', done: new Set(), today: '2026-11-30' }), ['2026-10', '2026-11']);
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

test('складові внеску: за м² і з приміщення, без тарифу — не нараховується', () => {
    const components = [
        { id: 'main', name: 'Утримання будинку', base: 'area' },
        { id: 'light', name: 'Освітлення МЗК', base: 'area' },
        { id: 'lift', name: 'Ліфти', base: 'area' },
        { id: 'waste', name: 'Вивезення ТПВ', base: 'fixed' }
    ];
    const tariffs = [
        { id: 'm', group: 'res', rate4: 48000, from: '2026-10' },
        { id: 'mn', group: 'nonres', rate4: 60000, from: '2026-10' },
        { id: 'l', component: 'light', group: 'res', rate4: 8000, from: '2026-10' },
        { id: 'lf', component: 'lift', group: 'res', rate4: 6500, from: '2026-10' },
        { id: 'w', component: 'waste', group: 'res', rate4: 450000, from: '2026-10' },
        { id: 'wn', component: 'waste', group: 'nonres', rate4: 1200000, from: '2026-10' }
    ];
    const r = c.computeCharges({ apartments: [{ apt: '10', area: 72.4 }, { apt: 'н1', area: 30 }, { apt: '7', area: '' }],
        premises: { 'н1': 'nonres' }, tariffs, components, period: '2026-10' });
    const flat = r.rows.find(x => x.apt === '10');
    // 72,4 × 4,80 = 347,52; × 0,80 = 57,92; × 0,65 = 47,06; ТПВ — 45,00 з квартири.
    assert.deepEqual(flat.parts.map(p => [p.component, p.amountKop]), [['main', 34752], ['light', 5792], ['lift', 4706], ['waste', 4500]]);
    assert.equal(flat.amountKop, 34752 + 5792 + 4706 + 4500);
    // Нежитловому ліфти й освітлення не нараховуються: тарифів для групи немає.
    assert.deepEqual(r.rows.find(x => x.apt === 'н1').parts.map(p => [p.component, p.amountKop]), [['main', 18000], ['waste', 12000]]);
    assert.deepEqual(r.problems, [{ apt: '7', reason: 'немає площі' }]);
    assert.equal(c.chargeNote(flat, '2026-10'),
        'Внески за жовтень 2026: утримання будинку 72,4 м² × 4,80 грн; освітлення мзк 72,4 м² × 0,80 грн; ліфти 72,4 м² × 0,65 грн; вивезення тпв 45,00 грн');
    // Нова складова — без дубля назви, з відомою базою.
    assert.equal(c.checkComponent({ name: 'Домофон', base: 'fixed' }, components), null);
    assert.match(c.checkComponent({ name: 'ліфти', base: 'area' }, components), /вже є/);
    assert.match(c.checkComponent({ name: 'Домофон', base: 'x' }, components), /м²/);
    // Тариф тієї самої групи, але іншої складової — не дубль.
    assert.equal(c.checkTariff({ group: 'res', component: 'waste', base: 'fixed', rate4: 450000, from: '2026-11', decision: 'Протокол № 3' }, c.DEFAULT_GROUPS, tariffs), null);
    assert.match(c.checkTariff({ group: 'res', component: 'waste', base: 'fixed', rate4: 450000, from: '2026-10', decision: 'Протокол № 3' }, c.DEFAULT_GROUPS, tariffs), /вже є/);
});

test('як у реальній квитанції: 64 м², 2 проживають — 391,82 грн', () => {
    const components = [
        { id: 'main', name: 'Обслуговування будинку та прибудинкової території', base: 'area' },
        { id: 'light', name: 'Освітлення З. М', base: 'area' },
        { id: 'lift', name: 'Внесок на обслуговування ліфтів', base: 'area' },
        { id: 'waste', name: 'Вивезення побутових відходів', base: 'residents' }
    ];
    const tariffs = [
        { id: 'm', group: 'res', rate4: c.parseRate('4,57'), from: '2026-09' },
        { id: 'l', component: 'light', group: 'res', rate4: c.parseRate('0,48'), from: '2026-09' },
        { id: 'lf', component: 'lift', group: 'res', rate4: c.parseRate('0,63'), from: '2026-09' },
        { id: 'w', component: 'waste', group: 'res', rate4: c.parseRate('14,15'), from: '2026-09' }
    ];
    const r = c.computeCharges({ apartments: [{ apt: '1', area: 64, residents: 2 }, { apt: '2', area: 50, residents: 0 }, { apt: '3', area: 50 }],
        tariffs, components, period: '2026-09' });
    const flat = r.rows.find(x => x.apt === '1');
    assert.deepEqual(flat.parts.map(p => p.amountKop), [29248, 3072, 4032, 2830]);
    assert.equal(flat.amountKop, 39182);
    // Ніхто не проживає — за вивезення 0; кількість не внесено — проблема, а не мовчазний нуль.
    assert.equal(r.rows.find(x => x.apt === '2').parts.find(p => p.component === 'waste').amountKop, 0);
    assert.deepEqual(r.problems, [{ apt: '3', reason: 'не внесено кількість проживаючих' }]);
    assert.match(c.chargeNote(flat, '2026-09'), /вивезення побутових відходів 2 прож\. × 14,15 грн$/);
    assert.equal(c.parseResidents('3'), 3);
    assert.equal(c.parseResidents(-1), null);
    assert.equal(c.parseResidents(''), null);
});

test('розподіл оплати за складовими — як у квитанції сервісу', () => {
    const order = ['main', 'light', 'lift', 'waste'];
    // Вересень 2026: на початок місяця обслуговування в переплаті, інші — борг за серпень.
    const before = { main: 595485, light: -3136, lift: -4032, waste: -2830 };
    assert.deepEqual(c.allocatePayment(40000, before, order), { light: 3136, lift: 4032, waste: 2830, main: 30002 });
    // Оплати не вистачає на борги інших складових — пропорційно, без загублених копійок.
    const small = c.allocatePayment(5000, before, order);
    assert.equal(Object.values(small).reduce((s, v) => s + v, 0), 5000);
    assert.equal(small.main, undefined);
    // Боргів немає — усе на основну.
    assert.deepEqual(c.allocatePayment(40000, { main: 100 }, order), { main: 40000 });
});

test('історія за складовими: залишок 30.09 з квитанції, жовтень — оплата й нарахування', () => {
    const order = ['main', 'light', 'lift', 'waste'];
    // Залишок на 30.09.2026 за складовими: разом +5 863,05, як в акті звірки.
    const opening = { kind: 'opening', period: '2026-09', at: '2026-09-30T09:00:00Z', amountKop: 586305,
        parts: { main: 596239, light: -3072, lift: -4032, waste: -2830 } };
    const pay = { kind: 'payment', period: '2026-10', at: '2026-10-15T09:00:00Z', amountKop: 40000 };
    const charge = { kind: 'charge', period: '2026-10', at: '2026-10-31T09:00:00Z', amountKop: 39182,
        parts: [{ component: 'main', amountKop: 29248 }, { component: 'light', amountKop: 3072 }, { component: 'lift', amountKop: 4032 }, { component: 'waste', amountKop: 2830 }] };
    const old = { kind: 'charge', period: '2026-08', at: '2026-08-31T09:00:00Z', amountKop: 39246 };
    const r = c.replay([charge, pay, opening, old], { order });
    assert.deepEqual(r.steps.map(s => s.entry.kind), ['opening', 'payment', 'charge']);
    assert.deepEqual(r.steps[1].parts, { light: 3072, lift: 4032, waste: 2830, main: 30066 });
    assert.deepEqual(r.balances, { main: 596239 + 30066 - 29248, light: -3072, lift: -4032, waste: -2830 });
    assert.equal(Object.values(r.balances).reduce((s, v) => s + v, 0), c.balanceFromLedger([charge, pay, opening, old]));
    const st = c.componentStatement([charge, pay, opening], '2026-10', { order });
    assert.deepEqual(st.opening, opening.parts);
    assert.deepEqual(st.charged, { main: 29248, light: 3072, lift: 4032, waste: 2830 });
    assert.deepEqual(st.paid, { light: 3072, lift: 4032, waste: 2830, main: 30066 });
    assert.equal(c.checkOpening([{ apt: '1', amountKop: 586305, parts: opening.parts }], new Set(['1'])), null);
    assert.match(c.checkOpening([{ apt: '1', amountKop: 1, parts: { main: 2 } }], new Set(['1'])), /складові/);
});

test('оплати за складовими поквартирно: та сама сума, що й paidByComponent', () => {
    const at = new Date('2026-10-08T09:00:00Z');
    const ledgers = new Map([
        ['298', [{ kind: 'opening', period: '2026-09', amount: 5863.05, parts: { main: 596239, light: -3072, lift: -4032, waste: -2830 } },
            { kind: 'payment', period: '2026-10', at, amount: 400 }]],
        ['5', [{ kind: 'payment', period: '2026-10', at, amount: 100 }, { kind: 'payment', period: '2025-12', at, amount: 50 }]]
    ]);
    const opts = { order: ['main', 'light', 'lift', 'waste'] };
    const ops = c.paymentOps(ledgers, '2026', opts);
    const paid = c.paidByComponent(ledgers, '2026', opts);
    for (const [comp, kop] of Object.entries(paid)) assert.equal(ops.filter(o => o.component === comp).reduce((s, o) => s + o.kop, 0), kop, comp);
    assert.deepEqual(ops.filter(o => o.apt === '298').map(o => [o.component, o.kop]).sort(), [['lift', 4032], ['light', 3072], ['main', 30066], ['waste', 2830]]);
});
