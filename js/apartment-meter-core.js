import { normalizeMeterReading, meterSeries, integerReading, METER_RESOURCES, periodLabel } from './meter-core.js';

export const APARTMENT_METER_KIND = 'apartmentMeterReading';
export const APARTMENT_RESOURCES = ['electricity', 'water'];
export const WATER_CHANNELS = ['main', 'water2', 'water3', 'water4', 'water5', 'water6', 'water7', 'water8'];
export const apartmentMeterId = (apt, resource, period) => `${apt}_${resource}_${period}`;
export const apartmentChannelName = (resource, channel) => resource === 'electricity'
    ? ({ main: 'Електроенергія', day: 'День', night: 'Ніч' })[channel] : channel === 'main' ? 'Вода' : `Лічильник ${channel.slice(5)}`;

/** Старий запис з одним показником лишається основним лічильником. */
export function apartmentChannels(row) {
    return row.channels || { main: { name: apartmentChannelName(row.resource, 'main'),
        reading: row.reading, baseline: row.baseline, reset: row.reset, note: row.note || '' } };
}

export function normalizeApartmentChannel(input, requireInteger = true) {
    const value = normalizeMeterReading({ ...input, tariff: 0, heatedArea: undefined, totalArea: undefined });
    if (requireInteger && integerReading(value.reading) === null) throw new Error('Новий показник вводиться лише цілим числом');
    const name = String(input.name || apartmentChannelName(input.resource, input.channel || 'main')).trim();
    if (!name || name.length > 60) throw new Error('Вкажіть назву лічильника до 60 символів');
    return { name, reading: value.reading, baseline: value.baseline, reset: value.reset, note: value.note };
}

function storedApartmentReading(input, requireInteger = true) {
    if (!APARTMENT_RESOURCES.includes(input.resource)) throw new Error('Оберіть квартирний лічильник світла або води');
    let channels;
    if (input.channels !== undefined) {
        if (!input.channels || typeof input.channels !== 'object' || Array.isArray(input.channels)) throw new Error('Некоректний список лічильників');
        const keys = Object.keys(input.channels);
        const valid = input.resource === 'electricity'
            ? keys.length === 1 && keys[0] === 'main' || keys.length === 2 && keys.includes('day') && keys.includes('night')
            : keys.length > 0 && keys.length <= WATER_CHANNELS.length && keys.every(key => WATER_CHANNELS.includes(key));
        if (!valid) throw new Error('Для електроенергії оберіть один показник або день/ніч; водомірів може бути від 1 до 8');
        channels = Object.fromEntries(keys.map(channel => [channel, normalizeApartmentChannel({ ...input.channels[channel],
            resource: input.resource, period: input.period, unit: input.unit, channel }, requireInteger)]));
        const values = Object.values(channels);
        input = { ...input, reading: values.reduce((sum, row) => sum + row.reading, 0),
            baseline: values.reduce((sum, row) => sum + row.baseline, 0), reset: values.some(row => row.reset),
            note: values.length === 1 ? values[0].note : '' };
    }
    const { tariff, heatedArea, totalArea, ...row } = normalizeMeterReading({ ...input, tariff: 0, heatedArea: undefined, totalArea: undefined });
    if (requireInteger && integerReading(row.reading) === null) throw new Error('Новий показник вводиться лише цілим числом');
    return { ...row, kind: APARTMENT_METER_KIND, ...(channels ? { channels } : {}) };
}

export const normalizeApartmentReading = input => storedApartmentReading(input);

export function apartmentChannelSeries(records, resource, channel) {
    const values = records.filter(row => row.resource === resource && apartmentChannels(row)[channel])
        .map(row => ({ ...row, ...apartmentChannels(row)[channel], tariff: 0, channel }));
    return meterSeries(values, resource);
}

export function apartmentSeries(records, resource) {
    const values = records.filter(row => row.resource === resource).slice().sort((a, b) => a.period.localeCompare(b.period));
    const keys = new Set(values.flatMap(row => Object.keys(apartmentChannels(row))));
    const series = new Map([...keys].map(key => [key, new Map(apartmentChannelSeries(values, resource, key).map(row => [row.period, row]))]));
    return values.map(row => {
        const channelReadings = Object.keys(apartmentChannels(row)).map(key => series.get(key).get(row.period));
        const sum = field => Math.round(channelReadings.reduce((total, value) => total + value[field], 0) * 1e6) / 1e6;
        const invalid = channelReadings.find(value => value.error);
        return { ...row, channelReadings, effectiveBaseline: sum('effectiveBaseline'), consumption: sum('consumption'), cost: 0,
            previousPeriod: channelReadings[0].previousPeriod, error: invalid ? `${invalid.name}: ${invalid.error}` : null };
    });
}

export function validateApartmentChanges(records, changes) {
    const clean = changes.map(normalizeApartmentReading);
    const key = row => `${row.resource}_${row.period}`;
    if (new Set(clean.map(key)).size !== clean.length) throw new Error('Один ресурс можна зберегти лише один раз за місяць');
    const next = new Map(records.map(row => [key(row), row]));
    clean.forEach(row => next.set(key(row), row));
    for (const resource of new Set(clean.map(row => row.resource))) {
        const invalid = apartmentSeries([...next.values()], resource).find(row => row.error);
        if (invalid) throw new Error(`${METER_RESOURCES[resource].label}, ${periodLabel(invalid.period)}: ${invalid.error}`);
    }
    return clean;
}

export function synchronizedApartmentChanges(records, changes) {
    const clean = validateApartmentChanges(records, changes);
    const key = row => `${row.resource}_${row.period}`;
    const next = new Map(records.map(row => [key(row), row]));
    const writes = new Map(clean.map(row => [key(row), row]));
    clean.forEach(row => next.set(key(row), row));
    for (const resource of new Set(clean.map(row => row.resource))) {
        for (const row of apartmentSeries([...next.values()], resource)) {
            const source = next.get(key(row));
            if (!row.channelReadings.some(value => value.baseline !== value.effectiveBaseline)) continue;
            const patch = source.channels ? { channels: Object.fromEntries(row.channelReadings.map(value => [value.channel,
                { ...source.channels[value.channel], baseline: value.effectiveBaseline }])) } : { baseline: row.effectiveBaseline };
            writes.set(key(row), storedApartmentReading({ ...source, ...patch }, false));
        }
    }
    return [...writes.values()];
}
