// ============================================================
// «Банк» (рахунки й операції за днями) і «Налаштування» (підключення
// ПриватБанку, призначення рахунків, правила погодження).
// Відбори, групування й рішення в один дотик — bank-view-core.js.
// ============================================================
import { escapeHtml, toast, setBusy, confirmDialog } from './ui.js';
import { session } from './firebase.js';
import {
    loadSettings, loadPage, loadQueue, loadPayments, loadExpenses, loadDemo, loadRequisites, demoAct, expAct, act, money, signed, when, dateOnly, tagOf, maskIban,
    ACCOUNT_PURPOSES, METHOD
} from './buh-data.js';
import { toKop } from './charges-core.js';
import { registryHtml, saveRegistry } from './buh-registry.js';
import { TABS, byDay, quickAssign, filterTx } from './bank-view-core.js';

let requisites = {};

let rows = [];
let queue = [];
let last = null;
let more = false;
let tab = 'all';
let query = '';
let opened = null;
const busy = new Set();

const opsWord = n => (n % 10 === 1 && n % 100 !== 11 ? 'операція' : [2, 3, 4].includes(n % 10) && ![12, 13, 14].includes(n % 100) ? 'операції' : 'операцій');
const timeOf = ts => (ts?.toDate ? ts.toDate() : new Date(ts)).toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit' });

