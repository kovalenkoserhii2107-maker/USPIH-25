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
import { doc, updateDoc } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js";
import { escapeHtml, toast, setBusy, lockScroll, unlockScroll } from './ui.js';
import { agendaOf, meetingWhen } from './meeting.js';

let state = null;      // { poll, apartments, votes, onDone }

const modal = () => document.getElementById('protocolModal');

function questionBlock(question, index, heard, decision) {
    return `<div class="proto-q">
        <span class="proto-q-title">Питання ${index + 1}. ${escapeHtml(question)}</span>
        <label class="field-label" for="protoHeard${index}">Слухали</label>
        <textarea id="protoHeard${index}" class="field-input proto-heard" rows="2"
                  placeholder="Кого слухали і про що — коротко">${escapeHtml(heard)}</textarea>
        <label class="field-label" for="protoDecision${index}">Вирішили</label>
        <textarea id="protoDecision${index}" class="field-input proto-decision" rows="3"
                  placeholder="Текст рішення; кожен пункт — з нового рядка">${escapeHtml(decision)}</textarea>
    </div>`;
}

export function closeProtocolForm() {
    modal()?.classList.remove('is-open');
    unlockScroll();
    state = null;
}

/** Збирає введене, дописує в опитування й запускає генерацію PDF. */
async function submit(btn) {
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

    setBusy(btn, true, 'Запис даних…');
    try {
        // Спершу в базу, потім у PDF: якщо генерація впаде, введене
        // не доведеться набирати вдруге — воно вже збережене.
        await updateDoc(doc(db, 'polls', poll.id), patch);
        const filled = { ...poll, ...patch };

        const { generateAndPublishProtocol } = await import('./protocol_pdf.js');
        await generateAndPublishProtocol(filled, apartments, votes,
            (step) => setBusy(btn, true, step));

        const done = state.onDone;
        closeProtocolForm();
        toast('Протокол опубліковано та надіслано мешканцям', 'success');
        done?.();
    } catch (e) {
        console.error('Формування протоколу:', e);
        toast('Не вдалося сформувати протокол', 'error');
        setBusy(btn, false);
    }
}

export function openProtocolForm({ poll, apartments, votes, onDone }) {
    const box = modal();
    if (!box) return;
    state = { poll, apartments, votes, onDone };

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
            decisions[i] || ''))
        .join('');

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
}
