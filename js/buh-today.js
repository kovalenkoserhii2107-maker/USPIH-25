// ============================================================
// «Сьогодні»: перший екран кабінету.
//
// Угорі — одна головна дія за роллю (бухгалтер чи голова) і пульс:
// рішення, підпис, до оплати, найближчий строк. Поруч — гроші на
// рахунках і що з ними станеться після підписаних платежів. Нижче —
// справи з черги «Рішень», строки, рух коштів по днях місяця, збір
// внесків і боржники, шлях платежів, закриття місяця, кошторис і
// останні операції банку. Кожен блок веде у свій розділ.
//
// Рух: при вході картки зʼявляються по черзі, числа «докручуються»,
// стовпчики й кільця заповнюються. Лише при переході в розділ (не при
// фоновому оновленні) і не за «зменшити рух» у системі.
// Розрахунки — today-core.js.
// ============================================================
import { session } from './firebase.js';
import { escapeHtml } from './ui.js';
import { loadSettings, loadSince, loadPayments, money, when, dateOnly, signed, ACCOUNT_PURPOSES } from './buh-data.js';
import { collectInbox } from './buh-inbox.js';
import { loadMonthData } from './buh-month.js';
import { monthProgress, monthPhases } from './month-core.js';
import { fmtKop, periodName } from './charges-core.js';
import { humanDate } from './tax-calendar.js';
import { reportTasks, nextDeadline } from './reports-view-core.js';
import { BANK_CATEGORY_OPTIONS } from './bank-view-core.js';
import { paymentsOverview } from './buh-payments.js';
import { openTxSheet } from './buh-chain.js';
import { openFlat } from './buh-flats.js';
import { tasks, focusOf, cashByDay, collection, upcoming, leftText, computeUpcomingPayments, budgetPace, recentOps, plural } from './today-core.js';

const greeting = now => (now.getHours() < 5 ? 'Доброї ночі' : now.getHours() < 12 ? 'Доброго ранку' : now.getHours() < 18 ? 'Добрий день' : 'Добрий вечір');

export function todayTitle() {
    const now = new Date();
    return { title: greeting(now), sub: now.toLocaleDateString('uk-UA', { weekday: 'long', day: 'numeric', month: 'long' }) };
}

const reduceMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
const MONTHS_SHORT = ['січ', 'лют', 'бер', 'квіт', 'трав', 'черв', 'лип', 'серп', 'вер', 'жовт', 'лист', 'груд'];
const MONTHS_LOC = ['січні', 'лютому', 'березні', 'квітні', 'травні', 'червні', 'липні', 'серпні', 'вересні', 'жовтні', 'листопаді', 'грудні'];

const ICONS = {
    alert: '<path d="M12 3 2 20h20z"/><path d="M12 10v4M12 17h.01"/>',
    bank: '<path d="M3 10h18L12 4z"/><path d="M5 10v8M10 10v8M14 10v8M19 10v8M3 21h18"/>',
    doc: '<path d="M7 3h7l5 5v13H7z"/><path d="M14 3v5h5M10 13h6M10 17h6"/>',
    send: '<path d="M4 12 20 4l-6 16-3-7z"/><path d="m11 13 9-9"/>',
    charges: '<path d="M12 3v18M17 7H9.5a3 3 0 0 0 0 6h5a3 3 0 0 1 0 6H6"/>',
    people: '<circle cx="12" cy="8" r="4"/><path d="M4 21c1-4 4-6 8-6s7 2 8 6"/>',
    receipt: '<path d="M6 3h12v18l-3-2-3 2-3-2-3 2z"/><path d="M9 8h6M9 12h6"/>',
    report: '<path d="M5 3h14v18H5z"/><path d="M9 8h6M9 12h6M9 16h3"/>',
    journal: '<path d="M4 5h16M4 12h16M4 19h10"/>',
    budget: '<path d="M4 20V10M10 20V4M16 20v-8M22 20H2"/>',
    box: '<path d="M3 7l9-4 9 4-9 4-9-4z"/><path d="M3 7v10l9 4 9-4V7"/><path d="M12 11v10"/>',
    in: '<path d="M17 7 7 17"/><path d="M15 17H7V9"/>',
    out: '<path d="M7 17 17 7"/><path d="M9 7h8v8"/>'
};
const icon = (k, cls = '') => `<span class="tz-ico ${cls}" aria-hidden="true"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONS[k] || ICONS.doc}</svg></span>`;

