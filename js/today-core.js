// ============================================================
// «Сьогодні»: з чого почати день. Головна дія за роллю, справи з
// черги «Рішень», гроші й рух коштів за місяць, внески мешканців,
// строки, платежі, кошторис і останні операції — з даних, які кабінет
// уже отримує. Тут немає ні мережі, ні DOM: тести —
// tests/unit/today-core.test.mjs.
// ============================================================
import { fmtKop, periodName } from './charges-core.js';
import { humanDate } from './tax-calendar.js';
import { periodOfKey } from './reports-view-core.js';
import { payrollTotals } from './payroll-view-core.js';

const ms = v => (v?.toMillis ? v.toMillis() : v?.toDate ? v.toDate().getTime() : v instanceof Date ? v.getTime() : v ? Date.parse(v) || 0 : 0);
const grn = kop => `${fmtKop(kop)} грн`;
const periodOf = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
export const plural = (n, one, few, many) => {
    const m10 = n % 10, m100 = n % 100;
    return m10 === 1 && m100 !== 11 ? one : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? few : many;
};

// ------------------------------------------------------------
// СПРАВИ — з черги «Рішень», згруповані за видом
// ------------------------------------------------------------
const BANK_TYPES = new Set(['link', 'assign', 'split', 'choose', 'income', 'expense', 'bank-conflict', 'payment-link']);
const DOC_TYPES = new Set(['approve-con', 'approve-exp', 'pay-exp', 'missing-doc']);
const META_GROUP = {
    'помилки платежів': 'failed_pay', 'зарплата': 'payroll', 'звітність': 'reports', 'проводки': 'journal', 'кошторис': 'budget',
    'авансові звіти': 'advance', 'компенсація підзвіт': 'advance', 'майно та тмц': 'assets', 'амортизація оз/мнма': 'assets'
};

/** Групи справ: назва, іконка й куди веде (без go — у «Рішення» з фільтром групи). */
export const GROUPS = {
    failed_pay: { title: 'Виправити відхилені платежі', icon: 'alert', go: 'payments' },
    bank: { title: 'Розподілити операції банку', icon: 'bank' },
    docs: { title: 'Документи й договори', icon: 'doc' },
    pay: { title: 'Створити платежі', icon: 'send' },
    charges: { title: 'Нарахування внесків', icon: 'charges' },
    payroll: { title: 'Зарплата', icon: 'people' },
    advance: { title: 'Авансові звіти', icon: 'receipt' },
    reports: { title: 'Звіти до податкової', icon: 'report' },
    journal: { title: 'Проводки й закриття', icon: 'journal' },
    budget: { title: 'Кошторис', icon: 'budget' },
    assets: { title: 'Майно та ТМЦ', icon: 'box' }
};
const ORDER = Object.keys(GROUPS);

export function groupOf(item) {
    const p = item.proposal;
    if (BANK_TYPES.has(p.type)) return 'bank';
    if (DOC_TYPES.has(p.type)) return 'docs';
    if (p.type === 'pay') return 'pay';
    if (p.type === 'charge') return 'charges';
    if (p.paymentsAction === 'open-failed') return 'failed_pay';
    return META_GROUP[p.meta] || 'charges';
}

function noteOf(item) {
    const p = item.proposal;
    if (p.paymentsAction === 'open-failed') {
        const first = String(p.text || '').split('. ')[0];
        return first ? `Банк не прийняв: ${first}` : (p.title || 'Банк не прийняв платіж');
    }
    if (BANK_TYPES.has(p.type)) return [item.tx?.counterparty?.name, item.tx?.purpose].filter(Boolean).join(' · ') || 'Операція з виписки';
    if (p.type === 'pay') return `${p.payment?.recipient?.name || 'Платіж'} · ${grn(p.payment?.amountKop || 0)}`;
    if (p.expense) return `${p.expense.supplierName || 'Документ'} · ${grn(p.expense.amountKop || 0)}`;
    if (p.contract) return `Договір: ${p.contract.subject || p.contract.number || 'на затвердження'}`;
    if (p.type === 'charge') return 'Внески за місяць готові до нарахування';
    return p.title || '';
}

