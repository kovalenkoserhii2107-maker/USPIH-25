'use strict';
// ============================================================
// Звітність (частина 9): дані для Податкового розрахунку J0500111 з
// затвердженої відомості зарплати й платежів за нею.
//
// Дані використовує XML-експорт (dps-xml.js) і таблиці кабінету.
// Ознаки доходу 4ДФ: 101 — зарплата, 102 — договір ЦПД, 157 — ФОП.
// ============================================================
const payroll = require('./payroll-core');
const { shift } = require('./leave-core');

// Ключі — як у календарі кабінету (js/tax-calendar.js): місяць без нуля.
const KEY_RE = /^(?:(j0500111|esv)-(\d{4})-(1[0-2]|[1-9])|(budget|fs-stat|npo|land)-(\d{4}))$/;
const STATUSES = { submitted: 'подано', accepted: 'прийнято', rejected: 'відхилено', not_required: 'не потрібно', paid: 'сплачено' };
const INCOME_SIGN = { employee: '101', gph: '102' };

const validKey = key => KEY_RE.test(String(key || ''));
function allowedStatus(key, status) {
    const list = key.startsWith('esv-') ? ['paid', 'not_required'] : key.startsWith('budget-') ? ['accepted', 'not_required']
        : ['submitted', 'accepted', 'rejected', 'not_required'];
    return list.includes(status);
}
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

const { recipientType } = require('./payroll-payment-core');
const paidAmount = (payments, stage, key) => payments.filter(p => recipientType(p) === 'tax' && p.status === 'paid' && p.stage === stage && p.key === key && Number.isSafeInteger(p.amountKop) && p.amountKop > 0).reduce((sum, p) => sum + p.amountKop, 0);
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
 *   payments — [{ period, stage, key, status, amountKop, paidOn }],
 *              paidOn — підтверджена випискою київська дата.
 *   runs     — затверджені відомості інших місяців для пізніх виплат.
 * Зарплата, виплачена у встановлений строк наступного місяця,
 * лишається в місяці нарахування; пізні виплати й ЦПД — за датою банку.
 * Повертає { period, status, summary, income (4ДФ), esv (Д1), relations (Д5), checks }.
 */
