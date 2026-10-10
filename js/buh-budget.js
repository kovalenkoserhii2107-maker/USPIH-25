// ============================================================
// «Кошторис»: план на рік за статтями статуту, виконання (план/факт),
// затвердження загальними зборами, звіт для мешканців і річний звіт.
//
// Факт рахує сервер (budgetAction): документи витрат за місяцем
// послуги й списання без документа. Кошторис затверджують збори — у
// системі це запис протоколу; зміни до затвердженого — лише з новим.
// ============================================================
import { escapeHtml, toast, setBusy, confirmDialog, promptDialog } from './ui.js';
import { loadBudget, budgetAct } from './buh-data.js';
import { fmtKop, toKop } from './charges-core.js';
import { opsListHtml, opsFilterHtml, opsInMonth, opsTotalKop } from './finance-ops.js';

let year = String(new Date().getFullYear());
let ctx = null;
let edit = null;            // робоча копія { lines, income, mode: 'draft'|'amend' }

const pct = (fact, plan) => (plan > 0 ? Math.round(fact / plan * 100) : null);
const human = iso => (iso ? new Date(iso).toLocaleDateString('uk-UA') : '');
const money2 = k => (k ? (k / 100).toFixed(2).replace('.', ',') : '');

/** Відкрити розділ на потрібному році (із «Вхідних»). */
export function openBudget(y) {
    if (y) year = String(y);
    if (location.hash !== '#budget') location.hash = 'budget';
    else loadBudgetView();
}

// ------------------------------------------------------------
// ПЛАН/ФАКТ
// ------------------------------------------------------------
function bar(fact, toDate) {
    const p = pct(fact, toDate);
    if (p === null) return '<span class="t-muted">—</span>';
    return `<span class="bd-bar${p > 100 ? ' is-over' : ''}" title="${p}% від плану на сьогодні"><i style="width:${Math.min(100, p)}%"></i></span><small>${p}%</small>`;
}

function executionHtml() {
    const ex = ctx.execution;
    if (!ex.sections.length && !ex.income.length) return '<section class="buh-card"><p class="list-empty">Ні плану, ні фактичних витрат за цей рік ще немає</p></section>';
    const groupTitle = item => Object.values(ctx.groups).find(g => g.items.includes(item))?.title || '';
    return ex.sections.map(s => {
        let lastGroup = null;
        const rows = s.lines.map(l => {
            const g = groupTitle(l.item);
            const head = s.id === 'main' && g !== lastGroup ? `<tr class="bd-group"><td colspan="5">${escapeHtml(g)}</td></tr>` : '';
            lastGroup = g;
            const n = ctx.ops?.[l.item]?.length || 0;
            const title = n ? `<button type="button" class="bd-open" data-act="ops" data-item="${escapeHtml(l.item)}" aria-expanded="false"><b>${escapeHtml(l.title)}</b><small>операцій: ${n}</small></button>` : `<b>${escapeHtml(l.title)}</b>`;
            return `${head}<tr${l.outside ? ' class="bd-outside"' : ''}><td class="t-main">${title}${l.outside ? '<small>поза кошторисом</small>' : ''}</td>
                <td class="t-sum">${fmtKop(l.planKop)}</td><td class="t-sum t-muted">${fmtKop(l.toDateKop)}</td>
                <td class="t-sum${l.factKop > l.toDateKop && l.toDateKop ? ' is-out' : ''}">${fmtKop(l.factKop)}</td><td class="bd-cell">${bar(l.factKop, l.toDateKop)}</td></tr>`;
        }).join('');
        return `<section class="buh-card">
            <div class="buh-card-head"><h2>${escapeHtml(s.title)}</h2><span>${fmtKop(s.factKop)} з ${fmtKop(s.planKop)} грн</span></div>
            <table class="buh-table bd-table"><thead><tr><th>Стаття</th><th class="t-sum">План на рік</th><th class="t-sum">План на сьогодні</th><th class="t-sum">Факт</th><th>Виконання</th></tr></thead>
                <tbody>${rows}</tbody>
                <tfoot><tr><td>Разом</td><td class="t-sum">${fmtKop(s.planKop)}</td><td class="t-sum">${fmtKop(s.toDateKop)}</td><td class="t-sum">${fmtKop(s.factKop)}</td><td class="bd-cell">${bar(s.factKop, s.toDateKop)}</td></tr></tfoot></table>
        </section>`;
    }).join('') + (ex.income.length ? `<section class="buh-card">
            <div class="buh-card-head"><h2>Надходження</h2><span>${fmtKop(ex.totals.incomeFactKop)} з ${fmtKop(ex.totals.incomePlanKop)} грн</span></div>
            <table class="buh-table bd-table"><thead><tr><th>Джерело</th><th class="t-sum">План на рік</th><th class="t-sum">План на сьогодні</th><th class="t-sum">Факт</th><th>Виконання</th></tr></thead>
                <tbody>${ex.income.map(i => `<tr><td><b>${escapeHtml(i.title)}</b></td><td class="t-sum">${fmtKop(i.planKop)}</td><td class="t-sum t-muted">${fmtKop(i.toDateKop)}</td>
                    <td class="t-sum is-in">${fmtKop(i.factKop)}</td><td class="bd-cell">${bar(i.factKop, i.toDateKop)}</td></tr>
                    ${(i.parts || []).map(p => `<tr class="bd-sub"><td>${escapeHtml(p.title)}</td><td></td><td></td><td class="t-sum">${fmtKop(p.factKop)}</td><td></td></tr>`).join('')}`).join('')}</tbody></table>
            <p class="buh-note">Внески — оплати мешканців з виписки; «план на сьогодні» — частка річного плану за ${ex.months} міс. обліку в застосунку.</p>
        </section>` : '');
}

