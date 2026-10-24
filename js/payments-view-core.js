// ============================================================
// «Платежі»: шлях грошей від погодження до виписки й звʼязки кожного
// платежу з документом, договором, відомістю зарплати, авансовим
// звітом і операцією банку. Тут немає ні мережі, ні DOM: тести —
// tests/unit/payments-view-core.test.mjs.
//
// Шлях: погодження (документ, відомість, авансовий звіт чекають
// голову) → до оплати (система пропонує) → на підписі голови в
// Приват24 → проведено (виписка знайшла списання).
// ============================================================
import { remaining, supplierFlags } from './docs-core.js';
import { stageState } from './payroll-view-core.js';

const ms = v => (v?.toMillis ? v.toMillis() : v instanceof Date ? v.getTime() : v ? Date.parse(v) || 0 : 0);
const normIban = v => String(v || '').replace(/\s+/g, '').toUpperCase();
const STALE_MS = 10 * 60 * 1000;
const SIGNING = ['sending', 'sent', 'unknown'];

export const TABS = { todo: 'До оплати', signing: 'На підписі', history: 'Історія' };
export const KINDS = { supplier: 'Постачальнику', salary: 'Зарплата', tax: 'Податки', advance: 'Підзвітній особі', other: 'Інше' };
export const HISTORY_FILTERS = { all: 'Усі', supplier: 'Постачальникам', salary: 'Зарплата', tax: 'Податки', advance: 'Підзвітні', other: 'Інше' };
const TAX_NAMES = { pdfo: 'ПДФО', vz: 'Військовий збір', esv: 'ЄСВ' };

export const isSigning = p => SIGNING.includes(p.status);

/** Вид платежу для людини: зарплату й податки з відомості розрізняємо за отримувачем. */
export function kindOf(p) {
    if (p.payroll) return p.payroll.recipientType === 'tax' || TAX_NAMES[p.payroll.key] ? 'tax' : 'salary';
    if (p.kind === 'advance' || p.advanceReportId) return 'advance';
    return KINDS[p.kind] ? p.kind : 'other';
}

/**
 * Що з платежем не так і хто це виправляє:
 * failed — банк не прийняв; unknown — банк не підтвердив (голова перевіряє в Приват24);
 * stale — відправка чи скасування зависли понад 10 хв; returned — банк повернув зарплату
 * (її повторюють із відомості; повернення постачальнику знову відкриває документ «до оплати»).
 */
export function problemOf(p, now = Date.now()) {
    if (p.status === 'failed') return 'failed';
    if (p.status === 'unknown') return 'unknown';
    if (p.status === 'sending' && now - (ms(p.createdAt) || now) > STALE_MS) return 'stale';
    if (p.canceling && now - (ms(p.canceling.at) || now) > STALE_MS) return 'stale';
    if (p.status === 'paid' && p.payroll && p.returnedKop > 0 && !(p.repaidBy || []).length && !p.repaid) return 'returned';
    return null;
}
export const PROBLEM_TEXT = {
    failed: 'Банк не прийняв',
    unknown: 'Банк не підтвердив — перевірте в Приват24',
    stale: 'Відповідь банку затрималась — перевірте в Приват24',
    returned: 'Банк повернув кошти'
};

/** Позначки звʼязків платежу: [{ type, text, id?, period?, state? }] — що за ним стоїть і чим він закрився. */
export function paymentTags(p, ex = null) {
    const tags = [];
    const expense = p.expenseId ? ex?.expenses?.find(e => e.id === p.expenseId) : null;
    if (p.expenseId) tags.push({ type: 'doc', id: p.expenseId, text: expense ? `${ex?.docTypes?.[expense.docType] || 'Документ'} № ${expense.number}` : 'Документ' });
    const contract = expense?.contractId ? ex?.contracts?.find(c => c.id === expense.contractId) : null;
    if (contract) tags.push({ type: 'contract', id: contract.id, text: contract.number && contract.number !== 'б/н' ? `Договір № ${contract.number}` : 'Договір' });
    if (p.payroll?.period) tags.push({ type: 'payroll', period: p.payroll.period, text: `Відомість · ${p.payroll.stage === 'advance' ? 'аванс' : 'зарплата'} ${monthShort(p.payroll.period)}` });
    if (p.advanceReportId) tags.push({ type: 'advance', id: p.advanceReportId, text: 'Авансовий звіт' });
    if (!p.expenseId && !p.payroll && !p.advanceReportId) {
        tags.push(String(p.proposalKey || '').startsWith('manual:') || !p.proposalKey ? { type: 'manual', text: 'Вручну' } : { type: 'regular', text: 'Регулярний' });
    }
    if (p.txId) tags.push({ type: 'tx', id: p.txId, text: 'У виписці', state: 'ok' });
    else if (p.status === 'paid') tags.push({ type: 'tx', text: 'Без операції у виписці', state: 'warn' });
    return tags;
}

