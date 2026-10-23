// ============================================================
// «Налаштування» кабінету бухгалтера.
//
// Ліворуч — розділи з позначками, що потребує уваги; праворуч — сам
// розділ. «Огляд» показує готовність кабінету до роботи: що вже
// налаштовано, чого бракує і куди перейти (settings-core.js).
//
// Довідники (тарифи, приміщення, працівники, постачальники, договори)
// ведуться у своїх розділах — тут лише переходи до них.
// ============================================================
import { escapeHtml, toast, setBusy, confirmDialog, promptDialog } from './ui.js';
import { db, session } from './firebase.js';
import { doc, setDoc } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js';
import { callBackend } from './backend.js';
import {
    loadSettings, loadExpenses, loadRequisites, loadCharges, loadPayroll, loadBudget, loadOpeningData,
    expAct, act, chargeAct, payrollAct, budgetAct, reportsQuery, reportsAct,
    money, when, dateOnly, maskIban, ACCOUNT_PURPOSES, loadStaffNames, authorLabel, invalidate
} from './buh-data.js';
import { toKop, fmtKop, parseOpeningLines, openingSummary } from './charges-core.js';
import { registryHtml, saveRegistry } from './buh-registry.js';
import { openExpenses } from './buh-expenses.js';
import { openCharges } from './buh-charges.js';
import { openPayrollBank, DEFAULT_TAXES, withDefaultTaxes } from './buh-payroll.js';
import { loadOpening, openingAction, openingInput } from './buh-opening.js';
import { loadAccountingSettings } from './buh-accounting-settings.js';
import { mountMigration } from './buh-migration.js';
import { mountDatabaseReset, databaseResetStatus } from './buh-database-reset.js';
import { SECTIONS, sectionKey, readiness, readinessSummary, parseRateRow, nextRateRow } from './settings-core.js';

let section = 'overview';
let anchor = null;          // картка, до якої прокрутити після переходу з «Огляду»
let requisites = {};
let data = {};              // усе, з чого рахується готовність
let items = [];
let openingSign = 'overpaid';
let annualYear = String(new Date().getFullYear());
let annualReport = null;
let staffNames = {};
let budgetCtx = null;

export function setSettingsTab(next) {
    section = sectionKey(next);
    anchor = null;
    try { sessionStorage.removeItem('buh_settings_tab'); } catch { /* ignore */ }
}

export function openSettings(next = 'overview') {
    setSettingsTab(next);
    if (location.hash !== '#settings') location.hash = 'settings';
    else loadSettingsView();
}

const ICONS = {
    overview: '<path d="M4 12.5 9 17l11-11"/>',
    org: '<path d="M4 21V7l8-4 8 4v14"/><path d="M9 21v-5h6v5M9 10h.01M15 10h.01"/>',
    bank: '<path d="M3 10h18L12 4z"/><path d="M5 10v8M10 10v8M14 10v8M19 10v8M3 21h18"/>',
    policy: '<rect x="5" y="3" width="14" height="18" rx="2"/><path d="M9 8h6M9 12h6M9 16h3"/>',
    rules: '<path d="M12 3 4 6v6c0 4.5 3.4 8.3 8 9 4.6-.7 8-4.5 8-9V6z"/><path d="m9 12 2 2 4-4"/>',
    startup: '<path d="M12 3v12M7 10l5 5 5-5"/><path d="M5 21h14"/>',
    service: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9 7 7M17 17l2.1 2.1M4.9 19.1 7 17M17 7l2.1-2.1"/>'
};
const icon = k => `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[k]}</svg>`;

const STATE = { ok: ['готово', 'is-done'], todo: ['не налаштовано', 'is-bad'], wait: ['чекає голову', 'is-work'], warn: ['потрібна увага', 'is-work'] };
const chip = (text, cls = '') => `<span class="sv-chip ${cls}">${escapeHtml(text)}</span>`;
const stateChip = key => { const i = items.find(x => x.key === key); return i ? chip(...STATE[i.state]) : ''; };
const card = (id, title, head, body, cls = '') => `<section class="py-card se-card ${cls}" id="${id}">
        <div class="se-card-head"><h3>${title}</h3>${head || ''}</div>${body}</section>`;
const isChair = () => session.role === 'chair';

// ------------------------------------------------------------
// ОГЛЯД
// ------------------------------------------------------------
function checkRow(i) {
    // Додаткова можливість без налаштування — не тривога, а просто «вимкнено».
    const off = !i.need && i.state === 'todo';
    return `<button type="button" class="se-check is-${off ? 'off' : i.state}" data-st-go="${i.section}" data-anchor="se-${i.key}">
        <i class="se-dot" aria-hidden="true"></i>
        <span class="se-check-main"><b>${escapeHtml(i.title)}</b><small>${escapeHtml(i.note)}</small></span>
        <span class="se-check-state">${off ? 'вимкнено' : escapeHtml(STATE[i.state][0])}</span><span class="se-go" aria-hidden="true">›</span></button>`;
}

function overviewHtml() {
    const s = readinessSummary(items);
    const pct = s.total ? Math.round(s.done / s.total * 100) : 100;
    const links = [
        ['charges', 'tariffs', 'Тарифи й складові внеску', 'Нарахування → Тарифи'],
        ['charges', 'premises', 'Приміщення, проживаючі, особові рахунки', 'Нарахування → Приміщення'],
        ['flats', '', 'Квартири й власники', 'Квартири'],
        ['payroll', '', 'Працівники й підрядники ЦПД', 'Зарплата'],
        ['expenses', 'suppliers', 'Постачальники', 'Документи → Постачальники'],
        ['expenses', 'contracts', 'Договори', 'Документи → Договори']
    ];
    return `<section class="py-card se-hero${s.done === s.total ? ' is-done' : ''}">
            <div class="se-ring" style="--p:${pct}" role="img" aria-label="Налаштовано ${s.done} з ${s.total}"><b>${s.done}</b><small>з ${s.total}</small></div>
            <div class="se-hero-text">
                <h3>${s.done === s.total ? 'Кабінет налаштовано' : `Налаштовано ${s.done} з ${s.total}`}</h3>
                <p>${s.next ? `Далі: <b>${escapeHtml(s.next.title)}</b> — ${escapeHtml(s.next.note)}` : 'Усе обовʼязкове заповнено. Нижче — додаткові можливості.'}</p>
                ${s.next ? `<button type="button" class="sv-btn" data-st-go="${s.next.section}" data-anchor="se-${s.next.key}">${escapeHtml(s.next.title)} ›</button>` : ''}
            </div>
        </section>
        <section class="py-card se-card"><div class="se-card-head"><h3>Для роботи</h3><span class="py-muted">${s.done} з ${s.total}</span></div>
            ${items.filter(i => i.need).map(checkRow).join('')}</section>
        <section class="py-card se-card"><div class="se-card-head"><h3>Додаткові можливості</h3></div>
            ${items.filter(i => !i.need).map(checkRow).join('')}</section>
        <section class="py-card se-card"><div class="se-card-head"><h3>Довідники — у своїх розділах</h3></div>
            <p class="se-lead">Тарифи, приміщення, люди й контрагенти ведуться там, де з ними працюють.</p>
            <div class="se-links">${links.map(([go, tab, title, where]) => `<button type="button" class="se-link" data-act="st-open" data-to="${go}" data-tab="${tab}">
                <b>${escapeHtml(title)}</b><small>${escapeHtml(where)} ›</small></button>`).join('')}</div>
        </section>`;
}

