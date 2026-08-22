// ============================================================
// Голосування та опитування.
//
// Голос лежить окремим документом у polls/{id}/votes/{apt},
// де ID документа — номер квартири. Тому одна квартира фізично
// не може подати два голоси: другий запис просто перезаписав би
// перший. Правила Firestore дозволяють писати лише за свою
// квартиру, лише в активне опитування і лише один із варіантів.
// ============================================================
import { db, session } from './firebase.js';
import {
    collection, addDoc, getDocs, setDoc, updateDoc, doc,
    query, orderBy, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js";
import { escapeHtml, formatDateTime, toast, setBusy, confirmDialog } from './ui.js';

// Барви стовпчиків. Варіанти — довільні рядки, тож семантику
// («за» — зелений, «проти» — червоний) вгадати не можна;
// беремо стабільний перебір за порядком варіанта.
const BAR_COLORS = ['var(--blue)', 'var(--green)', 'var(--orange)', 'var(--purple)', 'var(--red)'];

const barColor = (i) => BAR_COLORS[i % BAR_COLORS.length];

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

function statusBadge(status) {
    return status === 'active'
        ? '<span class="poll-badge poll-badge-active">Триває</span>'
        : '<span class="poll-badge poll-badge-closed">Завершено</span>';
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
            const canVote = poll.status === 'active' && !myVote;

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
                : renderResults(options, poll.votes, myVote ? myVote.option : null);

            return `<div class="card poll-card">
                <div class="poll-head">
                    ${statusBadge(poll.status)}
                    <span class="poll-date">${formatDateTime(poll.createdAt)}</span>
                </div>
                <h3 class="poll-title">${escapeHtml(poll.title)}</h3>
                ${poll.description ? `<p class="poll-desc">${escapeHtml(poll.description)}</p>` : ''}
                ${body}
            </div>`;
        }).join('');

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
        await loadUserPolls();
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
}

export async function createPoll(btn) {
    const title = document.getElementById('pollTitle').value.trim();
    const description = document.getElementById('pollDescription').value.trim();
    const options = optionInputs().map(i => i.value.trim()).filter(Boolean);

    if (!title) return toast('Вкажіть питання', 'error');
    if (options.length < 2) return toast('Потрібно щонайменше два варіанти', 'error');
    if (new Set(options).size !== options.length) {
        return toast('Варіанти не мають повторюватися', 'error');
    }

    setBusy(btn, true, 'Публікація…');
    try {
        await addDoc(collection(db, 'polls'), {
            title, description, options,
            status: 'active',
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
export async function loadAdminPolls() {
    const host = document.getElementById('adminPollsContainer');
    if (!host) return;
    host.innerHTML = '<p class="list-empty">Завантаження…</p>';

    try {
        const polls = await fetchPollsWithVotes();
        if (!polls.length) {
            host.innerHTML = '<p class="list-empty">Опитувань ще не створено</p>';
            return;
        }

        host.innerHTML = polls.map(poll => `
            <div class="poll-card poll-card-admin">
                <div class="poll-head">
                    ${statusBadge(poll.status)}
                    <span class="poll-date">${formatDateTime(poll.createdAt)}</span>
                </div>
                <h3 class="poll-title">${escapeHtml(poll.title)}</h3>
                ${poll.description ? `<p class="poll-desc">${escapeHtml(poll.description)}</p>` : ''}
                ${renderResults(poll.options || [], poll.votes)}
                ${poll.status === 'active'
                    ? `<button type="button" class="btn-soft btn-compact poll-close-btn"
                               data-poll="${poll.id}">Завершити опитування</button>`
                    : ''}
            </div>`).join('');

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
        'Мешканці більше не зможуть голосувати. Результати залишаться видимими.');
    if (!ok) return;

    setBusy(btn, true, 'Завершення…');
    try {
        await updateDoc(doc(db, 'polls', pollId), { status: 'closed' });
        toast('Опитування завершено', 'success');
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
}
