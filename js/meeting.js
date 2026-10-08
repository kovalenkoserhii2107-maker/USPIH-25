// ============================================================
// Загальні збори співвласників: спільні розрахунки.
//
// Тут немає ні DOM, ні звернень до бази — лише математика, яку
// однаково читають три місця: панель правління (картка зборів),
// вікно внесення паперових голосів і генератор протоколу. Якщо
// відсоток кворуму рахувати в кожному з них окремо, протокол
// рано чи пізно розійдеться з тим, що правління бачило на екрані.
//
// МОДЕЛЬ ЗБОРІВ
// Збори — це те саме опитування (колекція polls), але з isMeeting:
// true. Порядок денний лежить у полі options: для звичайного
// опитування це варіанти відповіді, для зборів — питання. Відповіді
// ж у зборах завжди одні й ті самі три, тому окремого поля не треба.
//
// Старий та електронний голос квартири — polls/{id}/votes/{apt}.
// Новий паперовий голос — окремий документ із полями apt та ownerId.
// В обох answers: { "1": "За", "2": "Проти" }, де ключ — індекс питання,
// а не текст: виправлена кома не знецінює вже подані голоси.
// Питання 1 голосують з голосу, його підсумки лежать у poll.chairVote.
// ============================================================

/** Відповіді на питання порядку денного. Порядок важливий: у такому вони і в PDF. */
export const MEETING_ANSWERS = ['За', 'Проти', 'Утримався'];

/**
 * Перше питання будь-яких зборів. Стаття 10 Закону «Про особливості
 * здійснення права власності у багатоквартирному будинку» вимагає
 * обрати головуючого й секретаря — без них немає кому підписати
 * протокол. Тому питання додається саме кодом, а не руками.
 */
export const CHAIR_QUESTION = 'Про обрання голови та секретаря зборів';

/** Скільки власників має взяти участь, щоб збори відбулися. */
export const QUORUM_PCT = 50;

/**
 * Скільки голосів має бути «за», щоб рішення вважалося прийнятим.
 *
 * За п. 3.2.11 Статуту ОСББ «Успіх-25» кожний співвласник має один
 * голос незалежно від кількості та площі своїх приміщень, а рішення
 * ухвалюється більшістю голосів ВІД ЗАГАЛЬНОЇ кількості співвласників,
 * а не від тих, хто взяв участь. Тому рахуємо співвласників, а площу
 * показуємо поруч — вона теж має бути в протоколі.
 *
 * Виняток — обрання голови та секретаря: за п. 3.2.9 Статуту їх
 * обирає більшість ПРИСУТНІХ, інакше збори неможливо було б навіть
 * розпочати. Саме тому питання про голову завжди стоїть першим.
 */
export const DECISION_PCT = 50;

/** Реквізити для шапки документів. Підміняються з osbb_settings/finance. */
export const OSBB_DEFAULTS = {
    name: 'ОСББ «Успіх-25»',
    address: 'вул. Інглезі, 3/3, м. Одеса',
    edrpou: '40562894'
};

export const isMeeting = (poll) => poll?.isMeeting === true;

/** Порядок денний. Для звичайного опитування — просто його варіанти. */
export const agendaOf = (poll) => poll?.options || [];

/** Перше питання вирішують з голосу; номери решти питань не змінюємо. */
export const writtenQuestions = poll => agendaOf(poll)
    .map((question, index) => ({ question, index })).filter(({ index }) => !isChairQuestion(index));

/** Голос подано на папері (обхід квартир), а не в застосунку. */
export const isPaperVote = (vote) => vote?.source === 'paper';

/**
 * Відповідь квартири на конкретне питання.
 *
 * Ключі мапи з Firestore приходять рядками, а індекс у циклі — число,
 * тож пробуємо обидва написання, щоб не втратити голос на дрібниці.
 */
export function answerFor(vote, index) {
    const a = vote?.answers;
    if (!a) return null;
    return a[index] ?? a[String(index)] ?? null;
}

export function parseArea(v) {
    const n = parseFloat(String(v ?? '').replace(',', '.'));
    return isNaN(n) ? 0 : n;
}

