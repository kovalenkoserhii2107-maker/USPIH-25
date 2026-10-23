// ============================================================
// «ОСВ»: оборотно-сальдова відомість за місяць, аналітика й проводки
// за рахунком, перевірки й закриття місяця.
//
// Проводки будує сервер з операцій (journalAction, journal-core.js):
// руками їх не вводять. Закритий місяць не змінюється — відкрити знову
// може лише голова, з причиною в журналі дій.
// Вхідна ОСВ на початок обліку винесена в «Налаштування → Стартові дані та база».
//
// Екран читається згори вниз: місяць і стан → чотири підсумки → що
// заважає закрити → сама відомість. Рахунки згруповані за змістом і
// мають підказку простими словами; аналітика й проводки розгортаються
// лише для рахунку, який відкрили.
// ============================================================
import { session } from './firebase.js';
import { escapeHtml, toast, setBusy, confirmDialog, promptDialog } from './ui.js';
import { loadJournal, journalAct, maskIban } from './buh-data.js';
import { fmtKop, toKop } from './charges-core.js';
import { loadNotes } from './buh-accounting-notes.js';
import { openFlat } from './buh-flats.js';
import { openExpenses } from './buh-expenses.js';
import { openPayroll } from './buh-payroll.js';
import { openTxSheet } from './buh-chain.js';
import { openAssets } from './buh-assets.js';
import { openAdvance } from './buh-advance.js';

const MONTHS = ['Січень', 'Лютий', 'Березень', 'Квітень', 'Травень', 'Червень', 'Липень', 'Серпень', 'Вересень', 'Жовтень', 'Листопад', 'Грудень'];
const monthTitle = p => `${MONTHS[Number(p.slice(5, 7)) - 1]} ${p.slice(0, 4)}`;
const human = d => String(d || '').split('-').reverse().join('.');
const ANALYTICS_SHOWN = 10;
const ENTRIES_STEP = 50;
const CASH = ['301', '311', '313', '351', '143'];
const ASSET_ACCS = ['10', '11', '131', '132', '20', '22'];

/** Групи рахунків у відомості — як їх пояснюють правлінню. */
const GROUPS = [
    { name: 'Майно ОСББ', accs: ['10', '11', '131', '132', '20', '22', '143'] },
    { name: 'Гроші', accs: ['301', '311', '313', '351'] },
    { name: 'Розрахунки', accs: ['361', '371', '372', '377', '378', '631', '641', '651', '661', '685'] },
    { name: 'Фонди й капітал', accs: ['40', '44', '48'] },
    { name: 'Доходи й витрати', accs: ['703', '719', '733', '79', '92'] },
    { name: 'Технічний', accs: ['00'] }
];
/** Що означає рахунок — одним рядком, без бухгалтерської мови. */
const HINTS = {
    '00': 'допоміжний рахунок для вхідних залишків',
    10: 'будівлі, обладнання, техніка',
    11: 'малоцінні необоротні активи',
    131: 'накопичений знос основних засобів',
    132: 'накопичений знос МНМА',
    143: 'довгостроковий депозит',
    20: 'матеріали й запчастини',
    22: 'інвентар і інструмент',
    301: 'готівка в касі',
    311: 'гроші на поточних рахунках у банку',
    313: 'депозитні рахунки',
    351: 'короткострокові вкладення',
    361: 'орендарі та інші покупці',
    371: 'передоплати постачальникам',
    372: 'гроші, видані під звіт',
    377: 'борги й переплати квартир',
    378: 'лікарняні від ПФУ',
    40: 'капітал ОСББ',
    44: 'результат минулих років',
    48: 'внески й фонди будинку',
    631: 'рахунки постачальників і підрядників',
    641: 'ПДФО й військовий збір',
    651: 'ЄСВ',
    661: 'зарплата й виплати за ЦПД',
    685: 'операції банку, які ще не розібрали',
    703: 'дохід від послуг',
    719: 'інші доходи: оренда, розміщення обладнання',
    733: 'відсотки банку',
    79: 'закриття доходів і витрат місяця',
    92: 'витрати на утримання будинку'
};
/** Куди перейти з рахунку, щоб побачити первинні дані. */
const LINKS = {
    '00': ['settings', 'Вхідна ОСВ', 'startup'],
    10: ['assets', 'Майно та ТМЦ'], 11: ['assets', 'Майно та ТМЦ'], 131: ['assets', 'Майно та ТМЦ'], 132: ['assets', 'Майно та ТМЦ'],
    20: ['assets', 'Майно та ТМЦ'], 22: ['assets', 'Майно та ТМЦ'],
    311: ['bank', 'Банк'], 313: ['bank', 'Банк'],
    372: ['advance', 'Авансові звіти'],
    377: ['flats', 'Квартири'],
    48: ['charges', 'Нарахування'],
    631: ['expenses', 'Документи'],
    641: ['payroll', 'Зарплата'], 651: ['payroll', 'Зарплата'], 661: ['payroll', 'Зарплата'],
    685: ['inbox', 'Рішення']
};

