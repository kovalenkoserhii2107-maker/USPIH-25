// ============================================================
// Юридичні документи зборів: листки письмового опитування
// і протокол загальних зборів.
//
// Обидва документи повторюють ті, що ОСББ веде на папері, — аж до
// формулювань у шапках таблиць. Це не примха: листок підписують
// співвласники, а протокол подають у міську раду, і документ,
// який виглядає «майже так», доводиться переробляти вручну.
//
// PDF складає pdfmake. Бібліотеку тягнемо з CDN на вимогу, а не
// в <head>: разом зі шрифтами це майже два мегабайти, і платити
// їх трафіком кожному мешканцю заради кнопки, яку натискає раз
// на рік голова правління, немає за що. Перше натискання чекає
// на завантаження (секунду-дві), решта беруть уже завантажене.
//
// Шрифт — стандартний для pdfmake Roboto: у ньому є кирилиця з
// українськими «і», «ї», «є», «ґ». Вбудовані PDF-шрифти (Helvetica
// тощо) кирилиці не мають зовсім — там був би ряд знаків питання.
// ============================================================
import { db, storage } from './firebase.js';
import {
    collection, addDoc, doc, getDoc, updateDoc, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js";
import {
    ref as sRef, uploadBytes, getDownloadURL
} from "https://www.gstatic.com/firebasejs/10.8.1/firebase-storage.js";
import { buildRecipients } from './messages.js';
import {
    MEETING_ANSWERS, DECISION_PCT, QUORUM_PCT, OSBB_DEFAULTS,
    agendaOf, answerFor, isPaperVote, isChairQuestion, parseArea, ownerShare,
    quorumBreakdown, questionTally,
    formatMeetingDate, formatProtocolDate, formatShortDate,
    fmtNum, fmtPct, plural
} from './meeting.js';

// Два джерела, а не одне: колись cdnjs уже лежав, і в такий день
// правління не змогло б сформувати протокол зборів. Порядок має
// значення — jsDelivr береться, лише якщо перший не відповів.
const PDFMAKE_SOURCES = [
    'https://cdnjs.cloudflare.com/ajax/libs/pdfmake/0.2.7',
    'https://cdn.jsdelivr.net/npm/pdfmake@0.2.7/build'
];

const INK = '#000000';
const LINE = '#000000';

let pdfMakeLoading = null;

function loadScript(src) {
    return new Promise((resolve, reject) => {
        const el = document.createElement('script');
        el.src = src;
        el.onload = resolve;
        el.onerror = () => reject(new Error(`Не завантажився ${src}`));
        document.head.appendChild(el);
    });
}

/** Готовий до роботи pdfMake зі шрифтами. Вантажиться один раз. */
export function loadPdfMake() {
    if (window.pdfMake?.vfs) return Promise.resolve(window.pdfMake);
    // Невдалу спробу не запамʼятовуємо: наступне натискання має
    // спробувати ще раз, а не впиратися в мережеву помилку назавжди.
    pdfMakeLoading ||= (async () => {
        let last = null;
        for (const base of PDFMAKE_SOURCES) {
            try {
                await loadScript(`${base}/pdfmake.min.js`);
                await loadScript(`${base}/vfs_fonts.js`);
                if (!window.pdfMake) throw new Error('pdfmake не завантажився');
                // Різні збірки vfs_fonts кладуть таблицю шрифтів у різні місця.
                if (!window.pdfMake.vfs && window.pdfMake.pdfMake?.vfs) {
                    window.pdfMake.vfs = window.pdfMake.pdfMake.vfs;
                }
                if (!window.pdfMake.vfs && window.vfs) window.pdfMake.vfs = window.vfs;
                if (!window.pdfMake.vfs) throw new Error('шрифти pdfmake не завантажилися');
                return window.pdfMake;
            } catch (e) {
                console.warn(`pdfmake з ${base}:`, e);
                last = e;
            }
        }
        throw last || new Error('pdfmake недоступний');
    })().catch(e => { pdfMakeLoading = null; throw e; });
    return pdfMakeLoading;
}

/** Реквізити ОСББ із налаштувань; якщо їх ще не заповнили — типові. */
export async function osbbInfo() {
    try {
        const snap = await getDoc(doc(db, 'osbb_settings', 'finance'));
        const d = snap.exists() ? snap.data() : {};
        return {
            name: d.payeeName || OSBB_DEFAULTS.name,
            address: d.houseAddress || OSBB_DEFAULTS.address,
            edrpou: d.edrpou || OSBB_DEFAULTS.edrpou
        };
    } catch (e) {
        console.warn('Реквізити ОСББ для документа:', e);
        return { ...OSBB_DEFAULTS };
    }
}

const safe = (s) => String(s ?? '').trim();

/**
 * Назва без абревіатури: у шапці протоколу над нею вже стоїть рядок
 * «ОБ’ЄДНАННЯ СПІВВЛАСНИКІВ БАГАТОКВАРТИРНОГО БУДИНКУ», і повне
 * «ОСББ «Успіх-25»» читалося б як «…будинку ОСББ «Успіх-25»».
 */
const bareName = (name) => safe(name).replace(/^ОСББ\s*/i, '');

/** Місто з адреси будинку: у шапці протоколу воно стоїть окремо. */
function cityOf(address) {
    const m = String(address || '').match(/м\.\s*[А-ЯІЇЄҐ][А-Яа-яІіЇїЄєҐґ'’-]*/);
    return m ? m[0] : '';
}

/** Латиниця в назві файлу: кирилиця в заголовку Storage ламає завантаження. */
function fileSlug(text) {
    const MAP = { а:'a',б:'b',в:'v',г:'h',ґ:'g',д:'d',е:'e',є:'ie',ж:'zh',з:'z',и:'y',і:'i',
        ї:'i',й:'i',к:'k',л:'l',м:'m',н:'n',о:'o',п:'p',р:'r',с:'s',т:'t',у:'u',ф:'f',
        х:'kh',ц:'ts',ч:'ch',ш:'sh',щ:'shch',ь:'',ю:'iu',я:'ia',"'":'' };
    return safe(text).toLowerCase().split('')
        .map(ch => MAP[ch] ?? ch)
        .join('')
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 60) || 'document';
}

/**
 * Пункти рішення з багаторядкового тексту.
 *
 * Правління пише проєкт рішення рядками; нумерацію «2.1», «2.2»
 * дописуємо самі, але не чіпаємо рядок, який уже починається з
 * номера — інакше вийшло б «2.1. 2.1. Здійснити…».
 */
export function decisionLines(text, questionNo) {
    const lines = safe(text).split('\n').map(l => l.trim()).filter(Boolean);
    if (lines.length <= 1) return lines;
    return lines.map((line, i) =>
        /^\d+[.)]/.test(line) ? line : `${questionNo}.${i + 1}. ${line}`);
}

/** Рядки таблиці «власники квартири», по одному на співвласника. */
function ownerRows(apartments) {
    const rows = [];
    (apartments || []).forEach(apt => {
        const owners = apt.owners?.length ? apt.owners : [{ name: '', docInfo: '' }];
        owners.forEach(o => {
            rows.push({
                apt: apt.apt,
                // Площу пишемо в КОЖНОМУ рядку квартири — так зроблено
                // в паперовому листку: співвласник бачить площу свого
                // приміщення у своєму ж рядку, а не через два вище.
                area: parseArea(apt.area),
                name: safe(o.name),
                docInfo: safe(o.docInfo),
                share: ownerShare(o)
            });
        });
    });
    return rows;
}

function pdfStyles() {
    return {
        org: { fontSize: 11, bold: true, alignment: 'center' },
        sub: { fontSize: 9, alignment: 'center', margin: [0, 1, 0, 0] },
        docTitle: { fontSize: 13, bold: true, alignment: 'center', margin: [0, 10, 0, 2] },
        sheetTitle: { fontSize: 12, bold: true, alignment: 'center' },
        sheetSub: { fontSize: 9, alignment: 'center', margin: [0, 2, 0, 4] },
        question: { fontSize: 9.5, bold: true, margin: [0, 2, 0, 2] },
        qsub: { fontSize: 9, margin: [0, 1, 0, 0] },
        h2: { fontSize: 11, bold: true, margin: [0, 14, 0, 6] },
        th: { fontSize: 7.5, bold: true, alignment: 'center' },
        td: { fontSize: 9 },
        note: { fontSize: 9, margin: [0, 10, 0, 0] },
        footer: { fontSize: 8, color: '#666666' },
        para: { fontSize: 10.5, margin: [0, 0, 0, 5], alignment: 'justify', lineHeight: 1.15 },
        label: { fontSize: 10.5, bold: true, margin: [0, 6, 0, 2] },
        verdict: { fontSize: 10.5, bold: true, margin: [0, 6, 0, 0] }
    };
}

const gridLayout = () => ({
    hLineWidth: () => 0.5, vLineWidth: () => 0.5,
    hLineColor: () => LINE, vLineColor: () => LINE,
    paddingTop: () => 3, paddingBottom: () => 3
});

// У листку рядки вищі за звичайні: у три порожні клітинки праворуч
// співвласник вписує дату, відповідь і ставить підпис від руки.
const sheetLayout = () => ({
    hLineWidth: () => 0.5, vLineWidth: () => 0.5,
    hLineColor: () => LINE, vLineColor: () => LINE,
    paddingTop: (i) => (i < 2 ? 3 : 7),
    paddingBottom: (i) => (i < 2 ? 3 : 7)
});

// ------------------------------------------------------------
// ЛИСТКИ ПИСЬМОВОГО ОПИТУВАННЯ
// ------------------------------------------------------------
/**
 * PDF для обходу квартир: на кожне питання порядку денного — своя
 * таблиця з усіма співвласниками, де від руки ставлять дату,
 * відповідь і підпис.
 *
 * Питання на окремих сторінках не з естетики: закон вимагає, щоб
 * письмове рішення власника стосувалося конкретного питання, тож
 * листок із двома питаннями на одному аркуші довелося б переробляти.
 *
 * Шапка з питанням лежить усередині таблиці (headerRows), а не над
 * нею. Так вона повторюється на кожній сторінці сама — а без цього
 * на другому аркуші співвласник підписувався б під невідомо чим.
 *
 * Складання відокремлене від завантаження: так документ можна
 * зібрати й перевірити, не відкриваючи браузера.
 */
export function buildBlankSheetsDoc(poll, apartments, osbb) {
    const questions = agendaOf(poll);
    const decisions = poll.agendaDecisions || [];
    const rows = ownerRows(apartments);

    const when = [
        formatShortDate(poll.meetingDate) ? `${formatShortDate(poll.meetingDate)} року` : '',
        poll.timeStart ? `з ${poll.timeStart}${poll.timeEnd ? ` по ${poll.timeEnd}` : ''} годину` : ''
    ].filter(Boolean).join(' ');

    const HEAD = ['N з/п', '№ квартири / нежитлового приміщення',
        'Загальна площа квартири / нежитлового приміщення',
        'Прізвище, ім’я, по батькові співвласника або його представника та документ, '
            + 'що надає представнику повноваження на голосування',
        'Документ, що підтверджує право власності на квартиру / нежитлове приміщення',
        'Частка', 'Дата', 'Відповідь співвласника: «ЗА», «ПРОТИ», «УТРИМАВСЯ»',
        'Підпис співвласника (представника)'];

    const titleCell = (question, index) => ({
        colSpan: HEAD.length,
        margin: [0, 2, 0, 4],
        stack: [
            { text: 'Листок опитування', style: 'sheetTitle' },
            {
                text: `співвласників на загальних зборах ${osbb.name}`
                    + `${when ? `, що відбулись ${when}` : ''}`,
                style: 'sheetSub'
            },
            { text: `Питання ${index + 1}. ${question}`, style: 'question' },
            ...decisionLines(decisions[index], index + 1).map(t => ({ text: t, style: 'qsub' }))
        ]
    });

    const content = [];
    questions.forEach((q, i) => {
        if (i > 0) content.push({ text: '', pageBreak: 'before' });
        content.push({
            table: {
                headerRows: 2,
                widths: [24, 50, 58, '*', 150, 36, 52, 82, 84],
                body: [
                    [titleCell(q, i), ...Array(HEAD.length - 1).fill({})],
                    HEAD.map(text => ({ text, style: 'th' })),
                    ...rows.map((r, n) => [
                        { text: String(n + 1), style: 'td', alignment: 'center' },
                        { text: String(r.apt), style: 'td', alignment: 'center' },
                        { text: r.area ? fmtNum(r.area, 1) : '', style: 'td', alignment: 'center' },
                        { text: r.name, style: 'td' },
                        { text: r.docInfo, style: 'td' },
                        { text: r.share, style: 'td', alignment: 'center' },
                        { text: '', style: 'td' },      // дату ставить власник
                        { text: '', style: 'td' },      // відповідь пише власник
                        { text: '', style: 'td' }       // підпис
                    ])
                ]
            },
            layout: sheetLayout()
        });
        content.push({
            text: 'Підпис особи, яка проводила опитування: _____________________ (                              )',
            style: 'note'
        });
    });

    if (!questions.length) {
        content.push({ text: 'У зборів немає жодного питання порядку денного.', style: 'note' });
    }

    return {
        pageSize: 'A4',
        pageOrientation: 'landscape',
        pageMargins: [22, 20, 22, 26],
        content,
        footer: (page, total) => ({
            text: `Сторінка ${page} з ${total}`, style: 'footer', alignment: 'right',
            margin: [0, 0, 22, 0]
        }),
        defaultStyle: { font: 'Roboto', fontSize: 9, color: INK },
        styles: pdfStyles()
    };
}

/** Складає листки й одразу віддає файл на пристрій правління. */
export async function generateBlankSheets(poll, apartments) {
    const [pdfMake, osbb] = await Promise.all([loadPdfMake(), osbbInfo()]);
    const dd = buildBlankSheetsDoc(poll, apartments, osbb);
    const name = `Lystky_${fileSlug(poll.title)}_${poll.meetingDate || ''}.pdf`.replace('__', '_');
    pdfMake.createPdf(dd).download(name);
    return name;
}

// ------------------------------------------------------------
// ПРОТОКОЛ
// ------------------------------------------------------------
/**
 * Тіло протоколу — окремо від публікації, щоб його було з чого
 * зібрати й перевірити.
 *
 * Структура повторює протокол, який ОСББ подає в міську раду:
 * шапка, загальна інформація прозою, порядок денний, розгляд
 * кожного питання («Слухали» — «Вирішили» — результати —
 * «Рішення ПРИЙНЯТО») і підписи голови та секретаря.
 */
export function buildProtocolDoc(poll, apartments, votes, osbb) {
    const questions = agendaOf(poll);
    const decisions = poll.agendaDecisions || [];
    const heard = poll.agendaHeard || [];
    const q = quorumBreakdown(votes, apartments);
    const total = q.total;
    const city = cityOf(osbb.address);
    const owners = (n) => `${n} ${plural(n, 'співвласник', 'співвласники', 'співвласників')}`;
    const persons = (n) => `${n} ${plural(n, 'особа', 'особи', 'осіб')}`;
    // Більшість — це перше ціле число, що перевищує половину.
    const majority = Math.floor(total.totalOwners / 2) + 1;

    const content = [
        { text: 'ОБ’ЄДНАННЯ СПІВВЛАСНИКІВ БАГАТОКВАРТИРНОГО БУДИНКУ', style: 'org' },
        { text: bareName(osbb.name), style: 'org' },
        {
            text: `${osbb.address}${osbb.edrpou ? `, ЄДРПОУ ${osbb.edrpou}` : ''}`,
            style: 'sub', margin: [0, 2, 0, 0]
        },
        { text: `ПРОТОКОЛ № ${safe(poll.protocolNumber) || '___'}`, style: 'docTitle' },
        { text: 'загальних зборів об’єднання співвласників багатоквартирного будинку', style: 'sub' },
        { text: bareName(osbb.name), style: 'sub' },
        {
            columns: [
                { text: city, style: 'para', margin: [0, 16, 0, 0] },
                { text: formatProtocolDate(poll.meetingDate), style: 'para',
                  alignment: 'right', margin: [0, 16, 0, 0] }
            ]
        },
        {
            text: poll.timeStart
                ? `Збори розпочато о ${poll.timeStart} год.`
                  + `${poll.timeEnd ? `, завершено о ${poll.timeEnd} год.` : ''}`
                : '',
            style: 'para'
        },
        {
            text: `Місце проведення загальних зборів: ${osbb.address}`
                + `${poll.location ? ` (${poll.location})` : ''}.`,
            style: 'para'
        },

        { text: 'ЗАГАЛЬНА ІНФОРМАЦІЯ:', style: 'h2' },
        {
            text: `Загальна кількість співвласників багатоквартирного будинку: `
                + `${persons(total.totalOwners)} (100%).`,
            style: 'para'
        },
        {
            text: `Загальна площа всіх квартир та/або нежитлових приміщень багатоквартирного `
                + `будинку: ${fmtNum(total.totalArea)} м² (100%).`,
            style: 'para'
        },
        {
            text: `У голосуванні на загальних зборах взяли участь особисто та/або через `
                + `представників: співвласники в кількості ${persons(q.online.votedOwners)}, яким `
                + `належать квартири та/або нежитлові приміщення у багатоквартирному будинку `
                + `загальною площею ${fmtNum(q.online.votedArea)} м².`,
            style: 'para'
        },
        {
            text: `У письмовому опитуванні взяли участь особисто та/або через представників: `
                + `співвласники в кількості ${persons(q.paper.votedOwners)}, яким належать квартири `
                + `та/або нежитлові приміщення у багатоквартирному будинку загальною площею `
                + `${fmtNum(q.paper.votedArea)} м².`,
            style: 'para'
        },
        {
            text: `Разом у голосуванні (на зборах та в письмовому опитуванні) взяли участь: `
                + `співвласники в кількості ${persons(total.votedOwners)}, яким належать квартири `
                + `та/або нежитлові приміщення у багатоквартирному будинку загальною площею `
                + `${fmtNum(total.votedArea)} м², що становить ${fmtPct(total.ownersPct)}% голосів `
                + `усіх співвласників.`,
            style: 'para'
        },
        {
            text: `Кожний співвласник (його представник) має один голос незалежно від кількості `
                + `та площі квартир і нежитлових приміщень, що перебувають у його власності. `
                + `Для прийняття рішень з питань порядку денного необхідна більшість голосів від `
                + `загальної кількості голосів співвласників об’єднання (тобто не менше `
                + `${majority} ${plural(majority, 'голосу', 'голосів', 'голосів')} — понад `
                + `${DECISION_PCT}% від загальної кількості у ${persons(total.totalOwners)}).`,
            style: 'para'
        },
        {
            text: total.hasQuorum
                ? `Кворум зібрано: участь узяли ${fmtPct(total.ownersPct)}% співвласників `
                  + `(необхідно понад ${QUORUM_PCT}%). Збори правомочні.`
                : `Кворуму немає: участь узяли ${fmtPct(total.ownersPct)}% співвласників `
                  + `(необхідно понад ${QUORUM_PCT}%). Збори неправомочні.`,
            style: 'verdict'
        },

        { text: 'ПОРЯДОК ДЕННИЙ ЗБОРІВ:', style: 'h2' },
        ...questions.map((text, i) => ({ text: `${i + 1}. ${text}`, style: 'para' })),

        { text: 'РОЗГЛЯД ПИТАНЬ ПОРЯДКУ ДЕННОГО ТА ПРИЙНЯТІ РІШЕННЯ:', style: 'h2' }
    ];

    questions.forEach((question, index) => {
        const amongPresent = isChairQuestion(index);
        const t = questionTally(votes, apartments, index, amongPresent);

        content.push({
            text: `Питання ${index + 1}. ${question}`,
            style: 'para', bold: true, margin: [0, 12, 0, 4]
        });
        if (safe(heard[index])) {
            content.push({ text: 'Слухали:', style: 'label' });
            content.push({ text: safe(heard[index]), style: 'para' });
        }

        const lines = decisionLines(decisions[index], index + 1);
        if (lines.length) {
            content.push({ text: 'Вирішили:', style: 'label' });
            lines.forEach(line => content.push({ text: line, style: 'para' }));
        }

        content.push({
            text: `Результати голосування з питання №${index + 1}:`,
            style: 'label', margin: [0, 8, 0, 4]
        });
        content.push({
            table: {
                widths: ['*', 110, 90, 110],
                body: [
                    ['Результат', 'Кількість співвласників', 'Площа приміщень, м²',
                     amongPresent ? '% від присутніх (голоси / площа)' : '% від загальної кількості / площі']
                        .map(text => ({ text, style: 'th' })),
                    ...MEETING_ANSWERS.map((ans, k) => ([
                        { text: `«${['ЗА', 'ПРОТИ', 'УТРИМАЛИСЬ'][k] || ans.toUpperCase()}»`, style: 'td' },
                        { text: owners(t.rows[ans].ownersCount), style: 'td', alignment: 'center' },
                        { text: `${fmtNum(t.rows[ans].area)} м²`, style: 'td', alignment: 'center' },
                        { text: `${fmtPct(t.rows[ans].ownersPct)}% / ${fmtPct(t.rows[ans].areaPct)}%`,
                          style: 'td', alignment: 'center' }
                    ]))
                ]
            },
            layout: gridLayout()
        });
        content.push({
            text: t.accepted ? 'Рішення ПРИЙНЯТО.' : 'Рішення НЕ ПРИЙНЯТО.',
            style: 'verdict'
        });
    });

    content.push({
        text: `Всі питання порядку денного загальних зборів розглянуті та по ним прийняті рішення.`
            + `${poll.timeEnd ? ` Загальні збори оголошено закритими о ${poll.timeEnd} годині.` : ''}`,
        style: 'para', margin: [0, 14, 0, 0]
    });

    const chair = safe(poll.chairName) || '________________';
    const secretary = safe(poll.secretaryName) || '________________';
    content.push({
        style: 'para', margin: [0, 22, 0, 0],
        text: `Голова загальних зборів  __________________  / ${chair} /`
    });
    content.push({
        style: 'para', margin: [0, 10, 0, 0],
        text: `Секретар загальних зборів  __________________  / ${secretary} /`
    });

    // ---- Додаток: поіменне голосування ----
    // У паперовому протоколі цю роль виконують підписані листки.
    // Тут вони теж є — але зведена таблиця дозволяє правлінню звірити
    // підрахунок, не перебираючи стос аркушів.
    content.push({
        text: 'ДОДАТОК. Результати поіменного голосування',
        style: 'h2', pageBreak: 'before', pageOrientation: 'landscape'
    });

    const voteByApt = new Map((votes || []).map(v => [String(v.apt), v]));
    const nameHeader = ['№ кв.', 'Площа, м²', 'ПІБ співвласників', 'Форма участі',
        ...questions.map((_, i) => `Пит. ${i + 1}`)];
    const nameBody = (apartments || []).map(apt => {
        const vote = voteByApt.get(String(apt.apt));
        const form = !vote ? 'Не голосував' : (isPaperVote(vote) ? 'Письмово' : 'На зборах');
        return [
            { text: String(apt.apt), style: 'td', alignment: 'center' },
            { text: fmtNum(parseArea(apt.area), 1), style: 'td', alignment: 'center' },
            { text: (apt.owners || []).map(o => o.name).filter(Boolean).join(', '), style: 'td' },
            { text: form, style: 'td', alignment: 'center' },
            ...questions.map((_, i) => ({
                text: vote ? (answerFor(vote, i) || '—') : '—', style: 'td', alignment: 'center'
            }))
        ];
    });
    content.push({
        table: {
            headerRows: 1,
            widths: [34, 50, '*', 62, ...questions.map(() => 58)],
            body: [nameHeader.map(text => ({ text, style: 'th' })), ...nameBody]
        },
        layout: gridLayout()
    });

    return {
        docDefinition: {
            pageSize: 'A4',
            pageMargins: [42, 34, 34, 34],
            content,
            footer: (page, total_) => ({
                text: `Сторінка ${page} з ${total_}`, style: 'footer',
                alignment: 'right', margin: [0, 0, 34, 0]
            }),
            defaultStyle: { font: 'Roboto', fontSize: 10.5, color: INK },
            styles: pdfStyles()
        },
        quorum: q
    };
}

function toBlob(pdf) {
    // getBlob працює через колбек; без обгортки не було б як дочекатися файлу
    return new Promise((resolve, reject) => {
        try { pdf.getBlob(resolve); } catch (e) { reject(e); }
    });
}

/**
 * Складає протокол, кладе його в Базу документів ОСББ і розсилає
 * мешканцям посилання.
 *
 * Файл не завантажується на пристрій: протокол — документ будинку,
 * а не голови правління. Він має лежати там, де його знайде будь-який
 * мешканець через півроку, тому шлях один — Storage і osbb_documents.
 */
export async function generateAndPublishProtocol(poll, apartments, votes, onStep = () => {}) {
    const [pdfMake, osbb] = await Promise.all([loadPdfMake(), osbbInfo()]);

    onStep('Складання документа…');
    const { docDefinition, quorum } = buildProtocolDoc(poll, apartments, votes, osbb);
    const blob = await toBlob(pdfMake.createPdf(docDefinition));

    onStep('Завантаження у Базу…');
    const fileName = `Protocol_${poll.id}.pdf`;
    const fileRef = sRef(storage, `osbb_docs/${fileName}`);
    await uploadBytes(fileRef, blob, { contentType: 'application/pdf' });
    const url = await getDownloadURL(fileRef);

    const dateLabel = formatMeetingDate(poll.meetingDate) || 'без дати';
    const title = `Протокол № ${safe(poll.protocolNumber) || '___'} загальних зборів від ${dateLabel}`;

    const docRef = await addDoc(collection(db, 'osbb_documents'), {
        title,
        category: 'Протоколи зборів',
        fileName,
        url,
        size: blob.size,
        type: 'application/pdf',
        pollId: poll.id,
        createdAt: serverTimestamp()
    });

    onStep('Публікація…');
    // Статус і посилання пишемо ДО розсилки: якщо впаде розсилка,
    // протокол усе одно лишається опублікованим і знайденим у Базі.
    await updateDoc(doc(db, 'polls', poll.id), {
        status: 'closed',
        quorum: quorum.total,
        protocolUrl: url,
        protocolDocId: docRef.id,
        protocolAt: serverTimestamp()
    });

    const questions = agendaOf(poll);
    const summary = questions.map((question, i) => {
        const t = questionTally(votes, apartments, i, isChairQuestion(i));
        return `${i + 1}. ${question}\n   ${t.accepted ? 'ПРИЙНЯТО' : 'НЕ ПРИЙНЯТО'} — `
            + `за ${t.rows[MEETING_ANSWERS[0]].ownersCount}, `
            + `проти ${t.rows[MEETING_ANSWERS[1]].ownersCount}, `
            + `утрималися ${t.rows[MEETING_ANSWERS[2]].ownersCount}`;
    }).join('\n');

    await addDoc(collection(db, 'messages'), {
        title: `Протокол зборів від ${dateLabel}`,
        body: `Протокол загальних зборів співвласників сформовано та додано до Бази документів ОСББ.\n\n`
            + `Участь узяли ${quorum.total.votedOwners} із ${quorum.total.totalOwners} співвласників `
            + `(${fmtPct(quorum.total.ownersPct)}%), ${fmtNum(quorum.total.votedArea)} із `
            + `${fmtNum(quorum.total.totalArea)} м².\n`
            + `${quorum.total.hasQuorum ? 'Кворум зібрано, збори правомочні.' : 'Кворуму немає, збори неправомочні.'}\n\n`
            + `РІШЕННЯ (голосів співвласників)\n${summary}\n\n`
            + `Повний текст протоколу — у прикріпленому документі.`,
        targetType: 'all',
        targetValue: '',
        recipients: buildRecipients('all', ''),
        attachments: [],
        linkedDoc: { name: title, url, type: 'application/pdf', size: blob.size },
        createdAt: serverTimestamp(),
        readBy: {}
    });

    return { url, title, quorum: quorum.total };
}
