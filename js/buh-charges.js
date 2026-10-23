// ============================================================
// «Нарахування» — внески співвласників помісячно.
// Вгорі: місяць, що зробити зараз і підсумки збору (нараховано, сплачено,
// борг, переплати). Нижче вкладки:
//   «Розрахунок»  — з чого складається внесок місяця, пропущені приміщення,
//                   нараховані місяці;
//   «Відомість»   — розрахунки з кожною квартирою, квитанції з QR, CSV;
//   «Тарифи»      — матриця «складова × група» з історією й новим тарифом;
//   «Приміщення»  — площа, проживаючі й група кожного приміщення.
// Рядок приміщення відкриває його картку збоку.
//
// Рахує й записує сервер (chargesAction): він же перераховує баланси
// квартир і пише журнал дій. Вхідні залишки — у «Налаштування → Перехід на облік».
// ============================================================
import { escapeHtml, toast, setBusy, confirmDialog } from './ui.js';
import { loadCharges, loadStatement, loadRequisites, chargeAct, chargesPeek, dateOnly, loadStaffNames, authorLabel } from './buh-data.js';
import { periodName, periodStart, periodsBetween, shiftPeriod, fmtKop, statementCsv, receiptPurpose } from './charges-core.js';
import { nextChargesAction, collectionStats, rowState, filterStatement, tariffCell } from './charges-view-core.js';
import { paymentLinks } from './nbu-qr.js';
import { openFlat } from './buh-flats.js';
import { openClaimCase } from './buh-claims.js';

const TABS = { calc: 'Розрахунок', statement: 'Відомість', tariffs: 'Тарифи', premises: 'Приміщення' };
const LEGACY = { month: 'calc' };
let tab = 'calc';
let period = null;
let ctx = null;
let names = {};
let stFilter = 'all';
let stQuery = '';
let prFilter = 'all';
let prQuery = '';
let sheet = null;               // { kind: 'apt', apt } | { kind: 'tariff', group, component }
const previews = new Map();     // розрахунок інших місяців: period → preview

const groupName = id => ctx.groups.find(g => g.id === id)?.name || 'Квартири';
const compName = id => (ctx.components || []).find(c => c.id === (id || 'main'))?.name || 'Утримання будинку';
const rate = r4 => (r4 / 10000).toLocaleString('uk-UA', { minimumFractionDigits: 2, maximumFractionDigits: 4 });
const area = v => String(v ?? '').replace('.', ',');
const areaSum = centi => (centi / 100).toLocaleString('uk-UA', { maximumFractionDigits: 2 });
/** «з жовтня 2026». */
const since = p => periodStart(p).slice(3);
const cap = s => s.charAt(0).toUpperCase() + s.slice(1);
const grn = kop => `${fmtKop(kop)} грн`;
const unit = base => (base === 'fixed' ? 'грн з прим.' : base === 'residents' ? 'грн/прож.' : 'грн/м²');
const chip = ([t, c]) => `<span class="sv-chip ${c}">${escapeHtml(t)}</span>`;
const signed = kop => `<span class="cg-num${kop < 0 ? ' is-out' : kop > 0 ? ' is-in' : ''}">${fmtKop(kop)}</span>`;
const val = id => document.getElementById(id)?.value?.trim() || '';

/** Відкрити розділ одразу на потрібній вкладці (із «Вхідних», «Квартир», «Налаштувань»). */
export function openCharges(seg = 'calc') {
    if (seg === 'opening') {
        try { sessionStorage.setItem('buh_settings_tab', 'startup'); } catch { /* ignore */ }
        location.hash = 'settings';
        return;
    }
    tab = TABS[LEGACY[seg] || seg] ? LEGACY[seg] || seg : 'calc';
    if (location.hash !== '#charges') location.hash = 'charges';
    else loadChargesView();
}

// ------------------------------------------------------------
// ДАНІ МІСЯЦЯ
// ------------------------------------------------------------
async function previewFor(p) {
    if (p === ctx.preview.period) return ctx.preview;
    if (p > ctx.current) return null;
    if (!previews.has(p)) previews.set(p, await chargesPeek({ action: 'preview', period: p }).catch(() => null));
    return previews.get(p);
}

/** Розбивка нарахування: складова × група × тариф. */
function groupsBreakdown(rows) {
    const by = new Map();
    for (const r of rows) {
        for (const p of r.parts?.length ? r.parts : [{ component: 'main', name: 'Утримання будинку', base: 'area', rate4: r.rate4, amountKop: r.amountKop }]) {
            const key = `${p.component}:${r.group}:${p.rate4}`;
            const g = by.get(key) || { component: p.component, name: p.name, base: p.base, group: r.group, rate4: p.rate4, count: 0, area: 0, residents: 0, total: 0 };
            g.count += 1; g.area += r.areaCenti || 0; g.residents += Number(r.residents) || 0; g.total += p.amountKop;
            by.set(key, g);
        }
    }
    return [...by.values()];
}

// ------------------------------------------------------------
// ВЕРХ РОЗДІЛУ
// ------------------------------------------------------------
function headHtml(run) {
    const periods = periodsBetween(ctx.startPeriod, ctx.current);
    const idx = periods.indexOf(period);
    const state = run ? (run.problems?.length ? ['нараховано частково', 'is-work'] : ['нараховано', 'is-done'])
        : ctx.due.includes(period) ? ['не нараховано', 'is-bad'] : period === ctx.current ? ['місяць триває', ''] : ['не нараховано', 'is-work'];
    return `<div class="cg-head">
        <button type="button" class="cg-step" data-period-step="1" aria-label="Попередній місяць"${idx >= periods.length - 1 ? ' disabled' : ''}>‹</button>
        <select id="cgPeriod" class="cg-period" aria-label="Місяць">${periods.map(p => `<option value="${p}"${p === period ? ' selected' : ''}>${escapeHtml(cap(periodName(p)))}</option>`).join('')}</select>
        <button type="button" class="cg-step" data-period-step="-1" aria-label="Наступний місяць"${idx <= 0 ? ' disabled' : ''}>›</button>
        ${chip(state)}
        ${run ? `<span class="cg-run-meta">${escapeHtml([run.at ? dateOnly(run.at) : '', authorLabel(names, run.by), run.recalculated ? `перераховано ${run.recalculated} р.` : ''].filter(Boolean).join(' · '))}</span>` : ''}
    </div>`;
}

