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
import { loadToday, todayTitle } from './buh-today.js';
import { initMonthView, loadMonthView } from './buh-month.js';
import { initFlatsView, loadFlatsView } from './buh-flats.js';
import { initBankView, loadBankView, initSettingsView, loadSettingsView } from './buh-bank.js';
import { initPaymentsView, loadPaymentsView } from './buh-payments.js';
import { initChargesView, loadChargesView } from './buh-charges.js';
import { initExpensesView, loadExpensesView } from './buh-expenses.js';
import { initBudgetView, loadBudgetView } from './buh-budget.js';
import { initJournalView, loadJournalView } from './buh-journal.js';
import { initPayrollView, loadPayrollView } from './buh-payroll.js';
import { initReportsView, loadReportsView } from './buh-reports.js';

const VIEWS = {
    today: { title: () => todayTitle().title, sub: () => todayTitle().sub, load: loadToday },
    month: { title: 'Місяць', sub: 'Закриття крок за кроком: нарахування, банк, документи, зарплата, перевірка', load: loadMonthView },
    inbox: { title: 'Рішення', sub: 'Система пропонує — ви підтверджуєте', load: loadInbox },
    bank: { title: 'Банк', sub: 'Рахунки й операції ПриватБанку', load: loadBankView },
    payments: { title: 'Платежі', sub: 'Система готує — ви підтверджуєте, голова підписує в Приват24', load: loadPaymentsView },
    flats: { title: 'Квартири', sub: 'Борги й переплати, історія квартири, довідка й акт звірки', load: loadFlatsView },
    charges: { title: 'Нарахування', sub: 'Внески співвласників: тарифи, відомість за місяць, вхідні залишки', load: loadChargesView },
    expenses: { title: 'Документи', sub: 'Рахунки й акти, договори, постачальники', load: loadExpensesView },
    payroll: { title: 'Зарплата', sub: 'Табель, утримання, ЄСВ і виплати — голова затверджує й підписує', load: loadPayrollView },
    reports: { title: 'Звіти', sub: 'Строки ДПС, файли для Електронного кабінету, квитанції', load: loadReportsView },
    budget: { title: 'Кошторис', sub: 'План на рік, виконання й звіт для мешканців', load: loadBudgetView },
    journal: { title: 'Проводки', sub: 'Оборотно-сальдова відомість і закриття місяця', load: loadJournalView },
    settings: { title: 'Налаштування', sub: 'Підключення банку й правила погодження', load: loadSettingsView }
};
// Старі посилання (#overview) ведуть на «Сьогодні».
const ALIASES = { overview: 'today' };
const textOf = v => (typeof v === 'function' ? v() : v);
let view = 'today';

const toResident = () => location.replace('index.html');

