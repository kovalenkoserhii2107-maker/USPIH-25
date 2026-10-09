// ============================================================
// «Вхідні»: усе, що потребує рішення людини, з готовою пропозицією.
//
// Система пропонує — бухгалтер підтверджує. На ПК: ↑/↓ — між
// пунктами, Enter — «Так», E — інше рішення, Esc — закрити форму.
// На телефоні — кнопка «Так» на кожній картці. Будь-яке рішення
// можна змінити вручну, а потім повернути з «Банку».
// ============================================================
import { escapeHtml, toast, confirmDialog } from './ui.js';
import {
    loadQueue, loadDirectory, act, signed, when, money, maskIban, skipProposal, INCOME_CATEGORIES, EXPENSE_CATEGORIES
} from './buh-data.js';
import { activeProposals, sendProposal, defaultAccount, openForm as openPaymentForm } from './buh-payments.js';

const CONFIDENCE = {
    'імʼя власника': ['high', 'висока'],
    'прізвище власника': ['medium', 'середня'],
    'число в призначенні': ['low', 'низька']
};

let items = [];
let focus = 0;
let editing = null;
let busy = new Set();

/** Пропозиція системи для операції з черги. */
export function proposalFor(tx) {
    const suggestions = tx.suggestions || [];
    if (tx.direction === 'out') return { type: 'expense' };
    if (tx.kind === 'income') return { type: 'income' };
    if (tx.reason === 'several' && suggestions.length > 1) return { type: 'split', apts: suggestions.map(s => s.apt) };
    if (suggestions.length === 1) {
        const [level, label] = CONFIDENCE[suggestions[0].reason] || ['low', 'низька'];
        return { type: 'assign', apt: suggestions[0].apt, reason: suggestions[0].reason, level, label };
    }
    return { type: 'choose', apts: suggestions.map(s => s.apt) };
}

const ownerName = (dir, apt) => dir.find(a => a.apt === apt)?.owners?.[0]?.name || '';

function proposalHtml(item, dir) {
    const p = item.proposal;
    if (p.type === 'assign') {
        return `<p class="inbox-proposal"><span class="inbox-arrow">→</span> Рознести в <b>кв. ${escapeHtml(p.apt)}</b>
            ${ownerName(dir, p.apt) ? `<span class="inbox-who">${escapeHtml(ownerName(dir, p.apt))}</span>` : ''}
            <span class="inbox-level is-${p.level}" title="Впевненість: ${p.label}">${escapeHtml(p.reason)} · ${p.label}</span></p>`;
    }
    if (p.type === 'split') return `<p class="inbox-proposal"><span class="inbox-arrow">→</span> Розділити між <b>кв. ${p.apts.map(escapeHtml).join(' і ')}</b> — вкажіть суми</p>`;
    if (p.type === 'income') return '<p class="inbox-proposal is-ask">Надходження не від мешканця — оберіть вид</p>';
    if (p.type === 'expense') return '<p class="inbox-proposal is-ask">Списання — оберіть вид витрати</p>';
    return `<p class="inbox-proposal is-ask">Квартиру не розпізнано${p.apts.length ? ` — схоже на кв. ${p.apts.map(escapeHtml).join(', ')}` : ''}</p>`;
}

function formHtml(item, dir) {
    const p = item.proposal;
    if (p.type === 'income' || p.type === 'expense') {
        const cats = p.type === 'income' ? INCOME_CATEGORIES : EXPENSE_CATEGORIES;
        return `<div class="inbox-cats">${Object.entries(cats).map(([k, v]) =>
            `<button type="button" class="inbox-cat" data-cat="${k}">${escapeHtml(v)}</button>`).join('')}</div>`;
    }
    const preset = p.type === 'split' ? p.apts : [p.type === 'assign' ? p.apt : (p.apts.length === 1 ? p.apts[0] : '')];
    const split = preset.length > 1;
    const chips = (item.tx.suggestions || []).filter(s => !preset.includes(s.apt) || !split)
        .map(s => `<button type="button" class="inbox-chip" data-pick="${escapeHtml(s.apt)}">кв. ${escapeHtml(s.apt)}<small>${escapeHtml(ownerName(dir, s.apt) || s.reason)}</small></button>`).join('');
    return `${chips && p.type !== 'assign' ? `<div class="inbox-chips">${chips}</div>` : ''}
        <div class="inbox-rows">${preset.map(apt => rowHtml(apt, split)).join('')}</div>
        <div class="inbox-form-tools">
            <button type="button" class="btn-ghost-small" data-act="add-row">+ квартира</button>
            <label class="am-check inbox-remember"${split ? ' hidden' : ''}><input type="checkbox" checked><span>Запамʼятати платника</span></label>
        </div>
        <div class="inbox-form-actions">
            <button type="button" class="btn-primary btn-compact" data-act="save">Рознести</button>
            <select class="field-input field-select inbox-other" aria-label="Не від мешканця">
                <option value="">Не від мешканця…</option>
                ${Object.entries(INCOME_CATEGORIES).map(([k, v]) => `<option value="${k}">${escapeHtml(v)}</option>`).join('')}
            </select>
        </div>`;
}

