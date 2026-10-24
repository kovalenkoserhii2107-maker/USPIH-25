// ============================================================
// «Місяць»: закриття місяця крок за кроком.
//
// Угорі — стрічка місяців обліку (закриті, відкриті, поточний) і
// головна картка: стан місяця смугою з кроків, перешкоди закриттю й
// одна наступна дія. Поруч — підсумки місяця з оборотно-сальдової
// відомості. Нижче — пʼять фаз (доходи, банк, витрати, зарплата й
// звіти, облік і закриття); кожен крок розгортається: що це, факти,
// зауваження й дія. Звірка залишків банку, закриття й повторне
// відкриття (голова) — тут же. Стан кроків — month-core.js.
// ============================================================
import { session } from './firebase.js';
import { escapeHtml, toast, setBusy, confirmDialog, promptDialog } from './ui.js';
import { loadJournal, loadCharges, loadQueue, loadExpenses, loadPayroll, loadPayments, loadReports, journalAct, money } from './buh-data.js';
import { periodName, toKop } from './charges-core.js';
import { monthSteps, monthProgress, monthPhases, monthTotals, STATES, PHASES } from './month-core.js';
import { reportTasks, periodOfKey } from './reports-view-core.js';
import { openCharges } from './buh-charges.js';
import { openExpenses, draftFromContract } from './buh-expenses.js';
import { openPayroll } from './buh-payroll.js';
import { openJournal } from './buh-journal.js';
import { openAdvance } from './buh-advance.js';
import { openAssets } from './buh-assets.js';

let period = null;      // null — місяць, який пропонує сервер (найдавніший незакритий)
let open = null;        // ключ розгорнутого кроку
let data = null;        // { journal, steps, totals }

const toDate = ts => (ts?.toDate ? ts.toDate() : new Date(ts));
const monthOf = ts => { const d = toDate(ts); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; };
const capital = s => s.charAt(0).toUpperCase() + s.slice(1);
const isChair = () => session.role === 'chair';
const SHORT = ['січ', 'лют', 'бер', 'квіт', 'трав', 'черв', 'лип', 'серп', 'вер', 'жовт', 'лист', 'груд'];
const ICON = {
    done: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
    work: '<path d="M12 7v6M12 16.5h.01"/>',
    wait: '<path d="M12 7v5l3 2"/>',
    locked: '<rect x="6" y="11" width="12" height="9" rx="2"/><path d="M9 11V8a3 3 0 0 1 6 0v3"/>',
    unknown: '<path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .8-1 1.5M12 16.5h.01"/>'
};
const stateIcon = st => `<span class="mn-state is-${st}" aria-hidden="true"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round">${ICON[st] || ICON.unknown}</svg></span>`;

/** Дані для кроків місяця (і для картки на «Сьогодні»). */
export async function loadMonthData(p = period) {
    const j = await loadJournal(p);
    const [charges, queue, expenses, payroll, payments, reports] = await Promise.all([loadCharges().catch(() => null), loadQueue().catch(() => []),
        loadExpenses().catch(() => null), loadPayroll(j.period).catch(() => null), loadPayments().catch(() => null), loadReports().catch(() => null)]);
    const waiting = queue.filter(tx => monthOf(tx.at) <= j.period);
    const bank = { count: waiting.length, sumKop: waiting.reduce((s, tx) => s + (tx.amountKop || 0), 0) };
    const tasks = reports ? reportTasks(reports).filter(t => periodOfKey(t.key) === j.period) : null;
    return {
        journal: j, totals: monthTotals(j.tb),
        steps: monthSteps({ period: j.period, journal: j, charges, bank, expenses, payroll, payments, reports: tasks, today: j.today })
    };
}

