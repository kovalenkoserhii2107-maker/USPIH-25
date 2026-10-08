'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { computeQuorum, questionTally, meetingSummary } = require('./meeting-core');

const apartments = [
    { apt: '1', area: 40, owners: [{ name: 'А' }] },
    { apt: '2', area: 60, owners: [{ name: 'Б' }] }
];

test('серверний кворум відповідає моделі один власник — один голос', () => {
    assert.deepEqual(computeQuorum([{ apt: '1' }], apartments), {
        totalOwners: 2, votedOwners: 1, ownersPct: 50,
        totalArea: 100, votedArea: 40, areaPct: 40,
        votedApts: 1, totalApts: 2, hasQuorum: true
    });
});

test('підсумок зборів стабільний для повторної публікації', () => {
    const text = meetingSummary({ options: ['Голова', 'Кошторис'] }, [
        { apt: '1', answers: { 0: 'За', 1: 'За' } },
        { apt: '2', answers: { 0: 'За', 1: 'Проти' } }
    ], apartments);
    assert.match(text, /1\. Голова/);
    assert.match(text, /2\. Кошторис/);
});

test('серверні підсумки розділяють голоси двох власників однієї квартири', () => {
    const shared = [{ apt: '298', area: 64, owners: [
        { id: 'a', name: 'А', shareFrac: '1/2' }, { id: 'b', name: 'Б', shareFrac: '1/2' }
    ] }];
    const votes = [
        { apt: '298', ownerId: 'a', source: 'paper', answers: { 0: 'За' } },
        { apt: '298', ownerId: 'b', source: 'paper', answers: { 0: 'Проти' } }
    ];
    assert.equal(computeQuorum(votes.slice(0, 1), shared).votedOwners, 1);
    const result = questionTally(votes, shared, 0);
    assert.equal(result.rows['За'].ownersCount, 1);
    assert.equal(result.rows['Проти'].ownersCount, 1);
    assert.equal(result.rows['За'].area, 32);
    const laterVotes = votes.map(vote => ({ ...vote, answers: { 1: vote.answers[0] } }));
    assert.match(meetingSummary({ options: ['Голова', 'Кошторис'] }, laterVotes, shared), /за 1, проти 1, утримався 0/);
});

test('сервер бере голосування питання 1 з очних підсумків і не домішує відповіді квартир', () => {
    const summary = meetingSummary({
        options: ['Голова', 'Кошторис'], chairVote: { present: 15, yes: 15, no: 0, abstain: 0 }
    }, [{ apt: '1', answers: { 0: 'Проти', 1: 'За' } }], apartments);
    assert.match(summary, /1\. Голова\n   ПРИЙНЯТО \(голосів співвласників: за 15, проти 0, утримався 0\); присутніх 15, проголосували 15/);
    assert.match(summary, /2\. Кошторис\n   НЕ ПРИЙНЯТО \(голосів співвласників: за 1/);
    assert.match(meetingSummary({ options: ['Голова'] }, [], apartments), /ще не внесено/);
});
