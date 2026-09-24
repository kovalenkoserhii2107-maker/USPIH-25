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

const VERSION = '104';
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
    './js/meeting.js',
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

self.addEventListener('activate', (event) => {
    event.waitUntil((async () => {
        const names = await caches.keys();
        await Promise.all(names
            .filter(n => n.startsWith('uspih-25-') && n !== CACHE)
            .map(n => caches.delete(n)));
        await self.clients.claim();
    })());
});

self.addEventListener('fetch', (event) => {
    const req = event.request;
    if (req.method !== 'GET') return;
    const url = new URL(req.url);
    if (url.origin !== self.location.origin) return;
    event.respondWith(networkFirst(req));
});

async function networkFirst(req) {
    const cache = await caches.open(CACHE);
    try {
        const fresh = await fetch(req.url, { cache: 'no-cache', credentials: 'same-origin' });
        if (fresh && fresh.ok && fresh.type === 'basic') cache.put(req, fresh.clone());
        return fresh;
    } catch (e) {
        return (await cache.match(req))
            || (req.mode === 'navigate' ? await cache.match('./index.html') : null)
            || Response.error();
    }
}
