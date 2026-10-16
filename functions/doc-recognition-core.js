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

function extractDocNumber(text) {
    const s = cleanText(text);
    const m = s.match(/(?:№|номер|ном\.?|no\.?)\s*[:.]?\s*([A-Za-zА-Яа-яІіЇїЄє0-9\-_/]{1,30})/i)
        || s.match(/\b(?:СФ|РХ|АКТ|ВН|ЧЕК|ФЧ)[-\s]?([0-9\-_/]{1,25})\b/i);
    return m ? m[1].trim() : '';
}

function extractDocDate(text) {
    const s = cleanText(text);

    const textDate = s.match(/[«"]?(\d{1,2})[»"]?\s+([а-яіїєґ]+)\s+(\d{4})/i);
    if (textDate) {
        const day = String(textDate[1]).padStart(2, '0');
        const month = UKR_MONTHS[textDate[2].toLowerCase()];
        const year = textDate[3];
        if (month) return `${year}-${month}-${day}`;
    }

    const numDate = s.match(/\b(\d{1,2})[./-](\d{1,2})[./-](\d{4})\b/);
    if (numDate) {
        const d = String(numDate[1]).padStart(2, '0');
        const m = String(numDate[2]).padStart(2, '0');
        const y = numDate[3];
        return `${y}-${m}-${d}`;
    }

    const isoDate = s.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
    if (isoDate) return isoDate[0];

    return '';
}

function extractIban(text) {
    const s = cleanText(text).replace(/\s+/g, ' ');
    const matches = s.match(/UA\s*(?:\d\s*){27}/gi) || [];
    let fallback = '';
    for (const m of matches) {
        const clean = normIban(m);
        if (/^UA\d{27}$/.test(clean)) {
            if (validIban(clean)) return clean;
            if (!fallback) fallback = clean;
        }
    }
    return fallback;
}

function extractEdrpou(text) {
    const s = cleanText(text);

    const labelled = s.match(/(?:єДРПОУ|едрпоу|код\s+за\s+єдрпоу|код\s+єдрпоу|рнокпп|ідентифікаційний\s+код|код\s+платника|код)[\s:№.]*(\d{8,10})\b/i);
    if (labelled) {
        const code = labelled[1];
        if (code.length === 8 && validEdrpou(code)) return code;
        if (code.length === 10 && validRnokpp(code)) return code;
        return code;
    }

    const words = s.match(/\b\d{8}\b/g) || [];
    for (const w of words) {
        if (validEdrpou(w)) return w;
    }

    const fopCodes = s.match(/\b\d{10}\b/g) || [];
    for (const w of fopCodes) {
        if (validRnokpp(w)) return w;
    }

    return '';
}