// ------------------------------------------------------------
// РОЗДІЛИ
// ------------------------------------------------------------
async function show(name, { push = true, refresh = false } = {}) {
    name = ALIASES[name] || name;
    if (!VIEWS[name]) name = 'today';
    view = name;
    document.querySelectorAll('.buh-view').forEach(v => { v.hidden = v.dataset.view !== name; });
    document.querySelectorAll('[data-view]').forEach(b => {
        if (b.matches('.buh-nav-item, .buh-tab')) b.classList.toggle('active', b.dataset.view === name);
    });
    const title = textOf(VIEWS[name].title);
    document.getElementById('buhTitle').textContent = title;
    document.getElementById('buhSubtitle').textContent = textOf(VIEWS[name].sub);
    document.title = `${name === 'today' ? 'Сьогодні' : title} — Бухгалтерія`;
    // Активна вкладка видна й на вузькому екрані, де стрічка вкладок прокручується.
    document.querySelector(`.buh-nav .buh-nav-item[data-view="${name}"]`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    // Кожен перехід — запис в історії: «Назад» у браузері веде на попередній розділ.
    if (push && location.hash !== `#${name}`) history.pushState(null, '', `#${name}`);
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
    if (view !== 'inbox' && view !== 'today') await loadInbox().catch(() => {});
}

// ------------------------------------------------------------
// ВХІД
// ------------------------------------------------------------
/** Іконки меню — лінійні, в одному стилі з нижньою панеллю. */
const ICON = {
    flats: '<path d="M4 20V9l8-5 8 5v11"/><path d="M9 20v-6h6v6"/>',
    expenses: '<path d="M7 3h7l5 5v13H7z"/><path d="M14 3v5h5M10 13h6M10 17h6"/>',
    payroll: '<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 4-6 8-6s8 2 8 6"/>',
    reports: '<path d="M5 3h14v18H5z"/><path d="M9 8h6M9 12h6M9 16h3"/>',
    inbox: '<path d="M4 13l3-8h10l3 8v6H4z"/><path d="M4 13h5l1 2h4l1-2h5"/>',
    charges: '<path d="M12 3v18M17 7H9.5a3 3 0 0 0 0 6h5a3 3 0 0 1 0 6H6"/>',
    budget: '<path d="M4 20V10M10 20V4M16 20v-8M22 20H2"/>',
    journal: '<path d="M4 4h16v16H4z"/><path d="M4 10h16M10 4v16"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
    board: '<path d="M3 21h18M5 21V8l7-5 7 5v13"/><path d="M9 21v-4h6v4"/>',
    home: '<path d="M3 11l9-7 9 7"/><path d="M5 10v10h14V10"/>',
    finance: '<path d="M3 3v18h18"/><path d="M7 15l4-4 3 3 5-6"/>',
    logout: '<path d="M15 4h4v16h-4M10 8l-4 4 4 4M6 12h11"/>'
};
const icon = k => `<svg class="mn-ico-svg" viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[k] || ''}</svg>`;

function renderAccount(apartment) {
    const name = session.staffName || (session.serviceAccount ? 'Бухгалтер' : `Квартира ${session.apt}`);
    const initial = name.trim().charAt(0).toUpperCase() || 'Б';
    document.getElementById('buhAccountBtn').textContent = initial;
    // Плитки основних розділів — лише на телефоні (на компʼютері вони вгорі).
    const tile = (v, t, sub) => `<button class="mn-tile buh-nav-item" data-view="${v}" type="button"><span class="mn-ico">${icon(v)}</span><b>${t}</b><small>${sub}</small></button>`;
    // Рядок меню: іконка, назва, підпис, стрілка; бейдж — для «Рішень».
    const row = (attrs, ico, t, sub, extra = '') => `<${attrs.startsWith('href') ? 'a' : 'button type="button"'} class="mn-row${attrs.startsWith('href') ? '' : ' buh-nav-item'}" ${attrs}>
        <span class="mn-ico">${icon(ico)}</span><span class="mn-copy"><b>${t}</b><small>${sub}</small></span>${extra}<span class="mn-chev" aria-hidden="true">›</span></${attrs.startsWith('href') ? 'a' : 'button'}>`;
    const links = [];
    if (hasRight(session.role, 'manage')) links.push(row('href="admin.html" data-mode="staff"', 'board', 'Панель правління', 'збори, мешканці, звернення'));
    if (!session.serviceAccount && apartment) links.push(row('href="index.html" data-mode="home"', 'home', 'Мій кабінет', `квартира ${escapeHtml(String(session.apt))}`));
    document.getElementById('buhMoreBody').innerHTML = `
        <section class="mn-profile">
            <span class="mn-avatar">${escapeHtml(initial)}</span>
            <span class="mn-copy"><b>${escapeHtml(name)}</b><small>${escapeHtml(ROLE_LABELS[session.role] || '')}</small></span>
            <button type="button" class="mn-logout" data-act="logout">${icon('logout')}<span>Вийти</span></button>
        </section>
        <nav class="mn-tiles" aria-label="Розділи">
            ${tile('flats', 'Квартири', 'борги й історія')}${tile('expenses', 'Документи', 'рахунки й акти')}
            ${tile('payroll', 'Зарплата', 'відомість')}${tile('reports', 'Звіти', 'строки ДПС')}
        </nav>
        <h5 class="mn-h">Облік</h5>
        <nav class="mn-group" aria-label="Облік">
            ${row('data-view="inbox"', 'inbox', 'Рішення', 'усе, що чекає вас, — по черзі', '<span class="mn-badge" id="buhInboxBadgeMenu" hidden></span>')}
            ${row('data-view="charges"', 'charges', 'Нарахування й тарифи', 'внески за місяць, вхідні залишки')}
            ${row('data-view="budget"', 'budget', 'Кошторис', 'план і виконання за рік')}
            ${row('data-view="journal"', 'journal', 'Проводки й ОСВ', 'журнал, закриття місяця')}
        </nav>
        <h5 class="mn-h">Налаштування й переходи</h5>
        <nav class="mn-group" aria-label="Налаштування й переходи">
            ${row('data-view="settings"', 'settings', 'Налаштування', 'банк, реквізити, правила, демо')}
            ${links.join('')}
            ${row('href="admin.html?tab=finance"', 'finance', 'Фінанси: попередні розділи', 'старий вигляд у панелі правління')}
        </nav>`;
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
    await show(VIEWS[ALIASES[wanted] || wanted] ? wanted : 'today', { push: false });
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
    initPayrollView();
    initReportsView();
    initSettingsView();
    initMonthView();
    initFlatsView();
    registerServiceWorker();

    document.addEventListener('click', async e => {
        // Навігація — пункти меню, вкладки й посилання data-go всередині розділів.
        const nav = e.target.closest('.buh-nav-item[data-view], .buh-tab[data-view], [data-go]');
        if (nav) {
            const name = nav.dataset.go || nav.dataset.view;
            if (name === 'more') { openSheet('buhMoreSheet'); return; }
            if (VIEWS[ALIASES[name] || name]) { e.preventDefault(); closeAllSheets(); show(name); return; }
        }
        const mode = e.target.closest('[data-mode]')?.dataset.mode;
        if (mode) rememberWorkMode(mode);
        if (e.target.closest('[data-act="logout"]')) {
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
    // «Назад» до першого екрана повертає адресу без розділу — це «Сьогодні».
    window.addEventListener('hashchange', () => { const name = ALIASES[location.hash.slice(1)] || location.hash.slice(1) || 'today'; if (VIEWS[name] && name !== view) show(name, { push: false }); });
}

init();
