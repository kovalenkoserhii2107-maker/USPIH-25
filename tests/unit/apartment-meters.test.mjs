import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeApartmentReading, apartmentSeries, synchronizedApartmentChanges } from '../../js/apartment-meter-core.js';
import { normalizeMeterReading, meterSeries, apartmentHeatShare, buildingTotalArea, integerReading } from '../../js/meter-core.js';

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

test('загальна площа береться з усіх квартир, службовий обліковий запис не додається', () => {
    const total = buildingTotalArea([{ area: '64,5' }, { area: '100' }, { isAdmin: true, area: 99999 }]);
    assert.equal(total, 164.5);
    assert.equal(buildingTotalArea([{ area: 64 }, { area: '' }]), null);
    assert.equal(buildingTotalArea([]), null);
    const heat = { cost: 1000, heatedArea: 1 };
    assert.equal(apartmentHeatShare(heat, 64.5, total), 392.1);
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
