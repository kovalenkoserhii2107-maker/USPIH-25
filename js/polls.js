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
import { db, session } from './firebase.js';
import {
    collection, getDocs, getDoc, setDoc, doc, query, where, orderBy, serverTimestamp, limit, startAfter
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { escapeHtml, formatDateTime, toast, setBusy } from './ui.js';
import { renderAttachments } from './attachments.js';
import {
    MEETING_ANSWERS, QUORUM_PCT, DECISION_PCT, computeQuorum, isMeeting, agendaOf, answerFor, meetingQuestionTally, isChairQuestion, writtenQuestions, formatMeetingDate, fmtPct, beforeStart, startLabel
} from './meeting.js';


// Барви стовпчиків. Варіанти — довільні рядки, тож семантику
// («за» — зелений, «проти» — червоний) вгадати не можна;
// беремо стабільний перебір за порядком варіанта.
const BAR_COLORS = ['var(--blue)', 'var(--green)', 'var(--orange)', 'var(--purple)', 'var(--red)'];

const barColor = (i) => BAR_COLORS[i % BAR_COLORS.length];

/** Строк минув? Опитування без строку триває, доки його не закриють вручну. */
export function isExpired(poll) {
    if (!poll.deadline) return false;
    const at = poll.deadline.toDate ? poll.deadline.toDate() : new Date(poll.deadline);
    return at.getTime() <= Date.now();
}

/** Опитування закрите — або вручну, або строком. */
export function isClosed(poll) {
    return poll.status !== 'active' || isExpired(poll);
}

export function formatDeadline(poll) {
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
export function tallyVotes(options, voteDocs) {
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

/** Проєкт рішення під питанням — мешканець має бачити, за що голосує. */
function draftDecision(poll, index) {
    const text = (poll.agendaDecisions || [])[index];
    if (!text) return '';
    return `<span class="meeting-q-draft">${(String(text).split('\n')
        .filter(l => l.trim())
        .map(l => escapeHtml(l.trim()))
        .join('<br>'))}</span>`;
}

/**
 * Порядок денний до початку зборів — без бюлетеня.
 *
 * Голос, поданий до зборів, — це голос до обговорення: людина не чула
 * ні доповіді, ні заперечень сусідів. Тому до часу початку показуємо
 * лише те, що виноситься на розгляд, і коли відкриється голосування.
 */
function agendaPreview(poll) {
    return `<div class="meeting-preview">
        <span class="meeting-wait">Голосування відкриється ${escapeHtml(startLabel(poll))}</span>
        ${agendaOf(poll).map((q, i) => `
            <div class="meeting-q">
                <span class="meeting-q-text"><b>${i + 1}.</b> ${escapeHtml(q)}</span>
                ${draftDecision(poll, i)}
            </div>`).join('')}
    </div>`;
}

/** Бюлетень: питання 1 голосують з голосу, решту — по квартирі. */
function agendaBallot(poll) {
    const questions = agendaOf(poll);
    return `<div class="meeting-ballot">
        ${questions.map((q, i) => `
            <div class="meeting-q">
                <span class="meeting-q-text"><b>${i + 1}.</b> ${escapeHtml(q)}</span>
                ${draftDecision(poll, i)}
                ${isChairQuestion(i)
                    ? '<span class="field-hint">Голову й секретаря обирають з голосу на зборах. Правління внесе підсумки в протокол.</span>'
                    : `<div class="poll-options meeting-answers" role="radiogroup"
                     aria-label="${escapeHtml(q)}">
                    ${MEETING_ANSWERS.map(ans => `
                        <label class="poll-option">
                            <input type="radio" name="meet-${poll.id}-${i}" value="${escapeHtml(ans)}">
                            <span class="poll-option-mark"></span>
                            <span class="poll-option-text">${escapeHtml(ans)}</span>
                        </label>`).join('')}
                </div>`}
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
        const mine = myVote && !isChairQuestion(i) ? answerFor(myVote, i) : null;
        // Питання про голову зборів вирішують присутні, решту — весь
        // будинок: та сама різниця, що й у протоколі.
        const legal = apartments?.length || isChairQuestion(i)
            ? meetingQuestionTally(poll, votes, apartments || [], i)
            : null;
        if (isChairQuestion(i) && !legal) {
            return `<div class="meeting-q-result">
                <span class="meeting-q-text"><b>${i + 1}.</b> ${escapeHtml(q)}</span>
                <span class="field-hint">Голосування з голосу на зборах. Підсумки ще не внесено в протокол.</span>
            </div>`;
        }
        if (legal) {
            total = 0;
            MEETING_ANSWERS.forEach(answer => {
                counts[answer] = legal.rows[answer].ownersCount;
                total += counts[answer];
            });
            if (isChairQuestion(i)) total = legal.baseOwners;
        }

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
            ${isChairQuestion(i) ? `<span class="field-hint">Присутніх: ${legal.baseOwners} · проголосували: ${legal.votedOwners}</span>` : ''}
            ${verdict}
        </div>`;
    }).join('')}</div>`;
}

// ------------------------------------------------------------
// ЗАВАНТАЖЕННЯ ГОЛОСІВ
// ------------------------------------------------------------
export async function fetchVotes(pollId) {
    const snap = await getDocs(collection(db, 'polls', pollId, 'votes'));
    return snap.docs.map(d => ({ apt: d.id, ...d.data() }));
}

/** Опитування разом з голосами, найновіші згори. */
export async function fetchPollsWithVotes(cursor = null) {
    const constraints = [orderBy('createdAt', 'desc')];
    if (cursor) constraints.push(startAfter(cursor));
    constraints.push(limit(30));
    const snap = await getDocs(query(collection(db, 'polls'), ...constraints));
    const polls = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    // Паралельно, а не по черзі: інакше десяток опитувань
    // означав би десяток послідовних запитів.
    const votes = await Promise.all(polls.map(p => fetchVotes(p.id)));
    polls.forEach((p, i) => { p.votes = votes[i]; });
    return {
        polls,
        cursor: snap.docs[snap.docs.length - 1] || cursor,
        hasMore: snap.size === 30
    };
}

const userPages = { polls: [], cursor: null, hasMore: false };

export function statusBadge(poll) {
    if (isClosed(poll)) return '<span class="poll-badge poll-badge-closed">Завершено</span>';
    // «Триває» на зборах, які ще не почалися, збиває з пантелику:
    // мешканець шукає кнопку голосування й не знаходить її.
    if (isMeeting(poll) && beforeStart(poll)) {
        return '<span class="poll-badge poll-badge-soon">Незабаром</span>';
    }
    return '<span class="poll-badge poll-badge-active">Триває</span>';
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
        // Збори, які ще не почалися, теж не рахуємо: смикати мешканця
        // лічильником за тиждень до зборів немає сенсу — голосувати
        // однаково нікуди.
        const live = snap.docs.filter(d => !isExpired(d.data()) && !beforeStart(d.data()));
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
export async function loadUserPolls(append = false) {
    const host = document.getElementById('userPollsContainer');
    if (!host) return;
    if (!append) {
        host.innerHTML = '<p class="list-empty">Завантаження…</p>';
        Object.assign(userPages, { polls: [], cursor: null, hasMore: false });
    }

    try {
        const page = await fetchPollsWithVotes(append ? userPages.cursor : null);
        userPages.polls.push(...page.polls);
        userPages.cursor = page.cursor;
        userPages.hasMore = page.hasMore;
        const polls = userPages.polls;
        if (!polls.length) {
            host.innerHTML = '<p class="list-empty">Опитувань поки немає</p>';
            return;
        }

        host.innerHTML = polls.map(poll => {
            const myVote = poll.votes.find(v => v.apt === String(session.apt) && !v.ownerId);
            const options = poll.options || [];
            const canVote = !isClosed(poll) && !myVote;

            // Збори голосуються по кожному питанню порядку денного,
            // тому і бюлетень, і підсумки в них свої.
            const body = isMeeting(poll)
                ? (canVote && beforeStart(poll)
                    ? agendaPreview(poll)
                    : canVote
                    ? agendaBallot(poll)
                      + (writtenQuestions(poll).length ? `<button type="button" class="btn-primary btn-compact meeting-vote-btn"
                                 data-poll="${poll.id}">${options.length === 2 ? 'Проголосувати з питання 2' : `Проголосувати з питань 2–${options.length}`}</button>` : '')
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
        }).join('') + (userPages.hasMore
            ? '<button type="button" class="btn-soft user-polls-more">Показати давніші</button>' : '');

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
                const questions = writtenQuestions(poll);
                const answers = {};
                for (const { index: i } of questions) {
                    const picked = host.querySelector(`input[name="meet-${poll.id}-${i}"]:checked`);
                    // Половина бюлетеня — не голос: у протоколі така
                    // квартира однаково пішла б у «не голосував».
                    if (!picked) return toast(`Не відмічено питання ${i + 1}`, 'error');
                    answers[String(i)] = picked.value;
                }
                submitMeetingVote(poll.id, answers, this);
            });
        });
        host.querySelector('.user-polls-more')?.addEventListener('click', () => loadUserPolls(true));
    } catch (e) {
        console.error('Завантаження опитувань:', e);
        host.innerHTML = '<p class="list-empty">Не вдалося завантажити опитування</p>';
    }
}

/**
 * Чому сервер відмовив у голосі.
 *
 * permission-denied прилітає з кількох різних причин, і показувати
 * на всі «опитування завершено» — означає збрехати мешканцю: він
 * бачить строк «лишилось 13 днів» і не розуміє, що відбувається.
 * Тому перечитуємо опитування й розрізняємо випадки. Найчастіший
 * серед «інших» — у Firebase не опублікували свіжі firestore.rules,
 * і саме це має прочитати правління.
 */
async function rejectionMessage(pollId, meeting) {
    try {
        const snap = await getDoc(doc(db, 'polls', pollId));
        if (!snap.exists()) return meeting ? 'Збори не знайдено' : 'Опитування не знайдено';
        const poll = snap.data();
        if (poll.status !== 'active') {
            return meeting ? 'Збори вже завершено' : 'Опитування вже завершено';
        }
        if (isExpired(poll)) {
            return meeting ? 'Строк голосування минув' : 'Строк опитування минув';
        }
    } catch (e) {
        console.warn('Причина відмови:', e);
    }
    return meeting
        ? 'Сервер відхилив голос. Правлінню: опублікуйте оновлені правила Firestore'
        : 'Сервер відхилив голос. Спробуйте пізніше';
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
            ? await rejectionMessage(pollId, false)
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
            ? await rejectionMessage(pollId, true)
            : 'Не вдалося проголосувати', 'error');
        setBusy(btn, false);
    }
}

