// ============================================================
// Звернення й База документів у панелі правління: черга звернень,
// відповіді, публікація документів. Кабінет мешканця цього коду не вантажить.
// ============================================================
import { db, storage } from './firebase.js';
import { audit } from './audit.js';
import {
    collection, getDocs, updateDoc, doc, query, orderBy, where, serverTimestamp, limit, startAfter, runTransaction
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import {
    ref as sRef, uploadBytes, getDownloadURL
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-storage.js";
import { escapeHtml, formatDateTime, toast, setBusy, lockScroll, unlockScroll } from './ui.js';
import { renderAttachments, renderFileManager } from './attachments.js';

import { STATUS, normStatus, uploadAll } from './requests.js';

const OVERDUE_MS = 3 * 24 * 60 * 60 * 1000;
let replyFiles = [];

let osbbDocFile = null;

// ------------------------------------------------------------
// АДМІН: черга звернень
// ------------------------------------------------------------
let adminReqs = [];

let reqFilter = 'active';

// Звернення читаємо не цілком. Незакриті приходять завжди всі — пропустити
// давнє, але не вирішене звернення не можна. Решта — сторінками від
// найновіших: вирішені за кілька років правлінню щоразу не потрібні, а
// кожне з них — окреме читання з квоти Firestore.
const REQ_PAGE = 50;

let reqCursor = null;       // останній документ показаної сторінки
let reqHasMore = false;


let reqSearchText = '';

let reqOpenId = null;

/** Коротко, скільки чекає — у рядку списку немає місця на «2 дн. 3 год.». */
function shortAge(ms) {
    const min = Math.floor(ms / 60000);
    if (min < 1) return 'щойно';
    if (min < 60) return `${min} хв`;
    const h = Math.floor(min / 60);
    if (h < 24) return `${h} год`;
    const d = Math.floor(h / 24);
    if (d < 31) return `${d} дн`;
    return `${Math.floor(d / 30)} міс`;
}

function previewText(text) {
    const one = String(text || '').replace(/\s+/g, ' ').trim();
    return one.length > 90 ? one.slice(0, 90) + '…' : (one || 'Без тексту');
}

function matchesFilter(r) {
    if (reqFilter === 'active' && r.st === 'done') return false;
    if (reqFilter === 'done' && r.st !== 'done') return false;
    if (reqSearchText) {
        const q = reqSearchText.toLowerCase();
        if (!String(r.apt).toLowerCase().includes(q) && !String(r.text || '').toLowerCase().includes(q)) return false;
    }
    return true;
}

function statusButtons(id, st) {
    return Object.entries(STATUS).map(([key, v]) =>
        `<button type="button" class="req-st-btn ${key === st ? 'active' : ''} ${v.cls}"
                 data-set-status="${key}" data-id="${id}">${v.label}</button>`).join('');
}

function requestHtml(r) {
    const s = STATUS[r.st];
    const age = r.createdMs ? shortAge(Date.now() - r.createdMs) : '';
    const overdue = r.st !== 'done' && r.createdMs && (Date.now() - r.createdMs) > OVERDUE_MS;
    const open = r.id === reqOpenId;
    const files = r.attachments || [];

    return `<article class="req-item ${open ? 'open' : ''} ${overdue ? 'req-overdue' : ''}" data-id="${r.id}" data-status="${r.st}">
        <button type="button" class="req-row" data-toggle="${r.id}">
            <span class="req-avatar">${escapeHtml(String(r.apt))}</span>
            <span class="req-main">
                <span class="req-line-top">
                    <span class="req-apt">Квартира ${escapeHtml(String(r.apt))}</span>
                    <span class="req-age ${overdue ? 'is-overdue' : ''}">${age}</span>
                </span>
                <span class="req-preview">${escapeHtml(previewText(r.text))}</span>
            </span>
            <span class="req-right">
                <span class="req-pill ${s.cls}">${s.label}</span>
                ${files.length ? `<span class="req-clip"><svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M21 12.5 12.5 21a5 5 0 0 1-7-7l8.5-8.5a3.5 3.5 0 0 1 5 5L10.5 19"></path></svg>${files.length}</span>` : ''}
            </span>
        </button>

        <div class="req-detail"><div class="req-detail-inner">
            <p class="req-full-text">${escapeHtml(r.text || '')}</p>
            <div class="attach-block req-attach" data-req-id="${r.id}"></div>

            ${r.replyText ? `<div class="req-reply">
                <span class="eyebrow">Відповідь правління · ${formatDateTime(r.repliedAt)}</span>
                <p class="req-full-text">${escapeHtml(r.replyText)}</p>
                <div class="attach-block reply-attach" data-req-id="${r.id}"></div>
            </div>` : ''}

            <span class="req-detail-label">Статус</span>
            <div class="req-st-row">${statusButtons(r.id, r.st)}</div>

            <div class="req-actions">
                <button type="button" class="btn-primary btn-compact btn-open-reply" data-id="${r.id}">
                    ${r.replyText ? 'Змінити відповідь' : 'Відповісти'}
                </button>
                <span class="req-created">Надійшло ${formatDateTime(r.createdAt)}</span>
            </div>
        </div></div>
    </article>`;
}

function renderAdminRequests() {
    const host = document.getElementById('adminRequestsContainer');
    if (!host) return;

    const counts = {
        active: adminReqs.filter(r => r.st !== 'done').length,
        done:   adminReqs.filter(r => r.st === 'done').length,
        all:    adminReqs.length
    };
    document.querySelectorAll('#reqFilters .req-filter').forEach(b => {
        const n = b.querySelector('.req-filter-n');
        // Активні підвантажені всі — їхнє число точне. Вирішених і всіх
        // може бути більше, ніж на показаних сторінках, — чесно кажемо «+».
        const partial = reqHasMore && b.dataset.filter !== 'active';
        if (n) n.textContent = `${counts[b.dataset.filter] ?? 0}${partial ? '+' : ''}`;
        b.classList.toggle('active', b.dataset.filter === reqFilter);
    });

    const list = adminReqs.filter(matchesFilter);
    if (!list.length) {
        host.innerHTML = `<p class="list-empty">${
            reqSearchText ? 'Нічого не знайдено' :
            reqFilter === 'active' ? 'Усе опрацьовано — активних звернень немає' :
            reqFilter === 'done' ? 'Вирішених звернень ще немає' :
            'Немає звернень від мешканців'}</p>`;
        return;
    }

    host.innerHTML = list.map(requestHtml).join('')
        + (reqHasMore && reqFilter !== 'active'
            ? '<button type="button" class="btn-soft btn-compact list-more" id="reqMoreBtn">Показати давніші</button>'
            : '');
    document.getElementById('reqMoreBtn')?.addEventListener('click', function () {
        setBusy(this, true, 'Завантаження…');
        loadAdminRequests(true);
    });
    // Вкладення малюємо лише для розгорнутого — решта їх не показує,
    // і тягнути прев’ю для всієї черги нема сенсу.
    const opened = list.find(r => r.id === reqOpenId);
    if (opened) {
        if (opened.attachments?.length)
            renderAttachments(host.querySelector(`.req-attach[data-req-id="${opened.id}"]`), opened.attachments);
        if (opened.replyAttachments?.length)
            renderAttachments(host.querySelector(`.reply-attach[data-req-id="${opened.id}"]`), opened.replyAttachments);
    }

    const badge = document.getElementById('adminReqBadge');
    if (badge) {
        badge.textContent = counts.active;
        badge.style.display = counts.active ? 'flex' : 'none';
    }
}

const toReq = (d) => {
    const r = d.data();
    return {
        id: d.id, ...r,
        st: normStatus(r.status),
        createdMs: r.createdAt?.toDate ? r.createdAt.toDate().getTime() : null
    };
};

/**
 * @param {boolean} more true — дочитати наступну сторінку давніших, не
 *        скидаючи вже показане. Слухач кліку передає сюди подію, тому
 *        порівнюємо строго з true.
 */
export async function loadAdminRequests(more = false) {
    const host = document.getElementById('adminRequestsContainer');
    if (!host) return;
    const append = more === true;
    if (!append) {
        host.innerHTML = '<p class="list-empty">Завантаження…</p>';
        reqCursor = null;
    }
    try {
        const pageQuery = reqCursor
            ? query(collection(db, 'requests'), orderBy('createdAt', 'desc'), startAfter(reqCursor), limit(REQ_PAGE))
            : query(collection(db, 'requests'), orderBy('createdAt', 'desc'), limit(REQ_PAGE));
        // Незакриті — окремим запитом за статусом: вони мають бути в списку,
        // навіть якщо старші за будь-яку підвантажену сторінку. Одне поле
        // в умові — Firestore обходиться без складеного індексу.
        const [openSnap, pageSnap] = await Promise.all([
            append ? null : getDocs(query(collection(db, 'requests'),
                where('status', 'in', ['new', 'in_progress']))),
            getDocs(pageQuery)
        ]);

        const byId = new Map(append ? adminReqs.map(r => [r.id, r]) : []);
        [...(openSnap?.docs || []), ...pageSnap.docs].forEach(d => byId.set(d.id, toReq(d)));
        adminReqs = [...byId.values()].sort((a, b) => (b.createdMs || 0) - (a.createdMs || 0));

        reqCursor = pageSnap.docs.at(-1) || reqCursor;
        reqHasMore = pageSnap.size === REQ_PAGE;
        renderAdminRequests();
    } catch (e) {
        console.error(e);
        host.innerHTML = '<p class="list-empty">Не вдалося завантажити звернення</p>';
    }
}

async function setRequestStatus(id, status) {
    const req = adminReqs.find(r => r.id === id);
    if (!req || req.st === status) return;
    const prev = req.st;
    req.st = status;                       // показуємо одразу, не чекаючи сервера
    renderAdminRequests();
    try {
        await updateDoc(doc(db, 'requests', id), { status, statusAt: serverTimestamp() });
        audit('request.status', { target: `requests/${id}`, summary: `Звернення кв. ${req.apt}: статус «${status}»` });
    } catch (e) {
        console.error(e);
        req.st = prev;                     // сервер відмовив — повертаємо як було
        renderAdminRequests();
        toast('Не вдалося змінити статус', 'error');
    }
}

// ------------------------------------------------------------
// АДМІН: відповідь на звернення
// ------------------------------------------------------------
function openReplyModal(id) {
    const req = adminReqs.find(r => r.id === id);
    if (!req) return;
    document.getElementById('replyModalTitle').textContent = `Відповідь квартирі ${req.apt}`;
    document.getElementById('replyModalOriginalText').textContent = req.text || '';
    document.getElementById('replyModalReqId').value = id;
    document.getElementById('replyModalReqApt').value = req.apt;
    // Виправлення відповіді не має стирати вже написане.
    document.getElementById('replyModalBody').value = req.replyText || '';
    document.getElementById('replyMarkDone').checked = req.st !== 'in_progress';
    replyFiles = [];
    refreshReplyChips();
    document.getElementById('adminReplyModal').classList.add('is-open');
    lockScroll();
}

function closeReplyModal() {
    document.getElementById('adminReplyModal').classList.remove('is-open');
    unlockScroll();
}

async function sendReply(btn) {
    const id = document.getElementById('replyModalReqId').value;
    const text = document.getElementById('replyModalBody').value.trim();
    if (!text) return toast('Напишіть відповідь', 'error');

    const markDone = document.getElementById('replyMarkDone').checked;
    const req = adminReqs.find(r => r.id === id);

    setBusy(btn, true, 'Надсилання…');
    try {
        const fresh = await uploadAll(replyFiles, `replies/${id}`);
        // Нові файли додаються до вже надісланих, а не заміняють їх:
        // під час виправлення відповіді вкладення втрачати не можна.
        const attachments = [...(req?.replyAttachments || []), ...fresh];
        const status = markDone ? 'done' : 'in_progress';

        await updateDoc(doc(db, 'requests', id), {
            status, replyText: text, replyAttachments: attachments,
            repliedAt: serverTimestamp(), statusAt: serverTimestamp()
        });

        if (req) {
            req.st = status; req.status = status;
            req.replyText = text; req.replyAttachments = attachments;
            req.repliedAt = { toMillis: () => Date.now() };   // formatDateTime читає саме toMillis
        }
        closeReplyModal();
        await audit('request.reply', { target: `requests/${id}`, summary: `Відповідь на звернення${req ? ` кв. ${req.apt}` : ''}${markDone ? ', закрито' : ''}` });
        toast(markDone ? 'Відповідь надіслано, звернення закрито' : 'Відповідь надіслано', 'success');
        renderAdminRequests();
    } catch (e) {
        console.error(e);
        toast('Помилка надсилання відповіді', 'error');
    } finally {
        setBusy(btn, false);
    }
}

// ------------------------------------------------------------
// БАЗА ДОКУМЕНТІВ ОСББ
// ------------------------------------------------------------
/** Єдина публікація готового або сформованого документа. ID можна зберегти для повторної спроби. */
export async function publishOsbbDocument({ title, category, file, metadata = {}, documentId }) {
    if (!String(title || '').trim() || !file) throw new Error('Вкажіть назву та оберіть файл');
    if (file.size <= 0 || file.size >= 30 * 1024 * 1024) throw new Error('Документ має бути непорожнім і меншим за 30 МБ');
    const documentRef = documentId ? doc(db, 'osbb_documents', documentId) : doc(collection(db, 'osbb_documents'));
    const contentType = file.type || 'application/octet-stream';
    const fileName = file.name || `Document_${documentRef.id}.pdf`;
    const fileRef = sRef(storage, `osbb_docs/${documentRef.id}_${fileName.replace(/[\\/?#]/g, '_')}`);
    await uploadBytes(fileRef, file, { contentType });
    const url = await getDownloadURL(fileRef);
    await runTransaction(db, async tx => {
        const previous = await tx.get(documentRef);
        tx.set(documentRef, { ...metadata, title: title.trim(), category, fileName, url,
            size: file.size, type: contentType, createdAt: previous.data()?.createdAt || serverTimestamp() });
    });
    return { id: documentRef.id, url, title };
}

export async function uploadOsbbDoc(btn) {
    const title = document.getElementById('osbbDocTitle').value.trim();
    const category = document.getElementById('osbbDocCategory').value;
    if (!title || !osbbDocFile) return toast('Вкажіть назву та оберіть файл', 'error');
    if (osbbDocFile.size >= 30 * 1024 * 1024) return toast('Документ має бути меншим за 30 МБ', 'error');

    setBusy(btn, true, 'Завантаження…');
    try {
        await publishOsbbDocument({ title, category, file: osbbDocFile });
        document.getElementById('osbbDocTitle').value = '';
        osbbDocFile = null;
        refreshOsbbChips();
        await audit('document.publish', { target: 'osbb_documents', summary: `Документ «${title}» додано до Бази`, details: { category } });
        toast('Документ додано до Бази', 'success');
        await populateDocsDropdown();
    } catch (e) {
        console.error(e);
        toast(e.code === 'storage/unauthorized'
            ? 'Немає дозволу завантажити документ. Перевірте права доступу до сховища файлів.'
            : 'Помилка завантаження', 'error');
    } finally {
        setBusy(btn, false);
    }
}

export async function populateDocsDropdown() {
    const select = document.getElementById('adminMsgLinkedDoc');
    if (!select) return;
    try {
        const snap = await getDocs(query(collection(db, 'osbb_documents'), orderBy('createdAt', 'desc'), limit(200)));
        select.innerHTML = '<option value="">Не прикріплювати</option>';
        snap.forEach(d => {
            const doc = d.data();
            const opt = document.createElement('option');
            opt.value = JSON.stringify({ name: doc.title, url: doc.url, type: doc.type || '', size: doc.size || 0 });
            opt.textContent = doc.title;
            select.appendChild(opt);
        });
    } catch (e) { console.error(e); }
}

function refreshReplyChips() {
    renderFileManager(document.getElementById('replyModalFilesPreview'), [], replyFiles,
        () => {}, (i) => { replyFiles.splice(i, 1); refreshReplyChips(); });
}

function refreshOsbbChips() {
    renderFileManager(document.getElementById('osbbDocFilePreview'), [], osbbDocFile ? [osbbDocFile] : [],
        () => {}, () => { osbbDocFile = null; refreshOsbbChips(); });
}

export function initRequestsAdmin() {
    document.getElementById('sendReplyBtn')?.addEventListener('click', function () { sendReply(this); });
    document.getElementById('closeReplyModalBtn')?.addEventListener('click', closeReplyModal);

    // Черга звернень. Слухач делегований: список перемальовується
    // при кожній зміні фільтра чи статусу.
    document.getElementById('adminRequestsContainer')?.addEventListener('click', (e) => {
        const st = e.target.closest('[data-set-status]');
        if (st) { setRequestStatus(st.dataset.id, st.dataset.setStatus); return; }

        const rep = e.target.closest('.btn-open-reply');
        if (rep) { openReplyModal(rep.dataset.id); return; }

        const row = e.target.closest('[data-toggle]');
        if (row) {
            reqOpenId = reqOpenId === row.dataset.toggle ? null : row.dataset.toggle;
            renderAdminRequests();
        }
    });

    document.getElementById('reqFilters')?.addEventListener('click', (e) => {
        const b = e.target.closest('.req-filter');
        if (!b) return;
        reqFilter = b.dataset.filter;
        renderAdminRequests();
    });

    const search = document.getElementById('reqSearch');
    search?.addEventListener('input', () => {
        reqSearchText = search.value.trim();
        renderAdminRequests();
    });
    document.getElementById('uploadOsbbDocBtn')?.addEventListener('click', function () { uploadOsbbDoc(this); });

    const replyInput = document.getElementById('replyModalFiles');
    replyInput?.addEventListener('change', () => {
        replyFiles.push(...Array.from(replyInput.files));
        replyInput.value = '';
        refreshReplyChips();
    });

    const osbbInput = document.getElementById('osbbDocFile');
    osbbInput?.addEventListener('change', () => {
        osbbDocFile = osbbInput.files[0] || null;
        osbbInput.value = '';
        refreshOsbbChips();
    });
}
