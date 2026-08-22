// ============================================================
// Service Worker застосунку ОСББ «Успіх-25».
//
// Кешує лише оболонку застосунку (HTML, CSS, модулі JS).
// Дані — оголошення, звернення, співвласники, статус світла —
// живуть у Firebase і НІКОЛИ не кешуються: інакше мешканець
// бачив би вчорашні новини як сьогоднішні.
//
// ВАЖЛИВО ПРО ВЕРСІЮ: VERSION нижче має збігатися з «?v=» у
// index.html. Коли міняєте код — підніміть обидва місця разом,
// інакше браузери мешканців віддаватимуть стару оболонку.
// ============================================================

const VERSION = '15';
const CACHE = `uspih-25-v${VERSION}`;

// Файли з «?v=» підключені саме так в index.html — кешуємо їх
// із тим самим рядком запиту, інакше збігу не буде.
const SHELL = [
    './',
    './index.html',
    './manifest.json',
    `./style.css?v=${VERSION}`,
    `./js/app.js?v=${VERSION}`,
    './js/firebase.js',
    './js/ui.js',
    './js/attachments.js',
    './js/owners.js',
    './js/power.js',
    './js/messages.js',
    './js/requests.js',
    './js/contacts.js',
    './js/install.js',
    './js/pull-refresh.js',
    './js/polls.js',
    './js/dashboard.js',
    './js/directory.js',
    './js/finance.js'
];

// ------------------------------------------------------------
// ВСТАНОВЛЕННЯ
// Кожен файл додаємо окремо: якщо один шлях зіпсовано, це не
// має валити встановлення воркера цілком (cache.addAll саме так
// і поводиться — падає весь список через один файл).
// ------------------------------------------------------------
self.addEventListener('install', (event) => {
    event.waitUntil((async () => {
        const cache = await caches.open(CACHE);
        await Promise.all(SHELL.map(
            url => cache.add(url).catch(e => console.warn('SW: не закешовано', url, e))
        ));
        await self.skipWaiting();
    })());
});

// ------------------------------------------------------------
// АКТИВАЦІЯ: прибираємо кеші попередніх версій
// ------------------------------------------------------------
self.addEventListener('activate', (event) => {
    event.waitUntil((async () => {
        const names = await caches.keys();
        await Promise.all(names
            .filter(n => n.startsWith('uspih-25-') && n !== CACHE)
            .map(n => caches.delete(n)));
        await self.clients.claim();
    })());
});

// ------------------------------------------------------------
// ЗАПИТИ
// ------------------------------------------------------------
self.addEventListener('fetch', (event) => {
    const req = event.request;

    // Записи (POST до Firestore тощо) не чіпаємо взагалі.
    if (req.method !== 'GET') return;

    const url = new URL(req.url);

    // Чужі домени — Firestore, Storage, Auth, SDK з gstatic —
    // пропускаємо повз воркер. Кешувати живі дані не можна, а
    // втручання в потокові запити Firestore ламає онлайн-оновлення.
    if (url.origin !== self.location.origin) return;

    // Перехід між сторінками: спершу мережа, щоб не показувати
    // стару оболонку; без зв'язку віддаємо збережену копію.
    if (req.mode === 'navigate') {
        event.respondWith(networkFirst(req));
        return;
    }

    event.respondWith(cacheFirst(req));
});

async function networkFirst(req) {
    const cache = await caches.open(CACHE);
    try {
        const fresh = await fetch(req);
        cache.put(req, fresh.clone());
        return fresh;
    } catch (e) {
        return (await cache.match(req))
            || (await cache.match('./index.html'))
            || Response.error();
    }
}

async function cacheFirst(req) {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(req);
    if (hit) return hit;
    try {
        const fresh = await fetch(req);
        // Кешуємо лише вдалі відповіді свого походження
        if (fresh && fresh.ok && fresh.type === 'basic') cache.put(req, fresh.clone());
        return fresh;
    } catch (e) {
        return Response.error();
    }
}