let period = null;          // null — місяць, який пропонує сервер
let ctx = null;
let wantedJournalFocus = null; // { acc, cashAcc, ref }
let query = '';
const open = new Set();         // розгорнуті рахунки
const allAnalytics = new Set(); // рахунки, де показано всю аналітику
const entriesShown = new Map(); // рахунок → скільки проводок показано (0 — сховано)

/** Відкрити розділ на місяці (із «Вхідних» або з модального вікна «Банку» з фокусом на проводці). */
export function openJournal(p, focusOpts = null) {
    if (p) period = p;
    if (focusOpts) {
        wantedJournalFocus = focusOpts;
        for (const acc of [focusOpts.acc, focusOpts.cashAcc].filter(Boolean).map(String)) {
            open.add(acc);
            entriesShown.set(acc, Infinity);
        }
    }
    if (location.hash !== '#journal') location.hash = 'journal';
    else loadJournalView();
}

/** Назва аналітики: квартира, рахунок банку, стаття, складова. */
function label(acc, a) {
    if (a === '' || a === undefined || a === null) return '—';
    if (acc === '377') return `кв. ${a}`;
    if (CASH.includes(acc)) return /^UA\d{27}$/.test(a) ? `рахунок ${maskIban(a)}` : a;
    return ctx.labels?.[acc]?.[a] || a;
}

const hasAnalytics = r => r.byA.length > 1 || (r.byA[0] && r.byA[0].a !== '');
const net = x => (x.closeDr || 0) - (x.closeCr || 0);

// data-l — підпис комірки, коли на телефоні таблиця стає картками.
const cell = (kop, l, cls = '') => `<td class="t-sum${cls ? ` ${cls}` : ''}${kop ? '' : ' is-zero'}" data-l="${l}">${kop ? fmtKop(kop) : ''}</td>`;
const sums = r => `${cell(r.openDr, 'Поч. Дт')}${cell(r.openCr, 'Поч. Кт')}${cell(r.dr, 'Обор. Дт', 'jr-turn')}${cell(r.cr, 'Обор. Кт', 'jr-turn')}${cell(r.closeDr, 'Кін. Дт', 'jr-close')}${cell(r.closeCr, 'Кін. Кт', 'jr-close')}`;

function checksHtml() {
    const icon = { block: '✕', warn: '!', ok: '✓' };
    const order = { block: 0, warn: 1, ok: 2 };
    const list = ctx.checks.slice().sort((a, b) => order[a.level] - order[b.level]);
    return `<ul class="jr-checks">${list.map(c => `<li class="is-${c.level}"><span aria-hidden="true">${icon[c.level]}</span>${escapeHtml(c.text)}</li>`).join('')}</ul>`;
}

