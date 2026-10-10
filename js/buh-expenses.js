// ============================================================
// «Витрати»: рахунки й акти постачальників, договори, постачальники.
//
// Бухгалтер вносить документ з файлом → система визначає, хто
// затверджує (за договором — бухгалтер, без договору чи понад нього —
// голова) → затверджений документ одним «Сплатити» йде в Приват24 на
// підпис голови → виписка сама позначає його оплаченим.
// Усі записи — через сервер (expenseAction).
// ============================================================
import { session } from './firebase.js';
import { escapeHtml, toast, setBusy, confirmDialog, promptDialog } from './ui.js';
import {
    loadExpenses, expAct, uploadExpenseFiles, loadPaymentContext, EXPENSE_STATUS, CONTRACT_STATUS, maskIban
} from './buh-data.js';
import { defaultAccount } from './buh-payments.js';
import { periodName, fmtKop, toKop } from './charges-core.js';

const SEGMENTS = { docs: 'Документи', contracts: 'Договори', suppliers: 'Постачальники' };
const FILTERS = { all: 'Усі', pending: 'Чекають голову', approved: 'До оплати', paid: 'Оплачені' };
let segment = 'docs';
let filter = 'all';
let ctx = null;
let form = null;          // { kind: 'doc'|'contract'|'supplier', data }
let files = [];           // нові файли форми, ще не завантажені

const isChair = () => session.role === 'chair';
const human = d => (d ? String(d).split('-').reverse().join('.') : '');
const tag = (map, s) => { const [t, c] = map[s] || [s, '']; return `<span class="buh-tag ${c}">${escapeHtml(t)}</span>`; };
const contractOf = id => ctx.contracts.find(c => c.id === id);
const remaining = e => e.amountKop - (e.stornoKop || 0) - (e.paidKop || 0);
const LIVE = ['pending', 'approved', 'paid'];
let attaching = null;     // документ, який привʼязують до основного
let stornoing = null;     // документ, який сторнують
/** Основні документи постачальника, до яких можна привʼязати doc. */
const mainsFor = doc => ctx.expenses.filter(x => x.id !== doc.id && x.supplierId === doc.supplierId && LIVE.includes(x.status) && !x.linkedTo && x.amountKop > 0 && x.amountKop >= (doc.amountKop || 0));
const docName = x => `${ctx.docTypes[x.docType] || 'Документ'} № ${x.number} від ${human(x.date)}`;
const docsWord = n => (n % 10 === 1 && n % 100 !== 11 ? 'документ' : [2, 3, 4].includes(n % 10) && ![12, 13, 14].includes(n % 100) ? 'документи' : 'документів');
const val = id => document.getElementById(id)?.value?.trim() ?? '';
const filesHtml = list => (list || []).map(f => `<a class="buh-file" href="${escapeHtml(f.url)}" target="_blank" rel="noopener">${escapeHtml(f.name)}</a>`).join(' ');

/** Відкрити розділ на потрібній вкладці, за потреби — з готовою формою. */
export function openExpenses(seg = 'docs', prefill = null) {
    segment = SEGMENTS[seg] ? seg : 'docs';
    form = prefill;
    files = [];
    if (location.hash !== '#expenses') location.hash = 'expenses';
    else loadExpensesView();
}

/** Чернетка акта за щомісячним договором — для нагадування «бракує акта». */
export function draftFromContract(c, period) {
    return { kind: 'doc', data: { supplierId: c.supplierId, contractId: c.id, docType: 'act', amountKop: c.monthlyKop, period,
        item: c.item, description: `${c.subject} за ${periodName(period)}` } };
}

// ------------------------------------------------------------
// ФОРМИ
// ------------------------------------------------------------
const options = (map, selected) => Object.entries(map).map(([k, v]) => `<option value="${escapeHtml(k)}"${k === selected ? ' selected' : ''}>${escapeHtml(v)}</option>`).join('');
const money2 = k => (k ? (k / 100).toFixed(2).replace('.', ',') : '');

