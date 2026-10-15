// ============================================================
// «Майно та ТМЦ»: Інвентарна книга основних засобів (10) та МНМА (11),
// складський облік виробничих запасів (20) та МШП (22), оперативний
// позабалансовий кількісний облік МШП в експлуатації за матеріально
// відповідальними особами (МВО), щомісячна амортизація та друковані
// первинні акти (ОЗ-1, ОЗ-3, Акт списання ТМЦ/МШП, Інвентаризаційний опис).
//
// Принцип: «Система пропонує — людина підтверджує».
// ============================================================
import { session } from './firebase.js';
import { escapeHtml, toast, setBusy, confirmDialog } from './ui.js';
import { loadAssets, assetsAct, loadRequisites } from './buh-data.js';
import { fmtKop, toKop, periodName } from './charges-core.js';
import {
    ASSET_ACCOUNTS, ASSET_SUBACCOUNTS, DEPR_METHODS, UNITS,
    isNonCurrent, isInventory, defaultSubacc, defaultDeprMethod,
    suggestAssetId
} from './assets-core.js';
import { openExpenses } from './buh-expenses.js';

const TABS = {
    all: 'Усі',
    oz: 'Основні засоби (10)',
    mnhma: 'МНМА (11)',
    stock: 'Запаси (20)',
    mshp: 'МШП та інвентар (22)',
    disposed: 'Списані / архів'
};

let period = null;
let ctx = null;
let segment = 'all';
let selected = null;
let query = '';
let form = null; // { kind: 'card'|'commission'|'writeoff'|'dispose'|'retire-mshp', data }

const isChair = () => session.role === 'chair';
const human = d => (d ? String(d).split('-').reverse().join('.') : '—');
const money2 = k => (k ? (k / 100).toFixed(2).replace('.', ',') : '');
const val = id => document.getElementById(id)?.value?.trim() ?? '';
const options = (map, cur) => Object.entries(map).map(([k, v]) =>
    `<option value="${escapeHtml(k)}"${String(k) === String(cur) ? ' selected' : ''}>${escapeHtml(typeof v === 'object' ? v.title : v)}</option>`).join('');

export function openAssets(seg = 'all', assetId = null, prefillForm = null) {
    if (TABS[seg]) segment = seg;
    if (assetId) selected = assetId;
    if (prefillForm) form = prefillForm;
    if (location.hash !== '#assets') location.hash = 'assets';
    else loadAssetsView();
}

export async function runMonthlyDepreciation(targetPeriod) {
    const r = await assetsAct({ action: 'depreciateMonth', period: targetPeriod });
    if (r.count > 0) {
        toast(`Нараховано амортизацію за ${periodName(r.period)}: ${r.count} об. на ${fmtKop(r.totalKop)} грн`, 'success');
    } else {
        toast('За цей місяць амортизацію вже нараховано для всіх обʼєктів', 'info');
    }
    return r;
}

function matchesTab(a, tab) {
    if (tab === 'disposed') return a.status === 'disposed';
    if (a.status === 'disposed') return false;
    if (tab === 'oz') return a.acc === '10';
    if (tab === 'mnhma') return a.acc === '11';
    if (tab === 'stock') return a.acc === '20';
    if (tab === 'mshp') return a.acc === '22';
    return true;
}

function filterItems(list) {
    const q = query.trim().toLowerCase();
    return (list || []).filter(a => {
        if (!matchesTab(a, segment)) return false;
        if (!q) return true;
        return [a.id, a.name, a.custodian, a.location, a.serialNumber, a.supplierName, a.subacc]
            .filter(Boolean).join(' ').toLowerCase().includes(q);
    });
}

function tabCounts(list) {
    const out = { all: 0, oz: 0, mnhma: 0, stock: 0, mshp: 0, disposed: 0 };
    for (const a of list || []) {
        if (a.status === 'disposed') { out.disposed += 1; continue; }
        out.all += 1;
        if (a.acc === '10') out.oz += 1;
        else if (a.acc === '11') out.mnhma += 1;
        else if (a.acc === '20') out.stock += 1;
        else if (a.acc === '22') out.mshp += 1;
    }
    return out;
}

function bannersHtml() {
    const out = [];
    const plan = ctx.deprPlan;
    if (ctx.status === 'open' && plan?.items?.length > 0) {
        out.push(`<div class="buh-card as-banner is-work" style="display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:16px">
            <div class="as-banner-copy" style="flex:1 1 280px;min-width:220px">
                <b>Регламентна амортизація за ${escapeHtml(periodName(ctx.period))}: ${fmtKop(plan.totalKop)} грн (${plan.items.length} об.)</b>
                <p class="buh-note">Проводка: <b>Дт 92 Кт 131/132</b> та одночасно <b>Дт 48 Кт 719</b> (визнання доходу цільового фінансування в сумі нарахованого зносу за п. 18 НП(С)БО 15): ${plan.items.map(i => `${escapeHtml(i.id)} «${escapeHtml(i.name)}» — ${fmtKop(i.kop)} грн`).join('; ')}.</p>
            </div>
            <button type="button" class="sv-btn" style="width:auto;flex:0 0 auto;min-height:44px;padding:0 20px;font-size:14.5px;white-space:nowrap" data-act="depreciate-month">Нарахувати амортизацію (${fmtKop(plan.totalKop)} грн)</button>
        </div>`);
    }
    const uncomm = ctx.items.filter(a => isNonCurrent(a.acc) && a.status === 'uncommissioned' && a.costKop > 0);
    if (uncomm.length > 0) {
        out.push(`<div class="buh-card as-banner is-ask" style="display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:16px">
            <div class="as-banner-copy" style="flex:1 1 280px;min-width:220px">
                <b>Очікують введення в експлуатацію (Акт ОЗ-1): ${uncomm.length} об.</b>
                <p class="buh-note">Майно вже оприбутковане на баланс за документом постачальника, але ще не введене в експлуатацію: ${uncomm.map(a => `<b>${escapeHtml(a.id)}</b> «${escapeHtml(a.name)}» (${fmtKop(a.costKop)} грн)`).join(', ')}.</p>
            </div>
            <button type="button" class="sv-btn" style="width:auto;flex:0 0 auto;min-height:44px;padding:0 20px;font-size:14.5px;white-space:nowrap" data-act="open-commission" data-id="${escapeHtml(uncomm[0].id)}">Ввести в експлуатацію ›</button>
        </div>`);
    }
    return out.join('');
}

