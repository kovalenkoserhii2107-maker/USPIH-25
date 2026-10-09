import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeApartmentReading, apartmentSeries, synchronizedApartmentChanges } from '../../js/apartment-meter-core.js';
import { normalizeMeterReading, meterSeries, apartmentHeatShare, apartmentHeatCalculation, buildingTotalArea, integerReading, normalizeHeatTariff, heatTariffForPeriod, heatReadingTariff } from '../../js/meter-core.js';

const row = (period, reading, baseline = 100, extra = {}) => normalizeApartmentReading({ resource: 'water', period,
    reading, baseline, unit: 'м³', ...extra });

test('квартирні показники зберігаються без тарифів та фінансових полів', () => {
    const water = row('2026-09', '123', 100, { tariff: 999, heatedArea: 1234, balance: 0 });
    assert.equal(water.reading, 123);
    assert.throws(() => row('2026-09', '123,456'), /цілим/);
    assert.equal(water.kind, 'apartmentMeterReading');
    for (const field of ['tariff', 'heatedArea', 'balance']) assert.equal(field in water, false);
    assert.throws(() => row('2026-09', 200, 100, { resource: 'heat', unit: 'Гкал' }), /квартирний/);
});

test('цілі показники перевіряються без округлення введених дробів', () => {
    assert.equal(integerReading('000787'), 787); assert.equal(integerReading(0), 0);
    for (const value of ['', null, -1, 1.5, '123,4', 1e11]) assert.equal(integerReading(value), null);
});

test('тариф на тепло підставляється з дати дії, майбутня і середмісячна зміна не переписують попередній місяць', () => {
    const october = normalizeHeatTariff({ tariff: '1 500,50', effectiveFrom: '2026-10-01' });
    const november = normalizeHeatTariff({ tariff: 2000, effectiveFrom: '2026-11-01' });
    const partial = normalizeHeatTariff({ tariff: 2500, effectiveFrom: '2026-12-15' });
    const rows = [november, partial, october];
    assert.equal(heatTariffForPeriod(rows, '2026-09'), null);
    assert.equal(heatTariffForPeriod(rows, '2026-10').tariff, 1500.5);
    assert.equal(heatTariffForPeriod(rows, '2026-11').tariff, 2000);
    assert.equal(heatTariffForPeriod(rows, '2026-12').tariff, 2000);
    assert.equal(heatTariffForPeriod(rows, '2027-01').tariff, 2500);
    assert.equal(normalizeHeatTariff({ tariff: 0, effectiveFrom: '2026-10-01' }).tariff, 0);
    for (const patch of [{ tariff: '' }, { tariff: -1 }, { effectiveFrom: '' }, { effectiveFrom: '2026-02-30' }]) {
        assert.throws(() => normalizeHeatTariff({ ...october, ...patch }));
    }
});

test('тепло використовує єдиний датований тариф, зберігає старі дані та враховує одиницю лічильника', () => {
    const october = normalizeHeatTariff({ tariff: 1500.5, effectiveFrom: '2026-10-01' });
    const november = normalizeHeatTariff({ tariff: 2000, effectiveFrom: '2026-11-01' });
    const old = { tariff: 1000, unit: 'Гкал' };
    assert.equal(heatReadingTariff([october, november], '2026-10', 'Гкал', old, old), 1500.5);
    assert.equal(heatReadingTariff([november], '2026-10', 'Гкал', old), 1000);
    assert.equal(heatReadingTariff([], '2026-10', 'Гкал', undefined, old), 1000);
    assert.equal(heatReadingTariff([october], '2026-09', 'Гкал'), null);
    const free = normalizeHeatTariff({ tariff: 0, effectiveFrom: '2026-10-01' });
    assert.equal(heatReadingTariff([free], '2026-10', 'Гкал', old), 0);
    const perMwh = heatReadingTariff([october], '2026-10', 'МВт·год', old);
    assert.ok(Math.abs(perMwh - 1500.5 * 3.6 / 4.1868) < 1e-8);
    assert.ok(Math.abs(heatReadingTariff([], '2026-10', 'Гкал', { tariff: perMwh, unit: 'МВт·год' }) - 1500.5) < 1e-8);
    assert.equal(heatReadingTariff([], '2026-10', 'Гкал', { tariff: '', unit: 'Гкал' }), null);
    assert.equal(heatReadingTariff([october], '2026-10', 'м³', old), null);
    assert.equal(old.tariff, 1000);
});

