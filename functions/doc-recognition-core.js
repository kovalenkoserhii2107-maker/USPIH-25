'use strict';
// ============================================================
// Чисте ядро розпізнавання первинних бухгалтерських документів ОСББ:
//   • Рахунки на оплату (invoice)
//   • Акти надання послуг / виконаних робіт (act)
//   • Видаткові та товарні накладні (waybill)
//   • Договори (contract)
//   • Фіскальні та товарні чеки (receipt)
// ============================================================
const { normIban } = require('./bank-core');
const { validIban } = require('./payments-core');
const { validEdrpou, validRnokpp } = require('./expenses-core');
const zlib = require('zlib');

const UKR_MONTHS = {
    'січня': '01', 'січень': '01',
    'лютого': '02', 'лютий': '02',
    'березня': '03', 'березень': '03',
    'квітня': '04', 'квітень': '04',
    'травня': '05', 'травень': '05',
    'червня': '06', 'червень': '06',
    'липня': '07', 'липень': '07',
    'серпня': '08', 'серпень': '08',
    'вересня': '09', 'вересень': '09',
    'жовтня': '10', 'жовтень': '10',
    'листопада': '11', 'листопад': '11',
    'грудня': '12', 'грудень': '12'
};

// Власні реквізити ОСББ: у документі вони стоять поруч із реквізитами
// постачальника, і без цього списку парсер міг узяти код чи рахунок
// самого будинку («Замовник: ОСББ…») за постачальника.
let OWN = { codes: new Set(), ibans: new Set() };
function setOwnRequisites({ codes = [], ibans = [] } = {}) {
    OWN = {
        codes: new Set(codes.map(c => String(c || '').replace(/\D/g, '')).filter(Boolean)),
        ibans: new Set(ibans.map(i => normIban(i || '')).filter(Boolean))
    };
}
const isOwnCode = (code) => OWN.codes.has(String(code || '').replace(/\D/g, ''));
const isOwnIban = (iban) => OWN.ibans.has(normIban(iban || ''));

/**
 * Число з документа: «4 800,00», «4800.00», «1.234,56», «1,234.56».
 * Коли є і крапка, і кома, десятковий — останній із них.
 */