/** Число, що «докручується» при вході: data-count — значення, data-fmt — money | pct | int. */
const num = (value, fmt = 'money') => `<span class="tz-num" data-count="${Math.round(value)}" data-fmt="${fmt}">${fmtValue(value, fmt)}</span>`;
function fmtValue(v, fmt) {
    if (fmt === 'pct') return `${Math.round(v)}%`;
    if (fmt === 'int') return String(Math.round(v));
    return money(Math.round(v));
}

/** Кільце прогресу (0…1) — стрічка «намальовується» при вході. */
function ring(share, label, sub = '', cls = '') {
    const r = 42, len = +(2 * Math.PI * r).toFixed(1), off = +(len * (1 - Math.max(0, Math.min(1, share)))).toFixed(1);
    return `<div class="tz-ring ${cls}" style="--len:${len};--off:${off}">
        <svg viewBox="0 0 100 100" aria-hidden="true"><circle class="tz-ring-track" cx="50" cy="50" r="${r}"/><circle class="tz-ring-bar" cx="50" cy="50" r="${r}" stroke-dasharray="${len}" stroke-dashoffset="${off}"/></svg>
        <span class="tz-ring-label"><b>${label}</b>${sub ? `<small>${sub}</small>` : ''}</span></div>`;
}

const goAttr = (go, group) => `data-go="${escapeHtml(go)}"${group ? ` data-inbox-group="${escapeHtml(group)}"` : ''}`;

// ------------------------------------------------------------
// БЛОКИ
// ------------------------------------------------------------
function heroHtml(focus, s) {
    const stat = (label, value, sub, attrs, cls = '') => `<button type="button" class="tz-stat ${cls}" ${attrs}><span>${label}</span><b>${value}</b><small>${sub}</small></button>`;
    const dl = s.deadline;
    return `<section class="tz-card tz-hero is-${focus.tone}" style="--i:0" aria-label="Головне зараз">
        <div class="tz-hero-main">
            <span class="tz-eyebrow"><i class="tz-dot"></i>${escapeHtml(focus.eyebrow)}</span>
            <h2>${escapeHtml(focus.title)}</h2>
            ${focus.hint ? `<p>${escapeHtml(focus.hint)}</p>` : ''}
            <div class="tz-hero-actions">
                <button type="button" class="sv-btn is-white" ${goAttr(focus.go, focus.group)}>${escapeHtml(focus.btn)} <span aria-hidden="true">→</span></button>
                ${s.decisions && focus.go !== 'inbox' ? `<button type="button" class="tz-link" data-go="inbox" data-inbox-group="all">Усі рішення · ${s.decisions}</button>` : ''}
            </div>
        </div>
        <div class="tz-pulse" role="list">
            ${stat('Рішення', num(s.decisions, 'int'), s.decisions ? 'чекають у черзі' : 'усе вирішено', 'data-go="inbox" data-inbox-group="all" role="listitem"', s.decisions ? 'is-hot' : '')}
            ${stat('На підписі голови', s.pay ? num(s.pay.f.signing.kop) : '—', s.pay ? (s.pay.f.signing.count ? `${s.pay.f.signing.count} ${plural(s.pay.f.signing.count, 'платіж', 'платежі', 'платежів')} у Приват24` : 'нічого не чекає КЕП') : '', 'data-go="payments" role="listitem"')}
            ${stat('До оплати', s.pay ? num(s.pay.f.todo.kop) : '—', s.pay ? (s.pay.f.todo.count ? `${s.pay.f.todo.count} ще не створено` : 'усе створено') : '', 'data-go="payments" role="listitem"')}
            ${stat('Найближчий строк', dl ? escapeHtml(humanDate(dl.date)) : '—', dl ? escapeHtml(`${leftText(dl.left)} · ${dl.title}`) : 'строків немає', 'data-go="reports" role="listitem"', dl && dl.left < 0 ? 'is-bad' : dl && dl.left <= 3 ? 'is-hot' : '')}
        </div>
    </section>`;
}

