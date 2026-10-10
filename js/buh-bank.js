// ============================================================
// «Банк» (рахунки й журнал операцій) і «Налаштування» (підключення
// ПриватБанку, призначення рахунків, правила погодження).
// ============================================================
import { escapeHtml, toast, setBusy, confirmDialog } from './ui.js';
import { session } from './firebase.js';
import {
    loadSettings, loadPage, loadExpenses, loadDemo, demoAct, expAct, act, money, signed, when, dateOnly, tagOf, maskIban,
    ACCOUNT_PURPOSES, METHOD
} from './buh-data.js';
import { toKop } from './charges-core.js';

const FILTERS = { all: 'Усі', in: 'Надходження', out: 'Списання', review: 'Чекають рішення' };
let rows = [];
let last = null;
let more = false;
let filter = 'all';
let opened = null;

function accountsHtml(settings) {
    const accounts = Object.entries(settings.accounts || {});
    if (!accounts.length) return `<div class="buh-card buh-hint">Банк не підключено. <button type="button" class="btn-ghost-small" data-go="settings">Підключити ПриватБанк →</button></div>`;
    return `<div class="acc-strip">${accounts.map(([iban, a]) => `
        <div class="acc-card">
            <span class="acc-purpose">${escapeHtml(ACCOUNT_PURPOSES[a.purpose] || 'Рахунок')}</span>
            <b class="acc-balance">${typeof a.balanceKop === 'number' ? money(a.balanceKop) : '—'}</b>
            <small>${escapeHtml(maskIban(iban))}${a.balanceAt ? ` · ${escapeHtml(when(a.balanceAt))}` : ''}</small>
        </div>`).join('')}</div>`;
}

function matches(tx) {
    if (filter === 'in' && tx.direction !== 'in') return false;
    if (filter === 'out' && tx.direction !== 'out') return false;
    if (filter === 'review' && tx.status !== 'review') return false;
    const q = (document.getElementById('bankQuery')?.value || '').trim().toLowerCase();
    if (!q) return true;
    const apt = q.replace(/^кв\.?\s*/, '');
    return (tx.allocations || []).some(a => a.apt === apt)
        || String(tx.counterparty?.name || '').toLowerCase().includes(q)
        || String(tx.purpose || '').toLowerCase().includes(q)
        || String(tx.amountKop / 100).includes(q.replace(',', '.'));
}

