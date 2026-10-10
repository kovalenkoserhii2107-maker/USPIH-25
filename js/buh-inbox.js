// ============================================================
// «Вхідні»: усе, що потребує рішення людини, з готовою пропозицією.
//
// Система пропонує — бухгалтер підтверджує. На ПК: ↑/↓ — між
// пунктами, Enter — «Так», E — інше рішення, Esc — закрити форму.
// На телефоні — кнопка «Так» на кожній картці. Будь-яке рішення
// можна змінити вручну, а потім повернути з «Банку».
// ============================================================
import { escapeHtml, toast, confirmDialog } from './ui.js';
import {
    loadQueue, loadDirectory, loadCharges, loadExpenses, loadPayments, loadBudget, loadJournal, journalAct, loadPayroll, payrollAct, loadReports, expAct, act, signed, when, money, maskIban, skipProposal, INCOME_CATEGORIES, EXPENSE_CATEGORIES
} from './buh-data.js';
import { activeProposals, sendProposal, defaultAccount, openForm as openPaymentForm } from './buh-payments.js';
import { openCharges, runCharges } from './buh-charges.js';
import { periodName, fmtKop, toKop } from './charges-core.js';
import { session } from './firebase.js';
import { openExpenses, draftFromContract, payExpense, decideExpense, decideContract } from './buh-expenses.js';
import { openBudget, publishFinance } from './buh-budget.js';
import { openJournal } from './buh-journal.js';
import { openPayroll } from './buh-payroll.js';
import { openReports, reportTasks } from './buh-reports.js';

const CONFIDENCE = {
    'імʼя власника': ['high', 'висока'],
    'прізвище власника': ['medium', 'середня'],
    'число в призначенні': ['low', 'низька']
};

let items = [];
let focus = 0;
let editing = null;
let busy = new Set();

/** Пропозиція системи для операції з черги. */
export function proposalFor(tx) {
    const suggestions = tx.suggestions || [];
    // Списання постачальнику, схоже на затверджений документ витрат.
    if (tx.direction === 'out' && tx.expenseSuggestions?.length) return { type: 'link', ids: tx.expenseSuggestions };
    if (tx.direction === 'out') return { type: 'expense' };
    if (tx.kind === 'income') return { type: 'income' };
    if (tx.reason === 'several' && suggestions.length > 1) return { type: 'split', apts: suggestions.map(s => s.apt) };
    if (suggestions.length === 1) {
        const [level, label] = CONFIDENCE[suggestions[0].reason] || ['low', 'низька'];
        return { type: 'assign', apt: suggestions[0].apt, reason: suggestions[0].reason, level, label };
    }
    return { type: 'choose', apts: suggestions.map(s => s.apt) };
}

const ownerName = (dir, apt) => dir.find(a => a.apt === apt)?.owners?.[0]?.name || '';

let exCache = { expenses: [], contracts: [], suppliers: [] };
const expenseLabel = id => {
    const e = exCache.expenses.find(x => x.id === id);
    return e ? `${exCache.docTypes?.[e.docType] || 'Документ'} № ${e.number} від ${e.date.split('-').reverse().join('.')}, ${e.supplierName} — до сплати ${fmtKop(e.amountKop - (e.paidKop || 0))} грн` : 'документ';
};

/** Наскільки списання схоже на документ: та сама сума — висока впевненість, менша — часткова оплата. */
function linkLevel(item) {
    const ids = item.proposal.ids;
    if (ids.length > 1) return `<span class="inbox-level is-medium">ще ${ids.length - 1} схожих</span>`;
    const e = exCache.expenses.find(x => x.id === ids[0]);
    const left = e ? e.amountKop - (e.paidKop || 0) : 0;
    return left === item.tx.amountKop ? '<span class="inbox-level is-high">постачальник і сума збіглися</span>'
        : `<span class="inbox-level is-medium">часткова оплата: ${fmtKop(item.tx.amountKop)} з ${fmtKop(left)}</span>`;
}

function proposalHtml(item, dir) {
    const p = item.proposal;
    if (p.type === 'link') {
        return `<p class="inbox-proposal"><span class="inbox-arrow">→</span> Оплата за документом: <b>${escapeHtml(expenseLabel(p.ids[0]))}</b>
            ${linkLevel(item)}</p>`;
    }
    if (p.type === 'assign') {
        return `<p class="inbox-proposal"><span class="inbox-arrow">→</span> Рознести в <b>кв. ${escapeHtml(p.apt)}</b>
            ${ownerName(dir, p.apt) ? `<span class="inbox-who">${escapeHtml(ownerName(dir, p.apt))}</span>` : ''}
            <span class="inbox-level is-${p.level}" title="Впевненість: ${p.label}">${escapeHtml(p.reason)} · ${p.label}</span></p>`;
    }
    if (p.type === 'split') return `<p class="inbox-proposal"><span class="inbox-arrow">→</span> Розділити між <b>кв. ${p.apts.map(escapeHtml).join(' і ')}</b> — вкажіть суми</p>`;
    if (p.type === 'income') return '<p class="inbox-proposal is-ask">Надходження не від мешканця — оберіть вид</p>';
    if (p.type === 'expense') return '<p class="inbox-proposal is-ask">Списання — оберіть вид витрати</p>';
    return `<p class="inbox-proposal is-ask">Квартиру не розпізнано${p.apts.length ? ` — схоже на кв. ${p.apts.map(escapeHtml).join(', ')}` : ''}</p>`;
}