const MONTHS = ['січ', 'лют', 'бер', 'квіт', 'трав', 'черв', 'лип', 'серп', 'вер', 'жовт', 'лист', 'груд'];
const MONTHS_FULL = ['січень', 'лютий', 'березень', 'квітень', 'травень', 'червень', 'липень', 'серпень', 'вересень', 'жовтень', 'листопад', 'грудень'];
const monthShort = period => { const [y, m] = String(period).split('-').map(Number); return m ? `${MONTHS[m - 1]} ${y}` : ''; };
export const monthName = period => { const [y, m] = String(period).split('-').map(Number); return m ? `${MONTHS_FULL[m - 1]} ${y}` : ''; };
const periodOf = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;

// ------------------------------------------------------------
// ДО ОПЛАТИ: документи, регулярні, зарплата, авансові звіти
// ------------------------------------------------------------

/** Погоджені документи із залишком, за якими ще немає платежу в банку. */
export function docsToPay(ex, payments = []) {
    const inBank = new Set(payments.filter(p => p.expenseId && isSigning(p)).map(p => p.expenseId));
    return (ex?.expenses || []).filter(e => e.status === 'approved' && remaining(e) > 0 && !inBank.has(e.id));
}

/**
 * Що зарплатна відомість чекає оплатити: { period, stage, amountKop, taxKop, state, note } або null.
 * Платежі відомості створює «Зарплата» (план затверджений головою), тут — лише нагадування й перехід.
 */
export function payrollDue(ctx) {
    if (!ctx || ctx.closed || ctx.status !== 'approved' || !(ctx.run?.rows || []).length) return null;
    const t = ctx.run?.totals || {};
    const adv = stageState(ctx, 'advance'), fin = stageState(ctx, 'final');
    const tax = (t.pdfoKop || 0) + (t.vzKop || 0) + (t.esvKop || 0);
    const base = { period: ctx.period };
    if (['building', 'partial'].includes(adv)) return { ...base, stage: 'advance', amountKop: t.advance?.netKop || 0, taxKop: 0, state: 'bad', note: adv === 'building' ? 'відомість у банку не завершено' : 'частину платежів не створено' };
    if (['building', 'partial'].includes(fin)) return { ...base, stage: 'final', amountKop: ctx.stages?.advance ? t.final?.netKop || 0 : t.netKop || 0, taxKop: tax, state: 'bad', note: fin === 'building' ? 'відомість у банку не завершено' : 'частину платежів не створено' };
    if (adv === 'none' && fin === 'none' && t.advance?.netKop > 0) return { ...base, stage: 'advance', amountKop: t.advance.netKop, taxKop: 0, state: 'todo', note: 'за першу половину місяця' };
    if (fin === 'none') return { ...base, stage: 'final', amountKop: ctx.stages?.advance ? t.final?.netKop || 0 : t.netKop || 0, taxKop: tax, state: 'todo', note: 'остаточний розрахунок — до 7-го числа наступного місяця' };
    return null;
}

/** Затверджені авансові звіти з перевитратою, за якими ще немає платежу в банку. */
export function advanceToPay(adv, payments = []) {
    const inBank = new Set(payments.filter(p => p.advanceReportId && isSigning(p)).map(p => p.advanceReportId));
    return (adv?.reports || []).filter(r => r.status === 'approved' && (r.totals?.pendingReimburseKop || 0) > 0 && !inBank.has(r.id));
}

/**
 * Єдиний список «до оплати»: [{ type: doc|regular|payroll|advance, key, title, sub, amountKop, ref, risk? }].
 * Спершу те, що має строк (зарплата), далі документи від старіших, регулярні й авансові звіти.
 */