const rowHtml = (apt = '', withSum = false) => `<div class="inbox-row">
    <input class="field-input inbox-apt" inputmode="numeric" maxlength="6" placeholder="Кв." value="${escapeHtml(apt)}" aria-label="Квартира">
    <input class="field-input inbox-sum" inputmode="decimal" placeholder="Сума, грн" aria-label="Сума"${withSum ? '' : ' hidden'}>
</div>`;

/** Регулярний платіж, який система пропонує відправити в банк. */
function payCardHtml(item, index) {
    const p = item.proposal.payment;
    return `<article class="inbox-card is-pay${index === focus ? ' is-focus' : ''}${busy.has(item.tx.id) ? ' is-busy' : ''}" data-id="${escapeHtml(item.tx.id)}" data-index="${index}" tabindex="-1">
        <div class="inbox-main">
            <span class="inbox-sum-big is-out">−${escapeHtml(money(p.amountKop).replace(' грн', ''))} ₴</span>
            <span class="inbox-meta">платіж · зазвичай ${p.day}-го</span>
            <p class="inbox-payer">${escapeHtml(p.recipient.name)}</p>
            <p class="inbox-purpose">${escapeHtml(p.purpose)}</p>
        </div>
        <div class="inbox-decision">
            <p class="inbox-proposal"><span class="inbox-arrow">→</span> Відправити в Приват24 на підпис голови
                <span class="inbox-level is-high">${p.months} міс. поспіль</span></p>
            <p class="inbox-purpose">${escapeHtml(maskIban(p.recipient.iban))} · ${escapeHtml(p.recipient.code)}</p>
            <div class="inbox-actions">
                <button type="button" class="btn-primary inbox-yes" data-act="yes">Так<kbd>Enter</kbd></button>
                <button type="button" class="btn-ghost-small" data-act="edit">Змінити<kbd>E</kbd></button>
                <button type="button" class="btn-ghost-small" data-act="skip">Не цього місяця</button>
            </div>
        </div>
    </article>`;
}

function cardHtml(item, index, dir) {
    if (item.proposal.type === 'pay') return payCardHtml(item, index);
    const tx = item.tx;
    const p = item.proposal;
    const open = editing === tx.id || !['assign'].includes(p.type);
    const quick = p.type === 'assign';
    return `<article class="inbox-card${index === focus ? ' is-focus' : ''}${busy.has(tx.id) ? ' is-busy' : ''}" data-id="${escapeHtml(tx.id)}" data-index="${index}" tabindex="-1">
        <div class="inbox-main">
            <span class="inbox-sum-big ${tx.direction === 'out' ? 'is-out' : 'is-in'}">${signed(tx)} ₴</span>
            <span class="inbox-meta">${escapeHtml(when(tx.at))}</span>
            <p class="inbox-payer">${escapeHtml(tx.counterparty?.name || 'Платник не вказаний')}</p>
            <p class="inbox-purpose">${escapeHtml(tx.purpose || 'Без призначення')}</p>
        </div>
        <div class="inbox-decision">
            ${proposalHtml(item, dir)}
            ${quick ? `<div class="inbox-actions">
                <button type="button" class="btn-primary inbox-yes" data-act="yes">Так<kbd>Enter</kbd></button>
                <button type="button" class="btn-ghost-small" data-act="edit">Інше рішення<kbd>E</kbd></button>
            </div>` : ''}
            ${open ? `<div class="inbox-form">${formHtml(item, dir)}</div>` : ''}
        </div>
    </article>`;
}

function updateBadges() {
    for (const id of ['buhInboxBadge', 'buhInboxBadgeTab']) {
        const el = document.getElementById(id);
        if (!el) continue;
        el.textContent = items.length > 99 ? '99+' : String(items.length);
        el.hidden = !items.length;
    }
}