function formHtml(item, dir) {
    const p = item.proposal;
    if (p.type === 'link') {
        return `<div class="inbox-chips">${p.ids.map(id => `<button type="button" class="inbox-chip" data-link="${escapeHtml(id)}">${escapeHtml(expenseLabel(id))}</button>`).join('')}</div>
            <div class="inbox-cats">${Object.entries(EXPENSE_CATEGORIES).map(([k, v]) => `<button type="button" class="inbox-cat" data-cat="${k}">Не за документом: ${escapeHtml(v)}</button>`).join('')}</div>`;
    }
    if (p.type === 'income' || p.type === 'expense') {
        const cats = p.type === 'income' ? INCOME_CATEGORIES : EXPENSE_CATEGORIES;
        return `<div class="inbox-cats">${Object.entries(cats).map(([k, v]) =>
            `<button type="button" class="inbox-cat" data-cat="${k}">${escapeHtml(v)}</button>`).join('')}</div>`;
    }
    const preset = p.type === 'split' ? p.apts : [p.type === 'assign' ? p.apt : (p.apts.length === 1 ? p.apts[0] : '')];
    const split = preset.length > 1;
    const chips = (item.tx.suggestions || []).filter(s => !preset.includes(s.apt) || !split)
        .map(s => `<button type="button" class="inbox-chip" data-pick="${escapeHtml(s.apt)}">кв. ${escapeHtml(s.apt)}<small>${escapeHtml(ownerName(dir, s.apt) || s.reason)}</small></button>`).join('');
    return `${chips && p.type !== 'assign' ? `<div class="inbox-chips">${chips}</div>` : ''}
        <div class="inbox-rows">${preset.map(apt => rowHtml(apt, split)).join('')}</div>
        <div class="inbox-form-tools">
            <button type="button" class="btn-ghost-small" data-act="add-row">+ квартира</button>
            <label class="am-check inbox-remember"${split ? ' hidden' : ''}><input type="checkbox" checked><span>Запамʼятати платника</span></label>
        </div>
        <div class="inbox-form-actions">
            <button type="button" class="btn-primary btn-compact" data-act="save">Рознести</button>
            <select class="field-input field-select inbox-other" aria-label="Не від мешканця">
                <option value="">Не від мешканця…</option>
                ${Object.entries(INCOME_CATEGORIES).map(([k, v]) => `<option value="${k}">${escapeHtml(v)}</option>`).join('')}
            </select>
        </div>`;
}

const rowHtml = (apt = '', withSum = false) => `<div class="inbox-row">
    <input class="field-input inbox-apt" inputmode="numeric" maxlength="6" placeholder="Кв." value="${escapeHtml(apt)}" aria-label="Квартира">
    <input class="field-input inbox-sum" inputmode="decimal" placeholder="Сума, грн" aria-label="Сума"${withSum ? '' : ' hidden'}>
</div>`;

/** Регулярний платіж, який система пропонує відправити в банк. */
function payCardHtml(item, index) {
    const p = item.proposal.payment;
    return `<article class="inbox-card is-pay${index === focus ? ' is-focus' : ''}${busy.has(item.tx.id) ? ' is-busy' : ''}" data-id="${escapeHtml(item.tx.id)}" data-index="${index}" tabindex="-1">
        <div class="inbox-main">
            <span class="inbox-sum-big is-out">−${escapeHtml(money(p.amountKop).replace(' грн', ''))} ₴</span>
            <span class="inbox-meta">платіж · зазвичай ${p.day}-го</span>
            <p class="inbox-payer">${escapeHtml(p.recipient.name)}</p>
            <p class="inbox-purpose">${escapeHtml(p.purpose)}</p>
        </div>
        <div class="inbox-decision">
            <p class="inbox-proposal"><span class="inbox-arrow">→</span> Відправити в Приват24 на підпис голови
                <span class="inbox-level is-high">${p.months} міс. поспіль</span></p>
            <p class="inbox-purpose">${escapeHtml(maskIban(p.recipient.iban))} · ${escapeHtml(p.recipient.code)}</p>
            <div class="inbox-actions">
                <button type="button" class="btn-primary inbox-yes" data-act="yes">Так<kbd>Enter</kbd></button>
                <button type="button" class="btn-ghost-small" data-act="edit">Змінити<kbd>E</kbd></button>
                <button type="button" class="btn-ghost-small" data-act="skip">Не цього місяця</button>
            </div>
        </div>
    </article>`;
}

