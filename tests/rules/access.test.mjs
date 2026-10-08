import test, { after, afterEach, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { initializeTestEnvironment, assertFails, assertSucceeds } from '@firebase/rules-unit-testing';
import * as firestore from 'firebase/firestore';
import { doc, getDoc, getDocs, collection, setDoc, updateDoc, writeBatch, serverTimestamp } from 'firebase/firestore';
import { ref, uploadString, uploadBytes, getDownloadURL, getMetadata, deleteObject } from 'firebase/storage';
import { CHAIR_QUESTION, meetingStart, surveyorAssignments, surveyorFor, ownerVoteId, questionTally } from '../../js/meeting.js';
import { createMeetingActions } from '../helpers/meeting-actions.mjs';

let env;
before(async () => {
    env = await initializeTestEnvironment({
        projectId: 'uspih-25-rules-test',
        firestore: { rules: await readFile('firestore.rules', 'utf8') },
        storage: { rules: await readFile('storage.rules', 'utf8') }
    });
});
afterEach(async () => env.clearFirestore());
after(async () => env.cleanup());

async function seed() {
    await env.withSecurityRulesDisabled(async context => {
        const db = context.firestore();
        await setDoc(doc(db, 'apartments/45'), { isAdmin: false, balance: -100 });
        await setDoc(doc(db, 'apartments/board'), { isAdmin: true });
    });
}

test('мешканець читає свою квартиру, але не змінює баланс', async () => {
    await seed();
    const db = env.authenticatedContext('resident', { email: '45@uspih-25.com' }).firestore();
    await assertSucceeds(getDoc(doc(db, 'apartments/45')));
    await assertFails(updateDoc(doc(db, 'apartments/45'), { balance: 0 }));
});

test('мешканець завантажує файл лише у власну папку звернень', async () => {
    await seed();
    const storage = env.authenticatedContext('resident', { email: '45@uspih-25.com' }).storage();
    await assertSucceeds(uploadString(ref(storage, 'requests/45/a.txt'), 'ok'));
    await assertFails(uploadString(ref(storage, 'requests/46/a.txt'), 'no'));
});

test('правління публікує документ ОСББ', async () => {
    await seed();
    const storage = env.authenticatedContext('admin', { email: 'board@uspih-25.com' }).storage();
    const result = await assertSucceeds(uploadString(ref(storage, 'osbb_docs/protocol.pdf'), 'pdf', 'raw', {
        contentType: 'application/pdf'
    }));
    assert.ok(result.ref);
});

test('правління створює та редагує збори зі спільною відповідальною особою', async () => {
    await seed();
    const db = env.authenticatedContext('admin', { email: 'board@uspih-25.com' }).firestore();
    const meeting = doc(db, 'polls/meeting-surveyor');
    const schedule = { meetingDate: '2026-12-20', timeStart: '18:00' };
    await assertSucceeds(setDoc(meeting, {
        title: 'Загальні збори співвласників',
        description: '', attachments: [],
        options: [CHAIR_QUESTION, 'Затвердження кошторису'],
        agendaDecisions: ['', 'Затвердити кошторис'], agendaHeard: ['', ''],
        isMeeting: true, ...schedule, timeEnd: '', location: 'Двір',
        votingOpensAt: meetingStart(schedule),
        surveyors: surveyorAssignments([{ entrance: '', name: 'Іваненко І. І.' }]),
        chairName: '', secretaryName: '', protocolNumber: '', sheetsByEntrance: false,
        deadline: null, status: 'active', resultsSent: false, createdAt: serverTimestamp()
    }));
    await assertSucceeds(updateDoc(meeting, {
        surveyors: surveyorAssignments([{ entrance: '', name: 'Петренко П. П.' }]),
        chairVote: { present: 15, yes: 15, no: 0, abstain: 0 }
    }));
    const saved = (await assertSucceeds(getDoc(meeting))).data();
    assert.equal(surveyorFor(saved, '1'), 'Петренко П. П.');
    assert.deepEqual(saved.chairVote, { present: 15, yes: 15, no: 0, abstain: 0 });
    const residentDb = env.authenticatedContext('resident', { email: '45@uspih-25.com' }).firestore();
    await assertFails(updateDoc(doc(residentDb, meeting.path), { title: 'Змінено мешканцем' }));
    await assertFails(updateDoc(doc(residentDb, meeting.path), { chairVote: { present: 15, yes: 0, no: 15, abstain: 0 } }));
});

test('правління додає PDF, Word, Excel і фото до зборів, мешканець не може', async () => {
    await seed();
    const admin = env.authenticatedContext('admin', { email: 'board@uspih-25.com' });
    const resident = env.authenticatedContext('resident', { email: '45@uspih-25.com' });
    const files = [
        { name: '1791469673683_dodatok_2.pdf', type: 'application/pdf' },
        { name: '1791469673684_Результат голосування 2504.xlsx', type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
        { name: '1791469673685_Проєкт рішення.docx', type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
        { name: '1791469673686_Схема.jpg', type: 'image/jpeg' },
        { name: '1791469673687_Кошторис.xls', type: 'application/octet-stream' }
    ];
    const attachments = [];
    for (const file of files) {
        const path = `polls/${file.name}`;
        const fileRef = ref(admin.storage(), path);
        const data = new Uint8Array(75 * 1024);
        await assertSucceeds(uploadBytes(fileRef, data, { contentType: file.type }));
        const url = await assertSucceeds(getDownloadURL(fileRef));
        attachments.push({ name: file.name, type: file.type, size: data.length, url });
        await assertSucceeds(getMetadata(ref(resident.storage(), path)));
        await assertFails(uploadBytes(ref(resident.storage(), path), data, { contentType: file.type }));
    }
    const meetingRef = doc(admin.firestore(), 'polls/meeting-with-files');
    await assertSucceeds(setDoc(meetingRef, { isMeeting: true, title: 'Збори з вкладеннями', attachments }));
    const saved = (await assertSucceeds(getDoc(meetingRef))).data();
    assert.deepEqual(saved.attachments, attachments);
});

test('правління завантажує й оновлює протоколи, мешканці лише читають', async () => {
    await seed();
    const admin = env.authenticatedContext('admin', { email: 'board@uspih-25.com' });
    const resident = env.authenticatedContext('resident', { email: '45@uspih-25.com' });
    const anonymous = env.unauthenticatedContext();
    const files = [
        { name: 'Протокол правління.pdf', type: 'application/pdf' },
        { name: 'Додаток до протоколу.docx', type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
        { name: 'Кошторис.xlsx', type: 'application/octet-stream' }
    ];
    for (const [index, file] of files.entries()) {
        const path = `osbb_docs/board-test-${index}_${file.name}`;
        const fileRef = ref(admin.storage(), path);
        await assertSucceeds(uploadBytes(fileRef, new Uint8Array(1024), { contentType: file.type }));
        const url = await assertSucceeds(getDownloadURL(fileRef));
        const documentRef = doc(admin.firestore(), `osbb_documents/board-test-${index}`);
        await assertSucceeds(setDoc(documentRef, {
            title: file.name, category: 'Протоколи правління', fileName: file.name,
            url, type: file.type, size: 1024, createdAt: serverTimestamp()
        }));
        assert.equal((await assertSucceeds(getDoc(doc(resident.firestore(), documentRef.path)))).data().url, url);
        await assertSucceeds(getMetadata(ref(resident.storage(), path)));
        await assertFails(uploadBytes(ref(resident.storage(), path), new Uint8Array(2048), { contentType: file.type }));
        await assertFails(deleteObject(ref(resident.storage(), path)));
        await assertFails(getMetadata(ref(anonymous.storage(), path)));
        await assertFails(uploadBytes(ref(anonymous.storage(), path), new Uint8Array(1024), { contentType: file.type }));
        await assertSucceeds(uploadBytes(fileRef, new Uint8Array(2048), { contentType: file.type }));
        assert.equal((await getMetadata(fileRef)).size, 2048);
        await assertSucceeds(deleteObject(fileRef));
    }
});

test('ліміти вкладень зборів і протоколів перевіряються у Storage', async () => {
    await seed();
    const storage = env.authenticatedContext('admin', { email: 'board@uspih-25.com' }).storage();
    const metadata = { contentType: 'application/pdf' };
    await assertFails(uploadBytes(ref(storage, 'polls/oversized.pdf'), new Uint8Array(20 * 1024 * 1024), metadata));
    await assertFails(uploadBytes(ref(storage, 'osbb_docs/oversized.pdf'), new Uint8Array(30 * 1024 * 1024), metadata));
    const protocol = ref(storage, 'osbb_docs/large-protocol.pdf');
    await assertSucceeds(uploadBytes(protocol, new Uint8Array(21 * 1024 * 1024), metadata));
    await assertSucceeds(deleteObject(protocol));
});

test('правління записує окремі паперові голоси співвласників без перезапису інших питань', async () => {
    await seed();
    const admin = env.authenticatedContext('admin', { email: 'board@uspih-25.com' }).firestore();
    const resident = env.authenticatedContext('resident', { email: '45@uspih-25.com' }).firestore();
    await setDoc(doc(admin, 'polls/paper-owner-test'), {
        isMeeting: true, options: ['Голова', 'Кошторис'], status: 'active',
        votingOpensAt: new Date(Date.now() + 3600000)
    });
    const apartments = [{ apt: '45', area: 64, owners: [
        { id: 'first', name: 'Перший', shareFrac: '1/2' }, { id: 'second', name: 'Другий', shareFrac: '1/2' }
    ] }];
    const refs = ['first', 'second'].map(id => doc(admin, 'polls/paper-owner-test/votes', ownerVoteId('45', id)));
    await assertSucceeds(setDoc(refs[0], {
        apt: '45', ownerId: 'first', source: 'paper', answers: { 0: 'За' },
        enteredBy: 'board', votedAt: serverTimestamp()
    }));
    await assertSucceeds(setDoc(refs[0], { answers: { 1: 'Проти' } }, { merge: true }));
    await assertSucceeds(setDoc(refs[1], { apt: '45', ownerId: 'second', source: 'paper', answers: { 1: 'За' } }));
    const votes = await Promise.all(refs.map(async ref => (await getDoc(ref)).data()));
    assert.deepEqual(votes[0].answers, { 0: 'За', 1: 'Проти' });
    const tally = questionTally(votes, apartments, 1);
    assert.equal(tally.rows['За'].ownersCount, 1);
    assert.equal(tally.rows['Проти'].ownersCount, 1);
    await assertFails(setDoc(doc(resident, refs[1].path), { answers: { 1: 'Проти' } }, { merge: true }));
    await assertFails(setDoc(doc(admin, 'polls/paper-owner-test/votes', ownerVoteId('45', 'invalid')), {
        apt: '45', ownerId: 'invalid', source: 'paper', answers: { 0: 'Невідома відповідь' }
    }));
    await assertSucceeds(setDoc(doc(admin, 'polls/paper-owner-test/votes/46'), {
        source: 'paper', answers: { 0: 'За' }, enteredBy: 'board', votedAt: serverTimestamp()
    }));
});

test('мешканець голосує за свою квартиру, але не підмінює паперовий голос чи власника', async () => {
    await seed();
    const admin = env.authenticatedContext('admin', { email: 'board@uspih-25.com' }).firestore();
    const resident = env.authenticatedContext('resident', { email: '45@uspih-25.com' }).firestore();
    await setDoc(doc(admin, 'polls/resident-meeting'), {
        isMeeting: true, options: ['Голова', 'Кошторис'], status: 'active', deadline: null,
        votingOpensAt: new Date(Date.now() - 3600000)
    });
    const vote = doc(resident, 'polls/resident-meeting/votes/45');
    const payload = () => ({ answers: { 0: 'За', 1: 'Утримався' }, votedAt: serverTimestamp() });
    await assertSucceeds(setDoc(vote, payload()));
    await assertSucceeds(setDoc(vote, { answers: { 0: 'Проти' }, votedAt: serverTimestamp() }));
    await assertFails(setDoc(doc(resident, 'polls/resident-meeting/votes/46'), payload()));
    for (const extra of [{ apt: '46' }, { ownerId: 'another-owner' }, { source: 'paper' }, { enteredBy: 'board' }]) {
        await assertFails(setDoc(vote, { ...payload(), ...extra }));
    }
    await assertFails(setDoc(doc(resident, 'polls/resident-meeting/votes', ownerVoteId('45', 'first')), {
        ...payload(), apt: '45', ownerId: 'first', source: 'paper'
    }));
    await assertFails(setDoc(vote, { answers: { 0: 'Інша відповідь' }, votedAt: serverTimestamp() }));
    await assertFails(setDoc(vote, { option: 'Голова', votedAt: serverTimestamp() }));
});

test('межі часу голосування залишаються чинними, звичайні опитування працюють', async () => {
    await seed();
    const admin = env.authenticatedContext('admin', { email: 'board@uspih-25.com' }).firestore();
    const resident = env.authenticatedContext('resident', { email: '45@uspih-25.com' }).firestore();
    const meeting = doc(admin, 'polls/meeting-time-test');
    const payload = () => ({ answers: { 0: 'За' }, votedAt: serverTimestamp() });
    const vote = doc(resident, 'polls/meeting-time-test/votes/45');
    await setDoc(meeting, {
        isMeeting: true, options: ['Голова'], status: 'active', deadline: null,
        votingOpensAt: new Date(Date.now() + 3600000)
    });
    await assertFails(setDoc(vote, payload()));
    await updateDoc(meeting, { votingOpensAt: new Date(Date.now() - 3600000), deadline: new Date(Date.now() - 1000) });
    await assertFails(setDoc(vote, payload()));
    await updateDoc(meeting, { deadline: null, status: 'closed' });
    await assertFails(setDoc(vote, payload()));
    await setDoc(doc(admin, 'polls/regular-poll'), { options: ['А', 'Б'], status: 'active', deadline: null });
    const regular = doc(resident, 'polls/regular-poll/votes/45');
    await assertSucceeds(setDoc(regular, { option: 'А', votedAt: serverTimestamp() }));
    await assertFails(setDoc(regular, { option: 'В', votedAt: serverTimestamp() }));
    await assertFails(setDoc(regular, { option: 'А', source: 'paper', votedAt: serverTimestamp() }));
    await assertFails(setDoc(regular, { answers: { 0: 'За' }, votedAt: serverTimestamp() }));
});

async function seedActionMeeting(status = 'active') {
    await seed();
    await env.withSecurityRulesDisabled(async context => {
        const db = context.firestore();
        await updateDoc(doc(db, 'apartments/45'), { area: 80, entrance: '1' });
        await setDoc(doc(db, 'apartments/45/owners/first'), { name: 'Перший власник', shareFrac: '1/2' });
        await setDoc(doc(db, 'apartments/45/owners/second'), { name: 'Другий власник', shareFrac: '1/2' });
        await setDoc(doc(db, 'polls/action-meeting'), {
            isMeeting: true, title: 'Загальні збори', status, resultsSent: false,
            options: [CHAIR_QUESTION, 'Кошторис'], meetingDate: '2026-10-08',
            protocolNumber: '25', chairName: 'Голова', secretaryName: 'Секретар',
            agendaHeard: ['Пропозицію', 'Звіт'], agendaDecisions: ['Обрати', 'Затвердити'],
            chairVote: { present: 15, yes: 8, no: 4, abstain: 3 }
        });
        await setDoc(doc(db, 'polls/action-meeting/votes/45'), { answers: { 0: 'Проти', 1: 'За' } });
        await setDoc(doc(db, `polls/action-meeting/votes/${ownerVoteId('45', 'second')}`), {
            apt: '45', ownerId: 'second', source: 'paper', answers: { 1: 'Проти' }
        });
    });
    const db = env.authenticatedContext('admin', { email: 'board@uspih-25.com' }).firestore();
    return { db, actions: createMeetingActions(db, () => 'board') };
}

function protocolPayload(id = 'action-meeting') {
    const fileName = `Protocol_${id}.pdf`;
    return { pollId: id, fileName, size: 1024,
        url: `https://firebasestorage.googleapis.com/v0/b/uspih-25.firebasestorage.app/o/${encodeURIComponent(`osbb_docs/${fileName}`)}?alt=media&token=test` };
}

function failingWrites(method, prefix) {
    return { ...firestore, runTransaction: (db, callback) => firestore.runTransaction(db, tx => callback(new Proxy(tx, {
        get(target, key) {
            const value = Reflect.get(target, key, target);
            if (typeof value !== 'function') return value;
            return (...args) => {
                if (key === method && args[0].path.startsWith(prefix)) throw new Error('Змодельований збій запису');
                return value.apply(target, args);
            };
        }
    }))) };
}

test('завершення зборів з браузера рахує власників і очні числа, паралельні спроби не дублюють розсилку', async () => {
    const { db, actions } = await seedActionMeeting();
    await Promise.all([actions.finalizeMeeting('action-meeting'), actions.finalizeMeeting('action-meeting')]);
    const poll = (await getDoc(doc(db, 'polls/action-meeting'))).data();
    assert.equal(poll.status, 'closed');
    assert.equal(poll.resultsSent, true);
    assert.equal(poll.quorum.totalOwners, 2);
    assert.equal(poll.quorum.votedOwners, 2);
    assert.equal(poll.quorum.votedArea, 80);
    assert.equal((await getDocs(collection(db, 'messages'))).size, 1);
    const messageRef = doc(db, 'messages/meeting-results_action-meeting');
    const message = (await getDoc(messageRef)).data();
    assert.match(message.body, /за 8, проти 4, утримався 3/);
    assert.match(message.body, /присутніх 15, проголосували 15/);
    assert.match(message.body, /за 1, проти 1, утримався 0/);
    await updateDoc(messageRef, { readBy: { 45: true } });
    await actions.finalizeMeeting('action-meeting');
    const repeated = (await getDoc(messageRef)).data();
    assert.deepEqual(repeated.readBy, { 45: true });
    assert.equal(repeated.createdAt.toMillis(), message.createdAt.toMillis());
    assert.equal((await getDoc(doc(db, 'polls/action-meeting'))).data().closedAt.toMillis(), poll.closedAt.toMillis());
    const resident = env.authenticatedContext('resident', { email: '45@uspih-25.com' }).firestore();
    await assertFails(setDoc(doc(resident, 'polls/action-meeting/votes/45'), {
        answers: { 1: 'За' }, votedAt: serverTimestamp()
    }));
});

test('після збою розсилки збори закриті, позначка не поставлена, повторна спроба завершує збереження', async () => {
    const { db, actions } = await seedActionMeeting();
    const failing = createMeetingActions(db, () => 'board', failingWrites('set', 'messages/'));
    await assert.rejects(failing.finalizeMeeting('action-meeting'), /Змодельований збій/);
    const poll = (await getDoc(doc(db, 'polls/action-meeting'))).data();
    assert.equal(poll.status, 'closed');
    assert.equal(poll.resultsSent, false);
    assert.equal((await getDoc(doc(db, 'messages/meeting-results_action-meeting'))).exists(), false);
    await actions.finalizeMeeting('action-meeting');
    assert.equal((await getDoc(doc(db, 'polls/action-meeting'))).data().resultsSent, true);
    assert.equal((await getDocs(collection(db, 'messages'))).size, 1);
});

test('протокол і повідомлення публікуються разом, повторна публікація зберігає прочитання і дати', async () => {
    const { db, actions } = await seedActionMeeting('closed');
    const payload = protocolPayload();
    await Promise.all([actions.publishMeetingProtocol(payload), actions.publishMeetingProtocol(payload)]);
    const documentRef = doc(db, 'osbb_documents/protocol_action-meeting');
    const messageRef = doc(db, 'messages/protocol_action-meeting');
    const document = (await getDoc(documentRef)).data();
    const message = (await getDoc(messageRef)).data();
    const poll = (await getDoc(doc(db, 'polls/action-meeting'))).data();
    assert.equal(poll.protocolPublished, true);
    assert.equal(poll.protocolUrl, payload.url);
    assert.equal(document.url, payload.url);
    assert.equal(document.category, 'Протоколи зборів');
    assert.equal(message.linkedDoc.url, payload.url);
    assert.match(message.body, /за 8, проти 4, утримався 3/);
    assert.match(message.body, /за 1, проти 1, утримався 0/);
    await updateDoc(messageRef, { readBy: { 45: true } });
    await actions.publishMeetingProtocol({ ...payload, url: payload.url.replace('token=test', 'token=replaced') });
    assert.equal((await getDocs(collection(db, 'messages'))).size, 1);
    assert.equal((await getDocs(collection(db, 'osbb_documents'))).size, 1);
    assert.deepEqual((await getDoc(messageRef)).data().readBy, { 45: true });
    assert.equal((await getDoc(messageRef)).data().createdAt.toMillis(), message.createdAt.toMillis());
    assert.equal((await getDoc(documentRef)).data().createdAt.toMillis(), document.createdAt.toMillis());
    const resident = env.authenticatedContext('resident', { email: '45@uspih-25.com' }).firestore();
    await assertSucceeds(getDoc(doc(resident, messageRef.path)));
    await assertSucceeds(getDoc(doc(resident, documentRef.path)));
});

test('збій фінального запису протоколу не лишає ані документа, ані оголошення, повторна спроба працює', async () => {
    const { db, actions } = await seedActionMeeting('closed');
    const failing = createMeetingActions(db, () => 'board', failingWrites('update', 'polls/'));
    await assert.rejects(failing.publishMeetingProtocol(protocolPayload()), /Змодельований збій/);
    assert.equal((await getDoc(doc(db, 'osbb_documents/protocol_action-meeting'))).exists(), false);
    assert.equal((await getDoc(doc(db, 'messages/protocol_action-meeting'))).exists(), false);
    assert.notEqual((await getDoc(doc(db, 'polls/action-meeting'))).data().protocolPublished, true);
    await actions.publishMeetingProtocol(protocolPayload());
    assert.equal((await getDoc(doc(db, 'polls/action-meeting'))).data().protocolPublished, true);
});

test('протокол відкритих зборів, некоректних очних чисел або чужого файлу не публікується', async () => {
    const { db, actions } = await seedActionMeeting();
    const payload = protocolPayload();
    await assert.rejects(actions.publishMeetingProtocol(payload), { code: 'failed-precondition' });
    await updateDoc(doc(db, 'polls/action-meeting'), {
        status: 'closed', chairVote: { present: 15, yes: 14, no: 2, abstain: 0 }
    });
    await assert.rejects(actions.publishMeetingProtocol(payload), { code: 'failed-precondition' });
    await updateDoc(doc(db, 'polls/action-meeting'), { chairVote: { present: 15, yes: 15, no: 0, abstain: 0 } });
    for (const invalid of [
        { ...payload, url: payload.url.replace('uspih-25.firebasestorage.app', 'another.appspot.com') },
        { ...payload, url: payload.url.replace('Protocol_action-meeting.pdf', 'another.pdf') },
        { ...payload, size: 30 * 1024 * 1024 }
    ]) await assert.rejects(actions.publishMeetingProtocol(invalid), { code: 'invalid-argument' });
    assert.equal((await getDocs(collection(db, 'osbb_documents'))).size, 0);
    assert.equal((await getDocs(collection(db, 'messages'))).size, 0);
});

test('застарілий текст PDF відхиляється, повторне читання бачить актуальні дані власників і голосів', async () => {
    const { db, actions } = await seedActionMeeting('closed');
    const context = await actions.loadMeetingContext('action-meeting');
    assert.equal(context.apartments.length, 1);
    assert.deepEqual(context.apartments[0].owners.map(owner => owner.id).sort(), ['first', 'second']);
    await updateDoc(doc(db, 'polls/action-meeting'), {
        protocolNumber: '26', chairVote: { present: 15, yes: 9, no: 3, abstain: 3 }
    });
    await updateDoc(doc(db, `polls/action-meeting/votes/${ownerVoteId('45', 'second')}`), { answers: { 1: 'За' } });
    await updateDoc(doc(db, 'apartments/45'), { area: 100 });
    await assert.rejects(actions.publishMeetingProtocol(protocolPayload(), context), { code: 'failed-precondition' });
    assert.equal((await getDocs(collection(db, 'osbb_documents'))).size, 0);
    const fresh = await actions.loadMeetingContext('action-meeting');
    const published = await actions.publishMeetingProtocol(protocolPayload(), fresh);
    assert.equal(published.quorum.votedArea, 100);
    const message = (await getDoc(doc(db, 'messages/protocol_action-meeting'))).data();
    assert.match(message.body, /за 9, проти 3, утримався 3/);
    assert.match(message.body, /за 2, проти 0, утримався 0/);
    assert.match(published.title, /Протокол № 26/);
});

test('мешканець і неавторизована сесія не можуть завершити збори або опублікувати протокол', async () => {
    const { db } = await seedActionMeeting('closed');
    const resident = env.authenticatedContext('resident', { email: '45@uspih-25.com' }).firestore();
    const actions = createMeetingActions(resident, () => '45');
    await assert.rejects(actions.finalizeMeeting('action-meeting'), { code: 'permission-denied' });
    await assert.rejects(actions.publishMeetingProtocol(protocolPayload()), { code: 'permission-denied' });
    const signedOut = createMeetingActions(db, () => null);
    await assert.rejects(signedOut.finalizeMeeting('action-meeting'), { code: 'unauthenticated' });
    await assert.rejects(signedOut.publishMeetingProtocol(protocolPayload()), { code: 'unauthenticated' });
    // Перевіряємо й прямий обхід UI: право запису визначають правила.
    const batch = writeBatch(resident);
    batch.update(doc(resident, 'polls/action-meeting'), { protocolPublished: true });
    batch.set(doc(resident, 'osbb_documents/protocol_action-meeting'), { title: 'Підробка', url: protocolPayload().url });
    batch.set(doc(resident, 'messages/protocol_action-meeting'), { recipients: ['all'], title: 'Підробка' });
    await assertFails(batch.commit());
    assert.equal((await getDocs(collection(db, 'osbb_documents'))).size, 0);
    assert.equal((await getDocs(collection(db, 'messages'))).size, 0);
});
