'use strict';
// XML Податкового розрахунку: структура за офіційними XSD ДПС (functions/dps),
// суми рядків розрахунку, Д1, 4ДФ, Д5, імена файлів і windows-1251.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const dps = require('./dps-xml');
const payroll = require('./payroll-core');
const reports = require('./reports-core');

const org = { edrpou: '40562894', name: 'ОСББ «ТЕСТ»', katottg: 'UA51100270010069184', address: 'м. Одеса, вул. Тестова, 1', zip: '65101',
    kved: '81.10 Комплексне обслуговування обʼєктів', sti: { reg: 15, raj: 53, code: 1553, name: 'ГУ ДПС В ОДЕСЬКІЙ ОБЛАСТІ, ОДЕСЬКА ДПІ' },
    headName: 'Голова Тестовий', headTin: '3124567809' };
const emp = { id: 'e1', name: 'Працівник Тестовий Іванович', kind: 'employee', position: 'двірник', salaryKop: 864700, fte: 1, mainJob: true, rnokpp: '3124567809',
    iban: 'UA223052990000026001234567890', taxNotified: true, from: '2026-10-16', gender: 'Ч', kpCode: '9141', hireDoc: 'Наказ № 1-к від 15.10.2026', insuranceYears: 10 };
const half = { id: 'e2', name: 'Прибиральниця Тестова', kind: 'employee', position: 'прибиральниця', salaryKop: 432350, fte: 0.5, mainJob: true, rnokpp: '3124567809',
    iban: 'UA223052990000026001234567890', taxNotified: true, from: '2026-01-01', gender: 'Ж', psp: { kind: '169.1.1', from: '2026-01-10' } };
const gph = { id: 'g1', name: 'Виконавець Тестовий', kind: 'gph', position: 'прибирання території', rnokpp: '3124567809', iban: 'UA223052990000026001234567890',
    from: '2026-10-01', to: '2026-10-31', gender: 'Ч', contract: 'Договір № 5 від 01.10.2026' };

function pack() {
    const people = [emp, half, gph];
    const run = payroll.buildRun({ people, period: '2026-10',
        inputs: { g1: { actKop: 800000 }, e2: { absences: [{ type: 'sick', from: '2026-10-05', to: '2026-10-07', avgDailyKop: 14000 }] } } });
    const stored = { status: 'approved', run };
    const report = reports.payrollReport({ period: '2026-10', stored, people: new Map(people.map(p => [p.id, p])), payments: [] });
    return { run, report, out: dps.buildPackage({ period: '2026-10', org, report, run, people: new Map(people.map(p => [p.id, p])), fillDate: '2026-11-12' }) };
}

/** Перевірка xmllint за офіційною схемою (з локальним наближенням common_types). */
function validate(file, xsdName) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dps-'));
    fs.copyFileSync(path.join(__dirname, 'dps', `${xsdName}.xsd`), path.join(dir, `${xsdName}.xsd`));
    fs.copyFileSync(path.join(__dirname, 'dps', 'common_types.local.xsd'), path.join(dir, 'common_types.xsd'));
    const xml = path.join(dir, 'doc.xml');
    fs.writeFileSync(xml, dps.encode1251(file.xml));
    try { execFileSync('xmllint', ['--noout', '--schema', path.join(dir, `${xsdName}.xsd`), xml], { stdio: 'pipe' }); return null; }
    catch (e) { return String(e.stderr || e.message); }
}
const hasXmllint = (() => { try { execFileSync('xmllint', ['--version'], { stdio: 'pipe' }); return true; } catch { return false; } })();

test('пакет: чотири файли з правильними іменами й звʼязками', () => {
    const { out } = pack();
    assert.deepEqual(out.problems, []);
    // C_REG C_RAJ TIN(10) J05 SUB 11 STAN TYPE(2) CNT(7) 1 MM YYYY C_STI(4)
    const name = sub => `1553${'0040562894'}J05${sub}11${'1'}${'00'}${'0000001'}1${'10'}2026${'1553'}.xml`;
    assert.deepEqual(out.files.map(f => f.name), ['001', '101', '104', '105'].map(name));
    assert.match(out.files[0].xml, /<LINKED_DOCS><DOC NUM="1" TYPE="1">.*J0510111.*<\/LINKED_DOCS>/);
    assert.match(out.files[1].xml, /<DOC NUM="1" TYPE="2">.*J0500111/);
    assert.ok(out.files.every(f => f.xml.startsWith('<?xml version="1.0" encoding="windows-1251"?>')));
});

