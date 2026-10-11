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
import { deadlines, humanDate, daysLeft } from './tax-calendar.js';

const BANK_TYPES = new Set(['link', 'assign', 'split', 'choose', 'income', 'expense']);
const DOC_TYPES = new Set(['approve-con', 'approve-exp', 'pay-exp', 'missing-doc']);
const META_GROUP = { 'зарплата': 'payroll', 'звітність': 'reports', 'проводки': 'journal', 'кошторис': 'budget' };

/** Групи справ: що робити, скільки й короткий приклад. */
const GROUPS = {
    bank: { title: 'Розподілити операції банку', icon: '₴' },
    charges: { title: 'Нарахування внесків', icon: '%' },
    docs: { title: 'Документи й договори', icon: '§' },
    pay: { title: 'Створити платежі', icon: '↗' },
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
    return META_GROUP[p.meta] || 'charges';
}

function noteOf(item) {
    const p = item.proposal;
    if (BANK_TYPES.has(p.type)) return [item.tx.counterparty?.name, item.tx.purpose].filter(Boolean).join(' · ') || 'Операція з виписки';
    if (p.type === 'pay') return `${p.payment.recipient?.name || 'Платіж'} · ${fmtKop(p.payment.amountKop)} грн`;
    if (p.expense) return `${p.expense.supplierName || 'Документ'} · ${fmtKop(p.expense.amountKop)} грн`;
    if (p.contract) return `Договір: ${p.contract.subject || p.contract.number || 'на затвердження'}`;
    if (p.type === 'charge') return 'Внески за місяць готові до нарахування';
    return p.title || '';
}

function tasks(items) {
    const out = new Map();
    for (const item of items) {
        const g = groupOf(item);
        const t = out.get(g) || { key: g, ...GROUPS[g], count: 0, sumKop: 0, note: noteOf(item) };
        t.count += 1;
        if (BANK_TYPES.has(item.proposal.type)) t.sumKop += item.tx.amountKop || 0;
        out.set(g, t);
    }
    return [...out.values()];
}

const greeting = now => (now.getHours() < 12 ? 'Доброго ранку' : now.getHours() < 18 ? 'Добрий день' : 'Добрий вечір');

export function todayTitle() {
    const now = new Date();
    return { title: greeting(now), sub: now.toLocaleDateString('uk-UA', { weekday: 'long', day: 'numeric', month: 'long' }) };
}

