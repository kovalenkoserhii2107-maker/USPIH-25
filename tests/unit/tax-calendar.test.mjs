import test from 'node:test';
import assert from 'node:assert/strict';
import { deadlines, fileBy, payBy, daysLeft } from '../../js/tax-calendar.js';

const iso = d => d.toISOString().slice(0, 10);
const find = (list, key) => list.find(e => e.key === key);

test('перенесення з вихідних', () => {
    assert.equal(iso(fileBy(new Date('2026-12-20'))), '2026-12-21');   // неділя → понеділок
    assert.equal(iso(payBy(new Date('2026-12-20'))), '2026-12-18');    // неділя → пʼятниця
    assert.equal(iso(fileBy(new Date('2026-10-20'))), '2026-10-20');
});

test('строки збігаються з календарем дослідження (LEGAL.md, розділ 11)', () => {
    const list = deadlines(new Date('2026-10-01'), new Date('2027-12-31'));
    assert.equal(iso(find(list, 'j0500111-2026-9').date), '2026-10-20');
    assert.equal(iso(find(list, 'j0500111-2026-11').date), '2026-12-21');
    assert.equal(iso(find(list, 'esv-2026-11').date), '2026-12-18');
    assert.equal(iso(find(list, 'j0500111-2027-1').date), '2027-02-22');
    assert.equal(iso(find(list, 'esv-2027-1').date), '2027-02-19');
    assert.equal(iso(find(list, 'j0500111-2027-5').date), '2027-06-21');
    assert.equal(iso(find(list, 'j0500111-2027-10').date), '2027-11-22');
    assert.equal(iso(find(list, 'npo-2026').date), '2027-03-01');
    assert.equal(iso(find(list, 'fs-stat-2026').date), '2027-02-26');
    assert.equal(iso(find(list, 'budget-2027').date), '2026-12-31');
});

test('без працівників — без розрахунку й ЄСВ; земля — лише за ознакою', () => {
    const quiet = deadlines(new Date('2027-01-01'), new Date('2027-03-31'), { payroll: false, land: false });
    assert.equal(quiet.some(e => e.key.startsWith('j0500111')), false);
    assert.equal(quiet.some(e => e.key.startsWith('land')), false);
    const land = deadlines(new Date('2027-01-01'), new Date('2027-03-31'), { payroll: false, land: true });
    assert.equal(iso(find(land, 'land-2027').date), '2027-02-22');
});

test('відлік днів', () => {
    assert.equal(daysLeft(new Date('2026-10-20'), new Date(2026, 9, 9)), 11);
});
