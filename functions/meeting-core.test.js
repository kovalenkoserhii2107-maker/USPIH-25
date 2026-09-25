'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { computeQuorum, meetingSummary } = require('./meeting-core');

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
