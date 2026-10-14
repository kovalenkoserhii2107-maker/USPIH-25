// ============================================================
// «Проводки»: оборотно-сальдова відомість за місяць, проводки за
// рахунком і аналітикою, перевірки й закриття місяця.
//
// Проводки будує сервер з операцій (journalAction, journal-core.js):
// руками їх не вводять. Закритий місяць не змінюється — відкрити знову
// може лише голова, з причиною в журналі дій.
// ============================================================
import { session } from './firebase.js';
import { escapeHtml, toast, setBusy, confirmDialog, promptDialog } from './ui.js';
import { loadJournal, journalAct, maskIban } from './buh-data.js';
import { fmtKop, toKop } from './charges-core.js';
import { loadOpening, openingAction, openingInput } from './buh-opening.js';
import { loadNotes } from './buh-accounting-notes.js';
import { openFlat } from './buh-flats.js';
import { openExpenses } from './buh-expenses.js';
import { openPayroll } from './buh-payroll.js';
import { openTxSheet } from './buh-chain.js';

const MONTHS = ['Січень', 'Лютий', 'Березень', 'Квітень', 'Травень', 'Червень', 'Липень', 'Серпень', 'Вересень', 'Жовтень', 'Листопад', 'Грудень'];
const monthTitle = p => `${MONTHS[Number(p.slice(5, 7)) - 1]} ${p.slice(0, 4)}`;
const human = d => String(d || '').split('-').reverse().join('.');
const ENTRIES_SHOWN = 200;

let period = null;          // null — місяць, який пропонує сервер
let ctx = null;
const open = new Set();     // розгорнуті рахунки
const allEntries = new Set();
let showOpening = null;     // null — показати, доки вхідну ОСВ не затверджено

/** Відкрити розділ на місяці (із «Вхідних»). */
export function openJournal(p) {
    if (p) period = p;
    if (location.hash !== '#journal') location.hash = 'journal';
    else loadJournalView();
}

const openingShown = () => showOpening ?? (ctx?.opening?.status !== 'approved');

/** Назва аналітики: квартира, рахунок банку, стаття, складова. */
function label(acc, a) {
    if (a === '' || a === undefined || a === null) return '—';
    if (acc === '377') return `кв. ${a}`;
    if (acc === '311') return /^UA\d{27}$/.test(a) ? `рахунок ${maskIban(a)}` : a;
    return ctx.labels?.[acc]?.[a] || a;
}

// data-l — підпис комірки, коли на телефоні таблиця стає картками.
const cell = (kop, label, cls = '') => `<td class="t-sum${cls ? ` ${cls}` : ''}${kop ? '' : ' is-zero'}" data-l="${label}">${kop ? fmtKop(kop) : ''}</td>`;
const sums = r => `${cell(r.openDr, 'Поч. Дт')}${cell(r.openCr, 'Поч. Кт')}${cell(r.dr, 'Обороти Дт', 'jr-turn')}${cell(r.cr, 'Обороти Кт', 'jr-turn')}${cell(r.closeDr, 'Кін. Дт')}${cell(r.closeCr, 'Кін. Кт')}`;

function checksHtml() {
    const icon = { block: '✕', warn: '!', ok: '✓' };
    return `<ul class="jr-checks">${ctx.checks.map(c => `<li class="is-${c.level}"><span aria-hidden="true">${icon[c.level]}</span>${escapeHtml(c.text)}</li>`).join('')}</ul>`;
}

function entryDrillAttr(e) {
    if (e.src === 'bank' && e.ref) return `data-act="open-entry" data-src="bank" data-ref="${escapeHtml(e.ref)}"`;
    if (e.src === 'expense' && e.ref) return `data-act="open-entry" data-src="expense" data-ref="${escapeHtml(e.ref)}"`;
    if (e.src === 'payroll') return `data-act="open-entry" data-src="payroll" data-ref="${escapeHtml(ctx.period)}"`;
    if (e.dr === '377' && e.dA) return `data-act="open-apt" data-apt="${escapeHtml(e.dA)}"`;
    if (e.cr === '377' && e.cA) return `data-act="open-apt" data-apt="${escapeHtml(e.cA)}"`;
    return '';
}