// ------------------------------------------------------------
// ОРГАНІЗАЦІЯ
// ------------------------------------------------------------
const XML_INPUTS = [
    ['katottg', 'Код КАТОТТГ', 'maxlength="19" spellcheck="false" placeholder="UA і 17 цифр, з витягу ЄДР"'],
    ['zip', 'Поштовий індекс', 'inputmode="numeric" maxlength="5"'],
    ['address', 'Податкова адреса'],
    ['phone', 'Телефон', 'inputmode="tel"'],
    ['email', 'Ел. пошта', 'type="email"'],
    ['headName', 'Керівник: імʼя та прізвище'],
    ['headTin', 'РНОКПП керівника', 'inputmode="numeric" maxlength="10"'],
    ['accName', 'Бухгалтер: імʼя та прізвище'],
    ['accTin', 'РНОКПП бухгалтера', 'inputmode="numeric" maxlength="10"']
];

const purposePreview = tpl => String(tpl || '').replace(/\{apt\}/g, '12').replace(/\{account\}/g, '10012').replace(/\{period\}/g, 'жовтень 2026');

function orgHtml() {
    const accounts = Object.entries(data.bank?.accounts || {});
    const currentAcc = accounts.find(([, a]) => (a.purpose || 'current') === 'current')?.[0] || accounts[0]?.[0] || '';
    const reg = requisites.registry || {};
    const payeeName = requisites.payeeName || reg.legalName || 'ОСББ «Успіх-25»';
    const edrpou = requisites.edrpou || reg.code || '40562894';
    const iban = requisites.iban || currentAcc || '';
    const houseAddress = requisites.houseAddress || 'вул. Інглезі, 3/3, м. Одеса';
    const purpose = requisites.purposeTemplate || 'Внески на утримання будинку, кв. {apt}, особовий рахунок {account}';
    const xml = data.xmlCtx || { settings: {}, offices: [] };
    const v = xml.settings || {};

    return card('se-pay', 'Платіжні реквізити', stateChip('pay'), `
            <p class="se-lead">У квитанціях, QR-коді НБУ, довідках і претензіях.</p>
            <div class="se-grid" id="stPayRequisitesForm">
                <label class="py-field se-wide"><span>Отримувач</span><input id="stReqPayee" maxlength="160" value="${escapeHtml(payeeName)}"></label>
                <label class="py-field"><span>Код ЄДРПОУ</span><input id="stReqEdrpou" inputmode="numeric" maxlength="8" value="${escapeHtml(edrpou)}"></label>
                <label class="py-field se-wide"><span>IBAN для внесків</span>
                    <span class="se-row"><input id="stReqIban" maxlength="34" spellcheck="false" value="${escapeHtml(iban)}" placeholder="UA…">
                    ${accounts.length ? `<select id="stReqIbanPick" class="field-select" aria-label="Обрати з рахунків ПриватБанку">
                        <option value="">З рахунків банку…</option>
                        ${accounts.map(([acc, a]) => `<option value="${escapeHtml(acc)}">${escapeHtml(maskIban(acc))} · ${escapeHtml(ACCOUNT_PURPOSES[a.purpose] || 'Поточний')}</option>`).join('')}
                    </select>` : ''}</span></label>
                <label class="py-field se-full"><span>Адреса будинку</span><input id="stReqAddress" maxlength="200" value="${escapeHtml(houseAddress)}"></label>
                <label class="py-field se-full"><span>Призначення платежу · {apt} — квартира, {account} — о/р, {period} — місяць</span>
                    <input id="stReqPurpose" maxlength="220" value="${escapeHtml(purpose)}"></label>
                <p class="se-preview se-full">У квитанції: <b id="stPurposePreview">${escapeHtml(purposePreview(purpose))}</b></p>
            </div>
            <div class="se-actions"><button type="button" class="sv-btn" data-act="save-pay-requisites">Зберегти</button></div>`)
        + card('se-xml', 'Звітність до ДПС', stateChip('xml'), `
            <p class="se-lead">Підставляються в XML податкового розрахунку (Д1), 4ДФ і Д5 для Е-кабінету. РНОКПП бачать лише голова й бухгалтер.</p>
            <div class="se-grid" id="stXmlSettingsForm">
                <label class="py-field se-full"><span>Податкова інспекція</span>
                    <select name="sti" class="field-select">${(xml.offices || []).map(o => `<option value="${o.code}"${o.code === Number(v.sti) ? ' selected' : ''}>${escapeHtml(`${o.code} — ${o.name}`)}</option>`).join('')}</select></label>
                ${XML_INPUTS.map(([k, label, extra = '']) => `<label class="py-field${k === 'address' ? ' se-full' : ''}"><span>${label}</span>
                    <input name="${k}" value="${escapeHtml(v[k] || '')}" ${extra}></label>`).join('')}
            </div>
            <div class="se-actions"><button type="button" class="sv-btn" data-act="save-xml-settings">Зберегти</button>
                <button type="button" class="sv-btn is-soft" data-go="reports">До «Звітів» ›</button></div>`)
        + `<div id="se-registry" class="se-wrap">${registryHtml(requisites.registry, requisites.houseAddress)}</div>`;
}

// ------------------------------------------------------------
// БАНК І СЕРВІСИ
// ------------------------------------------------------------
const aiNote = (set, tail) => set
    ? `Ключ …${tail} зберігається лише на сервері. Скани, фото й PDF розпізнає Google Gemini.`
    : 'Без ключа читаються лише електронні документи M.E.Doc і Вчасно (XML, ZIP, .p7s).';

function accountBalance(a) {
    if (typeof a.balanceKop !== 'number') return '—';
    return a.currency && a.currency !== 'UAH'
        ? `${(a.balanceKop / 100).toLocaleString('uk-UA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${escapeHtml(a.currency)}`
        : money(a.balanceKop);
}

