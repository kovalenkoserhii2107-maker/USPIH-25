// ============================================================
// «Нарахування»: внески співвласників за місяць, розрахунки з
// мешканцями, тарифи, приміщення й вхідні залишки.
//
// Система готує нарахування (площа × тариф) — бухгалтер підтверджує
// одним Enter. Усі записи робить сервер (chargesAction): він же
// перераховує баланси квартир і пише журнал дій.
// ============================================================
import { escapeHtml, toast, setBusy, confirmDialog } from './ui.js';
import { loadCharges, loadStatement, loadRequisites, chargeAct, dateOnly } from './buh-data.js';
import {
    periodName, periodStart, periodsBetween, fmtKop, parseOpeningLines, openingSummary, statementCsv, receiptPurpose
} from './charges-core.js';
import { paymentLinks } from './nbu-qr.js';

const SEGMENTS = { month: 'Місяць', statement: 'Відомість', tariffs: 'Тарифи', premises: 'Приміщення', opening: 'Вхідні залишки' };
let segment = 'month';
let ctx = null;
let stPeriod = null;
let stFilter = 'all';
let openingSign = 'overpaid';

const groupName = id => ctx.groups.find(g => g.id === id)?.name || 'Квартири';
const rate = r4 => (r4 / 10000).toLocaleString('uk-UA', { minimumFractionDigits: 2, maximumFractionDigits: 4 });
const area = v => String(v ?? '').replace('.', ',');
const cap = s => s.charAt(0).toUpperCase() + s.slice(1);
const kopCell = (kop, cls = '') => `<td class="t-sum${kop < 0 ? ' is-out' : ''}${cls}">${fmtKop(kop)}</td>`;

/** Відкрити розділ одразу на потрібній вкладці (із «Вхідних» чи «Огляду»). */
export function openCharges(seg = 'month') {
    segment = SEGMENTS[seg] ? seg : 'month';
    if (location.hash !== '#charges') location.hash = 'charges';
    else loadChargesView();
}

// ------------------------------------------------------------
// МІСЯЦЬ
// ------------------------------------------------------------
/** Розбивка нарахування: складова × група × тариф. */
function groupsBreakdown(rows) {
    const by = new Map();
    for (const r of rows) {
        for (const p of r.parts?.length ? r.parts : [{ component: 'main', name: 'Утримання будинку', base: 'area', rate4: r.rate4, amountKop: r.amountKop }]) {
            const key = `${p.component}:${r.group}:${p.rate4}`;
            const g = by.get(key) || { name: p.name, base: p.base, group: r.group, rate4: p.rate4, count: 0, area: 0, total: 0 };
            g.count += 1; g.area += r.areaCenti || 0; g.total += p.amountKop;
            by.set(key, g);
        }
    }
    return [...by.values()];
}
const unit = base => (base === 'fixed' ? 'грн з прим.' : base === 'residents' ? 'грн/прож.' : 'грн/м²');
const compName = id => (ctx.components || []).find(c => c.id === (id || 'main'))?.name || 'Утримання будинку';

