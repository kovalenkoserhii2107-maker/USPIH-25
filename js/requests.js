// ============================================================
// Звернення мешканців до правління + база документів ОСББ.
// ============================================================
import { db, storage, session } from './firebase.js';
import {
    collection, addDoc, getDocs, query, orderBy, where, serverTimestamp, limit, startAfter
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import {
    ref as sRef, uploadBytes, getDownloadURL
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-storage.js";
import { escapeHtml, formatDateTime, toast, setBusy, openSheet, closeAllSheets } from './ui.js';
import { renderAttachments, renderFileManager, getDocKind, docIconSvg } from './attachments.js';

// Статуси: 'new' → 'in_progress' → 'done'. Давні записи мають
// 'replied' — для правління це те саме, що 'done', тому нормалізуємо
// при читанні, а не міграцією: історія лишається недоторканою.
export const STATUS = {
    new:         { label: 'Нове',     cls: 'st-new' },
    in_progress: { label: 'В роботі', cls: 'st-work' },
    done:        { label: 'Вирішено', cls: 'st-done' }
};

export const normStatus = (s) => (s === 'replied' ? 'done' : (STATUS[s] ? s : 'new'));

let userReqFiles = [];
const MAX_FILES = 10;   // стільки ж пропускають правила Firestore
let osbbDocs = [];
let osbbDocsCursor = null;
let osbbDocsHaveMore = false;

export async function uploadAll(files, folder) {
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

export async function loadOsbbDocs(append = false) {
    const host = document.getElementById('osbbDocsContainer');
    if (!host) return;
    if (!append) {
        host.innerHTML = '<p class="list-empty">Завантаження документів…</p>';
        osbbDocs = [];
        osbbDocsCursor = null;
    }
    try {
        const constraints = [orderBy('createdAt', 'desc')];
        if (append && osbbDocsCursor) constraints.push(startAfter(osbbDocsCursor));
        constraints.push(limit(40));
        const snap = await getDocs(query(collection(db, 'osbb_documents'), ...constraints));
        osbbDocsCursor = snap.docs[snap.docs.length - 1] || osbbDocsCursor;
        osbbDocsHaveMore = snap.size === 40;
        osbbDocs.push(...snap.docs.map(d => d.data()));
        if (!osbbDocs.length) { host.innerHTML = '<p class="list-empty">База документів порожня</p>'; return; }

        const groups = {};
        osbbDocs.forEach(doc => {
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
            </div>`).join('') + (osbbDocsHaveMore
            ? '<button type="button" class="btn-soft osbb-docs-more">Показати ще</button>' : '');

        host.querySelectorAll('.osbb-doc-row').forEach(row => {
            row.addEventListener('click', async () => {
                const d = groups[row.dataset.cat][parseInt(row.dataset.idx, 10)];
                const { openDocViewer } = await import('./attachments.js');
                openDocViewer({ name: d.fileName || d.title, url: d.url, type: d.type, size: d.size });
            });
        });
        host.querySelector('.osbb-docs-more')?.addEventListener('click', () => loadOsbbDocs(true));
    } catch (e) {
        console.error(e);
        host.innerHTML = '<p class="list-empty">Не вдалося завантажити базу</p>';
    }
}

// ------------------------------------------------------------
// ЧІПИ ФАЙЛІВ
// ------------------------------------------------------------
function refreshUserReqChips() {
    renderFileManager(document.getElementById('userReqFilesPreview'), [], userReqFiles,
        () => {}, (i) => { userReqFiles.splice(i, 1); refreshUserReqChips(); });
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
    const userInput = document.getElementById('userReqFiles');
    userInput?.addEventListener('change', () => {
        userReqFiles.push(...Array.from(userInput.files));
        userInput.value = '';
        if (userReqFiles.length > MAX_FILES) {
            userReqFiles = userReqFiles.slice(0, MAX_FILES);
            toast(`Не більше ${MAX_FILES} файлів у зверненні`, 'error');
        }
        refreshUserReqChips();
    });

}
