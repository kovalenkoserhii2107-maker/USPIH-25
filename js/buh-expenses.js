// ============================================================
// «Документи»: рахунки, акти й накладні постачальників, договори,
// постачальники. Документи — списком і карткою зі сканом; файл можна
// перетягнути на сторінку — відкриється форма з ним.
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
    loadExpenses, expAct, uploadExpenseFiles, loadPaymentContext, loadPayments, CONTRACT_STATUS, maskIban, when, dateOnly, loadTx, PAYMENT_STATUS
} from './buh-data.js';
import { defaultAccount } from './buh-payments.js';
import { periodName, fmtKop, toKop } from './charges-core.js';
import { TABS, remaining, bucketOf, chipOf, filterDocs, docCounts, mainsFor as mainsOf, twinOf, scanKind } from './docs-core.js';
import { docPayments } from './chain-core.js';
import { openPaymentSheet, openTxSheet, openContractSheet } from './buh-chain.js';
import { ASSET_SUBACCOUNTS, DEPR_METHODS, UNITS, defaultSubacc, defaultDeprMethod, suggestAssetId } from './assets-core.js';
import { openAssets } from './buh-assets.js';


const LEGACY = { docs: 'work' };
let segment = 'work';
let selected = null;      // id документа в картці
let query = '';
let paying = new Set();   // документи, платіж за якими вже в Приват24 на підписі
let allPayments = [];     // платежі — для блоку «Оплата» в картці документа
let wanted = null;        // документ, який треба показати (з «Рішень» чи картки ланцюжка) — вкладку визначаємо за ним
let ctx = null;
let form = null;          // { kind: 'doc'|'contract'|'supplier', data }
let files = [];           // нові файли форми, ще не завантажені

const isChair = () => session.role === 'chair';
const human = d => (d ? String(d).split('-').reverse().join('.') : '');
const tag = (map, s) => { const [t, c] = map[s] || [s, '']; return `<span class="buh-tag ${c}">${escapeHtml(t)}</span>`; };
const contractOf = id => ctx.contracts.find(c => c.id === id);
let attaching = null;     // документ, який привʼязують до основного
let stornoing = null;     // документ, який сторнують
/** Основні документи постачальника, до яких можна привʼязати doc. */
const mainsFor = doc => mainsOf(doc, ctx.expenses);
const docName = x => `${ctx.docTypes[x.docType] || 'Документ'} № ${x.number} від ${human(x.date)}`;
const docsWord = n => (n % 10 === 1 && n % 100 !== 11 ? 'документ' : [2, 3, 4].includes(n % 10) && ![12, 13, 14].includes(n % 100) ? 'документи' : 'документів');
const val = id => document.getElementById(id)?.value?.trim() ?? '';
const filesHtml = list => (list || []).map(f => `<a class="buh-file" href="${escapeHtml(f.url)}" target="_blank" rel="noopener">${escapeHtml(f.name)}</a>`).join(' ');

