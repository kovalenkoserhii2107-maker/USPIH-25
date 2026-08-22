// ============================================================
// Точка входу: автентифікація, маршрутизація екранів, навігація.
// ============================================================
import { db, auth, session, currentApt, resetSession, aptToEmail } from './firebase.js';
import {
    doc, getDoc, setDoc, updateDoc
} from "https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js";
import {
    signInWithEmailAndPassword, onAuthStateChanged, signOut, updatePassword
} from "https://www.gstatic.com/firebasejs/10.8.1/firebase-auth.js";

import {
    toast, setBusy, showScreen, currentScreen, initSheets, toggleSheet, closeAllSheets
} from './ui.js';
import { initAttachmentViewers } from './attachments.js';
import { initOwners, loadOwners } from './owners.js';
import { initPowerToggle, startPowerListener, stopPowerListener } from './power.js';
import { initMessages, loadUserMessages, loadAdminHistory, backfillRecipients } from './messages.js';
import {
    initRequests, loadUserRequests, loadAdminRequests,
    loadOsbbDocs, populateDocsDropdown
} from './requests.js';
import {
    initContacts, loadBoardContacts, loadServices,
    loadAdminBoard, loadAdminServices
} from './contacts.js';
import { initPolls, loadUserPolls, loadAdminPolls, refreshPollsBadge } from './polls.js';
import { loadDashboard } from './dashboard.js';
import { initDirectory, loadDirectory } from './directory.js';
import {
    initFinance, initPayments, initAccounts, loadBalance, loadExpenses, loadReceipts,
    loadAdminExpenses, loadAdminRequisites
} from './finance.js';
import {
    registerServiceWorker, initInstallPrompt, showInstallHint, triggerInstall, canInstall
} from './install.js';
import { initPullToRefresh } from './pull-refresh.js';

const SESSION_TIMEOUT = 30 * 24 * 60 * 60 * 1000; // 30 днів

// ------------------------------------------------------------
// ВХІД
// ------------------------------------------------------------
async function handleLogin() {
    const btn = document.getElementById('loginBtn');
    const apt = document.getElementById('aptInput').value.trim();
    const pass = document.getElementById('passInput').value;
    const errorEl = document.getElementById('loginError');
    errorEl.style.display = 'none';

    if (!apt || !pass) {
        errorEl.textContent = 'Введіть номер квартири та пароль';
        errorEl.style.display = 'block';
        return;
    }

    setBusy(btn, true, 'Вхід…');
    try {
        await signInWithEmailAndPassword(auth, aptToEmail(apt), pass);
        localStorage.setItem('session_timestamp', Date.now());
    } catch (error) {
        console.error('Помилка входу:', error.code, error.message);
        // Розрізняємо причини, щоб не маскувати технічну проблему під "невірний пароль"
        const messages = {
            'auth/user-not-found': 'Такої квартири немає в системі. Зверніться до правління.',
            'auth/invalid-credential': 'Невірний номер квартири або пароль',
            'auth/wrong-password': 'Невірний пароль',
            'auth/invalid-email': 'Невірний номер квартири',
            'auth/too-many-requests': 'Забагато спроб. Спробуйте за кілька хвилин.',
            'auth/network-request-failed': 'Немає зв\'язку з сервером. Перевірте інтернет.'
        };
        errorEl.textContent = messages[error.code] || 'Не вдалося увійти. Спробуйте пізніше.';
        errorEl.style.display = 'block';
        setBusy(btn, false);
    }
}

