// «Сьогодні»: справи, головна дія за роллю, рух коштів, внески, строки, кошторис.
import test from 'node:test';
import assert from 'node:assert/strict';
import { tasks, focusOf, cashByDay, collection, upcoming, leftText, budgetPace, recentOps, describeDeadline } from '../../js/today-core.js';

const NOW = new Date(2026, 9, 24, 10);
const at = (d, h = 10) => new Date(2026, 9, d, h);

test('справи: групи в усталеному порядку, суми операцій банку', () => {
    const list = tasks([
        { proposal: { type: 'approve-exp', expense: { supplierName: 'Ліфт (демо)', amountKop: 1000 } } },
        { proposal: { type: 'assign' }, tx: { amountKop: 500, counterparty: { name: 'Власник Тестовий 1' } } },
        { proposal: { type: 'link' }, tx: { amountKop: 700 } },
        { proposal: { paymentsAction: 'open-failed', failedPaymentsCount: 2, failedPaymentsSumKop: 900, text: 'Рахунок закрито. Деталі' } }
    ]);
    assert.deepEqual(list.map(t => [t.key, t.count, t.sumKop]), [['failed_pay', 2, 900], ['bank', 2, 1200], ['docs', 1, 0]]);
    assert.equal(list[0].note, 'Банк не прийняв: Рахунок закрито');
    assert.equal(list[2].note, 'Ліфт (демо) · 10,00 грн');
});

test('головна дія: бухгалтер', () => {
    const d = (left, title = 'Сплатити ЄСВ') => ({ left, title, date: new Date(Date.UTC(2026, 10, 20)) });
    const bank = { key: 'bank', count: 3, sumKop: 1500, title: 'Розподілити операції банку' };
    const failed = { key: 'failed_pay', count: 1, sumKop: 900, note: 'Банк не прийняв' };
    assert.equal(focusOf({ list: [failed, bank] }).go, 'payments');
    assert.match(focusOf({ list: [failed] }).title, /^Платіж не пройшов/);
    assert.equal(focusOf({ list: [bank], deadline: d(-2) }).tone, 'bad', 'прострочений строк — раніше за банк');
    assert.deepEqual([focusOf({ list: [bank], deadline: d(2) }).go, focusOf({ list: [bank], deadline: d(2) }).group], ['inbox', 'bank']);
    assert.equal(focusOf({ list: [], deadline: d(2) }).go, 'reports');
    assert.equal(focusOf({ pay: { todo: { count: 2, kop: 300 }, signing: { count: 0 } } }).go, 'payments');
    assert.equal(focusOf({ list: [{ key: 'docs', count: 1, title: 'Документи' }] }).group, 'all');
    assert.equal(focusOf({ month: { done: 2, total: 6, next: { title: 'Банк', short: '8 операцій' } } }).go, 'month');
    assert.equal(focusOf({}).tone, 'done');
});

test('головна дія: голова підписує, погоджує, стежить за строками', () => {
    const pay = { signing: { count: 2, kop: 5000 }, todo: { count: 1, kop: 100 } };
    assert.match(focusOf({ role: 'chair', pay }).title, /^Підпишіть 2 платежі/);
    const docs = [{ key: 'docs', count: 2 }, { key: 'failed_pay', count: 1 }];
    const f = focusOf({ role: 'chair', list: docs });
    assert.equal(f.go, 'inbox');
    assert.match(f.title, /^2 рішення/, 'відхилені банком платежі — справа бухгалтера');
    assert.equal(focusOf({ role: 'chair', list: [{ key: 'failed_pay', count: 1 }] }).tone, 'done');
});

