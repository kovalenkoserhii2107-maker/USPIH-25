// ============================================================
// Закриття місяця крок за кроком: стан кожного кроку з даних, які
// кабінет уже отримує від сервера — нарахування, виписка й звірка
// залишків, документи й акти за договорами, платежі, авансові звіти,
// зарплата, звітність за місяць, майно й амортизація, перевірки
// проводок і саме закриття.
//
// Тут немає ні мережі, ні DOM: тести — tests/unit/month-core.test.mjs.
// ============================================================
import { fmtKop, periodName } from './charges-core.js';
import { paymentWho } from './payroll-view-core.js';

/**
 * done — зроблено; work — потрібна дія; wait — не заважає закриттю (чекає голову, банк чи строк);
 * locked — ще недоступно; unknown — даних немає.
 */
export const STATES = { done: 'готово', work: 'потрібна дія', wait: 'не заважає закриттю', locked: 'ще недоступно', unknown: 'немає даних' };

/** Фази місяця — у такому порядку їх і проходять. */
export const PHASES = { income: 'Доходи', bank: 'Банк', costs: 'Витрати', payroll: 'Зарплата й звіти', ledger: 'Облік і закриття' };

const grn = kop => `${fmtKop(kop)} грн`;
const plural = (n, one, few, many) => {
    const m10 = n % 10, m100 = n % 100;
    return m10 === 1 && m100 !== 11 ? one : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? few : many;
};
const lastDay = period => { const [y, m] = period.split('-').map(Number); return `${period}-${String(new Date(y, m, 0).getDate()).padStart(2, '0')}`; };
const human = iso => iso.split('-').reverse().join('.');
const ms = v => (v?.toMillis ? v.toMillis() : v instanceof Date ? v.getTime() : v ? Date.parse(v) || 0 : 0);
const monthOf = v => { const d = new Date(ms(v)); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; };

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
    const base = { key: 'bank', title: 'Операції виписки', go: 'inbox',
        text: 'Операції з виписки Приват24. Більшість система розподіляє сама; ті, де вона не певна, чекають вашого підтвердження.' };
    const n = bank?.count || 0;
    if (!n) return { ...base, state: 'done', short: 'усе розподілено', facts: [['Чекають рішення', '0']], action: 'Відкрити банк', go: 'bank' };
    return { ...base, state: 'work', short: `${n} ${plural(n, 'операція чекає', 'операції чекають', 'операцій чекають')}`,
        facts: [['Чекають рішення', String(n)], ['На суму', grn(bank.sumKop || 0)]], action: `Розподілити ${n}` };
}

function docsStep(period, expenses) {
    const base = { key: 'docs', title: 'Документи витрат', go: 'expenses',
        text: 'Рахунки й акти постачальників за місяць і акти за щомісячними договорами. Рахунок і акт однієї послуги — один запис, щоб витрата не задвоїлась. Голова погоджує кожен документ.' };
    if (!expenses) return { ...base, state: 'unknown', short: 'немає даних', facts: [], action: 'Відкрити документи' };
    const list = (expenses.expenses || []).filter(e => e.period === period && ['pending', 'approved', 'paid'].includes(e.status));
    const pending = list.filter(e => e.status === 'pending');
    const missing = (expenses.missing || []).filter(m => m.period === period)
        .map(m => (expenses.contracts || []).find(c => c.id === m.contractId)).filter(Boolean);
    const facts = [['Документів', String(list.length)], ['На суму', grn(list.reduce((s, e) => s + (e.amountKop || 0) - (e.stornoKop || 0), 0))]];
    if (pending.length) facts.push(['Чекають голову', String(pending.length)]);
    if (missing.length) facts.push(['Бракує актів', missing.map(c => c.supplierName || c.subject || `№ ${c.number}`).join(', ')]);
    if (pending.length) return { ...base, state: 'work', who: 'chair', short: `${pending.length} ${plural(pending.length, 'чекає', 'чекають', 'чекають')} погодження голови${missing.length ? ` · бракує ${missing.length} ${plural(missing.length, 'акта', 'актів', 'актів')}` : ''}`, facts, action: 'Відкрити документи' };
    if (missing.length) return { ...base, state: 'work', short: `бракує ${missing.length} ${plural(missing.length, 'акта', 'актів', 'актів')} за договорами`, facts, action: 'Додати акти', missing };
    return { ...base, state: 'done', short: list.length ? `${list.length} ${plural(list.length, 'документ', 'документи', 'документів')} погоджено` : 'документів немає', facts, action: 'Відкрити документи' };
}

