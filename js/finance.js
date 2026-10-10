// ============================================================
// Фінанси: баланс квартири, квитанції та звіт про витрати ОСББ.
//
// Баланс лежить у самій квартирі (apartments/{apt}.balance):
// ВІД'ЄМНЕ число — борг, додатне — переплата (як на рахунку в
// банку). Квитанції —
// підколекція квартири, тож мешканець бачить лише свої.
// Звіт про витрати спільний для всіх і лежить у finance/current.
// ============================================================
import { db, session } from './firebase.js';
import {
    collection, doc, getDoc, getDocs, query, orderBy
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { escapeHtml, formatDateTime, toast, parseMoney, formatMoney } from './ui.js';
import { renderAttachments } from './attachments.js';
import { fetchDirectory } from './directory.js';
import { paymentLinks } from './nbu-qr.js';

/** Номери реальних квартир — щоб не створити фіктивну через друкарську помилку. */
let knownApts = null;
export async function loadKnownApts() {
    if (knownApts) return knownApts;
    try {
        knownApts = new Set((await fetchDirectory()).map(a => String(a.apt)));
    } catch (e) {
        console.warn('Список квартир для звірки:', e);
        knownApts = new Set();
    }
    return knownApts;
}

const SLICE_COLORS = ['#007AFF', '#34C759', '#FF9500', '#AF52DE', '#FF3B30',
                      '#5AC8FA', '#FFC300', '#14A79D'];

// ------------------------------------------------------------
// БАЛАНС КВАРТИРИ (мешканець)
// ------------------------------------------------------------
/** Баланс за статтями — як у квитанції сервісу: до сплати чи переплата за кожною. */
function partsHtml(parts) {
    const list = (Array.isArray(parts) ? parts : []).filter(p => p && Math.round(p.amountKop));
    if (list.length < 2) return '';
    return `<ul class="balance-parts">${list.map(p => `<li><span>${escapeHtml(p.name)}</span>
        <b class="${p.amountKop < 0 ? 'is-debt' : 'is-credit'}">${p.amountKop < 0 ? 'до сплати' : 'переплата'} ${formatMoney(Math.abs(p.amountKop) / 100)}</b></li>`).join('')}</ul>`;
}

export function renderBalance(balance, updatedAt, parts) {
    const n = parseMoney(balance);
    const debt = n < -0.005;
    const credit = n > 0.005;
    const state = debt ? 'debt' : credit ? 'credit' : 'zero';
    const label = debt ? 'До сплати' : credit ? 'Переплата' : 'Заборгованості немає';

    return `<div class="balance-card balance-${state}">
        <div class="balance-head">
            <div class="balance-main">
                <span class="balance-label">${label}</span>
                <span class="balance-sum">${state === 'zero' ? '0,00' : formatMoney(n)}<small>грн</small></span>
                ${updatedAt ? `<span class="balance-date">Оновлено ${escapeHtml(formatDateTime(updatedAt))}</span>` : ''}
                ${partsHtml(parts)}
            </div>
            <button type="button" class="balance-history" id="openLedgerBtn"
                    aria-label="Історія нарахувань і оплат" title="Історія нарахувань і оплат">
                <svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3v5h5"></path><path d="M3.05 13A9 9 0 1 0 6 5.3L3 8"></path><polyline points="12 7 12 12 15 14"></polyline></svg>
            </button>
        </div>
        <div class="balance-actions">
            <button type="button" class="btn-primary balance-pay" id="payBtn">
                <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="5" width="20" height="14" rx="2"></rect><line x1="2" y1="10" x2="22" y2="10"></line></svg>
                ${debt ? 'Сплатити' : 'Реквізити'}
            </button>
            <button type="button" class="balance-receipts" id="openReceiptsBtn"
                    aria-label="Квитанції" title="Квитанції">
                <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="8" y1="13" x2="15" y2="13"></line><line x1="8" y1="17" x2="13" y2="17"></line></svg>
                <span class="balance-receipts-text">Квитанції</span>
            </button>
        </div>
    </div>`;
}

function renderPersonalAccount() {
    const btn = document.getElementById('heroAccountBtn');
    const val = document.getElementById('displayAccount');
    if (!btn || !val) return;
    const acc = session.personalAccount;
    btn.hidden = !acc;
    if (acc) val.textContent = acc;
}

/** apartment — уже прочитаний документ квартири, щоб не читати його вдруге. */
export async function loadBalance(apt, apartment) {
    const host = document.getElementById('balanceHost');
    if (!host) return;
    try {
        let d = apartment;
        if (!d) {
            const snap = await getDoc(doc(db, 'apartments', apt));
            d = snap.exists() ? snap.data() : {};
        }
        session.balance = parseMoney(d.balance);
        session.personalAccount = d.personalAccount || '';
        // Рахунок показуємо в картці квартири: його доводиться диктувати
        // в банку, і шукати його в реквізитах щоразу — зайвий шлях.
        renderPersonalAccount();
        host.innerHTML = renderBalance(d.balance, d.balanceUpdatedAt, d.balanceParts);

        document.getElementById('payBtn')?.addEventListener('click', openPaymentSheet);
    } catch (e) {
        console.error('Баланс:', e);
        host.innerHTML = '';
    }
}

// ------------------------------------------------------------
// КВИТАНЦІЇ (мешканець)
// ------------------------------------------------------------
export async function loadReceipts() {
    const host = document.getElementById('receiptsContainer');
    if (!host) return;
    host.innerHTML = '<p class="list-empty">Завантаження…</p>';
    try {
        const snap = await getDocs(query(
            collection(db, 'apartments', String(session.apt), 'receipts'),
            orderBy('uploadedAt', 'desc')
        ));
        if (snap.empty) {
            host.innerHTML = '<p class="list-empty">Квитанцій ще немає</p>';
            return;
        }
        const groups = {};
        snap.forEach(d => {
            const r = d.data();
            (groups[r.period || 'Без періоду'] ||= []).push(r);
        });
        host.innerHTML = Object.entries(groups).map(([period, list]) => `
            <div class="doc-group">
                <h3 class="doc-group-title">${escapeHtml(period)}</h3>
                <div class="attach-block receipt-block" data-period="${escapeHtml(period)}"></div>
            </div>`).join('');
        Object.entries(groups).forEach(([period, list]) => {
            renderAttachments(
                host.querySelector(`.receipt-block[data-period="${CSS.escape(period)}"]`),
                list.map(r => ({ name: r.name, url: r.url, type: r.type || '', size: r.size || 0 }))
            );
        });
    } catch (e) {
        console.error('Квитанції:', e);
        host.innerHTML = '<p class="list-empty">Не вдалося завантажити квитанції</p>';
    }
}

// ------------------------------------------------------------
// ЗВІТ ПРО ВИТРАТИ — кругова діаграма
// ------------------------------------------------------------
/**
 * Кільцева діаграма одним колом: кожен сегмент — та сама
 * окружність із власним dasharray і зсувом. Так не доводиться
 * рахувати дуги вручну і не буває щілин між секторами.
 */
export function renderDonut(items) {
    const clean = (items || [])
        .map(i => ({ label: String(i.label || '').trim(), amount: parseMoney(i.amount) }))
        .filter(i => i.label && i.amount > 0);

    const total = clean.reduce((s, i) => s + i.amount, 0);
    if (!total) return '';

    const R = 42, C = 2 * Math.PI * R;
    let acc = 0;
    const arcs = clean.map((it, idx) => {
        const frac = it.amount / total;
        const seg = `<circle class="donut-seg" cx="50" cy="50" r="${R}"
            stroke="${SLICE_COLORS[idx % SLICE_COLORS.length]}"
            stroke-dasharray="${(C * frac).toFixed(2)} ${(C * (1 - frac)).toFixed(2)}"
            stroke-dashoffset="${(-C * acc).toFixed(2)}"
            transform="rotate(-90 50 50)"></circle>`;
        acc += frac;
        return seg;
    }).join('');

    const legend = clean.map((it, idx) => `
        <div class="donut-row">
            <span class="donut-dot" style="background: ${SLICE_COLORS[idx % SLICE_COLORS.length]};"></span>
            <span class="donut-name">${escapeHtml(it.label)}</span>
            <span class="donut-pct">${Math.round((it.amount / total) * 100)}%</span>
            <span class="donut-sum">${formatMoney(it.amount)}</span>
        </div>`).join('');

    return `<div class="donut-wrap">
        <div class="donut">
            <svg viewBox="0 0 100 100" aria-hidden="true">${arcs}</svg>
            <span class="donut-center">
                <b>${formatMoney(total)}</b>
                <small>грн</small>
            </span>
        </div>
        <div class="donut-legend">${legend}</div>
    </div>`;
}

/**
 * Бюджет ОСББ на головному екрані.
 *
 * Раніше тут одразу лежала діаграма витрат на півекрана — і це при
 * тому, що мешканця насамперед цікавить власна квартира. Тепер
 * згорнутий блок показує головне число (залишок на рахунку), а
 * розклад витрат відкривається дотиком.
 */
export function renderBudget(d) {
        const chart = renderDonut(d.items);
        const money = (v) => (v === undefined || v === null || v === '') ? null : parseMoney(v);
        const funds = money(d.funds);
        const income = money(d.income);
        const spent = (d.items || []).reduce((sum, i) => sum + parseMoney(i.amount), 0);

        // Нічого показувати — краще нічого й не малювати, ніж порожня картка
        if (funds === null && income === null && !chart) return '';

        // Дату вказує бухгалтер: виписку могли внести пізніше, ніж
        // вона сформована, і «станом на» має бути датою виписки.
        const asOf = d.fundsDate || (d.updatedAt ? formatDateTime(d.updatedAt) : '');

        // Заголовок називає те, що під ним. Коли залишку немає, називати
        // блок «залишком на рахунку» було б неправдою — тоді це просто
        // фінанси за період.
        const head = funds === null
            ? `<span class="bud-label">Фінанси ОСББ</span>
               <span class="bud-sum bud-sum-muted">${escapeHtml(d.period || 'Витрати за місяць')}</span>`
            : `<span class="bud-label">Залишок на рахунку ОСББ</span>
               <span class="bud-sum">${formatMoney(funds)}<small>грн</small></span>
               ${asOf ? `<span class="bud-when">станом на ${escapeHtml(asOf)}</span>` : ''}`;

        // Надходження й витрати поруч: одна цифра без другої нічого не
        // каже — 17 тисяч витрат це багато чи мало, видно лише поруч
        // із тим, скільки зібрали.
        const flows = (income === null && !spent) ? '' : `<div class="bud-flows">
            ${income === null ? '' : `<div class="bud-flow bud-flow-in">
                <span class="bud-flow-label">Надходження</span>
                <span class="bud-flow-sum">${formatMoney(income)}</span>
            </div>`}
            ${!spent ? '' : `<div class="bud-flow bud-flow-out">
                <span class="bud-flow-label">Витрати</span>
                <span class="bud-flow-sum">${formatMoney(spent)}</span>
            </div>`}
        </div>`;

        return `<div class="card admin-fold bud-card">
            <button class="admin-card-toggle bud-toggle" type="button" aria-expanded="false">
                <span class="bud-mark">
                    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="7" width="20" height="14" rx="2"></rect><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"></path></svg>
                </span>
                <span class="bud-head">${head}</span>
                <svg class="admin-card-chevron" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>
            </button>
            <div class="admin-card-body"><div class="admin-card-body-inner"><div class="bud-body">
                ${d.period ? `<span class="bud-period">${escapeHtml(d.period)}</span>` : ''}
                ${flows}
                ${chart}
                <button type="button" class="bud-more">
                    Докладніше про доходи й витрати
                    <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><polyline points="9 18 15 12 9 6"></polyline></svg>
                </button>
            </div></div></div>
        </div>`;
}

/**
 * @param {string} hostId куди малювати. Той самий блок бачать і мешканець
 *   у кабінеті, і правління на дашборді — це не два різні звіти.
 */
export async function loadExpenses(hostId = 'expensesHost') {
    const host = document.getElementById(hostId);
    if (!host) return;
    try {
        const snap = await getDoc(doc(db, 'finance', 'current'));
        host.innerHTML = snap.exists() ? renderBudget(snap.data()) : '';
        host.querySelector('.bud-more')?.addEventListener('click', async () => {
            const { showScreen } = await import('./ui.js');
            showScreen('financeSection');
            const nav = document.getElementById('topNav');
            if (nav) nav.style.display = 'none';
            loadFinanceDetail({ tab: 'money' });
        });
    } catch (e) {
        console.error('Звіт про витрати:', e);
        host.innerHTML = '';
    }
}

// ------------------------------------------------------------
// ФІНАНСИ ОСББ — окремий екран
// ------------------------------------------------------------
/** Окремий екран «Фінанси будинку» живе у власному модулі й вантажиться на вимогу. */
export async function loadFinanceDetail(options) {
    const { loadHouseFinance } = await import('./house-finance.js');
    return loadHouseFinance(options);
}

// ============================================================
// ПЛАТІЖНІ РЕКВІЗИТИ ТА ОПЛАТА
//
// Українські банки не приймають реквізити через посилання, тож
// «оплатити одним дотиком» технічно неможливо. Робимо наступне
// найкраще: показуємо поля в тому порядку, в якому їх питає
// конкретний банк, і даємо кожне скопіювати одним дотиком.
// ============================================================

let requisites = null;

/**
 * Єдиний перелік реквізитів у зручному для заповнення порядку.
 *
 * Раніше тут були пресети під конкретні банки з посиланнями
 * monobank:// і privat24://. Ці схеми ніде не задокументовані й на
 * iOS не відкриваються — Safari показував «адрес недействителен».
 * Обіцянка, якої застосунок не може дотримати, гірша за її
 * відсутність, тож лишився один надійний шлях: скопіювати й
 * вставити у своєму банку.
 */
const FIELDS = ['payeeName', 'edrpou', 'iban', 'purpose', 'personalAccount', 'amount'];

// Portmone — звичайне https-посилання, воно працює скрізь,
// на відміну від схем застосунків.
const PORTMONE_URL = 'https://www.portmone.com.ua/r3/perekaz-dovilni-rekvizyty';

const FIELD_LABELS = {
    iban: 'IBAN',
    edrpou: 'ЄДРПОУ / ІПН',
    payeeName: 'Одержувач',
    amount: 'Сума',
    purpose: 'Призначення платежу',
    ownerName: 'ПІБ',
    address: 'Адреса',
    personalAccount: 'Особовий рахунок',
    period: 'Період'
};

const MONTHS = ['Січень', 'Лютий', 'Березень', 'Квітень', 'Травень', 'Червень',
                'Липень', 'Серпень', 'Вересень', 'Жовтень', 'Листопад', 'Грудень'];

/** Платять за місяць, що завершився, тож беремо попередній. */
function previousPeriod() {
    const d = new Date();
    d.setDate(1);
    d.setMonth(d.getMonth() - 1);
    return `${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}


export async function loadRequisites() {
    if (requisites) return requisites;
    const snap = await getDoc(doc(db, 'osbb_settings', 'finance'));
    requisites = snap.exists() ? snap.data() : {};
    return requisites;
}

/**
 * Складає призначення платежу. Підтримує {apt} і {account}.
 * Якщо шаблон не згадує особовий рахунок, а він у квартири є —
 * дописуємо його: без нього платіж може не знайти адресата.
 */
function buildPurpose(tpl, apt, account) {
    const raw = tpl || 'Внески на утримання будинку, кв. {apt}';
    let text = raw
        .replace(/\{apt\}/g, String(apt ?? ''))
        .replace(/\{account\}/g, String(account ?? ''));

    if (account && !/\{account\}/.test(raw) && !text.includes(account)) {
        text += `, особовий рахунок ${account}`;
    }
    return text.replace(/,\s*$/, '').replace(/\s{2,}/g, ' ').trim();
}

function fieldValues(req, apt, balance) {
    const debt = parseMoney(balance) < 0 ? Math.abs(parseMoney(balance)) : 0;
    const house = req.houseAddress || 'вул. Інглезі, 3/3, м. Одеса';
    return {
        iban: (req.iban || '').replace(/\s+/g, ''),
        edrpou: req.edrpou || '',
        payeeName: req.payeeName || '',
        // Для копіювання — крапка: її розуміють усі банківські форми
        amount: debt ? debt.toFixed(2) : '',
        purpose: buildPurpose(req.purposeTemplate, apt, session.personalAccount),
        ownerName: session.ownerName || '',
        address: `${house}, кв. ${apt ?? ''}`,
        personalAccount: session.personalAccount || '',
        period: previousPeriod()
    };
}

const COPY_ICON = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>';

/** Клавіатура недоступна на iOS у не-secure контексті — тримаємо запасний шлях. */
async function copyText(text) {
    try {
        if (navigator.clipboard && window.isSecureContext) {
            await navigator.clipboard.writeText(text);
            return true;
        }
    } catch (e) { /* пробуємо старий спосіб */ }
    try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.setAttribute('readonly', '');
        ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;';
        document.body.appendChild(ta);
        ta.select();
        ta.setSelectionRange(0, ta.value.length);
        const ok = document.execCommand('copy');
        ta.remove();
        return ok;
    } catch (e) {
        return false;
    }
}

/**
 * Кнопки «Відкрити в Приват24 / monobank» і QR-код НБУ. Якщо реквізити
 * неповні (немає IBAN чи ЄДРПОУ) — лишається копіювання вручну.
 */
let qrLink = '';
function renderQuickPay(vals) {
    const box = document.getElementById('payQuick');
    if (!box) return;
    let links = null;
    try {
        links = paymentLinks({
            name: vals.payeeName, iban: vals.iban, code: vals.edrpou,
            amount: vals.amount ? parseFloat(vals.amount) : null,
            purpose: vals.purpose, reference: `KV${String(session.apt ?? '').replace(/[^\w-]/g, '')}`
        });
    } catch { /* неповні реквізити */ }
    box.hidden = !links;
    const hint = document.getElementById('payCopyHint');
    if (hint) hint.textContent = links
        ? 'Або скопіюйте реквізити й вставте їх у застосунку свого банку.'
        : 'Скопіюйте реквізити та вставте їх у застосунку свого банку — у розділі переказу за реквізитами.';
    if (!links) return;
    document.getElementById('payApps').innerHTML = links.apps.map(app =>
        `<a class="btn-primary pay-app" href="${escapeHtml(app.href)}" target="_blank" rel="noopener">Оплатити в ${escapeHtml(app.label)}</a>`).join('');
    qrLink = links.link;
    const wrap = document.getElementById('payQrWrap');
    document.getElementById('payQr').innerHTML = '';
    if (wrap.open) drawPayQr();
}

/** QR малюємо лише на вимогу: бібліотека не потрібна, поки мешканець не відкрив блок. */
async function drawPayQr() {
    const host = document.getElementById('payQr');
    if (!host || !qrLink || host.dataset.link === qrLink) return;
    const { default: qrcode } = await import('./vendor/qrcode.js');
    const qr = qrcode(0, 'Q');
    qr.addData(qrLink);
    qr.make();
    // Знак гривні в центрі обовʼязковий для форматів 002/003; рівень
    // корекції Q відновлює закриту ним середину.
    host.innerHTML = `${qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true })}<span class="pay-qr-mark" aria-hidden="true">₴</span>`;
    host.dataset.link = qrLink;
}

export function renderPaymentSheet() {
    const host = document.getElementById('paymentFieldsContainer');
    if (!host) return;

    const vals = fieldValues(requisites || {}, session.apt, session.balance);
    renderQuickPay(vals);
    const shown = FIELDS.filter(f => vals[f]);
    const copyAllBtn = document.getElementById('openBankBtn');

    if (!shown.length) {
        host.innerHTML = '<p class="list-empty">Правління ще не внесло платіжні реквізити</p>';
        copyAllBtn?.setAttribute('hidden', '');
        return;
    }
    copyAllBtn?.removeAttribute('hidden');

    // Чого бракує — кажемо прямо, щоб мешканець не гадав
    const missing = FIELDS.filter(f => !vals[f] && f !== 'amount');
    const note = missing.length
        ? `<p class="pay-missing">Не заповнено: ${missing.map(f => FIELD_LABELS[f]).join(', ')}. Зверніться до правління.</p>`
        : '';

    host.innerHTML = note + shown.map((f, i) => `
        <button type="button" class="pay-field" data-value="${escapeHtml(vals[f])}">
            <span class="pay-field-text">
                <span class="pay-field-label">${i + 1}. ${escapeHtml(FIELD_LABELS[f])}</span>
                <span class="pay-field-value">${escapeHtml(
                    f === 'amount' ? formatMoney(parseMoney(vals[f])) + ' грн' : vals[f]
                )}</span>
            </span>
            <span class="pay-copy" aria-label="Копіювати">${COPY_ICON}</span>
        </button>`).join('');

    host.querySelectorAll('.pay-field').forEach(btn => {
        btn.addEventListener('click', async () => {
            const ok = await copyText(btn.dataset.value);
            if (!ok) return toast('Не вдалося скопіювати', 'error');
            toast('Скопійовано', 'success');
            btn.classList.add('pay-field-done');
            setTimeout(() => btn.classList.remove('pay-field-done'), 1200);
        });
    });
}

/** Усі реквізити одним текстом — щоб вставити в нотатку чи месенджер. */
function allRequisitesText() {
    const vals = fieldValues(requisites || {}, session.apt, session.balance);
    return FIELDS
        .filter(f => vals[f])
        .map(f => `${FIELD_LABELS[f]}: ${f === 'amount' ? formatMoney(parseMoney(vals[f])) + ' грн' : vals[f]}`)
        .join('\n');
}

async function copyAll(btn) {
    const text = allRequisitesText();
    if (!text) return;
    const ok = await copyText(text);
    if (!ok) return toast('Не вдалося скопіювати', 'error');
    toast('Усі реквізити скопійовано', 'success');
}


export async function openPaymentSheet() {
    const { openSheet } = await import('./ui.js');
    try {
        await loadRequisites();
    } catch (e) {
        console.error('Реквізити:', e);
    }
    // Банк питає одну людину, тож беремо першого співвласника
    if (!session.ownerName) {
        try {
            const owners = await getDocs(collection(db, 'apartments', String(session.apt), 'owners'));
            session.ownerName = owners.empty ? '' : (owners.docs[0].data().name || '');
        } catch (e) {
            console.warn('ПІБ для платежу:', e);
        }
    }
    renderPaymentSheet();
    openSheet('paymentPopup');
}

export function initPayments() {
    document.getElementById('heroAccountBtn')?.addEventListener('click', async function () {
        const acc = session.personalAccount;
        if (!acc) return;
        const ok = await copyText(acc);
        toast(ok ? 'Особовий рахунок скопійовано' : 'Не вдалося скопіювати', ok ? 'success' : 'error');
    });

    document.getElementById('openBankBtn')?.addEventListener('click', function () { copyAll(this); });
    document.getElementById('payQrWrap')?.addEventListener('toggle', e => { if (e.currentTarget.open) drawPayQr(); });
    document.getElementById('portmoneLink')?.setAttribute('href', PORTMONE_URL);
}

