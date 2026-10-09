'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const pay = require('./payments-core');

// Справжня контрольна сума для тестових рахунків.
function iban(bban) {
    const digits = `${bban}3010` + '00';   // U=30, A=10
    let rest = 0;
    for (const ch of digits) rest = (rest * 10 + Number(ch)) % 97;
    return `UA${String(98 - rest).padStart(2, '0')}${bban}`;
}
const OWN_IBAN = iban('3052990000026001234567890');
const OWN = new Set([OWN_IBAN]);
// IBAN з офіційного прикладу НБУ — контрольна сума правильна.
const SUPPLIER = 'UA906543210000000260323012024';
const base = { recipient: { name: 'ТОВ Ліфт-Сервіс', iban: SUPPLIER, code: '12345678' }, amountKop: 425000,
    purpose: 'Оплата за обслуговування ліфтів за жовтень 2026', account: OWN_IBAN };

test('перевірка платежу: зрозумілі помилки', () => {
    assert.equal(pay.checkPayment(base, OWN), null);
    assert.match(pay.checkPayment({ ...base, recipient: { ...base.recipient, iban: 'UA916543210000000260323012024' } }, OWN), /IBAN/);
    assert.match(pay.checkPayment({ ...base, recipient: { ...base.recipient, code: '123' } }, OWN), /Код/);
    assert.match(pay.checkPayment({ ...base, amountKop: 0 }, OWN), /більшою/);
    assert.match(pay.checkPayment({ ...base, amountKop: 10.5 }, OWN), /більшою/);
    assert.match(pay.checkPayment({ ...base, purpose: 'x' }, OWN), /призначення/);
    assert.match(pay.checkPayment({ ...base, purpose: 'а'.repeat(421) }, OWN), /420/);
    assert.match(pay.checkPayment({ ...base, account: 'UA00' }, OWN), /рахунок ОСББ/);
    assert.match(pay.checkPayment({ ...base, recipient: { ...base.recipient, iban: OWN_IBAN } }, OWN), /самого ОСББ/);
});

test('списання у виписці закриває відправлений платіж', () => {
    const sent = { ...base, status: 'sent', sentAt: new Date('2026-10-10T09:00:00Z'), bankRef: 'PACK1' };
    const tx = { direction: 'out', amountKop: 425000, counterparty: { account: SUPPLIER }, at: new Date('2026-10-11T08:00:00Z') };
    assert.equal(pay.matchesPayment(tx, sent), true);
    assert.equal(pay.matchesPayment({ ...tx, amountKop: 425001 }, sent), false);
    assert.equal(pay.matchesPayment({ ...tx, at: new Date('2026-12-30') }, sent), false);
    assert.equal(pay.matchesPayment({ ...tx, direction: 'in' }, sent), false);
    // Референс пачки важливіший за суму (банк міг об'єднати).
    assert.equal(pay.matchesPayment({ ...tx, amountKop: 1, dlr: 'PACK1' }, sent), true);
    assert.equal(pay.matchesPayment(tx, { ...sent, status: 'paid' }), false);
});

test('регулярні отримувачі за історією списань', () => {
    const tx = (date, amountKop, purpose, iban = SUPPLIER, name = 'ТОВ Ліфт-Сервіс') =>
        ({ at: new Date(date), amountKop, purpose, counterparty: { name, account: iban, code: '12345678' } });
    const history = [
        tx('2026-08-05', 420000, 'Обслуговування ліфтів за серпень 2026'),
        tx('2026-09-05', 425000, 'Обслуговування ліфтів за вересень 2026'),
        tx('2026-10-06', 425000, 'Обслуговування ліфтів за жовтень 2026'),
        tx('2026-10-06', 99000, 'Разова закупівля лампочок', iban('3220010000026007233566001'), 'ФОП Іванов'),
        tx('2026-09-20', 190234, 'ЄСВ за серпень', iban('8999980000031119101003011'), 'ГУ ДПС')
    ];
    const list = pay.recurringRecipients(history);
    assert.equal(list.length, 1);
    assert.deepEqual([list[0].recipient.name, list[0].amountKop, list[0].day, list[0].months], ['ТОВ Ліфт-Сервіс', 425000, 6, 3]);
});

test('призначення переноситься на новий місяць', () => {
    const nov = new Date('2026-11-03');
    assert.equal(pay.purposeForMonth('Обслуговування ліфтів за жовтень 2026', nov), 'Обслуговування ліфтів за листопад 2026');
    assert.equal(pay.purposeForMonth('Прибирання за 10.2026', nov), 'Прибирання за 11.2026');
    assert.equal(pay.purposeForMonth('Оплата згідно рахунку', nov), 'Оплата згідно рахунку');
    assert.equal(pay.purposeForMonth('Послуги до 15 жовтня', nov), 'Послуги до 15 листопада');
});

test('платіж цього місяця вже є — не пропонуємо вдруге', () => {
    const rec = { key: SUPPLIER };
    const now = new Date('2026-11-10');
    assert.equal(pay.alreadyPaidThisMonth(rec, [], [{ at: new Date('2026-11-05'), counterparty: { account: SUPPLIER } }], now), true);
    assert.equal(pay.alreadyPaidThisMonth(rec, [{ recipient: { iban: SUPPLIER }, status: 'sent', createdAt: new Date('2026-11-02') }], [], now), true);
    assert.equal(pay.alreadyPaidThisMonth(rec, [{ recipient: { iban: SUPPLIER }, status: 'canceled', createdAt: new Date('2026-11-02') }], [], now), false);
    assert.equal(pay.alreadyPaidThisMonth(rec, [], [{ at: new Date('2026-10-05'), counterparty: { account: SUPPLIER } }], now), false);
});