/** Платежі місяця: відхилені банком — дія; на підписі й неоплачені документи — не заважають закриттю. */
function paymentsStep(period, payments, expenses) {
    const base = { key: 'payments', title: 'Платежі', go: 'payments',
        text: 'Оплати постачальникам, зарплати й податків через Приват24. Підписує голова КЕП, проведення підтверджує виписка. Неоплачений документ закриттю не заважає — це борг постачальнику на кінець місяця.' };
    if (!payments) return { ...base, state: 'unknown', short: 'немає даних', facts: [], action: 'Відкрити платежі' };
    const docIds = new Set((expenses?.expenses || []).filter(e => e.period === period).map(e => e.id));
    const mine = payments.filter(p => monthOf(p.createdAt) === period || docIds.has(p.expenseId) || p.payroll?.period === period);
    const bad = mine.filter(p => ['failed', 'unknown'].includes(p.status));
    const signing = mine.filter(p => ['sending', 'sent'].includes(p.status));
    const paid = mine.filter(p => p.status === 'paid');
    const inBank = new Set(payments.filter(p => ['sending', 'unknown', 'sent'].includes(p.status) && p.expenseId).map(p => p.expenseId));
    const toPay = (expenses?.expenses || []).filter(e => e.period === period && e.status === 'approved' && e.amountKop - (e.stornoKop || 0) > (e.paidKop || 0) && !inBank.has(e.id));
    const sum = list => list.reduce((s, p) => s + (p.amountKop || 0), 0);
    const facts = [['Проведено', `${paid.length} · ${grn(sum(paid))}`]];
    if (signing.length) facts.push(['На підписі голови', `${signing.length} · ${grn(sum(signing))}`]);
    if (toPay.length) facts.push(['Документів до оплати', `${toPay.length} · ${grn(toPay.reduce((s, e) => s + e.amountKop - (e.stornoKop || 0) - (e.paidKop || 0), 0))}`]);
    if (bad.length) return { ...base, state: 'work', short: `${bad.length} ${plural(bad.length, 'платіж', 'платежі', 'платежів')} банк не прийняв чи не підтвердив`, facts, action: 'Виправити' };
    if (signing.length) return { ...base, state: 'wait', who: 'chair', short: `${signing.length} на підписі голови`, facts, action: 'Відкрити платежі' };
    if (toPay.length) return { ...base, state: 'wait', short: `${toPay.length} ${plural(toPay.length, 'документ', 'документи', 'документів')} до оплати`, facts, action: 'Створити платежі' };
    return { ...base, state: 'done', short: paid.length ? `${paid.length} проведено банком` : 'платежів не було', facts, action: 'Відкрити платежі' };
}

/** Авансові звіти: на затвердженні й до відшкодування — не блокують закриття, але про них варто знати. */
function advanceStep(summary) {
    const base = { key: 'advance', title: 'Авансові звіти', go: 'advance',
        text: 'Витрати підзвітних осіб (рах. 372): чеки, дрібні закупівлі. Голова затверджує звіт, перевитрату відшкодовують платежем у Приват24.' };
    if (!summary) return { ...base, state: 'unknown', short: 'немає даних', facts: [], action: 'Відкрити звіти' };
    const facts = [];
    if (summary.pendingCount) facts.push(['Чекають голову', String(summary.pendingCount)]);
    if (summary.toReimburseCount) facts.push(['До відшкодування', `${summary.toReimburseCount} · ${grn(summary.toReimburseKop || 0)}`]);
    if (summary.inBankCount) facts.push(['На підписі', `${summary.inBankCount} · ${grn(summary.inBankKop || 0)}`]);
    if (summary.toReimburseCount) return { ...base, state: 'wait', short: `до відшкодування ${grn(summary.toReimburseKop || 0)}`, facts, action: 'Відшкодувати' };
    if (summary.pendingCount) return { ...base, state: 'wait', who: 'chair', short: `${summary.pendingCount} ${plural(summary.pendingCount, 'чекає', 'чекають', 'чекають')} затвердження голови`, facts, action: 'Відкрити звіти' };
    return { ...base, state: 'done', short: summary.inBankCount ? 'відшкодування на підписі' : 'незакритих звітів немає', facts, action: 'Відкрити звіти' };
}

