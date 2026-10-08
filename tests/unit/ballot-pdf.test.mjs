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
        assert.match(text, /Опитування проводить:/);
        assert.equal((text.match(/Підпис особи, яка проводила опитування:/g) || []).length, 1);
        assert(!text.includes('Підпис:'));
        const name = text.includes('Парадна 1') ? 'ПершаВідповідальна' : 'ДругаВідповідальна';
        assert.equal((text.match(new RegExp(name, 'g')) || []).length, 2, 'правильне ПІБ у шапці та footer');
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
    assert.match(text, /Опитування проводить: _+/);
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
