'use strict';
// ============================================================
// Звітність (частина 9): дані для Податкового розрахунку J0500111 з
// затвердженої відомості зарплати й платежів за нею.
//
// XML за XSD ДПС поки не формуємо (схеми ще не перевірено на пробному
// поданні): кабінет показує готові суми за людьми — їх переносять у
// форму в Електронному кабінеті, де голова підписує й подає звіт.
// Ознаки доходу 4ДФ: 101 — зарплата, 102 — договір ЦПД, 157 — виплати ФОП
// (LEGAL.md, розділ 7).
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
 * Виплати ФОП за місяць — дохід з ознакою 157 у 4ДФ (ПДФО й ВЗ ФОП сплачує
 * сам). Списання постачальникам-ФОП за датою банку, мінус повернення того
 * самого місяця.
 *   tx        — bank_tx місяця: [{ id, direction, kind, status, category, expenseId, refundOf, amountKop, counterparty }]
 *   expenses  — Map(id → { supplierId })
 *   suppliers — Map(id → { name, kind, code, iban })
 */
function fopIncome({ tx = [], expenses = new Map(), suppliers = new Map() }) {
    const norm = v => String(v || '').replace(/\s+/g, '').toUpperCase();
    const fops = [...suppliers].filter(([, x]) => x.kind === 'fop');
    const supplierOf = t => {
        const byDoc = t.expenseId ? expenses.get(t.expenseId)?.supplierId : null;
        if (byDoc) return suppliers.get(byDoc)?.kind === 'fop' ? byDoc : null;
        const cp = t.counterparty || {};
        const hit = fops.find(([, x]) => (x.code && x.code === cp.code) || (x.iban && norm(x.iban) === norm(cp.account)));
        return hit ? hit[0] : null;
    };
    const sums = new Map(), byTx = new Map();
    for (const t of tx) {
        if (t.direction !== 'out' || t.status !== 'done' || t.kind !== 'expense' || t.category !== 'supplier') continue;
        const id = supplierOf(t);
        if (!id || !Number.isSafeInteger(t.amountKop)) continue;
        byTx.set(t.id, id);
        sums.set(id, (sums.get(id) || 0) + t.amountKop);
    }
    for (const t of tx) {
        if (t.kind === 'refund' && t.status === 'done' && byTx.has(t.refundOf)) sums.set(byTx.get(t.refundOf), sums.get(byTx.get(t.refundOf)) - t.amountKop);
    }
    return [...sums].filter(([, kop]) => kop > 0)
        .map(([id, kop]) => ({ supplierId: id, name: suppliers.get(id).name || '', rnokpp: suppliers.get(id).code || '', amountKop: kop }))
        .sort((a, b) => a.name.localeCompare(b.name, 'uk'));
}

/**
 * Дані розрахунку за місяць.
 *   stored   — payroll_runs/{period} (або null)
 *   people   — Map(id → картка) для дат прийому/звільнення
 *   payments — платежі за відомостями: [{ period, stage, key, status, amountKop, paidOn }];
 *              period — місяць нарахування (без нього — цей), paidOn — дата банку (Київ)
 *   runs     — Map(місяць → payroll_runs) для виплат цього місяця за попередні місяці
 *   fop      — fopIncome(…): виплати ФОП (ознака 157)
 * 4ДФ: нараховане — з відомості цього місяця; виплачене й перераховані
 * податки — за датою виплати (аванс за жовтень 20.10 — у жовтні, остаточний
 * розрахунок 05.11 — у листопаді). ЄСВ і контроль сплати податків — за
 * місяцем нарахування.
 * Повертає { period, status, summary, income (4ДФ), esv (Д1), relations (Д5), checks }.
 */