function monthHtml() {
    const p = ctx.preview;
    const run = ctx.runs.find(r => r.period === p.period);
    const lastRun = ctx.runs[0]?.period;
    const others = ctx.due.filter(x => x !== p.period);
    const setup = [];
    if (!ctx.tariffs.length) setup.push('<button type="button" class="btn-ghost-small" data-seg="tariffs">Внести тарифи →</button>');
    if (!ctx.opening?.set) setup.push('<button type="button" class="btn-ghost-small" data-seg="opening">Внести вхідні залишки →</button>');

    const head = run
        ? `<div class="buh-card-head"><h2>${escapeHtml(cap(periodName(p.period)))}</h2><span class="buh-tag is-payment">нараховано</span></div>
           <p class="ch-big">${fmtKop(run.totalKop)} <small>грн · ${run.count} прим.</small></p>
           <p class="buh-note">${run.at ? `${escapeHtml(dateOnly(run.at))} · ` : ''}${escapeHtml(run.by || '')}${run.recalculated ? ` · перераховано ${run.recalculated} р.` : ''}</p>
           <div class="inbox-actions">
               <button type="button" class="btn-soft btn-compact" data-act="recalc" data-period="${p.period}">Перерахувати</button>
               ${lastRun === p.period ? `<button type="button" class="btn-ghost-small" data-act="revert" data-period="${p.period}">Скасувати нарахування</button>` : ''}
               <button type="button" class="btn-ghost-small" data-seg="statement">Відомість →</button>
           </div>`
        : `<div class="buh-card-head"><h2>Нарахувати за ${escapeHtml(periodName(p.period))}</h2><span class="buh-tag is-review">чекає підтвердження</span></div>
           <p class="ch-big">${fmtKop(p.totalKop)} <small>грн · ${p.rows.length} прим.</small></p>
           ${p.rows.length ? `<table class="buh-table is-compact ch-groups"><thead><tr><th>Складова</th><th>Група</th><th>Прим.</th><th>Площа, м²</th><th>Тариф</th><th class="t-sum">Сума, ₴</th></tr></thead>
               <tbody>${groupsBreakdown(p.rows).map(g => `<tr><td>${escapeHtml(g.name)}</td><td>${escapeHtml(groupName(g.group))}</td><td>${g.count}</td><td>${g.base === 'fixed' ? '—' : area(g.area / 100)}</td><td>${rate(g.rate4)} ${unit(g.base)}</td>${kopCell(g.total)}</tr>`).join('')}</tbody></table>` : ''}
           <div class="inbox-actions">
               <button type="button" class="btn-primary inbox-yes" data-act="run" data-period="${p.period}"${p.rows.length ? '' : ' disabled'}>Нарахувати<kbd>Enter</kbd></button>
               ${others.length ? `<span class="buh-note">Також не нараховано: ${others.map(periodName).map(escapeHtml).join(', ')}</span>` : ''}
               ${!ctx.due.includes(p.period) ? `<span class="buh-note">Зазвичай нараховують в останній день місяця — «Вхідні» нагадають. Запис матиме дату кінця місяця.</span>` : ''}
           </div>`;

    return `<section class="buh-card ch-month">
            ${head}
            ${p.problems.length ? `<details class="ch-problems"${run ? '' : ' open'}><summary>Не нараховано: ${p.problems.length} прим.</summary>
                <p>${p.problems.slice(0, 60).map(x => `<span class="buh-tag is-review">${escapeHtml(x.apt)}: ${escapeHtml(x.reason)}</span>`).join(' ')}</p>
                <p class="buh-note">Площу вносить правління в довіднику квартир; тарифи й групи — на вкладках поруч.</p></details>` : ''}
            ${!ctx.opening?.set ? '<p class="buh-note ch-warn">Поки немає вхідних залишків, баланс у кабінеті мешканця не змінюється: нарахування лише записуються в історію.</p>' : ''}
            ${setup.length ? `<div class="inbox-actions">${setup.join('')}</div>` : ''}
        </section>
        <section class="buh-card">
            <div class="buh-card-head"><h2>Нараховані місяці</h2></div>
            ${ctx.runs.length ? `<table class="buh-table"><thead><tr><th>Місяць</th><th>Прим.</th><th>Хто й коли</th><th class="t-sum">Сума, ₴</th><th></th></tr></thead>
                <tbody>${ctx.runs.map(r => `<tr><td><b>${escapeHtml(periodName(r.period))}</b></td><td>${r.count}${r.problems.length ? ` <small class="t-muted">(${r.problems.length} без нарахування)</small>` : ''}</td>
                    <td class="t-muted">${escapeHtml(r.by || '')}${r.at ? ` · ${escapeHtml(dateOnly(r.at))}` : ''}</td>${kopCell(r.totalKop)}
                    <td class="t-act"><button type="button" class="btn-ghost-small" data-act="recalc" data-period="${r.period}">Перерахувати</button></td></tr>`).join('')}</tbody></table>`
                : '<p class="list-empty">Ще нічого не нараховано</p>'}
        </section>`;
}

// ------------------------------------------------------------
// ВІДОМІСТЬ РОЗРАХУНКІВ З МЕШКАНЦЯМИ
// ------------------------------------------------------------
function statementRows(st) {
    const q = (document.getElementById('stQuery')?.value || '').trim().toLowerCase().replace(/^кв\.?\s*/, '');
    return st.rows.filter(r => (stFilter === 'debt' ? r.closing < 0 : stFilter === 'over' ? r.closing > 0 : true) && (!q || r.apt === q || r.apt.startsWith(q)));
}

function statementTable(st) {
    const rows = statementRows(st);
    const t = st.totals;
    if (!rows.length) return '<p class="list-empty">Нічого не знайдено</p>';
    return `<table class="buh-table ch-statement"><thead><tr><th>Кв.</th><th class="t-sum">На початок</th><th class="t-sum">Нараховано</th><th class="t-sum">Сплачено</th><th class="t-sum">На кінець</th></tr></thead>
        <tbody>${rows.map(r => `<tr><td><b>${escapeHtml(r.apt)}</b></td>${kopCell(r.opening)}${kopCell(r.charged)}${kopCell(r.paid)}${kopCell(r.closing, ' t-strong')}</tr>`).join('')}</tbody>
        <tfoot><tr><td>Разом</td>${kopCell(t.opening)}${kopCell(t.charged)}${kopCell(t.paid)}${kopCell(t.closing, ' t-strong')}</tr></tfoot></table>`;
}