function moneyHtml(s) {
    const { accounts, sync, pay, forecast } = s;
    const total = accounts.reduce((sum, a) => sum + (a.balanceKop || 0), 0);
    const live = sync && sync.ok !== false;
    const m = pay?.money;
    return `<section class="tz-card tz-money" style="--i:1">
        <button type="button" class="tz-head" data-go="bank"><h2>Гроші</h2><span class="tz-sync${sync?.ok === false ? ' is-bad' : live ? ' is-live' : ''}"><i></i>${!accounts.length ? 'банк не підключено' : sync?.ok === false ? 'виписка не оновилась' : sync ? `виписка ${escapeHtml(when(sync.at))}` : 'виписки ще немає'}</span></button>
        <button type="button" class="tz-balance" data-go="bank"><span>На рахунках ОСББ</span><b>${accounts.length ? num(total) : '—'}</b></button>
        ${accounts.length > 1 ? `<div class="tz-accs">${accounts.slice(0, 4).map(a => {
            const share = total > 0 ? Math.max(2, Math.round((a.balanceKop || 0) / total * 100)) : 0;
            return `<div class="tz-acc"><span>${escapeHtml(ACCOUNT_PURPOSES[a.purpose] || 'Рахунок')}</span><b>${escapeHtml(money(a.balanceKop || 0))}</b><i style="--w:${share}%"></i></div>`;
        }).join('')}</div>` : ''}
        <dl class="tz-facts">
            ${m?.known && pay.f.signing.count ? `<div><dt>Після підписаних</dt><dd>${escapeHtml(money(m.afterSigningKop))}</dd></div>` : ''}
            ${m?.known && pay.f.todo.count ? `<div class="${m.shortKop ? 'is-bad' : ''}"><dt>${m.shortKop ? 'Бракує на все до оплати' : 'Після всього до оплати'}</dt><dd>${escapeHtml(money(m.shortKop || m.afterAllKop))}</dd></div>` : ''}
            ${forecast.totalKop ? `<div><dt>Ще виплатити за ${escapeHtml(periodName(forecast.period).split(' ')[0].toLowerCase())}</dt><dd>${escapeHtml(money(forecast.totalKop))}</dd></div>` : ''}
        </dl>
    </section>`;
}

function tasksHtml(list) {
    const total = list.reduce((s, t) => s + t.count, 0);
    const max = Math.max(1, ...list.map(t => t.count));
    return `<section class="tz-card tz-tasks" style="--i:2" aria-label="Що зробити">
        <div class="tz-head"><h2>Що зробити</h2><span>${total ? `${total} ${plural(total, 'рішення', 'рішення', 'рішень')}` : 'черга порожня'}</span></div>
        ${list.length ? `<ul class="tz-list">${list.map((t, i) => `<li style="--j:${i}">
            <button type="button" class="tz-task${t.key === 'failed_pay' ? ' is-bad' : ''}" ${goAttr(t.go || 'inbox', t.go ? '' : t.key)}>
                ${icon(t.icon, t.key === 'failed_pay' ? 'is-bad' : t.key === 'bank' ? 'is-hot' : '')}
                <span class="tz-task-main"><b>${escapeHtml(t.title)}</b><small>${escapeHtml(t.note)}</small><i class="tz-share" style="--w:${Math.round(t.count / max * 100)}%"></i></span>
                <span class="tz-task-right"><b>${t.count}</b>${t.sumKop ? `<small>${escapeHtml(money(t.sumKop))}</small>` : ''}</span>
            </button></li>`).join('')}</ul>
            <button type="button" class="tz-more" data-go="inbox" data-inbox-group="all">Відкрити «Рішення» — по одному, з підказкою системи <span aria-hidden="true">→</span></button>`
        : `<div class="tz-clear"><b>Усе вирішено</b><span>Нові справи зʼявляться, щойно прийде виписка чи документ.</span>
            <div class="tz-quick">${[['expenses', '+ Документ'], ['payments', 'Платежі'], ['advance', 'Авансові звіти'], ['flats', 'Квартири']].map(([g, t]) => `<button type="button" class="tz-chip" data-go="${g}">${t}</button>`).join('')}</div></div>`}
    </section>`;
}