/** Прізвище з ініціалами для звірки — так само, як у довіднику. */
function normName(n) {
    return String(n || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

/** Стабільний ключ співвласника з довідника; старі дані без ID теж читаються. */
export function ownerIdentity(owner, index = 0) {
    return String(owner?.id || `legacy-${normName(owner?.name)}-${index}`);
}

/** Окремий документ паперового голосу, без зміни старого голосу квартири. */
export function ownerVoteId(apt, ownerId) {
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
export function ownerVotingRows(votes = [], apartments = []) {
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
export function computeQuorum(votes = [], apartments = []) {
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

/** Розбивка участі за електронним і письмовим голосуванням. */
export function quorumBreakdown(votes, apartments) {
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
export function questionTally(votes = [], apartments = [], index, amongPresent = false) {
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

/** Питання про обрання голови та секретаря вирішують присутні. */
export const isChairQuestion = (index) => index === 0;

/** Перевірка підсумків очного обрання голови та секретаря. */
export function chairVoteError(vote) {
    if (!vote || !['present', 'yes', 'no', 'abstain'].every(key => Number.isSafeInteger(vote[key]) && vote[key] >= 0)) {
        return 'Питання 1: вкажіть цілу невід’ємну кількість присутніх і голосів';
    }
    if (!vote.present) return 'Питання 1: кількість присутніх має бути більшою за нуль';
    if (vote.yes + vote.no + vote.abstain > vote.present) {
        return 'Питання 1: голосів не може бути більше, ніж присутніх';
    }
    return null;
}

/** Очне голосування рахується лише за людьми, без площ і квартир. */
export function chairVoteTally(vote) {
    if (chairVoteError(vote)) return null;
    const counts = [vote.yes, vote.no, vote.abstain];
    const rows = Object.fromEntries(MEETING_ANSWERS.map((answer, index) => [answer, {
        count: counts[index], ownersCount: counts[index],
        ownersPct: Math.round(counts[index] / vote.present * 10000) / 100
    }]));
    return {
        rows, baseOwners: vote.present, amongPresent: true,
        votedOwners: counts.reduce((sum, count) => sum + count, 0),
        accepted: vote.yes > vote.present / 2
    };
}

/** Однаковий підсумок для картки зборів, PDF і розсилки. */
export function meetingQuestionTally(poll, votes, apartments, index) {
    return isChairQuestion(index) ? chairVoteTally(poll.chairVote) : questionTally(votes, apartments, index);
}

/** Той самий підсумок для картки, оголошення та протоколу. */
export function meetingSummary(poll, votes, apartments) {
    return agendaOf(poll).map((question, index) => {
        const tally = meetingQuestionTally(poll, votes, apartments, index);
        if (!tally) return `${index + 1}. ${question}\n   Результати голосування на зборах ще не внесено`;
        const counts = MEETING_ANSWERS
            .map(answer => `${answer.toLowerCase()} ${tally.rows[answer].ownersCount}`)
            .join(', ');
        return `${index + 1}. ${question}\n   ${tally.accepted ? 'ПРИЙНЯТО' : 'НЕ ПРИЙНЯТО'} `
            + `(голосів співвласників: ${counts})`
            + (isChairQuestion(index) ? `; присутніх ${tally.baseOwners}, проголосували ${tally.votedOwners}` : '');
    }).join('\n');
}

/** «9 472,20» — числа в документі пишуться з комою й нерозривним пробілом. */
export function fmtNum(n, decimals = 2) {
    const value = Number(n) || 0;
    const fixed = value.toFixed(decimals);
    const [int, frac] = fixed.split('.');
    const spaced = int.replace(/\B(?=(\d{3})+(?!\d))/g, '\u00A0');
    return frac ? `${spaced},${frac}` : spaced;
}

/** Відсоток без зайвих нулів: «59,65», «100», «0». */
export function fmtPct(n) {
    const value = Math.round((Number(n) || 0) * 100) / 100;
    return String(value).replace('.', ',');
}

/** Українське відмінювання після числа: 1 особа, 2 особи, 5 осіб. */
export function plural(n, one, few, many) {
    const m10 = n % 10, m100 = n % 100;
    if (m10 === 1 && m100 !== 11) return one;
    if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
    return many;
}

/** «20 вересня 2026 р.» — так дата виглядає в юридичному документі. */
export function formatMeetingDate(value) {
    if (!value) return '';
    const at = value instanceof Date ? value : new Date(`${value}T00:00:00`);
    if (isNaN(at.getTime())) return String(value);
    // Українська локаль сама дописує «р.» — свій додавати лише тоді,
    // коли браузер цього не зробив, інакше вийде «2026 р. р.».
    const label = at.toLocaleDateString('uk-UA', { day: 'numeric', month: 'long', year: 'numeric' });
    return label.endsWith('р.') ? label : `${label} р.`;
}

/** Рядок «20 вересня 2026 р., 18:00–20:00, внутрішній двір будинку». */
export function meetingWhen(poll) {
    const parts = [formatMeetingDate(poll.meetingDate)];
    if (poll.timeStart) parts.push(poll.timeEnd ? `${poll.timeStart}–${poll.timeEnd}` : poll.timeStart);
    if (poll.location) parts.push(poll.location);
    return parts.filter(Boolean).join(', ');
}

const MONTHS_GEN = ['січня', 'лютого', 'березня', 'квітня', 'травня', 'червня',
    'липня', 'серпня', 'вересня', 'жовтня', 'листопада', 'грудня'];

/**
 * Мить, коли відкривається голосування, — початок зборів.
 *
 * До цього часу порядок денний уже опублікований: мешканець має
 * прочитати, що виноситься на розгляд, і прийти на збори з готовою
 * думкою. Але голос до відкриття зборів — це голос до обговорення,
 * тому кнопку показуємо лише з початку, а сервер підстраховує
 * перевіркою votingOpensAt у правилах.
 */
export function meetingStart(poll) {
    if (!poll?.meetingDate) return null;
    const at = new Date(`${poll.meetingDate}T${poll.timeStart || '00:00'}:00`);
    return isNaN(at.getTime()) ? null : at;
}

/** Голосування ще не відкрилося? */
export function beforeStart(poll) {
    const at = poll?.votingOpensAt?.toDate ? poll.votingOpensAt.toDate() : meetingStart(poll);
    return at ? Date.now() < at.getTime() : false;
}

/** «20 вересня 2026 р. о 18:00» — коли відкриється голосування. */
export function startLabel(poll) {
    const at = poll?.votingOpensAt?.toDate ? poll.votingOpensAt.toDate() : meetingStart(poll);
    if (!at) return '';
    const pad = (n) => String(n).padStart(2, '0');
    return `${formatMeetingDate(at)} о ${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

/** Дані відповідальних для Firestore: порожній ключ поля заборонений. */
export function surveyorAssignments(entries) {
    const map = {};
    for (const { entrance, name } of entries) {
        const value = String(name || '').trim();
        if (value) map[entrance || 'all'] = value;
    }
    return map;
}

/** Хто проводить опитування в цій парадній. Ключ 'all' — «для всіх». */
export function surveyorFor(poll, entrance = '') {
    const map = poll?.surveyors || {};
    return String(map[entrance] || map.all || map[''] || '').trim();
}

/** «22» серпня 2026 р. — саме так дата стоїть у шапці протоколу. */
export function formatProtocolDate(value) {
    if (!value) return '«___» _____________ 20___ р.';
    const at = value instanceof Date ? value : new Date(`${value}T00:00:00`);
    if (isNaN(at.getTime())) return String(value);
    const day = String(at.getDate()).padStart(2, '0');
    return `«${day}» ${MONTHS_GEN[at.getMonth()]} ${at.getFullYear()} р.`;
}

/** «22.08.2026» — для листка опитування. */
export function formatShortDate(value) {
    if (!value) return '';
    const at = value instanceof Date ? value : new Date(`${value}T00:00:00`);
    if (isNaN(at.getTime())) return String(value);
    const pad = (n) => String(n).padStart(2, '0');
    return `${pad(at.getDate())}.${pad(at.getMonth() + 1)}.${at.getFullYear()}`;
}

/** Частка співвласника: у документах її пишуть дробом («1/3»). */
export function ownerShare(owner) {
    const frac = String(owner?.shareFrac || '').trim();
    if (frac) return frac;
    const perc = String(owner?.sharePerc || '').trim();
    return perc ? `${perc}%` : '';
}

/**
 * Парадні будинку в природному порядку.
 *
 * Листки письмового опитування роздають відповідальним особам по
 * парадних, тому і друк, і внесення голосів ідуть тим самим розрізом.
 * Квартири без вказаної парадної збираються в окрему групу — інакше
 * вони просто зникли б з обходу.
 */
export function entrancesOf(apartments) {
    const set = new Set();
    (apartments || []).forEach(a => set.add(String(a.entrance || '').trim()));
    return [...set].sort((a, b) => {
        if (!a) return 1;                       // «без парадної» — завжди останні
        if (!b) return -1;
        return (parseInt(a, 10) || 0) - (parseInt(b, 10) || 0) || a.localeCompare(b, 'uk');
    });
}

/** Квартири однієї парадної. Порожня парадна означає «усі». */
export function aptsOfEntrance(apartments, entrance) {
    if (!entrance) return apartments || [];
    return (apartments || []).filter(a => String(a.entrance || '').trim() === String(entrance));
}

/** Список власників квартири одним рядком — для таблиць і списків. */
export function ownersLine(apt) {
    const names = (apt?.owners || []).map(o => o.name).filter(Boolean);
    return names.length ? names.join(', ') : 'власник не вказаний';
}
