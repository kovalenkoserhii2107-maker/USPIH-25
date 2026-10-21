// ============================================================
// «Зарплата»: зверху — нараховано, людям і податки; ліворуч — люди,
// праворуч — розрахунок обраної людини з табелем чи актом місяця.
// Поля всіх людей лишаються на сторінці (приховані), тож «Зберегти
// відомість» читає їх так само, як раніше. Відомість з
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
import { initials, personState, payrollTotals, paymentWho } from './payroll-view-core.js';
import { openPaymentSheet } from './buh-chain.js';

const MONTHS = ['Січень', 'Лютий', 'Березень', 'Квітень', 'Травень', 'Червень', 'Липень', 'Серпень', 'Вересень', 'Жовтень', 'Листопад', 'Грудень'];
const monthTitle = p => `${MONTHS[Number(p.slice(5, 7)) - 1]} ${p.slice(0, 4)}`;
const shift = (p, n) => { const d = new Date(Date.UTC(Number(p.slice(0, 4)), Number(p.slice(5, 7)) - 1 + n, 1)); return d.toISOString().slice(0, 7); };
const money2 = k => (k ? (k / 100).toFixed(2).replace('.', ',') : '');

const PAY_METHOD_KEY = 'uspih25_payroll_pay_method';
export function getPayMethod() {
    try { return localStorage.getItem(PAY_METHOD_KEY) === 'project' ? 'project' : 'iban'; } catch { return 'iban'; }
}
export function setPayMethod(val) {
    const clean = val === 'project' ? 'project' : 'iban';
    try { localStorage.setItem(PAY_METHOD_KEY, clean); } catch { /* ignore */ }
    return clean;
}

let period = null;
let ctx = null;
let editing = null;          // картка людини у формі: null — закрито, {} — нова
let selected = null;         // людина в правій картці
let pendingPersonEdit = null;
const projectStatuses = {};

/** Відкрити розділ на місяці (із «Вхідних»). */
export function openPayroll(p) {
    if (p) period = p;
    if (location.hash !== '#payroll') location.hash = 'payroll';
    else loadPayrollView();
}

/** Відкрити розділ одразу на формі додавання або редагування працівника / підрядника ЦПД (із «Налаштувань»). */
export function openPayrollPerson(personId = 'new') {
    pendingPersonEdit = personId || 'new';
    if (location.hash !== '#payroll') location.hash = 'payroll';
    else loadPayrollView();
}

const STATUS = { none: ['Відомість не складено', ''], draft: ['Відомість чекає голову', 'is-work'], approved: ['Відомість затверджено', 'is-done'] };
const grn = k => `${fmtKop(k)} грн`;
const TAX_NAMES = { pdfo: 'ПДФО', vz: 'Військовий збір', esv: 'ЄСВ' };
const pct = v => `${String(v / 100).replace('.', ',')}%`;

/** Бюджетні рахунки за замовчуванням (ГУК / ГУ ДПС в Одеській обл., м. Одеса, МФО 899998). */
export const DEFAULT_TAXES = {
    pdfo: { name: 'ГУК в Одеській обл. / м. Одеса', iban: 'UA538999980313010101000015744', code: '37607526' },
    vz: { name: 'ГУК в Одеській обл. / м. Одеса', iban: 'UA808999980313090106000015744', code: '37607526' },
    esv: { name: 'ГУ ДПС в Одеській області', iban: 'UA208999980000355609201001532', code: '44069166' }
};

export function withDefaultTaxes(taxes = {}) {
    const merge = key => {
        const def = DEFAULT_TAXES[key] || { name: '', iban: '', code: '' };
        const cur = taxes?.[key] || {};
        const own = {
            name: String(cur.name || '').trim(),
            iban: String(cur.iban || '').replace(/\s+/g, '').toUpperCase(),
            code: String(cur.code || '').replace(/\D/g, '').slice(0, 10)
        };
        // Типовий отримувач підставляється цілком і лише замість порожнього: змішати свій IBAN
        // з чужою назвою чи кодом означало б платіж податку не тому отримувачу.
        return own.name || own.iban || own.code ? own : { ...def };
    };
    return { pdfo: merge('pdfo'), vz: merge('vz'), esv: merge('esv') };
}

/** Переконується, що реквізити отримувачів податків (ПДФО, ВЗ, ЄСВ) збережені на сервері перед виплатою. */
export async function ensurePayrollTaxes(targetPeriod = null, payrollCtx = null) {
    const state = payrollCtx || (ctx && (!targetPeriod || ctx.period === targetPeriod) ? ctx : await loadPayroll(targetPeriod || period));
    const rawTaxes = state?.settings?.taxes || {};
    const merged = withDefaultTaxes(rawTaxes);
    const needsSave = ['pdfo', 'vz', 'esv'].some(k =>
        !String(rawTaxes[k]?.name || '').trim() &&
        !String(rawTaxes[k]?.iban || '').trim() &&
        !String(rawTaxes[k]?.code || '').trim()
    );
    if (needsSave) {
        const advancePct = Number.isFinite(state?.settings?.advancePct) ? state.settings.advancePct : 50;
        await payrollAct({ action: 'settings', advancePct, taxes: merged });
        if (state?.settings) state.settings.taxes = merged;
    }
    return state;
}