/** Нарахування внесків за місяць або крок налаштування, без якого його не зробити. */
function chargeCardHtml(item, index) {
    const p = item.proposal;
    const head = `<article class="inbox-card is-charge${index === focus ? ' is-focus' : ''}${busy.has(item.tx.id) ? ' is-busy' : ''}" data-id="${escapeHtml(item.tx.id)}" data-index="${index}" tabindex="-1">`;
    if (p.type === 'setup') {
        return `${head}<div class="inbox-main"><span class="inbox-meta">${escapeHtml(p.meta || 'налаштування нарахувань')}</span><p class="inbox-payer">${escapeHtml(p.title)}</p>
                <p class="inbox-purpose">${escapeHtml(p.text)}</p></div>
            <div class="inbox-decision"><div class="inbox-actions">
                <button type="button" class="btn-primary inbox-yes" data-act="yes">${escapeHtml(p.yes || 'Відкрити')}<kbd>Enter</kbd></button></div></div></article>`;
    }
    const v = p.preview;
    return `${head}<div class="inbox-main">
            <span class="inbox-sum-big">${escapeHtml(fmtKop(v.totalKop))} ₴</span>
            <span class="inbox-meta">нарахування · ${v.rows.length} прим.</span>
            <p class="inbox-payer">Внески за ${escapeHtml(periodName(v.period))}</p>
            <p class="inbox-purpose">Площа × тариф кожного приміщення${v.problems.length ? ` · без нарахування: ${v.problems.length} (${v.problems.slice(0, 4).map(x => `${escapeHtml(x.apt)} — ${escapeHtml(x.reason)}`).join(', ')}${v.problems.length > 4 ? '…' : ''})` : ''}</p>
        </div>
        <div class="inbox-decision">
            <p class="inbox-proposal"><span class="inbox-arrow">→</span> Нарахувати й записати в історію квартир${p.opening ? '; баланси перерахуються' : ''}</p>
            <div class="inbox-actions">
                <button type="button" class="btn-primary inbox-yes" data-act="yes">Так<kbd>Enter</kbd></button>
                <button type="button" class="btn-ghost-small" data-act="edit">Переглянути<kbd>E</kbd></button>
            </div>
        </div></article>`;
}

/**
 * Справи з витратами: голові — затвердити документ чи договір;
 * бухгалтеру — сплатити затверджений документ або внести акт, якого
 * бракує за щомісячним договором.
 */
function taskCardHtml(item, index) {
    const p = item.proposal;
    const e = p.expense, c = p.contract;
    const head = `<article class="inbox-card is-task${index === focus ? ' is-focus' : ''}${busy.has(item.tx.id) ? ' is-busy' : ''}" data-id="${escapeHtml(item.tx.id)}" data-index="${index}" tabindex="-1">`;
    const files = list => (list || []).map(f => `<a class="buh-file" href="${escapeHtml(f.url)}" target="_blank" rel="noopener">${escapeHtml(f.name)}</a>`).join(' ');
    const date = d => String(d || '').split('-').reverse().join('.');
    const body = {
        'approve-exp': () => [`${fmtKop(e.amountKop)} ₴`, `затвердження · ${escapeHtml(e.approval?.reason || '')}`, e.supplierName,
            `${escapeHtml(exCache.docTypes?.[e.docType] || '')} № ${escapeHtml(e.number)} від ${date(e.date)} · ${escapeHtml(e.description)} ${files(e.files) || '<span class="buh-tag is-review">без файлу</span>'}`,
            'Затвердити витрату', 'Так', 'Відхилити'],
        'approve-con': () => [`${fmtKop(c.totalKop || c.amountKop || 0)} ₴`, `договір${c.type === 'monthly' ? ` · ${fmtKop(c.monthlyKop)} на місяць` : ''}`, c.supplierName,
            `№ ${escapeHtml(c.number)} від ${date(c.date)} · ${escapeHtml(c.subject)} · ${date(c.validFrom)} — ${c.validTo ? date(c.validTo) : 'безстроково'}${c.meetingDecision ? ` · збори: ${escapeHtml(c.meetingDecision)}` : ''} ${files(c.files)}`,
            'Затвердити договір', 'Так', 'Відхилити'],
        'pay-exp': () => [`−${fmtKop(e.amountKop - (e.paidKop || 0))} ₴`, `до оплати · ${escapeHtml(e.approval?.reason || '')}`, e.supplierName,
            `${escapeHtml(exCache.docTypes?.[e.docType] || '')} № ${escapeHtml(e.number)} від ${date(e.date)} · ${escapeHtml(e.description)}`,
            'Відправити в Приват24 на підпис голови', 'Так', null],
        'missing-doc': () => [`${fmtKop(c.monthlyKop)} ₴`, 'бракує документа', c.supplierName,
            `Договір № ${escapeHtml(c.number)} · ${escapeHtml(c.subject)}: немає акта за ${escapeHtml(periodName(p.period))}`,
            'Внести акт — форму заповнено з договору', 'Внести', null]
    }[p.type]();
    const [sum, meta, who, details, action, yes, no] = body;
    return `${head}<div class="inbox-main">
            <span class="inbox-sum-big${p.type === 'pay-exp' ? ' is-out' : ''}">${sum}</span><span class="inbox-meta">${meta}</span>
            <p class="inbox-payer">${escapeHtml(who || '')}</p><p class="inbox-purpose">${details}</p></div>
        <div class="inbox-decision"><p class="inbox-proposal"><span class="inbox-arrow">→</span> ${escapeHtml(action)}</p>
            <div class="inbox-actions">
                <button type="button" class="btn-primary inbox-yes" data-act="yes">${yes}<kbd>Enter</kbd></button>
                ${no ? `<button type="button" class="btn-ghost-small" data-act="no">${no}</button>` : ''}
                <button type="button" class="btn-ghost-small" data-act="edit">Відкрити<kbd>E</kbd></button>
            </div></div></article>`;
}

