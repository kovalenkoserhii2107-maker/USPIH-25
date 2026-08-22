// ============================================================
// Повідомлення від правління: розсилка, вхідні мешканця,
// історія розсилок адміна.
// ============================================================
import { db, storage, session } from './firebase.js';
import {
    collection, addDoc, getDocs, doc, query, orderBy, where,
    serverTimestamp, writeBatch
} from "https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js";
import {
    ref as sRef, uploadBytes, getDownloadURL
} from "https://www.gstatic.com/firebasejs/10.8.1/firebase-storage.js";
import { escapeHtml, formatDateTime, toast, setBusy, openSheet, isSheetOpen, closeAllSheets, lockScroll, unlockScroll } from './ui.js';
import { renderAttachments, renderFileManager, isImageFile } from './attachments.js';

let unreadMsgIds = [];
let pendingMsgFiles = [];

/**
 * Будує масив адресатів. Це те, що дозволяє фільтрувати на СЕРВЕРІ,
 * а не тягнути всі повідомлення будинку в кожен телефон.
 * Формати: 'all' | 'apt:45' | 'ent:2'
 */
export function buildRecipients(targetType, targetValue) {
    if (targetType === 'all') return ['all'];
    const parts = String(targetValue || '').split(',').map(s => s.trim()).filter(Boolean);
    const prefix = targetType === 'entrance' ? 'ent:' : 'apt:';
    return parts.map(p => prefix + p);
}

// ------------------------------------------------------------
// РОЗСИЛКА (адмін)
// ------------------------------------------------------------
export async function sendMessage(btn) {
    const title = document.getElementById('adminMsgTitle').value.trim();
    const body = document.getElementById('adminMsgBody').value.trim();
    const targetType = document.getElementById('adminMsgTargetType').value;
    const targetValue = document.getElementById('adminMsgTargetValue').value.trim();
    const linkedDocRaw = document.getElementById('adminMsgLinkedDoc').value;

    if (!title || !body) return toast('Заповніть заголовок і текст', 'error');
    if (targetType !== 'all' && !targetValue) return toast('Вкажіть номери адресатів', 'error');

    setBusy(btn, true, 'Надсилання…');
    try {
        const attachments = [];
        const failed = [];
        // Кожен файл окремо: збій одного не зриває всю розсилку
        for (const file of pendingMsgFiles) {
            try {
                const fileRef = sRef(storage, `messages/${Date.now()}_${file.name}`);
                await uploadBytes(fileRef, file);
                attachments.push({
                    name: file.name,
                    url: await getDownloadURL(fileRef),
                    type: file.type || '',
                    size: file.size || 0
                });
            } catch (e) {
                console.error(`Файл "${file.name}":`, e);
                failed.push(file.name);
            }
        }
        if (failed.length) toast(`Не завантажено: ${failed.join(', ')}`, 'error');

        await addDoc(collection(db, 'messages'), {
            title, body, targetType, targetValue,
            recipients: buildRecipients(targetType, targetValue),
            attachments,
            linkedDoc: linkedDocRaw ? JSON.parse(linkedDocRaw) : null,
            createdAt: serverTimestamp(),
            readBy: {}
        });

        toast('Повідомлення надіслано', 'success');
        resetMessageForm();
        await loadAdminHistory();
    } catch (error) {
        console.error(error);
        toast('Помилка надсилання. Перевірте інтернет.', 'error');
    } finally {
        setBusy(btn, false);
    }
}

function resetMessageForm() {
    document.getElementById('adminMsgTitle').value = '';
    const bodyEl = document.getElementById('adminMsgBody');
    bodyEl.value = '';
    bodyEl.style.height = '';
    document.getElementById('adminMsgTargetValue').value = '';
    document.getElementById('adminMsgTargetType').value = 'all';
    document.getElementById('adminMsgTargetValueGroup').hidden = true;
    document.getElementById('adminMsgLinkedDoc').value = '';
    document.querySelectorAll('#adminTargetSegmented .segmented-item')
        .forEach(i => i.classList.toggle('active', i.dataset.target === 'all'));
    pendingMsgFiles = [];
    refreshMsgChips();
}

