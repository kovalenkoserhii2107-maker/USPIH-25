// ============================================================
// «Зарплата» — місяць за кроками: табель → затвердження головою →
// аванс → зарплата. Зверху — що зробити зараз і хід місяця, нижче —
// чотири вкладки:
//   «Відомість»    — хто скільки отримує; рядок відкриває розрахунок і табель;
//   «Працівники»   — картки, готовність до виплати, прийом нового;
//   «Відпустки»    — графік відпусток і лікарняних з попереднім розрахунком;
//   «Приват24»     — спосіб виплати, зарплатний проект і відомості в банку.
//
// Рахує сервер (payrollAction, payroll-core.js, leave-core.js). Персональні
// дані (РНОКПП, IBAN, оклад) бачать лише голова й бухгалтер. Повний номер
// картки не зберігається: він іде лише в банк під час додавання в проект.
// ============================================================
import { session } from './firebase.js';
import { escapeHtml, toast, setBusy, confirmDialog } from './ui.js';
import { loadPayroll, payrollAct, payrollPeek, maskIban } from './buh-data.js';
import { fmtKop, toKop } from './charges-core.js';
import { initials, personState, payrollTotals, paymentWho, flowSteps, nextPayrollAction, stageState, bankStep, RECORD_STATUS } from './payroll-view-core.js';
import { openPaymentSheet } from './buh-chain.js';

const MONTHS = ['Січень', 'Лютий', 'Березень', 'Квітень', 'Травень', 'Червень', 'Липень', 'Серпень', 'Вересень', 'Жовтень', 'Листопад', 'Грудень'];
const MONTHS_GEN = ['січня', 'лютого', 'березня', 'квітня', 'травня', 'червня', 'липня', 'серпня', 'вересня', 'жовтня', 'листопада', 'грудня'];
const monthTitle = p => `${MONTHS[Number(p.slice(5, 7)) - 1]} ${p.slice(0, 4)}`;
const shift = (p, n) => { const d = new Date(Date.UTC(Number(p.slice(0, 4)), Number(p.slice(5, 7)) - 1 + n, 1)); return d.toISOString().slice(0, 7); };
const money2 = k => (k ? (k / 100).toFixed(2).replace('.', ',') : '');
const grn = k => `${fmtKop(k)} грн`;
const day = d => d ? `${Number(d.slice(8, 10))} ${MONTHS_GEN[Number(d.slice(5, 7)) - 1]}` : '';
const range = (a, b) => a === b ? day(a) : a.slice(0, 7) === b.slice(0, 7) ? `${Number(a.slice(8, 10))}–${day(b)}` : `${day(a)} – ${day(b)}`;
const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000) + 1;
const chip = (text, cls = '') => `<span class="sv-chip ${cls}">${escapeHtml(text)}</span>`;
const TAX_NAMES = { pdfo: 'ПДФО', vz: 'Військовий збір', esv: 'ЄСВ' };
const LEAVE = { vacation: 'Відпустка', sick: 'Лікарняний' };
const pct = v => `${String(v / 100).replace('.', ',')}%`;
const STAGE = { advance: 'Аванс', final: 'Зарплата' };

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

let period = null;
let ctx = null;
let draft = {};              // табель місяця: копія ctx.inputs, яку правлять картки людей
let tab = 'sheet';
let showInactive = false;
let pendingOpen = null;      // відкрити картку після завантаження (із «Налаштувань»)
let project = { state: 'idle', data: null, error: '' };   // зарплатний проект з банку
let packets = { state: 'idle', list: [], error: '' };     // усі відомості в банку
const bankStatus = {};       // `${місяць}:${етап}` → стан відомості в банку
let sheet = null;            // відкрита бічна картка: { kind: 'person'|'form'|'leave', … }

/** Відкрити розділ на місяці (із «Вхідних»). */
export function openPayroll(p) {
    if (p) period = p;
    if (location.hash !== '#payroll') location.hash = 'payroll';
    else loadPayrollView();
}

/** Відкрити розділ одразу на картці працівника чи формі нового (із «Налаштувань»). */
export function openPayrollPerson(personId = 'new') {
    pendingOpen = personId || 'new';
    if (location.hash !== '#payroll') location.hash = 'payroll';
    else loadPayrollView();
}

/** Відкрити вкладку «Приват24» (із «Налаштувань → Банк»). */
export function openPayrollBank() {
    tab = 'bank';
    if (location.hash !== '#payroll') location.hash = 'payroll';
    else loadPayrollView();
}