function cardFormHtml(d = {}) {
    const acc = d.acc || '10';
    const subOpts = Object.fromEntries(Object.entries(ASSET_SUBACCOUNTS).filter(([, v]) => v.acc === acc));
    const nextCode = d.id || suggestAssetId(acc, (ctx.items || []).map(x => x.id));
    const nonCurr = isNonCurrent(acc);
    const limitGrn = ((ctx.mnhmaLimitKop || 2000000) / 100).toLocaleString('uk-UA');
    return `<section class="buh-card ex-form" id="asForm">
        <div class="buh-card-head"><h2>${d.isEdit ? `Картка активу ${escapeHtml(d.id)}` : 'Нова картка ОЗ, МНМА або ТМЦ'}</h2><button type="button" class="btn-ghost-small" data-act="close-form">Закрити</button></div>
        <p class="buh-note">Вартісний поріг МНМА за Обліковою політикою (пп. 14.1.138 ПКУ): <b>${limitGrn} грн</b>. Придбання за рахунком або накладною постачальника проводьте через розділ «Документи» (там створюється проводка Дт 10/11/20/22 Кт 631). Тут можна відредагувати паспортні дані картки, МВО або оприбуткувати безоплатно отримане майно ОСББ (Дт 10/11/20/22 Кт 48).</p>
        <div class="pay-grid">
            <label class="field"><span class="field-label">Рахунок обліку</span>
                <select id="afAcc" class="field-input field-select"${d.isEdit ? ' disabled' : ''}>${options(ASSET_ACCOUNTS, acc)}</select></label>
            <label class="field"><span class="field-label">Субрахунок за Планом рахунків</span>
                <select id="afSubacc" class="field-input field-select">${options(subOpts, d.subacc || defaultSubacc(acc))}</select></label>
            <label class="field"><span class="field-label">Інвентарний / номенклатурний код</span>
                <input id="afId" class="field-input" maxlength="80" value="${escapeHtml(nextCode)}"${d.isEdit ? ' readonly' : ''}></label>
            <label class="field"><span class="field-label">Назва обʼєкта або ТМЦ</span>
                <input id="afName" class="field-input" maxlength="200" placeholder="Напр.: Генератор інверторний 5,5 кВт" value="${escapeHtml(d.name || '')}"></label>
            <label class="field"><span class="field-label">Стаття витрат (92) для зносу / списання</span>
                <select id="afItem" class="field-input field-select">${options(ctx.expenseItems, d.item || 'systems')}</select></label>
            <label class="field"><span class="field-label">Цільовий фонд (48)</span>
                <select id="afFund" class="field-input field-select">${options(Object.fromEntries((ctx.funds || [{ id: 'main', name: 'Основний фонд' }]).map(f => [f.id, f.name])), d.fundId || 'main')}</select></label>
            ${nonCurr ? `
                <label class="field"><span class="field-label">Метод амортизації (НП(С)БО 7)</span>
                    <select id="afMethod" class="field-input field-select">${options(acc === '10' ? { straight: DEPR_METHODS.straight } : DEPR_METHODS, d.deprMethod || defaultDeprMethod(acc))}</select></label>
                <label class="field"><span class="field-label">Строк корисного використання, міс.</span>
                    <input id="afLife" class="field-input" type="number" min="1" max="600" value="${escapeHtml(String(d.usefulLifeMonths || (acc === '10' ? 60 : 36)))}"></label>
                <label class="field"><span class="field-label">Ліквідаційна вартість, грн</span>
                    <input id="afSalvage" class="field-input" inputmode="decimal" placeholder="0,00" value="${money2(d.salvageKop || 0)}"></label>
                <label class="field"><span class="field-label">Дата введення в експлуатацію (ОЗ-1)</span>
                    <input id="afCommDate" class="field-input" type="date" value="${escapeHtml(d.commissionedDate || '')}"></label>
                <label class="field"><span class="field-label">№ Акта ОЗ-1</span>
                    <input id="afCommNo" class="field-input" maxlength="60" placeholder="ОЗ-1/1" value="${escapeHtml(d.commissionActNo || '')}"></label>
                <label class="field"><span class="field-label">Заводський / серійний номер</span>
                    <input id="afSerial" class="field-input" maxlength="100" value="${escapeHtml(d.serialNumber || '')}"></label>
            ` : `
                <label class="field"><span class="field-label">Одиниця виміру</span>
                    <select id="afUnit" class="field-input field-select">${UNITS.map(u => `<option value="${escapeHtml(u)}"${u === (d.unit || 'шт.') ? ' selected' : ''}>${escapeHtml(u)}</option>`).join('')}</select></label>
                <label class="field"><span class="field-label">Початкова кількість</span>
                    <input id="afQty" class="field-input" type="number" step="0.001" min="0.001" value="${escapeHtml(String(d.initialQty || 1))}"></label>
            `}
            <label class="field"><span class="field-label">Матеріально відповідальна особа (МВО)</span>
                <input id="afCustodian" class="field-input" maxlength="160" placeholder="Голова правління / електрик / комендант" value="${escapeHtml(d.custodian || '')}"></label>
            <label class="field"><span class="field-label">Місце зберігання / експлуатації</span>
                <input id="afLocation" class="field-input" maxlength="200" placeholder="Електрощитова, підʼїзд № 1 / комора ОСББ" value="${escapeHtml(d.location || '')}"></label>
            <label class="field pay-wide"><span class="field-label">Технічний паспорт / примітка</span>
                <input id="afNote" class="field-input" maxlength="300" placeholder="Комплектація, гарантійний талон, умови експлуатації" value="${escapeHtml(d.passportNote || '')}"></label>
            ${!d.isEdit ? `<details class="pay-wide"><summary>Безоплатно отримане майно або виявлений інвентаризацією лишок (без оплати постачальнику)</summary>
                <div class="pay-grid" style="margin-top:10px">
                    <label class="field"><span class="field-label">Первісна вартість оприбуткування, грн</span>
                        <input id="afDonatedKop" class="field-input" inputmode="decimal" placeholder="Залиште порожнім, якщо купівля через «Документи»"></label>
                    <label class="field"><span class="field-label">Дата оприбуткування</span>
                        <input id="afAcqDate" class="field-input" type="date" value="${escapeHtml(ctx.today)}"></label>
                    <label class="field pay-wide"><span class="field-label">Документ-підстава (акт приймання-передачі, рішення зборів / донора)</span>
                        <input id="afSourceDoc" class="field-input" maxlength="200" placeholder="Акт приймання-передачі безоплатної допомоги № 1"></label>
                </div>
            </details>` : ''}
        </div>
        <div class="pay-form-actions"><button type="button" class="btn-primary" data-act="save-card">Зберегти картку</button></div>
    </section>`;
}

function commissionFormHtml(a) {
    return `<section class="buh-card ex-form" id="asForm">
        <div class="buh-card-head"><h2>Введення в експлуатацію (Форма ОЗ-1): ${escapeHtml(a.id)}</h2><button type="button" class="btn-ghost-small" data-act="close-form">Закрити</button></div>
        <p class="buh-note">Обʼєкт <b>«${escapeHtml(a.name)}»</b> первісною вартістю <b>${fmtKop(a.costKop)} грн</b>. ${a.acc === '10'
            ? 'Для основних засобів (рахунок 10) прямолінійна амортизація почне нараховуватися з місяця, наступного за місяцем введення в експлуатацію (п. 29 НП(С)БО 7).'
            : 'Для МНМА (рахунок 11) за методом «100 %» або «50 %/50 %» система одразу нарахує знос у місяці введення в експлуатацію (п. 27 НП(С)БО 7), зберігаючи обʼєкт у кількісному інвентарному обліку.'}</p>
        <div class="pay-grid">
            <label class="field"><span class="field-label">Дата Акта ОЗ-1</span>
                <input id="cmDate" class="field-input" type="date" value="${escapeHtml(a.commissionedDate || a.acquiredDate || ctx.today)}"></label>
            <label class="field"><span class="field-label">Номер Акта ОЗ-1</span>
                <input id="cmNo" class="field-input" maxlength="60" value="${escapeHtml(a.commissionActNo || `ОЗ-1/${a.id}`)}"></label>
            <label class="field"><span class="field-label">Метод амортизації</span>
                <select id="cmMethod" class="field-input field-select">${options(a.acc === '10' ? { straight: DEPR_METHODS.straight } : DEPR_METHODS, a.deprMethod || defaultDeprMethod(a.acc))}</select></label>
            <label class="field"><span class="field-label">Строк корисного використання, міс.</span>
                <input id="cmLife" class="field-input" type="number" min="1" max="600" value="${escapeHtml(String(a.usefulLifeMonths || (a.acc === '10' ? 60 : 36)))}"></label>
            <label class="field"><span class="field-label">Стаття витрат для амортизації (92)</span>
                <select id="cmItem" class="field-input field-select">${options(ctx.expenseItems, a.item || 'systems')}</select></label>
            <label class="field"><span class="field-label">Матеріально відповідальна особа (МВО)</span>
                <input id="cmCustodian" class="field-input" maxlength="160" placeholder="ПІБ та посада" value="${escapeHtml(a.custodian || '')}"></label>
            <label class="field pay-wide"><span class="field-label">Місце встановлення / експлуатації в будинку</span>
                <input id="cmLocation" class="field-input" maxlength="200" placeholder="Технічне приміщення ОСББ / електрощитова" value="${escapeHtml(a.location || '')}"></label>
        </div>
        <div class="pay-form-actions"><button type="button" class="btn-primary" data-act="save-commission" data-id="${escapeHtml(a.id)}">Провести введення в експлуатацію</button></div>
    </section>`;
}