function entriesHtml(acc) {
    const list = ctx.entries.filter(e => e.dr === acc || e.cr === acc);
    const shown = allEntries.has(acc) ? list : list.slice(0, ENTRIES_SHOWN);
    return `<tr class="jr-entries"><td colspan="8">
        <table class="buh-table is-compact jr-journal"><thead><tr><th>Дата</th><th>Дебет</th><th>Кредит</th><th class="t-sum">Сума</th><th>Зміст і первинний документ</th></tr></thead>
        <tbody>${shown.map(e => {
            const attr = entryDrillAttr(e);
            const memo = escapeHtml(e.memo || 'Відкрити документ');
            return `<tr><td class="t-date">${escapeHtml(human(e.date))}</td>
            <td><b>${escapeHtml(e.dr)}</b> <small>${escapeHtml(label(e.dr, e.dA))}</small></td>
            <td><b>${escapeHtml(e.cr)}</b> <small>${escapeHtml(label(e.cr, e.cA))}</small></td>
            <td class="t-sum">${fmtKop(e.kop)}</td>
            <td class="t-muted">${memo}${attr ? ` <button type="button" class="btn-ghost-small" ${attr}>Відкрити ›</button>` : ''}</td></tr>`;
        }).join('')}</tbody></table>
        ${list.length > shown.length ? `<button type="button" class="btn-ghost-small" data-act="all-entries" data-acc="${escapeHtml(acc)}">Показати всі проводки (${list.length})</button>` : ''}
    </td></tr>`;
}

function tbHtml() {
    const tb = ctx.tb;
    if (!tb.rows.length) return '<section class="buh-card"><p class="list-empty">За цей місяць проводок немає</p></section>';
    const rows = tb.rows.map(r => {
        const isOpen = open.has(r.acc);
        return `<tr class="jr-acc${isOpen ? ' is-open' : ''}"><td><button type="button" class="jr-toggle" data-act="toggle" data-acc="${escapeHtml(r.acc)}" aria-expanded="${isOpen}">${escapeHtml(r.acc)}</button></td>
            <td class="t-main">${escapeHtml(r.name)}</td>${sums(r)}</tr>
            ${isOpen ? `${r.byA.length > 1 || (r.byA[0] && r.byA[0].a !== '') ? r.byA.map(x => `<tr class="jr-sub"><td></td><td>${r.acc === '377' && x.a ? `<button type="button" class="btn-ghost-small" data-act="open-apt" data-apt="${escapeHtml(x.a)}">${escapeHtml(label(r.acc, x.a))} ›</button>` : escapeHtml(label(r.acc, x.a))}</td>${sums(x)}</tr>`).join('') : ''}${entriesHtml(r.acc)}` : ''}`;
    }).join('');
    const t = tb.totals;
    return `<section class="buh-card jr-card">
        <div class="buh-card-head"><h2>Оборотно-сальдова відомість</h2><span>${tb.balanced ? 'Дебет = кредит' : '<b class="is-out">Дебет ≠ кредит</b>'}</span></div>
        <div class="jr-scroll"><table class="buh-table jr-table">
            <thead><tr><th rowspan="2">Рахунок</th><th rowspan="2">Назва</th><th colspan="2" class="t-sum">Сальдо на початок</th><th colspan="2" class="t-sum">Обороти</th><th colspan="2" class="t-sum">Сальдо на кінець</th></tr>
                <tr><th class="t-sum">Дт</th><th class="t-sum">Кт</th><th class="t-sum">Дт</th><th class="t-sum">Кт</th><th class="t-sum">Дт</th><th class="t-sum">Кт</th></tr></thead>
            <tbody>${rows}</tbody>
            <tfoot><tr><td></td><td>Разом</td>${sums({ openDr: t.openDr, openCr: t.openCr, dr: t.dr, cr: t.cr, closeDr: t.closeDr, closeCr: t.closeCr })}</tr></tfoot>
        </table></div>
        <p class="buh-note">Натисніть номер рахунку — аналітика (квартири, рахунки банку, статті) і проводки. Проводки будуються з операцій за правилами облікової політики; руками їх не вводять.</p>
    </section>`;
}