function docFormHtml(d = {}) {
    const supplierId = d.supplierId || '';
    const contracts = ctx.contracts.filter(c => c.supplierId === supplierId && c.status !== 'rejected');
    return `<section class="buh-card ex-form" id="exForm">
        <div class="buh-card-head"><h2>${d.id ? 'Змінити документ' : 'Новий документ'}</h2><button type="button" class="btn-ghost-small" data-act="close">Закрити</button></div>
        <div class="pay-grid">
            <label class="field pay-wide"><span class="field-label">Постачальник</span>
                <select id="dfSupplier" class="field-input field-select"><option value="">Оберіть…</option>${ctx.suppliers.map(s =>
                    `<option value="${escapeHtml(s.id)}"${s.id === supplierId ? ' selected' : ''}>${escapeHtml(s.name)} · ${escapeHtml(s.code)}</option>`).join('')}<option value="__new">+ Новий постачальник…</option></select></label>
            <label class="field pay-wide"><span class="field-label">Договір</span>
                <select id="dfContract" class="field-input field-select"><option value="">Без договору</option>${contracts.map(c =>
                    `<option value="${escapeHtml(c.id)}"${c.id === d.contractId ? ' selected' : ''}>№ ${escapeHtml(c.number)} від ${human(c.date)} — ${escapeHtml(c.subject)}${c.status === 'pending' ? ' (не затверджено)' : ''}</option>`).join('')}</select></label>
            <label class="field"><span class="field-label">Вид документа</span><select id="dfType" class="field-input field-select">${options(ctx.docTypes, d.docType || 'invoice')}</select></label>
            <label class="field"><span class="field-label">Номер</span><input id="dfNumber" class="field-input" maxlength="60" value="${escapeHtml(d.number || '')}"></label>
            <label class="field"><span class="field-label">Дата</span><input id="dfDate" class="field-input" type="date" value="${escapeHtml(d.date || ctx.today)}"></label>
            <label class="field"><span class="field-label">За місяць</span><input id="dfPeriod" class="field-input" type="month" value="${escapeHtml(d.period || ctx.today.slice(0, 7))}"></label>
            <label class="field"><span class="field-label">Сума, грн</span><input id="dfAmount" class="field-input" inputmode="decimal" placeholder="0,00" value="${money2(d.amountKop)}"></label>
            <label class="field"><span class="field-label">У т.ч. ПДВ, грн</span><input id="dfVat" class="field-input" inputmode="decimal" placeholder="без ПДВ" value="${money2(d.vatKop)}"></label>
            <label class="field pay-wide"><span class="field-label">Стаття витрат</span><select id="dfItem" class="field-input field-select">${options(ctx.items, d.item || 'other')}</select></label>
            <label class="field pay-wide"><span class="field-label">За що</span><input id="dfDesc" class="field-input" maxlength="300" placeholder="Послуга чи товар, період" value="${escapeHtml(d.description || '')}"></label>
            ${!d.id && supplierId ? `<label class="field pay-wide"><span class="field-label">Підтверджує документ тієї самої послуги</span>
                <select id="dfLinked" class="field-input field-select"><option value="">Ні — це окрема витрата</option>${mainsFor({ supplierId, amountKop: 0 }).map(x =>
                    `<option value="${escapeHtml(x.id)}"${x.id === d.linkedTo ? ' selected' : ''}>${escapeHtml(docName(x))} · ${fmtKop(x.amountKop)} грн</option>`).join('')}</select></label>` : ''}
            <label class="field pay-wide"><span class="field-label">Скан або PDF документа</span><input id="dfFiles" class="field-input" type="file" multiple accept=".pdf,image/*,.doc,.docx,.xls,.xlsx"></label>
        </div>
        ${d.files?.length ? `<p class="buh-note">Уже додано: ${filesHtml(d.files)}</p>` : ''}
        <p class="buh-note" id="dfHint">Документ за затвердженим договором у межах його суми затверджуєте ви. Без договору чи понад нього — голова: йому прийде сповіщення.</p>
        <div class="pay-form-actions"><button type="button" class="btn-primary" data-act="save-doc">${d.id ? 'Зберегти' : 'Внести документ'}</button></div>
    </section>`;
}

function contractFormHtml(c = {}) {
    const monthly = (c.type || 'monthly') === 'monthly';
    return `<section class="buh-card ex-form" id="exForm">
        <div class="buh-card-head"><h2>${c.id ? 'Змінити договір' : 'Новий договір'}</h2><button type="button" class="btn-ghost-small" data-act="close">Закрити</button></div>
        <div class="pay-grid">
            <label class="field pay-wide"><span class="field-label">Постачальник</span>
                <select id="cfSupplier" class="field-input field-select"><option value="">Оберіть…</option>${ctx.suppliers.map(s =>
                    `<option value="${escapeHtml(s.id)}"${s.id === c.supplierId ? ' selected' : ''}>${escapeHtml(s.name)} · ${escapeHtml(s.code)}</option>`).join('')}<option value="__new">+ Новий постачальник…</option></select></label>
            <label class="field"><span class="field-label">Номер</span><input id="cfNumber" class="field-input" maxlength="60" value="${escapeHtml(c.number || '')}"></label>
            <label class="field"><span class="field-label">Дата</span><input id="cfDate" class="field-input" type="date" value="${escapeHtml(c.date || ctx.today)}"></label>
            <label class="field pay-wide"><span class="field-label">Предмет договору</span><input id="cfSubject" class="field-input" maxlength="300" value="${escapeHtml(c.subject || '')}" placeholder="Технічне обслуговування ліфтів"></label>
            <label class="field"><span class="field-label">Вид</span><select id="cfType" class="field-input field-select">${options({ monthly: 'Щомісячний', fixed: 'Разовий' }, c.type || 'monthly')}</select></label>
            <label class="field"><span class="field-label" id="cfAmountLabel">${monthly ? 'Сума на місяць, грн' : 'Сума договору, грн'}</span><input id="cfAmount" class="field-input" inputmode="decimal" value="${money2(monthly ? c.monthlyKop : c.amountKop)}"></label>
            <label class="field"><span class="field-label">Діє з</span><input id="cfFrom" class="field-input" type="date" value="${escapeHtml(c.validFrom || ctx.today)}"></label>
            <label class="field"><span class="field-label">Діє по (порожньо — безстроковий)</span><input id="cfTo" class="field-input" type="date" value="${escapeHtml(c.validTo || '')}"></label>
            <label class="field pay-wide"><span class="field-label">Стаття витрат</span><select id="cfItem" class="field-input field-select">${options(ctx.items, c.item || 'other')}</select></label>
            <label class="field pay-wide"><span class="field-label">Погодження правління (протокол, дата)</span><input id="cfBoard" class="field-input" maxlength="200" value="${escapeHtml(c.boardDecision || '')}"></label>
            <label class="field pay-wide"><span class="field-label">Рішення загальних зборів — обовʼязково понад 50 000 грн</span><input id="cfMeeting" class="field-input" maxlength="200" value="${escapeHtml(c.meetingDecision || '')}"></label>
            <label class="field pay-wide"><span class="field-label">Скан договору</span><input id="cfFiles" class="field-input" type="file" multiple accept=".pdf,image/*,.doc,.docx"></label>
        </div>
        <p class="buh-note" id="cfHint"></p>
        <div class="pay-form-actions"><button type="button" class="btn-primary" data-act="save-contract">${isChair() ? 'Зберегти й затвердити' : 'Подати голові на затвердження'}</button></div>
    </section>`;
}