function payrollReport({ period, stored, people = new Map(), payments = [], runs = new Map(), otherIncome = [] }) {
    const checks = [];
    const status = stored?.status || 'none';
    const run = stored?.run || null;
    const rows = status === 'approved' && Array.isArray(run?.rows) ? run.rows : [];
    if (status === 'none') checks.push({ level: 'block', text: 'Відомість зарплати за місяць не складено' });
    if (status === 'draft') checks.push({ level: 'block', text: 'Відомість ще не затверджена головою — цифри можуть змінитися' });
    if (status === 'approved' && (!run || !Array.isArray(run.rows))) checks.push({ level: 'block', text: 'У затвердженій відомості відсутній розрахунок — відновіть джерело звіту' });
    if (status === 'approved' && run) for (const field of ['grossKop', 'pdfoKop', 'vzKop', 'netKop', 'esvKop']) {
        if (rows.some(r => !Number.isSafeInteger(r[field]) || r[field] < 0) || rows.reduce((s, r) => s + (r[field] || 0), 0) !== run.totals?.[field]) {
            checks.push({ level: 'block', text: `Відомість: ${field} у підсумках не відповідає правильним сумам за людьми` });
        }
    }
    for (const r of rows) if (r.grossKop !== r.netKop + r.pdfoKop + r.vzKop) checks.push({ level: 'block', text: `${r.name}: нараховано не дорівнює виплаті та утриманим податкам` });
    const physical=new Map();
    for(const r of rows)if(r.payee?.rnokpp){const list=physical.get(r.payee.rnokpp)||[];list.push(r);physical.set(r.payee.rnokpp,list);}
    for(const group of physical.values())if(group.length>1&&group.some(r=>!r.esvConsolidated))checks.push({level:'block',text:`${group[0].name}: старі рядки за кількома договорами потребують звірки спільної бази ЄСВ до подання Д1`});
    if (status === 'approved' && run && !Array.isArray(run.peopleSnapshot)) checks.push({ level: 'warn', text: 'Стара відомість не зберігає склад людей і дати відносин: звірте Д1/Д5 з кадровими документами' });

    const stages = ['advance', 'final'];
    const monthOf = p => p.period || period;
    const own = payments.filter(p => monthOf(p) === period);
    for (const p of payments) if (p.status === 'paid' && (!Number.isSafeInteger(p.amountKop) || p.amountKop <= 0)) checks.push({ level: 'block', text: 'У проведеному платежі відсутня правильна сума. Перевірте виписку.' });
    const incomeByKey = new Map();
    const rowOf = r => {
        const rnokpp = r.payee ? r.payee.rnokpp || '' : people.get(r.personId)?.rnokpp || '';
        const sign = INCOME_SIGN[r.kind] || '101', key = `${rnokpp || r.personId}|${sign}|${r.pspCode || ''}`;
        if (!incomeByKey.has(key)) incomeByKey.set(key, {
            personId: r.personId, name: r.name, rnokpp, kind: r.kind, sign,
            grossKop: 0, paidKop: 0, pdfoKop: 0, pdfoPaidKop: 0, vzKop: 0, vzPaidKop: 0,
            pspCode: r.pspCode || '', pspKop: 0, vacationKop: 0, sickKop: 0, earlierKop: 0
        });
        return incomeByKey.get(key);
    };
    for (const r of rows) {
        const x = rowOf(r);
        for (const f of ['grossKop', 'pdfoKop', 'vzKop', 'pspKop', 'vacationKop']) x[f] += r[f] || 0;
        x.sickKop += (r.sickKop || 0) + (r.fundSickKop || 0);
    }
    const relevant = payments.filter(p => monthOf(p) === period || String(p.paidOn || '').slice(0, 7) === period);
    for (const q of [...new Set(relevant.map(monthOf))].sort()) {
        const source = q === period ? stored : runs.get(q);
        const qRows = source?.status === 'approved' && Array.isArray(source.run?.rows) ? source.run.rows : [];
        const qPays = payments.filter(p => monthOf(p) === q);
        const paid = qPays.filter(p => p.status === 'paid' && Number.isSafeInteger(p.amountKop) && p.amountKop > 0);
        if (paid.length && (!source || source.status !== 'approved' || !Array.isArray(source.run?.rows))) {
            checks.push({ level: 'block', text: `Виплати за ${q}: відомість за ${q} не затверджена — виплачений дохід не визначити` });
            continue;
        }
        const withAdvance = Boolean(source?.stages?.advance) || qPays.some(p => p.stage === 'advance' && ['paid', 'sent', 'sending', 'unknown'].includes(p.status));
        const part = (r, stage, f) => withAdvance ? r?.[stage]?.[f] || 0 : stage === 'final' ? (r?.advance?.[f] || 0) + (r?.final?.[f] || 0) : 0;
        const timelyWage = (r, stage) => {
            const wages = paid.filter(p => recipientType(p) === 'person' && p.stage === stage && p.key === r.personId);
            return r.kind === 'employee' && stage === 'final' && wages.length > 0
                && wages.reduce((s, p) => s + p.amountKop, 0) === part(r, stage, 'netKop')
                && wages.every(p => !p.paidOn || String(p.paidOn).slice(0, 7) === q || (String(p.paidOn).slice(0, 7) === shift(q, 1) && Number(String(p.paidOn).slice(8)) <= 7));
        };
        const reportPeriod = (p, r) => {
            const month = p.paidOn ? String(p.paidOn).slice(0, 7) : q;
            return month === shift(q, 1) && Number(String(p.paidOn).slice(8)) <= 7 && timelyWage(r, p.stage) ? q : month;
        };
        for (const p of paid) if (!stages.includes(p.stage) || !(recipientType(p) === 'tax' ? ['pdfo', 'vz', 'esv'] : qRows.map(r => r.personId)).includes(p.key)) {
            checks.push({ level: 'block', text: 'Проведений платіж не відповідає етапу чи отримувачу відомості — звірте його перед звітом' });
        }
        for (const r of qRows) for (const stage of stages) {
            const wages = paid.filter(p => recipientType(p) === 'person' && p.stage === stage && p.key === r.personId);
            const actual = wages.reduce((s, p) => s + p.amountKop, 0), expected = part(r, stage, 'netKop');
            const declared = wages.length > 0 && wages.every(p => Number.isSafeInteger(p.paidGrossKop) && p.paidGrossKop >= p.amountKop);
            if (declared) {
                const gross = wages.reduce((s, p) => s + p.paidGrossKop, 0);
                const expectedGross = part(r, stage, 'grossKop');
                if (actual > expected || gross > expectedGross || (actual === expected && gross !== expectedGross)) {
                    checks.push({ level: 'block', text: `${r.name}: розподіл часткових виплат не відповідає відомості` });
                    continue;
                }
                for (const p of wages) if (reportPeriod(p, r) === period) {
                    const x = rowOf(r);
                    x.paidKop += p.paidGrossKop;
                    if (q !== period) x.earlierKop += p.paidGrossKop;
                }
                continue;
            }
            if (actual && actual !== expected) checks.push({ level: 'block', text: `${r.name}: проведена виплата не відповідає відомості; виплачений дохід треба уточнити` });
            if (!actual || actual !== expected) continue;
            // Штатний цикл має один платіж на етап. При розділенні за
            // датами нетто недостатньо для достовірного визначення gross.
            if (wages.length !== 1) {
                checks.push({ level: 'block', text: `${r.name}: етап виплачено кількома платежами — уточніть розподіл доходу за датами для 4ДФ` });
                continue;
            }
            if (reportPeriod(wages[0], r) === period) {
                const x = rowOf(r), amount = part(r, stage, 'grossKop');
                x.paidKop += amount;
                if (q !== period) x.earlierKop += amount;
            }
        }
        for (const p of paid.filter(p => recipientType(p) === 'tax' && ['pdfo', 'vz'].includes(p.key) && stages.includes(p.stage))) {
            const f = `${p.key}Kop`, weights = qRows.map(r => part(r, p.stage, f));
            if (p.amountKop > weights.reduce((s, k) => s + k, 0)) checks.push({ level: 'block', text: `${q}: перерахований податок перевищує відомість — уточніть персональний розподіл переплати` });
            const shares = distribute(p.amountKop, weights);
            qRows.forEach((r, i) => { if (shares[i] && reportPeriod(p, r) === period) rowOf(r)[`${p.key}PaidKop`] += shares[i]; });
        }
    }
    const income = [...incomeByKey.values()];
    income.push(...otherIncome);
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
                relations.push({ personId: p.id, name: p.name, rnokpp: p.rnokpp || '', kind: p.kind, event: what, date: p[field], position: p.position || '',
                    ...(p.mainJob !== undefined ? { mainJob: p.mainJob } : {}), reporting: p.reporting || {} });
            }
        }
    }
    relations.sort((a, b) => a.date.localeCompare(b.date) || a.name.localeCompare(b.name, 'uk'));

    for (const r of income) if (!payroll.validRnokpp(r.rnokpp)) checks.push({ level: 'block', text: `${r.name}: немає правильного РНОКПП` });
    for (const r of relations) if (!payroll.validRnokpp(r.rnokpp)) checks.push({ level: 'block', text: `${r.name}: немає правильного РНОКПП для події Д5` });
    for (const r of esv) if (r.days === null) checks.push({ level: 'block', text: `${r.name}: немає дати початку договору ЦПД для календарних днів Д1; уточніть період договору` });
    const sum = (list, k) => list.reduce((s, r) => s + (r[k] || 0), 0);
    const summary = {
        people: rows.length, employees: rows.filter(r => r.kind === 'employee').length, gph: rows.filter(r => r.kind === 'gph').length,
        fop: otherIncome.filter(r => r.kind === 'fop').length,
        grossKop: sum(income, 'grossKop'), paidKop: sum(income, 'paidKop'),
        pdfoKop: sum(income, 'pdfoKop'), pdfoPaidKop: sum(income, 'pdfoPaidKop'),
        vzKop: sum(income, 'vzKop'), vzPaidKop: sum(income, 'vzPaidKop'),
        esvBaseKop: sum(esv, 'baseKop'), esvKop: sum(esv, 'esvKop'),
        esvPaidKop: stages.reduce((s, st) => s + paidAmount(own, st, 'esv'), 0),
        earlierKop: sum(income, 'earlierKop'), fopKop: sum(otherIncome, 'grossKop'),
        due: dueDate(period)
    };
    if (rows.length) {
        for (const [key, field] of [['pdfo', 'pdfoKop'], ['vz', 'vzKop'], ['esv', 'esvKop']]) {
            if (stages.reduce((s, st) => s + paidAmount(own, st, key), 0) > run.totals[field]) checks.push({ level: 'warn', text: `${key.toUpperCase()}: сплачено більше за нарахування; переплату треба звірити окремо` });
        }
        if (stages.reduce((s, st) => s + paidAmount(own, st, 'pdfo'), 0) < run.totals.pdfoKop || stages.reduce((s, st) => s + paidAmount(own, st, 'vz'), 0) < run.totals.vzKop) {
            checks.push({ level: 'warn', text: 'Не всі ПДФО й військовий збір сплачено (видно за проведеними платежами відомості)' });
        }
        if (summary.esvPaidKop < summary.esvKop) checks.push({ level: 'warn', text: `ЄСВ сплачено не повністю — строк ${summary.due.split('-').reverse().join('.')}` });
        if (summary.paidKop < summary.grossKop) checks.push({ level: 'info', text: 'Частину зарплати ще не виплачено — у розрахунку показуються нараховані суми' });
    }
    if (!income.length && status === 'approved') checks.push({ level: 'info', text: 'Нарахувань фізособам немає' });
    return { period, status, summary, income, esv, relations, checks };
}

module.exports = { KEY_RE, STATUSES, INCOME_SIGN, validKey, allowedStatus, periodOf, keyFor, dueDate, payrollReport };