function bankHtml() {
    const s = data.bank || {};
    const connected = s.tokenSet === true;
    const sync = s.lastSync;
    const accounts = Object.entries(s.accounts || {});
    const ex = data.ex?.settings || {};
    const ai = ex.aiKey || { set: false, tail: '' };
    const ycReal = Boolean(ex.youscoreHasRealKey);
    const steps = `<ol class="se-steps">
            <li>Приват24 для бізнесу → «Інтеграція (Автоклієнт)» → «Підключити додаток», тип «API».</li>
            <li>Дозвольте виписки, залишки й створення платежів. Платіж однаково проводиться лише після підпису КЕП голови.</li>
            <li>«API для розробників» → скопіюйте token. «Обмеження за IP» лишіть порожнім.</li></ol>`;

    return card('se-privat', 'ПриватБанк', connected ? chip(`підключено · …${s.tokenHint || ''}`, sync?.ok === false ? 'is-work' : 'is-done') : chip('не підключено', 'is-bad'), `
            <p class="se-lead">${!connected ? 'Виписка й залишки завантажуються щогодини, платежі йдуть на підпис голові в Приват24.'
                : sync?.ok === false ? `Остання спроба ${escapeHtml(when(sync.at))}: ${escapeHtml(sync.error || 'помилка')}`
                : sync?.waiting ? 'Банк зараз оновлює дані — виписку перевіримо пізніше.'
                : sync ? `Виписку оновлено ${escapeHtml(when(sync.at))}${sync.added ? ` · нових операцій: ${sync.added}` : ''}` : 'Перша виписка — протягом години.'}</p>
            ${connected ? `<details class="se-more"><summary>Як замінити токен</summary>${steps}</details>` : steps}
            <div class="se-row se-inline">
                <input id="tokenInput" type="password" autocomplete="off" spellcheck="false" placeholder="${connected ? 'Новий токен, щоб замінити' : 'Вставте токен'}" aria-label="Токен Автоклієнта">
                <button type="button" class="sv-btn" data-act="token-save">Перевірити й зберегти</button>
                ${connected ? '<button type="button" class="sv-btn is-soft" data-act="token-remove">Відключити</button>' : ''}
            </div>
            <p class="se-hint">Токен бачить лише сервер. Тестовий банк підключає голова в <a href="platform.html#bank">симуляторі Приват24</a>. Зарплатний проект і відомості — <button type="button" class="se-a" data-act="st-payroll-bank">у «Зарплата → Приват24» ›</button></p>`)
        + (accounts.length ? card('se-accounts', 'Рахунки ОСББ', `<span class="py-muted">${accounts.length}</span>`, `
            <p class="se-lead">Призначення визначає субрахунок обліку (311, 313, 351) і рахунок для оплат і зарплати.</p>
            ${accounts.map(([iban, a]) => `<div class="se-acc" data-iban="${escapeHtml(iban)}">
                <span class="se-acc-main"><b>${escapeHtml(maskIban(iban))}</b><small>${escapeHtml(a.name || '')}${a.available === false ? ' · немає доступу за токеном' : ''}${a.currency && a.currency !== 'UAH' ? ` · ${escapeHtml(a.currency)}` : ''}</small></span>
                <b class="se-acc-sum">${accountBalance(a)}</b>
                <select class="field-select acc-purpose-select" aria-label="Призначення ${escapeHtml(maskIban(iban))}">${Object.entries(ACCOUNT_PURPOSES).map(([k, t]) =>
                    `<option value="${k}"${k === (a.purpose || 'current') ? ' selected' : ''}>${t}</option>`).join('')}</select>
            </div>`).join('')}`) : '')
        + card('se-youscore', 'YouScore', chip(ycReal ? `бойовий ключ ${ex.youscoreKeyMasked || ''}` : 'тестовий режим', ycReal ? 'is-done' : 'is-work'), `
            <p class="se-lead">Автозаповнення постачальників з ЄДР, податковий борг; суди й виконавчі провадження боржників; перевірка власника квартири (ДРРП).</p>
            <div class="se-row se-inline">
                <input id="stYouscoreKeyInput" type="password" autocomplete="off" spellcheck="false" placeholder="${ycReal ? 'Новий ключ, щоб замінити' : 'API-ключ YouScore'}" aria-label="API-ключ YouScore">
                <button type="button" class="sv-btn" data-act="youscore-key-save">Зберегти</button>
                <button type="button" class="sv-btn is-soft" data-act="youscore-key-balance">Залишок запитів</button>
                ${ycReal ? '<button type="button" class="sv-btn is-soft" data-act="youscore-key-sandbox">Тестовий режим</button>' : ''}
            </div>
            <p class="se-hint" id="stYouscoreStatusNote">${ycReal ? 'Ключ зберігається лише на сервері.' : 'Поки ключа немає, працює пісочниця: перевірки показують тестові дані й нічого не коштують. Для даних про нерухомість власник ключа проходить верифікацію на youscore.com.ua.'}</p>`)
        + card('se-ai', 'Розпізнавання сканів (AI)', `<span id="aiKeyBadge">${chip(ai.set ? `підключено · …${ai.tail}` : 'не підключено', ai.set ? 'is-done' : '')}</span>`, `
            <p class="se-lead">Скани, фото й PDF рахунків та актів читає Google Gemini; система підказує, що перевірити: код, IBAN, ПДВ, дату.</p>
            <div class="se-row se-inline">
                <input id="aiKeyInput" type="password" autocomplete="off" spellcheck="false" placeholder="${ai.set ? `Новий ключ, щоб замінити …${escapeHtml(ai.tail)}` : 'Gemini API Key (AIza…)'}" aria-label="Ключ Google AI Studio">
                <button type="button" class="sv-btn" data-act="ai-key-save">Перевірити й зберегти</button>
                <button type="button" class="sv-btn is-soft" data-act="ai-key-clear" id="aiKeyClearBtn"${ai.set ? '' : ' hidden'}>Видалити ключ</button>
            </div>
            <p class="se-hint" id="aiKeyStatusNote">${escapeHtml(aiNote(ai.set, ai.tail))} <a href="https://aistudio.google.com/app/apikey" target="_blank" rel="noopener">Безкоштовний ключ у Google AI Studio ↗</a></p>`);
}

function updateAiKeyUi(info) {
    const set = Boolean(info?.set), tail = info?.tail || '';
    const badge = document.getElementById('aiKeyBadge');
    if (badge) badge.innerHTML = chip(set ? `підключено · …${tail}` : 'не підключено', set ? 'is-done' : '');
    const note = document.getElementById('aiKeyStatusNote');
    if (note) note.textContent = aiNote(set, tail);
    const input = document.getElementById('aiKeyInput');
    if (input) { input.value = ''; input.placeholder = set ? `Новий ключ, щоб замінити …${tail}` : 'Gemini API Key (AIza…)'; }
    const clear = document.getElementById('aiKeyClearBtn');
    if (clear) clear.hidden = !set;
}

// ------------------------------------------------------------
// ОБЛІК І ПОДАТКИ
// ------------------------------------------------------------
const pct = bps => (Number(bps) / 100).toLocaleString('uk-UA', { maximumFractionDigits: 2 });
const grn = kop => (Number(kop) / 100).toFixed(2).replace('.', ',');

function rateRow(r, edit) {
    const dis = edit ? '' : ' disabled';
    return `<tr>
        <td><input class="st-rate-from" type="month" value="${escapeHtml(r.from || '')}" aria-label="Діє з"${dis}></td>
        <td><input class="st-rate-to" type="month" value="${escapeHtml(r.to || '')}" aria-label="Діє до"${dis}></td>
        <td><input class="st-rate-pdfo" inputmode="decimal" value="${pct(r.pdfo)}" aria-label="ПДФО, %"${dis}></td>
        <td><input class="st-rate-vz" inputmode="decimal" value="${pct(r.vz)}" aria-label="ВЗ, %"${dis}></td>
        <td><input class="st-rate-esv" inputmode="decimal" value="${pct(r.esv)}" aria-label="ЄСВ, %"${dis}></td>
        <td><input class="st-rate-min" inputmode="decimal" value="${grn(r.minWageKop)}" aria-label="Мінімальна зарплата, грн"${dis}></td>
        <td><input class="st-rate-max" inputmode="numeric" value="${r.maxBaseMult ?? ''}" aria-label="Макс. база ЄСВ, мінімалок"${dis}></td>
        <td><input class="st-rate-sub" inputmode="decimal" value="${grn(r.subsistenceKop)}" aria-label="Прожитковий мінімум, грн"${dis}></td>
    </tr>`;
}