export function toPayList({ docs = [], proposals = [], payroll = [], advance = [], docTypes = {}, contracts = [], suppliers = [] } = {}) {
    const items = [];
    for (const due of payroll.filter(Boolean)) {
        items.push({ type: 'payroll', key: `payroll:${due.period}:${due.stage}`, title: `${due.stage === 'advance' ? 'Аванс' : 'Зарплата'} за ${monthName(due.period)}`,
            sub: due.taxKop ? `людям ${kopText(due.amountKop)} · податки ${kopText(due.taxKop)}` : due.note, note: due.note,
            amountKop: due.amountKop + (due.taxKop || 0), ref: due, state: due.state });
    }
    for (const e of [...docs].sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')))) {
        const contract = e.contractId ? contracts.find(c => c.id === e.contractId) : null;
        const supplier = suppliers.find(s => s.id === e.supplierId) || null;
        items.push({ type: 'doc', key: `doc:${e.id}`, title: e.supplierName || supplier?.name || 'Постачальник', sub: e.description || '',
            doc: `${docTypes[e.docType] || 'Документ'} № ${e.number}${e.date ? ` від ${String(e.date).split('-').reverse().join('.')}` : ''}`,
            contract: contract ? (contract.number && contract.number !== 'б/н' ? `Договір № ${contract.number}` : 'Договір') : '',
            partial: e.paidKop > 0 ? e.paidKop : 0, amountKop: remaining(e), ref: e, supplier, risk: riskOf(supplier) });
    }
    for (const p of proposals) {
        items.push({ type: 'regular', key: `regular:${p.proposalKey}`, title: p.recipient?.name || '', sub: p.purpose || '',
            note: `щомісяця ${p.months} міс. поспіль · зазвичай ${p.day}-го`, amountKop: p.amountKop, ref: p });
    }
    for (const r of advance) {
        items.push({ type: 'advance', key: `advance:${r.id}`, title: r.personName || 'Підзвітна особа', sub: `Перевитрата за авансовим звітом № ${r.number || ''}`.trim(),
            amountKop: r.totals.pendingReimburseKop, ref: r });
    }
    return items;
}
const kopText = kop => `${(Math.round(kop) / 100).toFixed(2).replace('.', ',').replace(/\B(?=(\d{3})+(?!\d))/g, ' ')} грн`;

/** Ризик постачальника з картки довідника (дані YouControl, збережені при перевірці): { level, text } або null. */
export function riskOf(supplier) {
    if (!supplier) return null;
    const flags = supplierFlags(supplier).filter(f => !/ЦПД|КВЕД/.test(f.text));
    if (!flags.length) return null;
    return { level: flags.some(f => f.level === 'bad') ? 'bad' : 'warn', text: flags[0].text };
}

/** Постачальник платежу: з документа, інакше за кодом чи IBAN отримувача. */
export function supplierFor(p, ex) {
    const expense = p.expenseId ? ex?.expenses?.find(e => e.id === p.expenseId) : null;
    const suppliers = ex?.suppliers || [];
    if (expense) return suppliers.find(s => s.id === expense.supplierId) || null;
    const code = String(p.recipient?.code || ''), iban = normIban(p.recipient?.iban);
    return (code && suppliers.find(s => String(s.code || '') === code)) || (iban && suppliers.find(s => normIban(s.iban) === iban)) || null;
}

// ------------------------------------------------------------
// ПІДСУМКИ
// ------------------------------------------------------------

/**
 * Шлях грошей для смуги вгорі: погодження → до оплати → на підписі → проведено за місяць.
 * approval — що чекає голову (документи, відомість, авансові звіти) і тому ще не може бути оплачене.
 */
export function flow({ payments = [], toPay = [], approval = {}, now = new Date() } = {}) {
    const month = periodOf(now);
    const signing = payments.filter(isSigning);
    const paid = payments.filter(p => p.status === 'paid' && periodOf(new Date(ms(p.paidAt || p.createdAt))) === month);
    const sum = list => list.reduce((s, x) => s + (x.amountKop || 0), 0);
    const approvalCount = (approval.docs || []).length + (approval.payroll ? 1 : 0) + (approval.advance || 0);
    return {
        approval: { count: approvalCount, kop: sum(approval.docs || []), docs: (approval.docs || []).length, payroll: Boolean(approval.payroll), advance: approval.advance || 0 },
        todo: { count: toPay.length, kop: sum(toPay) },
        signing: { count: signing.length, kop: sum(signing) },
        paid: { count: paid.length, kop: sum(paid) - paid.reduce((s, p) => s + (p.returnedKop || 0), 0) },
        problems: payments.filter(p => problemOf(p, now.getTime())).length
    };
}