function payrollStep(payroll) {
    const base = { key: 'payroll', title: 'Зарплата', go: 'payroll',
        text: 'Відомість місяця: нарахування, утримання, ЄСВ. Голова затверджує відомість і підписує виплати в Приват24.' };
    if (!payroll) return { ...base, state: 'unknown', short: 'немає даних', facts: [], action: 'Відкрити зарплату' };
    const gross = payroll.run?.totals?.grossKop;
    const facts = gross ? [['Нараховано', grn(gross)]] : [];
    if (payroll.status === 'none' && !payroll.activePeople) return { ...base, state: 'done', short: 'працівників немає', facts, action: 'Відкрити зарплату' };
    if (payroll.status === 'none') return { ...base, state: 'work', short: 'відомість не складено', facts, action: 'Скласти відомість' };
    if (payroll.pendingLeaves && !payroll.stages?.final) return { ...base, state: 'work', short: 'нові відпустки чи лікарняні не враховано', facts, action: 'Перерахувати відомість' };
    if (payroll.status === 'draft') return { ...base, state: 'work', who: 'chair', short: 'чекає затвердження голови', facts, action: 'Відкрити відомість' };
    const final = payroll.stages?.final;
    if (final && final.complete !== false) {
        const paid = new Map();
        for (const p of payroll.payments || []) if (p.status === 'paid') paid.set(paymentWho(p), (paid.get(paymentWho(p)) || 0) + p.amountKop - (p.returnedKop || 0));
        const expected = [...(payroll.run?.rows || []).map(r => [r.personId, r.netKop]), ...['pdfo', 'vz', 'esv'].map(k => [k, payroll.run?.totals?.[`${k}Kop`] || 0])];
        if (payroll.run?.rows && expected.every(([k, amount]) => (paid.get(k) || 0) === amount)) return { ...base, state: 'done', short: 'затверджено й виплачено', facts, action: 'Відкрити відомість' };
        const broken = (payroll.payments || []).some(p => p.status === 'failed' || (p.status === 'paid' && p.returnedKop > 0 && !p.repaid));
        if (broken) return { ...base, state: 'work', short: 'банк повернув чи не прийняв частину виплат', facts, action: 'Повторити виплату' };
        return { ...base, state: 'wait', who: 'chair', short: 'платежі надіслано — чекають підпису й виписки', facts, action: 'Перевірити платежі' };
    }
    return { ...base, state: 'work', short: 'затверджено, виплату не завершено', facts, action: 'Відкрити відомість' };
}

/** Звірка залишків банку з обліком на останній день місяця — без неї сервер не закриє місяць. */
function bankCutStep(period, journal, today) {
    const base = { key: 'bankcut', title: 'Звірка залишків банку', go: 'journal', inline: 'bankcut',
        text: `Залишки поточного й депозитного рахунків в обліку мають дорівнювати випискам на ${human(lastDay(period))}. Введіть залишки з виписки й її реквізити — розбіжність покаже пропущену операцію.` };
    if (!journal) return { ...base, state: 'unknown', short: 'немає даних', facts: [], action: 'Відкрити проводки' };
    const rows = journal.bankRows || [];
    const facts = rows.map(r => [`…${String(r.iban).slice(-4)} · рах. ${r.acc}`, grn(r.balanceKop)]);
    if (journal.status === 'closed') return { ...base, state: 'done', short: 'звірено під час закриття', facts: [], action: 'Відкрити проводки' };
    if (!rows.length) return { ...base, state: 'done', short: 'рахунків для звірки немає', facts, action: 'Відкрити проводки' };
    if (journal.bankCut?.key && journal.bankCut.key === journal.key) return { ...base, state: 'done', short: `звірено${journal.bankCut.note ? ` · ${journal.bankCut.note}` : ''}`, facts, action: 'Відкрити проводки' };
    if ((today || journal.today || '') <= lastDay(period)) return { ...base, state: 'locked', short: `після ${human(lastDay(period))}`, facts, action: 'Звірити після кінця місяця' };
    return { ...base, state: 'work', short: journal.bankCut ? 'операції змінились — звірте знову' : `звірте з випискою на ${human(lastDay(period))}`, facts, action: 'Звірити залишки' };
}

