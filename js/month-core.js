// ============================================================
// Закриття місяця крок за кроком: стан кожного кроку з даних, які
// кабінет уже отримує від сервера (нарахування, черга банку,
// документи витрат, відомість зарплати, перевірки проводок).
//
// Тут немає ні мережі, ні DOM: тести — tests/unit/month-core.test.mjs.
// ============================================================
import { fmtKop, periodName } from './charges-core.js';
import { paymentWho } from './payroll-view-core.js';

/** done — зроблено, work — потрібна дія, locked — ще недоступно, unknown — даних немає. */
export const STATES = { done: 'готово', work: 'потрібна ваша дія', locked: 'ще недоступно', unknown: 'немає даних' };

const grn = kop => `${fmtKop(kop)} грн`;
const plural = (n, one, few, many) => {
    const m10 = n % 10, m100 = n % 100;
    return m10 === 1 && m100 !== 11 ? one : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? few : many;
};

function chargesStep(period, charges) {
    const base = { key: 'charges', title: 'Нарахування', go: 'charges',
        text: 'Внески квартирам за тарифами, затвердженими зборами. Поки місяць відкритий, нарахування можна переглянути чи повторити.' };
    if (!charges) return { ...base, state: 'unknown', short: 'немає даних', facts: [], action: 'Відкрити нарахування' };
    const run = (charges.runs || []).find(r => r.period === period);
    if (!run) return { ...base, state: 'work', short: 'ще не нараховано', facts: [], action: 'Нарахувати внески' };
    const facts = [['Квартир', String(run.count)], ['Нараховано', grn(run.totalKop)]];
    if (!run.complete) return { ...base, state: 'work', short: 'нарахування неповне', facts, action: 'Завершити нарахування' };
    return { ...base, state: 'done', short: `${run.count} ${plural(run.count, 'квартира', 'квартири', 'квартир')} · ${grn(run.totalKop)}`, facts, action: 'Переглянути відомість' };
}

function bankStep(bank) {
    const base = { key: 'bank', title: 'Банк', go: 'inbox',
        text: 'Операції з виписки Приват24. Більшість система розподіляє сама; ті, де вона не певна, чекають вашого підтвердження.' };
    const n = bank?.count || 0;
    if (!n) return { ...base, state: 'done', short: 'усе розподілено', facts: [['Чекають рішення', '0']], action: 'Відкрити банк', go: 'bank' };
    return { ...base, state: 'work', short: `${n} ${plural(n, 'операція чекає', 'операції чекають', 'операцій чекають')}`,
        facts: [['Чекають рішення', String(n)], ['На суму', grn(bank.sumKop || 0)]], action: `Розподілити ${n}` };
}

function docsStep(period, expenses) {
    const base = { key: 'docs', title: 'Документи витрат', go: 'expenses',
        text: 'Рахунки й акти постачальників за місяць. Рахунок і акт однієї послуги — один запис, щоб витрата не задвоїлась.' };
    if (!expenses) return { ...base, state: 'unknown', short: 'немає даних', facts: [], action: 'Відкрити документи' };
    const list = (expenses.expenses || []).filter(e => e.period === period && ['pending', 'approved', 'paid'].includes(e.status));
    const pending = list.filter(e => e.status === 'pending');
    const facts = [['Документів', String(list.length)], ['На суму', grn(list.reduce((s, e) => s + (e.amountKop || 0) - (e.stornoKop || 0), 0))]];
    if (!pending.length) return { ...base, state: 'done', short: list.length ? `${list.length} ${plural(list.length, 'документ', 'документи', 'документів')} погоджено` : 'документів немає', facts, action: 'Відкрити документи' };
    return { ...base, state: 'work', short: `${pending.length} ${plural(pending.length, 'чекає', 'чекають', 'чекають')} погодження`,
        facts: [...facts, ['Чекають', String(pending.length)]], action: 'Відкрити документи' };
}

