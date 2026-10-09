// ============================================================
// Панель правління (admin.html): окрема точка входу, тож мешканець
// не вантажить ні розмітку, ні код правління. Вхід — у кабінеті
// мешканця (index.html); сюди потрапляє лише людина з роллю.
// ============================================================
import { auth, session, currentApt, resetSession } from './firebase.js';
import { onAuthStateChanged, signOut } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js';
import { toast, showScreen, currentScreen, initSheets, closeAllSheets } from './ui.js';
import { initAttachmentViewers } from './attachments.js';
import { initOwners } from './owners.js';
import { initPowerToggle, startPowerListener, stopPowerListener } from './power.js';
import { initPowerStats } from './power-stats.js';
import { initChat, loadChat, stopChat, refreshChatBadge } from './chat.js';
import { initMessages } from './messages.js';
import { initMessagesAdmin, loadAdminHistory } from './messages-admin.js';
import { initRequestsAdmin, loadAdminRequests, populateDocsDropdown } from './requests-admin.js';
import { initContactsAdmin, loadAdminBoard, loadAdminServices } from './contacts-admin.js';
import { initPollsAdmin, loadAdminPolls } from './polls-admin.js';
import { initDtek, loadDtekSettings } from './dtek.js';
import { initFinanceAdmin, loadAdminExpenses, loadAdminRequisites } from './finance-admin.js';
import { initLedger } from './ledger.js';
import { registerServiceWorker } from './install.js';
import { initPullToRefresh } from './pull-refresh.js';
import { ROLE_LABELS, TAB_RIGHTS, hasRight } from './staff-core.js';
import { buildShell, markActive, renderAccount, initSections, initShell } from './admin-shell.js';
import { loadProfile, loadResiliently, initAppShell, sessionExpired, rememberWorkMode } from './app-common.js';

const toResident = () => location.replace('index.html');

const loadedAdminTabs = new Set();
const loadingAdminTabs = new Map();
let activeAdminTab = 'overview';
const adminFeaturePromises = new Map();
const featureImports = {
    dashboard: () => import('./dashboard.js'), meetings: () => import('./meetings.js'),
    directory: () => import('./directory.js'), importer: () => import('./import-owners.js'),
    exporter: () => import('./export-base.js'), verify: () => import('./verify.js'),
    documents: () => import('./admin-documents.js'), meters: () => import('./meters.js'),
    apartmentMeters: () => import('./apartment-meters.js'), team: () => import('./admin-team.js'),
    bank: () => import('./bank-admin.js')
};
const featureGroups = { overview: ['dashboard'], meetings: ['meetings', 'documents'],
    directory: ['directory', 'importer', 'exporter', 'verify', 'documents'], finance: ['documents', 'bank'],
    meters: ['meters', 'apartmentMeters'], team: ['team'], journal: ['team'] };
async function ensureAdminFeatures(group) {
    const modules = await Promise.all(featureGroups[group].map(name => {
        if (!adminFeaturePromises.has(name)) adminFeaturePromises.set(name, featureImports[name]().then(features => {
            for (const init of ['initDirectory', 'initImportOwners', 'initExportBase', 'initMeetings', 'initVerify',
                'initAdminDocuments', 'initMeters', 'initApartmentMeters', 'initTeam', 'initBank']) features[init]?.();
            if (name === 'meetings') initMeetingWorkspace();
            return features;
        }).catch(error => { adminFeaturePromises.delete(name); throw error; }));
        return adminFeaturePromises.get(name);
    }));
    return Object.assign({}, ...modules);
}

