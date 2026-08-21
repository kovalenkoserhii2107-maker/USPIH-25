// ============================================================
// Звернення мешканців до правління + база документів ОСББ.
// ============================================================
import { db, storage, session } from './firebase.js';
import {
    collection, addDoc, getDocs, updateDoc, doc, query, orderBy, where, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js";
import {
    ref as sRef, uploadBytes, getDownloadURL
} from "https://www.gstatic.com/firebasejs/10.8.1/firebase-storage.js";
import { escapeHtml, formatDateTime, toast, setBusy } from './ui.js';
import { renderAttachments, renderFileManager, getDocKind, docIconSvg } from './attachments.js';

let userReqFiles = [];
let replyFiles = [];
let osbbDocFile = null;

async function uploadAll(files, folder) {
    return Promise.all(files.map(async (file) => {
        const fileRef = sRef(storage, `${folder}/${Date.now()}_${file.name}`);
        await uploadBytes(fileRef, file);
        return { name: file.name, url: await getDownloadURL(fileRef), type: file.type || '', size: file.size || 0 };
    }));
}

// ------------------------------------------------------------
// МЕШКАНЕЦЬ: створення та історія звернень
// ------------------------------------------------------------
export async function sendUserRequest(btn) {
    const text = document.getElementById('userReqBody').value.trim();
    if (!text) return toast('Опишіть ваше питання', 'error');

    setBusy(btn, true, 'Надсилання…');
    try {
        const attachments = await uploadAll(userReqFiles, `requests/${session.apt}`);
        await addDoc(collection(db, 'requests'), {
            apt: session.apt,
            text,
            attachments,
            status: 'new',
            createdAt: serverTimestamp()
        });
        document.getElementById('userReqBody').value = '';
        userReqFiles = [];
        refreshUserReqChips();
        toast('Звернення надіслано', 'success');
        await loadUserRequests();
    } catch (e) {
        console.error(e);
        toast('Помилка надсилання', 'error');
    } finally {
        setBusy(btn, false);
    }
}

export async function loadUserRequests() {
    const host = document.getElementById('userRequestsContainer');
    if (!host) return;
    host.innerHTML = '<p class="list-empty">Завантаження…</p>';
    try {
        const snap = await getDocs(query(
            collection(db, 'requests'),
            where('apt', '==', session.apt),
            orderBy('createdAt', 'desc')
        ));
        if (snap.empty) { host.innerHTML = '<p class="list-empty">Ви ще не надсилали звернень</p>'; return; }

        let html = '';
        const maps = [];
        snap.forEach(d => {
            const req = d.data();
            const replied = req.status === 'replied';
            maps.push({ id: d.id, files: req.attachments || [], replyFiles: req.replyAttachments || [] });
            html += `<div class="req-card ${replied ? 'req-done' : 'req-pending'}">
                <div class="req-head">
                    <span class="req-status ${replied ? 'req-status-done' : 'req-status-new'}">${replied ? 'Є відповідь' : 'На розгляді'}</span>
                    <span class="req-date">${formatDateTime(req.createdAt)}</span>
                </div>
                <p class="req-text">${escapeHtml(req.text)}</p>
                <div class="attach-block req-attach" data-req-id="${d.id}"></div>
                ${replied ? `<div class="reply-block">
                    <span class="eyebrow">Відповідь правління</span>
                    <p class="req-text">${escapeHtml(req.replyText || '')}</p>
                    <div class="attach-block reply-attach" data-req-id="${d.id}"></div>
                </div>` : ''}
            </div>`;
        });
        host.innerHTML = html;
        maps.forEach(m => {
            if (m.files.length) renderAttachments(host.querySelector(`.req-attach[data-req-id="${m.id}"]`), m.files);
            if (m.replyFiles.length) renderAttachments(host.querySelector(`.reply-attach[data-req-id="${m.id}"]`), m.replyFiles);
        });
    } catch (e) {
        console.error(e);
        host.innerHTML = '<p class="list-empty">Не вдалося завантажити звернення</p>';
    }
}

// ------------------------------------------------------------
// АДМІН: перегляд звернень і відповідь
// ------------------------------------------------------------
export async function loadAdminRequests() {
    const host = document.getElementById('adminRequestsContainer');
    const badge = document.getElementById('adminReqBadge');
    if (!host) return;
    host.innerHTML = '<p class="list-empty">Завантаження…</p>';

    try {
        const snap = await getDocs(query(collection(db, 'requests'), orderBy('createdAt', 'desc')));
        if (snap.empty) {
            host.innerHTML = '<p class="list-empty">Немає звернень від мешканців</p>';
            if (badge) badge.style.display = 'none';
            return;
        }

        let html = '', pending = 0;
        const maps = [];
        snap.forEach(d => {
            const req = d.data();
            const replied = req.status === 'replied';
            if (!replied) pending++;
            maps.push({ id: d.id, files: req.attachments || [] });

            html += `<div class="req-card ${replied ? 'req-done' : 'req-pending'}">
                <div class="req-head">
                    <span class="req-apt-badge">${escapeHtml(String(req.apt))}</span>
                    <span class="req-head-text">
                        <span class="req-apt-label">Квартира ${escapeHtml(String(req.apt))}</span>
                        <span class="req-date">${formatDateTime(req.createdAt)}</span>
                    </span>
                    <span class="req-status ${replied ? 'req-status-done' : 'req-status-new'}">${replied ? 'Відповіли' : 'Нове'}</span>
                </div>
                <p class="req-text">${escapeHtml(req.text)}</p>
                <div class="attach-block req-attach" data-req-id="${d.id}"></div>
                ${replied ? '' : `<button type="button" class="btn-primary btn-compact btn-open-reply"
                    data-id="${d.id}" data-apt="${escapeHtml(String(req.apt))}" data-text="${encodeURIComponent(req.text)}">Відповісти</button>`}
            </div>`;
        });

        host.innerHTML = html;
        maps.forEach(m => {
            if (m.files.length) renderAttachments(host.querySelector(`.req-attach[data-req-id="${m.id}"]`), m.files);
        });
        if (badge) {
            badge.textContent = pending;
            badge.style.display = pending ? 'flex' : 'none';
        }

        host.querySelectorAll('.btn-open-reply').forEach(btn => {
            btn.addEventListener('click', () => openReplyModal(btn.dataset.id, btn.dataset.apt, decodeURIComponent(btn.dataset.text)));
        });
    } catch (e) {
        console.error(e);
        host.innerHTML = '<p class="list-empty">Не вдалося завантажити звернення</p>';
    }
}

function openReplyModal(id, apt, text) {
    document.getElementById('replyModalTitle').textContent = `Відповідь квартирі ${apt}`;
    document.getElementById('replyModalOriginalText').textContent = text;
    document.getElementById('replyModalReqId').value = id;
    document.getElementById('replyModalReqApt').value = apt;
    document.getElementById('replyModalBody').value = '';
    replyFiles = [];
    refreshReplyChips();
    document.getElementById('adminReplyModal').classList.add('is-open');
    document.body.classList.add('no-scroll');
}

function closeReplyModal() {
    document.getElementById('adminReplyModal').classList.remove('is-open');
    document.body.classList.remove('no-scroll');
}

async function sendReply(btn) {
    const id = document.getElementById('replyModalReqId').value;
    const text = document.getElementById('replyModalBody').value.trim();
    if (!text) return toast('Напишіть відповідь', 'error');

    setBusy(btn, true, 'Надсилання…');
    try {
        const attachments = await uploadAll(replyFiles, `replies/${id}`);
        await updateDoc(doc(db, 'requests', id), {
            status: 'replied',
            replyText: text,
            replyAttachments: attachments,
            repliedAt: serverTimestamp()
        });
        closeReplyModal();
        toast('Відповідь надіслано', 'success');
        await loadAdminRequests();
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
export async function uploadOsbbDoc(btn) {
    const title = document.getElementById('osbbDocTitle').value.trim();
    const category = document.getElementById('osbbDocCategory').value;
    if (!title || !osbbDocFile) return toast('Вкажіть назву та оберіть файл', 'error');

    setBusy(btn, true, 'Завантаження…');
    try {
        const fileRef = sRef(storage, `osbb_docs/${Date.now()}_${osbbDocFile.name}`);
        await uploadBytes(fileRef, osbbDocFile);
        const url = await getDownloadURL(fileRef);
        await addDoc(collection(db, 'osbb_documents'), {
            title, category, fileName: osbbDocFile.name, url,
            size: osbbDocFile.size, type: osbbDocFile.type || '', createdAt: serverTimestamp()
        });
        document.getElementById('osbbDocTitle').value = '';
        osbbDocFile = null;
        refreshOsbbChips();
        toast('Документ додано до Бази', 'success');
        await populateDocsDropdown();
    } catch (e) {
        console.error(e);
        toast('Помилка завантаження', 'error');
    } finally {
        setBusy(btn, false);
    }
}

export async function loadOsbbDocs() {
    const host = document.getElementById('osbbDocsContainer');
    if (!host) return;
    host.innerHTML = '<p class="list-empty">Завантаження документів…</p>';
    try {
        const snap = await getDocs(query(collection(db, 'osbb_documents'), orderBy('createdAt', 'desc')));
        if (snap.empty) { host.innerHTML = '<p class="list-empty">База документів порожня</p>'; return; }

        const groups = {};
        snap.forEach(d => {
            const doc = d.data();
            (groups[doc.category || 'Інше'] ||= []).push(doc);
        });

        host.innerHTML = Object.entries(groups).map(([cat, docs]) => `
            <div class="doc-group">
                <h3 class="doc-group-title">${escapeHtml(cat)}</h3>
                <div class="doc-attach-list">
                    ${docs.map((doc, i) => {
                        const kind = getDocKind({ name: doc.fileName, type: doc.type });
                        return `<button type="button" class="doc-attach-row osbb-doc-row"
                                    data-cat="${escapeHtml(cat)}" data-idx="${i}">
                            <span class="file-icon icon-${kind}">${docIconSvg(kind)}</span>
                            <span class="doc-attach-info">
                                <span class="doc-attach-name">${escapeHtml(doc.title)}</span>
                                <span class="doc-attach-meta">${formatDateTime(doc.createdAt)}</span>
                            </span>
                            <svg class="row-chevron" viewBox="0 0 24 24" width="18" height="18" stroke="currentColor" stroke-width="2" fill="none"><polyline points="9 18 15 12 9 6"></polyline></svg>
                        </button>`;
                    }).join('')}
                </div>
            </div>`).join('');

        host.querySelectorAll('.osbb-doc-row').forEach(row => {
            row.addEventListener('click', async () => {
                const d = groups[row.dataset.cat][parseInt(row.dataset.idx, 10)];
                const { openDocViewer } = await import('./attachments.js');
                openDocViewer({ name: d.fileName || d.title, url: d.url, type: d.type, size: d.size });
            });
        });
    } catch (e) {
        console.error(e);
        host.innerHTML = '<p class="list-empty">Не вдалося завантажити базу</p>';
    }
}

export async function populateDocsDropdown() {
    const select = document.getElementById('adminMsgLinkedDoc');
    if (!select) return;
    try {
        const snap = await getDocs(query(collection(db, 'osbb_documents'), orderBy('createdAt', 'desc')));
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

// ------------------------------------------------------------
// ЧІПИ ФАЙЛІВ
// ------------------------------------------------------------
function refreshUserReqChips() {
    renderFileManager(document.getElementById('userReqFilesPreview'), [], userReqFiles,
        () => {}, (i) => { userReqFiles.splice(i, 1); refreshUserReqChips(); });
}
function refreshReplyChips() {
    renderFileManager(document.getElementById('replyModalFilesPreview'), [], replyFiles,
        () => {}, (i) => { replyFiles.splice(i, 1); refreshReplyChips(); });
}
function refreshOsbbChips() {
    renderFileManager(document.getElementById('osbbDocFilePreview'), [], osbbDocFile ? [osbbDocFile] : [],
        () => {}, () => { osbbDocFile = null; refreshOsbbChips(); });
}

export function initRequests() {
    document.getElementById('sendUserReqBtn')?.addEventListener('click', function () { sendUserRequest(this); });
    document.getElementById('sendReplyBtn')?.addEventListener('click', function () { sendReply(this); });
    document.getElementById('closeReplyModalBtn')?.addEventListener('click', closeReplyModal);
    document.getElementById('uploadOsbbDocBtn')?.addEventListener('click', function () { uploadOsbbDoc(this); });

    const userInput = document.getElementById('userReqFiles');
    userInput?.addEventListener('change', () => {
        userReqFiles.push(...Array.from(userInput.files));
        userInput.value = '';
        refreshUserReqChips();
    });

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
