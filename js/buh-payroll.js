// ============================================================
// «Зарплата»: картки людей, табель і акти місяця, відомість з
// утриманнями (ПДФО, військовий збір) і ЄСВ, затвердження головою,
// платежі авансу й остаточного розрахунку в Приват24 на підпис голови.
//
// Рахує сервер (payrollAction, payroll-core.js). Персональні дані
// (РНОКПП, IBAN, оклад) бачать лише голова й бухгалтер.
// ============================================================
import { session } from './firebase.js';
import { escapeHtml, toast, setBusy, confirmDialog } from './ui.js';
import { loadPayroll, payrollAct, maskIban } from './buh-data.js';
import { fmtKop, toKop } from './charges-core.js';

const MONTHS = ['Січень', 'Лютий', 'Березень', 'Квітень', 'Травень', 'Червень', 'Липень', 'Серпень', 'Вересень', 'Жовтень', 'Листопад', 'Грудень'];
const monthTitle = p => `${MONTHS[Number(p.slice(5, 7)) - 1]} ${p.slice(0, 4)}`;
const shift = (p, n) => { const d = new Date(Date.UTC(Number(p.slice(0, 4)), Number(p.slice(5, 7)) - 1 + n, 1)); return d.toISOString().slice(0, 7); };
const money2 = k => (k ? (k / 100).toFixed(2).replace('.', ',') : '');

let period = null;
let ctx = null;
let editing = null;          // картка людини у формі: null — закрито, {} — нова

/** Відкрити розділ на місяці (із «Вхідних»). */
export function openPayroll(p) {
    if (p) period = p;
    if (location.hash !== '#payroll') location.hash = 'payroll';
    else loadPayrollView();
}

const STATUS = { none: ['не складено', 'is-review'], draft: ['чекає голову', 'is-review'], approved: ['затверджено', 'is-payment'] };

