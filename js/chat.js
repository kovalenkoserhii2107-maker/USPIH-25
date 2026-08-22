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
    collection, addDoc, updateDoc, doc, onSnapshot, getDocs,
    query, orderBy, limit, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js";
import {
    ref as sRef, uploadBytes, getDownloadURL
} from "https://www.gstatic.com/firebasejs/10.8.1/firebase-storage.js";
import { escapeHtml, formatDateTime, toast, setBusy, confirmDialog } from './ui.js';
import { renderAttachments, renderFileManager } from './attachments.js';

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

const LIMIT = 200;                      // скільки повідомлень тримаємо на екрані
const SEEN_KEY = () => `chat_seen_${session.apt}`;

let unsubscribe = null;
let pendingFiles = [];
let lastRendered = [];

// Куди відповідаємо і що редагуємо. Тримаємо окремо для чату й
// коментарів, бо вікна можуть бути відкриті одночасно.
const compose = {
    chat: { reply: null, edit: null },
    comments: { reply: null, edit: null }
};

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
function quoteBlock(r) {
    if (!r) return '';
    const who = r.isBoard ? 'Правління' : `Кв. ${escapeHtml(String(r.apt))}`;
    return `<button type="button" class="chat-quote" data-jump="${escapeHtml(r.id)}">
        <span class="chat-quote-who">${who}</span>
        <span class="chat-quote-text">${escapeHtml(r.text || 'вкладення')}</span>
    </button>`;
}

function bubble(m, id) {
    const mine = String(m.apt) === String(session.apt);
    const author = m.isBoard ? 'Правління' : `Кв. ${escapeHtml(String(m.apt))}`;

    // Видалене лишається в стрічці міткою: інакше розмова, де хтось
    // прибрав свої слова, ставала б незрозумілою.
    if (m.deleted) {
        return `<div class="chat-msg${mine ? ' chat-mine' : ''}" data-id="${id}">
            <div class="chat-bubble chat-removed">
                <p class="chat-text">${m.deletedByBoard ? 'Повідомлення видалено правлінням' : 'Повідомлення видалено'}</p>
            </div>
        </div>`;
    }

    return `<div class="chat-msg${mine ? ' chat-mine' : ''}${m.isBoard ? ' chat-board' : ''}" data-id="${id}">
        <div class="chat-bubble" data-menu="${id}">
            <span class="chat-author">${author}</span>
            ${quoteBlock(m.replyTo)}
            <p class="chat-text">${escapeHtml(m.text || '')}</p>
            <div class="attach-block chat-attach" data-att="${id}"></div>
            <span class="chat-time">${escapeHtml(formatDateTime(m.createdAt))}${m.editedAt ? ' · змінено' : ''}</span>
        </div>
    </div>`;
}

/** Прокручує до повідомлення й підсвічує його. */
function jumpTo(host, id) {
    const el = host.querySelector(`.chat-msg[data-id="${CSS.escape(id)}"]`);
    if (!el) return toast('Це повідомлення вже поза межами стрічки', 'info');
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.classList.remove('chat-flash');
    void el.offsetWidth;                 // перезапуск анімації
    el.classList.add('chat-flash');
}

function renderList(host, items, ctx) {
    if (!items.length) {
        host.innerHTML = ctx.empty || '<p class="list-empty">Повідомлень ще немає.<br>Напишіть перший.</p>';
        return;
    }
    host.innerHTML = items.map(i => bubble(i.data, i.id)).join('');

    items.forEach(i => {
        if (i.data.attachments?.length && !i.data.deleted) {
            renderAttachments(host.querySelector(`.chat-attach[data-att="${i.id}"]`), i.data.attachments);
        }
    });

    host.querySelectorAll('.chat-quote').forEach(q => {
        q.addEventListener('click', (e) => { e.stopPropagation(); jumpTo(host, q.dataset.jump); });
    });

    host.querySelectorAll('.chat-bubble[data-menu]').forEach(b => {
        attachLongPress(b, () => {
            const item = items.find(x => x.id === b.dataset.menu);
            if (item) openActions(item, ctx);
        });
    });
}

