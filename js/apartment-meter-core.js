import { normalizeMeterReading, validateMeterChanges, meterSeries, integerReading } from './meter-core.js';

export const APARTMENT_METER_KIND = 'apartmentMeterReading';
export const APARTMENT_RESOURCES = ['electricity', 'water'];
export const apartmentMeterId = (apt, resource, period) => `${apt}_${resource}_${period}`;

function storedApartmentReading(input) {
    if (!APARTMENT_RESOURCES.includes(input.resource)) throw new Error('Оберіть квартирний лічильник світла або води');
    const { tariff, heatedArea, ...row } = normalizeMeterReading({ ...input, tariff: 0, heatedArea: undefined });
    return { ...row, kind: APARTMENT_METER_KIND };
}

export function normalizeApartmentReading(input) {
    const row = storedApartmentReading(input);
    if (integerReading(row.reading) === null) throw new Error('Новий показник вводиться лише цілим числом');
    return row;
}

export function validateApartmentChanges(records, changes) {
    const clean = changes.map(normalizeApartmentReading);
    validateMeterChanges(records.map(row => ({ ...row, tariff: 0 })), clean.map(row => ({ ...row, tariff: 0 })));
    return clean;
}

export const apartmentSeries = (records, resource) => meterSeries(records.map(row => ({ ...row, tariff: 0 })), resource);

export function synchronizedApartmentChanges(records, changes) {
    const clean = validateApartmentChanges(records, changes);
    const next = new Map(records.map(row => [`${row.resource}_${row.period}`, row]));
    const writes = new Map(clean.map(row => [`${row.resource}_${row.period}`, row]));
    clean.forEach(row => next.set(`${row.resource}_${row.period}`, row));
    for (const resource of new Set(clean.map(row => row.resource))) {
        for (const row of apartmentSeries([...next.values()], resource)) {
            if (row.baseline !== row.effectiveBaseline) writes.set(`${row.resource}_${row.period}`,
                storedApartmentReading({ ...row, baseline: row.effectiveBaseline }));
        }
    }
    return [...writes.values()];
}
