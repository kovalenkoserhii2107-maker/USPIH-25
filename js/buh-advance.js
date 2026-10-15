// ============================================================
// «Авансові звіти» (Рахунок 372): розрахунки з підзвітними особами
// за власні кошти або отриманий аванс (господарські потреби, паливо,
// запчастини, лампочки, дрібний ремонт), виплата компенсації через
// Приват24 та друкована форма Мінфіну № 841 (у редакції № 289).
//
// Принцип: «Система пропонує — людина підтверджує».
// ============================================================
import { session } from './firebase.js';
import { escapeHtml, toast, setBusy, confirmDialog } from './ui.js';
import { loadAdvance, advanceAct, loadRequisites, loadPaymentContext, uploadExpenseFiles } from './buh-data.js';
import { defaultAccount } from './buh-payments.js';
import { fmtKop, toKop, periodName } from './charges-core.js';
import {
    ADVANCE_DOC_TYPES, ADVANCE_STATUS_LABELS, POSTING_ACCOUNTS,
    calculateReportTotals, suggestReportNumber
} from './advance-core.js';
import { suggestAssetId, UNITS } from './assets-core.js';

const TABS = {
    all: 'Усі',
    to_pay: 'До відшкодування',
    settled: 'Розраховані',
    pending: 'Чекають затвердження',
    draft: 'Чернетки'
};

let period = null;
let ctx = null;
let segment = 'all';
let selected = null;
let query = '';
let form = null;

const isChair = () => session.role === 'chair';
const human = d => (d ? String(d).split('-').reverse().join('.') : '—');
const money2 = k => (k ? (k / 100).toFixed(2).replace('.', ',') : '');
const val = id => document.getElementById(id)?.value?.trim() ?? '';
const options = (map, cur) => Object.entries(map).map(([k, v]) =>
    `<option value="${escapeHtml(k)}"${String(k) === String(cur) ? ' selected' : ''}>${escapeHtml(typeof v === 'object' ? v.title : v)}</option>`).join('');

function nextAssetIdForLine(acc, currentLines = [], excludeIdx = -1) {
    const baseIds = ctx?.existingAssetIds || [];
    const lineIds = (currentLines || [])
        .map((l, idx) => (idx === excludeIdx ? '' : l?.assetId))
        .filter(Boolean);
    return suggestAssetId(acc, [...baseIds, ...lineIds]);
}

export function openAdvance(seg = 'all', reportId = null, prefillForm = null) {
    if (TABS[seg]) segment = seg;
    if (reportId) selected = reportId;
    if (prefillForm) form = prefillForm;
    if (location.hash !== '#advance') location.hash = 'advance';
    else loadAdvanceView();
}

function matchesTab(r, tab) {
    if (tab === 'all') return true;
    if (tab === 'to_pay') return r.status === 'approved' && (r.totals.pendingReimburseKop || 0) > 0;
    if (tab === 'settled') return r.status === 'settled' || (r.status === 'approved' && r.totals.isFullySettled);
    if (tab === 'pending') return r.status === 'pending';
    if (tab === 'draft') return r.status === 'draft';
    return true;
}

function filterReports(list) {
    const q = query.trim().toLowerCase();
    return (list || []).filter(r => {
        if (!matchesTab(r, segment)) return false;
        if (!q) return true;
        const lineTexts = (r.lines || []).map(l => `${l.supplier || ''} ${l.desc || ''} ${l.number || ''} ${l.assetId || ''}`).join(' ');
        return [r.id, r.number, r.personName, r.purpose, r.personIban, lineTexts]
            .filter(Boolean).join(' ').toLowerCase().includes(q);
    });
}

function tabCounts(list) {
    const out = { all: (list || []).length, to_pay: 0, settled: 0, pending: 0, draft: 0 };
    for (const r of list || []) {
        if (r.status === 'approved' && (r.totals.pendingReimburseKop || 0) > 0) out.to_pay += 1;
        if (r.status === 'settled' || (r.status === 'approved' && r.totals.isFullySettled)) out.settled += 1;
        if (r.status === 'pending') out.pending += 1;
        if (r.status === 'draft') out.draft += 1;
    }
    return out;
}

function bannersHtml() {
    const out = [];
    const pendingList = (ctx.reports || []).filter(r => r.status === 'pending');
    if (isChair() && pendingList.length > 0) {
        out.push(`<div class="buh-card as-banner is-ask" style="display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:16px">
            <div class="as-banner-copy" style="flex:1 1 280px;min-width:220px">
                <b>Чекають затвердження голови: ${pendingList.length} авансових звітів</b>
                <p class="buh-note">${pendingList.map(r => `№ ${escapeHtml(r.number || r.id)} (${escapeHtml(r.personName)} — ${fmtKop(r.totals.spentKop)} грн)`).join(', ')}.</p>
            </div>
            <button type="button" class="sv-btn" style="width:auto;flex:0 0 auto;min-height:44px;padding:0 20px;font-size:14.5px;white-space:nowrap" data-act="pick" data-id="${escapeHtml(pendingList[0].id)}">Переглянути звіт ›</button>
        </div>`);
    }

    const toPay = (ctx.reports || []).filter(r => r.status === 'approved' && (r.totals.pendingReimburseKop || 0) > 0);
    if (toPay.length > 0) {
        const sum = toPay.reduce((s, r) => s + r.totals.pendingReimburseKop, 0);
        const firstUnpaid = toPay.find(r => !r.paymentId) || toPay[0];
        const btnHtml = firstUnpaid.paymentId
            ? `<button type="button" class="sv-btn is-soft" style="width:auto;flex:0 0 auto;min-height:44px;padding:0 20px;font-size:14.5px;white-space:nowrap" data-go="payments">Платіж у Приват24 ›</button>`
            : `<button type="button" class="sv-btn" style="width:auto;flex:0 0 auto;min-height:44px;padding:0 20px;font-size:14.5px;white-space:nowrap" data-act="pay-advance" data-id="${escapeHtml(firstUnpaid.id)}">Створити платіж (${fmtKop(firstUnpaid.totals.pendingReimburseKop)} грн)</button>`;
        out.push(`<div class="buh-card as-banner is-work" style="display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:16px">
            <div class="as-banner-copy" style="flex:1 1 280px;min-width:220px">
                <b>До відшкодування підзвітним особам: ${toPay.length} звітів на суму ${fmtKop(sum)} грн</b>
                <p class="buh-note">Затверджені витрати власних коштів. Створіть платіж у Приват24 на особисту картку підзвітної особи (Дт 372 Кт 311) в один клік.</p>
            </div>
            ${btnHtml}
        </div>`);
    }
    return out.join('');
}

