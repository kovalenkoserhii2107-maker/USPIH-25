// ============================================================
// Ініціалізація Firebase. Єдине місце, де живе конфігурація.
// ============================================================
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import { getFirestore, disableNetwork, enableNetwork } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import {
    initializeAuth, indexedDBLocalPersistence, browserLocalPersistence, browserSessionPersistence
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import { getStorage } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-storage.js";
import { getFunctions } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-functions.js";

const firebaseConfig = {
    apiKey: "AIzaSyAtNW2KCzP0Xn6vy6h77-ABUJEkcum8rCE",
    authDomain: "uspih-25.firebaseapp.com",
    projectId: "uspih-25",
    storageBucket: "uspih-25.firebasestorage.app",
    messagingSenderId: "56244989310",
    appId: "1:56244989310:web:69c3779936387888d6172f",
    measurementId: "G-FCD4GREECY"
};

export const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);
// Не getAuth(): той додає вхід через вікна Google і на iPhone та в Safari
// ще до відновлення сесії вантажить службовий iframe із firebaseapp.com
// та скрипти apis.google.com — черепаха чекала саме на них. Вхід у нас
// лише за паролем, тож лишаємо ті самі сховища сесії без цього модуля.
export const auth = initializeAuth(app, {
    persistence: [indexedDBLocalPersistence, browserLocalPersistence, browserSessionPersistence]
});
export const storage = getStorage(app);
export const functions = getFunctions(app, 'europe-central2');

// ------------------------------------------------------------
// ПЕРЕЗАПУСК З'ЄДНАННЯ. Після повернення з фону (особливо на iPhone)
// канал Firestore буває «мертвим»: запити не падають і не відповідають,
// а екран вічно показує «Завантаження…». Вимкнення й увімкнення мережі
// відкриває новий канал; слухачі (світло, чат) відновлюються самі.
// ------------------------------------------------------------
let reconnecting = null;
export function reconnectFirestore() {
    reconnecting ||= (async () => {
        try { await disableNetwork(db); } finally { await enableNetwork(db); }
    })().finally(() => { reconnecting = null; });
    return reconnecting;
}

// ------------------------------------------------------------
// СЕСІЯ. Раніше "хто я" читалося з тексту на екрані
// (displayAptNum.innerText), тому будь-хто міг це підмінити
// через DevTools. Тепер єдине джерело істини — сам Firebase Auth.
// ------------------------------------------------------------
// Домен службових email-адрес мешканців. Реальної пошти не існує —
// це технічний спосіб входу за номером квартири. Формат: "45@uspih-25.com".
// Тримаємо в одному місці: зміна цього рядка ламає вхід усім користувачам.
export const AUTH_DOMAIN = 'uspih-25.com';

/** Будує email для входу з номера квартири. */
export function aptToEmail(apt) {
    return `${String(apt).trim()}@${AUTH_DOMAIN}`;
}

export const session = {
    apt: null,        // номер квартири (з email користувача)
    entrance: null,   // парадна
    area: null,       // площа
    balance: 0,       // від'ємне — борг, додатне — переплата
    personalAccount: '',
    ownersStatus: '',
    ownersDecision: null,
    tutorialSeen: false,
    ownerName: '',    // ПІБ першого співвласника — для форм банку
    isAdmin: false
};

/** Номер квартири поточного користувача — завжди з токена автентифікації. */
export function currentApt() {
    const user = auth.currentUser;
    if (!user || !user.email) return null;
    return user.email.split('@')[0];
}

export function resetSession() {
    session.apt = null;
    session.entrance = null;
    session.area = null;
    session.balance = 0;
    session.personalAccount = '';
    session.ownersStatus = '';
    session.ownersDecision = null;
    session.tutorialSeen = false;
    session.ownerName = '';
    session.isAdmin = false;
}