function runHtml() {
    const run = ctx.run;
    if (!run.rows.length) {
        return `<section class="buh-card"><p class="list-empty">${ctx.people.length ? 'У цьому місяці немає діючих працівників і договорів ЦПД' : 'Додайте працівників і виконавців за договорами ЦПД нижче — відомість складеться сама'}</p></section>`;
    }
    const locked = ctx.closed || Boolean(ctx.stages.final) || ctx.stages.advance?.complete === false;
    const rows = run.rows.map(r => {
        const input = r.kind === 'gph'
            ? `<input class="field-input pr-in" data-id="${escapeHtml(r.personId)}" data-k="actKop" inputmode="decimal" value="${money2(r.actKop)}" aria-label="Сума акта"${locked ? ' disabled' : ''}><small>акт, грн</small>`
            : `<input class="field-input pr-in pr-days" data-id="${escapeHtml(r.personId)}" data-k="workedDays" inputmode="numeric" value="${r.workedDays}" aria-label="Відпрацьовано днів"${locked ? ' disabled' : ''}><small>з ${r.normDays} дн.</small>`;
        const notes = [...r.problems.map(t => `<span class="is-out">${escapeHtml(t)}</span>`), ...r.warnings.map(t => escapeHtml(t))];
        return `<tr><td class="t-main"><b>${escapeHtml(r.name)}</b><small>${escapeHtml(r.kind === 'gph' ? 'договір ЦПД' : `${r.position || 'працівник'}${r.fte && r.fte < 1 ? ` · ставка ${r.fte}` : ''} · оклад ${fmtKop(r.salaryKop)}`)}</small>
                ${notes.length ? `<small class="pr-notes">${notes.join(' · ')}</small>` : ''}</td>
            <td class="pr-input">${input}</td>
            <td>${r.kind === 'employee' ? `<input class="field-input pr-in" data-id="${escapeHtml(r.personId)}" data-k="bonusKop" inputmode="decimal" value="${money2(r.bonusKop)}" placeholder="0,00" aria-label="Премія"${locked ? ' disabled' : ''}>
                <details class="pr-corr"${r.correctionKop ? ' open' : ''}><summary>перерахунок</summary>
                    <input class="field-input pr-in" data-id="${escapeHtml(r.personId)}" data-k="correctionKop" inputmode="decimal" value="${r.correctionKop ? (r.correctionKop / 100).toFixed(2).replace('.', ',') : ''}" placeholder="±0,00" aria-label="Перерахунок за минулий місяць, плюс чи мінус"${locked ? ' disabled' : ''}>
                    <input class="field-input pr-txt" type="month" data-id="${escapeHtml(r.personId)}" data-k="correctionFor" value="${escapeHtml(r.correctionFor || shift(ctx.period, -1))}" max="${shift(ctx.period, -1)}" aria-label="За який місяць"${locked ? ' disabled' : ''}>
                    <input class="field-input pr-txt" data-id="${escapeHtml(r.personId)}" data-k="correctionNote" maxlength="120" value="${escapeHtml(r.correctionNote || '')}" placeholder="причина" aria-label="Причина перерахунку"${locked ? ' disabled' : ''}>
                </details>` : ''}</td>
            <td class="t-sum">${fmtKop(r.grossKop)}</td><td class="t-sum t-muted">${fmtKop(r.pdfoKop + r.vzKop)}</td>
            <td class="t-sum"><b>${fmtKop(r.netKop)}</b></td><td class="t-sum t-muted">${fmtKop(r.esvKop)}</td>
            <td class="t-sum">${r.advance.netKop ? fmtKop(r.advance.netKop) : '—'}</td><td class="t-sum">${fmtKop(r.final.netKop)}</td></tr>`;
    }).join('');
    const t = run.totals;
    return `<section class="buh-card">
        <div class="buh-card-head"><h2>Відомість за ${escapeHtml(monthTitle(ctx.period).toLowerCase())}</h2><span>ставки: ПДФО ${run.rate.pdfo / 100} %, ВЗ ${run.rate.vz / 100} %, ЄСВ ${run.rate.esv / 100} % · МЗП ${fmtKop(run.rate.minWageKop)}</span></div>
        <div class="jr-scroll"><table class="buh-table pr-table"><thead><tr><th>Людина</th><th>Табель / акт</th><th>Премія</th><th class="t-sum">Нараховано</th><th class="t-sum">ПДФО+ВЗ</th><th class="t-sum">На руки</th><th class="t-sum">ЄСВ</th><th class="t-sum">Аванс</th><th class="t-sum">Решта</th></tr></thead>
            <tbody>${rows}</tbody>
            <tfoot><tr><td>Разом</td><td></td><td></td><td class="t-sum">${fmtKop(t.grossKop)}</td><td class="t-sum">${fmtKop(t.pdfoKop + t.vzKop)}</td><td class="t-sum">${fmtKop(t.netKop)}</td><td class="t-sum">${fmtKop(t.esvKop)}</td><td class="t-sum">${fmtKop(t.advance.netKop)}</td><td class="t-sum">${fmtKop(t.final.netKop)}</td></tr></tfoot></table></div>
        <p class="buh-note">ПДФО, військовий збір та ЄСВ сплачуються з кожною виплатою. З остаточним розрахунком — решта й доплата ЄСВ до мінімальної бази. Свята під час воєнного стану — робочі дні: норма — пн–пт.${ctx.stages.advance ? ' Аванс уже підготовлено — його суми не змінюються.' : ''}</p>
    </section>`;
}

