'use strict';

const MEETING_ANSWERS = ['За', 'Проти', 'Утримався'];
const QUORUM_PCT = 50;
const DECISION_PCT = 50;

function parseArea(value) {
    const number = Number.parseFloat(String(value ?? '').replace(',', '.'));
    return Number.isFinite(number) ? number : 0;
}

function ownerKey(owner) {
    return String(owner?.name || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function answerFor(vote, index) {
    return vote?.answers?.[index] ?? vote?.answers?.[String(index)] ?? null;
}

function computeQuorum(votes = [], apartments = []) {
    const votedApts = new Set(votes.map(vote => String(vote.apt)));
    const allOwners = new Set();
    const votedOwners = new Set();
    let totalArea = 0;
    let votedArea = 0;

    apartments.forEach(apartment => {
        const area = parseArea(apartment.area);
        const voted = votedApts.has(String(apartment.apt));
        totalArea += area;
        if (voted) votedArea += area;
        (apartment.owners || []).forEach(owner => {
            const key = ownerKey(owner);
            if (!key) return;
            allOwners.add(key);
            if (voted) votedOwners.add(key);
        });
    });

    const round = value => Math.round(value * 10) / 10;
    const ownersPct = allOwners.size ? votedOwners.size / allOwners.size * 100 : 0;
    const areaPct = totalArea ? votedArea / totalArea * 100 : 0;
    return {
        totalOwners: allOwners.size,
        votedOwners: votedOwners.size,
        ownersPct: round(ownersPct),
        totalArea: round(totalArea),
        votedArea: round(votedArea),
        areaPct: round(areaPct),
        votedApts: votedApts.size,
        totalApts: apartments.length,
        hasQuorum: ownersPct >= QUORUM_PCT
    };
}

function questionTally(votes = [], apartments = [], index, amongPresent = false) {
    const byApt = new Map(apartments.map(apartment => [String(apartment.apt), apartment]));
    const totals = computeQuorum(votes, apartments);
    const baseOwners = amongPresent ? totals.votedOwners : totals.totalOwners;
    const baseArea = amongPresent ? totals.votedArea : totals.totalArea;
    const rows = Object.fromEntries(MEETING_ANSWERS.map(answer => [answer, {
        apts: 0, area: 0, owners: new Set(), ownersCount: 0, ownersPct: 0, areaPct: 0
    }]));

    votes.forEach(vote => {
        const row = rows[answerFor(vote, index)];
        if (!row) return;
        const apartment = byApt.get(String(vote.apt));
        row.apts += 1;
        row.area += parseArea(apartment?.area);
        (apartment?.owners || []).forEach(owner => {
            const key = ownerKey(owner);
            if (key) row.owners.add(key);
        });
    });

    Object.values(rows).forEach(row => {
        row.area = Math.round(row.area * 100) / 100;
        row.ownersCount = row.owners.size;
        row.ownersPct = baseOwners ? Math.round(row.ownersCount / baseOwners * 10000) / 100 : 0;
        row.areaPct = baseArea ? Math.round(row.area / baseArea * 10000) / 100 : 0;
        delete row.owners;
    });
    return { rows, accepted: rows['За'].ownersPct > DECISION_PCT };
}

function meetingSummary(poll, votes, apartments) {
    return (poll.options || []).map((question, index) => {
        const tally = questionTally(votes, apartments, index, index === 0);
        const counts = MEETING_ANSWERS
            .map(answer => `${answer.toLowerCase()} ${tally.rows[answer].ownersCount}`)
            .join(', ');
        return `${index + 1}. ${question}\n   ${tally.accepted ? 'ПРИЙНЯТО' : 'НЕ ПРИЙНЯТО'} `
            + `(голосів співвласників: ${counts})`;
    }).join('\n');
}

module.exports = {
    MEETING_ANSWERS,
    QUORUM_PCT,
    computeQuorum,
    questionTally,
    meetingSummary
};