function entryDrill(e) {
    if (e.src === 'bank' && e.ref) return { act: 'open-entry', src: 'bank', ref: e.ref };
    if (e.src === 'expense' && e.ref) return { act: 'open-entry', src: 'expense', ref: e.ref };
    if (e.src === 'advance_report' && e.ref) return { act: 'open-entry', src: 'advance', ref: e.ref };
    if (e.src === 'payroll') return { act: 'open-entry', src: 'payroll', ref: ctx.period };
    if (ASSET_ACCS.includes(e.dr) && e.dA) return { act: 'open-asset', asset: e.dA };
    if (ASSET_ACCS.includes(e.cr) && e.cA) return { act: 'open-asset', asset: e.cA };
    if (e.dr === '377' && e.dA) return { act: 'open-apt', apt: e.dA };
    if (e.cr === '377' && e.cA) return { act: 'open-apt', apt: e.cA };
    return null;
}
const drillAttr = d => (d ? Object.entries(d).map(([k, v]) => `data-${k === 'act' ? 'act' : k}="${escapeHtml(String(v))}"`).join(' ') : '');

function entriesHtml(acc) {
    const list = ctx.entries.filter(e => e.dr === acc || e.cr === acc);
    const limit = entriesShown.get(acc) || 0;
    if (!list.length) return '';
    if (!limit) {
        return `<tr class="jr-more"><td colspan="7"><button type="button" class="jr-link" data-act="entries" data-acc="${escapeHtml(acc)}">Проводки за рахунком · ${list.length} ▾</button></td></tr>`;
    }
    const shown = list.slice(0, limit);
    return `<tr class="jr-entries"><td colspan="7">
        <div class="jr-entries-head"><b>Проводки за рахунком ${escapeHtml(acc)}</b><span>${list.length}</span>
            <button type="button" class="jr-link" data-act="entries-hide" data-acc="${escapeHtml(acc)}">Сховати ▴</button></div>
        <table class="buh-table is-compact jr-journal"><thead><tr><th>Дата</th><th>Дебет</th><th>Кредит</th><th class="t-sum">Сума, грн</th><th>Зміст</th></tr></thead>
        <tbody>${shown.map(e => {
            const d = entryDrill(e);
            const side = e.dr === acc ? 'is-dr' : 'is-cr';
            return `<tr class="${d ? 'is-link ' : ''}${side}" data-entry-ref="${escapeHtml(e.ref || '')}" data-entry-acc="${escapeHtml(acc)}" ${drillAttr(d)}${d ? ' tabindex="0" title="Відкрити первинний документ"' : ''}>
            <td class="t-date">${escapeHtml(human(e.date))}</td>
            <td><b>${escapeHtml(e.dr)}</b> <small>${escapeHtml(label(e.dr, e.dA))}</small></td>
            <td><b>${escapeHtml(e.cr)}</b> <small>${escapeHtml(label(e.cr, e.cA))}</small></td>
            <td class="t-sum">${fmtKop(e.kop)}</td>
            <td class="t-muted jr-memo">${escapeHtml(e.memo || '')}${d ? '<span class="jr-go" aria-hidden="true">›</span>' : ''}</td></tr>`;
        }).join('')}</tbody></table>
        ${list.length > shown.length ? `<button type="button" class="jr-link" data-act="entries-more" data-acc="${escapeHtml(acc)}">Показати ще ${Math.min(ENTRIES_STEP, list.length - shown.length)} з ${list.length - shown.length}</button>` : ''}
    </td></tr>`;
}

function subRowHtml(acc, x) {
    const name = escapeHtml(label(acc, x.a));
    const btn = acc === '377' && x.a ? `<button type="button" class="jr-link" data-act="open-apt" data-apt="${escapeHtml(x.a)}">${name} ›</button>`
        : ASSET_ACCS.includes(acc) && x.a ? `<button type="button" class="jr-link" data-act="open-asset" data-asset="${escapeHtml(x.a)}">${name} ›</button>`
            : acc === '372' && x.a ? `<button type="button" class="jr-link" data-act="open-adv-person" data-person="${escapeHtml(x.a)}">${name} ›</button>` : name;
    return `<tr class="jr-sub"><td class="jr-sub-name">${btn}</td>${sums(x)}</tr>`;
}

