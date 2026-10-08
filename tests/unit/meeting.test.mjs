import test from 'node:test';
import assert from 'node:assert/strict';
import { computeQuorum, questionTally, surveyorAssignments, surveyorFor, ownerVotingRows, ownerVoteId,
    chairVoteError, chairVoteTally, meetingQuestionTally, writtenQuestions } from '../../js/meeting.js';
import serverCore from '../../functions/meeting-core.js';
import { initializeApp, deleteApp } from 'firebase/app';
import { getFirestore, doc, writeBatch, terminate } from 'firebase/firestore';

const apartments = [
    { apt: '1', area: '40,5', owners: [{ name: 'Іваненко І. І.' }] },
    { apt: '2', area: 60, owners: [{ name: 'Петренко П. П.' }, { name: 'Сидоренко С. С.' }] },
    { apt: '3', area: 50, owners: [{ name: 'Іваненко І. І.' }] }
];

test('кворум не подвоює власника з кількома квартирами', () => {
    const result = computeQuorum([{ apt: '1' }, { apt: '2' }], apartments);
    assert.equal(result.totalOwners, 3);
    assert.equal(result.votedOwners, 3);
    assert.equal(result.votedApts, 2);
    assert.equal(result.hasQuorum, true);
    assert.equal(result.votedArea, 100.5);
});

test('звичайне рішення рахується від усіх співвласників', () => {
    const votes = [
        { apt: '1', answers: { 1: 'За' } },
        { apt: '2', answers: { 1: 'Проти' } }
    ];
    const tally = questionTally(votes, apartments, 1, false);
    assert.equal(tally.rows['За'].ownersCount, 1);
    assert.equal(tally.rows['Проти'].ownersCount, 2);
    assert.equal(tally.accepted, false);
});

test('голову обирає більшість присутніх, незалежно від пізніших паперових голосів', () => {
    const votes = [
        { apt: '1', answers: { 0: 'За' } },
        { apt: '2', answers: { 0: 'За' } }
    ];
    const poll = { chairVote: { present: 15, yes: 8, no: 4, abstain: 2 } };
    const tally = meetingQuestionTally(poll, votes, apartments, 0);
    assert.equal(tally.accepted, true);
    assert.equal(tally.baseOwners, 15);
    assert.equal(tally.votedOwners, 14);
    assert.equal(tally.rows['За'].ownersCount, 8);
    assert.equal(tally.rows['За'].ownersPct, 53.33);
    assert.deepEqual(serverCore.meetingQuestionTally(poll, votes, apartments, 0), tally);
    assert.deepEqual(meetingQuestionTally(poll, votes, apartments, 1), questionTally(votes, apartments, 1));
});

test('половини присутніх недостатньо, відсоток не рахується від лише поданих голосів', () => {
    assert.equal(chairVoteTally({ present: 10, yes: 5, no: 0, abstain: 0 }).accepted, false);
    assert.equal(chairVoteTally({ present: 15, yes: 7, no: 0, abstain: 0 }).accepted, false);
    assert.equal(chairVoteTally({ present: 15, yes: 8, no: 0, abstain: 0 }).accepted, true);
});

test('очні підсумки потребують цілих чисел і не допускають більше голосів, ніж людей', () => {
    for (const vote of [undefined, {},
        { present: 0, yes: 0, no: 0, abstain: 0 },
        { present: 15, yes: 14, no: 2, abstain: 0 },
        { present: 15, yes: -1, no: 0, abstain: 0 },
        { present: 15, yes: 1.5, no: 0, abstain: 0 },
        { present: '15', yes: 15, no: 0, abstain: 0 }]) {
        assert(chairVoteError(vote));
        assert.equal(chairVoteTally(vote), null);
        assert.equal(serverCore.chairVoteError(vote), chairVoteError(vote));
    }
    assert.equal(chairVoteError({ present: 15, yes: 15, no: 0, abstain: 0 }), null);
    assert.equal(meetingQuestionTally({}, [{ apt: '1', answers: { 0: 'За' } }], apartments, 0), null);
});

test('письмове голосування починається з питання 2 без зміни ключів відповідей', () => {
    assert.deepEqual(writtenQuestions({ options: ['Голова', 'Кошторис', 'Ремонт'] }), [
        { question: 'Кошторис', index: 1 }, { question: 'Ремонт', index: 2 }
    ]);
});