/** Зведення за статтями: як «Надходження» й «Нарахування» по статтях у сервісі бухгалтера. */
function componentsTable(st) {
    const comps = (st.components || []).filter(c => st.byComponent?.[c.id]);
    if (comps.length < 2) return '';
    const b = st.byComponent;
    return `<table class="buh-table is-compact ch-comps"><thead><tr><th>Стаття</th><th class="t-sum">На початок</th><th class="t-sum">Нараховано</th><th class="t-sum">Сплачено</th><th class="t-sum">На кінець</th></tr></thead>
        <tbody>${comps.map(c => `<tr><td>${escapeHtml(c.name)}</td>${kopCell(b[c.id].opening)}${kopCell(b[c.id].charged)}${kopCell(b[c.id].paid)}${kopCell(b[c.id].closing, ' t-strong')}</tr>`).join('')}</tbody></table>`;
}

async function statementHtml() {
    const periods = periodsBetween(ctx.startPeriod, ctx.current);
    if (!stPeriod || !periods.includes(stPeriod)) stPeriod = ctx.runs[0]?.period || periods[0];
    const st = await loadStatement(stPeriod);
    const t = st.totals;
    return `<div class="kpi-grid ch-kpi">
            <div class="kpi"><span>Борг на кінець місяця</span><b class="is-out">${fmtKop(t.debt)}</b><small>${t.debtors} кв.</small></div>
            <div class="kpi"><span>Нараховано</span><b>${fmtKop(t.charged)}</b><small>${escapeHtml(periodName(st.period))}</small></div>
            <div class="kpi"><span>Сплачено</span><b class="is-in">${fmtKop(t.paid)}</b><small>${t.charged ? `${Math.round(t.paid / t.charged * 100)}% від нарахованого` : '—'}</small></div>
        </div>
        <section class="buh-card">
            <div class="buh-toolbar">
                <select id="stPeriod" class="field-input field-select ch-period" aria-label="Місяць">${periods.map(p => `<option value="${p}"${p === stPeriod ? ' selected' : ''}>${escapeHtml(periodName(p))}</option>`).join('')}</select>
                <div class="buh-seg">${[['all', 'Усі'], ['debt', 'Борг'], ['over', 'Переплата']].map(([k, v]) =>
                    `<button type="button" class="buh-seg-item${k === stFilter ? ' active' : ''}" data-stfilter="${k}">${v}</button>`).join('')}</div>
                <input type="search" id="stQuery" class="field-input buh-search ch-search" placeholder="Квартира">
                <span class="ch-tools">
                    <button type="button" class="btn-ghost-small" data-act="csv">CSV для Excel</button>
                    <button type="button" class="btn-soft btn-compact" data-act="receipts">Квитанції</button>
                </span>
            </div>
            ${!st.opening ? '<p class="buh-note ch-warn">Вхідні залишки ще не внесено — колонка «на початок» неповна.</p>' : ''}
            ${componentsTable(st)}
            <div id="stTable">${statementTable(st)}</div>
            <p class="buh-note">Мінус — борг, плюс — переплата. Оплати з виписки банку потрапляють сюди одразу після рознесення.</p>
        </section>`;
}

