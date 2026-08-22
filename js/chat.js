// ============================================================
// Чат будинку та коментарі під оголошеннями.
//
// Підписуються КВАРТИРИ, а не люди: вхід у застосунку за номером
// квартири, і в однієї квартири часто двоє співвласників з одним
// паролем. Тому автор — «Кв. 298», і за слово відповідає квартира.
//
// Позначку «Правління» перевіряють правила Firestore, а не код:
// інакше через DevTools можна було б видати себе за правління.
// ============================================================
import { db, storage, session } from './firebase.js';
import {
    collection, addDoc, deleteDoc, doc, onSnapshot, getDocs,
    query, orderBy, limit, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js";
import {
    ref as sRef, uploadBytes, getDownloadURL
} from "https://www.gstatic.com/firebasejs/10.8.1/firebase-storage.js";
import { escapeHtml, formatDateTime, toast, setBusy, confirmDialog } from './ui.js';
import { renderAttachments, renderFileManager } from './attachments.js';

const LIMIT = 200;                      // скільки повідомлень тримаємо на екрані
const SEEN_KEY = () => `chat_seen_${session.apt}`;

let unsubscribe = null;
let pendingFiles = [];
let lastRendered = [];

// ------------------------------------------------------------
// ПРОЧИТАНЕ
// Позначку тримаємо локально: у кожної квартири свій телефон, і
// синхронізувати її через базу означало б запис на кожне відкриття.
// ------------------------------------------------------------
function lastSeen() {
    return parseInt(localStorage.getItem(SEEN_KEY()) || '0', 10);
}

function markSeen(ts) {
    try { localStorage.setItem(SEEN_KEY(), String(ts || Date.now())); } catch (e) { /* ігноруємо */ }
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
            const t = m.createdAt?.toDate?.().getTime() || 0;
            return t > seen;
        }).length;
        setBadge('chatMenuBadge', unread);
        const { updateNavBadge } = await import('./ui.js');
        updateNavBadge();
    } catch (e) {
        console.warn('Лічильник чату:', e);
        setBadge('chatMenuBadge', 0);
    }
}

// ------------------------------------------------------------
// МАЛЮВАННЯ
// ------------------------------------------------------------
function bubble(m, id, canDelete) {
    const mine = String(m.apt) === String(session.apt);
    const author = m.isBoard ? 'Правління' : `Кв. ${escapeHtml(String(m.apt))}`;
    return `<div class="chat-msg${mine ? ' chat-mine' : ''}${m.isBoard ? ' chat-board' : ''}" data-id="${id}">
        <div class="chat-bubble">
            <span class="chat-author">${author}</span>
            <p class="chat-text">${escapeHtml(m.text || '')}</p>
            <div class="attach-block chat-attach" data-att="${id}"></div>
            <span class="chat-time">${escapeHtml(formatDateTime(m.createdAt))}</span>
            ${canDelete ? `<button type="button" class="chat-del" data-del="${id}" aria-label="Видалити">
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
            </button>` : ''}
        </div>
    </div>`;
}

function renderList(host, items, onDelete) {
    if (!items.length) {
        host.innerHTML = '<p class="list-empty">Повідомлень ще немає.<br>Напишіть перший.</p>';
        return;
    }
    host.innerHTML = items
        .map(i => bubble(i.data, i.id, session.isAdmin || String(i.data.apt) === String(session.apt)))
        .join('');

    items.forEach(i => {
        if (i.data.attachments?.length) {
            renderAttachments(host.querySelector(`.chat-attach[data-att="${i.id}"]`), i.data.attachments);
        }
    });

    host.querySelectorAll('.chat-del').forEach(btn => {
        btn.addEventListener('click', () => onDelete(btn.dataset.del));
    });
}

// ------------------------------------------------------------
// ЧАТ БУДИНКУ
// ------------------------------------------------------------
export function loadChat() {
    const host = document.getElementById('chatList');
    if (!host) return;
    host.innerHTML = '<p class="list-empty">Завантаження…</p>';
    stopChat();

    // onSnapshot, а не одноразове читання: нове повідомлення має
    // зʼявлятися в усіх відкритих застосунках одразу.
    unsubscribe = onSnapshot(
        query(collection(db, 'chat'), orderBy('createdAt', 'desc'), limit(LIMIT)),
        (snap) => {
            // Читаємо згори вниз, показуємо знизу вгору — як у месенджерах
            lastRendered = snap.docs.map(d => ({ id: d.id, data: d.data() })).reverse();
            const atBottom = host.scrollHeight - host.scrollTop - host.clientHeight < 120;
            renderList(host, lastRendered, removeMessage);

            const newest = lastRendered.length
                ? lastRendered[lastRendered.length - 1].data.createdAt?.toDate?.().getTime()
                : 0;
            markSeen(newest || Date.now());
            setBadge('chatMenuBadge', 0);
            import('./ui.js').then(m => m.updateNavBadge());

            // Прокручуємо вниз лише якщо мешканець і так був унизу:
            // інакше вирвали б його з середини читання
            if (atBottom) host.scrollTop = host.scrollHeight;
        },
        (e) => {
            console.error('Чат:', e);
            host.innerHTML = '<p class="list-empty">Не вдалося завантажити чат</p>';
        }
    );
}

