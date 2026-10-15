'use strict';
// ============================================================
// Річна звітність ДПС:
// 1. J0101912 — Звіт про використання доходів (прибутків)
//    неприбуткової організації (наказ Мінфіну № 553 у редакції № 469)
// 2. J0901206 — Фінансова звітність мікропідприємства
//    (Форма № 1-мс «Баланс» та Форма № 2-мс «Звіт про фінансові
//    результати» за НП(С)БО 25)
//
// Файли формуються у кодуванні windows-1251 за стандартом ДПС
// з взаємним звʼязком через LINKED_DOCS для завантаження в
// Електронний кабінет ДПС або M.E.Doc / Сонату.
// ============================================================

const SOFTWARE = "OSBB Uspikh-25 accounting";
const { encode1251, orgProblems } = require("./dps-xml");
const { validDate } = require("./expenses-core");

const DOCS = {
    npo: { doc: "J01", sub: "019", ver: "12", name: "J0101912" },
    fs: { doc: "J09", sub: "012", ver: "06", name: "J0901206" }
};

const esc = v => String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const pad = (v, n) => String(v ?? "").padStart(n, "0");
const dmy = iso => (iso ? `${iso.slice(8, 10)}${iso.slice(5, 7)}${iso.slice(0, 4)}` : "");
const el = (name, value) => (value === null || value === undefined || value === "" ? "" : `<${name}>${esc(value)}</${name}>`);
const fmtGrn = kop => String(Math.round(Number(kop || 0) / 100));
const fmtUnits = units => (units == null ? "" : (Number(units) / 10).toFixed(1));

function filename(h) {
    return `${pad(h.reg, 2)}${pad(h.raj, 2)}${pad(h.tin, 10)}${h.doc}${pad(h.sub, 3)}${pad(h.ver, 2)}${h.stan}${pad(h.type, 2)}${pad(h.cnt, 7)}412${h.year}${pad(h.sti, 4)}.xml`;
}