const csvMoney = kop => (kop / 100).toFixed(2).replace('.', ',');
const csvCell = v => (/[;"\r\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
function download(name, rows) {
    const blob = new Blob(['﻿' + rows.map(r => r.map(csvCell).join(';')).join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = name;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}
function csvTb() {
    const rows = [['Рахунок', 'Аналітика', 'Назва', 'Сальдо на початок Дт', 'Сальдо на початок Кт', 'Обороти Дт', 'Обороти Кт', 'Сальдо на кінець Дт', 'Сальдо на кінець Кт']];
    const nums = r => [r.openDr, r.openCr, r.dr, r.cr, r.closeDr, r.closeCr].map(csvMoney);
    for (const r of ctx.tb.rows) {
        rows.push([r.acc, '', r.name, ...nums(r)]);
        if (r.byA.length > 1 || (r.byA[0] && r.byA[0].a !== '')) r.byA.forEach(x => rows.push([r.acc, label(r.acc, x.a), '', ...nums(x)]));
    }
    rows.push(['', '', 'Разом', ...nums(ctx.tb.totals)]);
    download(`osv-${ctx.period}.csv`, rows);
}
function csvJournal() {
    const rows = [['Дата', 'Дебет', 'Аналітика Дт', 'Кредит', 'Аналітика Кт', 'Сума', 'Зміст', 'Джерело']];
    ctx.entries.forEach(e => rows.push([human(e.date), e.dr, label(e.dr, e.dA), e.cr, label(e.cr, e.cA), csvMoney(e.kop), e.memo || '', e.src]));
    download(`journal-${ctx.period}.csv`, rows);
}

export async function loadJournalView() {
    ctx = await loadJournal(period);
    period = ctx.period;
    const chair = session.role === 'chair';
    const closed = ctx.status === 'closed';
    const closing = ctx.status === 'closing';
    const last = ctx.history.at(-1);
    document.getElementById('viewJournal').innerHTML = `
        <div class="buh-toolbar">
            <select id="jrPeriod" class="field-input field-select ch-period" aria-label="Місяць">${ctx.periods.slice().reverse().map(p => `<option value="${p.id}"${p.id === ctx.period ? ' selected' : ''}>${monthTitle(p.id)}${p.status === 'closed' ? ' · закрито' : ''}</option>`).join('')}</select>
            <span class="buh-tag ${closed ? 'is-payment' : 'is-review'}">${closed ? 'закрито' : closing ? 'закривається' : 'відкритий'}</span>
            <span class="buh-note">${closed ? `Закрито ${escapeHtml(ctx.closedAt ? new Date(ctx.closedAt).toLocaleDateString('uk-UA') : '')}${ctx.closedBy ? ` · ${escapeHtml(ctx.closedBy)}` : ''}` : closing ? 'Дочекайтеся завершення перевірки місяця' : last?.action === 'reopen' ? `Відкрито знову: ${escapeHtml(last.reason || '')}` : 'Операції місяця ще можна змінювати'}</span>
            <span class="ch-tools">
                ${ctx.canClose ? '<button type="button" class="btn-primary btn-compact" data-act="close">Закрити місяць</button>' : ''}
                ${ctx.canReopen && chair ? '<button type="button" class="btn-ghost-small" data-act="reopen">Відкрити знову</button>' : ''}
                <button type="button" class="btn-ghost-small" data-act="opening" aria-expanded="${openingShown()}">Вхідна ОСВ${ctx.opening?.status === 'approved' ? '' : ' !'}</button>
                <button type="button" class="btn-ghost-small" data-act="csv-tb">ОСВ у CSV</button>
                <button type="button" class="btn-ghost-small" data-act="csv-journal">Журнал у CSV</button>
            </span>
        </div>
        <div class="kpi-grid">
            <div class="kpi"><span>Обороти за місяць</span><b>${fmtKop(ctx.tb.totals.dr)}</b><small>дебет = кредит${ctx.tb.balanced ? '' : ' — НІ'}</small></div>
            <div class="kpi"><span>Проводок</span><b>${ctx.entries.length}</b><small>з операцій місяця</small></div>
            <div class="kpi"><span>Поточні та депозитні рахунки</span><b>${fmtKop(ctx.tb.rows.filter(r=>['311','313','351','143'].includes(r.acc)).reduce((s,r)=>s+r.closeDr-r.closeCr,0))}</b><small>${ctx.opening?.status === 'approved' ? 'з погодженими вхідними залишками' : `рух з ${escapeHtml(ctx.startDate || ctx.start)}, без вхідних залишків`}</small></div>
            <div class="kpi"><span>Борг співвласників (377)</span><b class="is-out">${fmtKop(ctx.tb.rows.find(r => r.acc === '377')?.byA.reduce((s, x) => s + x.closeDr, 0) || 0)}</b><small>переплати — ${fmtKop(ctx.tb.rows.find(r => r.acc === '377')?.byA.reduce((s, x) => s + x.closeCr, 0) || 0)}</small></div>
        </div>
        ${!closed && ctx.bankRows?.length ? `<details class="buh-card"${ctx.bankCut?.key===ctx.key?'':' open'}><summary>Звірка з банком на кінець місяця</summary><p class="buh-note">Внесіть залишки з виписки на останній день цього місяця. Поточний залишок банку може належати іншій даті.</p>
            ${ctx.bankRows.map((r,i)=>`<label class="py-field"><span>…${escapeHtml(r.iban.slice(-4))} · ${r.acc} · в обліку ${fmtKop(r.balanceKop)} грн</span><input class="field-input" inputmode="decimal" data-jr-cut="${i}" placeholder="Залишок у виписці, грн" value="${ctx.bankCut?.key===ctx.key?(r.balanceKop/100).toFixed(2):''}"></label>`).join('')}
            <label class="py-field"><span>Реквізити виписки / підтвердження</span><input id="jrCutNote" class="field-input" maxlength="300" value="${escapeHtml(ctx.bankCut?.note || '')}"></label><button type="button" class="sv-btn is-soft" data-act="bank-cut">Звірити залишки</button></details>`:''}
        ${openingShown() ? '<div id="jrOpening"><section class="buh-card"><p class="list-empty">Завантаження вхідної ОСВ…</p></section></div>' : ''}
        <section class="buh-card"><div class="buh-card-head"><h2>${closed ? 'Стан' : 'Перед закриттям'}</h2></div>${checksHtml()}</section>
        ${tbHtml()}<div id="jrNotes"></div>`;
    const notesHost=document.getElementById('jrNotes');
    loadNotes(notesHost,ctx.period,ctx.policy?.funds || [{id:'main',name:'Основний фонд'}]).catch(err=>{if(notesHost.isConnected)notesHost.textContent=err.message;});
    if (openingShown()) loadOpening(document.getElementById('jrOpening')).catch(e => toast(e.message, 'error'));
    return 0;
}

async function onAction(btn) {
    const a = btn.dataset.act;
    try {
        if (a === 'toggle') {
            const acc = btn.dataset.acc;
            if (open.has(acc)) open.delete(acc); else open.add(acc);
            await loadJournalView();
            document.querySelector(`#viewJournal [data-act="toggle"][data-acc="${CSS.escape(acc)}"]`)?.focus();
        } else if (a === 'all-entries') { allEntries.add(btn.dataset.acc); await loadJournalView(); }
        else if (a === 'open-apt') { location.hash = 'flats'; setTimeout(() => openFlat(btn.dataset.apt), 0); }
        else if (a === 'open-entry') {
            const { src, ref } = btn.dataset;
            if (src === 'bank') openTxSheet(ref);
            else if (src === 'expense') openExpenses('docs', null, ref);
            else if (src === 'payroll') openPayroll(ref);
        }
        else if (a === 'opening') { showOpening = !openingShown(); await loadJournalView(); }
        else if (a === 'csv-tb') csvTb();
        else if (a === 'csv-journal') csvJournal();
        else if (a === 'bank-cut') {
            const rows=ctx.bankRows.map((r,i)=>({...r,balanceKop:toKop(document.querySelector(`[data-jr-cut="${i}"]`).value)}));
            await journalAct({action:'bankCut',period:ctx.period,rows,note:document.getElementById('jrCutNote').value});
            toast('Залишки банку звірено','success');
        }
        else if (a === 'close') {
            if (!await confirmDialog(`Закрити ${monthTitle(ctx.period).toLowerCase()}?`,
                'Після закриття операції цього місяця (нарахування, документи, рознесення виписки) змінити не можна. Відкрити знову може лише голова, з причиною.', 'Закрити')) return;
            setBusy(btn, true, 'Закриваю…');
            await journalAct({ action: 'close', period: ctx.period });
            toast(`${monthTitle(ctx.period)} закрито`, 'success');
        } else if (a === 'reopen') {
            const reason = await promptDialog(`Відкрити ${monthTitle(ctx.period).toLowerCase()} знову?`, 'Причина буде в журналі дій. Після виправлень місяць треба закрити ще раз.',
                { confirmLabel: 'Відкрити', placeholder: 'Наприклад: пізня комісія банку', maxLength: 300 });
            if (!reason) return;
            await journalAct({ action: 'reopen', period: ctx.period, reason });
            toast(`${monthTitle(ctx.period)} відкрито`, 'success');
        }
    } catch (e) { toast(e.message, 'error'); }
    finally { if (btn.isConnected) setBusy(btn, false); }
}

export function initJournalView() {
    const host = document.getElementById('viewJournal');
    host.addEventListener('click', async e => {
        const ob = e.target.closest('[data-ob]');
        if (ob && !ob.disabled) {
            // Після збереження розділ перемалюється сам (onChange) — лишаємо ОСВ відкритою.
            if (await openingAction(ob, document.getElementById('jrOpening'))) showOpening = true;
            return;
        }
        const btn = e.target.closest('[data-act]');
        if (btn && !btn.disabled) onAction(btn);
    });
    host.addEventListener('input', e => {
        if (e.target.closest('#jrOpening') && e.target.classList.contains('ob-sum')) openingInput(document.getElementById('jrOpening'));
    });
    host.addEventListener('change', e => {
        if (e.target.id === 'jrPeriod') { period = e.target.value; open.clear(); allEntries.clear(); loadJournalView(); }
    });
}
