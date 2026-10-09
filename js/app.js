// ============================================================
// Точка входу: автентифікація, маршрутизація екранів, навігація.
// ============================================================
import { db, auth, session, currentApt, resetSession, aptToEmail } from './firebase.js';
import {
    doc, setDoc, updateDoc, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import {
    signInWithEmailAndPassword, onAuthStateChanged, signOut, updatePassword
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";

import {
    toast, setBusy, showScreen, currentScreen, initSheets, toggleSheet, closeAllSheets
} from './ui.js';
import { initAttachmentViewers } from './attachments.js';
import { initOwners, loadOwners } from './owners.js';
import { startPowerListener, stopPowerListener } from './power.js';
import { initPowerStats } from './power-stats.js';
import { initFaq, loadFaq } from './faq.js';
import { initChat, loadChat, stopChat, refreshChatBadge } from './chat.js';
import { initMessages, loadUserMessages } from './messages.js';
import { initRequests, loadUserRequests, refreshRequestsBadge, loadOsbbDocs } from './requests.js';
import { loadBoardContacts, loadServices } from './contacts.js';
import { loadUserPolls, refreshPollsBadge } from './polls.js';
import { initDtek, loadPowerSchedule } from './dtek.js';
import {
    initPayments, loadBalance, loadExpenses, loadReceipts, loadFinanceDetail
} from './finance.js';
import {
    registerServiceWorker, initInstallPrompt, showInstallHint, triggerInstall, canInstall
} from './install.js';
import { initPullToRefresh } from './pull-refresh.js';
import { maybeShowTutorial, markFreshLogin } from './tutorial.js';
import { loadProfile, loadResiliently, initAppShell, sessionExpired, storedWorkMode, rememberWorkMode } from './app-common.js';
import { initLedger, loadLedger } from './ledger.js';

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
        markFreshLogin();
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
let homeApartment = null;

async function loadCabinet(apt) {
    const aptRef = doc(db, 'apartments', apt);
    const { apartment, staff } = await loadProfile(apt);
    homeApartment = apartment;

    let firstLogin = true;
    if (apartment) {
        firstLogin = !apartment.passwordChanged;
        session.area = apartment.area || '--';
        session.entrance = apartment.entrance || '--';
        session.ownersStatus = apartment.ownersStatus || 'pending';
        session.ownersDecision = apartment.ownersDecision || null;
        session.tutorialSeen = Boolean(apartment.tutorialAt);
    } else if (staff) {
        // Службовий номер без документа квартири: не створюємо його,
        // інакше в довіднику з'явилася б неіснуюча квартира.
        firstLogin = false;
        session.area = '--';
        session.entrance = '--';
    } else {
        await setDoc(aptRef, { passwordChanged: false, area: '', entrance: '', isAdmin: false, lastLogin: serverTimestamp() });
        session.area = '--';
        session.entrance = '--';
    }

    if (firstLogin) {
        document.getElementById('hiddenAptInput').value = apt;
        document.getElementById('cancelPassBtn').hidden = true;
        showScreen('passwordSection');
        return;
    }

    startPowerListener();
    renderStaffEntry();

    const mode = storedWorkMode();
    const staffMode = Boolean(session.role) && (session.serviceAccount || mode === 'staff' || mode === 'buh');
    // Лоадер лишається, поки відкривається панель чи бухгалтерія.
    if (staffMode) { location.replace(workPage(mode)); return; }
    await openHomeMode(apt);
}

/**
 * Куди йде людина з роллю: бухгалтер — у кабінет бухгалтера, решта
 * команди — у панель правління; голова повертається туди, де працював.
 */
function workPage(mode) {
    if (session.role === 'accountant') return 'buh.html';
    return mode === 'buh' && session.role === 'chair' ? 'buh.html' : 'admin.html';
}

/** Плитка «Правління» («Бухгалтерія» для бухгалтера) в меню мешканця — лише для команди. */
function renderStaffEntry() {
    const tile = document.getElementById('menuStaffBtn');
    if (!tile) return;
    tile.hidden = !session.role || session.serviceAccount;
    const label = tile.querySelector('.menu-tile-label');
    if (label) label.textContent = session.role === 'accountant' ? 'Бухгалтерія' : 'Правління';
}

/** Панель правління чи бухгалтерія — окремі сторінки зі своїм кодом. */
function openStaffMode() {
    if (!session.role) return;
    const page = session.role === 'accountant' ? 'buh.html' : 'admin.html';
    rememberWorkMode(page === 'buh.html' ? 'buh' : 'staff');
    location.assign(page);
}

/** Власний кабінет мешканця — і для члена правління, що живе в будинку. */
async function openHomeMode(apt = session.apt) {
    session.isAdmin = false;
    if (session.role) rememberWorkMode('home');
    closeAllSheets();
    showScreen('dataSection');
    document.getElementById('topNav').style.display = 'block';
    document.getElementById('displayAptNum').textContent = apt;
    document.getElementById('displayEntranceNum').textContent = session.entrance;
    // Кома, а не крапка: усі інші числа в застосунку українські
    // («6 247,33»), і «64.0» серед них виглядає чужим.
    document.getElementById('displayAreaVal').textContent =
        String(session.area).replace('.', ',');
    const apartment = homeApartment;
    homeApartment = null;           // при наступному переході — свіжі дані
    await Promise.all([
        loadOwners(apt), loadUserMessages(apt, session.entrance),
        loadBalance(apt, apartment || undefined), loadExpenses(), loadPowerSchedule()
    ]);

    // Кнопку малює loadBalance, тож слухача вішаємо після нього
    const receiptsBtn = document.getElementById('openReceiptsBtn');
    if (receiptsBtn) receiptsBtn.onclick = () => {
        showScreen('receiptsSection');
        document.getElementById('topNav').style.display = 'none';
        loadReceipts();
    };
    refreshPollsBadge();          // без await: значок не має затримувати кабінет
    refreshRequestsBadge();       // так само — непрочитані відповіді правління
    refreshChatBadge();
    showInstallHint();
    // Знайомство — останнім: кабінет під ним уже завантажений, тож
    // з останнього кроку можна одразу везти до списку співвласників.
    maybeShowTutorial();
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
    docsSection: loadOsbbDocs,
    requestsSection: loadUserRequests,
    pollsSection: loadUserPolls,
    boardSection: loadBoardContacts,
    servicesSection: loadServices,
    receiptsSection: loadReceipts,
    ledgerSection: loadLedger,
    financeSection: loadFinanceDetail,
    metersSection: async () => { const meters = await import('./apartment-meters.js'); meters.initApartmentMeters(); return meters.loadApartmentMeters(); },
    faqSection: loadFaq,
    chatSection: loadChat
};

async function refreshCurrentScreen() {
    if (!auth.currentUser) return;
    const reloader = SCREEN_RELOADERS[currentScreen()];
    // Невідомий екран — чесніше перезавантажити, ніж не зробити нічого
    if (!reloader) { location.reload(); return; }
    try {
        await loadResiliently(reloader);
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
        if (sessionExpired()) { await signOut(auth); return; }
        try {
            await loadResiliently(() => loadCabinet(currentApt()), null);
        } catch (e) {
            console.error('Завантаження кабінету:', e);
            toast('Не вдалося завантажити дані', 'error');
            showScreen('loginSection');
        }
    } else {
        resetSession();
        stopPowerListener();
        stopChat();
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
    const terms = document.getElementById('termsCheckbox').checked;
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
    if (!terms) {
        errorEl.textContent = 'Ви повинні погодитися з умовами та політикою конфіденційності';
        errorEl.style.display = 'block';
        return;
    }

    setBusy(btn, true, 'Збереження…');
    try {
        await updatePassword(auth.currentUser, pass);
        await updateDoc(doc(db, 'apartments', currentApt()), { 
            passwordChanged: true,
            termsAcceptedAt: serverTimestamp()
        });
        document.getElementById('newPass').value = '';
        document.getElementById('confirmPass').value = '';
        document.getElementById('termsCheckbox').checked = false;
        toast('Пароль змінено', 'success');
        setBusy(btn, false);
        await loadCabinet(currentApt());
    } catch (error) {
        console.error(error);
        errorEl.textContent = 'Не вдалося змінити пароль. Увійдіть повторно.';
        errorEl.style.display = 'block';
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
        if (loader) await loadResiliently(loader, screen);
    };

    document.getElementById('menuDocsBtn').addEventListener('click', () => go('docsSection', loadOsbbDocs));
    document.getElementById('menuFaqBtn').addEventListener('click', () => go('faqSection', loadFaq));
    document.getElementById('menuChatBtn').addEventListener('click', () => go('chatSection', loadChat));
    document.getElementById('menuRequestsBtn').addEventListener('click', () => go('requestsSection', loadUserRequests));
    document.getElementById('menuBoardBtn').addEventListener('click', () => go('boardSection', loadBoardContacts));
    document.getElementById('menuServicesBtn').addEventListener('click', () => go('servicesSection', loadServices));
    document.getElementById('menuPollsBtn').addEventListener('click', () => go('pollsSection', loadUserPolls));
    document.getElementById('menuMetersBtn')?.addEventListener('click', () => go('metersSection', async () => {
        const meters = await import('./apartment-meters.js'); meters.initApartmentMeters(); await meters.loadApartmentMeters();
    }));
    document.getElementById('menuActivityBtn')?.addEventListener('click', () => go('financeSection', loadFinanceDetail));

    document.getElementById('menuLinkTerms')?.addEventListener('click', (e) => { e.preventDefault(); toggleSheet('termsSheet'); });
    document.getElementById('menuLinkPrivacy')?.addEventListener('click', (e) => { e.preventDefault(); toggleSheet('privacySheet'); });
    document.getElementById('linkTerms')?.addEventListener('click', (e) => { e.preventDefault(); toggleSheet('termsSheet'); });
    document.getElementById('linkPrivacy')?.addEventListener('click', (e) => { e.preventDefault(); toggleSheet('privacySheet'); });

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

    // Член правління перемикається між панеллю й власним кабінетом без перевходу.
    document.getElementById('menuStaffBtn')?.addEventListener('click', () => openStaffMode());


    const back = () => {
        stopChat();
        closeAllSheets();
        // Кабінет уже завантажений: повернення працює навіть без мережі.
        showScreen('dataSection');
        document.getElementById('topNav').style.display = 'block';
    };
    ['backFromDocsBtn', 'backFromRequestsBtn', 'backFromBoardBtn', 'backFromPollsBtn', 'backFromServicesBtn', 'backFromReceiptsBtn', 'backFromFaqBtn', 'backFromChatBtn', 'backFromLedgerBtn', 'backFromFinanceBtn', 'backFromMetersBtn'].forEach(id => {
        document.getElementById(id)?.addEventListener('click', back);
    });
    document.getElementById('cancelPassBtn').addEventListener('click', back);
}

// ------------------------------------------------------------
// СТАРТ
// ------------------------------------------------------------
function init() {
    initAppShell();
    initSheets();
    initAttachmentViewers();
    initOwners();
    initPowerStats();
    initFaq();
    initChat();
    initMessages();
    initRequests();
    initDtek();
    initPayments();
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
    initLedger();

    document.getElementById('loginBtn').addEventListener('click', handleLogin);
    const aptInput = document.getElementById('aptInput');
    // Поле текстове (щоб телефон показав цифрову клавіатуру), тож нецифри
    // відсікаємо самі — і при наборі, і при вставці з буфера.
    aptInput.addEventListener('input', () => {
        const clean = aptInput.value.replace(/\D/g, '');
        if (clean !== aptInput.value) aptInput.value = clean;
    });
    aptInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') document.getElementById('passInput').focus();
    });
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
