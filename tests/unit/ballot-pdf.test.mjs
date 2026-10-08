import test from 'node:test';
import assert from 'node:assert/strict';
import pdfMake from 'pdfmake/build/pdfmake.js';
import fonts from 'pdfmake/build/vfs_fonts.js';
import { documents } from '../helpers/pdf-documents.mjs';

pdfMake.vfs = fonts.pdfMake.vfs;
const { buildBlankSheetsDoc, buildProtocolDoc, decisionLines } = documents;
const osbb = { name: 'ОСББ «Успіх-25»', address: 'м. Одеса', edrpou: '40562894' };
const pagesOf = doc => new Promise(resolve => pdfMake.createPdf(doc)._getPages({}, resolve));
const pageText = page => page.items.filter(item => item.type === 'line')
    .map(({ item }) => item.inlines.map(inline => inline.text).join('')).join('\n');

test('бюлетень не додає нумерацію до тексту рішень', () => {
    assert.deepEqual(decisionLines('3.1. Затвердити кошторис\nпродовження того самого пункту\n\n3.2. Дозволити правлінню'), [
        '3.1. Затвердити кошторис', 'продовження того самого пункту', '3.2. Дозволити правлінню'
    ]);
});

test('короткі переноси в пунктах не звужують опис і залишають місце для власників', async () => {
    const decision = [
        '3.1. З урахуванням висновків',
        'ревізійної комісії затвердити',
        'підготовлений правлінням',
        'Фінансовий звіт Об’єднання за 2025 рік',
        'та прийняти його до відома.',
        '3.2. Дозволити правлінню виходячи',
        'з фактичних потреб Об’єднання',
        'здійснювати перенесення асигнувань',
        'між статтями витрат у межах',
        'загальної суми дохідної частини кошторису.'
    ].join('\n');
    const apartments = Array.from({ length: 40 }, (_, index) => ({
        apt: String(297 + index), area: 64,
        owners: [{
            name: `Власник${String(index).padStart(3, '0')} Коваленко Сергій Пилипович`,
            docInfo: 'Договір купівлі-продажу від 21.10.2021 №321', shareFrac: '1/2'
        }]
    }));
    const pages = await pagesOf(buildBlankSheetsDoc({
        options: ['Затвердження кошторису\nОб’єднання'], agendaDecisions: [decision],
        meetingDate: '2026-10-24', timeStart: '13:00', timeEnd: '14:00'
    }, apartments, osbb));
    const lines = pages[0].items.filter(item => item.type === 'line').map(item => item.item);
    const decisionRows = lines.filter(line => /^3\.[12]\. /.test(line.inlines.map(i => i.text).join('')));
    assert.equal(decisionRows.length, 2, 'кожен пункт поміщається в один рядок замість п’яти коротких');
    assert(decisionRows.every(line => line.maxWidth > 750), 'пункти використовують ширину всіх колонок');
    const last = decisionRows[1];
    assert(Math.max(...last.inlines.map(i => last.x + i.x + i.width)) > 750,
        'довгий пункт справді друкується біля правого краю листка');
    const text = pageText(pages[0]);
    assert.match(text, /Питання 1\. Затвердження кошторису Об’єднання/);
    assert.match(text, /висновків ревізійної комісії/);
    assert((text.match(/Власник\d{3}/g) || []).length >= 10, 'на першій сторінці поміщається щонайменше 10 власників');
    const combined = pages.map(pageText).join('\n');
    assert.equal((combined.match(/Власник\d{3}/g) || []).length, 40, 'усі власники збереглися');
});

test('абзаци та різні маркери пунктів зберігаються без додаткових номерів', () => {
    const doc = buildBlankSheetsDoc({
        options: ['Ремонт'],
        agendaDecisions: ['Вступний текст\nпродовження\n\nОкремий абзац\n- Ремонт\nдаху\nа) Доручити\nправлінню\n2) Затвердити роботи']
    }, [{ apt: '1', owners: [{ name: 'Власник' }] }], osbb);
    const header = doc.content[0].table.body[0][0].stack;
    assert.deepEqual(header.filter(node => node.style === 'qsub').map(node => node.text), [
        'Вступний текст продовження', 'Окремий абзац', '- Ремонт даху', 'а) Доручити правлінню', '2) Затвердити роботи'
    ]);
});