function policyHtml() {
    const chair = isChair();
    const p = data.payroll?.settings || {};
    const taxes = withDefaultTaxes(p.taxes || {});
    const rates = [...(p.rates || [])].sort((a, b) => String(a.from).localeCompare(String(b.from)));
    const taxRow = (key, title, hint) => {
        const t = taxes[key] || {};
        return `<div class="se-tax"><div class="se-tax-head"><b>${title}</b><small>${hint}</small></div>
            <div class="se-grid se-tax-grid">
                <label class="py-field"><span>Отримувач</span><input data-st-tax="${key}.name" value="${escapeHtml(t.name || '')}"></label>
                <label class="py-field"><span>ЄДРПОУ</span><input data-st-tax="${key}.code" inputmode="numeric" maxlength="8" value="${escapeHtml(t.code || '')}"></label>
                <label class="py-field"><span>IBAN бюджетного рахунку</span><input data-st-tax="${key}.iban" maxlength="34" spellcheck="false" value="${escapeHtml(t.iban || '')}"></label>
            </div></div>`;
    };

    return `<div id="se-policy" class="se-wrap"><div id="accountingSettings"><section class="py-card se-card"><p class="py-muted">Завантаження облікової політики…</p></section></div></div>`
        + card('se-rates', 'Ставки зарплатних податків', stateChip('rates'), `
            <p class="se-lead">Відомість кожного місяця бере рядок, чинний у цьому місяці. Затверджені відомості не змінюються.${chair ? '' : ' Змінює голова.'}</p>
            <div class="se-scroll"><table class="se-rates" id="stRatesTable">
                <thead><tr><th>Діє з</th><th>Діє до</th><th>ПДФО, %</th><th>ВЗ, %</th><th>ЄСВ, %</th><th>Мін. зарплата, грн</th><th>Макс. база ЄСВ, мін.</th><th>Прожитк. мінімум, грн</th></tr></thead>
                <tbody>${(rates.length ? rates : [nextRateRow([])]).map(r => rateRow(r, chair)).join('')}</tbody>
            </table></div>
            ${chair ? `<div class="se-row se-inline">
                <input id="stRatesBasis" maxlength="300" value="${escapeHtml(p.ratesBasis || '')}" placeholder="Підстава: закон про Держбюджет, дата" aria-label="Підстава">
                <button type="button" class="sv-btn is-soft" data-act="st-rate-add">+ Наступний рік</button>
                <button type="button" class="sv-btn" data-act="st-rates-save">Зберегти ставки</button>
            </div>` : ''}`)
        + card('se-taxes', 'Бюджетні рахунки й аванс', '', `
            <p class="se-lead">На ці рахунки формуються платіжки ПДФО, військового збору та ЄСВ під час виплати авансу й зарплати.</p>
            ${taxRow('pdfo', 'ПДФО', 'у день виплати доходу · код 11010100 (зарплата), 11010400 (ЦПД)')}
            ${taxRow('vz', 'Військовий збір', 'у день виплати доходу · код 11011000')}
            ${taxRow('esv', 'ЄСВ', 'під час виплати або до 20 числа наступного місяця')}
            <div class="se-row se-inline">
                <label class="py-field se-narrow"><span>Аванс, % окладу</span><input id="stAdvPct" inputmode="numeric" maxlength="2" value="${p.advancePct ?? 50}"></label>
                <button type="button" class="sv-btn" data-act="st-save-taxes">Зберегти</button>
                <button type="button" class="sv-btn is-soft" data-act="st-fill-odesa-taxes">Підставити рахунки Одеси</button>
            </div>`);
}

// ------------------------------------------------------------
// ПРАВИЛА
// ------------------------------------------------------------
const RULES = [
    ['Рознесення оплат мешканців', 'Система; сумнівні — бухгалтер', 'ст. 9 Закону № 996-XIV'],
    ['Інші надходження (оренда, відсотки, гранти)', 'Бухгалтер', 'п. 133.4.2 ПКУ'],
    ['Платежі постачальникам', 'Бухгалтер готує, підпис КЕП — голова', 'п. 3.4.15 статуту'],
    ['Договори', 'Голова (погодження правління)', 'п. 3.4.15 статуту'],
    ['Рахунки й акти в межах договору', 'Бухгалтер', 'договір затвердив голова'],
    ['Витрати без договору чи понад договір', 'Голова; до порогу — бухгалтер', 'рішення правління'],
    ['Договори понад 50 000 грн', 'Загальні збори', 'п. 3.4.15 статуту'],
    ['Податкова й фінансова звітність', 'Бухгалтер готує, КЕП — голова', 'пп. 48.5.1 ПКУ']
];

function rulesHtml() {
    const chair = isChair();
    const small = data.ex?.settings?.smallKop || 0;
    const show = budgetCtx?.showApartments === true;
    const martial = requisites?.martialLaw !== false;
    return card('se-approvals', 'Хто що погоджує', '', `
            <div class="se-rules">${RULES.map(([op, who, why]) => `<div class="se-rule"><b>${escapeHtml(op)}</b><span>${escapeHtml(who)}</span><small>${escapeHtml(why)}</small></div>`).join('')}</div>
            <div class="se-row se-inline se-threshold">
                <span>Витрати без договору до</span>
                <input id="smallInput" inputmode="decimal" value="${(small / 100).toFixed(2).replace('.', ',')}"${chair ? '' : ' disabled'} aria-label="Поріг, грн">
                <span>грн затверджує бухгалтер</span>
                ${chair ? '<button type="button" class="sv-btn is-soft" data-act="small-save">Зберегти поріг</button>' : '<small class="py-muted">змінює голова</small>'}
            </div>`)
        + card('se-public', 'Публічність звіту', chip(show ? 'номери квартир видно' : 'анонімно', show ? 'is-work' : ''), `
            <label class="se-switch"><input type="checkbox" data-act="st-visibility"${show ? ' checked' : ''}${chair ? '' : ' disabled'}>
                <span><b>Показувати мешканцям номери квартир у «Фінансах будинку»</b>
                <small>У надходженнях і списку боржників. Прізвищ — ніколи. Номер квартири — теж персональні дані: вмикайте за рішенням правління чи зборів.${chair ? '' : ' Змінює голова.'}</small></span></label>`)
        + card('se-martial', 'Пеня і воєнний стан', chip(martial ? 'пеня не нараховується' : 'пеня нараховується', martial ? '' : 'is-work'), `
            <label class="se-switch"><input type="checkbox" data-act="st-martial-law"${martial ? ' checked' : ''}>
                <span><b>Діє воєнний стан</b>
                <small>Основний борг стягується через суд, а пеня й штрафи населенню — 0 грн (постанова КМУ № 206). Після скасування вимкніть: претензії й позови рахуватимуть пеню та інфляційні за ст. 625 ЦК.</small></span></label>`);
}

