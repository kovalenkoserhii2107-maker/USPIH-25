// ============================================================
// «Сьогодні»: з чого почати. Справи — з тієї самої черги, що й
// «Рішення» (collectInbox), згруповані за видом; поруч — закриття
// місяця, найближчий строк, гроші на рахунку й борги мешканців.
// ============================================================
import { escapeHtml } from './ui.js';
import { loadSettings, loadSince, loadPayments, money, when } from './buh-data.js';
import { collectInbox } from './buh-inbox.js';
import { loadMonthData } from './buh-month.js';
import { monthProgress } from './month-core.js';
import { fmtKop, periodName } from './charges-core.js';
import { humanDate, daysLeft } from './tax-calendar.js';
import { reportTasks, nextDeadline, periodOfKey } from './reports-view-core.js';
import { payrollTotals } from './payroll-view-core.js';

const BANK_TYPES = new Set(['link', 'assign', 'split', 'choose', 'income', 'expense', 'bank-conflict', 'payment-link']);
const DOC_TYPES = new Set(['approve-con', 'approve-exp', 'pay-exp', 'missing-doc']);
const META_GROUP = {
    'помилки платежів': 'failed_pay',
    'зарплата': 'payroll',
    'звітність': 'reports',
    'проводки': 'journal',
    'кошторис': 'budget',
    'авансові звіти': 'advance',
    'компенсація підзвіт': 'advance',
    'майно та тмц': 'assets',
    'амортизація оз/мнма': 'assets'
};

/** Групи справ: що робити, скільки й короткий приклад. */
const GROUPS = {
    failed_pay: { title: 'Виправити відхилені платежі', icon: '!', go: 'payments' },
    bank: { title: 'Розподілити операції банку', icon: '₴' },
    charges: { title: 'Нарахування внесків', icon: '%' },
    docs: { title: 'Документи й договори', icon: '§' },
    pay: { title: 'Створити платежі', icon: '↗' },
    advance: { title: 'Авансові звіти', icon: '₴' },
    assets: { title: 'Майно та ТМЦ', icon: '□' },
    payroll: { title: 'Зарплата', icon: '₴' },
    reports: { title: 'Звіти до податкової', icon: '✓' },
    journal: { title: 'Проводки й закриття', icon: '=' },
    budget: { title: 'Кошторис', icon: '≡' }
};

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
        const firstSentence = String(p.text || '').split('. ')[0];
        return firstSentence ? `Банк не прийняв: ${firstSentence}` : (p.title || 'Банк не прийняв платіж');
    }
    if (BANK_TYPES.has(p.type)) return [item.tx.counterparty?.name, item.tx.purpose].filter(Boolean).join(' · ') || 'Операція з виписки';
    if (p.type === 'pay') return `${p.payment.recipient?.name || 'Платіж'} · ${fmtKop(p.payment.amountKop)} грн`;
    if (p.expense) return `${p.expense.supplierName || 'Документ'} · ${fmtKop(p.expense.amountKop)} грн`;
    if (p.contract) return `Договір: ${p.contract.subject || p.contract.number || 'на затвердження'}`;
    if (p.type === 'charge') return 'Внески за місяць готові до нарахування';
    return p.title || '';
}

export function tasks(items) {
    const out = new Map();
    for (const item of items) {
        const g = groupOf(item);
        const t = out.get(g) || { key: g, ...GROUPS[g], count: 0, sumKop: 0, note: noteOf(item) };
        if (g === 'failed_pay') {
            t.count += item.proposal.failedPaymentsCount || 1;
            t.sumKop += item.proposal.failedPaymentsSumKop || 0;
        } else {
            t.count += 1;
            if (BANK_TYPES.has(item.proposal.type)) t.sumKop += item.tx.amountKop || 0;
        }
        out.set(g, t);
    }
    return [...out.values()];
}

const greeting = now => (now.getHours() < 12 ? 'Доброго ранку' : now.getHours() < 18 ? 'Добрий день' : 'Добрий вечір');