function datesHtml(list) {
    return `<section class="tz-card tz-dates" style="--i:3" aria-label="Строки">
        <button type="button" class="tz-head" data-go="reports"><h2>Строки</h2><span>податковий календар ›</span></button>
        ${list.length ? `<ol class="tz-timeline">${list.map((d, i) => `<li class="${d.left < 0 ? 'is-bad' : d.left <= 3 ? 'is-hot' : ''}" style="--j:${i}">
            <button type="button" data-go="reports">
                <span class="tz-date"><b>${new Date(d.date).getUTCDate()}</b><small>${MONTHS_SHORT[new Date(d.date).getUTCMonth()]}</small></span>
                <span class="tz-date-main">${d.items.map(x => `<b>${escapeHtml(x.title)}</b>${x.detail ? `<small>${escapeHtml(x.detail)}</small>` : ''}`).join('')}</span>
                <span class="tz-left">${escapeHtml(leftText(d.left))}</span>
            </button></li>`).join('')}</ol>`
        : '<p class="tz-empty">Найближчими тижнями строків немає — усе подано й сплачено.</p>'}
    </section>`;
}

function flowHtml(c, now) {
    const monthWord = MONTHS_LOC[now.getMonth()];
    const h = kop => Math.round(kop / c.maxKop * 100);
    return `<section class="tz-card tz-flow" style="--i:4" aria-label="Рух коштів">
        <button type="button" class="tz-head" data-go="bank"><h2>Рух коштів у ${monthWord}</h2><span>за випискою ›</span></button>
        <div class="tz-flow-tiles">
            <div><span>Надійшло</span><b class="is-in">+${num(c.inKop)}</b><small>з них внески ${escapeHtml(money(c.residentsKop))}</small></div>
            <div><span>Списано</span><b>−${num(c.outKop)}</b><small>${c.outTop.length ? escapeHtml(c.outTop.map(x => x.label).slice(0, 2).join(', ').toLowerCase()) : 'списань не було'}</small></div>
            <div><span>Різниця</span><b class="${c.netKop < 0 ? 'is-out' : 'is-in'}">${c.netKop < 0 ? '−' : '+'}${num(Math.abs(c.netKop))}</b><small>надійшло мінус списано</small></div>
        </div>
        <div class="tz-chart" role="img" aria-label="Надходження й списання по днях">
            ${c.days.map((d, i) => `<span class="tz-day${d.future ? ' is-future' : ''}${d.today ? ' is-today' : ''}" style="--k:${i}" title="${d.day}: +${fmtKop(d.inKop)} / −${fmtKop(d.outKop)} грн">
                <i class="is-in" style="--h:${h(d.inKop)}%"></i><i class="is-out" style="--h:${h(d.outKop)}%"></i></span>`).join('')}
        </div>
        <div class="tz-chart-axis"><span>1</span><span>${Math.ceil(c.days.length / 2)}</span><span>${c.days.length}</span></div>
        <div class="tz-legend"><span><i class="is-in"></i>надходження</span><span><i class="is-out"></i>списання</span><span><i class="is-today"></i>сьогодні</span></div>
    </section>`;
}

function duesHtml(c) {
    if (!c.known) return '';
    return `<section class="tz-card tz-dues" style="--i:5" aria-label="Внески мешканців">
        <button type="button" class="tz-head" data-go="charges"><h2>Внески за ${escapeHtml(periodName(c.period).split(' ')[0].toLowerCase())}</h2><span>нарахування ›</span></button>
        <div class="tz-dues-top">
            ${ring(c.share === null ? 0 : c.share / 100, c.share === null ? '—' : num(c.share, 'pct'), 'сплачено')}
            <dl class="tz-facts is-plain">
                <div><dt>Нараховано</dt><dd>${c.chargedKop ? escapeHtml(money(c.chargedKop)) : 'ще ні'}</dd></div>
                <div><dt>Сплатили</dt><dd>${escapeHtml(money(c.paidKop))}</dd></div>
                <div><dt>Квартир сплатило</dt><dd>${c.paidApts}${c.totalApts ? ` з ${c.totalApts}` : ''}</dd></div>
            </dl>
        </div>
        <button type="button" class="tz-debt" data-go="flats"><span>Борг мешканців</span><b>${num(c.debtKop)}</b><small>${c.debtors} ${plural(c.debtors, 'квартира', 'квартири', 'квартир')}</small></button>
        ${c.top.length ? `<div class="tz-debtors">${c.top.map((a, i) => `<button type="button" class="tz-debtor" data-apt="${escapeHtml(a.apt)}" style="--j:${i}">
            <span>кв. ${escapeHtml(a.apt)}</span><i style="--w:${Math.max(4, Math.round(a.kop / c.top[0].kop * 100))}%"></i><b>${escapeHtml(money(a.kop))}</b></button>`).join('')}</div>` : ''}
    </section>`;
}