function supplierFormHtml(s = {}) {
    return `<section class="buh-card ex-form" id="exForm">
        <div class="buh-card-head"><h2>${s.id ? 'Змінити постачальника' : 'Новий постачальник'}</h2><button type="button" class="btn-ghost-small" data-act="close">Закрити</button></div>
        <div class="pay-grid">
            <label class="field pay-wide"><span class="field-label">Назва</span><input id="sfName" class="field-input" maxlength="200" value="${escapeHtml(s.name || '')}" placeholder="ТОВ «Ліфт-Сервіс» або ФОП Іваненко І. І."></label>
            <label class="field"><span class="field-label">Хто це</span><select id="sfKind" class="field-input field-select">${options(ctx.kinds, s.kind || 'company')}</select></label>
            <label class="field"><span class="field-label">ЄДРПОУ або РНОКПП</span><input id="sfCode" class="field-input" inputmode="numeric" maxlength="10" value="${escapeHtml(s.code || '')}"></label>
            <label class="field pay-wide"><span class="field-label">IBAN для оплати</span><input id="sfIban" class="field-input" maxlength="34" value="${escapeHtml(s.iban || '')}" placeholder="UA…"></label>
            <label class="am-check pay-wide" id="sfFopRow"${(s.kind || 'company') === 'fop' ? '' : ' hidden'}><input type="checkbox" id="sfFop"${s.fopChecked ? ' checked' : ''}><span>Витяг з ЄДР і КВЕД перевірено: послуга відповідає видам діяльності ФОП</span></label>
            <label class="field pay-wide"><span class="field-label">Примітка</span><input id="sfNote" class="field-input" maxlength="300" value="${escapeHtml(s.note || '')}"></label>
        </div>
        <div class="pay-form-actions"><button type="button" class="btn-primary" data-act="save-supplier">Зберегти</button></div>
    </section>`;
}

function formHtml() {
    if (!form) return '';
    return form.kind === 'doc' ? docFormHtml(form.data) : form.kind === 'contract' ? contractFormHtml(form.data) : supplierFormHtml(form.data);
}

// ------------------------------------------------------------
// СПИСКИ
// ------------------------------------------------------------
function docActions(e) {
    const out = [];
    if (e.status === 'pending' && isChair()) out.push('<button type="button" class="btn-soft btn-compact" data-act="approve-doc">Затвердити</button>', '<button type="button" class="btn-ghost-small" data-act="reject-doc">Відхилити</button>');
    if (e.status === 'approved' && remaining(e) > 0) out.push('<button type="button" class="btn-soft btn-compact" data-act="pay-doc">Сплатити</button>');
    if (['pending', 'rejected'].includes(e.status)) out.push('<button type="button" class="btn-ghost-small" data-act="edit-doc">Змінити</button>');
    if (['pending', 'approved', 'rejected'].includes(e.status) && !(e.paidKop > 0) && !e.linkedIds?.length && !e.stornoIds?.length && mainsFor(e).length) {
        out.push('<button type="button" class="btn-ghost-small" data-act="attach-doc" title="Рахунок і акт однієї послуги — одна витрата">Це та сама послуга…</button>');
    }
    if (['approved', 'paid'].includes(e.status) && e.amountKop > 0 && e.amountKop > (e.stornoKop || 0)) out.push('<button type="button" class="btn-ghost-small" data-act="storno-doc">Сторно</button>');
    if (['pending', 'approved', 'rejected', 'linked'].includes(e.status) && !(e.paidKop > 0) && !e.stornoIds?.length) out.push('<button type="button" class="btn-ghost-small" data-act="cancel-doc">Скасувати</button>');
    return out.join('');
}

/** Звʼязки документа: підтвердні документи, основний, сторно. */
function relationsHtml(e) {
    const byId = id => ctx.expenses.find(x => x.id === id);
    const parts = [];
    if (e.linkedTo) { const m = byId(e.linkedTo); parts.push(`Підтверджує ${m ? escapeHtml(docName(m)) : 'основний документ'} — окремої витрати й боргу немає`); }
    const linked = (e.linkedIds || []).map(byId).filter(x => x && x.status === 'linked');
    if (linked.length) parts.push(`Підтвердні документи: ${linked.map(x => escapeHtml(docName(x))).join(', ')}`);
    if (e.stornoOf) { const o = byId(e.stornoOf); parts.push(`Коригує ${o ? escapeHtml(docName(o)) : 'документ'}`); }
    if (e.stornoKop) parts.push(`Сторно −${fmtKop(e.stornoKop)} грн: до сплати ${fmtKop(e.amountKop - e.stornoKop)} грн`);
    if (e.refundTxIds?.length) parts.push('Банк повернув оплату — документ знову до сплати');
    return parts.length ? `<span class="ex-rel">${parts.join(' · ')}</span>` : '';
}