// ------------------------------------------------------------
// ПЕРЕХІД НА ОБЛІК
// ------------------------------------------------------------
function openingPreview() {
    const host = document.getElementById('stOpPreview');
    const c = data.charges;
    if (!host || !c) return;
    const { rows: parsed, errors } = parseOpeningLines(document.getElementById('stOpText')?.value, openingSign);
    if (!parsed.length && !errors.length) { host.innerHTML = ''; return; }
    const known = new Set((c.apartments || []).map(a => a.apt));
    const unknown = parsed.filter(r => !known.has(r.apt)).map(r => r.apt);
    const s = openingSummary(parsed);
    const missing = (c.apartments || []).length - parsed.filter(r => known.has(r.apt)).length;
    host.innerHTML = `<div class="se-tiles">
            <div><span>Рядків</span><b>${s.count}</b><small>${missing > 0 ? `${missing} прим. без рядка — буде 0` : 'усі приміщення'}</small></div>
            <div><span>Борг</span><b class="is-out">${fmtKop(s.debtKop)}</b><small>${s.debtors} кв.</small></div>
            <div><span>Переплата</span><b class="is-in">${fmtKop(s.overpaidKop)}</b><small>${parsed.filter(r => r.amountKop > 0).length} кв.</small></div>
        </div>
        ${unknown.length ? `<p class="se-warn">Немає в довіднику: ${unknown.slice(0, 10).map(escapeHtml).join(', ')} — виправте перед збереженням</p>` : ''}
        ${errors.length ? `<p class="se-warn">Незрозумілі рядки: ${errors.slice(0, 6).map(e => `№${e.line} «${escapeHtml(e.raw.slice(0, 30))}»`).join(', ')}</p>` : ''}
        <p class="se-hint">Перевірте знак: ${parsed.slice(0, 3).map(r => `кв. ${escapeHtml(r.apt)} — ${r.amountKop < 0 ? 'борг' : r.amountKop > 0 ? 'переплата' : 'розраховано'} ${fmtKop(Math.abs(r.amountKop))}`).join('; ')}</p>`;
}

function startupHtml() {
    const chair = isChair();
    const c = data.charges || { opening: null, startPeriod: '2026-10', startDate: '2026-10-01', apartments: [] };
    const o = c.opening;
    const cutoff = new Date(Date.parse(`${c.startDate || `${c.startPeriod || '2026-10'}-01`}T12:00:00Z`) - 86400000).toISOString().slice(0, 10).split('-').reverse().join('.');
    const startYr = Number(String(data.bank?.startDate || '2026-10-01').slice(0, 4)) || new Date().getFullYear();
    const years = Array.from({ length: Math.max(1, new Date().getFullYear() - startYr + 2) }, (_, i) => startYr + i).reverse();
    if (!years.includes(Number(annualYear))) years.push(Number(annualYear));
    const rep = annualReport;
    const prev = Number(annualYear) - 1;

    return `<p class="se-intro">Порядок: перенесіть базу або внесіть залишки вручну → звірте вхідну ОСВ → голова затверджує. Після першого закритого місяця залишки не змінюються.</p>
        ${chair ? '<div id="se-migration" class="se-wrap"><div id="migrationSettings"></div></div>' : ''}
        ${card('se-opening', `Залишки квартир на ${escapeHtml(cutoff)}`, stateChip('opening'), `
            ${c.startDate && !c.startDate.endsWith('-01') && chair ? `<div class="se-callout">Місяць переходу вже нараховано в попередній системі? Підтвердьте перенос, щоб не нарахувати двічі.
                <button type="button" class="sv-btn is-soft" data-act="st-imported-month">Підтвердити перенесений місяць</button></div>` : ''}
            ${o?.set ? `<p class="se-lead">${o.count} кв. · борг ${fmtKop(o.debtKop)} · переплата ${fmtKop(o.overpaidKop)} грн · ${escapeHtml(authorLabel(staffNames, o.by))}${o.at ? `, ${escapeHtml(dateOnly(o.at))}` : ''}. Баланс мешканців рахує система: залишок + оплати − нарахування.</p>
                <div class="se-actions"><button type="button" class="sv-btn is-soft" data-act="st-recompute">Перерахувати баланси з історії</button></div>`
            : '<p class="se-lead">Борги й переплати кожної квартири з попереднього обліку. Після внесення баланс мешканців рахується автоматично.</p>'}
            <details class="se-more"${o?.set ? '' : ' open'}><summary>${o?.set ? 'Виправити залишки' : 'Внести залишки'}</summary>
                <p class="se-hint">Рядок — «квартира;сума», можна вставити два стовпці з Excel. Приміщення без рядка отримає 0. Повторне збереження замінює весь список.</p>
                <div class="se-seg" role="radiogroup" aria-label="Знак боргу">
                    <button type="button" class="${openingSign === 'overpaid' ? 'is-active' : ''}" data-st-sign="overpaid">Мінус — борг</button>
                    <button type="button" class="${openingSign === 'debt' ? 'is-active' : ''}" data-st-sign="debt">Плюс — борг</button>
                </div>
                <textarea id="stOpText" rows="6" spellcheck="false" placeholder="45;-1250,40&#10;46;210,00&#10;н1;0" aria-label="Залишки квартир"></textarea>
                <div id="stOpPreview"></div>
                <div class="se-actions">
                    <button type="button" class="sv-btn" data-act="st-opening-save">Зберегти залишки</button>
                    <button type="button" class="sv-btn is-soft" data-act="st-opening-fill">Заповнити з поточних балансів</button>
                </div>
            </details>`)}
        <div id="se-osv" class="se-wrap"><div id="stOpeningHost"><section class="py-card se-card"><p class="py-muted">Завантаження вхідної ОСВ…</p></section></div></div>
        ${card('se-annual', 'Попередній рік та історія до переходу', `<label class="se-year"><span>Звітний рік</span>
                <select id="stAnnualYear" class="field-select">${years.map(y => `<option value="${y}"${String(y) === String(annualYear) ? ' selected' : ''}>${y}</option>`).join('')}</select></label>`, `
            <p class="se-lead">Фінзвітність (форма 2-м) потребує колонки за ${prev} рік. Якщо облік почато не з 1 січня — ще й журнал проводок від початку року до переходу.</p>
            <div class="se-grid">
                <label class="py-field"><span>Доходи за ${prev}, грн</span><input id="stPriorIncome" inputmode="decimal" value="${rep?.previousIncome?.incomeKop !== undefined ? grn(rep.previousIncome.incomeKop) : ''}" placeholder="0,00"${chair ? '' : ' disabled'}></label>
                <label class="py-field"><span>Витрати за ${prev}, грн</span><input id="stPriorCost" inputmode="decimal" value="${rep?.previousIncome?.costKop !== undefined ? grn(rep.previousIncome.costKop) : ''}" placeholder="0,00"${chair ? '' : ' disabled'}></label>
                <label class="py-field se-full"><span>Підстава</span><input id="stPriorBasis" maxlength="500" value="${escapeHtml(rep?.previousIncome?.basis || '')}" placeholder="Фінансовий звіт за ${prev} рік, квитанція № 2"${chair ? '' : ' disabled'}></label>
            </div>
            ${chair ? '<div class="se-actions"><button type="button" class="sv-btn is-soft" data-act="st-annual-comparative">Погодити порівняльні дані</button></div>' : '<p class="se-hint">Порівняльні дані погоджує голова.</p>'}
            <details class="se-more"><summary>Перенести журнал проводок з початку року (JSON)</summary>
                <p class="se-hint">Залишки на 1 січня й журнал до дати переходу, суми в копійках; має збігтися з вхідною ОСВ. <a href="docs/accounting/MIGRATION.md" download>Формат файлу ↗</a></p>
                <div class="se-grid">
                    <label class="py-field"><span>Файл JSON</span><input id="stAnnualImportFile" type="file" accept=".json,application/json"></label>
                    <label class="py-field"><span>Джерело / підстава звірки</span><input id="stAnnualImportBasis" maxlength="500" placeholder="Попередня система, дата звірки"></label>
                </div>
                <div class="se-actions">
                    <button type="button" class="sv-btn is-soft" data-act="st-annual-import">Перевірити й завантажити</button>
                    ${chair ? '<button type="button" class="sv-btn" data-act="st-annual-approve">Погодити перенос</button>' : ''}
                </div>
            </details>`)}`;
}