/** Відбір за пошуком: рахунок, назва, підказка або аналітика (квартира, контрагент, IBAN). */
function filtered() {
    const q = query.trim().toLowerCase();
    return ctx.tb.rows.map(r => {
        if (!q) return { r, subs: r.byA, hit: false };
        const own = `${r.acc} ${r.name} ${HINTS[r.acc] || ''}`.toLowerCase().includes(q);
        const subs = r.byA.filter(x => `${label(r.acc, x.a)} ${x.a}`.toLowerCase().includes(q));
        if (own) return { r, subs: r.byA, hit: false };
        return subs.length ? { r, subs, hit: true } : null;
    }).filter(Boolean);
}

function accountHtml({ r, subs, hit }) {
    const isOpen = open.has(r.acc) || hit;
    const link = LINKS[r.acc];
    const closeNet = net(r);
    const balance = closeNet ? `<span class="jr-bal ${closeNet > 0 ? 'is-dr' : 'is-cr'}">${fmtKop(Math.abs(closeNet))} <small>${closeNet > 0 ? 'Дт' : 'Кт'}</small></span>` : '<span class="jr-bal">0,00</span>';
    let detail = '';
    if (isOpen) {
        const all = allAnalytics.has(r.acc) || hit;
        const sorted = subs.slice().sort((a, b) => Math.abs(net(b)) - Math.abs(net(a)) || (b.dr + b.cr) - (a.dr + a.cr));
        const shown = hasAnalytics(r) ? (all ? sorted : sorted.slice(0, ANALYTICS_SHOWN)) : [];
        detail = `${shown.map(x => subRowHtml(r.acc, x)).join('')}
            ${hasAnalytics(r) && sorted.length > shown.length ? `<tr class="jr-more"><td colspan="7"><button type="button" class="jr-link" data-act="all-analytics" data-acc="${escapeHtml(r.acc)}">Уся аналітика · ${sorted.length} ▾</button></td></tr>` : ''}
            ${link ? `<tr class="jr-more"><td colspan="7"><button type="button" class="jr-link" data-go="${link[0]}"${link[2] ? ` data-settings-tab="${link[2]}"` : ''}>Відкрити розділ «${escapeHtml(link[1])}» ›</button></td></tr>` : ''}
            ${entriesHtml(r.acc)}`;
    }
    return `<tr class="jr-acc${isOpen ? ' is-open' : ''}" data-acc-row="${escapeHtml(r.acc)}">
        <td class="jr-acc-cell"><button type="button" class="jr-toggle" data-act="toggle" data-acc="${escapeHtml(r.acc)}" aria-expanded="${isOpen}">
            <span class="jr-code">${escapeHtml(r.acc)}</span>
            <span class="jr-name">${escapeHtml(r.name)}${HINTS[r.acc] ? `<small>${escapeHtml(HINTS[r.acc])}</small>` : ''}</span>
            <span class="jr-chev" aria-hidden="true"></span>
        </button>${balance}</td>${sums(r)}</tr>${detail}`;
}

function tbBodyHtml() {
    const rows = filtered();
    if (!rows.length) return `<tbody><tr><td colspan="7" class="list-empty">Нічого не знайдено за «${escapeHtml(query)}»</td></tr></tbody>`;
    const byAcc = new Map(rows.map(x => [x.r.acc, x]));
    const known = new Set(GROUPS.flatMap(g => g.accs));
    const groups = [...GROUPS, { name: 'Інші', accs: rows.map(x => x.r.acc).filter(a => !known.has(a)) }];
    return groups.map(g => {
        const items = g.accs.map(a => byAcc.get(a)).filter(Boolean);
        if (!items.length) return '';
        return `<tbody class="jr-group"><tr class="jr-group-head"><th colspan="7" scope="rowgroup">${escapeHtml(g.name)}</th></tr>${items.map(accountHtml).join('')}</tbody>`;
    }).join('');
}

