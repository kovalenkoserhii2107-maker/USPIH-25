// ============================================================
// Загальні збори співвласників: власна вкладка правління.
//
// Збори живуть у тій самій колекції polls, що й опитування, але
// ведуться інакше — через порядок денний, обхід квартир і протокол,
// — тому й панель у них окрема. Опитування лишилися на своїй вкладці
// й нічого про збори не знають.
//
// Три списки один під одним: форма створення, активні збори (їх ще
// можна правити й добирати голоси) і архів (завершені, з протоколами).
// Правити можна і в архіві: описка в питанні спливає найчастіше тоді,
// коли протокол уже друкують.
// ============================================================
import { db, storage } from './firebase.js';
import {
    collection, addDoc, getDocs, getDoc, doc, updateDoc,
    query, orderBy, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js";
import {
    ref as sRef, uploadBytes, getDownloadURL
} from "https://www.gstatic.com/firebasejs/10.8.1/firebase-storage.js";
import { escapeHtml, formatDateTime, toast, setBusy, confirmDialog, lockScroll, unlockScroll } from './ui.js';
import { renderAttachments, renderFileManager } from './attachments.js';
import { buildRecipients } from './messages.js';
import { fetchDirectory } from './directory.js';
import {
    CHAIR_QUESTION, MEETING_ANSWERS, DECISION_PCT, isMeeting, agendaOf,
    computeQuorum, questionTally, isChairQuestion, meetingWhen,
    formatMeetingDate, fmtPct, entrancesOf, meetingStart, beforeStart, startLabel
} from './meeting.js';

let pendingFiles = [];
let cache = { meetings: [], apartments: [] };
let editing = null;             // збори, відкриті у вікні редагування

// ------------------------------------------------------------
// ФОРМА: ПОРЯДОК ДЕННИЙ
// ------------------------------------------------------------
/**
 * Рядок порядку денного.
 *
 * Номер друкується самою формою: правління не має його вписувати,
 * інакше після видалення другого питання нумерація попливе, а в
 * протокол потрапить «Питання 2, Питання 4».
 */
function agendaRow(listId, value = '', decision = '') {
    const list = document.getElementById(listId);
    const row = document.createElement('div');
    row.className = 'poll-option-row poll-option-row-meeting agenda-row';
    row.innerHTML = `
        <div class="poll-option-main">
            <span class="agenda-no"></span>
            <input type="text" class="field-input poll-option-input"
                   placeholder="Формулювання питання" value="${escapeHtml(value)}">
            <button type="button" class="poll-option-del" aria-label="Прибрати питання">
                <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor"
                     stroke-width="2.2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
            </button>
        </div>
        <textarea class="field-input poll-decision-input" rows="2"
                  placeholder="Проєкт рішення — кожен пункт з нового рядка">${escapeHtml(decision)}</textarea>`;
    row.querySelector('.poll-option-del').addEventListener('click', () => {
        row.remove();
        renumberAgenda(listId);
    });
    list.appendChild(row);
    renumberAgenda(listId);
    return row;
}

/** Проставляє номери. Питання 1 — про голову, тож форма починає з другого. */
function renumberAgenda(listId) {
    const rows = document.querySelectorAll(`#${listId} .agenda-row`);
    rows.forEach((row, i) => {
        row.querySelector('.agenda-no').textContent = `${i + 2}.`;
        const del = row.querySelector('.poll-option-del');
        if (del) del.disabled = rows.length <= 1;
    });
}

function readAgenda(listId) {
    return Array.from(document.querySelectorAll(`#${listId} .agenda-row`)).map(row => ({
        question: row.querySelector('.poll-option-input').value.trim(),
        decision: row.querySelector('.poll-decision-input').value.trim()
    })).filter(x => x.question);
}

// ------------------------------------------------------------
// ФОРМА: ГОЛОВА ТА СЕКРЕТАР
// ------------------------------------------------------------
/** Список співвласників для підказки у полях голови й секретаря. */
function fillOwnersDatalist(apartments) {
    const list = document.getElementById('meetingOwnersList');
    if (!list) return;
    const seen = new Set();
    const items = [];
    (apartments || []).forEach(a => (a.owners || []).forEach(o => {
        const label = `${o.name} (кв. ${a.apt})`;
        if (o.name && !seen.has(label)) { seen.add(label); items.push(label); }
    }));
    list.innerHTML = items.map(v => `<option value="${escapeHtml(v)}"></option>`).join('');
}

/**
 * Перше питання порядку денного однакове на всіх зборах, тому його
 * рішення й «Слухали» складаються з того, кого запропоновано.
 * Правління ще зможе виправити текст у вікні протоколу — якщо на
 * зборах обрали не тих, кого пропонували.
 */
function chairTexts(chair, secretary) {
    if (!chair && !secretary) return { heard: '', decision: '' };
    const who = [
        chair ? `головою загальних зборів — ${chair}` : '',
        secretary ? `секретарем зборів — ${secretary}` : ''
    ].filter(Boolean).join(', ');
    return {
        heard: `Пропозицію обрати ${who}.`,
        decision: `Обрати ${who}.`
    };
}

/**
 * Поля «хто проводить опитування».
 *
 * Листки роздають по парадних, тому й відповідальних зазвичай кілька.
 * Коли парадна одна або друк іде суцільним списком, лишається одне
 * поле — ключ '' означає «для всіх».
 */
function renderSurveyors(hostId, values = {}, byEntrance = true) {
    const host = document.getElementById(hostId);
    if (!host) return;
    const entrances = byEntrance ? entrancesOf(cache.apartments).filter(Boolean) : [];
    const rows = entrances.length > 1
        ? entrances.map(e => ({ key: e, label: `Парадна ${e}` }))
        : [{ key: '', label: 'Відповідальна особа' }];

    host.innerHTML = rows.map(r => `
        <label class="surveyor-row">
            <span class="surveyor-label">${escapeHtml(r.label)}</span>
            <input type="text" class="field-input surveyor-input" list="meetingOwnersList"
                   data-entrance="${escapeHtml(r.key)}" placeholder="Прізвище та ініціали"
                   value="${escapeHtml(values[r.key] || values[''] || '')}">
        </label>`).join('');
}

function readSurveyors(hostId) {
    const out = {};
    document.querySelectorAll(`#${hostId} .surveyor-input`).forEach(input => {
        const v = input.value.trim();
        if (v) out[input.dataset.entrance] = v;
    });
    return out;
}

// ------------------------------------------------------------
// СТВОРЕННЯ
// ------------------------------------------------------------
function meetingPlace(selectId, otherId) {
    const select = document.getElementById(selectId);
    if (!select) return '';
    return select.value === 'other'
        ? document.getElementById(otherId).value.trim()
        : select.value;
}

function resetForm() {
    document.getElementById('meetingTitle').value = 'Загальні збори співвласників';
    document.getElementById('meetingDescription').value = '';
    ['meetingDate', 'meetingTimeStart', 'meetingTimeEnd', 'meetingPlaceOther',
     'meetingDeadline', 'meetingChair', 'meetingSecretary'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.value = '';
    });
    const place = document.getElementById('meetingPlace');
    if (place) { place.selectedIndex = 0; togglePlaceOther(); }
    document.getElementById('meetingNotify').checked = true;
    document.getElementById('meetingByEntrance').checked = true;
    document.getElementById('meetingAgendaList').innerHTML = '';
    agendaRow('meetingAgendaList');
    renderSurveyors('meetingSurveyors', {}, true);
    pendingFiles = [];
    refreshChips();
}

