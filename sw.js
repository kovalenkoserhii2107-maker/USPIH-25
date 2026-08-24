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

const VERSION = '71';
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
    './js/finance.js',
    './js/power-stats.js',
    './js/faq.js',
    './js/chat.js',
    './js/ledger.js',
    './js/verify.js'
];

// ------------------------------------------------------------
// ВСТАНОВЛЕННЯ
// Кожен файл додаємо окремо: якщо один шлях зіпсовано, це не
// має валити встановлення воркера цілком (cache.addAll саме так
// і поводиться — падає весь список через один файл).
//
// Не cache.add(), а fetch із no-cache: add() читає крізь браузерний
// HTTP-кеш і склав би у сховище воркера рівно ті застарілі файли,
// заради оновлення яких воркер і перевстановлюється.
// ------------------------------------------------------------
self.addEventListener('install', (event) => {
    event.waitUntil((async () => {
        const cache = await caches.open(CACHE);
        await Promise.all(SHELL.map(async (url) => {
            try {
                const res = await fetch(url, { cache: 'no-cache', credentials: 'same-origin' });
                if (res.ok) await cache.put(url, res);
            } catch (e) {
                console.warn('SW: не закешовано', url, e);
            }
        }));
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

    // Мережа-перша для ВСЬОГО свого домену, а не лише для сторінок.
    //
    // Раніше модулі віддавалися з кешу. Але «?v=» стоїть тільки біля
    // app.js і style.css, а решта модулів кешуються без версії. Тому
    // після оновлення виходила суміш: свіжий app.js і старий ui.js із
    // кешу — імпорт не резолвився, і застосунок вічно висів на
    // завантаженні. Кеш тепер потрібен лише для роботи без мережі.
    event.respondWith(networkFirst(req));
});

async function networkFirst(req) {
    const cache = await caches.open(CACHE);
    try {
        // cache: 'no-cache' — не примха, а обовʼязкова умова.
        //
        // GitHub Pages віддає файли з max-age=600, а браузерний HTTP-кеш
        // стоїть ПЕРЕД воркером: звичайний fetch(req) до десяти хвилин
        // повертав старий файл, хоч на сервері вже лежав новий. Виходила
        // та сама суміш версій, від якої мала рятувати «мережа-перша».
        // no-cache змушує спитати сервер; якщо файл не змінився, той
        // відповість 304 — це дешево.
        //
        // Беремо req.url, а не сам req: у запиту навігації режим
        // 'navigate', і конструювання нового Request з нього має власні
        // тонкощі, які тут ні до чого.
        const fresh = await fetch(req.url, { cache: 'no-cache', credentials: 'same-origin' });
        // Кешуємо лише вдалі відповіді свого походження
        if (fresh && fresh.ok && fresh.type === 'basic') cache.put(req, fresh.clone());
        return fresh;
    } catch (e) {
        return (await cache.match(req))
            || (req.mode === 'navigate' ? await cache.match('./index.html') : null)
            || Response.error();
    }
}