function lineRowHtml(l, idx, allLines = []) {
    const acc = l.postingAcc || '92';
    const isAsset = acc !== '92';
    const autoAssetId = isAsset ? (l.assetId || nextAssetIdForLine(acc, allLines, idx)) : '';
    return `<div class="av-line buh-card is-compact" data-line-idx="${idx}" style="margin:8px 0;padding:12px;background:var(--sv-soft-2,#f4f6f9)">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;margin-bottom:8px">
            <b style="font-size:13.5px">Документ № ${idx + 1}</b>
            <button type="button" class="btn-ghost-small" data-act="remove-line" data-line-idx="${idx}" style="color:#b42318;width:auto;flex:0 0 auto">Видалити рядок ✕</button>
        </div>
        <div class="pay-grid">
            <label class="field"><span class="field-label">Вид документа</span>
                <select class="field-input field-select av-doc-type">${options(ADVANCE_DOC_TYPES, l.docType || 'fiscal_receipt')}</select></label>
            <label class="field"><span class="field-label">№ чека / квитанції</span>
                <input class="field-input av-doc-num" maxlength="60" placeholder="Ч-12345" value="${escapeHtml(l.number || '')}"></label>
            <label class="field"><span class="field-label">Дата чека</span>
                <input class="field-input av-doc-date" type="date" value="${escapeHtml(l.date || ctx.today)}"></label>
            <label class="field"><span class="field-label">Сума за чеком, грн</span>
                <input class="field-input av-amount" inputmode="decimal" placeholder="0,00" value="${money2(l.amountKop || 0)}"></label>
            <label class="field pay-wide"><span class="field-label">Постачальник / магазин</span>
                <input class="field-input av-supplier" maxlength="200" placeholder="АЗС WOG / Епіцентр / Госптовари" value="${escapeHtml(l.supplier || '')}"></label>
            <label class="field"><span class="field-label">Рахунок обліку</span>
                <select class="field-input field-select av-posting">${options(POSTING_ACCOUNTS, acc)}</select></label>
            <label class="field"><span class="field-label">Стаття витрат кошторису (92)</span>
                <select class="field-input field-select av-item">${options(ctx.expenseItems, l.item || 'systems')}</select></label>
            ${isAsset ? `
                <label class="field"><span class="field-label">Інв. / номенкл. код на складі (авто)</span>
                    <input class="field-input av-asset-id" list="avAssetList" maxlength="80" placeholder="Підставляється автоматично" value="${escapeHtml(autoAssetId)}"></label>
                <label class="field"><span class="field-label">Кількість</span>
                    <input class="field-input av-asset-qty" type="number" step="0.001" min="0.001" value="${escapeHtml(String(l.assetQty || 1))}"></label>
                <label class="field"><span class="field-label">Одиниця виміру</span>
                    <select class="field-input field-select av-asset-unit">${UNITS.map(u => `<option value="${escapeHtml(u)}"${u === (l.assetUnit || 'шт.') ? ' selected' : ''}>${escapeHtml(u)}</option>`).join('')}</select></label>
            ` : ''}
            <label class="field pay-wide"><span class="field-label">Що придбано / опис товару</span>
                <input class="field-input av-desc" maxlength="300" placeholder="Бензин А-95 для генератора / замок навісний" value="${escapeHtml(l.desc || '')}"></label>
            <label class="field pay-wide"><span class="field-label">Фото чека або скан (PDF/JPG/PNG)</span>
                <input class="field-input av-file" type="file" multiple accept=".pdf,image/*"></label>
        </div>
        ${(l.files || []).length ? `<p class="buh-note" style="margin-top:6px">Додані файли: ${l.files.map(f => `<a href="${escapeHtml(f.url)}" target="_blank" rel="noopener" class="buh-file">${escapeHtml(f.name)}</a>`).join(' ')}</p>` : ''}
    </div>`;
}