export async function loadToday() {
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const [inbox, settings, month, outgoing, monthData] = await Promise.all([collectInbox(), loadSettings().catch(() => ({})),
        loadSince(monthStart).catch(() => []), loadPayments().catch(() => []), loadMonthData(null).catch(() => null)]);
    const { items, charges } = inbox;
    const list = tasks(items);
    const signing = outgoing.filter(p => p.status === 'sent');
    const accounts = Object.values(settings.accounts || {});
    const total = accounts.reduce((s, a) => s + (a.currency === 'UAH' || !a.currency ? (a.balanceKop || 0) : 0), 0);
    const debtors = (charges?.apartments || []).filter(a => Number(a.balance) < 0);
    const debt = debtors.reduce((s, a) => s + Math.round(Number(a.balance) * 100), 0);
    const run = charges?.runs?.find(r => r.period === charges.current);
    const paid = month.filter(t => t.kind === 'payment' && t.status === 'done').reduce((s, t) => s + t.amountKop, 0);
    const share = run?.totalKop ? Math.min(100, Math.round(paid / run.totalKop * 100)) : null;
    const soon = deadlines(new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate())), new Date(Date.UTC(now.getFullYear(), now.getMonth() + 3, 0)))[0];
    const progress = monthData ? monthProgress(monthData.steps) : null;
    const last = settings.lastSync;

    document.getElementById('viewToday').innerHTML = `
        <div class="td-grid">
            <section class="sv-card td-tasks" aria-label="Що зробити">
                <div class="sv-card-head"><h2>Що зробити</h2><span>${items.length ? `${items.length} ${items.length === 1 ? 'рішення' : 'рішень'}` : ''}</span></div>
                ${list.length ? `<ul class="td-list">${list.map(t => `<li>
                    <button type="button" class="td-task" data-go="inbox">
                        <span class="td-count${t.key === 'bank' || t.key === 'docs' ? ' is-hot' : ''}">${t.count}</span>
                        <span class="td-copy"><b>${escapeHtml(t.title)}</b><small>${escapeHtml(t.note)}</small></span>
                        <span class="td-sum">${t.sumKop ? escapeHtml(money(t.sumKop)) : ''}</span>
                        <span class="td-chev" aria-hidden="true">›</span>
                    </button></li>`).join('')}</ul>
                <button type="button" class="sv-btn is-wide" data-go="inbox">Почати з першого</button>`
                : '<div class="td-clear"><b>Усе вирішено</b><span>Нових рішень немає. Система підготує наступні, щойно прийде виписка чи документ.</span></div>'}
            </section>
            <div class="td-side">
                ${progress ? `<button type="button" class="sv-card td-month" data-go="month">
                    <span class="td-label">Закриття: ${escapeHtml(periodName(monthData.journal.period))} · <b>${progress.done} з ${progress.total}</b></span>
                    <span class="td-bars" aria-hidden="true">${monthData.steps.map(s => `<i class="is-${s.state}"></i>`).join('')}</span>
                    <span class="td-small">${progress.done === progress.total ? 'Місяць закрито ›' : `Далі: ${escapeHtml(progress.next.title.toLowerCase())} — ${escapeHtml(progress.next.short)} ›`}</span>
                </button>` : ''}
                ${soon ? `<button type="button" class="sv-card td-deadline" data-go="reports">
                    <span class="td-label">Наступний строк</span>
                    <b class="td-big">${escapeHtml(humanDate(soon.date))}</b>
                    <span class="td-small">${escapeHtml(soon.title)} · ${(d => (d === 0 ? 'сьогодні' : d === 1 ? 'завтра' : `через ${d} дн.`))(daysLeft(soon.date, now))} ›</span>
                </button>` : ''}
                <button type="button" class="sv-card td-balance" data-go="bank">
                    <span class="td-label">На рахунку</span>
                    <b class="td-big">${accounts.length ? escapeHtml(money(total)) : '—'}</b>
                    <span class="td-small${last?.ok === false ? ' is-bad' : ' is-good'}">${!accounts.length ? 'Банк не підключено' : last?.ok === false ? 'Помилка оновлення виписки' : last ? `Виписка о ${escapeHtml(when(last.at))}` : 'Виписку ще не отримано'}</span>
                </button>
            </div>
        </div>
        ${signing.length ? `<button type="button" class="sv-card td-signing" data-go="payments">
            <span><b>${signing.length} ${signing.length === 1 ? 'платіж чекає' : 'платежі чекають'} підпису голови</b><small>Підписує голова КЕП у Приват24</small></span>
            <b class="td-sum">${escapeHtml(money(signing.reduce((s, p) => s + p.amountKop, 0)))} ›</b>
        </button>` : ''}
        <div class="td-row">
            <button type="button" class="sv-card" data-go="charges"><span class="td-label">Нараховано за місяць</span><b class="td-mid">${run ? escapeHtml(money(run.totalKop)) : '—'}</b>
                <span class="td-small">${run ? `${run.count} квартир` : 'ще не нараховано'}</span></button>
            <button type="button" class="sv-card" data-go="charges"><span class="td-label">Мешканці сплатили</span><b class="td-mid">${share === null ? escapeHtml(money(paid)) : `${share}%`}</b>
                ${share === null ? '<span class="td-small">цього місяця</span>' : `<span class="sv-meter" aria-hidden="true"><i style="width:${share}%"></i></span><span class="td-small">${escapeHtml(money(paid))}</span>`}</button>
            <button type="button" class="sv-card" data-go="charges"><span class="td-label">Борг мешканців</span><b class="td-mid">${charges ? escapeHtml(money(Math.abs(debt))) : '—'}</b>
                <span class="td-small${debtors.length ? ' is-bad' : ''}">${charges ? `${debtors.length} квартир ›` : ''}</span></button>
        </div>
        <p class="buh-note">Система пропонує — рішення за вами. Платежі підписує голова КЕП у Приват24.</p>`;
    return items.length;
}