/** Звітність і податки за місяць: прострочене — дія, інше — строк у наступному місяці. */
function reportsStep(tasks) {
    const base = { key: 'reports', title: 'Податки й звітність', go: 'reports',
        text: 'ЄСВ, ПДФО й військовий збір із зарплати цього місяця та податковий розрахунок. Цифри — із затвердженої відомості; подає голова в Електронному кабінеті.' };
    if (!tasks) return { ...base, state: 'unknown', short: 'немає даних', facts: [], action: 'Відкрити звіти' };
    if (!tasks.length) return { ...base, state: 'done', short: 'звітувати за місяць не потрібно', facts: [], action: 'Відкрити звіти' };
    const open = tasks.filter(t => !t.done).sort((a, b) => a.left - b.left);
    const facts = tasks.map(t => [t.title, t.done ? 'готово' : t.waiting ? 'подано, чекає квитанцію' : `до ${human(t.iso)}`]);
    if (!open.length) return { ...base, state: 'done', short: 'сплачено й подано', facts, action: 'Відкрити звіти' };
    const late = open.filter(t => t.left < 0 && !t.waiting);
    if (late.length) return { ...base, state: 'work', short: `прострочено: ${late.map(t => t.title).join(', ')}`, facts, action: 'До звітів' };
    const first = open[0];
    return { ...base, state: 'wait', short: first.waiting ? 'подано — чекає квитанцію' : `строк ${human(first.iso)}`, facts, action: 'До звітів' };
}

/** Майно: нарахувати амортизацію ОЗ/МНМА за місяць і ввести придбане в експлуатацію. */
function assetsStep(summary) {
    const base = { key: 'assets', title: 'Майно й амортизація', go: 'assets',
        text: 'Основні засоби й МНМА: амортизація за місяць і введення в експлуатацію придбаного. Без амортизації витрати місяця будуть неповні.' };
    if (!summary) return { ...base, state: 'unknown', short: 'немає даних', facts: [], action: 'Відкрити майно' };
    const total = (summary.ozCount || 0) + (summary.mnhmaCount || 0);
    const facts = [['ОЗ і МНМА', String(total)]];
    if (summary.deprThisPeriodKop) facts.push(['Амортизація за місяць', grn(summary.deprThisPeriodKop)]);
    if (summary.uncommissionedCount) facts.push(['Не введено в експлуатацію', String(summary.uncommissionedCount)]);
    if (summary.dueDeprCount) return { ...base, state: 'work', short: `нарахуйте амортизацію: ${summary.dueDeprCount} ${plural(summary.dueDeprCount, 'обʼєкт', 'обʼєкти', 'обʼєктів')} · ${grn(summary.dueDeprKop || 0)}`, facts, action: 'Нарахувати амортизацію' };
    if (summary.uncommissionedCount) return { ...base, state: 'wait', short: `${summary.uncommissionedCount} не введено в експлуатацію`, facts, action: 'Відкрити майно' };
    return { ...base, state: 'done', short: total ? 'амортизацію нараховано' : 'обʼєктів немає', facts, action: 'Відкрити майно' };
}

function checksStep(journal) {
    const base = { key: 'checks', title: 'Перевірка обліку', go: 'journal',
        text: 'Проводки, оборотно-сальдова відомість і звірка з банком та балансами квартир. Перешкоди закриттю — червоним, зауваження — жовтим.' };
    if (!journal) return { ...base, state: 'unknown', short: 'немає даних', facts: [], checks: [], action: 'Відкрити проводки' };
    const checks = (journal.checks || []).filter(c => c.level !== 'ok');
    const blocks = checks.filter(c => c.level === 'block');
    if (journal.status === 'closed') return { ...base, state: 'done', short: 'місяць закрито', facts: [], checks, action: 'Відкрити проводки' };
    if (!blocks.length) return { ...base, state: 'done', short: checks.length ? `${checks.length} ${plural(checks.length, 'зауваження', 'зауваження', 'зауважень')}, не блокують` : 'усе збалансовано', facts: [], checks, action: 'Відкрити проводки' };
    return { ...base, state: 'work', short: `${blocks.length} ${plural(blocks.length, 'перешкода', 'перешкоди', 'перешкод')} закриттю`, facts: [], checks, action: 'Відкрити проводки' };
}

function closeStep(period, journal, before) {
    const base = { key: 'close', title: 'Закрити місяць', go: 'journal',
        text: 'Після закриття записи місяця змінити не можна — лише виправленнями в наступному. Відкрити знову може тільки голова, з причиною.' };
    if (!journal) return { ...base, state: 'unknown', short: 'немає даних', facts: [], action: 'Відкрити проводки' };
    if (journal.status === 'closed') {
        const at = journal.closedAt ? new Date(journal.closedAt).toLocaleDateString('uk-UA') : '';
        return { ...base, state: 'done', short: at ? `закрито ${at}` : 'закрито', facts: [], action: 'Відкрити проводки', reopen: Boolean(journal.canReopen) };
    }
    if (journal.canClose) return { ...base, state: 'work', short: 'можна закривати', facts: [], action: `Закрити ${periodName(period)}`, close: true };
    const left = before.filter(s => s.state === 'work' || s.state === 'locked').map(s => s.title.toLowerCase());
    return { ...base, state: 'locked', short: left.length ? `після: ${left.join(', ')}` : 'перевірки не пройдено', facts: [], action: 'Спершу завершіть попередні кроки' };
}