// ------------------------------------------------------------
// РОЗМІТКА
// ------------------------------------------------------------
function monthsHtml(j) {
    const list = j.periods || [];
    const current = (j.today || '').slice(0, 7);
    return `<nav class="mn-months" aria-label="Місяці обліку">${list.map(p => {
        const [y, m] = p.id.split('-').map(Number);
        const cls = [p.id === j.period ? 'is-active' : '', p.status === 'closed' ? 'is-closed' : p.id === current ? 'is-current' : 'is-open'].join(' ');
        return `<button type="button" class="mn-month ${cls}" data-act="period" data-period="${p.id}" aria-current="${p.id === j.period ? 'true' : 'false'}"
            title="${escapeHtml(capital(periodName(p.id)))} · ${p.status === 'closed' ? 'закрито' : 'відкритий'}">
            <i aria-hidden="true"></i><b>${SHORT[m - 1]}</b>${m === 1 || p === list[0] ? `<small>${y}</small>` : ''}</button>`;
    }).join('')}</nav>`;
}

function heroHtml(j, steps) {
    const p = monthProgress(steps);
    const closed = j.status === 'closed';
    const blocks = (j.checks || []).filter(c => c.level === 'block');
    const notEnded = blocks.find(c => /ще не скінчився/.test(c.text));
    const close = steps.find(s => s.key === 'close');
    const next = p.next;
    const cta = closed
        ? (close.reopen && isChair() ? '<button type="button" class="sv-btn is-white" data-act="reopen">Відкрити місяць знову</button>' : '')
        : close.close ? `<button type="button" class="sv-btn is-white" data-act="close">${escapeHtml(close.action)}</button>`
        : next && next.state === 'work' ? `<button type="button" class="sv-btn is-white" data-act="go" data-key="${next.key}">${escapeHtml(next.action)} <span aria-hidden="true">→</span></button>` : '';
    const status = closed ? `Закрито${j.closedAt ? ` ${new Date(j.closedAt).toLocaleDateString('uk-UA')}` : ''}. Записи місяця змінити не можна — лише виправленнями в наступному.`
        : close.close ? 'Усі перевірки пройдено — місяць можна закривати.'
        : next?.state === 'work' ? `Далі: ${next.title.toLowerCase()} — ${next.short}.`
        : notEnded ? notEnded.text : 'Залишились кроки, що не заважають закриттю.';
    return `<section class="mn-card mn-hero${closed ? ' is-closed' : ''}" style="--i:0">
        <div class="mn-hero-top">
            <div><span class="mn-eyebrow">${closed ? 'Закритий місяць' : j.period === (j.today || '').slice(0, 7) ? 'Поточний місяць' : 'Відкритий місяць'}</span>
                <h2>${escapeHtml(capital(periodName(j.period)))}</h2></div>
            <div class="mn-score"><b>${p.done}<span>/${p.total}</span></b><small>кроків пройдено</small></div>
        </div>
        <div class="mn-bar" role="img" aria-label="Пройдено ${p.done} з ${p.total} кроків">${steps.map((s, i) => `<button type="button" class="mn-seg is-${s.state}${s.key === open ? ' is-open' : ''}" data-act="toggle" data-key="${s.key}" style="--k:${i}" title="${escapeHtml(`${s.title}: ${s.short}`)}"></button>`).join('')}</div>
        <div class="mn-phase-row">${monthPhases(steps).map(ph => `<span class="mn-phase is-${ph.state}">${escapeHtml(ph.title)} <b>${ph.done}/${ph.steps.length}</b></span>`).join('')}</div>
        <p class="mn-status">${escapeHtml(status)}</p>
        <div class="mn-hero-actions">${cta}
            ${blocks.length && !closed ? `<span class="mn-blocks">${blocks.length} ${blocks.length === 1 ? 'перешкода' : blocks.length < 5 ? 'перешкоди' : 'перешкод'} закриттю</span>` : ''}
            <button type="button" class="mn-link" data-act="journal">Проводки й ОСВ ›</button></div>
    </section>`;
}

