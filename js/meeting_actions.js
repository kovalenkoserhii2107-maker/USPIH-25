// Операції правління зі зборами. Права перевіряє Firestore;
// публікація оголошення і службових позначок відбувається разом.
import { db, currentApt } from './firebase.js';
import * as firestore from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js';
import { computeQuorum, meetingSummary, chairVoteError, formatMeetingDate, QUORUM_PCT } from './meeting.js';

function fail(code, message) {
    const error = new Error(message);
    error.code = code;
    throw error;
}

function meetingId(value) {
    const id = String(value || '').trim();
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) fail('invalid-argument', 'Некоректний ID зборів');
    return id;
}

function requireMeeting(snapshot) {
    if (!snapshot.exists() || snapshot.data().isMeeting !== true) {
        fail('not-found', 'Збори не знайдено');
    }
    return { ...snapshot.data(), id: snapshot.id };
}

function requireClosed(poll) {
    if (poll.status !== 'closed') fail('failed-precondition', 'Спочатку завершіть збори');
}

function requireChairVote(poll) {
    const error = chairVoteError(poll.chairVote);
    if (error) fail('failed-precondition', error);
}

// Дані, які потрапляють у текст PDF. Зміни в іншій вкладці під час
// його складання потребують повторної генерації, а не тихої публікації.
function protocolBasis(poll) {
    return JSON.stringify([
        poll.title, poll.description, poll.options, poll.agendaHeard, poll.agendaDecisions,
        poll.meetingDate, poll.timeStart, poll.timeEnd, poll.location,
        poll.protocolNumber, poll.chairName, poll.secretaryName,
        ['present', 'yes', 'no', 'abstain'].map(key => poll.chairVote?.[key])
    ]);
}

