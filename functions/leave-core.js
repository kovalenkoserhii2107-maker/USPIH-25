'use strict';
// ============================================================
// Відпустки, лікарняні й податкова соціальна пільга (ПСП) — для
// розрахунку зарплати (payroll-core.js). Робочий варіант для перевірки
// бухгалтером; підстави й упевненість — docs/accounting/LEGAL.md, розділ 7.
//
// ВІДПУСТКА (Порядок № 100): середньоденна = заробіток за 12 календарних
//   місяців перед місяцем відпустки / календарні дні цих місяців. Попередні
//   щорічні відпускні й допомога з тимчасової непрацездатності включаються
//   (п. 3 Порядку № 100); неоплачений час виключається. Під час воєнного стану
//   святкові дні не виключаються (ст. 73 КЗпП не застосовується).
//   Відпускні = середньоденна × календарні дні відпустки; виплачуються до
//   відпустки — разом з авансом.
// ЛІКАРНЯНИЙ (Порядок № 1266): середньоденна = заробіток за 12 місяців
//   (з відпускними) / календарні дні без днів лікарняних; не більше
//   максимальної бази / 30,44. Загальної нижньої межі з МЗП для звичайної
//   тимчасової непрацездатності немає (це не допомога з вагітності й пологів).
//   Відсоток за страховим стажем: до 3 р. — 50 %, 3–5 — 60 %, 5–8 — 70 %,
//   понад 8 — 100 %. Перші 5 календарних днів випадку — за рахунок ОСББ,
//   далі — ПФУ: ОСББ подає заяву-розрахунок, а коли кошти надійдуть,
//   нараховує й виплачує їх (з ПДФО й ВЗ) окремим рядком.
// ПСП (ст. 169 ПКУ): за заявою, лише за основним місцем роботи, якщо
//   дохід місяця не перевищує прожитковий мінімум × 1,4 (округлено до
//   10 грн; для пільги «на дітей» — × кількість дітей). Зменшує базу ПДФО,
//   не ВЗ і не ЄСВ.
//
// Тут немає ні мережі, ні бази: тести — leave-core.test.js.
// ============================================================

