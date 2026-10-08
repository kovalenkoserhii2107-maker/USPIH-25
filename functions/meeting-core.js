'use strict';

const MEETING_ANSWERS = ['За', 'Проти', 'Утримався'];
const QUORUM_PCT = 50;
const DECISION_PCT = 50;

function parseArea(value) {
    const number = Number.parseFloat(String(value ?? '').replace(',', '.'));
    return Number.isFinite(number) ? number : 0;
}

function normName(n) {
    return String(n || '').trim().toLowerCase().replace(/\s+/g, ' ');
}
function answerFor(vote, index) {
    return vote?.answers?.[index] ?? vote?.answers?.[String(index)] ?? null;
}
const isPaperVote = vote => vote?.source === 'paper';

/** Стабільний ключ співвласника з довідника; старі дані без ID теж читаються. */
function ownerIdentity(owner, index = 0) {
    return String(owner?.id || `legacy-${normName(owner?.name)}-${index}`);
}

/** Окремий документ паперового голосу, без зміни старого голосу квартири. */
function ownerVoteId(apt, ownerId) {
    return `owner:${encodeURIComponent(String(apt))}:${encodeURIComponent(String(ownerId))}`;
}

function ownedArea(apartment, owner, count) {
    const area = parseArea(apartment.area);
    const fraction = String(owner?.shareFrac || '').match(/^\s*(\d+(?:[.,]\d+)?)\s*\/\s*(\d+(?:[.,]\d+)?)\s*$/);
    if (fraction && parseArea(fraction[2]) > 0) {
        return area * Math.min(1, parseArea(fraction[1]) / parseArea(fraction[2]));
    }
    if (String(owner?.sharePerc ?? '').trim()) {
        return area * Math.max(0, Math.min(100, parseArea(owner.sharePerc))) / 100;
    }
    return area / count;
}

/** По одному рядку на власника. Індивідуальна відповідь має пріоритет на своє питання. */
function ownerVotingRows(votes = [], apartments = []) {
    const legacy = new Map(), individual = new Map();
    for (const vote of votes) {
        if (vote.ownerId) individual.set(ownerVoteId(vote.apt, vote.ownerId), vote);
        else legacy.set(String(vote.apt), vote);
    }
    return apartments.flatMap(apartment => {
        const owners = apartment.owners?.length ? apartment.owners : [{ name: '' }];
        return owners.map((owner, index) => {
            const ownerId = ownerIdentity(owner, index);
            const inherited = legacy.get(String(apartment.apt));
            const direct = individual.get(ownerVoteId(apartment.apt, ownerId));
            const vote = direct ? {
                ...inherited, ...direct,
                answers: { ...(inherited?.answers || {}), ...(direct.answers || {}) }
            } : (inherited || null);
            return {
                apt: String(apartment.apt), apartment, owner, ownerId,
                voteId: ownerVoteId(apartment.apt, ownerId), vote,
                area: ownedArea(apartment, owner, owners.length)
            };
        });
    });
}

/** Явка за власниками та належною їм площею, зі збереженням старих голосів. */
function computeQuorum(votes = [], apartments = []) {
    const allOwners = new Set(), votedOwners = new Set(), votedApts = new Set();
    let votedArea = 0;
    for (const row of ownerVotingRows(votes, apartments)) {
        const key = normName(row.owner.name);
        if (key) allOwners.add(key);
        if (!row.vote) continue;
        votedApts.add(row.apt);
        votedArea += row.area;
        if (key) votedOwners.add(key);
    }
    const totalArea = apartments.reduce((sum, a) => sum + parseArea(a.area), 0);
    const ownersPct = allOwners.size ? votedOwners.size / allOwners.size * 100 : 0;
    const round = n => Math.round(n * 10) / 10;
    return {
        totalOwners: allOwners.size, votedOwners: votedOwners.size,
        ownersPct: round(ownersPct), totalArea: round(totalArea), votedArea: round(votedArea),
        areaPct: round(totalArea ? votedArea / totalArea * 100 : 0),
        votedApts: votedApts.size, totalApts: apartments.length,
        hasQuorum: ownersPct >= QUORUM_PCT
    };
}

/** Розбивка явки за особистим і письмовим голосуванням. */
function quorumBreakdown(votes, apartments) {
    const effective = ownerVotingRows(votes, apartments).filter(r => r.vote).map(r => ({
        ...r.vote, apt: r.apt, ownerId: r.ownerId
    }));
    const online = effective.filter(v => !isPaperVote(v));
    const paper = effective.filter(isPaperVote);
    return {
        total: computeQuorum(votes, apartments),
        online: computeQuorum(online, apartments), paper: computeQuorum(paper, apartments),
        onlineCount: online.length, paperCount: paper.length
    };
}

/** Підсумок питання: кожен співвласник має свою відповідь і свою частку площі. */
function questionTally(votes = [], apartments = [], index, amongPresent = false) {
    const totals = computeQuorum(votes, apartments);
    const baseOwners = amongPresent ? totals.votedOwners : totals.totalOwners;
    const baseArea = amongPresent ? totals.votedArea : totals.totalArea;
    const rows = Object.fromEntries(MEETING_ANSWERS.map(answer => [answer, {
        apts: new Set(), area: 0, owners: new Set()
    }]));
    for (const ownerRow of ownerVotingRows(votes, apartments)) {
        const row = rows[answerFor(ownerRow.vote, index)];
        if (!row) continue;
        row.apts.add(ownerRow.apt);
        row.area += ownerRow.area;
        const key = normName(ownerRow.owner.name);
        if (key) row.owners.add(key);
    }
    const round = n => Math.round(n * 100) / 100;
    for (const row of Object.values(rows)) {
        row.apts = row.apts.size;
        row.count = row.apts;
        row.area = round(row.area);
        row.ownersCount = row.owners.size;
        row.ownersPct = baseOwners ? round(row.ownersCount / baseOwners * 100) : 0;
        row.areaPct = baseArea ? round(row.area / baseArea * 100) : 0;
        row.pct = row.areaPct;
        delete row.owners;
    }
    return {
        rows, baseOwners, baseArea: round(baseArea), totalArea: round(totals.totalArea),
        amongPresent, accepted: rows[MEETING_ANSWERS[0]].ownersPct > DECISION_PCT
    };
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
    ownerIdentity,
    ownerVoteId,
    ownerVotingRows,
    computeQuorum,
    questionTally,
    meetingSummary
};