function head(h, linked = []) {
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

const wrap = (xsd, headXml, body) => `<?xml version="1.0" encoding="windows-1251"?>\n<DECLAR xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="${xsd}.xsd">${headXml}<DECLARBODY>${body}</DECLARBODY></DECLAR>\n`;

function buildAnnualPackage({ year, org, report, calculation, fillDate, num = 1, stan = 1 }) {
    const problems = orgProblems(org);
    if (!/^20\d{2}$/.test(String(year || ""))) problems.push("Оберіть правильний звітний рік");
    if (!validDate(fillDate)) problems.push("Вкажіть правильну дату складання звітності");
    if (!calculation) problems.push("Розрахунок річних форм не виконано");
    if (calculation && !calculation.reviewReady) {
        problems.push(...(calculation.checks || []).filter(c => c.level === "block").map(c => c.text));
    }
    if (stan !== 1) {
        problems.push("Автоматичне формування доступне для звітного пакета (стан 1). Уточнюючі пакети складаються в Електронному кабінеті.");
    }

    if (problems.length) {
        return { files: [], problems, totals: null };
    }

    const yr = Number(year);
    const sti = org.sti || { reg: 15, raj: 53, code: 1553, name: "" };
    const kved = (String(org.kved || "").match(/\d{2}\.\d{2}/) || ["81.10"])[0];
    const fill = dmy(fillDate);

    const baseHeader = {
        reg: sti.reg,
        raj: sti.raj,
        tin: org.edrpou,
        type: "00",
        cnt: pad(num, 7),
        year: yr,
        sti: sti.code,
        stan: String(stan),
        fill
    };

    const npoFile = filename({ ...baseHeader, ...DOCS.npo });
    const fsFile = filename({ ...baseHeader, ...DOCS.fs });

    const linkedForNpo = [{ ...DOCS.fs, type: 0, cnt: 1, file: fsFile }];
    const linkedForFs = [{ ...DOCS.npo, type: 0, cnt: 1, file: npoFile }];

    // 1. J0101912: Звіт неприбуткової організації
    const npoRows = calculation.npoRows || [];
    const npoTotals = calculation.npoTotals || { incomeKop: 0, costKop: 0 };

    let npoDetailsXml = "";
    for (const r of npoRows) {
        const code = String(r.code || "").trim();
        if (code.startsWith("1.")) {
            const sub = code.slice(2);
            npoDetailsXml += `<R01${sub}G3>${fmtGrn(r.kop)}</R01${sub}G3>`;
        } else if (code.startsWith("2.")) {
            const sub = code.slice(2);
            npoDetailsXml += `<R02${sub}G3>${fmtGrn(r.kop)}</R02${sub}G3>`;
        }
    }

    const npoBody = `<HZ>1</HZ>`
        + `${el("HNAME", org.name)}${el("HTIN", org.edrpou)}${el("HKATOTTG", org.katottg)}`
        + `${el("HLOC", org.address)}${el("HZIP", org.zip)}${el("HTEL", org.phone)}${el("HEMAIL", org.email)}`
        + `${el("HSTI", sti.name)}${el("HZY", yr)}`
        + `<R01G3>${fmtGrn(npoTotals.incomeKop)}</R01G3>`
        + npoDetailsXml
        + `<R02G3>${fmtGrn(npoTotals.costKop)}</R02G3>`
        + `<HFZ>1</HFZ><HNPBO>1</HNPBO><HFZ1>1</HFZ1>`
        + `${el("HKB", org.headName)}${el("HTINB", org.headTin)}`
        + (org.accTin ? `${el("HBUH", org.accName)}${el("HTINBUH", org.accTin)}` : "");

    const npoXml = wrap(DOCS.npo.name, head({ ...baseHeader, ...DOCS.npo }, linkedForNpo), npoBody);

    // 2. J0901206: Фінансова звітність мікропідприємства (1-мс + 2-мс)
    const balance = calculation.balance || [];
    const results = calculation.results || [];

    let balanceXml = "";
    for (const r of balance) {
        const c = String(r.code || "").trim();
        balanceXml += `<R${c}G3>${fmtUnits(r.startUnits)}</R${c}G3><R${c}G4>${fmtUnits(r.endUnits)}</R${c}G4>`;
    }

    let resultsXml = "";
    for (const r of results) {
        const c = String(r.code || "").trim();
        resultsXml += `<R${c}G3>${fmtUnits(r.units)}</R${c}G3>`;
        if (r.previousUnits != null) {
            resultsXml += `<R${c}G4>${fmtUnits(r.previousUnits)}</R${c}G4>`;
        }
    }

    const fsBody = `${el("HNAME", org.name)}${el("HTIN", org.edrpou)}${el("HKATOTTG", org.katottg)}`
        + `${el("HKVED", kved)}<HKOPFG>840</HKOPFG>${el("HLOC", org.address)}${el("HZY", yr)}`
        + balanceXml
        + resultsXml
        + `${el("HKB", org.headName)}${el("HTINB", org.headTin)}`
        + (org.accTin ? `${el("HBUH", org.accName)}${el("HTINBUH", org.accTin)}` : "");

    const fsXml = wrap(DOCS.fs.name, head({ ...baseHeader, ...DOCS.fs }, linkedForFs), fsBody);

    const files = [
        { name: npoFile, doc: "npo", title: "Звіт неприбуткової організації (J0101912)", xml: npoXml },
        { name: fsFile, doc: "fs", title: "Фінансова звітність 1-мс / 2-мс (J0901206)", xml: fsXml }
    ];

    const totals = {
        incomeKop: npoTotals.incomeKop,
        costKop: npoTotals.costKop,
        balanceStartKop: balance.find(r => r.code === "1300")?.startKop || 0,
        balanceEndKop: balance.find(r => r.code === "1300")?.endKop || 0
    };

    return { files, problems: [], totals };
}

module.exports = {
    DOCS,
    filename,
    head,
    wrap,
    encode1251,
    buildAnnualPackage
};