// ------------------------------------------------------------
// ТАРИФИ
// ------------------------------------------------------------
function tariffsHtml() {
    const comps = ctx.components || [];
    const now = (g, c) => ctx.tariffs.filter(x => x.group === g && (x.component || 'main') === c && x.from <= ctx.current).sort((a, b) => (a.from < b.from ? 1 : -1))[0];
    // Чинні тарифи: рядок — складова, стовпчик — група приміщень.
    const matrix = `<table class="buh-table ch-matrix"><thead><tr><th>Складова внеску</th>${ctx.groups.map(g => `<th class="t-sum">${escapeHtml(g.name)}</th>`).join('')}</tr></thead>
        <tbody>${comps.map(c => `<tr><td><b>${escapeHtml(c.name)}</b><small class="t-muted"> ${escapeHtml(unit(c.base))}</small></td>${ctx.groups.map(g => {
            const t = now(g.id, c.id);
            return `<td class="t-sum">${t ? rate(t.rate4) : '<span class="t-muted">—</span>'}</td>`;
        }).join('')}</tr>`).join('')}</tbody></table>`;
    const sorted = [...ctx.tariffs].sort((a, b) => (a.from < b.from ? 1 : a.from > b.from ? -1 : 0));
    return `<section class="buh-card">
            <div class="buh-card-head"><h2>Чинні тарифи</h2><span>на ${escapeHtml(periodName(ctx.current))}, на місяць</span></div>
            ${matrix}
            <p class="buh-note">«—» — складова цій групі не нараховується (напр. ліфти нежитловим приміщенням). «Утримання будинку» — обовʼязкова.</p>
        </section>
        <section class="buh-card">
            <div class="buh-card-head"><h2>Усі тарифи</h2></div>
            ${sorted.length ? `<table class="buh-table"><thead><tr><th>Складова</th><th>Група</th><th>Тариф</th><th>Діє з</th><th>Рішення</th><th></th></tr></thead>
                <tbody>${sorted.map(t => `<tr><td>${escapeHtml(compName(t.component))}</td><td>${escapeHtml(groupName(t.group))}</td><td><b>${rate(t.rate4)}</b> <small class="t-muted">${unit(t.base)}</small></td><td>${escapeHtml(periodName(t.from))}</td>
                    <td class="t-muted">${escapeHtml(t.decision)}</td><td class="t-act"><button type="button" class="btn-ghost-small" data-act="tariff-remove" data-id="${escapeHtml(t.id)}">Прибрати</button></td></tr>`).join('')}</tbody></table>`
                : '<p class="list-empty">Тарифів ще немає</p>'}
            <h3 class="ch-sub">Новий тариф</h3>
            <div class="buh-inline-form ch-form">
                <select id="tfComp" class="field-input field-select" aria-label="Складова">${comps.map(c => `<option value="${escapeHtml(c.id)}">${escapeHtml(c.name)}</option>`).join('')}</select>
                <select id="tfGroup" class="field-input field-select" aria-label="Група">${ctx.groups.map(g => `<option value="${escapeHtml(g.id)}">${escapeHtml(g.name)}</option>`).join('')}</select>
                <input id="tfRate" class="field-input ch-narrow" inputmode="decimal" placeholder="Тариф, грн" aria-label="Тариф">
                <input id="tfFrom" class="field-input ch-narrow" type="month" value="${escapeHtml(ctx.current)}" aria-label="Діє з місяця">
                <input id="tfDecision" class="field-input" maxlength="200" placeholder="Рішення: протокол зборів № …, дата" aria-label="Рішення">
                <button type="button" class="btn-primary btn-compact" data-act="tariff-add">Додати</button>
            </div>
            <p class="buh-note">Новий тариф діє з указаного місяця, попередні нарахування не змінюються. Тариф, за яким уже нараховано, не прибрати — лише замінити новим з наступного місяця. Окремий тариф для нежитлових потребує рішення загальних зборів (статут, п. 4.4).</p>
            <h3 class="ch-sub">Складові внеску</h3>
            <p class="ch-chips">${comps.map(c => `<span class="buh-tag">${escapeHtml(c.name)} · ${escapeHtml(unit(c.base))}</span>`).join(' ')}</p>
            <div class="buh-inline-form ch-form">
                <input id="cpName" class="field-input" maxlength="60" placeholder="Нова складова, напр. «Освітлення МЗК», «Ліфти», «Вивезення ТПВ»" aria-label="Назва складової">
                <select id="cpBase" class="field-input field-select" aria-label="Як рахувати"><option value="area">за м²</option><option value="fixed">з приміщення</option><option value="residents">з проживаючого</option></select>
                <button type="button" class="btn-ghost-small" data-act="component-add">Додати складову</button>
            </div>
            <h3 class="ch-sub">Групи приміщень</h3>
            <p class="ch-chips">${ctx.groups.map(g => `<span class="buh-tag">${escapeHtml(g.name)}</span>`).join(' ')}</p>
            <div class="buh-inline-form ch-form">
                <input id="grName" class="field-input" maxlength="60" placeholder="Нова група, напр. «Паркінг» або «Комори»" aria-label="Назва групи">
                <button type="button" class="btn-ghost-small" data-act="group-add">Додати групу</button>
            </div>
        </section>`;
}

// ------------------------------------------------------------
// ПРИМІЩЕННЯ
// ------------------------------------------------------------
function premisesRows() {
    const q = (document.getElementById('prQuery')?.value || '').trim().toLowerCase();
    const charge = new Map(ctx.preview.rows.map(r => [r.apt, r.amountKop]));
    const problem = new Map(ctx.preview.problems.map(r => [r.apt, r.reason]));
    const list = ctx.apartments.filter(a => !q || a.apt.startsWith(q))
        .sort((a, b) => a.apt.localeCompare(b.apt, 'uk', { numeric: true }));
    if (!list.length) return '<p class="list-empty">Нічого не знайдено</p>';
    return `<table class="buh-table"><thead><tr><th>Прим.</th><th>Площа, м²</th><th>Проживає</th><th>Група</th><th class="t-sum">Внесок за ${escapeHtml(periodName(ctx.preview.period))}</th></tr></thead>
        <tbody>${list.map(a => `<tr data-apt="${escapeHtml(a.apt)}"><td><b>${escapeHtml(a.apt)}</b></td><td>${a.area ? escapeHtml(area(a.area)) : '<span class="buh-tag is-review">немає</span>'}</td>
            <td><input class="field-input pr-res" inputmode="numeric" maxlength="2" value="${a.residents ?? ''}" placeholder="—" aria-label="Проживає"></td>
            <td><select class="field-input field-select pr-group" aria-label="Група">${ctx.groups.map(g => `<option value="${escapeHtml(g.id)}"${(ctx.premises[a.apt] || 'res') === g.id ? ' selected' : ''}>${escapeHtml(g.name)}</option>`).join('')}</select></td>
            ${charge.has(a.apt) ? kopCell(charge.get(a.apt)) : `<td class="t-sum t-muted">${escapeHtml(problem.get(a.apt) || '—')}</td>`}</tr>`).join('')}</tbody></table>`;
}