const DAY = 86400000;
const { validDate } = require('./expenses-core');
const iso = ms => new Date(ms).toISOString().slice(0, 10);
const parse = d => Date.parse(`${d}T00:00:00Z`);
const pad = n => String(n).padStart(2, '0');
const daysInMonth = period => { const [y, m] = period.split('-').map(Number); return new Date(Date.UTC(y, m, 0)).getUTCDate(); };
const shift = (period, n) => { const [y, m] = period.split('-').map(Number); const d = new Date(Date.UTC(y, m - 1 + n, 1)); return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}`; };
const isWorkday = d => ![0, 6].includes(new Date(parse(d)).getUTCDay());

const TYPES = { vacation: 'Щорічна відпустка', sick: 'Лікарняний' };
const SICK_EMPLOYER_DAYS = 5;

/** Відсоток лікарняних за страховим стажем (ст. 24 Закону № 1105-XIV). */
function sickPercent(years) {
    const y = Number(years) || 0;
    return y >= 8 ? 100 : y >= 5 ? 70 : y >= 3 ? 60 : 50;
}

/** Дати відсутності в межах місяця й трудових відносин. */
function absenceDates(abs, period, person = {}) {
    const first = `${period}-01`, last = `${period}-${pad(daysInMonth(period))}`;
    const from = [abs.from, first, person.from || first].sort().at(-1);
    const to = [abs.to, last, person.to || last].sort()[0];
    const out = [];
    for (let t = parse(from); t <= parse(to); t += DAY) out.push(iso(t));
    return out;
}

/** Перевірка рядків відсутності місяця: null — гаразд, інакше текст. */
function checkAbsences(list, period) {
    if (!Array.isArray(list)) return 'Невірний список відсутностей';
    if (list.length > 10) return 'Забагато відсутностей за місяць';
    const first = `${period}-01`, last = `${period}-${pad(daysInMonth(period))}`;
    const taken = new Set();
    for (const [i, a] of list.entries()) {
        const n = `Відсутність ${i + 1}`;
        if (!TYPES[a.type]) return `${n}: оберіть відпустку чи лікарняний`;
        if (!validDate(a.from) || !validDate(a.to) || a.to < a.from) return `${n}: вкажіть правильні дати з … по …`;
        if (a.from < first || a.to > last) return `${n}: дати мають бути в межах місяця відомості. Відпустку чи лікарняний на два місяці внесіть у кожну відомість окремо`;
        if (a.caseStart && (!validDate(a.caseStart) || a.caseStart > a.from)) return `${n}: вкажіть правильну дату початку відсутності — не пізніше першого дня в цьому місяці`;
        if (a.avgDailyKop !== undefined && a.avgDailyKop !== null && (!Number.isSafeInteger(a.avgDailyKop) || a.avgDailyKop < 0 || a.avgDailyKop > 10000000)) return `${n}: середньоденна — сума в копійках`;
        for (let t = parse(a.from); t <= parse(a.to); t += DAY) {
            if (taken.has(t)) return `${n}: дати перетинаються з іншою відсутністю`;
            taken.add(t);
        }
    }
    return null;
}

/**
 * Середньоденна з історії: місяці перед period (до 12), з відомостей
 * застосунку або з заробітку до застосунку (картка людини).
 * history: [{ period, regularKop, vacationKop, sickKop, vacationDays, sickDays, calendarDays }]
 * prior: { 'РРРР-ММ': { kop, days } } — заробіток і календарні дні до застосунку.
 */
function averageDaily({ mode, period, history = [], prior = {} }) {
    let earnings = 0, days = 0, months = 0;
    const byPeriod = new Map(history.map(h => [h.period, h]));
    for (let i = 12; i >= 1; i--) {
        const p = shift(period, -i);
        const h = byPeriod.get(p);
        if (h) {
            const excluded = (h.excludedDays || 0) + (mode === 'sick' ? h.sickDays || 0 : 0);
            const kop = (h.regularKop || 0) + (h.vacationKop || 0) + (mode === 'vacation' ? h.sickKop || 0 : 0);
            const d = Math.max(0, (h.calendarDays ?? daysInMonth(p)) - excluded);
            if (d > 0 || kop) { earnings += kop; days += d; months += 1; }
        } else if (prior[p] && Number.isSafeInteger(prior[p].kop)) {
            earnings += prior[p].kop;
            days += Number.isInteger(prior[p].days) ? prior[p].days : daysInMonth(p);
            months += 1;
        }
    }
    return { avgKop: days > 0 ? Math.round(earnings / days) : 0, earningsKop: earnings, days, months };
}

/**
 * Відпустки й лікарняні працівника за місяць.
 * Повертає суми, дні й попередження/проблеми для рядка відомості.
 */
function leaveFor({ person, absences = [], period, rate, history = [] }) {
    const out = { vacationKop: 0, vacationDays: 0, vacationWorkdays: 0, sickKop: 0, sickDays: 0, sickWorkdays: 0, sickEmployerDays: 0,
        fundDays: 0, fundExpectKop: 0, avgVacationKop: null, avgSickKop: null, warnings: [], problems: [], items: [] };
    const average = (a, mode) => {
        if (Number.isSafeInteger(a.avgDailyKop) && a.avgDailyKop > 0) return { avgKop: a.avgDailyKop, months: null, manual: true };
        const start = a.caseStart || a.from;
        if (start.slice(0, 7) < period) {
            const saved = history.flatMap(h => h.absences || []).find(x => x.type === mode && (x.caseStart || x.from) === start && x.avgKop > 0);
            if (saved) return { avgKop: saved.avgKop, percent: saved.percent, fixed: true };
            out.problems.push('продовження відсутності: немає зафіксованої середньоденної з початку випадку — вкажіть підтверджену суму вручну');
            return { avgKop: 0, months: 0 };
        }
        return averageDaily({ mode, period, history, prior: person.priorEarnings || {} });
    };
    for (const a of absences) {
        const dates = absenceDates(a, period, person);
        if (!dates.length) continue;
        const work = dates.filter(isWorkday).length;
        if (a.type === 'vacation') {
            const avg = average(a, 'vacation');
            if (!avg.avgKop) out.problems.push(`відпустка ${dates[0].slice(8)}–${dates.at(-1).slice(8)}: немає заробітку за 12 міс. для середньої — вкажіть середньоденну`);
            const kop = Math.round(avg.avgKop * dates.length);
            out.vacationKop += kop; out.vacationDays += dates.length; out.vacationWorkdays += work; out.avgVacationKop = avg.avgKop;
            out.items.push({ type: 'vacation', from: dates[0], to: dates.at(-1), caseStart: a.caseStart || a.from, days: dates.length, avgKop: avg.avgKop, kop, manual: Boolean(avg.manual) });
            out.warnings.push(`відпустка ${dates.length} дн.: ${(kop / 100).toFixed(2).replace('.', ',')} грн (середньоденна ${(avg.avgKop / 100).toFixed(2).replace('.', ',')}${avg.manual ? ', внесена вручну' : avg.fixed ? ', з початку відпустки' : `, за ${avg.months} міс.`}) — виплатіть до початку відпустки або у строк трудового/колективного договору`);
        } else {
            const raw = average(a, 'sick');
            if (!raw.avgKop) out.problems.push(`лікарняний ${dates[0].slice(8)}–${dates.at(-1).slice(8)}: немає заробітку для середньоденної — вкажіть підтверджену середньоденну`);
            const max = Math.round(rate.minWageKop * rate.maxBaseMult / 30.44);
            const avgKop = Math.min(max, raw.avgKop);
            const percent = raw.fixed && raw.percent ? raw.percent : sickPercent(person.insuranceYears);
            const start = a.caseStart || a.from;
            // Перші 5 календарних днів випадку — ОСББ (навіть якщо випадок почався в попередньому місяці).
            const employerDays = dates.filter(d => (parse(d) - parse(start)) / DAY < SICK_EMPLOYER_DAYS).length;
            const fundDays = dates.length - employerDays;
            const perDay = avgKop * percent / 100;
            const kop = Math.round(perDay * employerDays);
            const fund = Math.round(perDay * fundDays);
            out.sickKop += kop; out.sickDays += dates.length; out.sickWorkdays += work; out.sickEmployerDays += employerDays;
            out.fundDays += fundDays; out.fundExpectKop += fund; out.avgSickKop = avgKop;
            out.items.push({ type: 'sick', from: dates[0], to: dates.at(-1), caseStart: start, days: dates.length, employerDays, fundDays, percent, avgKop, kop, fundKop: fund, manual: Boolean(raw.manual) });
            out.warnings.push(`лікарняний ${dates.length} дн. (${percent} % за стажем): ОСББ — ${employerDays} дн., ${(kop / 100).toFixed(2).replace('.', ',')} грн${fundDays ? `; ПФУ — ${fundDays} дн., ≈${(fund / 100).toFixed(2).replace('.', ',')} грн: подайте заяву-розрахунок, а коли кошти надійдуть — внесіть їх у відомість` : ''}`);
            if (raw.avgKop > max) out.warnings.push('середньоденна лікарняного обмежена максимальною базою ЄСВ / 30,44');
            if (!raw.manual && !raw.fixed && raw.months < 12) out.warnings.push(`середня лікарняного: є дані за ${raw.months} міс. — звірте повноту розрахункового періоду і страховий стаж за останні 12 міс.`);
        }
    }
    return out;
}

// ------------------------------------------------------------
// ПОДАТКОВА СОЦІАЛЬНА ПІЛЬГА
// ------------------------------------------------------------
// Ознака пільги в 4ДФ — за підпунктом ст. 169.1 ПКУ.
const PSP_KINDS = {
    '169.1.1': { code: '01', pct: 100, perChild: false, label: 'Базова (100 %)' },
    '169.1.2': { code: '02', pct: 100, perChild: true, label: 'Двоє й більше дітей до 18 років (100 % на кожну дитину)' },
    '169.1.3': { code: '03', pct: 150, perChild: 'optional', label: '150 %: одинокі батьки, дитина з інвалідністю (на кожну дитину), особа з інвалідністю I–II групи, студент та ін.' },
    '169.1.4': { code: '04', pct: 200, perChild: false, label: '200 %: Герої, учасники бойових дій та ін.' }
};
const round10 = kop => Math.round(kop / 1000) * 1000;

/** Пільга за місяць: { pspKop, code, limitKop, reason }. */
function pspFor({ person, period, grossKop, rate }) {
    const p = person.psp;
    const kind = p && PSP_KINDS[p.kind];
    if (!kind || person.kind !== 'employee' || person.mainJob === false || !rate.subsistenceKop) return { pspKop: 0 };
    if (p.from && p.from.slice(0, 7) > period) return { pspKop: 0 };
    const children = kind.perChild ? Math.max(kind.perChild === true ? 2 : 1, Number(p.children) || 0) : 1;
    const limitKop = round10(rate.subsistenceKop * 14 / 10) * children;
    if (grossKop > limitKop) return { pspKop: 0, code: kind.code, limitKop, reason: `дохід місяця більший за граничний ${(limitKop / 100).toFixed(2).replace('.', ',')} грн — пільга не застосовується` };
    return { pspKop: Math.round(rate.subsistenceKop / 2 * kind.pct / 100) * children, code: kind.code, limitKop };
}

// ------------------------------------------------------------
// ГРАФІК ВІДПУСТОК І ЛІКАРНЯНИХ ПРАЦІВНИКА
// ------------------------------------------------------------
// payroll_people/{id}.leaves: [{ id, type, from, to, avgDailyKop?, note? }] — увесь
// випадок одним записом, навіть якщо він на два місяці. У відомість кожного
// місяця потрапляє лише його частина; для продовження — з датою початку
// випадку (caseStart), щоб середньоденна й 5 днів за рахунок ОСББ рахувались
// від початку, а не від 1-го числа.

/** Перевірка запису графіка: null — гаразд, інакше текст. */
function checkLeave(l) {
    if (!TYPES[l?.type]) return 'Оберіть відпустку чи лікарняний';
    if (!validDate(l.from) || !validDate(l.to) || l.to < l.from) return 'Вкажіть правильні дати з … по …';
    if ((parse(l.to) - parse(l.from)) / DAY > 183) return 'Один запис — не довше пів року. Довшу відсутність розбийте на кілька';
    if (l.avgDailyKop !== undefined && l.avgDailyKop !== null && (!Number.isSafeInteger(l.avgDailyKop) || l.avgDailyKop <= 0 || l.avgDailyKop > 10000000)) return 'Середньоденна — сума в копійках';
    return null;
}

/** Частина випадку, що припадає на місяць; null — якщо не припадає. */
function leavePortion(l, period) {
    const first = `${period}-01`, last = `${period}-${pad(daysInMonth(period))}`;
    if (l.to < first || l.from > last) return null;
    const from = l.from > first ? l.from : first, to = l.to < last ? l.to : last;
    return { type: l.type, from, to, ...(l.from < from ? { caseStart: l.from } : {}), ...(l.avgDailyKop ? { avgDailyKop: l.avgDailyKop } : {}) };
}

const overlaps = (a, b) => a.from <= b.to && b.from <= a.to;

/**
 * Додає до відсутностей місяця частини випадків з графіка, яких там ще немає
 * (за перетином дат). Повертає { absences, added }.
 */
function mergeLeaves(absences = [], leaves = [], period) {
    const out = [...absences];
    let added = 0;
    for (const l of leaves) {
        const part = leavePortion(l, period);
        if (!part || out.some(a => overlaps(a, part))) continue;
        out.push(part);
        added++;
    }
    out.sort((a, b) => a.from.localeCompare(b.from));
    return { absences: out, added };
}

/** Прибирає з відсутностей місяця частину цього випадку (та сама дата початку й кінця частини). */
function dropLeave(absences = [], l, period) {
    const part = leavePortion(l, period);
    return part ? absences.filter(a => !(a.type === part.type && a.from === part.from && a.to === part.to)) : absences;
}

/** Місяці, на які припадає випадок: ['2026-10', '2026-11']. */
function leaveMonths(l) {
    const out = [];
    for (let p = l.from.slice(0, 7); p <= l.to.slice(0, 7) && out.length < 8; p = shift(p, 1)) out.push(p);
    return out;
}

module.exports = { TYPES, SICK_EMPLOYER_DAYS, PSP_KINDS, sickPercent, absenceDates, checkAbsences, averageDaily, leaveFor, pspFor, daysInMonth, shift,
    checkLeave, leavePortion, mergeLeaves, dropLeave, leaveMonths };