function nextHtml(n) {
    const btn = n.btn ? (n.act ? `<button type="button" class="sv-btn" data-act="${n.act}" data-period="${period}">${escapeHtml(n.btn)}${n.key ? '<kbd>Enter</kbd>' : ''}</button>`
        : n.tab ? `<button type="button" class="sv-btn" data-tab="${n.tab}">${escapeHtml(n.btn)}</button>`
        : n.go ? `<button type="button" class="sv-btn" data-go="${n.go}" data-settings-tab="startup">${escapeHtml(n.btn)}</button>` : '') : '';
    return `<section class="cg-next is-${n.tone}">
        <span class="cg-next-icon" aria-hidden="true">${{ todo: '→', wait: '…', done: '✓', bad: '!' }[n.tone]}</span>
        <div class="cg-next-copy"><b>${escapeHtml(n.title)}</b><span>${escapeHtml(n.hint || '')}</span></div>
        ${btn ? `<div class="cg-next-actions">${btn}</div>` : ''}
    </section>`;
}

function kpisHtml(run, preview, s) {
    const charged = run ? run.totalKop : preview?.totalKop || 0;
    return `<div class="cg-kpis">
        <button type="button" class="cg-kpi" data-tab="calc"><span>${run ? 'Нараховано' : 'Буде нараховано'}</span><b>${fmtKop(charged)} <small>грн</small></b>
            <small>${run ? `${run.count} прим.` : `${preview?.rows?.length || 0} прим. за чинними тарифами`}</small></button>
        <button type="button" class="cg-kpi" data-tab="statement" data-filter="all"><span>Сплачено за місяць</span><b>${fmtKop(s.paidKop)} <small>грн</small></b>
            <small>${s.chargedKop ? `${s.pct}% нарахованого · ${s.paidCount} кв.` : 'ще нічого не нараховано'}</small>${s.chargedKop ? `<i class="cg-bar"><i style="width:${Math.min(100, s.pct)}%"></i></i>` : ''}</button>
        <button type="button" class="cg-kpi${s.debtors ? ' is-bad' : ''}" data-tab="statement" data-filter="debt"><span>Борг на кінець місяця</span><b>${fmtKop(s.debtKop)} <small>грн</small></b>
            <small>${s.debtors ? `${s.debtors} кв. · з них ${(ctx._deep || 0)} понад 3 внески` : 'боржників немає'}</small></button>
        <button type="button" class="cg-kpi" data-tab="statement" data-filter="over"><span>Переплати</span><b>${fmtKop(s.overKop)} <small>грн</small></b>
            <small>${s.overCount ? `${s.overCount} кв. — зарахуються в наступні місяці` : 'переплат немає'}</small></button>
    </div>`;
}

function tabsHtml(st, preview) {
    const problems = (preview?.problems || []).length;
    const counts = { calc: '', statement: st?.rows?.length || '', tariffs: ctx.tariffs.length || '', premises: problems ? `!${problems}` : ctx.apartments.length };
    return `<div class="cg-tabs" role="tablist">${Object.entries(TABS).map(([k, v]) =>
        `<button type="button" role="tab" class="cg-tab${k === tab ? ' is-active' : ''}" aria-selected="${k === tab}" data-tab="${k}">${v}${counts[k] !== '' ? `<small${String(counts[k]).startsWith('!') ? ' class="is-bad" title="Приміщення з помилками"' : ''}>${String(counts[k]).replace('!', '')}</small>` : ''}</button>`).join('')}
        <button type="button" class="cg-tab-link" data-go="settings" data-settings-tab="startup">Вхідні залишки ›</button></div>`;
}

// ------------------------------------------------------------
// РОЗРАХУНОК
// ------------------------------------------------------------
function calcPane(run, preview) {
    const groups = groupsBreakdown(preview?.rows || []);
    const byComp = new Map();
    for (const g of groups) byComp.set(g.component, [...(byComp.get(g.component) || []), g]);
    const compTotal = list => list.reduce((s, g) => s + g.total, 0);
    const lastRun = ctx.runs[0]?.period;
    const problems = preview?.problems || [];
    return `<section class="py-card cg-card">
            <div class="cg-card-head"><h2>З чого складається внесок</h2>
                <span class="py-muted">${run ? 'за поточними тарифами й площами' : `за ${escapeHtml(periodName(period))}`}</span></div>
            ${groups.length ? [...byComp.entries()].map(([comp, list]) => `<div class="cg-comp">
                <div class="cg-comp-head"><b>${escapeHtml(list[0].name || compName(comp))}</b><b class="cg-num">${grn(compTotal(list))}</b></div>
                ${list.map(g => `<div class="cg-comp-row"><span>${escapeHtml(groupName(g.group))} · ${g.count} прим.</span>
                    <span class="py-muted">${g.base === 'fixed' ? `${g.count} × ${rate(g.rate4)} грн` : g.base === 'residents' ? `${g.residents} прож. × ${rate(g.rate4)} грн` : `${areaSum(g.area)} м² × ${rate(g.rate4)} грн`}</span>
                    <span class="cg-num">${list.length > 1 ? grn(g.total) : ''}</span></div>`).join('')}
            </div>`).join('') : '<p class="py-empty">Немає що нараховувати: внесіть тарифи й площі приміщень</p>'}
            <div class="cg-total"><span>Разом за місяць</span><b>${grn(preview?.totalKop || 0)}</b></div>
            ${run ? `<div class="cg-actions">
                <button type="button" class="sv-btn is-soft" data-act="recalc" data-period="${period}">Перерахувати</button>
                ${lastRun === period ? `<button type="button" class="sv-btn is-soft" data-act="revert" data-period="${period}">Скасувати нарахування</button>` : ''}
                <button type="button" class="sv-btn is-soft" data-act="receipts">Квитанції за місяць</button></div>` : ''}
        </section>
        ${problems.length ? `<section class="py-card cg-card"><div class="cg-card-head"><h2>Не нараховується: ${problems.length} прим.</h2></div>
            <div class="cg-problems">${problems.slice(0, 80).map(x => `<button type="button" class="cg-problem" data-apt="${escapeHtml(x.apt)}"><b>${escapeHtml(x.apt)}</b><span>${escapeHtml(x.reason)}</span></button>`).join('')}</div>
            <p class="py-note">Площу вносить правління в довіднику квартир; групу, проживаючих і тарифи — тут, на вкладках поруч.</p></section>` : ''}
        <section class="py-card cg-card"><div class="cg-card-head"><h2>Нараховані місяці</h2></div>
            ${ctx.runs.length ? ctx.runs.map(r => `<button type="button" class="cg-run${r.period === period ? ' is-current' : ''}" data-goto="${r.period}">
                <span><b>${escapeHtml(cap(periodName(r.period)))}</b><small>${escapeHtml([authorLabel(names, r.by), r.at ? dateOnly(r.at) : ''].filter(Boolean).join(' · '))}</small></span>
                <span class="py-muted">${r.count} прим.${r.problems.length ? ` · ${r.problems.length} пропущено` : ''}</span>
                <b class="cg-num">${grn(r.totalKop)}</b></button>`).join('') : '<p class="py-empty">Ще нічого не нараховано</p>'}
            ${ctx.due.filter(p => p !== period).length ? `<p class="py-note">Ще не нараховано: ${ctx.due.filter(p => p !== period).map(p => `<button type="button" class="cg-link" data-goto="${p}">${escapeHtml(periodName(p))}</button>`).join(', ')}</p>` : ''}
        </section>`;
}