/** Справи за групами в усталеному порядку: [{ key, title, icon, go?, count, sumKop, note }]. */
export function tasks(items = []) {
    const out = new Map();
    for (const item of items) {
        const g = groupOf(item);
        const t = out.get(g) || { key: g, ...GROUPS[g], count: 0, sumKop: 0, note: noteOf(item) };
        if (g === 'failed_pay') {
            t.count += item.proposal.failedPaymentsCount || 1;
            t.sumKop += item.proposal.failedPaymentsSumKop || 0;
        } else {
            t.count += 1;
            if (BANK_TYPES.has(item.proposal.type)) t.sumKop += item.tx?.amountKop || 0;
        }
        out.set(g, t);
    }
    return [...out.values()].sort((a, b) => ORDER.indexOf(a.key) - ORDER.indexOf(b.key));
}

// ------------------------------------------------------------
// ГОЛОВНА ДІЯ ЗАРАЗ
// ------------------------------------------------------------

/**
 * Одна найважливіша дія за роллю: { tone: bad|todo|wait|done, eyebrow, title, hint, go, group?, btn }.
 * Бухгалтер: відхилене банком → прострочений строк → операції банку → строк за 3 дні →
 * до оплати → інші рішення → закриття місяця. Голова: підпис у Приват24 → погодження → строки.
 */
export function focusOf({ role = 'accountant', list = [], pay = null, deadline = null, month = null } = {}) {
    const chair = role === 'chair';
    const by = k => list.find(t => t.key === k);
    const left = d => (d.left < 0 ? `прострочено на ${-d.left} ${plural(-d.left, 'день', 'дні', 'днів')}` : d.left === 0 ? 'сьогодні' : d.left === 1 ? 'завтра' : `через ${d.left} ${plural(d.left, 'день', 'дні', 'днів')}`);
    const dl = d => ({ tone: d.left < 0 ? 'bad' : 'todo', eyebrow: `Строк ${left(d)}`, title: d.title, hint: `${d.detail ? `${d.detail} · ` : ''}до ${humanDate(d.date)}. Дані й файли — у «Звітах».`, go: 'reports', btn: 'До звітів' });
    if (chair) {
        if (pay?.signing?.count) return { tone: 'todo', eyebrow: 'Чекає вашого КЕП', title: `Підпишіть ${pay.signing.count} ${plural(pay.signing.count, 'платіж', 'платежі', 'платежів')} — ${grn(pay.signing.kop)}`,
            hint: 'Приват24 для бізнесу → «Платежі» → «На підписі». Виписка сама позначить їх проведеними.', go: 'payments', btn: 'Переглянути платежі' };
        const decide = list.filter(t => t.key !== 'failed_pay').reduce((s, t) => s + t.count, 0);
        if (deadline && deadline.left < 0) return dl(deadline);
        if (decide) return { tone: 'todo', eyebrow: 'Чекає вашого рішення', title: `${decide} ${plural(decide, 'рішення', 'рішення', 'рішень')} — погодження й перевірки`,
            hint: 'Документи, договори, відомість зарплати чи авансові звіти: поки ви не погодили, бухгалтер не може їх оплатити.', go: 'inbox', group: 'all', btn: 'До «Рішень»' };
        if (deadline && deadline.left <= 3) return dl(deadline);
        return { tone: 'done', eyebrow: 'Усе під контролем', title: 'Нічого не чекає вашого підпису', hint: 'Бухгалтер готує платежі й звіти — вони зʼявляться тут, щойно знадобиться ваш КЕП.', go: 'month', btn: 'Стан місяця' };
    }
    const failed = by('failed_pay');
    if (failed) return { tone: 'bad', eyebrow: 'Банк не прийняв', title: `${failed.count === 1 ? 'Платіж не пройшов' : `${failed.count} ${plural(failed.count, 'платіж', 'платежі', 'платежів')} не пройшли`} — ${grn(failed.sumKop)}`,
        hint: failed.note, go: 'payments', btn: 'Виправити' };
    if (deadline && deadline.left < 0) return dl(deadline);
    const bank = by('bank');
    if (bank) return { tone: 'todo', eyebrow: 'Почніть з виписки', title: `Розподіліть ${bank.count} ${plural(bank.count, 'операцію', 'операції', 'операцій')} банку — ${grn(bank.sumKop)}`,
        hint: 'Оплати мешканців і списання, де система не впевнена. Решту вона розподілила сама.', go: 'inbox', group: 'bank', btn: 'Розподілити' };
    if (deadline && deadline.left <= 3) return dl(deadline);
    if (pay?.todo?.count) return { tone: 'todo', eyebrow: 'До оплати', title: `Створіть ${pay.todo.count} ${plural(pay.todo.count, 'платіж', 'платежі', 'платежів')} — ${grn(pay.todo.kop)}`,
        hint: 'Погоджені документи, відомість зарплати, регулярні платежі. Після створення вони чекатимуть КЕП голови.', go: 'payments', btn: 'До платежів' };
    const rest = list.reduce((s, t) => s + t.count, 0);
    if (rest) return { tone: 'todo', eyebrow: 'Рішення', title: `${rest} ${plural(rest, 'рішення', 'рішення', 'рішень')} чекають`, hint: list.map(t => t.title).slice(0, 3).join(' · '), go: 'inbox', group: 'all', btn: 'До «Рішень»' };
    if (month && month.done < month.total) return { tone: 'wait', eyebrow: 'Закриття місяця', title: `Далі: ${month.next.title.toLowerCase()}`, hint: month.next.short || '', go: 'month', btn: 'До місяця' };
    return { tone: 'done', eyebrow: 'Усе вирішено', title: 'Нових справ немає', hint: 'Система підготує наступні, щойно прийде виписка чи документ.', go: 'month', btn: 'Стан місяця' };
}