function payrollStep(payroll) {
    const base = { key: 'payroll', title: 'Зарплата', go: 'payroll',
        text: 'Відомість місяця: нарахування, утримання, ЄСВ. Голова затверджує відомість і підписує виплати в Приват24.' };
    if (!payroll) return { ...base, state: 'unknown', short: 'немає даних', facts: [], action: 'Відкрити зарплату' };
    const gross = payroll.run?.totals?.grossKop;
    const facts = gross ? [['Нараховано', grn(gross)]] : [];
    if (payroll.status === 'none' && !payroll.activePeople) return { ...base, state: 'done', short: 'працівників немає', facts, action: 'Відкрити зарплату' };
    if (payroll.status === 'none') return { ...base, state: 'work', short: 'відомість не складено', facts, action: 'Скласти відомість' };
    if (payroll.status === 'draft') return { ...base, state: 'work', short: 'чекає затвердження голови', facts, action: 'Відкрити відомість' };
    const final = payroll.stages?.final;
    if (final && final.complete !== false) {
        const paid = new Map();
        for (const p of payroll.payments || []) if (p.status === 'paid') paid.set(paymentWho(p), (paid.get(paymentWho(p)) || 0) + p.amountKop - (p.returnedKop || 0));
        const expected = [...(payroll.run?.rows || []).map(r => [r.personId, r.netKop]), ...['pdfo', 'vz', 'esv'].map(k => [k, payroll.run?.totals?.[`${k}Kop`] || 0])];
        if (payroll.run?.rows && expected.every(([k, amount]) => (paid.get(k) || 0) === amount)) return { ...base, state: 'done', short: 'затверджено й виплачено', facts, action: 'Відкрити відомість' };
        return { ...base, state: 'work', short: 'платежі надіслано — чекають проведення банком', facts, action: 'Перевірити платежі' };
    }
    return { ...base, state: 'work', short: 'затверджено, виплату не завершено', facts, action: 'Відкрити відомість' };
}

function checksStep(journal) {
    const base = { key: 'checks', title: 'Перевірка обліку', go: 'journal',
        text: 'Проводки, оборотно-сальдова відомість і звірка з банком та балансами квартир. Що не сходиться — видно тут.' };
    if (!journal) return { ...base, state: 'unknown', short: 'немає даних', facts: [], checks: [], action: 'Відкрити проводки' };
    const checks = (journal.checks || []).filter(c => c.level !== 'ok');
    const blocks = checks.filter(c => c.level === 'block');
    if (journal.status === 'closed') return { ...base, state: 'done', short: 'місяць закрито', facts: [], checks: [], action: 'Відкрити проводки' };
    if (!blocks.length) return { ...base, state: 'done', short: checks.length ? `${checks.length} ${plural(checks.length, 'зауваження', 'зауваження', 'зауважень')}, не блокують` : 'усе збалансовано', facts: [], checks, action: 'Відкрити проводки' };
    return { ...base, state: 'work', short: `${blocks.length} ${plural(blocks.length, 'перешкода', 'перешкоди', 'перешкод')} закриттю`, facts: [], checks, action: 'Відкрити проводки' };
}

function closeStep(period, journal, before) {
    const base = { key: 'close', title: 'Закрити місяць', go: 'journal',
        text: 'Після закриття записи місяця змінити не можна — лише виправленнями в наступному. Відкрити знову може тільки голова, з причиною.' };
    if (!journal) return { ...base, state: 'unknown', short: 'немає даних', facts: [], action: 'Відкрити проводки' };
    if (journal.status === 'closed') {
        const at = journal.closedAt ? new Date(journal.closedAt).toLocaleDateString('uk-UA') : '';
        return { ...base, state: 'done', short: at ? `закрито ${at}` : 'закрито', facts: [], action: 'Відкрити проводки' };
    }
    if (journal.canClose) return { ...base, state: 'work', short: 'можна закривати', facts: [], action: `Закрити ${periodName(period)}`, close: true };
    const left = before.filter(s => s.state !== 'done').map(s => s.title.toLowerCase());
    return { ...base, state: 'locked', short: left.length ? `після: ${left.join(', ')}` : 'перевірки не пройдено', facts: [], action: 'Спершу завершіть попередні кроки' };
}

/**
 * Кроки закриття місяця period.
 *   journal  — journalAction context за period (checks, status, canClose, closedAt);
 *   charges  — chargesAction context (runs);
 *   bank     — { count, sumKop } — операції банку цього місяця, що чекають рішення;
 *   expenses — expenseAction context (expenses з period і status);
 *   payroll  — payrollAction context за period (status, stages, activePeople, run).
 */
export function monthSteps({ period, journal, charges, bank, expenses, payroll }) {
    const steps = [chargesStep(period, charges), bankStep(bank), docsStep(period, expenses), payrollStep(payroll), checksStep(journal)];
    steps.push(closeStep(period, journal, steps));
    return steps.map((s, i) => ({ ...s, n: i + 1 }));
}

/** Скільки кроків зроблено й який відкрити першим. */
export function monthProgress(steps) {
    const done = steps.filter(s => s.state === 'done').length;
    const next = steps.find(s => s.state === 'work') || steps.find(s => s.state !== 'done') || steps.at(-1);
    return { done, total: steps.length, next };
}