function cardHtml(item, index, dir) {
    if (item.proposal.type === 'pay') return payCardHtml(item, index);
    if (['approve-exp', 'approve-con', 'pay-exp', 'missing-doc'].includes(item.proposal.type)) return taskCardHtml(item, index);
    if (item.proposal.type === 'charge' || item.proposal.type === 'setup') return chargeCardHtml(item, index);
    const tx = item.tx;
    const p = item.proposal;
    const open = editing === tx.id || !['assign', 'link'].includes(p.type);
    const quick = p.type === 'assign' || (p.type === 'link' && p.ids.length === 1);
    return `<article class="inbox-card${index === focus ? ' is-focus' : ''}${busy.has(tx.id) ? ' is-busy' : ''}" data-id="${escapeHtml(tx.id)}" data-index="${index}" tabindex="-1">
        <div class="inbox-main">
            <span class="inbox-sum-big ${tx.direction === 'out' ? 'is-out' : 'is-in'}">${signed(tx)} ₴</span>
            <span class="inbox-meta">${escapeHtml(when(tx.at))}</span>
            <p class="inbox-payer">${escapeHtml(tx.counterparty?.name || 'Платник не вказаний')}</p>
            <p class="inbox-purpose">${escapeHtml(tx.purpose || 'Без призначення')}</p>
        </div>
        <div class="inbox-decision">
            ${proposalHtml(item, dir)}
            ${quick ? `<div class="inbox-actions">
                <button type="button" class="btn-primary inbox-yes" data-act="yes">Так<kbd>Enter</kbd></button>
                <button type="button" class="btn-ghost-small" data-act="edit">Інше рішення<kbd>E</kbd></button>
            </div>` : ''}
            ${open ? `<div class="inbox-form">${formHtml(item, dir)}</div>` : ''}
        </div>
    </article>`;
}

function updateBadges() {
    for (const id of ['buhInboxBadge', 'buhInboxBadgeTab']) {
        const el = document.getElementById(id);
        if (!el) continue;
        el.textContent = items.length > 99 ? '99+' : String(items.length);
        el.hidden = !items.length;
    }
}

let dirCache = [];
function render() {
    const host = document.getElementById('viewInbox');
    updateBadges();
    if (!items.length) {
        host.innerHTML = `<div class="buh-empty"><span class="buh-empty-mark">✓</span><h2>Усе розібрано</h2>
            <p>Оплати з номером квартири чи особовим рахунком і від знайомих платників система розносить сама. Тут зʼявляється лише те, що потребує вашого рішення.</p></div>`;
        return;
    }
    focus = Math.min(focus, items.length - 1);
    const sure = items.filter(i => i.proposal.type === 'assign' && i.proposal.level === 'high');
    host.innerHTML = `<div class="inbox-head">
            <p><b>${items.length}</b> чекають рішення · пропозиція є для <b>${items.filter(i => !['choose', 'split', 'income', 'expense', 'setup'].includes(i.proposal.type)).length}</b></p>
            ${sure.length > 1 ? `<button type="button" class="btn-soft btn-compact" data-act="bulk">Підтвердити всі з високою впевненістю (${sure.length})</button>` : ''}
            <span class="inbox-keys"><kbd>↑</kbd><kbd>↓</kbd> пункти · <kbd>Enter</kbd> так · <kbd>E</kbd> змінити</span>
        </div>
        <div class="inbox-list">${items.map((item, i) => cardHtml(item, i, dirCache)).join('')}</div>`;
}

/**
 * Нарахування стоїть першим: з початку місяця це головна справа.
 * Поки немає тарифів чи вхідних залишків — пропонуємо їх внести.
 */
export function chargeItems(c) {
    if (!c) return [];
    const out = [];
    if (!c.tariffs?.length) out.push({ tx: { id: 'setup:tariffs' }, proposal: { type: 'setup', seg: 'tariffs', title: 'Внесіть тарифи внесків',
        text: 'Ставка за м² для квартир і окремо для нежитлових приміщень — з посиланням на рішення загальних зборів.' } });
    if (!c.opening?.set) out.push({ tx: { id: 'setup:opening' }, proposal: { type: 'setup', seg: 'opening', title: 'Внесіть вхідні залишки на 30.09.2026',
        text: 'Борги й переплати квартир на початок обліку. З ними баланс мешканців рахуватиме система.' } });
    const v = c.preview;
    if (v && c.due?.includes(v.period) && !v.done && v.rows.length) {
        out.push({ tx: { id: `charge:${v.period}` }, proposal: { type: 'charge', preview: v, opening: Boolean(c.opening?.set) } });
    }
    return out;
}