// ------------------------------------------------------------
// ОБСЛУГОВУВАННЯ
// ------------------------------------------------------------
function serviceHtml() {
    return card('se-test', 'Тестовий полігон', '', `
            <p class="se-lead">Окремий навчальний будинок: нарахування, імітована виписка, зарплата, проводки й звірка звітів. Робочу базу не зачіпає.</p>
            <div class="se-actions"><a class="sv-btn" href="accounting-test.html">Відкрити полігон ›</a><a class="sv-btn is-soft" href="platform.html">Платформа ОСББ ›</a></div>`)
        + (isChair() ? '<div id="se-reset" class="se-wrap"><div id="resetSettings"></div></div>' : '');
}

// ------------------------------------------------------------
// ЗАВАНТАЖЕННЯ Й РЕНДЕР
// ------------------------------------------------------------
async function loadData() {
    const [bank, ex, req, xmlCtx, payroll, policy, charges, osv] = await Promise.all([
        loadSettings(),
        loadExpenses().catch(() => null),
        loadRequisites().catch(() => ({})),
        reportsQuery({ action: 'xmlSettings' }).catch(() => null),
        loadPayroll(null).catch(() => null),
        callBackend('journalAction', { action: 'policy' }).catch(() => null),
        loadCharges().catch(() => null),
        loadOpeningData().catch(() => null)
    ]);
    requisites = req || {};
    data = { bank, ex, xmlCtx, payroll, policy, charges, osv };
    items = readiness({
        requisites,
        xml: xmlCtx?.settings || {},
        bank,
        policy: policy || {},
        rates: payroll?.settings?.rates || [],
        opening: charges?.opening || null,
        osv: osv?.status || 'none',
        aiKey: Boolean(ex?.settings?.aiKey?.set),
        youscore: Boolean(ex?.settings?.youscoreHasRealKey)
    });
}

function navHtml() {
    const s = readinessSummary(items);
    return `<nav class="se-nav" aria-label="Розділи налаштувань">${Object.entries(SECTIONS).map(([k, [title, sub]]) => {
        const n = s.bySection[k] || 0;
        const badge = k === 'overview' ? `<i class="se-badge${s.done === s.total ? ' is-ok' : ''}">${s.done}/${s.total}</i>` : n ? `<i class="se-badge">${n}</i>` : '';
        return `<button type="button" class="se-nav-item${k === section ? ' is-active' : ''}" data-st-tab="${k}"${k === section ? ' aria-current="page"' : ''}>
            <span class="se-ico">${icon(k)}</span><span class="se-nav-text"><b>${escapeHtml(title)}</b><small>${escapeHtml(sub)}</small></span>${badge}</button>`;
    }).join('')}</nav>`;
}

export async function loadSettingsView() {
    const host = document.getElementById('viewSettings');
    if (!host) return;
    try {
        const wanted = sessionStorage.getItem('buh_settings_tab');
        if (wanted) { section = sectionKey(wanted); sessionStorage.removeItem('buh_settings_tab'); }
    } catch { /* ignore */ }

    // Поки триває повне очищення бази, голова бачить лише його.
    if (isChair()) {
        const reset = await databaseResetStatus().catch(() => null);
        if (reset?.job?.active) {
            host.innerHTML = '<div id="resetSettings"></div>';
            await mountDatabaseReset(document.getElementById('resetSettings'), reset);
            return;
        }
    }

    const scrollY = window.scrollY;
    const hadContent = host.querySelector('.se-layout');
    await loadData();
    if (section === 'rules') budgetCtx = await loadBudget(String(new Date().getFullYear())).catch(() => ({ showApartments: false }));
    if (section === 'startup') {
        [staffNames, annualReport] = await Promise.all([
            loadStaffNames().catch(() => ({})),
            reportsQuery({ action: 'annual', year: annualYear }).catch(() => null)
        ]);
    }

    const body = section === 'org' ? orgHtml() : section === 'bank' ? bankHtml() : section === 'policy' ? policyHtml()
        : section === 'rules' ? rulesHtml() : section === 'startup' ? startupHtml() : section === 'service' ? serviceHtml() : overviewHtml();
    const [title, sub] = SECTIONS[section];
    host.innerHTML = `<div class="se-layout">${navHtml()}
        <div class="se-main"><header class="se-head"><h2>${escapeHtml(title)}</h2><p>${escapeHtml(sub)}</p></header>${body}</div></div>`;

    // На телефоні розділи — стрічкою: активний має бути видно.
    const nav = host.querySelector('.se-nav'), cur = nav?.querySelector('.is-active');
    if (nav && cur && nav.scrollWidth > nav.clientWidth) nav.scrollLeft = cur.offsetLeft - (nav.clientWidth - cur.offsetWidth) / 2;

    if (section === 'policy') {
        const el = document.getElementById('accountingSettings');
        await loadAccountingSettings(el, Object.entries(data.bank?.accounts || {})).catch(err => { if (el.isConnected) el.textContent = err.message; });
    } else if (section === 'startup') {
        const mig = document.getElementById('migrationSettings');
        if (mig) mountMigration(mig);
        const openEl = document.getElementById('stOpeningHost');
        await loadOpening(openEl).catch(err => { if (openEl.isConnected) openEl.textContent = err.message; });
    } else if (section === 'service') {
        const el = document.getElementById('resetSettings');
        if (el) await mountDatabaseReset(el).catch(err => { if (el.isConnected) el.textContent = err.message; });
    }

    if (anchor) {
        const target = document.getElementById(anchor);
        anchor = null;
        if (target) {
            target.scrollIntoView({ behavior: 'smooth', block: 'start' });
            target.classList.add('is-flash');
            setTimeout(() => target.classList.remove('is-flash'), 1600);
        }
    } else if (hadContent && scrollY > 0) window.scrollTo({ top: scrollY });
}

function goSection(next, target = null) {
    section = sectionKey(next);
    anchor = target;
    if (!target) window.scrollTo({ top: 0 });
    return loadSettingsView();
}

// ------------------------------------------------------------
// ДІЇ
// ------------------------------------------------------------
const val = id => document.getElementById(id)?.value?.trim() || '';