// ------------------------------------------------------------
// РУХ КОШТІВ ЗА МІСЯЦЬ
// ------------------------------------------------------------

/**
 * Надходження й списання по днях поточного місяця (без переказів між своїми рахунками):
 * { days: [{ day, inKop, outKop, future, today }], inKop, outKop, netKop, maxKop, residentsKop, outTop: [{ label, kop }] }.
 */
export function cashByDay(txs = [], now = new Date(), labels = {}) {
    const y = now.getFullYear(), m = now.getMonth();
    const last = new Date(y, m + 1, 0).getDate();
    const days = Array.from({ length: last }, (_, i) => ({ day: i + 1, inKop: 0, outKop: 0, future: i + 1 > now.getDate(), today: i + 1 === now.getDate() }));
    const out = new Map();
    let residentsKop = 0;
    for (const t of txs) {
        if (t.kind === 'internal' || t.bankVoided) continue;
        const d = new Date(ms(t.at));
        if (d.getFullYear() !== y || d.getMonth() !== m) continue;
        const slot = days[d.getDate() - 1];
        const kop = t.amountKop || 0;
        if (t.direction === 'out') {
            slot.outKop += kop;
            const key = t.category || 'other';
            out.set(key, (out.get(key) || 0) + kop);
        } else {
            slot.inKop += kop;
            if (t.kind === 'payment') residentsKop += kop;
        }
    }
    const inKop = days.reduce((s, d) => s + d.inKop, 0), outKop = days.reduce((s, d) => s + d.outKop, 0);
    return {
        days, inKop, outKop, netKop: inKop - outKop, residentsKop,
        maxKop: Math.max(1, ...days.map(d => Math.max(d.inKop, d.outKop))),
        outTop: [...out.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, kop]) => ({ key: k, label: labels[k] || 'Інше', kop }))
    };
}

// ------------------------------------------------------------
// ВНЕСКИ МЕШКАНЦІВ
// ------------------------------------------------------------

/**
 * Збір за місяць і борги: { period, chargedKop, paidKop, share, paidApts, totalApts, debtKop, debtors, top: [{ apt, kop }] }.
 * share — частка нарахованого, яку вже сплатили (null, якщо нарахування ще немає).
 */
export function collection(charges, txs = [], now = new Date()) {
    const period = charges?.current || periodOf(now);
    const run = (charges?.runs || []).find(r => r.period === period) || null;
    const paid = txs.filter(t => t.kind === 'payment' && t.status === 'done' && t.direction !== 'out' && periodOf(new Date(ms(t.at))) === periodOf(now));
    const paidKop = paid.reduce((s, t) => s + (t.amountKop || 0), 0);
    const apts = new Set(paid.flatMap(t => (t.allocations || []).map(a => String(a?.apt || '').trim())).filter(Boolean));
    const all = charges?.apartments || [];
    const debtorsList = all.filter(a => Number(a.balance) < 0).map(a => ({ apt: a.apt, kop: Math.round(-Number(a.balance) * 100) })).sort((a, b) => b.kop - a.kop);
    return {
        period, known: Boolean(charges),
        chargedKop: run?.totalKop || 0,
        paidKop,
        share: run?.totalKop ? Math.min(100, Math.round(paidKop / run.totalKop * 100)) : null,
        paidApts: apts.size,
        totalApts: run?.count || all.length,
        debtKop: debtorsList.reduce((s, a) => s + a.kop, 0),
        debtors: debtorsList.length,
        top: debtorsList.slice(0, 5)
    };
}

