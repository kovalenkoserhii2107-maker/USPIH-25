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
import { initInbox, loadInbox, setInboxFilter, restoreCachedBadges } from './buh-inbox.js';
import { loadToday, todayTitle } from './buh-today.js';
import { initMonthView, loadMonthView } from './buh-month.js';
import { initFlatsView, loadFlatsView } from './buh-flats.js';
import { initBankView, loadBankView, hasBankReturnState, renderBankReturnBanner } from './buh-bank.js';
import { initSettingsView, loadSettingsView, setSettingsTab } from './buh-settings.js';
import { initPaymentsView, loadPaymentsView } from './buh-payments.js';
import { initChargesView, loadChargesView } from './buh-charges.js';
import { initExpensesView, loadExpensesView } from './buh-expenses.js';
import { initBudgetView, loadBudgetView } from './buh-budget.js';
import { initJournalView, loadJournalView } from './buh-journal.js';
import { initPayrollView, loadPayrollView } from './buh-payroll.js';
import { initReportsView, loadReportsView } from './buh-reports.js';
import { initAssetsView, loadAssetsView } from './buh-assets.js';
import { initAdvanceView, loadAdvanceView } from './buh-advance.js';
import { initClaimsView, loadClaimsView } from './buh-claims.js';

const VIEWS = {
    today: { title: () => todayTitle().title, sub: () => todayTitle().sub, load: loadToday },
    month: { title: 'Місяць', sub: 'Закриття крок за кроком: нарахування, банк, документи, зарплата, перевірка', load: loadMonthView },
    inbox: { title: 'Рішення', sub: 'Система пропонує — ви підтверджуєте', load: loadInbox },
    bank: { title: 'Банк', sub: 'Рахунки й операції ПриватБанку', load: loadBankView },
    payments: { title: 'Платежі', sub: 'Система готує — ви підтверджуєте, голова підписує в Приват24', load: loadPaymentsView },
    flats: { title: 'Квартири', sub: 'Борги й переплати, історія квартири, довідка й акт звірки', load: loadFlatsView },
    charges: { title: 'Нарахування', sub: 'Внески співвласників: розрахунок місяця, відомість і квитанції, тарифи, приміщення', load: loadChargesView },
    expenses: { title: 'Документи', sub: 'Рахунки й акти, договори, постачальники', load: loadExpensesView },
    payroll: { title: 'Зарплата', sub: 'Табель, утримання, ЄСВ і виплати — голова затверджує й підписує', load: loadPayrollView },
    reports: { title: 'Звіти', sub: 'Строки ДПС, файли для Електронного кабінету, квитанції', load: loadReportsView },
    budget: { title: 'Кошторис', sub: 'План на рік, виконання й звіт для мешканців', load: loadBudgetView },
    assets: { title: 'Майно та ТМЦ', sub: 'Основні засоби (10), МНМА (11), запаси (20), МШП (22) та амортизація за НП(С)БО 7 і 9', load: loadAssetsView },
    advance: { title: 'Авансові звіти', sub: 'Розрахунки з підзвітними особами (рах. 372): чеки, компенсація в Приват24', load: loadAdvanceView },
    claims: { title: 'Претензійна робота', sub: 'Боржники й справи: претензія, суд, виконання, реструктуризація', load: loadClaimsView },
    journal: { title: 'ОСВ', sub: 'Оборотно-сальдова відомість, проводки й закриття місяця', load: loadJournalView },
    settings: { title: 'Налаштування', sub: 'Готовність кабінету, реквізити, банк і сервіси, облік, правила, перехід на облік', load: loadSettingsView }
};
// Старі посилання (#overview) ведуть на «Сьогодні».
const ALIASES = { overview: 'today' };
const MENU_ONLY_VIEWS = new Set(['assets', 'advance', 'claims', 'budget', 'settings']);
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
    document.getElementById('buhAccountBtn')?.classList.toggle('active', MENU_ONLY_VIEWS.has(name));
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
    // Фонове оновлення після дії або повернення в Банк на збережену позицію не повинно кидати сторінку вгору.
    const restoringBank = name === 'bank' && hasBankReturnState();
    if (!refresh && !restoringBank) window.scrollTo({ top: 0 });
    renderBankReturnBanner(name);
    try {
        await loadResiliently(VIEWS[name].load);
        renderBankReturnBanner(name);
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
        chip.textContent = !last ? 'Виписка: оновити' : last.ok === false ? 'Виписка: помилка' : `Виписка · ${when(last.at)}`;
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
    assets: '<path d="M3 7l9-4 9 4-9 4-9-4z"/><path d="M3 7v10l9 4 9-4V7"/><path d="M12 11v10"/>',
    advance: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 10h18M7 15h4"/>',
    claims: '<path d="M12 3v18M5 7h14M7 7l-3 6h6l-3-6zM17 7l-3 6h6l-3-6z"/><path d="M8 21h8"/>',
    check: '<path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>',
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
    const avaEl = document.getElementById('buhAccountAva');
    if (avaEl) avaEl.textContent = initial;
    else document.getElementById('buhAccountBtn').textContent = initial;
    // Плитки основних розділів — лише на телефоні (на компʼютері вони вгорі).
    const tile = (v, t, sub) => `<button class="mn-tile buh-nav-item" data-view="${v}" type="button"><span class="mn-ico">${icon(v)}</span><b>${t}</b><small>${sub}</small></button>`;
    // Рядок меню: іконка, назва, підпис, стрілка; mobileOnly ховає на ПК розділи, які вже винесені у верхню панель.
    const row = (attrs, ico, t, sub, extra = '', mobileOnly = false) => `<${attrs.startsWith('href') ? 'a' : 'button type="button"'} class="mn-row${attrs.startsWith('href') ? '' : ' buh-nav-item'}${mobileOnly ? ' buh-more-mobile' : ''}" ${attrs}>
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
        <h5 class="mn-h">Річне планування та облік</h5>
        <nav class="mn-group" aria-label="Облік">
            ${row('data-view="inbox"', 'inbox', 'Рішення', 'усе, що чекає вас, — по черзі', '<span class="mn-badge" id="buhInboxBadgeMenu" hidden></span>', true)}
            ${row('data-view="charges"', 'charges', 'Нарахування й тарифи', 'внески за місяць, відомість, тарифи', '', true)}
            ${row('data-view="assets"', 'assets', 'Майно та ТМЦ', 'основні засоби (10), МНМА (11), запаси (20), МШП (22), амортизація')}
            ${row('data-view="advance"', 'advance', 'Авансові звіти (372)', 'підзвітні особи, витрати за чеками, виплата на картку')}
            ${row('data-view="claims"', 'claims', 'Претензійно-позовна робота', 'боржники, претензії, судові накази, позови, договори')}
            ${row('data-view="budget"', 'budget', 'Кошторис', 'план і виконання за рік, звіт для мешканців')}
            ${row('data-view="journal"', 'journal', 'Проводки й ОСВ', 'журнал, закриття місяця', '', true)}
        </nav>
        <h5 class="mn-h">Налаштування й переходи</h5>
        <nav class="mn-group" aria-label="Налаштування й переходи">
            ${row('data-view="settings"', 'settings', 'Налаштування', 'реквізити, банк, облік, правила, перехід на облік')}
            ${row('href="platform.html"', 'finance', 'Платформа ОСББ (Super-Admin)', 'усі ОСББ і бази, інспектор БД, тести, активність')}
            ${row('href="platform.html#bank"', 'finance', 'Симулятор Приват24 API', 'підпис КЕП платежів, вхідні операції, рахунки')}
            ${row('href="accounting-test.html"', 'check', 'Тестова бухгалтерія', 'окремий будинок, імітований банк, звірки')}
            ${links.join('')}
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
    await show(location.hash.replace('#', '') || 'today', { push: false });
    renderSync();
    refreshBadge();
    onChange(() => {
        show(view, { push: false, refresh: true });
        renderSync();
        refreshBadge();
    });
}

// ------------------------------------------------------------
// СТАРТ
// ------------------------------------------------------------
initSheets();
restoreCachedBadges();
initAppShell('Бухгалтерія');
initInbox(() => view === 'inbox');
initMonthView();
initFlatsView();
initBankView();
initPaymentsView();
initChargesView(() => view === 'charges');
initExpensesView();
initBudgetView();
initPayrollView();
initReportsView();
initAssetsView();
initAdvanceView();
initJournalView();
initClaimsView();
initSettingsView();

document.addEventListener('click', e => {
    const mode = e.target.closest('[data-mode]');
    if (mode) { rememberWorkMode(mode.dataset.mode); return; }
    // ВАЖЛИВО: шукаємо лише кнопки навігації (.buh-nav-item, .buh-tab),
    // а не контейнери <section class="buh-view" data-view="...">,
    // інакше будь-який клік усередині активного розділу викликав би show() і скидав екран угору!
    const nav = e.target.closest('.buh-nav-item[data-view], .buh-tab[data-view]');
    if (nav) {
        if (nav.dataset.view === 'more') { openSheet('buhMoreSheet'); return; }
        closeAllSheets();
        show(nav.dataset.view);
        return;
    }
    const go = e.target.closest('[data-go]');
    if (go) {
        const filter = go.dataset.inboxFilter || go.dataset.inboxGroup;
        if (filter) setInboxFilter(filter);
        if (go.dataset.settingsTab) setSettingsTab(go.dataset.settingsTab);
        closeAllSheets();
        show(go.dataset.go);
        return;
    }
    if (e.target.closest('#buhAccountBtn')) { openSheet('buhMoreSheet'); return; }
    if (e.target.closest('[data-act="logout"]')) { resetSession(); signOut(auth).then(toResident); }
});

document.getElementById('buhSyncChip').addEventListener('click', async e => {
    const btn = e.currentTarget;
    btn.disabled = true;
    btn.textContent = 'Синхронізую…';
    try {
        const r = await act({ action: 'sync' });
        toast(`Нових: ${r.imported}, рознесено: ${r.autoAssigned}, чекають: ${r.review}`, 'success');
    } catch (err) { toast(err.message, 'error'); }
    finally { btn.disabled = false; renderSync(); }
});

window.addEventListener('popstate', () => show(location.hash.replace('#', '') || 'today', { push: false }));

let activeUserKey = null;
onAuthStateChanged(auth, async user => {
    if (!user) { activeUserKey = null; resetSession(); toResident(); return; }
    if (await sessionExpired(user)) { activeUserKey = null; resetSession(); await signOut(auth); toResident(); return; }
    const apt = currentApt(user);
    if (!apt) { activeUserKey = null; resetSession(); toResident(); return; }
    const key = `${user.uid}:${apt}`;
    if (key === activeUserKey) return;
    activeUserKey = key;
    try { await openCabinet(apt); }
    catch (e) { activeUserKey = null; console.error('Вхід у бухгалтерію:', e); hideAppLoader(); toast('Помилка завантаження', 'error'); }
});

registerServiceWorker();
