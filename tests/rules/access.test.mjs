import test, { after, afterEach, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { initializeTestEnvironment, assertFails, assertSucceeds } from '@firebase/rules-unit-testing';
import { doc, getDoc, setDoc, updateDoc, serverTimestamp } from 'firebase/firestore';
import { ref, uploadString, uploadBytes, getDownloadURL } from 'firebase/storage';
import { CHAIR_QUESTION, meetingStart, surveyorAssignments, surveyorFor } from '../../js/meeting.js';

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
