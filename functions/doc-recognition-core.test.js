'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('./doc-recognition-core');

test('розпізнавання рахунку-фактури на обслуговування ліфтів', () => {
    const text = `
    РАХУНОК-ФАКТУРА № СФ-00124
    від «14» жовтня 2026 р.
    Постачальник: ТОВ «Одесаліфт-Сервіс»
    Код ЄДРПОУ: 38245674
    Р/р IBAN: UA213283840000026007123456789 в АТ КБ "ПРИВАТБАНК"
    Покупець: ОСББ «Успіх-25»
    Призначення: Технічне обслуговування пасажирських ліфтів за жовтень 2026 р.
    Сума без ПДВ: 4000,00 грн
    ПДВ 20%: 800,00 грн
    Всього до сплати: 4 800,00 грн
    Оплата протягом 5 банківських днів з моменту отримання рахунку.
    `;

    const res = core.parseDocumentText(text);

    assert.equal(res.docType, 'invoice');
    assert.equal(res.number, 'СФ-00124');
    assert.equal(res.date, '2026-10-14');
    assert.equal(res.period, '2026-10');
    assert.equal(res.supplier.code, '38245674');
    assert.equal(res.supplier.iban, 'UA213283840000026007123456789');
    assert.equal(res.amountKop, 480000);
    assert.equal(res.vatKop, 80000);
    assert.equal(res.item, 'lift');
    assert.equal(res.postingAcc, '92');
    assert.equal(res.paymentDueDays, 5);
});

test('розпізнавання акта виконаних робіт з поточного ремонту сантехніки', () => {
    const text = `
    АКТ НАДАННЯ ПОСЛУГ № 89
    від 05.10.2026
    Виконавець: ФОП Коваленко Сергій Миколайович
    ІПН / РНОКПП: 2845612347
    IBAN: UA773052990000026201234567890
    Замовник: ОСББ «Успіх-25»
    Найменування робіт: Аварійна заміна крана кульового та ділянки труби ГВП у підвалі під'їзду № 2
    Разом до сплати: 2 450,00 грн
    Без ПДВ
    `;

    const res = core.parseDocumentText(text);

    assert.equal(res.docType, 'act');
    assert.equal(res.number, '89');
    assert.equal(res.date, '2026-10-05');
    assert.equal(res.supplier.code, '2845612347');
    assert.equal(res.supplier.iban, 'UA773052990000026201234567890');
    assert.equal(res.amountKop, 245000);
    assert.equal(res.vatKop, 0);
    assert.equal(res.postingAcc, '92'); // послуги аварійної сантехніки
});

test('розпізнавання видаткової накладної на закупівлю інвентарю (МШП, рах. 22)', () => {
    const text = `
    ВИДАТКОВА НАКЛАДНА № ВН-5541
    від 10.10.2026 р.
    Постачальник: ТОВ "Епіцентр К"
    ЄДРПОУ 32490244
    Товар: Лопата снігова пластикова, віник сорго, рукавиці робочі
    Всього: 1 350,50 грн. Без ПДВ.
    `;

    const res = core.parseDocumentText(text);

    assert.equal(res.docType, 'waybill');
    assert.equal(res.number, 'ВН-5541');
    assert.equal(res.date, '2026-10-10');
    assert.equal(res.amountKop, 135050);
    assert.equal(res.postingAcc, '22'); // МШП (лопата, віник, рукавиці)
});

test('розпізнавання фіскального чека АЗС для авансового звіту', () => {
    const text = `
    ФІСКАЛЬНИЙ ЧЕК № 003491
    АЗС WOG ТОВ "ВЕСТ ПЕТРОЛ МАРКЕТ"
    ЄДРПОУ: 32628374
    12.10.2026 15:42
    Бензин А-95 Євро5 (для генератора)
    СУМА: 1 650,00 ГРН
    ПДВ 20%: 275,00
    Дякуємо за покупку!
    `;

    const res = core.parseDocumentText(text);

    assert.equal(res.docType, 'receipt');
    assert.equal(res.number, '003491');
    assert.equal(res.date, '2026-10-12');
    assert.equal(res.amountKop, 165000);
    assert.equal(res.vatKop, 27500);
    assert.equal(res.postingAcc, '20'); // паливо для генератора
});

test('співставлення постачальника з базою ОСББ', () => {
    const existingSuppliers = [
        { id: 'sup1', name: 'ТОВ «Одесаліфт»', code: '38245674', iban: 'UA213283840000026007123456789' },
        { id: 'sup2', name: 'ФОП Петренко', code: '2911122233', iban: 'UA443052990000026001111111111' }
    ];
    const existingContracts = [
        { id: 'con1', supplierId: 'sup1', number: '10-Л', status: 'approved' }
    ];

    const matchByEdrpou = core.matchSupplierWithDatabase({ code: '38245674', name: 'Одесаліфт' }, existingSuppliers, existingContracts);
    assert.equal(matchByEdrpou.isNew, false);
    assert.equal(matchByEdrpou.matched.id, 'sup1');
    assert.equal(matchByEdrpou.contract.id, 'con1');

    const matchNew = core.matchSupplierWithDatabase({ code: '99999999', name: 'Нова Компанія' }, existingSuppliers, existingContracts);
    assert.equal(matchNew.isNew, true);
    assert.equal(matchNew.matched, null);
});

