// ============================================================
// Внесення паперових голосів (письмове опитування).
//
// Порядок роботи повторює стос листків на столі: листки друкують
// на КОЖНЕ питання окремо й роздають відповідальним по парадних,
// тому й тут спершу обирається питання та парадна, а далі йде
// суцільний список квартир — рядок за рядком, як на аркуші.
// Позначити треба лише «За», «Проти» чи «Утримався».
//
// Голос лягає туди ж, куди й звичайний, — polls/{id}/votes/{apt},
// але з міткою source: 'paper' і лише в ті питання, за якими є
// підпис: запис іде злиттям (merge), тож відповідь на друге питання
// не стирає раніше внесену відповідь на перше.
//
// Квартири, які вже відповіли на це питання, показані окремо й без
// перемикачів: другий запис не «додав» би голос, а мовчки затер
// перший — зокрема й поданий мешканцем у застосунку.
// ============================================================
import { db, session } from './firebase.js';
import {
    collection, getDocs, doc, writeBatch, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js";
import { escapeHtml, toast, setBusy, lockScroll, unlockScroll } from './ui.js';
import { fetchDirectory } from './directory.js';
import {
    MEETING_ANSWERS, agendaOf, answerFor, isPaperVote,
    meetingWhen, ownersLine, parseArea, entrancesOf, aptsOfEntrance
} from './meeting.js';

let state = null;   // { poll, apartments, votes, question, entrance, saved, onDone }

const modal = () => document.getElementById('paperVotesModal');
const el = (id) => document.getElementById(id);

/** Відповідь квартири на поточне питання, якщо вона вже є. */
function existing(apt) {
    const vote = state.votes.get(String(apt));
    if (!vote) return null;
    const answer = answerFor(vote, state.question);
    return answer ? { answer, paper: isPaperVote(vote) } : null;
}

function rowMarkup(apt) {
    const area = parseArea(apt.area);
    const done = existing(apt.apt);

    const controls = done
        ? `<span class="paper-done-mark">${escapeHtml(done.answer)}
               <small>${done.paper ? 'письмово' : 'у застосунку'}</small></span>`
        : `<div class="paper-answers" role="radiogroup" aria-label="Кв. ${escapeHtml(apt.apt)}">
               ${MEETING_ANSWERS.map(ans => `
                   <label class="paper-answer">
                       <input type="radio" name="paper-${escapeHtml(apt.apt)}" value="${escapeHtml(ans)}">
                       <span>${escapeHtml(ans)}</span>
                   </label>`).join('')}
           </div>`;

    return `<div class="paper-row${done ? ' paper-row-done' : ''}" data-apt="${escapeHtml(apt.apt)}">
        <div class="paper-row-head">
            <span class="paper-apt">Кв. ${escapeHtml(apt.apt)}</span>
            <span class="paper-row-text">
                <span class="paper-owners">${escapeHtml(ownersLine(apt))}</span>
                <span class="paper-area">${area ? `${area} м²` : 'площа не вказана'}</span>
            </span>
        </div>
        ${controls}
    </div>`;
}

function visibleApartments() {
    const needle = (el('paperVotesSearch')?.value || '').trim().toLowerCase();
    let list = aptsOfEntrance(state.apartments, state.entrance);
    if (needle) {
        list = list.filter(a => String(a.apt).includes(needle)
            || ownersLine(a).toLowerCase().includes(needle));
    }
    return list;
}

function renderList() {
    const host = el('paperVotesList');
    if (!host || !state) return;
    const list = visibleApartments();
    host.innerHTML = list.length
        ? list.map(rowMarkup).join('')
        : '<p class="list-empty">Квартир не знайдено</p>';

    const left = list.filter(a => !existing(a.apt)).length;
    el('paperVotesCount').textContent = left
        ? `Питання ${state.question + 1} · залишилося внести: ${left} з ${list.length}`
        : `Питання ${state.question + 1} · голоси внесено за всіма квартирами списку`;
}

/** Записує всі позначені рядки одним пакетом. */
async function saveMarked(btn) {
    const host = el('paperVotesList');
    const marked = [];
    host.querySelectorAll('.paper-row').forEach(row => {
        const picked = row.querySelector('.paper-answer input:checked');
        if (picked) marked.push({ apt: row.dataset.apt, answer: picked.value });
    });
    if (!marked.length) return toast('Немає жодної позначеної квартири', 'error');

    setBusy(btn, true, `Запис ${marked.length}…`);
    try {
        // Пакетами по 400: у Firestore на один batch не більше 500 записів,
        // а обхід великої парадної легко дає кілька сотень листків.
        for (let i = 0; i < marked.length; i += 400) {
            const batch = writeBatch(db);
            marked.slice(i, i + 400).forEach(({ apt, answer }) => {
                batch.set(doc(db, 'polls', state.poll.id, 'votes', String(apt)), {
                    answers: { [String(state.question)]: answer },
                    source: 'paper',
                    enteredBy: String(session.apt || ''),
                    votedAt: serverTimestamp()
                }, { merge: true });
            });
            await batch.commit();
        }

        // Оновлюємо локальний знімок голосів, щоб рядки одразу стали
        // «внесеними», а лічильник не брехав до перезавантаження.
        marked.forEach(({ apt, answer }) => {
            const vote = state.votes.get(String(apt)) || { apt: String(apt), answers: {}, source: 'paper' };
            vote.answers = { ...(vote.answers || {}), [String(state.question)]: answer };
            state.votes.set(String(apt), vote);
        });
        state.saved += marked.length;
        renderList();
        toast(`Внесено голосів: ${marked.length}`, 'success');
    } catch (e) {
        console.error('Паперові голоси:', e);
        toast(e.code === 'permission-denied'
            ? 'Сервер відхилив запис: опублікуйте оновлені правила Firestore'
            : 'Не вдалося зберегти голоси', 'error');
    } finally {
        setBusy(btn, false);
    }
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

    el('paperVotesMeta').textContent =
        `${poll.title}${meetingWhen(poll) ? ` · ${meetingWhen(poll)}` : ''}`;
    el('paperVotesSearch').value = '';
    el('paperVotesList').innerHTML = '<p class="list-empty">Завантаження…</p>';
    el('paperVotesCount').textContent = '';
    box.classList.add('is-open');
    lockScroll();

    try {
        const [apartments, voteSnap] = await Promise.all([
            fetchDirectory(),
            getDocs(collection(db, 'polls', poll.id, 'votes'))
        ]);
        state = {
            poll, apartments, onDone, saved: 0,
            question: 0,
            entrance: '',
            votes: new Map(voteSnap.docs.map(d => [d.id, { apt: d.id, ...d.data() }]))
        };

        el('paperQuestion').innerHTML = agendaOf(poll)
            .map((q, i) => `<option value="${i}">Питання ${i + 1}. ${escapeHtml(q)}</option>`)
            .join('');

        const entrances = entrancesOf(apartments).filter(Boolean);
        el('paperEntrance').innerHTML = ['<option value="">Усі парадні</option>',
            ...entrances.map(e => `<option value="${escapeHtml(e)}">Парадна ${escapeHtml(e)}</option>`)]
            .join('');
        // Листки роздають по парадних, тож із однією парадною вибір зайвий
        el('paperEntrance').closest('.field').hidden = entrances.length < 2;

        renderList();
    } catch (e) {
        console.error('Список для паперових голосів:', e);
        el('paperVotesList').innerHTML =
            '<p class="list-empty">Не вдалося завантажити список квартир</p>';
    }
}

/** Разова прив'язка обробників вікна. */
export function initPaperVotes() {
    const box = modal();
    if (!box || box.dataset.ready) return;
    box.dataset.ready = '1';

    el('closePaperVotesBtn')?.addEventListener('click', closePaperVotes);
    box.addEventListener('click', (e) => { if (e.target === box) closePaperVotes(); });
    el('paperQuestion')?.addEventListener('change', function () {
        if (!state) return;
        state.question = parseInt(this.value, 10) || 0;
        renderList();
    });
    el('paperEntrance')?.addEventListener('change', function () {
        if (!state) return;
        state.entrance = this.value;
        renderList();
    });
    el('paperVotesSearch')?.addEventListener('input', () => { if (state) renderList(); });
    el('paperSaveBtn')?.addEventListener('click', function () { saveMarked(this); });
}
