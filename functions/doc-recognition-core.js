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

function parseDocumentText(rawText) {
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
    matchSupplierWithDatabase
};