// ============================================================
// Кабінет бухгалтера (buh.html): окрема сторінка й окремий код.
//
// Сюди потрапляють бухгалтер (службовим номером або квартирою з роллю
// «бухгалтер») і голова — для контролю й підтверджень. Член правління
// без фінансових прав іде в панель правління, мешканець — у кабінет.
// ============================================================
import { auth, session, currentApt, resetSession } from './firebase.js';
import { onAuthStateChanged, signOut } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js';
import { toast, initSheets, openSheet, closeAllSheets, hideAppLoader, escapeHtml } from './ui.js';
import { ROLE_LABELS, hasRight } from './staff-core.js';
import { loadProfile, loadResiliently, initAppShell, sessionExpired, rememberWorkMode } from './app-common.js';
import { registerServiceWorker } from './install.js';
import { onChange, act, loadSettings, when } from './buh-data.js';
import { initInbox, loadInbox } from './buh-inbox.js';
import { loadOverview } from './buh-overview.js';
import { initBankView, loadBankView, initSettingsView, loadSettingsView } from './buh-bank.js';
import { initPaymentsView, loadPaymentsView } from './buh-payments.js';
import { initChargesView, loadChargesView } from './buh-charges.js';
import { initExpensesView, loadExpensesView } from './buh-expenses.js';
import { initBudgetView, loadBudgetView } from './buh-budget.js';
import { initJournalView, loadJournalView } from './buh-journal.js';

const VIEWS = {
    overview: { title: 'Огляд', sub: 'Гроші ОСББ і що потребує уваги', load: loadOverview },
    inbox: { title: 'Вхідні', sub: 'Система пропонує — ви підтверджуєте', load: loadInbox },
    budget: { title: 'Кошторис', sub: 'План на рік, виконання й звіт для мешканців', load: loadBudgetView },
    journal: { title: 'Проводки', sub: 'Оборотно-сальдова відомість і закриття місяця', load: loadJournalView },
    expenses: { title: 'Витрати', sub: 'Рахунки й акти, договори, постачальники', load: loadExpensesView },
    charges: { title: 'Нарахування', sub: 'Внески співвласників: площа × тариф, баланс з історії', load: loadChargesView },
    payments: { title: 'Платежі', sub: 'Система готує — ви підтверджуєте, голова підписує в Приват24', load: loadPaymentsView },
    bank: { title: 'Банк', sub: 'Рахунки й операції ПриватБанку', load: loadBankView },
    settings: { title: 'Налаштування', sub: 'Підключення банку й правила погодження', load: loadSettingsView }
};
let view = 'overview';

const toResident = () => location.replace('index.html');

// ------------------------------------------------------------
// РОЗДІЛИ
// ------------------------------------------------------------
async function show(name, { push = true, refresh = false } = {}) {
    if (!VIEWS[name]) name = 'overview';
    view = name;
    document.querySelectorAll('.buh-view').forEach(v => { v.hidden = v.dataset.view !== name; });
    document.querySelectorAll('[data-view]').forEach(b => {
        if (b.matches('.buh-nav-item, .buh-tab')) b.classList.toggle('active', b.dataset.view === name);
    });
    document.getElementById('buhTitle').textContent = VIEWS[name].title;
    document.getElementById('buhSubtitle').textContent = VIEWS[name].sub;
    document.title = `${VIEWS[name].title} — Бухгалтерія`;
    if (push && location.hash !== `#${name}`) history.replaceState(null, '', `#${name}`);
    // Фокус на пункті меню перехоплював би Enter: «Так» у розділі
    // натискав би знову той самий пункт.
    if (document.activeElement?.closest?.('.buh-nav-item, .buh-tab, [data-go]')) document.activeElement.blur();
    // Фонове оновлення після дії не повинно кидати сторінку вгору.
    if (!refresh) window.scrollTo({ top: 0 });
    try {
        await loadResiliently(VIEWS[name].load);
    } catch (e) {
        console.error(`Розділ ${name}:`, e);
        toast('Не вдалося завантажити розділ', 'error');
    }
}

async function renderSync() {
    const chip = document.getElementById('buhSyncChip');
    try {
        const s = await loadSettings();
        const last = s.lastSync;
        chip.hidden = !s.tokenSet;
        chip.classList.toggle('is-error', last?.ok === false);
        chip.textContent = !last ? 'Банк: оновити' : last.ok === false ? 'Банк: помилка' : `Банк · ${when(last.at)}`;
    } catch { chip.hidden = true; }
}

/** Лічильник «Вхідних» потрібен на будь-якому розділі. */
async function refreshBadge() {
    if (view !== 'inbox') await loadInbox().catch(() => {});
}

