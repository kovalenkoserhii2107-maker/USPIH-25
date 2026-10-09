// ============================================================
// Оголошення в панелі правління: розсилка, історія, сповіщення
// квартирі. Кабінет мешканця цього коду не вантажить.
// ============================================================
import { db, storage } from './firebase.js';
import { audit } from './audit.js';
import {
    collection, addDoc, getDocs, query, orderBy, serverTimestamp, limit, startAfter
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import {
    ref as sRef, uploadBytes, getDownloadURL
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-storage.js";
import { escapeHtml, formatDateTime, toast, setBusy } from './ui.js';
import { renderAttachments, renderFileManager } from './attachments.js';

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

/**
 * Готує форму розсилки, але НЕ надсилає.
 *
 * Нагадування про звірку списків збирається саме тут: правління
 * бачить текст і перелік квартир перед відправкою. Надсилати потай
 * від його імені було б неправильно, та й нової логіки не треба —
 * усе робить наявна розсилка.
 */
export function prefillAnnouncement({ title = '', body = '', apartments = [] }) {
    const set = (id, v) => { const el = document.getElementById(id); if (el) el.value = v; };
    set('adminMsgTitle', title);
    set('adminMsgBody', body);

    const targeted = apartments.length > 0;
    set('adminMsgTargetType', targeted ? 'apartment' : 'all');
    set('adminMsgTargetValue', apartments.join(', '));
    const group = document.getElementById('adminMsgTargetValueGroup');
    if (group) group.hidden = !targeted;
    document.querySelectorAll('#adminTargetSegmented .segmented-item')
        .forEach(i => i.classList.toggle('active', i.dataset.target === (targeted ? 'apartment' : 'all')));
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

        await audit('message.send', { target: 'messages', summary: `Оголошення «${title}»`, details: { targetType, targetValue } });
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

/**
 * Службове сповіщення одній квартирі — у дзвіночок.
 *
 * Рішення правління щодо співвласників мешканець має побачити там,
 * де він звик шукати новини, а не смугою під списком: смуга або
 * висить вічно, або зникає непоміченою. Тут вона стає звичайним
 * повідомленням — з міткою «непрочитане», датою і повним текстом.
 *
 * Пише лише правління: створення в messages дозволене адміністратору.
 * Помилка тут не має зривати саму дію — рішення вже в базі, тож
 * ловимо її на місці й лише пишемо в журнал.
 */
export async function notifyApartment({ apt, title, body, kind = 'owners' }) {
    try {
        await addDoc(collection(db, 'messages'), {
            title, body, kind,
            targetType: 'apartment', targetValue: String(apt),
            recipients: [`apt:${apt}`],
            attachments: [], linkedDoc: null,
            createdAt: serverTimestamp(),
            readBy: {}
        });
        return true;
    } catch (e) {
        console.error('Сповіщення квартири:', e);
        return false;
    }
}

// ------------------------------------------------------------
// ІСТОРІЯ РОЗСИЛОК (адмін)
// ------------------------------------------------------------
// Історію розсилок читаємо сторінками. Раніше при кожному вході правління
// вона підвантажувалася вся — за рік це сотні оголошень, і кожне з них
// окреме читання з квоти Firestore, хоча дивляться лише кілька останніх.
const HISTORY_PAGE = 30;

let historyCursor = null;

/**
 * @param {boolean} more true — дочитати давніші під уже показаними.
 *        Слухач кліку «Оновити» передає сюди подію, тож порівнюємо
 *        строго з true, інакше оновлення дописувало б, а не оновлювало.
 */
export async function loadAdminHistory(more = false) {
    const host = document.getElementById('adminMsgHistoryContainer');
    if (!host) return;
    const append = more === true;
    if (!append) {
        host.innerHTML = '<p class="list-empty">Завантаження…</p>';
        historyCursor = null;
    }

    try {
        const snap = await getDocs(historyCursor
            ? query(collection(db, 'messages'), orderBy('createdAt', 'desc'), startAfter(historyCursor), limit(HISTORY_PAGE))
            : query(collection(db, 'messages'), orderBy('createdAt', 'desc'), limit(HISTORY_PAGE)));
        if (snap.empty && !append) { host.innerHTML = '<p class="list-empty">Історія порожня</p>'; return; }

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

        historyCursor = snap.docs.at(-1) || historyCursor;
        const moreBtn = snap.size === HISTORY_PAGE
            ? '<button type="button" class="btn-soft btn-compact list-more" id="histMoreBtn">Показати давніші</button>'
            : '';
        if (append) {
            host.querySelector('#histMoreBtn')?.remove();
            host.insertAdjacentHTML('beforeend', html + moreBtn);
        } else {
            host.innerHTML = html + moreBtn;
        }
        document.getElementById('histMoreBtn')?.addEventListener('click', function () {
            setBusy(this, true, 'Завантаження…');
            loadAdminHistory(true);
        });
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

export function initMessagesAdmin() {
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
