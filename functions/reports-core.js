'use strict';
// ============================================================
// Звітність (частина 9): дані для Податкового розрахунку J0500111 з
// затвердженої відомості зарплати й платежів за нею.
//
// XML за XSD ДПС поки не формуємо (схеми ще не перевірено на пробному
// поданні): кабінет показує готові суми за людьми — їх переносять у
// форму в Електронному кабінеті, де голова підписує й подає звіт.
// Ознаки доходу 4ДФ: 101 — зарплата, 102 — договір ЦПД (LEGAL.md, розділ 7).
// ============================================================
const payroll = require('./payroll-core');

// Ключі — як у календарі кабінету (js/tax-calendar.js): місяць без нуля.
const KEY_RE = /^(?:(j0500111|esv)-(\d{4})-(1[0-2]|[1-9])|(budget|fs-stat|npo|land)-(\d{4}))$/;
const STATUSES = { submitted: 'подано', accepted: 'прийнято', rejected: 'відхилено', not_required: 'не потрібно', paid: 'сплачено' };
const INCOME_SIGN = { employee: '101', gph: '102' };

const validKey = key => KEY_RE.test(String(key || ''));
/** 'j0500111-2026-10' → '2026-10'; для річних — null. */
function periodOf(key) {
    const m = KEY_RE.exec(String(key || ''));
    return m && m[1] ? `${m[2]}-${String(m[3]).padStart(2, '0')}` : null;
}
const keyFor = (kind, period) => `${kind}-${period.slice(0, 4)}-${Number(period.slice(5, 7))}`;

/** Строк ЄСВ і розрахунку — 20 число наступного місяця. */
function dueDate(period) {
    const [y, m] = period.split('-').map(Number);
    return new Date(Date.UTC(y, m, 20)).toISOString().slice(0, 10);
}

/**
 * Дані розрахунку за місяць.
 *   stored   — payroll_runs/{period} (або null)
 *   people   — Map(id → картка) для дат прийому/звільнення
 *   payments — платежі за відомістю: [{ stage, key, status, amountKop }]
 * Повертає { period, status, summary, income (4ДФ), esv (Д1), relations (Д5), checks }.
 */
function payrollReport({ period, stored, people = new Map(), payments = [] }) {
    const checks = [];
    const status = stored?.status || 'none';
    const run = stored?.run || null;
    const rows = status === 'approved' && run ? run.rows : [];
    if (status === 'none') checks.push({ level: 'block', text: 'Відомість зарплати за місяць не складено' });
    if (status === 'draft') checks.push({ level: 'block', text: 'Відомість ще не затверджена головою — цифри можуть змінитися' });

    const paid = (stage, key) => payments.some(p => p.stage === stage && p.key === key && p.status === 'paid');
    const stages = ['advance', 'final'];
    // Без авансу остаточний розрахунок платить усе нараховане за місяць.
    const withAdvance = payments.some(p => p.stage === 'advance');
    const part = (row, stage, field) => (withAdvance ? row?.[stage]?.[field] || 0
        : stage === 'final' ? (row?.advance?.[field] || 0) + (row?.final?.[field] || 0) : 0);
    const income = rows.map(r => {
        const rnokpp = r.payee?.rnokpp || people.get(r.personId)?.rnokpp || '';
        const got = stage => (paid(stage, r.personId) ? part(r, stage, 'grossKop') : 0);
        const taxPaid = (tax, field) => stages.reduce((s, st) => s + (paid(st, tax) ? part(r, st, field) : 0), 0);
        return {
            personId: r.personId, name: r.name, rnokpp, kind: r.kind, sign: INCOME_SIGN[r.kind] || '101',
            grossKop: r.grossKop, paidKop: got('advance') + got('final'),
            pdfoKop: r.pdfoKop, pdfoPaidKop: taxPaid('pdfo', 'pdfoKop'),
            vzKop: r.vzKop, vzPaidKop: taxPaid('vz', 'vzKop')
        };
    });
    const esv = rows.map(r => {
        const person = people.get(r.personId) || {};
        return {
            personId: r.personId, name: r.name, rnokpp: r.payee?.rnokpp || person.rnokpp || '', kind: r.kind,
            days: r.kind === 'employee' ? payroll.employmentDays(person, period) : null,
            normDays: r.kind === 'employee' ? r.normDays : null,
            grossKop: r.grossKop, baseKop: r.esvBaseKop, topUpKop: Math.max(0, r.esvBaseKop - r.grossKop), esvKop: r.esvKop
        };
    });
    // Д5: початок і кінець трудових відносин і договорів ЦПД у цьому місяці.
    const relations = [];
    for (const p of people.values()) {
        for (const [field, what] of [['from', 'start'], ['to', 'end']]) {
            if (String(p[field] || '').slice(0, 7) === period) {
                relations.push({ personId: p.id, name: p.name, rnokpp: p.rnokpp || '', kind: p.kind, event: what, date: p[field], position: p.position || '' });
            }
        }
    }
    relations.sort((a, b) => a.date.localeCompare(b.date) || a.name.localeCompare(b.name, 'uk'));

    for (const r of income) if (!payroll.validRnokpp(r.rnokpp)) checks.push({ level: 'block', text: `${r.name}: немає правильного РНОКПП` });
    const sum = (list, k) => list.reduce((s, r) => s + (r[k] || 0), 0);
    const summary = {
        people: rows.length, employees: rows.filter(r => r.kind === 'employee').length, gph: rows.filter(r => r.kind === 'gph').length,
        grossKop: sum(income, 'grossKop'), paidKop: sum(income, 'paidKop'),
        pdfoKop: sum(income, 'pdfoKop'), pdfoPaidKop: sum(income, 'pdfoPaidKop'),
        vzKop: sum(income, 'vzKop'), vzPaidKop: sum(income, 'vzPaidKop'),
        esvBaseKop: sum(esv, 'baseKop'), esvKop: sum(esv, 'esvKop'),
        esvPaidKop: stages.reduce((s, st) => s + (paid(st, 'esv') ? part(run?.totals, st, 'esvKop') : 0), 0),
        due: dueDate(period)
    };
    if (rows.length) {
        if (summary.pdfoPaidKop < summary.pdfoKop || summary.vzPaidKop < summary.vzKop) {
            checks.push({ level: 'warn', text: 'Не всі ПДФО й військовий збір сплачено (видно за проведеними платежами відомості)' });
        }
        if (summary.esvPaidKop < summary.esvKop) checks.push({ level: 'warn', text: `ЄСВ сплачено не повністю — строк ${summary.due.split('-').reverse().join('.')}` });
        if (summary.paidKop < summary.grossKop) checks.push({ level: 'info', text: 'Частину зарплати ще не виплачено — у розрахунку показуються нараховані суми' });
    }
    if (!rows.length && status === 'approved') checks.push({ level: 'info', text: 'Нарахувань фізособам немає' });
    return { period, status, summary, income, esv, relations, checks };
}

module.exports = { KEY_RE, STATUSES, INCOME_SIGN, validKey, periodOf, keyFor, dueDate, payrollReport };
