import test from 'node:test';
import assert from 'node:assert/strict';
import { periodName, periodStart, periodsBetween, toKop, fmtKop, parseOpeningLines, openingSummary, statementCsv, receiptPurpose } from '../../js/charges-core.js';

test('місяці', () => {
    assert.equal(periodName('2026-10'), 'жовтень 2026');
    assert.equal(periodStart('2026-11'), '01 листопада 2026');
    assert.deepEqual(periodsBetween('2026-10', '2027-01'), ['2027-01', '2026-12', '2026-11', '2026-10']);
    assert.deepEqual(periodsBetween('2026-10', '2026-09'), []);
});

test('суми в копійках', () => {
    assert.equal(toKop('1 250,40'), 125040);
    assert.equal(toKop('-1250.4'), -125040);
    assert.equal(toKop('−300'), -30000);
    assert.equal(toKop('0'), 0);
    assert.equal(toKop('12,345'), null);
    assert.equal(toKop('борг'), null);
    assert.equal(fmtKop(-125040).replace(/\s/g, ' '), '−1 250,40');
    assert.equal(fmtKop(0), '0,00');
});

test('вхідні залишки: формати рядків і знак', () => {
    const text = 'Кв;Сальдо\n45;-1250,40\nкв. 46; 210\n10 -1 000,00\n11\t0\nабракадабра\n45;-1300';
    const { rows, errors } = parseOpeningLines(text);
    assert.deepEqual(rows, [{ apt: '45', amountKop: -130000 }, { apt: '46', amountKop: 21000 }, { apt: '10', amountKop: -100000 }, { apt: '11', amountKop: 0 }]);
    assert.deepEqual(errors.map(e => e.line), [6]);
    // Сальдо з бухгалтерської програми: додатне — борг.
    assert.deepEqual(parseOpeningLines('45;1250,40\nн1;-100', 'debt').rows, [{ apt: '45', amountKop: -125040 }, { apt: 'н1', amountKop: 10000 }]);
    assert.deepEqual(openingSummary(rows), { count: 4, debtKop: -230000, overpaidKop: 21000, debtors: 2 });
});

test('відомість у CSV для Excel', () => {
    const csv = statementCsv({
        rows: [{ apt: '45', opening: -125040, charged: 54400, paid: 179440, closing: 0 }],
        totals: { opening: -125040, charged: 54400, paid: 179440, closing: 0 }
    }, new Map([['45', { personalAccount: '1045', area: 64 }]]));
    assert.ok(csv.startsWith('﻿Квартира;'));
    assert.deepEqual(csv.slice(1).split('\r\n').slice(1), ['45;1045;64;-1250,40;544,00;1794,40;0,00', 'Разом;;;-1250,40;544,00;1794,40;0,00']);
});

test('призначення у квитанції', () => {
    assert.equal(receiptPurpose('', '45', '1045', '2026-10'), 'Внески на утримання будинку, кв. 45, особовий рахунок 1045, за жовтень 2026');
    assert.equal(receiptPurpose('Внесок ОСББ, о/р {account}, кв. {apt}', '45', '1045'), 'Внесок ОСББ, о/р 1045, кв. 45');
    assert.equal(receiptPurpose('Внесок, кв. {apt}', '7', ''), 'Внесок, кв. 7');
});
