// ============================================================
// «Огляд»: гроші ОСББ і що потребує уваги — на одному екрані.
// ============================================================
import { escapeHtml } from './ui.js';
import { loadSettings, loadQueue, loadSince, loadPayments, loadCharges, money, signed, when, tagOf, maskIban, ACCOUNT_PURPOSES } from './buh-data.js';
import { chargeItems } from './buh-inbox.js';
import { periodName } from './charges-core.js';
import { deadlines, humanDate, daysLeft } from './tax-calendar.js';

const MONTHS = ['січні', 'лютому', 'березні', 'квітні', 'травні', 'червні', 'липні', 'серпні', 'вересні', 'жовтні', 'листопаді', 'грудні'];

export async function loadOverview() {
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const [settings, queue, month, outgoing, charges] = await Promise.all([loadSettings(), loadQueue(), loadSince(monthStart),
        loadPayments().catch(() => []), loadCharges().catch(() => null)]);
    const waiting = queue.length + chargeItems(charges).length;
    const debtors = (charges?.apartments || []).filter(a => Number(a.balance) < 0);
    const debt = debtors.reduce((s, a) => s + Math.round(Number(a.balance) * 100), 0);
    const chargedRun = charges?.runs?.find(r => r.period === charges.current);
    const signing = outgoing.filter(p => p.status === 'sent');
    const accounts = Object.entries(settings.accounts || {});
    const total = accounts.reduce((s, [, a]) => s + (a.currency === 'UAH' || !a.currency ? (a.balanceKop || 0) : 0), 0);
    const income = month.filter(t => t.direction === 'in' && t.kind !== 'internal').reduce((s, t) => s + t.amountKop, 0);
    const payments = month.filter(t => t.kind === 'payment' && t.status === 'done').reduce((s, t) => s + t.amountKop, 0);
    const spent = month.filter(t => t.direction === 'out' && t.kind !== 'internal').reduce((s, t) => s + t.amountKop, 0);
    const soon = deadlines(new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate())), new Date(Date.UTC(now.getFullYear(), now.getMonth() + 3, 0)));

    document.getElementById('viewOverview').innerHTML = `
        <div class="kpi-grid is-five">
            <div class="kpi"><span>На рахунках</span><b>${accounts.length ? money(total) : '—'}</b>
                <small>${accounts.length ? accounts.map(([iban, a]) => `${escapeHtml(ACCOUNT_PURPOSES[a.purpose] || 'Рахунок')} ${escapeHtml(maskIban(iban).slice(-4))}`).join(' · ') : 'Банк не підключено'}</small></div>
            <div class="kpi"><span>Надійшло в ${MONTHS[now.getMonth()]}</span><b class="is-in">${money(income)}</b><small>з них внески мешканців ${money(payments)}</small></div>
            <div class="kpi"><span>Списано в ${MONTHS[now.getMonth()]}</span><b>${money(spent)}</b><small>${month.filter(t => t.direction === 'out').length} операцій</small></div>
            <button type="button" class="kpi kpi-action" data-go="charges"><span>Борг мешканців</span><b${debt ? ' class="is-out"' : ''}>${charges ? money(debt) : '—'}</b>
                <small>${charges ? `${debtors.length} кв. · ${chargedRun ? 'місяць нараховано' : `${periodName(charges.current).split(' ')[0]} не нараховано`}` : 'Нарахування недоступні'}</small></button>
            <button type="button" class="kpi kpi-action${waiting ? ' is-alert' : ''}" data-go="inbox"><span>Чекають рішення</span><b>${waiting}</b><small>${waiting ? 'Відкрити «Вхідні» →' : 'Усе розібрано'}</small></button>
        </div>
        ${signing.length ? `<button type="button" class="buh-card sign-strip" data-go="payments">
            <b>${signing.length} ${signing.length === 1 ? 'платіж чекає' : 'платежі чекають'} підпису голови в Приват24</b>
            <span>${money(signing.reduce((s, p) => s + p.amountKop, 0))} · відкрити «Платежі» →</span>
        </button>` : ''}

        <div class="ov-grid">
            <section class="buh-card">
                <div class="buh-card-head"><h2>Строки</h2><span>на 3 місяці</span></div>
                ${soon.length ? `<ul class="deadline-list">${soon.slice(0, 6).map(d => {
                    const left = daysLeft(d.date, now);
                    return `<li class="deadline${left <= 3 ? ' is-near' : ''}">
                        <span class="deadline-date"><b>${d.date.getUTCDate()}</b>${escapeHtml(humanDate(d.date).split(' ')[1])}</span>
                        <span class="deadline-text"><b>${escapeHtml(d.title)}</b><small>${escapeHtml(d.detail)}</small></span>
                        <span class="deadline-left">${left === 0 ? 'сьогодні' : left === 1 ? 'завтра' : `${left} дн.`}</span>
                    </li>`;
                }).join('')}</ul>` : '<p class="list-empty">Найближчим часом строків немає</p>'}
                <p class="buh-note">Строки за правилами ПКУ; підстави — у docs/accounting/LEGAL.md. Перевіряє бухгалтер.</p>
            </section>
            <section class="buh-card">
                <div class="buh-card-head"><h2>Останні операції</h2><button type="button" class="btn-ghost-small" data-go="bank">Усі →</button></div>
                ${month.length ? `<table class="buh-table is-compact ov-ops"><tbody>${month.slice(0, 8).map(t => {
                    const tag = tagOf(t);
                    return `<tr><td class="t-date">${escapeHtml(when(t.at))}</td>
                        <td class="t-main"><b>${escapeHtml(t.counterparty?.name || '—')}</b><small>${escapeHtml(t.purpose || '')}</small></td>
                        <td class="t-tag"><span class="buh-tag ${tag.cls}">${escapeHtml(tag.text)}</span></td>
                        <td class="t-sum ${t.direction === 'out' ? 'is-out' : 'is-in'}">${signed(t)}</td></tr>`;
                }).join('')}</tbody></table>` : '<p class="list-empty">Цього місяця операцій ще немає</p>'}
            </section>
        </div>`;
    return waiting;
}