function paymentsHtml() {
    if (!ctx.payments.length) return '';
    const STAT = { sending: 'надсилається', sent: 'на підписі в Приват24', paid: 'проведено', failed: 'банк не прийняв', unknown: 'перевірте у Приват24', canceled: 'скасовано' };
    return `<section class="buh-card"><div class="buh-card-head"><h2>Платежі за відомістю</h2></div>
        <table class="buh-table is-compact"><tbody>${ctx.payments.map(p => `<tr><td>${p.stage === 'advance' ? 'Аванс' : 'Зарплата'}</td><td class="t-main">${escapeHtml(p.recipient)}${p.error ? `<small class="is-out">${escapeHtml(p.error)}</small>` : ''}</td>
            <td class="t-sum">${fmtKop(p.amountKop)}</td><td>${p.returnedKop ? `<span class="buh-tag is-error">повернено банком${p.repaid ? ' · відправлено знову' : ''}</span>`
                : `<span class="buh-tag ${p.status === 'paid' ? 'is-payment' : p.status === 'failed' ? 'is-error' : 'is-review'}">${STAT[p.status] || p.status}${p.retry ? ' · повторно' : ''}</span>`}</td>
            <td class="t-act">${p.status === 'paid' && p.returnedKop >= p.amountKop && !p.repaid ? `<button type="button" class="btn-ghost-small" data-act="repay" data-id="${escapeHtml(p.id)}" title="Спершу виправте IBAN у картці людини чи рахунок податку">Відправити знову</button>` : ''}</td></tr>`).join('')}</tbody></table>
        ${ctx.payments.some(p => p.returnedKop) ? '<p class="buh-note">Повернений банком платіж: виправте IBAN у картці людини (або рахунок податку) і натисніть «Відправити знову» — новий платіж піде голові на підпис.</p>' : ''}</section>`;
}

function peopleHtml() {
    const list = ctx.people.slice().sort((a, b) => Number(b.active !== false) - Number(a.active !== false) || a.name.localeCompare(b.name, 'uk'));
    return `<section class="buh-card">
        <div class="buh-card-head"><h2>Працівники й виконавці</h2><button type="button" class="btn-soft btn-compact" data-act="person-new">Додати</button></div>
        ${list.length ? `<div class="jr-scroll"><table class="buh-table is-compact"><tbody>${list.map(p => `<tr${p.active === false ? ' class="t-muted"' : ''}>
            <td class="t-main"><b>${escapeHtml(p.name)}</b><small>${escapeHtml(ctx.kinds[p.kind])}${p.position ? ` · ${escapeHtml(p.position)}` : ''}${p.active === false ? ' · не діє' : ''}</small></td>
            <td>${p.kind === 'employee' ? `${fmtKop(p.salaryKop)}${p.fte < 1 ? ` · ${p.fte} ст.` : ''}` : 'за актами'}</td>
            <td class="t-muted">${p.iban ? escapeHtml(maskIban(p.iban)) : '<span class="is-out">немає IBAN</span>'}</td>
            <td>${p.kind === 'employee' && !p.taxNotified ? '<span class="buh-tag is-review">повідомити ДПС</span>' : ''}</td>
            <td class="t-act"><button type="button" class="btn-ghost-small" data-act="person-edit" data-id="${escapeHtml(p.id)}">Змінити</button></td></tr>`).join('')}</tbody></table></div>` : '<p class="list-empty">Ще нікого немає</p>'}
        ${editing ? personFormHtml(editing) : ''}
    </section>`;
}

function personFormHtml(p) {
    const gph = p.kind === 'gph';
    const f = (id, label, value, extra = '') => `<label class="field"><span class="field-label">${label}</span><input id="${id}" class="field-input" value="${escapeHtml(value ?? '')}" ${extra}></label>`;
    return `<div class="pay-form pr-form">
        <h3 class="ch-sub">${p.id ? 'Картка' : 'Нова людина'}</h3>
        <div class="rg-grid">
            ${f('pfName', 'Прізвище, імʼя, по батькові', p.name)}
            <label class="field"><span class="field-label">Договір</span><select id="pfKind" class="field-input field-select">${Object.entries(ctx.kinds).map(([k, v]) => `<option value="${k}"${k === (p.kind || 'employee') ? ' selected' : ''}>${v}</option>`).join('')}</select></label>
            ${f('pfPosition', 'Посада / роботи', p.position)}
            ${f('pfRnokpp', 'РНОКПП', p.rnokpp, 'inputmode="numeric" maxlength="10"')}
            ${f('pfIban', 'IBAN для виплати', p.iban, 'spellcheck="false"')}
            ${gph ? f('pfContract', 'Договір ЦПД (номер і дата)', p.contract) : `${f('pfSalary', 'Оклад, грн', money2(p.salaryKop), 'inputmode="decimal"')}
            ${f('pfFte', 'Ставка (1 — повна)', String(p.fte ?? 1).replace('.', ','), 'inputmode="decimal"')}`}
            ${f('pfFrom', gph ? 'Початок договору' : 'Прийнято', p.from, 'type="date"')}
            ${f('pfTo', gph ? 'Кінець договору' : 'Звільнено', p.to, 'type="date"')}
        </div>
        ${gph ? '' : `<label class="pr-check"><input id="pfMain" type="checkbox"${p.mainJob !== false ? ' checked' : ''}> Основне місце роботи (ЄСВ не менше ніж з мінімальної зарплати)</label>
        <label class="pr-check"><input id="pfNotified" type="checkbox"${p.taxNotified ? ' checked' : ''}> Повідомлення ДПС про прийняття подано (до початку роботи)</label>`}
        <label class="pr-check"><input id="pfActive" type="checkbox"${p.active !== false ? ' checked' : ''}> Діє (у відомості)</label>
        <div class="pay-form-actions"><button type="button" class="btn-primary btn-compact" data-act="person-save">Зберегти</button><button type="button" class="btn-ghost-small" data-act="person-cancel">Скасувати</button></div>
    </div>`;
}