/**
 * Чи вистачить коштів: на поточному рахунку — balance; спершу спишуться ті, що на підписі,
 * далі — до оплати. { balanceKop, afterSigningKop, afterAllKop, shortKop, known }.
 */
export function funds(accounts = [], signingKop = 0, todoKop = 0) {
    const acc = accounts.find(a => a.purpose === 'current') || accounts[0];
    if (!acc || typeof acc.balanceKop !== 'number') return { known: false, balanceKop: 0, afterSigningKop: 0, afterAllKop: 0, shortKop: 0 };
    const afterSigningKop = acc.balanceKop - signingKop;
    const afterAllKop = afterSigningKop - todoKop;
    return { known: true, iban: acc.iban, balanceKop: acc.balanceKop, afterSigningKop, afterAllKop, shortKop: afterAllKop < 0 ? -afterAllKop : 0 };
}

/**
 * Головна підказка: що зробити зараз. { tone: bad|todo|wait|done, title, hint, act?, btn?, go? }.
 * Бухгалтер готує платежі, голова — підписує в Приват24 й вирішує, чи є платіж у банку.
 */
export function nextStep(f, role, firstProblem = null) {
    const chair = role === 'chair';
    if (firstProblem) {
        const n = f.problems;
        return { tone: 'bad', title: n === 1 ? `Платіж потребує уваги: ${firstProblem.recipient?.name || ''}` : `${n} платежі потребують уваги`,
            hint: PROBLEM_TEXT[problemOf(firstProblem)] || '', act: 'open-problem', btn: 'Розібратися' };
    }
    if (chair && f.signing.count) return { tone: 'todo', title: `Підпишіть ${f.signing.count} ${payWord(f.signing.count)} у Приват24 — ${kopText(f.signing.kop)}`,
        hint: 'Відкрийте Приват24 для бізнесу → «Платежі» → «На підписі» й підпишіть КЕП. Виписка сама позначить їх проведеними.', act: 'tab-signing', btn: 'Переглянути' };
    if (chair && f.approval.count) return { tone: 'todo', title: 'Погодьте документи до оплати', hint: 'Поки голова не погодив документ, відомість чи авансовий звіт, бухгалтер не може створити платіж.', go: 'inbox', btn: 'До «Рішень»' };
    if (!chair && f.todo.count) return { tone: 'todo', title: `До оплати ${f.todo.count} — ${kopText(f.todo.kop)}`,
        hint: 'Створіть платежі: вони потраплять у Приват24 й чекатимуть підпису голови.', act: 'tab-todo', btn: 'Показати' };
    if (f.signing.count) return { tone: 'wait', title: `На підписі голови ${f.signing.count} ${payWord(f.signing.count)} — ${kopText(f.signing.kop)}`,
        hint: 'Гроші не рухаються без КЕП голови. Коли банк проведе, виписка закриє платежі сама.', act: chair ? null : 'remind', btn: chair ? null : 'Нагадати голові' };
    if (f.approval.count) return { tone: 'wait', title: 'Нового до оплати немає — дещо чекає погодження голови', hint: approvalText(f.approval), go: 'inbox', btn: 'До «Рішень»' };
    if (chair && f.todo.count) return { tone: 'wait', title: `Бухгалтер готує ${f.todo.count} ${payWord(f.todo.count)}`, hint: 'Після створення вони зʼявляться у вас у Приват24 на підписі.' };
    return { tone: 'done', title: 'Усе сплачено', hint: 'Нові платежі зʼявляться з погодженими документами, відомістю зарплати й регулярними платежами.' };
}
export const payWord = n => (n % 10 === 1 && n % 100 !== 11 ? 'платіж' : [2, 3, 4].includes(n % 10) && ![12, 13, 14].includes(n % 100) ? 'платежі' : 'платежів');
export function approvalText(a) {
    return [a.docs ? `документів: ${a.docs}` : '', a.payroll ? 'відомість зарплати' : '', a.advance ? `авансових звітів: ${a.advance}` : ''].filter(Boolean).join(' · ');
}

