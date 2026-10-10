'use strict';
// ============================================================
// Зарплата й виплати фізособам (частина 7): розрахунок відомості.
//
// Працівник за трудовим договором: оклад × відпрацьовані дні / норма +
// премія. Утримання — ПДФО 18 % і військовий збір 5 %; ЄСВ 22 % —
// нарахування ОСББ (не утримання). Для основного місця роботи база ЄСВ
// за повний місяць не нижча за мінімальну зарплату, незалежно від ставки.
// Виконавець за договором ЦПД: сума акта, ті самі ПДФО, ВЗ і ЄСВ, без
// мінімальної бази (ознака доходу 102).
//
// Двічі на місяць (ст. 115 КЗпП): аванс — частина нарахування за першу
// половину; ПДФО й ВЗ утримуються в день кожної виплати. Решта й ЄСВ —
// при остаточному розрахунку. ЄСВ сплачується також під час авансу.
//
// Ставки — довідник у коді з датою дії (LEGAL.md, розділ 7).
// Тут немає ні мережі, ні бази: тести — payroll-core.test.js.
// ============================================================

/** Ставки: відсотки в базисних пунктах (1800 = 18 %), гроші в копійках. */
// subsistenceKop — прожитковий мінімум для працездатних на 1 січня (для ПСП).
const DEFAULT_RATES = [
    { from: '2026-01', pdfo: 1800, vz: 500, esv: 2200, minWageKop: 864700, maxBaseMult: 20, subsistenceKop: 332800 }
];

const KINDS = { employee: 'Трудовий договір', gph: 'Договір ЦПД' };
const { validIban } = require('./payments-core');
const { validDate } = require('./expenses-core');
const leave = require('./leave-core');

const pct = (kop, bp) => Math.round(kop * bp / 10000);
/** «4 323,50» — як суми в застосунку. */
const uah = kop => (Math.round(kop) / 100).toFixed(2).replace('.', ',').replace(/\B(?=(\d{3})+(?!\d))/g, ' ');

/** Чинні на місяць ставки: останні з датою дії не пізніше місяця. */
function rateFor(period, rates = DEFAULT_RATES) {
    const list = [...rates].filter(r => r.from <= period).sort((a, b) => (a.from < b.from ? 1 : -1));
    return list[0] || null;
}

/**
 * Норма робочих днів: понеділок–пʼятниця. Під час воєнного стану святкові
 * дні не є неробочими (ст. 73 КЗпП не застосовується, Закон № 2136-IX), тож
 * окремого календаря свят немає; переноси вносить бухгалтер вручну.
 */
function workingDays(period) {
    const [y, m] = period.split('-').map(Number);
    const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
    let n = 0;
    for (let d = 1; d <= days; d++) {
        const wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
        if (wd !== 0 && wd !== 6) n++;
    }
    return n;
}

const validRnokpp = code => {
    const d = String(code || '');
    if (!/^\d{10}$/.test(d)) return false;
    const sum = [-1, 5, 7, 9, 4, 6, 10, 5, 7].reduce((s, w, i) => s + w * Number(d[i]), 0);
    return ((sum % 11) + 11) % 11 % 10 === Number(d[9]);
};
/** Робочі дні в межах трудових відносин (для прийому/звільнення посеред місяця). */
function employmentDays(person, period) {
    const [y, m] = period.split('-').map(Number);
    const dates = [];
    for (let d = 1; d <= workingDaysEnd(period); d++) {
        const at = new Date(Date.UTC(y, m - 1, d));
        if (![0, 6].includes(at.getUTCDay())) dates.push(at.toISOString().slice(0, 10));
    }
    return dates.filter(d => (!person.from || d >= person.from) && (!person.to || d <= person.to)).length;
}

/** Календарні дні трудових/цивільних відносин для Д1, включно з вихідними. */
function calendarDays(person, period) {
    const [year, month] = period.split('-').map(Number);
    const first = `${period}-01`;
    const last = `${period}-${String(new Date(Date.UTC(year, month, 0)).getUTCDate()).padStart(2, '0')}`;
    const from = person.from && person.from > first ? person.from : first;
    const to = person.to && person.to < last ? person.to : last;
    return from > to ? 0 : Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000) + 1;
}