function taxesHtml() {
    const t = ctx.settings.taxes || {};
    const row = (key, label) => `<tr data-tax="${key}"><td><b>${label}</b></td>
        <td><input class="field-input" data-f="name" value="${escapeHtml(t[key]?.name || '')}" placeholder="Отримувач (казначейство)" aria-label="Отримувач"></td>
        <td><input class="field-input" data-f="iban" value="${escapeHtml(t[key]?.iban || '')}" placeholder="UA…" spellcheck="false" aria-label="IBAN"></td>
        <td><input class="field-input" data-f="code" value="${escapeHtml(t[key]?.code || '')}" placeholder="Код ЄДРПОУ" inputmode="numeric" aria-label="Код"></td></tr>`;
    return `<section class="buh-card">
        <div class="buh-card-head"><h2>Податки й аванс</h2></div>
        <p class="buh-note">Рахунки для сплати — з Електронного кабінету ДПС («Бюджетні рахунки» для вашої громади). ПДФО й військовий збір — у день кожної виплати, ЄСВ — до 20 числа наступного місяця.</p>
        <div class="jr-scroll"><table class="buh-table is-compact pr-taxes"><tbody>${row('pdfo', 'ПДФО')}${row('vz', 'Військовий збір')}${row('esv', 'ЄСВ')}</tbody></table></div>
        <div class="buh-inline-form"><span>Аванс</span><input id="prAdvance" class="field-input ch-narrow" inputmode="numeric" value="${ctx.settings.advancePct}" aria-label="Аванс, %"><span>% нарахування</span>
            <button type="button" class="btn-soft btn-compact" data-act="taxes-save">Зберегти</button></div>
    </section>`;
}

