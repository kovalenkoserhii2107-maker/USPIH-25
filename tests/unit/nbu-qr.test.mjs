import test from 'node:test';
import assert from 'node:assert/strict';
import { validIban, formatAmount, buildPayload, paymentLinks } from '../../js/nbu-qr.js';

// IBAN з офіційного прикладу постанови НБУ (контрольна сума правильна).
const IBAN = 'UA906543210000000260323012024';

test('IBAN перевіряється за MOD 97', () => {
    assert.equal(validIban(IBAN), true);
    assert.equal(validIban('UA90 6543 2100 0000 0260 3230 1202 4'), true);
    assert.equal(validIban('UA916543210000000260323012024'), false);
    assert.equal(validIban('PL906543210000000260323012024'), false);
});

test('сума: копійки — дві цифри або жодної', () => {
    assert.equal(formatAmount(1250.5), 'UAH1250.50');
    assert.equal(formatAmount(100), 'UAH100');
    assert.equal(formatAmount(0.07), 'UAH0.07');
    assert.equal(formatAmount(0), '');
    assert.equal(formatAmount(-5), '');
});

test('дані формату 003 збігаються з еталонним прикладом', () => {
    const payload = buildPayload({ name: 'ОСББ "Приклад"', iban: IBAN, code: '12345678', amount: 1250.5,
        purpose: 'Внесок на утримання будинку, кв. 15, жовтень 2026', reference: 'KV15-2026-10' });
    assert.equal(payload, 'BCD\n003\n1\nUCT\n\nОСББ "Приклад"\nUA906543210000000260323012024\nUAH1250.50\n12345678\nOTHR/OTHR\nKV15-2026-10\nВнесок на утримання будинку, кв. 15, жовтень 2026\n\n\n\n\n');
    assert.equal(payload.split('\n').length, 17);
    const { link, apps } = paymentLinks({ name: 'ОСББ "Приклад"', iban: IBAN, code: '12345678', amount: 1250.5,
        purpose: 'Внесок на утримання будинку, кв. 15, жовтень 2026', reference: 'KV15-2026-10' });
    // Посилання з офіційного дослідження формату (docs/accounting/research/2026-10-tech.md, B4).
    assert.equal(link, 'https://qr.bank.gov.ua/QkNECjAwMwoxClVDVAoK0J7QodCR0JEgItCf0YDQuNC60LvQsNC0IgpVQTkwNjU0MzIxMDAwMDAwMDI2MDMyMzAxMjAyNApVQUgxMjUwLjUwCjEyMzQ1Njc4Ck9USFIvT1RIUgpLVjE1LTIwMjYtMTAK0JLQvdC10YHQvtC6INC90LAg0YPRgtGA0LjQvNCw0L3QvdGPINCx0YPQtNC40L3QutGDLCDQutCyLiAxNSwg0LbQvtCy0YLQtdC90YwgMjAyNgoKCgoK');
    assert.ok(apps[0].href.startsWith('https://www.privat24.ua/rd/send_qr/nbu/QkNE'));
});

test('перевід рядка в полі не ламає структуру, без суми — порожнє поле', () => {
    const payload = buildPayload({ name: 'ОСББ\n«Успіх-25» 🏠', iban: IBAN, code: '12345678', purpose: 'кв. 45\nо/р 1045' });
    const fields = payload.split('\n');
    assert.equal(fields.length, 17);
    assert.equal(fields[5], 'ОСББ «Успіх-25»');
    assert.equal(fields[7], '');
    assert.equal(fields[11], 'кв. 45 о/р 1045');
});

test('без IBAN чи коду посилання не будується', () => {
    assert.throws(() => buildPayload({ name: 'ОСББ', iban: 'UA00', code: '1', purpose: 'x' }), /IBAN/);
    assert.throws(() => buildPayload({ name: 'ОСББ', iban: IBAN, code: '', purpose: 'x' }), /Бракує/);
});