/** Створює платежі авансу або зарплати з автоматичним заповненням бюджетних рахунків за замовчуванням. */
export async function payPayrollStage(targetPeriod, stage, payrollCtx = null) {
    const state = await ensurePayrollTaxes(targetPeriod, payrollCtx);
    if (state?.stages?.[stage]?.complete === false && state?.stages?.[stage]?.plan) {
        await payrollAct({ action: 'refreshRecipients', period: targetPeriod, stage }).catch(() => {});
    }
    return payrollAct({ action: 'pay', period: targetPeriod, stage });
}

/** Поля людини за місяць: табель чи акт, премія, перерахунок, відсутності. */
function inputsHtml(r, locked) {
    const id = escapeHtml(r.personId);
    const dis = locked ? ' disabled' : '';
    if (r.kind === 'gph') {
        return `<div class="pr-fields"><label class="py-field"><span>Сума акта за місяць, грн</span>
            <input class="pr-in" data-id="${id}" data-k="actKop" inputmode="decimal" value="${money2(r.actKop)}" placeholder="0,00"${dis}></label></div>`;
    }
    return `<div class="pr-fields">
        <div class="py-pair">
            <label class="py-field"><span>Відпрацьовано днів (з ${r.normDays})</span>
                <input class="pr-in pr-days" data-id="${id}" data-k="workedDays" inputmode="numeric" value="${r.workedDays ?? ''}"${dis}></label>
            <label class="py-field"><span>Премія, грн</span>
                <input class="pr-in" data-id="${id}" data-k="bonusKop" inputmode="decimal" value="${money2(r.bonusKop)}" placeholder="0,00"${dis}></label>
        </div>
        ${absencesHtml(r, locked)}
        <details class="pr-corr"${r.correctionKop ? ' open' : ''}><summary>Перерахунок за минулий місяць</summary>
            <div class="pr-corr-row">
                <input class="field-input pr-in" data-id="${id}" data-k="correctionKop" inputmode="decimal" value="${r.correctionKop ? (r.correctionKop / 100).toFixed(2).replace('.', ',') : ''}" placeholder="±0,00" aria-label="Перерахунок, плюс чи мінус"${dis}>
                <input class="field-input pr-txt" type="month" data-id="${id}" data-k="correctionFor" value="${escapeHtml(r.correctionFor || shift(ctx.period, -1))}" max="${shift(ctx.period, -1)}" aria-label="За який місяць"${dis}>
                <input class="field-input pr-txt" data-id="${id}" data-k="correctionNote" maxlength="120" value="${escapeHtml(r.correctionNote || '')}" placeholder="причина" aria-label="Причина перерахунку"${dis}>
            </div>
        </details>
    </div>`;
}