/** Чи етап платиться через зарплатний проект і відомість у банку ще не готова (тоді — у розділ «Зарплата»). */
export async function payrollNeedsProject(targetPeriod, stage) {
    const state = await loadPayroll(targetPeriod);
    const s = state.stages?.[stage];
    if (s?.project) return s.project.status !== 'prepared';
    const part = r => (stage === 'final' && !state.stages?.advance ? r.netKop : r[stage]?.netKop);
    return state.settings?.payMethod === 'project' && !s?.plan && state.run.rows.some(r => r.kind === 'employee' && part(r) > 0);
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

// ------------------------------------------------------------
// ПРАЦІВНИКИ: як платимо й чого бракує
// ------------------------------------------------------------
const isProject = () => ctx.settings.payMethod === 'project';
const linked = p => p.kind === 'employee' && p.salaryProject?.receiverId;

function payWay(p) {
    if (linked(p)) return `картка ${p.salaryProject.pan || 'зарплатного проекту'} · таб. № ${p.salaryProject.tabn}`;
    if (p.iban) return `IBAN ${maskIban(p.iban)}`;
    return '';
}

/** Що ще потрібно в картці: [{ ok, text }]. */
function readiness(p) {
    const list = [{ ok: Boolean(p.rnokpp), text: 'РНОКПП' }];
    if (p.kind === 'employee') {
        list.push({ ok: Boolean(p.taxNotified), text: 'повідомлення ДПС про прийняття' });
        list.push(isProject() ? { ok: Boolean(linked(p)), text: 'картка зарплатного проекту' } : { ok: Boolean(p.iban || linked(p)), text: 'IBAN для зарплати' });
        list.push({ ok: Boolean(p.salaryKop), text: 'оклад' });
    } else {
        list.push({ ok: Boolean(p.iban), text: 'IBAN для оплати' }, { ok: Boolean(p.contract), text: 'номер і дата договору' });
    }
    return list;
}

// ------------------------------------------------------------
// ГОЛОВНИЙ ЕКРАН
// ------------------------------------------------------------
function nextHtml() {
    const n = nextPayrollAction(ctx, session.role);
    const btn = n.btn ? (n.act ? `<button type="button" class="sv-btn" data-act="${n.act}">${escapeHtml(n.btn)}</button>`
        : n.tab ? `<button type="button" class="sv-btn" data-tab="${n.tab}">${escapeHtml(n.btn)}</button>`
        : n.go ? `<button type="button" class="sv-btn" data-go="${n.go}"${n.go === 'settings' ? ' data-settings-tab="policy"' : ''}>${escapeHtml(n.btn)}</button>` : '') : '';
    const alt = n.alt ? `<button type="button" class="sv-btn is-soft" data-act="${n.alt.act}">${escapeHtml(n.alt.btn)}</button>` : '';
    return `<section class="zp-next is-${n.tone}">
        <span class="zp-next-icon" aria-hidden="true">${{ todo: '→', wait: '…', done: '✓', bad: '!' }[n.tone]}</span>
        <div class="zp-next-copy"><b>${escapeHtml(n.title)}</b><span>${escapeHtml(n.hint || '')}</span></div>
        ${btn || alt ? `<div class="zp-next-actions">${alt}${btn}</div>` : ''}
    </section>`;
}

function flowHtml() {
    return `<ol class="zp-flow" aria-label="Хід місяця">${flowSteps(ctx).map((s, i) => `<li class="is-${s.state}">
        <span class="zp-dot" aria-hidden="true">${s.state === 'done' ? '✓' : i + 1}</span>
        <span class="zp-step"><b>${escapeHtml(s.title)}</b><small>${escapeHtml(s.note || (s.state === 'skip' ? '' : '—'))}</small></span></li>`).join('')}</ol>`;
}

function kpisHtml() {
    const t = ctx.run.totals;
    const sum = payrollTotals(ctx);
    const people = [sum.employees ? `${sum.employees} ${sum.employees === 1 ? 'працівник' : sum.employees < 5 ? 'працівники' : 'працівників'}` : '',
        sum.contractors ? `${sum.contractors} ЦПД` : ''].filter(Boolean).join(' · ');
    const paidLine = (paid, signing, idle) => paid || signing ? `${paid ? `${grn(paid)} проведено` : ''}${paid && signing ? ' · ' : ''}${signing ? `${grn(signing)} на підписі` : ''}` : idle;
    return `<div class="pr-kpis zp-kpis">
        <section class="py-card pr-kpi"><span class="bk-label">Нараховано</span><b class="pr-kpi-sum">${grn(sum.grossKop)}</b><span class="py-muted">${escapeHtml(people || 'нікого у відомості')}</span></section>
        <section class="py-card pr-kpi"><span class="bk-label">Людям на руки</span><b class="pr-kpi-sum">${grn(sum.netKop)}</b>
            <span class="py-muted">${escapeHtml(paidLine(sum.netPaidKop, sum.netSigningKop, t.advance.netKop ? `аванс ${grn(t.advance.netKop)} · решта ${grn(t.final.netKop)}` : 'одним платежем'))}</span></section>
        <section class="py-card pr-kpi"><span class="bk-label">Податки й ЄСВ</span><b class="pr-kpi-sum">${grn(sum.taxKop)}</b>
            <span class="py-muted">${escapeHtml(paidLine(sum.taxPaidKop, sum.taxSigningKop, `ПДФО ${grn(t.pdfoKop)} · ВЗ ${grn(t.vzKop)} · ЄСВ ${grn(t.esvKop)}`))}</span></section>
    </div>`;
}

function tabsHtml() {
    const leaves = ctx.people.reduce((n, p) => n + (p.leaves || []).filter(l => l.to >= `${ctx.period}-01`).length, 0);
    const notReady = ctx.people.filter(p => p.active !== false && readiness(p).some(r => !r.ok)).length;
    const items = [['sheet', 'Відомість', ctx.run.rows.length || ''], ['people', 'Працівники', notReady ? `!${notReady}` : ctx.people.filter(p => p.active !== false).length || ''],
        ['leave', 'Відпустки', leaves || ''], ['bank', 'Приват24', '']];
    return `<div class="zp-tabs" role="tablist" aria-label="Розділи зарплати">${items.map(([k, label, n]) =>
        `<button type="button" role="tab" class="zp-tab${tab === k ? ' is-active' : ''}" aria-selected="${tab === k}" data-tab="${k}">${label}${n !== '' ? `<small${String(n).startsWith('!') ? ' class="is-bad" title="Картки, у яких бракує даних"' : ''}>${String(n).replace('!', '')}</small>` : ''}</button>`).join('')}</div>`;
}

// ---------- «Відомість» ----------
function sheetPane() {
    const rows = ctx.run.rows;
    if (!rows.length) return `<section class="py-card"><div class="fl-empty"><b>${ctx.people.length ? 'У цьому місяці нікому нараховувати' : 'Ще нікого немає'}</b>
        <span>${ctx.people.length ? 'Немає діючих працівників і договорів ЦПД — перевірте дати в картках.' : 'Додайте працівника чи виконавця за договором ЦПД — відомість складеться сама.'}</span>
        <button type="button" class="sv-btn" data-act="person-new">Додати працівника</button></div></section>`;
    const t = ctx.run.totals;
    const body = rows.map(r => {
        const [state, cls] = personState(ctx, r.personId, true);
        const days = r.kind === 'gph' ? 'акт' : `${r.workedDays ?? r.normDays} з ${r.normDays}`;
        const extras = [r.vacationDays ? `відпустка ${r.vacationDays} дн.` : '', r.sickDays ? `лікарняний ${r.sickDays} дн.` : '', r.bonusKop ? 'премія' : '', r.correctionKop ? 'перерахунок' : ''].filter(Boolean).join(' · ');
        return `<button type="button" class="zp-row" data-act="open-person" data-id="${escapeHtml(r.personId)}">
            <span class="zp-who"><span class="zp-ava" aria-hidden="true">${escapeHtml(initials(r.name))}</span><span><b>${escapeHtml(r.name)}</b>
                <small>${escapeHtml([r.position, r.kind === 'gph' ? 'договір ЦПД' : ''].filter(Boolean).join(' · '))}${extras ? ` · ${escapeHtml(extras)}` : ''}</small></span></span>
            <span class="zp-num" data-label="Дні">${escapeHtml(days)}</span>
            <span class="zp-num" data-label="Нараховано">${grn(r.grossKop)}</span>
            <span class="zp-num is-muted" data-label="Утримано">−${grn(r.pdfoKop + r.vzKop)}</span>
            <span class="zp-num is-strong" data-label="На руки">${grn(r.netKop)}</span>
            <span class="zp-state">${r.problems.length ? chip('виправте картку', 'is-bad') : chip(state, cls)}</span>
        </button>`;
    }).join('');
    return `<section class="py-card zp-table">
        <div class="zp-thead" aria-hidden="true"><span>Працівник</span><span>Дні</span><span>Нараховано</span><span>ПДФО і ВЗ</span><span>На руки</span><span>Стан</span></div>
        ${body}
        <div class="zp-tfoot"><span>Разом · ЄСВ ${grn(t.esvKop)} понад зарплату</span><span></span><span class="zp-num">${grn(t.grossKop)}</span><span class="zp-num is-muted">−${grn(t.pdfoKop + t.vzKop)}</span><span class="zp-num is-strong">${grn(t.netKop)}</span><span></span></div>
    </section>
    ${paymentsHtml()}
    ${Object.entries(ctx.stages).filter(([, s]) => s.complete === false && !s.project).map(([stage, s]) => `<section class="py-card"><p class="py-note">${s.external ? 'Етап оплачують у банку вручну. Привʼяжіть решту списань до відомості у «Рішеннях».' : 'Частину платежів ще не створено. Після виправлення картки чи рахунків податків оновіть реквізити й продовжте виплату.'}</p>
        ${s.external ? '<button type="button" class="sv-btn is-soft" data-go="inbox">До рознесення виписки</button>' : `<button type="button" class="sv-btn is-soft" data-act="recipients-refresh" data-stage="${stage}">Оновити реквізити</button>`}</section>`).join('')}
    <section class="py-card zp-rules"><span>ПДФО ${pct(ctx.run.rate.pdfo)} · ВЗ ${pct(ctx.run.rate.vz)} · ЄСВ ${pct(ctx.run.rate.esv)} · МЗП ${grn(ctx.run.rate.minWageKop)} · аванс ${ctx.settings.advancePct}% окладу</span>
        <button type="button" class="btn-ghost-small" data-go="settings" data-settings-tab="policy">Ставки, аванс і рахунки податків ›</button></section>`;
}

function paymentsHtml() {
    if (!ctx.payments.length) return '';
    const STAT = { sending: ['надсилається', 'is-work'], sent: ['на підписі', ''], paid: ['проведено', 'is-done'], failed: ['банк не прийняв', 'is-bad'], unknown: ['перевірте у Приват24', 'is-bad'], canceled: ['скасовано', 'is-locked'] };
    return `<section class="py-card pr-payments"><div class="py-card-head"><h2>Платежі за відомістю</h2></div>
        ${ctx.payments.map(p => { const [text, cls] = p.returnedKop ? [`повернено банком${p.repaid ? ' · відправлено знову' : ''}`, 'is-bad'] : STAT[p.status] || [p.status, ''];
            const who = TAX_NAMES[paymentWho(p)] ? `${TAX_NAMES[paymentWho(p)]}${p.stage === 'advance' ? ' з авансу' : ''}` : `${STAGE[p.stage] || 'Зарплата'}${p.source === 'salaryProject' ? ' · зарплатний проект' : ''}`;
            return `<div class="py-row is-link" data-pay="${escapeHtml(p.id)}" tabindex="0" role="button">
            <span class="py-main"><b>${escapeHtml(p.recipient)}</b><small class="py-muted">${escapeHtml(who)}${p.retry ? ' · повторно' : ''}${p.error ? ` · ${escapeHtml(p.error)}` : ''}</small></span>
            <span class="py-right"><b class="py-sum">${grn(p.amountKop)}</b>${chip(text, cls)}</span>
            ${p.status === 'paid' && p.returnedKop >= p.amountKop && !p.repaid ? `<span class="py-actions"><button type="button" class="sv-btn" data-act="repay" data-id="${escapeHtml(p.id)}" title="Спершу виправте IBAN у картці людини чи рахунок податку">Відправити знову</button></span>` : ''}
        </div>`; }).join('')}
        ${ctx.payments.some(p => p.returnedKop) ? '<p class="py-note">Повернений банком платіж: виправте IBAN у картці людини (або рахунок податку) і натисніть «Відправити знову» — новий платіж піде голові на підпис.</p>' : ''}</section>`;
}

// ---------- «Працівники» ----------
function peoplePane() {
    const inRun = new Map(ctx.run.rows.map(r => [r.personId, r]));
    const list = ctx.people.filter(p => showInactive || p.active !== false)
        .sort((a, b) => Number(b.active !== false) - Number(a.active !== false) || (a.kind === b.kind ? 0 : a.kind === 'employee' ? -1 : 1) || a.name.localeCompare(b.name, 'uk'));
    const hidden = ctx.people.filter(p => p.active === false).length;
    return `<div class="zp-bar">
        <button type="button" class="sv-btn" data-act="person-new">+ Працівник</button>
        <button type="button" class="sv-btn is-soft" data-act="person-new" data-kind="gph">+ Договір ЦПД</button>
        ${hidden ? `<label class="pr-check zp-bar-right"><input type="checkbox" data-act="toggle-inactive"${showInactive ? ' checked' : ''}> Показати звільнених (${hidden})</label>` : ''}
    </div>
    ${list.length ? `<div class="zp-people">${list.map(p => {
        const ready = readiness(p);
        const missing = ready.filter(r => !r.ok);
        const r = inRun.get(p.id);
        const way = payWay(p);
        return `<button type="button" class="zp-person${p.active === false ? ' is-off' : ''}" data-act="person-edit" data-id="${escapeHtml(p.id)}">
            <span class="zp-person-top"><span class="zp-ava" aria-hidden="true">${escapeHtml(initials(p.name))}</span>
                <span class="zp-person-name"><b>${escapeHtml(p.name)}</b><small>${escapeHtml([p.position, p.kind === 'gph' ? `договір ЦПД${p.contract ? ` ${p.contract}` : ''}` : 'трудовий договір'].filter(Boolean).join(' · '))}</small></span>
                ${p.active === false ? chip('звільнено', 'is-locked') : missing.length ? chip(`бракує ${missing.length}`, 'is-bad') : chip('готово', 'is-done')}</span>
            <span class="zp-person-facts">
                ${p.kind === 'employee' ? `<span><small>Оклад</small><b>${grn(p.salaryKop || 0)}${p.fte && p.fte < 1 ? ` · ${String(p.fte).replace('.', ',')} ст.` : ''}</b></span>` : `<span><small>Цього місяця</small><b>${r ? grn(r.grossKop) : '—'}</b></span>`}
                <span><small>Виплата</small><b>${escapeHtml(way || 'немає реквізитів')}</b></span>
                <span><small>${p.kind === 'employee' ? 'Прийнято' : 'Договір'}</small><b>${escapeHtml(p.from ? day(p.from) + ' ' + p.from.slice(0, 4) : '—')}${p.to ? ` – ${escapeHtml(day(p.to))}` : ''}</b></span>
            </span>
            ${missing.length && p.active !== false ? `<span class="zp-missing">Бракує: ${escapeHtml(missing.map(m => m.text).join(', '))}</span>` : ''}
        </button>`; }).join('')}</div>` : '<section class="py-card"><p class="py-empty">Ще нікого немає</p></section>'}`;
}

// ---------- «Відпустки» ----------
function allLeaves() {
    return ctx.people.filter(p => p.kind === 'employee').flatMap(p => (p.leaves || []).map(l => ({ ...l, person: p })));
}

function leavePane() {
    const first = `${ctx.period}-01`, last = `${ctx.period}-31`;
    const leaves = allLeaves();
    const now = leaves.filter(l => l.from <= last && l.to >= first).sort((a, b) => a.from.localeCompare(b.from));
    const next = leaves.filter(l => l.from > last).sort((a, b) => a.from.localeCompare(b.from));
    const past = leaves.filter(l => l.to < first).sort((a, b) => b.from.localeCompare(a.from)).slice(0, 6);
    // Внесене у відомість вручну, без графіка (старі записи).
    const manual = ctx.run.rows.flatMap(r => (r.absences || []).filter(a => !leaves.some(l => l.person.id === r.personId && l.from <= a.to && a.from <= l.to)).map(a => ({ ...a, name: r.name })));
    const amountIn = l => {
        const row = ctx.run.rows.find(r => r.personId === l.person.id);
        const items = (row?.absences || []).filter(a => a.type === l.type && l.from <= a.to && a.from <= l.to);
        return items.length ? items.reduce((s, a) => s + (a.kop || 0) + (a.fundKop || 0), 0) : null;
    };
    const item = (l, mode) => {
        const kop = mode === 'now' ? amountIn(l) : null;
        const months = l.from.slice(0, 7) !== l.to.slice(0, 7);
        return `<div class="zp-leave">
            <span class="zp-leave-type is-${l.type}" aria-hidden="true">${l.type === 'vacation' ? 'В' : 'Л'}</span>
            <span class="zp-leave-main"><b>${escapeHtml(l.person.name)}</b><small>${escapeHtml(`${LEAVE[l.type]} · ${range(l.from, l.to)} · ${daysBetween(l.from, l.to)} дн.${months ? ' · на два місяці' : ''}${l.note ? ` · ${l.note}` : ''}`)}</small></span>
            <span class="zp-leave-right">${mode === 'now' ? kop !== null ? `<b>${grn(kop)}</b>${chip('у відомості', 'is-done')}` : chip('не перераховано', 'is-work') : mode === 'next' ? chip(`з ${MONTHS[Number(l.from.slice(5, 7)) - 1].toLowerCase()}`, '') : ''}
                ${mode !== 'past' ? `<button type="button" class="zp-x" data-act="leave-remove" data-person="${escapeHtml(l.person.id)}" data-id="${escapeHtml(l.id)}" aria-label="Прибрати з графіка">×</button>` : ''}</span>
        </div>`;
    };
    const employees = ctx.people.filter(p => p.kind === 'employee' && p.active !== false);
    return `<div class="zp-bar">
        <button type="button" class="sv-btn" data-act="leave-new" data-type="vacation"${employees.length ? '' : ' disabled'}>+ Відпустка</button>
        <button type="button" class="sv-btn is-soft" data-act="leave-new" data-type="sick"${employees.length ? '' : ' disabled'}>+ Лікарняний</button>
    </div>
    <section class="py-card"><div class="py-card-head"><h2>${escapeHtml(monthTitle(ctx.period))}</h2></div>
        ${now.length ? now.map(l => item(l, 'now')).join('') : '<p class="py-empty">Цього місяця всі на роботі</p>'}
        ${manual.map(a => `<div class="zp-leave"><span class="zp-leave-type is-${a.type}" aria-hidden="true">${a.type === 'vacation' ? 'В' : 'Л'}</span>
            <span class="zp-leave-main"><b>${escapeHtml(a.name)}</b><small>${escapeHtml(`${LEAVE[a.type]} · ${range(a.from, a.to)} · внесено у табель вручну`)}</small></span>
            <span class="zp-leave-right"><b>${grn((a.kop || 0) + (a.fundKop || 0))}</b></span></div>`).join('')}
    </section>
    ${next.length ? `<section class="py-card"><div class="py-card-head"><h2>Заплановано</h2></div>${next.map(l => item(l, 'next')).join('')}</section>` : ''}
    ${past.length ? `<details class="py-card zp-past"><summary>Раніше</summary>${past.map(l => item(l, 'past')).join('')}</details>` : ''}
    <p class="py-note zp-help">Відпустку чи лікарняний вносьте одним записом, навіть якщо вони на два місяці: у кожну відомість потрапить своя частина, а середньоденна й перші 5 днів лікарняного за рахунок ОСББ рахуватимуться від початку. Відпускні платять до початку відпустки — разом з авансом.</p>`;
}

// ---------- «Приват24» ----------
function bankPane() {
    const method = ctx.settings.payMethod;
    const employees = ctx.people.filter(p => p.kind === 'employee' && p.active !== false);
    const stages = Object.entries(ctx.stages || {}).filter(([, s]) => s.project);
    return `<section class="py-card">
        <div class="py-card-head"><h2>Як платимо працівникам</h2></div>
        <div class="zp-seg" role="radiogroup" aria-label="Спосіб виплати">
            <button type="button" role="radio" aria-checked="${method === 'project'}" class="${method === 'project' ? 'is-active' : ''}" data-act="method" data-method="project"><b>Зарплатний проект</b><small>Одна відомість на всіх, картки ПриватБанку</small></button>
            <button type="button" role="radio" aria-checked="${method === 'iban'}" class="${method === 'iban' ? 'is-active' : ''}" data-act="method" data-method="iban"><b>Платежі по IBAN</b><small>Окремий платіж кожному на будь-який рахунок</small></button>
        </div>
        <p class="py-note">Податки (ПДФО, військовий збір, ЄСВ) і оплата за договорами ЦПД завжди йдуть окремими платежами по IBAN. Усе підписує голова в Приват24 для бізнесу.</p>
    </section>
    ${method === 'project' || stages.length ? projectHtml(employees) : ''}
    ${stages.map(([stage, s]) => packetHtml(stage, s)).join('')}
    ${method === 'project' || stages.length ? `<section class="py-card"><div class="py-card-head"><h2>Усі відомості в банку</h2>
        <button type="button" class="btn-ghost-small" data-act="packets-load">${packets.state === 'ok' ? 'Оновити' : 'Показати'}</button></div>
        ${packets.state === 'loading' ? '<p class="py-note">Запитую банк…</p>' : packets.state === 'error' ? `<p class="py-note is-bad">${escapeHtml(packets.error)}</p>`
            : packets.state === 'ok' ? packets.list.length ? packets.list.map(p => { const b = bankStep(p.status, p.substatus);
                return `<div class="py-row"><span class="py-main"><b>${escapeHtml(p.period ? `${STAGE[p.stage]} за ${monthTitle(p.period).toLowerCase()}` : p.packetName || p.reference)}</b>
                    <small class="py-muted">${escapeHtml([p.reference, p.createdAt ? String(p.createdAt).slice(0, 10).split('-').reverse().join('.') : '', `${p.recordCount} запис.`].filter(Boolean).join(' · '))}${p.error ? ` · ${escapeHtml(p.error)}` : ''}</small></span>
                    <span class="py-right"><b class="py-sum">${grn(p.recordAmountKop)}</b>${chip(b.text, b.bad ? 'is-bad' : b.step >= 5 ? 'is-done' : 'is-work')}</span></div>`; }).join('') : '<p class="py-empty">За три місяці відомостей немає</p>'
            : '<p class="py-note">Чернетки, відомості на підписі, проведені й забраковані за останні три місяці — прямо з Приват24.</p>'}
    </section>` : ''}`;
}

function projectHtml(employees) {
    const d = project.data;
    if (project.state === 'idle' || project.state === 'loading') {
        if (project.state === 'idle') loadProject();
        return '<section class="py-card"><div class="py-card-head"><h2>Зарплатний проект</h2></div><p class="py-note">Запитую список отримувачів у ПриватБанку…</p></section>';
    }
    if (project.state === 'error') return `<section class="py-card"><div class="py-card-head"><h2>Зарплатний проект</h2><button type="button" class="btn-ghost-small" data-act="project-sync">Спробувати ще</button></div>
        <p class="py-note is-bad">${escapeHtml(project.error)}</p>
        <button type="button" class="sv-btn is-soft" data-go="settings" data-settings-tab="bank">Підключити банк ›</button></section>`;
    if (!d.groups.length) return `<section class="py-card"><div class="py-card-head"><h2>Зарплатний проект</h2></div>
        <p class="py-note is-bad">У ПриватБанку для ОСББ немає зарплатного проекту. Відкрийте його в Приват24 для бізнесу («Каталог послуг → Зарплатні та інші виплати») або платіть по IBAN.</p></section>`;
    const byId = new Map(d.receivers.map(r => [r.id, r]));
    const unlinked = employees.filter(p => !linked(p));
    const canAuto = unlinked.some(p => d.receivers.some(r => r.inn === p.rnokpp));
    return `<section class="py-card">
        <div class="py-card-head"><h2>Зарплатний проект</h2><button type="button" class="btn-ghost-small" data-act="project-sync">Оновити з банку</button></div>
        <div class="zp-proj-head">
            ${d.groups.length > 1 ? `<select class="field-input field-select" data-act="project-group" aria-label="Проект">${d.groups.map(g => `<option value="${g.type}"${g.type === d.group ? ' selected' : ''}>${escapeHtml(g.name)}</option>`).join('')}</select>`
                : `<span class="zp-proj-name"><b>${escapeHtml(d.groups[0].name)}</b>${d.groups[0].rko !== null ? `<small>комісія за даними банку ${escapeHtml(String(d.groups[0].rko))}%</small>` : ''}</span>`}
            <span class="py-muted">${d.receivers.length} отримувач${d.receivers.length === 1 ? '' : 'ів'} у банку</span>
            ${d.sandbox ? chip('тестовий банк', 'is-work') : ''}
        </div>
        ${employees.length ? employees.map(p => {
            const r = linked(p) ? byId.get(p.salaryProject.receiverId) : null;
            const guess = !linked(p) && d.receivers.find(x => x.inn === p.rnokpp);
            return `<div class="zp-recv">
                <span class="zp-ava" aria-hidden="true">${escapeHtml(initials(p.name))}</span>
                <span class="zp-recv-main"><b>${escapeHtml(p.name)}</b><small>${linked(p) ? escapeHtml(`картка ${p.salaryProject.pan || r?.pan || ''} · таб. № ${p.salaryProject.tabn}${r ? '' : ' · у банку не знайдено — оновіть'}`)
                    : guess ? escapeHtml(`у банку є ${guess.fio}, таб. № ${guess.tabn} — звʼяжіть`) : 'ще не в проекті'}</small></span>
                ${linked(p) ? chip(r ? 'у проекті' : 'перевірте', r ? 'is-done' : 'is-bad') : `<button type="button" class="sv-btn is-soft" data-act="project-add" data-id="${escapeHtml(p.id)}">${guess ? 'Звʼязати' : 'Додати'}</button>`}
            </div>`; }).join('') : '<p class="py-empty">Немає працівників за трудовим договором</p>'}
        ${canAuto ? '<button type="button" class="sv-btn is-soft" data-act="project-auto">Звʼязати всіх за РНОКПП</button>' : ''}
    </section>`;
}

function packetHtml(stage, s) {
    const key = `${ctx.period}:${stage}`;
    const st = bankStatus[key];
    const pr = s.project;
    if (pr.reference && !st && !pr._asked) { pr._asked = true; refreshPacket(stage); }
    const b = bankStep(st?.status || pr.bankStatus, st?.substatus ?? pr.bankSubstatus);
    const steps = ['Створено', 'Перевірено банком', 'Підписано в Приват24', 'Надіслано', 'Проведено'];
    const total = Object.keys(pr.added || {}).length;
    const signDone = b.step > 3 || b.done;
    return `<section class="py-card zp-packet">
        <div class="py-card-head"><h2>${STAGE[stage]} за ${escapeHtml(monthTitle(ctx.period).toLowerCase())} — відомість банку</h2>${chip(pr.status === 'prepared' ? b.text : pr.status === 'unknown' ? 'результат невідомий' : 'готується', b.bad || pr.status === 'unknown' ? 'is-bad' : b.step >= 5 ? 'is-done' : 'is-work')}</div>
        <ol class="zp-pflow">${steps.map((t, i) => `<li class="${b.bad && i + 1 === Math.max(1, b.step) ? 'is-bad' : i + 1 < b.step || (i + 1 === b.step && (i !== 2 || signDone)) || b.step >= 5 ? 'is-done' : i + 1 === b.step || (i === 2 && b.step === 3) ? 'is-current' : ''}"><span></span>${t}</li>`).join('')}</ol>
        <p class="py-note">${escapeHtml([pr.reference ? `Референс ${pr.reference}` : 'Банк ще не підтвердив референс', `${total} працівник${total === 1 ? '' : 'ів'} у відомості`, st ? `${grn(st.amountKop)}` : ''].filter(Boolean).join(' · '))}${pr.error ? ` · <span class="is-bad">${escapeHtml(pr.error)}</span>` : ''}</p>
        ${st?.rows?.length ? `<div class="zp-precs">${st.rows.map(r => { const [t, c] = RECORD_STATUS[r.status] || [r.status, 'is-bad'];
            return `<div class="zp-prec"><span><b>${escapeHtml(r.name)}</b><small>${escapeHtml(`таб. № ${r.tabn} · ${r.card}`)}${r.error ? ` · ${escapeHtml(r.error)}` : ''}</small></span><b class="zp-num">${grn(r.amountKop)}</b>${chip(t, c)}</div>`; }).join('')}</div>` : ''}
        ${b.step >= 2 && b.step < 4 && !b.bad ? `<p class="zp-sign">Підписати й надіслати відомість можна лише в <b>Приват24 для бізнесу → Каталог послуг → Зарплатні та інші виплати</b>${session.role === 'chair' ? '' : ' — це робить голова'}.</p>` : ''}
        <div class="chs-actions">
            ${pr.reference ? `<button type="button" class="sv-btn is-soft" data-act="packet-refresh" data-stage="${stage}">Оновити стан</button>` : ''}
            ${pr.status !== 'prepared' && pr.status !== 'unknown' ? `<button type="button" class="sv-btn" data-act="pay-${stage}">Продовжити підготовку</button>` : ''}
            ${(st?.sandbox || project.data?.sandbox) && pr.reference && b.step >= 2 && b.step < 5 && !b.bad ? `<button type="button" class="sv-btn is-soft" data-act="packet-sandbox" data-stage="${stage}">Тестовий банк: ${b.step === 2 ? 'підписати' : b.step === 3 && !b.done ? 'другий підпис' : b.step === 3 ? 'надіслати' : 'провести'}</button>` : ''}
        </div>
        ${pr.status === 'unknown' && session.role === 'chair' ? `<label class="py-field"><span>Референс відомості з Приват24</span><input class="field-input" data-project-ref="${stage}" maxlength="120"></label>
            <button type="button" class="sv-btn is-soft" data-act="project-recover" data-stage="${stage}">Звірити й продовжити</button>` : pr.status === 'unknown' ? '<p class="py-note">Банк не відповів, чи створено відомість. Голова звіряє її в Приват24 і вводить референс тут.</p>' : ''}
    </section>`;
}

async function loadProject(group) {
    project = { ...project, state: 'loading' };
    try {
        project = { state: 'ok', data: await payrollPeek({ action: 'projectContext', group: group || ctx?.settings?.projectGroup || null }), error: '' };
    } catch (e) { project = { state: 'error', data: null, error: e.message }; }
    if (tab === 'bank' || sheet?.kind === 'form') renderPane();
    if (sheet?.kind === 'form') renderSheet();
}

async function refreshPacket(stage) {
    try {
        bankStatus[`${ctx.period}:${stage}`] = await payrollPeek({ action: 'projectStatus', period: ctx.period, stage });
    } catch (e) { toast(e.message, 'error'); }
    if (tab === 'bank') renderPane();
}

function paneHtml() {
    return tab === 'people' ? peoplePane() : tab === 'leave' ? leavePane() : tab === 'bank' ? bankPane() : sheetPane();
}
function renderPane() {
    const pane = document.getElementById('zpPane');
    if (!pane || !ctx) return;
    pane.innerHTML = paneHtml();
    document.querySelectorAll('#viewPayroll .zp-tab').forEach(b => { const on = b.dataset.tab === tab; b.classList.toggle('is-active', on); b.setAttribute('aria-selected', on); });
}

export async function loadPayrollView() {
    ctx = await loadPayroll(period);
    period = ctx.period;
    draft = JSON.parse(JSON.stringify(ctx.inputs || {}));
    if (pendingOpen) {
        const id = pendingOpen;
        pendingOpen = null;
        tab = 'people';
        queueMicrotask(() => openSheet(id === 'new' ? { kind: 'form', id: null } : { kind: 'form', id }));
    }
    const [label, cls] = ctx.closed ? ['Місяць закрито', 'is-locked'] : { none: ['Відомість не збережено', ''], draft: ['Чекає голову', 'is-work'], approved: ['Затверджено', 'is-done'] }[ctx.status] || ['', ''];
    const months = [...new Set([shift(ctx.today.slice(0, 7), 1), ctx.today.slice(0, 7), shift(ctx.today.slice(0, 7), -1), ...ctx.runs.map(r => r.period), ctx.period])].sort().reverse();
    document.getElementById('viewPayroll').innerHTML = `
        <div class="pr-head">
            <div class="pr-head-left">
                <select id="prPeriod" class="pr-period" aria-label="Місяць">${months.map(m => `<option value="${m}"${m === ctx.period ? ' selected' : ''}>${monthTitle(m)}</option>`).join('')}</select>
                ${chip(`${label}${ctx.approvedAt && ctx.status === 'approved' ? ` ${new Date(ctx.approvedAt).toLocaleDateString('uk-UA', { day: 'numeric', month: 'long' })}` : ''}`, cls)}
            </div>
        </div>
        ${nextHtml()}
        ${flowHtml()}
        ${kpisHtml()}
        ${tabsHtml()}
        <div id="zpPane" role="tabpanel">${paneHtml()}</div>`;
    if (sheet) renderSheet();
    return ctx.status === 'draft' && session.role === 'chair' ? 1 : 0;
}

// ------------------------------------------------------------
// БІЧНА КАРТКА
// ------------------------------------------------------------
function sheetHost() {
    let el = document.getElementById('zpSheet');
    if (!el) {
        el = document.createElement('div');
        el.id = 'zpSheet';
        el.className = 'chs-wrap zp-sheet';
        el.hidden = true;
        document.body.appendChild(el);
        el.addEventListener('click', onClick);
        el.addEventListener('change', onChange);
        el.addEventListener('input', onInput);
        document.addEventListener('keydown', e => { if (e.key === 'Escape' && !el.hidden && !document.querySelector('.confirm-overlay')) closeSheet(); });
    }
    return el;
}

function openSheet(s) {
    sheet = s;
    if (s.kind === 'form' && (isProject() || ctx.people.find(p => p.id === s.id)?.salaryProject) && project.state === 'idle') loadProject();
    renderSheet();
    sheetHost().querySelector('.chs-sheet')?.focus();
}

function closeSheet() {
    sheet = null;
    const el = sheetHost();
    el.hidden = true;
    el.innerHTML = '';
    document.body.classList.remove('chs-open');
}

function renderSheet() {
    if (!sheet || !ctx) return;
    const el = sheetHost();
    const [title, body] = sheet.kind === 'person' ? personSheet(sheet.id) : sheet.kind === 'leave' ? leaveSheet() : formSheet(sheet.id);
    const keepScroll = el.querySelector('.chs-body')?.scrollTop || 0;
    el.innerHTML = `<div class="chs-backdrop" data-act="sheet-close"></div>
        <aside class="chs-sheet" role="dialog" aria-modal="true" aria-label="${escapeHtml(title)}" tabindex="-1">
            <div class="chs-bar"><span></span><span class="chs-bar-title">${escapeHtml(title)}</span>
                <button type="button" class="chs-icon" data-act="sheet-close" aria-label="Закрити">×</button></div>
            <div class="chs-body">${body}</div>
        </aside>`;
    el.hidden = false;
    document.body.classList.add('chs-open');
    if (keepScroll) el.querySelector('.chs-body').scrollTop = keepScroll;
}

const locked = () => ctx.closed || Boolean(ctx.stages.final) || ctx.stages.advance?.complete === false;

// ---------- Розрахунок і табель людини ----------
function personSheet(id) {
    const r = ctx.run.rows.find(x => x.personId === id);
    const p = ctx.people.find(x => x.id === id) || {};
    if (!r) return [p.name || 'Працівник', `<div class="chs-head"><span class="py-muted">${escapeHtml(ctx.kinds[p.kind] || '')}</span><span class="chs-title">${escapeHtml(p.name || '')}</span></div>
        <p class="py-note">${p.active === false ? 'Картку позначено «не діє» — у відомості людини немає.' : 'У цьому місяці договір не діє — перевірте дати в картці.'}</p>
        <div class="chs-actions"><button type="button" class="sv-btn" data-act="person-edit" data-id="${escapeHtml(id)}">Картка працівника</button></div>`];
    const rate = ctx.run.rate;
    const lines = r.kind === 'gph'
        ? [['За актом виконаних робіт', grn(r.actKop || 0)]]
        : [[`Оклад${r.fte && r.fte < 1 ? ` · ставка ${String(r.fte).replace('.', ',')}` : ''}`, grn(r.salaryKop)],
            ['За відпрацьовані дні', `${r.workedDays ?? r.normDays} з ${r.normDays} · ${grn(r.regularKop - (r.bonusKop || 0))}`],
            ...(r.bonusKop ? [['Премія', grn(r.bonusKop)]] : []),
            ...(r.vacationKop ? [[`Відпускні · ${r.vacationDays} дн.`, grn(r.vacationKop)]] : []),
            ...(r.sickKop ? [[`Лікарняні за рахунок ОСББ · ${r.sickEmployerDays} дн.`, grn(r.sickKop)]] : []),
            ...(r.fundSickKop ? [['Лікарняні з ПФУ', grn(r.fundSickKop)]] : []),
            ...(r.correctionKop ? [['Перерахунок', grn(r.correctionKop)]] : [])];
    lines.push(['Нараховано', grn(r.grossKop)], [`ПДФО ${pct(rate.pdfo)}${r.pspKop ? ` (пільга ${grn(r.pspKop)})` : ''}`, `−${grn(r.pdfoKop)}`], [`Військовий збір ${pct(rate.vz)}`, `−${grn(r.vzKop)}`]);
    const notes = [...r.problems.map(t => `<li class="is-bad">${escapeHtml(t)}</li>`), ...r.warnings.map(t => `<li>${escapeHtml(t)}</li>`)];
    const dis = locked() ? ' disabled' : '';
    const input = draft[id] || {};
    const absences = r.absences || [];
    const fields = r.kind === 'gph'
        ? `<label class="py-field"><span>Сума акта за місяць, грн</span><input class="field-input" data-f="actKop" inputmode="decimal" value="${money2(input.actKop ?? r.actKop)}" placeholder="0,00"${dis}></label>`
        : `<div class="py-pair">
            <label class="py-field"><span>Відпрацьовано днів (норма ${r.normDays})</span><input class="field-input" data-f="workedDays" inputmode="numeric" value="${input.workedDays ?? r.workedDays ?? ''}" data-auto="${r.workedDays ?? ''}"${dis}></label>
            <label class="py-field"><span>Премія, грн</span><input class="field-input" data-f="bonusKop" inputmode="decimal" value="${money2(input.bonusKop)}" placeholder="0,00"${dis}></label>
        </div>
        ${r.fundDays || input.fundSickKop ? `<label class="py-field"><span>Кошти ПФУ за лікарняний (коли надійшли), грн</span><input class="field-input" data-f="fundSickKop" inputmode="decimal" value="${money2(input.fundSickKop)}" placeholder="≈ ${money2(r.fundExpectKop)}"${dis}></label>` : ''}
        <details class="zp-more"${input.correctionKop ? ' open' : ''}><summary>Перерахунок за минулий місяць</summary>
            <div class="zp-corr">
                <input class="field-input" data-f="correctionKop" inputmode="decimal" value="${money2(input.correctionKop)}" placeholder="±0,00" aria-label="Сума перерахунку, плюс чи мінус"${dis}>
                <input class="field-input" type="month" data-f="correctionFor" value="${escapeHtml(input.correctionFor || shift(ctx.period, -1))}" max="${shift(ctx.period, -1)}" aria-label="За який місяць"${dis}>
                <input class="field-input" data-f="correctionNote" maxlength="120" value="${escapeHtml(input.correctionNote || '')}" placeholder="причина" aria-label="Причина перерахунку"${dis}>
            </div></details>`;
    const paidAdvance = ctx.stages.advance ? r.advance.netKop : 0;
    return [r.name, `<div class="chs-head"><span class="py-muted">${escapeHtml(r.kind === 'gph' ? `Договір ЦПД${p.contract ? ` ${p.contract}` : ''}` : `Трудовий договір${p.mainJob === false ? ' · сумісництво' : ''}`)}</span>
            <span class="chs-title">${escapeHtml(r.name)}</span>${r.position ? `<span class="py-muted">${escapeHtml(r.position)}</span>` : ''}
            <div class="chs-actions"><button type="button" class="sv-btn is-soft" data-act="person-edit" data-id="${escapeHtml(id)}">Картка</button>
                <button type="button" class="sv-btn is-soft" data-act="payslip" data-id="${escapeHtml(id)}">Розрахунковий лист</button></div></div>
        <div class="chs-tiles"><div><span>На руки</span><b>${grn(r.netKop)}</b></div><div><span>${paidAdvance ? 'Аванс виплачено' : 'Аванс'}</span><b>${grn(r.advance.netKop)}</b></div>
            <div><span>Решта</span><b>${grn(r.final.netKop)}</b></div><div><span>ЄСВ від ОСББ</span><b>${grn(r.esvKop)}</b></div></div>
        <section class="py-card zp-lines"><dl class="pr-lines">${lines.map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd${v.startsWith('−') ? ' class="is-minus"' : ''}>${escapeHtml(v)}</dd>`).join('')}
            <dt class="is-total">До виплати</dt><dd class="is-total">${grn(r.netKop)}</dd></dl></section>
        ${notes.length ? `<ul class="zp-notes">${notes.join('')}</ul>` : ''}
        ${r.kind === 'employee' ? `<h3 class="chs-h">Відпустки й лікарняні</h3>
        <section class="py-card zp-abs">${absences.length ? absences.map(a => `<div class="zp-leave"><span class="zp-leave-type is-${a.type}" aria-hidden="true">${a.type === 'vacation' ? 'В' : 'Л'}</span>
            <span class="zp-leave-main"><b>${escapeHtml(`${LEAVE[a.type]} · ${range(a.from, a.to)}`)}</b><small>${escapeHtml(`${a.days} дн. · середньоденна ${grn(a.avgKop)}${a.type === 'sick' ? ` · ${a.percent}% · ОСББ ${a.employerDays} дн.${a.fundDays ? `, ПФУ ${a.fundDays} дн.` : ''}` : ''}`)}</small></span>
            <span class="zp-leave-right"><b>${grn(a.kop)}</b></span></div>`).join('') : '<p class="py-empty">Цього місяця без відсутностей</p>'}
            ${locked() ? '' : `<div class="chs-actions"><button type="button" class="sv-btn is-soft" data-act="leave-new" data-type="vacation" data-person="${escapeHtml(id)}">+ Відпустка</button>
                <button type="button" class="sv-btn is-soft" data-act="leave-new" data-type="sick" data-person="${escapeHtml(id)}">+ Лікарняний</button></div>`}</section>` : ''}
        <h3 class="chs-h">${r.kind === 'gph' ? 'Акт за місяць' : 'Табель за місяць'}</h3>
        <section class="py-card zp-fields" data-person="${escapeHtml(id)}">${fields}</section>
        ${locked() ? `<p class="py-note">${ctx.closed ? 'Місяць закрито.' : 'Виплату вже відправлено — відомість не змінюється. Перерахунок внесіть у наступному місяці.'}</p>`
            : `<div class="chs-actions"><button type="button" class="sv-btn" data-act="person-save" data-id="${escapeHtml(id)}">Зберегти й перерахувати</button></div>
            ${ctx.status === 'approved' ? '<p class="py-note">Відомість уже затверджено: після змін вона знову піде голові на затвердження.</p>' : ''}`}`];
}

/** Поля табеля з картки людини → чернетка відомості. */
function readPersonFields(id) {
    const box = document.querySelector(`#zpSheet .zp-fields[data-person="${CSS.escape(id)}"]`);
    if (!box) return;
    const next = { ...(draft[id] || {}) };
    box.querySelectorAll('[data-f]').forEach(i => {
        const k = i.dataset.f, v = i.value.trim();
        if (k === 'workedDays') {
            // Дні, які система порахувала сама (з відпустками), не фіксуємо: зміниться відсутність — зміняться й дні.
            if (v === '' || (v === i.dataset.auto && draft[id]?.workedDays === undefined)) delete next.workedDays;
            else if (!/^\d{1,2}$/.test(v)) throw new Error('Дні — ціле число');
            else next.workedDays = Number(v);
        } else if (k === 'correctionFor' || k === 'correctionNote') {
            next[k] = v;
        } else {
            const kop = v ? toKop(v) : 0;
            if (v && kop === null) throw new Error('Суму вказуйте в гривнях, напр. 8 000,00');
            if (kop) next[k] = kop; else delete next[k];
        }
    });
    if (!next.correctionKop) { delete next.correctionFor; delete next.correctionNote; }
    draft[id] = next;
}