/**
 * Кошторис: внести, якщо його немає; з листопада — підготувати на
 * наступний рік (збори затверджують до 01 січня, п. 4.12.2 статуту);
 * оновити звіт для мешканців, коли є що показати.
 */
export function budgetItems(b) {
    if (!b) return [];
    const out = [];
    const setup = (id, extra) => out.push({ tx: { id }, proposal: { type: 'setup', meta: 'кошторис', ...extra } });
    if (!b.effective) setup(`budget:${b.year}`, { budgetYear: b.year, title: `Внесіть кошторис на ${b.year} рік`,
        text: 'Статті й суми, затверджені загальними зборами. Без нього не видно план/факт, а документи понад статтю не контролюються.' });
    const next = String(Number(b.year) + 1);
    if (Number(b.today.slice(5, 7)) >= 11 && !b.years.some(y => y.year === next)) setup(`budget:${next}`, { budgetYear: next,
        title: `Підготуйте кошторис на ${next} рік`, text: 'Загальні збори затверджують його до 01 січня (п. 4.12.2 статуту). Можна скопіювати поточний і змінити суми.' });
    if (b.publish.stale && (b.effective || b.execution.totals.factKop)) setup(`publish:${b.year}`, { publish: true, year: b.year, yes: 'Оновити',
        title: 'Оновіть «Фінанси будинку» для мешканців', text: 'Виконання кошторису, витрати з документами й загальний борг будинку — без прізвищ і номерів квартир.' });
    return out;
}

/**
 * Місяць скінчився — закрити його: Enter, якщо перевірки пройдено;
 * інакше — що заважає (відкриває «Проводки»).
 */
export function journalItems(j) {
    if (!j || j.status === 'closed') return [];
    const end = new Date(Date.UTC(Number(j.period.slice(0, 4)), Number(j.period.slice(5, 7)), 0)).toISOString().slice(0, 10);
    if (j.today <= end) return [];
    const name = new Date(`${j.period}-15`).toLocaleDateString('uk-UA', { month: 'long', year: 'numeric' }).replace(' р.', '');
    const block = j.checks.find(c => c.level === 'block');
    return [{ tx: { id: `close:${j.period}` }, proposal: { type: 'setup', meta: 'проводки', journalPeriod: j.period, closePeriod: block ? null : j.period,
        yes: block ? 'Відкрити' : 'Закрити', title: `Закрийте ${name}`,
        text: block ? `Що заважає: ${block.text}` : 'Перевірки пройдено: проводки збалансовано, виписку розібрано, внески нараховано. Після закриття операції місяця змінити не можна.' } }];
}

/**
 * Зарплата: голові — затвердити відомість; бухгалтеру — скласти її,
 * виплатити аванс (з 13-го) і остаточний розрахунок (з останнього дня
 * місяця). Виплата — платежі в Приват24 на підпис голови.
 */
export function payrollItems(p, chair) {
    if (!p || !p.activePeople) return [];
    const out = [];
    const month = p.today.slice(0, 7), day = Number(p.today.slice(8, 10));
    const name = per => new Date(`${per}-15`).toLocaleDateString('uk-UA', { month: 'long', year: 'numeric' }).replace(' р.', '');
    const lastDay = per => new Date(Date.UTC(Number(per.slice(0, 4)), Number(per.slice(5, 7)), 0)).getUTCDate();
    const setup = (id, extra) => out.push({ tx: { id }, proposal: { type: 'setup', meta: 'зарплата', ...extra } });
    for (const r of p.runs) {
        if (r.status === 'draft' && chair) {
            setup(`payroll-approve:${r.period}`, { payrollPeriod: r.period, payrollAction: 'approve', yes: 'Затвердити',
                title: `Затвердіть відомість зарплати за ${name(r.period)}`, text: 'Бухгалтер склав відомість: нарахування, утримання ПДФО й військового збору, ЄСВ. Після затвердження — платежі на ваш підпис у Приват24.' });
        }
        if (r.status !== 'approved' || r.final) continue;
        if (r.period === month && !r.advance && day >= 13) {
            setup(`payroll-advance:${r.period}`, { payrollPeriod: r.period, payrollAction: 'advance', yes: 'Створити платежі',
                title: `Виплатіть аванс за ${name(r.period)}`, text: 'Зарплату платять двічі на місяць (ст. 115 КЗпП). ПДФО й військовий збір з авансу — у той самий день.' });
        }
        if (r.period < month || (r.period === month && day >= lastDay(month))) {
            setup(`payroll-final:${r.period}`, { payrollPeriod: r.period, payrollAction: 'final', yes: 'Створити платежі',
                title: `Виплатіть зарплату за ${name(r.period)}`, text: 'Решта на руки, ПДФО й військовий збір, ЄСВ (до 20 числа). Якщо табель змінився — спершу виправте відомість.' });
        }
    }
    if (!p.runs.some(r => r.period === month) && day >= 10) {
        setup(`payroll-new:${month}`, { payrollPeriod: month, yes: 'Відкрити', title: `Складіть відомість зарплати за ${name(month)}`,
            text: 'Табель і акти ЦПД — система порахує утримання й ЄСВ; голова затвердить.' });
    }
    return out;
}