test('за офіційними XSD: розрахунок, Д1, 4ДФ, Д5', { skip: !hasXmllint && 'xmllint не встановлено' }, () => {
    const { out } = pack();
    for (const [i, xsd] of ['J0500111', 'J0510111', 'J0510411', 'J0510511'].entries()) {
        assert.equal(validate(out.files[i], xsd), null, `${xsd}: ${validate(out.files[i], xsd)}`);
    }
});

test('суми: розділ I розрахунку, Д1 і 4ДФ збігаються з відомістю', () => {
    const { run, report, out } = pack();
    const main = out.files[0].xml, d1 = out.files[1].xml, df4 = out.files[2].xml;
    const val = (xml, tag) => Number((xml.match(new RegExp(`<${tag}>([^<]+)</${tag}>`)) || [])[1]);
    const r = id => run.rows.find(x => x.personId === id);
    const sick = r('e2').sickKop;
    assert.equal(val(main, 'R01012G3') * 100, 800000);
    assert.equal(Math.round(val(main, 'R01013G3') * 100), sick);
    assert.equal(Math.round(val(main, 'R0101G3') * 100), run.totals.grossKop);
    assert.equal(Math.round(val(main, 'R0107G3') * 100), run.totals.esvKop);
    assert.equal(Math.round(val(d1, 'R01G20') * 100), run.totals.esvKop);
    assert.equal(Math.round(val(d1, 'R01G16') * 100), run.totals.grossKop);
    // Лікарняний — окремим рядком категорії 29 з днями непрацездатності.
    assert.match(d1, /<T1RXXXXG8 ROWNUM="3">29<\/T1RXXXXG8>/);
    assert.match(d1, /<T1RXXXXG12 ROWNUM="3">3<\/T1RXXXXG12>/);
    // 4ДФ: ознаки 101/102, ПСП 01 у півставки, дата прийому.
    assert.equal(Math.round(val(df4, 'R01G04A') * 100), report.income.reduce((s, x) => s + x.pdfoKop, 0));
    assert.match(df4, /<T1RXXXXG05 ROWNUM="3">102<\/T1RXXXXG05>/);
    assert.match(df4, /<T1RXXXXG08 ROWNUM="2">01<\/T1RXXXXG08>/);
    assert.match(df4, /<T1RXXXXG06D ROWNUM="1">16102026<\/T1RXXXXG06D>/);
    assert.match(df4, /<R00G01I>2<\/R00G01I><R00G02I>1<\/R00G02I>/);
    // Д5: прийом працівника з кодом КП і договір ЦПД (категорія 3) з початком і кінцем.
    const d5 = out.files[3].xml;
    assert.match(d5, /<T1RXXXXG14S ROWNUM="\d">9141<\/T1RXXXXG14S>/);
    assert.match(d5, /<T1RXXXXG7 ROWNUM="\d">3<\/T1RXXXXG7>/);
    assert.match(d5, /<T1RXXXXG102D ROWNUM="\d">31102026<\/T1RXXXXG102D>/);
});

test('немає реквізитів чи даних людей — файлів немає, лише перелік', () => {
    const { run, report } = pack();
    const out = dps.buildPackage({ period: '2026-10', org: { ...org, katottg: '', headTin: '' }, report, run, people: new Map([[emp.id, { ...emp, kpCode: '' }]]), fillDate: '2026-11-12' });
    assert.deepEqual(out.files, []);
    assert.ok(out.problems.some(p => /КАТОТТГ/.test(p)));
    assert.ok(out.problems.some(p => /Керівник/.test(p)));
    assert.ok(out.problems.some(p => /код класифікатора професій/.test(p)));
});

test('windows-1251 і поділ ПІБ', () => {
    assert.deepEqual([...dps.encode1251('Їжак ґ №')], [0xAF, 0xE6, 0xE0, 0xEA, 0x20, 0xB4, 0x20, 0xB9]);
    assert.deepEqual(dps.splitName('Петренко Марія Іванівна'), ['Петренко', 'Марія', 'Іванівна']);
});