/** Розрахунковий лист (ст. 30 Закону «Про оплату праці»): друк з браузера. */
function printPayslip(id) {
    const r = ctx.run.rows.find(x => x.personId === id);
    if (!r) return;
    const rows = [['Оклад', r.kind === 'gph' ? '' : grn(r.salaryKop)], ['Відпрацьовано днів', r.kind === 'gph' ? '' : `${r.workedDays ?? r.normDays} з ${r.normDays}`],
        ['Заробітна плата за відпрацьований час', r.kind === 'gph' ? '' : grn(r.regularKop - (r.bonusKop || 0))], ['Винагорода за договором ЦПД', r.kind === 'gph' ? grn(r.grossKop) : ''],
        ['Премія', r.bonusKop ? grn(r.bonusKop) : ''], ['Відпускні', r.vacationKop ? `${grn(r.vacationKop)} (${r.vacationDays} дн.)` : ''],
        ['Допомога з тимчасової непрацездатності', r.sickKop || r.fundSickKop ? grn((r.sickKop || 0) + (r.fundSickKop || 0)) : ''], ['Перерахунок', r.correctionKop ? grn(r.correctionKop) : ''],
        ['Усього нараховано', grn(r.grossKop)], [`ПДФО ${pct(ctx.run.rate.pdfo)}`, grn(r.pdfoKop)], [`Військовий збір ${pct(ctx.run.rate.vz)}`, grn(r.vzKop)],
        ['Усього утримано', grn(r.pdfoKop + r.vzKop)], ['Аванс', grn(r.advance.netKop)], ['Остаточний розрахунок', grn(r.final.netKop)], ['До виплати за місяць', grn(r.netKop)],
        [`ЄСВ ${pct(ctx.run.rate.esv)} (сплачує роботодавець)`, grn(r.esvKop)]].filter(([, v]) => v);
    const w = window.open('', '_blank', 'width=720,height=900');
    if (!w) { toast('Браузер заблокував нове вікно — дозвольте спливні вікна для друку', 'error'); return; }
    w.document.write(`<!doctype html><html lang="uk"><head><meta charset="utf-8"><title>Розрахунковий лист — ${escapeHtml(r.name)}</title>
        <style>body{font:14px/1.45 system-ui,sans-serif;margin:32px;color:#000}h1{font-size:20px;margin:0 0 4px}p{margin:0 0 16px;color:#444}table{width:100%;border-collapse:collapse}
        td{padding:7px 0;border-bottom:1px solid #ddd}td:last-child{text-align:right;font-variant-numeric:tabular-nums}tr.t td{font-weight:700;border-bottom:2px solid #000}</style></head>
        <body><h1>Розрахунковий лист за ${escapeHtml(monthTitle(ctx.period).toLowerCase())}</h1>
        <p>${escapeHtml(r.name)}${r.position ? `, ${escapeHtml(r.position)}` : ''} · ${escapeHtml(r.kind === 'gph' ? 'договір ЦПД' : 'трудовий договір')}</p>
        <table>${rows.map(([k, v]) => `<tr class="${/^Усього|^До виплати/.test(k) ? 't' : ''}"><td>${escapeHtml(k)}</td><td>${escapeHtml(v)}</td></tr>`).join('')}</table>
        <script>window.onload=()=>window.print()<\/script></body></html>`);
    w.document.close();
}