/** Перевірка картки людини. */
function checkPerson(p) {
    const name = String(p.name || '').trim();
    if (name.split(/\s+/).length < 2) return 'Вкажіть прізвище та імʼя повністю';
    if (!KINDS[p.kind]) return 'Оберіть вид договору';
    if (p.rnokpp && !validRnokpp(p.rnokpp)) return 'РНОКПП — 10 цифр; контрольна цифра не збігається';
    if (p.iban && !validIban(p.iban)) return 'IBAN має вигляд UA та 27 цифр';
    if (p.kind === 'employee') {
        if (!Number.isInteger(p.salaryKop) || p.salaryKop <= 0) return 'Вкажіть оклад';
        if (!(p.fte > 0 && p.fte <= 1)) return 'Ставка — від 0,1 до 1';
    }
    if (p.psp) {
        if (!leave.PSP_KINDS[p.psp.kind]) return 'Оберіть вид податкової соціальної пільги';
        if (!validDate(p.psp.from)) return 'ПСП: вкажіть дату заяви працівника';
        if (p.mainJob === false) return 'ПСП — лише за основним місцем роботи';
        if (p.psp.kind === '169.1.2' && (p.psp.children || 0) < 2) return 'ПСП на дітей (169.1.2) — від двох дітей до 18 років';
    }
    if ((p.from && !validDate(p.from)) || (p.to && !validDate(p.to))) return 'Вкажіть правильну дату прийому / звільнення';
    if (p.from && p.to && p.to < p.from) return 'Дата звільнення раніше за прийом';
    return null;
}

/**
 * Нарахування за місяць одній людині.
 * input: { workedDays, bonusKop, actKop } — табель і акти місяця;
 *   correctionKop (±), correctionFor (місяць), correctionNote — перерахунок
 *   уже виплаченого за минулий місяць: проходить нарахуванням цього місяця
 *   з утриманнями й ЄСВ (стару відомість не переписуємо).
 * Повертає { grossKop, pdfoKop, vzKop, netKop, esvBaseKop, esvKop, advance, final, warnings }.
 */
function calcRow(person, input, period, rate, { advancePct = 50, history = [] } = {}) {
    const warnings = [];
    const problems = [];
    const norm = workingDays(period);
    let grossKop, esvBaseKop;
    let lv = null, regularKop = 0, fundSickKop = 0, workedDays = null;
    if (person.kind === 'gph') {
        grossKop = Math.max(0, Math.round(Number(input.actKop) || 0));
        esvBaseKop = grossKop;
        regularKop = grossKop;
        if (!grossKop) warnings.push('немає суми акта виконаних робіт');
    } else {
        const available = employmentDays(person, period);
        // Відпустки й лікарняні: робочі дні відсутності не оплачуються окладом.
        lv = leave.leaveFor({ person, absences: input.absences || [], period, rate, history });
        warnings.push(...lv.warnings);
        problems.push(...lv.problems);
        const present = Math.max(0, available - lv.vacationWorkdays - lv.sickWorkdays);
        const worked = Math.min(present, Math.max(0, Number(input.workedDays ?? present)));
        workedDays = worked;
        const bonus = Math.max(0, Math.round(Number(input.bonusKop) || 0));
        regularKop = Math.round(person.salaryKop * worked / norm) + bonus;
        // Кошти ПФУ за лікарняний (з 6-го дня) — нараховуємо, коли надійшли.
        fundSickKop = Math.max(0, Math.round(Number(input.fundSickKop) || 0));
        grossKop = regularKop + lv.vacationKop + lv.sickKop + fundSickKop;
        esvBaseKop = grossKop;
        const fte = person.fte || 1;
        if (person.salaryKop < Math.round(rate.minWageKop * fte)) {
            warnings.push(`оклад менший за мінімальну зарплату${fte < 1 ? ` для ставки ${fte}` : ''} (${uah(rate.minWageKop * fte)} грн) — потрібна доплата до МЗП`);
        }
        if (person.mainJob !== false && grossKop > 0 && available === norm) {
            // Мінімальна база — на зарплату й відпускні; у місяці з лікарняним — пропорційно дням без нього.
            const dim = leave.daysInMonth(period);
            const minBase = lv.sickDays ? Math.round(rate.minWageKop * (dim - lv.sickDays) / dim) : rate.minWageKop;
            const nonSick = regularKop + lv.vacationKop;
            if (nonSick < minBase) {
                esvBaseKop = minBase + lv.sickKop + fundSickKop;
                warnings.push('ЄСВ — з мінімальної бази (основне місце роботи): різницю сплачує ОСББ');
            }
        }
        if (worked < norm) warnings.push(`відпрацьовано ${worked} з ${norm} дн.`);
    }
    // Перерахунок за минулий місяць: окремо від мінімальної бази й авансу поточного місяця.
    const correctionKop = Math.round(Number(input.correctionKop) || 0);
    if (correctionKop) {
        grossKop += correctionKop;
        esvBaseKop = Math.max(0, esvBaseKop + correctionKop);
        warnings.push(`перерахунок${input.correctionFor ? ` за ${input.correctionFor.split('-').reverse().join('.')}` : ''}: ${correctionKop > 0 ? '+' : '−'}${uah(Math.abs(correctionKop))} грн${input.correctionNote ? ` (${input.correctionNote})` : ''}`);
    }
    esvBaseKop = Math.min(esvBaseKop, rate.minWageKop * rate.maxBaseMult);
    // Податкова соціальна пільга зменшує лише базу ПДФО.
    const psp = leave.pspFor({ person, period, grossKop, rate });
    if (psp.reason) warnings.push(`ПСП: ${psp.reason}`);
    else if (psp.pspKop) warnings.push(`ПСП ${uah(psp.pspKop)} грн (ознака ${psp.code})`);
    const pdfoKop = pct(Math.max(0, grossKop - psp.pspKop), rate.pdfo);
    const vzKop = pct(grossKop, rate.vz);
    const esvKop = pct(esvBaseKop, rate.esv);
    // Аванс — лише працівникам: частина зарплати за першу половину плюс відпускні (їх платять до відпустки).
    const vacation = lv?.vacationKop || 0;
    const advGross = person.kind === 'employee' ? Math.max(0, Math.min(grossKop, Math.round(regularKop * advancePct / 100) + vacation)) : 0;
    const advance = { grossKop: advGross, pdfoKop: Math.min(pdfoKop, pct(advGross, rate.pdfo)), vzKop: pct(advGross, rate.vz) };
    advance.netKop = advance.grossKop - advance.pdfoKop - advance.vzKop;
    advance.esvKop = pct(Math.min(advance.grossKop, esvBaseKop), rate.esv);
    const final = { grossKop: grossKop - advance.grossKop, pdfoKop: pdfoKop - advance.pdfoKop, vzKop: vzKop - advance.vzKop };
    final.netKop = final.grossKop - final.pdfoKop - final.vzKop;
    final.esvKop = esvKop - advance.esvKop;
    return { grossKop, pdfoKop, vzKop, netKop: grossKop - pdfoKop - vzKop, esvBaseKop, esvKop, advance, final, normDays: norm, warnings, leaveProblems: problems,
        regularKop, calendarDays: calendarDays(person, period), ...(workedDays !== null ? { workedDays } : {}),
        vacationKop: vacation, vacationDays: lv?.vacationDays || 0, sickKop: lv?.sickKop || 0, sickDays: lv?.sickDays || 0,
        sickEmployerDays: lv?.sickEmployerDays || 0, fundDays: lv?.fundDays || 0, fundExpectKop: lv?.fundExpectKop || 0, fundSickKop,
        absences: lv?.items || [], pspKop: psp.pspKop, pspCode: psp.pspKop ? psp.code : '',
        correctionKop, correctionFor: correctionKop ? input.correctionFor || '' : '', correctionNote: correctionKop ? input.correctionNote || '' : '' };
}

