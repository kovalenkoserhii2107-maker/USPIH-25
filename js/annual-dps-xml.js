// ============================================================
// Клієнтське дзеркало генерації XML річної звітності ДПС (ES-модуль)
// ============================================================

export const SOFTWARE = "OSBB Uspikh-25 accounting";

export const DOCS = {
    npo: { doc: "J01", sub: "019", ver: "12", name: "J0101912" },
    fs: { doc: "J09", sub: "012", ver: "06", name: "J0901206" }
};

const esc = v => String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const pad = (v, n) => String(v ?? "").padStart(n, "0");
const dmy = iso => (iso ? `${iso.slice(8, 10)}${iso.slice(5, 7)}${iso.slice(0, 4)}` : "");
const el = (name, value) => (value === null || value === undefined || value === "" ? "" : `<${name}>${esc(value)}</${name}>`);
const fmtGrn = kop => String(Math.round(Number(kop || 0) / 100));
const fmtUnits = units => (units == null ? "" : (Number(units) / 10).toFixed(1));

export function filename(h) {
    return `${pad(h.reg, 2)}${pad(h.raj, 2)}${pad(h.tin, 10)}${h.doc}${pad(h.sub, 3)}${pad(h.ver, 2)}${h.stan}${pad(h.type, 2)}${pad(h.cnt, 7)}412${h.year}${pad(h.sti, 4)}.xml`;
}

export function head(h, linked = []) {
    const docs = linked.map((d, i) => `<DOC NUM="${i + 1}" TYPE="1">`
        + `<C_DOC>${d.doc}</C_DOC><C_DOC_SUB>${d.sub}</C_DOC_SUB><C_DOC_VER>${d.ver}</C_DOC_VER>`
        + `<C_DOC_TYPE>${d.type}</C_DOC_TYPE><C_DOC_CNT>${d.cnt}</C_DOC_CNT><C_DOC_STAN>${h.stan}</C_DOC_STAN>`
        + `<FILENAME>${esc(d.file)}</FILENAME></DOC>`).join("");

    return `<DECLARHEAD><TIN>${esc(pad(h.tin, 10))}</TIN><C_DOC>${h.doc}</C_DOC><C_DOC_SUB>${pad(h.sub, 3)}</C_DOC_SUB><C_DOC_VER>${pad(h.ver, 2)}</C_DOC_VER>`
        + `<C_DOC_TYPE>${h.type}</C_DOC_TYPE><C_DOC_CNT>${h.cnt}</C_DOC_CNT><C_REG>${h.reg}</C_REG><C_RAJ>${h.raj}</C_RAJ>`
        + `<PERIOD_MONTH>12</PERIOD_MONTH><PERIOD_TYPE>4</PERIOD_TYPE><PERIOD_YEAR>${h.year}</PERIOD_YEAR><C_STI_ORIG>${h.sti}</C_STI_ORIG>`
        + `<C_DOC_STAN>${h.stan}</C_DOC_STAN>${docs ? `<LINKED_DOCS>${docs}</LINKED_DOCS>` : ""}`
        + `<D_FILL>${h.fill}</D_FILL><SOFTWARE>${SOFTWARE}</SOFTWARE></DECLARHEAD>`;
}

export const wrap = (xsd, headXml, body) => `<?xml version="1.0" encoding="windows-1251"?>\n<DECLAR xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="${xsd}.xsd">${headXml}<DECLARBODY>${body}</DECLARBODY></DECLAR>\n`;

const EXTRA = { 0x401: 0xA8, 0x451: 0xB8, 0x404: 0xAA, 0x454: 0xBA, 0x406: 0xB2, 0x456: 0xB3, 0x407: 0xAF, 0x457: 0xBF, 0x490: 0xA5, 0x491: 0xB4,
    0x2116: 0xB9, 0xAB: 0xAB, 0xBB: 0xBB, 0x2014: 0x97, 0x2013: 0x96, 0x2019: 0x92, 0x2018: 0x91, 0x201C: 0x93, 0x201D: 0x94, 0x2BC: 0x92, 0xA0: 0xA0 };

export function encode1251(text) {
    const out = new Uint8Array(text.length);
    let n = 0;
    for (const ch of text) {
        const c = ch.codePointAt(0);
        out[n++] = c < 0x80 ? c : c >= 0x410 && c <= 0x44F ? c - 0x350 : EXTRA[c] ?? 0x3F;
    }
    return out.subarray(0, n);
}
