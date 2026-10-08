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
    assert.match(meetingSummary({ options: ['Кошторис'] }, votes, shared), /за 1, проти 1, утримався 0/);
});