test('рух коштів: дні місяця, без внутрішніх переказів', () => {
    const c = cashByDay([
        { at: at(3), direction: 'in', kind: 'payment', amountKop: 1000 },
        { at: at(3, 15), direction: 'out', category: 'supplier', amountKop: 400 },
        { at: at(5), direction: 'out', category: 'bank_fee', amountKop: 50 },
        { at: at(5), direction: 'out', kind: 'internal', amountKop: 99999 },
        { at: new Date(2026, 8, 30), direction: 'in', amountKop: 777 }
    ], NOW, { supplier: 'Оплата постачальнику' });
    assert.equal(c.days.length, 31);
    assert.deepEqual([c.inKop, c.outKop, c.netKop, c.residentsKop, c.maxKop], [1000, 450, 550, 1000, 1000]);
    assert.deepEqual(c.days[2], { day: 3, inKop: 1000, outKop: 400, future: false, today: false });
    assert.equal(c.days[23].today, true);
    assert.equal(c.days[24].future, true);
    assert.deepEqual(c.outTop.map(x => x.label), ['Оплата постачальнику', 'Інше']);
});

test('внески: частка сплаченого, боржники від більшого', () => {
    const charges = { current: '2026-10', runs: [{ period: '2026-10', totalKop: 10000, count: 4 }],
        apartments: [{ apt: '1', balance: -50 }, { apt: '2', balance: 10 }, { apt: '3', balance: -120.5 }, { apt: '4', balance: 0 }] };
    const txs = [{ at: at(2), kind: 'payment', status: 'done', amountKop: 2500, allocations: [{ apt: '2' }, { apt: '4' }] },
        { at: at(4), kind: 'payment', status: 'review', amountKop: 999 }];
    const c = collection(charges, txs, NOW);
    assert.deepEqual([c.chargedKop, c.paidKop, c.share, c.paidApts, c.totalApts, c.debtKop, c.debtors], [10000, 2500, 25, 2, 4, 17050, 2]);
    assert.deepEqual(c.top, [{ apt: '3', kop: 12050 }, { apt: '1', kop: 5000 }]);
    assert.equal(collection(null, [], NOW).known, false);
    assert.equal(collection({ current: '2026-10', runs: [], apartments: [] }, [], NOW).share, null);
});

test('строки: прострочені першими, однакова дата — разом, подане не нагадуємо', () => {
    const t = (key, left, iso, extra = {}) => ({ key, title: key, left, iso, date: new Date(`${iso}T00:00:00Z`), ...extra });
    const list = upcoming([t('esv-2026-10', 27, '2026-11-20'), t('j0500111-2026-10', 27, '2026-11-20'), t('old', -3, '2026-10-21'),
        t('done', 5, '2026-10-29', { done: true }), t('sent', 6, '2026-10-30', { waiting: true }), t('far', 200, '2027-05-12')]);
    assert.deepEqual(list.map(d => [d.iso, d.items.length]), [['2026-10-21', 1], ['2026-11-20', 2]]);
    assert.deepEqual([-2, 0, 1, 5].map(leftText), ['прострочено 2 дн.', 'сьогодні', 'завтра', 'через 5 дн.']);
    const all = [t('esv-2026-10', 27, '2026-11-20'), t('j0500111-2026-10', 27, '2026-11-20')];
    assert.match(describeDeadline(all[0], all).whatText, /^Сплатити ЄСВ і подати Податковий розрахунок/);
});

test('кошторис і останні операції', () => {
    assert.equal(budgetPace(null), null);
    const b = budgetPace({ year: '2026', budget: { status: 'approved' }, execution: { months: 10,
        totals: { planKop: 12000, toDateKop: 10000, factKop: 11000, incomePlanKop: 24000, incomeFactKop: 15000 },
        sections: [{ lines: [{ title: 'Прибирання', toDateKop: 5000, factKop: 6500 }, { title: 'Ліфти', toDateKop: 5000, factKop: 4500 }] }] } });
    assert.deepEqual([b.pct, b.yearPct, b.incomeToDateKop, b.incomePct], [110, 92, 20000, 75]);
    assert.deepEqual(b.over, [{ title: 'Прибирання', overKop: 1500 }]);
    const ops = recentOps([{ id: 'a', at: at(1) }, { id: 'b', at: at(3) }, { id: 'c', at: at(2), kind: 'internal' }], 5);
    assert.deepEqual(ops.map(t => t.id), ['b', 'a']);
});