// ------------------------------------------------------------
// ВІДОМІСТЬ
// ------------------------------------------------------------
function statementPane(st) {
    if (!st) return '<section class="py-card"><p class="py-empty">Відомість за цей місяць ще не готова</p></section>';
    const rows = filterStatement(st.rows, stFilter, stQuery);
    const comps = (st.components || []).filter(c => st.byComponent?.[c.id]);
    const n = f => filterStatement(st.rows, f).length;
    const t = st.totals;
    return `<div class="cg-bar-row">
            <div class="cg-chips" role="group">${[['all', 'Усі', st.rows.length], ['debt', 'Борг', n('debt')], ['deep', 'Борг понад 3 внески', n('deep')], ['unpaid', 'Не платили цього місяця', n('unpaid')], ['over', 'Переплата', n('over')]].map(([k, v, c]) =>
                `<button type="button" class="cg-chip${k === stFilter ? ' is-active' : ''}" data-filter="${k}">${v} <small>${c}</small></button>`).join('')}</div>
            <label class="fl-search cg-search"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>
                <input type="search" id="cgStQuery" placeholder="Номер квартири" value="${escapeHtml(stQuery)}" aria-label="Номер квартири"></label>
            <span class="cg-tools"><button type="button" class="sv-btn is-soft" data-act="receipts">Квитанції${rows.length !== st.rows.length ? ` (${rows.length})` : ''}</button>
                <button type="button" class="sv-btn is-soft" data-act="csv">CSV для Excel</button></span>
        </div>
        ${!st.opening ? '<p class="cg-warn">Вхідні залишки ще не внесено — колонка «на початок» неповна. <button type="button" class="cg-link" data-go="settings" data-settings-tab="startup">Внести в «Налаштуваннях» ›</button></p>' : ''}
        ${comps.length > 1 ? `<details class="py-card cg-card cg-comps"><summary>За статтями внеску <small>${comps.length}</small></summary>
            <div class="cg-st cg-st-comps"><div class="cg-st-head"><span>Стаття</span><span>На початок</span><span>Нараховано</span><span>Сплачено</span><span>На кінець</span></div>
            ${comps.map(c => { const b = st.byComponent[c.id]; return `<div class="cg-st-row is-static"><span>${escapeHtml(c.name)}</span>${signed(b.opening)}<span class="cg-num">${fmtKop(b.charged)}</span><span class="cg-num is-in">${fmtKop(b.paid)}</span>${signed(b.closing)}</div>`; }).join('')}</div></details>` : ''}
        <section class="py-card cg-card cg-st">
            <div class="cg-st-head" aria-hidden="true"><span>Квартира</span><span>На початок</span><span>Нараховано</span><span>Сплачено</span><span>На кінець</span><span>Стан</span></div>
            ${rows.length ? rows.map(r => `<button type="button" class="cg-st-row" data-apt="${escapeHtml(r.apt)}">
                <span class="cg-apt"><b>${escapeHtml(r.apt)}</b></span>
                <span data-l="На початок">${signed(r.opening)}</span><span data-l="Нараховано"><span class="cg-num">${fmtKop(r.charged)}</span></span>
                <span data-l="Сплачено"><span class="cg-num${r.paid > 0 ? ' is-in' : ''}">${fmtKop(r.paid)}</span></span><span data-l="На кінець" class="is-strong">${signed(r.closing)}</span>
                <span class="cg-state">${chip(rowState(r))}</span></button>`).join('') : '<p class="py-empty">Нічого не знайдено</p>'}
            ${rows.length === st.rows.length ? `<div class="cg-st-foot"><span>Разом</span>${signed(t.opening)}<span class="cg-num">${fmtKop(t.charged)}</span><span class="cg-num is-in">${fmtKop(t.paid)}</span>${signed(t.closing)}<span></span></div>` : ''}
        </section>
        <p class="py-note cg-help">Мінус — борг, плюс — переплата. Оплати з виписки банку потрапляють сюди одразу після рознесення. Борг понад 3 місячні внески — підстава для претензії.</p>`;
}

// ------------------------------------------------------------
// ТАРИФИ
// ------------------------------------------------------------
function tariffsPane() {
    const comps = ctx.components || [];
    return `<section class="py-card cg-card">
            <div class="cg-card-head"><h2>Тарифи на ${escapeHtml(periodName(period))}</h2>
                <button type="button" class="sv-btn" data-act="tariff-new">+ Тариф</button></div>
            <div class="cg-matrix" style="--cols:${ctx.groups.length}">
                <div class="cg-mx-head"><span>Складова внеску</span>${ctx.groups.map(g => `<span>${escapeHtml(g.name)}</span>`).join('')}</div>
                ${comps.map(c => `<div class="cg-mx-row"><span class="cg-mx-name"><b>${escapeHtml(c.name)}</b><small>${escapeHtml(unit(c.base))}</small></span>
                    ${ctx.groups.map(g => { const cell = tariffCell(ctx.tariffs, g.id, c.id, period);
                        return `<button type="button" class="cg-mx-cell${cell.current ? '' : ' is-empty'}" data-tariff="${escapeHtml(g.id)}" data-component="${escapeHtml(c.id)}" aria-label="${escapeHtml(`${c.name}, ${g.name}`)}">
                            ${cell.current ? `<b>${rate(cell.current.rate4)}</b><small>з ${escapeHtml(since(cell.current.from))}</small>` : '<b>—</b><small>не нараховується</small>'}
                            ${cell.next ? `<span class="cg-mx-next">з ${escapeHtml(since(cell.next.from))}: ${rate(cell.next.rate4)}</span>` : ''}</button>`; }).join('')}</div>`).join('')}
            </div>
            <p class="py-note">Клітинка відкриває історію тарифу й форму нового. «—» — складова цій групі не нараховується (напр. ліфти нежитловим приміщенням). Новий тариф діє з указаного місяця, попередні нарахування не змінюються. Окремий тариф для нежитлових — лише за рішенням загальних зборів (статут, п. 4.4).</p>
        </section>
        <section class="py-card cg-card"><div class="cg-card-head"><h2>Складові внеску</h2></div>
            <div class="cg-tags">${comps.map(c => `<span class="cg-tag"><b>${escapeHtml(c.name)}</b><small>${escapeHtml(unit(c.base))}</small></span>`).join('')}</div>
            <div class="cg-form-row">
                <input id="cpName" class="field-input" maxlength="60" placeholder="Нова складова, напр. «Освітлення МЗК», «Ліфти»" aria-label="Назва складової">
                <select id="cpBase" class="field-input field-select" aria-label="Як рахувати"><option value="area">за м²</option><option value="fixed">з приміщення</option><option value="residents">з проживаючого</option></select>
                <button type="button" class="sv-btn is-soft" data-act="component-add">Додати</button>
            </div>
        </section>
        <section class="py-card cg-card"><div class="cg-card-head"><h2>Групи приміщень</h2></div>
            <div class="cg-tags">${ctx.groups.map(g => `<span class="cg-tag"><b>${escapeHtml(g.name)}</b><small>${ctx.apartments.filter(a => (ctx.premises[a.apt] || 'res') === g.id).length} прим.</small></span>`).join('')}</div>
            <div class="cg-form-row">
                <input id="grName" class="field-input" maxlength="60" placeholder="Нова група, напр. «Паркінг» або «Комори»" aria-label="Назва групи">
                <button type="button" class="sv-btn is-soft" data-act="group-add">Додати</button>
            </div>
        </section>`;
}