// ------------------------------------------------------------
// ІСТОРІЯ
// ------------------------------------------------------------

/** Проведені й скасовані платежі за пошуком і видом, по місяцях: [{ period, kop, list }]. */
export function historyGroups(payments = [], { query = '', kind = 'all' } = {}) {
    const q = String(query || '').trim().toLowerCase();
    const list = payments.filter(p => ['paid', 'canceled'].includes(p.status))
        .filter(p => kind === 'all' || kindOf(p) === kind)
        .filter(p => !q || [p.recipient?.name, p.purpose, p.recipient?.code, p.recipient?.iban, p.bankRef].some(v => String(v || '').toLowerCase().includes(q)))
        .sort((a, b) => ms(b.paidAt || b.createdAt) - ms(a.paidAt || a.createdAt));
    const groups = new Map();
    for (const p of list) {
        const period = periodOf(new Date(ms(p.paidAt || p.createdAt)));
        const g = groups.get(period) || { period, kop: 0, list: [] };
        g.list.push(p);
        if (p.status === 'paid') g.kop += p.amountKop - (p.returnedKop || 0);
        groups.set(period, g);
    }
    return [...groups.values()];
}

// ------------------------------------------------------------
// ФОРМА НОВОГО ПЛАТЕЖУ: підказки до відправки
// ------------------------------------------------------------

/**
 * Попередження до створення платежу вручну: [{ level: bad|warn|info, text, act?, id? }].
 * Дубль на підписі, нещодавня така сама оплата, погоджений документ цього постачальника
 * (краще платити за документом — тоді оплата звʼяжеться з обліком), ризики з довідника,
 * зарплата й податки (їх платить відомість).
 */
export function draftWarnings(draft, { payments = [], ex = null, payrollIbans = [], now = Date.now() } = {}) {
    const out = [];
    const iban = normIban(draft?.recipient?.iban);
    const code = String(draft?.recipient?.code || '').trim();
    if (!iban && !code) return out;
    const same = p => (iban && normIban(p.recipient?.iban) === iban) || (code && String(p.recipient?.code || '') === code);
    const twin = payments.find(p => isSigning(p) && same(p) && (!draft.amountKop || p.amountKop === draft.amountKop));
    if (twin) out.push({ level: 'bad', text: `Такий платіж уже на підписі голови: ${kopText(twin.amountKop)}`, act: 'open-payment', id: twin.id });
    const recent = payments.find(p => p.status === 'paid' && same(p) && draft.amountKop && p.amountKop === draft.amountKop && now - ms(p.paidAt || p.createdAt) < 31 * 864e5);
    if (recent && !twin) out.push({ level: 'warn', text: `Цю суму цьому отримувачу вже сплачено ${new Date(ms(recent.paidAt || recent.createdAt)).toLocaleDateString('uk-UA')}`, act: 'open-payment', id: recent.id });
    const supplier = supplierFor({ recipient: { iban, code } }, ex);
    const docs = supplier ? docsToPay(ex, payments).filter(e => e.supplierId === supplier.id) : [];
    if (docs.length) out.push({ level: 'info', text: `Є погоджений документ ${docs[0].number ? `№ ${docs[0].number} ` : ''}на ${kopText(remaining(docs[0]))} — оплатіть за ним, і платіж звʼяжеться з обліком`, act: 'pay-doc', id: docs[0].id });
    const risk = riskOf(supplier);
    if (risk) out.push({ level: risk.level, text: `${supplier.name}: ${risk.text}` });
    if (payrollIbans.map(normIban).includes(iban)) out.push({ level: 'warn', text: 'Це рахунок працівника чи податку з «Зарплати» — платіть із відомості, щоб не заплатити двічі', act: 'go-payroll' });
    if (draft.kind === 'supplier' && !supplier && /^\d{8}$|^\d{10}$/.test(code)) out.push({ level: 'info', text: 'Отримувача немає в довіднику постачальників — перевірте його в YouControl перед оплатою', act: 'check-yc' });
    return out;
}
