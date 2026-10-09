import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeResourceTariff, resourceTariffForPeriod, readingTariff } from '../../js/meter-core.js';
import { normalizeApartmentReading, apartmentSeries, apartmentChannels, synchronizedApartmentChanges } from '../../js/apartment-meter-core.js';

const channel = (reading, baseline, extra = {}) => ({ reading, baseline, ...extra });
const reading = (resource, period, channels) => normalizeApartmentReading({ resource, period, channels });

test('тарифи трьох ресурсів незалежні, беруть дату початку місяця й сумісні зі старим тарифом тепла', () => {
    const rows = [normalizeResourceTariff({ resource: 'electricity', tariff: '4,32', effectiveFrom: '2026-10-01' }),
        normalizeResourceTariff({ resource: 'water', tariff: 64, effectiveFrom: '2026-11-01' }),
        { kind: 'houseHeatTariff', unit: 'Гкал', tariff: 2000, effectiveFrom: '2026-10-01' }];
    assert.equal(resourceTariffForPeriod(rows, 'electricity', '2026-10').tariff, 4.32);
    assert.equal(resourceTariffForPeriod(rows, 'water', '2026-10'), null);
    assert.equal(readingTariff(rows, 'water', '2026-10', 'м³', { unit: 'м³', tariff: 30 }), 30);
    assert.equal(readingTariff(rows, 'water', '2026-11', 'м³', { unit: 'м³', tariff: 30 }), 64);
    assert.equal(readingTariff(rows, 'heat', '2026-10', 'Гкал'), 2000);
    assert.throws(() => normalizeResourceTariff({ resource: 'gas', tariff: 1, effectiveFrom: '2026-10-01' }));
});

test('день і ніч мають незалежні інтервали, перехід зі старого загального показника не ділить його навмання', () => {
    const old = normalizeApartmentReading({ resource: 'electricity', period: '2026-09', reading: 1700, baseline: 1000 });
    const october = reading('electricity', '2026-10', { day: channel(1100, 1000), night: channel(700, 650) });
    const november = reading('electricity', '2026-11', { day: channel(1200, 0), night: channel(720, 0) });
    const records = [old, october, november];
    const values = apartmentSeries(records, 'electricity');
    assert.equal(values[1].consumption, 150); assert.equal(values[2].consumption, 120);
    assert.deepEqual(values[2].channelReadings.map(row => [row.channel, row.effectiveBaseline, row.consumption]), [['day', 1100, 100], ['night', 700, 20]]);
    const changed = synchronizedApartmentChanges(records, [reading('electricity', '2026-10', { day: channel(1150, 1000), night: channel(700, 650) })]);
    assert.equal(changed.length, 2);
    assert.equal(changed.find(row => row.period === '2026-11').channels.day.baseline, 1150);
    assert.equal(changed.find(row => row.period === '2026-11').channels.night.baseline, 700);
    assert.equal(apartmentChannels(old).main.reading, 1700);
});

test('водоміри зберігають назви, попередні показники й обнулення кожного приладу окремо', () => {
    const october = reading('water', '2026-10', { main: channel(420, 400, { name: 'Ванна' }), water2: channel(105, 100, { name: 'Кухня' }) });
    const november = reading('water', '2026-11', { main: channel(430, 420, { name: 'Ванна' }), water2: channel(5, 0, { name: 'Кухня', reset: true }) });
    const changed = synchronizedApartmentChanges([october, november], [reading('water', '2026-10', {
        main: channel(425, 400, { name: 'Ванна' }), water2: channel(107, 100, { name: 'Кухня' }) })]);
    const next = changed.find(row => row.period === '2026-11');
    assert.equal(next.channels.main.baseline, 425);
    assert.equal(next.channels.water2.baseline, 0); assert.equal(next.channels.water2.reset, true);
    assert.equal(next.channels.water2.name, 'Кухня');
    assert.equal(apartmentSeries([october, november], 'water')[1].consumption, 15);
    const removed = reading('water', '2026-12', { water2: channel(10, 5, { name: 'Кухня' }) });
    assert.equal(apartmentSeries([october, november, removed], 'water')[2].consumption, 5);
    assert.throws(() => synchronizedApartmentChanges([october, november], [reading('water', '2026-10', {
        main: channel(431, 400), water2: channel(105, 100) })]), /менший за попередній/);
});

test('нові прилади не приймають дроби, невідому зону або порожній двозонний набір, фінансові поля не зберігаються', () => {
    for (const channels of [{ main: channel(1.5, 0) }, { day: channel(1, 0) }, { main: channel(1, 0), night: channel(2, 0) }]) {
        assert.throws(() => reading('electricity', '2026-10', channels));
    }
    assert.throws(() => reading('water', '2026-10', { water9: channel(1, 0) }));
    assert.throws(() => reading('water', '2026-10', { main: channel(1, 0, { name: 'x'.repeat(61) }) }));
    const clean = reading('water', '2026-10', { main: channel(1, 0, { tariff: 999, balance: 0 }) });
    assert.equal('tariff' in clean.channels.main, false); assert.equal('balance' in clean.channels.main, false);
    assert.equal('tariff' in clean, false);
});