// ---------- Картка працівника: прийом і зміни ----------
function formSheet(id) {
    const p = sheet.data || (id ? ctx.people.find(x => x.id === id) : null) || { kind: sheet.newKind || 'employee' };
    const gph = p.kind === 'gph';
    const f = (fid, label, value, extra = '') => `<label class="py-field"><span>${label}</span><input id="${fid}" class="field-input" value="${escapeHtml(value ?? '')}" ${extra}></label>`;
    const section = (title, body, open = true) => `<details class="py-card zp-sec"${open ? ' open' : ''}><summary>${title}</summary><div class="zp-sec-body">${body}</div></details>`;
    const ready = id ? readiness(p) : [];
    return [id ? p.name : gph ? 'Новий договір ЦПД' : 'Новий працівник', `
        ${id ? `<div class="zp-ready">${ready.map(r => `<span class="${r.ok ? 'is-ok' : 'is-miss'}">${r.ok ? '✓' : '!'} ${escapeHtml(r.text)}</span>`).join('')}</div>` : `<p class="py-note">${gph ? 'Виконавець за договором ЦПД: оплата за актом, ЄСВ з суми акта, без табеля й відпусток.' : 'Повідомте ДПС про прийняття до початку роботи. Після збереження людина зʼявиться у відомості з дати прийому.'}</p>`}
        ${section('Особа', `<div class="zp-grid">
            ${f('pfName', 'Прізвище, імʼя, по батькові', p.name, 'autocomplete="off"')}
            ${f('pfRnokpp', 'РНОКПП', p.rnokpp, 'inputmode="numeric" maxlength="10"')}
            <label class="py-field"><span>Договір</span><select id="pfKind" class="field-input field-select">${Object.entries(ctx.kinds).map(([k, v]) => `<option value="${k}"${k === p.kind ? ' selected' : ''}>${v}</option>`).join('')}</select></label>
            <label class="py-field"><span>Стать (для звіту ДПС)</span><select id="pfGender" class="field-input field-select"><option value="">—</option>${['Ж', 'Ч'].map(g => `<option${g === p.gender ? ' selected' : ''}>${g}</option>`).join('')}</select></label>
        </div>`)}
        ${section(gph ? 'Договір' : 'Робота й оклад', `<div class="zp-grid">
            ${f('pfPosition', gph ? 'Роботи за договором' : 'Посада', p.position, 'placeholder="двірник"')}
            ${gph ? f('pfContract', 'Номер і дата договору', p.contract, 'placeholder="№ 5 від 01.10.2026"') : `${f('pfSalary', 'Оклад, грн', money2(p.salaryKop), 'inputmode="decimal"')}
            ${f('pfFte', 'Ставка (1 — повна)', String(p.fte ?? 1).replace('.', ','), 'inputmode="decimal"')}`}
            ${f('pfFrom', gph ? 'Початок договору' : 'Прийнято', p.from, 'type="date"')}
        </div>
        ${gph ? '' : `<label class="pr-check"><input id="pfMain" type="checkbox"${p.mainJob !== false ? ' checked' : ''}> Основне місце роботи (ЄСВ не менше ніж з мінімальної зарплати)</label>
        <label class="pr-check"><input id="pfNotified" type="checkbox"${p.taxNotified ? ' checked' : ''}> Повідомлення ДПС про прийняття подано</label>`}`)}
        ${section('Виплата', `${f('pfIban', gph ? 'IBAN для оплати' : 'IBAN (якщо не через зарплатний проект)', p.iban, 'spellcheck="false" placeholder="UA…"')}
            ${gph ? '' : projectBlock(p)}`)}
        ${gph ? '' : section('Податкова пільга й лікарняні', `<div class="zp-grid">
            <label class="py-field zp-wide"><span>Податкова соціальна пільга (за заявою)</span><select id="pfPsp" class="field-input field-select"><option value="">Немає</option>${Object.entries(ctx.pspKinds || {}).map(([k, v]) => `<option value="${k}"${k === p.psp?.kind ? ' selected' : ''}>${escapeHtml(`${k} — ${v}`)}</option>`).join('')}</select></label>
            ${f('pfPspChildren', 'Дітей до 18 (для пільги на дітей)', p.psp?.children || '', 'inputmode="numeric"')}
            ${f('pfPspFrom', 'Заява про пільгу від', p.psp?.from || '', 'type="date"')}
            ${f('pfInsurance', 'Страховий стаж, років', p.insuranceYears ?? '', 'inputmode="decimal"')}
        </div>
        <label class="py-field"><span>Заробіток до застосунку — для середньоденної (рядок: місяць сума [календарних днів])</span>
            <textarea id="pfPrior" class="field-input" rows="3" placeholder="2026-09 8647,00&#10;2026-08 8647,00 31">${escapeHtml(Object.entries(p.priorEarnings || {}).sort().map(([m, e]) => `${m} ${money2(e.kop) || '0,00'}${e.days !== undefined ? ` ${e.days}` : ''}`).join('\n'))}</textarea></label>`, Boolean(p.psp || p.insuranceYears || Object.keys(p.priorEarnings || {}).length) || !id)}
        ${section('Кадрові документи для звіту (Д5)', `<div class="zp-grid">
            ${gph ? '' : `${f('pfKp', 'Код професії за КП', p.kpCode, 'inputmode="decimal" maxlength="10" placeholder="9141"')}
            ${f('pfHireDoc', 'Наказ про прийняття', p.hireDoc, 'placeholder="Наказ № 1-к від 15.10.2026"')}`}
            ${f('pfFireDoc', gph ? 'Документ про припинення договору' : 'Наказ про звільнення', p.fireDoc)}
            ${f('pfFireBasis', 'Підстава припинення', p.fireBasis, 'placeholder="п. 1 ст. 36 КЗпП"')}
        </div>`, false)}
        ${id ? section(gph ? 'Припинення договору' : 'Звільнення', `<div class="zp-grid">${f('pfTo', gph ? 'Кінець договору' : 'Звільнено', p.to, 'type="date"')}</div>
            <label class="pr-check"><input id="pfActive" type="checkbox"${p.active !== false ? ' checked' : ''}> Діє (є у відомості)</label>`, Boolean(p.to) || p.active === false) : ''}
        <div class="chs-actions zp-sticky"><button type="button" class="sv-btn" data-act="form-save">${id ? 'Зберегти' : gph ? 'Додати договір' : 'Прийняти працівника'}</button>
            <button type="button" class="sv-btn is-soft" data-act="sheet-close">Скасувати</button></div>`];
}

