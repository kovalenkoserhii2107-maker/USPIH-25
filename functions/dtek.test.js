'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { daySlots, extractAssignment } = require('./dtek');

test('сусідні півгодини графіка обʼєднуються', () => {
    assert.deepEqual(daySlots({ '18': 'second', '19': 'no' }), [
        { from: '17:30', to: '19:00', hours: 1.5, maybe: false }
    ]);
});

test('JSON ДТЕК читається з присвоєння без регулярного виразу', () => {
    const html = '<script>DisconSchedule.preset = {"data":{"G":{"1":{}}}};</script>';
    assert.deepEqual(extractAssignment(html, 'preset').data.G['1'], {});
});

test('фактичний графік: дні за київською датою, черга з половинками', () => {
    // 17.10.2026 00:00 за Києвом (UTC+3) = 16.10.2026 21:00 UTC
    const today = Date.UTC(2026, 9, 16, 21) / 1000, tomorrow = today + 86400;
    const hours = (map) => Object.fromEntries(Array.from({ length: 24 }, (_, i) => [String(i + 1), map[i + 1] || 'yes']));
    const html = `<script>DisconSchedule.preset = {"data":{"GPV3.1":{"6":{"1":"no"}}},"updateFact":"старе"};
        DisconSchedule.fact = ${JSON.stringify({ data: {
            [today]: { 'GPV3.1': hours({ 11: 'no', 12: 'no' }), 'GPV3.2': hours({}) },
            [tomorrow]: { 'GPV3.1': hours({ 8: 'second', 9: 'no' }) } }, update: '17.10.2026 09:54', today })};</script>`;
    const { parseSchedule } = require('./dtek');
    const parsed = parseSchedule(html);
    assert.equal(parsed.fact.today, '2026-10-17');
    assert.equal(parsed.updatedText, '17.10.2026 09:54');
    assert.deepEqual(parsed.fact.days['GPV3.1']['2026-10-17'], [{ from: '10:00', to: '12:00', hours: 2, maybe: false }]);
    assert.deepEqual(parsed.fact.days['GPV3.1']['2026-10-18'], [{ from: '07:30', to: '09:00', hours: 1.5, maybe: false }]);
    assert.deepEqual(parsed.fact.days['GPV3.2']['2026-10-17'], []);
    // тижневий шаблон лишається довідкою
    assert.deepEqual(parsed.week['GPV3.1']['6'], [{ from: '00:00', to: '01:00', hours: 1, maybe: false }]);
});

test('сторінка лише з фактичним графіком теж читається', () => {
    const html = `DisconSchedule.fact = {"data":{"1792184400":{"GPV1.1":{"1":"no"}}},"update":"x","today":1792184400};`;
    const { parseSchedule } = require('./dtek');
    const parsed = parseSchedule(html);
    assert.ok(parsed);
    assert.deepEqual(parsed.groups, ['GPV1.1']);
});