function attachHtml(e) {
    const list = mainsFor(e);
    return `<div class="ex-inline" id="exAttach">
        <label class="field"><span class="field-label">Основний документ тієї самої послуги</span><select id="atMain" class="field-input field-select">${list.map(x =>
            `<option value="${escapeHtml(x.id)}">${escapeHtml(docName(x))} · ${fmtKop(x.amountKop)} грн · ${escapeHtml(EXPENSE_STATUS[x.status]?.[0] || x.status)}</option>`).join('')}</select></label>
        <p class="buh-note">${escapeHtml(docName(e))} стане підтвердним: витрата й борг лишаться лише за основним документом.</p>
        <div class="pay-form-actions"><button type="button" class="btn-primary btn-compact" data-act="attach-save">Привʼязати</button><button type="button" class="btn-ghost-small" data-act="inline-close">Скасувати</button></div>
    </div>`;
}

function stornoHtml(e) {
    const left = e.amountKop - (e.stornoKop || 0);
    return `<div class="ex-inline" id="exStorno">
        <div class="pay-grid">
            <label class="field"><span class="field-label">Сума сторно, грн (до ${fmtKop(left)})</span><input id="stAmount" class="field-input" inputmode="decimal" value="${money2(left)}"></label>
            <label class="field"><span class="field-label">Дата коригування</span><input id="stDate" class="field-input" type="date" value="${escapeHtml(ctx.today)}" max="${escapeHtml(ctx.today)}"></label>
            <label class="field"><span class="field-label">№ акта коригування / накладної на повернення</span><input id="stNumber" class="field-input" maxlength="60"></label>
            <label class="field pay-wide"><span class="field-label">Причина</span><input id="stReason" class="field-input" maxlength="300" placeholder="Напр.: перерахунок за неякісну послугу, повернення товару"></label>
            <label class="field pay-wide"><span class="field-label">Документ коригування (скан)</span><input id="stFiles" class="field-input" type="file" accept=".pdf,image/*"></label>
        </div>
        <p class="buh-note">Сторно зменшує витрату й борг постачальнику датою коригування — закриті місяці не змінюються. Якщо документ уже оплачено, постачальник винен ОСББ різницю: її повернення на рахунок рознесіть як «Повернення» до цієї оплати.</p>
        <div class="pay-form-actions"><button type="button" class="btn-primary btn-compact" data-act="storno-save">Провести сторно</button><button type="button" class="btn-ghost-small" data-act="inline-close">Скасувати</button></div>
    </div>`;
}

function docsHtml() {
    const q = (document.getElementById('exQuery')?.value || '').trim().toLowerCase();
    const list = ctx.expenses.filter(e => (filter === 'all' ? e.status !== 'canceled' : e.status === filter)
        && (!q || `${e.supplierName} ${e.number} ${e.description}`.toLowerCase().includes(q)));
    const sum = st => ctx.expenses.filter(e => e.status === st).reduce((s, e) => s + remaining(e), 0);
    return `<div class="kpi-grid ch-kpi">
            <div class="kpi"><span>Чекають голову</span><b>${ctx.expenses.filter(e => e.status === 'pending').length}</b><small>${fmtKop(ctx.expenses.filter(e => e.status === 'pending').reduce((s, e) => s + e.amountKop, 0))} грн</small></div>
            <div class="kpi"><span>До оплати</span><b>${fmtKop(sum('approved'))}</b><small>${ctx.expenses.filter(e => e.status === 'approved').length} ${docsWord(ctx.expenses.filter(e => e.status === 'approved').length)}</small></div>
            <div class="kpi"><span>Оплачено цього місяця</span><b class="is-in">${fmtKop(ctx.expenses.filter(e => e.status === 'paid' && String(e.paidAt || '').slice(0, 7) === ctx.today.slice(0, 7)).reduce((s, e) => s + e.amountKop, 0))}</b><small>за даними виписки</small></div>
        </div>
        <section class="buh-card">
            <div class="buh-toolbar">
                <div class="buh-seg">${Object.entries(FILTERS).map(([k, v]) => `<button type="button" class="buh-seg-item${k === filter ? ' active' : ''}" data-filter="${k}">${v}</button>`).join('')}</div>
                <input type="search" id="exQuery" class="field-input buh-search" placeholder="Постачальник, номер, опис" value="${escapeHtml(q)}">
                <button type="button" class="btn-primary btn-compact" data-act="new-doc">+ Документ</button>
            </div>
            ${list.length ? `<table class="buh-table is-ops ex-table"><thead><tr><th>Дата</th><th>Постачальник і опис</th><th>Документ</th><th>Стан</th><th class="t-sum">Сума, ₴</th></tr></thead>
                <tbody>${list.map(e => `<tr class="tx-row" data-id="${escapeHtml(e.id)}">
                    <td class="t-date">${human(e.date)}</td>
                    <td class="t-main"><b>${escapeHtml(e.supplierName)}</b><small>${escapeHtml(e.description)} · ${escapeHtml(ctx.items[e.item] || '')}</small></td>
                    <td class="t-acc ex-doc">${escapeHtml(ctx.docTypes[e.docType] || '')} № ${escapeHtml(e.number)}${e.contractNumber ? `<small>дог. № ${escapeHtml(e.contractNumber)}</small>` : ''}</td>
                    <td>${tag(EXPENSE_STATUS, e.status)}</td>
                    <td class="t-sum is-out">${fmtKop(e.amountKop)}${e.paidKop && e.status !== 'paid' ? `<small>сплачено ${fmtKop(e.paidKop)}</small>` : ''}</td>
                </tr><tr class="tx-detail-row"><td colspan="5"><div class="ex-detail">
                    <span class="t-muted">${escapeHtml(e.approval?.reason || '')}${e.approval?.by ? ` · затвердив ${escapeHtml(e.approval.by)}` : ''}${e.comment ? ` · «${escapeHtml(e.comment)}»` : ''}</span>
                    ${filesHtml(e.files) || '<span class="buh-tag is-review">без файлу</span>'}
                    ${relationsHtml(e)}
                    <span class="tx-actions">${docActions(e)}</span>${attaching === e.id ? attachHtml(e) : ''}${stornoing === e.id ? stornoHtml(e) : ''}</div></td></tr>`).join('')}</tbody></table>`
                : '<p class="list-empty">Документів немає</p>'}
        </section>`;
}