// ------------------------------------------------------------
// РЕДАГУВАННЯ
// ------------------------------------------------------------
function startEdit(mode) {
    const b = ctx.budget;
    const lines = b?.lines?.length ? b.lines.map(l => ({ ...l })) : Object.keys(ctx.items).map(item => ({ item, title: '', planKop: 0 }));
    const income = Object.keys(ctx.incomeSources).map(source => ({ source, planKop: b?.income?.find(i => i.source === source)?.planKop || 0 }));
    edit = { mode, lines, income };
    loadBudgetView();
}

function editorHtml() {
    const total = edit.lines.reduce((s, l) => s + (l.planKop || 0), 0);
    const income = edit.income.reduce((s, i) => s + (i.planKop || 0), 0);
    const options = sel => Object.entries(ctx.items).map(([k, v]) => `<option value="${k}"${k === sel ? ' selected' : ''}>${escapeHtml(v)}</option>`).join('');
    return `<section class="buh-card bd-editor">
        <div class="buh-card-head"><h2>${edit.mode === 'amend' ? `Зміни до кошторису ${year}` : `Кошторис ${year} — чернетка`}</h2><button type="button" class="btn-ghost-small" data-act="cancel-edit">Закрити</button></div>
        <p class="buh-note">Суми — на рік, у гривнях. Ремонтний і резервний фонди — окремими кошторисами (п. 4.12.4 статуту): статті «Капітальний ремонт» і «Резервний фонд». Рядки з нулем при збереженні прибираються.</p>
        <table class="buh-table bd-edit"><thead><tr><th>Стаття</th><th>Уточнення (необовʼязково)</th><th class="t-sum">План на рік, грн</th><th></th></tr></thead>
            <tbody>${edit.lines.map((l, i) => `<tr data-i="${i}">
                <td><select class="field-input field-select bd-item" aria-label="Стаття">${options(l.item)}</select></td>
                <td><input class="field-input bd-title" maxlength="120" value="${escapeHtml(l.title || '')}" placeholder="напр. Ремонт покрівлі"></td>
                <td><input class="field-input bd-plan" inputmode="decimal" value="${money2(l.planKop)}" placeholder="0,00"></td>
                <td class="t-act"><button type="button" class="btn-ghost-small" data-act="del-line" aria-label="Прибрати">✕</button></td></tr>`).join('')}</tbody>
            <tfoot><tr><td colspan="2"><button type="button" class="btn-ghost-small" data-act="add-line">+ рядок</button></td><td class="t-sum"><b id="bdTotal">${fmtKop(total)}</b></td><td></td></tr></tfoot></table>
        <h3 class="ch-sub">Надходження на рік</h3>
        <table class="buh-table bd-edit"><tbody>${edit.income.map((r, i) => `<tr data-k="${i}"><td>${escapeHtml(ctx.incomeSources[r.source])}</td>
            <td><input class="field-input bd-income" inputmode="decimal" value="${money2(r.planKop)}" placeholder="0,00"></td>
            <td>${r.source === 'contributions' && ctx.contributionsYearKop ? `<button type="button" class="btn-ghost-small" data-act="from-tariffs">З тарифів: ${fmtKop(ctx.contributionsYearKop)}</button>` : ''}</td></tr>`).join('')}</tbody>
            <tfoot><tr><td>Разом</td><td class="t-sum"><b id="bdIncome">${fmtKop(income)}</b></td><td id="bdGap">${gapHtml(total, income)}</td></tr></tfoot></table>
        ${edit.mode === 'amend' ? `<label class="field"><span class="field-label">Рішення загальних зборів про зміни (протокол, дата)</span><input id="bdDecision" class="field-input" maxlength="200"></label>` : ''}
        <div class="pay-form-actions">
            ${edit.mode === 'amend' ? '<button type="button" class="btn-primary" data-act="amend">Зберегти зміни</button>'
                : '<button type="button" class="btn-primary" data-act="save">Зберегти чернетку</button>'}
        </div>
    </section>`;
}

