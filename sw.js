// ============================================================
// Service Worker застосунку ОСББ «Успіх-25».
//
// Кешує лише оболонку застосунку (HTML, CSS, модулі JS).
// Дані — оголошення, звернення, співласники, статус світла —
// живуть у Firebase і НІКОЛИ не кешуються: інакше мешканець
// бачив би вчорашні новини як сьогоднішні.
//
// ВАЖЛИВО ПРО ВЕРСІЮ: VERSION нижче має збігатися з «?v=» у
// index.html. Коли міняєте код — підніміть обидва місця разом,
// інакше браузери мешканців віддаватимуть стару оболонку.
// ============================================================

const VERSION = '148';
const CACHE = `uspih-25-v${VERSION}`;

// Файли з «?v=» підключені саме так в index.html — кешуємо їх
// із тим самим рядком запиту, інакше збігу не буде.
const SHELL = [
    './',
    './index.html',
    './manifest.json',
    `./style.css?v=${VERSION}`,
    `./style-chat.css?v=${VERSION}`,
    `./js/app.js?v=${VERSION}`,
    './js/firebase.js',
    './js/backend.js',
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
    './js/meeting.js',
    './js/meeting_actions.js',
    './js/admin-documents.js',
    './js/admin-document-core.js',
    './js/meters.js',
    './js/meter-dial.js',
    './js/apartment-meter-core.js',
    './js/apartment-meter-store.js',
    './js/apartment-meters.js',
    './js/meter-core.js',
    './js/meter-store.js',
    './js/meetings.js',
    './js/paper_votes.js',
    './js/protocol_pdf.js',
    './js/protocol_form.js',
    './js/dashboard.js',
    './js/directory.js',
    './js/finance.js',
    './js/power-stats.js',
    './js/faq.js',
    './js/chat.js',
    './js/ledger.js',
    './js/verify.js',
    './js/tutorial.js',
    './js/import-owners.js',
    './js/export-base.js',
    './js/xlsx-write.js',
    './js/dtek.js'
];

const FIREBASE_SDK = [
    'https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js',
    'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js',
    'https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js',
    'https://www.gstatic.com/firebasejs/10.14.1/firebase-storage.js',
    'https://www.gstatic.com/firebasejs/10.14.1/firebase-functions.js'
];