test('400 власників переходять на нові сторінки зі шапкою та одним нижнім підписом', async () => {
    const apartments = Array.from({ length: 200 }, (_, index) => ({
        apt: String(index + 1), entrance: index < 100 ? '1' : '2', area: 64,
        owners: [0, 1].map(n => ({
            id: `owner-${n}`, name: `Власник${String(index * 2 + n).padStart(4, '0')} Довге Українське Прізвище`,
            docInfo: 'Договір купівлі-продажу від 21.10.2021 №321', shareFrac: '1/2'
        }))
    }));
    const poll = {
        options: ['Кошторис', 'Ремонт'],
        agendaDecisions: ['3.1. Затвердити кошторис\nпродовження пункту без номера', 'Затвердити ремонт'],
        meetingDate: '2026-10-24', timeStart: '13:00',
        surveyors: { 1: 'ПершаВідповідальна', 2: 'ДругаВідповідальна' }
    };
    const pages = await pagesOf(buildBlankSheetsDoc(poll, apartments, osbb, { byEntrance: true }));
    assert(pages.length > 4, 'великий список справді розбито на кілька сторінок');
    const texts = pages.map(pageText);
    for (const text of texts) {
        assert.match(text, /Листок опитування/);
        assert.match(text, /Питання [12]\. (Кошторис|Ремонт)/);
        assert(!text.includes('Опитування проводить:'));
        assert.equal((text.match(/Підпис особи, яка проводила опитування:/g) || []).length, 1);
        assert(!text.includes('Підпис:'));
        const name = text.includes('Парадна 1') ? 'ПершаВідповідальна' : 'ДругаВідповідальна';
        assert.equal((text.match(new RegExp(name, 'g')) || []).length, 1, 'ПІБ лише біля нижнього підпису');
        assert.match(text, /Власник\d{4}/, 'сторінки містять власників, а не лише шапку або підпис');
        if (text.includes('Кошторис')) {
            assert(text.includes('продовження пункту без номера'));
            assert(!text.includes('1.2. продовження'));
        }
    }
    const combined = texts.join('\n');
    for (let i = 0; i < 400; i++) {
        const marker = `Власник${String(i).padStart(4, '0')}`;
        assert.equal((combined.match(new RegExp(marker, 'g')) || []).length, 2, `${marker} друкується один раз на питання`);
    }
});

test('ПІБ опитувача можна залишити порожнім на кожній сторінці', async () => {
    const pages = await pagesOf(buildBlankSheetsDoc({ options: ['Ремонт'], surveyors: {} }, [
        { apt: '1', area: 40, owners: [{ name: 'Петренко П. П.' }] }
    ], osbb));
    assert.equal(pages.length, 1);
    const text = pageText(pages[0]);
    assert(!text.includes('Опитування проводить:'));
    assert.match(text, /ПІБ: _+/);
    assert.match(text, /Підпис особи, яка проводила опитування:/);
});

test('група без парадної не дублює власників інших парадних', async () => {
    const pages = await pagesOf(buildBlankSheetsDoc({ options: ['Ремонт'] }, [
        { apt: '1', entrance: '1', owners: [{ name: 'ПершийВласник' }] },
        { apt: '2', entrance: '', owners: [{ name: 'ДругийВласник' }] }
    ], osbb, { byEntrance: true }));
    assert.equal(pages.length, 2);
    const text = pages.map(pageText).join('\n');
    assert.equal((text.match(/ПершийВласник/g) || []).length, 1);
    assert.equal((text.match(/ДругийВласник/g) || []).length, 1);
});

test('додаток протоколу показує різні відповіді співвласників однієї квартири', () => {
    const apartments = [{ apt: '298', area: 64, owners: [
        { id: 'a', name: 'Перший', shareFrac: '1/2' }, { id: 'b', name: 'Другий', shareFrac: '1/2' }
    ] }];
    const { docDefinition: doc } = buildProtocolDoc({ options: ['Ремонт'] }, apartments, [
        { apt: '298', ownerId: 'a', answers: { 0: 'За' }, source: 'paper' },
        { apt: '298', ownerId: 'b', answers: { 0: 'Проти' }, source: 'paper' }
    ], osbb);
    const table = doc.content.filter(node => node.table).at(-1).table.body;
    assert.equal(table.length, 3);
    assert.equal(table[1][2].text, 'Перший');
    assert.equal(table[1][4].text, 'За');
    assert.equal(table[2][2].text, 'Другий');
    assert.equal(table[2][4].text, 'Проти');
});
