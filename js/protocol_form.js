// ============================================================
// Дані, які дописуються в протокол перед його формуванням.
//
// Номер протоколу, голова й секретар відомі лише після зборів —
// їх обирають першим питанням порядку денного. «Слухали» пишеться
// теж по факту. Тому вікно відкривається в мить, коли правління
// натискає «Сформувати протокол», а не при створенні зборів.
//
// Проєкти рішень сюди підтягуються з порядку денного: під час
// зборів формулювання часто правлять, і протокол має містити те,
// за що насправді голосували, а не те, що планували.
// ============================================================
import { db } from './firebase.js';
import { audit } from './audit.js';
import { doc, updateDoc } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { escapeHtml, toast, setBusy, lockScroll, unlockScroll } from './ui.js';
import { agendaOf, meetingWhen, isChairQuestion, chairVoteError, chairVoteTally } from './meeting.js';

let state = null;      // { poll, apartments, votes, onDone }

const modal = () => document.getElementById('protocolModal');

function chairVoteFields(vote = {}) {
    vote = vote || {};
    return `<span class="field-hint">Голову й секретаря обирають з голосу більшістю присутніх на зборах.</span>
        <div class="proto-chair-counts">
            ${[
                ['protoPresent', 'Присутніх співвласників / представників', vote.present, 1],
                ['protoFor', 'За', vote.yes, 0],
                ['protoAgainst', 'Проти', vote.no ?? 0, 0],
                ['protoAbstained', 'Утримались', vote.abstain ?? 0, 0]
            ].map(([id, label, value, min]) => `<div class="field">
                <label class="field-label" for="${id}">${label}</label>
                <input type="number" inputmode="numeric" min="${min}" step="1"
                    id="${id}" class="field-input" value="${escapeHtml(value ?? '')}" placeholder="Кількість">
            </div>`).join('')}
        </div>
        <span id="protoChairVoteSummary" class="field-hint" aria-live="polite"></span>`;
}

function readChairVote() {
    return Object.fromEntries([
        ['present', 'protoPresent'], ['yes', 'protoFor'], ['no', 'protoAgainst'], ['abstain', 'protoAbstained']
    ].map(([key, id]) => {
        const value = document.getElementById(id)?.value.trim();
        return [key, value ? Number(value) : NaN];
    }));
}

function updateChairVoteSummary() {
    const summary = document.getElementById('protoChairVoteSummary');
    if (!summary) return;
    const tally = chairVoteTally(readChairVote());
    summary.textContent = tally
        ? `Проголосували: ${tally.votedOwners} з ${tally.baseOwners}. Не проголосували: ${tally.baseOwners - tally.votedOwners}. `
            + `Рішення ${tally.accepted ? 'прийнято' : 'не прийнято'}.`
        : 'Внесіть кількість присутніх і голоси з першого питання. Сума голосів не може перевищувати кількість присутніх.';
}

function questionBlock(question, index, heard, decision, chairVote) {
    return `<div class="proto-q">
        <span class="proto-q-title">Питання ${index + 1}. ${escapeHtml(question)}</span>
        ${isChairQuestion(index) ? chairVoteFields(chairVote) : ''}
        <label class="field-label" for="protoHeard${index}">Слухали</label>
        <textarea id="protoHeard${index}" class="field-input proto-heard" rows="2"
                  placeholder="Кого слухали і про що — коротко">${escapeHtml(heard)}</textarea>
        <label class="field-label" for="protoDecision${index}">Вирішили</label>
        <textarea id="protoDecision${index}" class="field-input proto-decision" rows="3"
                  placeholder="Текст рішення; кожен пункт — з нового рядка">${escapeHtml(decision)}</textarea>
    </div>`;
}

export function closeProtocolForm() {
    if (state?.saving) return;
    modal()?.classList.remove('is-open');
    unlockScroll();
    state = null;
}