// ------------------------------------------------------------
// ВСТАНОВЛЕННЯ
// Оболонка встановлюється цілком: якщо файл недоступний,
// попередній робочий воркер лишається активним.
//
// Не cache.add(), а fetch із no-cache: add() читає крізь браузерний
// HTTP-кеш і склав би у сховище воркера рівно ті застарілі файли,
// заради оновлення яких воркер і перевстановлюється.
// ------------------------------------------------------------
self.addEventListener('install', (event) => {
    event.waitUntil((async () => {
        const cache = await caches.open(CACHE);
        // Оболонка атомарна: один отсутствующий модуль отменяет установку,
        // поэтому прежний полностью рабочий worker остаётся активным.
        const shellResponses = await Promise.all(SHELL.map(async url => {
            const response = await fetch(url, { cache: 'no-cache', credentials: 'same-origin' });
            if (!response.ok) throw new Error(`SW: ${url} — HTTP ${response.status}`);
            return [url, response];
        }));
        await Promise.all(shellResponses.map(([url, response]) => cache.put(url, response)));

        // SDK не является частью атомарной оболочки: при блокировке CDN
        // установка всё равно завершается, а онлайн-запуск использует сеть.
        await Promise.allSettled(FIREBASE_SDK.map(async url => {
            const response = await fetch(url, { cache: 'no-cache', mode: 'cors' });
            if (response.ok) await cache.put(url, response);
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

    // Кешуємо лише точні URL модулів SDK. Firestore/Auth/Storage API
    // й усі інші чужі запити проходять напряму та ніколи не кешуються.
    if (url.origin !== self.location.origin) {
        if (FIREBASE_SDK.includes(url.href)) event.respondWith(cacheFirst(req));
        return;
    }

    // A versioned production bundle has all local modules inside it, so it is
    // safe to reuse the exact version without mixing old and new imports.
    if (url.searchParams.get('v') === VERSION && /\/(?:js\/(?:app|admin-main|buh-main)\.js|style(?:-chat|-admin|-buh)?\.css)$/.test(url.pathname)) {
        event.respondWith(cacheFirst(req));
        return;
    }

    // Частини збірки мають хеш вмісту в імені: новий код — нове імʼя,
    // тож файл за тим самим шляхом ніколи не змінюється. Частини для
    // кабінету лежать в оболонці, а модулі правління кешуються при
    // першому відкритті вкладки.
    if (url.pathname.includes('/js/chunks/')) {
        event.respondWith(cacheFirst(req));
        return;
    }

    // HTML та файли без версії спочатку читаємо з мережі.
    // Це дає свіжу оболонку та не змішує вихідні JS-модулі
    // різних версій під час локальної розробки або preview.
    event.respondWith(networkFirst(req, event));
});

async function cacheFirst(req) {
    const cache = await caches.open(CACHE);
    const cached = await cache.match(req);
    if (cached) return cached;
    const response = await fetch(req);
    if (response && (response.ok || response.type === 'opaque')) {
        await cache.put(req, response.clone());
    }
    return response;
}

// Скільки сторінка чекає на мережу, поки не відкриється з кешу.
// На слабкому мобільному звʼязку запит може висіти десятки секунд,
// перш ніж остаточно впасти, — і весь цей час мешканець бачив білий екран.
const NAVIGATION_TIMEOUT = 4000;

async function networkFirst(req, event) {
    const cache = await caches.open(CACHE);
    const cached = async () => (await cache.match(req))
        || (req.mode === 'navigate' ? await cache.match('./index.html') : null);
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
    const network = fetch(req.url, { cache: 'no-cache', credentials: 'same-origin' }).then(fresh => {
        // Кешуємо лише вдалі відповіді свого походження
        if (fresh && fresh.ok && fresh.type === 'basic') cache.put(req, fresh.clone());
        return fresh;
    });

    if (req.mode === 'navigate') {
        // Повільна мережа не скасовується: свіжа сторінка ляже в кеш
        // і відкриється наступного разу.
        event.waitUntil(network.catch(() => {}));
        const first = await Promise.race([
            network.then(response => ({ response }), () => ({})),
            new Promise(resolve => setTimeout(() => resolve({}), NAVIGATION_TIMEOUT))
        ]);
        if (first.response) return first.response;
        const fallback = await cached();
        if (fallback) return fallback;
    }
    try {
        return await network;
    } catch (e) {
        return (await cached()) || Response.error();
    }
}

// ------------------------------------------------------------
// PUSH-СПОВІЩЕННЯ (Firebase Cloud Messaging)
// Сервер шле webpush з notification { title, body } і посиланням у
// fcmOptions.link — показуємо самі, бо воркер у застосунку свій.
// ------------------------------------------------------------
self.addEventListener('push', (event) => {
    let payload = {};
    try { payload = event.data ? event.data.json() : {}; } catch (e) { payload = {}; }
    const n = payload.notification || {};
    const link = (payload.fcmOptions && payload.fcmOptions.link) || (payload.data && payload.data.link) || './';
    event.waitUntil(self.registration.showNotification(n.title || 'ОСББ «Успіх-25»', {
        body: n.body || '',
        icon: './assets/icons/icon-192x192.png',
        badge: './assets/icons/icon-192x192.png',
        data: { link },
        tag: (payload.data && payload.data.tag) || undefined
    }));
});

self.addEventListener('notificationclick', (event) => {
    event.notification.close();
    const target = new URL((event.notification.data && event.notification.data.link) || './', self.registration.scope).href;
    event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
        const open = list.find(c => c.url.startsWith(self.registration.scope));
        if (open) { open.navigate(target).catch(() => {}); return open.focus(); }
        return self.clients.openWindow(target);
    }));
});