// ------------------------------------------------------------
// СТРОКИ
// ------------------------------------------------------------

/** Найближчі строки (прострочені й до horizon днів), однакова дата — один рядок: [{ iso, date, left, items: [{ title, detail, key }] }]. */
export function upcoming(tasksList = [], horizon = 120, limit = 4) {
    const open = tasksList.filter(t => !t.done && !t.waiting && t.left <= horizon).sort((a, b) => a.left - b.left);
    const byDate = new Map();
    for (const t of open) {
        const g = byDate.get(t.iso) || { iso: t.iso, date: t.date, left: t.left, items: [] };
        g.items.push({ title: t.title, detail: t.detail || '', key: t.key, kind: t.kind });
        byDate.set(t.iso, g);
    }
    return [...byDate.values()].slice(0, limit);
}

/** Людський опис строку: «сьогодні», «завтра», «через 5 дн.», «прострочено 2 дн.». */
export const leftText = d => (d < 0 ? `прострочено ${-d} дн.` : d === 0 ? 'сьогодні' : d === 1 ? 'завтра' : `через ${d} дн.`);

/**
 * Опис строку для картки: ЄСВ і податковий розрахунок на одну дату — одним рядком.
 * { categoryLabel, leftText, dateHeadline, whatText, isOverdue } або null.
 */
export function describeDeadline(soon, allTasks = []) {
    if (!soon) return null;
    const same = (allTasks || []).filter(t => !t.done && !t.waiting && t.iso === soon.iso);
    const hasEsv = same.some(t => t.key.startsWith('esv-'));
    const hasJ05 = same.some(t => t.key.startsWith('j0500111-'));
    const repPeriod = periodOfKey(soon.key);
    const monthLabel = repPeriod ? periodName(repPeriod) : '';
    const whatText = hasEsv && hasJ05 && monthLabel ? `Сплатити ЄСВ і подати Податковий розрахунок за ${monthLabel}`
        : same.length > 1 ? same.map(t => t.title).join(' · ') : `${soon.title}${soon.detail ? ` (${soon.detail})` : ''}`;
    return {
        categoryLabel: soon.left < 0 ? 'Прострочено' : soon.kind === 'decision' ? 'Календар ОСББ' : 'Податковий календар',
        leftText: leftText(soon.left), dateHeadline: `до ${humanDate(soon.date)}`, whatText, isOverdue: soon.left < 0
    };
}

// ------------------------------------------------------------
// ОЧІКУВАНІ ВИПЛАТИ МІСЯЦЯ (прогноз)
// ------------------------------------------------------------

/**
 * Що ще треба сплатити цього місяця й ще не відправлено в банк: документи, договори без
 * документа за місяць, авансові звіти, зарплата «на руки» й податки з неї.
 */
