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

const paidAmount = (payments, stage, key) => payments.filter(p => p.status === 'paid' && p.stage === stage && p.key === key && Number.isSafeInteger(p.amountKop) && p.amountKop > 0).reduce((sum, p) => sum + p.amountKop, 0);
/** Розподіл фактично сплаченого податку: цілі копійки, сума частин точна. */
function distribute(amount, weights) {
    const total = weights.reduce((s, k) => s + k, 0);
    if (!total) return weights.map(() => 0);
    const bounded = Math.min(amount, total);
    const portions = weights.map((weight, index) => {
        const value = BigInt(bounded) * BigInt(weight);
        return { index, kop: Number(value / BigInt(total)), rest: value % BigInt(total) };
    });
    const left = bounded - portions.reduce((s, p) => s + p.kop, 0);
    const ranked = portions.slice().sort((a, b) => a.rest > b.rest ? -1 : a.rest < b.rest ? 1 : a.index - b.index);
    for (let i = 0; i < left; i++) ranked[i].kop++;
    return portions.map(p => p.kop);
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
    if (status === 'approved' && run && !Array.isArray(run.peopleSnapshot)) checks.push({ level: 'warn', text: 'Стара відомість не зберігає склад людей і дати відносин: звірте Д1/Д5 з кадровими документами' });

    const stages = ['advance', 'final'];
    // Без авансу остаточний розрахунок платить усе нараховане за місяць.
    const withAdvance = Boolean(stored?.stages?.advance) || payments.some(p => p.stage === 'advance' && ['paid', 'sent', 'sending', 'unknown'].includes(p.status));
    const part = (row, stage, field) => (withAdvance ? row?.[stage]?.[field] || 0
        : stage === 'final' ? (row?.advance?.[field] || 0) + (row?.final?.[field] || 0) : 0);
    const paidTax = {};
    for (const stage of stages) for (const [key, field] of [['pdfo', 'pdfoKop'], ['vz', 'vzKop']]) {
        paidTax[`${stage}:${key}`] = distribute(paidAmount(payments, stage, key), rows.map(r => part(r, stage, field)));
    }
    for (const p of payments) if (p.status === 'paid' && (!Number.isSafeInteger(p.amountKop) || p.amountKop <= 0)) checks.push({ level: 'block', text: 'У проведеному платежі відсутня правильна сума. Перевірте виписку.' });
    const income = rows.map((r, index) => {
        const rnokpp = r.payee ? r.payee.rnokpp || '' : people.get(r.personId)?.rnokpp || '';
        const got = stage => {
            const actual = paidAmount(payments, stage, r.personId), expected = part(r, stage, 'netKop');
            if (actual && actual !== expected) checks.push({ level: 'block', text: `${r.name}: проведена виплата не відповідає відомості; виплачений дохід треба уточнити` });
            return actual && actual === expected ? part(r, stage, 'grossKop') : 0;
        };
        const taxPaid = tax => stages.reduce((s, st) => s + paidTax[`${st}:${tax}`][index], 0);
        return {
            personId: r.personId, name: r.name, rnokpp, kind: r.kind, sign: INCOME_SIGN[r.kind] || '101',
            grossKop: r.grossKop, paidKop: got('advance') + got('final'),
            pdfoKop: r.pdfoKop, pdfoPaidKop: taxPaid('pdfo'),
            vzKop: r.vzKop, vzPaidKop: taxPaid('vz'),
            // Ознака ПСП (ст. 169.1 ПКУ) і сума пільги; відпускні й лікарняні — у складі доходу з ознакою 101.
            pspCode: r.pspCode || '', pspKop: r.pspKop || 0, vacationKop: r.vacationKop || 0, sickKop: (r.sickKop || 0) + (r.fundSickKop || 0)
        };
    });
    const esv = rows.map(r => {
        const person = r.relationship || people.get(r.personId) || {};
        if (!r.relationship) checks.push({ level: 'warn', text: `${r.name}: у старій відомості немає збережених дат відносин; дані Д1/Д5 треба звірити` });
        return {
            personId: r.personId, name: r.name, rnokpp: r.payee ? r.payee.rnokpp || '' : person.rnokpp || '', kind: r.kind,
            days: r.kind === 'gph' && !person.from ? null : payroll.calendarDays(person, period),
            normDays: new Date(Date.UTC(Number(period.slice(0, 4)), Number(period.slice(5, 7)), 0)).getUTCDate(),
            grossKop: r.grossKop, baseKop: r.esvBaseKop, topUpKop: Math.max(0, r.esvBaseKop - r.grossKop), esvKop: r.esvKop,
            // У Д1 лікарняні й відпускні — окремими рядками з власними кодами типу нарахувань (перевіряє бухгалтер).
            vacationKop: r.vacationKop || 0, vacationDays: r.vacationDays || 0, sickKop: (r.sickKop || 0) + (r.fundSickKop || 0), sickDays: r.sickDays || 0
        };
    });
    // Д5: початок і кінець трудових відносин і договорів ЦПД у цьому місяці.
    const relations = [];
    const snapshots = run?.peopleSnapshot || rows.map(r => ({ id: r.personId, name: r.name, rnokpp: r.payee?.rnokpp || '', kind: r.kind, ...(r.relationship || people.get(r.personId) || {}) }));
    for (const p of status === 'approved' ? snapshots : people.values()) {
        if (p.active === false && !p.to) continue;
        for (const [field, what] of [['from', 'start'], ['to', 'end']]) {
            if (String(p[field] || '').slice(0, 7) === period) {
                relations.push({ personId: p.id, name: p.name, rnokpp: p.rnokpp || '', kind: p.kind, event: what, date: p[field], position: p.position || '' });
            }
        }
    }
    relations.sort((a, b) => a.date.localeCompare(b.date) || a.name.localeCompare(b.name, 'uk'));

    for (const r of income) if (!payroll.validRnokpp(r.rnokpp)) checks.push({ level: 'block', text: `${r.name}: немає правильного РНОКПП` });
    for (const r of esv) if (r.days === null) checks.push({ level: 'block', text: `${r.name}: немає дати початку договору ЦПД для календарних днів Д1; уточніть період договору` });
    const sum = (list, k) => list.reduce((s, r) => s + (r[k] || 0), 0);
    const summary = {
        people: rows.length, employees: rows.filter(r => r.kind === 'employee').length, gph: rows.filter(r => r.kind === 'gph').length,
        grossKop: sum(income, 'grossKop'), paidKop: sum(income, 'paidKop'),
        pdfoKop: sum(income, 'pdfoKop'), pdfoPaidKop: sum(income, 'pdfoPaidKop'),
        vzKop: sum(income, 'vzKop'), vzPaidKop: sum(income, 'vzPaidKop'),
        esvBaseKop: sum(esv, 'baseKop'), esvKop: sum(esv, 'esvKop'),
        esvPaidKop: stages.reduce((s, st) => s + paidAmount(payments, st, 'esv'), 0),
        due: dueDate(period)
    };
    if (rows.length) {
        for (const [key, field] of [['pdfo', 'pdfoKop'], ['vz', 'vzKop'], ['esv', 'esvKop']]) {
            if (stages.reduce((s, st) => s + paidAmount(payments, st, key), 0) > summary[field]) checks.push({ level: 'warn', text: `${key.toUpperCase()}: сплачено більше за нарахування; переплату треба звірити окремо` });
        }
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