// ------------------------------------------------------------
// ПРИМІЩЕННЯ
// ------------------------------------------------------------
function premisesPane(preview) {
    const charge = new Map((preview?.rows || []).map(r => [r.apt, r.amountKop]));
    const problem = new Map((preview?.problems || []).map(r => [r.apt, r.reason]));
    const usesResidents = (ctx.components || []).some(c => c.base === 'residents');
    const q = prQuery.trim().toLowerCase();
    const keep = { all: () => true, problems: a => problem.has(a.apt), noarea: a => !a.area, nores: a => a.residents === undefined || a.residents === null || a.residents === '' };
    const groupKeep = ctx.groups.some(g => g.id === prFilter) ? a => (ctx.premises[a.apt] || 'res') === prFilter : keep[prFilter] || keep.all;
    const list = ctx.apartments.filter(a => groupKeep(a) && (!q || a.apt.startsWith(q)))
        .sort((a, b) => Number(problem.has(b.apt)) - Number(problem.has(a.apt)) || a.apt.localeCompare(b.apt, 'uk', { numeric: true }));
    const count = f => ctx.apartments.filter(keep[f]).length;
    const chips = [['all', 'Усі', ctx.apartments.length], ['problems', 'З помилками', problem.size], ['noarea', 'Без площі', count('noarea')],
        ...(usesResidents ? [['nores', 'Не вказано проживаючих', count('nores')]] : []),
        ...ctx.groups.map(g => [g.id, g.name, ctx.apartments.filter(a => (ctx.premises[a.apt] || 'res') === g.id).length])];
    return `<div class="cg-bar-row">
            <div class="cg-chips" role="group">${chips.map(([k, v, c]) => `<button type="button" class="cg-chip${k === prFilter ? ' is-active' : ''}" data-prfilter="${escapeHtml(k)}">${escapeHtml(v)} <small>${c}</small></button>`).join('')}</div>
            <label class="fl-search cg-search"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>
                <input type="search" id="cgPrQuery" placeholder="Номер приміщення" value="${escapeHtml(prQuery)}" aria-label="Номер приміщення"></label>
        </div>
        <section class="py-card cg-card cg-prem">
            <div class="cg-prem-head" aria-hidden="true"><span>Приміщення</span><span>Площа, м²</span><span>Проживає</span><span>Група</span><span>Внесок за ${escapeHtml(periodName(period))}</span></div>
            ${list.length ? list.map(a => `<div class="cg-prem-row${problem.has(a.apt) ? ' is-bad' : ''}" data-apt="${escapeHtml(a.apt)}">
                <button type="button" class="cg-apt cg-open" data-apt="${escapeHtml(a.apt)}"><b>${escapeHtml(a.apt)}</b>${a.personalAccount ? `<small>о/р ${escapeHtml(a.personalAccount)}</small>` : ''}</button>
                <span data-l="Площа">${a.area ? escapeHtml(area(a.area)) : chip(['немає', 'is-bad'])}</span>
                <span data-l="Проживає"><input class="field-input cg-res" inputmode="numeric" maxlength="2" value="${a.residents ?? ''}" placeholder="—" aria-label="Проживає в ${escapeHtml(a.apt)}"></span>
                <span data-l="Група"><select class="field-input field-select cg-grp" aria-label="Група ${escapeHtml(a.apt)}">${ctx.groups.map(g => `<option value="${escapeHtml(g.id)}"${(ctx.premises[a.apt] || 'res') === g.id ? ' selected' : ''}>${escapeHtml(g.name)}</option>`).join('')}</select></span>
                <span data-l="Внесок" class="cg-num">${charge.has(a.apt) ? fmtKop(charge.get(a.apt)) : `<small class="is-bad">${escapeHtml(problem.get(a.apt) || '—')}</small>`}</span>
            </div>`).join('') : '<p class="py-empty">Нічого не знайдено</p>'}
        </section>
        <details class="py-card cg-card cg-bulk"><summary>Масові зміни</summary>
            <div class="cg-form-row">
                <input id="prBulk" class="field-input" placeholder="Кілька приміщень через кому: н1, н2, 101" aria-label="Приміщення">
                <select id="prBulkGroup" class="field-input field-select" aria-label="Група">${ctx.groups.map(g => `<option value="${escapeHtml(g.id)}">${escapeHtml(g.name)}</option>`).join('')}</select>
                <button type="button" class="sv-btn is-soft" data-act="premises-bulk">Призначити групу</button>
            </div>
            <div class="cg-form-row">
                <textarea id="resBulk" class="field-input" rows="3" placeholder="Проживаючі: «298;2» або «298 2», кожна квартира з нового рядка чи через кому" aria-label="Проживаючі"></textarea>
                <button type="button" class="sv-btn is-soft" data-act="residents-bulk">Внести проживаючих</button>
            </div>
            <div class="cg-form-row">
                <textarea id="paBulk" class="field-input" rows="3" placeholder="Особові рахунки: «45;00045» або «101 250101», кожна квартира з нового рядка чи через кому" aria-label="Особові рахунки"></textarea>
                <button type="button" class="sv-btn is-soft" data-act="personal-accounts-bulk">Зберегти особові рахунки</button>
            </div>
            <p class="py-note">Площу веде правління в довіднику квартир.</p>
        </details>`;
}

// ------------------------------------------------------------
// БІЧНА КАРТКА: приміщення й тариф
// ------------------------------------------------------------
function sheetHost() {
    let el = document.getElementById('cgSheet');
    if (!el) {
        el = document.createElement('div');
        el.id = 'cgSheet';
        el.className = 'chs-wrap cg-sheet';
        el.hidden = true;
        document.body.appendChild(el);
        el.addEventListener('click', onClick);
        el.addEventListener('change', onChange);
        document.addEventListener('keydown', e => { if (e.key === 'Escape' && !el.hidden && !document.querySelector('.confirm-overlay')) closeSheet(); });
        window.addEventListener('hashchange', () => { if (location.hash !== '#charges') closeSheet(); });
    }
    return el;
}
function closeSheet() { sheet = null; renderSheet(); }