function contractsHtml() {
    const ending = c => c.validTo && c.validTo >= ctx.today && c.validTo <= new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10);
    return `<section class="buh-card">
            <div class="buh-toolbar"><span class="buh-note">Договори понад 50 000 грн — лише за рішенням загальних зборів (п. 3.4.15 статуту). Підписує й затверджує голова.</span>
                <button type="button" class="btn-primary btn-compact" data-act="new-contract">+ Договір</button></div>
            ${ctx.contracts.length ? `<table class="buh-table ex-table"><thead><tr><th>Договір</th><th>Постачальник і предмет</th><th>Діє</th><th>Стан</th><th class="t-sum">Сума, ₴</th><th></th></tr></thead>
                <tbody>${ctx.contracts.map(c => `<tr data-id="${escapeHtml(c.id)}">
                    <td class="ex-doc"><b>№ ${escapeHtml(c.number)}</b><small class="t-muted"> від ${human(c.date)}</small></td>
                    <td class="t-main"><b>${escapeHtml(c.supplierName || '')}</b><small>${escapeHtml(c.subject)} · ${escapeHtml(ctx.items[c.item] || '')}${c.meetingDecision ? ` · збори: ${escapeHtml(c.meetingDecision)}` : ''}</small></td>
                    <td class="t-muted">${human(c.validFrom)} — ${c.validTo ? human(c.validTo) : 'безстроково'}${ending(c) ? ' <span class="buh-tag is-review">закінчується</span>' : ''}</td>
                    <td>${tag(CONTRACT_STATUS, c.status)}</td>
                    <td class="t-sum">${c.type === 'monthly' ? `${fmtKop(c.monthlyKop)}<small>на місяць</small>` : fmtKop(c.amountKop)}</td>
                    <td class="t-act">${c.status === 'pending' && isChair() ? '<button type="button" class="btn-soft btn-compact" data-act="approve-contract">Затвердити</button> <button type="button" class="btn-ghost-small" data-act="reject-contract">Відхилити</button>' : ''}
                        ${c.status !== 'approved' || isChair() ? '<button type="button" class="btn-ghost-small" data-act="edit-contract">Змінити</button>' : ''}
                        ${c.status === 'approved' ? '<button type="button" class="btn-ghost-small" data-act="end-contract">Завершити</button>' : ''}
                        ${filesHtml(c.files)}</td></tr>`).join('')}</tbody></table>` : '<p class="list-empty">Договорів ще немає</p>'}
        </section>`;
}

function suppliersHtml() {
    const totals = new Map();
    ctx.expenses.filter(e => ['approved', 'paid'].includes(e.status)).forEach(e => totals.set(e.supplierId, (totals.get(e.supplierId) || 0) + e.amountKop));
    return `<section class="buh-card">
            <div class="buh-toolbar"><span class="buh-note">Код перевіряється за контрольною цифрою. Фізособі без ФОП через «Витрати» не платять — це виплата за ЦПД.</span>
                <button type="button" class="btn-primary btn-compact" data-act="new-supplier">+ Постачальник</button></div>
            ${ctx.suppliers.length ? `<table class="buh-table ex-table"><thead><tr><th>Назва</th><th>Код</th><th>IBAN</th><th>Примітки</th><th class="t-sum">Витрати, ₴</th><th></th></tr></thead>
                <tbody>${ctx.suppliers.map(s => `<tr data-id="${escapeHtml(s.id)}">
                    <td class="t-main"><b>${escapeHtml(s.name)}</b><small>${escapeHtml(ctx.kinds[s.kind] || '')}</small></td>
                    <td>${escapeHtml(s.code)}</td><td class="t-muted">${escapeHtml(maskIban(s.iban || '')) || '—'}</td>
                    <td>${s.kind === 'fop' ? (s.fopChecked ? '<span class="buh-tag is-payment">витяг перевірено</span>' : '<span class="buh-tag is-review">перевірте витяг ЄДР</span>') : s.kind === 'person' ? '<span class="buh-tag is-error">лише через ЦПД</span>' : ''}</td>
                    <td class="t-sum">${fmtKop(totals.get(s.id) || 0)}</td>
                    <td class="t-act"><button type="button" class="btn-ghost-small" data-act="edit-supplier">Змінити</button></td></tr>`).join('')}</tbody></table>`
                : '<p class="list-empty">Постачальників ще немає. Їх можна додати й прямо з форми документа.</p>'}
        </section>`;
}