/**
 * Звітність: звіт, строк якого за 10 днів чи минув, і не позначений;
 * ЄСВ — за 3 дні, якщо платежі ще не проведено; кошторис — за місяць.
 */
export function reportItems(r) {
    const near = t => (t.kind === 'decision' ? 30 : t.kind === 'payment' ? 3 : 10);
    return reportTasks(r).filter(t => !t.done && t.left <= near(t)).map(t => ({ tx: { id: `report:${t.key}` }, proposal: {
        type: 'setup', meta: 'звітність', reportKey: t.key, yes: 'Відкрити',
        title: t.left < 0 ? `Прострочено: ${t.title.charAt(0).toLowerCase()}${t.title.slice(1)}` : t.title,
        text: `${t.detail}. Строк — ${t.date.getUTCDate()}.${String(t.date.getUTCMonth() + 1).padStart(2, '0')}${t.left >= 0 ? ` (${t.left === 0 ? 'сьогодні' : `через ${t.left} дн.`})` : ''}. ${t.kind === 'report' ? 'Цифри готові в «Звітності»; подає голова в Електронному кабінеті, потім позначте «подано» й додайте квитанцію.' : ''}`.trim()
    } }));
}

/** Справи з витратами для «Вхідних» (голова бачить і затвердження). */
export function expenseItems(ex, payments, chair) {
    if (!ex) return [];
    const out = [];
    const onTheWay = new Set(payments.filter(p => ['sending', 'unknown', 'sent'].includes(p.status) && p.expenseId).map(p => p.expenseId));
    if (chair) {
        ex.contracts.filter(c => c.status === 'pending').forEach(c => out.push({ tx: { id: `con:${c.id}` }, proposal: { type: 'approve-con', contract: c } }));
        ex.expenses.filter(e => e.status === 'pending').forEach(e => out.push({ tx: { id: `exp:${e.id}` }, proposal: { type: 'approve-exp', expense: e } }));
    }
    ex.expenses.filter(e => e.status === 'approved' && e.amountKop > (e.paidKop || 0) && !onTheWay.has(e.id))
        .forEach(e => out.push({ tx: { id: `payexp:${e.id}` }, proposal: { type: 'pay-exp', expense: e } }));
    (ex.missing || []).forEach(m => {
        const c = ex.contracts.find(x => x.id === m.contractId);
        if (c) out.push({ tx: { id: `miss:${c.id}:${m.period}` }, proposal: { type: 'missing-doc', contract: c, period: m.period } });
    });
    return out;
}

let payAccount = '';
export async function loadInbox() {
    const thisYear = String(new Date().getFullYear());
    const [queue, dir, pays, charges, ex, payments, budget, journal, payroll, reports] = await Promise.all([loadQueue(), loadDirectory(),
        activeProposals().catch(() => ({ list: [], context: { accounts: [] } })), loadCharges().catch(() => null),
        loadExpenses().catch(() => null), loadPayments().catch(() => []), loadBudget(thisYear).catch(() => null), loadJournal(null).catch(() => null), loadPayroll(null).catch(() => null),
        loadReports().catch(() => null)]);
    dirCache = dir;
    exCache = ex || exCache;
    payAccount = defaultAccount(pays.context.accounts || []);
    // Кому платимо за документами (щомісячний договір) — тому регулярний платіж «за історією» не пропонуємо.
    const byDocs = new Set((ex?.contracts || []).filter(c => c.status === 'approved' && c.type === 'monthly')
        .map(c => ex.suppliers.find(s => s.id === c.supplierId)?.iban).filter(Boolean));
    items = chargeItems(charges)
        .concat(budgetItems(budget))
        .concat(journalItems(journal))
        .concat(payrollItems(payroll, session.role === 'chair'))
        .concat(reportItems(reports))
        .concat(expenseItems(ex, payments, session.role === 'chair'))
        .concat(queue.map(tx => ({ tx, proposal: proposalFor(tx) })))
        .concat(payAccount ? pays.list.filter(p => !byDocs.has(p.recipient.iban)).map(p => ({ tx: { id: `pay:${p.proposalKey}` }, proposal: { type: 'pay', payment: p } })) : []);
    const reportBadge = document.getElementById('buhReportBadge');
    if (reportBadge) {
        const urgent = reportTasks(reports).filter(t => !t.done && t.kind === 'report' && t.left <= 10).length;
        reportBadge.hidden = !urgent;
        reportBadge.textContent = urgent || '';
    }
    render();
    return items.length;
}

// ------------------------------------------------------------
// ДІЇ
// ------------------------------------------------------------
async function run(item, payload, done) {
    busy.add(item.tx.id);
    render();
    try {
        await act({ txId: item.tx.id, ...payload });
        editing = null;
        if (done) toast(done, 'success');
    } catch (e) {
        toast(e.message, 'error');
    } finally {
        busy.delete(item.tx.id);
        await loadInbox().catch(() => render());
        document.querySelector('.inbox-card.is-focus')?.focus({ preventScroll: true });
    }
}

