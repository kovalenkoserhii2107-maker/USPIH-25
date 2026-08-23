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
import { escapeHtml, formatDateTime, toast, setBusy, lockScroll, unlockScroll,
         openSheet, closeAllSheets } from './ui.js';
import { renderAttachments, renderFileManager, getDocKind, docIconSvg } from './attachments.js';

// Статуси: 'new' → 'in_progress' → 'done'. Давні записи мають
// 'replied' — для правління це те саме, що 'done', тому нормалізуємо
// при читанні, а не міграцією: історія лишається недоторканою.
const STATUS = {
    new:         { label: 'Нове',     cls: 'st-new' },
    in_progress: { label: 'В роботі', cls: 'st-work' },
    done:        { label: 'Вирішено', cls: 'st-done' }
};
const OVERDUE_MS = 3 * 24 * 60 * 60 * 1000;

const normStatus = (s) => (s === 'replied' ? 'done' : (STATUS[s] ? s : 'new'));

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
        closeAllSheets();
        toast('Звернення надіслано', 'success');
        await loadUserRequests();
    } catch (e) {
        console.error(e);
        toast('Помилка надсилання', 'error');
    } finally {
        setBusy(btn, false);
    }
}

// Які відповіді мешканець уже бачив. Тримаємо на пристрої: сервер про це
// знати не мусить, а мітка потрібна лише власнику квартири.
const SEEN_KEY = 'uspih.seenReplies';
function loadSeen() {
    try { return JSON.parse(localStorage.getItem(SEEN_KEY)) || {}; } catch { return {}; }
}
function markSeen(id, ms) {
    const m = loadSeen();
    m[id] = ms;
    try { localStorage.setItem(SEEN_KEY, JSON.stringify(m)); } catch { /* приватний режим */ }
}

const msOf = (ts) => (ts?.toMillis ? ts.toMillis() : (ts?.toDate ? ts.toDate().getTime() : 0));

/** «2 дні тому» читається легше за «21.08, 16:31», коли важлива давність. */
function relTime(ms) {
    if (!ms) return '';
    const diff = Date.now() - ms;
    const min = Math.floor(diff / 60000);
    if (min < 2) return 'щойно';
    if (min < 60) return `${min} хв тому`;
    const h = Math.floor(min / 60);
    if (h < 24) return `${h} год тому`;
    const d = Math.floor(h / 24);
    if (d === 1) return 'учора';
    if (d < 7) return `${d} дні тому`;
    return new Date(ms).toLocaleDateString('uk-UA', { day: '2-digit', month: '2-digit', year: '2-digit' });
}

const USER_LABEL = { new: 'На розгляді', in_progress: 'В роботі', done: 'Вирішено' };