function totalsHtml(t, j) {
    if (!t) return '';
    const row = (label, value, cls = '') => `<div class="${cls}"><dt>${label}</dt><dd>${value}</dd></div>`;
    const signed = kop => `${kop < 0 ? '−' : ''}${money(Math.abs(kop))}`;
    return `<section class="mn-card mn-sum" style="--i:1" aria-label="Підсумки місяця">
        <div class="mn-head"><h2>Підсумки місяця</h2><span class="${t.balanced ? 'mn-ok' : 'mn-bad'}">${t.balanced ? 'дебет = кредит' : 'дебет ≠ кредит'}</span></div>
        <div class="mn-money">
            <div><span>На початок</span><b>${money(t.moneyOpenKop)}</b></div>
            <i aria-hidden="true">→</i>
            <div><span>На кінець</span><b>${money(t.moneyCloseKop)}</b></div>
        </div>
        <div class="mn-flow"><span class="is-in">+${money(t.moneyInKop)}</span><span class="is-out">−${money(t.moneyOutKop)}</span></div>
        <dl class="mn-facts">
            ${row('Нараховано співвласникам', money(t.chargedKop))}
            ${row('Сплатили співвласники', money(t.residentsPaidKop))}
            ${row(t.residentsDebtKop >= 0 ? 'Борг співвласників на кінець' : 'Переплата співвласників', money(Math.abs(t.residentsDebtKop)), t.residentsDebtKop > 0 ? 'is-bad' : '')}
            ${row('Витрати (рах. 92)', money(t.expensesKop))}
            ${t.incomeKop ? row('Доходи (рах. 703, 719, 733)', money(t.incomeKop)) : ''}
            ${t.payrollKop ? row('Зарплата нарахована · ЄСВ', `${money(t.payrollKop)} · ${money(t.esvKop)}`) : ''}
            ${row('Борг постачальникам на кінець', signed(t.suppliersDebtKop))}
        </dl>
        <button type="button" class="mn-link is-dark" data-act="journal">Оборотно-сальдова відомість за ${escapeHtml(periodName(j.period).split(' ')[0])} ›</button>
    </section>`;
}

function blocksHtml(j) {
    const list = (j.checks || []).filter(c => c.level !== 'ok');
    if (!list.length || j.status === 'closed') return '';
    return `<section class="mn-card mn-checks" style="--i:2" aria-label="Перешкоди й зауваження">
        <div class="mn-head"><h2>Що каже перевірка</h2><span>${list.filter(c => c.level === 'block').length} блокують</span></div>
        <ul>${list.map(c => `<li class="is-${c.level}">${escapeHtml(c.text)}</li>`).join('')}</ul>
    </section>`;
}

function detailHtml(s, j) {
    const facts = s.facts?.length ? `<dl class="mn-facts is-step">${s.facts.map(([k, v]) => `<div><dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd></div>`).join('')}</dl>` : '';
    const checks = s.checks?.length ? `<ul class="mn-step-checks">${s.checks.map(c => `<li class="is-${c.level}">${escapeHtml(c.text)}</li>`).join('')}</ul>` : '';
    const missing = s.missing?.length ? `<div class="mn-missing">${s.missing.map(c => `<button type="button" class="mn-chip" data-act="add-act" data-contract="${escapeHtml(c.id)}">+ акт: ${escapeHtml(c.supplierName || c.subject || `№ ${c.number}`)}</button>`).join('')}</div>` : '';
    const cut = s.inline === 'bankcut' && s.state === 'work' && !isChair() ? `<form class="mn-cut" data-cut>
        ${(j.bankRows || []).map((r, i) => `<label class="py-field"><span>…${escapeHtml(String(r.iban).slice(-4))} · рах. ${escapeHtml(r.acc)} — в обліку ${escapeHtml(money(r.balanceKop))}</span>
            <input inputmode="decimal" data-cut-row="${i}" placeholder="Залишок у виписці, грн" autocomplete="off"></label>`).join('')}
        <label class="py-field"><span>Реквізити виписки</span><input id="mnCutNote" maxlength="300" placeholder="Напр.: виписка Приват24 за 31.10" autocomplete="off"></label>
        <button type="submit" class="sv-btn">Звірити залишки</button></form>` : '';
    const action = s.close ? `<button type="button" class="sv-btn" data-act="close">${escapeHtml(s.action)}</button>`
        : s.reopen && isChair() ? '<button type="button" class="sv-btn is-soft" data-act="reopen">Відкрити місяць знову</button>'
        : s.state === 'locked' && s.key === 'close' ? '' : `<button type="button" class="sv-btn${s.state === 'work' ? '' : ' is-soft'}" data-act="go" data-key="${s.key}">${escapeHtml(s.action)}</button>`;
    return `<div class="mn-detail"><div>
        <p>${escapeHtml(s.text)}</p>${facts}${checks}${missing}${cut}
        <div class="mn-detail-actions">${action}</div></div></div>`;
}

