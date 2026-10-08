// Внесення письмових голосів: окремий рядок і окремий голос кожного співвласника.
// Старі голоси квартири читаються без міграції. Нові документи мають ownerId
// і не змінюють відповіді інших власників або вже внесені електронні голоси.
import { db, session } from './firebase.js';
import {
    collection, getDocs, doc, runTransaction, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { escapeHtml, toast, setBusy, lockScroll, unlockScroll } from './ui.js';
import { fetchDirectory } from './directory.js';
import {
    MEETING_ANSWERS, writtenQuestions, answerFor, isPaperVote, ownerVotingRows,
    meetingWhen, parseArea, ownerShare, entrancesOf
} from './meeting.js';

let state = null;
let loadId = 0;
const modal = () => document.getElementById('paperVotesModal');
const el = id => document.getElementById(id);

function existing(row) {
    const answer = answerFor(row.vote, state.question);
    return answer ? { answer, paper: isPaperVote(row.vote) } : null;
}

function rowMarkup(row) {
    const done = existing(row);
    const name = row.owner.name || 'Власника не вказано';
    const picked = state.drafts.get(row.voteId)?.answers?.[state.question];
    const controls = done
        ? `<span class="paper-done-mark">${escapeHtml(done.answer)}
               <small>${done.paper ? 'письмово' : 'у застосунку'}</small></span>`
        : `<div class="paper-answers" role="radiogroup" aria-label="${escapeHtml(name)}, кв. ${escapeHtml(row.apt)}">
               ${MEETING_ANSWERS.map(ans => `
                   <label class="paper-answer">
                       <input type="radio" name="paper-${escapeHtml(row.voteId)}" value="${escapeHtml(ans)}"
                              ${picked === ans ? 'checked' : ''} ${state.saving ? 'disabled' : ''}>
                       <span>${escapeHtml(ans)}</span>
                   </label>`).join('')}
           </div>`;
    const area = parseArea(row.apartment.area);
    const share = ownerShare(row.owner);
    return `<div class="paper-row${done ? ' paper-row-done' : ''}" data-vote-id="${escapeHtml(row.voteId)}">
        <div class="paper-row-text">
            <span class="paper-owners">${escapeHtml(name)}</span>
            <span class="paper-area"><b>Кв. ${escapeHtml(row.apt)}</b>${area ? ` · ${area} м²` : ''}${share ? ` · ${escapeHtml(share)}` : ''}</span>
        </div>
        ${controls}
    </div>`;
}

function renderList() {
    const host = el('paperVotesList');
    if (!host || !state) return;
    const needle = (el('paperVotesSearch')?.value || '').trim().toLowerCase();
    const all = ownerVotingRows([...state.votes.values()], state.apartments);
    state.rows = new Map(all.map(row => [row.voteId, row]));
    const list = all.filter(row => (!state.entrance || String(row.apartment.entrance) === state.entrance)
        && (!needle || row.apt.includes(needle) || String(row.owner.name || '').toLowerCase().includes(needle)));
    host.innerHTML = list.length ? list.map(rowMarkup).join('') : '<p class="list-empty">Співвласників не знайдено</p>';
    const left = list.filter(row => !existing(row)).length;
    el('paperVotesCount').textContent = left
        ? `Питання ${state.question + 1} · залишилося внести: ${left} з ${list.length} співвласників`
        : `Питання ${state.question + 1} · голоси внесено за всіма співвласниками списку`;
}

/** Транзакція перевіряє свіжі голоси, перш ніж додати підпис іншого власника. */
async function saveMarked(btn) {
    if (!state || state.saving) return;
    const active = state;
    const marked = [...active.drafts.values()];
    if (!marked.length) return toast('Немає жодного позначеного співвласника', 'error');
    active.saving = true;
    renderList();
    setBusy(btn, true, `Запис ${marked.length}…`);
    let saved = 0, skipped = 0;
    try {
        for (let i = 0; i < marked.length; i += 200) {
            const chunk = marked.slice(i, i + 200);
            const result = await runTransaction(db, async transaction => {
                const refs = new Map();
                for (const entry of chunk) {
                    for (const id of [entry.voteId, entry.apt]) {
                        refs.set(id, doc(db, 'polls', active.poll.id, 'votes', id));
                    }
                }
                // Усі читання мають бути до першого запису в транзакції.
                const snapshots = new Map(await Promise.all([...refs].map(async ([id, ref]) =>
                    [id, await transaction.get(ref)])));
                const updates = new Map([...snapshots].filter(([, snap]) => snap.exists())
                    .map(([id, snap]) => [id, { apt: id, ...snap.data() }]));
                let written = 0, already = 0;
                for (const entry of chunk) {
                    const current = snapshots.get(entry.voteId).data();
                    const legacy = snapshots.get(entry.apt).data();
                    const answers = {};
                    for (const [question, answer] of Object.entries(entry.answers)) {
                        if (answerFor(current, question) || answerFor(legacy, question)) already++;
                        else { answers[question] = answer; written++; }
                    }
                    if (!Object.keys(answers).length) continue;
                    const payload = {
                        apt: entry.apt, ownerId: entry.ownerId,
                        answers, source: 'paper', enteredBy: String(session.apt || ''),
                        votedAt: serverTimestamp()
                    };
                    transaction.set(refs.get(entry.voteId), payload, { merge: true });
                    updates.set(entry.voteId, { ...current, ...payload,
                        answers: { ...(current?.answers || {}), ...answers } });
                }
                return { updates, written, already };
            });
            for (const [id, vote] of result.updates) active.votes.set(id, vote);
            chunk.forEach(entry => active.drafts.delete(entry.voteId));
            saved += result.written;
            skipped += result.already;
            active.saved += result.written;
        }
        toast(`Внесено голосів: ${saved}${skipped ? `. Уже внесено: ${skipped}` : ''}`, saved ? 'success' : 'info');
    } catch (error) {
        console.error('Паперові голоси:', error);
        toast(`Не вдалося зберегти всі голоси${saved ? `. Збережено: ${saved}` : ''}. Позначки для решти залишено.`, 'error');
    } finally {
        active.saving = false;
        renderList();
        setBusy(btn, false);
    }
}

export function closePaperVotes() {
    if (state?.saving) return;
    if (state?.drafts.size && !window.confirm('Є незбережені голоси. Закрити без збереження?')) return;
    loadId++;
    modal()?.classList.remove('is-open');
    unlockScroll();
    const done = state?.saved > 0 ? state.onDone : null;
    state = null;
    done?.();
}

export async function openPaperVotes(poll, onDone = () => {}) {
    const questions = writtenQuestions(poll);
    if (!questions.length) return toast('Питання 1 вирішується з голосу. Внесіть підсумки під час формування протоколу.', 'error');
    const box = modal();
    if (!box) return;
    const requestId = ++loadId;
    el('paperVotesMeta').textContent = `${poll.title}${meetingWhen(poll) ? ` · ${meetingWhen(poll)}` : ''}`;
    el('paperVotesSearch').value = '';
    el('paperVotesList').innerHTML = '<p class="list-empty">Завантаження…</p>';
    el('paperVotesCount').textContent = '';
    state = null;
    box.classList.add('is-open');
    lockScroll();
    try {
        const [apartments, voteSnap] = await Promise.all([
            fetchDirectory(), getDocs(collection(db, 'polls', poll.id, 'votes'))
        ]);
        if (requestId !== loadId || !box.classList.contains('is-open')) return;
        state = {
            poll, apartments, onDone, saved: 0, saving: false, question: questions[0].index, entrance: '',
            drafts: new Map(), rows: new Map(),
            votes: new Map(voteSnap.docs.map(d => [d.id, { apt: d.id, ...d.data() }]))
        };
        el('paperQuestion').innerHTML = questions
            .map(({ question, index }) => `<option value="${index}">Питання ${index + 1}. ${escapeHtml(question)}</option>`).join('');
        const entrances = entrancesOf(apartments).filter(Boolean);
        el('paperEntrance').innerHTML = ['<option value="">Усі парадні</option>',
            ...entrances.map(e => `<option value="${escapeHtml(e)}">Парадна ${escapeHtml(e)}</option>`)].join('');
        el('paperEntrance').closest('.field').hidden = entrances.length < 2;
        renderList();
    } catch (error) {
        if (requestId !== loadId) return;
        console.error('Список для паперових голосів:', error);
        el('paperVotesList').innerHTML = '<p class="list-empty">Не вдалося завантажити список співвласників</p>';
    }
}

export function initPaperVotes() {
    const box = modal();
    if (!box || box.dataset.ready) return;
    box.dataset.ready = '1';
    el('closePaperVotesBtn')?.addEventListener('click', closePaperVotes);
    box.addEventListener('click', event => { if (event.target === box) closePaperVotes(); });
    box.addEventListener('change', event => {
        if (!state || state.saving || !event.target.matches('.paper-answer input')) return;
        const voteId = event.target.closest('.paper-row').dataset.voteId;
        const row = state.rows.get(voteId);
        const previous = state.drafts.get(voteId);
        state.drafts.set(voteId, {
            voteId, apt: row.apt, ownerId: row.ownerId,
            answers: { ...(previous?.answers || {}), [state.question]: event.target.value }
        });
    });
    el('paperQuestion')?.addEventListener('change', function () {
        if (!state || state.saving) return;
        state.question = parseInt(this.value, 10) || 0;
        renderList();
    });
    el('paperEntrance')?.addEventListener('change', function () {
        if (!state || state.saving) return;
        state.entrance = this.value;
        renderList();
    });
    el('paperVotesSearch')?.addEventListener('input', () => { if (state && !state.saving) renderList(); });
    el('paperSaveBtn')?.addEventListener('click', function () { saveMarked(this); });
}