// ------------------------------------------------------------
// РОЗДІЛ
// ------------------------------------------------------------
export async function loadExpensesView() {
    ctx = await loadExpenses();
    const host = document.getElementById('viewExpenses');
    const body = segment === 'docs' ? docsHtml() : segment === 'contracts' ? contractsHtml() : suppliersHtml();
    host.innerHTML = `<div class="buh-seg ch-segs" role="tablist">${Object.entries(SEGMENTS).map(([k, v]) =>
            `<button type="button" class="buh-seg-item${k === segment ? ' active' : ''}" data-seg="${k}">${v}</button>`).join('')}</div>
        ${formHtml()}${body}`;
    if (form) document.getElementById('exForm')?.querySelector('select, input')?.focus({ preventScroll: true });
    return ctx.expenses.filter(e => e.status === 'pending').length;
}

/** Затверджений документ → платіж у Приват24 на підпис голови. */
export async function payExpense(e) {
    const pc = await loadPaymentContext();
    const account = defaultAccount(pc.accounts || []);
    if (!account) throw new Error('Банк не підключено — немає рахунку, з якого платити');
    await expAct({ action: 'pay', id: e.id, account });
    toast(`${e.supplierName}: ${fmtKop(remaining(e))} грн — у Приват24 на підпис голови`, 'success');
}

export async function decideExpense(e, approve) {
    const comment = approve ? '' : await promptDialog('Відхилити документ?', `${e.supplierName}, № ${e.number}: ${fmtKop(e.amountKop)} грн. Бухгалтер побачить причину.`, { confirmLabel: 'Відхилити', placeholder: 'Причина' });
    if (!approve && !comment) return false;
    await expAct({ action: 'decideExpense', id: e.id, approve, comment });
    toast(approve ? 'Затверджено' : 'Відхилено', 'success');
    return true;
}

export async function decideContract(c, approve) {
    const comment = approve ? '' : await promptDialog('Відхилити договір?', `№ ${c.number} з ${c.supplierName}.`, { confirmLabel: 'Відхилити', placeholder: 'Причина' });
    if (!approve && !comment) return false;
    await expAct({ action: 'decideContract', id: c.id, approve, comment });
    toast(approve ? 'Договір затверджено' : 'Договір відхилено', 'success');
    return true;
}

async function saveDoc(btn) {
    const amountKop = toKop(val('dfAmount'));
    if (!amountKop || amountKop <= 0) { toast('Вкажіть суму документа', 'error'); return; }
    const vat = val('dfVat') ? toKop(val('dfVat')) : 0;
    if (vat === null) { toast('ПДВ — сума в гривнях', 'error'); return; }
    // Після будь-якої дії розділ перемальовується — введене не має зникнути, якщо сервер відмовить.
    form = snapshotForm();
    setBusy(btn, true, files.length ? 'Завантажую файли…' : 'Зберігаю…');
    try {
        const uploaded = await uploadExpenseFiles(files);
        form.data.files = [...(form.data.files || []), ...uploaded];
        files = [];
        const payload = { action: 'saveExpense', id: form.data.id || null, supplierId: form.data.supplierId, contractId: form.data.contractId || null,
            docType: form.data.docType, number: form.data.number, date: form.data.date, period: form.data.period, amountKop, vatKop: vat,
            item: form.data.item, description: form.data.description, files: form.data.files, linkedTo: form.data.linkedTo || null };
        let r;
        try {
            r = await expAct(payload);
        } catch (err) {
            // Схожий документ тієї самої послуги: привʼязати до нього або підтвердити окрему витрату.
            const similar = err.cause?.details?.similar;
            if (!similar) throw err;
            if (await confirmDialog('Та сама послуга?', `${err.message}`, `Привʼязати до № ${similar.number}`)) r = await expAct({ ...payload, linkedTo: similar.id });
            else if (await confirmDialog('Це окрема послуга?', 'Документ стане окремою витратою й окремим боргом постачальнику.', 'Так, окрема')) r = await expAct({ ...payload, distinct: true });
            else return;
        }
        form = null;
        toast(r.status === 'linked' ? 'Привʼязано як підтвердний документ — окремої витрати немає' : r.status === 'approved' ? `Затверджено (${r.approval.reason}) — можна сплачувати` : `Надіслано голові: ${r.approval.reason}`, 'success');
        (r.warnings || []).forEach(w => toast(w, 'info'));
    } catch (e) { toast(e.message, 'error'); }
    finally { setBusy(btn, false); }
}

