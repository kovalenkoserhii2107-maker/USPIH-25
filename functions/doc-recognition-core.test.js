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