export function todayTitle() {
    const now = new Date();
    return { title: greeting(now), sub: now.toLocaleDateString('uk-UA', { weekday: 'long', day: 'numeric', month: 'long' }) };
}

const ACCOUNT_PURPOSE_LABELS = {
    current: 'Поточний рахунок',
    reserve: 'Резервний фонд',
    repair: 'Ремонтний фонд',
    special: 'Спецрахунок',
    deposit: 'Депозит',
    grant: 'Грантовий рахунок'
};
/** 1, 2, 21 рішення; 5, 11, 12 рішень. */
const decisionsWord = n => ([1, 2, 3, 4].includes(n % 10) && ![11, 12, 13, 14].includes(n % 100) ? 'рішення' : 'рішень');

/**
 * Розрахунок очікуваних платежів за поточний місяць, які ще не проведено
 * і ще не передано на підпис у Приват24:
 *   1) Договори (щомісячні та разові за цей місяць, за якими ще не виставлено рахунок/акт)
 *      + неоплачені документи витрат + перевитрата за авансовими звітами;
 *   2) Зарплата та виплати за ЦПД «на руки» (за мінусом уже виплачених і тих, що на підписі);
 *   3) Податки із зарплати та ЦПД — ЄСВ, ПДФО, військовий збір (за мінусом сплачених і тих, що на підписі).
 */
