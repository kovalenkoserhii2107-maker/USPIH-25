// ============================================================
// Юридичні документи зборів: листки письмового опитування
// і протокол загальних зборів.
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
    agendaOf, answerFor, isPaperVote, parseArea,
    quorumBreakdown, questionTally, formatMeetingDate, meetingWhen
} from './meeting.js';

// Два джерела, а не одне: колись cdnjs уже лежав, і в такий день
// правління не змогло б сформувати протокол зборів. Порядок має
// значення — jsDelivr береться, лише якщо перший не відповів.
const PDFMAKE_SOURCES = [
    'https://cdnjs.cloudflare.com/ajax/libs/pdfmake/0.2.7',
    'https://cdn.jsdelivr.net/npm/pdfmake@0.2.7/build'
];

const INK = '#1C1C1E';
const LINE = '#B0B4BA';

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
async function osbbInfo() {
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

const num = (n) => (Math.round(n * 10) / 10).toString().replace('.', ',');
const safe = (s) => String(s ?? '').trim();

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

/** Рядки таблиці «власники квартири», по одному на співвласника. */
function ownerRows(apartments) {
    const rows = [];
    (apartments || []).forEach(apt => {
        const owners = apt.owners?.length ? apt.owners : [{ name: '', docInfo: '', sharePerc: '' }];
        owners.forEach((o, i) => {
            rows.push({
                apt: apt.apt,
                // Площу пишемо лише в першому рядку квартири, інакше в
                // сумі стовпця та сама квартира порахувалася б двічі.
                area: i === 0 ? parseArea(apt.area) : null,
                name: safe(o.name),
                docInfo: safe(o.docInfo),
                share: safe(o.sharePerc) ? `${safe(o.sharePerc)}%` : ''
            });
        });
    });
    return rows;
}

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
 * Складання відокремлене від завантаження: так документ можна
 * зібрати й перевірити, не відкриваючи браузера.
 */
export function buildBlankSheetsDoc(poll, apartments, osbb) {
    const questions = agendaOf(poll);
    const rows = ownerRows(apartments);
    const when = meetingWhen(poll);

    const header = (question, index) => ([
        { text: osbb.name, style: 'org' },
        { text: `${osbb.address}${osbb.edrpou ? `, ЄДРПОУ ${osbb.edrpou}` : ''}`, style: 'sub' },
        { text: 'ЛИСТОК ПИСЬМОВОГО ОПИТУВАННЯ', style: 'docTitle' },
        { text: `Загальні збори співвласників ${when ? `— ${when}` : ''}`, style: 'sub' },
        {
            text: [
                { text: `Питання ${index + 1} з ${questions.length}: `, bold: true },
                { text: question }
            ],
            style: 'question'
        }
    ]);

    const table = {
        table: {
            headerRows: 1,
            // Ширини під альбомний А4: підпису й відповіді треба місце
            // для руки, документу про власність — для номера й дати.
            widths: [26, 30, 44, '*', 116, 34, 48, 64, 64],
            body: [
                ['№ з/п', '№ кв.', 'Площа, м²', 'ПІБ співвласника',
                 'Документ про право власності', 'Частка', 'Дата',
                 'Відповідь (ЗА / ПРОТИ / УТРИМАВСЯ)', 'Підпис']
                    .map(text => ({ text, style: 'th' })),
                ...rows.map((r, i) => [
                    { text: String(i + 1), style: 'td', alignment: 'center' },
                    { text: String(r.apt), style: 'td', alignment: 'center' },
                    { text: r.area ? num(r.area) : '', style: 'td', alignment: 'center' },
                    { text: r.name, style: 'td' },
                    { text: r.docInfo, style: 'td' },
                    { text: r.share, style: 'td', alignment: 'center' },
                    { text: '', style: 'td' },      // дату ставить власник
                    { text: '', style: 'td' },      // відповідь пише власник
                    { text: '', style: 'td' }       // підпис
                ])
            ]
        },
        layout: {
            hLineWidth: () => 0.5, vLineWidth: () => 0.5,
            hLineColor: () => LINE, vLineColor: () => LINE,
            paddingTop: () => 4, paddingBottom: () => 4
        }
    };

    const content = [];
    questions.forEach((q, i) => {
        if (i > 0) content.push({ text: '', pageBreak: 'before' });
        content.push(...header(q, i), table);
        content.push({
            text: 'Підписуючи цей листок, співвласник підтверджує своє рішення з питання, '
                + 'зазначеного вище. Виправлення в графі «Відповідь» не допускаються.',
            style: 'note'
        });
    });

    if (!questions.length) {
        content.push({ text: 'У зборів немає жодного питання порядку денного.', style: 'note' });
    }

    const dd = {
        pageSize: 'A4',
        pageOrientation: 'landscape',
        pageMargins: [24, 24, 24, 28],
        content,
        footer: (page, total) => ({
            text: `Сторінка ${page} з ${total}`, style: 'footer', alignment: 'right',
            margin: [0, 0, 24, 0]
        }),
        defaultStyle: { font: 'Roboto', fontSize: 9, color: INK },
        styles: pdfStyles()
    };

    return dd;
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
function pdfStyles() {
    return {
        org: { fontSize: 12, bold: true, alignment: 'center' },
        sub: { fontSize: 9, alignment: 'center', color: '#48484A', margin: [0, 1, 0, 0] },
        docTitle: { fontSize: 14, bold: true, alignment: 'center', margin: [0, 10, 0, 2] },
        question: { fontSize: 10.5, margin: [0, 10, 0, 6] },
        h2: { fontSize: 11, bold: true, margin: [0, 14, 0, 6] },
        th: { fontSize: 8.5, bold: true, alignment: 'center', fillColor: '#EFEFF4' },
        td: { fontSize: 9 },
        note: { fontSize: 8, italics: true, color: '#48484A', margin: [0, 8, 0, 0] },
        footer: { fontSize: 8, color: '#8E8E93' },
        para: { fontSize: 10, margin: [0, 0, 0, 4], alignment: 'justify' },
        verdictOk: { fontSize: 10, bold: true, color: '#248A3D', margin: [0, 6, 0, 0] },
        verdictNo: { fontSize: 10, bold: true, color: '#C93400', margin: [0, 6, 0, 0] }
    };
}

function tableLayout() {
    return {
        hLineWidth: () => 0.5, vLineWidth: () => 0.5,
        hLineColor: () => LINE, vLineColor: () => LINE,
        paddingTop: () => 3, paddingBottom: () => 3
    };
}

/** Тіло протоколу — окремо від публікації, щоб його було з чого зібрати й перевірити. */
export function buildProtocolDoc(poll, apartments, votes, osbb) {
    const questions = agendaOf(poll);
    const q = quorumBreakdown(votes, apartments);
    const when = formatMeetingDate(poll.meetingDate);
    const voteByApt = new Map((votes || []).map(v => [String(v.apt), v]));

    const content = [
        { text: osbb.name, style: 'org' },
        { text: `${osbb.address}${osbb.edrpou ? `, ЄДРПОУ ${osbb.edrpou}` : ''}`, style: 'sub' },
        { text: 'ПРОТОКОЛ', style: 'docTitle' },
        { text: 'загальних зборів співвласників багатоквартирного будинку', style: 'sub' },
        {
            columns: [
                { text: when || '', style: 'para', margin: [0, 14, 0, 0] },
                {
                    text: poll.location ? `Місце проведення: ${poll.location}` : '',
                    style: 'para', alignment: 'right', margin: [0, 14, 0, 0]
                }
            ]
        },
        {
            text: poll.timeStart
                ? `Час початку: ${poll.timeStart}${poll.timeEnd ? `, час закінчення: ${poll.timeEnd}` : ''}`
                : '',
            style: 'para'
        },
        { text: `Ініціатор зборів: правління ${osbb.name}.`, style: 'para' },

        { text: 'ЗАГАЛЬНА ІНФОРМАЦІЯ', style: 'h2' },
        {
            table: {
                widths: ['*', 70, 70, 60],
                body: [
                    ['Показник', 'Власників', 'Площа, м²', '% площі'].map(text => ({ text, style: 'th' })),
                    [
                        { text: 'Усього співвласників у будинку', style: 'td' },
                        { text: String(q.total.totalOwners), style: 'td', alignment: 'center' },
                        { text: num(q.total.totalArea), style: 'td', alignment: 'center' },
                        { text: '100', style: 'td', alignment: 'center' }
                    ],
                    [
                        { text: 'Взяли участь особисто на зборах', style: 'td' },
                        { text: String(q.online.votedOwners), style: 'td', alignment: 'center' },
                        { text: num(q.online.votedArea), style: 'td', alignment: 'center' },
                        { text: num(q.online.areaPct), style: 'td', alignment: 'center' }
                    ],
                    [
                        { text: 'Взяли участь шляхом письмового опитування', style: 'td' },
                        { text: String(q.paper.votedOwners), style: 'td', alignment: 'center' },
                        { text: num(q.paper.votedArea), style: 'td', alignment: 'center' },
                        { text: num(q.paper.areaPct), style: 'td', alignment: 'center' }
                    ],
                    [
                        { text: 'РАЗОМ взяли участь', style: 'td', bold: true },
                        { text: String(q.total.votedOwners), style: 'td', alignment: 'center', bold: true },
                        { text: num(q.total.votedArea), style: 'td', alignment: 'center', bold: true },
                        { text: num(q.total.areaPct), style: 'td', alignment: 'center', bold: true }
                    ]
                ]
            },
            layout: tableLayout()
        },
        {
            text: `Квартир, що взяли участь: ${q.total.votedApts} із ${q.total.totalApts} `
                + `(особисто ${q.onlineCount}, письмово ${q.paperCount}).`,
            style: 'para', margin: [0, 8, 0, 0]
        },
        {
            text: q.total.hasQuorum
                ? `Кворум зібрано: участь узяли ${num(q.total.ownersPct)}% співвласників `
                  + `(необхідно понад ${QUORUM_PCT}%). Збори правомочні.`
                : `Кворуму немає: участь узяли ${num(q.total.ownersPct)}% співвласників `
                  + `(необхідно понад ${QUORUM_PCT}%). Збори неправомочні.`,
            style: q.total.hasQuorum ? 'verdictOk' : 'verdictNo'
        },

        { text: 'ПОРЯДОК ДЕННИЙ', style: 'h2' },
        ...questions.map((text, i) => ({ text: `${i + 1}. ${text}`, style: 'para' })),

        { text: 'РОЗГЛЯД ПИТАНЬ', style: 'h2' }
    ];

    questions.forEach((question, index) => {
        const t = questionTally(votes, apartments, index);
        content.push({
            text: [{ text: `Питання ${index + 1}. `, bold: true }, { text: question }],
            style: 'para', margin: [0, 10, 0, 6]
        });
        content.push({
            table: {
                widths: ['*', 70, 80, 70],
                body: [
                    ['Результат голосування', 'Квартир', 'Площа, м²', '% від будинку']
                        .map(text => ({ text, style: 'th' })),
                    ...MEETING_ANSWERS.map(ans => ([
                        { text: ans, style: 'td' },
                        { text: String(t.rows[ans].count), style: 'td', alignment: 'center' },
                        { text: num(t.rows[ans].area), style: 'td', alignment: 'center' },
                        { text: num(t.rows[ans].pct), style: 'td', alignment: 'center' }
                    ]))
                ]
            },
            layout: tableLayout()
        });
        content.push({
            text: t.accepted
                ? `ВИРІШИЛИ: рішення ПРИЙНЯТО (${num(t.rows[MEETING_ANSWERS[0]].pct)}% площі будинку, `
                  + `необхідно понад ${DECISION_PCT}%).`
                : `ВИРІШИЛИ: рішення НЕ ПРИЙНЯТО (${num(t.rows[MEETING_ANSWERS[0]].pct)}% площі будинку, `
                  + `необхідно понад ${DECISION_PCT}%).`,
            style: t.accepted ? 'verdictOk' : 'verdictNo'
        });
    });

    // ---- Додаток: поіменне голосування ----
    content.push({
        text: 'ДОДАТОК. Результати поіменного голосування',
        style: 'h2', pageBreak: 'before', pageOrientation: 'landscape'
    });

    const nameHeader = ['№ кв.', 'Площа, м²', 'ПІБ співвласників', 'Форма участі',
        ...questions.map((_, i) => `Пит. ${i + 1}`)];

    const nameBody = (apartments || []).map(apt => {
        const vote = voteByApt.get(String(apt.apt));
        const form = !vote ? 'Не голосував' : (isPaperVote(vote) ? 'Письмово' : 'Особисто');
        return [
            { text: String(apt.apt), style: 'td', alignment: 'center' },
            { text: num(parseArea(apt.area)), style: 'td', alignment: 'center' },
            { text: (apt.owners || []).map(o => o.name).filter(Boolean).join(', '), style: 'td' },
            { text: form, style: 'td', alignment: 'center' },
            ...questions.map((_, i) => ({
                text: vote ? (answerFor(vote, i) || '—') : '—',
                style: 'td', alignment: 'center'
            }))
        ];
    });

    content.push({
        table: {
            headerRows: 1,
            widths: [34, 50, '*', 62, ...questions.map(() => 58)],
            body: [nameHeader.map(text => ({ text, style: 'th' })), ...nameBody]
        },
        layout: tableLayout()
    });

    // ---- Підписи ----
    const chair = safe(poll.chairName) || '________________________';
    const secretary = safe(poll.secretaryName) || '________________________';
    content.push({
        columns: [
            { stack: [
                { text: 'Голова зборів', style: 'para', margin: [0, 24, 0, 12] },
                { text: '____________________', style: 'para' },
                { text: chair, style: 'sub', alignment: 'left' }
            ] },
            { stack: [
                { text: 'Секретар зборів', style: 'para', margin: [0, 24, 0, 12] },
                { text: '____________________', style: 'para' },
                { text: secretary, style: 'sub', alignment: 'left' }
            ] }
        ]
    });

    return {
        docDefinition: {
            pageSize: 'A4',
            pageMargins: [36, 32, 36, 34],
            content,
            footer: (page, total) => ({
                text: `Сторінка ${page} з ${total}`, style: 'footer',
                alignment: 'right', margin: [0, 0, 36, 0]
            }),
            defaultStyle: { font: 'Roboto', fontSize: 10, color: INK },
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
    const title = `Протокол загальних зборів від ${dateLabel}`;

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
        const t = questionTally(votes, apartments, i);
        return `${i + 1}. ${question}\n   ${t.accepted ? 'ПРИЙНЯТО' : 'НЕ ПРИЙНЯТО'} — `
            + `за ${t.rows[MEETING_ANSWERS[0]].count}, проти ${t.rows[MEETING_ANSWERS[1]].count}, `
            + `утрималися ${t.rows[MEETING_ANSWERS[2]].count}`;
    }).join('\n');

    await addDoc(collection(db, 'messages'), {
        title: `Протокол зборів від ${dateLabel}`,
        body: `Протокол загальних зборів співвласників сформовано та додано до Бази документів ОСББ.\n\n`
            + `Участь узяли ${quorum.total.votedOwners} із ${quorum.total.totalOwners} співвласників `
            + `(${quorum.total.ownersPct}%), ${quorum.total.votedArea} із ${quorum.total.totalArea} м² `
            + `(${quorum.total.areaPct}%).\n`
            + `${quorum.total.hasQuorum ? 'Кворум зібрано, збори правомочні.' : 'Кворуму немає, збори неправомочні.'}\n\n`
            + `РІШЕННЯ\n${summary}\n\nПовний текст протоколу — у прикріпленому документі.`,
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