// ------------------------------------------------------------
// ЗАВАНТАЖЕННЯ КАБІНЕТУ
// ------------------------------------------------------------
async function loadCabinet(apt) {
    const aptRef = doc(db, 'apartments', apt);
    const snap = await getDoc(aptRef);

    let firstLogin = true;
    if (snap.exists()) {
        const data = snap.data();
        firstLogin = !data.passwordChanged;
        session.apt = apt;
        session.area = data.area || '--';
        session.entrance = data.entrance || '--';
        session.isAdmin = data.isAdmin === true;
    } else {
        await setDoc(aptRef, { passwordChanged: false, area: '', entrance: '', isAdmin: false, lastLogin: new Date() });
        session.apt = apt;
        session.area = '--';
        session.entrance = '--';
        session.isAdmin = false;
    }

    if (firstLogin) {
        document.getElementById('hiddenAptInput').value = apt;
        document.getElementById('cancelPassBtn').hidden = true;
        showScreen('passwordSection');
        return;
    }

    startPowerListener();

    if (session.isAdmin) {
        showScreen('adminDashboardSection');
        document.getElementById('topNav').style.display = 'none';
        await Promise.all([loadAdminHistory(), loadAdminRequests(),
                           populateDocsDropdown(), loadAdminBoard(), loadAdminServices(), loadAdminPolls(),
                           loadAdminExpenses(), loadAdminRequisites(),
                           loadDirectory()]);
        // Дашборд рахує вже закриті прострочені опитування, тому — після них
        await loadDashboard();
        backfillRecipients(); // тиха міграція старих повідомлень
    } else {
        showScreen('dataSection');
        document.getElementById('topNav').style.display = 'block';
        document.getElementById('displayAptNum').textContent = apt;
        document.getElementById('displayEntranceNum').textContent = session.entrance;
        document.getElementById('displayAreaVal').textContent = session.area;
        await loadOwners(apt);
        await loadUserMessages(apt, session.entrance);
        await Promise.all([loadBalance(apt), loadExpenses()]);

        // Кнопку малює loadBalance, тож слухача вішаємо після нього
        document.getElementById('openReceiptsBtn')?.addEventListener('click', () => {
            showScreen('receiptsSection');
            document.getElementById('topNav').style.display = 'none';
            loadReceipts();
        });
        refreshPollsBadge();          // без await: значок не має затримувати кабінет
        showInstallHint();
    }
}

// ------------------------------------------------------------
// ОНОВЛЕННЯ ЖЕСТОМ
//
// Перезавантажувати сторінку не можна: мешканця викидало б на
// головний екран щоразу, коли він тягне вниз у зверненнях чи
// квитанціях. Тому оновлюємо дані того екрана, що відкритий.
// ------------------------------------------------------------
const SCREEN_RELOADERS = {
    dataSection: () => loadCabinet(session.apt),
    adminDashboardSection: () => loadCabinet(session.apt),
    docsSection: loadOsbbDocs,
    requestsSection: loadUserRequests,
    pollsSection: loadUserPolls,
    boardSection: loadBoardContacts,
    servicesSection: loadServices,
    receiptsSection: loadReceipts
};

async function refreshCurrentScreen() {
    if (!auth.currentUser) return;
    const reloader = SCREEN_RELOADERS[currentScreen()];
    // Невідомий екран — чесніше перезавантажити, ніж не зробити нічого
    if (!reloader) { location.reload(); return; }
    try {
        await reloader();
    } catch (e) {
        console.error('Оновлення екрана:', e);
        toast('Не вдалося оновити', 'error');
    }
}

// ------------------------------------------------------------
// СТАН АВТЕНТИФІКАЦІЇ
// ------------------------------------------------------------
onAuthStateChanged(auth, async (user) => {
    if (user) {
        const last = localStorage.getItem('session_timestamp');
        if (last && (Date.now() - parseInt(last, 10)) > SESSION_TIMEOUT) {
            localStorage.removeItem('session_timestamp');
            await signOut(auth);
            return;
        }
        localStorage.setItem('session_timestamp', Date.now());
        try {
            await loadCabinet(currentApt());
        } catch (e) {
            console.error('Завантаження кабінету:', e);
            toast('Не вдалося завантажити дані', 'error');
            showScreen('loginSection');
        }
    } else {
        resetSession();
        stopPowerListener();
        closeAllSheets();
        document.getElementById('topNav').style.display = 'none';
        showScreen('loginSection');
        setBusy(document.getElementById('loginBtn'), false);
    }
});

// ------------------------------------------------------------
// ЗМІНА ПАРОЛЯ
// ------------------------------------------------------------
async function savePassword() {
    const btn = document.getElementById('savePassBtn');
    const pass = document.getElementById('newPass').value;
    const confirm = document.getElementById('confirmPass').value;
    const errorEl = document.getElementById('passError');
    errorEl.style.display = 'none';

    if (pass.length < 6) {
        errorEl.textContent = 'Пароль має містити щонайменше 6 символів';
        errorEl.style.display = 'block';
        return;
    }
    if (pass !== confirm) {
        errorEl.textContent = 'Паролі не збігаються';
        errorEl.style.display = 'block';
        return;
    }

    setBusy(btn, true, 'Збереження…');
    try {
        await updatePassword(auth.currentUser, pass);
        await updateDoc(doc(db, 'apartments', currentApt()), { passwordChanged: true });
        document.getElementById('newPass').value = '';
        document.getElementById('confirmPass').value = '';
        toast('Пароль змінено', 'success');
        await loadCabinet(currentApt());
    } catch (error) {
        console.error(error);
        errorEl.textContent = 'Не вдалося змінити пароль. Увійдіть повторно.';
        errorEl.style.display = 'block';
    } finally {
        setBusy(btn, false);
    }
}