const gapHtml = (spend, income) => (income && spend > income
    ? `<span class="ch-warn">Витрати більші за надходження на ${fmtKop(spend - income)} грн</span>`
    : income ? `<span class="t-muted">Профіцит ${fmtKop(income - spend)} грн</span>` : '');

function readEditor() {
    document.querySelectorAll('.bd-edit tr[data-i]').forEach(tr => {
        const l = edit.lines[Number(tr.dataset.i)];
        l.item = tr.querySelector('.bd-item').value;
        l.title = tr.querySelector('.bd-title').value.trim();
        l.planKop = toKop(tr.querySelector('.bd-plan').value || '0') ?? NaN;
    });
    document.querySelectorAll('.bd-edit tr[data-k]').forEach(tr => {
        edit.income[Number(tr.dataset.k)].planKop = toKop(tr.querySelector('.bd-income').value || '0') ?? NaN;
    });
    const bad = edit.lines.find(l => Number.isNaN(l.planKop)) || edit.income.find(i => Number.isNaN(i.planKop));
    if (bad) throw new Error('Суми — у гривнях, до двох знаків після коми');
    return { lines: edit.lines.filter(l => l.planKop > 0), income: edit.income.filter(i => i.planKop > 0) };
}

// ------------------------------------------------------------
// РІЧНИЙ ЗВІТ (п. 4.12.5 статуту)
// ------------------------------------------------------------
function printReport() {
    const ex = ctx.execution;
    const t = ex.totals;
    const rows = list => list.map(l => `<tr><td>${escapeHtml(l.title)}${l.outside ? ' (поза кошторисом)' : ''}</td><td>${fmtKop(l.planKop)}</td><td>${fmtKop(l.factKop)}</td><td>${fmtKop(l.factKop - l.planKop)}</td></tr>`
        + (l.parts || []).map(p => `<tr class="bd-sub"><td>у т.ч. ${escapeHtml(p.title)}</td><td></td><td>${fmtKop(p.factKop)}</td><td></td></tr>`).join('')).join('');
    let host = document.getElementById('buhPrint');
    if (!host) { host = document.createElement('div'); host.id = 'buhPrint'; document.body.appendChild(host); }
    host.innerHTML = `<div class="rc-bar"><b>Звіт про виконання кошторису за ${escapeHtml(year)} рік</b>
            <button type="button" class="btn-primary btn-compact" data-print>Друкувати</button><button type="button" class="btn-ghost-small" data-close>Закрити</button></div>
        <div class="rc-list"><article class="rc bd-report">
            <header><b>ОСББ «Успіх-25»</b><span>станом на ${escapeHtml(human(new Date().toISOString()))}</span></header>
            <h2>Звіт про виконання кошторису за ${escapeHtml(year)} рік</h2>
            <p>Кошторис: ${ctx.effective ? `${escapeHtml(ctx.effective.year)} рік, ${escapeHtml(ctx.effective.decision || 'рішення не вказано')}${ctx.effective.carried ? ' (діє попередній — п. 4.12.2 статуту)' : ''}` : 'не затверджено'}.
                Облік у застосунку — з 01.10.2026; дані до цієї дати — у звітності попереднього бухгалтера.</p>
            ${ex.sections.map(s => `<h3>${escapeHtml(s.title)}</h3><table><thead><tr><th>Стаття</th><th>План, грн</th><th>Факт, грн</th><th>Відхилення, грн</th></tr></thead>
                <tbody>${rows(s.lines)}</tbody><tfoot><tr><td>Разом</td><td>${fmtKop(s.planKop)}</td><td>${fmtKop(s.factKop)}</td><td>${fmtKop(s.factKop - s.planKop)}</td></tr></tfoot></table>`).join('')}
            <h3>Надходження</h3><table><thead><tr><th>Джерело</th><th>План, грн</th><th>Факт, грн</th><th>Відхилення, грн</th></tr></thead>
                <tbody>${rows(ex.income)}</tbody><tfoot><tr><td>Разом</td><td>${fmtKop(t.incomePlanKop)}</td><td>${fmtKop(t.incomeFactKop)}</td><td>${fmtKop(t.incomeFactKop - t.incomePlanKop)}</td></tr></tfoot></table>
            <p>Загальна заборгованість співвласників: ${fmtKop(ctx.debt.totalKop)} грн (${ctx.debt.count} кв.).${ctx.fundsKop !== null ? ` Залишок коштів на рахунках: ${fmtKop(ctx.fundsKop)} грн.` : ''}</p>
            <div class="bd-signs"><span>Голова правління ____________</span><span>Бухгалтер ____________</span><span>Ревізійна комісія (ревізор) ____________</span></div>
            <p class="rc-req">Звіт подається ревізійній комісії, потім загальним зборам (п. 4.12.5 статуту). Розрахунки перевіряє бухгалтер.</p>
        </article></div>`;
    document.body.classList.add('is-printing');
    host.querySelector('[data-print]').addEventListener('click', () => window.print());
    host.querySelector('[data-close]').addEventListener('click', () => { document.body.classList.remove('is-printing'); host.innerHTML = ''; });
}

