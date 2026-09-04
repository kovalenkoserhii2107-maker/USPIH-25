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
// Голос квартири на зборах — документ polls/{id}/votes/{apt} з мапою
// answers: { "0": "За", "1": "Проти" }, де ключ — номер питання в
// порядку денному. Ключ саме номер, а не текст питання: інакше
// виправлена в питанні кома знецінила б уже подані голоси.
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

/**
 * Явка: за власниками і за площею.
 *
 * Голос лежить на КВАРТИРІ, а не на власнику, тож «один власник —
 * один голос» рахуємо так: проголосувала квартира — голос зараховано
 * всім її співвласникам. Власника, що має кілька квартир, ототожнюємо
 * за прізвищем: іншого спільного ідентифікатора в базі немає.
 */
export function computeQuorum(votes, apartments) {
    const votedApts = new Set((votes || []).map(v => String(v.apt)));
    const allOwners = new Set();
    const votedOwners = new Set();
    let totalArea = 0, votedArea = 0;

    (apartments || []).forEach(a => {
        const area = parseArea(a.area);
        totalArea += area;
        const voted = votedApts.has(String(a.apt));
        if (voted) votedArea += area;

        (a.owners || []).forEach(o => {
            const key = normName(o.name);
            if (!key) return;                 // безіменний запис не рахуємо
            allOwners.add(key);
            if (voted) votedOwners.add(key);
        });
    });

    const ownersPct = allOwners.size ? (votedOwners.size / allOwners.size) * 100 : 0;
    const areaPct = totalArea ? (votedArea / totalArea) * 100 : 0;
    const round = (n) => Math.round(n * 10) / 10;

    return {
        totalOwners: allOwners.size,
        votedOwners: votedOwners.size,
        ownersPct: round(ownersPct),
        totalArea: round(totalArea),
        votedArea: round(votedArea),
        areaPct: round(areaPct),
        votedApts: votedApts.size,
        totalApts: (apartments || []).length,
        hasQuorum: ownersPct >= QUORUM_PCT
    };
}

/**
 * Явка з розбивкою на форму участі.
 *
 * Протокол має розрізняти тих, хто голосував особисто (в застосунку
 * під час зборів), і тих, кого опитали письмово після них: закон
 * дозволяє добирати голоси письмовим опитуванням протягом 15 днів,
 * і в протоколі ці дві групи стоять окремими рядками.
 */
export function quorumBreakdown(votes, apartments) {
    const online = (votes || []).filter(v => !isPaperVote(v));
    const paper = (votes || []).filter(isPaperVote);
    return {
        total: computeQuorum(votes, apartments),
        online: computeQuorum(online, apartments),
        paper: computeQuorum(paper, apartments),
        onlineCount: online.length,
        paperCount: paper.length
    };
}

/**
 * Підсумок одного питання: скільки співвласників, квартир і площі за
 * кожною відповіддю та два відсотки — від кількості голосів і від площі.
 *
 * Співвласників рахуємо так само, як у кворумі: проголосувала квартира
 * — голос зараховано всім, хто в ній записаний, а однофамільця з двох
 * квартир не рахуємо двічі.
 *
 * @param {boolean} amongPresent база відсотка: присутні (питання про
 *        голову зборів) чи весь будинок (решта питань).
 */
export function questionTally(votes, apartments, index, amongPresent = false) {
    const byApt = new Map();
    (apartments || []).forEach(a => byApt.set(String(a.apt), a));

    const totals = computeQuorum(votes, apartments);
    const baseOwners = amongPresent ? totals.votedOwners : totals.totalOwners;
    const baseArea = amongPresent ? totals.votedArea : totals.totalArea;

    const rows = {};
    MEETING_ANSWERS.forEach(ans => {
        rows[ans] = { apts: 0, area: 0, owners: new Set(), ownersPct: 0, areaPct: 0, count: 0 };
    });

    (votes || []).forEach(v => {
        const ans = answerFor(v, index);
        const row = rows[ans];
        if (!row) return;                     // відповідь не з нашого списку
        const apt = byApt.get(String(v.apt));
        row.apts++;
        row.count++;                          // сумісність: раніше поле звалося count
        row.area += parseArea(apt?.area);
        (apt?.owners || []).forEach(o => {
            const key = normName(o.name);
            if (key) row.owners.add(key);
        });
    });

    const round = (n) => Math.round(n * 100) / 100;
    MEETING_ANSWERS.forEach(ans => {
        const r = rows[ans];
        r.area = round(r.area);
        r.ownersCount = r.owners.size;
        r.ownersPct = baseOwners ? round((r.owners.size / baseOwners) * 100) : 0;
        r.areaPct = baseArea ? round((r.area / baseArea) * 100) : 0;
        r.pct = r.areaPct;                    // сумісність зі старою розміткою
        delete r.owners;
    });

    const yes = rows[MEETING_ANSWERS[0]];
    return {
        rows,
        baseOwners,
        baseArea: round(baseArea),
        totalArea: round(totals.totalArea),
        amongPresent,
        // Рішення приймається голосами співвласників, не метрами.
        accepted: yes.ownersPct > DECISION_PCT
    };
}

/** Питання про обрання голови та секретаря вирішують присутні. */
export const isChairQuestion = (index) => index === 0;

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

/** Хто проводить опитування в цій парадній. Ключ '' — «для всіх». */
export function surveyorFor(poll, entrance = '') {
    const map = poll?.surveyors || {};
    return String(map[entrance] || map[''] || '').trim();
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