function phasesHtml(steps, j) {
    return monthPhases(steps).map((ph, pi) => `<section class="mn-card mn-phasecard is-${ph.state}" style="--i:${pi + 3}" aria-label="${escapeHtml(ph.title)}">
        <div class="mn-head"><h2>${escapeHtml(PHASES[ph.key])}</h2><span class="mn-tag is-${ph.state}">${ph.state === 'done' ? 'готово' : ph.state === 'wait' ? 'не заважає' : ph.state === 'work' ? 'є що зробити' : 'ще рано'} · ${ph.done}/${ph.steps.length}</span></div>
        <ol class="mn-steps">${ph.steps.map((s, i) => `<li class="mn-step is-${s.state}${s.key === open ? ' is-open' : ''}" style="--j:${i}" data-key="${s.key}">
            <button type="button" class="mn-step-head" data-act="toggle" data-key="${s.key}" aria-expanded="${s.key === open}">
                ${stateIcon(s.state)}
                <span class="mn-step-main"><b>${escapeHtml(s.title)}</b><small>${escapeHtml(s.short)}</small></span>
                ${s.who === 'chair' ? '<span class="mn-who">голова</span>' : ''}
                <span class="mn-step-state">${escapeHtml(STATES[s.state])}</span>
                <span class="mn-chev" aria-hidden="true">›</span>
            </button>
            ${detailHtml(s, j)}
        </li>`).join('')}</ol>
    </section>`).join('');
}

function render() {
    const host = document.getElementById('viewMonth');
    const { journal: j, steps, totals } = data;
    const enter = host.dataset.enter === '1';
    host.dataset.enter = '';
    host.innerHTML = `<div class="mn${enter && !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? ' mn-enter' : ''}">
        ${monthsHtml(j)}
        <div class="mn-grid">
            <div class="mn-main">${heroHtml(j, steps)}${phasesHtml(steps, j)}</div>
            <aside class="mn-side">${totalsHtml(totals, j)}${blocksHtml(j)}</aside>
        </div></div>`;
    host.querySelector('.mn-month.is-active')?.scrollIntoView({ block: 'nearest', inline: 'center' });
}

export async function loadMonthView() {
    const host = document.getElementById('viewMonth');
    if (document.body.dataset.enter === 'month') { host.dataset.enter = '1'; delete document.body.dataset.enter; }
    data = await loadMonthData(period);
    if (!data.steps.some(s => s.key === open)) open = monthProgress(data.steps).next.key;
    render();
    return data.steps.filter(s => s.state === 'work').length;
}

// ------------------------------------------------------------
// ДІЇ
// ------------------------------------------------------------
function go(step) {
    const p = data.journal.period;
    if (step.key === 'charges') return openCharges('month');
    if (step.key === 'docs') return openExpenses('docs');
    if (step.key === 'payroll') return openPayroll(p);
    if (step.key === 'advance') return openAdvance('all');
    if (step.key === 'assets') return openAssets('all');
    if (['checks', 'close', 'bankcut'].includes(step.key)) return openJournal(p);
    if (step.key === 'bank') { location.hash = step.state === 'work' ? 'inbox' : 'bank'; return; }
    location.hash = step.go;
}

