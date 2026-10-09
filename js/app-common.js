// ============================================================
// Спільне для кабінету мешканця (index.html) і панелі правління
// (admin.html): профіль і роль, сеанс, завантаження, що не зависає,
// згортання карток.
// ============================================================
import { db, auth, session, reconnectFirestore } from './firebase.js';
import { doc, getDoc } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js';
import { currentScreen, muteErrorToasts } from './ui.js';
import { createResilientLoader } from './resilient-load.js';
import { ROLES } from './staff-core.js';

export const SESSION_TIMEOUT = 30 * 24 * 60 * 60 * 1000; // 30 днів

/** Сеанс довший за 30 днів закінчується; інакше подовжуємо його. */
export function sessionExpired() {
    const last = localStorage.getItem('session_timestamp');
    if (last && (Date.now() - parseInt(last, 10)) > SESSION_TIMEOUT) {
        localStorage.removeItem('session_timestamp');
        return true;
    }
    localStorage.setItem('session_timestamp', Date.now());
    return false;
}

// ------------------------------------------------------------
// РЕЖИМ РОБОТИ ЧЛЕНА ПРАВЛІННЯ
// Голова частіше відкриває панель, решта — власний кабінет;
// пристрій пам'ятає, де людина була востаннє.
// ------------------------------------------------------------
const WORK_MODE_KEY = 'work_mode';
export const storedWorkMode = () => { try { return localStorage.getItem(WORK_MODE_KEY); } catch { return null; } };
export const rememberWorkMode = mode => { try { localStorage.setItem(WORK_MODE_KEY, mode); } catch { /* лише зручність */ } };

/**
 * Квартира й роль людини, що увійшла. Свій документ ролі читати може
 * кожен — так застосунок дізнається, чи людина в команді правління.
 * Старий спільний запис (isAdmin без документа в staff) діє як голова.
 */
export async function loadProfile(apt) {
    const [snap, staffSnap] = await Promise.all([
        getDoc(doc(db, 'apartments', apt)), getDoc(doc(db, 'staff', apt)).catch(() => null)
    ]);
    const apartment = snap.exists() ? snap.data() : null;
    const staff = staffSnap?.exists() ? staffSnap.data() : null;
    session.apt = apt;
    session.serviceAccount = apartment ? apartment.isAdmin === true : Boolean(staff);
    session.role = staff
        ? (staff.active === true && ROLES.includes(staff.role) ? staff.role : null)
        : (apartment?.isAdmin === true ? 'chair' : null);
    session.staffName = staff?.name || '';
    return { apartment, staff };
}

// ------------------------------------------------------------
// ЗАВАНТАЖЕННЯ, ЩО НЕ ЗАВИСАЄ (див. resilient-load.js)
// ------------------------------------------------------------
async function reconnect() {
    muteErrorToasts(60000);
    try { await reconnectFirestore(); }
    finally { muteErrorToasts(300); }
}

const resilient = createResilientLoader({ reconnect, currentScreen });
export const loadResiliently = resilient.load;

let hiddenAt = 0;
function resumeLoading() {
    if (resilient.resume()) return;
    if (hiddenAt && Date.now() - hiddenAt > 60000 && auth.currentUser) {
        // Після довгої паузи канал часто вже мертвий — відкриваємо новий
        // заздалегідь, щоб наступне натискання не чекало.
        reconnect().catch(() => {});
    }
}

/** Спільні слухачі сторінки: повернення з фону, мережа, згортання карток, довге очікування. */
export function initAppShell() {
    document.addEventListener('visibilitychange', () => {
        if (document.hidden) hiddenAt = Date.now();
        else resumeLoading();
    });
    window.addEventListener('online', resumeLoading);

    // Довге очікування без пояснень виглядає як зависання.
    setTimeout(() => {
        const loader = document.getElementById('appLoader');
        const text = loader?.querySelector('.loader-text');
        if (text && loader.style.display !== 'none') text.textContent = 'Повільне з’єднання — ще трохи…';
    }, 6000);

    // Згортання карток. Слухач один і делегований на документ —
    // інакше картки, розмітку яких перемальовує JS, лишалися б без нього.
    document.addEventListener('click', (e) => {
        const btn = e.target.closest('.admin-card-toggle');
        if (!btn) return;
        const card = btn.closest('.admin-fold');
        if (!card || card.classList.contains('is-section')) return;
        const open = card.classList.toggle('open');
        btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
}