function detailHtml(tx) {
    const lines = [
        ['Дата', dateOnly(tx.at)],
        ['Рахунок ОСББ', maskIban(tx.account)],
        ['Контрагент', [tx.counterparty?.name, tx.counterparty?.code ? `код ${tx.counterparty.code}` : '', tx.counterparty?.account].filter(Boolean).join(' · ')],
        ['Призначення', tx.purpose],
        tx.kind === 'payment' && tx.method ? ['Рознесено', `${METHOD[tx.method] || ''}${tx.resolvedBy ? ` · ${tx.resolvedBy}` : ''}`] : null,
        (tx.allocations || []).length > 1 ? ['Частини', tx.allocations.map(a => `кв. ${a.apt}: ${money(a.amountKop)}`).join(' · ')] : null
    ].filter(l => l && l[1]);
    const undo = tx.status === 'done' && tx.kind !== 'internal';
    return `<dl class="tx-detail">${lines.map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd>`).join('')}</dl>
        <div class="tx-actions">
            ${tx.status === 'review' ? '<button type="button" class="btn-soft btn-compact" data-go="inbox">Розібрати у «Вхідних»</button>' : ''}
            ${undo ? '<button type="button" class="btn-ghost-small" data-act="undo">Повернути у «Вхідні»</button>' : ''}
        </div>`;
}

function renderTable() {
    const host = document.getElementById('bankTable');
    if (!host) return;
    const list = rows.filter(matches);
    document.getElementById('bankMore').hidden = !more;
    if (!list.length) { host.innerHTML = `<p class="list-empty">${rows.length ? 'Нічого не знайдено' : 'Операцій ще немає'}</p>`; return; }
    host.innerHTML = `<table class="buh-table is-ops">
        <thead><tr><th>Дата</th><th>Контрагент і призначення</th><th>Рахунок</th><th>Рішення</th><th class="t-sum">Сума, ₴</th></tr></thead>
        <tbody>${list.map(tx => {
            const tag = tagOf(tx);
            return `<tr class="tx-row${opened === tx.id ? ' is-open' : ''}" data-id="${escapeHtml(tx.id)}" tabindex="0">
                <td class="t-date">${escapeHtml(when(tx.at))}</td>
                <td class="t-main"><b>${escapeHtml(tx.counterparty?.name || '—')}</b><small>${escapeHtml(tx.purpose || '')}</small></td>
                <td class="t-acc">${escapeHtml(maskIban(tx.account).slice(-4))}</td>
                <td><span class="buh-tag ${tag.cls}">${escapeHtml(tag.text)}</span></td>
                <td class="t-sum ${tx.direction === 'out' ? 'is-out' : 'is-in'}">${signed(tx)}</td>
            </tr>${opened === tx.id ? `<tr class="tx-detail-row"><td colspan="5">${detailHtml(tx)}</td></tr>` : ''}`;
        }).join('')}</tbody></table>`;
}

export async function loadBankView() {
    const [settings, page] = await Promise.all([loadSettings(), loadPage()]);
    rows = page.rows; last = page.last; more = page.full;
    const host = document.getElementById('viewBank');
    host.innerHTML = `${accountsHtml(settings)}
        <section class="buh-card">
            <div class="buh-toolbar">
                <div class="buh-seg" role="tablist">${Object.entries(FILTERS).map(([k, v]) =>
                    `<button type="button" class="buh-seg-item${k === filter ? ' active' : ''}" data-filter="${k}">${v}</button>`).join('')}</div>
                <input type="search" id="bankQuery" class="field-input buh-search" placeholder="Квартира, платник, сума або призначення">
            </div>
            <div id="bankTable"></div>
            <button type="button" id="bankMore" class="btn-ghost-small buh-more" hidden>Показати ще</button>
        </section>`;
    renderTable();
}

export function initBankView() {
    const host = document.getElementById('viewBank');
    host.addEventListener('input', e => { if (e.target.id === 'bankQuery') renderTable(); });
    host.addEventListener('click', async e => {
        const f = e.target.closest('[data-filter]');
        if (f) {
            filter = f.dataset.filter;
            host.querySelectorAll('[data-filter]').forEach(b => b.classList.toggle('active', b === f));
            renderTable();
            return;
        }
        if (e.target.closest('#bankMore')) {
            const btn = e.target.closest('#bankMore');
            setBusy(btn, true);
            try { const page = await loadPage(last); rows = rows.concat(page.rows); last = page.last; more = page.full; renderTable(); }
            catch (err) { toast(err.message, 'error'); }
            finally { setBusy(btn, false); }
            return;
        }
        if (e.target.closest('[data-act="undo"]')) {
            const tx = rows.find(t => t.id === opened);
            if (!tx || !await confirmDialog('Повернути у «Вхідні»?', tx.kind === 'payment'
                ? 'Оплату буде прибрано з історії квартири, операція знову чекатиме рішення.' : 'Категорію буде знято.', 'Повернути')) return;
            try { await act({ action: 'unassign', txId: tx.id }); toast('Повернуто у «Вхідні»', 'success'); }
            catch (err) { toast(err.message, 'error'); }
            return;
        }
        const row = e.target.closest('.tx-row');
        if (row) { opened = opened === row.dataset.id ? null : row.dataset.id; renderTable(); }
    });
    host.addEventListener('keydown', e => {
        const row = e.target.closest('.tx-row');
        if (row && e.key === 'Enter') { opened = opened === row.dataset.id ? null : row.dataset.id; renderTable(); }
    });
}

// ------------------------------------------------------------
// НАЛАШТУВАННЯ
// ------------------------------------------------------------
const RULES = [
    ['Рознесення оплат мешканців', 'Система сама; сумнівні — бухгалтер', 'ст. 9 Закону № 996-XIV'],
    ['Інші надходження (оренда, відсотки, гранти)', 'Бухгалтер', 'п. 133.4.2 ПКУ: облік за джерелами'],
    ['Платежі постачальникам', 'Бухгалтер; підпис КЕП у Приват24 — голова', 'п. 3.4.15 статуту: перший підпис — голова'],
    ['Договори', 'Голова (погодження правління)', 'п. 3.4.15 статуту'],
    ['Рахунки й акти за договором у межах суми', 'Бухгалтер', 'договір уже затвердив голова'],
    ['Витрати без договору чи понад договір', 'Голова (дрібні до порогу — бухгалтер)', 'рішення правління, жовтень 2026'],
    ['Договори понад 50 000 грн', 'Рішення загальних зборів', 'п. 3.4.15 статуту'],
    ['Податкова й фінансова звітність', 'Бухгалтер готує, КЕП — голова (і бухгалтер, якщо він відповідальний за облік у ДПС)', 'пп. 48.5.1 ПКУ']
];

/** Демо-прогін на тестовому акаунті: стан, кроки, кнопки (голова). */
function demoHtml(d, chair) {
    if (!d) return '';
    const done = d.status === 'done';
    if (!done && d.blockers?.length && d.status !== 'failed') return '';
    return `<section class="buh-card demo-card">
        <div class="buh-card-head"><h2>Демо-прогін</h2><span class="buh-tag ${done ? 'is-payment' : d.status === 'failed' ? 'is-error' : 'is-review'}">${done ? 'прогнано' : d.status === 'failed' ? 'збій' : 'тестовий акаунт'}</span></div>
        <p class="buh-note">${done ? 'Облік заповнено демо-даними через справжні функції системи. Подивіться «Вхідні», «Нарахування», «Витрати», «Кошторис», «Банк», а мешканцям — «Фінанси будинку».'
            : 'Проведе через справжні функції повний місяць: тарифи за складовими, вхідні залишки, нарахування за жовтень, виписку з оплатами мешканців, оренду й обладнання, постачальників і акти, кошторис 2026, звіт мешканцям. Цифри — у масштабі реального звіту ОСББ за 2026 рік. Уже внесені баланси квартир стануть вхідними залишками.'}</p>
        ${d.steps?.length ? `<ol class="buh-steps">${d.steps.map(s => `<li>${escapeHtml(s)}</li>`).join('')}</ol>` : ''}
        ${chair ? `<div class="inbox-actions">${done || d.status === 'failed' ? '<button type="button" class="btn-ghost-small" data-act="demo-remove">Прибрати демо</button>'
            : '<button type="button" class="btn-primary btn-compact" data-act="demo-run">Прогнати демо</button>'}</div>` : '<p class="buh-note">Прогнати й прибрати демо може голова.</p>'}
    </section>`;
}

export async function loadSettingsView() {
    const [settings, ex, demo] = await Promise.all([loadSettings(), loadExpenses().catch(() => null), loadDemo()]);
    const small = ex?.settings?.smallKop || 0;
    const chair = session.role === 'chair';
    const connected = settings.tokenSet === true;
    const last = settings.lastSync;
    const accounts = Object.entries(settings.accounts || {});
    document.getElementById('viewSettings').innerHTML = `${demoHtml(demo, chair)}
        <section class="buh-card">
            <div class="buh-card-head"><h2>ПриватБанк</h2><span class="buh-tag ${connected ? 'is-payment' : 'is-review'}">${connected ? `підключено · токен …${escapeHtml(settings.tokenHint || '')}` : 'не підключено'}</span></div>
            <p class="buh-note">${!connected ? 'Після підключення виписка й залишки завантажуватимуться щогодини.'
                : last?.ok === false ? `Остання спроба ${escapeHtml(when(last.at))}: ${escapeHtml(last.error || 'помилка')}`
                : last ? `Оновлено ${escapeHtml(when(last.at))}${last.added ? ` · нових операцій: ${last.added}` : ''}` : 'Перша виписка — протягом години.'}</p>
            <ol class="buh-steps">
                <li>Приват24 для бізнесу → «Інтеграція (Автоклієнт)» → «Підключити додаток» → тип «API», назва «Бухгалтерія ОСББ».</li>
                <li>Дозвольте виписки, залишки й створення платежів. Платіж із застосунку банк однаково проводить лише після підпису КЕП голови в Приват24.</li>
                <li>«API для розробників» → скопіюйте <b>token</b>. «Обмеження за IP-адресою» лишіть порожнім.</li>
            </ol>
            <div class="buh-inline-form">
                <input id="tokenInput" class="field-input" type="password" autocomplete="off" spellcheck="false" placeholder="${connected ? 'Новий токен, щоб замінити' : 'Вставте токен'}">
                <button type="button" class="btn-primary btn-compact" data-act="token-save">Перевірити й зберегти</button>
                ${connected ? '<button type="button" class="btn-ghost-small" data-act="token-remove">Відключити</button>' : ''}
            </div>
            <p class="buh-note">Токен зберігається лише на сервері — у браузері й базі його не видно.</p>
        </section>
        ${accounts.length ? `<section class="buh-card">
            <div class="buh-card-head"><h2>Рахунки</h2></div>
            <table class="buh-table"><tbody>${accounts.map(([iban, a]) => `<tr data-iban="${escapeHtml(iban)}">
                <td class="t-main"><b>${escapeHtml(iban)}</b><small>${escapeHtml(a.name || '')}</small></td>
                <td><select class="field-input field-select acc-purpose-select" aria-label="Призначення">${Object.entries(ACCOUNT_PURPOSES).map(([k, v]) =>
                    `<option value="${k}"${k === (a.purpose || 'current') ? ' selected' : ''}>${v}</option>`).join('')}</select></td>
                <td class="t-sum">${typeof a.balanceKop === 'number' ? money(a.balanceKop) : '—'}</td></tr>`).join('')}</tbody></table>
        </section>` : ''}
        <section class="buh-card">
            <div class="buh-card-head"><h2>Хто що підтверджує</h2></div>
            <table class="buh-table"><thead><tr><th>Операція</th><th>Підтверджує</th><th>Підстава</th></tr></thead>
            <tbody>${RULES.map(([op, who, why]) => `<tr><td>${escapeHtml(op)}</td><td>${escapeHtml(who)}</td><td class="t-muted">${escapeHtml(why)}</td></tr>`).join('')}</tbody></table>
            <div class="buh-inline-form ex-small">
                <span>Витрати без договору до</span>
                <input id="smallInput" class="field-input" inputmode="decimal" value="${(small / 100).toFixed(2).replace('.', ',')}"${chair ? '' : ' disabled'} aria-label="Поріг, грн">
                <span>грн затверджує бухгалтер</span>
                ${chair ? '<button type="button" class="btn-soft btn-compact" data-act="small-save">Зберегти</button>' : '<span class="t-muted">змінює голова</span>'}
            </div>
            <p class="buh-note">Облік у застосунку ведеться з ${escapeHtml(settings.startDate || '2026-10-01')}: раніші операції лише показуються.</p>
        </section>`;
}

export function initSettingsView() {
    const host = document.getElementById('viewSettings');
    host.addEventListener('click', async e => {
        const btn = e.target.closest('[data-act]');
        if (!btn) return;
        if (btn.dataset.act === 'token-save') {
            const token = document.getElementById('tokenInput').value.trim();
            if (!token) { toast('Вставте токен', 'error'); return; }
            setBusy(btn, true, 'Перевіряю в банку…');
            try { const r = await act({ action: 'saveToken', token }, 60000); toast(`Підключено. Рахунків: ${r?.accounts ?? 0}`, 'success'); }
            catch (err) { toast(err.message, 'error'); }
            finally { setBusy(btn, false); }
        }
        if (btn.dataset.act === 'demo-run') {
            if (!await confirmDialog('Прогнати демо?', 'Система проведе через справжні функції повний місяць обліку: тарифи, залишки, нарахування, виписку, постачальників, акти, кошторис і звіт мешканцям. Лише для тестового акаунта; потім усе можна прибрати.', 'Прогнати')) return;
            setBusy(btn, true, 'Проганяю… до хвилини');
            try { const r = await demoAct('run'); toast(`Готово: ${r.steps.length} кроків. Подивіться «Вхідні», «Нарахування», «Витрати», «Кошторис»`, 'success'); }
            catch (err) { toast(err.message, 'error'); }
            finally { setBusy(btn, false); }
        }
        if (btn.dataset.act === 'demo-remove') {
            if (!await confirmDialog('Прибрати демо?', 'Демо-операції, нарахування, документи й кошторис буде видалено, площі й баланси квартир повернуто як було. Журнал дій лишиться.', 'Прибрати')) return;
            setBusy(btn, true, 'Прибираю…');
            try { await demoAct('remove'); toast('Демо прибрано', 'success'); }
            catch (err) { toast(err.message, 'error'); }
            finally { setBusy(btn, false); }
        }
        if (btn.dataset.act === 'small-save') {
            const kop = toKop(document.getElementById('smallInput').value);
            if (kop === null || kop < 0) { toast('Вкажіть суму в гривнях', 'error'); return; }
            try { await expAct({ action: 'settings', smallKop: kop }); toast('Поріг збережено', 'success'); }
            catch (err) { toast(err.message, 'error'); }
        }
        if (btn.dataset.act === 'token-remove') {
            if (!await confirmDialog('Відключити банк?', 'Токен буде видалено з сервера. Завантажені операції лишаться.', 'Відключити')) return;
            try { await act({ action: 'removeToken' }); toast('Банк відключено', 'success'); }
            catch (err) { toast(err.message, 'error'); }
        }
    });
    host.addEventListener('change', async e => {
        const select = e.target.closest('.acc-purpose-select');
        if (!select) return;
        try { await act({ action: 'setAccount', iban: select.closest('[data-iban]').dataset.iban, purpose: select.value }); toast('Збережено', 'success'); }
        catch (err) { toast(err.message, 'error'); }
    });
}