function advanceFormHtml(d = {}) {
    const lines = Array.isArray(d.lines) && d.lines.length ? d.lines : [{
        docType: 'fiscal_receipt', number: '', date: ctx.today, supplier: '', amountKop: 0,
        item: 'systems', postingAcc: '92', assetId: '', assetQty: 1, assetUnit: 'шт.', desc: '', files: []
    }];
    const nextNo = d.number || suggestReportNumber(ctx.period, ctx.reports);
    const peopleList = ctx.people || [];
    const catalog = ctx.assetCatalog || [];

    return `<section class="buh-card ex-form" id="avForm">
        <div class="buh-card-head">
            <h2>${d.isEdit ? `Змінити авансовий звіт № ${escapeHtml(d.number || d.id)}` : 'Новий авансовий звіт (Рахунок 372)'}</h2>
            <button type="button" class="btn-ghost-small" data-act="close-form" style="width:auto;flex:0 0 auto">Закрити</button>
        </div>
        <p class="buh-note">Складається підзвітною особою при придбанні товарів/послуг за власні кошти або за рахунок виданого авансу (Типова форма наказу Мінфіну № 841 / 289, пп. 170.9 ПКУ). При виборі рахунку 20, 22 або 11 інвентарний / номенклатурний номер підставляється автоматично за єдиною системою.</p>
        <div class="pay-grid">
            <label class="field pay-wide"><span class="field-label">Підзвітна особа (працівник або член правління)</span>
                <div style="display:flex;gap:8px">
                    <select id="avPersonSelect" class="field-input field-select">
                        <option value="">Оберіть зі списку або введіть вручну…</option>
                        ${peopleList.map(p => `<option value="${escapeHtml(p.id)}"${p.name === d.personName ? ' selected' : ''}>${escapeHtml(p.name)}${p.code ? ` (${p.code})` : ''}${p.iban ? ` · ${p.iban.slice(-6)}` : ''}</option>`).join('')}
                    </select>
                </div>
            </label>
            <label class="field"><span class="field-label">ПІБ підзвітної особи</span>
                <input id="avPersonName" class="field-input" maxlength="200" placeholder="Коваленко Сергій Миколайович" value="${escapeHtml(d.personName || '')}"></label>
            <label class="field"><span class="field-label">РНОКПП (10 цифр)</span>
                <input id="avPersonCode" class="field-input" inputmode="numeric" maxlength="10" placeholder="1234567890" value="${escapeHtml(d.personCode || '')}"></label>
            <label class="field pay-wide"><span class="field-label">IBAN особистої картки для виплати компенсації</span>
                <input id="avPersonIban" class="field-input" maxlength="34" placeholder="UA…" value="${escapeHtml(d.personIban || '')}"></label>
            <label class="field"><span class="field-label">Номер авансового звіту</span>
                <input id="avNumber" class="field-input" maxlength="60" value="${escapeHtml(nextNo)}"></label>
            <label class="field"><span class="field-label">Дата складання звіту</span>
                <input id="avDate" class="field-input" type="date" value="${escapeHtml(d.date || ctx.today)}"></label>
            <label class="field"><span class="field-label">За звітний місяць</span>
                <input id="avPeriod" class="field-input" type="month" value="${escapeHtml(d.period || ctx.period)}"></label>
            <label class="field"><span class="field-label">Джерело фінансування (48)</span>
                <select id="avFund" class="field-input field-select">${options(Object.fromEntries((ctx.funds || [{ id: 'main', name: 'Основний фонд' }]).map(f => [f.id, f.name])), d.fundId || 'main')}</select></label>
            <label class="field pay-wide"><span class="field-label">Призначення авансу / підзвітних сум</span>
                <input id="avPurpose" class="field-input" maxlength="300" placeholder="Закупівля палива для генератора та замків підвалу" value="${escapeHtml(d.purpose || '')}"></label>
            <label class="field"><span class="field-label">Одержано аванс з рахунку ОСББ, грн</span>
                <input id="avAdvance" class="field-input" inputmode="decimal" placeholder="0,00" value="${money2(d.advanceKop || 0)}"></label>
        </div>
        <datalist id="avAssetList">${catalog.map(a => `<option value="${escapeHtml(a.id)}">${escapeHtml(a.name)}${a.legacyId ? ` (стар. № ${escapeHtml(a.legacyId)})` : ''}</option>`).join('')}</datalist>
        <div style="margin-top:16px">
            <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:8px">
                <h3 style="font-size:16px;margin:0">Підтвердні документи (чеки, квитанції, накладні)</h3>
                <button type="button" class="sv-btn is-soft" style="width:auto;flex:0 0 auto;min-height:38px;padding:0 16px;font-size:13.5px" data-act="add-line">+ Додати чек</button>
            </div>
            <div id="avLinesList">${lines.map((l, idx) => lineRowHtml(l, idx, lines)).join('')}</div>
        </div>
        <div class="pay-form-actions" style="margin-top:16px">
            <button type="button" class="sv-btn" style="width:auto" data-act="save-report">${d.id ? 'Зберегти зміни' : isChair() ? 'Зберегти й затвердити' : 'Подати на затвердження голові'}</button>
        </div>
    </section>`;
}

function reportRowHtml(r) {
    const t = r.totals;
    const [statusText, statusCls] = ADVANCE_STATUS_LABELS[r.status] || [r.status, ''];

    return `<li><button type="button" class="fl-item dc-item${r.id === selected ? ' is-current' : ''}" data-act="pick" data-id="${escapeHtml(r.id)}" aria-current="${r.id === selected}">
        <span class="fl-copy">
            <b>№ ${escapeHtml(r.number || r.id)} · ${escapeHtml(r.personName)}</b>
            <small>${escapeHtml(human(r.date))} · ${escapeHtml(r.purpose || 'господарські потреби')}</small>
        </span>
        <span class="dc-right">
            <b class="fl-sum">${fmtKop(t.spentKop)} грн</b>
            <span class="sv-chip ${statusCls}">${escapeHtml(statusText)}</span>
        </span>
    </button></li>`;
}

