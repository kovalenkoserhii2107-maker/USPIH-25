// ============================================================
// Повідомлення від правління: розсилка, вхідні мешканця,
// історія розсилок адміна.
// ============================================================
import { db, session } from './firebase.js';
import {
    collection, getDocs, doc, query, orderBy, where, writeBatch
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { escapeHtml, formatDateTime, openSheet, isSheetOpen, closeAllSheets, lockScroll, unlockScroll } from './ui.js';
import { renderAttachments, isImageFile } from './attachments.js';

let unreadMsgIds = [];

// ------------------------------------------------------------
// ВХІДНІ (мешканець) — фільтрація на сервері
// ------------------------------------------------------------
export async function loadUserMessages(apt, entrance) {
    const list = document.getElementById('messagesList');
    const badge = document.getElementById('notifBadge');
    if (!list) return;

    list.innerHTML = '<p class="list-empty">Завантаження…</p>';
    unreadMsgIds = [];

    try {
        const keys = ['all', `apt:${apt}`];
        if (entrance && entrance !== '--') keys.push(`ent:${entrance}`);

        const snap = await getDocs(query(
            collection(db, 'messages'),
            where('recipients', 'array-contains-any', keys),
            orderBy('createdAt', 'desc')
        ));

        if (snap.empty) {
            list.innerHTML = '<p class="list-empty">Немає повідомлень</p>';
            badge.style.display = 'none';
            return;
        }

        const items = [];
        let html = '';
        snap.forEach(d => {
            const msg = d.data();
            const isRead = msg.readBy && msg.readBy[apt];
            if (!isRead) unreadMsgIds.push(d.id);
            items.push({ id: d.id, ...msg });

            const imgCount = (msg.attachments || []).filter(isImageFile).length;
            const docCount = (msg.attachments || []).length - imgCount;

            // Тип визначає, що мешканець побачить першим. Підсумки
            // голосувань, документи й звичайні оголошення — різні за
            // суттю речі, і однаковий вигляд змушував читати все.
            const isPoll = /^Результати голосування/i.test(msg.title || '');
            // Якщо тип записаний у документі — віримо йому; здогад за назвою
            // лишається для старих повідомлень, надісланих до цього поля.
            const guessed = isPoll ? 'poll' : (msg.linkedDoc ? 'doc' : 'news');
            const kind = ['poll', 'doc', 'news', 'owners', 'ownersFix'].includes(msg.kind) ? msg.kind : guessed;
            const KIND = {
                poll: { label: 'Підсумки голосування',
                        icon: '<line x1="18" y1="20" x2="18" y2="10"></line><line x1="12" y1="20" x2="12" y2="4"></line><line x1="6" y1="20" x2="6" y2="14"></line>' },
                doc:  { label: 'Документ ОСББ',
                        icon: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline>' },
                news: { label: 'Оголошення',
                        icon: '<path d="M3 11l18-5v12L3 13v-2z"></path><path d="M11.6 16.8a3 3 0 1 1-5.8-1.6"></path>' },
                owners: { label: 'Звірка співвласників',
                        icon: '<path d="M9 12l2 2 4-4"></path><path d="M21 12c0 4.97-4.03 9-9 9s-9-4.03-9-9 4.03-9 9-9 9 4.03 9 9z"></path>' },
                // Відмова має власний вигляд: зелена галочка над словом
                // «не прийнято» читається як успіх ще до того, як текст
                // устигнуть прочитати.
                ownersFix: { label: 'Потрібно виправити',
                        icon: '<circle cx="12" cy="12" r="9"></circle><line x1="12" y1="7.5" x2="12" y2="13"></line><line x1="12" y1="16.5" x2="12" y2="16.5"></line>' }
            }[kind];

            // У підсумках голосування назва вже містить тип — не дублюємо
            const title = isPoll
                ? (msg.title || '').replace(/^Результати голосування:\s*/i, '')
                : (msg.title || '');

            const meta = [];
            if (imgCount) meta.push(`${imgCount} фото`);
            if (docCount) meta.push(`${docCount} док.`);

            html += `<button type="button" class="msg-row msg-${kind}${isRead ? '' : ' msg-unread'}" data-msg-id="${d.id}">
                <span class="msg-icon">
                    <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${KIND.icon}</svg>
                </span>
                <span class="msg-main">
                    <span class="msg-kind">${KIND.label}</span>
                    <span class="msg-title">${escapeHtml(title)}</span>
                    <span class="msg-preview">${escapeHtml(msg.body)}</span>
                    <span class="msg-meta">
                        <span class="msg-date">${formatDateTime(msg.createdAt)}</span>
                        ${meta.map(t => `<span class="msg-chip">${t}</span>`).join('')}
                    </span>
                </span>
                ${isRead ? '' : '<span class="msg-dot"></span>'}
            </button>`;
        });

        list.innerHTML = html;
        list.querySelectorAll('.msg-row').forEach(row => {
            row.addEventListener('click', () => {
                const msg = items.find(m => m.id === row.dataset.msgId);
                if (msg) openMessageModal(msg);
            });
        });

        badge.textContent = unreadMsgIds.length > 9 ? '9+' : unreadMsgIds.length;
        badge.style.display = unreadMsgIds.length ? 'flex' : 'none';
    } catch (e) {
        console.error('Завантаження повідомлень:', e);
        list.innerHTML = '<p class="list-empty">Не вдалося завантажити повідомлення</p>';
    }
}

export function openMessageModal(msg) {
    document.getElementById('modalMsgTitle').textContent = msg.title;
    document.getElementById('modalMsgDate').textContent = formatDateTime(msg.createdAt);
    document.getElementById('modalMsgBody').textContent = msg.body;
    renderAttachments(document.getElementById('modalMsgAttachments'), msg.attachments);

    const linkedHost = document.getElementById('modalMsgLinkedDoc');
    linkedHost.innerHTML = '';
    if (msg.linkedDoc) {
        renderAttachments(linkedHost, [{
            name: msg.linkedDoc.name || msg.linkedDoc.title || 'Документ ОСББ',
            url: msg.linkedDoc.url, type: msg.linkedDoc.type || '', size: msg.linkedDoc.size || 0
        }]);
    }
    // Коментарі — лише під оголошеннями для всього будинку
    import('./chat.js').then(c => c.openComments(msg.id, (msg.recipients || []).includes('all')));

    document.getElementById('msgModal').classList.add('is-open');
    lockScroll();
}

async function markAllRead(apt) {
    if (!unreadMsgIds.length) return;
    const stamp = new Date().toLocaleString('uk-UA', {
        day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit'
    });
    const batch = writeBatch(db);
    unreadMsgIds.forEach(id => batch.update(doc(db, 'messages', id), { [`readBy.${apt}`]: stamp }));
    try {
        await batch.commit();
        unreadMsgIds = [];
        document.querySelectorAll('.msg-row.msg-unread').forEach(r => r.classList.remove('msg-unread'));
    } catch (e) {
        console.error('Відмітка прочитання:', e);
    }
}


// ------------------------------------------------------------
// ІНІЦІАЛІЗАЦІЯ
// ------------------------------------------------------------
export function initMessages() {
    document.getElementById('bellBtn')?.addEventListener('click', async () => {
        const wasOpen = isSheetOpen('notifPopup');
        if (wasOpen) { closeAllSheets(); return; }
        openSheet('notifPopup');
        document.getElementById('notifBadge').style.display = 'none';
        await markAllRead(session.apt);
    });

    document.getElementById('closeMsgModal')?.addEventListener('click', closeMessageModal);
    document.getElementById('msgModal')?.addEventListener('click', (e) => {
        if (e.target.id === 'msgModal') closeMessageModal();
    });
}

export function closeMessageModal() {
    import('./chat.js').then(c => c.stopComments());
    document.getElementById('msgModal').classList.remove('is-open');
    unlockScroll();
}