function payrollReport({ period, stored, people = new Map(), payments = [], runs = new Map(), fop = [] }) {
    const checks = [];
    const status = stored?.status || 'none';
    const run = stored?.run || null;
    const rows = status === 'approved' && run ? run.rows : [];
    if (status === 'none') checks.push({ level: 'block', text: 'Відомість зарплати за місяць не складено' });
    if (status === 'draft') checks.push({ level: 'block', text: 'Відомість ще не затверджена головою — цифри можуть змінитися' });
    if (status === 'approved' && run && !Array.isArray(run.peopleSnapshot)) checks.push({ level: 'warn', text: 'Стара відомість не зберігає склад людей і дати відносин: звірте Д1/Д5 з кадровими документами' });

    const stages = ['advance', 'final'];
    const monthOf = p => p.period || period;
    // Платежі за відомістю цього місяця (будь-коли) і виплачені цього місяця (за будь-який місяць).
    const own = payments.filter(p => monthOf(p) === period);
    const paidHere = payments.filter(p => p.status === 'paid' && (p.paidOn ? String(p.paidOn).slice(0, 7) === period : monthOf(p) === period));
    for (const p of payments) if (p.status === 'paid' && (!Number.isSafeInteger(p.amountKop) || p.amountKop <= 0)) checks.push({ level: 'block', text: 'У проведеному платежі відсутня правильна сума. Перевірте виписку.' });

    const income = new Map();
    const rowOf = r => {
        if (!income.has(r.personId)) {
            const rnokpp = r.payee ? r.payee.rnokpp || '' : people.get(r.personId)?.rnokpp || '';
            income.set(r.personId, { personId: r.personId, name: r.name, rnokpp, kind: r.kind, sign: INCOME_SIGN[r.kind] || '101',
                grossKop: 0, paidKop: 0, pdfoKop: 0, pdfoPaidKop: 0, vzKop: 0, vzPaidKop: 0, pspCode: '', pspKop: 0, vacationKop: 0, sickKop: 0, earlierKop: 0 });
        }
        return income.get(r.personId);
    };
    // Нараховане за цей місяць.
    for (const r of rows) {
        Object.assign(rowOf(r), { grossKop: r.grossKop, pdfoKop: r.pdfoKop, vzKop: r.vzKop,
            // Ознака ПСП (ст. 169.1 ПКУ) і сума пільги; відпускні й лікарняні — у складі доходу з ознакою 101.
            pspCode: r.pspCode || '', pspKop: r.pspKop || 0, vacationKop: r.vacationKop || 0, sickKop: (r.sickKop || 0) + (r.fundSickKop || 0) });
    }
    // Виплачене цього місяця — за відомістю місяця нарахування.
    const months = [...new Set([period, ...paidHere.map(monthOf)])].sort();
    for (const q of months) {
        const st = q === period ? stored : runs.get(q);
        const qRows = st?.status === 'approved' ? st.run?.rows || [] : [];
        const forRun = paidHere.filter(p => monthOf(p) === q);
        if (q !== period && forRun.length && !qRows.length) checks.push({ level: 'block', text: `Виплати за ${q} цього місяця: відомість за ${q} не затверджена — виплачений дохід не визначити` });
        // Без авансу остаточний розрахунок платить усе нараховане за місяць.
        const withAdvance = Boolean(st?.stages?.advance) || payments.some(p => monthOf(p) === q && p.stage === 'advance' && ['paid', 'sent', 'sending', 'unknown'].includes(p.status));
        const part = (row, stage, field) => (withAdvance ? row?.[stage]?.[field] || 0
            : stage === 'final' ? (row?.advance?.[field] || 0) + (row?.final?.[field] || 0) : 0);
        const shares = {};
        for (const stage of stages) for (const [key, field] of [['pdfo', 'pdfoKop'], ['vz', 'vzKop']]) {
            shares[`${stage}:${key}`] = distribute(paidAmount(forRun, stage, key), qRows.map(r => part(r, stage, field)));
        }
        qRows.forEach((r, index) => {
            const x = rowOf(r);
            let gross = 0;
            for (const stage of stages) {
                const actual = paidAmount(forRun, stage, r.personId), expected = part(r, stage, 'netKop');
                if (actual && actual !== expected) checks.push({ level: 'block', text: `${r.name}: проведена виплата не відповідає відомості; виплачений дохід треба уточнити` });
                if (actual && actual === expected) gross += part(r, stage, 'grossKop');
                x.pdfoPaidKop += shares[`${stage}:pdfo`][index];
                x.vzPaidKop += shares[`${stage}:vz`][index];
            }
            x.paidKop += gross;
            if (q !== period) x.earlierKop += gross;
        });
    }
    for (const f of fop) {
        income.set(`fop-${f.supplierId}`, { personId: `fop-${f.supplierId}`, name: f.name, rnokpp: f.rnokpp, kind: 'fop', sign: '157',
            grossKop: f.amountKop, paidKop: f.amountKop, pdfoKop: 0, pdfoPaidKop: 0, vzKop: 0, vzPaidKop: 0, pspCode: '', pspKop: 0, vacationKop: 0, sickKop: 0, earlierKop: 0 });
    }
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

    const incomeRows = [...income.values()];
    for (const r of incomeRows) if (!payroll.validRnokpp(r.rnokpp)) checks.push({ level: 'block', text: r.kind === 'fop' ? `${r.name}: у картці ФОП немає правильного РНОКПП (код) — для 4ДФ` : `${r.name}: немає правильного РНОКПП` });
    for (const r of esv) if (r.days === null) checks.push({ level: 'block', text: `${r.name}: немає дати початку договору ЦПД для календарних днів Д1; уточніть період договору` });
    const sum = (list, k) => list.reduce((s, r) => s + (r[k] || 0), 0);
    const summary = {
        people: rows.length, employees: rows.filter(r => r.kind === 'employee').length, gph: rows.filter(r => r.kind === 'gph').length, fop: fop.length,
        grossKop: sum(incomeRows, 'grossKop'), paidKop: sum(incomeRows, 'paidKop'),
        pdfoKop: sum(incomeRows, 'pdfoKop'), pdfoPaidKop: sum(incomeRows, 'pdfoPaidKop'),
        vzKop: sum(incomeRows, 'vzKop'), vzPaidKop: sum(incomeRows, 'vzPaidKop'),
        esvBaseKop: sum(esv, 'baseKop'), esvKop: sum(esv, 'esvKop'),
        esvPaidKop: stages.reduce((s, st) => s + paidAmount(own, st, 'esv'), 0),
        earlierKop: sum(incomeRows, 'earlierKop'), fopKop: sum(fop, 'amountKop'),
        due: dueDate(period)
    };
    if (rows.length) {
        // Контроль сплати — за відомістю цього місяця, хоч би коли платили.
        const paidFor = key => stages.reduce((s, st) => s + paidAmount(own, st, key), 0);
        for (const [key, field] of [['pdfo', 'pdfoKop'], ['vz', 'vzKop'], ['esv', 'esvKop']]) {
            if (paidFor(key) > summary[field]) checks.push({ level: 'warn', text: `${key.toUpperCase()}: сплачено більше за нарахування; переплату треба звірити окремо` });
        }
        if (paidFor('pdfo') < summary.pdfoKop || paidFor('vz') < summary.vzKop) {
            checks.push({ level: 'warn', text: 'Не всі ПДФО й військовий збір сплачено (видно за проведеними платежами відомості)' });
        }
        if (summary.esvPaidKop < summary.esvKop) checks.push({ level: 'warn', text: `ЄСВ сплачено не повністю — строк ${summary.due.split('-').reverse().join('.')}` });
        const paidOwn = sum(incomeRows, 'paidKop') - summary.earlierKop - summary.fopKop;
        if (paidOwn < sum(rows, 'grossKop')) checks.push({ level: 'info', text: 'Частину зарплати за місяць ще не виплачено: у 4ДФ «виплачено» — лише те, що банк провів цього місяця; решта потрапить у розрахунок місяця виплати' });
    }
    if (summary.earlierKop) checks.push({ level: 'info', text: 'Цього місяця виплачено зарплату за попередній місяць — вона у графі «виплачено» 4ДФ' });
    if (!rows.length && status === 'approved') checks.push({ level: 'info', text: 'Нарахувань фізособам немає' });
    return { period, status, summary, income: incomeRows, esv, relations, checks };
}

module.exports = { KEY_RE, STATUSES, INCOME_SIGN, validKey, periodOf, keyFor, dueDate, fopIncome, payrollReport };