test('загальна площа береться з усіх квартир, службовий обліковий запис не додається', () => {
    const total = buildingTotalArea([{ area: '64,5' }, { area: '100' }, { isAdmin: true, area: 99999 }]);
    assert.equal(total, 164.5);
    assert.equal(buildingTotalArea([{ area: 64 }, { area: '' }]), null);
    assert.equal(buildingTotalArea([]), null);
    assert.equal(buildingTotalArea([{ apt: '45', area: 64 }, { apt: 'test', area: '' }]), 64);
    assert.equal(buildingTotalArea([{ apt: '45', area: 64 }, { apt: '46', area: '' }]), null);
    const heat = { cost: 1000, heatedArea: 1 };
    assert.equal(apartmentHeatShare(heat, 64.5, total), 392.1);
});

test('розрахунок квартири показує частку тепла, грн за м² і суму за вибраний місяць', () => {
    const heat = { cost: 40000, consumption: 20, totalArea: 10000 };
    const expected = { apartmentArea: 64, totalArea: 10000, cost: 256, perSquareMeter: 4, volume: 0.128 };
    assert.deepEqual(apartmentHeatCalculation(heat, '64,0', null), expected);
    assert.deepEqual(apartmentHeatCalculation({ ...heat, totalArea: undefined }, 64, 10000), expected);
    assert.deepEqual(apartmentHeatCalculation({ ...heat, totalArea: undefined, heatedArea: 10000 }, 64), expected);
    assert.equal(apartmentHeatCalculation({ ...heat, totalArea: undefined }, 64, null), null);
    assert.equal(apartmentHeatCalculation(heat, '', 10000), null);
    assert.equal(apartmentHeatCalculation({ ...heat, cost: 0 }, 64).cost, 0);
    assert.equal(apartmentHeatCalculation({ ...heat, error: 'Помилка показника' }, 64), null);
});

test('історичні дробові показники не округлюються під час синхронізації наступного запису', () => {
    const records = [row('2026-09', 120), { ...row('2026-10', 150), reading: 150.5 }];
    const changes = synchronizedApartmentChanges(records, [row('2026-09', 125)]);
    assert.equal(changes.find(value => value.period === '2026-10').reading, 150.5);
    assert.equal(changes.find(value => value.period === '2026-10').baseline, 125);
});

test('вхідний показник наступного періоду береться з попереднього вихідного', () => {
    const records = [row('2026-09', 120), row('2026-10', 140)];
    const values = apartmentSeries(records, 'water');
    assert.deepEqual(values.map(value => [value.effectiveBaseline, value.consumption]), [[100, 20], [120, 20]]);
    const changes = synchronizedApartmentChanges(records, [row('2026-09', 125)]);
    assert.equal(changes.length, 2);
    assert.equal(changes.find(value => value.period === '2026-10').baseline, 125);
    assert.throws(() => synchronizedApartmentChanges(records, [row('2026-09', 141)]), /менший за попередній/);
});

test('новий лічильник задає незалежний початок, зміна минулого не стирає обнулення', () => {
    const records = [row('2026-09', 120), row('2026-10', 5, 0, { reset: true })];
    const changes = synchronizedApartmentChanges(records, [row('2026-09', 125)]);
    assert.equal(changes.length, 1);
    assert.equal(apartmentSeries(records, 'water')[1].consumption, 5);
});

test('тепло розподіляється за площею, відсутня чи некоректна площа не стає нульовим нарахуванням', () => {
    const record = normalizeMeterReading({ resource: 'heat', period: '2026-10', unit: 'Гкал', baseline: 10,
        reading: 12, tariff: 1500, heatedArea: '10 000,50' });
    const heat = meterSeries([record], 'heat')[0];
    assert.equal(apartmentHeatShare(heat, '64,5'), 19.35);
    for (const area of [null, '', 0, -1, 10001]) assert.equal(apartmentHeatShare(heat, area), null);
    assert.equal(apartmentHeatShare({ ...heat, heatedArea: undefined }, 64), null);
    assert.throws(() => normalizeMeterReading({ ...record, heatedArea: 0 }), /опалювану площу/);
});
