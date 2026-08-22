// ============================================================
// Фінанси: баланс квартири, квитанції та звіт про витрати ОСББ.
//
// Баланс лежить у самій квартирі (apartments/{apt}.balance):
// додатне число — борг, від'ємне — переплата. Квитанції —
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
    const debt = n > 0.005;
    const credit = n < -0.005;
    const state = debt ? 'debt' : credit ? 'credit' : 'zero';
    const label = debt ? 'До сплати' : credit ? 'Переплата' : 'Заборгованості немає';

    return `<div class="balance-card balance-${state}">
        <div class="balance-main">
            <span class="balance-label">${label}</span>
            <span class="balance-sum">${state === 'zero' ? '0,00' : formatMoney(n)}<small>грн</small></span>
            ${updatedAt ? `<span class="balance-date">Оновлено ${escapeHtml(formatDateTime(updatedAt))}</span>` : ''}
        </div>
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
        host.innerHTML = renderBalance(d.balance, d.balanceUpdatedAt);
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
        host.innerHTML = `<div class="card">
            <div class="section-head-text" style="margin-bottom: 14px;">
                <h2 class="admin-card-title">Куди пішли гроші</h2>
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
        const m = raw.match(/^(\S+)[\s;,\t]+(-?[\d\s]+(?:[.,]\d+)?)$/);
        if (!m) { errors.push({ line: i + 1, raw }); return; }
        // Тільки цифри: «кв.9» → «9». Інакше в базі з'явився б
        // документ «кв9», якого не існує.
        const apt = m[1].replace(/\D/g, '');
        if (!apt) { errors.push({ line: i + 1, raw }); return; }
        rows.push({ apt, balance: parseMoney(m[2]) });
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
            `<span class="bulk-row">кв. ${escapeHtml(r.apt)} → ${r.balance > 0 ? 'борг ' : r.balance < 0 ? 'переплата ' : ''}${formatMoney(r.balance)} грн</span>`
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
    const items = currentExpenseItems();
    if (!period) return toast('Вкажіть період', 'error');
    if (!items.length) return toast('Додайте хоча б одну статтю витрат', 'error');

    setBusy(btn, true, 'Збереження…');
    try {
        await setDoc(doc(db, 'finance', 'current'), {
            period, items,
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