async function saveContract(btn) {
    const amount = toKop(val('cfAmount'));
    if (!amount || amount <= 0) { toast('Вкажіть суму', 'error'); return; }
    const monthly = val('cfType') === 'monthly';
    form = snapshotForm();
    setBusy(btn, true, 'Зберігаю…');
    try {
        const uploaded = await uploadExpenseFiles(files);
        const r = await expAct({ action: 'saveContract', id: form.data.id || null, supplierId: val('cfSupplier'), number: val('cfNumber'), date: val('cfDate'),
            subject: val('cfSubject'), type: monthly ? 'monthly' : 'fixed', monthlyKop: monthly ? amount : null, amountKop: monthly ? null : amount,
            validFrom: val('cfFrom'), validTo: val('cfTo'), item: val('cfItem'), boardDecision: val('cfBoard'), meetingDecision: val('cfMeeting'),
            files: [...(form.data.files || []), ...uploaded] });
        form = null; files = [];
        toast(r.status === 'approved' ? 'Договір затверджено' : 'Договір надіслано голові на затвердження', 'success');
    } catch (e) { toast(e.message, 'error'); }
    finally { setBusy(btn, false); }
}

async function saveSupplier(btn) {
    setBusy(btn, true, 'Зберігаю…');
    try {
        const back = form.back;
        form = snapshotForm();
        const r = await expAct({ action: 'saveSupplier', id: form.data.id || null, name: val('sfName'), kind: val('sfKind'), code: val('sfCode'),
            iban: val('sfIban'), fopChecked: document.getElementById('sfFop')?.checked === true, note: val('sfNote') });
        (r.warnings || []).forEach(w => toast(w, 'info'));
        toast('Постачальника збережено', 'success');
        // Повертаємось у форму документа чи договору, з якої прийшли, — уже з новим постачальником.
        form = back ? { ...back, data: { ...back.data, supplierId: r.id } } : null;
        if (back) segment = back.kind === 'doc' ? 'docs' : 'contracts';
    } catch (e) { toast(e.message, 'error'); }
    finally { setBusy(btn, false); }
}

/** Поточні значення форми — щоб не загубити їх при переході до нового постачальника. */
function snapshotForm() {
    if (form?.kind === 'supplier') return { ...form, data: { ...form.data, name: val('sfName'), kind: val('sfKind'), code: val('sfCode'), iban: val('sfIban'),
        fopChecked: document.getElementById('sfFop')?.checked === true, note: val('sfNote') } };
    if (form?.kind === 'doc') return { ...form, data: { ...form.data, supplierId: val('dfSupplier'), contractId: val('dfContract'), docType: val('dfType'), number: val('dfNumber'), date: val('dfDate'),
        period: val('dfPeriod'), amountKop: toKop(val('dfAmount')) || null, vatKop: toKop(val('dfVat')) || 0, item: val('dfItem'), description: val('dfDesc'), linkedTo: val('dfLinked') || form.data.linkedTo || '' } };
    if (form?.kind === 'contract') return { ...form, data: { ...form.data, supplierId: val('cfSupplier'), number: val('cfNumber'), date: val('cfDate'), subject: val('cfSubject'), type: val('cfType'),
        monthlyKop: toKop(val('cfAmount')), amountKop: toKop(val('cfAmount')), validFrom: val('cfFrom'), validTo: val('cfTo'), item: val('cfItem'),
        boardDecision: val('cfBoard'), meetingDecision: val('cfMeeting') } };
    return null;
}

function contractHint() {
    const hint = document.getElementById('cfHint');
    if (!hint) return;
    const amount = toKop(val('cfAmount')) || 0;
    const monthly = val('cfType') === 'monthly';
    const from = val('cfFrom'), to = val('cfTo');
    const months = monthly ? (to && from ? Math.max(1, (Number(to.slice(0, 4)) - Number(from.slice(0, 4))) * 12 + Number(to.slice(5, 7)) - Number(from.slice(5, 7)) + 1) : 12) : 1;
    const total = amount * months;
    document.getElementById('cfAmountLabel').textContent = monthly ? 'Сума на місяць, грн' : 'Сума договору, грн';
    hint.innerHTML = total ? `Сума договору: <b>${fmtKop(total)} грн</b>${monthly ? ` (${months} міс.${to ? '' : ', безстроковий — рахуємо рік'})` : ''}. ${total > ctx.limitKop
        ? '<b class="ch-warn">Понад 50 000 грн: потрібне рішення загальних зборів.</b>' : 'До 50 000 грн — за погодженням правління.'}` : '';
}