function payHtml(pay) {
    if (!pay) return '';
    const f = pay.f;
    const steps = [['Погодження', f.approval.count, f.approval.kop, 'inbox'], ['До оплати', f.todo.count, f.todo.kop, 'payments'],
        ['На підписі', f.signing.count, f.signing.kop, 'payments'], ['Проведено', f.paid.count, f.paid.kop, 'payments']];
    return `<section class="tz-card tz-pay" style="--i:6" aria-label="Платежі">
        <button type="button" class="tz-head" data-go="payments"><h2>Платежі</h2><span>${pay.problems.length ? `<em class="tz-bad">${pay.problems.length} з проблемою</em>` : 'шлях грошей ›'}</span></button>
        <ol class="tz-steps">${steps.map(([t, n, kop, go], i) => `<li class="${n ? 'is-on' : ''}" style="--j:${i}"><button type="button" data-go="${go}"${go === 'inbox' ? ' data-inbox-group="all"' : ''}>
            <i></i><span>${t}</span><b>${n ? escapeHtml(money(kop)) : '—'}</b><small>${n ? `${n} ${i === 3 ? 'за місяць' : ''}`.trim() : ''}</small></button></li>`).join('')}</ol>
    </section>`;
}

function monthHtml(md) {
    if (!md) return '';
    const p = monthProgress(md.steps);
    const closed = p.done === p.total;
    return `<section class="tz-card tz-month" style="--i:7" aria-label="Закриття місяця">
        <button type="button" class="tz-head" data-go="month"><h2>Закриття · ${escapeHtml(periodName(md.journal.period).split(' ')[0].toLowerCase())}</h2><span>місяць ›</span></button>
        <div class="tz-month-top">
            ${ring(p.done / p.total, `${num(p.done, 'int')}<em>/${p.total}</em>`, closed ? 'закрито' : 'кроків', closed ? 'is-done' : '')}
            <ul class="tz-msteps">${monthPhases(md.steps).map((ph, i) => `<li class="is-${ph.state === 'wait' ? 'done' : ph.state}" style="--j:${i}"><i></i>${escapeHtml(ph.title)}<small>${ph.done}/${ph.steps.length}</small></li>`).join('')}</ul>
        </div>
        <button type="button" class="tz-next" data-go="month">${closed ? 'Місяць закрито' : `Далі: ${escapeHtml(p.next.title.toLowerCase())}${p.next.short ? ` — ${escapeHtml(p.next.short)}` : ''}`} ›</button>
    </section>`;
}

function budgetHtml(b) {
    if (!b) return '';
    const bar = (label, fact, plan, pct, cls) => `<div class="tz-bbar ${cls}"><div><span>${label}</span><b>${pct}%</b></div>
        <span class="tz-track"><i style="--w:${Math.min(100, pct)}%"></i>${pct > 100 ? '<em></em>' : ''}</span><small>${escapeHtml(money(fact))} з ${escapeHtml(money(plan))} на сьогодні</small></div>`;
    return `<section class="tz-card tz-budget" style="--i:8" aria-label="Кошторис">
        <button type="button" class="tz-head" data-go="budget"><h2>Кошторис ${escapeHtml(b.year)}</h2><span>${b.approved ? 'затверджено' : 'чернетка'} ›</span></button>
        ${bar('Витрати', b.factKop, b.toDateKop, b.pct, b.pct > 105 ? 'is-bad' : '')}
        ${b.incomePlanKop ? bar('Надходження', b.incomeFactKop, b.incomeToDateKop, b.incomePct, b.incomePct < 85 ? 'is-warn' : 'is-good') : ''}
        ${b.over.length ? `<ul class="tz-over">${b.over.map(o => `<li><span>${escapeHtml(o.title)}</span><b>+${escapeHtml(money(o.overKop))}</b></li>`).join('')}</ul>` : '<p class="tz-empty">Перевитрат за статтями немає</p>'}
    </section>`;
}