export function computeUpcomingPayments({ expenses, payroll, journal, payments = [], period }) {
    const activePeriod = period || payroll?.period || journal?.period || new Date().toISOString().slice(0, 7);
    const monthStartIso = `${activePeriod}-01`;
    const monthEndIso = `${activePeriod}-31`;

    const activeExpensePayIds = new Set(
        (payments || [])
            .filter(p => ['sending', 'unknown', 'sent'].includes(p.status) && p.expenseId)
            .map(p => p.expenseId)
    );

    const exList = expenses?.expenses || [];
    const conList = expenses?.contracts || [];

    // 1a. Неоплачені документи постачальників (затверджені або на розгляді), які ще не на підписі в Приват24
    const unpaidDocs = exList.filter(e =>
        ['approved', 'pending'].includes(e.status) &&
        !e.linkedTo &&
        !activeExpensePayIds.has(e.id) &&
        (!e.period || e.period <= activePeriod) &&
        ((e.amountKop || 0) - (e.stornoKop || 0) - (e.paidKop || 0)) > 0
    );
    const unpaidDocsKop = unpaidDocs.reduce(
        (s, e) => s + Math.max(0, (e.amountKop || 0) - (e.stornoKop || 0) - (e.paidKop || 0)),
        0
    );

    // 1b. Чинні затверджені договори цього місяця, за якими ще не внесено документ витрат
    let expectedContractsKop = 0;
    let expectedContractsCount = 0;
    for (const c of conList) {
        if (c.status !== 'approved') continue;
        const isActive = (!c.validFrom || c.validFrom <= monthEndIso) && (!c.validTo || c.validTo >= monthStartIso);
        if (!isActive) continue;

        if (c.type === 'monthly' && (c.monthlyKop || 0) > 0) {
            const documentedKop = exList
                .filter(e => e.contractId === c.id && e.period === activePeriod && !['rejected', 'canceled', 'linked'].includes(e.status))
                .reduce((s, e) => s + Math.max(0, (e.amountKop || 0) - (e.stornoKop || 0)), 0);
            const left = Math.max(0, (c.monthlyKop || 0) - documentedKop);
            if (left > 0) {
                expectedContractsKop += left;
                expectedContractsCount += 1;
            }
        } else if (c.type === 'fixed' && (c.amountKop || 0) > 0 && (c.validFrom?.startsWith(activePeriod) || c.date?.startsWith(activePeriod))) {
            const documentedKop = exList
                .filter(e => e.contractId === c.id && !['rejected', 'canceled', 'linked'].includes(e.status))
                .reduce((s, e) => s + Math.max(0, (e.amountKop || 0) - (e.stornoKop || 0)), 0);
            const left = Math.max(0, (c.amountKop || 0) - documentedKop);
            if (left > 0) {
                expectedContractsKop += left;
                expectedContractsCount += 1;
            }
        }
    }

    // 1c. Авансові звіти до відшкодування (які ще не відправлено в Приват24)
    let unpaidAdvanceKop = journal?.advanceSummary?.toReimburseKop || 0;
    if (journal?.advanceSummary?.inBankCount === undefined && unpaidAdvanceKop > 0) {
        const activeAdvPaysKop = (payments || [])
            .filter(p => ['sending', 'unknown', 'sent'].includes(p.status) && (p.advanceReportId || p.kind === 'advance' || (typeof p.proposalKey === 'string' && p.proposalKey.startsWith('adv-'))))
            .reduce((s, p) => s + (p.amountKop || 0), 0);
        unpaidAdvanceKop = Math.max(0, unpaidAdvanceKop - activeAdvPaysKop);
    }

    const contractsAndDocsKop = expectedContractsKop + unpaidDocsKop + unpaidAdvanceKop;

    // 2 & 3. Зарплата «на руки» та податки (ЄСВ, ПДФО, ВЗ), які ще не сплачено й не на підписі
    const pt = payroll?.run ? payrollTotals(payroll) : { netKop: 0, netPaidKop: 0, netSigningKop: 0, taxKop: 0, taxPaidKop: 0, taxSigningKop: 0 };
    const salaryLeftKop = Math.max(0, (pt.netKop || 0) - (pt.netPaidKop || 0) - (pt.netSigningKop || 0));
    const taxesLeftKop = Math.max(0, (pt.taxKop || 0) - (pt.taxPaidKop || 0) - (pt.taxSigningKop || 0));

    const totalKop = contractsAndDocsKop + salaryLeftKop + taxesLeftKop;
    const goTarget = contractsAndDocsKop > 0 ? 'expenses' : (salaryLeftKop > 0 || taxesLeftKop > 0) ? 'payroll' : 'payments';

    return {
        period: activePeriod,
        totalKop,
        contractsAndDocsKop,
        expectedContractsKop,
        expectedContractsCount,
        unpaidDocsKop,
        unpaidDocsCount: unpaidDocs.length,
        unpaidAdvanceKop,
        salaryLeftKop,
        taxesLeftKop,
        goTarget
    };
}

/**
 * Формує зрозумілий опис найближчого податкового / звітного строку
 * без зайвого тексту: обʼєднує події на одну дату (напр. ЄСВ + звіт J0500111 до 20 числа).
 */
export function describeDeadline(soon, allTasks = []) {
    if (!soon) return null;
    const openOnSameDate = (allTasks || []).filter(t => !t.done && !t.waiting && t.iso === soon.iso);
    const hasEsv = openOnSameDate.some(t => t.key.startsWith('esv-'));
    const hasJ05 = openOnSameDate.some(t => t.key.startsWith('j0500111-'));
    const repPeriod = periodOfKey(soon.key);
    const monthLabel = repPeriod ? periodName(repPeriod) : '';

    const categoryLabel = soon.left < 0
        ? 'Прострочено · Податковий календар'
        : soon.kind === 'decision'
            ? 'Календар ОСББ · Загальні збори'
            : 'Податковий календар · ДПС';

    const leftText = (d => (d < 0 ? `прострочено ${-d} дн.` : d === 0 ? 'сьогодні' : d === 1 ? 'завтра' : `через ${d} дн.`))(soon.left);
    const dateHeadline = `до ${humanDate(soon.date)}`;

    let whatText = '';
    if (hasEsv && hasJ05 && monthLabel) {
        whatText = `Сплатити ЄСВ (22%) та подати Податковий розрахунок за ${monthLabel} ›`;
    } else if (openOnSameDate.length > 1) {
        whatText = `${openOnSameDate.map(t => t.title).join(' · ')} ›`;
    } else {
        whatText = `${soon.title}${soon.detail ? ` (${soon.detail})` : ''} ›`;
    }

    return {
        categoryLabel,
        leftText,
        dateHeadline,
        whatText,
        isOverdue: soon.left < 0
    };
}

