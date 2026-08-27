// ============================================================
// Складання файлу .xlsx без бібліотек.
//
// xlsx — це ZIP із кількох XML. Рядки пишемо inline (t="inlineStr"),
// а не через спільну таблицю рядків: та економить місце у великих
// книгах, але для трьохсот квартир різниця мізерна, зате коду вдвічі
// менше й нічим помилитися.
//
// Стискання не застосовуємо (метод «збережено»): валідний ZIP, на
// кілька сотень кілобайт більший — і жодної асинхронності з
// CompressionStream, яка могла б підвести на старому браузері.
// ============================================================

const enc = new TextEncoder();

// ------------------------------------------------------------
// CRC32 — обовʼязковий у заголовку кожного запису ZIP
// ------------------------------------------------------------
const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
        let c = i;
        for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        t[i] = c >>> 0;
    }
    return t;
})();

function crc32(bytes) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
}

// ------------------------------------------------------------
// ZIP
// ------------------------------------------------------------
function zip(files) {
    const parts = [];
    const central = [];
    let offset = 0;

    const u16 = (v) => [v & 0xFF, (v >>> 8) & 0xFF];
    const u32 = (v) => [v & 0xFF, (v >>> 8) & 0xFF, (v >>> 16) & 0xFF, (v >>> 24) & 0xFF];

    for (const { name, data } of files) {
        const nameBytes = enc.encode(name);
        const crc = crc32(data);
        // Прапорець 0x0800 — імена у UTF-8. Без нього кирилиця в назвах
        // файлів усередині архіву читалася б як завгодно.
        const head = [
            ...u32(0x04034b50), ...u16(20), ...u16(0x0800), ...u16(0),
            ...u16(0), ...u16(0),                     // час і дата — нулі, вони ні на що не впливають
            ...u32(crc), ...u32(data.length), ...u32(data.length),
            ...u16(nameBytes.length), ...u16(0)
        ];
        parts.push(new Uint8Array(head), nameBytes, data);

        central.push([
            ...u32(0x02014b50), ...u16(20), ...u16(20), ...u16(0x0800), ...u16(0),
            ...u16(0), ...u16(0),
            ...u32(crc), ...u32(data.length), ...u32(data.length),
            ...u16(nameBytes.length), ...u16(0), ...u16(0), ...u16(0), ...u16(0),
            ...u32(0), ...u32(offset),
            ...Array.from(nameBytes)
        ]);
        offset += head.length + nameBytes.length + data.length;
    }

    const dir = new Uint8Array(central.flat());
    const end = new Uint8Array([
        ...u32(0x06054b50), ...u16(0), ...u16(0),
        ...u16(files.length), ...u16(files.length),
        ...u32(dir.length), ...u32(offset), ...u16(0)
    ]);
    return new Blob([...parts, dir, end], {
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    });
}

// ------------------------------------------------------------
// XML
// ------------------------------------------------------------
/**
 * Керівні символи в XML заборонені, і Excel відмовиться відкривати
 * книгу з ними. У даних з чужих систем вони трапляються, тож чистимо.
 */
function xmlText(v) {
    return String(v ?? '')
        // eslint-disable-next-line no-control-regex
        .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '')
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

/** 0 → A, 25 → Z, 26 → AA */
export function colName(i) {
    let s = '';
    for (let n = i; n >= 0; n = Math.floor(n / 26) - 1) {
        s = String.fromCharCode(65 + (n % 26)) + s;
    }
    return s;
}

const isNum = (v) => typeof v === 'number' && isFinite(v);

function sheetXml(rows) {
    const body = rows.map((row, r) => {
        const cells = row.map((v, c) => {
            if (v === null || v === undefined || v === '') return '';
            const ref = `${colName(c)}${r + 1}`;
            return isNum(v)
                ? `<c r="${ref}"><v>${v}</v></c>`
                : `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xmlText(v)}</t></is></c>`;
        }).join('');
        return `<row r="${r + 1}">${cells}</row>`;
    }).join('');

    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${body}</sheetData></worksheet>`;
}

/**
 * @param {string} sheetName назва аркуша
 * @param {Array<Array<string|number|null>>} rows перший рядок — заголовок
 * @returns {Blob} готовий файл .xlsx
 */
export function buildXlsx(sheetName, rows) {
    // Excel забороняє в назві аркуша : \ / ? * [ ] і більше 31 символа
    const name = xmlText(String(sheetName || 'Аркуш').replace(/[:\\/?*[\]]/g, ' ').slice(0, 31));

    const files = [
        ['[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
</Types>`],
        ['_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`],
        ['xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets><sheet name="${name}" sheetId="1" r:id="rId1"/></sheets></workbook>`],
        ['xl/_rels/workbook.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
</Relationships>`],
        ['xl/worksheets/sheet1.xml', sheetXml(rows)]
    ];

    return zip(files.map(([name, xml]) => ({ name, data: enc.encode(xml) })));
}

/** Віддає файл користувачеві. */
export function saveBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}
