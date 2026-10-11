// «Банк»: операції за днями, відбори, рішення в один дотик.
import test from 'node:test';
import assert from 'node:assert/strict';
import { dayLabel, byDay, quickAssign, filterTx } from '../../js/bank-view-core.js';

const now = new Date(2026, 10, 12, 15, 0);
const at = (d, h = 10) => new Date(2026, 10, d, h);

test('дні: сьогодні, учора, дата; інший рік — з роком', () => {
    assert.equal(dayLabel(at(12, 1), now), 'Сьогодні');
    assert.equal(dayLabel(at(11, 23), now), 'Учора');
    assert.equal(dayLabel(at(10), now), '10 листопада');
    assert.match(dayLabel(new Date(2025, 11, 31), now), /31 грудня 2025/);
    const groups = byDay([{ id: 1, at: at(12) }, { id: 2, at: at(12, 8) }, { id: 3, at: at(11) }, { id: 4, at: at(10) }], now);
    assert.deepEqual(groups.map(g => [g.label, g.rows.map(r => r.id)]), [['Сьогодні', [1, 2]], ['Учора', [3]], ['10 листопада', [4]]]);
});

test('рішення в один дотик — лише одна квартира для надходження', () => {
    const tx = (extra) => ({ status: 'review', direction: 'in', kind: 'payment', ...extra });
    assert.deepEqual(quickAssign(tx({ suggestions: [{ apt: '112', reason: 'імʼя власника' }] })), { apt: '112', sure: true });
    assert.deepEqual(quickAssign(tx({ suggestions: [{ apt: 203, reason: 'число в призначенні' }] })), { apt: '203', sure: false });
    assert.equal(quickAssign(tx({ suggestions: [{ apt: '1' }, { apt: '2' }] })), null);
    assert.equal(quickAssign(tx({ suggestions: [] })), null);
    assert.equal(quickAssign(tx({ kind: 'income', suggestions: [{ apt: '1' }] })), null);
    assert.equal(quickAssign(tx({ direction: 'out', suggestions: [{ apt: '1' }] })), null);
    assert.equal(quickAssign({ status: 'done', direction: 'in', suggestions: [{ apt: '1' }] }), null);
});

test('відбори й пошук', () => {
    const list = [
        { id: 'a', status: 'review', amountKop: 27418, counterparty: { name: 'Платник А' }, purpose: 'внесок кв 47' },
        { id: 'b', status: 'done', amountKop: 41250, allocations: [{ apt: '19' }], purpose: 'кв 19' },
        { id: 'c', status: 'done', amountKop: 684000, counterparty: { name: 'Перевізник' }, purpose: 'рахунок 418' }
    ];
    assert.deepEqual(filterTx(list, 'review').map(t => t.id), ['a']);
    assert.deepEqual(filterTx(list, 'done').map(t => t.id), ['b', 'c']);
    assert.deepEqual(filterTx(list, 'all', 'кв 19').map(t => t.id), ['b']);
    assert.deepEqual(filterTx(list, 'all', '6840').map(t => t.id), ['c']);
    assert.deepEqual(filterTx(list, 'all', 'платник').map(t => t.id), ['a']);
});