test('розпізнавання договору на технічне обслуговування з умовами оплати', () => {
    const text = `
    ДОГОВІР ПРО НАДАННЯ ПОСЛУГ № 15-ТО/26
    м. Одеса, «01» вересня 2026 року
    Виконавець: ТОВ "Еко-Транс" (код ЄДРПОУ 38245674, IBAN UA213283840000026007123456789)
    Замовник: ОСББ "Успіх-25"
    Предмет договору: Вивезення та утилізація твердих побутових відходів.
    Загальна вартість послуг за місяць: 3 600,00 грн, у т.ч. ПДВ 600,00 грн.
    Умови розрахунків: Оплата здійснюється протягом 10 календарних днів після підписання акта.
    Строк дії: Договір діє до 31.12.2027 року.
    `;

    const res = core.parseDocumentText(text);

    assert.equal(res.docType, 'contract');
    assert.equal(res.number, '15-ТО/26');
    assert.equal(res.date, '2026-09-01');
    assert.equal(res.supplier.code, '38245674');
    assert.equal(res.amountKop, 360000);
    assert.equal(res.vatKop, 60000);
    assert.equal(res.item, 'waste');
    assert.equal(res.paymentDueDays, 10);
    assert.equal(res.contractEnd, '2027-12-31');
});

test("розпізнавання акта з M.E.Doc / ПТАХ (XML DECLAR)", () => {
    const medocXml = `<?xml version="1.0" encoding="windows-1251"?>
<DECLAR xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <DECLARHEAD>
    <TIN>38123456</TIN>
    <C_DOC>J12</C_DOC>
    <C_DOC_SUB>010</C_DOC_SUB>
    <D_FILL>16102026</D_FILL>
    <HNUM>125</HNUM>
  </DECLARHEAD>
  <DECLARBODY>
    <HNAME>ТОВ "ЛІФТ-СЕРВІС"</HNAME>
    <HTIN>38123456</HTIN>
    <HIBAN>UA123052990000026001234567890</HIBAN>
    <HNAME_B>ОСББ "УСПІХ-25"</HNAME_B>
    <HTIN_B>40562894</HTIN_B>
    <HDATE>16.10.2026</HDATE>
    <R03G1S>Технічне обслуговування ліфтів за жовтень 2026</R03G1S>
    <R01G11>12500.00</R01G11>
    <R01G10>2083.33</R01G10>
  </DECLARBODY>
</DECLAR>`;

    const res = core.parseDocumentText(medocXml);
    assert.equal(res.docType, "act");
    assert.equal(res.number, "125");
    assert.equal(res.date, "2026-10-16");
    assert.equal(res.period, "2026-10");
    assert.equal(res.supplier.name, "ТОВ \"ЛІФТ-СЕРВІС\"");
    assert.equal(res.supplier.code, "38123456");
    assert.equal(res.supplier.iban, "UA123052990000026001234567890");
    assert.equal(res.amountKop, 1250000);
    assert.equal(res.vatKop, 208333);
    assert.equal(res.item, "lift");
    assert.equal(res.postingAcc, "92");
    assert.equal(res.source, "medoc");
});

test("розпізнавання рахунку з 1С / CommerceML (XML)", () => {
    const cmlXml = `<?xml version="1.0" encoding="UTF-8"?>
<КоммерческаяИнформация ВерсияСхемы="2.03">
  <Документ>
    <Номер>СФ-458</Номер>
    <Дата>2026-10-16</Дата>
    <ХозяйственнаяОперация>ЗаказТовара</ХозяйственнаяОперация>
    <Сумма>4580.00</Сумма>
    <СуммаНДС>763.33</СуммаНДС>
    <Контрагенты>
      <Контрагент>
        <Наименование>ТОВ "Одесаенергопостач"</Наименование>
        <Роль>Поставщик</Роль>
        <ЕГРПОУ>35467890</ЕГРПОУ>
        <РасчетныеСчета>
          <РасчетныйСчет>
            <НомерСчета>UA443052990000026009876543210</НомерСчета>
          </РасчетныйСчет>
        </РасчетныеСчета>
      </Контрагент>
    </Контрагенты>
    <Товары>
      <Товар>
        <Наименование>Електроенергія на технічні цілі</Наименование>
        <Сумма>4580.00</Сумма>
      </Товар>
    </Товары>
  </Документ>
</КоммерческаяИнформация>`;

    const res = core.parseDocumentText(cmlXml);
    assert.equal(res.docType, "invoice");
    assert.equal(res.number, "СФ-458");
    assert.equal(res.date, "2026-10-16");
    assert.equal(res.supplier.code, "35467890");
    assert.equal(res.supplier.name, "ТОВ \"Одесаенергопостач\"");
    assert.equal(res.supplier.iban, "UA443052990000026009876543210");
    assert.equal(res.amountKop, 458000);
    assert.equal(res.vatKop, 76333);
    assert.equal(res.item, "power");
    assert.equal(res.postingAcc, "92");
    assert.equal(res.source, "commerceml");
});

