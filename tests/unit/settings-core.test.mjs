// «Налаштування»: розділи, готовність кабінету, ставки податків.
import test from 'node:test';
import assert from 'node:assert/strict';
import { sectionKey, readiness, readinessSummary, parseRateRow, nextRateRow, rateFor } from '../../js/settings-core.js';

const RATE_2026 = { from: '2026-01', to: '2026-12', pdfo: 1800, vz: 500, esv: 2200, minWageKop: 864700, maxBaseMult: 20, subsistenceKop: 332800 };

test('розділи: старі вкладки ведуть у нові', () => {
    assert.equal(sectionKey('org'), 'org');
    assert.equal(sectionKey('directories'), 'overview');
    assert.equal(sectionKey('невідома'), 'overview');
});

test('готовність: порожній кабінет — усе обовʼязкове треба зробити', () => {
    const items = readiness({}, '2026-10');
    const s = readinessSummary(items);
    assert.equal(s.done, 0);
    assert.equal(s.total, 7);
    assert.equal(s.next.key, 'pay');
    assert.equal(s.bySection.org, 2);
    assert.equal(s.bySection.bank, 1, 'AI й YouScore — додаткові, не рахуються');
    assert.match(items.find(i => i.key === 'rates').note, /немає чинних ставок/);
});

test('готовність: налаштований кабінет', () => {
    const items = readiness({
        requisites: { payeeName: 'ОСББ (демо)', edrpou: '12345678', iban: 'UA213052990000026007054321001' },
        xml: { sti: 1555, katottg: 'UA51100270010065487', headTin: '1234567890' },
        bank: { tokenSet: true, accounts: { a: {}, b: {} }, lastSync: { ok: true } },
        policy: { status: 'approved', startDate: '2026-10-01' },
        rates: [RATE_2026, { ...RATE_2026, from: '2027-01', to: '2027-12' }],
        opening: { set: true, count: 60 },
        osv: 'approved', aiKey: true, youscore: false
    }, '2026-10');
    const s = readinessSummary(items);
    assert.equal(s.done, s.total);
    assert.equal(s.next, null);
    assert.equal(items.find(i => i.key === 'pay').note, 'IBAN …1001 · ЄДРПОУ 12345678');
    assert.equal(items.find(i => i.key === 'privat').note, 'Підключено · рахунків: 2');
    assert.equal(items.find(i => i.key === 'policy').note, 'Погоджено · облік з 01.10.2026');
    assert.equal(items.find(i => i.key === 'youscore').state, 'todo');
});

test('готовність: чекає голову, помилка банку, ставки закінчуються', () => {
    const items = readiness({
        bank: { tokenSet: true, lastSync: { ok: false, error: 'таймаут' } },
        policy: { status: 'draft' }, osv: 'draft', rates: [RATE_2026]
    }, '2026-10');
    const by = k => items.find(i => i.key === k);
    assert.equal(by('privat').state, 'warn');
    assert.match(by('privat').note, /таймаут/);
    assert.equal(by('policy').state, 'wait');
    assert.equal(by('osv').state, 'wait');
    assert.equal(by('rates').state, 'warn');
    assert.equal(by('rates').note, 'Діють до кінця грудня 2026 — додайте ставки на наступний рік');
    assert.equal(readiness({ rates: [RATE_2026] }, '2026-06').find(i => i.key === 'rates').state, 'ok');
});

test('ставки: форма → сервер і наступний рік', () => {
    assert.deepEqual(parseRateRow({ from: '2027-01', to: '2027-12', pdfo: '18', vz: '5,0', esv: '22', minWage: '9 000,00', maxBaseMult: '20', subsistence: '3 500' }),
        { from: '2027-01', to: '2027-12', pdfo: 1800, vz: 500, esv: 2200, minWageKop: 900000, maxBaseMult: 20, subsistenceKop: 350000 });
    assert.deepEqual(nextRateRow([RATE_2026]), { ...RATE_2026, from: '2027-01', to: '2027-12' });
    assert.equal(nextRateRow([]).from, '2026-01');
    assert.equal(rateFor('2026-05', [RATE_2026]), RATE_2026);
    assert.equal(rateFor('2027-01', [RATE_2026]), null);
});