export function computeUpcomingPayments({ expenses, payroll, journal, payments = [], period }) {
    const activePeriod = period || payroll?.period || journal?.period || new Date().toISOString().slice(0, 7);
    const monthStartIso = `${activePeriod}-01`, monthEndIso = `${activePeriod}-31`;
    const inBank = new Set(payments.filter(p => ['sending', 'unknown', 'sent'].includes(p.status) && p.expenseId).map(p => p.expenseId));
    const exList = expenses?.expenses || [];
    const left = e => (e.amountKop || 0) - (e.stornoKop || 0) - (e.paidKop || 0);
    const unpaidDocs = exList.filter(e => ['approved', 'pending'].includes(e.status) && !e.linkedTo && !inBank.has(e.id) && (!e.period || e.period <= activePeriod) && left(e) > 0);
    const unpaidDocsKop = unpaidDocs.reduce((s, e) => s + Math.max(0, left(e)), 0);
    const documented = (c, samePeriod) => exList.filter(e => e.contractId === c.id && (!samePeriod || e.period === activePeriod) && !['rejected', 'canceled', 'linked'].includes(e.status))
        .reduce((s, e) => s + Math.max(0, (e.amountKop || 0) - (e.stornoKop || 0)), 0);
    let expectedContractsKop = 0, expectedContractsCount = 0;
    for (const c of expenses?.contracts || []) {
        if (c.status !== 'approved') continue;
        if (!((!c.validFrom || c.validFrom <= monthEndIso) && (!c.validTo || c.validTo >= monthStartIso))) continue;
        let rest = 0;
        if (c.type === 'monthly' && c.monthlyKop > 0) rest = Math.max(0, c.monthlyKop - documented(c, true));
        else if (c.type === 'fixed' && c.amountKop > 0 && (c.validFrom?.startsWith(activePeriod) || c.date?.startsWith(activePeriod))) rest = Math.max(0, c.amountKop - documented(c, false));
        if (rest > 0) { expectedContractsKop += rest; expectedContractsCount++; }
    }
    let unpaidAdvanceKop = journal?.advanceSummary?.toReimburseKop || 0;
    if (journal?.advanceSummary?.inBankCount === undefined && unpaidAdvanceKop > 0) {
        const inBankAdv = payments.filter(p => ['sending', 'unknown', 'sent'].includes(p.status) && (p.advanceReportId || p.kind === 'advance' || String(p.proposalKey || '').startsWith('adv-')))
            .reduce((s, p) => s + (p.amountKop || 0), 0);
        unpaidAdvanceKop = Math.max(0, unpaidAdvanceKop - inBankAdv);
    }
    const contractsAndDocsKop = expectedContractsKop + unpaidDocsKop + unpaidAdvanceKop;
    const pt = payroll?.run ? payrollTotals(payroll) : {};
    const salaryLeftKop = Math.max(0, (pt.netKop || 0) - (pt.netPaidKop || 0) - (pt.netSigningKop || 0));
    const taxesLeftKop = Math.max(0, (pt.taxKop || 0) - (pt.taxPaidKop || 0) - (pt.taxSigningKop || 0));
    const totalKop = contractsAndDocsKop + salaryLeftKop + taxesLeftKop;
    return {
        period: activePeriod, totalKop, contractsAndDocsKop, expectedContractsKop, expectedContractsCount, unpaidDocsKop, unpaidDocsCount: unpaidDocs.length,
        unpaidAdvanceKop, salaryLeftKop, taxesLeftKop,
        goTarget: contractsAndDocsKop > 0 ? 'expenses' : salaryLeftKop > 0 || taxesLeftKop > 0 ? 'payroll' : 'payments'
    };
}

// ------------------------------------------------------------
// КОШТОРИС
// ------------------------------------------------------------

/**
 * Виконання кошторису року: витрати проти плану на сьогодні й рядки з перевитратою.
 * { year, planKop, toDateKop, factKop, pct, incomePlanKop, incomeFactKop, incomePct, over: [{ title, overKop }] } або null.
 */
export function budgetPace(b) {
    const t = b?.execution?.totals;
    if (!b?.budget || !t || !t.planKop) return null;
    const lines = (b.execution.sections || []).flatMap(s => s.lines || []);
    const months = b.execution.months || 12;
    const incomeToDate = Math.round((t.incomePlanKop || 0) * months / 12);
    return {
        year: b.year, approved: b.budget.status === 'approved',
        planKop: t.planKop, toDateKop: t.toDateKop, factKop: t.factKop,
        pct: t.toDateKop ? Math.round(t.factKop / t.toDateKop * 100) : 0,
        yearPct: Math.round(t.factKop / t.planKop * 100),
        incomePlanKop: t.incomePlanKop || 0, incomeToDateKop: incomeToDate, incomeFactKop: t.incomeFactKop || 0,
        incomePct: incomeToDate ? Math.round((t.incomeFactKop || 0) / incomeToDate * 100) : 0,
        over: lines.filter(l => l.factKop > l.toDateKop && l.toDateKop > 0).map(l => ({ title: l.title, overKop: l.factKop - l.toDateKop }))
            .sort((a, b2) => b2.overKop - a.overKop).slice(0, 2)
    };
}

// ------------------------------------------------------------
// ОСТАННІ ОПЕРАЦІЇ
// ------------------------------------------------------------

/** Останні операції банку (без переказів між своїми рахунками), від нових. */
export const recentOps = (txs = [], n = 6) => txs.filter(t => t.kind !== 'internal' && !t.bankVoided)
    .sort((a, b) => ms(b.at) - ms(a.at)).slice(0, n);
