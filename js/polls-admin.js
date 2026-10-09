// ============================================================
// Опитування в панелі правління: створення, список, завершення
// й розсилка підсумків. Кабінет мешканця цього коду не вантажить.
// ============================================================
import { db, storage } from './firebase.js';
import { audit } from './audit.js';
import {
    collection, addDoc, getDoc, updateDoc, doc, runTransaction, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import {
    ref as sRef, uploadBytes, getDownloadURL
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-storage.js";
import { escapeHtml, formatDateTime, toast, setBusy, confirmDialog } from './ui.js';
import { renderAttachments, renderFileManager } from './attachments.js';
import { buildRecipients } from './messages-admin.js';
import { fetchDirectory } from './directory.js';
import { finalizeMeeting } from './meeting_actions.js';
import { QUORUM_PCT, computeQuorum, isMeeting } from './meeting.js';
import {
    fetchPollsWithVotes, fetchVotes, formatDeadline, isClosed, isExpired, statusBadge, tallyVotes, renderQuorum, renderResults
} from './polls.js';

let pendingPollFiles = [];
const adminPages = { polls: [], cursor: null, hasMore: false };

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
            isMeeting: false,
            status: 'active',
            resultsSent: false,
            createdAt: serverTimestamp()
        });
        await audit('poll.create', { target: 'polls', summary: `Опитування «${title}» опубліковано` });
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
            if (isMeeting(poll)) {
                await finalizeMeeting(poll.id);
                continue;
            }
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
export async function broadcastMeetingResults(poll) {
    return finalizeMeeting(poll.id);
}

/** Кнопка під карткою опитування. Збори ведуться у власній вкладці. */
function adminPollActions(poll) {
    return isClosed(poll) ? '' : `<div class="poll-actions">
        <button type="button" class="btn-soft btn-compact poll-close-btn"
                data-poll="${poll.id}">Завершити опитування</button></div>`;
}

export async function loadAdminPolls(append = false) {
    const host = document.getElementById('adminPollsContainer');
    if (!host) return;
    if (!append) {
        host.innerHTML = '<p class="list-empty">Завантаження…</p>';
        Object.assign(adminPages, { polls: [], cursor: null, hasMore: false });
    }

    try {
        const page = await fetchPollsWithVotes(append ? adminPages.cursor : null);
        await closeExpiredPolls(page.polls);
        page.polls.forEach(poll => {
            if (poll.status === 'active' && isExpired(poll)) poll.status = 'closed';
        });
        adminPages.polls.push(...page.polls);
        adminPages.cursor = page.cursor;
        adminPages.hasMore = page.hasMore;
        let polls = adminPages.polls;
        // Збори мають власну вкладку з іншим життєвим циклом — тут лише опитування
        polls = polls.filter(p => !isMeeting(p));

        // Правління бачить явку наживо, не чекаючи завершення
        const apartments = await fetchDirectory().catch(e => {
            console.warn('Довідник для кворуму:', e);
            return [];
        });

        if (!polls.length) {
            host.innerHTML = '<p class="list-empty">Опитувань ще не створено</p>'
                + (adminPages.hasMore
                    ? '<button type="button" class="btn-soft admin-polls-more">Показати давніші</button>' : '');
            host.querySelector('.admin-polls-more')?.addEventListener('click', () => loadAdminPolls(true));
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
                ${adminPollActions(poll)}
            </div>`).join('') + (adminPages.hasMore
                ? '<button type="button" class="btn-soft admin-polls-more">Показати давніші</button>' : '');

        polls.forEach(p => {
            if (p.attachments?.length) {
                renderAttachments(host.querySelector(`.poll-attach[data-poll-att="${p.id}"]`), p.attachments);
            }
        });

        host.querySelectorAll('.poll-close-btn').forEach(btn => {
            btn.addEventListener('click', function () { closePoll(this.dataset.poll, this); });
        });
        host.querySelector('.admin-polls-more')?.addEventListener('click', () => loadAdminPolls(true));
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
        if (meeting) {
            await finalizeMeeting(pollId);
            await audit('meeting.close', { target: `polls/${pollId}`, summary: 'Збори завершено, підсумки надіслано' });
            toast('Збори завершено, підсумки надіслано', 'success');
            await loadAdminPolls();
            return;
        }
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
        await audit('poll.close', { target: `polls/${pollId}`, summary: `Опитування «${poll.title}» завершено` });
        toast(meeting ? 'Збори завершено, підсумки надіслано' : 'Опитування завершено, підсумки надіслано', 'success');
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
export function initPollsAdmin() {
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