test('одна відповідальна особа зберігається з допустимим для Firestore ключем', async () => {
    const name = 'Іваненко І. І.';
    const surveyors = surveyorAssignments([{ entrance: '', name: ` ${name} ` }]);
    assert.deepEqual(surveyors, { all: name });
    assert.equal(surveyorFor({ surveyors }), name);
    assert.equal(surveyorFor({ surveyors }, '2'), name);

    const app = initializeApp({ projectId: 'demo-meeting-payload-check' }, 'meeting-payload-check');
    const db = getFirestore(app);
    try {
        const ref = doc(db, 'polls/check');
        assert.throws(() => writeBatch(db).set(ref, { surveyors: { '': name } }), /Document fields must not be empty/);
        // Перевіряємо серіалізацію, не надсилаючи дані в жодну базу.
        assert.doesNotThrow(() => writeBatch(db).set(ref, { surveyors }));
    } finally {
        await terminate(db);
        await deleteApp(app);
    }
});

test('відповідальні по парадних мають пріоритет над спільною особою', () => {
    const surveyors = surveyorAssignments([
        { entrance: '', name: 'Спільна особа' },
        { entrance: '1', name: 'Особа першої парадної' },
        { entrance: '2', name: '   ' }
    ]);
    assert.deepEqual(surveyors, { all: 'Спільна особа', 1: 'Особа першої парадної' });
    assert.equal(surveyorFor({ surveyors }, '1'), 'Особа першої парадної');
    assert.equal(surveyorFor({ surveyors }, '2'), 'Спільна особа');
    assert.deepEqual(surveyorAssignments([{ entrance: '', name: '' }]), {});
});

test('читання старого формату спільної відповідальної особи лишається доступним', () => {
    assert.equal(surveyorFor({ surveyors: { '': 'Спільна особа' } }, '1'), 'Спільна особа');
    assert.equal(surveyorFor({}, '1'), '');
});

const sharedApartment = [{ apt: '298', area: 64, owners: [
    { id: 'first', name: 'Перший Співвласник', shareFrac: '1/2' },
    { id: 'second', name: 'Другий Співвласник', shareFrac: '1/2' }
] }];

test('підпис одного власника не зараховується іншому власнику квартири', () => {
    const votes = [{ apt: '298', ownerId: 'first', source: 'paper', answers: { 1: 'За' } }];
    const quorum = computeQuorum(votes, sharedApartment);
    assert.equal(quorum.votedOwners, 1);
    assert.equal(quorum.votedArea, 32);
    const rows = ownerVotingRows(votes, sharedApartment);
    assert.equal(rows[0].vote.answers[1], 'За');
    assert.equal(rows[1].vote, null);
    assert.equal(questionTally(votes, sharedApartment, 1).rows['За'].ownersCount, 1);
});

test('різні відповіді співвласників зберігаються та рахуються незалежно', () => {
    const votes = [
        { apt: '298', ownerId: 'first', source: 'paper', answers: { 1: 'За' } },
        { apt: '298', ownerId: 'second', source: 'paper', answers: { 1: 'Проти' } }
    ];
    const tally = questionTally(votes, sharedApartment, 1);
    assert.equal(tally.rows['За'].ownersCount, 1);
    assert.equal(tally.rows['Проти'].ownersCount, 1);
    assert.equal(tally.rows['За'].area, 32);
    assert.equal(tally.rows['Проти'].area, 32);
    assert.equal(computeQuorum(votes, sharedApartment).votedApts, 1);
    assert.equal(tally.accepted, false);
    assert.deepEqual(serverCore.questionTally(votes, sharedApartment, 1), tally);
    assert.deepEqual(serverCore.computeQuorum(votes, sharedApartment), computeQuorum(votes, sharedApartment));
});

test('старі відповіді квартири читаються разом із новими без подвійного підрахунку', () => {
    const votes = [
        { apt: '298', answers: { 0: 'За', 1: 'За' } },
        { apt: '298', ownerId: 'first', source: 'paper', answers: { 1: 'Проти' } }
    ];
    assert.equal(questionTally(votes, sharedApartment, 0).rows['За'].ownersCount, 2);
    const tally = questionTally(votes, sharedApartment, 1);
    assert.equal(tally.rows['За'].ownersCount, 1);
    assert.equal(tally.rows['Проти'].ownersCount, 1);
    assert.equal(computeQuorum(votes, sharedApartment).votedArea, 64);
    assert.deepEqual(serverCore.questionTally(votes, sharedApartment, 1), tally);
    assert.notEqual(ownerVoteId('1:2', '3'), ownerVoteId('1', '2:3'));
});