function tbHtml() {
    const tb = ctx.tb;
    if (!tb.rows.length) return '<section class="buh-card"><p class="list-empty">За цей місяць проводок немає</p></section>';
    const t = tb.totals;
    return `<section class="buh-card jr-card" id="jrTb">
        <div class="jr-tb-head">
            <div><h2>Оборотно-сальдова відомість</h2>
                <span class="jr-balanced ${tb.balanced ? 'is-ok' : 'is-bad'}">${tb.balanced ? '✓ Дебет = кредит' : '✕ Дебет ≠ кредит — перевірте проводки'}</span></div>
            <label class="jr-search"><span class="visually-hidden">Пошук у відомості</span>
                <input id="jrSearch" class="field-input" type="search" placeholder="Рахунок, квартира, контрагент…" value="${escapeHtml(query)}" autocomplete="off"></label>
        </div>
        <details class="jr-legend"><summary>Як читати відомість</summary>
            <ul>
                <li><b>Дебет (Дт)</b> — що ОСББ має або на що витратило: гроші, майно, борги квартир, витрати.</li>
                <li><b>Кредит (Кт)</b> — звідки кошти й кому ОСББ винне: внески й фонди, зарплата й податки до сплати, рахунки постачальників.</li>
                <li><b>Сальдо на кінець</b> = сальдо на початок + обороти Дт − обороти Кт. Праворуч від назви — підсумок на кінець місяця.</li>
                <li>Разом дебет завжди дорівнює кредиту. Натисніть рахунок — побачите аналітику (квартири, рахунки банку, контрагентів) і проводки з переходом до документа.</li>
            </ul>
        </details>
        <div class="jr-scroll"><table class="buh-table jr-table">
            <thead><tr><th rowspan="2" scope="col">Рахунок</th><th colspan="2" class="t-sum" scope="colgroup">Сальдо на початок</th><th colspan="2" class="t-sum jr-turn" scope="colgroup">Обороти за місяць</th><th colspan="2" class="t-sum jr-close" scope="colgroup">Сальдо на кінець</th></tr>
                <tr><th class="t-sum">Дт</th><th class="t-sum">Кт</th><th class="t-sum jr-turn">Дт</th><th class="t-sum jr-turn">Кт</th><th class="t-sum jr-close">Дт</th><th class="t-sum jr-close">Кт</th></tr></thead>
            ${tbBodyHtml()}
            <tfoot><tr><td>Разом</td>${sums({ openDr: t.openDr, openCr: t.openCr, dr: t.dr, cr: t.cr, closeDr: t.closeDr, closeCr: t.closeCr })}</tr></tfoot>
        </table></div>
        <p class="buh-note">Проводки будуються з операцій за правилами облікової політики; руками їх не вводять.</p>
    </section>`;
}

function summaryHtml() {
    const tb = ctx.tb;
    const cashRows = tb.rows.filter(r => CASH.includes(r.acc));
    const opening = ctx.opening?.status === 'approved';
    const cashIn = cashRows.reduce((s, r) => s + r.dr, 0);
    const cashOut = cashRows.reduce((s, r) => s + r.cr, 0);
    const cashEnd = cashRows.reduce((s, r) => s + net(r), 0);
    const r377 = tb.rows.find(r => r.acc === '377');
    const debt = r377?.byA.reduce((s, x) => s + x.closeDr, 0) || 0;
    const over = r377?.byA.reduce((s, x) => s + x.closeCr, 0) || 0;
    const debtors = r377?.byA.filter(x => x.closeDr > 0).length || 0;
    const blocks = ctx.checks.filter(c => c.level === 'block').length;
    const warns = ctx.checks.filter(c => c.level === 'warn').length;
    const closed = ctx.status === 'closed';
    const ready = closed ? { cls: 'is-good', b: 'Закрито', s: 'місяць захищено від змін' }
        : blocks ? { cls: 'is-bad', b: `${blocks} ${blocks === 1 ? 'перешкода' : blocks < 5 ? 'перешкоди' : 'перешкод'}`, s: `${warns ? `ще ${warns} попередж. · ` : ''}деталі нижче` }
            : { cls: 'is-good', b: 'Можна закривати', s: warns ? `${warns} попередж. — перегляньте` : 'усі перевірки пройдено' };
    return `<div class="jr-summary">
        <div class="jr-kpi"><span>Обороти за місяць</span><b>${fmtKop(tb.totals.dr)} <small>грн</small></b><small>${ctx.entries.length} проводок · ${tb.balanced ? 'дебет = кредит' : '<b class="is-out">дебет ≠ кредит</b>'}</small></div>
        <div class="jr-kpi">${opening
            ? `<span>Гроші на рахунках</span><b>${fmtKop(cashEnd)} <small>грн</small></b><small>на кінець місяця · надійшло ${fmtKop(cashIn)}</small>`
            : `<span>Рух грошей за місяць</span><b class="jr-flow"><i class="is-in">+${fmtKop(cashIn)}</i><i class="is-out">−${fmtKop(cashOut)}</i></b><small>залишки — після затвердження вхідної ОСВ</small>`}</div>
        <button type="button" class="jr-kpi is-action" data-go="flats"><span>Борг співвласників</span><b class="${debt ? 'is-out' : ''}">${fmtKop(debt)} <small>грн</small></b><small>${debtors} кв. з боргом · переплати ${fmtKop(over)}</small></button>
        <button type="button" class="jr-kpi is-action ${ready.cls}" data-act="to-checks"><span>Закриття місяця</span><b>${ready.b}</b><small>${ready.s}</small></button>
    </div>`;
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
        if (hasAnalytics(r)) r.byA.forEach(x => rows.push([r.acc, label(r.acc, x.a), '', ...nums(x)]));
    }
    rows.push(['', '', 'Разом', ...nums(ctx.tb.totals)]);
    download(`osv-${ctx.period}.csv`, rows);
}
function csvJournal() {
    const rows = [['Дата', 'Дебет', 'Аналітика Дт', 'Кредит', 'Аналітика Кт', 'Сума', 'Зміст', 'Джерело']];
    ctx.entries.forEach(e => rows.push([human(e.date), e.dr, label(e.dr, e.dA), e.cr, label(e.cr, e.cA), csvMoney(e.kop), e.memo || '', e.src]));
    download(`journal-${ctx.period}.csv`, rows);
}