function writeOffFormHtml(a) {
    const isMshp = a.acc === '22';
    return `<section class="buh-card ex-form" id="asForm">
        <div class="buh-card-head"><h2>${isMshp ? 'Передача МШП в експлуатацію' : 'Акт списання використаних запасів'}: ${escapeHtml(a.id)}</h2><button type="button" class="btn-ghost-small" data-act="close-form">Закрити</button></div>
        <p class="buh-note">На складі: <b>${a.remainingQty} ${escapeHtml(a.unit || 'шт.')}</b> на суму <b>${fmtKop(a.costKop)} грн</b>. ${isMshp
            ? 'Згідно з п. 23 НП(С)БО 9 при видачі МШП працівникові їхня вартість списується з балансу (Дт 92 Кт 22 та Дт 48 Кт 719), а сама річ переходить в оперативний позабалансовий кількісний облік за МВО до моменту повного фізичного зносу.'
            : 'Вартість фактично витрачених матеріалів списується на витрати утримання будинку (Дт 92 Кт 20 та одночасно Дт 48 Кт 719).'}</p>
        <div class="pay-grid">
            <label class="field"><span class="field-label">Дата акта</span>
                <input id="woDate" class="field-input" type="date" value="${escapeHtml(ctx.today)}"></label>
            <label class="field"><span class="field-label">Номер акта</span>
                <input id="woNo" class="field-input" maxlength="60" value="${escapeHtml(`ТМЦ-${ctx.today.slice(0, 7)}/${a.id}`)}"></label>
            <label class="field"><span class="field-label">Кількість (${escapeHtml(a.unit || 'шт.')}, макс. ${a.remainingQty})</span>
                <input id="woQty" class="field-input" type="number" step="0.001" min="0.001" max="${a.remainingQty}" value="${a.remainingQty}"></label>
            <label class="field"><span class="field-label">Стаття витрат кошторису (92)</span>
                <select id="woItem" class="field-input field-select">${options(ctx.expenseItems, a.item || 'repair')}</select></label>
            <label class="field"><span class="field-label">Матеріально відповідальна особа (МВО)</span>
                <input id="woCustodian" class="field-input" maxlength="160" value="${escapeHtml(a.custodian || '')}" placeholder="Кому видано / хто використав"></label>
            <label class="field"><span class="field-label">Місце використання / робіт</span>
                <input id="woLocation" class="field-input" maxlength="200" value="${escapeHtml(a.location || '')}" placeholder="Підʼїзд № 1–4, дах, двір, генераторна"></label>
            <label class="field pay-wide"><span class="field-label">Напрям використання / підстава списання</span>
                <input id="woReason" class="field-input" maxlength="240" placeholder="${isMshp ? 'Видано двірнику / електрику для обслуговування будинку' : 'Заміна ламп освітлення МЗК / робота генератора під час відключень'}"></label>
        </div>
        <div class="pay-form-actions"><button type="button" class="btn-primary" data-act="save-writeoff" data-id="${escapeHtml(a.id)}">${isMshp ? 'Передати в експлуатацію' : 'Провести списання ТМЦ'}</button></div>
    </section>`;
}

function disposeFormHtml(a) {
    return `<section class="buh-card ex-form" id="asForm">
        <div class="buh-card-head"><h2>Ліквідація обʼєкта (Форма ОЗ-3): ${escapeHtml(a.id)}</h2><button type="button" class="btn-ghost-small" data-act="close-form">Закрити</button></div>
        <p class="buh-note">Обʼєкт <b>«${escapeHtml(a.name)}»</b>: первісна вартість <b>${fmtKop(a.costKop)} грн</b>, накопичений знос <b>${fmtKop(a.wearKop)} грн</b>, залишкова вартість <b>${fmtKop(a.netKop)} грн</b>. Система спише накопичений знос (<b>Дт ${a.acc === '10' ? '131' : '132'} Кт ${a.acc}</b> на ${fmtKop(a.wearKop)} грн)${a.netKop > 0 ? ` та залишкову вартість (<b>Дт 92 Кт ${a.acc}</b> на ${fmtKop(a.netKop)} грн)` : ''}.</p>
        <div class="pay-grid">
            <label class="field"><span class="field-label">Дата Акта ОЗ-3</span>
                <input id="dpDate" class="field-input" type="date" value="${escapeHtml(ctx.today)}"></label>
            <label class="field"><span class="field-label">Номер Акта ОЗ-3</span>
                <input id="dpNo" class="field-input" maxlength="60" value="${escapeHtml(`ОЗ-3/${a.id}`)}"></label>
            <label class="field pay-wide"><span class="field-label">Причина непридатності до подальшої експлуатації (висновок комісії)</span>
                <input id="dpReason" class="field-input" maxlength="240" placeholder="Повний фізичний знос, вихід з ладу без можливості економічно доцільного ремонту"></label>
        </div>
        <div class="pay-form-actions"><button type="button" class="btn-primary" data-act="save-dispose" data-id="${escapeHtml(a.id)}">Затвердити ліквідацію (ОЗ-3)</button></div>
    </section>`;
}

function retireMshpFormHtml(a) {
    return `<section class="buh-card ex-form" id="asForm">
        <div class="buh-card-head"><h2>Списання зношеного МШП з позабалансового обліку: ${escapeHtml(a.id)}</h2><button type="button" class="btn-ghost-small" data-act="close-form">Закрити</button></div>
        <p class="buh-note">МШП <b>«${escapeHtml(a.name)}»</b> вже списано з балансу при передачі в роботу (п. 23 НП(С)БО 9) і рахується в оперативному обліку за МВО (${escapeHtml(a.custodian || 'не вказано')}) у кількості <b>${a.inUseQty} ${escapeHtml(a.unit || 'шт.')}</b>. Після фізичного зносу оформлюється акт вибуття з позабалансового обліку.</p>
        <div class="pay-grid">
            <label class="field"><span class="field-label">Дата акта вибуття</span>
                <input id="rtDate" class="field-input" type="date" value="${escapeHtml(ctx.today)}"></label>
            <label class="field"><span class="field-label">Номер акта</span>
                <input id="rtNo" class="field-input" maxlength="60" value="${escapeHtml(`МШП-СПИС/${a.id}`)}"></label>
            <label class="field"><span class="field-label">Кількість до списання (макс. ${a.inUseQty})</span>
                <input id="rtQty" class="field-input" type="number" step="0.001" min="0.001" max="${a.inUseQty}" value="${a.inUseQty}"></label>
            <label class="field pay-wide"><span class="field-label">Причина вибуття (зношення, поломка)</span>
                <input id="rtReason" class="field-input" maxlength="240" placeholder="Повний фізичний знос інвентарю під час прибирання прибудинкової території"></label>
        </div>
        <div class="pay-form-actions"><button type="button" class="btn-primary" data-act="save-retire-mshp" data-id="${escapeHtml(a.id)}">Списати з позабалансу</button></div>
    </section>`;
}

function activeFormHtml() {
    if (!form) return '';
    if (form.kind === 'card') return cardFormHtml(form.data);
    const a = (ctx.items || []).find(x => x.id === form.id);
    if (!a) return '';
    if (form.kind === 'commission') return commissionFormHtml(a);
    if (form.kind === 'writeoff') return writeOffFormHtml(a);
    if (form.kind === 'dispose') return disposeFormHtml(a);
    if (form.kind === 'retire-mshp') return retireMshpFormHtml(a);
    return '';
}