export function initExpensesView() {
    const host = document.getElementById('viewExpenses');
    host.addEventListener('click', async e => {
        const seg = e.target.closest('[data-seg]');
        if (seg) { segment = seg.dataset.seg; form = null; loadExpensesView(); return; }
        const f = e.target.closest('[data-filter]');
        if (f) { filter = f.dataset.filter; loadExpensesView(); return; }
        const btn = e.target.closest('[data-act]');
        if (!btn || btn.disabled) return;
        const rowId = btn.closest('[data-id]')?.dataset.id || btn.closest('.tx-detail-row')?.previousElementSibling?.dataset.id;
        const doc = ctx.expenses.find(x => x.id === rowId);
        const con = ctx.contracts.find(x => x.id === rowId);
        const sup = ctx.suppliers.find(x => x.id === rowId);
        const a = btn.dataset.act;
        try {
            if (a === 'close') { form = null; files = []; loadExpensesView(); }
            else if (a === 'new-doc') openExpenses('docs', { kind: 'doc', data: {} });
            else if (a === 'new-contract') openExpenses('contracts', { kind: 'contract', data: {} });
            else if (a === 'new-supplier') openExpenses('suppliers', { kind: 'supplier', data: {} });
            else if (a === 'edit-doc') openExpenses('docs', { kind: 'doc', data: doc });
            else if (a === 'edit-contract') openExpenses('contracts', { kind: 'contract', data: con });
            else if (a === 'edit-supplier') openExpenses('suppliers', { kind: 'supplier', data: sup });
            else if (a === 'save-doc') await saveDoc(btn);
            else if (a === 'save-contract') await saveContract(btn);
            else if (a === 'save-supplier') await saveSupplier(btn);
            else if (a === 'approve-doc') await decideExpense(doc, true);
            else if (a === 'reject-doc') await decideExpense(doc, false);
            else if (a === 'approve-contract') await decideContract(con, true);
            else if (a === 'reject-contract') await decideContract(con, false);
            else if (a === 'pay-doc') {
                if (!await confirmDialog('Сплатити документ?', `${doc.supplierName}: ${fmtKop(remaining(doc))} грн. Платіж зʼявиться в Приват24 й чекатиме підпису КЕП голови.`, 'Сплатити')) return;
                setBusy(btn, true, 'Відправляю…');
                await payExpense(doc);
            } else if (a === 'attach-doc') { attaching = doc.id; stornoing = null; loadExpensesView(); }
            else if (a === 'storno-doc') { stornoing = doc.id; attaching = null; loadExpensesView(); }
            else if (a === 'inline-close') { attaching = null; stornoing = null; loadExpensesView(); }
            else if (a === 'attach-save') {
                setBusy(btn, true, 'Привʼязую…');
                await expAct({ action: 'linkExisting', id: doc.id, to: val('atMain') });
                attaching = null;
                toast('Документ став підтвердним: витрата не дублюється', 'success');
            } else if (a === 'storno-save') {
                const amount = toKop(val('stAmount'));
                if (!amount || amount <= 0) { toast('Вкажіть суму сторно', 'error'); return; }
                setBusy(btn, true, 'Проводжу…');
                const picked = [...(document.getElementById('stFiles')?.files || [])];
                const up = picked.length ? await uploadExpenseFiles(picked) : [];
                const r = await expAct({ action: 'storno', id: doc.id, amountKop: amount, date: val('stDate'), number: val('stNumber'), reason: val('stReason'), files: up });
                stornoing = null;
                toast(r.overpaidKop ? `Сторно проведено. Постачальник винен ОСББ ${fmtKop(r.overpaidKop)} грн — чекайте повернення на рахунок` : 'Сторно проведено', 'success');
            } else if (a === 'cancel-doc') {
                if (!await confirmDialog('Скасувати документ?', `${doc.supplierName}, № ${doc.number}. Його не буде оплачено; запис лишиться в журналі.`, 'Скасувати документ')) return;
                await expAct({ action: 'cancelExpense', id: doc.id });
                toast('Документ скасовано', 'success');
            } else if (a === 'end-contract') {
                const date = await promptDialog('Завершити договір', `№ ${con.number} з ${con.supplierName}. Вкажіть останній день дії (РРРР-ММ-ДД).`, { confirmLabel: 'Завершити', placeholder: ctx.today, maxLength: 10 });
                if (!date) return;
                await expAct({ action: 'endContract', id: con.id, date });
                toast('Договір завершено', 'success');
            }
        } catch (err) { toast(err.message, 'error'); }
        finally { if (btn.isConnected) setBusy(btn, false); }
    });
    host.addEventListener('change', e => {
        const t = e.target;
        if (t.id === 'dfFiles' || t.id === 'cfFiles') { files = [...t.files]; return; }
        if ((t.id === 'dfSupplier' || t.id === 'cfSupplier') && t.value === '__new') {
            const back = snapshotForm();
            form = { kind: 'supplier', data: {}, back };
            loadExpensesView();
            return;
        }
        if (t.id === 'dfSupplier') { form = snapshotForm(); form.data.supplierId = t.value; form.data.contractId = ''; loadExpensesView(); return; }
        if (t.id === 'dfContract' && t.value) {
            // Договір підставляє статтю, суму на місяць і опис.
            const c = contractOf(t.value);
            if (c) {
                if (!val('dfAmount') && c.monthlyKop) document.getElementById('dfAmount').value = money2(c.monthlyKop);
                document.getElementById('dfItem').value = c.item;
                if (c.type === 'monthly') document.getElementById('dfType').value = 'act';
                if (!val('dfDesc')) document.getElementById('dfDesc').value = `${c.subject} за ${periodName(val('dfPeriod'))}`;
            }
        }
        if (t.id === 'sfKind') document.getElementById('sfFopRow').hidden = t.value !== 'fop';
        if (t.id?.startsWith('cf')) contractHint();
    });
    host.addEventListener('input', e => {
        if (e.target.id === 'exQuery') { const pos = e.target.selectionStart; loadExpensesView().then(() => { const q = document.getElementById('exQuery'); q?.focus(); q?.setSelectionRange(pos, pos); }); }
        if (e.target.id?.startsWith('cf')) contractHint();
    });
    host.addEventListener('keydown', e => {
        if (e.key !== 'Enter' || !e.target.closest('#exForm') || e.target.matches('textarea, select, [type="file"]')) return;
        e.preventDefault();
        host.querySelector('#exForm [data-act^="save"]')?.click();
    });
}