async function onAction(btn, host) {
    const a = btn.dataset.act;
    if (a === 'save-pay-requisites') {
        const payeeName = val('stReqPayee');
        const edrpou = val('stReqEdrpou');
        const iban = val('stReqIban').replace(/\s+/g, '').toUpperCase();
        if (!payeeName) { toast('Вкажіть назву ОСББ', 'error'); return; }
        if (edrpou && !/^\d{8}$/.test(edrpou)) { toast('Код ЄДРПОУ має містити 8 цифр', 'error'); return; }
        if (iban && !/^UA\d{27}$/.test(iban)) { toast('IBAN має починатися з UA і містити 29 символів', 'error'); return; }
        setBusy(btn, true, 'Зберігаю…');
        await setDoc(doc(db, 'osbb_settings', 'finance'), { payeeName, edrpou, iban, houseAddress: val('stReqAddress'), purposeTemplate: val('stReqPurpose') }, { merge: true });
        invalidate(); // квитанції й платежі беруть реквізити з кешу — інакше друкувалися б старі
        toast('Платіжні реквізити збережено', 'success');
        await loadSettingsView();
    } else if (a === 'save-xml-settings') {
        const box = document.getElementById('stXmlSettingsForm');
        const form = Object.fromEntries([...box.querySelectorAll('[name]')].map(i => [i.name, i.value.trim()]));
        setBusy(btn, true, 'Зберігаю…');
        await reportsAct({ action: 'saveXmlSettings', ...form, sti: Number(form.sti) });
        await setDoc(doc(db, 'osbb_settings', 'finance'), {
            ...(form.phone ? { phone: form.phone } : {}),
            ...(form.email ? { email: form.email } : {}),
            ...(form.headName ? { headName: form.headName } : {})
        }, { merge: true }).catch(() => {});
        invalidate();
        toast('Реквізити для звітності збережено', 'success');
        await loadSettingsView();
    } else if (a === 'registry-save') {
        await saveRegistry(btn, requisites.registry);
    } else if (a === 'token-save') {
        const token = val('tokenInput');
        if (!token) { toast('Вставте токен', 'error'); return; }
        setBusy(btn, true, 'Перевіряю в банку…');
        const r = await act({ action: 'saveToken', token }, 60000);
        toast(`Підключено. Рахунків: ${r?.accounts ?? 0}`, 'success');
        await loadSettingsView();
    } else if (a === 'token-remove') {
        if (!await confirmDialog('Відключити банк?', 'Токен буде видалено з сервера. Завантажені операції лишаться.', 'Відключити')) return;
        await act({ action: 'removeToken' });
        toast('Банк відключено', 'success');
        await loadSettingsView();
    } else if (a === 'ai-key-save') {
        const input = document.getElementById('aiKeyInput');
        const key = input?.value.trim() || '';
        if (!key) { toast('Вставте ключ Google AI Studio', 'error'); input?.focus(); return; }
        setBusy(btn, true, 'Перевіряю в Google…');
        const r = await expAct({ action: 'aiKey', key });
        updateAiKeyUi(r.aiKey);
        toast(`Ключ збережено (…${r.aiKey.tail}) — скани й фото розпізнаються`, 'success');
    } else if (a === 'ai-key-clear') {
        if (!await confirmDialog('Видалити ключ AI?', 'Скани й фото перестануть розпізнаватися; файли M.E.Doc і Вчасно читатимуться далі.', 'Видалити')) return;
        setBusy(btn, true, 'Видаляю…');
        const r = await expAct({ action: 'aiKey', key: '' });
        updateAiKeyUi(r.aiKey);
        toast('Ключ AI видалено', 'info');
    } else if (a === 'youscore-key-save') {
        const input = document.getElementById('stYouscoreKeyInput');
        const apiKey = input?.value.trim() || '';
        if (!apiKey) { toast('Вставте API-ключ YouScore', 'error'); input?.focus(); return; }
        setBusy(btn, true, 'Зберігаю…');
        const sandbox = apiKey === 'YOUSCORE_TEST_KEY_USPIH25_SANDBOX';
        await expAct({ action: 'youscoreKey', apiKey, sandbox });
        toast(sandbox ? 'YouScore: тестовий режим' : 'Ключ YouScore збережено', 'success');
        await loadSettingsView();
    } else if (a === 'youscore-key-sandbox') {
        setBusy(btn, true, 'Перемикаю…');
        await expAct({ action: 'youscoreKey', apiKey: '', sandbox: true });
        toast('YouScore: тестовий режим', 'info');
        await loadSettingsView();
    } else if (a === 'youscore-key-balance') {
        setBusy(btn, true, 'Запитую…');
        const r = await expAct({ action: 'youscoreBalance' });
        const msg = r.sandbox
            ? `Тестовий режим: залишок ${r.remainingTransactions ?? 5000} запитів, нічого не списується.`
            : `Залишок запитів YouScore: ${r.remainingTransactions ?? '—'}${r.usedTransactions != null ? ` · використано: ${r.usedTransactions}` : ''}.`;
        const note = document.getElementById('stYouscoreStatusNote');
        if (note) note.textContent = msg;
        toast(msg, 'success');
    } else if (a === 'st-payroll-bank') {
        openPayrollBank();
    } else if (a === 'st-open') {
        const { to, tab } = btn.dataset;
        if (to === 'charges') openCharges(tab);
        else if (to === 'expenses') openExpenses(tab);
        else location.hash = to;
    } else if (a === 'st-fill-odesa-taxes') {
        for (const [k, def] of Object.entries(DEFAULT_TAXES)) {
            for (const f of ['name', 'code', 'iban']) {
                const input = host.querySelector(`[data-st-tax="${k}.${f}"]`);
                if (input) input.value = def[f];
            }
        }
        toast('Підставлено рахунки ГУК і ДПС в Одеській обл. — натисніть «Зберегти»', 'info');
    } else if (a === 'st-save-taxes') {
        const taxes = {};
        host.querySelectorAll('[data-st-tax]').forEach(i => {
            const [k, f] = i.dataset.stTax.split('.');
            (taxes[k] ||= {})[f] = i.value.trim();
        });
        setBusy(btn, true, 'Зберігаю…');
        await payrollAct({ action: 'settings', advancePct: Number(val('stAdvPct')), taxes });
        toast('Бюджетні рахунки й аванс збережено', 'success');
        await loadSettingsView();
    } else if (a === 'st-rate-add') {
        const tbody = host.querySelector('#stRatesTable tbody');
        const next = nextRateRow(readRates(host));
        tbody.insertAdjacentHTML('beforeend', rateRow(next, true));
        tbody.lastElementChild.querySelector('input')?.focus();
    } else if (a === 'st-rates-save') {
        const rates = readRates(host);
        if (rates.some(r => !r.from || !r.to)) { toast('Вкажіть місяці «з» і «до» для кожного рядка', 'error'); return; }
        if (val('stRatesBasis').length < 5) { toast('Вкажіть підставу: закон про Держбюджет, дата', 'error'); document.getElementById('stRatesBasis')?.focus(); return; }
        setBusy(btn, true, 'Зберігаю…');
        await payrollAct({ action: 'rates', rates, basis: val('stRatesBasis') });
        toast('Ставки збережено', 'success');
        await loadSettingsView();
    } else if (a === 'small-save') {
        const kop = toKop(val('smallInput'));
        if (kop === null || kop < 0) { toast('Вкажіть суму в гривнях', 'error'); return; }
        setBusy(btn, true, 'Зберігаю…');
        await expAct({ action: 'settings', smallKop: kop });
        toast('Поріг збережено', 'success');
    } else if (a === 'st-imported-month') {
        const note = await promptDialog('Підтвердити вже нарахований місяць?', 'Потрібна повна історія по всіх приміщеннях. Суми вже включені у вхідні залишки; повторного нарахування не буде.', { confirmLabel: 'Підтвердити', placeholder: 'Попередня система та підстава звірки' });
        if (!note) return;
        setBusy(btn, true);
        await chargeAct({ action: 'confirmImportedStartMonth', note });
        toast('Перенос місяця підтверджено', 'success');
        await loadSettingsView();
    } else if (a === 'st-recompute') {
        setBusy(btn, true, 'Рахую…');
        const r = await chargeAct({ action: 'recompute' });
        toast(r.updated ? `Оновлено балансів: ${r.updated}` : 'Баланси вже збігаються з історією', 'success');
        await loadSettingsView();
    } else if (a === 'st-opening-fill') {
        const lines = (data.charges?.apartments || []).filter(x => x.balance !== null && x.balance !== '' && x.balance !== undefined)
            .map(x => `${x.apt};${String(Number(x.balance).toFixed(2)).replace('.', ',')}`);
        openingSign = 'overpaid';
        host.querySelectorAll('[data-st-sign]').forEach(b => b.classList.toggle('is-active', b.dataset.stSign === 'overpaid'));
        const text = document.getElementById('stOpText');
        if (text) text.value = lines.join('\n');
        openingPreview();
        toast(lines.length ? `Взято балансів: ${lines.length}. Звірте з попереднім обліком.` : 'У картках квартир балансів немає', lines.length ? 'success' : 'error');
    } else if (a === 'st-opening-save') {
        const { rows: parsed, errors } = parseOpeningLines(val('stOpText'), openingSign);
        if (!parsed.length) { toast('Немає жодного рядка', 'error'); return; }
        if (errors.length) { toast(`Спершу виправте рядок №${errors[0].line}`, 'error'); return; }
        const s = openingSummary(parsed);
        if (!await confirmDialog('Зберегти вхідні залишки?', `${s.count} кв.: борг ${fmtKop(s.debtKop)} грн, переплата ${fmtKop(s.overpaidKop)} грн. Після цього баланс мешканців рахує система, ручне редагування балансу вимкнеться.`, 'Зберегти')) return;
        setBusy(btn, true, 'Зберігаю…');
        const r = await chargeAct({ action: 'setOpening', rows: parsed });
        toast(`Залишки внесено. Оновлено балансів: ${r.balances}`, 'success');
        await loadSettingsView();
    } else if (a === 'st-annual-comparative') {
        setBusy(btn, true, 'Зберігаю…');
        await reportsAct({ action: 'annualComparative', year: annualYear, incomeKop: toKop(val('stPriorIncome')), costKop: toKop(val('stPriorCost')), basis: val('stPriorBasis') });
        toast('Порівняльні дані погоджено', 'success');
        await loadSettingsView();
    } else if (a === 'st-annual-import') {
        const file = document.getElementById('stAnnualImportFile')?.files?.[0];
        if (!file) { toast('Оберіть файл JSON', 'error'); return; }
        if (file.size > 6 * 1024 * 1024) { toast('Файл завеликий: до 6 МБ', 'error'); return; }
        setBusy(btn, true, 'Перевіряю…');
        const imported = JSON.parse(await file.text());
        await reportsAct({ ...imported, action: 'importAnnualHistory', year: annualYear, basis: val('stAnnualImportBasis') });
        toast('Історію перевірено й збережено для погодження', 'success');
        await loadSettingsView();
    } else if (a === 'st-annual-approve') {
        setBusy(btn, true, 'Погоджую…');
        await reportsAct({ action: 'approveAnnualHistory', year: annualYear });
        toast('Перенос історії погоджено', 'success');
        await loadSettingsView();
    }
}