/** Відкрити розділ на потрібній вкладці, за потреби — з готовою формою чи документом. */
export function openExpenses(seg = 'docs', prefill = null, docId = null) {
    segment = TABS[LEGACY[seg] || seg] ? LEGACY[seg] || seg : 'work';
    if (docId) { selected = docId; wanted = docId; }
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
            <label class="field pay-wide"><span class="field-label">Джерело фінансування</span><select id="dfFund" class="field-input field-select">${options({...Object.fromEntries((ctx.funds || [{id:'main',name:'Основний фонд'}]).map(f=>[f.id,f.name])),...(ctx.ownIncome?{own:'Власний дохід (без використання 48)'}:{})},d.fundId || ctx.defaultFund || 'main')}</select></label>
            <details class="pay-wide"${d.postingAcc && d.postingAcc !== '92' ? ' open' : ''}><summary>Придбання активу ОСББ (ОЗ, МНМА) або ТМЦ (Запаси, МШП)</summary>
                <p class="buh-note">Послуги й ремонт спільного майна будинку — це поточні витрати (рахунок 92). Тут виділяють майно, яке переходить у власність ОСББ як юрособи: понад ${((ctx.mnhmaLimitKop || 2000000) / 100).toLocaleString('uk-UA')} грн і > 1 року — Основні засоби (10); до ${((ctx.mnhmaLimitKop || 2000000) / 100).toLocaleString('uk-UA')} грн і > 1 року — МНМА (11); паливо, будматеріали, запчастини — Запаси (20); інвентар та інструмент до 1 року — МШП (22).</p>
                <div class="pay-grid" style="margin-top:8px">
                    <label class="field"><span class="field-label">Рахунок обліку</span><select id="dfPosting" class="field-input field-select">${options({'92':'92 · Поточні витрати / послуги','10':'10 · Основний засіб ОСББ (ОЗ)','11':'11 · Малоцінний необоротний актив (МНМА)','20':'20 · Виробничі запаси (паливо, матеріали)','22':'22 · Малоцінні та швидкозношувані предмети (МШП)'},d.postingAcc || '92')}</select></label>
                    <label class="field"><span class="field-label">Інвентарний / номенклатурний код</span><input id="dfAsset" class="field-input" maxlength="80" placeholder="Напр.: ОЗ-001, МНМА-001, ТМЦ-001" value="${escapeHtml(d.assetId || '')}"></label>
                    <label class="field"><span class="field-label">Кількість (для ТМЦ / МШП)</span><input id="dfAssetQty" class="field-input" type="number" step="0.001" min="0.001" value="${escapeHtml(String(d.assetQty || 1))}"></label>
                    <label class="field"><span class="field-label">Одиниця виміру</span><select id="dfAssetUnit" class="field-input field-select">${UNITS.map(u => `<option value="${escapeHtml(u)}"${u === (d.assetUnit || 'шт.') ? ' selected' : ''}>${escapeHtml(u)}</option>`).join('')}</select></label>
                    <label class="field"><span class="field-label">МВО (хто прийняв майно)</span><input id="dfCustodian" class="field-input" maxlength="160" placeholder="Голова правління / комендант / електрик" value="${escapeHtml(d.custodian || '')}"></label>
                    <label class="field"><span class="field-label">Місце зберігання / встановлення</span><input id="dfLocation" class="field-input" maxlength="200" placeholder="Техприміщення / комора / електрощитова" value="${escapeHtml(d.location || '')}"></label>
                    <label class="am-check pay-wide"><input id="dfOwned" type="checkbox"${d.ownedByOsbb?' checked':''}><span>Підтверджую: майно належить саме ОСББ як юридичній особі (не є невідʼємною частиною спільного майна будинку)</span></label>
                    <label class="am-check pay-wide"><input id="dfCommissionNow" type="checkbox"${d.commissionedDate ? ' checked' : ''}><span>Для ОЗ (10) та МНМА (11): одразу ввести в експлуатацію датою документа (Акт ОЗ-1)</span></label>
                </div>
            </details>
            <label class="field pay-wide"><span class="field-label">За що</span><input id="dfDesc" class="field-input" maxlength="300" placeholder="Послуга чи товар, період" value="${escapeHtml(d.description || '')}"></label>
            ${!d.id && supplierId ? `<label class="field pay-wide"><span class="field-label">Підтверджує документ тієї самої послуги</span>
                <select id="dfLinked" class="field-input field-select"><option value="">Ні — це окрема витрата</option>${mainsFor({ supplierId, amountKop: 0 }).map(x =>
                    `<option value="${escapeHtml(x.id)}"${x.id === d.linkedTo ? ' selected' : ''}>${escapeHtml(docName(x))} · ${fmtKop(x.amountKop)} грн</option>`).join('')}</select></label>` : ''}
            <label class="field pay-wide"><span class="field-label">Скан або PDF документа</span><input id="dfFiles" class="field-input" type="file" multiple accept=".pdf,image/*,.doc,.docx,.xls,.xlsx"></label>
        </div>
        ${d.files?.length ? `<p class="buh-note">Уже додано: ${filesHtml(d.files)}</p>` : ''}
        ${files.length ? `<p class="buh-note">Буде додано: ${files.map(f => escapeHtml(f.name)).join(', ')}</p>` : ''}
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
            <label class="field"><span class="field-label">ЄДРПОУ або РНОКПП</span>
                <div style="display:flex;gap:8px;align-items:center">
                    <input id="sfCode" class="field-input" inputmode="numeric" maxlength="10" value="${escapeHtml(s.code || '')}" placeholder="8 або 10 цифр">
                    <button type="button" class="btn-soft btn-compact" data-act="check-supplier" title="Заповнити назву, КВЕД і перевірити ризики через Приват24 ЄДР/УБКІ">Перевірити в ЄДР</button>
                </div>
            </label>
            <label class="field"><span class="field-label">Хто це</span><select id="sfKind" class="field-input field-select">${options(ctx.kinds, s.kind || 'company')}</select></label>
            <label class="field pay-wide"><span class="field-label">Назва</span><input id="sfName" class="field-input" maxlength="200" value="${escapeHtml(s.name || '')}" placeholder="ТОВ «Ліфт-Сервіс» або ФОП Іваненко І. І."></label>
            <div id="sfEdrStatus" class="buh-note pay-wide" hidden></div>
            <label class="field pay-wide"><span class="field-label">IBAN для оплати</span><input id="sfIban" class="field-input" maxlength="34" value="${escapeHtml(s.iban || '')}" placeholder="UA…"></label>
            <label class="am-check pay-wide" id="sfFopRow"${(s.kind || 'company') === 'fop' ? '' : ' hidden'}><input type="checkbox" id="sfFop"${s.fopChecked ? ' checked' : ''}><span>Витяг з ЄДР і КВЕД перевірено: послуга відповідає видам діяльності ФОП</span></label>
            <label class="field pay-wide"><span class="field-label">Примітка (КВЕД, контакти)</span><input id="sfNote" class="field-input" maxlength="300" value="${escapeHtml(s.note || '')}"></label>
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
/** Дії з документом: головна — перша (чорна), решта — світлі. */
function docActions(e) {
    const out = [];
    const btn = (act, label, extra = '') => `<button type="button" class="sv-btn${out.length ? ' is-soft' : ''}" data-act="${act}"${extra}>${label}</button>`;
    if (e.status === 'pending' && isChair()) out.push(btn('approve-doc', 'Затвердити'), btn('reject-doc', 'Відхилити'));
    if (e.status === 'approved' && remaining(e) > 0 && !paying.has(e.id)) out.push(btn('pay-doc', e.paidKop > 0 ? 'Доплатити' : 'Створити платіж'));
    if (paying.has(e.id)) out.push('<button type="button" class="sv-btn" data-go="payments">Платіж на підписі голови</button>');
    if (e.postingAcc && e.postingAcc !== '92' && e.assetId) out.push(btn('open-asset', 'Картка в «Майно та ТМЦ» ›'));
    if (['pending', 'rejected'].includes(e.status)) out.push(btn('edit-doc', 'Змінити'));
    if (['pending', 'approved', 'rejected'].includes(e.status) && !(e.paidKop > 0) && !e.linkedIds?.length && !e.stornoIds?.length && mainsFor(e).length && !twinOf(e, ctx.expenses)) {
        out.push(btn('attach-doc', 'Це та сама послуга…', ' title="Рахунок і акт однієї послуги — одна витрата"'));
    }
    if (['approved', 'paid'].includes(e.status) && e.amountKop > 0 && e.amountKop > (e.stornoKop || 0)) out.push(btn('storno-doc', 'Сторно'));
    if (['pending', 'approved', 'rejected', 'linked'].includes(e.status) && !(e.paidKop > 0) && !e.stornoIds?.length && !paying.has(e.id)) out.push(btn('cancel-doc', 'Скасувати'));
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
    return parts.map(p => `<p class="dc-hint">${LINK_ICON}<span>${p}</span></p>`).join('');
}

const LINK_ICON = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" aria-hidden="true"><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/></svg>';
const UP_ICON = '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" aria-hidden="true"><path d="M12 16V4M7 9l5-5 5 5M5 20h14"/></svg>';

function attachHtml(e) {
    const list = mainsFor(e);
    return `<div class="ex-inline" id="exAttach">
        <label class="field"><span class="field-label">Основний документ тієї самої послуги</span><select id="atMain" class="field-input field-select">${list.map(x =>
            `<option value="${escapeHtml(x.id)}">${escapeHtml(docName(x))} · ${fmtKop(x.amountKop)} грн · ${escapeHtml(chipOf(x)[0])}</option>`).join('')}</select></label>
        <p class="buh-note">${escapeHtml(docName(e))} стане підтвердним: витрата й борг лишаться лише за основним документом.</p>
        <div class="pay-form-actions"><button type="button" class="sv-btn" data-act="attach-save">Привʼязати</button><button type="button" class="sv-btn is-soft" data-act="inline-close">Скасувати</button></div>
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
        <div class="pay-form-actions"><button type="button" class="sv-btn" data-act="storno-save">Провести сторно</button><button type="button" class="sv-btn is-soft" data-act="inline-close">Скасувати</button></div>
    </div>`;
}

const docTitle = e => e.description || e.supplierName || 'Документ';

/**
 * «Оплата»: договір, платежі за документом і списання у виписці — кожне
 * відкривається карткою ланцюжка (buh-chain.js).
 */
function chainHtml(e) {
    const c = e.contractId ? contractOf(e.contractId) : null;
    const pays = docPayments(e, allPayments);
    const payTxs = new Set(pays.map(p => p.txId).filter(Boolean));
    const txs = (e.txIds || []).filter(id => !payTxs.has(id));
    if (!c && !pays.length && !txs.length) return '';
    const row = (attrs, label, title, right = '') => `<button type="button" class="chs-link" ${attrs}><span class="chs-link-label">${label}</span>
        <span class="chs-link-main"><b>${title}</b></span><span class="chs-link-right">${right}<span aria-hidden="true">›</span></span></button>`;
    const statusChip = p => { const [t, cl] = PAYMENT_STATUS[p.status] || [p.status, '']; return `<span class="sv-chip ${cl === 'is-payment' ? 'is-done' : cl === 'is-error' ? 'is-bad' : cl === 'is-review' ? 'is-work' : ''}">${escapeHtml(t)}</span>`; };
    return `<div class="dc-chain"><h3 class="chs-h">Договір і оплата</h3><div class="chs-links">
        ${c ? row(`data-open="contract" data-id="${escapeHtml(c.id)}"`, 'Договір', `№ ${escapeHtml(c.number)} від ${human(c.date)} · ${escapeHtml(c.subject || '')}`) : ''}
        ${pays.map(p => row(`data-open="payment" data-id="${escapeHtml(p.id)}"`, 'Платіж', `${p.createdAt ? escapeHtml(when(p.createdAt)) : ''} · ${escapeHtml(p.recipient?.name || '')}`, `<b>${fmtKop(p.amountKop)} грн</b>${statusChip(p)}`)).join('')}
        ${txs.map(id => row(`data-open="tx" data-id="${escapeHtml(id)}" data-fill-tx="${escapeHtml(id)}"`, 'Списання', 'у виписці банку')).join('')}
    </div></div>`;
}

/** Підставити дату й суму списань у блоці «Оплата» (операції банку читаємо окремо). */
function fillTxRows() {
    document.querySelectorAll('#dcCard [data-fill-tx]').forEach(async b => {
        const tx = await loadTx(b.dataset.fillTx).catch(() => null);
        if (!tx || !b.isConnected) return;
        b.querySelector('.chs-link-main b').textContent = `${dateOnly(tx.at)} · ${tx.counterparty?.name || ''}`;
        b.querySelector('.chs-link-right').insertAdjacentHTML('afterbegin', `<b>${fmtKop(tx.amountKop)} грн</b>`);
    });
}

function scanHtml(e) {
    const [first, ...rest] = e.files || [];
    if (!first) return `<div class="dc-scan is-empty"><b>Скану немає</b><span>${['pending', 'rejected'].includes(e.status) ? 'Додайте файл через «Змінити» — без нього документ важче перевірити' : 'Документ внесено без файлу'}</span></div>`;
    const kind = scanKind(first);
    const url = escapeHtml(first.url);
    const view = kind === 'image' ? `<a href="${url}" target="_blank" rel="noopener"><img src="${url}" alt="Скан: ${escapeHtml(first.name)}" loading="lazy"></a>`
        : kind === 'pdf' ? `<iframe src="${url}#toolbar=0&amp;view=FitH" title="Скан: ${escapeHtml(first.name)}" loading="lazy"></iframe>`
            : '';
    return `<div class="dc-scan is-${kind}">${view}
        <span class="dc-files">${[first, ...rest].map(f => `<a href="${escapeHtml(f.url)}" target="_blank" rel="noopener">${escapeHtml(f.name)}</a>`).join('')}</span></div>`;
}

function fieldsHtml(e) {
    const c = e.contractId ? contractOf(e.contractId) : null;
    const rows = [
        ['Постачальник', e.supplierName],
        ['Документ', docName(e)],
        ['За місяць', e.period ? periodName(e.period) : ''],
        ['Стаття', ctx.items[e.item] || ''],
        ['Облік майна / ТМЦ', e.postingAcc && e.postingAcc !== '92' ? `Рахунок ${e.postingAcc} · Інв. код: ${e.assetId || '—'}` : ''],
        ['Договір', c ? '' : e.contractNumber ? `№ ${e.contractNumber}` : 'без договору'],
        ['ПДВ', e.vatKop ? `${fmtKop(e.vatKop)} грн` : ''],
        ['Затвердження', [e.approval?.reason, e.approval?.by ? `затвердив ${e.approval.by}` : ''].filter(Boolean).join(' · ')],
        ['Оплата', e.status === 'paid' ? 'оплачено за випискою' : e.paidKop > 0 ? `сплачено ${fmtKop(e.paidKop)} грн, лишилось ${fmtKop(remaining(e))} грн`
            : paying.has(e.id) ? 'у Приват24, чекає підпису голови' : e.status === 'approved' ? 'ще не створено' : ''],
        ['Коментар', e.comment ? `«${e.comment}»` : '']
    ].filter(([, v]) => v);
    return `<dl class="dc-fields">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${escapeHtml(v)}</dd>`).join('')}</dl>`;
}

function cardHtml(e, empty) {
    if (!e) return empty && segment === 'work' ? '<div class="fl-empty"><b>Усе опрацьовано</b><span>Нових документів немає. Додайте рахунок чи акт — перетягніть файл угору сторінки.</span></div>'
        : '<div class="fl-empty"><b>Оберіть документ</b><span>Скан, реквізити й звʼязки документа — тут.</span></div>';
    const [chip, cls] = chipOf(e, { chair: isChair(), paying: paying.has(e.id) });
    const twin = twinOf(e, ctx.expenses);
    return `<div class="fl-card-head">
            <div><span class="fl-facts">${escapeHtml(ctx.docTypes[e.docType] || 'Документ')}${e.linkedIds?.length ? ' + підтвердні' : ''} · ${human(e.date)}</span>
                <h2>${escapeHtml(docTitle(e))}</h2><span class="dc-amount">${fmtKop(e.amountKop)} грн</span></div>
            <span class="sv-chip ${cls}">${escapeHtml(chip)}</span>
        </div>
        <div class="dc-body">${scanHtml(e)}${fieldsHtml(e)}</div>
        ${twin ? `<div class="dc-hint is-ask">${LINK_ICON}<span>${escapeHtml(ctx.docTypes[twin.docType] || 'Документ')} № ${escapeHtml(twin.number)} того самого постачальника на ту саму суму — схоже, це одна послуга. Обʼєднаємо в одну витрату, щоб вона не порахувалась двічі.</span>
            <button type="button" class="sv-btn" data-act="merge-doc" data-to="${escapeHtml(twin.id)}">Обʼєднати</button></div>` : ''}
        ${relationsHtml(e)}
        ${chainHtml(e)}
        ${attaching === e.id ? attachHtml(e) : ''}${stornoing === e.id ? stornoHtml(e) : ''}
        <div class="fl-actions">${docActions(e)}</div>`;
}

function itemHtml(e) {
    const [chip, cls] = chipOf(e, { chair: isChair(), paying: paying.has(e.id) });
    return `<li><button type="button" class="fl-item dc-item${e.id === selected ? ' is-current' : ''}" data-act="pick" data-id="${escapeHtml(e.id)}" aria-current="${e.id === selected}">
        <span class="fl-copy"><b>${escapeHtml(docTitle(e))}</b><small>${escapeHtml(e.supplierName)} · ${escapeHtml(ctx.docTypes[e.docType] || '')} № ${escapeHtml(e.number)}</small></span>
        <span class="dc-right"><b class="fl-sum">${fmtKop(e.amountKop)} грн</b><span class="sv-chip ${cls}">${escapeHtml(chip)}</span></span>
    </button></li>`;
}

function docsHtml() {
    const list = filterDocs(ctx.expenses, segment, query);
    if (!list.some(e => e.id === selected)) selected = window.matchMedia('(max-width: 900px)').matches ? null : list[0]?.id || null;
    const cur = ctx.expenses.find(e => e.id === selected);
    const toPay = ctx.expenses.filter(e => e.status === 'approved' && !paying.has(e.id)).reduce((s, e) => s + Math.max(0, remaining(e)), 0);
    return `<div class="fl-grid dc-grid">
            <section class="fl-list" aria-label="Документи">
                <label class="fl-search dc-search"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>
                    <input type="search" id="exQuery" placeholder="Постачальник, номер, опис" value="${escapeHtml(query)}" aria-label="Пошук документа"></label>
                ${segment === 'work' && toPay ? `<p class="dc-sum">До оплати <b>${fmtKop(toPay)} грн</b></p>` : ''}
                ${list.length ? `<ul class="fl-items">${list.map(itemHtml).join('')}</ul>` : `<p class="list-empty">${query ? 'Нічого не знайдено' : segment === 'work' ? 'Документів, що чекають дії, немає' : 'Архів порожній'}</p>`}
            </section>
            <section class="fl-card dc-card${cur || !list.length ? '' : ' is-idle'}" id="dcCard"${cur ? ` data-id="${escapeHtml(cur.id)}"` : ''} aria-live="polite">${cardHtml(cur, !list.length)}</section>
        </div>`;
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
                        <button type="button" class="btn-ghost-small" data-open="contract" data-id="${escapeHtml(c.id)}">Деталі й оплати</button>
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
    const [data, outgoing] = await Promise.all([loadExpenses(), loadPayments().catch(() => [])]);
    ctx = data;
    allPayments = outgoing;
    const target = wanted && ctx.expenses.find(x => x.id === wanted);
    if (target) { segment = bucketOf(target); selected = target.id; form = null; }
    wanted = null;
    paying = new Set(outgoing.filter(p => p.expenseId && ['sending', 'unknown', 'sent'].includes(p.status)).map(p => p.expenseId));
    const host = document.getElementById('viewExpenses');
    const docs = segment === 'work' || segment === 'archive';
    const counts = { ...docCounts(ctx.expenses), contracts: ctx.contracts.length, suppliers: ctx.suppliers.length };
    const body = docs ? docsHtml() : segment === 'contracts' ? contractsHtml() : suppliersHtml();
    host.innerHTML = `${docs ? `<label class="dc-drop" id="dcDrop">
            <input type="file" id="dcPick" multiple accept=".pdf,image/*,.doc,.docx,.xls,.xlsx" class="dc-pick">
            <span class="dc-drop-icon">${UP_ICON}</span>
            <span class="dc-drop-copy"><b>Додати рахунок, акт чи накладну</b><small>Перетягніть файл сюди або оберіть чи сфотографуйте — відкриється форма з цим файлом</small></span>
        </label>` : ''}
        <div class="fl-filters dc-tabs" role="tablist">${Object.entries(TABS).map(([k, v]) =>
            `<button type="button" class="fl-filter${k === segment ? ' active' : ''}" role="tab" aria-selected="${k === segment}" data-seg="${k}">${v} <span>${counts[k]}</span></button>`).join('')}
            <button type="button" class="fl-filter" data-go="assets" title="Інвентарна книга ОЗ, МНМА, склад Запасів та МШП">Майно та ТМЦ ›</button></div>
        ${formHtml()}${body}`;
    if (form) document.getElementById('exForm')?.querySelector('select, input')?.focus({ preventScroll: true });
    fillTxRows();
    return ctx.expenses.filter(e => e.status === 'pending').length;
}

/** Файли, перетягнуті чи обрані у верхній зоні, — у форму нового документа. */
function startWithFiles(list) {
    if (!list.length) return;
    files = list;
    form = { kind: 'doc', data: form?.kind === 'doc' ? form.data : {} };
    loadExpensesView().then(() => document.getElementById('exForm')?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
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
            item: form.data.item, description: form.data.description, files: form.data.files, linkedTo: form.data.linkedTo || null,
            postingAcc:form.data.postingAcc || '92',assetId:form.data.assetId || '',ownedByOsbb:form.data.ownedByOsbb===true,fundId:form.data.fundId || ctx.defaultFund || 'main',
            assetQty:form.data.assetQty || 1,assetUnit:form.data.assetUnit || 'шт.',custodian:form.data.custodian || '',location:form.data.location || '',
            commissionedDate:form.data.commissionedDate || '' };
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

async function checkSupplierEdr(btn) {
    const code = val('sfCode');
    if (!/^\d{8,10}$/.test(code)) { toast('Введіть 8 цифр ЄДРПОУ або 10 цифр РНОКПП', 'error'); return; }
    setBusy(btn, true, 'Перевіряю в ЄДР…');
    try {
        const d = await expAct({ action: 'checkSupplier', code });
        const box = document.getElementById('sfEdrStatus');
        if (!d.found) {
            if (box) { box.hidden = false; box.textContent = d.needRetry ? 'Запит в ЄДР ще обробляється — натисніть «Перевірити в ЄДР» ще раз за кілька секунд.' : 'У ЄДР запис за цим кодом не знайдено.'; }
            toast('У ЄДР ще немає відповіді або код не знайдено', 'info');
            return;
        }
        if (d.name && !val('sfName')) document.getElementById('sfName').value = d.name;
        const kindEl = document.getElementById('sfKind');
        if (kindEl) {
            kindEl.value = code.length === 10 ? 'fop' : 'company';
            const fopRow = document.getElementById('sfFopRow');
            if (fopRow) fopRow.hidden = kindEl.value !== 'fop';
        }
        const kvedStr = (d.kveds || []).slice(0, 3).map(k => `${k.code} ${k.name}`).join('; ');
        if (kvedStr && !val('sfNote')) {
            document.getElementById('sfNote').value = `КВЕД: ${kvedStr}`.slice(0, 300);
        }
        if (code.length === 10 && d.isRegistered && (d.kveds || []).length && document.getElementById('sfFop')) {
            document.getElementById('sfFop').checked = true;
        }
        if (box) {
            box.hidden = false;
            const risks = (d.riskFlags || []).length ? ` · Увага: ${d.riskFlags.join(', ')}` : ' · Ризиків ДПС/УБКІ не виявлено';
            box.textContent = `ЄДР: ${d.name || d.edrpou} (${d.stateText || (d.isRegistered ? 'зареєстровано' : 'стан невідомий')})${kvedStr ? ` · КВЕД: ${kvedStr}` : ''}${risks}`;
        }
        toast(d.isSafe ? 'Дані з ЄДР підтягнуто, ризиків не виявлено' : 'Дані з ЄДР підтягнуто — зверніть увагу на попередження', d.isSafe ? 'success' : 'info');
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
        if (back) segment = back.kind === 'doc' ? 'work' : 'contracts';
    } catch (e) { toast(e.message, 'error'); }
    finally { setBusy(btn, false); }
}

/** Поточні значення форми — щоб не загубити їх при переході до нового постачальника. */
function snapshotForm() {
    if (form?.kind === 'supplier') return { ...form, data: { ...form.data, name: val('sfName'), kind: val('sfKind'), code: val('sfCode'), iban: val('sfIban'),
        fopChecked: document.getElementById('sfFop')?.checked === true, note: val('sfNote') } };
    if (form?.kind === 'doc') return { ...form, data: { ...form.data, supplierId: val('dfSupplier'), contractId: val('dfContract'), docType: val('dfType'), number: val('dfNumber'), date: val('dfDate'),
        period: val('dfPeriod'), amountKop: toKop(val('dfAmount')) || null, vatKop: toKop(val('dfVat')) || 0, item: val('dfItem'), description: val('dfDesc'), linkedTo: val('dfLinked') || form.data.linkedTo || '',
        postingAcc:val('dfPosting') || '92',assetId:val('dfAsset'),ownedByOsbb:document.getElementById('dfOwned')?.checked===true,fundId:val('dfFund') || ctx.defaultFund || 'main',
        assetQty:Number(val('dfAssetQty') || 1),assetUnit:val('dfAssetUnit') || 'шт.',custodian:val('dfCustodian'),location:val('dfLocation'),
        commissionedDate:document.getElementById('dfCommissionNow')?.checked ? (val('dfDate') || ctx.today) : '' } };
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
        const link = e.target.closest('[data-open]');
        if (link) {
            const open = { payment: openPaymentSheet, tx: openTxSheet, contract: openContractSheet }[link.dataset.open];
            open?.(link.dataset.id);
            return;
        }
        const seg = e.target.closest('[data-seg]');
        if (seg) { segment = seg.dataset.seg; form = null; attaching = null; stornoing = null; loadExpensesView(); return; }
        const btn = e.target.closest('[data-act]');
        if (!btn || btn.disabled) return;
        if (btn.dataset.act === 'pick') {
            selected = btn.dataset.id; attaching = null; stornoing = null;
            loadExpensesView().then(() => {
                if (window.matchMedia('(max-width: 900px)').matches) document.getElementById('dcCard')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
            });
            return;
        }
        const rowId = btn.closest('[data-id]')?.dataset.id;
        const doc = ctx.expenses.find(x => x.id === rowId);
        const con = ctx.contracts.find(x => x.id === rowId);
        const sup = ctx.suppliers.find(x => x.id === rowId);
        const a = btn.dataset.act;
        try {
            if (a === 'close') { form = null; files = []; loadExpensesView(); }
            else if (a === 'new-doc') openExpenses('docs', { kind: 'doc', data: {} });
            else if (a === 'new-contract') openExpenses('contracts', { kind: 'contract', data: {} });
            else if (a === 'new-supplier') openExpenses('suppliers', { kind: 'supplier', data: {} });
            else if (a === 'open-asset' && doc?.assetId) openAssets('all', doc.assetId);
            else if (a === 'edit-doc') openExpenses('docs', { kind: 'doc', data: doc });
            else if (a === 'edit-contract') openExpenses('contracts', { kind: 'contract', data: con });
            else if (a === 'edit-supplier') openExpenses('suppliers', { kind: 'supplier', data: sup });
            else if (a === 'save-doc') await saveDoc(btn);
            else if (a === 'save-contract') await saveContract(btn);
            else if (a === 'check-supplier') await checkSupplierEdr(btn);
            else if (a === 'save-supplier') await saveSupplier(btn);
            else if (a === 'approve-doc') await decideExpense(doc, true);
            else if (a === 'reject-doc') await decideExpense(doc, false);
            else if (a === 'approve-contract') await decideContract(con, true);
            else if (a === 'reject-contract') await decideContract(con, false);
            else if (a === 'pay-doc') {
                if (!await confirmDialog('Сплатити документ?', `${doc.supplierName}: ${fmtKop(remaining(doc))} грн. Платіж зʼявиться в Приват24 й чекатиме підпису КЕП голови.`, 'Сплатити')) return;
                setBusy(btn, true, 'Відправляю…');
                await payExpense(doc);
            } else if (a === 'merge-doc') {
                const to = ctx.expenses.find(x => x.id === btn.dataset.to);
                if (!await confirmDialog('Обʼєднати документи?', `${docName(doc)} стане підтвердним до ${docName(to)}: витрата й борг постачальнику — один раз, ${fmtKop(to.amountKop)} грн.`, 'Обʼєднати')) return;
                setBusy(btn, true, 'Обʼєдную…');
                await expAct({ action: 'linkExisting', id: doc.id, to: to.id });
                selected = to.id;
                toast('Обʼєднано: одна послуга — одна витрата', 'success');
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
        if (t.id === 'dcPick') { startWithFiles([...t.files]); return; }
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
        if (t.id === 'dfPosting' && t.value !== '92') {
            const assetInput = document.getElementById('dfAsset');
            const ownedBox = document.getElementById('dfOwned');
            if (ownedBox) ownedBox.checked = true;
            if (assetInput && (!assetInput.value || /^(ОЗ|МНМА|ТМЦ|МШП)-\d+$/.test(assetInput.value))) {
                const existing = (ctx.expenses || []).map(x => x.assetId).filter(Boolean);
                assetInput.value = suggestAssetId(t.value, existing);
            }
        }
        if (t.id === 'sfKind') document.getElementById('sfFopRow').hidden = t.value !== 'fop';
        if (t.id?.startsWith('cf')) contractHint();
    });
    host.addEventListener('input', e => {
        if (e.target.id === 'exQuery') { query = e.target.value; const pos = e.target.selectionStart; loadExpensesView().then(() => { const q = document.getElementById('exQuery'); q?.focus(); q?.setSelectionRange(pos, pos); }); }
        if (e.target.id?.startsWith('cf')) contractHint();
    });
    // Перетягнути файл можна на будь-яке місце розділу документів.
    const docsTab = () => segment === 'work' || segment === 'archive';
    host.addEventListener('dragover', e => {
        if (!docsTab() || !e.dataTransfer?.types?.includes('Files')) return;
        e.preventDefault();
        document.getElementById('dcDrop')?.classList.add('is-over');
    });
    host.addEventListener('dragleave', e => { if (!host.contains(e.relatedTarget)) document.getElementById('dcDrop')?.classList.remove('is-over'); });
    host.addEventListener('drop', e => {
        if (!docsTab() || !e.dataTransfer?.files?.length) return;
        e.preventDefault();
        startWithFiles([...e.dataTransfer.files]);
    });
    host.addEventListener('keydown', e => {
        if (e.key !== 'Enter' || !e.target.closest('#exForm') || e.target.matches('textarea, select, [type="file"]')) return;
        e.preventDefault();
        host.querySelector('#exForm [data-act^="save"]')?.click();
    });
}