const ADMIN_TAB_LOADERS = {
    overview: async () => {
        const features = await ensureAdminFeatures('overview');
        return Promise.all([features.loadDashboard(), loadDtekSettings()]);
    },
    meetings: async () => {
        const features = await ensureAdminFeatures('meetings');
        return Promise.all([features.loadMeetings(), features.loadProtocols()]);
    },
    directory: async () => {
        const features = await ensureAdminFeatures('directory');
        return Promise.all([features.loadDirectory(), features.loadVerifyQueue()]);
    },
    send: () => Promise.all([loadAdminHistory(), populateDocsDropdown()]),
    requests: loadAdminRequests,
    docs: populateDocsDropdown,
    polls: loadAdminPolls,
    finance: async () => {
        const features = await ensureAdminFeatures('finance');
        return Promise.all([loadAdminExpenses(), loadAdminRequisites(), features.loadBank()]);
    },
    meters: async () => { const features = await ensureAdminFeatures('meters'); return Promise.all([features.loadAdminMeters(), features.loadApartmentSubmissions()]); },
    board: () => Promise.all([loadAdminBoard(), loadAdminServices()]),
    team: async () => (await ensureAdminFeatures('team')).loadTeam(),
    journal: async () => (await ensureAdminFeatures('journal')).loadJournal(),
    chat: loadChat
};

async function loadAdminTab(name = activeAdminTab, force = false) {
    const loader = ADMIN_TAB_LOADERS[name];
    if (!loader || (!force && loadedAdminTabs.has(name))) return;
    if (loadingAdminTabs.has(name)) return loadingAdminTabs.get(name);
    const task = Promise.resolve().then(() => loadResiliently(loader, 'adminDashboardSection')).then(() => loadedAdminTabs.add(name));
    loadingAdminTabs.set(name, task);
    try {
        await task;
    } finally {
        loadingAdminTabs.delete(name);
    }
}

// ------------------------------------------------------------
// ВХІД У ПАНЕЛЬ
// ------------------------------------------------------------
async function openPanel(apt) {
    const { apartment } = await loadProfile(apt);
    // Без ролі чи з непідтвердженим паролем — у кабінет мешканця:
    // там і вхід, і зміна пароля.
    if (!session.role || (apartment && !apartment.passwordChanged)) { toResident(); return; }
    session.isAdmin = true;
    if (!session.serviceAccount) rememberWorkMode('staff');
    startPowerListener();
    renderStaffHeader();
    showScreen('adminDashboardSection');
    await loadAdminTab('overview');
    refreshChatBadge();            // чат за вкладкою — потрібен лічильник непрочитаного
}

/** Хто увійшов і що йому доступно — у шапці й меню панелі. */
function renderStaffHeader() {
    const name = session.staffName || (session.serviceAccount ? 'Правління ОСББ' : `Квартира ${session.apt}`);
    renderAccount({ name, role: ROLE_LABELS[session.role] || '', home: !session.serviceAccount });
    document.querySelectorAll('.admin-tab').forEach(tab => {
        tab.hidden = !hasRight(session.role, TAB_RIGHTS[tab.dataset.tab] || 'staff');
    });
    buildShell(session.role);
    markActive(activeAdminTab);
}

onAuthStateChanged(auth, async (user) => {
    if (!user) { resetSession(); stopPowerListener(); stopChat(); toResident(); return; }
    if (sessionExpired()) { await signOut(auth); return; }
    try {
        await loadResiliently(() => openPanel(currentApt()), null);
    } catch (e) {
        console.error('Завантаження панелі:', e);
        toast('Не вдалося завантажити панель', 'error');
        showScreen('adminDashboardSection');
    }
});

// ------------------------------------------------------------
// ОНОВЛЕННЯ ЖЕСТОМ
// ------------------------------------------------------------
const SCREEN_RELOADERS = {
    adminDashboardSection: () => loadAdminTab(activeAdminTab, true),
    chatSection: loadChat
};

async function refreshCurrentScreen() {
    if (!auth.currentUser) return;
    const reloader = SCREEN_RELOADERS[currentScreen()];
    if (!reloader) return;
    try { await loadResiliently(reloader); }
    catch (e) { console.error('Оновлення екрана:', e); toast('Не вдалося оновити', 'error'); }
}