async function closeMonth(btn) {
    const name = periodName(data.journal.period);
    if (!await confirmDialog(`Закрити ${name}?`, 'Після закриття операції цього місяця (нарахування, документи, рознесення виписки) змінити не можна. Відкрити знову може лише голова, з причиною.', 'Закрити')) return;
    setBusy(btn, true, 'Закриваю…');
    try { await journalAct({ action: 'close', period: data.journal.period }); toast(`${capital(name)} закрито`, 'success'); }
    catch (e) { toast(e.message, 'error'); }
    finally { if (btn.isConnected) setBusy(btn, false); }
}

async function reopenMonth() {
    const reason = await promptDialog('Відкрити місяць знову?', 'Потрібна причина — вона залишиться в історії місяця й журналі дій. Після виправлення місяць треба буде закрити знову.',
        { confirmLabel: 'Відкрити', placeholder: 'Напр.: пізня виписка за 30.10', maxLength: 300 });
    if (!reason) return;
    try { await journalAct({ action: 'reopen', period: data.journal.period, reason }); toast('Місяць відкрито знову', 'success'); }
    catch (e) { toast(e.message, 'error'); }
}

async function bankCut(form) {
    const rows = (data.journal.bankRows || []).map((r, i) => ({ acc: r.acc, iban: r.iban, balanceKop: toKop(form.querySelector(`[data-cut-row="${i}"]`).value) }));
    const note = form.querySelector('#mnCutNote').value.trim();
    if (rows.some(r => !Number.isInteger(r.balanceKop))) { toast('Вкажіть залишок кожного рахунку з виписки', 'error'); return; }
    if (note.length < 5) { toast('Вкажіть реквізити виписки', 'error'); return; }
    const off = rows.filter((r, i) => r.balanceKop !== data.journal.bankRows[i].balanceKop);
    if (off.length) { toast(`Не збігається: …${off.map(r => r.iban.slice(-4)).join(', …')}. Шукайте пропущену операцію у виписці`, 'error'); return; }
    const btn = form.querySelector('[type="submit"]');
    setBusy(btn, true, 'Звіряю…');
    try { await journalAct({ action: 'bankCut', period: data.journal.period, rows, note }); toast('Залишки звірено з випискою', 'success'); }
    catch (e) { toast(e.message, 'error'); setBusy(btn, false); }
}

async function onAction(btn) {
    const a = btn.dataset.act;
    if (a === 'toggle') {
        open = open === btn.dataset.key ? null : btn.dataset.key;
        const host = document.getElementById('viewMonth');
        host.querySelectorAll('.mn-step').forEach(li => {
            const on = li.dataset.key === open;
            li.classList.toggle('is-open', on);
            li.querySelector('.mn-step-head')?.setAttribute('aria-expanded', String(on));
        });
        host.querySelectorAll('.mn-seg').forEach(seg => seg.classList.toggle('is-open', seg.dataset.key === open));
        if (btn.classList.contains('mn-seg')) host.querySelector(`.mn-step[data-key="${open}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        return;
    }
    if (a === 'period') { period = btn.dataset.period || null; open = null; await loadMonthView(); return; }
    if (a === 'journal') { openJournal(data.journal.period); return; }
    if (a === 'close') { closeMonth(btn); return; }
    if (a === 'reopen') { reopenMonth(); return; }
    if (a === 'add-act') {
        const ex = await loadExpenses();
        const c = ex.contracts.find(x => x.id === btn.dataset.contract);
        if (c) openExpenses('docs', draftFromContract(c, data.journal.period));
        return;
    }
    const step = data.steps.find(s => s.key === btn.dataset.key);
    if (a === 'go' && step) go(step);
}

export function initMonthView() {
    const host = document.getElementById('viewMonth');
    host.addEventListener('click', e => {
        const btn = e.target.closest('[data-act]');
        if (btn && !btn.disabled) onAction(btn);
    });
    host.addEventListener('submit', e => {
        if (!e.target.matches('[data-cut]')) return;
        e.preventDefault();
        bankCut(e.target);
    });
}
