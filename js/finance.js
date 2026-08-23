// ============================================================
// Фінанси: баланс квартири, квитанції та звіт про витрати ОСББ.
//
// Баланс лежить у самій квартирі (apartments/{apt}.balance):
// ВІД'ЄМНЕ число — борг, додатне — переплата (як на рахунку в
// банку). Квитанції —
// підколекція квартири, тож мешканець бачить лише свої.
// Звіт про витрати спільний для всіх і лежить у finance/current.
// ============================================================
import { db, storage, session } from './firebase.js';
import {
    collection, doc, getDoc, getDocs, setDoc, updateDoc, addDoc,
    query, orderBy, serverTimestamp, writeBatch
} from "https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js";
import {
    ref as sRef, uploadBytes, getDownloadURL
} from "https://www.gstatic.com/firebasejs/10.8.1/firebase-storage.js";
import { escapeHtml, formatDateTime, toast, setBusy } from './ui.js';
import { renderAttachments } from './attachments.js';
import { fetchDirectory } from './directory.js';

/** Номери реальних квартир — щоб не створити фіктивну через друкарську помилку. */
let knownApts = null;
async function loadKnownApts() {
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

/** «1234.5» або «1 234,50» → 1234.5. Порожнє чи сміття → 0. */
export function parseMoney(v) {
    const n = parseFloat(String(v ?? '').replace(/\s/g, '').replace(',', '.'));
    return isNaN(n) ? 0 : n;
}

export function formatMoney(n) {
    return Math.abs(n).toLocaleString('uk-UA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// ------------------------------------------------------------
// БАЛАНС КВАРТИРИ (мешканець)
// ------------------------------------------------------------
export function renderBalance(balance, updatedAt) {
    const n = parseMoney(balance);
    const debt = n < -0.005;
    const credit = n > 0.005;
    const state = debt ? 'debt' : credit ? 'credit' : 'zero';
    const label = debt ? 'До сплати' : credit ? 'Переплата' : 'Заборгованості немає';

    return `<div class="balance-card balance-${state}">
        <div class="balance-main">
            <span class="balance-label">${label}</span>
            <span class="balance-sum">${state === 'zero' ? '0,00' : formatMoney(n)}<small>грн</small></span>
            ${updatedAt ? `<span class="balance-date">Оновлено ${escapeHtml(formatDateTime(updatedAt))}</span>` : ''}
        </div>
        <button type="button" class="btn-primary balance-pay" id="payBtn">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="5" width="20" height="14" rx="2"></rect><line x1="2" y1="10" x2="22" y2="10"></line></svg>
            ${debt ? 'Сплатити' : 'Реквізити для оплати'}
        </button>
        <button type="button" class="balance-receipts" id="openReceiptsBtn">
            <span class="balance-receipts-text">Квитанції</span>
            <svg class="row-chevron" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"></polyline></svg>
        </button>
    </div>`;
}

export async function loadBalance(apt) {
    const host = document.getElementById('balanceHost');
    if (!host) return;
    try {
        const snap = await getDoc(doc(db, 'apartments', apt));
        const d = snap.exists() ? snap.data() : {};
        session.balance = parseMoney(d.balance);
        session.personalAccount = d.personalAccount || '';
        host.innerHTML = renderBalance(d.balance, d.balanceUpdatedAt);

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

export async function loadExpenses() {
    const host = document.getElementById('expensesHost');
    if (!host) return;
    try {
        const snap = await getDoc(doc(db, 'finance', 'current'));
        if (!snap.exists()) { host.innerHTML = ''; return; }
        const d = snap.data();
        const chart = renderDonut(d.items);
        if (!chart) { host.innerHTML = ''; return; }
        const funds = (d.funds === undefined || d.funds === null || d.funds === '')
            ? null : parseMoney(d.funds);
        // Дату вказує бухгалтер: виписку могли внести пізніше, ніж
        // вона сформована, і «станом на» має бути датою виписки.
        const asOf = d.fundsDate
            ? d.fundsDate
            : (d.updatedAt ? formatDateTime(d.updatedAt) : '');

        host.innerHTML = `<div class="card">
            ${funds === null ? '' : `<div class="funds-row">
                <span class="funds-row-label">На рахунку ОСББ</span>
                <span class="funds-row-sum">${formatMoney(funds)}<small>грн</small></span>
                ${asOf ? `<span class="funds-row-date">станом на ${escapeHtml(asOf)}</span>` : ''}
            </div>`}
            <div class="section-head-text" style="margin-bottom: 16px;">
                <h2 class="admin-card-title">Витрати за місяць</h2>
                <span class="admin-card-sub">${escapeHtml(d.period || '')}</span>
            </div>
            ${chart}
        </div>`;
    } catch (e) {
        console.error('Звіт про витрати:', e);
        host.innerHTML = '';
    }
}

// ============================================================
// АДМІН
// ============================================================

// ------------------------------------------------------------
// МАСОВЕ ОНОВЛЕННЯ БАЛАНСІВ
// Бухгалтер вставляє рядки «квартира сума» — так швидше, ніж
// відкривати триста карток.
// ------------------------------------------------------------
/** Розбирає «298 1250,40» / «298;-300» / «298 - 300» на пари. */
export function parseBalanceLines(text) {
    const rows = [], errors = [];
    String(text || '').split(/\r?\n/).forEach((line, i) => {
        const raw = line.trim();
        if (!raw) return;
        // Такий самий розбір, як у parseDebtsCSV. Раніше тут стояв
        // жадібний (\S+) з роздільником у класі — і в рядку без пробілів
        // роздільником ставала ОСТАННЯ кома, тобто та, що відділяє
        // копійки: «298;-1250,40» давало квартиру «2981250» і суму 40.
        const m = raw.match(/^([^;,\t\s]+)\s*[;,\t]\s*(.+)$/)   // 298;-1250,40
               || raw.match(/^(\S+)\s+(.+)$/);                    // 298 -1250,40
        if (!m) { errors.push({ line: i + 1, raw }); return; }
        // Тільки цифри: «кв.9» → «9». Інакше в базі з'явився б
        // документ «кв9», якого не існує.
        const apt = m[1].replace(/\D/g, '');
        const amount = m[2].trim().replace(/^"|"$/g, '');
        if (!apt || !/^-?\s*[\d\s]*[.,]?\d+$/.test(amount)) {
            errors.push({ line: i + 1, raw });
            return;
        }
        rows.push({ apt, balance: parseMoney(amount) });
    });
    return { rows, errors };
}

export async function applyBalances(btn) {
    const text = document.getElementById('balanceBulk').value;
    const { rows, errors } = parseBalanceLines(text);

    if (!rows.length) return toast('Немає жодного коректного рядка', 'error');
    if (errors.length) {
        toast(`Пропущено рядків: ${errors.length} (рядок ${errors[0].line})`, 'error');
    }

    setBusy(btn, true, 'Збереження…');
    try {
        // Пишемо лише в наявні квартири: merge створив би документ
        // «кв. 9999» з однієї друкарської помилки, і він назавжди
        // залишився б у довіднику.
        const known = await loadKnownApts();
        const valid = known.size ? rows.filter(r => known.has(r.apt)) : rows;
        const unknown = rows.length - valid.length;
        if (!valid.length) {
            toast('Жодна з квартир не знайдена в базі', 'error');
            return;
        }

        // Пишемо пачками: у одному batch не більше 500 операцій
        for (let i = 0; i < valid.length; i += 400) {
            const batch = writeBatch(db);
            valid.slice(i, i + 400).forEach(r => {
                batch.set(doc(db, 'apartments', r.apt),
                    { balance: r.balance, balanceUpdatedAt: new Date() }, { merge: true });
            });
            await batch.commit();
        }
        toast(`Оновлено балансів: ${valid.length}${unknown ? `, невідомих квартир: ${unknown}` : ''}`,
              unknown ? 'info' : 'success');
        document.getElementById('balanceBulk').value = '';
        document.getElementById('balancePreview').innerHTML = '';
    } catch (e) {
        console.error('Оновлення балансів:', e);
        toast('Не вдалося зберегти баланси', 'error');
    } finally {
        setBusy(btn, false);
    }
}

function previewBalances() {
    const host = document.getElementById('balancePreview');
    if (!host) return;
    const { rows, errors } = parseBalanceLines(document.getElementById('balanceBulk').value);
    if (!rows.length && !errors.length) { host.innerHTML = ''; return; }
    host.innerHTML = `<div class="bulk-preview">
        <span class="bulk-ok">Розпізнано: ${rows.length}</span>
        ${errors.length ? `<span class="bulk-bad">Не розпізнано: ${errors.length}</span>` : ''}
        ${rows.slice(0, 4).map(r =>
            `<span class="bulk-row">кв. ${escapeHtml(r.apt)} → ${r.balance < 0 ? 'борг ' : r.balance > 0 ? 'переплата ' : ''}${formatMoney(r.balance)} грн</span>`
        ).join('')}
        ${rows.length > 4 ? `<span class="bulk-row bulk-more">…і ще ${rows.length - 4}</span>` : ''}
    </div>`;
}

// ------------------------------------------------------------
// КВИТАНЦІЇ: масове завантаження
// Квартиру визначаємо з назви файлу — перше число в ній.
// Бухгалтер бачить розпізнане ДО завантаження і може виправити.
// ------------------------------------------------------------
let pendingReceipts = [];

export function aptFromFileName(name) {
    const base = String(name || '').replace(/\.[^.]+$/, '');
    const m = base.match(/\d+/);
    return m ? m[0] : '';
}

async function renderReceiptRows() {
    const host = document.getElementById('receiptRows');
    if (!host) return;
    if (!pendingReceipts.length) { host.innerHTML = ''; return; }

    // Назва файлу — ненадійне джерело: «2026-08-298.pdf» дає «2026».
    // Тому звіряємо зі списком квартир і підсвічуємо сумнівне.
    const known = await loadKnownApts();
    const bad = r => !r.apt || (known.size && !known.has(r.apt));

    host.innerHTML = pendingReceipts.map((r, i) => `
        <div class="receipt-row${bad(r) ? ' receipt-row-warn' : ''}">
            <span class="receipt-file">${escapeHtml(r.file.name)}</span>
            <input type="text" class="field-input receipt-apt" data-idx="${i}"
                   value="${escapeHtml(r.apt)}" placeholder="кв.">
            <button type="button" class="poll-option-del receipt-del" data-idx="${i}" aria-label="Прибрати">
                <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
            </button>
        </div>`).join('');

    host.querySelectorAll('.receipt-apt').forEach(inp => {
        inp.addEventListener('input', () => {
            pendingReceipts[+inp.dataset.idx].apt = inp.value.trim();
            const v = inp.value.trim();
            inp.closest('.receipt-row').classList
               .toggle('receipt-row-warn', !v || (known.size && !known.has(v)));
        });
    });
    host.querySelectorAll('.receipt-del').forEach(b => {
        b.addEventListener('click', () => {
            pendingReceipts.splice(+b.dataset.idx, 1);
            renderReceiptRows();
        });
    });
}

export async function uploadReceipts(btn) {
    const period = document.getElementById('receiptPeriod').value.trim();
    if (!period) return toast('Вкажіть період, напр. «Серпень 2026»', 'error');

    const known = await loadKnownApts();
    const ready = pendingReceipts.filter(r => r.apt && (!known.size || known.has(r.apt)));
    if (!ready.length) {
        return toast('Немає файлів із коректним номером квартири', 'error');
    }

    const skipped = pendingReceipts.length - ready.length;
    setBusy(btn, true, `Завантаження 0/${ready.length}`);
    let done = 0;
    const failed = [];

    for (const r of ready) {
        try {
            const fileRef = sRef(storage, `receipts/${r.apt}/${Date.now()}_${r.file.name}`);
            await uploadBytes(fileRef, r.file);
            await addDoc(collection(db, 'apartments', r.apt, 'receipts'), {
                name: r.file.name,
                url: await getDownloadURL(fileRef),
                type: r.file.type || 'application/pdf',
                size: r.file.size || 0,
                period,
                uploadedAt: serverTimestamp()
            });
            done++;
            setBusy(btn, true, `Завантаження ${done}/${ready.length}`);
        } catch (e) {
            console.error(`Квитанція «${r.file.name}»:`, e);
            failed.push(r.file.name);
        }
    }

    setBusy(btn, false);
    if (failed.length) {
        toast(`Не завантажено: ${failed.length}. Решта — успішно.`, 'error');
    } else {
        toast(`Розіслано квитанцій: ${done}${skipped ? `, пропущено ${skipped}` : ''}`, 'success');
    }
    pendingReceipts = pendingReceipts.filter(r => failed.includes(r.file.name));
    renderReceiptRows();
    document.getElementById('receiptFiles').value = '';
}

// ------------------------------------------------------------
// ЗВІТ ПРО ВИТРАТИ (адмін)
// ------------------------------------------------------------
function expenseRows() {
    return Array.from(document.querySelectorAll('#expenseRows .expense-row'));
}

function addExpenseRow(label = '', amount = '') {
    const host = document.getElementById('expenseRows');
    const row = document.createElement('div');
    row.className = 'expense-row';
    row.innerHTML = `
        <input type="text" class="field-input expense-label" placeholder="Стаття витрат" value="${escapeHtml(label)}">
        <input type="text" class="field-input expense-amount" inputmode="decimal" placeholder="грн" value="${escapeHtml(String(amount))}">
        <button type="button" class="poll-option-del expense-del" aria-label="Прибрати">
            <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
        </button>`;
    row.querySelector('.expense-del').addEventListener('click', () => { row.remove(); previewExpenses(); });
    row.querySelectorAll('input').forEach(i => i.addEventListener('input', previewExpenses));
    host.appendChild(row);
    return row;
}

function currentExpenseItems() {
    return expenseRows().map(r => ({
        label: r.querySelector('.expense-label').value.trim(),
        amount: parseMoney(r.querySelector('.expense-amount').value)
    })).filter(i => i.label && i.amount > 0);
}

function previewExpenses() {
    const host = document.getElementById('expensePreview');
    if (host) host.innerHTML = renderDonut(currentExpenseItems());
}

export async function saveExpenses(btn) {
    const period = document.getElementById('expensePeriod').value.trim();
    const fundsRaw = document.getElementById('expenseFunds').value.trim();
    const fundsDate = document.getElementById('expenseFundsDate').value.trim();
    const items = currentExpenseItems();
    if (!period) return toast('Вкажіть період', 'error');
    if (!items.length) return toast('Додайте хоча б одну статтю витрат', 'error');

    setBusy(btn, true, 'Збереження…');
    try {
        await setDoc(doc(db, 'finance', 'current'), {
            period, items,
            // Порожнє поле — не нуль: у нуля й «не вказано» різний сенс
            funds: fundsRaw === '' ? null : parseMoney(fundsRaw),
            fundsDate,
            total: items.reduce((s, i) => s + i.amount, 0),
            updatedAt: serverTimestamp()
        });
        toast('Звіт опубліковано', 'success');
    } catch (e) {
        console.error('Звіт про витрати:', e);
        toast('Не вдалося зберегти звіт', 'error');
    } finally {
        setBusy(btn, false);
    }
}

export async function loadAdminExpenses() {
    const host = document.getElementById('expenseRows');
    if (!host) return;
    try {
        const snap = await getDoc(doc(db, 'finance', 'current'));
        host.innerHTML = '';
        if (snap.exists()) {
            const d = snap.data();
            document.getElementById('expensePeriod').value = d.period || '';
            document.getElementById('expenseFunds').value =
                (d.funds === undefined || d.funds === null) ? '' : d.funds;
            document.getElementById('expenseFundsDate').value = d.fundsDate || '';
            (d.items || []).forEach(i => addExpenseRow(i.label, i.amount));
        }
        if (!host.children.length) {
            ['Електроенергія', 'Прибирання', 'Обслуговування ліфта'].forEach(l => addExpenseRow(l, ''));
        }
        previewExpenses();
    } catch (e) {
        console.error('Завантаження звіту:', e);
    }
}

// ------------------------------------------------------------
// ІНІЦІАЛІЗАЦІЯ
// ------------------------------------------------------------
export function initFinance() {
    document.getElementById('balanceBulk')?.addEventListener('input', previewBalances);
    document.getElementById('applyBalancesBtn')?.addEventListener('click', function () { applyBalances(this); });

    const files = document.getElementById('receiptFiles');
    files?.addEventListener('change', () => {
        Array.from(files.files).forEach(f => {
            pendingReceipts.push({ file: f, apt: aptFromFileName(f.name) });
        });
        renderReceiptRows();
    });
    document.getElementById('uploadReceiptsBtn')?.addEventListener('click', function () { uploadReceipts(this); });

    document.getElementById('addExpenseBtn')?.addEventListener('click', () => addExpenseRow());
    document.getElementById('saveExpensesBtn')?.addEventListener('click', function () { saveExpenses(this); });
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

export function renderPaymentSheet() {
    const host = document.getElementById('paymentFieldsContainer');
    if (!host) return;

    const vals = fieldValues(requisites || {}, session.apt, session.balance);
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

// ------------------------------------------------------------
// РЕКВІЗИТИ (адмін)
// ------------------------------------------------------------
export async function loadAdminRequisites() {
    if (!document.getElementById('reqIban')) return;
    try {
        const snap = await getDoc(doc(db, 'osbb_settings', 'finance'));
        const d = snap.exists() ? snap.data() : {};
        document.getElementById('reqPayee').value = d.payeeName || '';
        document.getElementById('reqEdrpou').value = d.edrpou || '';
        document.getElementById('reqIban').value = d.iban || '';
        document.getElementById('reqHouse').value =
            d.houseAddress || 'вул. Інглезі, 3/3, м. Одеса';
        document.getElementById('reqPurpose').value =
            d.purposeTemplate || 'Внески на утримання будинку, кв. {apt}';
    } catch (e) {
        console.error('Завантаження реквізитів:', e);
    }
}

export async function saveRequisites(btn) {
    const payeeName = document.getElementById('reqPayee').value.trim();
    const edrpou = document.getElementById('reqEdrpou').value.trim();
    const iban = document.getElementById('reqIban').value.trim().replace(/\s+/g, '').toUpperCase();
    const purposeTemplate = document.getElementById('reqPurpose').value.trim();
    const houseAddress = document.getElementById('reqHouse').value.trim();

    // IBAN потрібен не всім: там, де ОСББ зареєстроване в банку
    // як отримувач, платять за особовим рахунком без нього.
    if (iban && !/^UA\d{27}$/.test(iban)) {
        return toast('IBAN має вигляд UA та 27 цифр', 'error');
    }
    if (edrpou && !/^\d{8,10}$/.test(edrpou)) {
        return toast('ЄДРПОУ — 8 цифр, ІПН — 10', 'error');
    }

    setBusy(btn, true, 'Збереження…');
    try {
        await setDoc(doc(db, 'osbb_settings', 'finance'),
            { payeeName, edrpou, iban, purposeTemplate, houseAddress, updatedAt: serverTimestamp() },
            { merge: true });
        requisites = null;              // щоб мешканець побачив свіже
        toast('Реквізити збережено', 'success');
    } catch (e) {
        console.error('Збереження реквізитів:', e);
        toast('Не вдалося зберегти реквізити', 'error');
    } finally {
        setBusy(btn, false);
    }
}

// ------------------------------------------------------------
// CSV З БОРГАМИ
// ------------------------------------------------------------
/**
 * Читає CSV «квартира;сума».
 *
 * Розбиваємо по ПЕРШОМУ роздільнику, а не по всіх: кома буває і
 * роздільником стовпців, і десятковою. Розбиття по всіх комах
 * перетворювало «298;-1250,40» на -1250 — сорок копійок зникали, —
 * а «9 -640,20» на квартиру 9640.
 */
export function parseDebtsCSV(text) {
    const rows = [], errors = [];
    String(text || '').replace(/^\ufeff/, '').split(/\r?\n/).forEach((line, i) => {
        const raw = line.trim();
        if (!raw) return;

        const m = raw.match(/^([^;,\t\s]+)\s*[;,\t]\s*(.+)$/)   // 298;-1250,40
               || raw.match(/^(\S+)\s+(.+)$/);                    // 298 -1250,40
        if (!m) { errors.push({ line: i + 1, raw }); return; }

        const apt = m[1].replace(/\D/g, '');
        const amount = m[2].trim().replace(/^"|"$/g, '');
        if (!apt || !/^-?\s*[\d\s]*[.,]?\d+$/.test(amount)) {
            errors.push({ line: i + 1, raw });
            return;
        }
        rows.push({ apt, balance: parseMoney(amount) });
    });
    // Шапку таблиці («Квартира;Борг») відкидаємо мовчки
    if (errors.length && /кварт|apt|№/i.test(errors[0].raw)) errors.shift();
    return { rows, errors };
}

export async function uploadDebtsCSV(file, btn) {
    if (!file) return toast('Оберіть файл CSV', 'error');
    setBusy(btn, true, 'Читання файлу…');
    try {
        const text = await file.text();
        const { rows, errors } = parseDebtsCSV(text);
        if (!rows.length) {
            toast('У файлі немає жодного коректного рядка', 'error');
            return;
        }

        const known = await loadKnownApts();
        const valid = known.size ? rows.filter(r => known.has(r.apt)) : rows;
        const unknown = rows.length - valid.length;
        if (!valid.length) {
            toast('Жодна квартира з файлу не знайдена в базі', 'error');
            return;
        }

        setBusy(btn, true, 'Збереження…');
        for (let i = 0; i < valid.length; i += 400) {
            const batch = writeBatch(db);
            valid.slice(i, i + 400).forEach(r => {
                batch.set(doc(db, 'apartments', r.apt),
                    { balance: r.balance, balanceUpdatedAt: new Date() }, { merge: true });
            });
            await batch.commit();
        }

        const extra = [
            unknown ? `невідомих квартир: ${unknown}` : '',
            errors.length ? `нерозпізнаних рядків: ${errors.length}` : ''
        ].filter(Boolean).join(', ');
        toast(`Оновлено балансів: ${valid.length}${extra ? ` (${extra})` : ''}`,
              extra ? 'info' : 'success');
    } catch (e) {
        console.error('CSV з боргами:', e);
        toast('Не вдалося прочитати файл', 'error');
    } finally {
        setBusy(btn, false);
    }
}

export function initPayments() {
    document.getElementById('openBankBtn')?.addEventListener('click', function () { copyAll(this); });
    document.getElementById('portmoneLink')?.setAttribute('href', PORTMONE_URL);
    document.getElementById('saveRequisitesBtn')?.addEventListener('click', function () { saveRequisites(this); });

    const csv = document.getElementById('debtsCsvFile');
    document.getElementById('uploadDebtsBtn')?.addEventListener('click', function () {
        uploadDebtsCSV(csv?.files?.[0], this);
    });
}

// ------------------------------------------------------------
// ОСОБОВІ РАХУНКИ
// Той самий формат, що й баланси: «квартира рахунок».
// ------------------------------------------------------------
export function parseAccountLines(text) {
    const rows = [], errors = [];
    String(text || '').replace(/^\ufeff/, '').split(/\r?\n/).forEach((line, i) => {
        const raw = line.trim();
        if (!raw) return;
        const m = raw.match(/^([^;,\t\s]+)\s*[;,\t]\s*(.+)$/) || raw.match(/^(\S+)\s+(.+)$/);
        if (!m) { errors.push({ line: i + 1, raw }); return; }
        const apt = m[1].replace(/\D/g, '');
        const account = m[2].trim().replace(/^"|"$/g, '').replace(/\s+/g, '');
        if (!apt || !account) { errors.push({ line: i + 1, raw }); return; }
        rows.push({ apt, account });
    });
    if (errors.length && /кварт|apt|№|рахун/i.test(errors[0].raw)) errors.shift();
    return { rows, errors };
}

export async function applyAccounts(btn) {
    const { rows, errors } = parseAccountLines(document.getElementById('accountsBulk').value);
    if (!rows.length) return toast('Немає жодного коректного рядка', 'error');

    setBusy(btn, true, 'Збереження…');
    try {
        const known = await loadKnownApts();
        const valid = known.size ? rows.filter(r => known.has(r.apt)) : rows;
        const unknown = rows.length - valid.length;
        if (!valid.length) {
            toast('Жодна квартира з переліку не знайдена в базі', 'error');
            return;
        }
        for (let i = 0; i < valid.length; i += 400) {
            const batch = writeBatch(db);
            valid.slice(i, i + 400).forEach(r => {
                batch.set(doc(db, 'apartments', r.apt), { personalAccount: r.account }, { merge: true });
            });
            await batch.commit();
        }
        const extra = [
            unknown ? `невідомих квартир: ${unknown}` : '',
            errors.length ? `нерозпізнаних рядків: ${errors.length}` : ''
        ].filter(Boolean).join(', ');
        toast(`Внесено рахунків: ${valid.length}${extra ? ` (${extra})` : ''}`, extra ? 'info' : 'success');
        document.getElementById('accountsBulk').value = '';
        document.getElementById('accountsPreview').innerHTML = '';
    } catch (e) {
        console.error('Особові рахунки:', e);
        toast('Не вдалося зберегти рахунки', 'error');
    } finally {
        setBusy(btn, false);
    }
}

function previewAccounts() {
    const host = document.getElementById('accountsPreview');
    if (!host) return;
    const { rows, errors } = parseAccountLines(document.getElementById('accountsBulk').value);
    if (!rows.length && !errors.length) { host.innerHTML = ''; return; }
    host.innerHTML = `<div class="bulk-preview">
        <span class="bulk-ok">Розпізнано: ${rows.length}</span>
        ${errors.length ? `<span class="bulk-bad">Не розпізнано: ${errors.length}</span>` : ''}
        ${rows.slice(0, 4).map(r => `<span class="bulk-row">кв. ${escapeHtml(r.apt)} → ${escapeHtml(r.account)}</span>`).join('')}
        ${rows.length > 4 ? `<span class="bulk-row bulk-more">…і ще ${rows.length - 4}</span>` : ''}
    </div>`;
}

export function initAccounts() {
    document.getElementById('accountsBulk')?.addEventListener('input', previewAccounts);
    document.getElementById('applyAccountsBtn')?.addEventListener('click', function () { applyAccounts(this); });
}