export async function loadUserRequests() {
    const host = document.getElementById('userRequestsContainer');
    const summary = document.getElementById('ureqSummary');
    if (!host) return;
    host.innerHTML = '<p class="list-empty">Завантаження…</p>';
    try {
        const snap = await getDocs(query(
            collection(db, 'requests'),
            where('apt', '==', session.apt),
            orderBy('createdAt', 'desc')
        ));
        if (snap.empty) {
            if (summary) summary.innerHTML = '';
            host.innerHTML = `<div class="ureq-empty">
                <svg viewBox="0 0 24 24" width="34" height="34" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"></path></svg>
                <p class="ureq-empty-title">Звернень ще не було</p>
                <p class="ureq-empty-hint">Протікає стеля, не працює домофон, згоріла лампочка — напишіть, і правління відповість тут.</p>
            </div>`;
            return;
        }

        const seen = loadSeen();
        const rows = snap.docs.map(d => {
            const r = d.data();
            const repliedMs = msOf(r.repliedAt);
            return {
                id: d.id, ...r,
                st: normStatus(r.status),
                createdMs: msOf(r.createdAt),
                repliedMs,
                isNewReply: Boolean(r.replyText) && repliedMs > (seen[d.id] || 0)
            };
        });

        if (summary) {
            const c = {
                new: rows.filter(r => r.st === 'new').length,
                in_progress: rows.filter(r => r.st === 'in_progress').length,
                done: rows.filter(r => r.st === 'done').length
            };
            summary.innerHTML = Object.entries(USER_LABEL)
                .filter(([k]) => c[k] > 0)
                .map(([k, label]) => `<div class="ureq-stat us-${k}">
                        <b>${c[k]}</b><span>${label.toLowerCase()}</span>
                    </div>`).join('');
        }

        host.innerHTML = rows.map(r => `
            <article class="ureq-card ${r.isNewReply ? 'has-new' : ''}" data-id="${r.id}" data-replied="${r.repliedMs}">
                <div class="ureq-head">
                    <span class="req-status req-status-${r.st}">${USER_LABEL[r.st]}</span>
                    ${r.isNewReply ? '<span class="ureq-new">Нова відповідь</span>' : ''}
                    <span class="ureq-date">${relTime(r.createdMs)}</span>
                </div>
                <p class="ureq-text">${escapeHtml(r.text || '')}</p>
                <div class="attach-block req-attach" data-req-id="${r.id}"></div>
                ${r.replyText ? `
                <div class="ureq-reply">
                    <div class="ureq-reply-head">
                        <span class="ureq-reply-avatar">
                            <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 21h18"></path><path d="M5 21V8l7-5 7 5v13"></path><path d="M10 21v-6h4v6"></path></svg>
                        </span>
                        Правління ОСББ · ${relTime(r.repliedMs)}
                    </div>
                    <p class="ureq-text">${escapeHtml(r.replyText)}</p>
                    <div class="attach-block reply-attach" data-req-id="${r.id}"></div>
                </div>` : `
                <p class="ureq-waiting">${r.st === 'in_progress'
                    ? 'Правління взяло звернення в роботу'
                    : 'Правління ще не відповіло'}</p>`}
            </article>`).join('');

        rows.forEach(r => {
            if (r.attachments?.length)
                renderAttachments(host.querySelector(`.req-attach[data-req-id="${r.id}"]`), r.attachments);
            if (r.replyAttachments?.length)
                renderAttachments(host.querySelector(`.reply-attach[data-req-id="${r.id}"]`), r.replyAttachments);
        });
    } catch (e) {
        console.error(e);
        host.innerHTML = '<p class="list-empty">Не вдалося завантажити звернення</p>';
    }
}

/** Скільки відповідей мешканець ще не читав — для значка в меню. */
export async function refreshRequestsBadge() {
    const el = document.getElementById('reqMenuBadge');
    if (!el) return;
    try {
        const snap = await getDocs(query(collection(db, 'requests'), where('apt', '==', session.apt)));
        const seen = loadSeen();
        const n = snap.docs.filter(d => {
            const r = d.data();
            return r.replyText && msOf(r.repliedAt) > (seen[d.id] || 0);
        }).length;
        el.textContent = n > 9 ? '9+' : n;
        el.style.display = n ? 'flex' : 'none';
        const { updateNavBadge } = await import('./ui.js');
        updateNavBadge();
    } catch (e) {
        // Немає звʼязку або правил — просто без лічильника
        console.warn('Лічильник звернень:', e);
        el.style.display = 'none';
    }
}

// ------------------------------------------------------------
// АДМІН: черга звернень
// ------------------------------------------------------------
let adminReqs = [];
let reqFilter = 'active';
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
        if (n) n.textContent = counts[b.dataset.filter] ?? 0;
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

    host.innerHTML = list.map(requestHtml).join('');
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

export async function loadAdminRequests() {
    const host = document.getElementById('adminRequestsContainer');
    if (!host) return;
    host.innerHTML = '<p class="list-empty">Завантаження…</p>';
    try {
        const snap = await getDocs(query(collection(db, 'requests'), orderBy('createdAt', 'desc')));
        adminReqs = snap.docs.map(d => {
            const r = d.data();
            return {
                id: d.id, ...r,
                st: normStatus(r.status),
                createdMs: r.createdAt?.toDate ? r.createdAt.toDate().getTime() : null
            };
        });
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
    document.getElementById('openNewReqBtn')?.addEventListener('click', () => openSheet('newRequestSheet'));

    // Дотик по картці знімає мітку «нова відповідь»: мешканець її побачив.
    document.getElementById('userRequestsContainer')?.addEventListener('click', (e) => {
        const card = e.target.closest('.ureq-card.has-new');
        if (!card) return;
        markSeen(card.dataset.id, Number(card.dataset.replied) || Date.now());
        card.classList.remove('has-new');
        card.querySelector('.ureq-new')?.remove();
        refreshRequestsBadge();
    });
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
