import test from 'node:test';
import assert from 'node:assert/strict';
import { computeQuorum, questionTally, surveyorAssignments, surveyorFor } from '../../js/meeting.js';
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

test('голову обирає більшість присутніх', () => {
    const votes = [
        { apt: '1', answers: { 0: 'За' } },
        { apt: '2', answers: { 0: 'За' } }
    ];
    assert.equal(questionTally(votes, apartments, 0, true).accepted, true);
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
