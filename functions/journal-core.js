'use strict';
// ============================================================
// Проводки (Дт/Кт), оборотно-сальдова відомість і закриття місяця.
//
// Проводки не вводяться руками: сервер будує їх з операцій (виписка,
// нарахування, документи витрат) за правилами нижче. Помилку в правилі
// можна виправити й перебудувати проводки, не чіпаючи операцій.
//
// ПЛАН РАХУНКІВ — наказ Мінфіну № 291; схема для ОСББ не нормативна,
// її фіксує облікова політика (LEGAL.md, розділ 8). Тут — робочий варіант
// для перевірки бухгалтером:
//   внески         Дт 377 (приміщення)  Кт 48 (складова)
//   оплата внесків Дт 311 (рахунок)     Кт 377
//   документ       Дт 92 (стаття)       Кт 631 (постачальник)
//   оплата за ним  Дт 631               Кт 311
//   списання без документа: комісія, зарплата й податки до частини 7,
//                  інше — Дт 92 Кт 311; постачальнику — Дт 631 Кт 311 (аванс)
//   інші надходження (оренда, обладнання, відсотки, гранти) — теж Кт 48
//                  з аналітикою джерела: у фінзвітності ОСББ за 2020–2025
//                  чистий прибуток 0, тобто все — цільове фінансування
//   нерозібрані операції банку — 685 (щоб 311 збігався з випискою)
//   кінець місяця: Дт 48 Кт 719 на суму витрат (цільове фінансування
//   використано), 719 і 92 — на 79; результат 0 (Кт 703/733 — лише якщо
//   облікова політика колись виділить власні доходи, тоді результат — на 44).
//   вхідна оборотно-сальдова на 30.09.2026 (journal_opening/main): кожен
//   рядок — проти технічного 00; залишки квартир (377) і документів
//   постачальників до початку обліку (631) — автоматично. Затверджена й
//   збалансована ОСВ закриває 00 у нуль.
//
// Тут немає ні мережі, ні бази: тести — journal-core.test.js.
// ============================================================

const START_PERIOD = '2026-10';
const { toKop } = require('./bank-core');

const ACCOUNTS = {
    '00': 'Введення залишків (технічний)',
    10: 'Основні засоби',
    11: 'Інші необоротні матеріальні активи',
    131: 'Знос основних засобів',
    132: 'Знос інших необоротних матеріальних активів',
    20: 'Виробничі запаси',
    22: 'Малоцінні та швидкозношувані предмети',
    301: 'Готівка в національній валюті (каса)',
    311: 'Поточні рахунки в національній валюті',
    313: 'Інші рахунки в банку (депозит)',
    361: 'Розрахунки з вітчизняними покупцями (орендарі)',
    371: 'Розрахунки за виданими авансами',
    372: 'Розрахунки з підзвітними особами',
    377: 'Розрахунки з іншими дебіторами (співвласники)',
    378: 'Розрахунки з державними цільовими фондами (лікарняні від ПФУ)',
    40: 'Зареєстрований (пайовий) капітал',
    44: 'Нерозподілені прибутки (непокриті збитки)',
    48: 'Цільове фінансування і цільові надходження',
    631: 'Розрахунки з вітчизняними постачальниками',
    641: 'Розрахунки за податками (ПДФО, військовий збір)',
    651: 'Розрахунки за ЄСВ',
    661: 'Розрахунки за виплатами працівникам і за договорами ЦПД',
    685: 'Розрахунки з іншими кредиторами (нерозібрані операції банку)',
    703: 'Дохід від реалізації робіт і послуг',
    719: 'Інші доходи від операційної діяльності',
    733: 'Інші доходи від фінансових операцій',
    79: 'Фінансові результати',
    92: 'Адміністративні витрати'
};
/** Порядок у відомості — за класами рахунків. */
const ORDER = ['00', '10', '11', '131', '132', '20', '22', '301', '311', '313', '361', '371', '372', '377', '378', '40', '44', '48', '631', '641', '651', '661', '685', '703', '719', '733', '79', '92'];