function extractSupplierName(text) {
    const s = cleanText(text);

    const m = s.match(/\b(?:ТОВ|ПП|ПрАТ|ПАТ|КП|ТзОВ)\s*(?:«[^»]+»|"[^"]+"|[А-ЯІЇЄҐ][\w\s\-]+)/i)
        || s.match(/\bФОП\s+[А-ЯІЇЄҐ][а-яіїєґ']+\s+[А-ЯІЇЄҐ]\.?\s*[А-ЯІЇЄҐ]?\.?/i)
        || s.match(/Постачальник[:\s]+([^\n,;]{3,80})/i)
        || s.match(/Виконавець[:\s]+([^\n,;]{3,80})/i);

    if (m) {
        return m[1] ? m[1].trim() : m[0].trim();
    }
    return '';
}

function extractAmounts(text) {
    const s = cleanText(text);

    let totalKop = 0;
    let vatKop = 0;

    // Пріоритет: 1) "Всього до сплати" / "Разом до сплати" 2) "Всього" / "Разом" 3) "Сума"
    const sumMatch = s.match(/(?:всього\s+до\s+сплати|разом\s+до\s+сплати|до\s+сплати)(?:[^\n:]{0,35})[:\s]+(\d+[\d\s\u00A0.,]*\d)\s*(?:грн|uah)?/i)
        || s.match(/(?:разом|всього|загальна\s+вартість)(?:[^\n:]{0,35})[:\s]+(\d+[\d\s\u00A0.,]*\d)\s*(?:грн|uah)?/i)
        || s.match(/(?<!без\s+)(?:сума|вартість|ціна)(?:[^\n:]{0,35})[:\s]+(\d+[\d\s\u00A0.,]*\d)\s*(?:грн|uah)?/i)
        || s.match(/\b(\d+[\d\s\u00A0]*[.,]\d{2})\s*(?:грн|uah)\b/i);

    if (sumMatch) {
        const cleanNum = sumMatch[1].replace(/[\s\u00A0]/g, '').replace(',', '.');
        const parsed = parseFloat(cleanNum);
        if (Number.isFinite(parsed) && parsed > 0) {
            totalKop = Math.round(parsed * 100);
        }
    }

    // Шукаємо суму ПДВ порядково, ігноруючи "без ПДВ"
    for (const line of s.split('\n')) {
        if (/без\s+пдв/i.test(line)) continue;
        const vm = line.match(/(?:у\s+т\.?ч\.?\s+)?(?<![а-яіїєґ])пдв(?![а-яіїєґ])(?:\s*(?:20\s*%|\(20%\)))?[:\s]*(\d+[\d\s\u00A0.,]*\d)/i);
        if (vm) {
            const cleanVat = vm[1].replace(/[\s\u00A0]/g, '').replace(',', '.');
            const parsedVat = parseFloat(cleanVat);
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
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
    const dot = s.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/);
    if (dot) return `${dot[3]}-${dot[2].padStart(2, "0")}-${dot[1].padStart(2, "0")}`;
    const isoComp = s.match(/^(\d{4})(\d{2})(\d{2})$/);
    if (isoComp) return `${isoComp[1]}-${isoComp[2]}-${isoComp[3]}`;
    const ddmmyyyy = s.match(/^(\d{2})(\d{2})(\d{4})$/);
    if (ddmmyyyy) return `${ddmmyyyy[3]}-${ddmmyyyy[2]}-${ddmmyyyy[1]}`;
    return "";
}

function parseKop(raw) {
    if (raw === undefined || raw === null || raw === "") return 0;
    const clean = String(raw).replace(/[\s\u00A0]/g, "").replace(",", ".");
    const n = parseFloat(clean);
    return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

function decodeTextBuffer(buffer) {
    if (!buffer) return "";
    const head = buffer.slice(0, 150).toString("latin1");
    if (/windows-1251|cp1251/i.test(head)) {
        try {
            return new TextDecoder("windows-1251").decode(buffer);
        } catch (_) {}
    }
    try {
        return new TextDecoder("utf-8").decode(buffer);
    } catch (_) {
        return buffer.toString("utf8");
    }
}

function unpackZip(buffer) {
    if (!buffer || buffer.length < 30) return [];
    const files = [];
    let offset = 0;
    while (offset < buffer.length - 30) {
        if (buffer[offset] === 0x50 && buffer[offset + 1] === 0x4B && buffer[offset + 2] === 0x03 && buffer[offset + 3] === 0x04) {
            const compMethod = buffer.readUInt16LE(offset + 8);
            const compSize = buffer.readUInt32LE(offset + 18);
            const uncompSize = buffer.readUInt32LE(offset + 22);
            const fnLen = buffer.readUInt16LE(offset + 26);
            const extraLen = buffer.readUInt16LE(offset + 28);

            const fnBuffer = buffer.slice(offset + 30, offset + 30 + fnLen);
            let filename = "";
            try { filename = new TextDecoder("utf-8").decode(fnBuffer); } catch (_) { filename = fnBuffer.toString("utf8"); }

            const dataOffset = offset + 30 + fnLen + extraLen;
            const compData = buffer.slice(dataOffset, dataOffset + compSize);

            let data = null;
            if (compMethod === 0) {
                data = compData;
            } else if (compMethod === 8) {
                try {
                    data = zlib.inflateRawSync(compData);
                } catch (_) {
                    try { data = zlib.inflateSync(compData); } catch (_) {}
                }
            }
            if (data) {
                files.push({ name: filename, data, size: uncompSize });
            }
            offset = dataOffset + compSize;
        } else if (buffer[offset] === 0x50 && buffer[offset + 1] === 0x4B && (buffer[offset + 2] === 0x01 || buffer[offset + 2] === 0x05)) {
            break;
        } else {
            offset++;
        }
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

        const tina = getXmlTag(body, "HTIN") || getXmlTag(head, "TIN");
        const tinb = getXmlTag(body, "HTIN_B") || getXmlTag(body, "TIN_B");
        const namea = getXmlTag(body, "HNAME") || getXmlTag(body, "NAME");
        const nameb = getXmlTag(body, "HNAME_B") || getXmlTag(body, "NAME_B");
        const ibana = getXmlTag(body, "HIBAN") || getXmlTag(body, "IBAN");
        const ibanb = getXmlTag(body, "HIBAN_B") || getXmlTag(body, "IBAN_B");

        if (tina === "40562894" && tinb && tinb !== "40562894") {
            supplierCode = tinb;
            supplierName = nameb;
            supplierIban = ibanb;
        } else {
            supplierCode = tina;
            supplierName = namea;
            supplierIban = ibana;
        }

        amountKop = parseKop(getXmlTag(body, "R01G11") || getXmlTag(body, "R03G1") || getXmlTag(body, "SUM") || getXmlTag(body, "TOTAL"));
        vatKop = parseKop(getXmlTag(body, "R01G10") || getXmlTag(body, "R02G1") || getXmlTag(body, "PDV") || getXmlTag(body, "VAT"));

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
            const edr = getXmlTag(cp, "ЕГРПОУ") || getXmlTag(cp, "ИНН") || getXmlTag(cp, "Ид");
            if (role.includes("постав") || role.includes("продавец") || (edr && edr !== "40562894")) {
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
    supplierIban = String(supplierIban || "").replace(/\s+/g, "").toUpperCase();
    if (supplierIban && !supplierIban.startsWith("UA")) {
        const uaM = supplierIban.match(/UA\d{27}/);
        supplierIban = uaM ? uaM[0] : "";
    }

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