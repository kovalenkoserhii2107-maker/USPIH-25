import test from 'node:test';
import assert from 'node:assert/strict';
import { financeSummary, houseResourceMonths, costChange } from '../../js/finance-core.js';

test('звіт сортує статті, рахує частки й не плутає «не вказано» з нулем', () => {
    const summary = financeSummary({ period: ' Вересень 2026 ', income: '1 000,50', funds: '', fundsDate: '15.09.2026',
        items: [{ label: 'Ліфт', amount: '200' }, { label: 'Прибирання', amount: 600 }, { label: '', amount: 5 }, { label: 'Нуль', amount: 0 }] });
    assert.equal(summary.period, 'Вересень 2026');
    assert.equal(summary.funds, null);
    assert.equal(summary.income, 1000.5);
    assert.equal(summary.spent, 800);
    assert.equal(summary.difference, 200.5);
    assert.deepEqual(summary.items.map(item => item.label), ['Прибирання', 'Ліфт']);
    assert.equal(summary.items[0].share, 75);
    assert.equal(Math.round(summary.spentShare), 80);
});

test('без надходжень різниця й відсоток витрат не вигадуються', () => {
    const summary = financeSummary({ items: [{ label: 'Світло', amount: 10 }] });
    assert.equal(summary.income, null);
    assert.equal(summary.difference, null);
    assert.equal(summary.spentShare, null);
    assert.equal(financeSummary({ income: 0, items: [] }).spentShare, null);
});

const row = (resource, period, reading, baseline, tariff, unit) => ({ kind: 'houseMeterReading', resource, period, unit, reading, baseline, tariff, reset: false, note: '' });

test('ресурси будинку групуються за місяцями, помилковий рядок не входить у суму', () => {
    const months = houseResourceMonths([
        row('electricity', '2026-09', 1100, 1000, 4, 'кВт·год'), row('heat', '2026-09', 15, 10, 2000, 'Гкал'),
        row('electricity', '2026-10', 1300, 1100, 5, 'кВт·год'), row('water', '2026-10', 5, 10, 30, 'м³')
    ]);
    assert.deepEqual(months.map(month => month.period), ['2026-09', '2026-10']);
    assert.equal(months[0].total, 10400);
    assert.equal(months[1].rows.find(item => item.resource === 'heat').row, null);
    assert.ok(months[1].rows.find(item => item.resource === 'water').row.error);
    assert.equal(months[1].total, 1000);
    assert.deepEqual(costChange(months, '2026-10', 'electricity'), { period: '2026-09', change: 150 });
    assert.equal(costChange(months, '2026-10', 'water'), null);
    assert.equal(costChange(months, '2026-09', 'heat'), null);
});
