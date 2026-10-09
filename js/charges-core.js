// ============================================================
// Нарахування в кабінеті бухгалтера: розбір вхідних залишків,
// вивантаження відомості й квитанції. Без DOM і бази — тести в
// tests/unit/charges-core.test.mjs. Розрахунки сум робить сервер
// (functions/charges-core.js); тут лише підготовка й показ.
// ============================================================

const MONTHS = ['січень', 'лютий', 'березень', 'квітень', 'травень', 'червень',
    'липень', 'серпень', 'вересень', 'жовтень', 'листопад', 'грудень'];
const MONTHS_GEN = ['січня', 'лютого', 'березня', 'квітня', 'травня', 'червня',
    'липня', 'серпня', 'вересня', 'жовтня', 'листопада', 'грудня'];

/** «2026-10» → «жовтень 2026». */
export function periodName(p) {
    const [y, m] = String(p).split('-').map(Number);
    return MONTHS[m - 1] ? `${MONTHS[m - 1]} ${y}` : String(p);
}

/** «2026-10» → «01 жовтня 2026» — дата, на яку залишок «на початок». */
export function periodStart(p) {
    const [y, m] = String(p).split('-').map(Number);
    return MONTHS_GEN[m - 1] ? `01 ${MONTHS_GEN[m - 1]} ${y}` : String(p);
}

export function shiftPeriod(p, months) {
    const [y, m] = p.split('-').map(Number);
    const total = y * 12 + (m - 1) + months;
    return `${Math.floor(total / 12)}-${String(total % 12 + 1).padStart(2, '0')}`;
}

/** Місяці від початку обліку до поточного, найновіший перший. */
export function periodsBetween(from, to) {
    const out = [];
    for (let p = from; p <= to && out.length < 120; p = shiftPeriod(p, 1)) out.push(p);
    return out.reverse();
}

/** «1 250,40», «-1250.4», «−300» → копійки; null — не число. */
export function toKop(text) {
    const t = String(text ?? '').replace(/[\s ]/g, '').replace(/[−–]/g, '-').replace(/грн\.?$/i, '').replace(/^"|"$/g, '');
    if (!/^[-+]?\d+([.,]\d{1,2})?$/.test(t)) return null;
    const negative = t.startsWith('-');
    const [whole, frac = ''] = t.replace(/^[-+]/, '').split(/[.,]/);
    const kop = Number(whole) * 100 + Number((frac + '00').slice(0, 2));
    return negative ? -kop : kop;
}

/** Копійки → «−1 250,40» (без «грн»), нуль — «0,00». */
export function fmtKop(kop) {
    const abs = (Math.abs(kop) / 100).toLocaleString('uk-UA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return `${kop < 0 ? '−' : ''}${abs}`;
}

/**
 * Вхідні залишки рядками «квартира сума». Роздільник — крапка з
 * комою, табуляція або пробіл (кома зайнята копійками).
 * positive: що означає число без мінуса — 'overpaid' (як у застосунку:
 * мінус — борг) чи 'debt' (як сальдо в бухгалтерських програмах).
 * Повертає { rows: [{ apt, amountKop }] у знаку застосунку, errors }.
 */
export function parseOpeningLines(text, positive = 'overpaid') {
    const rows = [], errors = [];
    const seen = new Map();
    String(text || '').replace(/^﻿/, '').split(/\r?\n/).forEach((line, i) => {
        const raw = line.trim();
        if (!raw) return;
        const m = raw.match(/^"?(?:кв\.?\s*)?([^;\t\s"]+)"?\s*[;\t]\s*(.+)$/i) || raw.match(/^(?:кв\.?\s*)?(\S+)\s+(.+)$/i);
        const apt = m ? m[1].toLowerCase().replace(/^кв\.?/, '') : '';
        const kop = m ? toKop(m[2].split(/[;\t]/)[0]) : null;
        if (!apt || kop === null) {
            // Заголовок таблиці — не помилка.
            if (!(i === 0 && /кв|apt|сума|сальдо|борг/i.test(raw))) errors.push({ line: i + 1, raw });
            return;
        }
        const amountKop = positive === 'debt' ? -kop : kop;
        if (seen.has(apt)) rows[seen.get(apt)].amountKop = amountKop;   // останній рядок перемагає
        else { seen.set(apt, rows.length); rows.push({ apt, amountKop }); }
    });
    return { rows, errors };
}

/** Зведення залишків для попереднього перегляду. */
export function openingSummary(rows) {
    return {
        count: rows.length,
        debtKop: rows.reduce((s, r) => s + Math.min(0, r.amountKop), 0),
        overpaidKop: rows.reduce((s, r) => s + Math.max(0, r.amountKop), 0),
        debtors: rows.filter(r => r.amountKop < 0).length
    };
}

const csvCell = v => {
    const s = String(v ?? '');
    return /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const csvMoney = kop => (kop / 100).toFixed(2).replace('.', ',');

/**
 * Відомість розрахунків у CSV для Excel і сервісу бухгалтера:
 * крапка з комою, кома в сумах, BOM — щоб Excel узяв UTF-8.
 */
export function statementCsv(statement, extra = new Map()) {
    const head = ['Квартира', 'Особовий рахунок', 'Площа, м²', 'Залишок на початок', 'Нараховано', 'Сплачено', 'Залишок на кінець'];
    const lines = statement.rows.map(r => {
        const a = extra.get(r.apt) || {};
        return [r.apt, a.personalAccount || '', a.area ?? '', csvMoney(r.opening), csvMoney(r.charged), csvMoney(r.paid), csvMoney(r.closing)];
    });
    const t = statement.totals;
    lines.push(['Разом', '', '', csvMoney(t.opening), csvMoney(t.charged), csvMoney(t.paid), csvMoney(t.closing)]);
    return '﻿' + [head, ...lines].map(row => row.map(csvCell).join(';')).join('\r\n');
}

/** Призначення платежу у квитанції: з номером квартири й особовим — тоді банк рознесе оплату сам. */
export function receiptPurpose(template, apt, account, period) {
    let text = String(template || 'Внески на утримання будинку, кв. {apt}')
        .replace(/\{apt\}/g, apt).replace(/\{account\}/g, account || '');
    if (account && !text.includes(account)) text += `, особовий рахунок ${account}`;
    if (period) text += `, за ${periodName(period)}`;
    return text.replace(/,\s*,/g, ',').replace(/\s{2,}/g, ' ').trim().slice(0, 140);
}