// ------------------------------------------------------------
// ВКЛАДКИ
// ------------------------------------------------------------
function initAdminTabs() {
    const today = document.getElementById('adminToday');
    if (today) today.textContent = new Date().toLocaleDateString('uk-UA', {
        day: 'numeric', month: 'long', year: 'numeric', weekday: 'short'
    });
    document.querySelectorAll('.admin-tab').forEach(tab => {
        tab.addEventListener('click', async () => {
            // Чат — окремий екран, а не картка в панелі: у картці
            // повідомлення тіснилися, а прокрутка всередині прокрутки
            // збивала сторінку вище й нижче потрібного.
            if (tab.dataset.tab === 'chat') {
                showScreen('chatSection');
                activeAdminTab = 'chat';
                await loadAdminTab('chat', true);
                return;
            }
            activeAdminTab = tab.dataset.tab;
            markActive(activeAdminTab);
            window.scrollTo({ top: 0 });
            try {
                await loadAdminTab(activeAdminTab);
            } catch (error) {
                console.error(`Завантаження вкладки ${activeAdminTab}:`, error);
                toast('Не вдалося завантажити вкладку', 'error');
            }
        });
    });
    document.getElementById('refreshHistoryBtn')?.addEventListener('click', () => loadAdminTab('send', true));
}

// Усередині найскладнішого розділу показуємо один робочий контекст
// за раз. Правління зазвичай продовжує активні збори, тому форма
// створення більше не перекриває результати й протоколи на вході.
function initMeetingWorkspace() {
    const panel = document.querySelector('.admin-panel[data-panel="meetings"]');
    if (!panel) return;

    const tabs = [...panel.querySelectorAll('[data-meeting-view]')];
    const views = [...panel.querySelectorAll('[data-meeting-panel]')];

    const show = (name, focus = false) => {
        views.forEach(view => { view.hidden = view.dataset.meetingPanel !== name; });
        tabs.forEach(tab => {
            const active = tab.dataset.meetingView === name;
            tab.classList.toggle('active', active);
            if (tab.getAttribute('role') === 'tab') {
                tab.setAttribute('aria-selected', active ? 'true' : 'false');
                tab.tabIndex = active ? 0 : -1;
            }
        });
        if (focus) {
            const target = panel.querySelector(`[data-meeting-panel="${name}"]`);
            target?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
    };

    tabs.forEach(tab => tab.addEventListener('click', () => show(tab.dataset.meetingView, true)));
    const tablist = panel.querySelector('[role="tablist"]');
    tablist?.addEventListener('keydown', event => {
        const keys = ['ArrowLeft', 'ArrowRight', 'Home', 'End'];
        if (!keys.includes(event.key)) return;
        const meetingTabs = [...tablist.querySelectorAll('[role="tab"]')];
        const current = meetingTabs.indexOf(document.activeElement);
        if (current < 0) return;
        event.preventDefault();
        let next = event.key === 'Home' ? 0 : event.key === 'End' ? meetingTabs.length - 1
            : (current + (event.key === 'ArrowRight' ? 1 : -1) + meetingTabs.length) % meetingTabs.length;
        meetingTabs[next].click();
        meetingTabs[next].focus();
    });
    show('active');
}

function init() {
    initAppShell();
    initSheets();
    initAttachmentViewers();
    initOwners();
    initPowerToggle();
    initPowerStats();
    initChat();
    initMessages();
    initMessagesAdmin();
    initRequestsAdmin();
    initContactsAdmin();
    initPollsAdmin();
    initDtek();
    initFinanceAdmin();
    initLedger();
    initShell();
    initSections();
    initAdminTabs();
    initPullToRefresh(refreshCurrentScreen);
    registerServiceWorker();

    // Член правління повертається до власного кабінету без перевходу.
    const toHome = () => {
        rememberWorkMode('home');
        location.assign('index.html');
    };
    const logout = async () => {
        localStorage.removeItem('session_timestamp');
        await signOut(auth);
    };
    document.getElementById('adminHomeBtn').addEventListener('click', toHome);
    document.getElementById('adminMoreHomeBtn').addEventListener('click', toHome);
    document.getElementById('adminLogoutBtn').addEventListener('click', logout);
    document.getElementById('adminMoreLogoutBtn').addEventListener('click', logout);
    document.getElementById('backFromChatBtn')?.addEventListener('click', () => {
        stopChat();
        closeAllSheets();
        showScreen('adminDashboardSection');
    });
}

init();