// ------------------------------------------------------------
// ДОВГЕ НАТИСКАННЯ
// На дотику немає ні наведення, ні правої кнопки, тож меню
// викликається утриманням. Рух пальцем скасовує: інакше меню
// вискакувало б посеред прокрутки.
// ------------------------------------------------------------
const HOLD_MS = 450;

function attachLongPress(el, onHold) {
    let timer = null, startY = 0, fired = false;

    const cancel = () => { clearTimeout(timer); timer = null; };

    el.addEventListener('touchstart', (e) => {
        fired = false;
        startY = e.touches[0].clientY;
        timer = setTimeout(() => { fired = true; onHold(); }, HOLD_MS);
    }, { passive: true });

    el.addEventListener('touchmove', (e) => {
        if (Math.abs(e.touches[0].clientY - startY) > 10) cancel();
    }, { passive: true });

    el.addEventListener('touchend', (e) => {
        cancel();
        // Після спрацювання не даємо натисканню піти далі
        if (fired) e.preventDefault();
    });

    // На комп'ютері звичний шлях — права кнопка
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

    back.addEventListener('click', closeActions);
    sheet.querySelectorAll('.action-row').forEach(btn => {
        btn.addEventListener('click', () => {
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
}

export function cancelCompose(ctx) {
    compose[ctx.key].reply = null;
    compose[ctx.key].edit = null;
    const input = document.getElementById(ctx.input);
    if (input) { input.value = ''; input.style.height = ''; }
    renderComposeContext(ctx);
}

function renderComposeContext(ctx) {
    const host = document.getElementById(ctx.context);
    if (!host) return;
    const st = compose[ctx.key];
    const active = st.edit || st.reply;
    if (!active) { host.hidden = true; host.innerHTML = ''; return; }

    host.hidden = false;
    host.innerHTML = `
        <span class="compose-ctx-icon">${st.edit ? '✎' : '↩'}</span>
        <span class="compose-ctx-text">
            <b>${st.edit ? 'Редагування' : (st.reply.isBoard ? 'Відповідь Правлінню' : 'Відповідь кв. ' + escapeHtml(String(st.reply.apt)))}</b>
            <small>${escapeHtml(st.edit ? 'змініть текст і надішліть' : st.reply.text)}</small>
        </span>
        <button type="button" class="compose-ctx-close" aria-label="Скасувати">✕</button>`;
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
        toast('Видалено', 'success');
    } catch (e) {
        console.error('Видалення:', e.code, e);
        toast(explain(e, 'Не вдалося видалити'), 'error');
    }
}

const CTX_CHAT = {
    key: 'chat', path: ['chat'],
    input: 'chatInput', context: 'chatComposeCtx'
};
const ctxComments = (msgId) => ({
    key: 'comments', path: ['messages', msgId, 'comments'],
    input: 'commentInput', context: 'commentComposeCtx',
    empty: '<p class="list-empty">Коментарів ще немає</p>'
});

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
            renderList(host, lastRendered, CTX_CHAT);

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
    closeActions();
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
    const st = compose.chat;

    if (!text && !pendingFiles.length) return;
    if (text.length > 2000) return toast('Повідомлення задовге', 'error');
    if (!session.apt) return toast('Сесія втрачена. Увійдіть знову.', 'error');
    if (!text) return toast('Напишіть текст повідомлення', 'error');

    setBusy(btn, true, '');
    try {
        if (st.edit) {
            // Правила дозволяють міняти лише text і editedAt
            await updateDoc(doc(db, 'chat', st.edit.id), { text, editedAt: serverTimestamp() });
        } else {
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
                replyTo: st.reply || null,
                createdAt: serverTimestamp()
            });
        }
        pendingFiles = [];
        refreshChips();
        cancelCompose(CTX_CHAT);
    } catch (e) {
        console.error('Надсилання в чат:', e.code, e);
        toast(explain(e, 'Не вдалося надіслати'), 'error');
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
