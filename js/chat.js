// ============================================================
// Чат будинку та коментарі під оголошеннями.
//
// Підписуються КВАРТИРИ, а не люди: вхід у застосунку за номером
// квартири, і в однієї квартири часто двоє співласників з одним
// паролем. Тому автор — «Кв. 298», і за слово відповідає квартира.
//
// Позначку «Правління» перевіряють правила Firestore, а не код:
// інакше через DevTools можна було б видати себе за правління.
// ============================================================
import { db, storage, session } from './firebase.js';
import {
    collection, addDoc, updateDoc, doc, onSnapshot, getDocs,
    query, orderBy, limit, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js";
import {
    ref as sRef, uploadBytes, getDownloadURL
} from "https://www.gstatic.com/firebasejs/10.8.1/firebase-storage.js";
import { escapeHtml, toast, setBusy, confirmDialog, safeFileUrl } from './ui.js';
import {
    renderFileManager, openGallery, isImageFile, openDocViewer, getDocKind, docIconSvg
} from './attachments.js';

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

function syncChatHeight() {
    const sec = document.getElementById('chatSection');
    if (!sec || sec.style.display === 'none') return;
    const vv = window.visualViewport;
    if (!vv) { sec.style.height = window.innerHeight + 'px'; sec.style.top = '0px'; return; }
    const h = Math.round(vv.height);
    const t = Math.round(vv.offsetTop);
    if (sec._vvH !== h) { sec.style.height = h + 'px'; sec._vvH = h; }
    if (sec._vvT !== t) { sec.style.top = t + 'px'; sec._vvT = t; }
}

function settleChatViewport() {
    requestAnimationFrame(syncChatHeight);
    [80, 180, 320, 480].forEach(ms => setTimeout(syncChatHeight, ms));
}

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

let audioCtx = null;
function playSend() {
    try {
        const Ctx = window.AudioContext || window.webkitAudioContext;
        if (!Ctx) return;
        audioCtx = audioCtx || new Ctx();
        if (audioCtx.state === 'suspended') audioCtx.resume();
        const t = audioCtx.currentTime;
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(740, t);
        osc.frequency.exponentialRampToValueAtTime(1180, t + 0.06);
        gain.gain.setValueAtTime(0.0001, t);
        gain.gain.exponentialRampToValueAtTime(0.07, t + 0.01);
        gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.13);
        osc.connect(gain).connect(audioCtx.destination);
        osc.start(t);
        osc.stop(t + 0.14);
    } catch (e) { /* звук не має зривати надсилання */ }
}

function taptic(ms = 10) {
    try { if (navigator.vibrate) navigator.vibrate(ms); } catch (e) { /* */ }
}

const LIMIT = 200;
const SEEN_KEY = () => `chat_seen_${session.apt}`;

let unsubscribe = null;
let pendingFiles = [];
const MAX_FILES = 10;
let lastRendered = [];

const compose = {
    chat: { reply: null, edit: null },
    comments: { reply: null, edit: null }
};

