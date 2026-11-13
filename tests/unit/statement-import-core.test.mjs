import test from 'node:test';
import assert from 'node:assert/strict';
import * as s from '../../js/statement-import-core.js';
import { createRequire } from 'node:module';
const server = createRequire(import.meta.url)('../../functions/statement-core.js');

const OSCHAD = 'UA503004650000026001234567890';
const OTHER = 'UA883052990000026007054321001';

test('Суми й дати: різні записи без похибок', () => {
    assert.equal(s.toKop('1 234,56'), 123456);
    assert.equal(s.toKop('-850.00'), -85000);
    assert.equal(s.toKop("1'234.5 UAH"), 123450);
    assert.equal(s.toKop('(120,00)'), -12000);
    assert.equal(s.toKop('1.234,56'), 123456);
    assert.equal(s.toKop('0.1'), 10);
    assert.equal(s.toKop('abc'), null);
    assert.equal(s.toDate('05.10.2026 14:31'), '2026-10-05');
    assert.equal(s.toDate('2026-10-05'), '2026-10-05');
    assert.equal(s.toDate('5/1/2026'), '2026-01-05');
    assert.equal(s.toDate('31.02.2026'), null);
    assert.equal(s.toDate('46300'), '2026-10-05');
});

test('Довідник банків однаковий у браузері й на сервері', () => {
    assert.deepEqual(s.BANKS, Object.fromEntries(Object.entries(server.BANKS)));
    assert.equal(s.bankOf(OSCHAD), 'Ощадбанк');
    assert.equal(s.validIban(OSCHAD), true);
});

test('1С: напрям за рахунком ОСББ, залишки й період', () => {
    const text = [
        '1CClientBankExchange', 'ВерсияФормата=1.02', 'Кодировка=Windows',
        'СекцияРасчСчет', 'ДатаНачала=01.10.2026', 'ДатаКонца=31.10.2026', `РасчСчет=${OSCHAD}`,
        'НачальныйОстаток=1000.00', 'КонечныйОстаток=1750.00', 'КонецРасчСчет',
        'СекцияДокумент=Платежное поручение', 'Номер=15', 'Дата=05.10.2026', 'Сумма=850.00',
        `ПлательщикСчет=${OTHER}`, 'Плательщик=Власник Тестовий 5', 'ПлательщикИНН=1234567890',
        `ПолучательСчет=${OSCHAD}`, 'Получатель=ОСББ (демо)', 'НазначениеПлатежа=Внески, кв. 5', 'ДатаПоступило=05.10.2026', 'КонецДокумента',
        'СекцияДокумент=Платежное поручение', 'Номер=7', 'Дата=10.10.2026', 'Сумма=100.00',
        `ПлательщикСчет=${OSCHAD}`, `ПолучательСчет=${OTHER}`, 'Получатель1=ТОВ «Ліфт» (демо)', 'ПолучательИНН=34512890',
        'НазначениеПлатежа=Оплата за ТО ліфтів', 'ДатаСписано=10.10.2026', 'КонецДокумента', 'КонецФайла'
    ].join('\r\n');
    const st = s.parse1C(text);
    assert.equal(st.iban, OSCHAD);
    assert.deepEqual([st.from, st.to, st.openingKop, st.closingKop], ['2026-10-01', '2026-10-31', 100000, 175000]);
    assert.deepEqual(st.rows.map(r => [r.direction, r.amountKop, r.name, r.code, r.account]), [
        ['in', 85000, 'Власник Тестовий 5', '1234567890', OTHER], ['out', 10000, 'ТОВ «Ліфт» (демо)', '34512890', OTHER]]);
    assert.deepEqual(s.checkStatement(st, { iban: OSCHAD }).problems, []);
    // Сервер приймає те, що розібрав браузер.
    assert.equal(server.cleanStatement(st, { iban: OSCHAD, today: '2026-11-13' }).rows.length, 2);
    assert.throws(() => s.parse1C('hello'), /1С/);
});

