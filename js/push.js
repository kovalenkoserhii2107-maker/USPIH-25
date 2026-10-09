// ============================================================
// Push-сповіщення на телефон і компʼютер (Firebase Cloud Messaging).
//
// Дозвіл питаємо лише після натискання кнопки — інакше браузери
// (а iPhone — завжди) відмовляють. На iPhone сповіщення працюють лише
// у встановленому застосунку («На екран Додому»), iOS 16.4+.
// Токен пристрою зберігається в push_tokens/{токен}: власна квартира
// й роль — правила перевіряють, що вони справжні.
// ============================================================
import { app, db, session } from './firebase.js';
import { doc, setDoc, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";

const SUPPORTED = () => 'Notification' in window && 'serviceWorker' in navigator && 'PushManager' in window;

/** Стан для кнопки: unsupported | denied | granted | default. */
export function pushState() {
    if (!SUPPORTED()) return 'unsupported';
    return Notification.permission;
}

/** Увімкнути сповіщення на цьому пристрої (викликати з обробника натискання). */
export async function enablePush() {
    if (!SUPPORTED()) throw new Error('Цей браузер не підтримує сповіщення. На iPhone — встановіть застосунок на екран «Додому».');
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') throw new Error('Сповіщення заборонені в налаштуваннях браузера');
    const registration = await navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' });
    await navigator.serviceWorker.ready;
    const { getMessaging, getToken } = await import("https://www.gstatic.com/firebasejs/10.14.1/firebase-messaging.js");
    const token = await getToken(getMessaging(app), { serviceWorkerRegistration: registration });
    if (!token) throw new Error('Не вдалося отримати адресу для сповіщень');
    await setDoc(doc(db, 'push_tokens', token), {
        apt: session.apt, role: session.role || 'none', token,
        ua: navigator.userAgent.slice(0, 200), at: serverTimestamp()
    });
    try { localStorage.setItem('push_enabled', '1'); } catch { /* лише підказка */ }
    return token;
}

export const pushEnabledHere = () => { try { return localStorage.getItem('push_enabled') === '1' && pushState() === 'granted'; } catch { return false; } };
