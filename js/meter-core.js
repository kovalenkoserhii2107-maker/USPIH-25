// Спільні розрахунки загальнобудинкового обліку, без DOM і Firebase.
export const METER_RESOURCES = {
    electricity: { label: 'Електроенергія', units: ['кВт·год'], color: '#e7a317' },
    heat: { label: 'Тепло', units: ['Гкал', 'МВт·год'], color: '#e56854' },
    water: { label: 'Вода', units: ['м³'], color: '#2584da' }
};
export const METER_KIND = 'houseMeterReading';

/** Порожнє або зіпсоване число не перетворюється на нуль. */
export function decimalValue(value) {
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    const text = String(value ?? '').trim().replace(/[\s\u00a0\u202f]/g, '').replace(',', '.');
    if (!/^[+-]?\d+(?:\.\d+)?$/.test(text)) return null;
    const number = Number(text);
    return Number.isFinite(number) ? number : null;
}

export function validPeriod(period) { return /^\d{4}-(0[1-9]|1[0-2])$/.test(String(period || '')); }
export const meterRecordId = (resource, period) => `meter_${resource}_${period}`;
export const periodLabel = period => validPeriod(period)
    ? new Date(`${period}-01T12:00:00`).toLocaleDateString('uk-UA', { month: 'long', year: 'numeric' }) : String(period || '');

export function normalizeMeterReading(input) {
    const resource = METER_RESOURCES[input.resource];
    if (!resource || !validPeriod(input.period)) throw new Error('Оберіть ресурс і місяць обліку');
    const unit = input.unit || resource.units[0];
    if (!resource.units.includes(unit)) throw new Error('Некоректна одиниця вимірювання');
    const reading = decimalValue(input.reading), baseline = decimalValue(input.baseline), tariff = decimalValue(input.tariff);
    if (reading === null || reading < 0) throw new Error(`${resource.label}: введіть невід’ємний поточний показник`);
    if (baseline === null || baseline < 0) throw new Error(`${resource.label}: введіть початковий / попередній показник`);
    if (tariff === null || tariff < 0) throw new Error(`${resource.label}: введіть тариф за одиницю`);
    if ([reading, baseline, tariff].some(value => value > 1e10)) throw new Error('Число перевищує допустимий розмір');
    const note = String(input.note || '').trim();
    if (note.length > 500) throw new Error('Примітка має містити до 500 символів');
    const heatedArea = decimalValue(input.heatedArea);
    if (input.resource === 'heat' && input.heatedArea != null && String(input.heatedArea).trim() !== ''
        && (heatedArea === null || heatedArea <= 0 || heatedArea > 1e7)) throw new Error('Вкажіть додатну загальну опалювану площу');
    return { kind: METER_KIND, resource: input.resource, period: input.period, unit,
        reading, baseline, tariff, reset: input.reset === true, note,
        ...(input.resource === 'heat' && heatedArea !== null ? { heatedArea } : {}) };
}

export function apartmentHeatShare(row, area) {
    const apartmentArea = decimalValue(area), totalArea = decimalValue(row?.heatedArea);
    if (!row || row.error || apartmentArea === null || apartmentArea <= 0 || !totalArea || apartmentArea > totalArea) return null;
    return Math.round((row.cost * apartmentArea / totalArea + Number.EPSILON) * 100) / 100;
}

/** Зміна історичного показника перераховує наступний інтервал, з його власним тарифом. */
export function meterSeries(records, resource) {
    const sorted = records.filter(row => row.resource === resource)
        .slice().sort((a, b) => a.period.localeCompare(b.period));
    let previous = null;
    return sorted.map(row => {
        const initial = row.reset || !previous;
        const baseline = initial ? row.baseline : previous.reading;
        const consumption = Math.round((row.reading - baseline) * 1e6) / 1e6;
        const error = !METER_RESOURCES[resource]?.units.includes(row.unit) ? 'Невідома одиниця вимірювання'
            : !initial && row.unit !== previous.unit ? 'Одиниця вимірювання змінилася без нового початку обліку'
            : row.reading < baseline ? 'Показник менший за попередній. Перевірте дані або позначте заміну лічильника'
            : null;
        const result = { ...row, effectiveBaseline: baseline, previousPeriod: initial ? null : previous.period,
            consumption, cost: Math.round((consumption * row.tariff + Number.EPSILON) * 100) / 100, error };
        previous = row;
        return result;
    });
}

export function validateMeterChanges(records, changes) {
    const normalized = changes.map(normalizeMeterReading);
    if (new Set(normalized.map(row => meterRecordId(row.resource, row.period))).size !== normalized.length) {
        throw new Error('Один ресурс можна зберегти лише один раз за місяць');
    }
    const next = new Map(records.map(row => [meterRecordId(row.resource, row.period), row]));
    normalized.forEach(row => next.set(meterRecordId(row.resource, row.period), row));
    for (const resource of new Set(normalized.map(row => row.resource))) {
        const invalid = meterSeries([...next.values()], resource).find(row => row.error);
        if (invalid) throw new Error(`${METER_RESOURCES[resource].label}, ${periodLabel(invalid.period)}: ${invalid.error}`);
    }
    return normalized;
}