function detailCardHtml(r, empty) {
    if (!r) {
        return `<div class="fl-empty"><b>${empty ? 'Авансових звітів ще немає' : 'Оберіть авансовий звіт'}</b>
            <span>Тут відображається розрахунок витрат підзвітної особи, перелік підтвердних чеків, формування виплати компенсації через Приват24 та друк офіційної форми Мінфіну № 841 / 289.</span></div>`;
    }
    const t = r.totals;
    const [statusText, statusCls] = ADVANCE_STATUS_LABELS[r.status] || [r.status, ''];
    const fundName = (ctx.funds || []).find(f => f.id === r.fundId)?.name || r.fundId;

    const summaryRows = [
        ['Номер та дата звіту', `№ ${r.number || r.id} від ${human(r.date)}`],
        ['Підзвітна особа', `${r.personName}${r.personCode ? ` (РНОКПП ${r.personCode})` : ''}`],
        ['Картка для компенсації', r.personIban ? `IBAN ${r.personIban}` : 'не вказано'],
        ['Звітний період', periodName(r.period)],
        ['Цільовий фонд (48)', fundName],
        ['Призначення підзвітних сум', r.purpose || 'господарські потреби'],
        ['Одержано аванс', `${fmtKop(t.advanceKop)} грн`],
        ['Витрачено за чеками', `${fmtKop(t.spentKop)} грн`],
        ...(t.reimburseKop > 0 ? [
            ['Перевитрата (до відшкодування)', `${fmtKop(t.reimburseKop)} грн`],
            ['Фактично відшкодовано', t.reimbursedKop > 0 ? `${fmtKop(t.reimbursedKop)} грн` : r.paymentId ? 'платіж створено в Приват24 (очікує проведення)' : 'ще не виплачено'],
            ['Залишок до виплати', t.pendingReimburseKop > 0 ? `${fmtKop(t.pendingReimburseKop)} грн` : 'повністю виплачено']
        ] : []),
        ...(t.returnKop > 0 ? [
            ['Невикористаний аванс (до повернення)', `${fmtKop(t.returnKop)} грн`],
            ['Фактично повернуто на рахунок', t.returnedKop > 0 ? `${fmtKop(t.returnedKop)} грн` : 'очікується повернення'],
            ['Залишок до повернення', t.pendingReturnKop > 0 ? `${fmtKop(t.pendingReturnKop)} грн` : 'повністю повернуто']
        ] : []),
        ...(r.approvedBy ? [['Затвердив', `${r.approvedBy} (${human(r.approvedAt)})`]] : []),
        ...(r.comment ? [['Примітка', r.comment]] : [])
    ];

    const actions = [];
    const btn = (act, label, soft = false, extra = '') =>
        `<button type="button" class="sv-btn${soft || actions.length ? ' is-soft' : ''}" data-act="${act}" data-id="${escapeHtml(r.id)}"${extra}>${label}</button>`;

    if (r.status === 'pending' && isChair()) {
        actions.push(btn('approve-report', 'Затвердити звіт'));
        actions.push(btn('reject-report', 'Відхилити', true));
    }
    if (r.status === 'approved' && t.pendingReimburseKop > 0) {
        if (r.paymentId) {
            actions.push(`<button type="button" class="sv-btn is-soft" data-go="payments">Перейти в «Платежі» (очікує підпису) ›</button>`);
        } else {
            actions.push(btn('pay-advance', `Створити платіж у Приват24 (${fmtKop(t.pendingReimburseKop)} грн)`));
        }
    }
    actions.push(btn('print-advance', 'Друк авансового звіту (№ 841)', true));
    if (['draft', 'pending', 'rejected'].includes(r.status) || (r.status === 'approved' && t.reimbursedKop === 0)) {
        actions.push(btn('edit-report', 'Змінити звіт', true));
    }

    return `<div class="fl-card-head">
            <div>
                <span class="fl-facts">Авансовий звіт · Рахунок 372 · ${human(r.date)}</span>
                <h2>№ ${escapeHtml(r.number || r.id)} — ${escapeHtml(r.personName)}</h2>
                <span class="dc-amount">${fmtKop(t.spentKop)} грн</span>
            </div>
            <span class="sv-chip ${statusCls}">${escapeHtml(statusText)}</span>
        </div>
        <div class="as-wear-box">
            <div class="as-wear-nums">
                <div><span>Витрачено за чеками</span><b>${fmtKop(t.spentKop)} грн</b></div>
                <div><span>Одержано аванс</span><b>${fmtKop(t.advanceKop)} грн</b></div>
                <div><span>${t.reimburseKop > 0 ? 'Перевитрата (ОСББ винне)' : 'Залишок (до повернення)'}</span><b style="color:${t.reimburseKop > 0 ? '#0068cf' : '#16a34a'}">${fmtKop(t.reimburseKop > 0 ? t.reimburseKop : t.returnKop)} грн</b></div>
            </div>
        </div>
        <dl class="dc-fields">${summaryRows.map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(String(v))}</dd>`).join('')}</dl>
        <div class="dc-chain">
            <h3 class="chs-h">Реєстр підтвердних чеків та документів (${(r.lines || []).length})</h3>
            <table class="buh-table is-compact">
                <thead><tr><th>№</th><th>Документ</th><th>Постачальник і товар</th><th>Рахунок</th><th class="t-sum">Сума</th></tr></thead>
                <tbody>${(r.lines || []).map((l, i) => `<tr>
                    <td>${i + 1}</td>
                    <td><b>${escapeHtml(ADVANCE_DOC_TYPES[l.docType] || l.docType)}</b><br><small>№ ${escapeHtml(l.number || '—')} від ${human(l.date)}</small></td>
                    <td><b>${escapeHtml(l.supplier || '—')}</b><br><small>${escapeHtml(l.desc || '')}${l.assetId ? ` · [${escapeHtml(l.assetId)}]` : ''}</small>
                        ${(l.files || []).length ? `<br><small>${l.files.map(f => `<a href="${escapeHtml(f.url)}" target="_blank" rel="noopener" class="buh-file">${escapeHtml(f.name)}</a>`).join(' ')}</small>` : ''}</td>
                    <td>${escapeHtml(l.postingAcc || '92')}${l.assetId ? `<br><small>${escapeHtml(l.assetId)}</small>` : ''}</td>
                    <td class="t-sum"><b>${fmtKop(l.amountKop)} грн</b></td>
                </tr>`).join('')}</tbody>
            </table>
        </div>
        <div class="fl-actions">${actions.join('')}</div>`;
}

async function printAdvanceReport(r) {
    const req = await loadRequisites().catch(() => ({}));
    const orgName = req?.payeeName || req?.recipientName || 'ОСББ «Успіх-25»';
    const edrpou = req?.edrpou || '40562894';
    const t = r.totals;
    const fundName = (ctx.funds || []).find(f => f.id === r.fundId)?.name || r.fundId || 'Основний фонд';
    const win = window.open('', '_blank', 'width=940,height=800');
    if (!win) { toast('Дозвольте спливаючі вікна для друку звіту', 'error'); return; }

    win.document.write(`<!DOCTYPE html><html lang="uk"><head><meta charset="UTF-8"><title>Авансовий звіт № ${escapeHtml(r.number || r.id)}</title>
        <style>
            body { font-family: "Times New Roman", Georgia, serif; color: #111; margin: 20px 28px; font-size: 11pt; line-height: 1.35; }
            .head-grid { display: flex; justify-content: space-between; gap: 20px; margin-bottom: 12px; font-size: 10pt; }
            h1 { font-size: 13pt; text-align: center; margin: 10px 0 4px; text-transform: uppercase; }
            h2 { font-size: 11pt; text-align: center; margin: 0 0 14px; font-weight: normal; }
            table { width: 100%; border-collapse: collapse; margin: 10px 0; font-size: 10pt; }
            th, td { border: 1px solid #222; padding: 4px 6px; text-align: left; vertical-align: top; }
            th { background: #f3f4f6; font-weight: bold; }
            .num { text-align: right; white-space: nowrap; }
            .signs { margin-top: 20px; display: grid; grid-template-columns: 1fr 1fr; gap: 14px 24px; font-size: 10pt; }
            .sign-line { border-bottom: 1px solid #222; min-height: 18px; margin-top: 12px; }
            .no-print { margin-bottom: 14px; padding: 8px 12px; background: #eef4ff; border-radius: 8px; font-family: sans-serif; display: flex; justify-content: space-between; align-items: center; }
            .no-print button { padding: 6px 14px; font-weight: 600; cursor: pointer; border-radius: 6px; border: 1px solid #1d4ed8; background: #1d4ed8; color: #fff; }
            @media print { .no-print { display: none; } body { margin: 8mm 12mm; } }
        </style></head><body>
        <div class="no-print"><span>Типова форма наказу Мінфіну України № 841 (у редакції № 289 від 09.05.2023)</span><button onclick="window.print()">Друкувати / Зберегти PDF</button></div>
        <div class="head-grid">
            <div><b>Підприємство / установа:</b> ${escapeHtml(orgName)}<br><b>Код за ЄДРПОУ:</b> ${escapeHtml(edrpou)}<br><b>Підзвітна особа:</b> ${escapeHtml(r.personName)}${r.personCode ? `<br><b>РНОКПП:</b> ${escapeHtml(r.personCode)}` : ''}</div>
            <div style="text-align:right"><b>ЗАТВЕРДЖУЮ</b><br>Звіт у сумі: <b>${fmtKop(t.spentKop)} грн</b><br>Голова правління ${escapeHtml(orgName)}<br>___________________ / ___________________ /<br>«___» ________________ 20___ р.</div>
        </div>
        <h1>ЗВІТ ПРО ВИКОРИСТАННЯ КОШТІВ / ЕЛЕКТРОННИХ ГРОШЕЙ, ВИДАНИХ НА ВІДРЯДЖЕННЯ АБО ПІД ЗВІТ</h1>
        <h2>№ ${escapeHtml(r.number || r.id)} від ${escapeHtml(human(r.date))} · Призначення: ${escapeHtml(r.purpose || 'господарські потреби')}</h2>
        <table>
            <thead><tr><th colspan="2">Рух підзвітних коштів</th><th class="num">Сума, грн</th><th colspan="2">Бухгалтерський запис</th><th class="num">Сума, грн</th></tr></thead>
            <tbody>
                <tr><td>1</td><td>Залишок попереднього авансу</td><td class="num">0,00</td><td>Дебет рахунку</td><td>372</td><td class="num">${fmtKop(t.reimburseKop)}</td></tr>
                <tr><td>2</td><td>Одержано під звіт (з рахунку ОСББ)</td><td class="num">${fmtKop(t.advanceKop)}</td><td>Кредит рахунку</td><td>311</td><td class="num">${fmtKop(t.advanceKop || t.reimburseKop)}</td></tr>
                <tr><td>3</td><td><b>Витрачено всього за звітом</b></td><td class="num"><b>${fmtKop(t.spentKop)}</b></td><td>Дебет рахунків витрат/ТМЦ</td><td>92 / 20 / 22</td><td class="num">${fmtKop(t.spentKop)}</td></tr>
                <tr><td>4</td><td><b>Перевитрата (до відшкодування)</b></td><td class="num"><b>${fmtKop(t.reimburseKop)}</b></td><td>Кредит субрахунку</td><td>372</td><td class="num">${fmtKop(t.spentKop)}</td></tr>
                <tr><td>5</td><td>Залишок невикористаного авансу</td><td class="num">${fmtKop(t.returnKop)}</td><td>Цільовий фонд</td><td>${escapeHtml(fundName)}</td><td class="num">${fmtKop(t.spentKop)}</td></tr>
            </tbody>
        </table>
        <h3 style="font-size:11pt;margin:14px 0 6px">Зворотний бік: Реєстр підтвердних документів</h3>
        <table>
            <thead><tr><th>№</th><th>Дата док.</th><th>Номер док.</th><th>Кому, за що сплачено</th><th>Рахунок</th><th class="num">Сума, грн</th></tr></thead>
            <tbody>${(r.lines || []).map((l, idx) => `<tr>
                <td>${idx + 1}</td>
                <td>${escapeHtml(human(l.date))}</td>
                <td>${escapeHtml(l.number || '—')}</td>
                <td>${escapeHtml(l.supplier || '')}${l.desc ? ` — ${escapeHtml(l.desc)}` : ''}</td>
                <td>${escapeHtml(l.postingAcc || '92')}${l.assetId ? ` (${escapeHtml(l.assetId)})` : ''}</td>
                <td class="num">${fmtKop(l.amountKop)}</td>
            </tr>`).join('')}</tbody>
            <tfoot><tr><th colspan="5">РАЗОМ за доданими документами:</th><th class="num">${fmtKop(t.spentKop)}</th></tr></tfoot>
        </table>
        <div class="signs">
            <div>Підпис підзвітної особи:<div class="sign-line"></div>«___» ________________ 20___ р.</div>
            <div>Звіт перевірив бухгалтер:<div class="sign-line"></div>«___» ________________ 20___ р.</div>
        </div>
        <p style="font-size:9.5pt;margin-top:16px;border-top:1px dashed #666;padding-top:8px"><b>Розписка бухгалтера:</b> Звіт № ${escapeHtml(r.number || r.id)} прийнято від ${escapeHtml(r.personName)} на суму ${fmtKop(t.spentKop)} грн з додаванням підтвердних документів у кількості ${(r.lines || []).length} шт. Перевитрата в сумі ${fmtKop(t.reimburseKop)} грн підлягає виплаті на картку підзвітної особи.</p>
    </body></html>`);
    win.document.close();
}

function exportCsv() {
    const csvCell = v => (/[;"\r\n]/.test(String(v ?? '')) ? `"${String(v ?? '').replace(/"/g, '""')}"` : String(v ?? ''));
    const csvKop = k => ((Number(k || 0)) / 100).toFixed(2).replace('.', ',');
    const rows = [[
        'Номер звіту', 'Дата', 'Період', 'Підзвітна особа', 'РНОКПП', 'IBAN картки',
        'Призначення', 'Аванс (грн)', 'Витрачено (грн)', 'Перевитрата до виплати (грн)',
        'Невикористаний аванс (грн)', 'Статус', 'Кількість документів'
    ]];
    for (const r of ctx.reports || []) {
        const t = r.totals;
        rows.push([
            r.number || r.id, r.date, r.period, r.personName, r.personCode || '', r.personIban || '',
            r.purpose || '', csvKop(t.advanceKop), csvKop(t.spentKop), csvKop(t.reimburseKop),
            csvKop(t.returnKop), r.status, (r.lines || []).length
        ]);
    }
    const blob = new Blob(['\uFEFF' + rows.map(r => r.map(csvCell).join(';')).join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `advance-reports-${ctx.period}.csv`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

function renderAdvanceView() {
    if (!ctx) return 0;
    const list = filterReports(ctx.reports);
    if (!list.some(r => r.id === selected)) {
        selected = window.matchMedia('(max-width: 900px)').matches ? null : list[0]?.id || null;
    }
    const cur = (ctx.reports || []).find(r => r.id === selected) || null;
    const counts = tabCounts(ctx.reports);
    const s = ctx.summary;
    const host = document.getElementById('viewAdvance');
    if (!host) return 0;

    host.innerHTML = `
        <div class="as-top-bar">
            <div class="as-period-row">
                <select id="avPeriodSelect" class="field-input field-select ch-period" aria-label="Період">${(ctx.periods || []).slice().reverse().map(p =>
                    `<option value="${escapeHtml(p.id)}"${p.id === ctx.period ? ' selected' : ''}>${escapeHtml(periodName(p.id))}${p.status === 'closed' ? ' · закрито' : ''}</option>`).join('')}</select>
            </div>
            <div class="buh-toolbar as-toolbar-right">
                <span class="ch-tools">
                    <button type="button" class="sv-btn" style="width:auto;min-height:38px;padding:0 18px;font-size:13.5px" data-act="new-report">+ Авансовий звіт</button>
                    <button type="button" class="btn-ghost-small" data-act="export-csv">Реєстр у CSV</button>
                    <button type="button" class="btn-ghost-small" data-go="journal">В ОСВ (рах. 372) ›</button>
                </span>
            </div>
        </div>
        <div class="kpi-grid">
            <div class="kpi">
                <span>До відшкодування (ОСББ винне)</span>
                <b>${fmtKop(s.totalPendingReimburseKop)}</b>
                <small>кредиторська заборгованість 372 (ряд. 1690 Балансу)</small>
            </div>
            <div class="kpi">
                <span>Неповернені аванси (борг перед ОСББ)</span>
                <b>${fmtKop(s.totalPendingReturnKop)}</b>
                <small>дебіторська заборгованість 372 (ряд. 1155 Балансу)</small>
            </div>
            <div class="kpi">
                <span>Витрачено за чеками за ${escapeHtml(periodName(ctx.period))}</span>
                <b>${fmtKop(s.totalSpentPeriodKop)}</b>
                <small>затверджені витрати підзвітних осіб</small>
            </div>
            <div class="kpi">
                <span>Звітів на розгляді</span>
                <b>${s.pendingCount}</b>
                <small>${s.toReimburseCount > 0 ? `${s.toReimburseCount} чекають виплати в банк` : 'усі витрати погоджено'}</small>
            </div>
        </div>
        ${bannersHtml()}
        <div class="fl-filters dc-tabs" role="tablist">
            ${Object.entries(TABS).map(([k, v]) =>
                `<button type="button" class="fl-filter${k === segment ? ' active' : ''}" role="tab" aria-selected="${k === segment}" data-seg="${k}">${escapeHtml(v)} <span>${counts[k] || 0}</span></button>`).join('')}
        </div>
        ${form ? advanceFormHtml(form.data) : ''}
        <div class="fl-grid dc-grid">
            <section class="fl-list" aria-label="Авансові звіти">
                <label class="fl-search dc-search">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>
                    <input type="search" id="avQuery" placeholder="Номер, ПІБ, чек, інв. код, призначення…" value="${escapeHtml(query)}" aria-label="Пошук авансового звіту">
                </label>
                ${list.length
                    ? `<ul class="fl-items">${list.map(reportRowHtml).join('')}</ul>`
                    : `<p class="list-empty">${query ? 'За запитом нічого не знайдено' : 'У цій вкладці немає звітів. Натисніть «+ Авансовий звіт», щоб зареєструвати витрати за чеками працівника або голови.'}</p>`}
            </section>
            <section class="fl-card dc-card${cur || !list.length ? '' : ' is-idle'}" id="avCard" aria-live="polite">
                ${detailCardHtml(cur, !list.length)}
            </section>
        </div>
        <p class="buh-note as-footer-note">Рахунок 372 «Розрахунки з підзвітними особами». Наказ Мінфіну № 841 (у редакції № 289), пп. 170.9 ПКУ.</p>`;

    return (s.pendingCount || 0) + (s.toReimburseCount || 0);
}

export async function loadAdvanceView() {
    ctx = await loadAdvance(period);
    period = ctx.period;
    return renderAdvanceView();
}

function snapshotFormData() {
    const lines = [];
    const container = document.getElementById('avLinesList');
    if (container) {
        container.querySelectorAll('.av-line').forEach(el => {
            const idx = Number(el.dataset.lineIdx);
            const oldLine = form?.data?.lines?.[idx] || {};
            const postingAcc = el.querySelector('.av-posting')?.value || '92';
            const assetInputEl = el.querySelector('.av-asset-id');
            let assetId = assetInputEl ? assetInputEl.value.trim() : (oldLine.assetId || '');
            if (postingAcc === '92') {
                assetId = '';
            } else {
                const expectedPrefix = postingAcc === '11' ? 'МНМА-' : postingAcc === '22' ? 'МШП-' : 'ТМЦ-';
                const prevAcc = oldLine.postingAcc || '92';
                if (!assetId || (prevAcc !== postingAcc && /^(ОЗ|МНМА|ТМЦ|МШП)-\d+$/i.test(assetId) && !assetId.toUpperCase().startsWith(expectedPrefix))) {
                    assetId = nextAssetIdForLine(postingAcc, lines, -1);
                }
            }
            lines.push({
                ...oldLine,
                docType: el.querySelector('.av-doc-type')?.value || 'fiscal_receipt',
                number: el.querySelector('.av-doc-num')?.value?.trim() || '',
                date: el.querySelector('.av-doc-date')?.value || ctx.today,
                amountKop: toKop(el.querySelector('.av-amount')?.value) || 0,
                supplier: el.querySelector('.av-supplier')?.value?.trim() || '',
                postingAcc,
                item: el.querySelector('.av-item')?.value || 'systems',
                assetId,
                assetQty: Number(el.querySelector('.av-asset-qty')?.value || oldLine.assetQty || 1),
                assetUnit: el.querySelector('.av-asset-unit')?.value || oldLine.assetUnit || 'шт.',
                desc: el.querySelector('.av-desc')?.value?.trim() || '',
                files: oldLine.files || []
            });
        });
    }
    return {
        ...(form?.data || {}),
        personName: val('avPersonName'),
        personCode: val('avPersonCode'),
        personIban: val('avPersonIban'),
        number: val('avNumber'),
        date: val('avDate'),
        period: val('avPeriod'),
        fundId: val('avFund'),
        purpose: val('avPurpose'),
        advanceKop: toKop(val('avAdvance')) || 0,
        lines
    };
}

async function saveReport(btn) {
    const formData = snapshotFormData();
    if (!formData.lines.length) {
        toast('Додайте хоча б один чек чи квитанцію', 'error');
        return;
    }
    setBusy(btn, true, 'Зберігаю звіт…');
    try {
        const fileInputs = document.querySelectorAll('#avLinesList .av-file');
        for (let i = 0; i < fileInputs.length; i++) {
            const fi = fileInputs[i];
            if (fi.files?.length) {
                const uploaded = await uploadExpenseFiles([...fi.files]);
                formData.lines[i].files = [...(formData.lines[i].files || []), ...uploaded];
            }
        }
        const r = await advanceAct({
            action: 'saveAdvanceReport',
            ...formData,
            id: form.data?.id || null,
            approve: isChair()
        });
        form = null;
        selected = r.id;
        toast(r.status === 'approved' ? 'Авансовий звіт затверджено' : 'Авансовий звіт збережено й надіслано на затвердження голові', 'success');
        await loadAdvanceView();
    } catch (e) { toast(e.message, 'error'); }
    finally { if (btn.isConnected) setBusy(btn, false); }
}

export async function reimburseReport(r) {
    const pc = await loadPaymentContext();
    const account = defaultAccount(pc.accounts || []);
    if (!account) throw new Error('Банк не підключено — немає рахунку ОСББ, з якого платити (перевірте «Налаштування»)');
    const res = await advanceAct({ action: 'reimburseAdvanceReport', id: r.id, account });
    toast(`Платіж на ${fmtKop(res.amountKop)} грн відправлено в Приват24 на підпис голови`, 'success');
    return res;
}

export function initAdvanceView() {
    const host = document.getElementById('viewAdvance');
    if (!host) return;

    host.addEventListener('click', async e => {
        const seg = e.target.closest('[data-seg]');
        if (seg) { segment = seg.dataset.seg; form = null; renderAdvanceView(); return; }
        const btn = e.target.closest('[data-act]');
        if (!btn || btn.disabled) return;
        const a = btn.dataset.act;
        const id = btn.dataset.id || selected;
        const report = (ctx?.reports || []).find(x => x.id === id);

        if (a === 'pick') {
            selected = btn.dataset.id;
            renderAdvanceView();
            if (window.matchMedia('(max-width: 900px)').matches) document.getElementById('avCard')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
            return;
        }
        if (a === 'close-form') { form = null; renderAdvanceView(); return; }
        if (a === 'new-report') {
            form = { isEdit: false, data: { date: ctx.today, period: ctx.period, lines: [{ docType: 'fiscal_receipt', date: ctx.today, amountKop: 0, postingAcc: '92', item: 'systems' }] } };
            renderAdvanceView();
            document.getElementById('avForm')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
            return;
        }
        if (a === 'edit-report' && report) {
            form = { isEdit: true, data: { ...report } };
            renderAdvanceView();
            document.getElementById('avForm')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
            return;
        }
        if (a === 'add-line') {
            const current = snapshotFormData();
            current.lines.push({ docType: 'fiscal_receipt', number: '', date: current.date || ctx.today, supplier: '', amountKop: 0, item: 'systems', postingAcc: '92' });
            form = { ...form, data: current };
            renderAdvanceView();
            return;
        }
        if (a === 'remove-line') {
            const lineIdx = Number(btn.dataset.lineIdx);
            const current = snapshotFormData();
            if (current.lines.length > 1) {
                current.lines.splice(lineIdx, 1);
                form = { ...form, data: current };
                renderAdvanceView();
            } else {
                toast('У звіті має бути щонайменше один документ', 'info');
            }
            return;
        }
        if (a === 'save-report') await saveReport(btn);
        else if (a === 'approve-report' && report) {
            setBusy(btn, true, 'Затверджую…');
            try {
                await advanceAct({ action: 'approveAdvanceReport', id: report.id });
                toast('Авансовий звіт затверджено', 'success');
                await loadAdvanceView();
            } catch (err) { toast(err.message, 'error'); }
            finally { if (btn.isConnected) setBusy(btn, false); }
        } else if (a === 'reject-report' && report) {
            const comment = prompt('Причина відхилення авансового звіту:');
            if (!comment) return;
            setBusy(btn, true, 'Відхиляю…');
            try {
                await advanceAct({ action: 'rejectAdvanceReport', id: report.id, comment });
                toast('Авансовий звіт відхилено', 'info');
                await loadAdvanceView();
            } catch (err) { toast(err.message, 'error'); }
            finally { if (btn.isConnected) setBusy(btn, false); }
        } else if (a === 'pay-advance' && report) {
            if (!report.personIban || !/^UA\d{27}$/.test(String(report.personIban).replace(/\s+/g, ''))) {
                toast('Спочатку вкажіть IBAN особистої картки та РНОКПП підзвітної особи у звіті', 'error');
                form = { isEdit: true, data: { ...report } };
                renderAdvanceView();
                document.getElementById('avPersonIban')?.focus();
                return;
            }
            if (!report.personCode || !/^\d{10}$/.test(String(report.personCode).trim())) {
                toast('Для банківського платежу в Приват24 вкажіть РНОКПП (10 цифр) підзвітної особи', 'error');
                form = { isEdit: true, data: { ...report } };
                renderAdvanceView();
                document.getElementById('avPersonCode')?.focus();
                return;
            }
            if (!await confirmDialog(
                `Виплатити компенсацію ${fmtKop(report.totals.pendingReimburseKop)} грн?`,
                `Підзвітній особі: ${report.personName} на картку ${report.personIban || '—'}. Платіж зʼявиться в Приват24 на підпис голови.`,
                'Виплатити'
            )) return;
            setBusy(btn, true, 'Створюю платіж…');
            try {
                await reimburseReport(report);
                await loadAdvanceView();
            } catch (err) { toast(err.message, 'error'); }
            finally { if (btn.isConnected) setBusy(btn, false); }
        } else if (a === 'print-advance' && report) {
            await printAdvanceReport(report);
        } else if (a === 'export-csv') {
            exportCsv();
        }
    });

    host.addEventListener('change', e => {
        if (e.target.id === 'avPeriodSelect') {
            period = e.target.value;
            form = null;
            loadAdvanceView();
            return;
        }
        if (e.target.id === 'avPersonSelect' && form) {
            const selectedPerson = (ctx?.people || []).find(p => p.id === e.target.value);
            if (selectedPerson) {
                if (document.getElementById('avPersonName')) document.getElementById('avPersonName').value = selectedPerson.name;
                if (document.getElementById('avPersonCode')) document.getElementById('avPersonCode').value = selectedPerson.code || '';
                if (document.getElementById('avPersonIban')) document.getElementById('avPersonIban').value = selectedPerson.iban || '';
            }
        }
        if (e.target.classList.contains('av-posting') && form) {
            form = { ...form, data: snapshotFormData() };
            renderAdvanceView();
        }
    });

    host.addEventListener('input', e => {
        if (e.target.id === 'avQuery') {
            query = e.target.value;
            const pos = e.target.selectionStart;
            renderAdvanceView();
            const input = document.getElementById('avQuery');
            input?.focus();
            input?.setSelectionRange(pos, pos);
        }
    });
}