/**
 * Рахунки, залишки яких вносять у вхідну ОСВ руками. 377 (співвласники) і
 * документи постачальників до початку обліку (631) — автоматично; інші
 * борги постачальникам, підзвітні суми, фонди (48) — рядками. Аналітика
 * обовʼязкова там, де за нею звіряють: рахунок банку, постачальник, людина.
 */
const OPENING_ACCOUNTS = ['10', '11', '131', '132', '20', '22', '301', '311', '313', '361', '371', '372', '378', '40', '44', '48', '631', '641', '651', '661', '685'];
const OPENING_NEEDS_A = { 311: 'IBAN рахунку', 313: 'рахунок', 361: 'орендаря', 371: 'кому видано аванс', 372: 'підзвітну особу', 631: 'постачальника', 661: 'працівника', 685: 'кредитора' };

/** Інші надходження → рахунок. Усі — цільове фінансування (48), як у звітності ОСББ. */
const INCOME_ACCOUNT = { rent: '48', equipment: '48', interest: '48', grant: '48', refund: '48', other: '48', sick_fund: '378' };
const BANK_EXPENSE_ITEM = { bank_fee: 'bank', salary: 'salary', taxes: 'salary', esv: 'esv', other: 'other' };

const pad = n => String(n).padStart(2, '0');
const lastDay = period => {
    const [y, m] = period.split('-').map(Number);
    return `${period}-${pad(new Date(Date.UTC(y, m, 0)).getUTCDate())}`;
};
const kyivDate = v => {
    const d = v?.toDate ? v.toDate() : v instanceof Date ? v : v ? new Date(v) : null;
    return d && !Number.isNaN(d.getTime()) ? new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Kyiv' }).format(d) : '';
};
const shift = (period, n) => {
    const [y, m] = period.split('-').map(Number);
    const d = new Date(Date.UTC(y, m - 1 + n, 1));
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}`;
};
const MONTHS = ['січень', 'лютий', 'березень', 'квітень', 'травень', 'червень', 'липень', 'серпень', 'вересень', 'жовтень', 'листопад', 'грудень'];
const monthName = p => `${MONTHS[Number(String(p).slice(5, 7)) - 1] || p} ${String(p).slice(0, 4)}`;
const kopOf = e => (Number.isInteger(e.amountKop) ? e.amountKop : toKop(e.amount || 0));

/** Місяці від початку обліку до period включно. */
function periodsUpTo(period, start = START_PERIOD) {
    const out = [];
    for (let p = start; p <= period; p = shift(p, 1)) out.push(p);
    return out;
}

/**
 * Проводки з операцій. Кожна: { date, period, dr, cr, kop, dA, cA, src, ref, memo }
 * (dA/cA — аналітика: приміщення, рахунок банку, постачальник, стаття).
 *
 * ledgers: Map<apt, entries[]> — нарахування й вхідні залишки (оплати
 *   беремо з виписки, щоб не рахувати двічі);
 * bankTx: [{ id, ...bank_tx }]; expenses: [{ id, ...expenses }];
 * suppliers: Map<id, { name }>; components: Map<id, name>.
 */
function buildEntries({ ledgers = new Map(), bankTx = [], expenses = [], suppliers = new Map(), payrollRuns = [], payrollPayments = new Map(), opening = null, start = START_PERIOD, until }) {
    const out = [];
    const add = (e) => { if (e.kop) out.push(e); };
    const inRange = p => p && p >= start && (!until || p <= until);

    // Затверджена вхідна ОСВ: дебетовий залишок — Дт рахунку Кт 00, кредитовий — Дт 00 Кт рахунку.
    if (opening?.status === 'approved') out.push(...openingEntries(opening.lines, start));

    for (const [apt, entries] of ledgers) {
        for (const e of entries) {
            const kop = kopOf(e);
            if (e.kind === 'opening') {
                // Вхідний залишок: борг — Дт 377, переплата — Кт 377; протилежна сторона — технічний 00.
                const date = lastDay(shift(start, -1));
                if (kop < 0) add({ date, period: shift(start, -1), dr: '377', cr: '00', kop: -kop, dA: apt, src: 'opening', ref: `opening-${apt}`, memo: `Вхідний борг, кв. ${apt}` });
                if (kop > 0) add({ date, period: shift(start, -1), dr: '00', cr: '377', kop, cA: apt, src: 'opening', ref: `opening-${apt}`, memo: `Вхідна переплата, кв. ${apt}` });
            } else if (e.kind === 'charge' && inRange(e.period)) {
                const parts = Array.isArray(e.parts) && e.parts.length ? e.parts : [{ component: 'main', amountKop: kop }];
                for (const p of parts) {
                    add({ date: lastDay(e.period), period: e.period, dr: '377', cr: '48', kop: p.amountKop, dA: apt, cA: p.component || 'main',
                        src: 'charge', ref: `charge-${e.period}-${apt}`, memo: `Нараховано внески за ${monthName(e.period)}, кв. ${apt}` });
                }
            }
        }
    }

    const txById = new Map(bankTx.map(t => [t.id, t]));
    /** Рахунок дебету списання (кому платили): ним же проводимо повернення цих коштів. */
    const debitOf = t => {
        const cp = t.counterparty || {};
        if (t.kind === 'expense' && t.status === 'done' && t.category === 'resident_refund') return { dr: '377', dA: t.allocations?.[0]?.apt || '' };
        if (t.kind === 'expense' && t.status === 'done' && payrollPayments.has(t.paymentId)) {
            const pp = payrollPayments.get(t.paymentId);
            const dr = pp.key === 'pdfo' || pp.key === 'vz' ? '641' : pp.key === 'esv' ? '651' : '661';
            return { dr, dA: dr === '661' ? pp.name : pp.key };
        }
        if (t.kind === 'expense' && t.status === 'done' && t.expenseId) return { dr: '631', dA: expenses.find(x => x.id === t.expenseId)?.supplierName || cp.name || '' };
        if (t.kind === 'expense' && t.status === 'done' && t.category === 'supplier') return { dr: '631', dA: cp.name || '', advance: true };
        if (t.kind === 'expense' && t.status === 'done') return { dr: '92', dA: BANK_EXPENSE_ITEM[t.category] || 'other' };
        return { dr: '685', dA: 'нерозібрано', unknown: true };
    };

    for (const t of bankTx) {
        if (!inRange(t.period)) continue;
        const date = kyivDate(t.at) || lastDay(t.period);
        const acc = t.account || '';
        const cp = t.counterparty || {};
        const base = { date, period: t.period, src: 'bank', ref: t.id };
        if (t.direction === 'in') {
            if (t.kind === 'payment' && t.status === 'done' && (t.allocations || []).length) {
                for (const a of t.allocations) add({ ...base, dr: '311', cr: '377', kop: a.amountKop, dA: acc, cA: a.apt, memo: `Оплата внесків, кв. ${a.apt}` });
            } else if (t.kind === 'income' && t.status === 'done') {
                add({ ...base, dr: '311', cr: INCOME_ACCOUNT[t.category] || '719', kop: t.amountKop, dA: acc, cA: t.category || 'other', memo: t.purpose || cp.name || '' });
            } else if (t.kind === 'internal') {
                // Переказ між власними рахунками — проводимо з боку списання.
            } else if (t.kind === 'refund' && t.status === 'done' && txById.has(t.refundOf)) {
                // Повернення списаного: назад на рахунок, з якого платили (постачальник, зарплата, витрата).
                const back = debitOf(txById.get(t.refundOf));
                add({ ...base, dr: '311', cr: back.dr, kop: t.amountKop, dA: acc, cA: back.dA, memo: `Повернення: ${t.purpose || cp.name || ''}` });
            } else {
                add({ ...base, dr: '311', cr: '685', kop: t.amountKop, dA: acc, cA: 'нерозібрано', memo: `Нерозібране надходження: ${t.purpose || cp.name || ''}` });
            }
        } else if (t.direction === 'out') {
            if (t.kind === 'internal') {
                add({ ...base, dr: '311', cr: '311', kop: t.amountKop, dA: cp.account || 'інший рахунок', cA: acc, memo: t.purpose || 'Переказ між рахунками ОСББ' });
            } else {
                // Зарплата за відомістю — 661/641/651; документ постачальника — 631; без документа — аванс 631;
                // повернення переплати співвласнику — 377; інше — 92; нерозібране — 685.
                const d = debitOf(t);
                const memo = d.unknown ? `Нерозібране списання: ${t.purpose || cp.name || ''}` : d.advance ? `Оплата без документа (аванс): ${t.purpose || ''}`
                    : d.dr === '377' ? `Повернення переплати, кв. ${d.dA}` : t.purpose || '';
                add({ ...base, dr: d.dr, cr: '311', kop: t.amountKop, dA: d.dA, cA: acc, memo });
            }
        }
    }

    // Затверджена відомість зарплати: нараховано (Дт 92 Кт 661), утримано
    // ПДФО й ВЗ (Дт 661 Кт 641), ЄСВ — витрати ОСББ (Дт 92 Кт 651).
    for (const pr of payrollRuns) {
        if (pr.status !== 'approved' || !inRange(pr.period) || !pr.run?.rows) continue;
        const date = lastDay(pr.period);
        const base = { date, period: pr.period, src: 'payroll', ref: `payroll-${pr.period}` };
        for (const r of pr.run.rows) {
            // Лікарняні з 6-го дня — за рахунок ПФУ: Дт 378 (кошти надходять від фонду), решта — витрати ОСББ.
            const fund = r.fundSickKop || 0;
            add({ ...base, dr: '92', cr: '661', kop: r.grossKop - fund, dA: 'salary', cA: r.name, memo: `Нараховано ${r.kind === 'gph' ? 'за договором ЦПД' : 'зарплату'} за ${monthName(pr.period)}` });
            add({ ...base, dr: '378', cr: '661', kop: fund, dA: 'pfu', cA: r.name, memo: 'Лікарняні за рахунок ПФУ' });
            add({ ...base, dr: '661', cr: '641', kop: r.pdfoKop, dA: r.name, cA: 'pdfo', memo: 'Утримано ПДФО 18 %' });
            add({ ...base, dr: '661', cr: '641', kop: r.vzKop, dA: r.name, cA: 'vz', memo: 'Утримано військовий збір 5 %' });
            add({ ...base, dr: '92', cr: '651', kop: r.esvKop, dA: 'esv', cA: r.name, memo: 'Нараховано ЄСВ 22 %' });
        }
    }

    // Документ до початку обліку (акт за вересень), оплачений уже в застосунку
    // чи ще не оплачений, — це вхідний борг перед постачальником: Кт 631.
    for (const e of expenses) {
        if (!['approved', 'paid'].includes(e.status) || !e.period || e.period >= start) continue;
        const paidHere = sum(bankTx.filter(t => t.expenseId === e.id && t.direction === 'out' && inRange(t.period)), t => t.amountKop);
        const owed = paidHere + Math.max(0, e.amountKop - (e.paidKop || 0));
        add({ date: lastDay(shift(start, -1)), period: shift(start, -1), dr: '00', cr: '631', kop: Math.min(owed, e.amountKop), cA: e.supplierName || suppliers.get(e.supplierId)?.name || '',
            src: 'opening', ref: `opening-${e.id}`, memo: `Вхідний борг за документом № ${e.number || '—'} (${e.period})` });
    }
    for (const e of expenses) {
        if (!['approved', 'paid', 'storno'].includes(e.status) || !inRange(e.period)) continue;
        const date = e.date && e.date.startsWith(e.period) ? e.date : lastDay(e.period);
        add({ date, period: e.period, dr: '92', cr: '631', kop: e.amountKop, dA: e.item || 'other', cA: e.supplierName || suppliers.get(e.supplierId)?.name || '',
            src: 'expense', ref: e.id, memo: `${e.description || ''} (№ ${e.number || '—'})`.trim() });
    }
    return out;
}

const sum = (list, f) => list.reduce((s, x) => s + f(x), 0);

/** Рядки вхідної ОСВ → проводки проти 00 на останній день перед початком обліку. */
function openingEntries(lines = [], start = START_PERIOD) {
    const period = shift(start, -1);
    const date = lastDay(period);
    return lines.filter(l => l.kop > 0).map((l, i) => {
        const base = { date, period, kop: l.kop, src: 'opening', ref: `ob-${i + 1}`, memo: l.memo || `Вхідний залишок ${l.acc}` };
        return l.side === 'dr' ? { ...base, dr: l.acc, cr: '00', dA: l.a || '' } : { ...base, dr: '00', cr: l.acc, cA: l.a || '' };
    });
}

/** Перевірка рядків вхідної ОСВ: null — гаразд, інакше текст помилки. */
function checkOpening(lines) {
    if (!Array.isArray(lines)) return 'Немає рядків';
    if (lines.length > 500) return 'Забагато рядків: до 500';
    const seen = new Set();
    for (const [i, l] of lines.entries()) {
        const n = `Рядок ${i + 1}`;
        if (!OPENING_ACCOUNTS.includes(l.acc)) return `${n}: рахунок ${l.acc || '—'} не вносять руками (377 і документи постачальників — автоматично)`;
        if (!['dr', 'cr'].includes(l.side)) return `${n}: оберіть дебет чи кредит`;
        if (!Number.isSafeInteger(l.kop) || l.kop <= 0) return `${n}: сума має бути більшою за нуль`;
        if (OPENING_NEEDS_A[l.acc] && !String(l.a || '').trim()) return `${n}: для рахунку ${l.acc} вкажіть ${OPENING_NEEDS_A[l.acc]}`;
        if (l.acc === '311' && !/^UA\d{27}$/.test(l.a)) return `${n}: для 311 вкажіть IBAN рахунку (UA і 27 цифр)`;
        const key = `${l.acc}|${String(l.a || '').toLowerCase()}`;
        if (seen.has(key)) return `${n}: рахунок ${l.acc}${l.a ? ` (${l.a})` : ''} уже є — обʼєднайте рядки`;
        seen.add(key);
    }
    return null;
}

/** Підсумки вхідної ОСВ разом з автоматичними залишками: різниця має бути 0. */
function openingTotals(autoEntries, lines) {
    const autoDr = sum(autoEntries.filter(e => e.cr === '00'), e => e.kop);
    const autoCr = sum(autoEntries.filter(e => e.dr === '00'), e => e.kop);
    const dr = autoDr + sum(lines.filter(l => l.side === 'dr'), l => l.kop);
    const cr = autoCr + sum(lines.filter(l => l.side === 'cr'), l => l.kop);
    return { autoDr, autoCr, dr, cr, diff: dr - cr };
}

/**
 * Проводки кінця місяця: використання цільового фінансування на суму
 * витрат і закриття доходів і витрат на фінансовий результат.
 */
function closingEntries(entries, period) {
    const month = entries.filter(e => e.period === period);
    const date = lastDay(period);
    const base = { date, period, src: 'close', ref: `close-${period}` };
    const turnover = (acc, side) => sum(month.filter(e => e[side] === acc), e => e.kop);
    const expenses = turnover('92', 'dr') - turnover('92', 'cr');
    const out = [];
    if (expenses) out.push({ ...base, dr: '48', cr: '719', kop: expenses, memo: 'Використано цільове фінансування на витрати місяця' });
    const income = acc => turnover(acc, 'cr') - turnover(acc, 'dr') + (acc === '719' ? expenses : 0);
    for (const acc of ['703', '719', '733']) {
        const k = income(acc);
        if (k > 0) out.push({ ...base, dr: acc, cr: '79', kop: k, memo: 'Доходи місяця — на фінансовий результат' });
        if (k < 0) out.push({ ...base, dr: '79', cr: acc, kop: -k, memo: 'Доходи місяця — на фінансовий результат' });
    }
    if (expenses) out.push({ ...base, dr: '79', cr: '92', kop: expenses, memo: 'Витрати місяця — на фінансовий результат' });
    const result = sum(['703', '719', '733'], acc => income(acc)) - expenses;
    if (result > 0) out.push({ ...base, dr: '79', cr: '44', kop: result, memo: 'Фінансовий результат місяця' });
    if (result < 0) out.push({ ...base, dr: '44', cr: '79', kop: -result, memo: 'Фінансовий результат місяця' });
    return out;
}

/** Усі проводки до period включно: операції + закриття кожного місяця. */
function journal(input, period) {
    const ops = buildEntries({ ...input, until: period });
    const closes = periodsUpTo(period, input.start || START_PERIOD).flatMap(p => closingEntries(ops, p));
    return [...ops, ...closes];
}

/**
 * Оборотно-сальдова відомість за місяць: сальдо на початок, обороти,
 * сальдо на кінець — за рахунками; byA — те саме за аналітикою.
 */
function trialBalance(entries, period) {
    const rows = new Map();
    const row = acc => {
        if (!rows.has(acc)) rows.set(acc, { acc, name: ACCOUNTS[acc] || acc, open: 0, dr: 0, cr: 0, byA: new Map() });
        return rows.get(acc);
    };
    const touch = (acc, a, field, kop) => {
        const r = row(acc);
        r[field] += kop;
        const key = a ?? '';
        if (!r.byA.has(key)) r.byA.set(key, { a: key, open: 0, dr: 0, cr: 0 });
        r.byA.get(key)[field] += kop;
    };
    for (const e of entries) {
        if (e.period > period) continue;
        if (e.period < period) {
            touch(e.dr, e.dA, 'open', e.kop);
            touch(e.cr, e.cA, 'open', -e.kop);
        } else {
            touch(e.dr, e.dA, 'dr', e.kop);
            touch(e.cr, e.cA, 'cr', e.kop);
        }
    }
    const split = r => {
        const close = r.open + r.dr - r.cr;
        return { openDr: Math.max(0, r.open), openCr: Math.max(0, -r.open), dr: r.dr, cr: r.cr, closeDr: Math.max(0, close), closeCr: Math.max(0, -close) };
    };
    const list = [...rows.values()]
        .map(r => {
            const balances = split(r);
            if (['377', '631', '685'].includes(r.acc)) {
                for (const key of ['openDr', 'openCr', 'closeDr', 'closeCr']) balances[key] = sum([...r.byA.values()], a => split(a)[key]);
            }
            return { acc: r.acc, name: r.name, ...balances,
            byA: [...r.byA.values()].map(x => ({ a: x.a, ...split(x) })).filter(x => x.openDr || x.openCr || x.dr || x.cr)
                .sort((x, y) => String(x.a).localeCompare(String(y.a), 'uk', { numeric: true })) };
        })
        .filter(r => r.openDr || r.openCr || r.dr || r.cr || r.closeDr || r.closeCr)
        .sort((a, b) => ORDER.indexOf(a.acc) - ORDER.indexOf(b.acc));
    const totals = ['openDr', 'openCr', 'dr', 'cr', 'closeDr', 'closeCr'].reduce((t, k) => ({ ...t, [k]: sum(list, r => r[k]) }), {});
    return { period, rows: list, totals, balanced: totals.openDr === totals.openCr && totals.dr === totals.cr && totals.closeDr === totals.closeCr };
}

/**
 * Перевірки перед закриттям місяця. level: block — закрити не можна;
 * warn — можна, але бухгалтер має бачити; ok — усе гаразд.
 */
function closeChecks({ period, today, bankTx = [], expenses = [], chargedPeriods = new Set(), closed = [], tb, openingStatus = 'none' }) {
    const out = [];
    const month = bankTx.filter(t => t.period === period);
    if (today <= lastDay(period)) out.push({ level: 'block', text: `Місяць ще не скінчився: закрити можна після ${lastDay(period).split('-').reverse().join('.')}` });
    const prev = shift(period, -1);
    if (period > START_PERIOD && !closed.includes(prev)) out.push({ level: 'block', text: `Спершу закрийте попередній місяць (${prev})` });
    const review = month.filter(t => t.status === 'review');
    if (review.length) out.push({ level: 'block', text: `У «Вхідних» чекають рішення операції банку за цей місяць: ${review.length}` });
    if (!chargedPeriods.has(period)) out.push({ level: 'block', text: 'Внески за цей місяць не нараховано' });
    const pending = expenses.filter(e => e.status === 'pending' && e.period === period);
    if (pending.length) out.push({ level: 'block', text: `Документи чекають затвердження головою: ${pending.length} — затвердьте або відхиліть їх перед закриттям місяця` });
    const advance = tb?.rows.find(r => r.acc === '631')?.byA.filter(x => x.closeDr) || [];
    if (advance.length) out.push({ level: 'warn', text: `Оплати постачальникам без документа (аванси, Дт 631): ${advance.map(x => x.a).join(', ')}` });
    const r00 = tb?.rows.find(r => r.acc === '00');
    const left00 = r00 ? r00.closeDr - r00.closeCr : 0;
    if (openingStatus !== 'approved') {
        out.push({ level: 'warn', text: 'Вхідну оборотно-сальдову на 30.09.2026 не затверджено: банк, каса, фонди й інші рахунки — без вхідних залишків (рахунок 00). Заповніть «Вхідну ОСВ» у цьому розділі' });
    } else if (left00) {
        out.push({ level: 'block', text: `Вхідна ОСВ не збігається з автоматичними залишками (квартири, документи до початку обліку): на рахунку 00 лишилось ${(Math.abs(left00) / 100).toFixed(2)} грн ${left00 > 0 ? 'за дебетом' : 'за кредитом'}. Оновіть вхідну ОСВ і затвердьте знову` });
    }
    if (tb && !tb.balanced) out.push({ level: 'block', text: 'Дебет не дорівнює кредиту — помилка в правилах проводок' });
    if (!out.some(c => c.level === 'block')) out.push({ level: 'ok', text: 'Можна закривати: після закриття операції цього місяця змінити не можна' });
    return out;
}

/** Відбиток проводок місяця: зміни після закриття видно одразу. */
function entriesKey(entries, period) {
    return entries.filter(e => e.period <= period)
        .map(e => `${e.date}|${e.dr}|${e.dA ?? ''}|${e.cr}|${e.cA ?? ''}|${e.kop}|${e.ref}`).sort().join('\n');
}

/** Чи можна змінювати операцію цього місяця. */
const isClosed = (period, closed = []) => closed.includes(String(period || ''));

module.exports = {
    START_PERIOD, ACCOUNTS, ORDER, INCOME_ACCOUNT, OPENING_ACCOUNTS, OPENING_NEEDS_A, lastDay, shift, periodsUpTo,
    buildEntries, openingEntries, checkOpening, openingTotals, closingEntries, journal, trialBalance, closeChecks, entriesKey, isClosed
};
