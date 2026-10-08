import test from 'node:test';
import assert from 'node:assert/strict';
import pdfMake from 'pdfmake/build/pdfmake.js';
import fonts from 'pdfmake/build/vfs_fonts.js';
import { decimalValue, normalizeMeterReading, meterSeries, validateMeterChanges } from '../../js/meter-core.js';
import { certificateAccount, buildDebtCertificateDoc, buildBoardProtocolDoc } from '../../js/admin-document-core.js';

pdfMake.vfs = fonts.pdfMake.vfs;
const record = (period, reading, tariff, extra = {}) => normalizeMeterReading({
    resource: 'electricity', period, reading, tariff, baseline: 100, unit: 'кВт·год', ...extra
});
const pdfText = async definition => {
    const pages = await new Promise(resolve => pdfMake.createPdf(definition)._getPages({}, resolve));
    return pages.map(page => page.items.filter(item => item.type === 'line')
        .map(({ item }) => item.inlines.map(inline => inline.text).join('')).join('\n')).join('\n');
};

test('числа з комою і пробілами читаються, невідомий баланс не стає нулем', () => {
    assert.equal(decimalValue('1 250,40'), 1250.4);
    assert.equal(decimalValue('0'), 0);
    for (const value of ['', null, undefined, 'невідомо', '123 грн', Infinity, '1,2,3']) assert.equal(decimalValue(value), null);
});

test('витрата й ціна беруть різницю, початковий показник і тариф свого місяця', () => {
    const rows = meterSeries([record('2026-04', 130, 3), record('2026-03', 110, 2)], 'electricity');
    assert.deepEqual(rows.map(row => [row.period, row.effectiveBaseline, row.consumption, row.cost]), [
        ['2026-03', 100, 10, 20], ['2026-04', 110, 20, 60]
    ]);
    assert.equal(rows[1].previousPeriod, '2026-03');
});

test('виправлення минулого показника перераховує сусідній інтервал, не змінюючи його тариф', () => {
    const records = [record('2026-03', 110, 2), record('2026-04', 130, 3)];
    const changes = validateMeterChanges(records, [record('2026-03', 125, 2)]);
    const rows = meterSeries([changes[0], records[1]], 'electricity');
    assert.deepEqual(rows.map(row => [row.consumption, row.cost]), [[25, 50], [5, 15]]);
    assert.throws(() => validateMeterChanges(records, [record('2026-03', 131, 2)]), /квітень.*менший за попередній/);
});

test('обнулення потребує явного нового початку, дробові витрати округлюються до копійок', () => {
    const records = [record('2026-03', 110, 2)];
    assert.throws(() => validateMeterChanges(records, [record('2026-04', 5, 3)]), /менший за попередній/);
    const reset = validateMeterChanges(records, [record('2026-04', 5, 3, { baseline: 0, reset: true })])[0];
    assert.equal(meterSeries([...records, reset], 'electricity')[1].cost, 15);
    const fraction = meterSeries([record('2026-03', '0,3', '0,3', { baseline: '0,1' })], 'electricity')[0];
    assert.equal(fraction.consumption, 0.2);
    assert.equal(fraction.cost, 0.06);
    assert.equal(normalizeMeterReading(record('2026-03', 110, 0)).tariff, 0);
});

test('нульовий тариф допустимий, порожній або від’ємний тариф і повтор ресурсу відхиляються', () => {
    for (const patch of [{ tariff: '' }, { tariff: -1 }, { reading: '' }, { baseline: '' }, { period: '2026-13' }]) {
        assert.throws(() => record('2026-03', 110, 2, patch));
    }
    assert.throws(() => validateMeterChanges([], [record('2026-03', 110, 2), record('2026-03', 120, 2)]), /лише один раз/);
});

test('зміна одиниці тепла потребує нового лічильника і нового початку обліку', () => {
    const first = record('2026-03', 20, 1000, { resource: 'heat', unit: 'Гкал', baseline: 10 });
    const second = record('2026-04', 25, 2000, { resource: 'heat', unit: 'МВт·год', baseline: 20 });
    assert.throws(() => validateMeterChanges([first], [second]), /одиниця|Одиниця/);
    const changed = validateMeterChanges([first], [{ ...second, reset: true, baseline: 0 }]);
    assert.equal(meterSeries([first, ...changed], 'heat')[1].consumption, 25);
});

test('довідка визначає борг за знаком балансу і не видає відсутність боргу за боржника', () => {
    const debt = { balance: '-1 250,40', personalAccount: '000123' };
    assert.deepEqual(certificateAccount(debt), { balance: -1250.4, account: '000123', debt: 1250.4, type: 'debt' });
    assert.throws(() => certificateAccount(debt, 'clear'), /відсутність сформувати не можна/);
    assert.equal(certificateAccount({ balance: 200, personalAccount: '000123' }).type, 'clear');
    assert.throws(() => certificateAccount({ balance: 0, personalAccount: '000123' }, 'debt'), /немає/);
    assert.equal(certificateAccount({ balance: -1.005, personalAccount: '000123' }).debt, 1.01);
    assert.throws(() => certificateAccount({ personalAccount: '000123' }), /Баланс/);
    assert.throws(() => certificateAccount({ balance: 0 }), /рахунок/);
});

test('PDF довідки друкує квартиру, особовий рахунок із нулями і правильний баланс', async () => {
    const args = { apt: '45', apartment: { balance: -1250.4, personalAccount: '000123' },
        date: '2026-10-08', number: '27', owners: [{ name: 'Петренко Іван' }] };
    const text = await pdfText(buildDebtCertificateDoc(args));
    assert.match(text, /ДОВІДКА ПРО ЗАБОРГОВАНІСТЬ/);
    assert.match(text, /000123/); assert.match(text, /Квартира \/ приміщення: 45/);
    assert.match(text, /Петренко Іван/); assert.match(text, /1\s250,40/);
    const clearText = await pdfText(buildDebtCertificateDoc({ ...args, apartment: { balance: 200, personalAccount: '000123' } }));
    assert.match(clearText, /ВІДСУТНІСТЬ ЗАБОРГОВАНОСТІ/);
    assert.match(clearText, /Переплата/); assert.match(clearText, /200,00/);
});

test('PDF протоколу правління зберігає введені рішення, присутніх і місця для підписів', async () => {
    const data = { number: '12', date: '2026-10-08', chair: 'Голова Правління', secretary: 'Секретар',
        present: 'Перший член\nДругий член', heard: 'Звіт про ремонт', decisions: '1. Виконати ремонт\n2. Затвердити кошторис' };
    assert.throws(() => buildBoardProtocolDoc({ ...data, decisions: '' }), /Вирішили/);
    const text = await pdfText(buildBoardProtocolDoc(data));
    assert.match(text, /ПРОТОКОЛ № 12/); assert.match(text, /Перший член/); assert.match(text, /Другий член/);
    assert.match(text, /1\. Виконати ремонт/); assert.match(text, /2\. Затвердити кошторис/);
    assert.match(text, /Голова засідання/); assert.match(text, /Секретар/);
});