function opsHtml(list) {
    if (!list.length) return '';
    return `<section class="tz-card tz-ops" style="--i:9" aria-label="Останні операції">
        <button type="button" class="tz-head" data-go="bank"><h2>Останні операції</h2><span>усі в «Банку» ›</span></button>
        <div class="tz-ops-list">${list.map((t, i) => `<button type="button" class="tz-op" data-tx="${escapeHtml(t.id)}" style="--j:${i}">
            ${icon(t.direction === 'out' ? 'out' : 'in', t.direction === 'out' ? '' : 'is-in')}
            <span class="tz-op-main"><b>${escapeHtml(t.counterparty?.name || (t.direction === 'out' ? 'Списання' : 'Надходження'))}</b><small>${escapeHtml(t.purpose || '')}</small></span>
            <span class="tz-op-right"><b class="${t.direction === 'out' ? '' : 'is-in'}">${escapeHtml(signed(t))} грн</b><small>${escapeHtml(dateOnly(t.at))}${t.status === 'review' ? ' · чекає рішення' : ''}</small></span>
        </button>`).join('')}</div>
    </section>`;
}

// ------------------------------------------------------------
// РУХ
// ------------------------------------------------------------
function countUp(root) {
    const els = [...root.querySelectorAll('[data-count]')];
    const start = performance.now(), dur = 950;
    const ease = k => 1 - Math.pow(1 - k, 4);
    els.forEach(el => { el.textContent = fmtValue(0, el.dataset.fmt); });
    const step = t => {
        const k = Math.min(1, (t - start) / dur);
        els.forEach(el => { el.textContent = fmtValue(Number(el.dataset.count) * ease(k), el.dataset.fmt); });
        if (k < 1 && root.isConnected) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
}

// ------------------------------------------------------------
// ЗАВАНТАЖЕННЯ
// ------------------------------------------------------------
export async function loadToday() {
    const now = new Date();
    const host = document.getElementById('viewToday');
    // Анімація входу — лише коли людина перейшла в розділ, не при фоновому оновленні.
    const enter = document.body.dataset.enter === 'today' || !host.querySelector('.tz');
    delete document.body.dataset.enter;
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const [inbox, settings, monthTx, outgoing, monthData, pay] = await Promise.all([
        collectInbox(), loadSettings().catch(() => ({})), loadSince(monthStart).catch(() => []), loadPayments().catch(() => []),
        loadMonthData(null).catch(() => null), paymentsOverview().catch(() => null)]);
    const { items, charges, expenses, payroll, journal, budget } = inbox;
    const list = tasks(items);
    const allDeadlines = reportTasks(inbox.reports);
    const deadline = nextDeadline(allDeadlines);
    const progress = monthData ? monthProgress(monthData.steps) : null;
    const accounts = Object.entries(settings.accounts || {}).map(([iban, a]) => ({ iban, ...a })).filter(a => !a.currency || a.currency === 'UAH')
        .sort((a, b) => ((a.purpose || 'current') === 'current' ? -1 : 0) - ((b.purpose || 'current') === 'current' ? -1 : 0));
    const focus = focusOf({ role: session.role, list, pay: pay?.f || null, deadline, month: progress });
    const forecast = computeUpcomingPayments({ expenses, payroll, journal, payments: outgoing, period: charges?.current || now.toISOString().slice(0, 7) });
    const labels = Object.fromEntries(Object.entries(BANK_CATEGORY_OPTIONS).map(([k, v]) => [k, v.replace(/\s*\(.*\)$/, '')]));
    const s = { decisions: list.reduce((a, t) => a + t.count, 0), pay, deadline, accounts, sync: settings.lastSync, forecast };

    host.innerHTML = `<div class="tz${enter && !reduceMotion() ? ' tz-enter' : ''}">
        ${heroHtml(focus, s)}
        ${moneyHtml(s)}
        ${tasksHtml(list)}
        ${datesHtml(upcoming(allDeadlines))}
        ${flowHtml(cashByDay(monthTx, now, labels), now)}
        ${duesHtml(collection(charges, monthTx, now))}
        ${payHtml(pay)}
        ${monthHtml(monthData)}
        ${budgetHtml(budgetPace(budget))}
        ${opsHtml(recentOps(monthTx, 6))}
    </div>
    <p class="buh-note">Система пропонує — рішення за вами. Платежі підписує голова КЕП у Приват24.</p>`;
    if (enter && !reduceMotion()) countUp(host);
    if (!host.dataset.bound) {
        host.dataset.bound = '1';
        host.addEventListener('click', e => {
            const tx = e.target.closest('[data-tx]');
            if (tx) { openTxSheet(tx.dataset.tx); return; }
            const apt = e.target.closest('[data-apt]');
            if (apt) { location.hash = 'flats'; setTimeout(() => openFlat(apt.dataset.apt), 0); }
        });
    }
    return items.length;
}