let dirCache = [];
function render() {
    const host = document.getElementById('viewInbox');
    updateBadges();
    if (!items.length) {
        host.innerHTML = `<div class="buh-empty"><span class="buh-empty-mark">✓</span><h2>Усе розібрано</h2>
            <p>Оплати з номером квартири чи особовим рахунком і від знайомих платників система розносить сама. Тут зʼявляється лише те, що потребує вашого рішення.</p></div>`;
        return;
    }
    focus = Math.min(focus, items.length - 1);
    const sure = items.filter(i => i.proposal.type === 'assign' && i.proposal.level === 'high');
    host.innerHTML = `<div class="inbox-head">
            <p><b>${items.length}</b> чекають рішення · пропозиція є для <b>${items.filter(i => ['assign', 'pay'].includes(i.proposal.type)).length}</b></p>
            ${sure.length > 1 ? `<button type="button" class="btn-soft btn-compact" data-act="bulk">Підтвердити всі з високою впевненістю (${sure.length})</button>` : ''}
            <span class="inbox-keys"><kbd>↑</kbd><kbd>↓</kbd> пункти · <kbd>Enter</kbd> так · <kbd>E</kbd> змінити</span>
        </div>
        <div class="inbox-list">${items.map((item, i) => cardHtml(item, i, dirCache)).join('')}</div>`;
}

let payAccount = '';
export async function loadInbox() {
    const [queue, dir, pays] = await Promise.all([loadQueue(), loadDirectory(), activeProposals().catch(() => ({ list: [], context: { accounts: [] } }))]);
    dirCache = dir;
    payAccount = defaultAccount(pays.context.accounts || []);
    items = queue.map(tx => ({ tx, proposal: proposalFor(tx) }))
        .concat(payAccount ? pays.list.map(p => ({ tx: { id: `pay:${p.proposalKey}` }, proposal: { type: 'pay', payment: p } })) : []);
    render();
    return items.length;
}

// ------------------------------------------------------------
// ДІЇ
// ------------------------------------------------------------
async function run(item, payload, done) {
    busy.add(item.tx.id);
    render();
    try {
        await act({ txId: item.tx.id, ...payload });
        editing = null;
        if (done) toast(done, 'success');
    } catch (e) {
        toast(e.message, 'error');
    } finally {
        busy.delete(item.tx.id);
        await loadInbox().catch(() => render());
        document.querySelector('.inbox-card.is-focus')?.focus({ preventScroll: true });
    }
}

async function runPay(item) {
    busy.add(item.tx.id);
    render();
    try { await sendProposal(item.proposal.payment, payAccount); }
    catch (e) { toast(e.message, 'error'); }
    finally { busy.delete(item.tx.id); await loadInbox().catch(() => render()); }
}

const confirmProposal = item => {
    if (item.proposal.type === 'pay') { runPay(item); return; }
    const p = item.proposal;
    if (p.type !== 'assign') { openForm(item); return; }
    run(item, { action: 'assign', allocations: [{ apt: p.apt, amountKop: item.tx.amountKop }], remember: true }, `Рознесено: кв. ${p.apt}`);
};

function openForm(item) {
    if (item.proposal.type === 'pay') {
        // Змінити суму чи призначення — у формі «Платежів».
        location.hash = 'payments';
        openPaymentForm(item.proposal.payment);
        return;
    }
    editing = item.tx.id;
    render();
    const card = document.querySelector(`.inbox-card[data-id="${CSS.escape(item.tx.id)}"]`);
    (card?.querySelector('.inbox-apt:placeholder-shown, .inbox-apt') || card?.querySelector('.inbox-cat'))?.focus();
}

function saveForm(card, item) {
    const rows = [...card.querySelectorAll('.inbox-row')];
    const split = rows.length > 1;
    const allocations = rows.map(row => ({
        apt: row.querySelector('.inbox-apt').value.trim().toLowerCase(),
        amountKop: split ? Math.round(parseFloat(row.querySelector('.inbox-sum').value.replace(/\s/g, '').replace(',', '.')) * 100) : item.tx.amountKop
    })).filter(a => a.apt);
    if (!allocations.length) { toast('Вкажіть квартиру', 'error'); return; }
    const remember = !split && card.querySelector('.inbox-remember input')?.checked === true;
    run(item, { action: 'assign', allocations, remember }, `Рознесено: кв. ${allocations.map(a => a.apt).join(', ')}`);
}