/** Збирає введене, дописує в опитування й запускає генерацію PDF. */
async function submit(btn) {
    if (!state || state.saving) return;
    const { poll, apartments, votes } = state;
    const questions = agendaOf(poll);
    const agendaHeard = [];
    const agendaDecisions = [];
    for (let i = 0; i < questions.length; i++) {
        agendaHeard.push(document.getElementById(`protoHeard${i}`)?.value.trim() || '');
        agendaDecisions.push(document.getElementById(`protoDecision${i}`)?.value.trim() || '');
    }
    const patch = {
        protocolNumber: document.getElementById('protoNumber').value.trim(),
        chairName: document.getElementById('protoChair').value.trim(),
        secretaryName: document.getElementById('protoSecretary').value.trim(),
        agendaHeard,
        agendaDecisions
    };
    if (questions.length) {
        patch.chairVote = readChairVote();
        const error = chairVoteError(patch.chairVote);
        if (error) return toast(error, 'error');
    }

    if (!patch.chairName || !patch.secretaryName) {
        return toast('Вкажіть голову й секретаря зборів', 'error');
    }
    // «Слухали» і «Вирішили» — обов'язкові розділи протоколу. Порожні
    // вони роблять документ непридатним, а помітити це вже після
    // публікації означає передруковувати й перепідписувати.
    const missing = questions.findIndex((_, i) => !agendaHeard[i] || !agendaDecisions[i]);
    if (missing >= 0) {
        return toast(`Питання ${missing + 1}: заповніть «Слухали» і «Вирішили»`, 'error');
    }

    state.saving = true;
    setBusy(btn, true, 'Запис даних…');
    try {
        // Спершу в базу, потім у PDF: якщо генерація впаде, введене
        // не доведеться набирати вдруге — воно вже збережене.
        await updateDoc(doc(db, 'polls', poll.id), patch);
        const filled = { ...poll, ...patch };
        state.poll = filled;

        const { generateAndPublishProtocol } = await import('./protocol_pdf.js');
        await generateAndPublishProtocol(filled, apartments, votes,
            (step) => setBusy(btn, true, step));

        const done = state.onDone;
        state.saving = false;
        closeProtocolForm();
        await audit('protocol.publish', { target: `polls/${filled.id}`, summary: `Протокол зборів «${filled.title}» опубліковано` });
        toast('Протокол опубліковано та надіслано мешканцям', 'success');
        done?.();
    } catch (e) {
        console.error('Формування протоколу:', e);
        toast(e.message || 'Не вдалося сформувати протокол', 'error');
    } finally {
        if (state) state.saving = false;
        setBusy(btn, false);
    }
}

export function openProtocolForm({ poll, apartments, votes, onDone }) {
    const box = modal();
    if (!box) return;
    state = { poll, apartments, votes, onDone, saving: false };

    document.getElementById('protoMeta').textContent =
        `${poll.title}${meetingWhen(poll) ? ` · ${meetingWhen(poll)}` : ''}`;
    document.getElementById('protoNumber').value = poll.protocolNumber || '';
    document.getElementById('protoChair').value = poll.chairName || '';
    document.getElementById('protoSecretary').value = poll.secretaryName || '';

    const heard = poll.agendaHeard || [];
    const decisions = poll.agendaDecisions || [];
    const chair = (poll.chairName || '').trim();
    document.getElementById('protocolQuestions').innerHTML = agendaOf(poll)
        .map((q, i) => questionBlock(q, i,
            // Порожнє «Слухали» підказуємо заготовкою: правлінню лишається
            // виправити формулювання, а не писати розділ з нуля.
            heard[i] || (chair ? `Голову зборів ${chair} з питання ${i + 1} порядку денного.` : ''),
            decisions[i] || '', poll.chairVote))
        .join('');
    updateChairVoteSummary();

    box.classList.add('is-open');
    lockScroll();
}

/** Разова прив'язка обробників вікна. */
export function initProtocolForm() {
    const box = modal();
    if (!box || box.dataset.ready) return;
    box.dataset.ready = '1';
    document.getElementById('closeProtocolModalBtn')?.addEventListener('click', closeProtocolForm);
    box.addEventListener('click', (e) => { if (e.target === box) closeProtocolForm(); });
    document.getElementById('protoSubmitBtn')?.addEventListener('click', function () { submit(this); });
    box.addEventListener('input', event => {
        if (event.target.closest('.proto-chair-counts')) updateChairVoteSummary();
    });
}