// ------------------------------------------------------------
// ВХІД
// ------------------------------------------------------------
function renderAccount(apartment) {
    const name = session.staffName || (session.serviceAccount ? 'Бухгалтер' : `Квартира ${session.apt}`);
    const initial = name.trim().charAt(0).toUpperCase() || 'Б';
    document.getElementById('buhAccountName').textContent = name;
    document.getElementById('buhAccountRole').textContent = ROLE_LABELS[session.role] || '';
    document.getElementById('buhAvatar').textContent = initial;
    document.getElementById('buhAccountBtn').textContent = initial;
    const links = [];
    if (hasRight(session.role, 'manage')) links.push('<a class="buh-nav-item buh-link" href="admin.html" data-mode="staff">Панель правління</a>');
    if (!session.serviceAccount && apartment) links.push('<a class="buh-nav-item buh-link" href="index.html" data-mode="home">Мій кабінет</a>');
    document.getElementById('buhSwitch').innerHTML = links.join('');
    document.getElementById('buhMoreBody').innerHTML = `
        <div class="buh-more-account"><span class="buh-avatar">${escapeHtml(initial)}</span>
            <span><b>${escapeHtml(name)}</b><small>${escapeHtml(ROLE_LABELS[session.role] || '')}</small></span></div>
        <nav class="buh-more-nav">
            <button class="buh-nav-item" data-view="charges" type="button">Нарахування</button>
            <button class="buh-nav-item" data-view="expenses" type="button">Витрати</button>
            <button class="buh-nav-item" data-view="budget" type="button">Кошторис</button>
            <button class="buh-nav-item" data-view="journal" type="button">Проводки</button>
            <button class="buh-nav-item" data-view="settings" type="button">Налаштування</button>
            <a class="buh-nav-item buh-link" href="admin.html?tab=finance">Фінанси: попередні розділи</a>
            ${links.join('')}
        </nav>
        <button type="button" class="menu-logout" data-act="logout">Вийти</button>`;
}

async function openCabinet(apt) {
    const { apartment } = await loadProfile(apt);
    if (!session.role || (apartment && !apartment.passwordChanged)) { toResident(); return; }
    if (!hasRight(session.role, 'account')) { location.replace('admin.html'); return; }
    rememberWorkMode('buh');
    renderAccount(apartment);
    document.getElementById('buhApp').hidden = false;
    hideAppLoader();
    const wanted = location.hash.slice(1);
    await show(VIEWS[wanted] ? wanted : 'overview', { push: false });
    renderSync();
    refreshBadge();
}

onAuthStateChanged(auth, async user => {
    if (!user) { resetSession(); toResident(); return; }
    if (sessionExpired()) { await signOut(auth); return; }
    try {
        await loadResiliently(() => openCabinet(currentApt()), null);
    } catch (e) {
        console.error('Завантаження бухгалтерії:', e);
        toast('Не вдалося завантажити бухгалтерію', 'error');
        document.getElementById('buhApp').hidden = false;
        hideAppLoader();
    }
});

// ------------------------------------------------------------
// ПОДІЇ
// ------------------------------------------------------------
function init() {
    initAppShell();
    initSheets();
    initInbox(() => view === 'inbox');
    initBankView();
    initPaymentsView();
    initChargesView(() => view === 'charges');
    initExpensesView();
    initBudgetView();
    initJournalView();
    initSettingsView();
    registerServiceWorker();

    document.addEventListener('click', async e => {
        // Навігація — пункти меню, вкладки й посилання data-go всередині розділів.
        const nav = e.target.closest('.buh-nav-item[data-view], .buh-tab[data-view], [data-go]');
        if (nav) {
            const name = nav.dataset.go || nav.dataset.view;
            if (name === 'more') { openSheet('buhMoreSheet'); return; }
            if (VIEWS[name]) { e.preventDefault(); closeAllSheets(); show(name); return; }
        }
        const mode = e.target.closest('[data-mode]')?.dataset.mode;
        if (mode) rememberWorkMode(mode);
        if (e.target.closest('[data-act="logout"]') || e.target.closest('#buhLogoutBtn')) {
            localStorage.removeItem('session_timestamp');
            await signOut(auth);
        }
        if (e.target.closest('#buhAccountBtn')) openSheet('buhMoreSheet');
    });

    document.getElementById('buhSyncChip').addEventListener('click', async e => {
        const chip = e.currentTarget;
        chip.disabled = true;
        chip.textContent = 'Банк: оновлюю…';
        try {
            const r = await act({ action: 'sync' }, 120000);
            toast(r?.waiting ? 'Банк зараз оновлює дані — спробуйте за кілька хвилин' : r?.added ? `Нових операцій: ${r.added}` : 'Нових операцій немає', 'success');
        } catch (err) { toast(err.message, 'error'); }
        finally { chip.disabled = false; }
    });

    // Після будь-якої дії — перемальовуємо відкритий розділ і лічильники.
    onChange(() => {
        clearTimeout(init.timer);
        init.timer = setTimeout(() => {
            // «Вхідні» оновлюють себе самі після кожного рішення.
            if (view !== 'inbox') show(view, { push: false, refresh: true });
            renderSync();
            refreshBadge();
        }, 50);
    });
    window.addEventListener('hashchange', () => { const name = location.hash.slice(1); if (VIEWS[name] && name !== view) show(name, { push: false }); });
}

init();
