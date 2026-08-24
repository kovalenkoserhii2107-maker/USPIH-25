// ============================================================
// Голосування та опитування.
//
// Голос лежить окремим документом у polls/{id}/votes/{apt},
// де ID документа — номер квартири. Тому одна квартира фізично
// не може подати два голоси: другий запис просто перезаписав би
// перший. Правила Firestore дозволяють писати лише за свою
// квартиру, лише в активне опитування і лише один із варіантів.
// ============================================================
import { db, storage, session } from './firebase.js';
import {
    collection, addDoc, getDocs, getDoc, setDoc, updateDoc, doc,
    query, where, orderBy, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js";
import {
    ref as sRef, uploadBytes, getDownloadURL
} from "https://www.gstatic.com/firebasejs/10.8.1/firebase-storage.js";
import { escapeHtml, formatDateTime, toast, setBusy, confirmDialog, normName } from './ui.js';
import { renderAttachments, renderFileManager } from './attachments.js';
import { buildRecipients } from './messages.js';
import { fetchDirectory } from './directory.js';

let pendingPollFiles = [];

// Барви стовпчиків. Варіанти — довільні рядки, тож семантику
// («за» — зелений, «проти» — червоний) вгадати не можна;
// беремо стабільний перебір за порядком варіанта.
const BAR_COLORS = ['var(--blue)', 'var(--green)', 'var(--orange)', 'var(--purple)', 'var(--red)'];

const barColor = (i) => BAR_COLORS[i % BAR_COLORS.length];

/** Строк минув? Опитування без строку триває, доки його не закриють вручну. */
function isExpired(poll) {
    if (!poll.deadline) return false;
    const at = poll.deadline.toDate ? poll.deadline.toDate() : new Date(poll.deadline);
    return at.getTime() <= Date.now();
}

/** Опитування закрите — або вручну, або строком. */
function isClosed(poll) {
    return poll.status !== 'active' || isExpired(poll);
}

function formatDeadline(poll) {
    if (!poll.deadline) return '';
    const at = poll.deadline.toDate ? poll.deadline.toDate() : new Date(poll.deadline);
    const label = at.toLocaleString('uk-UA', {
        day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit'
    });
    if (at.getTime() <= Date.now()) return `Завершено ${label}`;

    const left = at.getTime() - Date.now();
    const days = Math.floor(left / 86400000);
    const hours = Math.floor((left % 86400000) / 3600000);
    const rest = days > 0 ? `${days} дн.` : `${hours} год.`;
    return `До ${label} · лишилось ${rest}`;
}

// ------------------------------------------------------------
// КВОРУМ
//
// Голос лежить на КВАРТИРІ, а не на власнику, тож «один власник —
// один голос» рахуємо так: проголосувала квартира — голос
// зараховано всім її співвласникам. Власника, що має кілька
// квартир, ототожнюємо за прізвищем: іншого спільного
// ідентифікатора в базі немає.
// ------------------------------------------------------------
const QUORUM_PCT = 50;

function parseArea(v) {
    const n = parseFloat(String(v ?? '').replace(',', '.'));
    return isNaN(n) ? 0 : n;
}

/** Рахує явку за власниками і за площею. */
export function computeQuorum(votes, apartments) {
    const votedApts = new Set((votes || []).map(v => String(v.apt)));
    const allOwners = new Set();
    const votedOwners = new Set();
    let totalArea = 0, votedArea = 0;

    (apartments || []).forEach(a => {
        const area = parseArea(a.area);
        totalArea += area;
        const voted = votedApts.has(String(a.apt));
        if (voted) votedArea += area;

        (a.owners || []).forEach(o => {
            const key = normName(o.name);
            if (!key) return;                 // безіменний запис не рахуємо
            allOwners.add(key);
            if (voted) votedOwners.add(key);
        });
    });

    const ownersPct = allOwners.size ? (votedOwners.size / allOwners.size) * 100 : 0;
    const areaPct = totalArea ? (votedArea / totalArea) * 100 : 0;

    return {
        totalOwners: allOwners.size,
        votedOwners: votedOwners.size,
        ownersPct: Math.round(ownersPct * 10) / 10,
        totalArea: Math.round(totalArea * 10) / 10,
        votedArea: Math.round(votedArea * 10) / 10,
        areaPct: Math.round(areaPct * 10) / 10,
        votedApts: votedApts.size,
        totalApts: (apartments || []).length,
        hasQuorum: ownersPct >= QUORUM_PCT
    };
}

let ringSeq = 0;

function quorumRing(pct, label, from, to) {
    const CIRC = 2 * Math.PI * 44;
    const id = `qring${++ringSeq}`;
    const clamped = Math.min(Math.max(pct, 0), 100);
    return `<div class="quorum-ring">
        <svg viewBox="0 0 100 100" aria-hidden="true">
            <defs><linearGradient id="${id}" x1="0" y1="0" x2="1" y2="1">
                <stop offset="0" stop-color="${from}"></stop>
                <stop offset="1" stop-color="${to}"></stop>
            </linearGradient></defs>
            <circle class="quorum-ring-track" cx="50" cy="50" r="44"></circle>
            <circle class="quorum-ring-fill" cx="50" cy="50" r="44" stroke="url(#${id})"
                    stroke-dasharray="${CIRC.toFixed(2)}"
                    stroke-dashoffset="${(CIRC * (1 - clamped / 100)).toFixed(2)}"
                    transform="rotate(-90 50 50)"></circle>
        </svg>
        <span class="quorum-ring-text">${Math.round(pct)}<small>%</small></span>
        <span class="quorum-ring-label">${escapeHtml(label)}</span>
    </div>`;
}

/** Блок кворуму: два кільця й вердикт. */
export function renderQuorum(q) {
    if (!q) return '';
    const ok = q.hasQuorum;
    return `<div class="quorum">
        <div class="quorum-verdict ${ok ? 'quorum-ok' : 'quorum-fail'}">
            ${ok ? 'Кворум зібрано' : 'Кворуму немає'}
            <small>потрібно ${QUORUM_PCT}% власників</small>
        </div>
        <div class="quorum-rings">
            ${quorumRing(q.ownersPct, 'Власники', ok ? '#4CD97B' : '#FFB157', ok ? '#34C759' : '#FF9500')}
            ${quorumRing(q.areaPct, 'Площа', '#4FA3FF', '#007AFF')}
        </div>
        <div class="quorum-facts">
            <span><b>${q.votedOwners}</b> з ${q.totalOwners} власників</span>
            <span><b>${q.votedArea}</b> з ${q.totalArea} м²</span>
            <span><b>${q.votedApts}</b> з ${q.totalApts} квартир</span>
        </div>
    </div>`;
}

// ------------------------------------------------------------
// ПІДРАХУНОК
// ------------------------------------------------------------
/** Рахує голоси за варіантами. Повертає { tally, total }. */
function tallyVotes(options, voteDocs) {
    const tally = Object.fromEntries(options.map(o => [o, 0]));
    let total = 0;
    voteDocs.forEach(v => {
        const opt = v.option;
        // Голос за варіант, який згодом прибрали з опитування,
        // не має ламати підрахунок — просто не показуємо його.
        if (opt in tally) { tally[opt]++; total++; }
    });
    return { tally, total };
}

/**
 * Малює результати: назва варіанта, кількість, відсоток і смуга.
 * @param {string[]} options варіанти опитування
 * @param {Array} voteDocs   [{ apt, option }]
 * @param {string} myChoice  вибір поточної квартири, якщо вже голосувала
 */
export function renderResults(options, voteDocs, myChoice = null) {
    const { tally, total } = tallyVotes(options, voteDocs);
    const max = Math.max(...options.map(o => tally[o]), 0);

    const rows = options.map((opt, i) => {
        const count = tally[opt];
        const pct = total ? (count / total) * 100 : 0;
        const isMine = myChoice === opt;
        const isLeader = total > 0 && count === max;

        return `<div class="poll-result${isLeader ? ' poll-result-lead' : ''}">
            <div class="poll-result-head">
                <span class="poll-result-name">
                    ${escapeHtml(opt)}${isMine ? '<span class="poll-mine">ваш голос</span>' : ''}
                </span>
                <span class="poll-result-num">
                    ${Math.round(pct)}<small>%</small>
                    <span class="poll-result-count">${count}</span>
                </span>
            </div>
            <div class="poll-track">
                <span class="poll-fill" style="width: ${pct}%; background: ${barColor(i)};"></span>
            </div>
        </div>`;
    }).join('');

    return `<div class="poll-results">${rows}
        <span class="poll-total">${total ? `Проголосувало квартир: ${total}` : 'Голосів ще немає'}</span>
    </div>`;
}

// ------------------------------------------------------------
// ЗАВАНТАЖЕННЯ ГОЛОСІВ
// ------------------------------------------------------------
async function fetchVotes(pollId) {
    const snap = await getDocs(collection(db, 'polls', pollId, 'votes'));
    return snap.docs.map(d => ({ apt: d.id, ...d.data() }));
}

/** Опитування разом з голосами, найновіші згори. */
async function fetchPollsWithVotes() {
    const snap = await getDocs(query(collection(db, 'polls'), orderBy('createdAt', 'desc')));
    const polls = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    // Паралельно, а не по черзі: інакше десяток опитувань
    // означав би десяток послідовних запитів.
    const votes = await Promise.all(polls.map(p => fetchVotes(p.id)));
    polls.forEach((p, i) => { p.votes = votes[i]; });
    return polls;
}

function statusBadge(poll) {
    return isClosed(poll)
        ? '<span class="poll-badge poll-badge-closed">Завершено</span>'
        : '<span class="poll-badge poll-badge-active">Триває</span>';
}

// ------------------------------------------------------------
// ЛІЧИЛЬНИК НЕПРОГОЛОСОВАНИХ
// Без нього мешканець дізнався б про опитування лише випадково,
// відкривши меню, — і голосування б нікого не зібрало.
// ------------------------------------------------------------
function setBadge(id, count) {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = count > 9 ? '9+' : count;
    el.style.display = count ? 'flex' : 'none';
}

export async function refreshPollsBadge() {
    try {
        // Без orderBy: для лічильника порядок не потрібен, а зайвий
        // складений індекс у Firestore — потрібен.
        const snap = await getDocs(query(collection(db, 'polls'), where('status', '==', 'active')));
        // Прострочені сюди ще потрапляють: статус міняє панель правління,
        // а не сервер. Голосувати в них уже не можна, тож не рахуємо.
        const live = snap.docs.filter(d => !isExpired(d.data()));
        const mine = await Promise.all(live.map(
            d => getDoc(doc(db, 'polls', d.id, 'votes', String(session.apt)))
        ));
        const pending = mine.filter(v => !v.exists()).length;
        setBadge('pollsMenuBadge', pending);
        const { updateNavBadge } = await import('./ui.js');
        updateNavBadge();
    } catch (e) {
        // Правила ще не опубліковані або немає звʼязку — просто без лічильника
        console.warn('Лічильник опитувань:', e);
        setBadge('pollsMenuBadge', 0);
    }
}

// ------------------------------------------------------------
// МЕШКАНЕЦЬ
// ------------------------------------------------------------
export async function loadUserPolls() {
    const host = document.getElementById('userPollsContainer');
    if (!host) return;
    host.innerHTML = '<p class="list-empty">Завантаження…</p>';

    try {
        const polls = await fetchPollsWithVotes();
        if (!polls.length) {
            host.innerHTML = '<p class="list-empty">Опитувань поки немає</p>';
            return;
        }

        host.innerHTML = polls.map(poll => {
            const myVote = poll.votes.find(v => v.apt === String(session.apt));
            const options = poll.options || [];
            const canVote = !isClosed(poll) && !myVote;

            const body = canVote
                ? `<div class="poll-options" role="radiogroup" aria-label="${escapeHtml(poll.title)}">
                       ${options.map((opt, i) => `
                           <label class="poll-option">
                               <input type="radio" name="poll-${poll.id}" value="${escapeHtml(opt)}">
                               <span class="poll-option-mark"></span>
                               <span class="poll-option-text">${escapeHtml(opt)}</span>
                           </label>`).join('')}
                   </div>
                   <button type="button" class="btn-primary btn-compact poll-vote-btn"
                           data-poll="${poll.id}">Проголосувати</button>`
                : renderResults(options, poll.votes, myVote ? myVote.option : null)
                  // Кворум порахувало правління при завершенні: мешканець
                  // не має доступу до даних усіх квартир.
                  + (poll.quorum ? renderQuorum(poll.quorum) : '');

            return `<div class="card poll-card">
                <div class="poll-head">
                    ${statusBadge(poll)}
                    <span class="poll-date">${formatDateTime(poll.createdAt)}</span>
                </div>
                <h3 class="poll-title">${escapeHtml(poll.title)}</h3>
                ${poll.deadline ? `<span class="poll-deadline${isExpired(poll) ? ' poll-deadline-over' : ''}">${escapeHtml(formatDeadline(poll))}</span>` : ''}
                ${poll.description ? `<p class="poll-desc">${escapeHtml(poll.description)}</p>` : ''}
                <div class="attach-block poll-attach" data-poll-att="${poll.id}"></div>
                ${body}
            </div>`;
        }).join('');

        polls.forEach(p => {
            if (p.attachments?.length) {
                renderAttachments(host.querySelector(`.poll-attach[data-poll-att="${p.id}"]`), p.attachments);
            }
        });

        host.querySelectorAll('.poll-vote-btn').forEach(btn => {
            btn.addEventListener('click', function () {
                const picked = host.querySelector(`input[name="poll-${this.dataset.poll}"]:checked`);
                if (!picked) return toast('Оберіть варіант', 'error');
                submitVote(this.dataset.poll, picked.value, this);
            });
        });
    } catch (e) {
        console.error('Завантаження опитувань:', e);
        host.innerHTML = '<p class="list-empty">Не вдалося завантажити опитування</p>';
    }
}

export async function submitVote(pollId, option, btn) {
    setBusy(btn, true, 'Надсилання…');
    try {
        // ID документа — номер квартири: другого голосу просто нікуди покласти
        await setDoc(doc(db, 'polls', pollId, 'votes', String(session.apt)), {
            option,
            votedAt: serverTimestamp()
        });
        toast('Ваш голос враховано', 'success');
        await Promise.all([loadUserPolls(), refreshPollsBadge()]);
    } catch (e) {
        console.error('Голосування:', e);
        toast(e.code === 'permission-denied'
            ? 'Опитування вже завершено'
            : 'Не вдалося проголосувати', 'error');
        setBusy(btn, false);
    }
}

// ------------------------------------------------------------
// АДМІН: створення
// ------------------------------------------------------------
function optionInputs() {
    return Array.from(document.querySelectorAll('#pollOptionsList .poll-option-input'));
}

function refreshOptionRows() {
    const rows = document.querySelectorAll('#pollOptionsList .poll-option-row');
    // Двох варіантів — мінімум для голосування, менше видаляти не даємо
    rows.forEach(r => {
        const del = r.querySelector('.poll-option-del');
        if (del) del.disabled = rows.length <= 2;
    });
}

function addOptionRow(value = '') {
    const list = document.getElementById('pollOptionsList');
    const row = document.createElement('div');
    row.className = 'poll-option-row';
    row.innerHTML = `
        <input type="text" class="field-input poll-option-input"
               placeholder="Варіант відповіді" value="${escapeHtml(value)}">
        <button type="button" class="poll-option-del" aria-label="Прибрати варіант">
            <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor"
                 stroke-width="2.2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
        </button>`;
    row.querySelector('.poll-option-del').addEventListener('click', () => {
        row.remove();
        refreshOptionRows();
    });
    list.appendChild(row);
    refreshOptionRows();
    return row;
}

function resetPollForm() {
    document.getElementById('pollTitle').value = '';
    const desc = document.getElementById('pollDescription');
    desc.value = '';
    desc.style.height = '';
    document.getElementById('pollOptionsList').innerHTML = '';
    addOptionRow('За');
    addOptionRow('Проти');
    addOptionRow('Утримався');
    const dl = document.getElementById('pollDeadline');
    if (dl) dl.value = '';
    document.querySelectorAll('#pollQuickTerms .poll-term').forEach(b => b.classList.remove('active'));
    pendingPollFiles = [];
    refreshPollChips();
}

function refreshPollChips() {
    renderFileManager(
        document.getElementById('pollFilesPreview'),
        [], pendingPollFiles,
        () => {},
        (i) => { pendingPollFiles.splice(i, 1); refreshPollChips(); }
    );
}

/** Значення <input type="datetime-local"> для моменту «зараз + N днів». */
function localInputValue(date) {
    const pad = n => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
         + `T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export async function createPoll(btn) {
    const title = document.getElementById('pollTitle').value.trim();
    const description = document.getElementById('pollDescription').value.trim();
    const options = optionInputs().map(i => i.value.trim()).filter(Boolean);
    const deadlineRaw = document.getElementById('pollDeadline').value;

    if (!title) return toast('Вкажіть питання', 'error');
    if (options.length < 2) return toast('Потрібно щонайменше два варіанти', 'error');
    if (new Set(options).size !== options.length) {
        return toast('Варіанти не мають повторюватися', 'error');
    }

    let deadline = null;
    if (deadlineRaw) {
        deadline = new Date(deadlineRaw);
        if (isNaN(deadline.getTime())) return toast('Невірна дата завершення', 'error');
        if (deadline.getTime() <= Date.now()) {
            return toast('Строк завершення має бути в майбутньому', 'error');
        }
    }

    setBusy(btn, true, 'Публікація…');
    try {
        const attachments = [];
        for (const file of pendingPollFiles) {
            const fileRef = sRef(storage, `polls/${Date.now()}_${file.name}`);
            await uploadBytes(fileRef, file);
            attachments.push({
                name: file.name, url: await getDownloadURL(fileRef),
                type: file.type || '', size: file.size || 0
            });
        }

        await addDoc(collection(db, 'polls'), {
            title, description, options, attachments,
            deadline,
            status: 'active',
            resultsSent: false,
            createdAt: serverTimestamp()
        });
        toast('Опитування опубліковано', 'success');
        resetPollForm();
        await loadAdminPolls();
    } catch (e) {
        console.error('Створення опитування:', e);
        toast('Не вдалося опублікувати', 'error');
    } finally {
        setBusy(btn, false);
    }
}

// ------------------------------------------------------------
// АДМІН: список
// ------------------------------------------------------------
/**
 * Закриває опитування, яким минув строк, і розсилає підсумки.
 *
 * Сервера, який зробив би це за розкладом, немає, тож роботу
 * виконує панель правління при відкритті. Голосувати після строку
 * все одно не можна — це блокують правила Firestore, — тож
 * затримка впливає лише на момент розсилки, не на чесність.
 */
async function closeExpiredPolls(polls) {
    const due = polls.filter(p => p.status === 'active' && isExpired(p));
    if (!due.length) return false;

    const apartments = await fetchDirectory().catch(() => []);
    for (const poll of due) {
        try {
            // Кворум фіксуємо в самому опитуванні: мешканець не має права
            // читати всі квартири й не може порахувати його сам.
            const quorum = computeQuorum(poll.votes, apartments);
            await updateDoc(doc(db, 'polls', poll.id), { status: 'closed', quorum });
            if (!poll.resultsSent) {
                await broadcastResults(poll, quorum);
                await updateDoc(doc(db, 'polls', poll.id), { resultsSent: true });
            }
        } catch (e) {
            console.error(`Автозакриття «${poll.title}»:`, e);
        }
    }
    return true;
}

/** Надсилає підсумки всім мешканцям звичайною розсилкою. */
async function broadcastResults(poll, quorum) {
    const options = poll.options || [];
    const { tally, total } = tallyVotes(options, poll.votes || []);
    const lines = options
        .map(o => {
            const pct = total ? Math.round((tally[o] / total) * 100) : 0;
            return `${o} — ${tally[o]} (${pct}%)`;
        })
        .join('\n');

    const quorumText = quorum
        ? `\n\nЯВКА\n`
          + `${quorum.hasQuorum ? 'Кворум зібрано' : 'Кворуму немає'} `
          + `(потрібно ${QUORUM_PCT}% власників)\n`
          + `Власники: ${quorum.votedOwners} з ${quorum.totalOwners} — ${quorum.ownersPct}%\n`
          + `Площа: ${quorum.votedArea} з ${quorum.totalArea} м² — ${quorum.areaPct}%\n`
          + `Квартири: ${quorum.votedApts} з ${quorum.totalApts}`
        : '';

    await addDoc(collection(db, 'messages'), {
        title: `Результати голосування: ${poll.title}`,
        body: `Голосування завершено.\n\n${lines}\n\nВсього проголосувало квартир: ${total}${quorumText}`,
        targetType: 'all',
        targetValue: '',
        recipients: buildRecipients('all', ''),
        attachments: [],
        linkedDoc: null,
        createdAt: serverTimestamp(),
        readBy: {}
    });
}

export async function loadAdminPolls() {
    const host = document.getElementById('adminPollsContainer');
    if (!host) return;
    host.innerHTML = '<p class="list-empty">Завантаження…</p>';

    try {
        let polls = await fetchPollsWithVotes();
        // Якщо щось довелося закрити — перечитуємо, щоб показати свіжі статуси
        if (await closeExpiredPolls(polls)) polls = await fetchPollsWithVotes();

        // Правління бачить явку наживо, не чекаючи завершення
        const apartments = await fetchDirectory().catch(e => {
            console.warn('Довідник для кворуму:', e);
            return [];
        });

        if (!polls.length) {
            host.innerHTML = '<p class="list-empty">Опитувань ще не створено</p>';
            return;
        }

        host.innerHTML = polls.map(poll => `
            <div class="poll-card poll-card-admin">
                <div class="poll-head">
                    ${statusBadge(poll)}
                    <span class="poll-date">${formatDateTime(poll.createdAt)}</span>
                </div>
                <h3 class="poll-title">${escapeHtml(poll.title)}</h3>
                ${poll.deadline ? `<span class="poll-deadline${isExpired(poll) ? ' poll-deadline-over' : ''}">${escapeHtml(formatDeadline(poll))}</span>` : ''}
                ${poll.description ? `<p class="poll-desc">${escapeHtml(poll.description)}</p>` : ''}
                <div class="attach-block poll-attach" data-poll-att="${poll.id}"></div>
                ${renderResults(poll.options || [], poll.votes)}
                ${apartments.length ? renderQuorum(computeQuorum(poll.votes, apartments)) : ''}
                ${!isClosed(poll)
                    ? `<button type="button" class="btn-soft btn-compact poll-close-btn"
                               data-poll="${poll.id}">Завершити опитування</button>`
                    : ''}
            </div>`).join('');

        polls.forEach(p => {
            if (p.attachments?.length) {
                renderAttachments(host.querySelector(`.poll-attach[data-poll-att="${p.id}"]`), p.attachments);
            }
        });

        host.querySelectorAll('.poll-close-btn').forEach(btn => {
            btn.addEventListener('click', function () { closePoll(this.dataset.poll, this); });
        });
    } catch (e) {
        console.error('Завантаження опитувань:', e);
        host.innerHTML = '<p class="list-empty">Не вдалося завантажити опитування</p>';
    }
}

async function closePoll(pollId, btn) {
    const ok = await confirmDialog('Завершити опитування?',
        'Мешканці більше не зможуть голосувати, а підсумки підуть у розсилку.');
    if (!ok) return;

    setBusy(btn, true, 'Завершення…');
    try {
        const snap = await getDoc(doc(db, 'polls', pollId));
        const poll = { id: pollId, ...snap.data(), votes: await fetchVotes(pollId) };
        const quorum = computeQuorum(poll.votes, await fetchDirectory().catch(() => []));
        await updateDoc(doc(db, 'polls', pollId), { status: 'closed', quorum });

        // Підсумки надсилаємо один раз: resultsSent береже від повторів,
        // якщо правління натисне кнопку вдруге або спрацює автозакриття.
        if (!poll.resultsSent) {
            await broadcastResults(poll, quorum);
            await updateDoc(doc(db, 'polls', pollId), { resultsSent: true });
        }
        toast('Опитування завершено, підсумки надіслано', 'success');
        await loadAdminPolls();
    } catch (e) {
        console.error('Завершення опитування:', e);
        toast('Не вдалося завершити', 'error');
        setBusy(btn, false);
    }
}

// ------------------------------------------------------------
// ІНІЦІАЛІЗАЦІЯ
// ------------------------------------------------------------
export function initPolls() {
    const list = document.getElementById('pollOptionsList');
    if (list && !list.children.length) resetPollForm();

    document.getElementById('addPollOptionBtn')?.addEventListener('click', () => {
        const row = addOptionRow();
        row.querySelector('.poll-option-input').focus();
    });

    document.getElementById('createPollBtn')?.addEventListener('click', function () {
        createPoll(this);
    });

    const desc = document.getElementById('pollDescription');
    desc?.addEventListener('input', function () {
        this.style.height = 'auto';
        this.style.height = this.scrollHeight + 'px';
    });

    // Швидкий вибір строку одним натисканням
    document.querySelectorAll('#pollQuickTerms .poll-term').forEach(btn => {
        btn.addEventListener('click', () => {
            const days = parseInt(btn.dataset.days, 10);
            const at = new Date(Date.now() + days * 86400000);
            document.getElementById('pollDeadline').value = localInputValue(at);
            document.querySelectorAll('#pollQuickTerms .poll-term')
                .forEach(b => b.classList.toggle('active', b === btn));
        });
    });

    // Дату правили руками — підсвітка швидкої кнопки більше не відповідає дійсності
    document.getElementById('pollDeadline')?.addEventListener('input', () => {
        document.querySelectorAll('#pollQuickTerms .poll-term').forEach(b => b.classList.remove('active'));
    });

    const files = document.getElementById('pollFiles');
    files?.addEventListener('change', () => {
        pendingPollFiles.push(...Array.from(files.files));
        files.value = '';
        refreshPollChips();
    });
}
