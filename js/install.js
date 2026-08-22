// ============================================================
// PWA: реєстрація Service Worker і ненав'язлива підказка про
// встановлення на головний екран.
//
// Android/Chrome дає системний діалог — ловимо beforeinstallprompt
// і показуємо кнопку «Встановити».
// iOS Safari такого діалогу не має взагалі, тому там лишається
// тільки пояснити шлях: «Поділитися» → «На екран «Додому»».
// ============================================================

const DISMISS_KEY = 'install_hint_dismissed_at';
const DISMISS_DAYS = 30;
const SHOW_DELAY = 2500;

let deferredPrompt = null;   // подія beforeinstallprompt (лише Android/Chrome)
let hintShown = false;

// ------------------------------------------------------------
// SERVICE WORKER
// ------------------------------------------------------------
export function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    // Шлях відносний: на GitHub Pages застосунок лежить у підтеці
    // /USPIH-25/, і абсолютний «/sw.js» вказував би не туди.
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('./sw.js')
            .catch(e => console.warn('Service Worker не зареєстровано:', e));
    });
}

// ------------------------------------------------------------
// ПЕРЕВІРКИ СЕРЕДОВИЩА
// ------------------------------------------------------------
/** Застосунок уже відкрито як встановлений — підказка не потрібна. */
function isStandalone() {
    return window.matchMedia('(display-mode: standalone)').matches
        || window.navigator.standalone === true;
}

function isIos() {
    const ua = window.navigator.userAgent;
    if (/iPad|iPhone|iPod/.test(ua)) return true;
    // iPadOS 13+ представляється як Mac, вирізняємо його по дотику
    return /Macintosh/.test(ua) && navigator.maxTouchPoints > 1;
}

/** У вбудованих браузерах (Instagram, Facebook) додати на екран не можна. */
function isInAppBrowser() {
    return /FBAN|FBAV|Instagram|Line|Twitter/.test(window.navigator.userAgent);
}

function isDismissedRecently() {
    const at = parseInt(localStorage.getItem(DISMISS_KEY) || '0', 10);
    if (!at) return false;
    return (Date.now() - at) < DISMISS_DAYS * 24 * 60 * 60 * 1000;
}

function rememberDismiss() {
    try { localStorage.setItem(DISMISS_KEY, String(Date.now())); } catch (e) { /* ігноруємо */ }
}

// ------------------------------------------------------------
// БАНЕР
// ------------------------------------------------------------
const shareIcon = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 16V3"></path><polyline points="8 7 12 3 16 7"></polyline><path d="M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7"></path></svg>';

function buildBanner(mode) {
    const el = document.createElement('div');
    el.className = 'install-banner';
    el.id = 'installBanner';

    const action = mode === 'android'
        ? '<button type="button" class="install-btn" id="installAcceptBtn">Встановити</button>'
        : `<span class="install-steps">Натисніть ${shareIcon} у Safari, далі — «Додати на початковий екран»</span>`;

    el.innerHTML = `
        <span class="install-icon">
            <svg viewBox="0 0 100 100" width="26" height="26">
                <rect x="5" y="90" width="90" height="3" fill="#9E9E9E"/>
                <rect x="50" y="30" width="30" height="60" fill="#CFD4D8"/>
                <rect x="25" y="15" width="30" height="75" fill="#E2E5E7"/>
                <rect x="33" y="82" width="14" height="8" fill="#5C6B77"/>
                <circle cx="18" cy="55" r="10" fill="#83B799"/>
                <circle cx="12" cy="62" r="8" fill="#83B799"/>
                <circle cx="24" cy="60" r="7" fill="#83B799"/>
            </svg>
        </span>
        <span class="install-text">
            <strong>Додайте застосунок на екран</strong>
            <small>Відкриватиметься як звичайний додаток, без адресного рядка</small>
        </span>
        <button type="button" class="install-close" id="installCloseBtn" aria-label="Сховати">✕</button>
        ${action}`;

    return el;
}

function hideBanner() {
    const el = document.getElementById('installBanner');
    if (!el) return;
    el.classList.add('install-banner-out');
    setTimeout(() => el.remove(), 260);
}

/**
 * Показує підказку. Викликається вже після входу в кабінет —
 * на екрані входу вона тільки заважала б.
 */
export function showInstallHint() {
    if (hintShown || isStandalone() || isInAppBrowser() || isDismissedRecently()) return;

    const ios = isIos();
    // На Android показуємо лише тоді, коли браузер підтвердив
    // готовність встановити — інакше кнопці нема чого викликати.
    if (!ios && !deferredPrompt) return;

    hintShown = true;
    setTimeout(() => {
        if (document.getElementById('installBanner')) return;
        const banner = buildBanner(ios ? 'ios' : 'android');
        document.body.appendChild(banner);

        document.getElementById('installCloseBtn')?.addEventListener('click', () => {
            rememberDismiss();
            hideBanner();
        });

        document.getElementById('installAcceptBtn')?.addEventListener('click', async () => {
            if (!deferredPrompt) return;
            hideBanner();
            deferredPrompt.prompt();
            try {
                const { outcome } = await deferredPrompt.userChoice;
                if (outcome !== 'accepted') rememberDismiss();
            } catch (e) {
                console.warn('Діалог встановлення:', e);
            }
            // Подію можна використати лише один раз
            deferredPrompt = null;
        });
    }, SHOW_DELAY);
}

// ------------------------------------------------------------
// ІНІЦІАЛІЗАЦІЯ
// ------------------------------------------------------------
export function initInstallPrompt() {
    window.addEventListener('beforeinstallprompt', (e) => {
        // Без preventDefault Chrome показав би власну панель одразу
        e.preventDefault();
        deferredPrompt = e;
    });

    window.addEventListener('appinstalled', () => {
        deferredPrompt = null;
        rememberDismiss();
        hideBanner();
    });
}