async function runPay(item) {
    busy.add(item.tx.id);
    render();
    try { await sendProposal(item.proposal.payment, payAccount); }
    catch (e) { toast(e.message, 'error'); }
    finally { busy.delete(item.tx.id); await loadInbox().catch(() => render()); }
}

async function runCharge(item) {
    busy.add(item.tx.id);
    render();
    try { await runCharges(item.proposal.preview.period, item.proposal.preview.totalKop); }
    catch (e) { toast(e.message, 'error'); }
    finally { busy.delete(item.tx.id); await loadInbox().catch(() => render()); }
}

/** Дія з витратами з картки «Вхідних»: показуємо зайнятість і перечитуємо список. */
async function runTask(item, fn) {
    busy.add(item.tx.id);
    render();
    try { await fn(); }
    catch (e) { toast(e.message, 'error'); }
    finally { busy.delete(item.tx.id); await loadInbox().catch(() => render()); }
}

function confirmTask(item, yes) {
    const p = item.proposal;
    if (p.type === 'approve-exp') return runTask(item, () => decideExpense(p.expense, yes));
    if (p.type === 'approve-con') return runTask(item, () => decideContract(p.contract, yes));
    if (p.type === 'pay-exp') return runTask(item, () => payExpense(p.expense));
    if (p.type === 'missing-doc') return openExpenses('docs', draftFromContract(p.contract, p.period));
}

const linkTx = (item, expenseId) => runTask(item, async () => {
    await expAct({ action: 'linkTx', txId: item.tx.id, expenseId });
    toast('Списання привʼязано до документа', 'success');
});

const confirmProposal = item => {
    if (item.proposal.type === 'pay') { runPay(item); return; }
    if (['approve-exp', 'approve-con', 'pay-exp', 'missing-doc'].includes(item.proposal.type)) { confirmTask(item, true); return; }
    if (item.proposal.type === 'link' && item.proposal.ids.length === 1) { linkTx(item, item.proposal.ids[0]); return; }
    if (item.proposal.type === 'charge') { runCharge(item); return; }
    if (item.proposal.type === 'setup' && item.proposal.publish) { runTask(item, () => publishFinance(item.proposal.year)); return; }
    if (item.proposal.type === 'setup' && item.proposal.budgetYear) { openBudget(item.proposal.budgetYear); return; }
    if (item.proposal.type === 'setup' && item.proposal.payrollAction) {
        const { payrollPeriod: period, payrollAction: what } = item.proposal;
        runTask(item, async () => {
            if (what === 'approve') { await payrollAct({ action: 'approve', period }); toast('Відомість затверджено', 'success'); return; }
            const r = await payrollAct({ action: 'pay', period, stage: what });
            toast(`Платежів у Приват24: ${r.created}. Голова підписує пачку`, 'success');
        });
        return;
    }
    if (item.proposal.type === 'setup' && item.proposal.payrollPeriod) { openPayroll(item.proposal.payrollPeriod); return; }
    if (item.proposal.type === 'setup' && item.proposal.reportKey) { openReports(item.proposal.reportKey); return; }
    if (item.proposal.type === 'setup' && item.proposal.closePeriod) {
        runTask(item, async () => { await journalAct({ action: 'close', period: item.proposal.closePeriod }); toast('Місяць закрито', 'success'); });
        return;
    }
    if (item.proposal.type === 'setup' && item.proposal.journalPeriod) { openJournal(item.proposal.journalPeriod); return; }
    if (item.proposal.type === 'setup') { openCharges(item.proposal.seg); return; }
    const p = item.proposal;
    if (p.type !== 'assign') { openForm(item); return; }
    run(item, { action: 'assign', allocations: [{ apt: p.apt, amountKop: item.tx.amountKop }], remember: true }, `Рознесено: кв. ${p.apt}`);
};

function openForm(item) {
    if (item.proposal.type === 'charge' || item.proposal.type === 'setup') { openCharges(item.proposal.seg || 'month'); return; }
    if (item.proposal.type === 'missing-doc') { confirmTask(item); return; }
    if (item.proposal.type === 'approve-con') { openExpenses('contracts'); return; }
    if (['approve-exp', 'pay-exp'].includes(item.proposal.type)) { openExpenses('docs'); return; }
    if (item.proposal.type === 'pay') {
        // Змінити суму чи призначення — у формі «Платежів».
        location.hash = 'payments';
        openPaymentForm(item.proposal.payment);
        return;
    }
    editing = item.tx.id;
    render();
    const card = document.querySelector(`.inbox-card[data-id="${CSS.escape(item.tx.id)}"]`);
    (card?.querySelector('.inbox-apt:placeholder-shown, .inbox-apt') || card?.querySelector('.inbox-cat'))?.focus();
}

function saveForm(card, item) {
    const rows = [...card.querySelectorAll('.inbox-row')];
    const split = rows.length > 1;
    const allocations = rows.map(row => ({
        apt: row.querySelector('.inbox-apt').value.trim().toLowerCase(),
        amountKop: split ? toKop(row.querySelector('.inbox-sum').value) : item.tx.amountKop
    })).filter(a => a.apt);
    if (!allocations.length) { toast('Вкажіть квартиру', 'error'); return; }
    const remember = !split && card.querySelector('.inbox-remember input')?.checked === true;
    run(item, { action: 'assign', allocations, remember }, `Рознесено: кв. ${allocations.map(a => a.apt).join(', ')}`);
}

