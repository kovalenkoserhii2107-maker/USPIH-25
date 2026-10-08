import test, { after, afterEach, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { initializeTestEnvironment, assertFails, assertSucceeds } from '@firebase/rules-unit-testing';
import { doc, getDoc, setDoc, updateDoc, serverTimestamp } from 'firebase/firestore';
import { ref, uploadString, uploadBytes, getDownloadURL } from 'firebase/storage';
import { CHAIR_QUESTION, meetingStart, surveyorAssignments, surveyorFor, ownerVoteId, questionTally } from '../../js/meeting.js';

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
        surveyors: surveyorAssignments([{ entrance: '', name: 'Петренко П. П.' }])
    }));
    const saved = (await assertSucceeds(getDoc(meeting))).data();
    assert.equal(surveyorFor(saved, '1'), 'Петренко П. П.');
    const residentDb = env.authenticatedContext('resident', { email: '45@uspih-25.com' }).firestore();
    await assertFails(updateDoc(doc(residentDb, meeting.path), { title: 'Змінено мешканцем' }));
});

test('правління завантажує PDF і Excel до зборів, мешканець не може', async () => {
    await seed();
    const admin = env.authenticatedContext('admin', { email: 'board@uspih-25.com' });
    const resident = env.authenticatedContext('resident', { email: '45@uspih-25.com' });
    const files = [
        { name: '1791469673683_dodatok_2.pdf', type: 'application/pdf' },
        { name: '1791469673684_Результат голосування 2504.xlsx', type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }
    ];
    const attachments = [];
    for (const file of files) {
        const path = `polls/${file.name}`;
        const fileRef = ref(admin.storage(), path);
        const data = new Uint8Array(75 * 1024);
        await assertSucceeds(uploadBytes(fileRef, data, { contentType: file.type }));
        const url = await assertSucceeds(getDownloadURL(fileRef));
        attachments.push({ name: file.name, type: file.type, size: data.length, url });
        await assertFails(uploadBytes(ref(resident.storage(), path), data, { contentType: file.type }));
    }
    const meetingRef = doc(admin.firestore(), 'polls/meeting-with-files');
    await assertSucceeds(setDoc(meetingRef, { isMeeting: true, title: 'Збори з вкладеннями', attachments }));
    const saved = (await assertSucceeds(getDoc(meetingRef))).data();
    assert.deepEqual(saved.attachments, attachments);
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