test("розпізнавання документа Вчасно UBL XML", () => {
    const ublXml = `<?xml version="1.0" encoding="UTF-8"?>
<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2">
  <ID>АКТ-99</ID>
  <IssueDate>2026-10-15</IssueDate>
  <AccountingSupplierParty>
    <Party>
      <PartyName><Name>ТОВ «ЕКО-ТРАНС»</Name></PartyName>
      <PartyLegalEntity><CompanyID>33221100</CompanyID></PartyLegalEntity>
      <PaymentMeans><PayeeFinancialAccount><ID>UA993052990000026001122334455</ID></PayeeFinancialAccount></PaymentMeans>
    </Party>
  </AccountingSupplierParty>
  <LegalMonetaryTotal>
    <PayableAmount currencyID="UAH">8400.00</PayableAmount>
  </LegalMonetaryTotal>
  <TaxTotal>
    <TaxAmount currencyID="UAH">1400.00</TaxAmount>
  </TaxTotal>
  <InvoiceLine>
    <Item><Description>Вивезення та захоронення твердих побутових відходів</Description></Item>
  </InvoiceLine>
</Invoice>`;

    const res = core.parseDocumentText(ublXml);
    assert.equal(res.docType, "act");
    assert.equal(res.number, "АКТ-99");
    assert.equal(res.date, "2026-10-15");
    assert.equal(res.supplier.code, "33221100");
    assert.equal(res.supplier.name, "ТОВ «ЕКО-ТРАНС»");
    assert.equal(res.supplier.iban, "UA993052990000026001122334455");
    assert.equal(res.amountKop, 840000);
    assert.equal(res.vatKop, 140000);
    assert.equal(res.item, "waste");
    assert.equal(res.postingAcc, "92");
    assert.equal(res.source, "vchasno_ubl");
});

test("розпакування пакета ZIP з M.E.Doc (XML + PDF + P7S)", () => {
    const zlib = require("zlib");
    // Створюємо валідний ZIP у памʼяті
    const enc = new TextEncoder();
    function createZip(files) {
        const parts = [];
        let offset = 0;
        const central = [];
        const u16 = v => [v & 0xff, (v >>> 8) & 0xff];
        const u32 = v => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff];

        for (const { name, data } of files) {
            const nameBytes = enc.encode(name);
            const deflated = zlib.deflateRawSync(data);
            const head = [
                ...u32(0x04034b50), ...u16(20), ...u16(0x0800), ...u16(8),
                ...u16(0), ...u16(0),
                ...u32(0), ...u32(deflated.length), ...u32(data.length),
                ...u16(nameBytes.length), ...u16(0)
            ];
            parts.push(Buffer.from(head), nameBytes, deflated);
            central.push({ nameBytes, compSize: deflated.length, uncompSize: data.length, offset });
            offset += head.length + nameBytes.length + deflated.length;
        }

        let centralOffset = offset;
        let centralSize = 0;
        for (const c of central) {
            const chead = [
                ...u32(0x02014b50), ...u16(20), ...u16(20), ...u16(0x0800), ...u16(8),
                ...u16(0), ...u16(0),
                ...u32(0), ...u32(c.compSize), ...u32(c.uncompSize),
                ...u16(c.nameBytes.length), ...u16(0), ...u16(0),
                ...u16(0), ...u16(0), ...u32(0), ...u32(c.offset)
            ];
            parts.push(Buffer.from(chead), c.nameBytes);
            centralSize += chead.length + c.nameBytes.length;
        }
        const eocd = [
            ...u32(0x06054b50), ...u16(0), ...u16(0),
            ...u16(files.length), ...u16(files.length),
            ...u32(centralSize), ...u32(centralOffset), ...u16(0)
        ];
        parts.push(Buffer.from(eocd));
        return Buffer.concat(parts);
    }

    const xml = `<DECLAR><DECLARBODY><HNUM>777</HNUM><HDATE>2026-10-16</HDATE><HTIN>12345678</HTIN><HNAME>Постачальник</HNAME><R01G11>5000</R01G11></DECLARBODY></DECLAR>`;
    const zipBuf = createZip([
        { name: "document.xml", data: Buffer.from(xml, "utf8") },
        { name: "document.pdf", data: Buffer.from("%PDF-1.4...", "utf8") },
        { name: "document.pdf.p7s", data: Buffer.from("sig...", "utf8") }
    ]);

    const files = core.unpackZip(zipBuf);
    assert.equal(files.length, 3);
    const xmlFile = files.find(f => f.name.endsWith(".xml"));
    assert.ok(xmlFile);
    const parsed = core.parseEdiXml(core.decodeTextBuffer(xmlFile.data));
    assert.equal(parsed.number, "777");
    assert.equal(parsed.amountKop, 500000);
});