function setFocus(index) {
    focus = Math.max(0, Math.min(items.length - 1, index));
    document.querySelectorAll('.inbox-card').forEach(c => c.classList.toggle('is-focus', Number(c.dataset.index) === focus));
    const card = document.querySelector('.inbox-card.is-focus');
    card?.focus({ preventScroll: true });
    card?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

async function bulk() {
    const sure = items.filter(i => i.proposal.type === 'assign' && i.proposal.level === 'high');
    if (!await confirmDialog(`Рознести ${sure.length} оплат?`, 'Кожну — у квартиру, власника якої система впізнала за повним імʼям. Будь-яку можна повернути з «Банку».', 'Так, рознести')) return;
    let ok = 0;
    for (const item of sure) {
        try {
            await act({ action: 'assign', txId: item.tx.id, allocations: [{ apt: item.proposal.apt, amountKop: item.tx.amountKop }], remember: true });
            ok += 1;
        } catch (e) { toast(`${item.tx.counterparty?.name || ''}: ${e.message}`, 'error'); }
    }
    toast(`Рознесено: ${ok}`, 'success');
    await loadInbox();
}

export function initInbox(isActive) {
    const host = document.getElementById('viewInbox');
    host.addEventListener('click', e => {
        if (e.target.closest('[data-act="bulk"]')) { bulk(); return; }
        const card = e.target.closest('.inbox-card');
        if (!card) return;
        const item = items[Number(card.dataset.index)];
        if (!item || busy.has(item.tx.id)) return;
        if (Number(card.dataset.index) !== focus) setFocus(Number(card.dataset.index));
        const act = e.target.closest('[data-act]')?.dataset.act;
        const cat = e.target.closest('[data-cat]')?.dataset.cat;
        const pick = e.target.closest('[data-pick]')?.dataset.pick;
        if (act === 'skip' && item.proposal.type === 'pay') { skipProposal(item.proposal.payment.proposalKey); return; }
        if (act === 'no') { confirmTask(item, false); return; }
        const link = e.target.closest('[data-link]')?.dataset.link;
        if (link) { linkTx(item, link); return; }
        if (act === 'yes') confirmProposal(item);
        else if (act === 'edit') openForm(item);
        else if (act === 'save') saveForm(card, item);
        else if (act === 'add-row') {
            const rows = card.querySelector('.inbox-rows');
            rows.insertAdjacentHTML('beforeend', rowHtml('', true));
            rows.querySelectorAll('.inbox-sum').forEach(i => { i.hidden = false; });
            card.querySelector('.inbox-remember')?.setAttribute('hidden', '');
            rows.lastElementChild.querySelector('.inbox-apt').focus();
        } else if (pick) {
            const input = [...card.querySelectorAll('.inbox-apt')].find(i => !i.value) || card.querySelector('.inbox-apt');
            if (input) { input.value = pick; input.focus(); }
        } else if (cat) {
            const kind = item.tx.direction === 'out' ? 'expense' : 'income';
            const label = (kind === 'income' ? INCOME_CATEGORIES : EXPENSE_CATEGORIES)[cat];
            run(item, { action: 'classify', kind, category: cat }, label);
        }
    });

    host.addEventListener('change', e => {
        const select = e.target.closest('.inbox-other');
        const card = select?.closest('.inbox-card');
        const item = card && items[Number(card.dataset.index)];
        if (!item || !select.value) return;
        run(item, { action: 'classify', kind: 'income', category: select.value }, INCOME_CATEGORIES[select.value]);
    });

    document.addEventListener('keydown', e => {
        if (!isActive() || !items.length || document.querySelector('.confirm-overlay')) return;
        const typing = e.target.matches('input, textarea, select');
        const card = e.target.closest?.('.inbox-card') || document.querySelector('.inbox-card.is-focus');
        const item = items[focus];
        if (typing) {
            if (e.key === 'Enter' && card && e.target.matches('.inbox-apt, .inbox-sum')) { e.preventDefault(); saveForm(card, items[Number(card.dataset.index)]); }
            if (e.key === 'Escape') { editing = null; render(); setFocus(focus); }
            return;
        }
        if (e.metaKey || e.ctrlKey || e.altKey) return;
        if (e.key === 'ArrowDown' || e.key === 'j') { e.preventDefault(); setFocus(focus + 1); }
        else if (e.key === 'ArrowUp' || e.key === 'k') { e.preventDefault(); setFocus(focus - 1); }
        else if (e.key === 'Enter' && item && !e.target.closest('button, a')) { e.preventDefault(); confirmProposal(item); }
        else if ((e.key === 'e' || e.key === 'у') && item) { e.preventDefault(); openForm(item); }
        else if (e.key === 'Escape' && editing) { editing = null; render(); setFocus(focus); }
    });
}