/** Хто в відомості місяця: діючі на місяць (прийняті до кінця, не звільнені до початку). */
function activeIn(people, period) {
    const start = `${period}-01`;
    const end = `${period}-${String(workingDaysEnd(period)).padStart(2, '0')}`;
    // Порядок відомості сталий: працівники, потім ЦПД; за прізвищем.
    return people.filter(p => (p.active !== false || p.to) && (!p.from || p.from <= end) && (!p.to || p.to >= start))
        .sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'employee' ? -1 : 1) || String(a.name).localeCompare(String(b.name), 'uk'));
}
const workingDaysEnd = period => {
    const [y, m] = period.split('-').map(Number);
    return new Date(Date.UTC(y, m, 0)).getUTCDate();
};

/**
 * Відомість за місяць: рядки, підсумки, застереження й проблеми, що
 * заважають виплаті (немає IBAN, РНОКПП, повідомлення ДПС про прийом).
 */
function buildRun({ people, inputs = {}, period, rates = DEFAULT_RATES, advancePct = 50, history = new Map() }) {
    const rate = rateFor(period, rates);
    if (!rate) return { error: `Немає ставок для ${period}` };
    const rows = activeIn(people, period).map(p => {
        const input = inputs[p.id] || {};
        const { leaveProblems, ...r } = calcRow(p, input, period, rate, { advancePct, history: history.get(p.id) || [] });
        const problems = [...leaveProblems];
        if (!p.iban) problems.push('немає IBAN для виплати');
        if (!p.rnokpp) problems.push('немає РНОКПП (потрібен для звіту ДПС)');
        if (p.kind === 'employee' && !p.taxNotified) problems.push('не позначено повідомлення ДПС про прийняття працівника');
        return { personId: p.id, name: p.name, kind: p.kind, position: p.position || '', fte: p.fte || null, salaryKop: p.salaryKop || 0,
            workedDays: null,
            payee: { iban: p.iban || '', rnokpp: p.rnokpp || '', contract: p.contract || '' },
            relationship: { from: p.from || '', to: p.to || '', mainJob: p.mainJob !== false, position: p.position || '', kind: p.kind },
            bonusKop: Math.round(Number(input.bonusKop) || 0), actKop: p.kind === 'gph' ? Math.round(Number(input.actKop) || 0) : null,
            ...r, problems };
    });
    const sum = key => rows.reduce((s, r) => s + r[key], 0);
    const sumIn = (stage, key) => rows.reduce((s, r) => s + r[stage][key], 0);
    return {
        period, rate, rows,
        peopleSnapshot: people.map(p => ({ id: p.id, name: p.name, rnokpp: p.rnokpp || '', kind: p.kind, position: p.position || '', from: p.from || '', to: p.to || '', active: p.active !== false })),
        totals: { grossKop: sum('grossKop'), pdfoKop: sum('pdfoKop'), vzKop: sum('vzKop'), netKop: sum('netKop'), esvKop: sum('esvKop'),
            advance: { grossKop: sumIn('advance', 'grossKop'), pdfoKop: sumIn('advance', 'pdfoKop'), vzKop: sumIn('advance', 'vzKop'), netKop: sumIn('advance', 'netKop'), esvKop: sumIn('advance', 'esvKop') },
            final: { grossKop: sumIn('final', 'grossKop'), pdfoKop: sumIn('final', 'pdfoKop'), vzKop: sumIn('final', 'vzKop'), netKop: sumIn('final', 'netKop'), esvKop: sumIn('final', 'esvKop') },
            costKop: sum('grossKop') + sum('esvKop') }
    };
}