function refreshChips() {
    renderFileManager(
        document.getElementById('meetingFilesPreview'),
        [], pendingFiles,
        () => {},
        (i) => { pendingFiles.splice(i, 1); refreshChips(); }
    );
}

function togglePlaceOther() {
    const select = document.getElementById('meetingPlace');
    const other = document.getElementById('meetingPlaceOther');
    if (!select || !other) return;
    other.hidden = select.value !== 'other';
    if (!other.hidden) other.focus();
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

async function createMeeting(btn) {
    const title = document.getElementById('meetingTitle').value.trim();
    const description = document.getElementById('meetingDescription').value.trim();
    const meetingDate = document.getElementById('meetingDate').value;
    const timeStart = document.getElementById('meetingTimeStart').value;
    const timeEnd = document.getElementById('meetingTimeEnd').value;
    const location = meetingPlace('meetingPlace', 'meetingPlaceOther');
    const chairName = document.getElementById('meetingChair').value.trim();
    const secretaryName = document.getElementById('meetingSecretary').value.trim();
    const entered = readAgenda('meetingAgendaList');
    const deadlineRaw = document.getElementById('meetingDeadline').value;

    if (!title) return toast('Вкажіть назву зборів', 'error');
    if (!meetingDate) return toast('Вкажіть дату зборів', 'error');
    if (!timeStart) return toast('Вкажіть час початку зборів', 'error');
    if (timeEnd && timeEnd <= timeStart) {
        return toast('Час закінчення має бути пізніше за початок', 'error');
    }
    if (!location) return toast('Вкажіть місце проведення', 'error');
    if (!entered.length) return toast('Додайте хоча б одне питання порядку денного', 'error');
    const texts = entered.map(x => x.question);
    if (new Set(texts).size !== texts.length) return toast('Питання не мають повторюватися', 'error');

    let deadline = null;
    if (deadlineRaw) {
        deadline = new Date(deadlineRaw);
        if (isNaN(deadline.getTime())) return toast('Невірна дата завершення', 'error');
        if (deadline.getTime() <= Date.now()) {
            return toast('Строк завершення має бути в майбутньому', 'error');
        }
    }

    const chair = chairTexts(chairName, secretaryName);
    const agenda = [
        { question: CHAIR_QUESTION, decision: chair.decision, heard: chair.heard },
        ...entered.map(x => ({ ...x, heard: '' }))
    ];

    setBusy(btn, true, 'Публікація…');
    try {
        const attachments = [];
        for (const file of pendingFiles) {
            const fileRef = sRef(storage, `polls/${Date.now()}_${file.name}`);
            await uploadBytes(fileRef, file);
            attachments.push({
                name: file.name, url: await getDownloadURL(fileRef),
                type: file.type || '', size: file.size || 0
            });
        }

        const payload = {
            title, description, attachments,
            options: agenda.map(x => x.question),
            agendaDecisions: agenda.map(x => x.decision),
            agendaHeard: agenda.map(x => x.heard),
            isMeeting: true,
            meetingDate, timeStart, timeEnd, location,
            // Голосування відкривається в час початку зборів — до того
            // мешканець лише читає порядок денний. Дату рахуємо тут і
            // кладемо в документ: правила Firestore звіряються саме з нею.
            votingOpensAt: meetingStart({ meetingDate, timeStart }),
            surveyors: readSurveyors('meetingSurveyors'),
            chairName, secretaryName,
            protocolNumber: '',
            sheetsByEntrance: document.getElementById('meetingByEntrance').checked,
            deadline,
            status: 'active',
            resultsSent: false,
            createdAt: serverTimestamp()
        };
        const ref = await addDoc(collection(db, 'polls'), payload);

        // Розсилка окремо від запису: якщо вона впаде, збори вже
        // створені й нікуди не зникнуть — запрошення правління
        // повторить звичайним оголошенням.
        if (document.getElementById('meetingNotify').checked) {
            try {
                await announceMeeting({ id: ref.id, ...payload });
                toast('Збори створено, запрошення надіслано', 'success');
            } catch (e) {
                console.error('Запрошення на збори:', e);
                toast('Збори створено, але запрошення не пішло', 'error');
            }
        } else {
            toast('Збори створено', 'success');
        }

        resetForm();
        await loadMeetings();
    } catch (e) {
        console.error('Створення зборів:', e);
        toast('Не вдалося створити збори', 'error');
    } finally {
        setBusy(btn, false);
    }
}

// ------------------------------------------------------------
// СПИСКИ
// ------------------------------------------------------------
function isExpired(poll) {
    if (!poll.deadline) return false;
    const at = poll.deadline.toDate ? poll.deadline.toDate() : new Date(poll.deadline);
    return at.getTime() <= Date.now();
}

const isClosed = (poll) => poll.status !== 'active' || isExpired(poll);

async function fetchVotes(pollId) {
    const snap = await getDocs(collection(db, 'polls', pollId, 'votes'));
    return snap.docs.map(d => ({ apt: d.id, ...d.data() }));
}

function meetingCard(poll, apartments) {
    const q = apartments.length ? computeQuorum(poll.votes, apartments) : null;
    const paper = (poll.votes || []).filter(v => v.source === 'paper').length;
    const online = (poll.votes || []).length - paper;

    const results = agendaOf(poll).map((question, i) => {
        const t = apartments.length
            ? questionTally(poll.votes, apartments, i, isChairQuestion(i))
            : null;
        const counts = MEETING_ANSWERS
            .map(a => `${a.toLowerCase()} — ${t ? t.rows[a].ownersCount : 0}`).join(' · ');
        return `<div class="meeting-line">
            <span class="meeting-line-q"><b>${i + 1}.</b> ${escapeHtml(question)}</span>
            <span class="meeting-line-counts">${counts}</span>
            ${t ? `<span class="meeting-verdict ${t.accepted ? 'is-ok' : 'is-no'}">
                ${t.accepted ? 'Рішення прийнято' : 'Рішення не прийнято'}
                <small>«за» — ${t.rows[MEETING_ANSWERS[0]].ownersCount} з ${t.baseOwners}
                ${t.amongPresent ? 'присутніх' : 'співвласників'}
                (${fmtPct(t.rows[MEETING_ANSWERS[0]].ownersPct)}%), потрібно понад ${DECISION_PCT}%</small>
            </span>` : ''}
        </div>`;
    }).join('');

    const actions = [
        `<button type="button" class="btn-soft btn-compact meet-edit" data-id="${poll.id}">Редагувати</button>`,
        `<button type="button" class="btn-soft btn-compact meet-sheets" data-id="${poll.id}">Друк листків</button>`
    ];
    if (!poll.protocolUrl) {
        actions.push(`<button type="button" class="btn-soft btn-compact meet-paper" data-id="${poll.id}">Внести паперові голоси</button>`);
    }
    if (!isClosed(poll)) {
        actions.push(`<button type="button" class="btn-soft btn-compact meet-close" data-id="${poll.id}">Завершити збори</button>`);
    } else {
        actions.push(`<button type="button" class="btn-primary btn-compact meet-protocol" data-id="${poll.id}">${
            poll.protocolUrl ? 'Сформувати протокол заново' : 'Сформувати протокол'}</button>`);
    }

    return `<div class="poll-card poll-card-admin meeting-card">
        <div class="poll-head">
            ${isClosed(poll)
                ? '<span class="poll-badge poll-badge-closed">Завершено</span>'
                : beforeStart(poll)
                ? '<span class="poll-badge poll-badge-soon">Незабаром</span>'
                : '<span class="poll-badge poll-badge-active">Триває</span>'}
            <span class="poll-date">${formatDateTime(poll.createdAt)}</span>
        </div>
        <h3 class="poll-title">${escapeHtml(poll.title)}</h3>
        <div class="meeting-meta">${[
            formatMeetingDate(poll.meetingDate),
            poll.timeStart ? (poll.timeEnd ? `${poll.timeStart}–${poll.timeEnd}` : `з ${poll.timeStart}`) : '',
            poll.location
        ].filter(Boolean).map(c => `<span class="meeting-chip">${escapeHtml(c)}</span>`).join('')}</div>
        ${poll.description ? `<p class="poll-desc">${escapeHtml(poll.description)}</p>` : ''}
        ${beforeStart(poll) && !isClosed(poll)
            ? `<span class="meeting-wait">Голосування відкриється ${escapeHtml(startLabel(poll))}
                   — зараз мешканці бачать лише порядок денний</span>`
            : ''}
        <div class="attach-block poll-attach" data-meet-att="${poll.id}"></div>
        <div class="meeting-lines">${results}</div>
        <span class="meeting-split">Особисто на зборах: <b>${online}</b>
            · письмове опитування: <b>${paper}</b>${
            q ? ` · кворум: <b>${fmtPct(q.ownersPct)}%</b>` : ''}</span>
        ${poll.protocolUrl
            ? `<a class="meeting-protocol-link" href="${escapeHtml(poll.protocolUrl)}"
                  target="_blank" rel="noopener">Протокол опубліковано — відкрити PDF</a>`
            : ''}
        <div class="poll-actions">${actions.join('')}</div>
    </div>`;
}

export async function loadMeetings() {
    const active = document.getElementById('meetingsActive');
    const archive = document.getElementById('meetingsArchive');
    if (!active || !archive) return;
    active.innerHTML = '<p class="list-empty">Завантаження…</p>';
    archive.innerHTML = '';

    try {
        const snap = await getDocs(query(collection(db, 'polls'), orderBy('createdAt', 'desc')));
        const meetings = snap.docs.map(d => ({ id: d.id, ...d.data() })).filter(isMeeting);
        const votes = await Promise.all(meetings.map(m => fetchVotes(m.id)));
        meetings.forEach((m, i) => { m.votes = votes[i]; });

        const apartments = await fetchDirectory().catch(e => {
            console.warn('Довідник для зборів:', e);
            return [];
        });
        cache = { meetings, apartments };
        fillOwnersDatalist(apartments);
        // Поля відповідальних залежать від списку парадних, а він
        // відомий лише разом із довідником — тому малюємо їх тут.
        if (!document.getElementById('meetingSurveyors')?.children.length) {
            renderSurveyors('meetingSurveyors', {},
                document.getElementById('meetingByEntrance')?.checked !== false);
        }

        const live = meetings.filter(m => !isClosed(m));
        const past = meetings.filter(isClosed);

        active.innerHTML = live.length
            ? live.map(m => meetingCard(m, apartments)).join('')
            : '<p class="list-empty">Активних зборів немає</p>';
        archive.innerHTML = past.length
            ? past.map(m => meetingCard(m, apartments)).join('')
            : '<p class="list-empty">Архів порожній</p>';

        meetings.forEach(m => {
            if (!m.attachments?.length) return;
            document.querySelectorAll(`[data-meet-att="${m.id}"]`)
                .forEach(host => renderAttachments(host, m.attachments));
        });
    } catch (e) {
        console.error('Завантаження зборів:', e);
        active.innerHTML = '<p class="list-empty">Не вдалося завантажити збори</p>';
    }
}

/** Протоколи зборів і засідань правління — одним списком. */
export async function loadProtocols() {
    const host = document.getElementById('meetingsProtocols');
    if (!host) return;
    host.innerHTML = '<p class="list-empty">Завантаження…</p>';
    try {
        const snap = await getDocs(query(collection(db, 'osbb_documents'), orderBy('createdAt', 'desc')));
        const docs = snap.docs
            .map(d => ({ id: d.id, ...d.data() }))
            .filter(d => /протокол/i.test(d.category || '') || /протокол/i.test(d.title || ''));

        if (!docs.length) {
            host.innerHTML = '<p class="list-empty">Протоколів ще немає. '
                + 'Протокол зборів зʼявиться тут після формування, '
                + 'а протокол правління можна завантажити у вкладці «База».</p>';
            return;
        }
        host.innerHTML = docs.map(d => `
            <a class="proto-row" href="${escapeHtml(d.url)}" target="_blank" rel="noopener">
                <span class="proto-row-text">
                    <span class="proto-row-title">${escapeHtml(d.title)}</span>
                    <span class="proto-row-meta">${escapeHtml(d.category || 'Протоколи')} ·
                        ${formatDateTime(d.createdAt)}</span>
                </span>
                <svg class="row-chevron" viewBox="0 0 24 24" width="18" height="18" fill="none"
                     stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"></polyline></svg>
            </a>`).join('');
    } catch (e) {
        console.error('Завантаження протоколів:', e);
        host.innerHTML = '<p class="list-empty">Не вдалося завантажити протоколи</p>';
    }
}

// ------------------------------------------------------------
// РЕДАГУВАННЯ
// ------------------------------------------------------------
function openEdit(poll) {
    editing = poll;
    const set = (id, v) => { const el = document.getElementById(id); if (el) el.value = v ?? ''; };
    document.getElementById('editMeetingMeta').textContent = meetingWhen(poll) || poll.title;
    set('editMeetingTitle', poll.title);
    set('editMeetingDescription', poll.description);
    set('editMeetingDate', poll.meetingDate);
    set('editMeetingTimeStart', poll.timeStart);
    set('editMeetingTimeEnd', poll.timeEnd);
    set('editMeetingPlace', poll.location);
    set('editMeetingChair', poll.chairName);
    set('editMeetingSecretary', poll.secretaryName);
    document.getElementById('editMeetingByEntrance').checked = poll.sheetsByEntrance !== false;
    renderSurveyors('editSurveyors', poll.surveyors || {}, poll.sheetsByEntrance !== false);

    const dl = poll.deadline?.toDate ? poll.deadline.toDate() : (poll.deadline ? new Date(poll.deadline) : null);
    const pad = (n) => String(n).padStart(2, '0');
    set('editMeetingDeadline', dl && !isNaN(dl.getTime())
        ? `${dl.getFullYear()}-${pad(dl.getMonth() + 1)}-${pad(dl.getDate())}T${pad(dl.getHours())}:${pad(dl.getMinutes())}`
        : '');

    // Перше питання в списку не показуємо: воно однакове на всіх
    // зборах, а голова й секретар правляться полями вище.
    const list = document.getElementById('editAgendaList');
    list.innerHTML = '';
    const decisions = poll.agendaDecisions || [];
    agendaOf(poll).slice(1).forEach((qn, i) => agendaRow('editAgendaList', qn, decisions[i + 1] || ''));
    if (!list.children.length) agendaRow('editAgendaList');

    const voted = (poll.votes || []).length;
    document.getElementById('editAgendaWarn').hidden = voted === 0;

    document.getElementById('meetingEditModal').classList.add('is-open');
    lockScroll();
}

function closeEdit() {
    document.getElementById('meetingEditModal')?.classList.remove('is-open');
    unlockScroll();
    editing = null;
}

async function saveEdit(btn) {
    if (!editing) return;
    const title = document.getElementById('editMeetingTitle').value.trim();
    const meetingDate = document.getElementById('editMeetingDate').value;
    const entered = readAgenda('editAgendaList');
    if (!title) return toast('Вкажіть назву зборів', 'error');
    if (!entered.length) return toast('Порядок денний не може бути порожнім', 'error');

    const chairName = document.getElementById('editMeetingChair').value.trim();
    const secretaryName = document.getElementById('editMeetingSecretary').value.trim();
    const chair = chairTexts(chairName, secretaryName);
    const heardOld = editing.agendaHeard || [];

    const deadlineRaw = document.getElementById('editMeetingDeadline').value;
    let deadline = null;
    if (deadlineRaw) {
        deadline = new Date(deadlineRaw);
        if (isNaN(deadline.getTime())) return toast('Невірна дата завершення', 'error');
    }

    setBusy(btn, true, 'Збереження…');
    try {
        await updateDoc(doc(db, 'polls', editing.id), {
            title,
            description: document.getElementById('editMeetingDescription').value.trim(),
            meetingDate,
            timeStart: document.getElementById('editMeetingTimeStart').value,
            timeEnd: document.getElementById('editMeetingTimeEnd').value,
            location: document.getElementById('editMeetingPlace').value.trim(),
            chairName, secretaryName,
            votingOpensAt: meetingStart({
                meetingDate,
                timeStart: document.getElementById('editMeetingTimeStart').value
            }),
            surveyors: readSurveyors('editSurveyors'),
            sheetsByEntrance: document.getElementById('editMeetingByEntrance').checked,
            options: [CHAIR_QUESTION, ...entered.map(x => x.question)],
            agendaDecisions: [
                // Рішення першого питання переписуємо лише тоді, коли його
                // ще не правили руками у вікні протоколу.
                (editing.agendaDecisions?.[0] && !chair.decision)
                    ? editing.agendaDecisions[0] : (chair.decision || ''),
                ...entered.map(x => x.decision)
            ],
            agendaHeard: [heardOld[0] || chair.heard, ...entered.map((_, i) => heardOld[i + 1] || '')],
            deadline
        });
        closeEdit();
        toast('Зміни збережено', 'success');
        await loadMeetings();
    } catch (e) {
        console.error('Збереження зборів:', e);
        toast('Не вдалося зберегти', 'error');
        setBusy(btn, false);
    }
}

// ------------------------------------------------------------
// ДІЇ НАД ЗБОРАМИ
// ------------------------------------------------------------
const byId = (id) => cache.meetings.find(m => m.id === id);

async function printSheets(poll, btn) {
    if (!cache.apartments.length) return toast('Довідник квартир недоступний', 'error');
    setBusy(btn, true, 'Готуємо PDF…');
    try {
        const { generateBlankSheets } = await import('./protocol_pdf.js');
        await generateBlankSheets(poll, cache.apartments,
            { byEntrance: poll.sheetsByEntrance !== false });
        const ents = entrancesOf(cache.apartments).length;
        toast(poll.sheetsByEntrance !== false && ents > 1
            ? `Листки сформовано окремо по ${ents} парадних`
            : 'Листки опитування завантажено', 'success');
    } catch (e) {
        console.error('Листки опитування:', e);
        toast('Не вдалося сформувати листки', 'error');
    } finally {
        setBusy(btn, false);
    }
}

async function closeMeeting(poll, btn) {
    const ok = await confirmDialog('Завершити збори?',
        'Голосувати більше не можна — ні в застосунку, ні паперовим листком. '
        + 'Підсумки підуть у розсилку, протокол формується окремою кнопкою.',
        'Завершити');
    if (!ok) return;

    setBusy(btn, true, 'Завершення…');
    try {
        const votes = await fetchVotes(poll.id);
        const quorum = computeQuorum(votes, cache.apartments);
        await updateDoc(doc(db, 'polls', poll.id), { status: 'closed', quorum });

        if (!poll.resultsSent) {
            const { broadcastMeetingResults } = await import('./polls.js');
            await broadcastMeetingResults({ ...poll, votes }, quorum, cache.apartments);
            await updateDoc(doc(db, 'polls', poll.id), { resultsSent: true });
        }
        toast('Збори завершено, підсумки надіслано', 'success');
        await loadMeetings();
    } catch (e) {
        console.error('Завершення зборів:', e);
        toast('Не вдалося завершити', 'error');
        setBusy(btn, false);
    }
}

async function openProtocol(poll, btn) {
    setBusy(btn, true, 'Читання даних…');
    try {
        const [snap, votes] = await Promise.all([getDoc(doc(db, 'polls', poll.id)), fetchVotes(poll.id)]);
        if (!snap.exists()) throw new Error('Збори не знайдено');
        if (!cache.apartments.length) {
            return toast('Довідник квартир недоступний — протокол не буде з чого скласти', 'error');
        }
        const { initProtocolForm, openProtocolForm } = await import('./protocol_form.js');
        initProtocolForm();
        openProtocolForm({
            poll: { id: poll.id, ...snap.data() },
            apartments: cache.apartments,
            votes,
            onDone: async () => {
                try {
                    const { populateDocsDropdown } = await import('./requests.js');
                    await populateDocsDropdown();
                } catch (e) { console.warn('Оновлення списку документів:', e); }
                await Promise.all([loadMeetings(), loadProtocols()]);
            }
        });
    } catch (e) {
        console.error('Підготовка протоколу:', e);
        toast('Не вдалося підготувати протокол', 'error');
    } finally {
        setBusy(btn, false);
    }
}

async function openPaper(poll, btn) {
    setBusy(btn, true, 'Відкриваємо…');
    try {
        const { initPaperVotes, openPaperVotes } = await import('./paper_votes.js');
        initPaperVotes();
        await openPaperVotes(poll, () => loadMeetings());
    } catch (e) {
        console.error('Паперові голоси:', e);
        toast('Не вдалося відкрити вікно', 'error');
    } finally {
        setBusy(btn, false);
    }
}

// ------------------------------------------------------------
// ІНІЦІАЛІЗАЦІЯ
// ------------------------------------------------------------
export function initMeetings() {
    const list = document.getElementById('meetingAgendaList');
    if (!list) return;
    if (!list.children.length) agendaRow('meetingAgendaList');

    document.getElementById('addAgendaItemBtn')?.addEventListener('click', () => {
        agendaRow('meetingAgendaList').querySelector('.poll-option-input').focus();
    });
    document.getElementById('addEditAgendaBtn')?.addEventListener('click', () => {
        agendaRow('editAgendaList').querySelector('.poll-option-input').focus();
    });
    document.getElementById('meetingPlace')?.addEventListener('change', togglePlaceOther);
    document.getElementById('meetingByEntrance')?.addEventListener('change', function () {
        renderSurveyors('meetingSurveyors', readSurveyors('meetingSurveyors'), this.checked);
    });
    document.getElementById('editMeetingByEntrance')?.addEventListener('change', function () {
        renderSurveyors('editSurveyors', readSurveyors('editSurveyors'), this.checked);
    });
    document.getElementById('createMeetingBtn')?.addEventListener('click', function () {
        createMeeting(this);
    });
    document.getElementById('meetingFiles')?.addEventListener('change', function () {
        pendingFiles.push(...Array.from(this.files));
        this.value = '';
        refreshChips();
    });

    document.getElementById('closeMeetingEditBtn')?.addEventListener('click', closeEdit);
    document.getElementById('meetingEditModal')?.addEventListener('click', (e) => {
        if (e.target.id === 'meetingEditModal') closeEdit();
    });
    document.getElementById('saveMeetingEditBtn')?.addEventListener('click', function () {
        saveEdit(this);
    });

    // Один слухач на обидва списки: картки перемальовуються цілком,
    // і власні слухачі на кнопках доводилося б вішати щоразу заново.
    ['meetingsActive', 'meetingsArchive'].forEach(id => {
        document.getElementById(id)?.addEventListener('click', (e) => {
            const btn = e.target.closest('button[data-id]');
            if (!btn) return;
            const poll = byId(btn.dataset.id);
            if (!poll) return;
            if (btn.classList.contains('meet-edit')) openEdit(poll);
            else if (btn.classList.contains('meet-sheets')) printSheets(poll, btn);
            else if (btn.classList.contains('meet-paper')) openPaper(poll, btn);
            else if (btn.classList.contains('meet-close')) closeMeeting(poll, btn);
            else if (btn.classList.contains('meet-protocol')) openProtocol(poll, btn);
        });
    });
}