function setFocus(index) {
    focus = Math.max(0, Math.min(items.length - 1, index));
    document.querySelectorAll('.inbox-card').forEach(c => c.classList.toggle('is-focus', Number(c.dataset.index) === focus));
    const card = document.querySelector('.inbox-card.is-focus');
    card?.focus({ preventScroll: true });
    card?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

async function bulk() {
    const sure = items.filter(i => i.proposal.type === 'assign' && i.proposal.level === 'high');
    if (!await confirmDialog(`Рознести ${sure.length} оплат?`, 'Кожну — у квартиру, власника якої система впізнала за повним імʼям. Будь-яку можна повернути з «Банку».', 'Так, рознести')) return;
    let ok = 0;
    for (const item of sure) {
        try {
            await act({ action: 'assign', txId: item.tx.id, allocations: [{ apt: item.proposal.apt, amountKop: item.tx.amountKop }], remember: true });
            ok += 1;
        } catch (e) { toast(`${item.tx.counterparty?.name || ''}: ${e.message}`, 'error'); }
    }
    toast(`Рознесено: ${ok}`, 'success');
    await loadInbox();
}

export function initInbox(isActive) {
    const host = document.getElementById('viewInbox');
    host.addEventListener('click', e => {
        if (e.target.closest('[data-act="bulk"]')) { bulk(); return; }
        const card = e.target.closest('.inbox-card');
        if (!card) return;
        const item = items[Number(card.dataset.index)];
        if (!item || busy.has(item.tx.id)) return;
        if (Number(card.dataset.index) !== focus) setFocus(Number(card.dataset.index));
        const act = e.target.closest('[data-act]')?.dataset.act;
        const cat = e.target.closest('[data-cat]')?.dataset.cat;
        const pick = e.target.closest('[data-pick]')?.dataset.pick;
        if (act === 'skip' && item.proposal.type === 'pay') { skipProposal(item.proposal.payment.proposalKey); return; }
        if (act === 'yes') confirmProposal(item);
        else if (act === 'edit') openForm(item);
        else if (act === 'save') saveForm(card, item);
        else if (act === 'add-row') {
            const rows = card.querySelector('.inbox-rows');
            rows.insertAdjacentHTML('beforeend', rowHtml('', true));
            rows.querySelectorAll('.inbox-sum').forEach(i => { i.hidden = false; });
            card.querySelector('.inbox-remember')?.setAttribute('hidden', '');
            rows.lastElementChild.querySelector('.inbox-apt').focus();
        } else if (pick) {
            const input = [...card.querySelectorAll('.inbox-apt')].find(i => !i.value) || card.querySelector('.inbox-apt');
            if (input) { input.value = pick; input.focus(); }
        } else if (cat) {
            const kind = item.tx.direction === 'out' ? 'expense' : 'income';
            const label = (kind === 'income' ? INCOME_CATEGORIES : EXPENSE_CATEGORIES)[cat];
            run(item, { action: 'classify', kind, category: cat }, label);
        }
    });

    host.addEventListener('change', e => {
        const select = e.target.closest('.inbox-other');
        const card = select?.closest('.inbox-card');
        const item = card && items[Number(card.dataset.index)];
        if (!item || !select.value) return;
        run(item, { action: 'classify', kind: 'income', category: select.value }, INCOME_CATEGORIES[select.value]);
    });

    document.addEventListener('keydown', e => {
        if (!isActive() || !items.length || document.querySelector('.confirm-overlay')) return;
        const typing = e.target.matches('input, textarea, select');
        const card = e.target.closest?.('.inbox-card') || document.querySelector('.inbox-card.is-focus');
        const item = items[focus];
        if (typing) {
            if (e.key === 'Enter' && card && e.target.matches('.inbox-apt, .inbox-sum')) { e.preventDefault(); saveForm(card, items[Number(card.dataset.index)]); }
            if (e.key === 'Escape') { editing = null; render(); setFocus(focus); }
            return;
        }
        if (e.metaKey || e.ctrlKey || e.altKey) return;
        if (e.key === 'ArrowDown' || e.key === 'j') { e.preventDefault(); setFocus(focus + 1); }
        else if (e.key === 'ArrowUp' || e.key === 'k') { e.preventDefault(); setFocus(focus - 1); }
        else if (e.key === 'Enter' && item && !e.target.closest('button, a')) { e.preventDefault(); confirmProposal(item); }
        else if ((e.key === 'e' || e.key === 'у') && item) { e.preventDefault(); openForm(item); }
        else if (e.key === 'Escape' && editing) { editing = null; render(); setFocus(focus); }
    });
}