function aptSheet(apt, st, preview) {
    const a = ctx.apartments.find(x => x.apt === apt) || { apt };
    const r = st?.rows.find(x => x.apt === apt);
    const pr = preview?.rows.find(x => x.apt === apt);
    const problem = preview?.problems.find(x => x.apt === apt);
    const parts = r?.charge?.parts?.length ? r.charge.parts : pr?.parts || [];
    const areaCenti = r?.charge?.areaCenti ?? pr?.areaCenti;
    const comps = (st?.components || []).filter(c => r?.parts && [r.parts.opening, r.parts.charged, r.parts.paid].some(m => m?.[c.id]));
    const debt = r && r.closing < 0;
    return [`Приміщення ${apt}`, `<div class="chs-head">
            <span class="py-muted">${escapeHtml([groupName(ctx.premises[apt] || 'res'), a.personalAccount ? `о/р ${a.personalAccount}` : ''].filter(Boolean).join(' · '))}</span>
            <span class="chs-title">Приміщення ${escapeHtml(apt)}</span>
            ${r ? chip(rowState(r)) : ''}
        </div>
        ${problem ? `<p class="cg-warn">Не нараховується: ${escapeHtml(problem.reason)}</p>` : ''}
        ${r ? `<div class="chs-tiles">
            <div><span>На ${escapeHtml(periodStart(period))}</span><b>${signed(r.opening)}</b></div>
            <div><span>Нараховано за ${escapeHtml(periodName(period))}</span><b>${fmtKop(r.charged)}</b></div>
            <div><span>Сплачено</span><b>${fmtKop(r.paid)}</b></div>
            <div><span>${r.closing < 0 ? 'Борг на кінець' : r.closing > 0 ? 'Переплата на кінець' : 'На кінець'}</span><b>${signed(r.closing)}</b></div>
        </div>` : ''}
        <h3 class="chs-h">Розрахунок внеску</h3>
        <section class="py-card cg-card">${parts.length ? parts.map(p => `<div class="cg-comp-row"><span>${escapeHtml(p.name || compName(p.component))}</span>
            <span class="py-muted">${p.base === 'fixed' ? 'з приміщення' : p.base === 'residents' ? `${Number.isInteger(p.residents) ? p.residents : a.residents ?? '?'} прож. × ${rate(p.rate4)} грн` : `${area((areaCenti || 0) / 100)} м² × ${rate(p.rate4)} грн`}</span>
            <span class="cg-num">${grn(p.amountKop)}</span></div>`).join('') : '<p class="py-empty">Цього місяця не нараховано</p>'}</section>
        ${comps.length > 1 ? `<h3 class="chs-h">За статтями</h3><section class="py-card cg-card cg-st cg-st-comps">
            <div class="cg-st-head"><span>Стаття</span><span>На початок</span><span>Нараховано</span><span>Сплачено</span><span>На кінець</span></div>
            ${comps.map(c => `<div class="cg-st-row is-static"><span>${escapeHtml(c.name)}</span>${signed(r.parts.opening[c.id] || 0)}<span class="cg-num">${fmtKop(r.parts.charged[c.id] || 0)}</span><span class="cg-num is-in">${fmtKop(r.parts.paid[c.id] || 0)}</span>${signed(r.parts.closing[c.id] || 0)}</div>`).join('')}</section>` : ''}
        <h3 class="chs-h">Дані для розрахунку</h3>
        <section class="py-card cg-card cg-fields" data-apt="${escapeHtml(apt)}">
            <div class="cg-field"><span>Площа</span><b>${a.area ? `${escapeHtml(area(a.area))} м²` : 'не внесено — веде правління в довіднику квартир'}</b></div>
            <label class="cg-field"><span>Проживає</span><input class="field-input cg-res" inputmode="numeric" maxlength="2" value="${a.residents ?? ''}" placeholder="—"></label>
            <label class="cg-field"><span>Група</span><select class="field-input field-select cg-grp">${ctx.groups.map(g => `<option value="${escapeHtml(g.id)}"${(ctx.premises[apt] || 'res') === g.id ? ' selected' : ''}>${escapeHtml(g.name)}</option>`).join('')}</select></label>
            <p class="py-note">Зміни діють на наступне нарахування або перерахунок місяця.</p>
        </section>
        <div class="chs-actions cg-sticky">
            ${r ? `<button type="button" class="sv-btn" data-act="receipt-one" data-apt="${escapeHtml(apt)}">Квитанція</button>` : ''}
            <button type="button" class="sv-btn is-soft" data-act="open-flat" data-apt="${escapeHtml(apt)}">Картка квартири ›</button>
            ${debt ? `<button type="button" class="sv-btn is-soft" data-act="open-claim" data-apt="${escapeHtml(apt)}">Претензія ›</button>` : ''}
        </div>`];
}

function tariffSheet(group, component) {
    const cell = tariffCell(ctx.tariffs, group, component, period);
    const c = (ctx.components || []).find(x => x.id === component) || ctx.components[0];
    return [`${compName(component)} · ${groupName(group)}`, `<div class="chs-head">
            <span class="py-muted">${escapeHtml(groupName(group))} · ${escapeHtml(unit(c?.base))}</span>
            <span class="chs-title">${escapeHtml(compName(component))}</span>
            ${cell.current ? `<span class="cg-big">${rate(cell.current.rate4)} <small>${escapeHtml(unit(cell.current.base || c?.base))}</small></span>` : chip(['не нараховується', 'is-locked'])}
        </div>
        <h3 class="chs-h">Історія</h3>
        <section class="py-card cg-card">${cell.history.length ? cell.history.map(t => `<div class="cg-hist${t === cell.current ? ' is-current' : ''}">
            <span><b>${rate(t.rate4)} ${escapeHtml(unit(t.base || c?.base))}</b><small>з ${escapeHtml(since(t.from))}${t === cell.current ? ' · чинний' : t.from > period ? ' · наступний' : ''}</small><small>${escapeHtml(t.decision || '')}</small></span>
            <button type="button" class="cg-x" data-act="tariff-remove" data-id="${escapeHtml(t.id)}" aria-label="Прибрати тариф">×</button></div>`).join('') : '<p class="py-empty">Тарифу ще немає</p>'}</section>
        <h3 class="chs-h">Новий тариф</h3>
        <section class="py-card cg-card cg-tariff-form">
            <div class="cg-grid">
                <label class="py-field"><span>Складова</span><select id="tfComp" class="field-input field-select">${(ctx.components || []).map(x => `<option value="${escapeHtml(x.id)}"${x.id === component ? ' selected' : ''}>${escapeHtml(x.name)}</option>`).join('')}</select></label>
                <label class="py-field"><span>Група</span><select id="tfGroup" class="field-input field-select">${ctx.groups.map(g => `<option value="${escapeHtml(g.id)}"${g.id === group ? ' selected' : ''}>${escapeHtml(g.name)}</option>`).join('')}</select></label>
                <label class="py-field"><span>Тариф, грн</span><input id="tfRate" class="field-input" inputmode="decimal" placeholder="${cell.current ? rate(cell.current.rate4) : '0,00'}"></label>
                <label class="py-field"><span>Діє з місяця</span><input id="tfFrom" class="field-input" type="month" value="${escapeHtml(shiftPeriod(ctx.current, 1))}"></label>
            </div>
            <label class="py-field"><span>Рішення загальних зборів</span><input id="tfDecision" class="field-input" maxlength="200" placeholder="Протокол загальних зборів № …, дата"></label>
            <p class="py-note">Тариф, за яким уже нараховано, не прибрати — лише замінити новим з наступного місяця.</p>
        </section>
        <div class="chs-actions cg-sticky"><button type="button" class="sv-btn" data-act="tariff-add">Додати тариф</button>
            <button type="button" class="sv-btn is-soft" data-act="sheet-close">Скасувати</button></div>`];
}

