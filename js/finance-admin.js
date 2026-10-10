// ============================================================
// Фінанси в панелі правління: масові баланси, квитанції, звіт про
// витрати, реквізити, борги з CSV та особові рахунки. Кабінет
// мешканця цього коду не вантажить.
// ============================================================
import { db, storage, currentApt } from './firebase.js';
import { audit } from './audit.js';
import {
    collection, doc, getDoc, setDoc, addDoc, serverTimestamp, writeBatch
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import {
    ref as sRef, uploadBytes, getDownloadURL
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-storage.js";
import { escapeHtml, toast, setBusy, parseMoney, formatMoney } from './ui.js';
import { loadKnownApts, renderDonut } from './finance.js';

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
        // Після вхідних залишків баланс рахує сервер з історії квартири
        // (кабінет бухгалтера → «Нарахування»); правила запис забороняють.
        const charges = await getDoc(doc(db, 'charges', 'settings')).catch(() => null);
        if (charges?.exists() && charges.data().opening?.set) {
            toast('Баланси тепер рахуються з історії. Виправити залишок — у кабінеті бухгалтера → «Нарахування»', 'error');
            return;
        }
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
                    { balance: r.balance, balanceUpdatedAt: serverTimestamp(), balanceUpdatedBy: currentApt() }, { merge: true });
            });
            await batch.commit();
        }
        await audit('balances.update', { target: 'apartments', summary: `Баланси оновлено: ${valid.length} кв.`,
            details: { count: valid.length, balances: Object.fromEntries(valid.map(r => [r.apt, r.balance])) } });
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
    if (done) await audit('receipts.upload', { target: 'receipts', summary: `Квитанції за «${period}»: ${done} файл.`,
        details: { period, count: done, apartments: [...new Set(ready.map(r => r.apt))].slice(0, 400) } });
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
    const incomeRaw = document.getElementById('expenseIncome').value.trim();
    const items = currentExpenseItems();
    if (!period) return toast('Вкажіть період', 'error');
    if (!items.length) return toast('Додайте хоча б одну статтю витрат', 'error');

    setBusy(btn, true, 'Збереження…');
    try {
        // Звіт, який формує бухгалтерія (кабінет бухгалтера → «Кошторис»), руками не перезаписуємо.
        const current = await getDoc(doc(db, 'finance', 'current')).catch(() => null);
        if (current?.exists() && current.data().source === 'ledger') {
            toast('Звіт тепер формує бухгалтерія: кабінет бухгалтера → «Кошторис» → «Для мешканців»', 'error');
            return;
        }
        await setDoc(doc(db, 'finance', 'current'), {
            period, items,
            // Порожнє поле — не нуль: у нуля й «не вказано» різний сенс
            funds: fundsRaw === '' ? null : parseMoney(fundsRaw),
            income: incomeRaw === '' ? null : parseMoney(incomeRaw),
            fundsDate,
            total: items.reduce((s, i) => s + i.amount, 0),
            updatedAt: serverTimestamp()
        });
        await audit('finance.report', { target: 'finance/current', summary: `Фінансовий звіт «${period}» опубліковано`,
            details: { period, income: incomeRaw, funds: fundsRaw, items: items.length } });
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
            document.getElementById('expenseIncome').value =
                (d.income === undefined || d.income === null) ? '' : d.income;
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
function initBudgetTools() {
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
        await audit('finance.requisites', { target: 'osbb_settings/finance', summary: 'Платіжні реквізити змінено' });
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
                    { balance: r.balance, balanceUpdatedAt: serverTimestamp(), balanceUpdatedBy: currentApt() }, { merge: true });
            });
            await batch.commit();
        }

        await audit('balances.import', { target: 'apartments', summary: `Баланси з файлу: ${valid.length} кв.`,
            details: { count: valid.length, balances: Object.fromEntries(valid.map(r => [r.apt, r.balance])) } });
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
        await audit('accounts.import', { target: 'apartments', summary: `Особові рахунки: ${valid.length} кв.`,
            details: { count: valid.length, accounts: Object.fromEntries(valid.map(r => [r.apt, r.account])) } });
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

function initAccountTools() {
    document.getElementById('accountsBulk')?.addEventListener('input', previewAccounts);
    document.getElementById('applyAccountsBtn')?.addEventListener('click', function () { applyAccounts(this); });
}

export function initFinanceAdmin() {
    initBudgetTools();
    initAccountTools();
    document.getElementById('saveRequisitesBtn')?.addEventListener('click', function () { saveRequisites(this); });
    const csv = document.getElementById('debtsCsvFile');
    document.getElementById('uploadDebtsBtn')?.addEventListener('click', function () {
        uploadDebtsCSV(csv?.files?.[0], this);
    });
}
