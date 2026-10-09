// ============================================================
// Податковий календар ОСББ: строки звітів і платежів за правилами,
// а не списком дат, — щоб календар не застарівав щороку.
//
// Правила й підстави — docs/accounting/LEGAL.md, розділ 11:
//   • податковий розрахунок ПДФО/ВЗ/ЄСВ (J0500111) — щомісяця, 20 днів
//     після місяця (п. 51.1, пп. 49.18.1 ПКУ);
//   • ЄСВ — до 20 числа наступного місяця (ч. 8 ст. 9 Закону № 2464-VI);
//   • Звіт неприбуткової організації (J0101911) + ФЗ — 60 днів після
//     року (пп. 49.18.3 ПКУ); ФЗ для Держстату — до 28 лютого;
//   • земельна декларація — до 20 лютого (лише якщо ділянка на ОСББ);
//   • кошторис на рік — до 01 січня (п. 4.12.2 статуту).
// Строк подання з суботи чи неділі переноситься на понеділок (п. 49.20
// ПКУ). Під час воєнного стану святкові дні робочі (ст. 73 КЗпП не
// застосовується), тож свята не враховуємо. Сплату радимо робити до
// вихідного: однозначної норми про її перенесення немає.
// ============================================================

const MONTHS_GEN = ['січня', 'лютого', 'березня', 'квітня', 'травня', 'червня',
    'липня', 'серпня', 'вересня', 'жовтня', 'листопада', 'грудня'];
const MONTHS_NOM = ['січень', 'лютий', 'березень', 'квітень', 'травень', 'червень',
    'липень', 'серпень', 'вересень', 'жовтень', 'листопад', 'грудень'];

const day = (y, m, d) => new Date(Date.UTC(y, m, d));
const weekday = date => date.getUTCDay();

/** Строк подання: з вихідного — на понеділок. */
export function fileBy(date) {
    const d = new Date(date);
    while (weekday(d) === 0 || weekday(d) === 6) d.setUTCDate(d.getUTCDate() + 1);
    return d;
}

/** Строк сплати: з вихідного — на пʼятницю перед ним. */
export function payBy(date) {
    const d = new Date(date);
    while (weekday(d) === 0 || weekday(d) === 6) d.setUTCDate(d.getUTCDate() - 1);
    return d;
}

/** 60-й день після 31 грудня року year. */
function sixtyDaysAfter(year) {
    const d = day(year, 11, 31);
    d.setUTCDate(d.getUTCDate() + 60);
    return d;
}

/**
 * Події календаря в межах [from, to].
 * flags: { payroll: є працівники/ЦПД, land: ділянка оформлена на ОСББ }
 * Повертає [{ date, key, title, detail, kind: report|payment|decision }], за датою.
 */
export function deadlines(from, to, flags = { payroll: true, land: false }) {
    const out = [];
    const start = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() - 1, 1));
    for (let d = start; d <= to; d = day(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)) {
        const y = d.getUTCFullYear(), m = d.getUTCMonth();
        const month = `${MONTHS_NOM[m]} ${y}`;
        const twentieth = day(y, m + 1, 20);
        if (flags.payroll) {
            out.push({ date: fileBy(twentieth), key: `j0500111-${y}-${m + 1}`, kind: 'report',
                title: `Податковий розрахунок за ${month}`, detail: 'ПДФО, військовий збір, ЄСВ (J0500111)' });
            out.push({ date: payBy(twentieth), key: `esv-${y}-${m + 1}`, kind: 'payment',
                title: `Сплатити ЄСВ за ${month}`, detail: '22 % нарахованих виплат' });
        }
        if (m === 11) {
            out.push({ date: day(y, 11, 31), key: `budget-${y + 1}`, kind: 'decision',
                title: `Кошторис на ${y + 1} рік`, detail: 'Затверджують загальні збори до 01 січня (п. 4.12.2 статуту)' });
        }
        if (m === 0) {
            const prev = y - 1;
            out.push({ date: payBy(day(y, 1, 28)), key: `fs-stat-${prev}`, kind: 'report',
                title: `Фінансова звітність за ${prev} рік`, detail: 'Баланс і звіт про фінансові результати у форматі «S» — ДПС і Держстат' });
            out.push({ date: fileBy(sixtyDaysAfter(prev)), key: `npo-${prev}`, kind: 'report',
                title: `Звіт неприбуткової організації за ${prev} рік`, detail: 'Звіт про використання доходів (J0101911) разом із фінзвітністю' });
            if (flags.land) out.push({ date: fileBy(day(y, 1, 20)), key: `land-${y}`, kind: 'report',
                title: `Декларація з плати за землю на ${y} рік`, detail: 'Якщо ділянка оформлена на ОСББ' });
        }
    }
    return out.filter(e => e.date >= from && e.date <= to).sort((a, b) => a.date - b.date || a.key.localeCompare(b.key));
}

/** «20 жовтня». */
export const humanDate = date => `${date.getUTCDate()} ${MONTHS_GEN[date.getUTCMonth()]}`;

/** Скільки днів лишилося від today (локальна дата) до date (UTC-день). */
export function daysLeft(date, today = new Date()) {
    const t = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate());
    return Math.round((date - t) / 86400000);
}