/** Перемалювати лише відомість — пошук і розгортання не скидають прокрутку й фокус. */
function redrawTb(focusSel) {
    const host = document.getElementById('jrTb');
    if (!host) return;
    const searchFocused = document.activeElement?.id === 'jrSearch';
    const caret = searchFocused ? document.activeElement.selectionStart : null;
    host.outerHTML = tbHtml();
    if (searchFocused) {
        const input = document.getElementById('jrSearch');
        input.focus();
        if (caret !== null) input.setSelectionRange(caret, caret);
    } else if (focusSel) document.querySelector(focusSel)?.focus();
}

export async function loadJournalView() {
    ctx = await loadJournal(period);
    period = ctx.period;
    if (wantedJournalFocus) {
        const acc = [wantedJournalFocus.acc, wantedJournalFocus.cashAcc].find(a => a && ctx.tb.rows.some(r => r.acc === a));
        if (acc) { open.add(acc); entriesShown.set(acc, Infinity); }
    }
    const chair = session.role === 'chair';
    const closed = ctx.status === 'closed';
    const closing = ctx.status === 'closing';
    const last = ctx.history.at(-1);
    const ids = ctx.periods.map(p => p.id);
    const idx = ids.indexOf(ctx.period);
    const prev = idx > 0 ? ids[idx - 1] : null;
    const next = idx >= 0 && idx < ids.length - 1 ? ids[idx + 1] : null;
    const statusNote = closed ? `Закрито ${escapeHtml(ctx.closedAt ? new Date(ctx.closedAt).toLocaleDateString('uk-UA', { timeZone: 'Europe/Kyiv' }) : '')}${ctx.closedBy ? ` · ${escapeHtml(ctx.closedBy)}` : ''}`
        : closing ? 'Дочекайтеся завершення перевірки місяця'
            : last?.action === 'reopen' ? `Відкрито знову: ${escapeHtml(last.reason || '')}` : 'Операції місяця ще можна змінювати';
    const blocks = ctx.checks.filter(c => c.level === 'block').length;

    document.getElementById('viewJournal').innerHTML = `
        <div class="jr-head">
            <div class="jr-period">
                <button type="button" class="jr-step" data-act="period" data-period="${prev || ''}" aria-label="Попередній місяць"${prev ? '' : ' disabled'}>‹</button>
                <select id="jrPeriod" class="field-input field-select" aria-label="Місяць">${ctx.periods.slice().reverse().map(p => `<option value="${p.id}"${p.id === ctx.period ? ' selected' : ''}>${monthTitle(p.id)}${p.status === 'closed' ? ' · закрито' : ''}</option>`).join('')}</select>
                <button type="button" class="jr-step" data-act="period" data-period="${next || ''}" aria-label="Наступний місяць"${next ? '' : ' disabled'}>›</button>
                <span class="buh-tag ${closed ? 'is-payment' : 'is-review'}">${closed ? '🔒 закрито' : closing ? 'закривається' : 'відкритий'}</span>
                <span class="jr-status-note">${statusNote}</span>
            </div>
            <div class="jr-actions">
                ${ctx.canClose ? '<button type="button" class="btn-primary btn-compact" data-act="close">Закрити місяць</button>' : ''}
                ${ctx.canReopen && chair ? '<button type="button" class="btn-ghost-small" data-act="reopen">Відкрити знову</button>' : ''}
                <details class="jr-menu"><summary class="btn-ghost-small">Експорт ▾</summary>
                    <div class="jr-menu-list">
                        <button type="button" data-act="csv-tb">ОСВ у CSV (Excel)</button>
                        <button type="button" data-act="csv-journal">Журнал проводок у CSV</button>
                    </div>
                </details>
            </div>
        </div>
        ${summaryHtml()}
        ${ctx.opening?.status !== 'approved' ? `<div class="jr-alert">
            <span class="jr-alert-ico" aria-hidden="true">!</span>
            <p><b>Вхідна ОСВ на початок обліку не затверджена.</b> Без неї залишки рахунків показують лише рух від ${escapeHtml(human(ctx.startDate || ctx.start))}.</p>
            <button type="button" class="btn-ghost-small" data-go="settings" data-settings-tab="startup">Заповнити ›</button>
        </div>` : ''}
        <section class="buh-card jr-checks-card" id="jrChecks">
            <div class="buh-card-head"><h2>${closed ? 'Стан місяця' : 'Перед закриттям'}</h2><span>${closed ? '' : blocks ? `${blocks} блокує` : 'усе гаразд'}</span></div>
            ${checksHtml()}
            ${!closed && ctx.bankRows?.length ? `<details class="jr-cut"${ctx.bankCut?.key === ctx.key || ctx.opening?.status !== 'approved' ? '' : ' open'}><summary>Звірка з банком на кінець місяця${ctx.bankCut?.key === ctx.key ? ' · ✓ звірено' : ''}</summary>
                <p class="buh-note">Внесіть залишки з виписки на останній день цього місяця. Поточний залишок банку може належати іншій даті.</p>
                <div class="jr-cut-grid">${ctx.bankRows.map((r, i) => `<label class="py-field"><span>…${escapeHtml(r.iban.slice(-4))} · ${r.acc} · в обліку ${fmtKop(r.balanceKop)} грн</span><input class="field-input" inputmode="decimal" data-jr-cut="${i}" placeholder="Залишок у виписці, грн" value="${ctx.bankCut?.key === ctx.key ? (r.balanceKop / 100).toFixed(2) : ''}"></label>`).join('')}
                <label class="py-field"><span>Реквізити виписки / підтвердження</span><input id="jrCutNote" class="field-input" maxlength="300" value="${escapeHtml(ctx.bankCut?.note || '')}"></label></div>
                <button type="button" class="sv-btn is-soft" data-act="bank-cut">Звірити залишки</button></details>` : ''}
        </section>
        ${tbHtml()}<div id="jrNotes"></div>`;
    const notesHost = document.getElementById('jrNotes');
    loadNotes(notesHost, ctx.period, ctx.policy?.funds || [{ id: 'main', name: 'Основний фонд' }]).catch(err => { if (notesHost.isConnected) notesHost.textContent = err.message; });

    if (wantedJournalFocus) {
        const focus = wantedJournalFocus;
        wantedJournalFocus = null;
        setTimeout(() => {
            const targetEl = (focus.ref && document.querySelector(`#viewJournal tr[data-entry-ref="${CSS.escape(focus.ref)}"]`))
                || (focus.acc && document.querySelector(`#viewJournal tr[data-acc-row="${CSS.escape(focus.acc)}"]`))
                || (focus.cashAcc && document.querySelector(`#viewJournal tr[data-acc-row="${CSS.escape(focus.cashAcc)}"]`));
            if (targetEl) {
                targetEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
                targetEl.classList.add('buh-nav-target-highlight');
                setTimeout(() => targetEl.classList.remove('buh-nav-target-highlight'), 3000);
            }
        }, 80);
    }
    return 0;
}