export async function loadPayrollView() {
    ctx = await loadPayroll(period);
    period = ctx.period;
    const chair = session.role === 'chair';
    const [label, cls] = STATUS[ctx.status] || STATUS.none;
    const months = [...new Set([shift(ctx.today.slice(0, 7), 1), ctx.today.slice(0, 7), shift(ctx.today.slice(0, 7), -1), ...ctx.runs.map(r => r.period), ctx.period])].sort().reverse();
    const t = ctx.run.totals;
    const canPayAdvance = ctx.status === 'approved' && (!ctx.stages.advance || ctx.stages.advance.complete === false) && !ctx.stages.final && t.advance.netKop > 0 && !ctx.closed;
    const canPayFinal = ctx.status === 'approved' && (!ctx.stages.final || ctx.stages.final.complete === false) && ctx.stages.advance?.complete !== false && !ctx.closed;
    document.getElementById('viewPayroll').innerHTML = `
        <div class="buh-toolbar">
            <select id="prPeriod" class="field-input field-select ch-period" aria-label="Місяць">${months.map(m => `<option value="${m}"${m === ctx.period ? ' selected' : ''}>${monthTitle(m)}</option>`).join('')}</select>
            <span class="buh-tag ${cls}">${ctx.closed ? 'місяць закрито' : label}</span>
            <span class="buh-note">${ctx.approvedAt ? `Затверджено ${escapeHtml(new Date(ctx.approvedAt).toLocaleDateString('uk-UA'))}` : ctx.status === 'draft' ? 'Відомість затверджує голова' : 'Табель — у полях відомості; збережіть, і відомість піде голові'}</span>
            <span class="ch-tools">
                ${ctx.run.rows.length && !ctx.closed && !ctx.stages.final && ctx.stages.advance?.complete !== false ? '<button type="button" class="btn-soft btn-compact" data-act="save" title="Збережена відомість чекає затвердження голови">Зберегти відомість</button>' : ''}
                ${chair && ctx.status === 'draft' && !ctx.closed ? '<button type="button" class="btn-primary btn-compact" data-act="approve">Затвердити</button>' : ''}
                ${canPayAdvance ? '<button type="button" class="btn-primary btn-compact" data-act="pay-advance">Виплатити аванс</button>' : ''}
                ${canPayFinal ? '<button type="button" class="btn-primary btn-compact" data-act="pay-final">Виплатити зарплату</button>' : ''}
            </span>
        </div>
        <div class="kpi-grid">
            <div class="kpi"><span>Нараховано</span><b>${fmtKop(t.grossKop)}</b><small>${ctx.run.rows.length} особ.</small></div>
            <div class="kpi"><span>Утримано ПДФО + ВЗ</span><b>${fmtKop(t.pdfoKop + t.vzKop)}</b><small>ПДФО ${fmtKop(t.pdfoKop)} · ВЗ ${fmtKop(t.vzKop)}</small></div>
            <div class="kpi"><span>На руки</span><b>${fmtKop(t.netKop)}</b><small>аванс ${fmtKop(t.advance.netKop)}${ctx.stages.advance ? ctx.stages.advance.complete === false ? ' · не завершено' : ' ✓' : ''} · решта ${fmtKop(t.final.netKop)}${ctx.stages.final ? ctx.stages.final.complete === false ? ' · не завершено' : ' ✓' : ''}</small></div>
            <div class="kpi"><span>Витрати ОСББ</span><b>${fmtKop(t.costKop)}</b><small>з ЄСВ ${fmtKop(t.esvKop)}</small></div>
        </div>
        ${runHtml()}
        ${paymentsHtml()}
        ${peopleHtml()}
        ${taxesHtml()}`;
    return ctx.status === 'draft' && chair ? 1 : 0;
}

function readInputs() {
    const inputs = {};
    document.querySelectorAll('#viewPayroll .pr-in').forEach(i => {
        const v = i.dataset.k === 'workedDays' ? i.value.trim() : toKop(i.value);
        if (i.dataset.k !== 'workedDays' && i.value.trim() && v === null) throw new Error('Суму вказуйте в гривнях, напр. 8 000,00');
        (inputs[i.dataset.id] ||= {})[i.dataset.k] = v ?? '';
    });
    // Місяць і причина перерахунку — лише разом із сумою.
    document.querySelectorAll('#viewPayroll .pr-txt').forEach(i => {
        if (inputs[i.dataset.id]?.correctionKop) inputs[i.dataset.id][i.dataset.k] = i.value.trim();
    });
    return inputs;
}

function readPerson() {
    const v = id => document.getElementById(id)?.value.trim() ?? '';
    const kind = v('pfKind');
    const p = { id: editing.id || null, name: v('pfName'), kind, position: v('pfPosition'), rnokpp: v('pfRnokpp'), iban: v('pfIban'),
        contract: v('pfContract'), from: v('pfFrom'), to: v('pfTo'), active: document.getElementById('pfActive').checked };
    if (kind === 'employee') {
        p.salaryKop = toKop(v('pfSalary'));
        p.fte = Number(v('pfFte').replace(',', '.')) || 1;
        p.mainJob = document.getElementById('pfMain')?.checked ?? true;
        p.taxNotified = document.getElementById('pfNotified')?.checked ?? false;
    }
    return p;
}

