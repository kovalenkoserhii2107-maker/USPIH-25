import test from 'node:test';
import assert from 'node:assert/strict';
import { consumptionInsight } from '../../js/apartment-meter-core.js';
import { apartmentHeatHistory } from '../../js/meter-core.js';

const rows = values => values.map(([period, consumption, error = null]) => ({ period, consumption, error }));

test('підказка порівнює з попереднім поданим місяцем і не бере майбутні', () => {
    const series = rows([['2026-07', 100], ['2026-08', 120], ['2026-09', 200], ['2026-11', 999]]);
    const insight = consumptionInsight(series, '2026-10', 150);
    assert.equal(insight.previousPeriod, '2026-09');
    assert.equal(insight.previous, 200);
    assert.equal(insight.change, -25);
    assert.equal(Math.round(insight.average), 140);
    assert.equal(insight.unusual, false);
});

test('незвично велике споживання — утричі більше за середнє щонайменше двох місяців', () => {
    const series = rows([['2026-08', 10], ['2026-09', 12]]);
    assert.equal(consumptionInsight(series, '2026-10', 70).unusual, true);
    assert.equal(consumptionInsight(series, '2026-10', 30).unusual, false);
    assert.equal(consumptionInsight(rows([['2026-09', 1]]), '2026-10', 500).unusual, false);
});

test('без історії, з помилковими або нульовими місяцями відсоток не рахується', () => {
    assert.deepEqual(consumptionInsight([], '2026-10', 5), { previousPeriod: null, previous: null, change: null, average: null, unusual: false });
    const insight = consumptionInsight(rows([['2026-08', 40], ['2026-09', 0], ['2026-09', 50, 'Помилка']]), '2026-10', 10);
    assert.equal(insight.previous, 0);
    assert.equal(insight.change, null);
});

test('історія тепла рахує частку квартири за кожен місяць і пропускає помилкові', () => {
    const heat = (period, reading, baseline, extra = {}) => ({ resource: 'heat', period, unit: 'Гкал', reading, baseline, tariff: 2000, reset: false, ...extra });
    const history = apartmentHeatHistory([heat('2026-10', 15, 10, { totalArea: 200 }), heat('2026-11', 12, 0)], 50, 250);
    assert.equal(history.length, 2);
    assert.equal(history[0].row.cost, 10000);
    assert.equal(history[0].calculation.cost, 2500);
    assert.equal(history[0].calculation.totalArea, 200);
    assert.equal(history[1].row.error !== null, true);
    assert.equal(history[1].calculation, null);
});