async function renderSheet() {
    const el = sheetHost();
    if (!sheet || !ctx) { el.hidden = true; el.innerHTML = ''; document.body.classList.remove('chs-open'); return; }
    const [st, preview] = sheet.kind === 'apt' ? await Promise.all([loadStatement(period).catch(() => null), previewFor(period)]) : [null, null];
    if (!sheet) return;
    const [title, body] = sheet.kind === 'apt' ? aptSheet(sheet.apt, st, preview) : tariffSheet(sheet.group, sheet.component);
    el.innerHTML = `<div class="chs-backdrop" data-act="sheet-close"></div>
        <aside class="chs-sheet" role="dialog" aria-modal="true" aria-label="${escapeHtml(title)}" tabindex="-1">
            <div class="chs-bar"><span></span><span class="chs-bar-title">${escapeHtml(title)}</span>
                <button type="button" class="chs-icon" data-act="sheet-close" aria-label="Закрити">×</button></div>
            <div class="chs-body">${body}</div>
        </aside>`;
    el.hidden = false;
    document.body.classList.add('chs-open');
    el.querySelector('.chs-sheet')?.focus({ preventScroll: true });
}

// ------------------------------------------------------------
// КВИТАНЦІЇ
// ------------------------------------------------------------
function receiptPartsHtml(r, comps, charge) {
    const p = r.parts;
    if (!p) return '';
    const used = comps.filter(c => [p.opening, p.charged, p.paid].some(m => m[c.id]));
    if (used.length < 2) return '';
    const calc = c => {
        const part = charge?.parts?.find(x => x.component === c.id);
        if (!part) return '';
        return part.base === 'fixed' ? 'з приміщення' : part.base === 'residents' ? (Number.isInteger(part.residents) ? `${part.residents} прож. × ${rate(part.rate4)}` : 'з проживаючого') : `${area(charge.areaCenti / 100)} м² × ${rate(part.rate4)}`;
    };
    return `<table class="rc-parts"><thead><tr><th>Стаття</th><th>Баланс до нарахування</th><th>Нараховано</th><th>Сплачено за період</th><th>До сплати</th></tr></thead>
        <tbody>${used.map(c => `<tr><td>${escapeHtml(c.name)}${calc(c) ? `<small>${escapeHtml(calc(c))}</small>` : ''}</td>
            <td>${fmtKop(-(p.opening[c.id] || 0))}</td><td>${fmtKop(p.charged[c.id] || 0)}</td><td>${fmtKop(p.paid[c.id] || 0)}</td>
            <td>${fmtKop(Math.max(0, -(p.closing[c.id] || 0)))}</td></tr>`).join('')}</tbody></table>`;
}

function receiptHtml(r, a, req, receiptPeriod, qrcode, comps = []) {
    const due = Math.max(0, -r.closing);
    const purpose = receiptPurpose(req.purposeTemplate, r.apt, a.personalAccount, receiptPeriod);
    let qr = '';
    try {
        const links = paymentLinks({ name: req.payeeName, iban: req.iban, code: req.edrpou, amount: due ? due / 100 : null, purpose, reference: `KV${r.apt}` });
        const code = qrcode(0, 'Q');
        code.addData(links.link);
        code.make();
        qr = `<div class="rc-qr">${code.createSvgTag({ cellSize: 3, margin: 1, scalable: true })}<span aria-hidden="true">₴</span></div>`;
    } catch { /* немає реквізитів — квитанція без QR */ }
    const charge = r.charge;
    const receiptArea = charge?.areaCenti ? charge.areaCenti / 100 : a.area;
    const part = charge?.parts?.[0];
    const calculation = part?.base === 'fixed' ? 'з приміщення'
        : part?.base === 'residents' && Number.isInteger(part.residents) ? `${part.residents} прож. × ${rate(part.rate4)}`
        : charge?.areaCenti && charge.rate4 ? `${area(charge.areaCenti / 100)} м² × ${rate(charge.rate4)}` : '';
    return `<article class="rc">
        <header><b>${escapeHtml(req.payeeName || 'ОСББ')}</b><span>Рахунок-квитанція за ${escapeHtml(periodName(receiptPeriod))}</span></header>
        <div class="rc-body">
            <div class="rc-main">
                <p class="rc-apt">Кв. ${escapeHtml(r.apt)}${a.personalAccount ? ` · о/р ${escapeHtml(a.personalAccount)}` : ''}${receiptArea ? ` · ${escapeHtml(area(receiptArea))} м²` : ''}</p>
                ${receiptPartsHtml(r, comps, charge)}
                <table><tbody>
                    <tr><td>${r.opening < 0 ? 'Борг' : r.opening > 0 ? 'Переплата' : 'Залишок'} на ${escapeHtml(periodStart(receiptPeriod))}</td><td>${fmtKop(Math.abs(r.opening))}</td></tr>
                    <tr><td>Нараховано${calculation && !(charge.parts?.length > 1) ? ` (${escapeHtml(calculation)})` : ''}</td><td>${fmtKop(r.charged)}</td></tr>
                    <tr><td>Сплачено за місяць</td><td>${fmtKop(r.paid)}</td></tr>
                    <tr class="rc-total"><td>${due ? 'До сплати' : r.closing > 0 ? 'Переплата' : 'Розраховано'}</td><td>${fmtKop(due || r.closing)} грн</td></tr>
                </tbody></table>
                <p class="rc-req">${escapeHtml([req.iban, req.edrpou ? `ЄДРПОУ ${req.edrpou}` : ''].filter(Boolean).join(' · '))}<br>${escapeHtml(purpose)}</p>
            </div>
            ${qr ? `<div class="rc-pay">${qr}<small>Наведіть камеру телефону — переказ відкриється заповненим</small></div>` : ''}
        </div>
    </article>`;
}