function premisesHtml() {
    const counts = ctx.groups.map(g => `${escapeHtml(g.name)}: ${ctx.apartments.filter(a => (ctx.premises[a.apt] || 'res') === g.id).length}`).join(' · ');
    return `<section class="buh-card">
            <div class="buh-card-head"><h2>Приміщення</h2><span>${counts}</span></div>
            <div class="buh-inline-form ch-form">
                <input id="prBulk" class="field-input" placeholder="Кілька приміщень через кому: н1, н2, 101" aria-label="Приміщення">
                <select id="prBulkGroup" class="field-input field-select" aria-label="Група">${ctx.groups.map(g => `<option value="${escapeHtml(g.id)}">${escapeHtml(g.name)}</option>`).join('')}</select>
                <button type="button" class="btn-soft btn-compact" data-act="premises-bulk">Призначити групу</button>
            </div>
            <div class="buh-inline-form ch-form">
                <input id="resBulk" class="field-input" placeholder="Проживаючі списком: «298;2» або «298 2», кожна квартира з нового рядка чи через кому" aria-label="Проживаючі">
                <button type="button" class="btn-soft btn-compact" data-act="residents-bulk">Внести проживаючих</button>
            </div>
            <div class="buh-toolbar"><input type="search" id="prQuery" class="field-input buh-search" placeholder="Номер приміщення"></div>
            <div id="prTable">${premisesRows()}</div>
            <p class="buh-note">Площу веде правління в довіднику квартир (панель правління → «Квартири»). Без площі приміщенню не нараховується.</p>
        </section>`;
}

// ------------------------------------------------------------
// ВХІДНІ ЗАЛИШКИ
// ------------------------------------------------------------
function openingPreview() {
    const host = document.getElementById('opPreview');
    if (!host) return;
    const { rows, errors } = parseOpeningLines(document.getElementById('opText')?.value, openingSign);
    if (!rows.length && !errors.length) { host.innerHTML = ''; return; }
    const known = new Set(ctx.apartments.map(a => a.apt));
    const unknown = rows.filter(r => !known.has(r.apt)).map(r => r.apt);
    const s = openingSummary(rows);
    const missing = ctx.apartments.length - rows.filter(r => known.has(r.apt)).length;
    host.innerHTML = `<div class="kpi-grid ch-kpi">
            <div class="kpi"><span>Рядків</span><b>${s.count}</b><small>${missing > 0 ? `${missing} прим. без рядка — буде 0` : 'усі приміщення'}</small></div>
            <div class="kpi"><span>Борг</span><b class="is-out">${fmtKop(s.debtKop)}</b><small>${s.debtors} кв.</small></div>
            <div class="kpi"><span>Переплата</span><b class="is-in">${fmtKop(s.overpaidKop)}</b><small>${rows.filter(r => r.amountKop > 0).length} кв.</small></div>
        </div>
        ${unknown.length ? `<p class="buh-note ch-warn">Немає в довіднику: ${unknown.slice(0, 10).map(escapeHtml).join(', ')} — виправте перед збереженням</p>` : ''}
        ${errors.length ? `<p class="buh-note ch-warn">Незрозумілі рядки: ${errors.slice(0, 6).map(e => `№${e.line} «${escapeHtml(e.raw.slice(0, 30))}»`).join(', ')}</p>` : ''}
        <p class="buh-note">Перевірте знак: ${rows.slice(0, 3).map(r => `кв. ${escapeHtml(r.apt)} — ${r.amountKop < 0 ? 'борг' : r.amountKop > 0 ? 'переплата' : 'розраховано'} ${fmtKop(Math.abs(r.amountKop))}`).join('; ')}</p>`;
}

