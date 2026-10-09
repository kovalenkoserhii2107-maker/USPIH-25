// Спільні розрахунки загальнобудинкового обліку, без DOM і Firebase.
export const METER_RESOURCES = {
    electricity: { label: 'Електроенергія', units: ['кВт·год'], color: '#e7a317' },
    heat: { label: 'Тепло', units: ['Гкал', 'МВт·год'], color: '#e56854' },
    water: { label: 'Вода', units: ['м³'], color: '#2584da' }
};
export const METER_KIND = 'houseMeterReading';
export const HEAT_TARIFF_KIND = 'houseHeatTariff';
export const RESOURCE_TARIFF_KIND = 'houseResourceTariff';

/** Порожнє або зіпсоване число не перетворюється на нуль. */
export function decimalValue(value) {
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    const text = String(value ?? '').trim().replace(/[\s\u00a0\u202f]/g, '').replace(',', '.');
    if (!/^[+-]?\d+(?:\.\d+)?$/.test(text)) return null;
    const number = Number(text);
    return Number.isFinite(number) ? number : null;
}

export function integerReading(value) {
    const number = decimalValue(value);
    return Number.isSafeInteger(number) && number >= 0 && number <= 1e10 ? number : null;
}

export function validPeriod(period) { return /^\d{4}-(0[1-9]|1[0-2])$/.test(String(period || '')); }
export function normalizeResourceTariff(input) {
    const resource = METER_RESOURCES[input.resource];
    if (!resource) throw new Error('Оберіть ресурс для тарифу');
    const effectiveFrom = String(input.effectiveFrom || '');
    const date = new Date(`${effectiveFrom}T12:00:00Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(effectiveFrom) || !Number.isFinite(date.getTime())
        || date.toISOString().slice(0, 10) !== effectiveFrom) throw new Error('Вкажіть дату початку дії тарифу');
    const tariff = decimalValue(input.tariff);
    if (tariff === null || tariff < 0 || tariff > 1e10) throw new Error(`Вкажіть невід’ємний тариф: ${resource.label}, грн/${resource.units[0]}`);
    return { kind: input.resource === 'heat' ? HEAT_TARIFF_KIND : RESOURCE_TARIFF_KIND,
        resource: input.resource, unit: resource.units[0], effectiveFrom, tariff };
}
export const normalizeHeatTariff = input => normalizeResourceTariff({ ...input, resource: 'heat' });

/** У місячний облік підставляємо тариф, чинний на початок місяця. */
export function resourceTariffForPeriod(tariffs, resource, period) {
    if (!validPeriod(period)) return null;
    return tariffs.filter(row => (row.resource || 'heat') === resource && row.effectiveFrom <= `${period}-01`
        && row.unit === METER_RESOURCES[resource]?.units[0])
        .slice().sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom))[0] || null;
}
export const heatTariffForPeriod = (tariffs, period) => resourceTariffForPeriod(tariffs, 'heat', period);

/** Єдине джерело ціни — датований тариф; старі записи працюють до його внесення. */
export function readingTariff(tariffs, resource, period, unit, current, prior) {
    // 1 МВт·год = 3,6 ГДж; 1 Гкал = 4,1868 ГДж.
    const gcalPerUnit = { 'Гкал': 1, 'МВт·год': 3.6 / 4.1868 };
    if (!METER_RESOURCES[resource]?.units.includes(unit)) return null;
    for (const source of [resourceTariffForPeriod(tariffs, resource, period), current, prior]) {
        const tariff = decimalValue(source?.tariff);
        if (tariff !== null && tariff >= 0) {
            if (source.unit === unit) return tariff;
            if (resource === 'heat' && gcalPerUnit[source.unit]) return tariff * gcalPerUnit[unit] / gcalPerUnit[source.unit];
        }
    }
    return null;
}
export const heatReadingTariff = (tariffs, period, unit, current, prior) => readingTariff(tariffs, 'heat', period, unit, current, prior);
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
    const totalArea = decimalValue(input.totalArea);
    return { kind: METER_KIND, resource: input.resource, period: input.period, unit,
        reading, baseline, tariff, reset: input.reset === true, note,
        ...(input.resource === 'heat' && heatedArea !== null ? { heatedArea } : {}),
        ...(input.resource === 'heat' && totalArea > 0 ? { totalArea } : {}) };
}

export function apartmentHeatShare(row, area, buildingArea = row?.totalArea ?? row?.heatedArea) {
    const apartmentArea = decimalValue(area), totalArea = decimalValue(buildingArea);
    if (!row || row.error || apartmentArea === null || apartmentArea <= 0 || !totalArea || apartmentArea > totalArea) return null;
    return Math.round((row.cost * apartmentArea / totalArea + Number.EPSILON) * 100) / 100;
}

/** Площа в записі зберігає основу розрахунку за конкретний місяць. */
export function apartmentHeatCalculation(row, area, publishedArea) {
    const totalArea = [row?.totalArea, publishedArea, row?.heatedArea]
        .map(decimalValue).find(value => value > 0);
    const cost = apartmentHeatShare(row, area, totalArea);
    if (cost === null) return null;
    const apartmentArea = decimalValue(area);
    return { apartmentArea, totalArea, cost, perSquareMeter: row.cost / totalArea,
        volume: Math.round(row.consumption * apartmentArea / totalArea * 1e6) / 1e6 };
}

/** Частка квартири за кожен місяць, за який правління внесло тепло. */
export function apartmentHeatHistory(records, area, publishedArea) {
    return meterSeries(records, 'heat').map(row => ({ row,
        calculation: row.error ? null : apartmentHeatCalculation(row, area, publishedArea) }));
}

export function buildingTotalArea(apartments) {
    const homes = apartments.filter(row => {
        if (row.isAdmin === true) return false;
        const id = String(row.apt ?? row.id ?? '');
        // Порожній технічний профіль не є приміщенням будинку.
        return !id || /\d/.test(id) || String(row.area ?? '').trim() !== '' || row.owners?.length > 0;
    });
    if (!homes.length || homes.some(row => decimalValue(row.area) === null || decimalValue(row.area) <= 0)) return null;
    return Math.round(homes.reduce((sum, row) => sum + decimalValue(row.area), 0) * 1e6) / 1e6;
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
