import test from 'node:test';
import assert from 'node:assert/strict';
import { hasRight, TAB_RIGHTS, fetchStaffRole, requireRight } from '../../js/staff-core.js';

test('права ролей: правління веде людей, бухгалтер — гроші, голова — усе', () => {
    assert.equal(hasRight('chair', 'chair'), true);
    assert.equal(hasRight('board', 'manage'), true);
    assert.equal(hasRight('board', 'account'), false);
    assert.equal(hasRight('accountant', 'account'), true);
    assert.equal(hasRight('accountant', 'manage'), false);
    assert.equal(hasRight(null, 'staff'), false);
    assert.equal(hasRight('resident', 'staff'), false);
    const tabs = role => Object.keys(TAB_RIGHTS).filter(tab => hasRight(role, TAB_RIGHTS[tab]));
    assert.ok(!tabs('board').includes('finance') && tabs('board').includes('meetings'));
    assert.ok(tabs('accountant').includes('finance') && !tabs('accountant').includes('polls'));
    assert.equal(tabs('chair').length, Object.keys(TAB_RIGHTS).length);
});

const fakeDb = docs => ({
    doc: (_db, ...path) => path.join('/'),
    getDocFromServer: async path => ({ exists: () => path in docs, data: () => docs[path] })
});

test('роль читається з staff, вимкнений запис і невідома роль доступу не дають', async () => {
    assert.equal(await fetchStaffRole(fakeDb({ 'staff/11': { role: 'board', active: true } }), null, '11'), 'board');
    assert.equal(await fetchStaffRole(fakeDb({ 'staff/11': { role: 'board', active: false } }), null, '11'), null);
    assert.equal(await fetchStaffRole(fakeDb({ 'staff/11': { role: 'admin', active: true } }), null, '11'), null);
    assert.equal(await fetchStaffRole(fakeDb({}), null, '45'), null);
    assert.equal(await fetchStaffRole(fakeDb({}), null, ''), null);
});

test('старий спільний запис без staff діє як голова, а вимкнений у staff — ні', async () => {
    assert.equal(await fetchStaffRole(fakeDb({ 'apartments/board': { isAdmin: true } }), null, 'board'), 'chair');
    assert.equal(await fetchStaffRole(fakeDb({ 'apartments/board': { isAdmin: true }, 'staff/board': { role: 'chair', active: false } }), null, 'board'), null);
    assert.throws(() => requireRight('board', 'account', 'Лише бухгалтер'), /Лише бухгалтер/);
    assert.doesNotThrow(() => requireRight('chair', 'account'));
});