test('camt.053: проведені операції, контрагент за напрямом, залишки', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.02"><BkToCstmrStmt><Stmt>
  <Acct><Id><IBAN>${OSCHAD}</IBAN></Id></Acct>
  <Bal><Tp><CdOrPrtry><Cd>OPBD</Cd></CdOrPrtry></Tp><Amt Ccy="UAH">1000.00</Amt><CdtDbtInd>CRDT</CdtDbtInd><Dt><Dt>2026-10-01</Dt></Dt></Bal>
  <Bal><Tp><CdOrPrtry><Cd>CLBD</Cd></CdOrPrtry></Tp><Amt Ccy="UAH">1750.00</Amt><CdtDbtInd>CRDT</CdtDbtInd><Dt><Dt>2026-10-31</Dt></Dt></Bal>
  <Ntry><Amt Ccy="UAH">850.00</Amt><CdtDbtInd>CRDT</CdtDbtInd><Sts>BOOK</Sts><BookgDt><Dt>2026-10-05</Dt></BookgDt><AcctSvcrRef>R1</AcctSvcrRef>
    <NtryDtls><TxDtls><RltdPties><Dbtr><Nm>Власник Тестовий 5 &amp; Ко</Nm></Dbtr><DbtrAcct><Id><IBAN>${OTHER}</IBAN></Id></DbtrAcct></RltdPties>
    <RmtInf><Ustrd>Внески, кв. 5</Ustrd></RmtInf></TxDtls></NtryDtls></Ntry>
  <Ntry><Amt Ccy="UAH">100.00</Amt><CdtDbtInd>DBIT</CdtDbtInd><Sts>BOOK</Sts><BookgDt><Dt>2026-10-10</Dt></BookgDt>
    <NtryDtls><TxDtls><RltdPties><Cdtr><Nm>ТОВ Ліфт (демо)</Nm><Id><OrgId><Othr><Id>34512890</Id></Othr></OrgId></Id></Cdtr></RltdPties><RmtInf><Ustrd>ТО ліфтів</Ustrd></RmtInf></TxDtls></NtryDtls></Ntry>
  <Ntry><Amt Ccy="UAH">5.00</Amt><CdtDbtInd>DBIT</CdtDbtInd><Sts>PDNG</Sts><BookgDt><Dt>2026-10-31</Dt></BookgDt></Ntry>
</Stmt></BkToCstmrStmt></Document>`;
    assert.equal(s.detectFormat('x.xml', xml), 'camt053');
    const st = s.parseCamt(xml);
    assert.deepEqual([st.iban, st.openingKop, st.closingKop, st.from, st.to], [OSCHAD, 100000, 175000, '2026-10-01', '2026-10-31']);
    assert.deepEqual(st.rows.map(r => [r.direction, r.amountKop, r.name, r.code, r.ref]), [['in', 85000, 'Власник Тестовий 5 & Ко', '', 'R1'], ['out', 10000, 'ТОВ Ліфт (демо)', '34512890', '']]);
    assert.equal(st.warnings.length, 1);
    assert.deepEqual(s.checkStatement(st).problems, []);
});

test('Таблиця: заголовки, дебет/кредит, рахунок і залишки над таблицею', () => {
    const rows = [
        ['Виписка по рахунку', `UA50 3004 6500 0002 6001 2345 6789 0`],
        ['Період: 01.10.2026 - 31.10.2026'],
        ['Вхідний залишок', '1 000,00'],
        [],
        ['Дата операції', 'Номер документа', 'Контрагент', 'ЄДРПОУ', 'Рахунок контрагента', 'Дебет', 'Кредит', 'Призначення платежу'],
        ['05.10.2026', '15', 'Власник Тестовий 5', '1234567890', OTHER, '', '850,00', 'Внески, кв. 5'],
        ['10.10.2026', '7', 'ТОВ Ліфт (демо)', '34512890', '', '100,00', '', 'ТО ліфтів'],
        ['Разом', '', '', '', '', '100,00', '850,00', ''],
        ['Вихідний залишок', '1 750,00']
    ];
    const st = s.parseTable(rows);
    assert.equal(st.iban, OSCHAD);
    assert.deepEqual([st.from, st.to, st.openingKop, st.closingKop], ['2026-10-01', '2026-10-31', 100000, 175000]);
    assert.deepEqual(st.rows.map(r => [r.date, r.direction, r.amountKop, r.code]), [['2026-10-05', 'in', 85000, '1234567890'], ['2026-10-10', 'out', 10000, '34512890']]);
    assert.deepEqual(s.checkStatement(st).problems, []);
    assert.equal(st.table.map.debit, 5);
});

test('Таблиця: одна колонка суми зі знаком і ручні колонки', () => {
    const rows = [['Date', 'Amount', 'Description', 'Counterparty'], ['2026-10-05', '850.00', 'Внески кв 5', 'Власник Тестовий 5'], ['2026-10-06', '-12.50', 'Комісія', 'Банк']];
    const st = s.parseTable(rows);
    assert.deepEqual(st.rows.map(r => [r.direction, r.amountKop, r.purpose]), [['in', 85000, 'Внески кв 5'], ['out', 1250, 'Комісія']]);
    const manual = s.parseTable([['a', 'b'], ['05.10.2026', '10']], { header: 0, map: { date: 0, amount: 1 } });
    assert.equal(manual.rows[0].amountKop, 1000);
    assert.throws(() => s.parseTable([['x', 'y'], ['1', '2']]), /Дата/);
});

test('Перевірка: інший рахунок і розбіжність залишків', () => {
    const st = { iban: OTHER, openingKop: 0, closingKop: 100, from: '2026-10-01', to: '2026-10-31', rows: [{ date: '2026-10-05', direction: 'in', amountKop: 50 }] };
    const res = s.checkStatement(st, { iban: OSCHAD });
    assert.equal(res.problems.length, 2);
    assert.equal(res.diffKop, 50);
});