function openingHtml() {
    const o = ctx.opening;
    return `<section class="buh-card">
            <div class="buh-card-head"><h2>Вхідні залишки на 30.09.2026</h2>${o?.set ? `<span class="buh-tag is-payment">внесено</span>` : '<span class="buh-tag is-review">не внесено</span>'}</div>
            ${o?.set ? `<p class="buh-note">${o.count} кв. · борг ${fmtKop(o.debtKop)} · переплата ${fmtKop(o.overpaidKop)} грн · ${escapeHtml(o.by || '')}${o.at ? `, ${escapeHtml(dateOnly(o.at))}` : ''}.
                Баланс у кабінетах мешканців рахує система: залишок + оплати − нарахування.</p>
                <div class="inbox-actions"><button type="button" class="btn-ghost-small" data-act="recompute">Перерахувати баланси з історії</button></div>`
            : '<p class="buh-note">Борги й переплати кожної квартири на кінець 30.09.2026 — з сервісу бухгалтера. З ними система почне рахувати баланс мешканців сама. Доти баланс веде бухгалтер вручну, як раніше.</p>'}
            <h3 class="ch-sub">${o?.set ? 'Виправити залишки' : 'Внести залишки'}</h3>
            <p class="buh-note">Рядок — «квартира;сума» (можна вставити два стовпці з Excel). Приміщення без рядка отримає 0. Повторне збереження замінює весь список.</p>
            <div class="buh-seg ch-sign">
                <button type="button" class="buh-seg-item${openingSign === 'overpaid' ? ' active' : ''}" data-sign="overpaid">Мінус — борг (як у застосунку)</button>
                <button type="button" class="buh-seg-item${openingSign === 'debt' ? ' active' : ''}" data-sign="debt">Плюс — борг (сальдо)</button>
            </div>
            <textarea id="opText" class="field-input ch-textarea" rows="8" spellcheck="false" placeholder="45;-1250,40&#10;46;210,00&#10;н1;0"></textarea>
            <div id="opPreview"></div>
            <div class="inbox-actions">
                <button type="button" class="btn-primary btn-compact" data-act="opening-save">Зберегти залишки</button>
                <button type="button" class="btn-ghost-small" data-act="opening-fill">Заповнити з поточних балансів</button>
            </div>
        </section>`;
}

// ------------------------------------------------------------
// КВИТАНЦІЇ
// ------------------------------------------------------------
/**
 * Розрахунок за статтями — як у квитанції сервісу бухгалтера: баланс до
 * нарахування (плюс — борг, мінус — переплата), нараховано, сплачено за
 * період, до сплати за кожною статтею.
 */
function receiptPartsHtml(r, comps, charge) {
    const p = r.parts;
    if (!p) return '';
    const used = comps.filter(c => [p.opening, p.charged, p.paid].some(m => m[c.id]));
    if (used.length < 2) return '';
    const calc = c => {
        const part = charge?.parts?.find(x => x.component === c.id);
        if (!part) return '';
        return part.base === 'fixed' ? 'з приміщення' : part.base === 'residents' ? `${part.residents} прож. × ${rate(part.rate4)}` : `${area(charge.areaCenti / 100)} м² × ${rate(part.rate4)}`;
    };
    return `<table class="rc-parts"><thead><tr><th>Стаття</th><th>Баланс до нарахування</th><th>Нараховано</th><th>Сплачено за період</th><th>До сплати</th></tr></thead>
        <tbody>${used.map(c => `<tr><td>${escapeHtml(c.name)}${calc(c) ? `<small>${escapeHtml(calc(c))}</small>` : ''}</td>
            <td>${fmtKop(-(p.opening[c.id] || 0))}</td><td>${fmtKop(p.charged[c.id] || 0)}</td><td>${fmtKop(p.paid[c.id] || 0)}</td>
            <td>${fmtKop(Math.max(0, -(p.closing[c.id] || 0)))}</td></tr>`).join('')}</tbody></table>`;
}

