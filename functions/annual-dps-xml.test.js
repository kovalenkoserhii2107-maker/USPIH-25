'use strict';
const test = require("node:test");
const assert = require("node:assert/strict");
const annualDps = require("./annual-dps-xml");
const formsCore = require("./annual-forms-core");

const org = {
    edrpou: "40562894",
    name: "ОСББ «УСПІХ-25»",
    katottg: "UA51100270010069184",
    address: "м. Одеса, вул. Академіка Корольова, 25",
    zip: "65114",
    phone: "+380487000000",
    email: "uspih25@example.com",
    kved: "81.10 Комплексне обслуговування обʼєктів",
    sti: { reg: 15, raj: 53, code: 1553, name: "ГУ ДПС В ОДЕСЬКІЙ ОБЛАСТІ, ОДЕСЬКА ДПІ" },
    headName: "Голова Сергій Миколайович",
    headTin: "3124567809",
    accName: "Бухгалтер Олена Петрівна",
    accTin: "3124567821"
};

function createSampleCalculation() {
    const osv = [
        { acc: "10", openDr: 10000000, openCr: 0, dr: 0, cr: 0, closeDr: 10000000, closeCr: 0 },
        { acc: "131", openDr: 0, openCr: 2000000, dr: 0, cr: 0, closeDr: 0, closeCr: 2000000 },
        { acc: "20", openDr: 1500000, openCr: 0, dr: 0, cr: 0, closeDr: 1500000, closeCr: 0 },
        { acc: "311", openDr: 4500000, openCr: 0, dr: 0, cr: 0, closeDr: 4500000, closeCr: 0 },
        { acc: "372", openDr: 500000, openCr: 0, dr: 0, cr: 0, closeDr: 500000, closeCr: 0 },
        { acc: "48", openDr: 0, openCr: 14500000, dr: 0, cr: 0, closeDr: 0, closeCr: 14500000 }
    ];
    const rep = {
        year: "2026",
        reportingForm: "micro",
        complete: true,
        osv,
        entries: [
            { date: "2026-10-15", dr: "92", cr: "372", kop: 250000, dA: "office", cA: "Іваненко" },
            { date: "2026-10-15", dr: "48", cr: "719", kop: 250000, dA: "main", cA: "Цільове фінансування" }
        ],
        income: [{ acc: "719", kop: 250000 }],
        previousIncome: { incomeKop: 0, costKop: 0 },
        summary: { incomeKop: 250000, costKop: 250000, resultKop: 0 }
    };
    const settings = {
        financingTerm: "current",
        noIncomeTax: true,
        noViolation: true,
        comparatives: {
            salesKop: 0,
            operatingKop: 0,
            otherKop: 0,
            costOfSalesKop: 0,
            otherOperatingCostKop: 0,
            otherCostKop: 0
        },
        assignments: {
            "cost:92:office": { category: "maintenance", row: "2.3" },
            "income:719:fund-main": { category: "contributions", row: "1.6" }
        }
    };
    return { rep, calc: formsCore.build(rep, settings) };
}

test("генерація назв файлів за форматом ДПС (43 символи + .xml)", () => {
    const h = {
        reg: 15,
        raj: 53,
        tin: "40562894",
        doc: "J01",
        sub: "019",
        ver: "12",
        stan: 1,
        type: "00",
        cnt: "0000001",
        year: 2026,
        sti: 1553
    };
    const fname = annualDps.filename(h);
    assert.equal(fname, "15530040562894J0101912100000000141220261553.xml");
    assert.equal(fname.length, 47);
});

test("формування річного пакета: наявність J0101912 та J0901206 і звʼязок через LINKED_DOCS", () => {
    const { rep, calc } = createSampleCalculation();
    assert.equal(calc.reviewReady, true);

    const out = annualDps.buildAnnualPackage({
        year: "2026",
        org,
        report: rep,
        calculation: calc,
        fillDate: "2026-10-14"
    });

    assert.equal(out.problems.length, 0);
    assert.equal(out.files.length, 2);

    const [npoFile, fsFile] = out.files;
    assert.equal(npoFile.doc, "npo");
    assert.equal(fsFile.doc, "fs");

    assert.match(npoFile.xml, new RegExp(`<LINKED_DOCS><DOC NUM="1" TYPE="1"><C_DOC>J09</C_DOC><C_DOC_SUB>012</C_DOC_SUB><C_DOC_VER>06</C_DOC_VER>.*<FILENAME>${fsFile.name}</FILENAME></DOC></LINKED_DOCS>`));
    assert.match(fsFile.xml, new RegExp(`<LINKED_DOCS><DOC NUM="1" TYPE="1"><C_DOC>J01</C_DOC><C_DOC_SUB>019</C_DOC_SUB><C_DOC_VER>12</C_DOC_VER>.*<FILENAME>${npoFile.name}</FILENAME></DOC></LINKED_DOCS>`));

    assert.match(npoFile.xml, /<HNAME>ОСББ «УСПІХ-25»<\/HNAME>/);
    assert.match(npoFile.xml, /<HTIN>40562894<\/HTIN>/);
    assert.match(npoFile.xml, /<HKATOTTG>UA51100270010069184<\/HKATOTTG>/);
    assert.match(npoFile.xml, /<HZY>2026<\/HZY>/);
    assert.match(npoFile.xml, /<R01G3>2500<\/R01G3>/);
    assert.match(npoFile.xml, /<R016G3>2500<\/R016G3>/);
    assert.match(npoFile.xml, /<R02G3>2500<\/R02G3>/);
    assert.match(npoFile.xml, /<R023G3>2500<\/R023G3>/);
    assert.match(npoFile.xml, /<HFZ>1<\/HFZ>/);
    assert.match(npoFile.xml, /<HFZ1>1<\/HFZ1>/);

    assert.match(fsFile.xml, /<HKOPFG>840<\/HKOPFG>/);
    assert.match(fsFile.xml, /<R1010G3>80\.0<\/R1010G3>/);
    assert.match(fsFile.xml, /<R1010G4>80\.0<\/R1010G4>/);
    assert.match(fsFile.xml, /<R1100G3>15\.0<\/R1100G3>/);
    assert.match(fsFile.xml, /<R1155G3>5\.0<\/R1155G3>/);
    assert.match(fsFile.xml, /<R1165G3>45\.0<\/R1165G3>/);
    assert.match(fsFile.xml, /<R1300G3>145\.0<\/R1300G3>/);
    assert.match(fsFile.xml, /<R1900G3>145\.0<\/R1900G3>/);
});

test("кодування windows-1251 зберігає специфічні українські літери (і, ї, є, ґ, апостроф)", () => {
    const text = "ОСББ «Успіх-25» — підзвітні особи, звʼязок, обʼєкт та нарахування";
    const bytes = annualDps.encode1251(text);
    assert.ok(bytes instanceof Buffer || bytes instanceof Uint8Array);
    assert.equal(bytes.length, text.length);
});

test("блокування формування пакета при непогодженій розшифровці", () => {
    const { rep } = createSampleCalculation();
    const unreviewedCalc = { reviewReady: false, checks: [{ level: "block", text: "Потрібна перевірка бухгалтером" }] };
    const out = annualDps.buildAnnualPackage({
        year: "2026",
        org,
        report: rep,
        calculation: unreviewedCalc,
        fillDate: "2026-10-14"
    });
    assert.equal(out.files.length, 0);
    assert.match(out.problems.join("; "), /Потрібна перевірка бухгалтером/);
});