export function stopChat() {
    if (unsubscribe) { unsubscribe(); unsubscribe = null; }
}

async function removeMessage(id) {
    const ok = await confirmDialog('Видалити повідомлення?', 'Його більше не побачить ніхто.');
    if (!ok) return;
    try {
        await deleteDoc(doc(db, 'chat', id));
        toast('Видалено', 'success');
    } catch (e) {
        console.error('Видалення:', e);
        toast('Не вдалося видалити', 'error');
    }
}

function refreshChips() {
    renderFileManager(
        document.getElementById('chatFilesPreview'),
        [], pendingFiles,
        () => {},
        (i) => { pendingFiles.splice(i, 1); refreshChips(); }
    );
}

async function sendChat(btn) {
    const input = document.getElementById('chatInput');
    const text = input.value.trim();
    if (!text && !pendingFiles.length) return;
    if (text.length > 2000) return toast('Повідомлення задовге', 'error');

    setBusy(btn, true, '');
    try {
        const attachments = [];
        for (const file of pendingFiles) {
            const fileRef = sRef(storage, `chat/${session.apt}/${Date.now()}_${file.name}`);
            await uploadBytes(fileRef, file);
            attachments.push({
                name: file.name, url: await getDownloadURL(fileRef),
                type: file.type || '', size: file.size || 0
            });
        }
        await addDoc(collection(db, 'chat'), {
            apt: String(session.apt),
            isBoard: session.isAdmin === true,
            text, attachments,
            createdAt: serverTimestamp()
        });
        input.value = '';
        input.style.height = '';
        pendingFiles = [];
        refreshChips();
    } catch (e) {
        console.error('Надсилання в чат:', e);
        toast('Не вдалося надіслати', 'error');
    } finally {
        setBusy(btn, false);
    }
}

// ------------------------------------------------------------
// КОМЕНТАРІ ПІД ОГОЛОШЕННЯМ
// ------------------------------------------------------------
let commentsUnsub = null;
let currentMsgId = null;

export function openComments(msgId, isForAll) {
    currentMsgId = msgId;
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

    commentsUnsub = onSnapshot(
        query(collection(db, 'messages', msgId, 'comments'), orderBy('createdAt', 'asc'), limit(LIMIT)),
        (snap) => {
            renderList(host, snap.docs.map(d => ({ id: d.id, data: d.data() })), removeComment);
        },
        (e) => {
            console.error('Коментарі:', e);
            host.innerHTML = '<p class="list-empty">Не вдалося завантажити коментарі</p>';
        }
    );
}

export function stopComments() {
    if (commentsUnsub) { commentsUnsub(); commentsUnsub = null; }
}

async function removeComment(id) {
    const ok = await confirmDialog('Видалити коментар?', 'Його більше не побачить ніхто.');
    if (!ok || !currentMsgId) return;
    try {
        await deleteDoc(doc(db, 'messages', currentMsgId, 'comments', id));
        toast('Видалено', 'success');
    } catch (e) {
        console.error('Видалення коментаря:', e);
        toast('Не вдалося видалити', 'error');
    }
}

async function sendComment(btn) {
    const input = document.getElementById('commentInput');
    const text = input.value.trim();
    if (!text || !currentMsgId) return;
    if (text.length > 2000) return toast('Коментар задовгий', 'error');

    setBusy(btn, true, '');
    try {
        await addDoc(collection(db, 'messages', currentMsgId, 'comments'), {
            apt: String(session.apt),
            isBoard: session.isAdmin === true,
            text, attachments: [],
            createdAt: serverTimestamp()
        });
        input.value = '';
        input.style.height = '';
    } catch (e) {
        console.error('Коментар:', e);
        toast('Не вдалося надіслати коментар', 'error');
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
        this.style.height = Math.min(this.scrollHeight, 120) + 'px';
    });
}

export function initChat() {
    document.getElementById('chatSendBtn')?.addEventListener('click', function () { sendChat(this); });
    document.getElementById('commentSendBtn')?.addEventListener('click', function () { sendComment(this); });
    autoGrow(document.getElementById('chatInput'));
    autoGrow(document.getElementById('commentInput'));

    const files = document.getElementById('chatFiles');
    files?.addEventListener('change', () => {
        pendingFiles.push(...Array.from(files.files));
        files.value = '';
        refreshChips();
    });
}