async function receiptHtml(r, a, req, period, qrcode, comps = []) {
    const due = Math.max(0, -r.closing);
    const purpose = receiptPurpose(req.purposeTemplate, r.apt, a.personalAccount, period);
    let qr = '';
    try {
        const links = paymentLinks({ name: req.payeeName, iban: req.iban, code: req.edrpou, amount: due ? due / 100 : null, purpose, reference: `KV${r.apt}` });
        const code = qrcode(0, 'Q');
        code.addData(links.link);
        code.make();
        qr = `<div class="rc-qr">${code.createSvgTag({ cellSize: 3, margin: 1, scalable: true })}<span aria-hidden="true">₴</span></div>`;
    } catch { /* немає реквізитів — квитанція без QR */ }
    const charge = ctx.preview.period === period ? ctx.preview.rows.find(x => x.apt === r.apt) : null;
    return `<article class="rc">
        <header><b>${escapeHtml(req.payeeName || 'ОСББ')}</b><span>Рахунок-квитанція за ${escapeHtml(periodName(period))}</span></header>
        <div class="rc-body">
            <div class="rc-main">
                <p class="rc-apt">Кв. ${escapeHtml(r.apt)}${a.personalAccount ? ` · о/р ${escapeHtml(a.personalAccount)}` : ''}${a.area ? ` · ${escapeHtml(area(a.area))} м²` : ''}</p>
                ${receiptPartsHtml(r, comps, charge)}
                <table><tbody>
                    <tr><td>${r.opening < 0 ? 'Борг' : r.opening > 0 ? 'Переплата' : 'Залишок'} на ${escapeHtml(periodStart(period))}</td><td>${fmtKop(Math.abs(r.opening))}</td></tr>
                    <tr><td>Нараховано${charge && !(charge.parts?.length > 1) ? ` (${escapeHtml(area(charge.areaCenti / 100))} м² × ${rate(charge.rate4)})` : ''}</td><td>${fmtKop(r.charged)}</td></tr>
                    <tr><td>Сплачено за місяць</td><td>${fmtKop(r.paid)}</td></tr>
                    <tr class="rc-total"><td>${due ? 'До сплати' : r.closing > 0 ? 'Переплата' : 'Розраховано'}</td><td>${fmtKop(due || r.closing)} грн</td></tr>
                </tbody></table>
                <p class="rc-req">${escapeHtml([req.iban, req.edrpou ? `ЄДРПОУ ${req.edrpou}` : ''].filter(Boolean).join(' · '))}<br>${escapeHtml(purpose)}</p>
            </div>
            ${qr ? `<div class="rc-pay">${qr}<small>Наведіть камеру телефону — переказ відкриється заповненим</small></div>` : ''}
        </div>
    </article>`;
}

