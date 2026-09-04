// ============================================================
// Голосування, опитування та загальні збори співвласників.
//
// Збори — це те саме опитування з isMeeting: true, де options
// містить не варіанти відповіді, а порядок денний; відповіді на
// кожне його питання завжди «За / Проти / Утримався». Розрахунки
// зборів і формат голосу описані в meeting.js.
//
// Голос лежить окремим документом у polls/{id}/votes/{apt},
// де ID документа — номер квартири. Тому одна квартира фізично
// не може подати два голоси: другий запис просто перезаписав би
// перший. Правила Firestore дозволяють писати лише за свою
// квартиру, лише в активне опитування і лише один із варіантів.
// ============================================================
import { db, storage, session } from './firebase.js';
import {
    collection, addDoc, getDocs, getDoc, setDoc, updateDoc, doc, runTransaction,
    query, where, orderBy, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js";
import {
    ref as sRef, uploadBytes, getDownloadURL
} from "https://www.gstatic.com/firebasejs/10.8.1/firebase-storage.js";
import { escapeHtml, formatDateTime, toast, setBusy, confirmDialog } from './ui.js';
import { renderAttachments, renderFileManager } from './attachments.js';
import { buildRecipients } from './messages.js';
import { fetchDirectory } from './directory.js';
import {
    MEETING_ANSWERS, CHAIR_QUESTION, QUORUM_PCT, DECISION_PCT,
    computeQuorum, isMeeting, agendaOf, answerFor, questionTally, isChairQuestion,
    formatMeetingDate, fmtPct
} from './meeting.js';

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
// Сама математика живе в meeting.js: її читає і ця панель, і
// протокол зборів, і рахувати її двічі не можна — розійдуться.
// Тут лишається тільки те, що малюється на екрані.
// ------------------------------------------------------------
export { computeQuorum };

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
// ЗБОРИ: РОЗМІТКА
// ------------------------------------------------------------
/** Дата, час і місце зборів — рядком під заголовком картки. */
function meetingMeta(poll) {
    if (!isMeeting(poll)) return '';
    const chips = [
        formatMeetingDate(poll.meetingDate),
        poll.timeStart ? (poll.timeEnd ? `${poll.timeStart}–${poll.timeEnd}` : `з ${poll.timeStart}`) : '',
        poll.location
    ].filter(Boolean);
    if (!chips.length) return '';
    return `<div class="meeting-meta">${chips.map(c =>
        `<span class="meeting-chip">${escapeHtml(c)}</span>`).join('')}</div>`;
}

// На зборах відповіді не довільні, тому й кольори тут за змістом,
// а не за номером варіанта, як у звичайному опитуванні: зелений
// «проти» на смузі читається як схвалення.
const MEETING_COLORS = {
    [MEETING_ANSWERS[0]]: 'var(--green)',
    [MEETING_ANSWERS[1]]: 'var(--red)',
    [MEETING_ANSWERS[2]]: 'var(--ink-3)'
};

/** Бюлетень: по три відповіді на кожне питання порядку денного. */
function agendaBallot(poll) {
    const questions = agendaOf(poll);
    return `<div class="meeting-ballot">
        ${questions.map((q, i) => `
            <div class="meeting-q">
                <span class="meeting-q-text"><b>${i + 1}.</b> ${escapeHtml(q)}</span>
                <div class="poll-options meeting-answers" role="radiogroup"
                     aria-label="${escapeHtml(q)}">
                    ${MEETING_ANSWERS.map(ans => `
                        <label class="poll-option">
                            <input type="radio" name="meet-${poll.id}-${i}" value="${escapeHtml(ans)}">
                            <span class="poll-option-mark"></span>
                            <span class="poll-option-text">${escapeHtml(ans)}</span>
                        </label>`).join('')}
                </div>
            </div>`).join('')}
    </div>`;
}

/**
 * Результати зборів — окремий підрахунок для кожного питання.
 *
 * Мешканцю показуємо частку від тих, хто голосував: площі всіх
 * квартир він читати не має права. Правлінню, якому довідник
 * доступний, додаємо ще й відсоток площі будинку — саме з ним
 * закон порівнює поріг прийняття рішення.
 */
function renderMeetingResults(poll, votes, myVote = null, apartments = null) {
    const questions = agendaOf(poll);
    if (!questions.length) return '<p class="list-empty">Порядок денний порожній</p>';

    return `<div class="meeting-results">${questions.map((q, i) => {
        const counts = Object.fromEntries(MEETING_ANSWERS.map(a => [a, 0]));
        let total = 0;
        (votes || []).forEach(v => {
            const ans = answerFor(v, i);
            if (ans in counts) { counts[ans]++; total++; }
        });
        const mine = myVote ? answerFor(myVote, i) : null;
        // Питання про голову зборів вирішують присутні, решту — весь
        // будинок: та сама різниця, що й у протоколі.
        const legal = apartments?.length
            ? questionTally(votes, apartments, i, isChairQuestion(i))
            : null;

        const bars = MEETING_ANSWERS.map((ans) => {
            const pct = total ? (counts[ans] / total) * 100 : 0;
            return `<div class="poll-result">
                <div class="poll-result-head">
                    <span class="poll-result-name">${escapeHtml(ans)}${
                        mine === ans ? '<span class="poll-mine">ваш голос</span>' : ''}</span>
                    <span class="poll-result-num">${Math.round(pct)}<small>%</small>
                        <span class="poll-result-count">${counts[ans]}</span></span>
                </div>
                <div class="poll-track">
                    <span class="poll-fill" style="width: ${pct}%; background: ${MEETING_COLORS[ans]};"></span>
                </div>
            </div>`;
        }).join('');

        const verdict = legal
            ? `<span class="meeting-verdict ${legal.accepted ? 'is-ok' : 'is-no'}">
                   ${legal.accepted ? 'Рішення прийнято' : 'Рішення не прийнято'}
                   <small>«за» — ${legal.rows[MEETING_ANSWERS[0]].ownersCount} з ${legal.baseOwners}
                   ${legal.amongPresent ? 'присутніх' : 'співвласників'}
                   (${fmtPct(legal.rows[MEETING_ANSWERS[0]].ownersPct)}%), потрібно понад ${DECISION_PCT}%</small>
               </span>`
            : '';

        return `<div class="meeting-q-result">
            <span class="meeting-q-text"><b>${i + 1}.</b> ${escapeHtml(q)}</span>
            <div class="poll-results">${bars}</div>
            ${verdict}
        </div>`;
    }).join('')}</div>`;
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

            // Збори голосуються по кожному питанню порядку денного,
            // тому і бюлетень, і підсумки в них свої.
            const body = isMeeting(poll)
                ? (canVote
                    ? agendaBallot(poll)
                      + `<button type="button" class="btn-primary btn-compact meeting-vote-btn"
                                 data-poll="${poll.id}">Проголосувати з усіх питань</button>`
                    : renderMeetingResults(poll, poll.votes, myVote)
                      + (poll.quorum ? renderQuorum(poll.quorum) : ''))
                : canVote
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
                ${meetingMeta(poll)}
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

        host.querySelectorAll('.meeting-vote-btn').forEach(btn => {
            btn.addEventListener('click', function () {
                const poll = polls.find(p => p.id === this.dataset.poll);
                const questions = agendaOf(poll);
                const answers = {};
                for (let i = 0; i < questions.length; i++) {
                    const picked = host.querySelector(`input[name="meet-${poll.id}-${i}"]:checked`);
                    // Половина бюлетеня — не голос: у протоколі така
                    // квартира однаково пішла б у «не голосував».
                    if (!picked) return toast(`Не відмічено питання ${i + 1}`, 'error');
                    answers[String(i)] = picked.value;
                }
                submitMeetingVote(poll.id, answers, this);
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

/** Голос на зборах: одна відповідь на кожне питання порядку денного. */
export async function submitMeetingVote(pollId, answers, btn) {
    setBusy(btn, true, 'Надсилання…');
    try {
        await setDoc(doc(db, 'polls', pollId, 'votes', String(session.apt)), {
            answers,
            votedAt: serverTimestamp()
        });
        toast('Ваш голос враховано', 'success');
        await Promise.all([loadUserPolls(), refreshPollsBadge()]);
    } catch (e) {
        console.error('Голосування на зборах:', e);
        toast(e.code === 'permission-denied'
            ? 'Збори вже завершено'
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

/** Питання порядку денного разом із проєктами рішень, у порядку рядків. */
function agendaInputs() {
    return Array.from(document.querySelectorAll('#pollOptionsList .poll-option-row')).map(row => ({
        question: row.querySelector('.poll-option-input')?.value.trim() || '',
        decision: row.querySelector('.poll-decision-input')?.value.trim() || ''
    })).filter(x => x.question);
}

function refreshOptionRows() {
    const rows = document.querySelectorAll('#pollOptionsList .poll-option-row');
    // Двох варіантів — мінімум для голосування; у зборів же вистачає
    // одного питання: друге, про голову й секретаря, додає код.
    const min = currentPollKind() === 'meeting' ? 1 : 2;
    rows.forEach(r => {
        const del = r.querySelector('.poll-option-del');
        if (del) del.disabled = rows.length <= min;
    });
}

function addOptionRow(value = '', decision = '') {
    const list = document.getElementById('pollOptionsList');
    const meeting = currentPollKind() === 'meeting';
    const row = document.createElement('div');
    row.className = `poll-option-row${meeting ? ' poll-option-row-meeting' : ''}`;

    const del = `<button type="button" class="poll-option-del" aria-label="Прибрати ${meeting ? 'питання' : 'варіант'}">
            <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor"
                 stroke-width="2.2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
        </button>`;

    // У зборів під питанням стоїть проєкт рішення: саме він друкується
    // на листку опитування, під яким розписується співвласник, і саме
    // він потім лягає в протокол рядком «Вирішили».
    row.innerHTML = meeting
        ? `<div class="poll-option-main">
               <input type="text" class="field-input poll-option-input"
                      placeholder="Питання порядку денного" value="${escapeHtml(value)}">
               ${del}
           </div>
           <textarea class="field-input poll-decision-input" rows="2"
                     placeholder="Проєкт рішення — кожен пункт з нового рядка">${escapeHtml(decision)}</textarea>`
        : `<input type="text" class="field-input poll-option-input"
                  placeholder="Варіант відповіді" value="${escapeHtml(value)}">
           ${del}`;

    row.querySelector('.poll-option-del').addEventListener('click', () => {
        row.remove();
        refreshOptionRows();
    });
    list.appendChild(row);
    refreshOptionRows();
    return row;
}

function resetPollForm() {
    const meeting = currentPollKind() === 'meeting';
    document.getElementById('pollTitle').value = meeting ? 'Загальні збори співвласників' : '';
    const desc = document.getElementById('pollDescription');
    desc.value = '';
    desc.style.height = '';

    document.getElementById('pollOptionsList').innerHTML = '';
    if (meeting) {
        // Питання про голову й секретаря в списку не показуємо: воно
        // додається при публікації, і редагувати його ніхто не має.
        addOptionRow();
    } else {
        addOptionRow('За');
        addOptionRow('Проти');
        addOptionRow('Утримався');
    }

    const dl = document.getElementById('pollDeadline');
    if (dl) dl.value = '';
    ['meetingDate', 'meetingTimeStart', 'meetingTimeEnd', 'meetingPlaceOther'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.value = '';
    });
    const place = document.getElementById('meetingPlace');
    if (place) { place.selectedIndex = 0; togglePlaceOther(); }
    const notify = document.getElementById('meetingNotify');
    if (notify) notify.checked = true;

    document.querySelectorAll('#pollQuickTerms .poll-term').forEach(b => b.classList.remove('active'));
    pendingPollFiles = [];
    refreshPollChips();
}

/** Поле «інше місце» потрібне лише тоді, коли обрано саме «Інше…». */
function togglePlaceOther() {
    const select = document.getElementById('meetingPlace');
    const other = document.getElementById('meetingPlaceOther');
    if (!select || !other) return;
    other.hidden = select.value !== 'other';
    if (!other.hidden) other.focus();
}

/**
 * Перемикає форму між опитуванням і зборами.
 *
 * Форма при цьому очищується: у зборів і опитування різні за змістом
 * поля — «За / Проти / Утримався» як варіанти відповіді в порядку
 * денному виглядали б безглуздо, і навпаки.
 */
function setPollKind(kind) {
    document.querySelectorAll('#pollKindSwitch .poll-kind')
        .forEach(b => b.classList.toggle('active', b.dataset.kind === kind));

    const meeting = kind === 'meeting';
    const fields = document.getElementById('pollMeetingFields');
    if (fields) fields.hidden = !meeting;

    const set = (id, text) => { const el = document.getElementById(id); if (el) el.textContent = text; };
    set('pollFormTitle', meeting ? 'Нові загальні збори' : 'Нове опитування');
    set('pollFormSub', meeting
        ? 'Порядок денний, листки для обходу квартир і протокол'
        : 'Кожна квартира має один голос');
    set('pollTitleLabel', meeting ? 'Назва зборів' : 'Питання');
    set('pollOptionsLabel', meeting ? 'Порядок денний' : 'Варіанти відповіді');
    set('addPollOptionBtn', meeting ? '+ Додати питання' : '+ Додати варіант');
    set('createPollBtn', meeting ? 'Створити збори' : 'Опублікувати опитування');
    set('pollDeadlineHint', meeting
        ? 'До цього моменту приймаються голоси — і в застосунку, і паперові. Можна не вказувати.'
        : 'Можна не вказувати — тоді опитування триватиме, доки не завершите вручну.');

    const hint = document.getElementById('pollAgendaHint');
    if (hint) hint.hidden = !meeting;
    const title = document.getElementById('pollTitle');
    if (title) {
        title.placeholder = meeting
            ? 'Напр. Загальні збори співвласників'
            : 'Напр. Чи встановлювати шлагбаум?';
    }

    resetPollForm();
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

/** Обраний у формі тип: звичайне опитування чи загальні збори. */
function currentPollKind() {
    return document.querySelector('#pollKindSwitch .poll-kind.active')?.dataset.kind || 'poll';
}

/** Місце проведення: зі списку або дописане вручну. */
function meetingPlace() {
    const select = document.getElementById('meetingPlace');
    if (!select) return '';
    return select.value === 'other'
        ? document.getElementById('meetingPlaceOther').value.trim()
        : select.value;
}

/**
 * Порядок денний.
 *
 * Питання про голову й секретаря дописуємо самі й завжди першим:
 * без нього збори нікому вести й нікому підписувати протокол, а
 * покладатися, що правління щоразу згадає внести його руками, —
 * означає рано чи пізно отримати протокол, який не має сили.
 */
function buildAgenda(entered) {
    const own = entered.filter(x => x.question.toLowerCase() !== CHAIR_QUESTION.toLowerCase());
    // Рішення йде тим самим індексом, що й питання: у протоколі вони
    // читаються парою, і зсув на одиницю зіпсував би весь документ.
    return [{ question: CHAIR_QUESTION, decision: '' }, ...own];
}

/** Запрошення на збори — звичайною розсилкою всьому будинку. */
async function announceMeeting(poll) {
    const when = [
        `Дата: ${formatMeetingDate(poll.meetingDate)}`,
        poll.timeStart ? `Час: ${poll.timeStart}${poll.timeEnd ? `–${poll.timeEnd}` : ''}` : '',
        poll.location ? `Місце: ${poll.location}` : ''
    ].filter(Boolean).join('\n');

    const agenda = poll.options.map((q, i) => `${i + 1}. ${q}`).join('\n');

    await addDoc(collection(db, 'messages'), {
        title: `Скликання загальних зборів — ${formatMeetingDate(poll.meetingDate)}`,
        body: `Правління скликає загальні збори співвласників багатоквартирного будинку.\n\n`
            + `${when}\n\n`
            + (poll.description ? `${poll.description}\n\n` : '')
            + `ПОРЯДОК ДЕННИЙ\n${agenda}\n\n`
            + `Проголосувати можна в застосунку — розділ «Голосування» — або письмово, `
            + `підписавши листок опитування під час обходу квартир.`,
        targetType: 'all',
        targetValue: '',
        recipients: buildRecipients('all', ''),
        attachments: [],
        linkedDoc: null,
        createdAt: serverTimestamp(),
        readBy: {}
    });
}

export async function createPoll(btn) {
    const kind = currentPollKind();
    const meeting = kind === 'meeting';
    const title = document.getElementById('pollTitle').value.trim();
    const description = document.getElementById('pollDescription').value.trim();
    const entered = meeting
        ? agendaInputs()
        : optionInputs().map(i => i.value.trim()).filter(Boolean);
    const deadlineRaw = document.getElementById('pollDeadline').value;

    if (!title) return toast(meeting ? 'Вкажіть назву зборів' : 'Вкажіть питання', 'error');

    const meetingDate = document.getElementById('meetingDate')?.value || '';
    const timeStart = document.getElementById('meetingTimeStart')?.value || '';
    const timeEnd = document.getElementById('meetingTimeEnd')?.value || '';
    const location = meeting ? meetingPlace() : '';

    if (meeting) {
        if (!meetingDate) return toast('Вкажіть дату зборів', 'error');
        if (!timeStart) return toast('Вкажіть час початку зборів', 'error');
        if (timeEnd && timeEnd <= timeStart) {
            return toast('Час закінчення має бути пізніше за початок', 'error');
        }
        if (!location) return toast('Вкажіть місце проведення', 'error');
        if (!entered.length) return toast('Додайте хоча б одне питання порядку денного', 'error');
    } else {
        if (entered.length < 2) return toast('Потрібно щонайменше два варіанти', 'error');
    }
    const texts = meeting ? entered.map(x => x.question) : entered;
    if (new Set(texts).size !== texts.length) {
        return toast(meeting ? 'Питання не мають повторюватися' : 'Варіанти не мають повторюватися', 'error');
    }

    const agenda = meeting ? buildAgenda(entered) : [];
    const options = meeting ? agenda.map(x => x.question) : entered;

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

        const payload = {
            title, description, options, attachments,
            deadline,
            status: 'active',
            resultsSent: false,
            isMeeting: meeting,
            agendaDecisions: meeting ? agenda.map(x => x.decision) : [],
            agendaHeard: [],
            protocolNumber: '',
            chairName: '',
            secretaryName: '',
            meetingDate: meeting ? meetingDate : null,
            timeStart: meeting ? timeStart : '',
            timeEnd: meeting ? timeEnd : '',
            location,
            createdAt: serverTimestamp()
        };
        const ref = await addDoc(collection(db, 'polls'), payload);

        // Розсилка окремо від запису: якщо вона впаде, збори вже
        // створені й нікуди не зникнуть — запрошення правління
        // повторить звичайним оголошенням.
        if (meeting && document.getElementById('meetingNotify')?.checked) {
            try {
                await announceMeeting({ id: ref.id, ...payload });
                toast('Збори створено, запрошення надіслано', 'success');
            } catch (e) {
                console.error('Запрошення на збори:', e);
                toast('Збори створено, але запрошення не пішло', 'error');
            }
        } else {
            toast(meeting ? 'Збори створено' : 'Опитування опубліковано', 'success');
        }

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
            const ref = doc(db, 'polls', poll.id);

            // Мітку «підсумки надіслано» ставимо в транзакції, ДО розсилки.
            //
            // Читання й запис нарізно тут не годяться: дві вкладки
            // правління, відкриті одночасно, обидві побачили б
            // resultsSent === false і обидві розіслали б підсумки —
            // усьому будинку, двічі.
            //
            // Якщо розсилка після цього впаде, підсумки не підуть зовсім.
            // Це гірше, ніж здається на слух, але все ж краще за дубль:
            // відсутню розсилку правління бачить і повторює вручну, а
            // друга копія в трьохстах телефонах — уже не виправна.
            const mine = await runTransaction(db, async (tx) => {
                const snap = await tx.get(ref);
                if (!snap.exists()) return false;
                const already = snap.data().resultsSent === true;
                tx.update(ref, already
                    ? { status: 'closed', quorum }
                    : { status: 'closed', quorum, resultsSent: true });
                return !already;
            });

            if (mine) await broadcastResults(poll, quorum, apartments);
        } catch (e) {
            console.error(`Автозакриття «${poll.title}»:`, e);
        }
    }
    return true;
}

/** Надсилає підсумки всім мешканцям звичайною розсилкою. */
async function broadcastResults(poll, quorum, apartments = []) {
    if (isMeeting(poll)) return broadcastMeetingResults(poll, quorum, apartments);
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

/**
 * Підсумки зборів: рішення по кожному питанню порядку денного.
 *
 * Це ще не протокол — його правління формує окремою кнопкою, коли
 * внесе паперові голоси. Але мешканець має дізнатися результат у
 * день закінчення, а не через тиждень.
 */
async function broadcastMeetingResults(poll, quorum, apartments) {
    const questions = agendaOf(poll);
    const lines = questions.map((q, i) => {
        const t = questionTally(poll.votes, apartments, i, isChairQuestion(i));
        const counts = MEETING_ANSWERS
            .map(a => `${a.toLowerCase()} ${t.rows[a].ownersCount}`).join(', ');
        const verdict = apartments.length
            ? (t.accepted ? 'ПРИЙНЯТО' : 'НЕ ПРИЙНЯТО')
            : 'підсумок буде в протоколі';
        return `${i + 1}. ${q}\n   ${verdict} (голосів співвласників: ${counts})`;
    }).join('\n');

    const quorumText = quorum
        ? `\n\nЯВКА\n`
          + `${quorum.hasQuorum ? 'Кворум зібрано' : 'Кворуму немає'} `
          + `(потрібно ${QUORUM_PCT}% власників)\n`
          + `Власники: ${quorum.votedOwners} з ${quorum.totalOwners} — ${quorum.ownersPct}%\n`
          + `Площа: ${quorum.votedArea} з ${quorum.totalArea} м² — ${quorum.areaPct}%`
        : '';

    await addDoc(collection(db, 'messages'), {
        title: `Підсумки зборів: ${poll.title}`,
        body: `Голосування завершено.\n\nРІШЕННЯ\n${lines}${quorumText}\n\n`
            + `Протокол зборів буде опубліковано в Базі документів ОСББ.`,
        targetType: 'all',
        targetValue: '',
        recipients: buildRecipients('all', ''),
        attachments: [],
        linkedDoc: null,
        createdAt: serverTimestamp(),
        readBy: {}
    });
}

/** Кнопки під карткою: у зборів свій набір дій. */
function adminPollActions(poll) {
    if (!isMeeting(poll)) {
        return isClosed(poll) ? '' : `<div class="poll-actions">
            <button type="button" class="btn-soft btn-compact poll-close-btn"
                    data-poll="${poll.id}">Завершити опитування</button></div>`;
    }

    const actions = [
        `<button type="button" class="btn-soft btn-compact poll-sheets-btn"
                 data-poll="${poll.id}">Друк листків опитування</button>`
    ];
    // Після публікації протоколу дописувати голоси немає сенсу:
    // документ уже розісланий, і нові голоси в ньому не враховані.
    if (!poll.protocolUrl) {
        actions.push(`<button type="button" class="btn-soft btn-compact poll-paper-btn"
                 data-poll="${poll.id}">Внести паперові голоси</button>`);
    }
    if (!isClosed(poll)) {
        actions.push(`<button type="button" class="btn-soft btn-compact poll-close-btn"
                 data-poll="${poll.id}">Завершити збори</button>`);
    } else {
        actions.push(`<button type="button" class="btn-primary btn-compact poll-protocol-btn"
                 data-poll="${poll.id}">${poll.protocolUrl
                     ? 'Сформувати протокол заново'
                     : 'Сформувати протокол та опублікувати'}</button>`);
    }

    const link = poll.protocolUrl
        ? `<a class="meeting-protocol-link" href="${escapeHtml(poll.protocolUrl)}"
              target="_blank" rel="noopener">Протокол опубліковано — відкрити PDF</a>`
        : '';
    return `<div class="poll-actions">${actions.join('')}</div>${link}`;
}

/** Скільки голосів подано в застосунку, а скільки внесено з паперу. */
function participationLine(poll) {
    if (!isMeeting(poll)) return '';
    const paper = (poll.votes || []).filter(v => v.source === 'paper').length;
    const online = (poll.votes || []).length - paper;
    return `<span class="meeting-split">Особисто на зборах: <b>${online}</b>
        · письмове опитування: <b>${paper}</b></span>`;
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
                ${meetingMeta(poll)}
                ${poll.deadline ? `<span class="poll-deadline${isExpired(poll) ? ' poll-deadline-over' : ''}">${escapeHtml(formatDeadline(poll))}</span>` : ''}
                ${poll.description ? `<p class="poll-desc">${escapeHtml(poll.description)}</p>` : ''}
                <div class="attach-block poll-attach" data-poll-att="${poll.id}"></div>
                ${isMeeting(poll)
                    ? renderMeetingResults(poll, poll.votes, null, apartments) + participationLine(poll)
                    : renderResults(poll.options || [], poll.votes)}
                ${apartments.length ? renderQuorum(computeQuorum(poll.votes, apartments)) : ''}
                ${adminPollActions(poll)}
            </div>`).join('');

        polls.forEach(p => {
            if (p.attachments?.length) {
                renderAttachments(host.querySelector(`.poll-attach[data-poll-att="${p.id}"]`), p.attachments);
            }
        });

        host.querySelectorAll('.poll-close-btn').forEach(btn => {
            btn.addEventListener('click', function () { closePoll(this.dataset.poll, this); });
        });

        const pollById = (id) => polls.find(p => p.id === id);

        host.querySelectorAll('.poll-sheets-btn').forEach(btn => {
            btn.addEventListener('click', async function () {
                if (!apartments.length) return toast('Довідник квартир недоступний', 'error');
                setBusy(this, true, 'Готуємо PDF…');
                try {
                    const { generateBlankSheets } = await import('./protocol_pdf.js');
                    await generateBlankSheets(pollById(this.dataset.poll), apartments);
                    toast('Листки опитування завантажено', 'success');
                } catch (e) {
                    console.error('Листки опитування:', e);
                    toast('Не вдалося сформувати листки', 'error');
                } finally {
                    setBusy(this, false);
                }
            });
        });

        host.querySelectorAll('.poll-paper-btn').forEach(btn => {
            btn.addEventListener('click', async function () {
                setBusy(this, true, 'Відкриваємо…');
                try {
                    const { initPaperVotes, openPaperVotes } = await import('./paper_votes.js');
                    initPaperVotes();
                    // Перемальовуємо список лише якщо голоси справді внесли:
                    // інакше кожне закриття вікна смикало б увесь екран.
                    await openPaperVotes(pollById(this.dataset.poll), () => loadAdminPolls());
                } catch (e) {
                    console.error('Паперові голоси:', e);
                    toast('Не вдалося відкрити вікно', 'error');
                } finally {
                    setBusy(this, false);
                }
            });
        });

        host.querySelectorAll('.poll-protocol-btn').forEach(btn => {
            btn.addEventListener('click', function () { publishProtocol(this.dataset.poll, this); });
        });
    } catch (e) {
        console.error('Завантаження опитувань:', e);
        host.innerHTML = '<p class="list-empty">Не вдалося завантажити опитування</p>';
    }
}

async function closePoll(pollId, btn) {
    const snapBefore = await getDoc(doc(db, 'polls', pollId));
    const meeting = snapBefore.exists() && isMeeting(snapBefore.data());

    const ok = await confirmDialog(
        meeting ? 'Завершити збори?' : 'Завершити опитування?',
        meeting
            ? 'Голосувати більше не можна — ні в застосунку, ні паперовим листком. '
              + 'Підсумки підуть у розсилку, протокол формується окремою кнопкою.'
            : 'Мешканці більше не зможуть голосувати, а підсумки підуть у розсилку.',
        'Завершити');
    if (!ok) return;

    setBusy(btn, true, 'Завершення…');
    try {
        const poll = { id: pollId, ...snapBefore.data(), votes: await fetchVotes(pollId) };
        const apartments = await fetchDirectory().catch(() => []);
        const quorum = computeQuorum(poll.votes, apartments);
        await updateDoc(doc(db, 'polls', pollId), { status: 'closed', quorum });

        // Підсумки надсилаємо один раз: resultsSent береже від повторів,
        // якщо правління натисне кнопку вдруге або спрацює автозакриття.
        if (!poll.resultsSent) {
            await broadcastResults(poll, quorum, apartments);
            await updateDoc(doc(db, 'polls', pollId), { resultsSent: true });
        }
        toast(meeting ? 'Збори завершено, підсумки надіслано' : 'Опитування завершено, підсумки надіслано', 'success');
        await loadAdminPolls();
    } catch (e) {
        console.error('Завершення опитування:', e);
        toast('Не вдалося завершити', 'error');
        setBusy(btn, false);
    }
}

/**
 * Готує протокол зборів: читає свіжі дані й відкриває вікно, де
 * правління дописує номер, голову, секретаря та «Слухали».
 *
 * Дані перечитуємо з бази, а не беремо з намальованої картки:
 * між відкриттям панелі й натисканням кнопки могли зʼявитися
 * паперові голоси, внесені з іншого пристрою.
 */
async function publishProtocol(pollId, btn) {
    setBusy(btn, true, 'Читання даних…');
    try {
        const [snap, votes, apartments] = await Promise.all([
            getDoc(doc(db, 'polls', pollId)),
            fetchVotes(pollId),
            fetchDirectory().catch(() => [])
        ]);
        if (!snap.exists()) throw new Error('Збори не знайдено');
        if (!apartments.length) {
            toast('Довідник квартир недоступний — протокол не буде з чого скласти', 'error');
            return;
        }

        const { initProtocolForm, openProtocolForm } = await import('./protocol_form.js');
        initProtocolForm();
        openProtocolForm({
            poll: { id: pollId, ...snap.data() },
            apartments,
            votes,
            onDone: async () => {
                // Документ щойно зʼявився в Базі — випадаючий список у
                // розсилці має його побачити без перезавантаження сторінки.
                try {
                    const { populateDocsDropdown } = await import('./requests.js');
                    await populateDocsDropdown();
                } catch (e) { console.warn('Оновлення списку документів:', e); }
                await loadAdminPolls();
            }
        });
    } catch (e) {
        console.error('Підготовка протоколу:', e);
        toast('Не вдалося підготувати протокол', 'error');
    } finally {
        setBusy(btn, false);
    }
}

// ------------------------------------------------------------
// ІНІЦІАЛІЗАЦІЯ
// ------------------------------------------------------------
export function initPolls() {
    const list = document.getElementById('pollOptionsList');
    if (list && !list.children.length) resetPollForm();

    document.querySelectorAll('#pollKindSwitch .poll-kind').forEach(btn => {
        btn.addEventListener('click', () => setPollKind(btn.dataset.kind));
    });
    document.getElementById('meetingPlace')?.addEventListener('change', togglePlaceOther);

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
