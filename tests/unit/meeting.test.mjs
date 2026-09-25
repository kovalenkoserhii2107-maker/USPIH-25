import test from 'node:test';
import assert from 'node:assert/strict';
import { computeQuorum, questionTally } from '../../js/meeting.js';

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
