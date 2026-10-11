// ============================================================
// «Місяць»: закриття місяця крок за кроком — нарахування, банк,
// документи, зарплата, перевірка обліку, закриття. Стан кроків рахує
// month-core.js з даних, які кабінет уже отримує; дії ведуть у
// відповідні розділи, закриття — тут же, з підтвердженням.
// ============================================================
import { escapeHtml, toast, setBusy, confirmDialog } from './ui.js';
import { loadJournal, loadCharges, loadQueue, loadExpenses, loadPayroll, journalAct } from './buh-data.js';
import { periodName } from './charges-core.js';
import { monthSteps, monthProgress, STATES } from './month-core.js';
import { openCharges } from './buh-charges.js';
import { openExpenses } from './buh-expenses.js';
import { openPayroll } from './buh-payroll.js';
import { openJournal } from './buh-journal.js';

let period = null;      // null — місяць, який пропонує сервер (найдавніший незакритий)
let selected = null;    // ключ відкритого кроку
let steps = [];
let journal = null;

const toDate = ts => (ts?.toDate ? ts.toDate() : new Date(ts));
const monthOf = ts => { const d = toDate(ts); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; };
const capital = s => s.charAt(0).toUpperCase() + s.slice(1);

/** Дані для кроків місяця (і для картки на «Сьогодні»). */
export async function loadMonthData(p = period) {
    const j = await loadJournal(p);
    const [charges, queue, expenses, payroll] = await Promise.all([loadCharges().catch(() => null), loadQueue().catch(() => []),
        loadExpenses().catch(() => null), loadPayroll(j.period).catch(() => null)]);
    const waiting = queue.filter(tx => monthOf(tx.at) <= j.period);
    const bank = { count: waiting.length, sumKop: waiting.reduce((s, tx) => s + (tx.amountKop || 0), 0) };
    return { journal: j, steps: monthSteps({ period: j.period, journal: j, charges, bank, expenses, payroll }) };
}

function stepsHtml() {
    return `<nav class="mo-steps" aria-label="Кроки закриття"><ol>${steps.map(s => `
        <li><button type="button" class="mo-step is-${s.state}${s.key === selected ? ' is-current' : ''}" data-act="pick" data-key="${s.key}" aria-current="${s.key === selected ? 'step' : 'false'}">
            <span class="mo-dot" aria-hidden="true">${s.state === 'done' ? '✓' : s.n}</span>
            <span class="mo-step-copy"><b>${escapeHtml(s.title)}</b><small>${escapeHtml(s.short)}</small></span>
        </button></li>`).join('')}</ol></nav>`;
}

function detailHtml() {
    const s = steps.find(x => x.key === selected) || steps[0];
    const checks = s.checks?.length ? `<ul class="mo-checks">${s.checks.map(c => `<li class="is-${c.level}">${escapeHtml(c.text)}</li>`).join('')}</ul>` : '';
    const disabled = s.state === 'locked' || s.state === 'unknown' && !s.go;
    return `<section class="mo-detail" aria-label="${escapeHtml(s.title)}">
        <span class="sv-chip is-${s.state}">Крок ${s.n} · ${STATES[s.state]}</span>
        <h2>${escapeHtml(s.title)}</h2>
        <p>${escapeHtml(s.text)}</p>
        ${s.facts.length ? `<div class="mo-facts">${s.facts.map(([k, v]) => `<div><span>${escapeHtml(k)}</span><b>${escapeHtml(v)}</b></div>`).join('')}</div>` : ''}
        ${checks}
        <div class="mo-actions">
            <button type="button" class="sv-btn" data-act="${s.close ? 'close' : 'go'}" data-key="${s.key}"${disabled ? ' disabled' : ''}>${escapeHtml(s.action)}</button>
            <button type="button" class="sv-btn is-soft" data-act="next">Наступний крок ›</button>
        </div>
    </section>`;
}

export async function loadMonthView() {
    const data = await loadMonthData(period);
    journal = data.journal;
    steps = data.steps;
    if (!steps.some(s => s.key === selected)) selected = monthProgress(steps).next.key;
    const { done, total } = monthProgress(steps);
    const ids = (journal.periods || []).map(x => x.id);
    const at = ids.indexOf(journal.period);
    const prev = at > 0 ? ids[at - 1] : null, next = at >= 0 && at < ids.length - 1 ? ids[at + 1] : null;
    document.getElementById('viewMonth').innerHTML = `
        <div class="mo-bar">
            <div class="mo-title"><b>${escapeHtml(capital(periodName(journal.period)))}</b>
                <span class="sv-chip is-${journal.status === 'closed' ? 'done' : 'work'}">${journal.status === 'closed' ? 'закрито' : `відкритий · ${done} з ${total}`}</span></div>
            <div class="mo-switch">
                <button type="button" class="sv-btn is-white" data-act="period" data-period="${prev || ''}"${prev ? '' : ' disabled'}>‹ ${prev ? escapeHtml(capital(periodName(prev).split(' ')[0])) : 'Раніше'}</button>
                <button type="button" class="sv-btn is-white" data-act="period" data-period="${next || ''}"${next ? '' : ' disabled'}>${next ? escapeHtml(capital(periodName(next).split(' ')[0])) : 'Далі'} ›</button>
            </div>
        </div>
        <div class="mo-grid">${stepsHtml()}${detailHtml()}</div>`;
    return steps.filter(s => s.state === 'work').length;
}

function go(step) {
    if (step.key === 'charges') return openCharges('month');
    if (step.key === 'docs') return openExpenses('docs');
    if (step.key === 'payroll') return openPayroll(journal.period);
    if (step.key === 'checks' || step.key === 'close') return openJournal(journal.period);
    location.hash = step.state === 'work' ? 'inbox' : 'bank';
}

async function onAction(btn) {
    const a = btn.dataset.act;
    if (a === 'pick') { selected = btn.dataset.key; await loadMonthView(); document.querySelector(`#viewMonth [data-act="pick"][data-key="${selected}"]`)?.focus(); return; }
    if (a === 'next') { const i = steps.findIndex(s => s.key === selected); selected = steps[(i + 1) % steps.length].key; await loadMonthView(); return; }
    if (a === 'period') { period = btn.dataset.period || null; selected = null; await loadMonthView(); return; }
    const step = steps.find(s => s.key === btn.dataset.key);
    if (!step) return;
    if (a === 'go') { go(step); return; }
    if (a === 'close') {
        const name = periodName(journal.period);
        if (!await confirmDialog(`Закрити ${name}?`, 'Після закриття операції цього місяця (нарахування, документи, рознесення виписки) змінити не можна. Відкрити знову може лише голова, з причиною.', 'Закрити')) return;
        setBusy(btn, true, 'Закриваю…');
        try {
            await journalAct({ action: 'close', period: journal.period });
            toast(`${capital(name)} закрито`, 'success');
        } catch (e) { toast(e.message, 'error'); }
        finally { if (btn.isConnected) setBusy(btn, false); }
    }
}

export function initMonthView() {
    document.getElementById('viewMonth').addEventListener('click', e => {
        const btn = e.target.closest('[data-act]');
        if (btn && !btn.disabled) onAction(btn);
    });
}