async function onAction(btn) {
    const a = btn.dataset.act;
    try {
        if (a === 'person-new') { editing = { kind: 'employee' }; await loadPayrollView(); document.getElementById('pfName')?.focus(); return; }
        if (a === 'person-edit') { editing = ctx.people.find(p => p.id === btn.dataset.id) || null; await loadPayrollView(); return; }
        if (a === 'person-cancel') { editing = null; await loadPayrollView(); return; }
        if (a === 'person-save') {
            setBusy(btn, true, 'Зберігаю…');
            await payrollAct({ action: 'person', ...readPerson() });
            editing = null;
            toast('Збережено. Відомість місяця перерахується, коли ви її збережете', 'success');
        } else if (a === 'taxes-save') {
            const taxes = {};
            document.querySelectorAll('#viewPayroll [data-tax]').forEach(tr => {
                taxes[tr.dataset.tax] = Object.fromEntries([...tr.querySelectorAll('[data-f]')].map(i => [i.dataset.f, i.value.trim()]));
            });
            await payrollAct({ action: 'settings', advancePct: Number(document.getElementById('prAdvance').value) || 0, taxes });
            toast('Збережено', 'success');
        } else if (a === 'save') {
            setBusy(btn, true, 'Рахую…');
            await payrollAct({ action: 'save', period: ctx.period, inputs: readInputs() });
            toast('Відомість збережено й подано голові на затвердження', 'success');
        } else if (a === 'approve') {
            if (!await confirmDialog(`Затвердити відомість за ${monthTitle(ctx.period).toLowerCase()}?`,
                `Нараховано ${fmtKop(ctx.run.totals.grossKop)} грн, на руки ${fmtKop(ctx.run.totals.netKop)} грн, ЄСВ ${fmtKop(ctx.run.totals.esvKop)} грн. Після цього бухгалтер створить платежі, а ви підпишете їх у Приват24.`, 'Затвердити')) return;
            await payrollAct({ action: 'approve', period: ctx.period });
            toast('Відомість затверджено', 'success');
        } else if (a === 'repay') {
            if (!await confirmDialog('Відправити виплату знову?', 'Новий платіж на ту саму суму піде на рахунок з картки людини (чи податку) — голова підпише його в Приват24.', 'Відправити')) return;
            setBusy(btn, true, 'Створюю платіж…');
            await payrollAct({ action: 'repay', paymentId: btn.dataset.id });
            toast('Платіж створено — голова підписує його в Приват24', 'success');
        } else if (a === 'pay-advance' || a === 'pay-final') {
            const stage = a === 'pay-advance' ? 'advance' : 'final';
            // Без авансу остаточний розрахунок платить усе нараховане.
            const sum = stage === 'final' && !ctx.stages.advance ? ctx.run.totals : ctx.run.totals[stage];
            if (!await confirmDialog(stage === 'advance' ? 'Виплатити аванс?' : 'Виплатити зарплату?',
                `На руки ${fmtKop(sum.netKop)} грн, ПДФО й ВЗ ${fmtKop(sum.pdfoKop + sum.vzKop)} грн, ЄСВ ${fmtKop(sum.esvKop || 0)} грн. Платежі підуть у Приват24 на підпис голови.`, 'Створити платежі')) return;
            setBusy(btn, true, 'Створюю платежі…');
            const r = await payrollAct({ action: 'pay', period: ctx.period, stage });
            toast(r.errors?.length ? `Створено ${r.created}; не вдалося: ${r.errors.join('; ')}` : `Платежів у Приват24: ${r.created}. Голова підписує пачку`, r.errors?.length ? 'error' : 'success');
        }
    } catch (e) { toast(e.message, 'error'); }
    finally { if (btn.isConnected) setBusy(btn, false); }
}

export function initPayrollView() {
    const host = document.getElementById('viewPayroll');
    host.addEventListener('click', e => {
        const btn = e.target.closest('[data-act]');
        if (btn && !btn.disabled) onAction(btn);
    });
    host.addEventListener('change', e => {
        if (e.target.id === 'prPeriod') { period = e.target.value; editing = null; loadPayrollView(); }
        if (e.target.id === 'pfKind' && editing) { editing = { ...readPerson(), kind: e.target.value }; loadPayrollView(); }
    });
}
