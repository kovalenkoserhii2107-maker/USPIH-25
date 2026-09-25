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