// ------------------------------------------------------------
// РОЗДІЛ
// ------------------------------------------------------------
export async function loadBudgetView() {
    ctx = await loadBudget(year);
    const b = ctx.budget;
    const ex = ctx.execution;
    const now = Number(ctx.today.slice(0, 4));
    const years = [...new Set([String(now + 1), String(now), ...ctx.years.map(y => y.year)])].sort().reverse();
    const status = !b ? '<span class="buh-tag is-review">немає</span>' : b.status === 'approved' ? '<span class="buh-tag is-payment">затверджено</span>' : '<span class="buh-tag is-review">чернетка</span>';
    const p = ctx.publish;
    document.getElementById('viewBudget').innerHTML = `
        <div class="buh-toolbar bd-top">
            <select id="bdYear" class="field-input field-select ch-period" aria-label="Рік">${years.map(y => `<option value="${y}"${y === year ? ' selected' : ''}>${y} рік</option>`).join('')}</select>
            ${status}
            <span class="buh-note">${b?.status === 'approved' ? `Затверджено: ${escapeHtml(b.decision)}` : ctx.effective?.carried ? `Діє кошторис ${escapeHtml(ctx.effective.year)} року (п. 4.12.2 статуту), доки збори не затвердять новий` : 'Кошторис затверджують загальні збори до 01 січня (п. 4.12.2 статуту)'}</span>
            <span class="ch-tools">
                ${!edit && (!b || b.status === 'draft') ? `<button type="button" class="btn-soft btn-compact" data-act="edit">${b ? 'Редагувати' : 'Скласти кошторис'}</button>` : ''}
                ${!edit && !b && ctx.years.some(y => y.year === String(Number(year) - 1)) ? `<button type="button" class="btn-ghost-small" data-act="copy">Скопіювати з ${Number(year) - 1}</button>` : ''}
                ${!edit && b?.status === 'draft' ? '<button type="button" class="btn-primary btn-compact" data-act="approve">Затверджено зборами…</button>' : ''}
                ${!edit && b?.status === 'approved' ? '<button type="button" class="btn-ghost-small" data-act="amend-start">Внести зміни</button>' : ''}
                <button type="button" class="btn-ghost-small" data-act="report">Річний звіт</button>
            </span>
        </div>
        ${edit ? editorHtml() : ''}
        <div class="kpi-grid">
            <div class="kpi"><span>Витрати: факт / план на сьогодні</span><b${ex.totals.factKop > ex.totals.toDateKop && ex.totals.toDateKop ? ' class="is-out"' : ''}>${fmtKop(ex.totals.factKop)}</b><small>з ${fmtKop(ex.totals.toDateKop)} · на рік ${fmtKop(ex.totals.planKop)}</small></div>
            <div class="kpi"><span>Надходження</span><b class="is-in">${fmtKop(ex.totals.incomeFactKop)}</b><small>план на рік ${fmtKop(ex.totals.incomePlanKop)}</small></div>
            <div class="kpi"><span>Борг мешканців</span><b class="is-out">${fmtKop(-ctx.debt.totalKop)}</b><small>${ctx.debt.count} кв.</small></div>
            <button type="button" class="kpi kpi-action${p.stale ? ' is-alert' : ''}" data-act="publish"><span>Для мешканців</span><b>${p.stale ? 'Оновити' : 'Актуально'}</b><small>${p.at ? `опубліковано ${escapeHtml(human(p.at))}` : 'ще не публікувалося'}</small></button>
        </div>
        ${executionHtml()}
        ${b?.revisions?.length ? `<section class="buh-card"><div class="buh-card-head"><h2>Редакції</h2></div>
            <table class="buh-table is-compact"><tbody>${b.revisions.map(r => `<tr><td class="t-date">${escapeHtml(human(r.at))}</td><td>${escapeHtml(r.decision)}</td><td class="t-sum">${fmtKop(r.planKop)}</td><td class="t-muted">${escapeHtml(r.by)}</td></tr>`).join('')}</tbody></table></section>` : ''}`;
    return p.stale ? 1 : 0;
}

