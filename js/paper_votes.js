// ============================================================
// Внесення паперових голосів (письмове опитування).
//
// Обхід квартир дає стос підписаних листків — їх треба перенести
// в базу, щоб протокол рахувався з тих самих даних, що й онлайн.
// Голос лягає туди ж, куди й звичайний, — polls/{id}/votes/{apt},
// але з міткою source: 'paper'. Мітка потрібна протоколу: закон
// розрізняє участь особисто на зборах і письмове опитування.
//
// У списку — лише ті квартири, які ще не голосували. Так зроблено
// свідомо: документ голосу один на квартиру, і повторний запис
// не «додав» би другий голос, а мовчки затер перший — зокрема й
// поданий мешканцем у застосунку.
// ============================================================
import { db, session } from './firebase.js';
import {
    collection, getDocs, setDoc, doc, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js";
import { escapeHtml, toast, setBusy, lockScroll, unlockScroll } from './ui.js';
import { fetchDirectory } from './directory.js';
import { MEETING_ANSWERS, agendaOf, meetingWhen, ownersLine, parseArea } from './meeting.js';

let state = null;      // { poll, pending: [...], onDone }

const modal = () => document.getElementById('paperVotesModal');

function rowMarkup(apt) {
    const area = parseArea(apt.area);
    return `<div class="paper-row" data-apt="${escapeHtml(apt.apt)}">
        <button type="button" class="paper-row-head">
            <span class="paper-apt">Кв. ${escapeHtml(apt.apt)}</span>
            <span class="paper-row-text">
                <span class="paper-owners">${escapeHtml(ownersLine(apt))}</span>
                <span class="paper-area">${area ? `${area} м²` : 'площа не вказана'}</span>
            </span>
            <svg class="row-chevron" viewBox="0 0 24 24" width="18" height="18" fill="none"
                 stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"></polyline></svg>
        </button>
        <div class="paper-row-body" hidden></div>
    </div>`;
}

function bodyMarkup(apt) {
    const questions = agendaOf(state.poll);
    const groups = questions.map((q, i) => `
        <div class="paper-q">
            <span class="paper-q-text">${i + 1}. ${escapeHtml(q)}</span>
            <div class="paper-answers" role="radiogroup" aria-label="${escapeHtml(q)}">
                ${MEETING_ANSWERS.map(ans => `
                    <label class="paper-answer">
                        <input type="radio" name="paper-${escapeHtml(apt.apt)}-${i}" value="${escapeHtml(ans)}">
                        <span>${escapeHtml(ans)}</span>
                    </label>`).join('')}
            </div>
        </div>`).join('');

    // Обхідний листок частіше за все підписують однаково по всіх
    // питаннях — швидкі кнопки економлять правлінню сотні натискань.
    const quick = MEETING_ANSWERS.map(ans =>
        `<button type="button" class="paper-quick" data-fill="${escapeHtml(ans)}">Всі «${escapeHtml(ans)}»</button>`
    ).join('');

    return `<div class="paper-quick-row">${quick}</div>
        ${groups}
        <button type="button" class="btn-primary btn-compact paper-save">Зберегти голос квартири</button>`;
}

function renderList(filter = '') {
    const host = document.getElementById('paperVotesList');
    if (!host) return;
    const needle = filter.trim().toLowerCase();
    const list = needle
        ? state.pending.filter(a =>
            String(a.apt).includes(needle) || ownersLine(a).toLowerCase().includes(needle))
        : state.pending;

    if (!state.pending.length) {
        host.innerHTML = '<p class="list-empty">Усі квартири вже проголосували</p>';
        return;
    }
    host.innerHTML = list.length
        ? list.map(rowMarkup).join('')
        : '<p class="list-empty">Нічого не знайдено</p>';
}

function updateCounter() {
    const el = document.getElementById('paperVotesCount');
    if (el) el.textContent = state.pending.length
        ? `Залишилося внести: ${state.pending.length}`
        : 'Голоси внесено за всіма квартирами';
}

async function saveVote(row, btn) {
    const apt = row.dataset.apt;
    const questions = agendaOf(state.poll);
    const answers = {};
    for (let i = 0; i < questions.length; i++) {
        const picked = row.querySelector(`input[name="paper-${CSS.escape(apt)}-${i}"]:checked`);
        if (!picked) return toast(`Кв. ${apt}: не відмічено питання ${i + 1}`, 'error');
        answers[String(i)] = picked.value;
    }

    setBusy(btn, true, 'Запис…');
    try {
        await setDoc(doc(db, 'polls', state.poll.id, 'votes', String(apt)), {
            answers,
            source: 'paper',
            enteredBy: String(session.apt || ''),
            votedAt: serverTimestamp()
        });
        state.pending = state.pending.filter(a => String(a.apt) !== String(apt));
        state.saved++;
        row.classList.add('paper-row-done');
        row.querySelector('.paper-row-body').hidden = true;
        row.querySelector('.paper-row-head').disabled = true;
        row.querySelector('.paper-apt').insertAdjacentHTML('afterend',
            '<span class="paper-done-mark">внесено</span>');
        updateCounter();
    } catch (e) {
        console.error('Паперовий голос:', e);
        toast(e.code === 'permission-denied'
            ? 'Немає прав на запис голосу'
            : 'Не вдалося зберегти голос', 'error');
        setBusy(btn, false);
    }
}

function onListClick(e) {
    const head = e.target.closest('.paper-row-head');
    if (head) {
        const row = head.closest('.paper-row');
        const body = row.querySelector('.paper-row-body');
        // Вміст малюємо при першому розкритті: три сотні квартир,
        // помножені на питання й радіокнопки, склали б десятки тисяч
        // вузлів — вікно відкривалося б секундами.
        if (!body.dataset.ready) {
            const apt = state.pending.find(a => String(a.apt) === row.dataset.apt);
            if (apt) { body.innerHTML = bodyMarkup(apt); body.dataset.ready = '1'; }
        }
        body.hidden = !body.hidden;
        row.classList.toggle('paper-row-open', !body.hidden);
        return;
    }

    const quick = e.target.closest('.paper-quick');
    if (quick) {
        const row = quick.closest('.paper-row');
        row.querySelectorAll(`.paper-answer input[value="${CSS.escape(quick.dataset.fill)}"]`)
            .forEach(input => { input.checked = true; });
        return;
    }

    const save = e.target.closest('.paper-save');
    if (save) saveVote(save.closest('.paper-row'), save);
}

export function closePaperVotes() {
    modal()?.classList.remove('is-open');
    unlockScroll();
    const done = state?.saved > 0 ? state.onDone : null;
    state = null;
    done?.();
}

/**
 * Відкриває вікно внесення. Дані читаємо щоразу заново: між обходом
 * і внесенням мешканці могли проголосувати в застосунку, і затерти
 * їхній голос паперовим листком не можна.
 */
export async function openPaperVotes(poll, onDone = () => {}) {
    const box = modal();
    if (!box) return;

    document.getElementById('paperVotesTitle').textContent = 'Паперові голоси';
    document.getElementById('paperVotesMeta').textContent =
        `${poll.title}${meetingWhen(poll) ? ` · ${meetingWhen(poll)}` : ''}`;
    const search = document.getElementById('paperVotesSearch');
    search.value = '';
    document.getElementById('paperVotesList').innerHTML = '<p class="list-empty">Завантаження…</p>';
    document.getElementById('paperVotesCount').textContent = '';
    box.classList.add('is-open');
    lockScroll();

    try {
        const [apartments, voteSnap] = await Promise.all([
            fetchDirectory(),
            getDocs(collection(db, 'polls', poll.id, 'votes'))
        ]);
        const voted = new Set(voteSnap.docs.map(d => d.id));
        state = {
            poll,
            saved: 0,
            onDone,
            pending: apartments.filter(a => !voted.has(String(a.apt)))
        };
        renderList();
        updateCounter();
    } catch (e) {
        console.error('Список для паперових голосів:', e);
        document.getElementById('paperVotesList').innerHTML =
            '<p class="list-empty">Не вдалося завантажити список квартир</p>';
    }
}

/** Разова прив'язка обробників вікна. */
export function initPaperVotes() {
    const box = modal();
    if (!box || box.dataset.ready) return;
    box.dataset.ready = '1';

    document.getElementById('closePaperVotesBtn')?.addEventListener('click', closePaperVotes);
    box.addEventListener('click', (e) => { if (e.target === box) closePaperVotes(); });
    document.getElementById('paperVotesList')?.addEventListener('click', onListClick);
    document.getElementById('paperVotesSearch')?.addEventListener('input', function () {
        if (state) renderList(this.value);
    });
}
