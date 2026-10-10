// Розрахунки екрана «Фінанси будинку», без DOM і Firebase.
import { METER_RESOURCES, meterSeries } from './meter-core.js';

// Тепло першим: зазвичай це найбільша стаття.
export const HOUSE_RESOURCES = ['heat', 'electricity', 'water'];
const round2 = value => Math.round((value + Number.EPSILON) * 100) / 100;
/** Порожнє поле — «не вказано», а не нуль: у них різний сенс. */
function money(value) {
    if (value === undefined || value === null || String(value).trim() === '') return null;
    const number = parseFloat(String(value).replace(/[\s  ]/g, '').replace(',', '.'));
    return Number.isFinite(number) ? number : null;
}

/** Звіт правління: залишок, надходження, витрати й статті від найбільшої. */
export function financeSummary(report) {
    const items = (report.items || [])
        .map(item => ({ label: String(item.label || '').trim(), amount: money(item.amount) ?? 0, ...(item.item ? { item: String(item.item) } : {}) }))
        .filter(item => item.label && item.amount > 0)
        .sort((a, b) => b.amount - a.amount);
    const spent = round2(items.reduce((sum, item) => sum + item.amount, 0));
    const income = money(report.income), funds = money(report.funds);
    return {
        period: String(report.period || '').trim(), funds, fundsDate: String(report.fundsDate || '').trim(),
        income, spent, difference: income === null ? null : round2(income - spent),
        spentShare: income > 0 ? spent / income * 100 : null,
        items: items.map(item => ({ ...item, share: spent ? item.amount / spent * 100 : 0 }))
    };
}

/** Ресурси будинку помісячно: рядок кожного ресурсу й сума внесених без помилок. */
export function houseResourceMonths(records) {
    const series = Object.fromEntries(HOUSE_RESOURCES.map(resource => [resource, meterSeries(records, resource)]));
    const periods = [...new Set(records.filter(row => HOUSE_RESOURCES.includes(row.resource)).map(row => row.period))].sort();
    return periods.map(period => {
        const rows = HOUSE_RESOURCES.map(resource => ({ resource, label: METER_RESOURCES[resource].label,
            row: series[resource].find(row => row.period === period) || null }));
        const total = round2(rows.reduce((sum, { row }) => sum + (row && !row.error ? row.cost : 0), 0));
        return { period, rows, total };
    });
}

/** Зміна вартості ресурсу щодо попереднього місяця з даними, у відсотках. */
export function costChange(months, period, resource) {
    const index = months.findIndex(month => month.period === period);
    const current = months[index]?.rows.find(row => row.resource === resource)?.row;
    if (!current || current.error) return null;
    for (let i = index - 1; i >= 0; i -= 1) {
        const previous = months[i].rows.find(row => row.resource === resource)?.row;
        if (previous && !previous.error) {
            return previous.cost > 0 ? { period: months[i].period, change: Math.round((current.cost - previous.cost) / previous.cost * 100) } : null;
        }
    }
    return null;
}