/** Оновити «Фінанси будинку» для мешканців. */
export async function publishFinance(y = year) {
    await budgetAct({ action: 'publish', year: y });
    toast('«Фінанси будинку» для мешканців оновлено', 'success');
}

async function onAction(btn) {
    const a = btn.dataset.act;
    try {
        if (a === 'edit') startEdit('draft');
        else if (a === 'amend-start') startEdit('amend');
        else if (a === 'cancel-edit') { edit = null; loadBudgetView(); }
        else if (a === 'add-line') { readEditorSafe(); edit.lines.push({ item: 'other', title: '', planKop: 0 }); loadBudgetView(); }
        else if (a === 'del-line') { readEditorSafe(); edit.lines.splice(Number(btn.closest('tr').dataset.i), 1); loadBudgetView(); }
        else if (a === 'from-tariffs') { readEditorSafe(); edit.income.find(i => i.source === 'contributions').planKop = ctx.contributionsYearKop; loadBudgetView(); }
        else if (a === 'save') {
            const data = readEditor();
            setBusy(btn, true, 'Зберігаю…');
            await budgetAct({ action: 'save', year, ...data });
            edit = null;
            toast('Чернетку кошторису збережено', 'success');
        } else if (a === 'amend') {
            const data = readEditor();
            const decision = document.getElementById('bdDecision').value.trim();
            setBusy(btn, true, 'Зберігаю…');
            await budgetAct({ action: 'amend', year, ...data, decision });
            edit = null;
            toast('Зміни до кошторису збережено', 'success');
        } else if (a === 'approve') {
            const decision = await promptDialog(`Кошторис ${year} затверджено зборами`, 'Вкажіть протокол загальних зборів і дату. Після цього кошторис змінюється лише з новим рішенням.', { confirmLabel: 'Записати', placeholder: 'Протокол № … від …', maxLength: 200 });
            if (!decision) return;
            await budgetAct({ action: 'approve', year, decision, files: [] });
            toast('Кошторис затверджено', 'success');
        } else if (a === 'copy') {
            await budgetAct({ action: 'copy', year, fromYear: String(Number(year) - 1) });
            toast('Чернетку створено з минулорічного кошторису', 'success');
        } else if (a === 'publish') {
            if (!await confirmDialog('Оновити «Фінанси будинку»?', 'Мешканці побачать виконання кошторису, витрати з документами й загальний борг будинку — без прізвищ і номерів квартир.', 'Оновити')) return;
            await publishFinance();
        } else if (a === 'report') printReport();
    } catch (e) { toast(e.message, 'error'); }
    finally { if (btn.isConnected) setBusy(btn, false); }
}