function readRates(host) {
    return [...host.querySelectorAll('#stRatesTable tbody tr')].map(tr => parseRateRow({
        from: tr.querySelector('.st-rate-from').value,
        to: tr.querySelector('.st-rate-to').value,
        pdfo: tr.querySelector('.st-rate-pdfo').value,
        vz: tr.querySelector('.st-rate-vz').value,
        esv: tr.querySelector('.st-rate-esv').value,
        minWage: tr.querySelector('.st-rate-min').value,
        maxBaseMult: tr.querySelector('.st-rate-max').value,
        subsistence: tr.querySelector('.st-rate-sub').value
    }));
}

export function initSettingsView() {
    const host = document.getElementById('viewSettings');

    host.addEventListener('input', e => {
        if (e.target.id === 'stOpText') openingPreview();
        if (e.target.id === 'stReqPurpose') {
            const out = document.getElementById('stPurposePreview');
            if (out) out.textContent = purposePreview(e.target.value);
        }
        if (e.target.closest('#stOpeningHost') && e.target.classList.contains('ob-sum')) openingInput(document.getElementById('stOpeningHost'));
    });

    host.addEventListener('click', async e => {
        const tab = e.target.closest('[data-st-tab]');
        if (tab) { await goSection(tab.dataset.stTab); return; }
        const go = e.target.closest('[data-st-go]');
        if (go) { await goSection(go.dataset.stGo, go.dataset.anchor || null); return; }
        const sign = e.target.closest('[data-st-sign]');
        if (sign) {
            openingSign = sign.dataset.stSign;
            host.querySelectorAll('[data-st-sign]').forEach(b => b.classList.toggle('is-active', b === sign));
            openingPreview();
            return;
        }
        const ob = e.target.closest('[data-ob]');
        if (ob && !ob.disabled) {
            const el = document.getElementById('stOpeningHost');
            if (el) await openingAction(ob, el);
            return;
        }
        const btn = e.target.closest('button[data-act]');
        if (!btn || btn.disabled) return;
        try {
            await onAction(btn, host);
        } catch (err) {
            toast(err.message, 'error');
        } finally {
            if (btn.isConnected) setBusy(btn, false);
        }
    });

    host.addEventListener('change', async e => {
        const t = e.target;
        if (t.id === 'stReqIbanPick' && t.value) {
            const input = document.getElementById('stReqIban');
            if (input) input.value = t.value;
            return;
        }
        if (t.dataset?.act === 'st-visibility') {
            const show = t.checked;
            if (!await confirmDialog(
                show ? 'Показувати номери квартир?' : 'Приховати номери квартир?',
                show ? 'Мешканці побачать номери квартир у надходженнях і список боржників із сумами (без прізвищ). Звіт оновиться одразу.' : 'У звіті замість квартир буде «Співвласник», список боржників зникне.',
                show ? 'Показувати' : 'Приховати'
            )) { t.checked = !show; return; }
            try {
                await budgetAct({ action: 'visibility', showApartments: show });
                toast(show ? 'Номери квартир мешканцям показано' : 'Номери квартир приховано', 'success');
                await loadSettingsView();
            } catch (err) { t.checked = !show; toast(err.message, 'error'); }
            return;
        }
        if (t.dataset?.act === 'st-martial-law') {
            const on = t.checked;
            try {
                await setDoc(doc(db, 'osbb_settings', 'finance'), { martialLaw: on }, { merge: true });
                requisites.martialLaw = on;
                invalidate();
                toast(on ? 'Воєнний стан: пеня населенню не нараховується' : 'Мирний час: пеня та ст. 625 ЦК рахуються', 'success');
                await loadSettingsView();
            } catch (err) { t.checked = !on; toast(err.message, 'error'); }
            return;
        }
        if (t.id === 'stAnnualYear') {
            annualYear = t.value;
            await loadSettingsView();
            return;
        }
        const select = t.closest('.acc-purpose-select');
        if (!select) return;
        try {
            await act({ action: 'setAccount', iban: select.closest('[data-iban]').dataset.iban, purpose: select.value });
            toast('Призначення рахунку збережено', 'success');
        } catch (err) { toast(err.message, 'error'); }
    });
}