async function showReceipts(btn) {
    setBusy(btn, true, 'Готую…');
    try {
        const [st, req, { default: qrcode }] = await Promise.all([loadStatement(stPeriod), loadRequisites(), import('./vendor/qrcode.js')]);
        const extra = new Map(ctx.apartments.map(a => [a.apt, a]));
        const rows = statementRows(st);
        if (!rows.length) { toast('Немає квартир для квитанцій', 'error'); return; }
        const cards = [];
        for (const r of rows) cards.push(await receiptHtml(r, extra.get(r.apt) || {}, req, st.period, qrcode, st.components || []));
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
    } finally { setBusy(btn, false); }
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
export async function loadChargesView() {
    ctx = await loadCharges();
    const host = document.getElementById('viewCharges');
    const body = segment === 'month' ? monthHtml() : segment === 'statement' ? await statementHtml()
        : segment === 'tariffs' ? tariffsHtml() : segment === 'premises' ? premisesHtml() : openingHtml();
    host.innerHTML = `<div class="buh-seg ch-segs" role="tablist">${Object.entries(SEGMENTS).map(([k, v]) =>
            `<button type="button" class="buh-seg-item${k === segment ? ' active' : ''}" data-seg="${k}">${v}</button>`).join('')}</div>
        ${body}`;
    return ctx.due.length;
}

/** Нарахувати місяць: сума, яку бачила людина, звіряється на сервері. */
export async function runCharges(period, expectTotalKop) {
    const r = await chargeAct({ action: 'run', period, expectTotalKop });
    toast(`Нараховано за ${periodName(period)}: ${r.count} прим., ${fmtKop(r.totalKop)} грн`, 'success');
    if (r.problems?.length) toast(`Без нарахування: ${r.problems.length} прим. — див. «Нарахування»`, 'info');
    return r;
}

async function onAction(btn) {
    const a = btn.dataset.act;
    const period = btn.dataset.period;
    try {
        if (a === 'run') {
            setBusy(btn, true, 'Нараховую…');
            await runCharges(period, ctx.preview.period === period ? ctx.preview.totalKop : undefined);
        } else if (a === 'recalc') {
            if (!await confirmDialog(`Перерахувати ${periodName(period)}?`, 'Суми буде перераховано за поточними площами й тарифами. Записи в історії квартир оновляться, баланси теж.', 'Перерахувати')) return;
            setBusy(btn, true, 'Рахую…');
            const r = await chargeAct({ action: 'run', period });
            toast(r.changed ? `Перераховано: змінилося ${r.changed} прим.` : 'Суми не змінилися', 'success');
        } else if (a === 'revert') {
            if (!await confirmDialog(`Скасувати нарахування за ${periodName(period)}?`, 'Записи «Нарахування» за цей місяць буде прибрано з історії всіх квартир, баланси перераховано.', 'Скасувати нарахування')) return;
            setBusy(btn, true);
            await chargeAct({ action: 'revert', period });
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
        } else if (a === 'component-add') {
            await chargeAct({ action: 'addComponent', name: val('cpName'), base: val('cpBase') });
            toast('Складову додано — внесіть для неї тарифи', 'success');
        } else if (a === 'tariff-add') {
            setBusy(btn, true);
            await chargeAct({ action: 'addTariff', component: val('tfComp'), group: val('tfGroup'), rate: val('tfRate'), from: val('tfFrom'), decision: val('tfDecision') });
            toast('Тариф додано', 'success');
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
        } else if (a === 'opening-fill') {
            const lines = ctx.apartments.filter(x => x.balance !== null && x.balance !== '' && x.balance !== undefined)
                .map(x => `${x.apt};${String(Number(x.balance).toFixed(2)).replace('.', ',')}`);
            openingSign = 'overpaid';
            document.querySelectorAll('[data-sign]').forEach(b => b.classList.toggle('active', b.dataset.sign === 'overpaid'));
            document.getElementById('opText').value = lines.join('\n');
            openingPreview();
            toast(lines.length ? `Взято балансів: ${lines.length}. Звірте з сервісом бухгалтера.` : 'У картках квартир балансів немає', lines.length ? 'success' : 'error');
        } else if (a === 'opening-save') {
            const { rows, errors } = parseOpeningLines(val('opText'), openingSign);
            if (!rows.length) { toast('Немає жодного рядка', 'error'); return; }
            if (errors.length) { toast(`Спершу виправте рядок №${errors[0].line}`, 'error'); return; }
            const s = openingSummary(rows);
            if (!await confirmDialog('Зберегти вхідні залишки?', `${s.count} кв.: борг ${fmtKop(s.debtKop)} грн, переплата ${fmtKop(s.overpaidKop)} грн. Після цього баланс мешканців рахує система, ручне редагування балансу вимкнеться.`, 'Зберегти')) return;
            setBusy(btn, true, 'Зберігаю…');
            const r = await chargeAct({ action: 'setOpening', rows });
            toast(`Залишки внесено. Оновлено балансів: ${r.balances}`, 'success');
        } else if (a === 'recompute') {
            setBusy(btn, true, 'Рахую…');
            const r = await chargeAct({ action: 'recompute' });
            toast(r.updated ? `Оновлено балансів: ${r.updated}` : 'Баланси вже збігаються з історією', 'success');
        } else if (a === 'csv') {
            downloadCsv(await loadStatement(stPeriod));
        } else if (a === 'receipts') {
            await showReceipts(btn);
        }
    } catch (e) {
        toast(e.message, 'error');
    } finally { setBusy(btn, false); }
}

const val = id => document.getElementById(id)?.value?.trim() || '';

export function initChargesView(isActive) {
    const host = document.getElementById('viewCharges');
    host.addEventListener('click', e => {
        const seg = e.target.closest('[data-seg]');
        if (seg) { segment = seg.dataset.seg; loadChargesView().catch(err => toast(err.message, 'error')); return; }
        const f = e.target.closest('[data-stfilter]');
        if (f) {
            stFilter = f.dataset.stfilter;
            host.querySelectorAll('[data-stfilter]').forEach(b => b.classList.toggle('active', b === f));
            loadStatement(stPeriod).then(st => { document.getElementById('stTable').innerHTML = statementTable(st); });
            return;
        }
        const sign = e.target.closest('[data-sign]');
        if (sign) {
            openingSign = sign.dataset.sign;
            host.querySelectorAll('[data-sign]').forEach(b => b.classList.toggle('active', b === sign));
            openingPreview();
            return;
        }
        const btn = e.target.closest('[data-act]');
        if (btn && !btn.disabled) onAction(btn);
    });
    host.addEventListener('input', e => {
        if (e.target.id === 'opText') openingPreview();
        if (e.target.id === 'prQuery') document.getElementById('prTable').innerHTML = premisesRows();
        if (e.target.id === 'stQuery') loadStatement(stPeriod).then(st => { document.getElementById('stTable').innerHTML = statementTable(st); });
    });
    host.addEventListener('change', async e => {
        if (e.target.id === 'stPeriod') { stPeriod = e.target.value; loadChargesView().catch(err => toast(err.message, 'error')); return; }
        const res = e.target.closest('.pr-res');
        if (res) {
            try {
                await chargeAct({ action: 'setResidents', rows: [{ apt: res.closest('[data-apt]').dataset.apt, residents: res.value.trim() }] });
                toast('Збережено', 'success');
            } catch (err) { toast(err.message, 'error'); }
            return;
        }
        const select = e.target.closest('.pr-group');
        if (!select) return;
        try {
            await chargeAct({ action: 'setPremises', apts: [select.closest('[data-apt]').dataset.apt], group: select.value });
            toast('Збережено', 'success');
        } catch (err) { toast(err.message, 'error'); }
    });
    // Enter на вкладці «Місяць» — нарахувати (як у «Вхідних»).
    document.addEventListener('keydown', e => {
        if (!isActive() || segment !== 'month' || e.key !== 'Enter' || e.target.matches('input, textarea, select, button, a') || document.querySelector('.confirm-overlay')) return;
        const btn = host.querySelector('[data-act="run"]:not([disabled])');
        if (btn) { e.preventDefault(); onAction(btn); }
    });
}