/** Розрахунок людини: рядки «оклад → утримання → до виплати» і поля місяця. */
function personBodyHtml(r, locked) {
    const rate = ctx.run.rate;
    const lines = r.kind === 'gph'
        ? [['За актом виконаних робіт', grn(r.actKop || 0)]]
        : [['Оклад', `${grn(r.salaryKop)}${r.fte && r.fte < 1 ? ` · ставка ${String(r.fte).replace('.', ',')}` : ''}`],
            ['Відпрацьовано', r.workedDays === undefined || r.workedDays === null ? `${r.normDays} з ${r.normDays} днів` : `${r.workedDays} з ${r.normDays} днів`],
            ...(r.bonusKop ? [['Премія', grn(r.bonusKop)]] : []),
            ...(r.correctionKop ? [['Перерахунок', grn(r.correctionKop)]] : [])];
    lines.push(['Нараховано', grn(r.grossKop)], [`ПДФО ${pct(rate.pdfo)}`, `−${grn(r.pdfoKop)}`], [`Військовий збір ${pct(rate.vz)}`, `−${grn(r.vzKop)}`]);
    const notes = [...r.problems.map(t => `<li class="is-bad">${escapeHtml(t)}</li>`), ...r.warnings.map(t => `<li>${escapeHtml(t)}</li>`)];
    return `<dl class="pr-lines">${lines.map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd${v.startsWith('−') ? ' class="is-minus"' : ''}>${escapeHtml(v)}</dd>`).join('')}
            <dt class="is-total">До виплати</dt><dd class="is-total">${grn(r.netKop)}</dd></dl>
        <p class="pr-split">${r.advance.netKop ? `аванс ${grn(r.advance.netKop)} · ` : ''}решта ${grn(r.final.netKop)}</p>
        <p class="pr-employer">ЄСВ ${pct(rate.esv)} — ${grn(r.esvKop)} сплачує ОСББ понад зарплату.${r.kind === 'gph' ? ' Договір ЦПД: ЄСВ з суми акта.' : ''}</p>
        ${notes.length ? `<ul class="pr-notes">${notes.join('')}</ul>` : ''}
        <h3 class="pr-sub">${r.kind === 'gph' ? 'Акт за місяць' : 'Табель за місяць'}</h3>
        ${inputsHtml(r, locked)}`;
}

/** Права картка: розрахунок кожної людини (видно лише обрану) або форма картки людини. */
function cardHtml(locked) {
    const bodies = ctx.run.rows.map(r => {
        const person = ctx.people.find(p => p.id === r.personId) || {};
        return `<div class="pr-body" data-person="${escapeHtml(r.personId)}"${r.personId === selected && !editing ? '' : ' hidden'}>
            <div class="fl-card-head"><div><span class="fl-facts">${escapeHtml(r.kind === 'gph' ? `Договір ЦПД${person.contract ? ` ${person.contract}` : ''}` : `Трудовий договір${person.mainJob === false ? '' : ' · основне місце'}`)}</span>
                <h2>${escapeHtml(r.name)}</h2>${r.position ? `<span class="fl-owner">${escapeHtml(r.position)}</span>` : ''}</div>
                <button type="button" class="sv-btn is-soft pr-edit" data-act="person-edit" data-id="${escapeHtml(r.personId)}">Картка</button></div>
            ${personBodyHtml(r, locked)}
        </div>`;
    }).join('');
    const outside = ctx.people.find(p => p.id === selected && !ctx.run.rows.some(r => r.personId === p.id));
    const outsideHtml = outside && !editing ? `<div class="fl-card-head"><div><span class="fl-facts">${escapeHtml(ctx.kinds[outside.kind] || '')}</span><h2>${escapeHtml(outside.name)}</h2></div>
            <button type="button" class="sv-btn is-soft pr-edit" data-act="person-edit" data-id="${escapeHtml(outside.id)}">Картка</button></div>
        <p class="py-note">${outside.active === false ? 'Картку позначено «не діє» — у відомості людини немає.' : 'У цьому місяці договір не діє — перевірте дати в картці.'}</p>` : '';
    const empty = !ctx.run.rows.length && !outside && !editing
        ? `<div class="fl-empty"><b>${ctx.people.length ? 'У цьому місяці відомість порожня' : 'Ще нікого немає'}</b><span>${ctx.people.length ? 'Немає діючих працівників і договорів ЦПД.' : 'Додайте працівника чи виконавця за договором ЦПД — відомість складеться сама.'}</span></div>` : '';
    return `${bodies}${outsideHtml}${empty}${editing ? personFormHtml(editing) : ''}`;
}

/** Відпустки й лікарняні працівника за місяць і кошти ПФУ за лікарняний. */
function absencesHtml(r, locked) {
    const input = ctx.inputs?.[r.personId] || {};
    const list = [...(input.absences || []), { type: 'vacation', from: '', to: '' }];
    const dis = locked ? ' disabled' : '';
    const id = escapeHtml(r.personId);
    const first = `${ctx.period}-01`, last = new Date(Date.UTC(Number(ctx.period.slice(0, 4)), Number(ctx.period.slice(5, 7)), 0)).toISOString().slice(0, 10);
    return `<details class="pr-corr pr-abs"${input.absences?.length || input.fundSickKop ? ' open' : ''}><summary>відпустка / лікарняний${input.absences?.length ? ` (${input.absences.length})` : ''}</summary>
        ${list.map(a => `<div class="pr-abs-row" data-id="${id}">
            <select class="field-input field-select" data-f="type" aria-label="Вид"${dis}><option value="vacation"${a.type === 'vacation' ? ' selected' : ''}>відпустка</option><option value="sick"${a.type === 'sick' ? ' selected' : ''}>лікарняний</option></select>
            <input class="field-input" type="date" data-f="from" value="${escapeHtml(a.from || '')}" min="${first}" max="${last}" aria-label="З"${dis}>
            <input class="field-input" type="date" data-f="to" value="${escapeHtml(a.to || '')}" min="${first}" max="${last}" aria-label="По"${dis}>
            <input class="field-input" type="date" data-f="caseStart" value="${escapeHtml(a.caseStart || '')}" title="Відпустка чи лікарняний почались раніше — дата початку для незмінної середньоденної" aria-label="Початок випадку"${dis}>
            <input class="field-input" data-f="avg" inputmode="decimal" value="${a.avgDailyKop ? money2(a.avgDailyKop) : ''}" placeholder="середньоденна" title="Лише якщо немає заробітку за 12 місяців" aria-label="Середньоденна вручну"${dis}>
        </div>`).join('')}
        <input class="field-input pr-in" data-id="${id}" data-k="fundSickKop" inputmode="decimal" value="${money2(input.fundSickKop)}" placeholder="кошти ПФУ за лікарняний, грн" aria-label="Кошти ПФУ за лікарняний"${dis}>
    </details>`;
}

function paymentsHtml() {
    if (!ctx.payments.length) return '';
    const STAT = { sending: ['надсилається', 'is-work'], sent: ['на підписі', ''], paid: ['проведено', 'is-done'], failed: ['банк не прийняв', 'is-bad'], unknown: ['перевірте у Приват24', 'is-bad'], canceled: ['скасовано', 'is-locked'] };
    return `<section class="py-card pr-payments"><div class="py-card-head"><h2>Платежі за відомістю</h2></div>
        ${ctx.payments.map(p => { const [text, cls] = p.returnedKop ? [`повернено банком${p.repaid ? ' · відправлено знову' : ''}`, 'is-bad'] : STAT[p.status] || [p.status, ''];
            return `<div class="py-row is-link" data-pay="${escapeHtml(p.id)}" tabindex="0" role="button">
            <span class="py-main"><b>${escapeHtml(p.recipient)}</b><small class="py-muted">${TAX_NAMES[paymentWho(p)] ? `${TAX_NAMES[paymentWho(p)]}${p.stage === 'advance' ? ' з авансу' : ''}` : p.stage === 'advance' ? 'Аванс' : 'Зарплата'}${p.retry ? ' · повторно' : ''}${p.error ? ` · ${escapeHtml(p.error)}` : ''}</small></span>
            <span class="py-right"><b class="py-sum">${grn(p.amountKop)}</b><span class="sv-chip ${cls}">${escapeHtml(text)}</span></span>
            ${p.status === 'paid' && p.returnedKop >= p.amountKop && !p.repaid ? `<span class="py-actions"><button type="button" class="sv-btn" data-act="repay" data-id="${escapeHtml(p.id)}" title="Спершу виправте IBAN у картці людини чи рахунок податку">Відправити знову</button></span>` : ''}
        </div>`; }).join('')}
        ${ctx.payments.some(p => p.returnedKop) ? '<p class="py-note">Повернений банком платіж: виправте IBAN у картці людини (або рахунок податку) і натисніть «Відправити знову» — новий платіж піде голові на підпис.</p>' : ''}</section>`;
}

/** Ліва колонка: люди місяця, далі — ті, чий договір зараз не діє. */
function peopleHtml() {
    const inRun = new Map(ctx.run.rows.map(r => [r.personId, r]));
    const list = ctx.people.slice().sort((a, b) => Number(inRun.has(b.id)) - Number(inRun.has(a.id)) || Number(b.active !== false) - Number(a.active !== false) || a.name.localeCompare(b.name, 'uk'));
    return `<section class="fl-list pr-people" aria-label="Люди">
        <div class="pr-list-head"><h2>Люди</h2><button type="button" class="sv-btn is-soft" data-act="person-new">+ Додати</button></div>
        ${list.length ? `<ul class="fl-items">${list.map(p => {
            const r = inRun.get(p.id);
            const [state, cls] = personState(ctx, p.id, Boolean(r));
            return `<li><button type="button" class="fl-item pr-item${p.id === selected && !editing ? ' is-current' : ''}" data-act="pick" data-id="${escapeHtml(p.id)}" aria-current="${p.id === selected}">
                <span class="fl-no pr-ava">${escapeHtml(initials(p.name))}</span>
                <span class="fl-copy"><b>${escapeHtml(p.name)}</b><small>${escapeHtml([p.position, p.kind === 'gph' ? 'договір ЦПД' : 'трудовий договір'].filter(Boolean).join(' · '))}${!p.iban ? ' · немає IBAN' : ''}${p.kind === 'employee' && !p.taxNotified ? ' · повідомити ДПС' : ''}</small></span>
                <span class="dc-right">${r ? `<b class="fl-sum">${grn(r.netKop)}</b>` : ''}<span class="sv-chip ${cls}">${escapeHtml(state)}</span></span>
            </button></li>`; }).join('')}</ul>` : '<p class="py-empty">Ще нікого немає</p>'}
    </section>`;
}

function personFormHtml(p) {
    const gph = p.kind === 'gph';
    const f = (id, label, value, extra = '') => `<label class="field"><span class="field-label">${label}</span><input id="${id}" class="field-input" value="${escapeHtml(value ?? '')}" ${extra}></label>`;
    return `<div class="pay-form pr-form">
        <h2 class="pr-form-title">${p.id ? escapeHtml(p.name || 'Картка') : 'Нова людина'}</h2>
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
            <label class="field"><span class="field-label">Стать (для звіту ДПС)</span><select id="pfGender" class="field-input field-select"><option value="">—</option>${['Ж', 'Ч'].map(g => `<option${g === p.gender ? ' selected' : ''}>${g}</option>`).join('')}</select></label>
            ${gph ? '' : `${f('pfKp', 'Код професії за КП (Д5)', p.kpCode, 'inputmode="decimal" maxlength="10" placeholder="9141"')}
            ${f('pfHireDoc', 'Наказ про прийняття (Д5)', p.hireDoc, 'placeholder="Наказ № 1-к від 15.10.2026"')}`}
            ${f('pfFireDoc', gph ? 'Документ про припинення договору (Д5)' : 'Наказ про звільнення (Д5)', p.fireDoc)}
            ${f('pfFireBasis', 'Підстава припинення (стаття, Д5)', p.fireBasis, 'placeholder="п. 1 ст. 36 КЗпП"')}
        </div>
        ${gph ? '' : `<div class="rg-grid">
            ${f('pfInsurance', 'Страховий стаж, років (для лікарняних)', p.insuranceYears ?? '', 'inputmode="decimal"')}
            <label class="field"><span class="field-label">Податкова соціальна пільга (за заявою)</span><select id="pfPsp" class="field-input field-select"><option value="">Немає</option>${Object.entries(ctx.pspKinds || {}).map(([k, v]) => `<option value="${k}"${k === p.psp?.kind ? ' selected' : ''}>${escapeHtml(`${k} — ${v}`)}</option>`).join('')}</select></label>
            ${f('pfPspChildren', 'Дітей до 18 (для пільги на дітей)', p.psp?.children || '', 'inputmode="numeric"')}
            ${f('pfPspFrom', 'Заява про ПСП від', p.psp?.from || '', 'type="date"')}
        </div>
        <label class="field"><span class="field-label">Заробіток до застосунку — для середньої (рядок: місяць сума [календарних днів])</span>
            <textarea id="pfPrior" class="field-input" rows="3" placeholder="2026-09 8647,00&#10;2026-08 8647,00 31">${escapeHtml(Object.entries(p.priorEarnings || {}).sort().map(([m, e]) => `${m} ${money2(e.kop) || '0,00'}${e.days !== undefined ? ` ${e.days}` : ''}`).join('\n'))}</textarea></label>
        <label class="pr-check"><input id="pfMain" type="checkbox"${p.mainJob !== false ? ' checked' : ''}> Основне місце роботи (ЄСВ не менше ніж з мінімальної зарплати)</label>
        <label class="pr-check"><input id="pfNotified" type="checkbox"${p.taxNotified ? ' checked' : ''}> Повідомлення ДПС про прийняття подано (до початку роботи)</label>`}
        <label class="pr-check"><input id="pfActive" type="checkbox"${p.active !== false ? ' checked' : ''}> Діє (у відомості)</label>
        <div class="pr-form-actions"><button type="button" class="sv-btn" data-act="person-save">Зберегти</button><button type="button" class="sv-btn is-soft" data-act="person-cancel">Скасувати</button></div>
    </div>`;
}

function activeProjectStagesHtml() {
    const projectEntries = Object.entries(ctx.stages || {}).filter(([, s]) => s.project);
    if (!projectEntries.length) return '';
    return `<section class="py-card">
        <div class="py-card-head"><h2>Відомості зарплатного проекту ПриватБанку</h2></div>
        ${projectEntries.map(([stage, s]) => `<div style="margin-top:8px">
            <p class="py-note">${stage === 'advance' ? 'Аванс' : 'Розрахунок'} · ${escapeHtml(s.project.reference || 'референс ще не підтверджено')} · підготовлено ${Object.keys(s.project.added || {}).length} виплат · ${escapeHtml(s.project.status)}</p>
            ${s.project.reference ? `<button type="button" class="sv-btn is-soft" data-act="project-status" data-stage="${stage}">Перевірити стан у банку</button>` : ''}
            ${projectStatuses[`${ctx.period}:${stage}`] ? `<p class="py-note">Банк: ${escapeHtml(projectStatuses[`${ctx.period}:${stage}`].status)}${projectStatuses[`${ctx.period}:${stage}`].substatus ? ` / ${escapeHtml(projectStatuses[`${ctx.period}:${stage}`].substatus)}` : ''} · ${escapeHtml(projectStatuses[`${ctx.period}:${stage}`].error || '')}. Факт оплати у бухгалтерії підтверджується випискою.</p>` : ''}
            ${s.project.status === 'unknown' && session.role === 'chair' ? `<label class="py-field"><span>Референс після звірки у Приват24</span><input class="field-input" data-project-ref="${stage}" maxlength="120"></label><button type="button" class="sv-btn is-soft" data-act="project-recover" data-stage="${stage}">Звірити та продовжити</button>` : ''}
        </div>`).join('')}
    </section>`;
}

export async function loadPayrollView() {
    ctx = await loadPayroll(period);
    period = ctx.period;
    if (pendingPersonEdit) {
        if (pendingPersonEdit === 'new') {
            editing = { kind: 'employee' };
        } else {
            const found = ctx.people.find(p => p.id === pendingPersonEdit);
            if (found) { selected = found.id; editing = found; }
        }
        pendingPersonEdit = null;
    }
    const payMethod = getPayMethod();
    const chair = session.role === 'chair';
    const [label, cls] = ctx.closed ? ['Місяць закрито', 'is-locked'] : STATUS[ctx.status] || STATUS.none;
    const months = [...new Set([shift(ctx.today.slice(0, 7), 1), ctx.today.slice(0, 7), shift(ctx.today.slice(0, 7), -1), ...ctx.runs.map(r => r.period), ctx.period])].sort().reverse();
    const t = ctx.run.totals;
    const sum = payrollTotals(ctx);
    const locked = ctx.closed || Boolean(ctx.stages.final) || ctx.stages.advance?.complete === false;
    const canSave = ctx.run.rows.length && !ctx.closed && !ctx.stages.final && ctx.stages.advance?.complete !== false;
    const canPayAdvance = ctx.status === 'approved' && !ctx.stages.advance?.external && (!ctx.stages.advance || ctx.stages.advance.complete === false) && !ctx.stages.final && t.advance.netKop > 0 && !ctx.closed;
    const canPayFinal = ctx.status === 'approved' && !ctx.stages.final?.external && (!ctx.stages.final || ctx.stages.final.complete === false) && ctx.stages.advance?.complete !== false && !ctx.closed;
    const ids = [...ctx.run.rows.map(r => r.personId), ...ctx.people.map(p => p.id)];
    if (!ids.includes(selected)) selected = window.matchMedia('(max-width: 900px)').matches ? null : ids[0] || null;
    const idle = !selected && !editing && (ctx.run.rows.length || ctx.people.length);
    const people = [sum.employees ? `${sum.employees} ${sum.employees === 1 ? 'працівник' : 'працівники'}` : '', sum.contractors ? `${sum.contractors} ${sum.contractors === 1 ? 'договір' : 'договори'} ЦПД` : ''].filter(Boolean).join(' · ');
    const taxAccounts = withDefaultTaxes(ctx.settings.taxes);
    const taxesReady = ['pdfo', 'vz', 'esv'].every(k => taxAccounts[k]?.iban);

    document.getElementById('viewPayroll').innerHTML = `
        <div class="pr-head">
            <div class="pr-head-left">
                <select id="prPeriod" class="pr-period" aria-label="Місяць">${months.map(m => `<option value="${m}"${m === ctx.period ? ' selected' : ''}>${monthTitle(m)}</option>`).join('')}</select>
                <span class="sv-chip ${cls}">${escapeHtml(label)}${ctx.approvedAt && ctx.status === 'approved' ? ` ${escapeHtml(new Date(ctx.approvedAt).toLocaleDateString('uk-UA', { day: 'numeric', month: 'long' }))}` : ''}</span>
            </div>
            <div class="pr-head-actions">
                ${canSave ? `<button type="button" class="sv-btn${chair && ctx.status === 'draft' || canPayAdvance || canPayFinal ? ' is-soft' : ''}" data-act="save" title="${ctx.status === 'approved' ? 'Зміни повернуть відомість на затвердження голові' : 'Збережена відомість чекає затвердження голови'}">${ctx.status === 'approved' ? 'Зберегти зміни' : 'Зберегти відомість'}</button>` : ''}
                ${chair && ctx.status === 'draft' && !ctx.closed ? '<button type="button" class="sv-btn" data-act="approve">Затвердити</button>' : ''}
                ${canPayAdvance ? '<button type="button" class="sv-btn" data-act="pay-advance">Виплатити аванс</button>' : ''}
                ${canPayFinal ? `<button type="button" class="sv-btn${canPayAdvance ? ' is-soft' : ''}" data-act="pay-final">Виплатити зарплату</button>` : ''}
            </div>
        </div>
        <div class="pr-kpis">
            <section class="py-card pr-kpi"><span class="bk-label">Нараховано</span><b class="pr-kpi-sum">${grn(sum.grossKop)}</b><span class="py-muted">${escapeHtml(people || 'нікого у відомості')}</span></section>
            <button type="button" class="py-card pr-kpi" data-go="payments"><span class="bk-label">До виплати людям</span><b class="pr-kpi-sum">${grn(sum.netKop)}</b>
                <span class="py-muted">${sum.netPaidKop || sum.netSigningKop ? `${sum.netPaidKop ? `${grn(sum.netPaidKop)} виплачено` : ''}${sum.netPaidKop && sum.netSigningKop ? ' · ' : ''}${sum.netSigningKop ? `${grn(sum.netSigningKop)} на підписі` : ''} ›` : `аванс ${grn(t.advance.netKop)} · решта ${grn(t.final.netKop)}`}</span></button>
            <button type="button" class="py-card pr-kpi" data-go="payments"><span class="bk-label">Податки й внески</span><b class="pr-kpi-sum">${grn(sum.taxKop)}</b>
                <span class="py-muted">${sum.taxPaidKop || sum.taxSigningKop ? `${sum.taxPaidKop ? `${grn(sum.taxPaidKop)} сплачено` : ''}${sum.taxPaidKop && sum.taxSigningKop ? ' · ' : ''}${sum.taxSigningKop ? `${grn(sum.taxSigningKop)} на підписі` : ''} ›` : `ПДФО ${grn(t.pdfoKop)} · ВЗ ${grn(t.vzKop)} · ЄСВ ${grn(t.esvKop)}`}</span></button>
        </div>
        <div class="fl-grid pr-grid">
            ${peopleHtml()}
            <section class="fl-card pr-card${idle ? ' is-idle' : ''}" id="prCard" aria-live="polite">${idle ? '<div class="fl-empty"><b>Оберіть людину</b><span>Розрахунок, табель чи акт місяця — тут.</span></div>' : ''}${cardHtml(locked)}</section>
        </div>
        ${paymentsHtml()}
        ${Object.entries(ctx.stages).filter(([, s]) => s.complete === false).map(([stage, s]) => `<section class="py-card"><p class="py-note">${s.external ? 'Етап оплачують у банку вручну. Привʼяжіть решту списань до відомості у «Рішеннях».' : 'Частину платежів ще не підготовлено. Після виправлення картки людини або рахунків податків оновіть реквізити невідправлених платежів.'}</p>
            ${s.external ? '<button type="button" class="sv-btn is-soft" data-go="inbox">До рознесення виписки</button>' : `<button type="button" class="sv-btn is-soft" data-act="recipients-refresh" data-stage="${stage}">Оновити невідправлені реквізити</button>`}</section>`).join('')}
        ${activeProjectStagesHtml()}
        ${ctx.run.rateError ? `<section class="py-card"><p class="py-note is-bad">${escapeHtml(ctx.run.rateError)}</p><button type="button" class="sv-btn is-soft" data-go="settings" data-settings-tab="policy">Перевірити ставки в «Налаштуваннях» ›</button></section>` : ''}
        <section class="py-card pr-settings-bar">
            <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap">
                <div>
                    <b style="font-size:14px">Параметри розрахунку та виплати зарплати</b>
                    <p class="py-note" style="margin:2px 0 0">ПДФО ${pct(ctx.run.rate.pdfo)}, ВЗ ${pct(ctx.run.rate.vz)}, ЄСВ ${pct(ctx.run.rate.esv)} · МЗП ${grn(ctx.run.rate.minWageKop)} · Аванс ${ctx.settings.advancePct}% · ${taxesReady ? 'бюджетні рахунки заповнено' : 'заповніть рахунки податків'} · Виплата: ${payMethod === 'project' ? 'Зарплатний проект ПриватБанку' : 'По IBAN'}</p>
                </div>
                <div style="display:flex;gap:8px;flex-wrap:wrap">
                    <button type="button" class="btn-soft btn-compact" data-go="settings" data-settings-tab="policy">Податки, аванс і ставки ›</button>
                    <button type="button" class="btn-ghost-small" data-go="settings" data-settings-tab="bank">Зарплатний проект ›</button>
                </div>
            </div>
        </section>`;
    return ctx.status === 'draft' && chair ? 1 : 0;
}

/** Обрати людину: лише перемикаємо видимість — незбережені поля відомості лишаються. */
function pick(id) {
    if (editing) { editing = null; selected = id; loadPayrollView(); return; }
    selected = id;
    const card = document.getElementById('prCard');
    card.classList.remove('is-idle');
    card.querySelector(':scope > .fl-empty')?.remove();
    const body = card.querySelector(`.pr-body[data-person="${CSS.escape(id)}"]`);
    if (!body) { loadPayrollView(); return; }
    card.querySelectorAll('.pr-body').forEach(b => { b.hidden = b !== body; });
    document.querySelectorAll('#viewPayroll .pr-item').forEach(b => { b.classList.toggle('is-current', b.dataset.id === id); b.setAttribute('aria-current', b.dataset.id === id); });
    if (window.matchMedia('(max-width: 900px)').matches) card.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function readInputs() {
    const inputs = {};
    document.querySelectorAll('#viewPayroll .pr-in').forEach(i => {
        // Дні, які система порахувала сама (з відпустками й лікарняними), не фіксуємо: зміниться відсутність — зміняться й дні.
        if (i.dataset.k === 'workedDays' && i.value === i.defaultValue && ctx.inputs?.[i.dataset.id]?.workedDays === undefined) return;
        const v = i.dataset.k === 'workedDays' ? i.value.trim() : toKop(i.value);
        if (i.dataset.k !== 'workedDays' && i.value.trim() && v === null) throw new Error('Суму вказуйте в гривнях, напр. 8 000,00');
        (inputs[i.dataset.id] ||= {})[i.dataset.k] = v ?? '';
    });
    // Відпустки й лікарняні: рядки з датами.
    document.querySelectorAll('#viewPayroll .pr-abs-row').forEach(row => {
        const f = name => row.querySelector(`[data-f="${name}"]`)?.value.trim() || '';
        if (!f('from') && !f('to')) return;
        const avg = f('avg') ? toKop(f('avg')) : null;
        if (f('avg') && avg === null) throw new Error('Середньоденну вказуйте в гривнях, напр. 412,35');
        ((inputs[row.dataset.id] ||= {}).absences ||= []).push({ type: f('type'), from: f('from'), to: f('to'),
            ...(f('caseStart') ? { caseStart: f('caseStart') } : {}), ...(avg ? { avgDailyKop: avg } : {}) });
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
        contract: v('pfContract'), from: v('pfFrom'), to: v('pfTo'), active: document.getElementById('pfActive').checked,
        gender: v('pfGender'), kpCode: v('pfKp'), hireDoc: v('pfHireDoc'), fireDoc: v('pfFireDoc'), fireBasis: v('pfFireBasis') };
    if (kind === 'employee') {
        p.salaryKop = toKop(v('pfSalary'));
        p.fte = Number(v('pfFte').replace(',', '.')) || 1;
        p.mainJob = document.getElementById('pfMain')?.checked ?? true;
        p.taxNotified = document.getElementById('pfNotified')?.checked ?? false;
        p.insuranceYears = Number(v('pfInsurance').replace(',', '.')) || 0;
        p.psp = v('pfPsp') ? { kind: v('pfPsp'), children: Number(v('pfPspChildren')) || 0, from: v('pfPspFrom') } : null;
        // «2026-09 8647,00 30» → { '2026-09': { kop, days } }
        p.priorEarnings = {};
        for (const line of v('pfPrior').split('\n').map(l => l.trim()).filter(Boolean)) {
            const m = /^(\d{4}-\d{2})\s+([-\d\s.,]+?)(?:\s+(\d{1,2}))?$/.exec(line);
            const kopValue = m ? toKop(m[2]) : null;
            if (!m || kopValue === null) throw new Error(`Заробіток до застосунку: «${line}» — формат «2026-09 8647,00» або «2026-09 8647,00 30»`);
            p.priorEarnings[m[1]] = { kop: kopValue, ...(m[3] ? { days: Number(m[3]) } : {}) };
        }
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
        } else if (a === 'save') {
            setBusy(btn, true, 'Рахую…');
            await payrollAct({ action: 'save', period: ctx.period, inputs: readInputs() });
            toast('Відомість збережено й подано голові на затвердження', 'success');
        } else if (a === 'approve') {
            if (!await confirmDialog(`Затвердити відомість за ${monthTitle(ctx.period).toLowerCase()}?`,
                `Нараховано ${fmtKop(ctx.run.totals.grossKop)} грн, на руки ${fmtKop(ctx.run.totals.netKop)} грн, ЄСВ ${fmtKop(ctx.run.totals.esvKop)} грн. Після цього бухгалтер створить платежі, а ви підпишете їх у Приват24.`, 'Затвердити')) return;
            await payrollAct({ action: 'approve', period: ctx.period });
            toast('Відомість затверджено', 'success');
        } else if (a === 'project-status') {
            projectStatuses[`${ctx.period}:${btn.dataset.stage}`] = await payrollAct({ action: 'projectStatus', period: ctx.period, stage: btn.dataset.stage });
            await loadPayrollView();
        } else if (a === 'project-recover') {
            const stage = btn.dataset.stage;
            let ref = [...document.querySelectorAll('[data-project-ref]')].find(e => e.dataset.projectRef === stage)?.value.trim() || ctx.stages[stage].project.reference;
            if (!ref) {
                const found = await payrollAct({ action: 'projectFind', period: ctx.period, stage });
                if (found.length !== 1) throw new Error('Не знайдено єдиної відомості. Звірте референс у Приват24; нова чернетка не створюється автоматично');
                ref = found[0].reference;
            }
            const result = await payrollAct({ action: 'projectPrepare', period: ctx.period, stage, group: ctx.stages[stage].project.group, reference: ref });
            toast(`Підготовлено ${result.added} з ${result.total}. ${result.prepared ? 'Голова підписує у Приват24' : 'Продовжіть підготовку'}`, 'success');
        } else if (a === 'recipients-refresh') {
            await ensurePayrollTaxes(ctx.period, ctx);
            const result = await payrollAct({ action: 'refreshRecipients', period: ctx.period, stage: btn.dataset.stage });
            toast(`Оновлено: ${result.changed}. Тепер продовжіть виплату`, 'success');
        } else if (a === 'repay') {
            if (!await confirmDialog('Відправити виплату знову?', 'Новий платіж на ту саму суму піде на рахунок з картки людини (чи податку) — голова підпише його в Приват24.', 'Відправити')) return;
            setBusy(btn, true, 'Створюю платіж…');
            await payrollAct({ action: 'repay', paymentId: btn.dataset.id });
            toast('Платіж створено — голова підписує його в Приват24', 'success');
        } else if (a === 'pay-advance' || a === 'pay-final') {
            const stage = a === 'pay-advance' ? 'advance' : 'final';
            const project = ctx.stages[stage]?.project;
            const payMethod = getPayMethod();
            if ((project || payMethod === 'project') && project?.status !== 'prepared') {
                if (!await confirmDialog('Підготувати зарплатний проект?', 'Відомість буде створена й перевірена у банку. Підписати її потрібно у Приват24. Податки готуються окремими платежами по IBAN.', 'Підготувати')) return;
                setBusy(btn, true, 'Готую відомість…');
                await ensurePayrollTaxes(ctx.period, ctx);
                const result = await payrollAct({ action: 'projectPrepare', period: ctx.period, stage, group: project?.group || 'SALARY' });
                toast(`Підготовлено ${result.added} з ${result.total}. ${result.prepared ? 'Наступне натискання підготує податки; зарплатну відомість підпишіть у Приват24' : 'Натисніть повторно, щоб продовжити'}`, 'success');
                return;
            }
            // Без авансу остаточний розрахунок платить усе нараховане.
            const sum = stage === 'final' && !ctx.stages.advance ? ctx.run.totals : ctx.run.totals[stage];
            if (!await confirmDialog(stage === 'advance' ? 'Виплатити аванс?' : 'Виплатити зарплату?',
                `На руки ${fmtKop(sum.netKop)} грн, ПДФО й ВЗ ${fmtKop(sum.pdfoKop + sum.vzKop)} грн, ЄСВ ${fmtKop(sum.esvKop || 0)} грн. Платежі підуть у Приват24 на підпис голови.`, 'Створити платежі')) return;
            setBusy(btn, true, 'Створюю платежі…');
            const r = await payPayrollStage(ctx.period, stage, ctx);
            toast(r.errors?.length ? `Створено ${r.created}; не вдалося: ${r.errors.join('; ')}` : `Платежів у Приват24: ${r.created}. Голова підписує пачку`, r.errors?.length ? 'error' : 'success');
        }
    } catch (e) { toast(e.message, 'error'); }
    finally { if (btn.isConnected) setBusy(btn, false); }
}

export function initPayrollView() {
    const host = document.getElementById('viewPayroll');
    host.addEventListener('click', e => {
        const btn = e.target.closest('[data-act]');
        if (btn?.dataset.act === 'pick') { pick(btn.dataset.id); return; }
        const payRow = !btn && e.target.closest('[data-pay]');
        if (payRow) { openPaymentSheet(payRow.dataset.pay); return; }
        if (btn && !btn.disabled) onAction(btn);
    });
    host.addEventListener('change', e => {
        if (e.target.id === 'prPeriod') { period = e.target.value; editing = null; loadPayrollView(); }
        if (e.target.id === 'pfKind' && editing) { editing = { ...readPerson(), kind: e.target.value }; loadPayrollView(); }
    });
}
