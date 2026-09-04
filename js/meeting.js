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
export const CHAIR_QUESTION = 'Обрання голови та секретаря зборів';

/** Скільки власників має взяти участь, щоб збори відбулися. */
export const QUORUM_PCT = 50;

/**
 * Скільки площі має бути «за», щоб рішення вважалося прийнятим.
 *
 * Закон рахує не від тих, хто прийшов, а від усього будинку: рішення
 * приймається, якщо за нього проголосували власники, яким належить
 * понад половину загальної площі. Окремі питання (наприклад,
 * про надбудову) потребують трьох чвертей — це правління перевіряє
 * окремо, автоматично такі питання не розпізнати.
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
 * Підсумок одного питання: скільки квартир, скільки площі й відсоток
 * від усього будинку за кожною відповіддю.
 *
 * Відсоток рахуємо від загальної площі будинку, а не від тих, хто
 * голосував: саме так його рахує закон, і саме з ним порівнюється
 * поріг прийняття рішення.
 */
export function questionTally(votes, apartments, index) {
    const areaByApt = new Map((apartments || []).map(a => [String(a.apt), parseArea(a.area)]));
    const totalArea = [...areaByApt.values()].reduce((s, n) => s + n, 0);

    const rows = {};
    MEETING_ANSWERS.forEach(ans => { rows[ans] = { count: 0, area: 0, pct: 0 }; });

    (votes || []).forEach(v => {
        const ans = answerFor(v, index);
        if (!rows[ans]) return;               // відповідь не з нашого списку — не рахуємо
        rows[ans].count++;
        rows[ans].area += areaByApt.get(String(v.apt)) || 0;
    });

    MEETING_ANSWERS.forEach(ans => {
        rows[ans].area = Math.round(rows[ans].area * 10) / 10;
        rows[ans].pct = totalArea ? Math.round((rows[ans].area / totalArea) * 1000) / 10 : 0;
    });

    const accepted = rows[MEETING_ANSWERS[0]].pct > DECISION_PCT;
    return { rows, totalArea: Math.round(totalArea * 10) / 10, accepted };
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

/** Список власників квартири одним рядком — для таблиць і списків. */
export function ownersLine(apt) {
    const names = (apt?.owners || []).map(o => o.name).filter(Boolean);
    return names.length ? names.join(', ') : 'власник не вказаний';
}