// ------------------------------------------------------------
// НАВІГАЦІЯ
// ------------------------------------------------------------
function initNavigation() {
    document.getElementById('menuBtn').addEventListener('click', () => toggleSheet('menuPopup'));

    const go = async (screen, loader) => {
        closeAllSheets();
        showScreen(screen);
        document.getElementById('topNav').style.display = 'none';
        if (loader) await loader();
    };

    document.getElementById('menuDocsBtn').addEventListener('click', () => go('docsSection', loadOsbbDocs));
    document.getElementById('menuRequestsBtn').addEventListener('click', () => go('requestsSection', loadUserRequests));
    document.getElementById('menuBoardBtn').addEventListener('click', () => go('boardSection', loadBoardContacts));
    document.getElementById('menuServicesBtn').addEventListener('click', () => go('servicesSection', loadServices));
    document.getElementById('menuPollsBtn').addEventListener('click', () => go('pollsSection', loadUserPolls));

    document.getElementById('menuChangePassBtn').addEventListener('click', () => {
        closeAllSheets();
        document.getElementById('hiddenAptInput').value = session.apt;
        document.getElementById('cancelPassBtn').hidden = false;
        showScreen('passwordSection');
        document.getElementById('topNav').style.display = 'none';
    });

    document.getElementById('menuLogoutBtn').addEventListener('click', async () => {
        closeAllSheets();
        localStorage.removeItem('session_timestamp');
        await signOut(auth);
        location.reload();
    });

    document.getElementById('adminLogoutBtn').addEventListener('click', async () => {
        localStorage.removeItem('session_timestamp');
        await signOut(auth);
        location.reload();
    });

    const back = () => loadCabinet(session.apt);
    ['backFromDocsBtn', 'backFromRequestsBtn', 'backFromBoardBtn', 'backFromPollsBtn', 'backFromServicesBtn', 'backFromReceiptsBtn'].forEach(id => {
        document.getElementById(id)?.addEventListener('click', back);
    });
    document.getElementById('cancelPassBtn').addEventListener('click', back);
}

// ------------------------------------------------------------
// ВКЛАДКИ АДМІНКИ
// ------------------------------------------------------------
function initAdminTabs() {
    document.querySelectorAll('.admin-tab').forEach(tab => {
        tab.addEventListener('click', () => {
            document.querySelectorAll('.admin-tab').forEach(t => t.classList.toggle('active', t === tab));
            document.querySelectorAll('.admin-panel').forEach(p => {
                p.classList.toggle('active', p.dataset.panel === tab.dataset.tab);
            });
            const tabs = document.getElementById('adminTabs');
            window.scrollTo({ top: Math.max(0, tabs.offsetTop - 12), behavior: 'smooth' });
        });
    });
    document.getElementById('refreshHistoryBtn')?.addEventListener('click', loadAdminHistory);
}

// ------------------------------------------------------------
// СТАРТ
// ------------------------------------------------------------
function init() {
    initSheets();
    initAttachmentViewers();
    initOwners();
    initPowerToggle();
    initMessages();
    initRequests();
    initContacts();
    initPolls();
    initDirectory();
    initFinance();
    initPayments();
    initAccounts();
    initNavigation();
    registerServiceWorker();
    initInstallPrompt();
    initPullToRefresh(refreshCurrentScreen);

    // У вже встановленому застосунку пункт меню зайвий
    const installBtn = document.getElementById('menuInstallBtn');
    if (installBtn) {
        if (!canInstall()) {
            installBtn.hidden = true;
        } else {
            installBtn.addEventListener('click', async () => {
                closeAllSheets();
                const result = await triggerInstall();
                if (result === 'accepted') toast('Застосунок додано на екран', 'success');
            });
        }
    }
    initAdminTabs();

    document.getElementById('loginBtn').addEventListener('click', handleLogin);
    document.getElementById('passInput').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') handleLogin();
    });
    document.getElementById('savePassBtn').addEventListener('click', savePassword);

    document.querySelectorAll('.toggle-password').forEach(btn => {
        btn.addEventListener('click', function () {
            const input = document.getElementById(this.dataset.target);
            const shown = input.type === 'text';
            input.type = shown ? 'password' : 'text';
            this.classList.toggle('active', !shown);
        });
    });
}

init();
