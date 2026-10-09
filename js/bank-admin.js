// ============================================================
// Фінанси → Банк: рахунки ОСББ, черга «Розібрати» й операції.
//
// Клієнт нічого не пише в базу сам: рознесення, категорії, токен і
// синхронізація йдуть через серверну функцію bankAction. Там
// перевіряються ролі й суми, створюються записи в історії квартири
// й пишеться журнал дій. Тут — лише показ і форма.
// ============================================================
import { db } from './firebase.js';
import {
    collection, doc, getDoc, getDocs, query, where, orderBy, limit, startAfter
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { callBackend } from './backend.js';
import { escapeHtml, toast, setBusy, formatMoney, confirmDialog } from './ui.js';
import { fetchDirectory } from './directory.js';

export const ACCOUNT_PURPOSES = {
    current: 'Поточний', repair: 'Ремонтний фонд', reserve: 'Резервний фонд',
    deposit: 'Депозит', grant: 'Грантовий'
};
export const INCOME_CATEGORIES = {
    rent: 'Оренда', interest: 'Відсотки банку', grant: 'Грант, співфінансування',
    refund: 'Повернення коштів', other: 'Інше надходження'
};
export const EXPENSE_CATEGORIES = {
    bank_fee: 'Комісія банку', salary: 'Зарплата', taxes: 'Податки й внески', other: 'Витрата'
};
const METHOD = {
    account: 'за особовим рахунком', marked: 'за номером квартири в призначенні',
    link: 'за запамʼятованим платником', manual: 'вручну'
};
const FILTERS = { all: 'Усі', in: 'Надходження', out: 'Списання', review: 'Розібрати' };
const PAGE = 60;

let directory = [];
let ops = [];
let lastOp = null;
let filter = 'all';
let queue = [];

const money = kop => `${kop < 0 ? '−' : ''}${formatMoney(kop / 100)} грн`;
const signed = tx => `${tx.direction === 'out' ? '−' : '+'}${formatMoney(tx.amountKop / 100)}`;
const when = ts => {
    const d = ts?.toDate ? ts.toDate() : new Date(ts);
    return d.toLocaleString('uk-UA', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
};
const maskIban = iban => iban ? `${iban.slice(0, 4)}…${iban.slice(-4)}` : '';

/** Що це за операція — коротким ярликом для списку. */
function tagOf(tx) {
    if (tx.status === 'review') return { text: 'Розібрати', cls: 'is-review' };
    if (tx.kind === 'payment') {
        const apts = (tx.allocations || []).map(a => a.apt);
        return { text: apts.length ? `кв. ${apts.join(', ')}` : 'Внесок', cls: 'is-payment' };
    }
    if (tx.kind === 'internal') return { text: 'Між рахунками', cls: 'is-internal' };
    if (tx.kind === 'income') return { text: INCOME_CATEGORIES[tx.category] || 'Надходження', cls: 'is-income' };
    return { text: EXPENSE_CATEGORIES[tx.category] || 'Витрата', cls: 'is-expense' };
}

// ------------------------------------------------------------
// РАХУНКИ Й ПІДКЛЮЧЕННЯ
// ------------------------------------------------------------
function renderSettings(settings) {
    const state = document.getElementById('bankSyncState');
    const sync = document.getElementById('bankSyncBtn');
    const summary = document.getElementById('bankConnectSummary');
    const remove = document.getElementById('bankTokenRemoveBtn');
    const connected = settings?.tokenSet === true;
    sync.hidden = !connected;
    remove.hidden = !connected;
    summary.textContent = connected ? `ПриватБанк підключено (токен …${settings.tokenHint || ''})` : 'Підключити ПриватБанк';
    document.getElementById('bankConnect').open = !connected;

    const last = settings?.lastSync;
    if (!connected) state.textContent = 'Банк не підключено. Після підключення виписка завантажуватиметься сама щогодини.';
    else if (!last) state.textContent = 'Підключено. Перша виписка завантажиться протягом години або натисніть «Оновити з банку».';
    else if (last.ok === false) state.innerHTML = `<span class="bank-error">Банк не відповів ${escapeHtml(when(last.at))}: ${escapeHtml(last.error || 'невідома помилка')}</span>`;
    else state.textContent = `Оновлено ${when(last.at)}${last.added ? ` · нових операцій: ${last.added}` : ''}`;

    const accounts = Object.entries(settings?.accounts || {});
    document.getElementById('bankAccounts').innerHTML = accounts.length ? accounts.map(([iban, a]) => `
        <div class="bank-account" data-iban="${escapeHtml(iban)}">
            <span class="bank-account-main"><b>${escapeHtml(a.label || ACCOUNT_PURPOSES[a.purpose] || 'Рахунок')}</b>
                <small>${escapeHtml(maskIban(iban))}${a.currency && a.currency !== 'UAH' ? ` · ${escapeHtml(a.currency)}` : ''}</small></span>
            <select class="field-input field-select bank-purpose" aria-label="Призначення рахунку">
                ${Object.entries(ACCOUNT_PURPOSES).map(([k, v]) => `<option value="${k}"${k === (a.purpose || 'current') ? ' selected' : ''}>${v}</option>`).join('')}
            </select>
            <span class="bank-account-balance"><b>${typeof a.balanceKop === 'number' ? money(a.balanceKop) : '—'}</b>
                <small>${a.balanceAt ? `станом на ${escapeHtml(when(a.balanceAt))}` : ''}</small></span>
        </div>`).join('') : '';
}

// ------------------------------------------------------------
// ЧЕРГА «РОЗІБРАТИ»
// ------------------------------------------------------------
function allocRow(apt = '', amount = '', withSum = false) {
    return `<div class="bank-alloc-row">
        <input class="field-input bank-apt" inputmode="numeric" maxlength="6" placeholder="Кв." value="${escapeHtml(apt)}" aria-label="Квартира">
        <input class="field-input bank-sum" inputmode="decimal" placeholder="Сума, грн" value="${escapeHtml(amount)}" aria-label="Сума"${withSum ? '' : ' hidden'}>
    </div>`;
}

function renderQueue() {
    const host = document.getElementById('bankQueue');
    const count = document.getElementById('bankQueueCount');
    count.textContent = queue.length ? ` · ${queue.length}` : '';
    if (!queue.length) { host.innerHTML = '<p class="list-empty">Усе рознесено</p>'; return; }
    host.innerHTML = queue.map(tx => {
        const owner = apt => directory.find(a => a.apt === apt)?.owners?.[0]?.name || '';
        const chips = (tx.suggestions || []).map(s => `<button type="button" class="bank-chip" data-pick="${escapeHtml(s.apt)}">
            кв. ${escapeHtml(s.apt)}<small>${escapeHtml(s.reason)}${owner(s.apt) ? ` · ${escapeHtml(owner(s.apt))}` : ''}</small></button>`).join('');
        const income = tx.direction === 'in';
        // В одному призначенні кілька квартир — одразу пропонуємо розділити.
        const several = tx.reason === 'several' && (tx.suggestions || []).length > 1;
        return `<div class="bank-item" data-tx="${escapeHtml(tx.id)}">
            <div class="bank-item-head"><b class="bank-amount ${income ? 'is-in' : 'is-out'}">${signed(tx)} грн</b><span>${escapeHtml(when(tx.at))}</span></div>
            <p class="bank-payer">${escapeHtml(tx.counterparty?.name || 'Платник не вказаний')}</p>
            <p class="bank-purpose">${escapeHtml(tx.purpose || 'Без призначення')}</p>
            ${income ? `
            ${chips ? `<div class="bank-chips">${chips}</div>` : ''}
            <div class="bank-alloc">${several
                ? tx.suggestions.map(sg => allocRow(sg.apt, '', true)).join('')
                : allocRow((tx.suggestions || []).length === 1 ? tx.suggestions[0].apt : '')}</div>
            <div class="bank-item-tools">
                <button type="button" class="btn-ghost-small" data-act="split">${several ? 'Додати квартиру' : 'Розділити між квартирами'}</button>
                <label class="am-check bank-remember"${several ? ' hidden' : ''}><input type="checkbox" checked><span>Запамʼятати платника</span></label>
            </div>
            <div class="bank-item-actions">
                <button type="button" class="btn-primary btn-compact" data-act="assign">Рознести</button>
                <select class="field-input field-select bank-other" aria-label="Інше надходження">
                    <option value="">Не від мешканця…</option>
                    ${Object.entries(INCOME_CATEGORIES).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}
                </select>
            </div>` : `
            <div class="bank-item-actions">
                <select class="field-input field-select bank-expense" aria-label="Вид витрати">
                    <option value="">Вид витрати…</option>
                    ${Object.entries(EXPENSE_CATEGORIES).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}
                </select>
            </div>`}
        </div>`;
    }).join('');
}

async function assign(item, tx, button) {
    const rows = [...item.querySelectorAll('.bank-alloc-row')];
    const split = rows.length > 1;
    const allocations = rows.map(row => ({
        apt: row.querySelector('.bank-apt').value.trim().toLowerCase(),
        amountKop: split ? Math.round(parseFloat(row.querySelector('.bank-sum').value.replace(/\s/g, '').replace(',', '.')) * 100) : tx.amountKop
    })).filter(a => a.apt);
    if (!allocations.length) { toast('Вкажіть квартиру', 'error'); return; }
    const remember = !split && item.querySelector('.bank-remember input')?.checked === true;
    setBusy(button, true, 'Розношу…');
    try {
        await callBackend('bankAction', { action: 'assign', txId: tx.id, allocations, remember });
        toast(`Рознесено: кв. ${allocations.map(a => a.apt).join(', ')}`, 'success');
        await loadBank();
    } catch (e) {
        toast(e.message, 'error');
    } finally {
        setBusy(button, false);
    }
}

async function classifyTx(tx, kind, category) {
    try {
        await callBackend('bankAction', { action: 'classify', txId: tx.id, kind, category });
        toast('Збережено', 'success');
        await loadBank();
    } catch (e) {
        toast(e.message, 'error');
    }
}

// ------------------------------------------------------------
// ОПЕРАЦІЇ
// ------------------------------------------------------------
function matchesFilter(tx) {
    if (filter === 'in' && tx.direction !== 'in') return false;
    if (filter === 'out' && tx.direction !== 'out') return false;
    if (filter === 'review' && tx.status !== 'review') return false;
    const q = document.getElementById('bankSearch').value.trim().toLowerCase();
    if (!q) return true;
    const apts = (tx.allocations || []).map(a => a.apt);
    return apts.includes(q.replace(/^кв\.?\s*/, ''))
        || String(tx.counterparty?.name || '').toLowerCase().includes(q)
        || String(tx.purpose || '').toLowerCase().includes(q);
}

function renderOps() {
    document.getElementById('bankFilters').innerHTML = Object.entries(FILTERS).map(([k, v]) =>
        `<button type="button" class="dir-filter${k === filter ? ' active' : ''}" data-f="${k}">${v}</button>`).join('');
    const host = document.getElementById('bankOps');
    const list = ops.filter(matchesFilter);
    if (!list.length) { host.innerHTML = `<p class="list-empty">${ops.length ? 'Нічого не знайдено' : 'Операцій ще немає'}</p>`; return; }
    host.innerHTML = list.map(tx => {
        const tag = tagOf(tx);
        const detail = [
            tx.counterparty?.account ? `Рахунок: ${tx.counterparty.account}` : '',
            tx.counterparty?.code ? `Код: ${tx.counterparty.code}` : '',
            tx.kind === 'payment' && tx.method ? `Рознесено ${METHOD[tx.method] || ''}${tx.resolvedBy ? ` (${tx.resolvedBy})` : ''}` : '',
            (tx.allocations || []).length > 1 ? tx.allocations.map(a => `кв. ${a.apt}: ${money(a.amountKop)}`).join(' · ') : ''
        ].filter(Boolean);
        const canUndo = tx.status === 'done' && tx.kind !== 'internal';
        return `<div class="bank-op" data-tx="${escapeHtml(tx.id)}">
            <button type="button" class="bank-op-head">
                <span class="bank-op-date">${escapeHtml(when(tx.at))}</span>
                <span class="bank-op-main"><b>${escapeHtml(tx.counterparty?.name || '—')}</b><small>${escapeHtml(tx.purpose || '')}</small></span>
                <span class="bank-tag ${tag.cls}">${escapeHtml(tag.text)}</span>
                <span class="bank-op-sum ${tx.direction === 'out' ? 'is-out' : 'is-in'}">${signed(tx)}</span>
            </button>
            <div class="bank-op-body" hidden>
                ${detail.map(line => `<p>${escapeHtml(line)}</p>`).join('')}
                ${canUndo ? '<button type="button" class="btn-ghost-small" data-act="undo">Повернути в «Розібрати»</button>' : ''}
            </div>
        </div>`;
    }).join('');
}

async function fetchOps(more = false) {
    const parts = [collection(db, 'bank_tx'), orderBy('at', 'desc'), limit(PAGE)];
    if (more && lastOp) parts.splice(2, 0, startAfter(lastOp));
    const snap = await getDocs(query(...parts));
    lastOp = snap.docs[snap.docs.length - 1] || lastOp;
    const page = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    ops = more ? ops.concat(page) : page;
    document.getElementById('bankMoreBtn').hidden = snap.docs.length < PAGE;
}

export async function loadBank() {
    const [settings, queueSnap, dir] = await Promise.all([
        getDoc(doc(db, 'bank', 'settings')),
        getDocs(query(collection(db, 'bank_tx'), where('status', '==', 'review'), limit(200))),
        fetchDirectory().catch(() => []),
        fetchOps()
    ]);
    directory = dir;
    renderSettings(settings.exists() ? settings.data() : null);
    queue = queueSnap.docs.map(d => ({ id: d.id, ...d.data() }))
        .sort((a, b) => (b.at?.toMillis?.() || 0) - (a.at?.toMillis?.() || 0));
    renderQueue();
    renderOps();
}

export function initBank() {
    const card = document.getElementById('bankAccountsCard');
    if (!card || card.dataset.ready) return;
    card.dataset.ready = '1';

    document.getElementById('bankSyncBtn').addEventListener('click', async e => {
        setBusy(e.currentTarget, true, 'Завантажую виписку…');
        try {
            const r = await callBackend('bankAction', { action: 'sync' }, 120000);
            toast(r?.added ? `Нових операцій: ${r.added}` : 'Нових операцій немає', 'success');
            await loadBank();
        } catch (err) { toast(err.message, 'error'); }
        finally { setBusy(e.currentTarget, false); }
    });

    document.getElementById('bankTokenSaveBtn').addEventListener('click', async e => {
        const input = document.getElementById('bankTokenInput');
        const token = input.value.trim();
        if (!token) { toast('Вставте токен', 'error'); return; }
        setBusy(e.currentTarget, true, 'Перевіряю в банку…');
        try {
            const r = await callBackend('bankAction', { action: 'saveToken', token }, 60000);
            input.value = '';
            toast(`Підключено. Рахунків: ${r?.accounts ?? 0}`, 'success');
            await loadBank();
        } catch (err) { toast(err.message, 'error'); }
        finally { setBusy(e.currentTarget, false); }
    });

    document.getElementById('bankTokenRemoveBtn').addEventListener('click', async () => {
        if (!await confirmDialog('Відключити банк?', 'Токен буде видалено з сервера, виписка перестане завантажуватись. Завантажені операції лишаться.', 'Відключити')) return;
        try {
            await callBackend('bankAction', { action: 'removeToken' });
            toast('Банк відключено', 'success');
            await loadBank();
        } catch (err) { toast(err.message, 'error'); }
    });

    document.getElementById('bankAccounts').addEventListener('change', async e => {
        const select = e.target.closest('.bank-purpose');
        if (!select) return;
        const iban = select.closest('[data-iban]').dataset.iban;
        try {
            await callBackend('bankAction', { action: 'setAccount', iban, purpose: select.value });
            toast('Призначення рахунку збережено', 'success');
        } catch (err) { toast(err.message, 'error'); }
    });

    const queueHost = document.getElementById('bankQueue');
    queueHost.addEventListener('click', e => {
        const item = e.target.closest('.bank-item');
        if (!item) return;
        const tx = queue.find(t => t.id === item.dataset.tx);
        const pick = e.target.closest('[data-pick]');
        if (pick) {
            const empty = [...item.querySelectorAll('.bank-apt')].find(i => !i.value) || item.querySelector('.bank-apt');
            empty.value = pick.dataset.pick;
            return;
        }
        const act = e.target.closest('[data-act]')?.dataset.act;
        if (act === 'split') {
            const host = item.querySelector('.bank-alloc');
            host.insertAdjacentHTML('beforeend', allocRow());
            host.querySelectorAll('.bank-sum').forEach(i => { i.hidden = false; });
            item.querySelector('.bank-remember').hidden = true;
        }
        if (act === 'assign') assign(item, tx, e.target.closest('button'));
    });
    queueHost.addEventListener('change', e => {
        const item = e.target.closest('.bank-item');
        const tx = item && queue.find(t => t.id === item.dataset.tx);
        if (!tx || !e.target.value) return;
        if (e.target.matches('.bank-other')) classifyTx(tx, 'income', e.target.value);
        if (e.target.matches('.bank-expense')) classifyTx(tx, 'expense', e.target.value);
    });

    document.getElementById('bankFilters').addEventListener('click', e => {
        const b = e.target.closest('[data-f]');
        if (!b) return;
        filter = b.dataset.f;
        renderOps();
    });
    document.getElementById('bankSearch').addEventListener('input', renderOps);
    document.getElementById('bankMoreBtn').addEventListener('click', async e => {
        setBusy(e.currentTarget, true);
        try { await fetchOps(true); renderOps(); }
        catch (err) { toast(err.message, 'error'); }
        finally { setBusy(e.currentTarget, false); }
    });
    document.getElementById('bankOps').addEventListener('click', async e => {
        const op = e.target.closest('.bank-op');
        if (!op) return;
        if (e.target.closest('.bank-op-head')) {
            const body = op.querySelector('.bank-op-body');
            body.hidden = !body.hidden;
            op.classList.toggle('is-open', !body.hidden);
            return;
        }
        if (e.target.closest('[data-act="undo"]')) {
            const tx = ops.find(t => t.id === op.dataset.tx);
            if (!await confirmDialog('Повернути в «Розібрати»?', tx.kind === 'payment'
                ? 'Оплату буде прибрано з історії квартири. Платник лишиться запамʼятованим, якщо ви його не відвʼяжете.'
                : 'Категорію буде знято.', 'Повернути')) return;
            try {
                await callBackend('bankAction', { action: 'unassign', txId: tx.id });
                toast('Операцію повернуто в «Розібрати»', 'success');
                await loadBank();
            } catch (err) { toast(err.message, 'error'); }
        }
    });
}