export async function loadToday() {
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const [inbox, settings, month, outgoing, monthData] = await Promise.all([collectInbox(), loadSettings().catch(() => ({})),
        loadSince(monthStart).catch(() => []), loadPayments().catch(() => []), loadMonthData(null).catch(() => null)]);
    const { items, charges, expenses, payroll, journal } = inbox;
    const list = tasks(items);
    const signing = outgoing.filter(p => p.status === 'sent');
    const failedCount = outgoing.filter(p => p.status === 'failed').length;
    const accounts = Object.entries(settings.accounts || {}).map(([iban, a]) => ({ iban, ...a }));
    const uahAccounts = accounts.filter(a => a.currency === 'UAH' || !a.currency);
    const total = uahAccounts.reduce((s, a) => s + (a.balanceKop || 0), 0);
    const allApartments = charges?.apartments || [];
    const debtors = allApartments.filter(a => Number(a.balance) < 0);
    const debt = debtors.reduce((s, a) => s + Math.round(Number(a.balance) * 100), 0);
    const currentChargePeriod = charges?.current || now.toISOString().slice(0, 7);
    const run = charges?.runs?.find(r => r.period === currentChargePeriod);

    // Оплати мешканців за поточний місяць: сума та кількість унікальних квартир, що сплатили
    const paidTxs = month.filter(t => t.kind === 'payment' && t.status === 'done');
    const paid = paidTxs.reduce((s, t) => s + (t.amountKop || 0), 0);
    const paidAptsSet = new Set(
        paidTxs.flatMap(t => (t.allocations || []).map(a => String(a?.apt || '').trim())).filter(Boolean)
    );
    const paidAptsCount = paidAptsSet.size || (paid > 0 ? paidTxs.length : 0);
    const totalAptsCount = run?.count || allApartments.length || 0;
    const share = run?.totalKop ? Math.min(100, Math.round(paid / run.totalKop * 100)) : null;

    // Очікувані виплати цього місяця (договори, документи, зарплата, податки)
    const upcoming = computeUpcomingPayments({
        expenses,
        payroll,
        journal,
        payments: outgoing,
        period: currentChargePeriod
    });

    // Наступний строк — лише те, що ще треба зробити: сплачений ЄСВ чи поданий звіт не нагадуємо.
    const allReportTasks = reportTasks(inbox.reports);
    const soon = nextDeadline(allReportTasks);
    const deadlineInfo = describeDeadline(soon, allReportTasks);
    const progress = monthData ? monthProgress(monthData.steps) : null;
    const last = settings.lastSync;

    const totalTaskCount = list.reduce((s, t) => s + t.count, 0);
    const tasksCountLabel = totalTaskCount
        ? `${totalTaskCount} ${decisionsWord(totalTaskCount)}`
        : '';

    const primaryGo = list.length === 1 && list[0].go ? list[0].go : 'inbox';
    const primaryGroupAttr = primaryGo === 'inbox' ? ' data-inbox-group="all"' : '';

    document.getElementById('viewToday').innerHTML = `
        <div class="td-grid">
            <div class="td-main">
                <section class="sv-card td-tasks" aria-label="Що зробити">
                    <div class="sv-card-head"><h2>Що зробити</h2><span>${tasksCountLabel}</span></div>
                    ${list.length ? `<ul class="td-list">${list.map(t => {
                        const goTarget = t.go || 'inbox';
                        const groupAttr = t.go ? '' : ` data-inbox-group="${escapeHtml(t.key)}"`;
                        const badgeCls = t.key === 'failed_pay' ? ' is-bad' : (t.key === 'bank' || t.key === 'docs' ? ' is-hot' : '');
                        return `<li>
                        <button type="button" class="td-task" data-go="${escapeHtml(goTarget)}"${groupAttr}>
                            <span class="td-count${badgeCls}">${t.count}</span>
                            <span class="td-copy"><b>${escapeHtml(t.title)}</b><small>${escapeHtml(t.note)}</small></span>
                            <span class="td-sum">${t.sumKop ? escapeHtml(money(t.sumKop)) : ''}</span>
                            <span class="td-chev" aria-hidden="true">›</span>
                        </button></li>`;
                    }).join('')}</ul>
                    <button type="button" class="sv-btn is-wide" data-go="${escapeHtml(primaryGo)}"${primaryGroupAttr}>Почати з першого</button>`
                    : `<div class="td-clear">
                        <b>Усе вирішено</b>
                        <span>Нових рішень немає. Система підготує наступні, щойно прийде виписка чи документ.</span>
                        <div class="td-quick">
                            <button type="button" class="td-quick-btn" data-go="expenses">+ Документ</button>
                            <button type="button" class="td-quick-btn" data-go="payments">Платежі</button>
                            <button type="button" class="td-quick-btn" data-go="advance">Авансові звіти</button>
                            <button type="button" class="td-quick-btn" data-go="flats">Квартири</button>
                        </div>
                    </div>`}
                </section>
                ${progress ? `<button type="button" class="sv-card td-month" data-go="month">
                    <div class="td-month-head">
                        <span class="td-label">Закриття: ${escapeHtml(periodName(monthData.journal.period))} · <b>${progress.done} з ${progress.total}</b></span>
                        <span class="td-month-chip ${progress.done === progress.total ? 'is-done' : 'is-work'}">${progress.done === progress.total ? 'Закрито' : 'У роботі'}</span>
                    </div>
                    <span class="td-bars" aria-hidden="true">${monthData.steps.map(s => `<i class="is-${s.state}"></i>`).join('')}</span>
                    <div class="td-steps-pills" aria-hidden="true">
                        ${monthData.steps.map(s => `<span class="td-step-pill is-${s.state}"><i>${s.state === 'done' ? '✓' : s.state === 'work' ? '•' : '○'}</i>${escapeHtml(s.title)}</span>`).join('')}
                    </div>
                    <span class="td-small">${progress.done === progress.total ? 'Місяць закрито ›' : `Далі: ${escapeHtml(progress.next.title.toLowerCase())} — ${escapeHtml(progress.next.short)} ›`}</span>
                </button>` : ''}
                <div class="td-row">
                    <button type="button" class="sv-card" data-go="charges">
                        <span class="td-label">Нараховано за місяць</span>
                        <b class="td-mid">${run ? escapeHtml(money(run.totalKop)) : '—'}</b>
                        <span class="td-small">${run ? `${run.count} квартир · ${escapeHtml(periodName(run.period))}` : 'ще не нараховано'}</span>
                    </button>
                    <button type="button" class="sv-card" data-go="flats">
                        <span class="td-label">Мешканці сплатили</span>
                        <b class="td-mid">${share === null ? escapeHtml(money(paid)) : `${share}%`}</b>
                        ${share === null ? '' : `<span class="sv-meter" aria-hidden="true"><i style="width:${share}%"></i></span>`}
                        <span class="td-small">${escapeHtml(money(paid))}${totalAptsCount ? ` · ${paidAptsCount} з ${totalAptsCount} кв.` : paidAptsCount ? ` · ${paidAptsCount} кв.` : ''} ›</span>
                    </button>
                    <button type="button" class="sv-card" data-go="flats">
                        <span class="td-label">Борг мешканців</span>
                        <b class="td-mid">${charges ? escapeHtml(money(Math.abs(debt))) : '—'}</b>
                        <span class="td-small${debtors.length ? ' is-bad' : ''}">${charges ? `${debtors.length}${totalAptsCount ? ` з ${totalAptsCount}` : ''} квартир ›` : ''}</span>
                    </button>
                </div>
            </div>
            <div class="td-side">
                <button type="button" class="sv-card td-balance" data-go="bank">
                    <span class="td-label">На рахунку</span>
                    <b class="td-big">${accounts.length ? escapeHtml(money(total)) : '—'}</b>
                    ${uahAccounts.length > 1 ? `<div class="td-acc-list">${uahAccounts.slice(0, 3).map(a => `<span class="td-acc-row"><span>${escapeHtml(ACCOUNT_PURPOSE_LABELS[a.purpose] || a.name || `…${String(a.iban || '').slice(-4)}`)}</span><b>${escapeHtml(money(a.balanceKop || 0))}</b></span>`).join('')}${uahAccounts.length > 3 ? `<span class="td-acc-row is-muted"><span>Ще ${uahAccounts.length - 3} — у «Банку»</span></span>` : ''}</div>` : ''}
                    <span class="td-small${last?.ok === false ? ' is-bad' : last ? ' is-good' : ' is-muted'}">${!accounts.length ? 'Банк не підключено' : last?.ok === false ? 'Помилка оновлення виписки' : last ? `Виписка о ${escapeHtml(when(last.at))}` : 'Виписку ще не отримано'}</span>
                </button>
                ${signing.length ? `<button type="button" class="sv-card td-signing" data-go="payments">
                    <span class="td-label">На підписі голови · КЕП у Приват24</span>
                    <b class="td-big">${escapeHtml(money(signing.reduce((s, p) => s + p.amountKop, 0)))}</b>
                    <span class="td-small">${signing.length} ${signing.length === 1 ? 'платіж чекає' : signing.length < 5 ? 'платежі чекають' : 'платежів чекають'}${failedCount ? ` · ${failedCount} відхилено банком` : ''} ›</span>
                </button>` : ''}
                <button type="button" class="sv-card td-upcoming" data-go="${escapeHtml(upcoming.goTarget)}">
                    <span class="td-label">Очікувані виплати · ${escapeHtml(periodName(upcoming.period))}</span>
                    <b class="td-big">${escapeHtml(money(upcoming.totalKop))}</b>
                    <div class="td-acc-list">
                        <span class="td-acc-row"><span>Договори та рахунки</span><b>${escapeHtml(money(upcoming.contractsAndDocsKop))}</b></span>
                        ${upcoming.salaryLeftKop > 0 ? `<span class="td-acc-row"><span>Зарплата та ЦПД</span><b>${escapeHtml(money(upcoming.salaryLeftKop))}</b></span>` : ''}
                        <span class="td-acc-row"><span>Податки (ЄСВ, ПДФО, ВЗ)</span><b>${escapeHtml(money(upcoming.taxesLeftKop))}</b></span>
                    </div>
                    <span class="td-small is-muted">${upcoming.totalKop > 0 ? 'Ще до відправки в банк цього місяця ›' : 'Усі планові виплати місяця вже сформовано ›'}</span>
                </button>
                ${deadlineInfo ? `<button type="button" class="sv-card td-deadline" data-go="reports">
                    <div class="td-deadline-head">
                        <span class="td-label">${escapeHtml(deadlineInfo.categoryLabel)}</span>
                        <span class="td-deadline-badge${deadlineInfo.isOverdue ? ' is-bad' : ''}">${escapeHtml(deadlineInfo.leftText)}</span>
                    </div>
                    <b class="td-big">${escapeHtml(deadlineInfo.dateHeadline)}</b>
                    <span class="td-small">${escapeHtml(deadlineInfo.whatText)}</span>
                </button>` : ''}
            </div>
        </div>
        <p class="buh-note">Система пропонує — рішення за вами. Платежі підписує голова КЕП у Приват24.</p>`;
    return items.length;
}