function refreshMsgChips() {
    renderFileManager(
        document.getElementById('adminMsgFilesPreview'),
        [], pendingMsgFiles,
        () => {},
        (idx) => { pendingMsgFiles.splice(idx, 1); refreshMsgChips(); }
    );
}

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
            const kind = isPoll ? 'poll' : (msg.linkedDoc ? 'doc' : 'news');
            const KIND = {
                poll: { label: 'Підсумки голосування',
                        icon: '<line x1="18" y1="20" x2="18" y2="10"></line><line x1="12" y1="20" x2="12" y2="4"></line><line x1="6" y1="20" x2="6" y2="14"></line>' },
                doc:  { label: 'Документ ОСББ',
                        icon: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline>' },
                news: { label: 'Оголошення',
                        icon: '<path d="M3 11l18-5v12L3 13v-2z"></path><path d="M11.6 16.8a3 3 0 1 1-5.8-1.6"></path>' }
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

function openMessageModal(msg) {
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
// ІСТОРІЯ РОЗСИЛОК (адмін)
// ------------------------------------------------------------
export async function loadAdminHistory() {
    const host = document.getElementById('adminMsgHistoryContainer');
    if (!host) return;
    host.innerHTML = '<p class="list-empty">Завантаження…</p>';

    try {
        const snap = await getDocs(query(collection(db, 'messages'), orderBy('createdAt', 'desc')));
        if (snap.empty) { host.innerHTML = '<p class="list-empty">Історія порожня</p>'; return; }

        let html = '';
        const attachMap = [];
        snap.forEach(d => {
            const msg = d.data();
            let target = 'Усьому будинку';
            if (msg.targetType === 'entrance') target = `Парадні: ${escapeHtml(msg.targetValue)}`;
            if (msg.targetType === 'apartment') target = `Квартири: ${escapeHtml(msg.targetValue)}`;

            const readers = Object.entries(msg.readBy || {});
            const readHtml = readers.length
                ? readers.map(([apt, time]) =>
                    `<span class="read-badge">Кв.${escapeHtml(apt)}<small>${escapeHtml(time)}</small></span>`).join('')
                : '<span class="muted-note">Ще ніхто не прочитав</span>';

            attachMap.push({ id: d.id, files: msg.attachments || [] });

            html += `<div class="hist-card">
                <div class="hist-head">
                    <strong class="hist-title">${escapeHtml(msg.title)}</strong>
                    <span class="hist-date">${formatDateTime(msg.createdAt)}</span>
                </div>
                <span class="hist-target">${target}</span>
                <p class="hist-body">${escapeHtml(msg.body)}</p>
                <div class="attach-block hist-attach" data-hist-id="${d.id}"></div>
                <div class="hist-readers">
                    <span class="eyebrow">Прочитали (${readers.length})</span>
                    <div class="read-badges">${readHtml}</div>
                </div>
            </div>`;
        });

        host.innerHTML = html;
        attachMap.forEach(item => {
            if (item.files.length) {
                renderAttachments(host.querySelector(`.hist-attach[data-hist-id="${item.id}"]`), item.files);
            }
        });
    } catch (e) {
        console.error(e);
        host.innerHTML = '<p class="list-empty">Не вдалося завантажити історію</p>';
    }
}

/**
 * Одноразове дозаповнення поля recipients для повідомлень,
 * створених до переходу на серверну фільтрацію. Запускається
 * тихо при вході адміна, щоб старі оголошення не зникли.
 */
export async function backfillRecipients() {
    try {
        const snap = await getDocs(collection(db, 'messages'));
        const batch = writeBatch(db);
        let count = 0;
        snap.forEach(d => {
            const msg = d.data();
            if (!msg.recipients) {
                batch.update(d.ref, { recipients: buildRecipients(msg.targetType, msg.targetValue) });
                count++;
            }
        });
        if (count) {
            await batch.commit();
            console.info(`Міграція: оновлено ${count} повідомлень.`);
        }
    } catch (e) {
        console.error('Міграція recipients:', e);
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

    document.getElementById('adminSendMsgBtn')?.addEventListener('click', function () { sendMessage(this); });

    const bodyEl = document.getElementById('adminMsgBody');
    bodyEl?.addEventListener('input', function () {
        this.style.height = 'auto';
        this.style.height = this.scrollHeight + 'px';
    });

    // Сегментований вибір адресатів керує прихованим select
    document.querySelectorAll('#adminTargetSegmented .segmented-item').forEach(item => {
        item.addEventListener('click', () => {
            document.querySelectorAll('#adminTargetSegmented .segmented-item')
                .forEach(i => i.classList.toggle('active', i === item));
            const select = document.getElementById('adminMsgTargetType');
            select.value = item.dataset.target;
            const group = document.getElementById('adminMsgTargetValueGroup');
            group.hidden = item.dataset.target === 'all';
            if (item.dataset.target === 'all') document.getElementById('adminMsgTargetValue').value = '';
            const label = document.getElementById('adminTargetValueLabel');
            if (label) label.textContent = item.dataset.target === 'entrance'
                ? 'Номери парадних через кому' : 'Номери квартир через кому';
        });
    });

    const filesInput = document.getElementById('adminMsgFiles');
    filesInput?.addEventListener('change', () => {
        pendingMsgFiles.push(...Array.from(filesInput.files));
        filesInput.value = '';
        refreshMsgChips();
    });
}

function closeMessageModal() {
    import('./chat.js').then(c => c.stopComments());
    document.getElementById('msgModal').classList.remove('is-open');
    unlockScroll();
}