/** Окремий екземпляр дозволяє перевіряти ці операції з реальними правилами в емуляторі. */
export function createMeetingActions(database, apartmentOfCurrentUser, api = firestore) {
    const { doc, collection, collectionGroup, getDocFromServer, getDocsFromServer,
        runTransaction, serverTimestamp } = api;

    async function requireAdmin() {
        const apt = apartmentOfCurrentUser();
        if (!apt) fail('unauthenticated', 'Сеанс завершився. Увійдіть повторно.');
        const admin = await getDocFromServer(doc(database, 'apartments', apt));
        if (!admin.exists() || admin.data().isAdmin !== true) {
            fail('permission-denied', 'Ця дія доступна лише правлінню.');
        }
    }

    async function readContext(id) {
        const pollRef = doc(database, 'polls', id);
        // Для юридичного документа потрібні актуальні дані сервера,
        // навіть якщо довідник або форма були відкриті кілька годин тому.
        const [pollSnap, aptSnap, ownerSnap, votesSnap] = await Promise.all([
            getDocFromServer(pollRef),
            getDocsFromServer(collection(database, 'apartments')),
            getDocsFromServer(collectionGroup(database, 'owners')),
            getDocsFromServer(collection(database, 'polls', id, 'votes'))
        ]);
        const poll = requireMeeting(pollSnap);
        const ownersByApt = {};
        ownerSnap.forEach(owner => {
            const apt = owner.ref.parent.parent?.id;
            if (apt) (ownersByApt[apt] ||= []).push({ ...owner.data(), id: owner.id });
        });
        const apartments = aptSnap.docs.filter(apartment => apartment.data().isAdmin !== true)
            .map(apartment => ({
                apt: apartment.id, entrance: apartment.data().entrance || '',
                area: apartment.data().area || '', owners: ownersByApt[apartment.id] || []
            })).sort((a, b) => a.apt.localeCompare(b.apt, 'uk', { numeric: true }));
        const votes = votesSnap.docs.map(vote => ({ apt: vote.id, ...vote.data() }));
        return { poll, apartments, votes };
    }

    async function loadMeetingContext(pollId) {
        const id = meetingId(pollId);
        await requireAdmin();
        return readContext(id);
    }

    async function finalizeMeeting(pollId) {
        const id = meetingId(pollId);
        await requireAdmin();
        const pollRef = doc(database, 'polls', id);
        // Спершу закриваємо голосування, щоб електронні голоси більше
        // не змінювалися під час читання підсумків. Незавершена розсилка
        // лишає збори доступними для повторного натискання кнопки.
        await runTransaction(database, async tx => {
            const poll = requireMeeting(await tx.get(pollRef));
            if (poll.status !== 'closed') {
                tx.update(pollRef, { status: 'closed', closedAt: serverTimestamp() });
            }
        });
        const { apartments, votes } = await readContext(id);
        const quorum = computeQuorum(votes, apartments);
        const messageRef = doc(database, 'messages', `meeting-results_${id}`);
        await runTransaction(database, async tx => {
            const poll = requireMeeting(await tx.get(pollRef));
            const messageSnap = await tx.get(messageRef);
            requireClosed(poll);
            const message = {
                title: `Підсумки зборів: ${poll.title || 'Загальні збори'}`,
                body: `Голосування завершено.\n\nРІШЕННЯ\n${meetingSummary(poll, votes, apartments)}\n\nЯВКА\n`
                    + `${quorum.hasQuorum ? 'Кворум зібрано' : 'Кворуму немає'} (потрібно ${QUORUM_PCT}% власників)\n`
                    + `Власники: ${quorum.votedOwners} з ${quorum.totalOwners} — ${quorum.ownersPct}%\n`
                    + `Площа: ${quorum.votedArea} з ${quorum.totalArea} м² — ${quorum.areaPct}%\n\n`
                    + 'Протокол зборів буде опубліковано в Базі документів ОСББ.',
                targetType: 'all', targetValue: '', recipients: ['all'], attachments: [], linkedDoc: null,
                systemKey: `meeting-results:${id}`
            };
            if (!messageSnap.exists()) Object.assign(message, { createdAt: serverTimestamp(), readBy: {} });
            tx.set(messageRef, message, { merge: true });
            tx.update(pollRef, { quorum, resultsSent: true, resultsSentAt: serverTimestamp() });
        });
        return { quorum, resultsSent: true };
    }

    async function publishMeetingProtocol({ pollId, url, fileName, size }, context) {
        const id = meetingId(pollId);
        let parsed;
        try { parsed = new URL(url); } catch { /* перевіряється нижче */ }
        if (parsed?.protocol !== 'https:' || parsed.hostname !== 'firebasestorage.googleapis.com'
            || !parsed.pathname.startsWith('/v0/b/uspih-25.firebasestorage.app/o/')
            || fileName !== `Protocol_${id}.pdf` || !Number.isSafeInteger(size)
            || size <= 0 || size >= 30 * 1024 * 1024) {
            fail('invalid-argument', 'Некоректні дані протоколу');
        }
        let objectPath;
        try { objectPath = decodeURIComponent(parsed.pathname.split('/o/')[1]); } catch { /* нижче */ }
        if (objectPath !== `osbb_docs/${fileName}`) fail('invalid-argument', 'Некоректний файл протоколу');
        await requireAdmin();
        const data = context || await readContext(id);
        if (data.poll.id !== id) fail('invalid-argument', 'Дані належать іншим зборам');
        requireClosed(data.poll);
        requireChairVote(data.poll);
        const { apartments, votes } = data;
        const quorum = computeQuorum(votes, apartments);
        const pollRef = doc(database, 'polls', id);
        const docId = `protocol_${id}`;
        const documentRef = doc(database, 'osbb_documents', docId);
        const messageRef = doc(database, 'messages', docId);
        return runTransaction(database, async tx => {
            const poll = requireMeeting(await tx.get(pollRef));
            const documentSnap = await tx.get(documentRef);
            const messageSnap = await tx.get(messageRef);
            requireClosed(poll);
            requireChairVote(poll);
            if (protocolBasis(poll) !== protocolBasis(data.poll)) {
                fail('failed-precondition', 'Дані зборів змінилися під час формування. Сформуйте протокол ще раз.');
            }
            const dateLabel = formatMeetingDate(poll.meetingDate) || 'без дати';
            const title = `Протокол № ${String(poll.protocolNumber || '').trim() || '___'} загальних зборів від ${dateLabel}`;
            const document = { title, category: 'Протоколи зборів', fileName, url, size,
                type: 'application/pdf', pollId: id };
            if (!documentSnap.exists()) document.createdAt = serverTimestamp();
            const message = {
                title: `Протокол зборів від ${dateLabel}`,
                body: 'Протокол загальних зборів співвласників сформовано та додано до Бази документів ОСББ.\n\n'
                    + `Участь узяли ${quorum.votedOwners} із ${quorum.totalOwners} співвласників `
                    + `(${quorum.ownersPct}%), ${quorum.votedArea} із ${quorum.totalArea} м².\n`
                    + `${quorum.hasQuorum ? 'Кворум зібрано, збори правомочні.' : 'Кворуму немає, збори неправомочні.'}\n\n`
                    + `РІШЕННЯ (голосів співвласників)\n${meetingSummary(poll, votes, apartments)}\n\n`
                    + 'Повний текст протоколу — у прикріпленому документі.',
                targetType: 'all', targetValue: '', recipients: ['all'], attachments: [],
                linkedDoc: { name: title, url, type: 'application/pdf', size }, systemKey: `protocol:${id}`
            };
            if (!messageSnap.exists()) Object.assign(message, { createdAt: serverTimestamp(), readBy: {} });
            tx.set(documentRef, document, { merge: true });
            tx.set(messageRef, message, { merge: true });
            tx.update(pollRef, { quorum, protocolUrl: url, protocolDocId: docId,
                protocolAt: serverTimestamp(), protocolPublished: true });
            return { url, title, quorum, docId };
        });
    }

    return { loadMeetingContext, finalizeMeeting, publishMeetingProtocol };
}

export const { loadMeetingContext, finalizeMeeting, publishMeetingProtocol } = createMeetingActions(db, currentApt);