/** Розшифровка статті під рядком таблиці: хто й коли отримав гроші, з призначенням платежу. */
function opsRowHtml(item, month = '') {
    const list = ctx.ops?.[item] || [];
    const shown = opsInMonth(list, month);
    return `<tr class="bd-ops-row" data-ops-for="${escapeHtml(item)}"><td colspan="5">
        <div class="bd-ops"><p class="buh-note">Разом ${fmtKop(opsTotalKop(shown))} грн · операцій: ${shown.length}. Мешканці бачать те саме без імен фізичних осіб і без призначення платежу.</p>
        ${opsFilterHtml(list, month)}${opsListHtml(shown, { withPurpose: true })}</div></td></tr>`;
}

function toggleOps(btn) {
    const tr = btn.closest('tr');
    const open = tr.nextElementSibling?.classList.contains('bd-ops-row');
    if (open) tr.nextElementSibling.remove();
    else tr.insertAdjacentHTML('afterend', opsRowHtml(btn.dataset.item));
    btn.setAttribute('aria-expanded', String(!open));
}

function readEditorSafe() { try { readEditor(); } catch { /* незрозуміле число лишається як є */ } }

export function initBudgetView() {
    const host = document.getElementById('viewBudget');
    host.addEventListener('click', e => {
        const chip = e.target.closest('.bd-ops-row [data-fo-month]');
        if (chip) { const row = chip.closest('.bd-ops-row'); row.outerHTML = opsRowHtml(row.dataset.opsFor, chip.dataset.foMonth); return; }
        const btn = e.target.closest('[data-act]');
        if (btn?.dataset.act === 'ops') { toggleOps(btn); return; }
        if (btn && !btn.disabled) onAction(btn);
    });
    host.addEventListener('change', e => {
        if (e.target.id === 'bdYear') { year = e.target.value; edit = null; loadBudgetView(); }
    });
    host.addEventListener('input', e => {
        if (!e.target.closest('.bd-edit')) return;
        try {
            const { lines, income } = readEditor();
            const total = lines.reduce((s, l) => s + l.planKop, 0), inc = income.reduce((s, i) => s + i.planKop, 0);
            document.getElementById('bdTotal').textContent = fmtKop(total);
            document.getElementById('bdIncome').textContent = fmtKop(inc);
            document.getElementById('bdGap').innerHTML = gapHtml(total, inc);
        } catch { /* незакінчене число */ }
    });
}