function accountsHtml(settings) {
    const accounts = Object.entries(settings.accounts || {})
        .sort(([, a], [, b]) => ((a.purpose || 'current') === 'current' ? -1 : 0) - ((b.purpose || 'current') === 'current' ? -1 : 0));
    if (!accounts.length) return `<section class="bk-card bk-hero"><span class="bk-label">Банк не підключено</span>
        <button type="button" class="sv-btn" data-go="settings">Підключити ПриватБанк</button></section>`;
    const sync = settings.lastSync;
    const state = sync?.ok === false ? `<span class="bk-sync is-bad">Виписка не оновилась: ${escapeHtml(sync.error || 'помилка')}</span>`
        : sync ? `<span class="bk-sync is-good">Виписка оновлена о ${escapeHtml(timeOf(sync.at))}</span>` : '<span class="bk-sync">Виписку ще не отримано</span>';
    return accounts.map(([iban, a], i) => `<section class="bk-card ${i ? 'bk-acc' : 'bk-hero'}">
            <span class="bk-label">${escapeHtml(ACCOUNT_PURPOSES[a.purpose] || 'Рахунок')} · ПриватБанк</span>
            <b class="bk-balance">${typeof a.balanceKop === 'number' ? money(a.balanceKop) : '—'}</b>
            <span class="bk-iban">${escapeHtml(maskIban(iban))}${a.balanceAt ? ` · залишок на ${escapeHtml(when(a.balanceAt))}` : ''}</span>
            ${i ? '' : state}
        </section>`).join('');
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
    return `<div class="bk-detail"><dl class="dc-fields">${lines.map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd>`).join('')}</dl>
        <div class="bk-detail-actions">
            ${tx.status === 'review' ? '<button type="button" class="sv-btn" data-go="inbox">Розібрати в «Рішеннях»</button>' : ''}
            ${undo ? '<button type="button" class="sv-btn is-soft" data-act="undo">Повернути в «Рішення»</button>' : ''}
        </div></div>`;
}

function chipHtml(tx) {
    if (tx.status !== 'review') {
        const tag = tagOf(tx);
        return `<span class="bk-done">✓ ${escapeHtml(tag.text)}</span>`;
    }
    const q = quickAssign(tx);
    if (busy.has(tx.id)) return '<span class="bk-done">Зберігаю…</span>';
    if (q) return `<button type="button" class="bk-yes${q.sure ? '' : ' is-ask'}" data-act="quick">${q.sure ? `Так, кв. ${escapeHtml(q.apt)}` : `Це кв. ${escapeHtml(q.apt)}?`}</button>`;
    return '<button type="button" class="bk-yes is-ask" data-go="inbox">Розібрати ›</button>';
}

function rowHtml(tx) {
    const out = tx.direction === 'out';
    return `<div class="bk-row${opened === tx.id ? ' is-open' : ''}" data-id="${escapeHtml(tx.id)}" tabindex="0" role="button" aria-expanded="${opened === tx.id}">
            <span class="bk-ico${tx.status === 'review' ? ' is-wait' : ''}" aria-hidden="true">${out ? '↑' : '↓'}</span>
            <span class="bk-main"><b>${escapeHtml(tx.counterparty?.name || '—')}</b><small>${escapeHtml(tx.purpose || '')}</small></span>
            <span class="bk-right"><b class="bk-sum${out ? '' : ' is-in'}">${signed(tx)} грн</b>${chipHtml(tx)}</span>
        </div>${opened === tx.id ? detailHtml(tx) : ''}`;
}

function renderList() {
    const host = document.getElementById('bankList');
    if (!host) return;
    const source = tab === 'review' ? queue : rows;
    const list = filterTx(source, tab, query);
    document.getElementById('bankMore').hidden = !more || tab === 'review';
    host.innerHTML = list.length ? byDay(list).map(d => `<div class="bk-day">${escapeHtml(d.label)}</div>${d.rows.map(rowHtml).join('')}`).join('')
        : `<p class="py-empty">${query ? 'Нічого не знайдено' : tab === 'review' ? 'Усі операції розподілено' : 'Операцій ще немає'}</p>`;
}

export async function loadBankView() {
    const [settings, page, q, payments] = await Promise.all([loadSettings(), loadPage(), loadQueue().catch(() => []), loadPayments().catch(() => [])]);
    rows = page.rows; last = page.last; more = page.full;
    queue = q;   // уже від новіших
    const signing = payments.filter(p => p.status === 'sent');
    const host = document.getElementById('viewBank');
    host.innerHTML = `${signing.length ? `<div class="bk-links"><button type="button" class="bk-link" data-go="payments">Платежі на підписі голови · ${signing.length} ›</button></div>` : ''}
        <div class="bk-top">
            ${accountsHtml(settings)}
            ${queue.length ? `<button type="button" class="bk-card bk-need" data-go="inbox">
                <span class="bk-label">Потрібне ваше рішення</span>
                <b class="bk-balance">${queue.length} ${opsWord(queue.length)}</b>
                <span class="bk-need-go">Розподілити ›</span>
            </button>` : ''}
        </div>
        <section class="bk-card bk-ops">
            <div class="bk-ops-head">
                <h2>Операції</h2>
                <div class="bk-tabs" role="tablist">${Object.entries(TABS).map(([k, v]) =>
                    `<button type="button" class="bk-tab${k === tab ? ' active' : ''}" role="tab" aria-selected="${k === tab}" data-tab="${k}">${v}${k === 'review' && queue.length ? ` <span>${queue.length}</span>` : ''}</button>`).join('')}</div>
            </div>
            <label class="fl-search dc-search bk-search"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>
                <input type="search" id="bankQuery" placeholder="Квартира, платник, сума або призначення" value="${escapeHtml(query)}" aria-label="Пошук операції"></label>
            <div id="bankList"></div>
            <button type="button" id="bankMore" class="sv-btn is-soft is-wide" hidden>Показати ще</button>
        </section>`;
    renderList();
}

async function quick(tx, btn) {
    const q = quickAssign(tx);
    if (!q) return;
    if (!q.sure && !await confirmDialog(`Це оплата кв. ${q.apt}?`, `${tx.counterparty?.name || 'Платник'}: ${money(tx.amountKop)}. «${tx.purpose || ''}». Система не впевнена — перевірте призначення.`, `Так, кв. ${q.apt}`)) return;
    busy.add(tx.id);
    renderList();
    try {
        await act({ action: 'assign', txId: tx.id, allocations: [{ apt: q.apt, amountKop: tx.amountKop }], remember: q.sure });
        toast(`Рознесено: кв. ${q.apt}`, 'success');
    } catch (err) { toast(err.message, 'error'); }
    finally { busy.delete(tx.id); if (btn.isConnected) renderList(); }
}

export function initBankView() {
    const host = document.getElementById('viewBank');
    host.addEventListener('input', e => { if (e.target.id === 'bankQuery') { query = e.target.value; renderList(); } });
    host.addEventListener('click', async e => {
        const t = e.target.closest('[data-tab]');
        if (t) {
            tab = t.dataset.tab;
            host.querySelectorAll('[data-tab]').forEach(b => { b.classList.toggle('active', b === t); b.setAttribute('aria-selected', b === t); });
            renderList();
            return;
        }
        if (e.target.closest('#bankMore')) {
            const btn = e.target.closest('#bankMore');
            setBusy(btn, true);
            try { const page = await loadPage(last); rows = rows.concat(page.rows); last = page.last; more = page.full; renderList(); }
            catch (err) { toast(err.message, 'error'); }
            finally { setBusy(btn, false); }
            return;
        }
        const quickBtn = e.target.closest('[data-act="quick"]');
        if (quickBtn) {
            const id = quickBtn.closest('[data-id]').dataset.id;
            const tx = queue.find(x => x.id === id) || rows.find(x => x.id === id);
            if (tx) await quick(tx, quickBtn);
            return;
        }
        if (e.target.closest('[data-act="undo"]')) {
            const tx = rows.find(x => x.id === opened) || queue.find(x => x.id === opened);
            if (!tx || !await confirmDialog('Повернути в «Рішення»?', tx.kind === 'payment'
                ? 'Оплату буде прибрано з історії квартири, операція знову чекатиме рішення.' : 'Категорію буде знято.', 'Повернути')) return;
            try { await act({ action: 'unassign', txId: tx.id }); toast('Повернуто в «Рішення»', 'success'); }
            catch (err) { toast(err.message, 'error'); }
            return;
        }
        if (e.target.closest('[data-go]')) return;
        const row = e.target.closest('.bk-row');
        if (row) { opened = opened === row.dataset.id ? null : row.dataset.id; renderList(); }
    });
    host.addEventListener('keydown', e => {
        const row = e.target.closest('.bk-row');
        if (row && e.target === row && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); opened = opened === row.dataset.id ? null : row.dataset.id; renderList(); }
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
    // Голова завжди бачить картку й причину; іншим — лише коли демо можна дивитися.
    if (d.error) {
        return chair ? `<section class="buh-card demo-card">
            <div class="buh-card-head"><h2>Демо-прогін</h2><span class="buh-tag is-error">недоступне</span></div>
            <p class="buh-note">Сервер не відповів: ${escapeHtml(d.error)}. Найчастіше це означає, що функції ще не розгорнуто: <code>firebase deploy --only firestore:rules,firestore:indexes,functions</code>, потім оновіть сторінку.</p>
        </section>` : '';
    }
    const done = d.status === 'done';
    if (!done && d.blockers?.length && d.status !== 'failed') {
        return chair ? `<section class="buh-card demo-card">
            <div class="buh-card-head"><h2>Демо-прогін</h2><span class="buh-tag is-review">недоступне</span></div>
            <p class="buh-note">Демо проганяється лише на чистому обліку, щоб не зачепити справжні дані. Зараз заважає:</p>
            <ul class="jr-checks">${d.blockers.map(b => `<li class="is-block"><span aria-hidden="true">✕</span>${escapeHtml(b)}</li>`).join('')}</ul>
            <p class="buh-note">Якщо це тестовий акаунт і дані можна видалити — очистіть їх (або напишіть розробнику), тоді тут зʼявиться кнопка «Прогнати демо».</p>
        </section>` : '';
    }
    return `<section class="buh-card demo-card">
        <div class="buh-card-head"><h2>Демо-прогін</h2><span class="buh-tag ${done ? 'is-payment' : d.status === 'failed' ? 'is-error' : 'is-review'}">${done ? 'прогнано' : d.status === 'failed' ? 'збій' : 'тестовий акаунт'}</span></div>
        <p class="buh-note">${done ? 'Облік заповнено демо-даними через справжні функції системи. Подивіться «Вхідні», «Нарахування», «Витрати», «Кошторис», «Банк», а мешканцям — «Фінанси будинку».'
            : 'Проведе через справжні функції повний місяць: тарифи за складовими, вхідні залишки, нарахування за жовтень, виписку з оплатами мешканців, оренду й обладнання, постачальників і акти, кошторис 2026, звіт мешканцям. Цифри — у масштабі реального звіту ОСББ за 2026 рік. Уже внесені баланси квартир стануть вхідними залишками.'}</p>
        ${d.status === 'failed' && d.lastError ? `<p class="buh-note is-error">Прогін зупинився: ${escapeHtml(d.lastError)}. «Прибрати демо» поверне облік як було.</p>` : ''}
        ${d.steps?.length ? `<ol class="buh-steps">${d.steps.map(s => `<li>${escapeHtml(s)}</li>`).join('')}</ol>` : ''}
        ${chair && !done && d.status !== 'failed' ? `<h3 class="ch-sub">Квартира-зразок (необовʼязково)</h3>
            <p class="buh-note">На ній демо прожене все: залишок за статтями, нарахування з розбивкою, оплату за особовим рахунком і її розподіл за статтями, ручне рознесення із запамʼятовуванням платника. Порожні поля — дані з довідника.</p>
            <div class="buh-inline-form ch-form demo-showcase">
                <input id="dmApt" class="field-input ch-narrow" placeholder="Квартира" aria-label="Квартира-зразок">
                <input id="dmArea" class="field-input ch-narrow" inputmode="decimal" placeholder="Площа, м²" aria-label="Площа">
                <input id="dmRes" class="field-input ch-narrow" inputmode="numeric" placeholder="Проживає" aria-label="Проживає">
                <input id="dmOpening" class="field-input ch-narrow" inputmode="decimal" placeholder="Залишок 30.09 (+ переплата)" aria-label="Залишок на 30.09.2026">
            </div>
            <textarea id="dmHistory" class="field-input ch-textarea" rows="4" spellcheck="false" placeholder="Історія з сервісу бухгалтера (CSV «кв;дата;тип;сума;примітка») — необовʼязково"></textarea>
            <label class="btn-ghost-small demo-file">Вибрати файл історії<input id="dmFile" type="file" accept=".csv,.txt" hidden></label>` : ''}
        ${chair ? `<div class="inbox-actions">${done || d.status === 'failed' ? '<button type="button" class="btn-ghost-small" data-act="demo-remove">Прибрати демо</button>'
            : '<button type="button" class="btn-primary btn-compact" data-act="demo-run">Прогнати демо</button>'}</div>` : '<p class="buh-note">Прогнати й прибрати демо може голова.</p>'}
    </section>`;
}

export async function loadSettingsView() {
    const [settings, ex, demo, req] = await Promise.all([loadSettings(), loadExpenses().catch(() => null), loadDemo(), loadRequisites().catch(() => ({}))]);
    requisites = req || {};
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
        ${registryHtml(requisites.registry, requisites.houseAddress)}
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
            const v = id => document.getElementById(id)?.value?.trim() || '';
            const opening = v('dmOpening') ? toKop(v('dmOpening')) : null;
            if (v('dmOpening') && opening === null) { toast('Залишок — сума в гривнях, напр. 5863,05', 'error'); return; }
            const showcase = v('dmApt') ? { apt: v('dmApt'), area: v('dmArea'), residents: v('dmRes'), openingKop: opening, history: v('dmHistory') } : null;
            setBusy(btn, true, 'Проганяю… до хвилини');
            try { const r = await demoAct('run', showcase ? { showcase } : {}); toast(`Готово: ${r.steps.length} кроків. Подивіться «Вхідні», «Нарахування», «Витрати», «Кошторис»`, 'success'); }
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
        if (btn.dataset.act === 'registry-save') { await saveRegistry(btn, requisites.registry); return; }
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
        if (e.target.id === 'dmFile') {
            const f = e.target.files?.[0];
            if (f) document.getElementById('dmHistory').value = await f.text();
            return;
        }
        const select = e.target.closest('.acc-purpose-select');
        if (!select) return;
        try { await act({ action: 'setAccount', iban: select.closest('[data-iban]').dataset.iban, purpose: select.value }); toast('Збережено', 'success'); }
        catch (err) { toast(err.message, 'error'); }
    });
}
