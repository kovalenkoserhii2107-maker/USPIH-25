// ============================================================
// Чат будинку та коментарі під оголошеннями.
//
// Підписуються КВАРТИРИ, а не люди: вхід у застосунку за номером
// квартири, і в однієї квартири часто двоє співвласників з одним
// паролем. Тому автор — «Кв. 298», і за слово відповідає квартира.
//
// Позначку «Правління» перевіряють правила Firestore, а не код:
// інакше через DevTools можна було б видати себе за правління.
//
// Як влаштована стрічка:
//  • Повідомлення малюються по ключу (id): прийшло нове — додається
//    один вузол, змінилося — замінюється один. Стрічка ніколи не
//    перемальовується цілком, тому нічого не блимає й не стрибає.
//  • Своє повідомлення зʼявляється миттєво: Firestore показує запис
//    ще до відповіді сервера (hasPendingWrites). Поки сервер не
//    підтвердив — годинник, підтвердив — галочка.
//  • Прокрутка «прилипає» до низу, поки мешканець унизу. Якщо він
//    читає давніше — стрічка тримає на місці те, що він читає.
// ============================================================
import { db, storage, session } from './firebase.js';
import {
    collection, addDoc, setDoc, updateDoc, doc, onSnapshot, getDocs,
    query, orderBy, limit, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import {
    ref as sRef, uploadBytes, getDownloadURL
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-storage.js";
import { escapeHtml, toast, setBusy, confirmDialog, safeFileUrl } from './ui.js';
import {
    renderFileManager, openGallery, isImageFile, openDocViewer, getDocKind, docIconSvg
} from './attachments.js';

/**
 * Пояснює причину відмови. Загальне «не вдалося» не дає ні мешканцю,
 * ні правлінню жодної зачіпки — а код помилки одразу каже, куди
 * дивитися: у правила, у звʼязок чи в саму сесію.
 */
function explain(e, action) {
    const code = e?.code || 'unknown';
    const known = {
        'permission-denied': 'Немає доступу. Правління має опублікувати правила Firestore.',
        'unauthenticated': 'Сесія завершилася. Увійдіть у застосунок знову.',
        'unavailable': 'Немає звʼязку з сервером. Перевірте інтернет.',
        'failed-precondition': 'Потрібен індекс у Firestore. Перевірте консоль браузера.',
        'resource-exhausted': 'Перевищено ліміт Firebase. Зверніться до правління.'
    };
    return known[code] || `${action} (${code})`;
}

// ------------------------------------------------------------
// ВИСОТА ПІД КЛАВІАТУРУ
//
// На iOS клавіатура не стискає сторінку, а зменшує лише видиму
// частину (visualViewport). Екран чату підганяємо саме під неї:
// висоту — під видиму висоту, top — під зсув, який робить Safari.
// Подій під час виїзду клавіатури багато, тож оновлюємо не частіше
// за кадр — інакше екран тремтів би між сусідніми значеннями.
// ------------------------------------------------------------
function syncChatHeight() {
    const sec = document.getElementById('chatSection');
    if (!sec || sec.style.display === 'none') return;
    const vv = window.visualViewport;
    if (!vv) { sec.style.height = window.innerHeight + 'px'; sec.style.top = '0px'; return; }
    const h = Math.round(vv.height);
    const t = Math.max(0, Math.round(vv.offsetTop));
    if (sec._vvH !== h) { sec.style.height = h + 'px'; sec._vvH = h; }
    if (sec._vvT !== t) { sec.style.top = t + 'px'; sec._vvT = t; }
}

let vvFrame = 0;
function queueViewportSync() {
    if (vvFrame) return;
    vvFrame = requestAnimationFrame(() => { vvFrame = 0; syncChatHeight(); });
}

/** Клавіатура їде ~300 мс — доганяємо її кількома кадрами. */
function settleChatViewport() {
    queueViewportSync();
    [120, 300, 520].forEach(ms => setTimeout(queueViewportSync, ms));
}

// ------------------------------------------------------------
// ПАНЕЛЬ НАД КЛАВІАТУРОЮ
//
// Смужку зі стрілками ↑↓ і «✓» над клавіатурою iPhone малює сам
// Safari для будь-якого текстового поля — прибрати її сторінка не
// може (це вміє лише нативний застосунок). Але стрілки в ній
// перестрибують на інші поля застосунку, що сховані під чатом, і
// тоді iOS гортає екран до них. Тому, поки чат відкритий, інші
// поля вимикаємо: стрілки стають неактивними, «✓» просто ховає
// клавіатуру.
// ------------------------------------------------------------
function lockForeignFields(on) {
    const keep = new Set(['chatInput', 'chatFiles']);
    document.querySelectorAll('input, textarea, select').forEach(el => {
        if (keep.has(el.id)) return;
        if (on) {
            if (el.disabled) return;
            el.dataset.chatLock = '1';
            el.disabled = true;
        } else if (el.dataset.chatLock) {
            el.disabled = false;
            delete el.dataset.chatLock;
        }
    });
    document.body.classList.toggle('chat-open', on);
}

// ------------------------------------------------------------
// ЗВУК І ВІДЧУТТЯ
// Синтезуємо, щоб не тягнути файли. Гучність навмисно низька:
// це підтвердження, а не сповіщення.
// ------------------------------------------------------------
let audioCtx = null;
function audio() {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return null;
    audioCtx = audioCtx || new Ctx();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    return audioCtx;
}

function tone(from, to, dur, vol) {
    try {
        const ac = audio();
        if (!ac || ac.state !== 'running') return;
        const t = ac.currentTime;
        const osc = ac.createOscillator();
        const gain = ac.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(from, t);
        osc.frequency.exponentialRampToValueAtTime(to, t + dur * 0.5);
        gain.gain.setValueAtTime(0.0001, t);
        gain.gain.exponentialRampToValueAtTime(vol, t + 0.01);
        gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
        osc.connect(gain).connect(ac.destination);
        osc.start(t);
        osc.stop(t + dur + 0.02);
    } catch (e) { /* звук не має нічого зривати */ }
}

const playSend = () => tone(740, 1180, 0.13, 0.07);
let lastReceiveSound = 0;
function playReceive() {
    const now = Date.now();
    if (now - lastReceiveSound < 1500) return;   // пачка повідомлень — один звук
    lastReceiveSound = now;
    tone(1040, 720, 0.18, 0.045);
}

/** iOS дозволяє звук лише після дотику — «будимо» його на першому. */
function primeAudio() { try { audio(); } catch (e) { /* */ } }

function taptic(ms = 10) {
    try { if (navigator.vibrate) navigator.vibrate(ms); } catch (e) { /* */ }
}

// ------------------------------------------------------------
// ПРОЧИТАНЕ
// Позначку тримаємо локально: у кожної квартири свій телефон, і
// синхронізувати її через базу означало б запис на кожне відкриття.
// ------------------------------------------------------------
const LIMIT = 200;
const MAX_FILES = 10;   // стільки ж пропускають правила Firestore
const SEEN_KEY = () => `chat_seen_${session.apt}`;

function lastSeen() {
    try { return parseInt(localStorage.getItem(SEEN_KEY()) || '0', 10); } catch (e) { return 0; }
}

function markSeen(ts) {
    try { localStorage.setItem(SEEN_KEY(), String(ts || Date.now())); } catch (e) { /* */ }
}

function setBadge(id, count) {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = count > 99 ? '99+' : count;
    el.style.display = count ? 'flex' : 'none';
}

/** Рахує непрочитані, не відкриваючи чат. Свої повідомлення не рахуємо. */
export async function refreshChatBadge() {
    try {
        const snap = await getDocs(query(collection(db, 'chat'), orderBy('createdAt', 'desc'), limit(LIMIT)));
        const seen = lastSeen();
        const unread = snap.docs.filter(d => {
            const m = d.data();
            if (String(m.apt) === String(session.apt)) return false;
            return timeOf(m) > seen;
        }).length;
        setBadge('chatMenuBadge', unread);
        setBadge('adminChatBadge', unread);
        const { updateNavBadge } = await import('./ui.js');
        updateNavBadge();
    } catch (e) {
        console.warn('Лічильник чату:', e);
        setBadge('chatMenuBadge', 0);
        setBadge('adminChatBadge', 0);
    }
}

// ------------------------------------------------------------
// ДАТИ
// ------------------------------------------------------------
function asDate(ts) {
    if (!ts) return null;
    if (ts.toDate) return ts.toDate();
    if (ts instanceof Date) return ts;
    const d = new Date(ts);
    return Number.isNaN(d.getTime()) ? null : d;
}

function timeOf(m) { return asDate(m?.createdAt)?.getTime() || 0; }

function dayKey(ts) {
    const d = asDate(ts);
    return d ? `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}` : '';
}

function formatClock(ts) {
    const d = asDate(ts);
    return d ? d.toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit' }) : '';
}

function formatDayLabel(ts) {
    const d = asDate(ts);
    if (!d) return '';
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const that = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    const diff = Math.round((today - that) / 86400000);
    if (diff === 0) return 'Сьогодні';
    if (diff === 1) return 'Вчора';
    const opts = { day: 'numeric', month: 'long' };
    if (d.getFullYear() !== now.getFullYear()) opts.year = 'numeric';
    return d.toLocaleDateString('uk-UA', opts);
}

// ------------------------------------------------------------
// БУЛЬБАШКА
// ------------------------------------------------------------
const GROUP_MS = 5 * 60 * 1000;
const isMine = (m) => String(m.apt) === String(session.apt);

/** Чи це продовження серії від того самого відправника. */
function sameGroup(a, b) {
    if (!a || !b || a.deleted || b.deleted) return false;
    if (String(a.apt) !== String(b.apt)) return false;
    if ((a.isBoard === true) !== (b.isBoard === true)) return false;
    const ta = timeOf(a), tb = timeOf(b);
    return ta && tb && Math.abs(tb - ta) < GROUP_MS && dayKey(a.createdAt) === dayKey(b.createdAt);
}

function hasBody(m) {
    return !!(m.deleted || (m.text || '').trim() || (m.attachments || []).length || m.replyTo);
}

const ICON = {
    clock: '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><circle cx="8" cy="8" r="6.2"/><path d="M8 4.6V8l2.2 1.4"/></svg>',
    sent: '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3.2 8.4l3 3 6.6-7"/></svg>',
    fail: '<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor"><circle cx="8" cy="8" r="7"/><path d="M8 4.2v4.6" stroke="#fff" stroke-width="1.8" stroke-linecap="round"/><circle cx="8" cy="11.4" r="1" fill="#fff"/></svg>'
};

function chatPhotos(files, id) {
    const imgs = (files || []).filter(f => isImageFile(f) && safeFileUrl(f.url));
    if (!imgs.length) return '';
    const cls = imgs.length === 1 ? 'chat-photos-one' : '';
    return `<div class="chat-photos ${cls}" data-photos="${id}">
        ${imgs.map((f, i) => `<button type="button" class="chat-photo" data-i="${i}" aria-label="Відкрити фото">
            <img src="${escapeHtml(safeFileUrl(f.url))}" loading="lazy" decoding="async" alt="">
        </button>`).join('')}
    </div>`;
}

function chatDocs(files, id) {
    const docs = (files || []).filter(f => !isImageFile(f));
    if (!docs.length) return '';
    return `<div class="chat-docs" data-docs="${id}">
        ${docs.map((d, i) => {
            const kind = getDocKind(d);
            return `<button type="button" class="chat-doc" data-i="${i}">
                <span class="file-icon icon-${kind} file-icon-sm">${docIconSvg(kind)}</span>
                <span class="chat-doc-name">${escapeHtml(d.name || 'Документ')}</span>
            </button>`;
        }).join('')}
    </div>`;
}

/** Файли, що ще вантажаться: лише назви й кількість — посилань поки немає. */
function uploadingFiles(files) {
    if (!files?.length) return '';
    return `<div class="chat-uploading">
        <span class="chat-spinner" aria-hidden="true"></span>
        ${files.length === 1 ? escapeHtml(files[0].name) : `${files.length} файли`}
    </div>`;
}

function quoteBlock(r) {
    if (!r) return '';
    const who = r.isBoard ? 'Правління ОСББ' : `Кв. ${escapeHtml(String(r.apt))}`;
    return `<button type="button" class="chat-quote" data-jump="${escapeHtml(r.id)}">
        <span class="chat-quote-who">${who}</span>
        <span class="chat-quote-text">${escapeHtml(r.text || 'вкладення')}</span>
    </button>`;
}

/** Час і стан доставки. Стан показуємо лише на своїх повідомленнях. */
function metaHtml(item) {
    const m = item.data;
    if (item.failed) {
        return `<span class="chat-meta chat-meta-fail">${ICON.fail}Не надіслано · повторити</span>`;
    }
    let state = '';
    if (isMine(m)) {
        const waiting = item.pending || item.uploading;
        state = `<span class="chat-state${waiting ? ' is-wait' : ''}" aria-label="${waiting ? 'Надсилається' : 'Надіслано'}">${waiting ? ICON.clock : ICON.sent}</span>`;
    }
    return `<span class="chat-meta">${m.editedAt ? '<span class="chat-edited-mark">змінено</span>' : ''}${escapeHtml(formatClock(m.createdAt))}${state}</span>`;
}

function bubbleHtml(item, showAuthor) {
    const m = item.data;
    if (m.deleted) {
        return `<div class="chat-bubble chat-removed">
            <p class="chat-text">${m.deletedByBoard ? 'Повідомлення видалено правлінням' : 'Повідомлення видалено'}</p>
        </div>`;
    }
    const author = m.isBoard ? 'Правління ОСББ' : `Кв. ${escapeHtml(String(m.apt))}`;
    return `<div class="chat-bubble" data-menu="${escapeHtml(item.id)}">
        ${showAuthor ? `<span class="chat-author">${author}</span>` : ''}
        ${quoteBlock(m.replyTo)}
        ${chatPhotos(m.attachments, item.id)}
        ${chatDocs(m.attachments, item.id)}
        ${item.uploading ? uploadingFiles(item.files) : ''}
        <div class="chat-run">${m.text ? `<span class="chat-text">${escapeHtml(m.text)}</span>` : ''}${metaHtml(item)}</div>
    </div>`;
}

/**
 * Відбиток повідомлення: якщо він не змінився, вузол лишається тим
 * самим. Сюди входить усе, що впливає на вигляд, — зокрема сусід
 * зверху (від нього залежить, чи підписувати автора).
 */
function signature(item, grouped, showAuthor) {
    const m = item.data;
    return [
        m.deleted ? 'd' : '', m.deletedByBoard ? 'b' : '', m.text || '', m.editedAt ? 'e' : '',
        item.pending ? 'p' : '', item.failed ? 'f' : '', item.uploading ? 'u' : '',
        (m.attachments || []).map(f => f.url).join(','), formatClock(m.createdAt),
        grouped ? 'g' : '', showAuthor ? 'a' : '', m.replyTo?.id || ''
    ].join('|');
}

function buildMessage(item, grouped, showAuthor) {
    const m = item.data;
    const node = document.createElement('div');
    node.className = 'chat-msg'
        + (isMine(m) ? ' chat-mine' : '')
        + (m.isBoard && !m.deleted ? ' chat-board' : '')
        + (grouped ? ' chat-grouped' : '')
        + (item.failed ? ' chat-failed' : '');
    node.dataset.id = item.id;
    node.innerHTML = bubbleHtml(item, showAuthor);
    return node;
}

function wireMessage(node, item, ctx) {
    const m = item.data;
    if (item.failed) {
        node.addEventListener('click', (e) => { e.stopPropagation(); retryFailed(item.id); });
        return;
    }
    if (m.deleted || item.uploading) return;

    const imgs = (m.attachments || []).filter(f => isImageFile(f) && safeFileUrl(f.url));
    node.querySelectorAll('.chat-photo').forEach(b => {
        b.addEventListener('click', (e) => {
            e.stopPropagation();
            openGallery(imgs, parseInt(b.dataset.i, 10));
        });
    });
    const docs = (m.attachments || []).filter(f => !isImageFile(f));
    node.querySelectorAll('.chat-doc').forEach(b => {
        b.addEventListener('click', (e) => {
            e.stopPropagation();
            openDocViewer(docs[parseInt(b.dataset.i, 10)]);
        });
    });
    node.querySelectorAll('.chat-quote').forEach(q => {
        q.addEventListener('click', (e) => {
            e.stopPropagation();
            jumpTo(node.closest('.chat-list'), q.dataset.jump);
        });
    });
    const bubble = node.querySelector('.chat-bubble[data-menu]');
    if (bubble && !item.pending) attachLongPress(bubble, () => openActions(item, ctx));
}

function dayRow(ts) {
    const el = document.createElement('div');
    el.className = 'chat-day';
    el.innerHTML = `<span>${escapeHtml(formatDayLabel(ts))}</span>`;
    return el;
}

function unreadRow() {
    const el = document.createElement('div');
    el.className = 'chat-unread';
    el.innerHTML = '<span>Нові повідомлення</span>';
    return el;
}

/**
 * Перетворює список повідомлень на рядки стрічки: роздільники днів,
 * «Нові повідомлення» і самі бульбашки. Кожен рядок має ключ і відбиток.
 */
function toRows(items, unreadId) {
    const rows = [];
    let prev = null;
    items.filter(i => hasBody(i.data) || i.uploading || i.failed).forEach(item => {
        const m = item.data;
        const day = dayKey(m.createdAt);
        if (day && day !== dayKey(prev?.createdAt)) {
            const label = formatDayLabel(m.createdAt);
            rows.push({ key: 'day-' + day, sig: label, build: () => dayRow(m.createdAt) });
        }
        if (item.id === unreadId) rows.push({ key: 'unread', sig: '', build: unreadRow });
        const grouped = item.id !== unreadId && sameGroup(prev, m);
        const showAuthor = !isMine(m) && !grouped && !m.deleted;
        rows.push({
            key: item.id, item,
            sig: signature(item, grouped, showAuthor),
            build: () => buildMessage(item, grouped, showAuthor)
        });
        prev = m;
    });
    return rows;
}

/**
 * Приводить вміст контейнера до потрібного списку рядків, чіпаючи
 * лише те, що справді змінилося. Повертає нові вузли повідомлень.
 */
function reconcile(box, rows, ctx) {
    const byKey = new Map();
    [...box.children].forEach(n => { if (n.dataset.key) byKey.set(n.dataset.key, n); });
    const used = new Set();
    const created = [];
    let cursor = box.firstElementChild;

    rows.forEach(row => {
        let node = byKey.get(row.key);
        if (!node || node.dataset.sig !== row.sig) {
            const fresh = row.build();
            fresh.dataset.key = row.key;
            fresh.dataset.sig = row.sig;
            if (row.item) wireMessage(fresh, row.item, ctx);
            if (node) {
                node.replaceWith(fresh);
                if (cursor === node) cursor = fresh;
            } else if (row.item) {
                created.push({ node: fresh, item: row.item });
            }
            node = fresh;
        }
        used.add(node);
        if (node === cursor) cursor = cursor.nextElementSibling;
        else box.insertBefore(node, cursor);
    });

    [...box.children].forEach(n => { if (!used.has(n)) n.remove(); });
    return created;
}

// ------------------------------------------------------------
// ПРОКРУТКА
//
// «Прилипання» до низу: поки мешканець унизу, будь-яка зміна висоти
// (нове повідомлення, клавіатура, фото довантажилось) тримає низ.
// Коли він читає давніше, запамʼятовуємо повідомлення вгорі екрана
// і після змін повертаємо його рівно туди, де воно було.
// ------------------------------------------------------------
const feed = {
    host: null, box: null,
    stick: true, anchor: null,
    firstPaint: true, unreadId: null,
    known: new Set(), missed: 0,
    ro: null
};

function distanceToEnd(host) {
    return host.scrollHeight - host.scrollTop - host.clientHeight;
}

function captureAnchor() {
    const { host, box } = feed;
    if (!host || !box) return;
    const top = host.getBoundingClientRect().top;
    const el = [...box.children].find(n => n.getBoundingClientRect().bottom > top + 4);
    feed.anchor = el ? { el, offset: el.getBoundingClientRect().top - top } : null;
}

/** Після будь-яких змін: або до низу, або повертаємо якір на місце. */
function holdPosition() {
    const { host } = feed;
    if (!host) return;
    if (feed.stick) {
        const end = host.scrollHeight - host.clientHeight;
        if (Math.abs(host.scrollTop - end) > 1) host.scrollTop = end;
        return;
    }
    const a = feed.anchor;
    if (!a?.el?.isConnected) return;
    const delta = a.el.getBoundingClientRect().top - host.getBoundingClientRect().top - a.offset;
    if (Math.abs(delta) > 0.5) host.scrollTop += delta;
}

function onFeedScroll() {
    const { host } = feed;
    if (!host) return;
    feed.stick = distanceToEnd(host) < 32;
    captureAnchor();
    if (feed.stick) {
        feed.missed = 0;
        markAllSeen();
    }
    syncJumpBtn();
}

function syncJumpBtn() {
    const btn = document.getElementById('chatJumpDown');
    if (!btn || !feed.host) return;
    btn.hidden = distanceToEnd(feed.host) < 240 && !feed.missed;
    const n = btn.querySelector('.chat-jump-count');
    if (n) {
        n.textContent = feed.missed > 99 ? '99+' : String(feed.missed);
        n.hidden = !feed.missed;
    }
}

function scrollToEnd(smooth) {
    const { host } = feed;
    if (!host) return;
    feed.stick = true;
    feed.missed = 0;
    if (smooth) host.scrollTo({ top: host.scrollHeight, behavior: 'smooth' });
    else host.scrollTop = host.scrollHeight;
    markAllSeen();
    syncJumpBtn();
}

/** Прокручує до повідомлення й підсвічує його. */
function jumpTo(host, id) {
    const el = host?.querySelector(`.chat-msg[data-id="${CSS.escape(id)}"]`);
    if (!el) return toast('Це повідомлення вже поза межами стрічки', 'info');
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.classList.remove('chat-flash');
    void el.offsetWidth;
    el.classList.add('chat-flash');
}

// ------------------------------------------------------------
// ДОВГЕ НАТИСКАННЯ
// На дотику немає ні наведення, ні правої кнопки, тож меню
// викликається утриманням. Рух пальцем скасовує: інакше меню
// вискакувало б посеред прокрутки.
// ------------------------------------------------------------
const HOLD_MS = 320;

function attachLongPress(el, onHold) {
    let timer = null, startY = 0;
    const release = () => {
        clearTimeout(timer);
        timer = null;
        el.classList.remove('chat-pressed');
    };
    el.addEventListener('touchstart', (e) => {
        startY = e.touches[0].clientY;
        el.classList.add('chat-pressed');
        timer = setTimeout(() => {
            el.classList.remove('chat-pressed');
            taptic(8);
            onHold();
        }, HOLD_MS);
    }, { passive: true });
    el.addEventListener('touchmove', (e) => {
        if (Math.abs(e.touches[0].clientY - startY) > 8) release();
    }, { passive: true });
    el.addEventListener('touchend', release);
    el.addEventListener('touchcancel', release);
    el.addEventListener('contextmenu', (e) => { e.preventDefault(); onHold(); });
}

// ------------------------------------------------------------
// МЕНЮ ДІЙ
// ------------------------------------------------------------
function closeActions() {
    document.getElementById('actionSheet')?.remove();
    document.getElementById('actionBackdrop')?.remove();
}

function openActions(item, ctx) {
    closeActions();
    const m = item.data;
    if (item.pending || item.failed || item.uploading) return;
    document.getElementById(ctx.input)?.blur();
    const mine = isMine(m);
    const actions = [
        { id: 'reply', label: 'Відповісти', icon: 'M9 17l-6-6 6-6M3 11h11a6 6 0 0 1 6 6v2' },
        m.text ? { id: 'copy', label: 'Копіювати', icon: 'M9 9h13v13H9zM5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1' } : null,
        mine ? { id: 'edit', label: 'Змінити', icon: 'M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z' } : null,
        (mine || session.isAdmin) ? { id: 'delete', label: 'Видалити', icon: 'M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2', danger: true } : null
    ].filter(Boolean);

    const back = document.createElement('div');
    back.id = 'actionBackdrop';
    back.className = 'action-backdrop';
    document.body.appendChild(back);

    const sheet = document.createElement('div');
    sheet.id = 'actionSheet';
    sheet.className = 'action-sheet';
    sheet.innerHTML = `
        <div class="action-preview">${escapeHtml((m.text || 'Вкладення').slice(0, 90))}</div>
        ${actions.map(a => `
            <button type="button" class="action-row${a.danger ? ' action-danger' : ''}" data-act="${a.id}">
                <svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="${a.icon}"></path></svg>
                ${a.label}
            </button>`).join('')}
        <button type="button" class="action-row action-cancel" data-act="cancel">Скасувати</button>`;
    document.body.appendChild(sheet);

    // Меню зʼявляється, поки палець ще на екрані. Без паузи те саме
    // відпускання натискало б пункт, що опинився під пальцем.
    let armed = false;
    setTimeout(() => { armed = true; sheet.classList.add('action-armed'); }, 240);

    back.addEventListener('click', () => { if (armed) closeActions(); });
    sheet.querySelectorAll('.action-row').forEach(btn => {
        btn.addEventListener('click', () => {
            if (!armed) return;
            const act = btn.dataset.act;
            closeActions();
            if (act === 'reply') startReply(item, ctx);
            if (act === 'copy') copyMessage(m);
            if (act === 'edit') startEdit(item, ctx);
            if (act === 'delete') softDelete(item, ctx);
        });
    });
}

async function copyMessage(m) {
    try {
        await navigator.clipboard.writeText(m.text || '');
        toast('Скопійовано', 'success');
    } catch (e) {
        toast('Не вдалося скопіювати', 'error');
    }
}

// ------------------------------------------------------------
// ВІДПОВІДЬ І РЕДАГУВАННЯ
// ------------------------------------------------------------
const compose = {
    chat: { reply: null, edit: null },
    comments: { reply: null, edit: null }
};

function startReply(item, ctx) {
    compose[ctx.key].edit = null;
    compose[ctx.key].reply = {
        id: item.id,
        apt: item.data.apt,
        isBoard: item.data.isBoard === true,
        text: (item.data.text || '').slice(0, 120)
    };
    renderComposeContext(ctx);
    document.getElementById(ctx.input)?.focus();
    settleChatViewport();
}

function startEdit(item, ctx) {
    compose[ctx.key].reply = null;
    compose[ctx.key].edit = { id: item.id };
    const input = document.getElementById(ctx.input);
    if (input) {
        input.value = item.data.text || '';
        input.dispatchEvent(new Event('input'));
        input.focus();
    }
    renderComposeContext(ctx);
    settleChatViewport();
}

export function cancelCompose(ctx) {
    compose[ctx.key].reply = null;
    compose[ctx.key].edit = null;
    const input = document.getElementById(ctx.input);
    if (input) { input.value = ''; input.style.height = ''; }
    renderComposeContext(ctx);
    syncSendState();
}

function renderComposeContext(ctx) {
    const host = document.getElementById(ctx.context);
    if (!host) return;
    const st = compose[ctx.key];
    if (!st.edit && !st.reply) { host.hidden = true; host.innerHTML = ''; return; }
    host.hidden = false;
    host.innerHTML = `
        <span class="compose-ctx-bar"></span>
        <span class="compose-ctx-text">
            <b>${st.edit ? 'Редагування' : (st.reply.isBoard ? 'Правління ОСББ' : 'Кв. ' + escapeHtml(String(st.reply.apt)))}</b>
            <small>${escapeHtml(st.edit ? 'змініть текст і надішліть' : (st.reply.text || 'вкладення'))}</small>
        </span>
        <button type="button" class="compose-ctx-close" aria-label="Скасувати">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M18 6L6 18M6 6l12 12"></path></svg>
        </button>`;
    host.querySelector('.compose-ctx-close').addEventListener('click', () => cancelCompose(ctx));
}

async function softDelete(item, ctx) {
    const ok = await confirmDialog('Видалити повідомлення?',
        'Текст зникне, а в розмові лишиться позначка, що повідомлення видалено.');
    if (!ok) return;
    try {
        await updateDoc(doc(db, ...ctx.path, item.id), {
            deleted: true,
            deletedAt: serverTimestamp(),
            deletedByBoard: session.isAdmin === true && !isMine(item.data),
            text: '',
            attachments: []
        });
    } catch (e) {
        console.error('Видалення:', e.code, e);
        toast(explain(e, 'Не вдалося видалити'), 'error');
    }
}

// ------------------------------------------------------------
// ЧАТ БУДИНКУ
// ------------------------------------------------------------
const CTX_CHAT = {
    key: 'chat', path: ['chat'],
    list: 'chatList', input: 'chatInput', context: 'chatComposeCtx',
    files: 'chatFiles', preview: 'chatFilesPreview'
};
// Чат один на всіх — і мешканці, і правління користуються тим самим
// повноекранним чатом. Підпис «Правління ОСББ» береться з сесії.
const ctxComments = (msgId) => ({
    key: 'comments', path: ['messages', msgId, 'comments'],
    input: 'commentInput', context: 'commentComposeCtx',
    empty: '<p class="list-empty">Коментарів ще немає</p>'
});

let unsubscribe = null;
let serverItems = [];
// Свої повідомлення, яких ще немає в базі: з файлами, що вантажаться,
// або ті, що сервер відхилив. Ключ — той самий id, під яким документ
// потім зʼявиться в базі, тож заміна відбувається без дублів.
const localItems = new Map();
let pendingFiles = [];

function allItems() {
    const ids = new Set(serverItems.map(i => i.id));
    localItems.forEach((item, id) => { if (ids.has(id) && !item.failed) localItems.delete(id); });
    const extra = [...localItems.values()].filter(i => !ids.has(i.id));
    if (!extra.length) return serverItems;
    return serverItems.concat(extra).sort((a, b) => timeOf(a.data) - timeOf(b.data));
}

// Прокрутка біля низу викликає це на кожному кадрі — лічильники
// скидаємо лише тоді, коли справді зʼявилося щось нове.
let badgesCleared = false;
function markAllSeen() {
    const newest = serverItems.length ? timeOf(serverItems[serverItems.length - 1].data) : 0;
    if (newest && newest > lastSeen()) markSeen(newest);
    else if (badgesCleared) return;
    badgesCleared = true;
    setBadge('chatMenuBadge', 0);
    setBadge('adminChatBadge', 0);
    import('./ui.js').then(m => m.updateNavBadge()).catch(() => {});
}

function chatVisible() {
    const sec = document.getElementById('chatSection');
    return !!sec && sec.style.display !== 'none' && document.visibilityState === 'visible';
}

function paintChat() {
    const { host, box } = feed;
    if (!host || !box) return;
    const items = allItems();

    if (!items.length) {
        box.innerHTML = '<p class="list-empty chat-empty">Повідомлень ще немає.<br>Напишіть перше — його побачать усі сусіди.</p>';
        feed.firstPaint = false;
        return;
    }
    box.querySelector('.list-empty')?.remove();

    // Перше малювання: з якого місця відкривати
    if (feed.firstPaint) {
        const seen = lastSeen();
        const first = items.find(i => !isMine(i.data) && !i.data.deleted && timeOf(i.data) > seen);
        feed.unreadId = first?.id || null;
    } else if (!feed.stick) {
        captureAnchor();
    }

    const created = reconcile(box, toRows(items, feed.unreadId), CTX_CHAT);

    if (feed.firstPaint) {
        feed.firstPaint = false;
        items.forEach(i => feed.known.add(i.id));
        const divider = box.querySelector('.chat-unread');
        if (divider) {
            // Відкриваємо на першому непрочитаному: роздільник — угорі екрана
            host.scrollTop += divider.getBoundingClientRect().top - host.getBoundingClientRect().top - 6;
            feed.stick = distanceToEnd(host) < 32;
            captureAnchor();
        } else {
            host.scrollTop = host.scrollHeight;
            feed.stick = true;
        }
        if (feed.stick) markAllSeen();
        syncJumpBtn();
        return;
    }

    // Нові повідомлення: анімація, звук, лічильник на кнопці «вниз»
    let mineNew = false, othersNew = 0;
    created.forEach(({ node, item }) => {
        if (feed.known.has(item.id)) return;
        feed.known.add(item.id);
        node.classList.add(isMine(item.data) ? 'chat-in-mine' : 'chat-in');
        if (isMine(item.data)) mineNew = true;
        else othersNew++;
    });

    if (mineNew) feed.stick = true;               // своє — завжди показуємо
    if (othersNew) {
        if (!feed.stick) feed.missed += othersNew;
        if (chatVisible()) playReceive();
    }
    holdPosition();
    if (feed.stick) markAllSeen();
    syncJumpBtn();
}

export function loadChat() {
    const host = document.getElementById(CTX_CHAT.list);
    if (!host) return;
    ensureFeed(host);
    lockForeignFields(true);
    queueViewportSync();
    stopChat(false);
    primeAudio();

    feed.firstPaint = true;
    feed.unreadId = null;
    feed.known = new Set();
    feed.missed = 0;
    feed.stick = true;
    badgesCleared = false;
    if (!feed.box.querySelector('.chat-msg')) {
        feed.box.innerHTML = '<p class="list-empty chat-empty">Завантаження…</p>';
    }

    // includeMetadataChanges — щоб дізнатися момент, коли сервер
    // підтвердив запис: тоді годинник на повідомленні стає галочкою.
    unsubscribe = onSnapshot(
        query(collection(db, 'chat'), orderBy('createdAt', 'desc'), limit(LIMIT)),
        { includeMetadataChanges: true },
        (snap) => {
            // «estimate»: поки сервер не поставив час, беремо локальний.
            // Інакше неперевірене повідомлення не мало б дати — і
            // зʼявлялися порожні роздільники й бульбашки без часу.
            serverItems = snap.docs.map(d => ({
                id: d.id,
                data: d.data({ serverTimestamps: 'estimate' }),
                pending: d.metadata.hasPendingWrites
            })).reverse();
            paintChat();
        },
        (e) => {
            console.error('Чат:', e);
            feed.box.innerHTML = '<p class="list-empty chat-empty">Не вдалося завантажити чат</p>';
        }
    );
}

export function stopChat(unlock = true) {
    if (unsubscribe) { unsubscribe(); unsubscribe = null; }
    closeActions();
    if (unlock) {
        lockForeignFields(false);
        document.getElementById('chatInput')?.blur();
    }
}

/** Стрічка всередині прокрутки: її висоту стежить ResizeObserver. */
function ensureFeed(host) {
    if (feed.host === host && feed.box?.isConnected) return;
    let box = host.querySelector(':scope > .chat-feed');
    if (!box) {
        box = document.createElement('div');
        box.className = 'chat-feed';
        box.append(...host.childNodes);
        host.appendChild(box);
    }
    feed.host = host;
    feed.box = box;
    if ('ResizeObserver' in window) {
        feed.ro?.disconnect();
        // Змінилась висота стрічки (фото, нове повідомлення) або самого
        // вікна (клавіатура) — тримаємо позицію.
        feed.ro = new ResizeObserver(() => holdPosition());
        feed.ro.observe(box);
        feed.ro.observe(host);
    }
}

// ------------------------------------------------------------
// НАДСИЛАННЯ
// ------------------------------------------------------------
function refreshChips() {
    renderFileManager(
        document.getElementById(CTX_CHAT.preview),
        [], pendingFiles,
        () => {},
        (i) => { pendingFiles.splice(i, 1); refreshChips(); }
    );
    syncSendState();
}

function syncSendState() {
    const input = document.getElementById('chatInput');
    const btn = document.getElementById('chatSendBtn');
    if (!btn) return;
    const ready = !!(input?.value.trim() || pendingFiles.length);
    btn.classList.toggle('is-ready', ready);
    btn.setAttribute('aria-disabled', ready ? 'false' : 'true');
}

async function uploadFiles(files) {
    const attachments = [];
    for (const file of files) {
        const fileRef = sRef(storage, `chat/${session.apt}/${Date.now()}_${file.name}`);
        await uploadBytes(fileRef, file);
        attachments.push({
            name: file.name, url: await getDownloadURL(fileRef),
            type: file.type || '', size: file.size || 0
        });
    }
    return attachments;
}

/**
 * Записує повідомлення під заздалегідь відомим id. Текст зʼявляється в
 * стрічці одразу (Firestore показує запис до відповіді сервера), файли —
 * заглушкою, поки вантажаться.
 */
async function deliver(id, text, files, replyTo, uploaded) {
    const base = {
        apt: String(session.apt),
        isBoard: session.isAdmin === true,
        text,
        replyTo: replyTo || null
    };
    let attachments = uploaded || [];
    try {
        if (files.length && !uploaded) {
            localItems.set(id, {
                id, uploading: true, files,
                data: { ...base, attachments: [], createdAt: new Date() }
            });
            paintChat();
            attachments = await uploadFiles(files);
        }
        await setDoc(doc(db, 'chat', id), { ...base, attachments, createdAt: serverTimestamp() });
        localItems.delete(id);
    } catch (e) {
        console.error('Надсилання в чат:', e.code, e);
        const was = localItems.get(id);
        localItems.set(id, {
            id, failed: true, files, uploaded: attachments.length ? attachments : null,
            data: { ...base, attachments: [], createdAt: was?.data.createdAt || new Date() }
        });
        paintChat();
        toast(explain(e, 'Не вдалося надіслати'), 'error');
    }
}

function retryFailed(id) {
    const item = localItems.get(id);
    if (!item?.failed) return;
    localItems.delete(id);
    const { text, replyTo } = item.data;
    // Новий id: попередній запис сервер уже відхилив.
    deliver(doc(collection(db, 'chat')).id, text, item.files || [], replyTo, item.uploaded);
    paintChat();
}

async function sendChat() {
    const input = document.getElementById(CTX_CHAT.input);
    const text = (input.value || '').trim();
    const st = compose.chat;

    if (!text && !pendingFiles.length) return;
    if (text.length > 2000) return toast('Повідомлення задовге — до 2000 символів', 'error');
    if (!session.apt) return toast('Сесія втрачена. Увійдіть знову.', 'error');
    if (!text) return toast('Додайте до файлів кілька слів', 'error');

    primeAudio();
    taptic(7);

    if (st.edit) {
        const editId = st.edit.id;
        cancelCompose(CTX_CHAT);
        playSend();
        try {
            await updateDoc(doc(db, 'chat', editId), { text, editedAt: serverTimestamp() });
        } catch (e) {
            toast(explain(e, 'Не вдалося змінити'), 'error');
        }
        return;
    }

    const files = pendingFiles.slice();
    const replyTo = st.reply || null;
    pendingFiles = [];
    refreshChips();
    cancelCompose(CTX_CHAT);
    playSend();
    scrollToEnd(false);

    deliver(doc(collection(db, 'chat')).id, text, files, replyTo);
}

// ------------------------------------------------------------
// КОМЕНТАРІ ПІД ОГОЛОШЕННЯМ
// ------------------------------------------------------------
let commentsUnsub = null;
let currentMsgId = null;

export function openComments(msgId, isForAll) {
    currentMsgId = msgId;
    compose.comments = { reply: null, edit: null };
    renderComposeContext(ctxComments(msgId));
    const box = document.getElementById('msgComments');
    if (!box) return;
    stopComments();

    // Під адресним оголошенням коментарів немає: правила їх і не
    // віддадуть, тож не показуємо форму, якої не можна використати.
    if (!isForAll) {
        box.hidden = true;
        return;
    }
    box.hidden = false;

    const host = document.getElementById('commentsList');
    host.innerHTML = '<p class="list-empty">Завантаження…</p>';
    const ctx = ctxComments(msgId);

    commentsUnsub = onSnapshot(
        query(collection(db, 'messages', msgId, 'comments'), orderBy('createdAt', 'asc'), limit(LIMIT)),
        { includeMetadataChanges: true },
        (snap) => {
            const items = snap.docs.map(d => ({
                id: d.id,
                data: d.data({ serverTimestamps: 'estimate' }),
                pending: d.metadata.hasPendingWrites
            }));
            if (!items.length) { host.innerHTML = ctx.empty; return; }
            host.querySelector('.list-empty')?.remove();
            const atEnd = distanceToEnd(host) < 40;
            reconcile(host, toRows(items, null), ctx);
            if (atEnd) host.scrollTop = host.scrollHeight;
        },
        (e) => {
            console.error('Коментарі:', e);
            host.innerHTML = '<p class="list-empty">Не вдалося завантажити коментарі</p>';
        }
    );
}

export function stopComments() {
    if (commentsUnsub) { commentsUnsub(); commentsUnsub = null; }
    closeActions();
}

async function sendComment(btn) {
    const input = document.getElementById('commentInput');
    const text = input.value.trim();
    const st = compose.comments;

    if (!text || !currentMsgId) return;
    if (text.length > 2000) return toast('Коментар задовгий', 'error');
    if (!session.apt) return toast('Сесія втрачена. Увійдіть знову.', 'error');

    const ctx = ctxComments(currentMsgId);
    setBusy(btn, true, '');
    try {
        if (st.edit) {
            await updateDoc(doc(db, ...ctx.path, st.edit.id), { text, editedAt: serverTimestamp() });
        } else {
            await addDoc(collection(db, ...ctx.path), {
                apt: String(session.apt),
                isBoard: session.isAdmin === true,
                text, attachments: [],
                replyTo: st.reply || null,
                createdAt: serverTimestamp()
            });
        }
        cancelCompose(ctx);
        playSend();
    } catch (e) {
        console.error('Коментар:', e.code, e);
        toast(explain(e, 'Не вдалося надіслати коментар'), 'error');
    } finally {
        setBusy(btn, false);
    }
}

// ------------------------------------------------------------
// ІНІЦІАЛІЗАЦІЯ
// ------------------------------------------------------------
function autoGrow(el) {
    el?.addEventListener('input', function () {
        this.style.height = 'auto';
        this.style.height = Math.min(this.scrollHeight, 132) + 'px';
        syncSendState();
    });
}

function ensureJumpButton(list) {
    if (!list || document.getElementById('chatJumpDown')) return;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.id = 'chatJumpDown';
    btn.className = 'chat-jump';
    btn.hidden = true;
    btn.setAttribute('aria-label', 'До останніх повідомлень');
    btn.innerHTML = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>'
        + '<span class="chat-jump-count" hidden></span>';
    list.after(btn);
}

/**
 * Кнопка «Надіслати» не повинна забирати фокус у поля вводу: інакше
 * на iPhone клавіатура ховалася б і одразу виїжджала знову — саме це
 * й смикало екран після кожного повідомлення.
 */
function bindSendButton(btn, onSend) {
    if (!btn) return;
    btn.addEventListener('mousedown', (e) => e.preventDefault());
    btn.addEventListener('touchend', (e) => {
        const t = e.changedTouches[0];
        const r = btn.getBoundingClientRect();
        e.preventDefault();          // без синтетичного click і без втрати фокусу
        if (t.clientX >= r.left - 8 && t.clientX <= r.right + 8
            && t.clientY >= r.top - 8 && t.clientY <= r.bottom + 8) onSend();
    });
    btn.addEventListener('click', onSend);   // миша й клавіатура
}

export function initChat() {
    const vv = window.visualViewport;
    if (vv) {
        vv.addEventListener('resize', queueViewportSync);
        vv.addEventListener('scroll', queueViewportSync);
    }
    window.addEventListener('resize', queueViewportSync);

    const list = document.getElementById('chatList');
    const input = document.getElementById('chatInput');
    if (list) ensureFeed(list);
    ensureJumpButton(list);

    bindSendButton(document.getElementById('chatSendBtn'), () => sendChat());
    document.getElementById('commentSendBtn')?.addEventListener('click', function () { sendComment(this); });

    autoGrow(input);
    autoGrow(document.getElementById('commentInput'));

    input?.addEventListener('focus', () => {
        lockForeignFields(true);
        settleChatViewport();
    });
    input?.addEventListener('blur', settleChatViewport);
    // На компʼютері Enter надсилає, Shift+Enter — новий рядок.
    // На телефоні Enter — завжди новий рядок, як у месенджерах.
    input?.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' || e.shiftKey || e.isComposing) return;
        if (window.matchMedia('(pointer: coarse)').matches) return;
        e.preventDefault();
        sendChat();
    });

    if (list) {
        list.addEventListener('scroll', onFeedScroll, { passive: true });

        // Натискання на стрічку ховає клавіатуру — як у месенджерах
        list.addEventListener('click', () => {
            if (document.activeElement === input) input.blur();
        });
        // І жест «потягнути стрічку вниз» теж — щоб читати давніше
        let startY = null;
        list.addEventListener('touchstart', (e) => { startY = e.touches[0].clientY; }, { passive: true });
        list.addEventListener('touchmove', (e) => {
            if (startY === null || document.activeElement !== input) return;
            if (e.touches[0].clientY - startY > 24) { input.blur(); startY = null; }
        }, { passive: true });
        list.addEventListener('touchend', () => { startY = null; }, { passive: true });
    }

    document.getElementById('chatJumpDown')?.addEventListener('click', () => scrollToEnd(true));

    document.getElementById('chatFiles')?.addEventListener('change', () => {
        const files = document.getElementById('chatFiles');
        pendingFiles.push(...Array.from(files.files));
        files.value = '';
        if (pendingFiles.length > MAX_FILES) {
            pendingFiles = pendingFiles.slice(0, MAX_FILES);
            toast(`Не більше ${MAX_FILES} файлів в одному повідомленні`, 'error');
        }
        refreshChips();
    });

    // Повернулися в застосунок — мітки «сьогодні/вчора» могли застаріти
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible' && unsubscribe) paintChat();
    });

    syncSendState();
}