/** Квитанції: усі квартири з поточного фільтра відомості, або одна квартира. */
async function showReceipts(btn, onlyApt = null) {
    setBusy(btn, true, 'Готую…');
    try {
        const [st, req, { default: qrcode }] = await Promise.all([loadStatement(period), loadRequisites(), import('./vendor/qrcode.js')]);
        const extra = new Map(ctx.apartments.map(a => [a.apt, a]));
        const rows = onlyApt ? st.rows.filter(r => r.apt === onlyApt) : filterStatement(st.rows, tab === 'statement' ? stFilter : 'all', tab === 'statement' ? stQuery : '');
        if (!rows.length) { toast('Немає квартир для квитанцій', 'error'); return; }
        const cards = rows.map(r => receiptHtml(r, extra.get(r.apt) || {}, req, st.period, qrcode, st.components || []));
        let host = document.getElementById('buhPrint');
        if (!host) { host = document.createElement('div'); host.id = 'buhPrint'; document.body.appendChild(host); }
        host.innerHTML = `<div class="rc-bar"><b>Квитанції за ${escapeHtml(periodName(st.period))}: ${rows.length}</b>
                ${!req.iban ? '<span>Реквізити ОСББ не внесено — QR не буде</span>' : ''}
                <button type="button" class="btn-primary btn-compact" data-print>Друкувати</button>
                <button type="button" class="btn-ghost-small" data-close>Закрити</button></div>
            <div class="rc-list">${cards.join('')}</div>`;
        document.body.classList.add('is-printing');
        host.querySelector('[data-print]').addEventListener('click', () => window.print());
        host.querySelector('[data-close]').addEventListener('click', () => { document.body.classList.remove('is-printing'); host.innerHTML = ''; });
    } catch (e) {
        console.error('Квитанції:', e);
        toast('Не вдалося підготувати квитанції', 'error');
    } finally { if (btn.isConnected) setBusy(btn, false); }
}