function parseMoney(raw) {
    let t = String(raw ?? '').replace(/[\s\u00A0\u202F']/g, '');
    if (!t) return NaN;
    const lastDot = t.lastIndexOf('.'), lastComma = t.lastIndexOf(',');
    if (lastDot >= 0 && lastComma >= 0) {
        const dec = lastDot > lastComma ? '.' : ',';
        const thou = dec === '.' ? ',' : '.';
        t = t.split(thou).join('').replace(dec, '.');
    } else if (lastComma >= 0) {
        t = t.replace(',', '.');
    }
    return parseFloat(t);
}

const validYmd = (y, m, d) => {
    const yy = Number(y), mm = Number(m), dd = Number(d);
    if (!(yy >= 1990 && yy <= 2100 && mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31)) return false;
    const dt = new Date(Date.UTC(yy, mm - 1, dd));
    return dt.getUTCMonth() === mm - 1 && dt.getUTCDate() === dd;
};
const ymd = (y, m, d) => validYmd(y, m, d) ? `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}` : '';

function cleanText(raw) {
    return String(raw || '')
        .replace(/[\u00A0\u200B\u202F]/g, ' ')
        .replace(/\r\n/g, '\n')
        .trim();
}

function detectDocType(text) {
    const s = cleanText(text).toLowerCase();
    if (/фіскальн\w*\s+чек|касов\w*\s+чек|товарн\w*\s+чек|фн\s+чека|прро|рро\b|чек\s+№/i.test(s)) {
        return 'receipt';
    }
    if (/видатков\w*\s+накладн|товарн\w*\s+накладн|накладна\s+№|тільки\s+оригінал\s+накладної/i.test(s)) {
        return 'waybill';
    }
    if (/акт\s+(?:надання\s+послуг|виконаних\s+робіт|здачі|приймання|огляду)|акт\s+№/i.test(s)) {
        return 'act';
    }
    if (/рахунок(?:-фактура|\s+на\s+оплату|\s+№)/i.test(s)) {
        return 'invoice';
    }
    if (/договір\s+(?:про\s+надання|підряду|постачання|оренди|№)|контракт\s+№/i.test(s)) {
        return 'contract';
    }
    return 'invoice';
}

// Заголовок документа: номер і дата біля нього важливіші за перші-ліпші
// в тексті (там часто спершу йде «Договір № 5 від 01.01.2025»).
const TITLE_RX = /(?:рахунок(?:-фактура)?(?:\s+на\s+оплату)?|акт\s+(?:надання\s+послуг|виконаних\s+робіт|приймання[\s-]+передачі)?|видатков\w*\s+накладн\w*|товарн\w*\s+накладн\w*|накладн\w*|фіскальн\w*\s+чек|чек)/i;

function extractDocNumber(text) {
    const s = cleanText(text);
    const titled = s.match(new RegExp(TITLE_RX.source + '[^\\n№]{0,25}№\\s*([A-Za-zА-Яа-яІіЇїЄєҐґ0-9\\-_/]{1,30})', 'i'));
    if (titled) return titled[1].trim();
    const m = s.match(/(?:№|номер|ном\.?|no\.?)\s*[:.]?\s*([A-Za-zА-Яа-яІіЇїЄє0-9\-_/]{1,30})/i)
        || s.match(/\b(?:СФ|РХ|АКТ|ВН|ЧЕК|ФЧ)[-\s]?([0-9\-_/]{1,25})\b/i);
    return m ? m[1].trim() : '';
}

function firstDate(s) {
    const textDate = s.match(/[«"]?(\d{1,2})[»"]?\s+([а-яіїєґ]+)\s+(\d{4})/i);
    const numDate = s.match(/\b(\d{1,2})[./-](\d{1,2})[./-](\d{4})\b/);
    const isoDate = s.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
    // Береться та, що стоїть раніше в тексті.
    const found = [
        textDate && UKR_MONTHS[textDate[2].toLowerCase()] && { at: textDate.index, v: ymd(textDate[3], UKR_MONTHS[textDate[2].toLowerCase()], textDate[1]) },
        numDate && { at: numDate.index, v: ymd(numDate[3], numDate[2], numDate[1]) },
        isoDate && { at: isoDate.index, v: ymd(isoDate[1], isoDate[2], isoDate[3]) }
    ].filter(x => x && x.v).sort((a, b) => a.at - b.at);
    return found[0]?.v || '';
}

function extractDocDate(text) {
    const s = cleanText(text);
    // Спершу — дата в рядку заголовка документа («Акт № 12 від 30.09.2026»).
    const title = s.match(TITLE_RX);
    if (title) {
        const near = firstDate(s.slice(title.index, title.index + 120));
        if (near) return near;
    }
    return firstDate(s);
}

function extractIban(text) {
    const s = cleanText(text).replace(/\s+/g, ' ');
    const matches = s.match(/UA\s*(?:\d\s*){27}/gi) || [];
    let fallback = '';
    for (const m of matches) {
        const clean = normIban(m);
        if (/^UA\d{27}$/.test(clean) && !isOwnIban(clean)) {
            if (validIban(clean)) return clean;
            if (!fallback) fallback = clean;
        }
    }
    return fallback;
}

function extractEdrpou(text) {
    const s = cleanText(text);

    const valid = (c) => (c.length === 8 && validEdrpou(c)) || (c.length === 10 && validRnokpp(c));
    const rx = /(?:єДРПОУ|едрпоу|код\s+за\s+єдрпоу|код\s+єдрпоу|рнокпп|іпн|ідентифікаційний\s+код|код\s+платника|код)[\s:№./]*(\d{8,10})\b/gi;
    let firstLabelled = '';
    for (const m of s.matchAll(rx)) {
        const code = m[1];
        if (isOwnCode(code)) continue;
        if (valid(code)) return code;
        if (!firstLabelled) firstLabelled = code;
    }
    if (firstLabelled) return firstLabelled;

    for (const w of s.match(/\b\d{8}\b/g) || []) {
        if (!isOwnCode(w) && validEdrpou(w)) return w;
    }
    for (const w of s.match(/\b\d{10}\b/g) || []) {
        if (!isOwnCode(w) && validRnokpp(w)) return w;
    }
    return '';
}

function extractSupplierName(text) {
    const s = cleanText(text);

    const m = s.match(/(?:^|[\s,;:(])((?:ТОВ|ПП|ПрАТ|ПАТ|АТ|КП|ТзОВ)\s*(?:«[^»\n]+»|"[^"\n]+"|“[^”\n]+”|[А-ЯІЇЄҐA-Z][А-Яа-яІіЇїЄєҐґA-Za-z0-9'’\- ]{1,60}))/)
        || s.match(/\bФОП\s+[А-ЯІЇЄҐ][а-яіїєґ']+\s+[А-ЯІЇЄҐ]\.?\s*[А-ЯІЇЄҐ]?\.?/i)
        || s.match(/Постачальник[:\s]+([^\n,;]{3,80})/i)
        || s.match(/Виконавець[:\s]+([^\n,;]{3,80})/i);

    if (m) {
        return (m[1] ? m[1] : m[0]).trim();
    }
    return '';
}

function extractAmounts(text) {
    const s = cleanText(text);

    let totalKop = 0;
    let vatKop = 0;

    // Пріоритет: 1) "Всього до сплати" / "Разом до сплати" 2) "Всього" / "Разом" 3) "Сума".
    // Число не переходить на інший рядок: інакше «Разом 300» і рік на
    // наступному рядку злипалися в одне число.
    const N = '(\\d[\\d \\u00A0.,]*\\d|\\d)';
    const sumMatch = s.match(new RegExp('(?:всього\\s+до\\s+сплати|разом\\s+до\\s+сплати|до\\s+сплати)(?:[^\\n:]{0,35})[: \\t]+' + N + '[ \\t]*(?:грн|uah)?', 'i'))
        || s.match(new RegExp('(?:разом|всього|загальна\\s+вартість)(?:[^\\n:]{0,35})[: \\t]+' + N + '[ \\t]*(?:грн|uah)?', 'i'))
        || s.match(new RegExp('(?<!без\\s+)(?:сума|вартість|ціна)(?:[^\\n:]{0,35})[: \\t]+' + N + '[ \\t]*(?:грн|uah)?', 'i'))
        || s.match(/\b(\d[\d \u00A0]*[.,]\d{2})[ \t]*(?:грн|uah)\b/i);

    if (sumMatch) {
        const parsed = parseMoney(sumMatch[1]);
        if (Number.isFinite(parsed) && parsed > 0) {
            totalKop = Math.round(parsed * 100);
        }
    }

    // Шукаємо суму ПДВ порядково, ігноруючи "без ПДВ"
    for (const line of s.split('\n')) {
        if (/без\s+пдв/i.test(line)) continue;
        const vm = line.match(/(?:у\s+т\.?ч\.?\s+)?(?<![а-яіїєґ])пдв(?![а-яіїєґ])(?:\s*(?:\d{1,2}\s*%|\(\d{1,2}%\)))?[:\s]*(\d[\d \u00A0.,]*\d)/i);
        if (vm) {
            const parsedVat = parseMoney(vm[1]);
            if (Number.isFinite(parsedVat) && parsedVat > 0) {
                vatKop = Math.round(parsedVat * 100);
                break;
            }
        }
    }

    return { totalKop, vatKop };
}

function extractTerms(text) {
    const s = cleanText(text);

    let paymentDueDays = 0;
    const dueMatch = s.match(/оплата\s+(?:протягом|впродовж|здійснюється\s+протягом)\s+(\d+)\s*(?:банківських|календарних|роб)?\s*дн/i)
        || s.match(/відстрочк\w*\s+(?:платежу\s+)?(\d+)\s*дн/i);
    if (dueMatch) {
        paymentDueDays = parseInt(dueMatch[1], 10) || 0;
    }

    let contractEnd = '';
    const endMatch = s.match(/договір\s+діє\s+до\s+(\d{1,2}[./-]\d{1,2}[./-]\d{4})/i)
        || s.match(/строк\s+дії\s+(?:до\s+)?(\d{1,2}[./-]\d{1,2}[./-]\d{4})/i);
    if (endMatch) {
        contractEnd = extractDocDate(endMatch[1]);
    }

    return { paymentDueDays, contractEnd };
}

function suggestCategoryAndAccount(text, docType = 'invoice') {
    const s = cleanText(text).toLowerCase();

    // Ліфти
    if (/ліфт|підйомник|диспетчеризац|отіс|шиндлер/i.test(s)) {
        return { item: 'lift', postingAcc: '92' };
    }
    // Сміття
    if (/смітт|тпв|вивезення\s+відход|екотранс|побутових\s+відход/i.test(s)) {
        return { item: 'waste', postingAcc: '92' };
    }
    // Електроенергія
    if (/електроенерг|дтек|одесаобленерго|кіловат|квт/i.test(s)) {
        return { item: 'power', postingAcc: '92' };
    }
    // Водопостачання
    if (/інфокс|водоканал|водопостачання|водовідведення/i.test(s)) {
        return { item: 'water', postingAcc: '92' };
    }
    // Прибирання
    if (/прибирання|двірник|клінінг|дезінсекц|дератизац/i.test(s)) {
        return { item: 'cleaning', postingAcc: '92' };
    }
    // Юристи та бухгалтерія
    if (/бухгалтер|юридичн|адвокат|аудит|програм/i.test(s)) {
        return { item: 'services', postingAcc: '92' };
    }

    // ТМЦ / Матеріали та інвентар мають пріоритет для накладних або чеків
    if (docType === 'waybill' || docType === 'receipt') {
        if (/лопат|мітл|віник|граблі|швабр|драбин|замок\s+навісний|спецодяг|рукавиці|перчатки/i.test(s)) {
            return { item: 'repair', postingAcc: '22' };
        }
        if (/бензин|дизель|паливо|фарба|цемент|пісок|труба|кран\s+кульовий|кабель|провід|лампа|автомат\s+16а/i.test(s)) {
            return { item: 'repair', postingAcc: '20' };
        }
    }

    // Якщо це послуги / акт сантехнічних робіт
    if (/сантехнік|електрик|обслуговування\s+систем|вентиляц|аварійна\s+заміна/i.test(s)) {
        return { item: 'systems', postingAcc: '92' };
    }

    // Якщо це накладна з генератором
    if (/генератор|насос|теплолічильник|інвертор|мотопомпа/i.test(s)) {
        return { item: 'systems', postingAcc: '11' };
    }

    if (/лопат|мітл|віник|граблі|швабр|драбин|замок\s+навісний|спецодяг|рукавиці|перчатки/i.test(s)) {
        return { item: 'repair', postingAcc: '22' };
    }
    if (/бензин|дизель|паливо|фарба|цемент|пісок|труба|кран\s+кульовий|кабель|провід|лампа/i.test(s)) {
        return { item: 'repair', postingAcc: '20' };
    }

    return { item: 'other', postingAcc: '92' };
}


function cleanXmlText(s) {
    if (!s) return "";
    return String(s)
        .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/gi, "$1")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, "\"")
        .replace(/&#39;/g, "'")
        .trim();
}

function getXmlTag(xml, tag) {
    if (!xml) return "";
    const rx = new RegExp("<(?:[a-zA-Z0-9_.-]+:)?" + tag + "(?:\\s+[^>]*|\\s*)>([\\s\\S]*?)<\\/(?:[a-zA-Z0-9_.-]+:)?" + tag + ">", "i");
    const m = xml.match(rx);
    return m ? cleanXmlText(m[1]) : "";
}

function getAllXmlTags(xml, tag) {
    if (!xml) return [];
    const rx = new RegExp("<(?:[a-zA-Z0-9_.-]+:)?" + tag + "(?:\\s+[^>]*|\\s*)>([\\s\\S]*?)<\\/(?:[a-zA-Z0-9_.-]+:)?" + tag + ">", "gi");
    const res = [];
    let m;
    while ((m = rx.exec(xml)) !== null) {
        res.push(cleanXmlText(m[1]));
    }
    return res;
}

function normalizeDate(raw) {
    if (!raw) return "";
    const s = String(raw).trim();
    const full = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (full) return ymd(full[1], full[2], full[3]);
    const dot = s.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})/);
    if (dot) return ymd(dot[3], dot[2], dot[1]);
    const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (iso) return ymd(iso[1], iso[2], iso[3]);
    // Вісім цифр: M.E.Doc пише ддммрррр («30092026»), інші — ррррммдд.
    // Раніше першим перевірявся ррррммдд, і 30092026 ставало «3009-20-26».
    const eight = s.match(/^(\d{8})$/);
    if (eight) {
        const v = eight[1];
        return ymd(v.slice(4), v.slice(2, 4), v.slice(0, 2)) || ymd(v.slice(0, 4), v.slice(4, 6), v.slice(6));
    }
    return "";
}

function parseKop(raw) {
    if (raw === undefined || raw === null || raw === "") return 0;
    const n = parseMoney(raw);
    return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

function decodeTextBuffer(buffer) {
    if (!buffer) return "";
    const head = buffer.slice(0, 200).toString("latin1");
    const cp1251 = () => { try { return new TextDecoder("windows-1251").decode(buffer); } catch (_) { return null; } };
    if (/windows-1251|cp1251/i.test(head)) {
        const t = cp1251();
        if (t !== null) return t;
    }
    // UTF-8 з BOM або без; якщо байти не є коректним UTF-8 (типово для
    // старих файлів M.E.Doc без оголошення кодування) — пробуємо 1251.
    try {
        return new TextDecoder("utf-8", { fatal: true }).decode(buffer).replace(/^\uFEFF/, "");
    } catch (_) {
        return cp1251() ?? buffer.toString("utf8");
    }
}

/**
 * XML, вкладений у підписаний контейнер (.p7s, «.xml.p7s» з ЕДО).
 * Підпис CMS зберігає документ як є, тож XML можна знайти в байтах.
 */
function extractXmlFromSigned(buffer) {
    if (!buffer || !buffer.length) return "";
    // Корінь документа шукаємо в байтах: латинські теги (DECLAR, Invoice)
    // і кириличний корінь 1С у UTF-8 чи 1251.
    const roots = [["<?xml", null], ["<DECLAR", "DECLAR"], ["<Invoice", "Invoice"], ["<КоммерческаяИнформация", "КоммерческаяИнформация"]];
    let start = -1, rootName = null;
    for (const [marker, name] of roots) {
        for (const enc of ["utf8", "latin1"]) {
            const at = buffer.indexOf(Buffer.from(marker, enc === "utf8" ? "utf8" : "latin1"));
            if (at >= 0 && (start < 0 || at < start)) { start = at; rootName = name; }
        }
        if (start >= 0 && marker === "<?xml") break;
    }
    if (start < 0) return "";
    const tail = buffer.slice(start);
    if (!rootName) {
        // За оголошенням <?xml …?> іде корінь — беремо його назву.
        const m = tail.slice(0, 400).toString("latin1").replace(/^<\?xml[^>]*>\s*/, "").match(/^<([A-Za-z_][\w.:-]*)/);
        rootName = m ? m[1] : null;
        if (!rootName) {
            const u = tail.slice(0, 400).toString("utf8").replace(/^<\?xml[^>]*>\s*/, "").match(/^<([^\s>/]+)/);
            rootName = u ? u[1] : null;
        }
    }
    if (!rootName) return "";
    // Кінець — останній закривальний тег кореня в будь-якому з кодувань.
    let end = -1;
    for (const enc of ["utf8", "latin1"]) {
        const close = Buffer.from(`</${rootName}>`, enc);
        const at = tail.lastIndexOf(close);
        if (at >= 0) { end = Math.max(end, at + close.length); }
    }
    return end > 0 ? decodeTextBuffer(tail.slice(0, end)) : "";
}

const ZIP_MAX_ENTRY = 50 * 1024 * 1024;

function inflateEntry(method, comp) {
    if (method === 0) return comp;
    if (method !== 8) return null;
    try { return zlib.inflateRawSync(comp, { maxOutputLength: ZIP_MAX_ENTRY }); } catch (_) { return null; }
}

function zipName(buf, utf8Flag) {
    if (utf8Flag) return buf.toString("utf8");
    // Без прапорця UTF-8 Windows пише імена в CP866; ASCII-розширення
    // (.xml, .pdf) читаються однаково, тож назва лише для показу.
    try { return new TextDecoder("ibm866").decode(buf); } catch (_) { return buf.toString("latin1"); }
}

/**
 * Розпаковує ZIP за центральним каталогом. Розмір у локальному заголовку
 * буває нульовим (запис «потоком», з дескриптором даних після файлу) —
 * так пакують чимало систем ЕДО, і старий розбір такі файли губив.
 */
function unpackZip(buffer) {
    if (!buffer || buffer.length < 22) return [];
    let eocd = -1;
    for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65557); i--) {
        if (buffer.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) return unpackZipLocal(buffer);
    const count = buffer.readUInt16LE(eocd + 10);
    let p = buffer.readUInt32LE(eocd + 16);
    const files = [];
    for (let n = 0; n < count && p + 46 <= buffer.length; n++) {
        if (buffer.readUInt32LE(p) !== 0x02014b50) break;
        const flags = buffer.readUInt16LE(p + 8);
        const method = buffer.readUInt16LE(p + 10);
        const compSize = buffer.readUInt32LE(p + 20);
        const size = buffer.readUInt32LE(p + 24);
        const nameLen = buffer.readUInt16LE(p + 28);
        const extraLen = buffer.readUInt16LE(p + 30);
        const commentLen = buffer.readUInt16LE(p + 32);
        const local = buffer.readUInt32LE(p + 42);
        const name = zipName(buffer.slice(p + 46, p + 46 + nameLen), flags & 0x800);
        p += 46 + nameLen + extraLen + commentLen;
        if (name.endsWith("/") || size > ZIP_MAX_ENTRY || local + 30 > buffer.length || buffer.readUInt32LE(local) !== 0x04034b50) continue;
        const dataAt = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
        const data = inflateEntry(method, buffer.slice(dataAt, dataAt + compSize));
        if (data) files.push({ name, data, size: data.length });
    }
    return files.length ? files : unpackZipLocal(buffer);
}

/** Запасний розбір за локальними заголовками — для пошкоджених архівів без каталогу. */
function unpackZipLocal(buffer) {
    const files = [];
    let offset = 0;
    while (offset < buffer.length - 30) {
        if (buffer.readUInt32LE(offset) !== 0x04034b50) { offset++; continue; }
        const flags = buffer.readUInt16LE(offset + 6);
        const method = buffer.readUInt16LE(offset + 8);
        const compSize = buffer.readUInt32LE(offset + 18);
        const fnLen = buffer.readUInt16LE(offset + 26);
        const extraLen = buffer.readUInt16LE(offset + 28);
        const name = zipName(buffer.slice(offset + 30, offset + 30 + fnLen), flags & 0x800);
        const dataOffset = offset + 30 + fnLen + extraLen;
        const data = compSize ? inflateEntry(method, buffer.slice(dataOffset, dataOffset + compSize)) : null;
        if (data && !name.endsWith("/")) files.push({ name, data, size: data.length });
        offset = dataOffset + Math.max(compSize, 1);
    }
    return files;
}

function parseEdiXml(xml) {
    if (!xml || typeof xml !== "string") return null;
    const s = xml.trim();
    if (!s.includes("<") || !s.includes(">")) return null;

    let docType = "invoice";
    let number = "";
    let date = "";
    let supplierName = "";
    let supplierCode = "";
    let supplierIban = "";
    let amountKop = 0;
    let vatKop = 0;
    let desc = "";
    let contractName = "";
    let source = "edi";

    // 1. M.E.Doc / ПТАХ / СОТА format (<DECLAR>)
    if (/<DECLAR\b/i.test(s) || /<DECLARBODY\b/i.test(s)) {
        source = "medoc";
        const body = getXmlTag(s, "DECLARBODY") || s;
        const head = getXmlTag(s, "DECLARHEAD") || s;

        number = getXmlTag(body, "HNUM") || getXmlTag(head, "HNUM") || getXmlTag(head, "C_DOC_CNT");
        date = normalizeDate(getXmlTag(body, "HDATE") || getXmlTag(head, "D_FILL") || getXmlTag(head, "HFILL"));

        // HTINSEL/HNAMESEL/HTINBUY/HNAMEBUY — назви полів у документах
        // M.E.Doc із розділами «продавець/покупець».
        const tina = getXmlTag(body, "HTINSEL") || getXmlTag(body, "HTIN") || getXmlTag(head, "TIN");
        const tinb = getXmlTag(body, "HTINBUY") || getXmlTag(body, "HTIN_B") || getXmlTag(body, "TIN_B");
        const namea = getXmlTag(body, "HNAMESEL") || getXmlTag(body, "HNAME") || getXmlTag(body, "NAME");
        const nameb = getXmlTag(body, "HNAMEBUY") || getXmlTag(body, "HNAME_B") || getXmlTag(body, "NAME_B");
        const ibana = getXmlTag(body, "HIBAN") || getXmlTag(body, "IBAN");
        const ibanb = getXmlTag(body, "HIBAN_B") || getXmlTag(body, "IBAN_B");

        // Сторони: та, що не є самим ОСББ, — постачальник.
        if (isOwnCode(tina) && tinb && !isOwnCode(tinb)) {
            supplierCode = tinb;
            supplierName = nameb;
            supplierIban = ibanb;
        } else {
            supplierCode = tina;
            supplierName = namea;
            supplierIban = ibana;
        }

        // Податкова накладна: R04G11 — усього з ПДВ, R03G11 — сума ПДВ.
        amountKop = parseKop(getXmlTag(body, "R04G11") || getXmlTag(body, "R01G11") || getXmlTag(body, "R03G1") || getXmlTag(body, "SUM") || getXmlTag(body, "TOTAL"));
        vatKop = parseKop(getXmlTag(body, "R03G11") || getXmlTag(body, "R01G10") || getXmlTag(body, "R02G1") || getXmlTag(body, "PDV") || getXmlTag(body, "VAT"));

        desc = getXmlTag(body, "R03G1S") || getXmlTag(body, "DOC_NAME") || getXmlTag(body, "SUBJECT");
        const itemRows = getAllXmlTags(body, "T1RXXXXG4S").concat(getAllXmlTags(body, "T1RXXXXG3S"));
        if (itemRows.length && !desc) desc = itemRows.join("; ");

        contractName = getXmlTag(body, "DOGOVOR") || getXmlTag(body, "NUM_DOG");

        const cDocSub = getXmlTag(head, "C_DOC_SUB");
        const docName = (getXmlTag(body, "R01G1S") + " " + desc).toLowerCase();
        if (docName.includes("акт") || cDocSub === "010") docType = "act";
        else if (docName.includes("накладн")) docType = "waybill";
        else if (docName.includes("рахунок")) docType = "invoice";
    }
    // 2. 1C / BAS / CommerceML (<КоммерческаяИнформация>)
    else if (/<КоммерческаяИнформация(?:\s|>)/i.test(s) || /<Документ(?:\s|>)/i.test(s)) {
        source = "commerceml";
        const doc = getXmlTag(s, "Документ") || s;
        number = getXmlTag(doc, "Номер");
        date = normalizeDate(getXmlTag(doc, "Дата"));
        amountKop = parseKop(getXmlTag(doc, "Сумма"));
        vatKop = parseKop(getXmlTag(doc, "СуммаНДС") || getXmlTag(doc, "НДС"));

        const counterparties = getAllXmlTags(doc, "Контрагент");
        for (const cp of counterparties) {
            const role = getXmlTag(cp, "Роль").toLowerCase();
            // «Ид» — службовий GUID 1С, не код: беремо лише ЄДРПОУ/ІПН.
            const edr = [getXmlTag(cp, "ЕГРПОУ"), getXmlTag(cp, "ЄДРПОУ"), getXmlTag(cp, "ИНН")].map(v => String(v || "").replace(/\D/g, "")).find(v => /^\d{8}$|^\d{10}$/.test(v)) || "";
            if (isOwnCode(edr)) continue;
            if (role.includes("постав") || role.includes("продавец") || role.includes("продавець") || edr) {
                supplierName = getXmlTag(cp, "ОфициальноеНаименование") || getXmlTag(cp, "Наименование");
                supplierCode = edr;
                supplierIban = getXmlTag(cp, "НомерСчета") || getXmlTag(cp, "РасчетныйСчет");
                break;
            }
        }

        const items = getAllXmlTags(doc, "Товар").map(t => getXmlTag(t, "Наименование")).filter(Boolean);
        desc = items.join("; ") || getXmlTag(doc, "Комментарий");

        const op = getXmlTag(doc, "ХозяйственнаяОперация").toLowerCase();
        if (op.includes("услуг") || op.includes("акт")) docType = "act";
        else if (op.includes("заказ") || op.includes("счет")) docType = "invoice";
        else if (op.includes("постав") || op.includes("товар") || op.includes("накладн")) docType = "waybill";
    }
    // 3. UBL / Vchasno XML (<Invoice>, <Act>, etc.)
    else if (/<Invoice\b/i.test(s) || /<Act\b/i.test(s) || /<Waybill\b/i.test(s) || /<cac:AccountingSupplierParty\b/i.test(s)) {
        source = "vchasno_ubl";
        number = getXmlTag(s, "ID") || getXmlTag(s, "DocNumber") || getXmlTag(s, "Number");
        date = normalizeDate(getXmlTag(s, "IssueDate") || getXmlTag(s, "DocDate") || getXmlTag(s, "Date"));

        const supParty = getXmlTag(s, "AccountingSupplierParty") || getXmlTag(s, "Supplier") || s;
        supplierName = getXmlTag(supParty, "RegistrationName") || getXmlTag(supParty, "Name");
        supplierCode = getXmlTag(supParty, "CompanyID") || getXmlTag(supParty, "Edrpou") || getXmlTag(supParty, "TaxID");
        supplierIban = getXmlTag(supParty, "ID") || getXmlTag(supParty, "IBAN") || getXmlTag(s, "PaymentMeans");

        const totals = getXmlTag(s, "LegalMonetaryTotal") || s;
        amountKop = parseKop(getXmlTag(totals, "PayableAmount") || getXmlTag(totals, "TaxInclusiveAmount") || getXmlTag(s, "TotalAmount"));
        const tax = getXmlTag(s, "TaxTotal") || s;
        vatKop = parseKop(getXmlTag(tax, "TaxAmount") || getXmlTag(s, "VatAmount"));

        const items = getAllXmlTags(s, "Item").map(it => getXmlTag(it, "Name") || getXmlTag(it, "Description")).filter(Boolean);
        desc = items.join("; ") || getXmlTag(s, "Note");

        if (/<Act(?:\s|>)/i.test(s) || number.toLowerCase().includes("акт") || desc.toLowerCase().includes("акт") || desc.toLowerCase().includes("послуг")) docType = "act";
        else if (/<Waybill(?:\s|>)/i.test(s) || number.toLowerCase().includes("вн") || desc.toLowerCase().includes("накладн")) docType = "waybill";
    }

    if (!number && !supplierName && !amountKop && !supplierCode) return null;

    supplierCode = String(supplierCode || "").replace(/\D/g, "").slice(0, 10);
    if (isOwnCode(supplierCode)) supplierCode = "";
    supplierIban = String(supplierIban || "").replace(/\s+/g, "").toUpperCase();
    if (supplierIban && !/^UA\d{27}$/.test(supplierIban)) {
        const uaM = supplierIban.match(/UA\d{27}/);
        supplierIban = uaM ? uaM[0] : "";
    }
    if (isOwnIban(supplierIban)) supplierIban = "";

    number = String(number || "").replace(/^[№N#]\s*/i, "").trim();

    const { item, postingAcc } = suggestCategoryAndAccount(desc + " " + (contractName || ""), docType);

    return {
        docType,
        number,
        date,
        period: date ? date.slice(0, 7) : "",
        supplier: {
            name: supplierName.trim(),
            code: supplierCode,
            iban: supplierIban
        },
        amountKop,
        vatKop,
        item,
        postingAcc,
        contractName: contractName.trim(),
        description: desc.trim(),
        source
    };
}

function parseEdiJson(jsonText) {
    try {
        const j = typeof jsonText === "object" ? jsonText : JSON.parse(jsonText);
        if (!j) return null;
        const number = String(j.number || j.doc_number || j.id || "").replace(/^[№N#]\s*/i, "").trim();
        const date = normalizeDate(j.date || j.doc_date || j.issue_date);
        const supplierObj = j.supplier || j.seller || j.sender || {};
        const supplierName = String(supplierObj.name || j.supplier_name || "").trim();
        let supplierCode = String(supplierObj.code || supplierObj.edrpou || j.supplier_edrpou || "").replace(/\D/g, "").slice(0, 10);
        let supplierIban = String(supplierObj.iban || j.supplier_iban || "").replace(/\s+/g, "").toUpperCase();
        if (supplierIban && !supplierIban.startsWith("UA")) {
            const m = supplierIban.match(/UA\d{27}/);
            supplierIban = m ? m[0] : "";
        }
        let amountKop = 0;
        if (j.amountKop !== undefined) amountKop = Math.round(Number(j.amountKop));
        else if (j.amount !== undefined) amountKop = parseKop(j.amount);
        else if (j.total !== undefined) amountKop = parseKop(j.total);

        let vatKop = 0;
        if (j.vatKop !== undefined) vatKop = Math.round(Number(j.vatKop));
        else if (j.vat !== undefined) vatKop = parseKop(j.vat);

        const desc = String(j.description || j.subject || (Array.isArray(j.items) ? j.items.map(i => i.name || i.description).join("; ") : "") || "").trim();
        let docType = String(j.docType || j.doc_type || "").toLowerCase();
        if (!["invoice", "act", "waybill", "contract", "receipt"].includes(docType)) {
            docType = detectDocType(docType + " " + desc);
        }
        const { item, postingAcc } = suggestCategoryAndAccount(desc, docType);
        return {
            docType,
            number,
            date,
            period: date ? date.slice(0, 7) : "",
            supplier: { name: supplierName, code: supplierCode, iban: supplierIban },
            amountKop,
            vatKop,
            item,
            postingAcc,
            contractName: String(j.contractName || j.contract_name || "").trim(),
            description: desc,
            source: "vchasno_json"
        };
    } catch (_) {
        return null;
    }
}

function parseDocumentText(rawText) {
    const s = String(rawText || "").trim();
    if (s.startsWith("<") || s.startsWith("<?xml")) {
        const edi = parseEdiXml(s);
        if (edi) return edi;
    }
    if (s.startsWith("{") && s.endsWith("}")) {
        const jsonEdi = parseEdiJson(s);
        if (jsonEdi) return jsonEdi;
    }
    const text = cleanText(rawText);
    const docType = detectDocType(text);
    const number = extractDocNumber(text);
    const date = extractDocDate(text);
    const period = date ? date.slice(0, 7) : '';
    const iban = extractIban(text);
    const edrpou = extractEdrpou(text);
    const supplierName = extractSupplierName(text);
    const { totalKop, vatKop } = extractAmounts(text);
    const { paymentDueDays, contractEnd } = extractTerms(text);
    const { item, postingAcc } = suggestCategoryAndAccount(text, docType);

    return {
        docType,
        number,
        date,
        period,
        supplier: {
            name: supplierName,
            code: edrpou,
            iban
        },
        amountKop: totalKop,
        vatKop,
        item,
        postingAcc,
        paymentDueDays,
        contractEnd,
        description: supplierName ? `${docType === 'act' ? 'Акт робіт' : docType === 'invoice' ? 'Оплата за рахунком' : docType === 'contract' ? 'Договір' : 'Придбання'}: ${supplierName}` : ''
    };
}

const DOC_TYPES = ['invoice', 'act', 'waybill', 'contract', 'receipt'];
const ITEMS = ['lift', 'cleaning', 'waste', 'power', 'water', 'systems', 'repair', 'services', 'other'];
const POSTING = ['92', '20', '22', '11', '10'];

/**
 * Відповідь AI → той самий вигляд, що й у парсерів. Суми AI дає в
 * гривнях (у копійках моделі часто помиляються на порядок); свої код
 * та IBAN ОСББ відкидаються, решта перевіряється на формат.
 */
function normalizeAiResult(j) {
    if (!j || typeof j !== 'object') return null;
    const s = j.supplier && typeof j.supplier === 'object' ? j.supplier : {};
    let code = String(s.code ?? '').replace(/\D/g, '');
    if (![8, 10].includes(code.length) || isOwnCode(code)) code = '';
    let iban = String(s.iban ?? '').replace(/\s+/g, '').toUpperCase();
    iban = (iban.match(/UA\d{27}/) || [''])[0];
    if (isOwnIban(iban)) iban = '';
    const money = (uah, kopV) => {
        if (uah !== undefined && uah !== null && uah !== '') {
            const v = parseMoney(uah);
            return Number.isFinite(v) && v > 0 ? Math.round(v * 100) : 0;
        }
        const k = Math.round(Number(kopV));
        return Number.isFinite(k) && k > 0 ? k : 0;
    };
    const date = normalizeDate(j.date);
    const docType = DOC_TYPES.includes(j.docType) ? j.docType : detectDocType(String(j.docType || '') + ' ' + String(j.description || ''));
    const description = String(j.description || '').replace(/\s+/g, ' ').trim().slice(0, 300);
    const guess = suggestCategoryAndAccount(description, docType);
    return {
        docType,
        number: String(j.number ?? '').replace(/^[№N#]\s*/i, '').trim().slice(0, 40),
        date,
        period: /^\d{4}-\d{2}$/.test(String(j.period || '')) ? j.period : date.slice(0, 7),
        supplier: { name: String(s.name || '').replace(/\s+/g, ' ').trim().slice(0, 160), code, iban },
        amountKop: money(j.amount, j.amountKop),
        vatKop: money(j.vat, j.vatKop),
        item: ITEMS.includes(j.item) ? j.item : guess.item,
        postingAcc: POSTING.includes(String(j.postingAcc)) ? String(j.postingAcc) : guess.postingAcc,
        contractName: String(j.contractName || '').trim().slice(0, 160),
        contractEnd: normalizeDate(j.contractEnd),
        description,
        source: 'ai'
    };
}

/**
 * Що в розпізнаному варто перевірити очима. Не блокує — лише підказує
 * бухгалтеру, де розпізнавання могло схибити.
 */
function reviewRecognized(r, today = new Date().toISOString().slice(0, 10)) {
    const warnings = [];
    if (!r) return warnings;
    const code = String(r.supplier?.code || '');
    if (code && !((code.length === 8 && validEdrpou(code)) || (code.length === 10 && validRnokpp(code)))) warnings.push(`Код ${code} не пройшов перевірку контрольної цифри`);
    if (code && isOwnCode(code)) warnings.push('Код постачальника збігається з кодом ОСББ');
    const iban = String(r.supplier?.iban || '');
    if (iban && !validIban(iban)) warnings.push('IBAN не пройшов перевірку');
    if (r.vatKop && r.amountKop && r.vatKop >= r.amountKop) warnings.push('ПДВ не менший за суму документа');
    if (r.date && r.date > today) warnings.push('Дата документа в майбутньому');
    if (r.date && r.date < '2015-01-01') warnings.push('Дата документа надто давня');
    if (!r.amountKop) warnings.push('Суму не знайдено');
    return warnings;
}

function matchSupplierWithDatabase(recognizedSupplier, existingSuppliers = [], existingContracts = []) {
    if (!recognizedSupplier) return { matched: null, isNew: true, contract: null };

    const code = String(recognizedSupplier.code || '').trim();
    const iban = normIban(recognizedSupplier.iban || '');
    const nameLower = String(recognizedSupplier.name || '').trim().toLowerCase();

    // 1. Точний збіг за кодом ЄДРПОУ / РНОКПП
    if (code) {
        const found = existingSuppliers.find(s => String(s.code || '').trim() === code);
        if (found) {
            const contract = existingContracts.find(c => c.supplierId === found.id && c.status === 'approved') || null;
            return { matched: found, isNew: false, contract };
        }
    }

    // 2. Збіг за IBAN
    if (iban) {
        const found = existingSuppliers.find(s => normIban(s.iban || '') === iban);
        if (found) {
            const contract = existingContracts.find(c => c.supplierId === found.id && c.status === 'approved') || null;
            return { matched: found, isNew: false, contract };
        }
    }

    // 3. Збіг за назвою (без лапок і форми власності)
    if (nameLower.length > 3) {
        const cleanName = nameLower.replace(/(?:тов|пп|фоп|прат|пат|кп|«|»|")/gi, '').trim();
        const found = existingSuppliers.find(s => {
            const sName = String(s.name || '').toLowerCase().replace(/(?:тов|пп|фоп|прат|пат|кп|«|»|")/gi, '').trim();
            return cleanName && sName && (sName.includes(cleanName) || cleanName.includes(sName));
        });
        if (found) {
            const contract = existingContracts.find(c => c.supplierId === found.id && c.status === 'approved') || null;
            return { matched: found, isNew: false, contract };
        }
    }

    return { matched: null, isNew: true, contract: null };
}

module.exports = {
    setOwnRequisites,
    parseMoney,
    normalizeDate,
    extractXmlFromSigned,
    reviewRecognized,
    normalizeAiResult,
    detectDocType,
    extractDocNumber,
    extractDocDate,
    extractIban,
    extractEdrpou,
    extractSupplierName,
    extractAmounts,
    extractTerms,
    suggestCategoryAndAccount,
    parseDocumentText,
    matchSupplierWithDatabase,
    parseEdiXml,
    parseEdiJson,
    unpackZip,
    decodeTextBuffer
};