const MONTHS_GEN = ['січень', 'лютий', 'березень', 'квітень', 'травень', 'червень', 'липень', 'серпень', 'вересень', 'жовтень', 'листопад', 'грудень'];
const monthName = p => `${MONTHS_GEN[Number(p.slice(5, 7)) - 1]} ${p.slice(0, 4)}`;

/**
 * Платежі етапу виплати: «на руки» кожному, ПДФО і ВЗ разом (у день
 * виплати), ЄСВ — з остаточним розрахунком. Податкові — у форматі
 * призначення «*;101;ЄДРПОУ;…» на рахунки з налаштувань.
 * stage: 'advance' | 'final'. taxes: { pdfo, vz, esv: { name, iban, code } }.
 */
function stagePayments(run, stage, { code, taxes = {}, people = new Map() }) {
    const out = [];
    const what = stage === 'advance' ? `Аванс за ${monthName(run.period)}` : `Заробітна плата за ${monthName(run.period)}`;
    for (const r of run.rows) {
        const part = r[stage];
        if (!part || part.netKop <= 0) continue;
        const p = r.payee || people.get(r.personId) || {};
        out.push({ kind: 'salary', key: `${stage}:${r.personId}`, personId: r.personId, amountKop: part.netKop,
            recipient: { name: r.name, iban: p.iban || '', code: p.rnokpp || '' },
            purpose: r.kind === 'gph' ? `Оплата за договором ЦПД${p.contract ? ` ${p.contract}` : ''} за ${monthName(run.period)}, без ПДВ` : `${what}, без ПДВ` });
    }
    const sum = key => run.rows.reduce((s, r) => s + (r[stage]?.[key] || 0), 0);
    const tax = (key, amountKop, label) => {
        if (amountKop <= 0) return;
        const t = taxes[key] || {};
        out.push({ kind: 'tax', key: `${stage}:${key}`, amountKop, recipient: { name: t.name || '', iban: t.iban || '', code: t.code || '' },
            purpose: `*;101;${code};${label} ${stage === 'advance' ? 'з авансу ' : ''}за ${monthName(run.period)};;;` });
    };
    tax('pdfo', sum('pdfoKop'), 'ПДФО із заробітної плати');
    tax('vz', sum('vzKop'), 'Військовий збір із заробітної плати');
    tax('esv', sum('esvKop'), 'ЄСВ');
    return out;
}

/** Що заважає створити платежі етапу. */
function paymentProblems(payments) {
    return payments.filter(p => !validIban(p.recipient.iban)).map(p => (p.kind === 'tax'
        ? `немає рахунку для «${p.key.split(':')[1].toUpperCase()}» — внесіть у «Зарплата → Податки»`
        : `${p.recipient.name}: немає IBAN`));
}

module.exports = {
    DEFAULT_RATES, KINDS, rateFor, workingDays, validRnokpp, validIban, checkPerson, calcRow, activeIn, buildRun,
    stagePayments, paymentProblems, monthName, employmentDays, calendarDays
};