function lastSeen() {
    return parseInt(localStorage.getItem(SEEN_KEY()) || '0', 10);
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

export async function refreshChatBadge() {
    try {
        const snap = await getDocs(query(collection(db, 'chat'), orderBy('createdAt', 'desc'), limit(LIMIT)));
        const seen = lastSeen();
        const unread = snap.docs.filter(d => {
            const m = d.data();
            if (String(m.apt) === String(session.apt)) return false;
            const t = m.createdAt?.toDate?.().getTime() || 0;
            return t > seen;
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

function asDate(ts) {
    if (!ts) return null;
    if (ts.toDate) return ts.toDate();
    if (ts instanceof Date) return ts;
    const d = new Date(ts);
    return Number.isNaN(d.getTime()) ? null : d;
}

function dayKey(ts) {
    const d = asDate(ts);
    if (!d) return '';
    return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

function formatClock(ts) {
    const d = asDate(ts);
    if (!d) return '';
    return d.toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit' });
}

function formatDayLabel(ts) {
    const d = asDate(ts);
    if (!d) return '';
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const that = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    const diff = (today - that) / 86400000;
    if (diff === 0) return 'Сьогодні';
    if (diff === 1) return 'Вчора';
    return d.toLocaleDateString('uk-UA', { day: 'numeric', month: 'long' });
}

function sig(m) {
    return [
        m.deleted ? '1' : '0',
        m.text || '',
        m.editedAt ? 'e' : '',
        m.pending ? 'p' : '',
        m.failed ? 'f' : '',
        (m.attachments || []).length
    ].join('|');
}

function chatPhotos(files, id) {
    const imgs = (files || []).filter(f => isImageFile(f) && safeFileUrl(f.url));
    if (!imgs.length) return '';
    const cls = imgs.length === 1 ? 'chat-photos-one' : '';
    return `<div class="chat-photos ${cls}" data-photos="${id}">
        ${imgs.map((f, i) => `<button type="button" class="chat-photo" data-i="${i}">
            <img src="${escapeHtml(safeFileUrl(f.url))}" loading="lazy" alt="">
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

function quoteBlock(r) {
    if (!r) return '';
    const who = r.isBoard ? 'Правління ОСББ' : `Кв. ${escapeHtml(String(r.apt))}`;
    return `<button type="button" class="chat-quote" data-jump="${escapeHtml(r.id)}">
        <span class="chat-quote-who">${who}</span>
        <span class="chat-quote-text">${escapeHtml(r.text || 'вкладення')}</span>
    </button>`;
}

const GROUP_MS = 5 * 60 * 1000;

function sameGroup(a, b) {
    if (!a || !b) return false;
    if (String(a.apt) !== String(b.apt)) return false;
    if ((a.isBoard === true) !== (b.isBoard === true)) return false;
    const ta = asDate(a.createdAt)?.getTime() || 0;
    const tb = asDate(b.createdAt)?.getTime() || 0;
    return ta && tb && Math.abs(tb - ta) < GROUP_MS;
}

function hasBody(m) {
    if (m.deleted) return true;
    if ((m.text || '').trim()) return true;
    if ((m.attachments || []).length) return true;
    if (m.replyTo) return true;
    return false;
}

function bubbleInner(m, id) {
    if (m.deleted) {
        return `<div class="chat-bubble chat-removed">
            <p class="chat-text">${m.deletedByBoard ? 'Видалено правлінням' : 'Повідомлення видалено'}</p>
        </div>`;
    }
    const meta = m.failed
        ? '<span class="chat-meta chat-meta-fail">не надіслано</span>'
        : `<span class="chat-meta">${m.editedAt ? 'змін. ' : ''}${m.pending ? '•••' : escapeHtml(formatClock(m.createdAt))}</span>`;
    return `<div class="chat-bubble" data-menu="${id}">
        ${m._showAuthor ? `<span class="chat-author">${m.isBoard ? 'Правління' : `Кв. ${escapeHtml(String(m.apt))}`}</span>` : ''}
        ${quoteBlock(m.replyTo)}
        ${chatPhotos(m.attachments, id)}
        ${chatDocs(m.attachments, id)}
        <div class="chat-run">${m.text ? `<span class="chat-text">${escapeHtml(m.text)}</span>` : ''}${meta}</div>
    </div>`;
}

function visibleItems(items) {
    return items.filter(i => hasBody(i.data) || i.data.pending || i.data.failed);
}

function messageNode(item, prev) {
    const m = item.data;
    const mine = String(m.apt) === String(session.apt);
    const grouped = sameGroup(prev, m);
    m._showAuthor = !mine && !grouped;
    const wrap = document.createElement('div');
    wrap.className = `chat-msg${mine ? ' chat-mine' : ''}${m.isBoard ? ' chat-board' : ''}${grouped ? ' chat-grouped' : ''}${m.pending ? ' chat-pending' : ''}${m.failed ? ' chat-failed' : ''}`;
    wrap.dataset.id = item.id;
    wrap.dataset.sig = sig(m);
    wrap.innerHTML = bubbleInner(m, item.id);
    return wrap;
}

function dayNode(ts) {
    const el = document.createElement('div');
    el.className = 'chat-day';
    el.dataset.day = dayKey(ts);
    el.innerHTML = `<span>${escapeHtml(formatDayLabel(ts))}</span>`;
    return el;
}

function wireMessage(node, item, ctx) {
    const m = item.data;
    if (m.deleted) return;
    const imgs = (m.attachments || []).filter(f => isImageFile(f) && safeFileUrl(f.url));
    if (imgs.length) {
        node.querySelectorAll('.chat-photo').forEach(b => {
            b.addEventListener('click', (e) => {
                e.stopPropagation();
                openGallery(imgs, parseInt(b.dataset.i, 10));
            });
        });
    }
    const docs = (m.attachments || []).filter(f => !isImageFile(f));
    if (docs.length) {
        node.querySelectorAll('.chat-doc').forEach(b => {
            b.addEventListener('click', (e) => {
                e.stopPropagation();
                openDocViewer(docs[parseInt(b.dataset.i, 10)]);
            });
        });
    }
    node.querySelectorAll('.chat-quote').forEach(q => {
        q.addEventListener('click', (e) => {
            e.stopPropagation();
            jumpTo(node.parentElement, q.dataset.jump);
        });
    });
    const bubble = node.querySelector('.chat-bubble[data-menu]');
    if (bubble && !String(item.id).startsWith('local-')) {
        attachLongPress(bubble, () => openActions(item, ctx));
    }
    if (m.failed) {
        node.addEventListener('click', () => retryFailed(item, ctx));
    }
}

function jumpTo(host, id) {
    const el = host?.querySelector(`.chat-msg[data-id="${CSS.escape(id)}"]`);
    if (!el) return toast('Це повідомлення вже поза межами стрічки', 'info');
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.classList.remove('chat-flash');
    void el.offsetWidth;
    el.classList.add('chat-flash');
}

function nearBottom(host) {
    return host.scrollHeight - host.scrollTop - host.clientHeight < 140;
}

function scrollToEnd(host, instant) {
    requestAnimationFrame(() => {
        host.scrollTop = host.scrollHeight;
        if (!instant) return;
        host.scrollTop = host.scrollHeight;
    });
}

function syncJumpBtn(host) {
    const btn = document.getElementById('chatJumpDown');
    if (!btn || host.id !== 'chatList') return;
    btn.hidden = nearBottom(host);
}

function paintList(host, items, ctx) {
    host.replaceChildren();
    items = visibleItems(items);
    if (!items.length) {
        host.innerHTML = ctx.empty || '<p class="list-empty">Повідомлень ще немає.<br>Напишіть перший.</p>';
        host._ids = [];
        return;
    }
    const frag = document.createDocumentFragment();
    let prev = null;
    items.forEach(item => {
        if (dayKey(item.data.createdAt) !== dayKey(prev?.createdAt)) {
            frag.appendChild(dayNode(item.data.createdAt));
        }
        const node = messageNode(item, prev);
        wireMessage(node, item, ctx);
        frag.appendChild(node);
        prev = item.data;
    });
    host.appendChild(frag);
    host._ids = items.map(i => i.id);
}

function patchList(host, items, ctx) {
    items = visibleItems(items);
    const oldIds = host._ids || [];
    if (!oldIds.length || !host.querySelector('.chat-msg')) {
        paintList(host, items, ctx);
        return 'full';
    }
    const newIds = items.map(i => i.id);
    const sameSeq = oldIds.length === newIds.length && oldIds.every((id, i) => id === newIds[i]);
    if (sameSeq) {
        const oldMap = new Map((host._items || []).map(i => [i.id, i]));
        items.forEach((item, i) => {
            const was = oldMap.get(item.id);
            if (was && sig(was.data) === sig(item.data)) return;
            const node = host.querySelector(`.chat-msg[data-id="${CSS.escape(item.id)}"]`);
            if (!node) return;
            const fresh = messageNode(item, items[i - 1]?.data);
            node.replaceWith(fresh);
            wireMessage(fresh, item, ctx);
        });
        host._ids = newIds;
        host._items = items;
        return 'update';
    }
    const prefix = oldIds.length && newIds.length > oldIds.length
        && newIds.slice(0, oldIds.length).every((id, i) => id === oldIds[i]);
    if (prefix) {
        const empty = host.querySelector('.list-empty');
        if (empty) empty.remove();
        items.slice(oldIds.length).forEach((item, j) => {
            const prev = items[oldIds.length + j - 1]?.data || null;
            if (dayKey(item.data.createdAt) !== dayKey(prev?.createdAt)) {
                host.appendChild(dayNode(item.data.createdAt));
            }
            const node = messageNode(item, prev);
            node.classList.add('chat-in');
            wireMessage(node, item, ctx);
            host.appendChild(node);
        });
        host._ids = newIds;
        host._items = items;
        return 'append';
    }
    paintList(host, items, ctx);
    host._items = items;
    return 'full';
}

function renderList(host, items, ctx) {
    const pinned = nearBottom(host);
    const mode = patchList(host, items, ctx);
    host._items = items;
    if (pinned || mode === 'full') scrollToEnd(host, mode === 'full');
    syncJumpBtn(host);
}

const HOLD_MS = 320;

function attachLongPress(el, onHold) {
    let timer = null, startY = 0, fired = false;
    const release = () => {
        clearTimeout(timer);
        timer = null;
        el.classList.remove('chat-pressed');
    };
    el.addEventListener('touchstart', (e) => {
        fired = false;
        startY = e.touches[0].clientY;
        el.classList.add('chat-pressed');
        timer = setTimeout(() => {
            fired = true;
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

function closeActions() {
    document.getElementById('actionSheet')?.remove();
    document.getElementById('actionBackdrop')?.remove();
}

function openActions(item, ctx) {
    closeActions();
    const m = item.data;
    if (m.pending || m.failed || String(item.id).startsWith('local-')) return;
    const mine = String(m.apt) === String(session.apt);
    const canEdit = mine;
    const canDelete = mine || session.isAdmin;
    const actions = [
        { id: 'reply', label: 'Відповісти', icon: 'M9 17l-6-6 6-6M3 11h11a6 6 0 0 1 6 6v2' },
        { id: 'copy', label: 'Копіювати', icon: 'M9 9h13v13H9zM5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1' },
        canEdit ? { id: 'edit', label: 'Змінити', icon: 'M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z' } : null,
        canDelete ? { id: 'delete', label: 'Видалити', icon: 'M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2', danger: true } : null
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
    const active = st.edit || st.reply;
    if (!active) { host.hidden = true; host.innerHTML = ''; return; }
    host.hidden = false;
    host.innerHTML = `
        <span class="compose-ctx-bar"></span>
        <span class="compose-ctx-text">
            <b>${st.edit ? 'Редагування' : (st.reply.isBoard ? 'Правління ОСББ' : 'Кв. ' + escapeHtml(String(st.reply.apt)))}</b>
            <small>${escapeHtml(st.edit ? 'змініть текст і надішліть' : st.reply.text)}</small>
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
            deletedByBoard: session.isAdmin === true && String(item.data.apt) !== String(session.apt),
            text: '',
            attachments: []
        });
    } catch (e) {
        console.error('Видалення:', e.code, e);
        toast(explain(e, 'Не вдалося видалити'), 'error');
    }
}

const CTX_CHAT = {
    key: 'chat', path: ['chat'],
    list: 'chatList', input: 'chatInput', context: 'chatComposeCtx',
    files: 'chatFiles', preview: 'chatFilesPreview'
};
const activeCtx = () => CTX_CHAT;
const ctxComments = (msgId) => ({
    key: 'comments', path: ['messages', msgId, 'comments'],
    input: 'commentInput', context: 'commentComposeCtx',
    empty: '<p class="list-empty">Коментарів ще немає</p>'
});

function mergePending(serverItems) {
    const pending = lastRendered.filter(i => String(i.id).startsWith('local-'));
    const still = pending.filter(p => !serverItems.some(s =>
        String(s.data.apt) === String(p.data.apt)
        && s.data.text === p.data.text
        && !s.data.deleted
    ));
    return serverItems.concat(still);
}

export function loadChat() {
    const ctx = activeCtx();
    const host = document.getElementById(ctx.list);
    if (!host) return;
    lockForeignFields(true);
    requestAnimationFrame(syncChatHeight);
    stopChat(false);
    if (!host.childElementCount) {
        host.innerHTML = '<p class="list-empty">Завантаження…</p>';
    }
    unsubscribe = onSnapshot(
        query(collection(db, 'chat'), orderBy('createdAt', 'desc'), limit(LIMIT)),
        (snap) => {
            const server = snap.docs.map(d => ({ id: d.id, data: d.data() })).reverse();
            lastRendered = mergePending(server);
            renderList(host, lastRendered, ctx);
            syncChatHeight();
            const newest = lastRendered.length
                ? asDate(lastRendered[lastRendered.length - 1].data.createdAt)?.getTime()
                : 0;
            markSeen(newest || Date.now());
            setBadge('chatMenuBadge', 0);
            setBadge('adminChatBadge', 0);
            import('./ui.js').then(m => m.updateNavBadge());
        },
        (e) => {
            console.error('Чат:', e);
            host.innerHTML = '<p class="list-empty">Не вдалося завантажити чат</p>';
        }
    );
}

export function stopChat(unlock = true) {
    if (unsubscribe) { unsubscribe(); unsubscribe = null; }
    closeActions();
    if (unlock) lockForeignFields(false);
}

function refreshChips() {
    renderFileManager(
        document.getElementById(activeCtx().preview),
        [], pendingFiles,
        () => {},
        (i) => { pendingFiles.splice(i, 1); refreshChips(); syncSendState(); }
    );
    syncSendState();
}

function syncSendState() {
    const input = document.getElementById('chatInput');
    const btn = document.getElementById('chatSendBtn');
    if (!btn) return;
    const ready = !!(input?.value.trim() || pendingFiles.length);
    btn.classList.toggle('is-ready', ready);
    btn.disabled = !ready;
}

function pushLocal(item) {
    lastRendered = lastRendered.concat([item]);
    const host = document.getElementById('chatList');
    if (host) renderList(host, lastRendered, activeCtx());
}

function dropLocal(id) {
    lastRendered = lastRendered.filter(i => i.id !== id);
    const host = document.getElementById('chatList');
    if (host) renderList(host, lastRendered, activeCtx());
}

function markLocal(id, patch) {
    lastRendered = lastRendered.map(i => i.id === id ? { ...i, data: { ...i.data, ...patch } } : i);
    const host = document.getElementById('chatList');
    if (host) renderList(host, lastRendered, activeCtx());
}

async function sendChat() {
    const ctx = activeCtx();
    const input = document.getElementById(ctx.input);
    const text = (input.value || '').trim();
    const st = compose.chat;
    if (!text && !pendingFiles.length) return;
    if (text.length > 2000) return toast('Повідомлення задовге', 'error');
    if (!session.apt) return toast('Сесія втрачена. Увійдіть знову.', 'error');
    if (!text) return toast('Напишіть текст повідомлення', 'error');
    if (st.edit) {
        const editId = st.edit.id;
        const next = text;
        cancelCompose(ctx);
        syncSendState();
        try {
            await updateDoc(doc(db, 'chat', editId), { text: next, editedAt: serverTimestamp() });
            playSend();
        } catch (e) {
            toast(explain(e, 'Не вдалося змінити'), 'error');
        }
        return;
    }
    const filesNow = pendingFiles.slice();
    const replyNow = st.reply || null;
    const localId = 'local-' + Date.now();
    pendingFiles = [];
    refreshChips();
    cancelCompose(ctx);
    input.focus();
    settleChatViewport();
    taptic(7);
    playSend();
    pushLocal({
        id: localId,
        data: {
            apt: String(session.apt),
            isBoard: session.isAdmin === true,
            text,
            attachments: [],
            replyTo: replyNow,
            createdAt: new Date(),
            pending: true
        }
    });
    try {
        const attachments = filesNow.length ? await uploadPendingFrom(filesNow) : [];
        await addDoc(collection(db, 'chat'), {
            apt: String(session.apt),
            isBoard: session.isAdmin === true,
            text,
            attachments,
            replyTo: replyNow,
            createdAt: serverTimestamp()
        });
        dropLocal(localId);
    } catch (e) {
        console.error('Надсилання в чат:', e.code, e);
        markLocal(localId, { pending: false, failed: true });
        toast(explain(e, 'Не вдалося надіслати'), 'error');
    }
}

async function uploadPendingFrom(files) {
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

async function retryFailed(item) {
    if (!item.data.failed) return;
    markLocal(item.id, { failed: false, pending: true });
    try {
        await addDoc(collection(db, 'chat'), {
            apt: String(session.apt),
            isBoard: session.isAdmin === true,
            text: item.data.text,
            attachments: item.data.attachments || [],
            replyTo: item.data.replyTo || null,
            createdAt: serverTimestamp()
        });
        dropLocal(item.id);
    } catch (e) {
        markLocal(item.id, { pending: false, failed: true });
        toast(explain(e, 'Не вдалося надіслати'), 'error');
    }
}

let commentsUnsub = null;
let currentMsgId = null;

export function openComments(msgId, isForAll) {
    currentMsgId = msgId;
    compose.comments = { reply: null, edit: null };
    renderComposeContext(ctxComments(msgId));
    const box = document.getElementById('msgComments');
    if (!box) return;
    stopComments();
    if (!isForAll) {
        box.hidden = true;
        return;
    }
    box.hidden = false;
    const host = document.getElementById('commentsList');
    host.innerHTML = '<p class="list-empty">Завантаження…</p>';
    host._ids = [];
    commentsUnsub = onSnapshot(
        query(collection(db, 'messages', msgId, 'comments'), orderBy('createdAt', 'asc'), limit(LIMIT)),
        (snap) => {
            renderList(host, snap.docs.map(d => ({ id: d.id, data: d.data() })), ctxComments(msgId));
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

function autoGrow(el) {
    el?.addEventListener('input', function () {
        this.style.height = 'auto';
        this.style.height = Math.min(this.scrollHeight, 132) + 'px';
        syncSendState();
    });
}

function ensureChatChrome() {
    if (!document.querySelector('link[href*="style-chat.css"]')) {
        const link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = 'style-chat.css?v=105';
        document.head.appendChild(link);
    }
    const meta = document.querySelector('meta[name="viewport"]');
    if (meta && !meta.content.includes('interactive-widget')) {
        meta.content += ', interactive-widget=resizes-content';
    }
    const list = document.getElementById('chatList');
    if (list && !document.getElementById('chatJumpDown')) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.id = 'chatJumpDown';
        btn.className = 'chat-jump';
        btn.hidden = true;
        btn.setAttribute('aria-label', 'До нових повідомлень');
        btn.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>';
        list.after(btn);
    }
    const input = document.getElementById('chatInput');
    if (input) {
        input.setAttribute('enterkeyhint', 'send');
        input.setAttribute('autocomplete', 'off');
        input.setAttribute('autocorrect', 'on');
        input.setAttribute('autocapitalize', 'sentences');
        input.spellcheck = true;
    }
}

export function initChat() {
    ensureChatChrome();
    const vv = window.visualViewport;
    if (vv) {
        vv.addEventListener('resize', syncChatHeight);
        vv.addEventListener('scroll', syncChatHeight);
    }
    window.addEventListener('resize', syncChatHeight);
    document.getElementById('chatSendBtn')?.addEventListener('click', () => sendChat());
    document.getElementById('commentSendBtn')?.addEventListener('click', function () { sendComment(this); });
    const input = document.getElementById('chatInput');
    autoGrow(input);
    autoGrow(document.getElementById('commentInput'));
    input?.addEventListener('focus', () => {
        lockForeignFields(true);
        settleChatViewport();
    });
    input?.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' || e.shiftKey) return;
        if (window.matchMedia('(pointer: coarse)').matches) return;
        e.preventDefault();
        sendChat();
    });
    document.getElementById('chatList')?.addEventListener('scroll', () => {
        syncJumpBtn(document.getElementById('chatList'));
    }, { passive: true });
    document.getElementById('chatJumpDown')?.addEventListener('click', () => {
        const host = document.getElementById('chatList');
        if (!host) return;
        host.scrollTo({ top: host.scrollHeight, behavior: 'smooth' });
    });
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
    syncSendState();
}