function downloadCsv(st) {
    const blob = new Blob([statementCsv(st, new Map(ctx.apartments.map(a => [a.apt, a])))], { type: 'text/csv;charset=utf-8' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `vidomist-${st.period}.csv`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

// ------------------------------------------------------------
// РОЗДІЛ
// ------------------------------------------------------------
let current = null;  // що зараз на екрані: { run, preview, st, next } — для Enter
export async function loadChargesView() {
    [ctx, names] = await Promise.all([loadCharges(), loadStaffNames()]);
    previews.clear();
    const periods = periodsBetween(ctx.startPeriod, ctx.current);
    if (!period || !periods.includes(period)) period = ctx.preview.period;
    if (!TABS[tab]) tab = 'calc';
    const run = ctx.runs.find(r => r.period === period) || null;
    const [preview, st] = await Promise.all([previewFor(period), loadStatement(period).catch(() => null)]);
    const stats = collectionStats(st);
    ctx._deep = st ? filterStatement(st.rows, 'deep').length : 0;
    const next = nextChargesAction({ period, run, preview, due: ctx.due, current: ctx.current, tariffs: ctx.tariffs, opening: ctx.opening?.set, unfinished: ctx.unfinished, stats });
    current = { run, preview, st, next };
    const pane = tab === 'statement' ? statementPane(st) : tab === 'tariffs' ? tariffsPane() : tab === 'premises' ? premisesPane(preview) : calcPane(run, preview);
    document.getElementById('viewCharges').innerHTML = `${headHtml(run)}
        ${nextHtml(next)}
        ${kpisHtml(run, preview, stats)}
        ${tabsHtml(st, preview)}
        <div class="cg-pane" id="cgPane">${pane}</div>`;
    if (sheet) renderSheet();
    return ctx.due.length + (ctx.unfinished?.length || 0);
}

/** «Завершити операцію» — з розділу чи з «Вхідних». */
export async function resumeCharges() {
    const r = await chargeAct({ action: 'resume' });
    toast(r.resumed ? `Операцію завершено. Баланси перераховано: ${r.balances}` : 'Незавершених операцій немає', 'success');
    return r;
}

/** Нарахувати місяць: сума, яку бачила людина, звіряється на сервері. */
export async function runCharges(runPeriod, expectTotalKop) {
    const preview = await chargeAct({ action: 'preview', period: runPeriod });
    if (preview.problems?.length && !await confirmDialog('Нарахування неповне',
        `${preview.problems.length} прим. мають помилки: ${preview.problems.slice(0, 8).map(p => `${p.apt}: ${p.reason}`).join('; ')}. Буде нараховано лише коректні рядки. Попередні нарахування проблемних приміщень збережуться. Місяць залишиться неповним до виправлення даних.`, 'Нарахувати частково')) return null;
    const r = await chargeAct({ action: 'run', period: runPeriod, expectTotalKop: expectTotalKop ?? preview.totalKop, allowPartial: Boolean(preview.problems?.length) });
    toast(`Нараховано за ${periodName(runPeriod)}: ${r.count} прим., ${fmtKop(r.totalKop)} грн`, 'success');
    if (r.problems?.length) toast(`Неповне нарахування: ${r.problems.length} прим. потребують виправлення — див. «Нарахування»`, 'info');
    return r;
}

async function onAction(btn) {
    const a = btn.dataset.act;
    const p = btn.dataset.period || period;
    try {
        if (a === 'sheet-close') { closeSheet(); return; }
        if (a === 'open-flat') { closeSheet(); openFlat(btn.dataset.apt); return; }
        if (a === 'open-claim') { closeSheet(); openClaimCase(btn.dataset.apt); return; }
        if (a === 'receipt-one') { await showReceipts(btn, btn.dataset.apt); return; }
        if (a === 'receipts') { await showReceipts(btn); return; }
        if (a === 'csv') { downloadCsv(await loadStatement(period)); return; }
        if (a === 'tariff-new') { sheet = { kind: 'tariff', group: ctx.groups[0]?.id, component: ctx.components?.[0]?.id || 'main' }; renderSheet(); return; }
        if (a === 'resume') {
            setBusy(btn, true, 'Дописую…');
            await resumeCharges();
        } else if (a === 'run') {
            setBusy(btn, true, 'Нараховую…');
            const r = await runCharges(p, current?.preview?.period === p ? current.preview.totalKop : undefined);
            if (!r) return;
        } else if (a === 'recalc') {
            if (!await confirmDialog(`Перерахувати ${periodName(p)}?`, 'Суми буде перераховано за поточними площами й тарифами. Записи в історії квартир оновляться, баланси теж.', 'Перерахувати')) return;
            setBusy(btn, true, 'Рахую…');
            const r = await runCharges(p);
            if (!r) return;
            toast(r.changed ? `Перераховано: змінилося ${r.changed} прим.` : 'Суми не змінилися', 'success');
        } else if (a === 'revert') {
            if (!await confirmDialog(`Скасувати нарахування за ${periodName(p)}?`, 'Записи «Нарахування» за цей місяць буде прибрано з історії всіх квартир, баланси перераховано.', 'Скасувати нарахування')) return;
            setBusy(btn, true);
            await chargeAct({ action: 'revert', period: p });
            toast('Нарахування скасовано', 'success');
        } else if (a === 'residents-bulk') {
            const rows = val('resBulk').split(/[\n,]+/).map(x => x.trim()).filter(Boolean).map(x => {
                const [apt, residents] = x.split(/[;\t\s]+/);
                return { apt: String(apt || '').toLowerCase(), residents: residents ?? '' };
            });
            if (!rows.length) { toast('Вкажіть квартири й кількість', 'error'); return; }
            setBusy(btn, true);
            const r = await chargeAct({ action: 'setResidents', rows });
            toast(`Збережено: ${r.count} кв.`, 'success');
        } else if (a === 'personal-accounts-bulk') {
            const rows = val('paBulk').split(/[\n,]+/).map(x => x.trim()).filter(Boolean).map(x => {
                const [apt, pa] = x.split(/[;\t\s]+/);
                return { apt: String(apt || '').trim(), personalAccount: String(pa || '').trim() };
            }).filter(x => x.apt);
            if (!rows.length) { toast('Вкажіть квартири та особові рахунки, напр. 45;00045', 'error'); return; }
            setBusy(btn, true);
            // Сервер сам знаходить справжній документ квартири (н1 / Н1) і пише журнал дій.
            const r = await chargeAct({ action: 'setPersonalAccounts', rows });
            toast(`Особові рахунки збережено: ${r.count} прим.`, 'success');
        } else if (a === 'component-add') {
            await chargeAct({ action: 'addComponent', name: val('cpName'), base: val('cpBase') });
            toast('Складову додано — внесіть для неї тарифи', 'success');
        } else if (a === 'tariff-add') {
            setBusy(btn, true);
            await chargeAct({ action: 'addTariff', component: val('tfComp'), group: val('tfGroup'), rate: val('tfRate'), from: val('tfFrom'), decision: val('tfDecision') });
            toast('Тариф додано', 'success');
            sheet = { kind: 'tariff', group: val('tfGroup'), component: val('tfComp') };
        } else if (a === 'tariff-remove') {
            if (!await confirmDialog('Прибрати тариф?', 'Це можливо, лише поки за ним нічого не нараховано.', 'Прибрати')) return;
            await chargeAct({ action: 'removeTariff', id: btn.dataset.id });
            toast('Тариф прибрано', 'success');
        } else if (a === 'group-add') {
            await chargeAct({ action: 'addGroup', name: val('grName') });
            toast('Групу додано', 'success');
        } else if (a === 'premises-bulk') {
            const apts = val('prBulk').split(/[,;\s]+/).map(x => x.trim().toLowerCase()).filter(Boolean);
            if (!apts.length) { toast('Вкажіть приміщення', 'error'); return; }
            setBusy(btn, true);
            await chargeAct({ action: 'setPremises', apts, group: val('prBulkGroup') });
            toast(`Збережено: ${apts.length} прим.`, 'success');
        } else return;
        await loadChargesView();
    } catch (e) {
        toast(e.message, 'error');
    } finally { if (btn.isConnected) setBusy(btn, false); }
}

function rerenderPane(focusId) {
    const pos = document.getElementById(focusId)?.selectionStart;
    loadChargesView().then(() => {
        const el = document.getElementById(focusId);
        if (el) { el.focus(); if (pos !== undefined) el.setSelectionRange(pos, pos); }
    }).catch(err => toast(err.message, 'error'));
}

function onClick(e) {
    const t = e.target;
    const tabBtn = t.closest('[data-tab]');
    if (tabBtn) {
        tab = tabBtn.dataset.tab;
        if (tabBtn.dataset.filter) stFilter = tabBtn.dataset.filter;
        loadChargesView().then(() => { if (tabBtn.closest('.cg-next, .cg-kpis')) document.getElementById('cgPane')?.scrollIntoView({ behavior: 'smooth', block: 'start' }); });
        return;
    }
    const step = t.closest('[data-period-step]');
    if (step && !step.disabled) { period = shiftPeriod(period, -Number(step.dataset.periodStep)); loadChargesView(); return; }
    const go = t.closest('[data-goto]');
    if (go) { period = go.dataset.goto; loadChargesView().then(() => window.scrollTo({ top: 0, behavior: 'smooth' })); return; }
    const f = t.closest('[data-filter]');
    if (f) { stFilter = f.dataset.filter; loadChargesView(); return; }
    const pf = t.closest('[data-prfilter]');
    if (pf) { prFilter = pf.dataset.prfilter; loadChargesView(); return; }
    const cell = t.closest('[data-tariff]');
    if (cell) { sheet = { kind: 'tariff', group: cell.dataset.tariff, component: cell.dataset.component }; renderSheet(); return; }
    const btn = t.closest('[data-act]');
    if (btn && !btn.disabled) { onAction(btn); return; }
    const aptBtn = t.closest('.cg-st-row[data-apt], .cg-problem[data-apt], .cg-open[data-apt]');
    if (aptBtn) { sheet = { kind: 'apt', apt: aptBtn.dataset.apt }; renderSheet(); }
}

async function onChange(e) {
    const t = e.target;
    if (t.id === 'cgPeriod') { period = t.value; loadChargesView(); return; }
    const apt = t.closest('[data-apt]')?.dataset.apt;
    if (!apt) return;
    try {
        if (t.classList.contains('cg-res')) {
            await chargeAct({ action: 'setResidents', rows: [{ apt, residents: t.value.trim() }] });
            toast(`Приміщення ${apt}: проживає ${t.value.trim() || '—'}`, 'success');
        } else if (t.classList.contains('cg-grp')) {
            await chargeAct({ action: 'setPremises', apts: [apt], group: t.value });
            toast(`Приміщення ${apt}: група «${groupName(t.value)}»`, 'success');
        } else return;
        await loadChargesView();
    } catch (err) { toast(err.message, 'error'); }
}

export function initChargesView(isActive) {
    const host = document.getElementById('viewCharges');
    host.addEventListener('click', onClick);
    host.addEventListener('change', onChange);
    host.addEventListener('input', e => {
        if (e.target.id === 'cgStQuery') { stQuery = e.target.value; rerenderPane('cgStQuery'); }
        if (e.target.id === 'cgPrQuery') { prQuery = e.target.value; rerenderPane('cgPrQuery'); }
    });
    // Enter — нарахувати місяць, коли це головна дія (як у «Вхідних»).
    document.addEventListener('keydown', e => {
        if (!isActive() || e.key !== 'Enter' || sheet || e.target.matches('input, textarea, select, button, a') || document.querySelector('.confirm-overlay')) return;
        const btn = host.querySelector('.cg-next [data-act="run"]:not([disabled])');
        if (btn && current?.next?.key) { e.preventDefault(); onAction(btn); }
    });
}