const PHASE_OF = { charges: 'income', bank: 'bank', bankcut: 'bank', docs: 'costs', payments: 'costs', advance: 'costs', payroll: 'payroll', reports: 'payroll', assets: 'ledger', checks: 'ledger', close: 'ledger' };

/**
 * Кроки закриття місяця period.
 *   journal  — journalAction context за period (checks, status, canClose, closedAt, bankRows, bankCut, key,
 *              assetsSummary, advanceSummary);
 *   charges  — chargesAction context (runs);
 *   bank     — { count, sumKop } — операції банку цього місяця, що чекають рішення;
 *   expenses — expenseAction context (expenses з period і status, contracts, missing);
 *   payroll  — payrollAction context за period (status, stages, activePeople, run, pendingLeaves);
 *   payments — усі платежі (або null — немає даних); reports — строки звітності саме за period;
 *   today    — 'YYYY-MM-DD' (за замовчуванням — з journal).
 */
export function monthSteps({ period, journal, charges, bank, expenses, payroll, payments = null, reports = null, today = null }) {
    const steps = [chargesStep(period, charges), bankStep(bank), bankCutStep(period, journal, today), docsStep(period, expenses),
        paymentsStep(period, payments, expenses), advanceStep(journal?.advanceSummary), payrollStep(payroll), reportsStep(reports),
        assetsStep(journal?.assetsSummary), checksStep(journal)];
    steps.push(closeStep(period, journal, steps));
    return steps.map((s, i) => ({ ...s, n: i + 1, phase: PHASE_OF[s.key] }));
}

/** Скільки кроків зроблено (крок, що не заважає закриттю, теж вважається пройденим) і який відкрити першим. */
export function monthProgress(steps) {
    const done = steps.filter(s => s.state === 'done' || s.state === 'wait').length;
    const next = steps.find(s => s.state === 'work') || steps.find(s => s.state === 'locked') || steps.find(s => s.state !== 'done' && s.state !== 'wait') || steps.at(-1);
    return { done, total: steps.length, next };
}

/** Фази зі станом: work, якщо є хоч одна дія; locked — нічого робити, але й не готово; інакше done. */
export function monthPhases(steps) {
    return Object.entries(PHASES).map(([key, title]) => {
        const list = steps.filter(s => s.phase === key);
        const state = list.some(s => s.state === 'work') ? 'work' : list.some(s => s.state === 'locked' || s.state === 'unknown') ? 'locked'
            : list.some(s => s.state === 'wait') ? 'wait' : 'done';
        return { key, title, state, steps: list, done: list.filter(s => s.state === 'done' || s.state === 'wait').length };
    }).filter(p => p.steps.length);
}

/**
 * Підсумки місяця з оборотно-сальдової відомості:
 * гроші (311, 313, 351, 143, 301), співвласники (377), витрати (92), постачальники (631),
 * зарплата (661) і ЄСВ (651), доходи (703, 719, 733). null — відомості немає.
 */
export function monthTotals(tb) {
    if (!tb?.rows) return null;
    const row = acc => tb.rows.find(r => String(r.acc) === acc) || { openDr: 0, openCr: 0, dr: 0, cr: 0, closeDr: 0, closeCr: 0 };
    const money = ['311', '313', '351', '143', '301'].map(row);
    const sum = (list, f) => list.reduce((s, r) => s + (r[f] || 0), 0);
    const r377 = row('377'), r631 = row('631');
    return {
        moneyOpenKop: sum(money, 'openDr') - sum(money, 'openCr'),
        moneyInKop: sum(money, 'dr'), moneyOutKop: sum(money, 'cr'),
        moneyCloseKop: sum(money, 'closeDr') - sum(money, 'closeCr'),
        chargedKop: r377.dr || 0, residentsPaidKop: r377.cr || 0,
        residentsDebtKop: (r377.closeDr || 0) - (r377.closeCr || 0),
        expensesKop: row('92').dr || 0,
        incomeKop: ['703', '719', '733'].reduce((s, a) => s + (row(a).cr || 0), 0),
        suppliersDebtKop: (r631.closeCr || 0) - (r631.closeDr || 0),
        payrollKop: row('661').cr || 0, esvKop: row('651').cr || 0,
        balanced: tb.balanced !== false
    };
}