function projectBlock(p) {
    const id = sheet.id;
    if (linked(p)) return `<div class="zp-proj-linked"><b>Зарплатний проект</b><span>картка ${escapeHtml(p.salaryProject.pan || '')} · таб. № ${escapeHtml(p.salaryProject.tabn)}</span>
        <button type="button" class="btn-ghost-small" data-act="project-unlink" data-id="${escapeHtml(id)}">Відвʼязати</button></div>`;
    if (!isProject()) return '<p class="py-note">Зарплатний проект ПриватБанку вмикається у вкладці «Приват24».</p>';
    if (!id) return '<p class="py-note">Після збереження картки тут можна додати працівника в зарплатний проект ПриватБанку.</p>';
    if (project.state !== 'ok') return `<p class="py-note${project.state === 'error' ? ' is-bad' : ''}">${project.state === 'error' ? escapeHtml(project.error) : 'Запитую зарплатний проект у банку…'}</p>`;
    const d = project.data;
    if (!d.group) return '<p class="py-note is-bad">У ПриватБанку немає зарплатного проекту для ОСББ.</p>';
    const same = d.receivers.filter(r => r.inn && r.inn === p.rnokpp);
    return `<div class="zp-proj-add"><b>Зарплатний проект</b>
        ${same.length ? `<p class="py-note">У банку вже є отримувач з цим РНОКПП:</p>${same.map(r => `<div class="zp-recv"><span class="zp-recv-main"><b>${escapeHtml(r.fio)}</b><small>${escapeHtml(`таб. № ${r.tabn} · ${r.pan}`)}</small></span>
            <button type="button" class="sv-btn is-soft" data-act="project-link" data-id="${escapeHtml(id)}" data-receiver="${escapeHtml(r.id)}">Звʼязати</button></div>`).join('')}
            <p class="py-note">Або додайте нову картку:</p>` : '<p class="py-note">Банк додасть працівника до проекту за номером картки. Повний номер не зберігається в застосунку.</p>'}
        <div class="zp-grid">
            <label class="py-field"><span>Номер картки</span><input id="pjPan" class="field-input" inputmode="numeric" autocomplete="off" maxlength="23" placeholder="0000 0000 0000 0000"></label>
            <label class="py-field"><span>Табельний номер</span><input id="pjTabn" class="field-input" maxlength="20" value="${escapeHtml(d.nextTabn || '')}"></label>
        </div>
        <button type="button" class="sv-btn is-soft" data-act="project-enroll" data-id="${escapeHtml(id)}">Додати в зарплатний проект</button>
        <p class="py-note">Картка не ПриватБанку теж підходить — банк візьме ПІБ і РНОКПП з цієї картки.</p></div>`;
}