function openEntry(el) {
    const a = el.dataset.act;
    if (a === 'open-apt') { location.hash = 'flats'; setTimeout(() => openFlat(el.dataset.apt), 0); }
    else if (a === 'open-asset') openAssets('all', el.dataset.asset);
    else if (a === 'open-adv-person') openAdvance('all');
    else if (a === 'open-entry') {
        const { src, ref } = el.dataset;
        if (src === 'bank') openTxSheet(ref);
        else if (src === 'expense') openExpenses('docs', null, ref);
        else if (src === 'advance') openAdvance('all', ref);
        else if (src === 'payroll') openPayroll(ref);
    }
}

async function onAction(btn) {
    const a = btn.dataset.act;
    const acc = btn.dataset.acc;
    const accSel = sel => `#viewJournal [data-act="${sel}"][data-acc="${CSS.escape(acc)}"]`;
    try {
        if (a === 'toggle') {
            if (open.has(acc)) open.delete(acc); else open.add(acc);
            redrawTb(accSel('toggle'));
        } else if (a === 'all-analytics') { allAnalytics.add(acc); redrawTb(accSel('toggle')); }
        else if (a === 'entries') { entriesShown.set(acc, ENTRIES_STEP); redrawTb(accSel('entries-hide')); }
        else if (a === 'entries-more') { entriesShown.set(acc, (entriesShown.get(acc) || 0) + ENTRIES_STEP); redrawTb(accSel('entries-more')); }
        else if (a === 'entries-hide') { entriesShown.delete(acc); redrawTb(accSel('entries')); }
        else if (a === 'period') {
            if (!btn.dataset.period) return;
            period = btn.dataset.period; open.clear(); allAnalytics.clear(); entriesShown.clear();
            await loadJournalView();
        }
        else if (a === 'to-checks') document.getElementById('jrChecks')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        else if (['open-apt', 'open-asset', 'open-adv-person', 'open-entry'].includes(a)) openEntry(btn);
        else if (a === 'csv-tb') { csvTb(); btn.closest('details')?.removeAttribute('open'); }
        else if (a === 'csv-journal') { csvJournal(); btn.closest('details')?.removeAttribute('open'); }
        else if (a === 'bank-cut') {
            const rows = ctx.bankRows.map((r, i) => ({ ...r, balanceKop: toKop(document.querySelector(`[data-jr-cut="${i}"]`).value) }));
            await journalAct({ action: 'bankCut', period: ctx.period, rows, note: document.getElementById('jrCutNote').value });
            toast('Залишки банку звірено', 'success');
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
    finally { if (btn.isConnected && btn.tagName === 'BUTTON' && btn.dataset.busy) setBusy(btn, false); }
}

export function initJournalView() {
    const host = document.getElementById('viewJournal');
    host.addEventListener('click', e => {
        const btn = e.target.closest('[data-act]');
        if (btn && !btn.disabled && host.contains(btn)) onAction(btn);
    });
    host.addEventListener('keydown', e => {
        // Рядок проводки відкривається з клавіатури, як і кліком.
        const row = e.target.closest?.('tr[data-act]');
        if (row && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); onAction(row); }
    });
    host.addEventListener('change', e => {
        if (e.target.id === 'jrPeriod') { period = e.target.value; open.clear(); allAnalytics.clear(); entriesShown.clear(); loadJournalView(); }
    });
    host.addEventListener('input', e => {
        if (e.target.id !== 'jrSearch') return;
        query = e.target.value;
        redrawTb();
    });
}