function listRowHtml(a) {
    const isFixed = isNonCurrent(a.acc);
    const rightVal = isFixed
        ? `${fmtKop(a.netKop)} грн`
        : a.costKop > 0
            ? `${a.remainingQty} ${escapeHtml(a.unit || 'шт.')} · ${fmtKop(a.costKop)} грн`
            : `${a.inUseQty || 0} ${escapeHtml(a.unit || 'шт.')} (в експл.)`;
    return `<li><button type="button" class="fl-item dc-item${a.id === selected ? ' is-current' : ''}" data-act="pick" data-id="${escapeHtml(a.id)}" aria-current="${a.id === selected}">
        <span class="fl-copy">
            <b>${escapeHtml(a.name)}</b>
            <small>${escapeHtml(a.id)} · Рах. ${escapeHtml(a.subacc || a.acc)}${a.custodian ? ` · МВО: ${escapeHtml(a.custodian)}` : ''}</small>
        </span>
        <span class="dc-right">
            <b class="fl-sum">${rightVal}</b>
            <span class="sv-chip ${a.statusClass}">${escapeHtml(a.statusLabel)}</span>
        </span>
    </button></li>`;
}

function detailCardHtml(a, empty) {
    if (!a) {
        return `<div class="fl-empty"><b>${empty ? 'Карток у цій категорії ще немає' : 'Оберіть обʼєкт або ТМЦ'}</b>
            <span>Тут відображається інвентарна картка, розрахунок амортизації за НП(С)БО 7, рух ТМЦ за НП(С)БО 9 та друковані первинні акти (ОЗ-1, ОЗ-3, Акт списання).</span></div>`;
    }
    const isFixed = isNonCurrent(a.acc);
    const fundName = (ctx.funds || []).find(f => f.id === a.fundId)?.name || a.fundId;
    const rows = [
        ['Інвентарний / номенкл. код', a.id],
        ['Рахунок та субрахунок', `${a.acc} (${ASSET_SUBACCOUNTS[a.subacc]?.title || a.subacc})`],
        ['Стаття витрат (92)', ctx.expenseItems[a.item] || a.item],
        ['Джерело фінансування (48)', fundName],
        ['Постачальник', a.supplierName || '—'],
        ['Дата оприбуткування', human(a.acquiredDate)],
        ...(isFixed ? [
            ['Введено в експлуатацію', a.commissionedDate ? `${human(a.commissionedDate)}${a.commissionActNo ? ` (Акт № ${a.commissionActNo})` : ''}` : 'ще не введено'],
            ['Метод амортизації', DEPR_METHODS[a.deprMethod] || a.deprMethod],
            ['Строк корисної служби', a.deprMethod === 'straight' ? `${a.usefulLifeMonths} міс. (${(a.usefulLifeMonths / 12).toFixed(1).replace('.0', '')} р.)` : 'за обліковою політикою МНМА'],
            ['Планова норма зносу', a.deprMethod === 'straight' ? `${fmtKop(a.monthlyDeprKop)} грн / міс.` : a.deprMethod === 'mnhma_100' ? '100 % при введенні' : '50 % при введенні / 50 % при списанні'],
            ...(a.salvageKop ? [['Ліквідаційна вартість', `${fmtKop(a.salvageKop)} грн`]] : []),
            ...(a.serialNumber ? [['Серійний / заводський №', a.serialNumber]] : [])
        ] : [
            ['Одиниця виміру', a.unit || 'шт.'],
            ['Оприбутковано всього', `${a.initialQty} ${a.unit || 'шт.'} (${fmtKop(a.acquiredCostKop)} грн)`],
            ['Залишок на складі зараз', `${a.remainingQty} ${a.unit || 'шт.'} (${fmtKop(a.costKop)} грн)`],
            ...(a.acc === '22' ? [
                ['В експлуатації (позабаланс МВО)', `${a.inUseQty} ${a.unit || 'шт.'}`],
                ['Списано через повний знос', `${a.retiredQty || 0} ${a.unit || 'шт.'}`]
            ] : [])
        ]),
        ['Матеріально відповідальна особа', a.custodian || 'не призначено'],
        ['Місце зберігання / роботи', a.location || 'не вказано'],
        ...(a.passportNote ? [['Паспорт / примітка', a.passportNote]] : []),
        ...(a.disposedDate ? [['Дата та причина списання', `${human(a.disposedDate)}${a.disposalActNo ? ` (Акт № ${a.disposalActNo})` : ''}: ${a.disposalReason || ''}`]] : [])
    ];

    const wearBar = isFixed ? `<div class="as-wear-box">
        <div class="as-wear-nums">
            <div><span>Первісна вартість (${a.acc})</span><b>${fmtKop(a.costKop || a.acquiredCostKop)} грн</b></div>
            <div><span>Накопичений знос (${a.acc === '10' ? '131' : '132'})</span><b>${fmtKop(a.wearKop)} грн (${a.wearPct}%)</b></div>
            <div><span>Залишкова вартість (ряд. 1010 Балансу)</span><b>${fmtKop(a.netKop)} грн</b></div>
        </div>
        <div class="as-progress" role="progressbar" aria-valuenow="${a.wearPct}" aria-valuemin="0" aria-valuemax="100">
            <div class="as-progress-fill" style="width:${a.wearPct}%"></div>
        </div>
    </div>` : `<div class="as-wear-box">
        <div class="as-wear-nums">
            <div><span>Первісна вартість партії</span><b>${fmtKop(a.acquiredCostKop)} грн</b></div>
            <div><span>Залишок на складі (${a.acc})</span><b>${a.remainingQty} ${escapeHtml(a.unit || 'шт.')} · ${fmtKop(a.costKop)} грн</b></div>
            <div><span>${a.acc === '22' ? 'В експлуатації за МВО (позабаланс)' : 'Списано у витрати (92)'}</span><b>${a.acc === '22' ? `${a.inUseQty} ${escapeHtml(a.unit || 'шт.')}` : `${fmtKop(a.inventoryWriteOffKop)} грн`}</b></div>
        </div>
    </div>`;

    const actions = [];
    const btn = (act, label, soft = false, extra = '') =>
        `<button type="button" class="sv-btn${soft || actions.length ? ' is-soft' : ''}" data-act="${act}" data-id="${escapeHtml(a.id)}"${extra}>${label}</button>`;

    if (isFixed && a.status === 'uncommissioned' && a.costKop > 0) {
        actions.push(btn('open-commission', 'Ввести в експлуатацію (ОЗ-1)'));
    }
    if (isFixed && a.commissionedDate) {
        actions.push(btn('print-oz1', 'Друк Акта ОЗ-1', true));
    }
    if (isInventory(a.acc) && a.remainingQty > 0 && a.costKop > 0) {
        actions.push(btn('open-writeoff', a.acc === '22' ? 'Передати МШП в експлуатацію' : 'Списати використані запаси'));
    }
    if (a.acc === '22' && a.inUseQty > 0) {
        actions.push(btn('open-retire-mshp', 'Списати зношений МШП з позабалансу', true));
    }
    if (isInventory(a.acc) && (a.inventoryWriteOffKop > 0 || (a.retirementActs || []).length > 0)) {
        actions.push(btn('print-writeoff', 'Друк Акта списання ТМЦ/МШП', true));
    }
    actions.push(btn('edit-card', 'Змінити картку / МВО', true));
    if (isFixed && a.costKop > 0 && isChair()) {
        actions.push(btn('open-dispose', 'Ліквідувати (Акт ОЗ-3)', true));
    }
    if (isFixed && (a.status === 'disposed' || a.disposedDate)) {
        actions.push(btn('print-oz3', 'Друк Акта ОЗ-3', true));
    }

    return `<div class="fl-card-head">
            <div>
                <span class="fl-facts">${escapeHtml(ASSET_ACCOUNTS[a.acc] || '')} · Інв. № ${escapeHtml(a.id)}</span>
                <h2>${escapeHtml(a.name)}</h2>
                <span class="dc-amount">${isFixed ? `${fmtKop(a.netKop)} грн` : `${a.remainingQty} ${escapeHtml(a.unit || 'шт.')} (${fmtKop(a.costKop)} грн)`}</span>
            </div>
            <span class="sv-chip ${a.statusClass}">${escapeHtml(a.statusLabel)}</span>
        </div>
        ${a.thresholdWarning ? `<p class="dc-hint is-ask"><span>${escapeHtml(a.thresholdWarning)}</span></p>` : ''}
        ${wearBar}
        <dl class="dc-fields">${rows.map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(String(v))}</dd>`).join('')}</dl>
        ${a.sourceDocs?.length ? `<div class="dc-chain"><h3 class="chs-h">Первинні документи придбання</h3><div class="chs-links">
            ${a.sourceDocs.map(doc => `<button type="button" class="chs-link" data-act="open-doc" data-doc="${escapeHtml(doc.id)}">
                <span class="chs-link-label">Документ</span>
                <span class="chs-link-main"><b>№ ${escapeHtml(doc.number || '—')} від ${human(doc.date)} · ${escapeHtml(doc.supplierName)}</b></span>
                <span class="chs-link-right"><b>${fmtKop(doc.amountKop)} грн</b><span aria-hidden="true">›</span></span>
            </button>`).join('')}
        </div></div>` : ''}
        ${a.history?.length ? `<div class="dc-chain"><h3 class="chs-h">Історія операцій за карткою</h3>
            <table class="buh-table is-compact"><thead><tr><th>Дата</th><th>Операція</th><th class="t-sum">Сума</th></tr></thead>
            <tbody>${a.history.map(h => `<tr>
                <td class="t-date">${escapeHtml(human(h.date))}</td>
                <td>${escapeHtml(h.title)}${h.qty ? ` <small class="t-muted">(${h.qty} ${escapeHtml(a.unit || 'шт.')})</small>` : ''}</td>
                <td class="t-sum">${fmtKop(h.amountKop)} грн</td>
            </tr>`).join('')}</tbody></table>
        </div>` : ''}
        <div class="fl-actions">${actions.join('')}</div>`;
}

async function openPrintWindow(title, bodyHtml) {
    const req = await loadRequisites().catch(() => ({}));
    const orgName = req?.payeeName || req?.recipientName || 'ОСББ «Успіх-25»';
    const edrpou = req?.edrpou || '—';
    const win = window.open('', '_blank', 'width=920,height=780');
    if (!win) { toast('Дозвольте спливаючі вікна для друку акта', 'error'); return; }
    win.document.write(`<!DOCTYPE html><html lang="uk"><head><meta charset="UTF-8"><title>${escapeHtml(title)}</title>
        <style>
            body { font-family: "Times New Roman", Georgia, serif; color: #111; margin: 24px 32px; font-size: 13pt; line-height: 1.45; }
            .head-grid { display: flex; justify-content: space-between; gap: 24px; margin-bottom: 18px; font-size: 11.5pt; }
            h1 { font-size: 15pt; text-align: center; margin: 14px 0 6px; text-transform: uppercase; }
            h2 { font-size: 12.5pt; text-align: center; margin: 0 0 18px; font-weight: normal; }
            table { width: 100%; border-collapse: collapse; margin: 14px 0; font-size: 11.5pt; }
            th, td { border: 1px solid #222; padding: 6px 8px; text-align: left; vertical-align: top; }
            th { background: #f3f4f6; font-weight: bold; }
            .num { text-align: right; white-space: nowrap; }
            .signs { margin-top: 28px; display: grid; grid-template-columns: 1fr 1fr; gap: 18px 32px; font-size: 11.5pt; }
            .sign-line { border-bottom: 1px solid #222; min-height: 22px; margin-top: 16px; }
            .no-print { margin-bottom: 16px; padding: 10px 14px; background: #eef4ff; border-radius: 8px; font-family: sans-serif; display: flex; justify-content: space-between; align-items: center; }
            .no-print button { padding: 8px 16px; font-weight: 600; cursor: pointer; border-radius: 6px; border: 1px solid #1d4ed8; background: #1d4ed8; color: #fff; }
            @media print { .no-print { display: none; } body { margin: 10mm 15mm; } }
        </style></head><body>
        <div class="no-print"><span>Документ сформовано з облікової системи ${escapeHtml(orgName)}</span><button onclick="window.print()">Друкувати / Зберегти PDF</button></div>
        <div class="head-grid">
            <div><b>Організація:</b> ${escapeHtml(orgName)}<br><b>Код ЄДРПОУ:</b> ${escapeHtml(edrpou)}<br><small>Неприбуткова організація (п. 133.4 ПКУ)</small></div>
            <div style="text-align:right"><b>ЗАТВЕРДЖУЮ</b><br>Голова правління ${escapeHtml(orgName)}<br>___________________ / ___________________ /<br>«___» ________________ 20___ р.</div>
        </div>
        ${bodyHtml}
    </body></html>`);
    win.document.close();
}

function printOz1(a) {
    openPrintWindow(`Акт ОЗ-1 — ${a.id}`, `
        <h1>АКТ ПРИЙМАННЯ-ПЕРЕДАЧІ (ВВЕДЕННЯ В ЕКСПЛУАТАЦІЮ) ОСНОВНИХ ЗАСОБІВ / МНМА</h1>
        <h2>Типова форма № ОЗ-1 · Акт № ${escapeHtml(a.commissionActNo || '1')} від ${escapeHtml(human(a.commissionedDate || a.acquiredDate || ctx.today))}</h2>
        <p>Комісія, призначена рішенням правління ОСББ, провела огляд та перевірку готовності до експлуатації обʼєкта необоротних активів, що перебуває у власності ОСББ як юридичної особи (Закон України «Про ОСББ» № 417-VIII, НП(С)БО 7 «Основні засоби»):</p>
        <table>
            <thead><tr><th>Інвентарний №</th><th>Найменування обʼєкта та заводський №</th><th>Рахунок / субрахунок</th><th>Строк служби, міс.</th><th>Метод нарахування зносу</th><th class="num">Первісна вартість, грн</th></tr></thead>
            <tbody><tr>
                <td><b>${escapeHtml(a.id)}</b></td>
                <td><b>${escapeHtml(a.name)}</b>${a.serialNumber ? `<br><small>Серійний №: ${escapeHtml(a.serialNumber)}</small>` : ''}${a.passportNote ? `<br><small>${escapeHtml(a.passportNote)}</small>` : ''}</td>
                <td>${escapeHtml(a.acc)} / ${escapeHtml(a.subacc || defaultSubacc(a.acc))}</td>
                <td>${a.deprMethod === 'straight' ? a.usefulLifeMonths : 'згідно з обліковою політикою'}</td>
                <td>${escapeHtml(DEPR_METHODS[a.deprMethod] || a.deprMethod)}</td>
                <td class="num"><b>${fmtKop(a.acquiredCostKop || a.costKop)}</b></td>
            </tr></tbody>
        </table>
        <p><b>Місце встановлення (експлуатації):</b> ${escapeHtml(a.location || 'технічне приміщення ОСББ')}.</p>
        <p><b>Джерело цільового фінансування (рахунок 48):</b> ${escapeHtml((ctx.funds || []).find(f => f.id === a.fundId)?.name || a.fundId)}.</p>
        <p><b>Висновок комісії:</b> обʼєкт відповідає технічним умовам, придатний до експлуатації в господарській діяльності ОСББ з обслуговування будинку та вводиться в експлуатацію з <b>${escapeHtml(human(a.commissionedDate || ctx.today))}</b>.</p>
        <p><b>Обʼєкт на відповідальне зберігання та в експлуатацію прийняв (МВО):</b> ${escapeHtml(a.custodian || '____________________________________')}.</p>
        <div class="signs">
            <div>Голова комісії:<div class="sign-line"></div></div>
            <div>Члени комісії:<div class="sign-line"></div></div>
            <div>Прийняв на відповідальне зберігання (МВО):<div class="sign-line"></div></div>
            <div>Бухгалтер ОСББ (відмітка про відкриття інв. картки):<div class="sign-line"></div></div>
        </div>`);
}

function printOz3(a) {
    openPrintWindow(`Акт ОЗ-3 — ${a.id}`, `
        <h1>АКТ НА СПИСАННЯ ОСНОВНИХ ЗАСОБІВ / МНМА</h1>
        <h2>Типова форма № ОЗ-3 · Акт № ${escapeHtml(a.disposalActNo || `ОЗ-3/${a.id}`)} від ${escapeHtml(human(a.disposedDate || ctx.today))}</h2>
        <p>Комісія оглянула обʼєкт необоротних матеріальних активів ОСББ та встановила його непридатність до подальшої експлуатації (п. 33–34 НП(С)БО 7 «Основні засоби»):</p>
        <table>
            <thead><tr><th>Інвентарний №</th><th>Найменування обʼєкта</th><th>Дата введення</th><th class="num">Первісна вартість, грн</th><th class="num">Накопичений знос, грн</th><th class="num">Залишкова вартість, грн</th></tr></thead>
            <tbody><tr>
                <td><b>${escapeHtml(a.id)}</b></td>
                <td><b>${escapeHtml(a.name)}</b></td>
                <td>${escapeHtml(human(a.commissionedDate || a.acquiredDate))}</td>
                <td class="num">${fmtKop(a.acquiredCostKop || a.costKop)}</td>
                <td class="num">${fmtKop(a.disposedWearKop || a.wearKop)}</td>
                <td class="num">${fmtKop(Math.max(0, (a.acquiredCostKop || a.costKop) - (a.disposedWearKop || a.wearKop)))}</td>
            </tr></tbody>
        </table>
        <p><b>Причина списання та технічний стан:</b> ${escapeHtml(a.disposalReason || 'повний фізичний та моральний знос, відновлення економічно недоцільне')}.</p>
        <p><b>Кореспонденція рахунків бухгалтерського обліку:</b> Дт ${a.acc === '10' ? '131' : '132'} Кт ${a.acc} (списання зносу); при наявності залишкової вартості — Дт 92 Кт ${a.acc} з одночасним визнанням доходу цільового фінансування Дт 48 Кт 719.</p>
        <div class="signs">
            <div>Голова комісії:<div class="sign-line"></div></div>
            <div>Члени комісії:<div class="sign-line"></div></div>
            <div>Матеріально відповідальна особа:<div class="sign-line"></div></div>
            <div>Бухгалтер ОСББ:<div class="sign-line"></div></div>
        </div>`);
}

function printWriteOffAct(a) {
    const lastWriteOff = (a.history || []).find(h => h.kind === 'inventory_writeoff' || h.kind === 'mshp_use') || {
        date: ctx.today,
        amountKop: a.inventoryWriteOffKop || a.acquiredCostKop,
        qty: a.writtenOffQty || a.initialQty,
        title: a.acc === '22' ? 'Передача МШП в експлуатацію' : 'Списання використаних виробничих запасів'
    };
    openPrintWindow(`Акт списання ТМЦ — ${a.id}`, `
        <h1>${a.acc === '22' ? 'АКТ ВВЕДЕННЯ В ЕКСПЛУАТАЦІЮ ТА СПИСАННЯ МШП (РАХУНОК 22)' : 'АКТ НА СПИСАННЯ ВИКОРИСТАНИХ ВИРОБНИЧИХ ЗАПАСІВ (РАХУНОК 20)'}</h1>
        <h2>від ${escapeHtml(human(lastWriteOff.date))} · Період: ${escapeHtml(periodName(ctx.period))}</h2>
        <p>Комісія ОСББ склала цей акт про те, що для потреб утримання багатоквартирного будинку та прибудинкової території згідно з НП(С)БО 9 «Запаси» було ${a.acc === '22' ? 'передано в експлуатацію малоцінні та швидкозношувані предмети зі збереженням оперативного кількісного обліку за МВО (п. 23 НП(С)БО 9)' : 'фактично використано та списано на витрати періоду виробничі запаси'}:</p>
        <table>
            <thead><tr><th>Номенкл. №</th><th>Найменування ТМЦ / МШП</th><th>Рахунок</th><th>Од. вим.</th><th class="num">Кількість</th><th class="num">Сума, грн</th><th>Напрям використання та місце робіт</th></tr></thead>
            <tbody><tr>
                <td><b>${escapeHtml(a.id)}</b></td>
                <td><b>${escapeHtml(a.name)}</b></td>
                <td>${escapeHtml(a.subacc || a.acc)}</td>
                <td>${escapeHtml(a.unit || 'шт.')}</td>
                <td class="num">${escapeHtml(String(lastWriteOff.qty || a.initialQty || 1))}</td>
                <td class="num"><b>${fmtKop(lastWriteOff.amountKop)}</b></td>
                <td>${escapeHtml(lastWriteOff.title)}${a.location ? ` (${escapeHtml(a.location)})` : ''}</td>
            </tr></tbody>
        </table>
        <p><b>Матеріально відповідальна особа (МВО):</b> ${escapeHtml(a.custodian || '____________________________________')}.</p>
        <p><b>Бухгалтерська проводка:</b> Дт 92 (${escapeHtml(ctx.expenseItems[a.item] || a.item)}) — Кт ${escapeHtml(a.acc)} на суму ${fmtKop(lastWriteOff.amountKop)} грн; одночасно Дт 48 — Кт 719.</p>
        <div class="signs">
            <div>Голова комісії:<div class="sign-line"></div></div>
            <div>Члени комісії:<div class="sign-line"></div></div>
            <div>Матеріально відповідальна особа:<div class="sign-line"></div></div>
            <div>Бухгалтер ОСББ:<div class="sign-line"></div></div>
        </div>`);
}

function printInventorySheet() {
    const activeItems = (ctx.items || []).filter(a => a.status !== 'disposed');
    openPrintWindow(`Інвентаризаційний опис — ${ctx.period}`, `
        <h1>ІНВЕНТАРИЗАЦІЙНИЙ ОПИС НЕОБОРОТНИХ АКТИВІВ (ОЗ, МНМА), ЗАПАСІВ ТА МШП</h1>
        <h2>станом на кінець періоду ${escapeHtml(periodName(ctx.period))} (згідно з Положенням Мінфіну № 879)</h2>
        <table>
            <thead><tr><th>№</th><th>Інв. / ном. код</th><th>Найменування обʼєкта / ТМЦ</th><th>Рах.</th><th>МВО та місце</th><th class="num">Кільк. (облік)</th><th class="num">Первісна вартість, грн</th><th class="num">Знос, грн</th><th class="num">Залишкова вартість, грн</th><th class="num">Фактична наявність</th></tr></thead>
            <tbody>${activeItems.map((a, idx) => `<tr>
                <td>${idx + 1}</td>
                <td><b>${escapeHtml(a.id)}</b></td>
                <td>${escapeHtml(a.name)}</td>
                <td>${escapeHtml(a.subacc || a.acc)}</td>
                <td>${escapeHtml([a.custodian, a.location].filter(Boolean).join(' · ') || '—')}</td>
                <td class="num">${isNonCurrent(a.acc) ? `1 шт.` : `${a.acc === '22' && a.inUseQty > 0 && a.remainingQty === 0 ? `${a.inUseQty} (позабал.)` : a.remainingQty} ${escapeHtml(a.unit || 'шт.')}`}</td>
                <td class="num">${fmtKop(a.costKop || a.acquiredCostKop)}</td>
                <td class="num">${isNonCurrent(a.acc) ? fmtKop(a.wearKop) : '—'}</td>
                <td class="num"><b>${fmtKop(a.netKop)}</b></td>
                <td class="num"></td>
            </tr>`).join('')}</tbody>
            <tfoot><tr>
                <th colspan="6">РАЗОМ за даними бухгалтерського обліку</th>
                <th class="num">${fmtKop(ctx.summary.fixedCostKop + ctx.summary.stockTotalKop)}</th>
                <th class="num">${fmtKop(ctx.summary.fixedWearKop)}</th>
                <th class="num">${fmtKop(ctx.summary.fixedNetKop + ctx.summary.stockTotalKop)}</th>
                <th></th>
            </tr></tfoot>
        </table>
        <div class="signs">
            <div>Голова інвентаризаційної комісії:<div class="sign-line"></div></div>
            <div>Члени інвентаризаційної комісії:<div class="sign-line"></div></div>
            <div>Матеріально відповідальна особа:<div class="sign-line"></div></div>
            <div>Бухгалтер ОСББ:<div class="sign-line"></div></div>
        </div>`);
}

function exportCsv() {
    const csvCell = v => (/[;"\r\n]/.test(String(v ?? '')) ? `"${String(v ?? '').replace(/"/g, '""')}"` : String(v ?? ''));
    const csvKop = k => ((Number(k || 0)) / 100).toFixed(2).replace('.', ',');
    const rows = [[
        'Інвентарний код', 'Рахунок', 'Субрахунок', 'Найменування', 'Статус',
        'Дата оприбуткування', 'Дата введення в експлуатацію', 'Метод амортизації',
        'Строк служби (міс.)', 'Кількість на складі', 'МШП в експлуатації (позабаланс)',
        'Од. вим.', 'Первісна вартість (грн)', 'Накопичений знос (грн)', 'Залишкова вартість (грн)',
        'МВО', 'Місце зберігання / роботи'
    ]];
    for (const a of ctx.items || []) {
        rows.push([
            a.id, a.acc, a.subacc || '', a.name, a.statusLabel,
            a.acquiredDate || '', a.commissionedDate || '', a.deprMethod || '',
            isNonCurrent(a.acc) ? a.usefulLifeMonths : '',
            isInventory(a.acc) ? a.remainingQty : 1,
            a.acc === '22' ? a.inUseQty : '',
            a.unit || 'шт.',
            csvKop(a.costKop || a.acquiredCostKop),
            csvKop(a.wearKop),
            csvKop(a.netKop),
            a.custodian || '',
            a.location || ''
        ]);
    }
    const blob = new Blob(['\uFEFF' + rows.map(r => r.map(csvCell).join(';')).join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `assets-register-${ctx.period}.csv`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

export async function loadAssetsView() {
    ctx = await loadAssets(period);
    period = ctx.period;
    const list = filterItems(ctx.items);
    if (!list.some(a => a.id === selected)) {
        selected = window.matchMedia('(max-width: 900px)').matches ? null : list[0]?.id || null;
    }
    const cur = (ctx.items || []).find(a => a.id === selected) || null;
    const counts = tabCounts(ctx.items);
    const s = ctx.summary;
    const host = document.getElementById('viewAssets');
    if (!host) return 0;

    host.innerHTML = `
        <div class="buh-toolbar">
            <select id="asPeriod" class="field-input field-select ch-period" aria-label="Період">${(ctx.periods || []).slice().reverse().map(p =>
                `<option value="${escapeHtml(p.id)}"${p.id === ctx.period ? ' selected' : ''}>${escapeHtml(periodName(p.id))}${p.status === 'closed' ? ' · закрито' : ''}</option>`).join('')}</select>
            <span class="buh-note">НП(С)БО 7 «Основні засоби», НП(С)БО 9 «Запаси», пп. 14.1.138 ПКУ (поріг МНМА — ${((ctx.mnhmaLimitKop || 2000000) / 100).toLocaleString('uk-UA')} грн).</span>
            <span class="ch-tools">
                <button type="button" class="sv-btn" style="width:auto;min-height:38px;padding:0 18px;font-size:13.5px" data-act="new-card">+ Картка ОЗ / ТМЦ</button>
                <button type="button" class="btn-ghost-small" data-act="print-inventory">Інвентаризаційний опис</button>
                <button type="button" class="btn-ghost-small" data-act="export-csv">Реєстр у CSV</button>
                <button type="button" class="btn-ghost-small" data-go="journal">В ОСВ ›</button>
            </span>
        </div>
        <div class="kpi-grid">
            <div class="kpi">
                <span>ОЗ та МНМА: залишкова (10, 11)</span>
                <b>${fmtKop(s.fixedNetKop)}</b>
                <small>первісна ${fmtKop(s.fixedCostKop)} · знос ${fmtKop(s.fixedWearKop)} грн (${s.ozCount} ОЗ, ${s.mnhmaCount} МНМА)</small>
            </div>
            <div class="kpi">
                <span>Амортизація за місяць (131, 132)</span>
                <b>${fmtKop(s.deprThisPeriodKop)}</b>
                <small>${s.dueDeprKop > 0 ? `до нарахування: ${fmtKop(s.dueDeprKop)} грн (${s.dueDeprCount} об.)` : 'нараховано за всіма введеними обʼєктами'}</small>
            </div>
            <div class="kpi">
                <span>Запаси й МШП на складі (20, 22)</span>
                <b>${fmtKop(s.stockTotalKop)}</b>
                <small>запаси (20): ${fmtKop(s.stock20Kop)} · МШП (22): ${fmtKop(s.stock22Kop)} грн</small>
            </div>
            <div class="kpi">
                <span>МШП в експлуатації (позабаланс)</span>
                <b>${s.mshpInUseQty} од.</b>
                <small>${s.mshpInUseCards} найменувань за МВО (п. 23 НП(С)БО 9)</small>
            </div>
        </div>
        ${bannersHtml()}
        <div class="fl-filters dc-tabs" role="tablist">
            ${Object.entries(TABS).map(([k, v]) =>
                `<button type="button" class="fl-filter${k === segment ? ' active' : ''}" role="tab" aria-selected="${k === segment}" data-seg="${k}">${escapeHtml(v)} <span>${counts[k] || 0}</span></button>`).join('')}
        </div>
        ${activeFormHtml()}
        <div class="fl-grid dc-grid">
            <section class="fl-list" aria-label="Інвентарна книга та ТМЦ">
                <label class="fl-search dc-search">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>
                    <input type="search" id="asQuery" placeholder="Інв. №, назва, МВО, місце…" value="${escapeHtml(query)}" aria-label="Пошук активу або ТМЦ">
                </label>
                ${list.length
                    ? `<ul class="fl-items">${list.map(listRowHtml).join('')}</ul>`
                    : `<p class="list-empty">${query ? 'За запитом нічого не знайдено' : 'У цій вкладці ще немає обʼєктів. Придбані за рахунком чи накладною активи зʼявляються тут автоматично після проведення документа в «Документах».'}</p>`}
            </section>
            <section class="fl-card dc-card${cur || !list.length ? '' : ' is-idle'}" id="asCard" aria-live="polite">
                ${detailCardHtml(cur, !list.length)}
            </section>
        </div>`;

    return (s.uncommissionedCount || 0) + (ctx.status === 'open' ? (s.dueDeprCount || 0) : 0);
}

async function saveCard(btn) {
    const acc = val('afAcc') || '10';
    const donatedKop = val('afDonatedKop') ? toKop(val('afDonatedKop')) : 0;
    const payload = {
        action: 'saveAsset',
        id: val('afId'),
        acc,
        subacc: val('afSubacc'),
        name: val('afName'),
        item: val('afItem'),
        fundId: val('afFund'),
        usefulLifeMonths: Number(val('afLife') || 60),
        deprMethod: val('afMethod') || defaultDeprMethod(acc),
        salvageKop: val('afSalvage') ? toKop(val('afSalvage')) : 0,
        commissionedDate: val('afCommDate'),
        commissionActNo: val('afCommNo'),
        serialNumber: val('afSerial'),
        unit: val('afUnit') || 'шт.',
        initialQty: Number(val('afQty') || 1),
        custodian: val('afCustodian'),
        location: val('afLocation'),
        passportNote: val('afNote'),
        ...(donatedKop > 0 ? {
            sourceMode: 'donated_or_surplus',
            initialCostKop: donatedKop,
            acquiredDate: val('afAcqDate') || ctx.today,
            sourceDoc: val('afSourceDoc')
        } : {})
    };
    setBusy(btn, true, 'Зберігаю…');
    try {
        const r = await assetsAct(payload);
        selected = r.id;
        form = null;
        toast('Картку збережено', 'success');
        await loadAssetsView();
    } catch (e) { toast(e.message, 'error'); }
    finally { if (btn.isConnected) setBusy(btn, false); }
}

async function saveCommission(btn) {
    const id = btn.dataset.id;
    setBusy(btn, true, 'Проводжу ОЗ-1…');
    try {
        const r = await assetsAct({
            action: 'commissionAsset',
            id,
            commissionedDate: val('cmDate'),
            commissionActNo: val('cmNo'),
            deprMethod: val('cmMethod'),
            usefulLifeMonths: Number(val('cmLife') || 60),
            item: val('cmItem'),
            custodian: val('cmCustodian'),
            location: val('cmLocation')
        });
        form = null;
        selected = id;
        toast(r.accruedKop ? `Введено в експлуатацію (ОЗ-1) та нараховано знос ${fmtKop(r.accruedKop)} грн` : 'Обʼєкт введено в експлуатацію за Актом ОЗ-1', 'success');
        await loadAssetsView();
    } catch (e) { toast(e.message, 'error'); }
    finally { if (btn.isConnected) setBusy(btn, false); }
}

async function saveWriteOff(btn) {
    const id = btn.dataset.id;
    setBusy(btn, true, 'Проводжу списання…');
    try {
        const r = await assetsAct({
            action: 'writeOffInventory',
            id,
            date: val('woDate'),
            actNo: val('woNo'),
            qty: Number(val('woQty')),
            item: val('woItem'),
            custodian: val('woCustodian'),
            location: val('woLocation'),
            reason: val('woReason')
        });
        form = null;
        selected = id;
        toast(r.acc === '22'
            ? `МШП передано в експлуатацію (${fmtKop(r.amountKop)} грн списано на 92, облік за МВО збережено)`
            : `Списано використані запаси на суму ${fmtKop(r.amountKop)} грн`, 'success');
        await loadAssetsView();
    } catch (e) { toast(e.message, 'error'); }
    finally { if (btn.isConnected) setBusy(btn, false); }
}

async function saveDispose(btn) {
    const id = btn.dataset.id;
    setBusy(btn, true, 'Ліквідую обʼєкт…');
    try {
        const r = await assetsAct({
            action: 'disposeAsset',
            id,
            date: val('dpDate'),
            actNo: val('dpNo'),
            reason: val('dpReason')
        });
        form = null;
        selected = id;
        toast(`Обʼєкт ліквідовано за Актом ОЗ-3 (списано знос ${fmtKop(r.wearKop)} грн)`, 'success');
        await loadAssetsView();
    } catch (e) { toast(e.message, 'error'); }
    finally { if (btn.isConnected) setBusy(btn, false); }
}

async function saveRetireMshp(btn) {
    const id = btn.dataset.id;
    setBusy(btn, true, 'Списую з позабалансу…');
    try {
        await assetsAct({
            action: 'retireMshp',
            id,
            date: val('rtDate'),
            actNo: val('rtNo'),
            qty: Number(val('rtQty')),
            reason: val('rtReason')
        });
        form = null;
        selected = id;
        toast('Зношений МШП списано з оперативного позабалансового обліку', 'success');
        await loadAssetsView();
    } catch (e) { toast(e.message, 'error'); }
    finally { if (btn.isConnected) setBusy(btn, false); }
}

export function initAssetsView() {
    const host = document.getElementById('viewAssets');
    if (!host) return;
    host.addEventListener('click', async e => {
        const seg = e.target.closest('[data-seg]');
        if (seg) { segment = seg.dataset.seg; form = null; loadAssetsView(); return; }
        const btn = e.target.closest('[data-act]');
        if (!btn || btn.disabled) return;
        const a = btn.dataset.act;
        const id = btn.dataset.id || selected;
        const card = (ctx?.items || []).find(x => x.id === id);

        if (a === 'pick') {
            selected = btn.dataset.id;
            loadAssetsView().then(() => {
                if (window.matchMedia('(max-width: 900px)').matches) document.getElementById('asCard')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
            });
            return;
        }
        if (a === 'close-form') { form = null; loadAssetsView(); return; }
        if (a === 'new-card') {
            const defaultAcc = segment === 'mnhma' ? '11' : segment === 'stock' ? '20' : segment === 'mshp' ? '22' : '10';
            form = { kind: 'card', data: { acc: defaultAcc } };
            await loadAssetsView();
            document.getElementById('asForm')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
            return;
        }
        if (a === 'edit-card' && card) {
            form = { kind: 'card', data: { ...card, isEdit: true } };
            await loadAssetsView();
            document.getElementById('asForm')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
            return;
        }
        if (a === 'open-commission' && card) {
            selected = card.id;
            form = { kind: 'commission', id: card.id };
            await loadAssetsView();
            document.getElementById('asForm')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
            return;
        }
        if (a === 'open-writeoff' && card) {
            selected = card.id;
            form = { kind: 'writeoff', id: card.id };
            await loadAssetsView();
            document.getElementById('asForm')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
            return;
        }
        if (a === 'open-dispose' && card) {
            selected = card.id;
            form = { kind: 'dispose', id: card.id };
            await loadAssetsView();
            document.getElementById('asForm')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
            return;
        }
        if (a === 'open-retire-mshp' && card) {
            selected = card.id;
            form = { kind: 'retire-mshp', id: card.id };
            await loadAssetsView();
            document.getElementById('asForm')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
            return;
        }
        if (a === 'open-doc') { openExpenses('docs', null, btn.dataset.doc); return; }
        if (a === 'print-oz1' && card) { printOz1(card); return; }
        if (a === 'print-oz3' && card) { printOz3(card); return; }
        if (a === 'print-writeoff' && card) { printWriteOffAct(card); return; }
        if (a === 'print-inventory') { printInventorySheet(); return; }
        if (a === 'export-csv') { exportCsv(); return; }
        if (a === 'depreciate-month') {
            const plan = ctx.deprPlan;
            if (!plan?.items?.length) return;
            if (!await confirmDialog(
                `Нарахувати амортизацію за ${periodName(ctx.period)}?`,
                `Сума зносу: ${fmtKop(plan.totalKop)} грн (${plan.items.length} об.). Буде сформовано проводки Дт 92 Кт 131/132 та одночасно визнано дохід цільового фінансування Дт 48 Кт 719.`,
                'Нарахувати'
            )) return;
            setBusy(btn, true, 'Нараховую…');
            try {
                await runMonthlyDepreciation(ctx.period);
                await loadAssetsView();
            } catch (err) { toast(err.message, 'error'); }
            finally { if (btn.isConnected) setBusy(btn, false); }
            return;
        }
        if (a === 'save-card') await saveCard(btn);
        else if (a === 'save-commission') await saveCommission(btn);
        else if (a === 'save-writeoff') await saveWriteOff(btn);
        else if (a === 'save-dispose') await saveDispose(btn);
        else if (a === 'save-retire-mshp') await saveRetireMshp(btn);
    });

    host.addEventListener('change', e => {
        if (e.target.id === 'asPeriod') {
            period = e.target.value;
            form = null;
            loadAssetsView();
            return;
        }
        if (e.target.id === 'afAcc' && form?.kind === 'card') {
            const newAcc = e.target.value;
            form.data = {
                ...form.data,
                acc: newAcc,
                subacc: defaultSubacc(newAcc),
                id: suggestAssetId(newAcc, (ctx.items || []).map(x => x.id)),
                name: val('afName'),
                custodian: val('afCustodian'),
                location: val('afLocation')
            };
            loadAssetsView();
        }
    });

    host.addEventListener('input', e => {
        if (e.target.id === 'asQuery') {
            query = e.target.value;
            const pos = e.target.selectionStart;
            loadAssetsView().then(() => {
                const input = document.getElementById('asQuery');
                input?.focus();
                input?.setSelectionRange(pos, pos);
            });
        }
    });
}