function readPerson() {
    const v = fid => document.getElementById(fid)?.value.trim() ?? '';
    const base = sheet.data || ctx.people.find(x => x.id === sheet.id) || {};
    const kind = v('pfKind') || base.kind || 'employee';
    const p = { ...base, id: sheet.id || null, name: v('pfName'), kind, position: v('pfPosition'), rnokpp: v('pfRnokpp'), iban: v('pfIban'),
        contract: v('pfContract'), from: v('pfFrom'), to: document.getElementById('pfTo') ? v('pfTo') : base.to || '',
        active: document.getElementById('pfActive') ? document.getElementById('pfActive').checked : base.active !== false,
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

// ---------- Відпустка / лікарняний ----------
function leaveSheet() {
    const s = sheet;
    const employees = ctx.people.filter(p => p.kind === 'employee' && p.active !== false);
    const pv = s.preview;
    const title = s.type === 'sick' ? 'Лікарняний' : 'Відпустка';
    const months = pv?.months || [];
    const total = months.reduce((n, m) => n + (m.kop || 0), 0);
    const fund = months.reduce((n, m) => n + (m.fundKop || 0), 0);
    const problems = months.flatMap(m => m.problems || []);
    return [title, `
        <section class="py-card zp-fields">
            <div class="zp-seg is-small" role="radiogroup" aria-label="Вид">${['vacation', 'sick'].map(t => `<button type="button" role="radio" aria-checked="${s.type === t}" class="${s.type === t ? 'is-active' : ''}" data-act="leave-type" data-type="${t}"><b>${LEAVE[t]}</b></button>`).join('')}</div>
            <label class="py-field"><span>Працівник</span><select id="lvPerson" class="field-input field-select">${employees.map(p => `<option value="${escapeHtml(p.id)}"${p.id === s.personId ? ' selected' : ''}>${escapeHtml(p.name)}</option>`).join('')}</select></label>
            <div class="py-pair">
                <label class="py-field"><span>З</span><input id="lvFrom" class="field-input" type="date" value="${escapeHtml(s.from || '')}"></label>
                <label class="py-field"><span>По (включно)</span><input id="lvTo" class="field-input" type="date" value="${escapeHtml(s.to || '')}"></label>
            </div>
            <details class="zp-more"${s.avg ? ' open' : ''}><summary>Середньоденна вручну</summary>
                <label class="py-field"><span>Лише якщо немає заробітку за 12 місяців, грн</span><input id="lvAvg" class="field-input" inputmode="decimal" value="${escapeHtml(s.avg || '')}" placeholder="412,35"></label></details>
            <label class="py-field"><span>Примітка</span><input id="lvNote" class="field-input" maxlength="120" value="${escapeHtml(s.note || '')}" placeholder="${s.type === 'sick' ? 'листок непрацездатності № …' : 'наказ № … від …'}"></label>
        </section>
        ${s.loading ? '<p class="py-note">Рахую…</p>' : s.error ? `<p class="py-note is-bad">${escapeHtml(s.error)}</p>` : pv ? `<section class="py-card zp-preview">
            <div class="chs-tiles"><div><span>${s.type === 'sick' ? 'За рахунок ОСББ' : 'Відпускні'}</span><b>${grn(total)}</b></div><div><span>Днів</span><b>${pv.days}</b></div>
                ${s.type === 'sick' ? `<div><span>Очікується з ПФУ</span><b>${grn(fund)}</b></div>` : ''}<div><span>Середньоденна</span><b>${grn(months[0]?.avgKop || 0)}</b></div></div>
            ${months.map(m => `<div class="zp-pmonth"><span>${escapeHtml(monthTitle(m.period))}</span><span>${m.error ? escapeHtml(m.error) : escapeHtml(`${m.days} дн.${s.type === 'sick' ? ` · ${m.percent}% · ОСББ ${m.employerDays} дн.${m.fundDays ? `, ПФУ ${m.fundDays} дн.` : ''}` : ` · робочих ${m.workdays}`}`)}</span><b>${grn(m.kop || 0)}</b></div>`).join('')}
            ${problems.length ? `<ul class="zp-notes">${problems.map(t => `<li class="is-bad">${escapeHtml(t)}</li>`).join('')}</ul>` : ''}
            <p class="py-note">${s.type === 'sick' ? 'Перші 5 днів оплачує ОСББ, далі — ПФУ: подайте заяву-розрахунок, а коли кошти надійдуть, внесіть їх у табель працівника.' : 'Відпускні платять не пізніше ніж за 3 дні до відпустки — разом з авансом місяця, у якому вона починається.'}${months.length > 1 ? ' Частина наступного місяця потрапить у його відомість автоматично.' : ''}</p>
        </section>` : '<p class="py-note">Оберіть дати — система порахує середньоденну й суму.</p>'}
        <div class="chs-actions zp-sticky"><button type="button" class="sv-btn" data-act="leave-save"${pv && !s.loading && !s.error ? '' : ' disabled'}>Додати в графік</button>
            <button type="button" class="sv-btn is-soft" data-act="sheet-close">Скасувати</button></div>`];
}

function readLeave() {
    const v = id => document.getElementById(id)?.value.trim() || '';
    Object.assign(sheet, { personId: v('lvPerson'), from: v('lvFrom'), to: v('lvTo'), avg: v('lvAvg'), note: v('lvNote') });
    if (sheet.from && !sheet.to) sheet.to = sheet.from;
    const avgDailyKop = sheet.avg ? toKop(sheet.avg) : null;
    if (sheet.avg && avgDailyKop === null) throw new Error('Середньоденну вказуйте в гривнях, напр. 412,35');
    return { type: sheet.type, from: sheet.from, to: sheet.to, ...(avgDailyKop ? { avgDailyKop } : {}), note: sheet.note };
}

let previewTimer = 0;
function schedulePreview() {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(previewLeave, 350);
}
async function previewLeave() {
    if (sheet?.kind !== 'leave') return;
    let leave;
    try { leave = readLeave(); } catch (e) { sheet.error = e.message; renderSheet(); return; }
    if (!leave.from || !leave.to || !sheet.personId) { sheet.preview = null; renderSheet(); return; }
    if (leave.to < leave.from) { sheet.preview = null; sheet.error = 'Дата «по» раніше за «з»'; renderSheet(); return; }
    const mine = { ...sheet };
    Object.assign(sheet, { loading: true, error: '' });
    renderSheet();
    try {
        const pv = await payrollPeek({ action: 'leavePreview', personId: mine.personId, leave });
        if (sheet !== mine && sheet?.kind !== 'leave') return;
        Object.assign(sheet, { preview: pv, loading: false });
    } catch (e) { Object.assign(sheet, { preview: null, loading: false, error: e.message }); }
    renderSheet();
}

// ------------------------------------------------------------
// ДІЇ
// ------------------------------------------------------------
async function saveRun(btn, message = 'Відомість перераховано') {
    setBusy(btn, true, 'Рахую…');
    await payrollAct({ action: 'save', period: ctx.period, inputs: draft });
    toast(`${message}${session.role === 'chair' ? '' : ' — вона чекає затвердження голови'}`, 'success');
}

async function payStage(stage, btn) {
    const s = ctx.stages[stage];
    const t = ctx.run.totals;
    const sum = stage === 'final' && !ctx.stages.advance ? t : t[stage];
    const part = r => (stage === 'final' && !ctx.stages.advance ? r.netKop : r[stage].netKop);
    const workers = ctx.run.rows.filter(r => r.kind === 'employee' && part(r) > 0);
    // Немає кому платити через проект (лише ЦПД) — звичайні платежі по IBAN.
    const viaProject = Boolean(s?.project) || (isProject() && !s?.plan && workers.length > 0);
    if (viaProject && s?.project?.status !== 'prepared') {
        const others = ctx.run.rows.filter(r => r.kind !== 'employee' && part(r) > 0);
        const notLinked = workers.filter(r => !linked(ctx.people.find(p => p.id === r.personId) || {}));
        if (notLinked.length) { tab = 'bank'; renderPane(); throw new Error(`Спершу додайте в зарплатний проект: ${notLinked.map(r => r.name).join(', ')}`); }
        if (!s?.project && !await confirmDialog(`${STAGE[stage]}: створити відомість у Приват24?`,
            `${workers.length} працівник${workers.length === 1 ? '' : 'ів'} — ${grn(workers.reduce((n, r) => n + part(r), 0))} однією відомістю зарплатного проекту. Податки${others.length ? ' й оплата за ЦПД' : ''} — окремими платежами. Голова підписує все в Приват24 для бізнесу.`, 'Створити')) return;
        await ensurePayrollTaxes(ctx.period, ctx);
        let r;
        for (let i = 0; i < 12; i++) {
            setBusy(btn, true, r ? `Додано ${r.added} з ${r.total}…` : 'Створюю відомість у банку…');
            r = await payrollAct({ action: 'projectPrepare', period: ctx.period, stage, group: s?.project?.group || ctx.settings.projectGroup || project.data?.group || 'SALARY' });
            if (r.prepared) break;
        }
        if (!r.prepared) { toast(`Додано ${r.added} з ${r.total}. Натисніть «Продовжити», щоб додати решту`, 'info'); return; }
        delete bankStatus[`${ctx.period}:${stage}`];
        setBusy(btn, true, 'Створюю платежі податків…');
        const p = await payPayrollStage(ctx.period, stage);
        const extra = Math.max(0, p.created - r.total);
        toast(p.errors?.length ? `Відомість у банку готова; платежі: ${p.errors.join('; ')}` : `Відомість у Приват24 (${r.total} прац.)${extra ? ` і платежі податків${others.length ? ' й ЦПД' : ''} (${extra})` : ''} — на підписі голови`, p.errors?.length ? 'error' : 'success');
        tab = 'bank';
        return;
    }
    if (!s && !await confirmDialog(`${STAGE[stage] === 'Аванс' ? 'Виплатити аванс?' : 'Виплатити зарплату?'}`,
        `На руки ${grn(sum.netKop)}, ПДФО й ВЗ ${grn(sum.pdfoKop + sum.vzKop)}, ЄСВ ${grn(sum.esvKop || 0)}. Платежі підуть у Приват24 на підпис голови.`, 'Створити платежі')) return;
    setBusy(btn, true, 'Створюю платежі…');
    const r = await payPayrollStage(ctx.period, stage, ctx);
    toast(r.errors?.length ? `Створено ${r.created}; не вдалося: ${r.errors.join('; ')}` : `Платежів у Приват24: ${r.created}. Голова підписує пачку`, r.errors?.length ? 'error' : 'success');
}

async function onAction(btn) {
    const a = btn.dataset.act;
    try {
        if (a === 'sheet-close') { closeSheet(); return; }
        if (a === 'open-person') { openSheet({ kind: 'person', id: btn.dataset.id }); return; }
        if (a === 'person-new') { openSheet({ kind: 'form', id: null, newKind: btn.dataset.kind || 'employee' }); return; }
        if (a === 'person-edit') { openSheet({ kind: 'form', id: btn.dataset.id }); return; }
        if (a === 'payslip') { printPayslip(btn.dataset.id); return; }
        if (a === 'leave-new') {
            const first = ctx.people.find(p => p.kind === 'employee' && p.active !== false);
            openSheet({ kind: 'leave', type: btn.dataset.type || 'vacation', personId: btn.dataset.person || first?.id || '' });
            return;
        }
        if (a === 'leave-type') { readLeave(); sheet.type = btn.dataset.type; sheet.preview = null; renderSheet(); schedulePreview(); return; }
        if (a === 'packets-load') {
            packets = { ...packets, state: 'loading' }; renderPane();
            try { const r = await payrollPeek({ action: 'projectPackets' }); packets = { state: 'ok', list: r.list, error: '' }; }
            catch (e) { packets = { state: 'error', list: [], error: e.message }; }
            renderPane(); return;
        }
        if (a === 'project-sync') { project = { state: 'idle', data: null, error: '' }; await loadProject(); return; }
        if (a === 'packet-refresh') { setBusy(btn, true, 'Запитую банк…'); await refreshPacket(btn.dataset.stage); return; }

        if (a === 'form-save') {
            setBusy(btn, true, 'Зберігаю…');
            const person = readPerson();
            const r = await payrollAct({ action: 'person', ...person });
            const isNew = !sheet.id;
            toast(isNew ? 'Збережено. Людина зʼявиться у відомості з дати прийому' : 'Картку збережено. Відомість перерахується, коли ви її збережете', 'success');
            if (isNew && person.kind === 'employee' && isProject()) { sheet = null; await loadPayrollView(); openSheet({ kind: 'form', id: r.id }); return; }
            closeSheet();
        } else if (a === 'person-save') {
            readPersonFields(btn.dataset.id);
            await saveRun(btn);
        } else if (a === 'save') {
            await saveRun(btn, ctx.status === 'none' ? 'Відомість збережено' : 'Відомість перераховано');
        } else if (a === 'approve') {
            if (!await confirmDialog(`Затвердити відомість за ${monthTitle(ctx.period).toLowerCase()}?`,
                `Нараховано ${grn(ctx.run.totals.grossKop)}, на руки ${grn(ctx.run.totals.netKop)}, ЄСВ ${grn(ctx.run.totals.esvKop)}. Після цього бухгалтер готує виплату, а ви підписуєте її в Приват24.`, 'Затвердити')) return;
            await payrollAct({ action: 'approve', period: ctx.period });
            toast('Відомість затверджено', 'success');
        } else if (a === 'pay-advance' || a === 'pay-final') {
            await payStage(a === 'pay-advance' ? 'advance' : 'final', btn);
        } else if (a === 'leave-save') {
            const leave = readLeave();
            const person = ctx.people.find(p => p.id === sheet.personId);
            if (ctx.status === 'approved' && leave.from <= `${ctx.period}-31` && leave.to >= `${ctx.period}-01` && !locked()
                && !await confirmDialog('Перерахувати затверджену відомість?', 'Відпустка припадає на цей місяць: відомість перерахується й знову піде голові на затвердження.', 'Перерахувати')) return;
            setBusy(btn, true, 'Зберігаю…');
            const r = await payrollAct({ action: 'leave', op: 'add', personId: sheet.personId, leave, period: ctx.period });
            toast(`${LEAVE[leave.type]}: ${person?.name || ''} — у графіку${r.recalculated ? ', відомість перераховано' : r.months.length ? `, врахується у відомості за ${r.months.map(m => MONTHS[Number(m.slice(5, 7)) - 1].toLowerCase()).join(' і ')}` : ''}`, 'success');
            closeSheet();
        } else if (a === 'leave-remove') {
            const person = ctx.people.find(p => p.id === btn.dataset.person);
            const l = person?.leaves?.find(x => x.id === btn.dataset.id);
            if (!l || !await confirmDialog('Прибрати з графіка?', `${LEAVE[l.type]} ${range(l.from, l.to)} — ${person.name}. ${locked() ? '' : 'Відомість цього місяця перерахується.'}`, 'Прибрати')) return;
            await payrollAct({ action: 'leave', op: 'remove', personId: person.id, leaveId: l.id, period: ctx.period });
            toast('Прибрано з графіка', 'success');
        } else if (a === 'method') {
            if (btn.dataset.method === ctx.settings.payMethod) return;
            await payrollAct({ action: 'payMethod', payMethod: btn.dataset.method, group: project.data?.group || ctx.settings.projectGroup || null });
            toast(btn.dataset.method === 'project' ? 'Працівникам — через зарплатний проект ПриватБанку' : 'Працівникам — платежами по IBAN', 'success');
        } else if (a === 'project-add') {
            const p = ctx.people.find(x => x.id === btn.dataset.id);
            const guess = project.data?.receivers.filter(r => r.inn === p?.rnokpp) || [];
            if (guess.length === 1) {
                await payrollAct({ action: 'projectReceiver', personId: p.id, group: project.data.group, receiverId: guess[0].id });
                toast(`${p.name}: звʼязано з отримувачем таб. № ${guess[0].tabn}`, 'success');
            } else { openSheet({ kind: 'form', id: btn.dataset.id }); return; }
        } else if (a === 'project-auto') {
            const r = await payrollAct({ action: 'projectAutoLink', group: project.data.group });
            toast(r.linked ? `Звʼязано працівників: ${r.linked}` : 'Нікого не звʼязано: РНОКПП не збігаються або їх кілька', r.linked ? 'success' : 'info');
        } else if (a === 'project-link') {
            await payrollAct({ action: 'projectReceiver', personId: btn.dataset.id, group: project.data.group, receiverId: btn.dataset.receiver });
            toast('Працівника звʼязано із зарплатним проектом', 'success');
        } else if (a === 'project-unlink') {
            if (!await confirmDialog('Відвʼязати від зарплатного проекту?', 'Отримувач у банку лишиться. Наступні виплати цьому працівнику підуть по IBAN, якщо його внесено.', 'Відвʼязати')) return;
            await payrollAct({ action: 'projectReceiver', personId: btn.dataset.id, receiverId: '' });
            toast('Відвʼязано', 'success');
        } else if (a === 'project-enroll') {
            const pan = document.getElementById('pjPan')?.value.replace(/\D/g, '') || '';
            const tabn = document.getElementById('pjTabn')?.value.trim() || '';
            if (pan.length !== 16) throw new Error('Номер картки — 16 цифр');
            setBusy(btn, true, 'Додаю в банку…');
            const r = await payrollAct({ action: 'projectEnroll', personId: btn.dataset.id, group: project.data.group, pan, tabn });
            toast(`Додано в зарплатний проект: таб. № ${r.receiver.tabn}, картка ${r.receiver.pan}`, 'success');
            project = { state: 'idle', data: null, error: '' };
        } else if (a === 'packet-sandbox') {
            setBusy(btn, true, 'Тестовий банк…');
            bankStatus[`${ctx.period}:${btn.dataset.stage}`] = await payrollAct({ action: 'projectSandboxStep', period: ctx.period, stage: btn.dataset.stage });
        } else if (a === 'project-recover') {
            const stage = btn.dataset.stage;
            let ref = document.querySelector(`[data-project-ref="${stage}"]`)?.value.trim() || ctx.stages[stage].project.reference;
            if (!ref) {
                const found = await payrollPeek({ action: 'projectFind', period: ctx.period, stage });
                if (found.length !== 1) throw new Error('Не знайдено єдиної відомості. Звірте референс у Приват24; нова чернетка автоматично не створюється');
                ref = found[0].reference;
            }
            const r = await payrollAct({ action: 'projectPrepare', period: ctx.period, stage, group: ctx.stages[stage].project.group, reference: ref });
            toast(`Підготовлено ${r.added} з ${r.total}. ${r.prepared ? 'Голова підписує в Приват24' : 'Продовжіть підготовку'}`, 'success');
        } else if (a === 'recipients-refresh') {
            await ensurePayrollTaxes(ctx.period, ctx);
            const r = await payrollAct({ action: 'refreshRecipients', period: ctx.period, stage: btn.dataset.stage });
            toast(`Оновлено: ${r.changed}. Тепер продовжіть виплату`, 'success');
        } else if (a === 'repay') {
            if (!await confirmDialog('Відправити виплату знову?', 'Новий платіж на ту саму суму піде на рахунок з картки людини (чи податку) — голова підпише його в Приват24.', 'Відправити')) return;
            setBusy(btn, true, 'Створюю платіж…');
            await payrollAct({ action: 'repay', paymentId: btn.dataset.id });
            toast('Платіж створено — голова підписує його в Приват24', 'success');
        } else return;
        await loadPayrollView();
    } catch (e) { toast(e.message, 'error'); }
    finally { if (btn.isConnected) setBusy(btn, false); }
}

function onClick(e) {
    const tabBtn = e.target.closest('[data-tab]');
    if (tabBtn && tabBtn.closest('#viewPayroll')) { tab = tabBtn.dataset.tab; renderPane(); if (tabBtn.closest('.zp-next')) document.getElementById('zpPane')?.scrollIntoView({ behavior: 'smooth', block: 'start' }); return; }
    const btn = e.target.closest('[data-act]');
    if (btn?.dataset.act === 'toggle-inactive') { showInactive = btn.checked; renderPane(); return; }
    if (btn?.tagName === 'SELECT') return;
    const payRow = !btn && e.target.closest('[data-pay]');
    if (payRow) { openPaymentSheet(payRow.dataset.pay); return; }
    if (btn && !btn.disabled) onAction(btn);
}

function onChange(e) {
    const t = e.target;
    if (t.id === 'prPeriod') { period = t.value; closeSheet(); Object.keys(bankStatus).forEach(k => delete bankStatus[k]); loadPayrollView(); return; }
    if (t.dataset.act === 'project-group') { loadProject(t.value); return; }
    if (t.id === 'pfKind' && sheet?.kind === 'form') {
        try { sheet.data = { ...readPerson(), kind: t.value }; } catch { sheet.data = { ...(sheet.data || {}), kind: t.value }; }
        renderSheet(); return;
    }
    if (sheet?.kind === 'leave' && ['lvPerson', 'lvFrom', 'lvTo', 'lvAvg'].includes(t.id)) schedulePreview();
}

function onInput(e) {
    const t = e.target;
    if (t.id === 'pjPan') {
        const d = t.value.replace(/\D/g, '').slice(0, 16);
        const nice = d.replace(/(\d{4})(?=\d)/g, '$1 ');
        if (nice !== t.value) t.value = nice;
    }
    if (sheet?.kind === 'leave' && t.id === 'lvAvg') schedulePreview();
}

export function initPayrollView() {
    const host = document.getElementById('viewPayroll');
    host.addEventListener('click', onClick);
    host.addEventListener('change', onChange);
    host.addEventListener('keydown', e => {
        const row = e.target.closest?.('[data-pay]');
        if (row && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); openPaymentSheet(row.dataset.pay); }
    });
    window.addEventListener('hashchange', () => { if (location.hash !== '#payroll' && sheet) closeSheet(); });
}
