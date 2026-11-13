'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const s = require('./statement-core');

// Контрольні IBAN з правильною сумою (ISO 13616).
const PRIVAT = 'UA883052990000026007054321001';
const OSCHAD = 'UA503004650000026001234567890';

test('IBAN: контрольна сума й банк за МФО', () => {
    assert.equal(s.validIban(PRIVAT), true);
    assert.equal(s.validIban(OSCHAD), true);
    assert.equal(s.validIban('UA503004650000026001234567891'), false);
    assert.equal(s.validIban('UA12'), false);
    assert.equal(s.bankOf(PRIVAT), 'ПриватБанк');
    assert.equal(s.bankOf(OSCHAD), 'Ощадбанк');
    assert.equal(s.bankOf('UA713999990000026001234567890'), 'Банк (МФО 399999)');
    assert.equal(s.isPrivat(PRIVAT), true);
    assert.equal(s.isPrivat(OSCHAD), false);
});

const row = (date, direction, amountKop, extra = {}) => ({ date, direction, amountKop, purpose: 'Внески, кв. 5', name: 'Власник Тестовий 5', code: '', account: '', ref: '', ...extra });

test('Виписка: перевірка дат, сум і рівняння залишків', () => {
    const ok = s.cleanStatement({ from: '2026-10-01', to: '2026-10-31', openingKop: 100000, closingKop: 130000,
        rows: [row('2026-10-05', 'in', 50000), row('2026-10-10', 'out', 20000)] }, { iban: OSCHAD, today: '2026-11-13', startDate: '2026-10-01' });
    assert.deepEqual([ok.rows.length, ok.inKop, ok.outKop], [2, 50000, 20000]);
    assert.throws(() => s.cleanStatement({ openingKop: 100000, closingKop: 999, rows: [row('2026-10-05', 'in', 50000)] }, { iban: OSCHAD, today: '2026-11-13' }), /не дають вихідного/);
    assert.throws(() => s.cleanStatement({ rows: [row('2026-12-05', 'in', 50000)] }, { iban: OSCHAD, today: '2026-11-13' }), /ще не настала/);
    assert.throws(() => s.cleanStatement({ rows: [row('2026-10-05', 'in', -1)] }, { iban: OSCHAD, today: '2026-11-13' }), /некоректна сума/);
    assert.throws(() => s.cleanStatement({ iban: PRIVAT, rows: [row('2026-10-05', 'in', 1)] }, { iban: OSCHAD, today: '2026-11-13' }), /іншому рахунку/);
    assert.throws(() => s.cleanStatement({ from: '2026-10-10', to: '2026-10-31', rows: [row('2026-10-05', 'in', 1)] }, { iban: OSCHAD, today: '2026-11-13' }), /за межі періоду/);
});

test('Операції з виписки: стабільні ідентифікатори, однакові рядки не злипаються', () => {
    const st = s.cleanStatement({ rows: [row('2026-10-05', 'in', 50000), row('2026-10-05', 'in', 50000), row('2026-10-06', 'out', 100, { name: 'Банк', purpose: 'Комісія' })] }, { iban: OSCHAD, today: '2026-11-13' });
    const a = s.toTransactions(st, OSCHAD), b = s.toTransactions(st, OSCHAD);
    assert.equal(new Set(a.map(t => t.bankId)).size, 3);
    assert.deepEqual(a.map(t => t.bankId), b.map(t => t.bankId));
    assert.equal(a[0].account, OSCHAD);
    // Полудень за Києвом — та сама дата в київському часі.
    assert.equal(new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Kyiv' }).format(a[0].at), '2026-10-05');
});

test('Залишок на кінець дня: найближчий якір і рух після дати', () => {
    const txs = [{ date: '2026-11-02', direction: 'in', amountKop: 1000 }, { date: '2026-11-05', direction: 'out', amountKop: 300 }, { date: '2026-10-31', direction: 'in', amountKop: 5 }];
    assert.equal(s.balanceAt('2026-10-31', [{ date: '2026-11-10', balanceKop: 10000 }], txs).balanceKop, 9300);
    assert.equal(s.balanceAt('2026-10-31', [{ date: '2026-11-10', balanceKop: 10000 }, { date: '2026-11-01', balanceKop: 9300 }], txs).anchorDate, '2026-11-01');
    assert.equal(s.balanceAt('2026-10-31', [{ date: '2026-10-30', balanceKop: 1 }], txs), null);
    assert.deepEqual(s.statementAnchors({ from: '2026-10-01', to: '2026-10-31', openingKop: 5, closingKop: 7 }), [{ date: '2026-09-30', balanceKop: 5 }, { date: '2026-10-31', balanceKop: 7 }]);
});

test('Звірка місяця: автоматично з API і виписки, вручну — де залишку немає', () => {
    const rows = [{ acc: '311', iban: PRIVAT, balanceKop: 5000 }, { acc: '311', iban: OSCHAD, balanceKop: 7000 }];
    const accounts = [{ iban: PRIVAT, source: 'privat', balanceKop: 6000, balanceDate: '2026-11-13' }, { iban: OSCHAD, source: 'file' }];
    const txs = [{ account: PRIVAT, date: '2026-11-03', direction: 'in', amountKop: 1000 }];
    const early = s.reconcileBank({ lastDay: '2026-10-31', today: '2026-10-31', rows, accounts, txs });
    assert.equal(early.done, false);
    assert.match(early.checks[0].text, /після 31\.10\.2026/);

    const half = s.reconcileBank({ lastDay: '2026-10-31', today: '2026-11-13', rows, accounts, txs });
    assert.deepEqual(half.rows.map(r => r.state), ['match', 'none']);
    assert.equal(half.rows[1].bank, 'Ощадбанк');
    assert.match(half.checks.find(c => c.level === 'block').text, /Немає залишку банку на 31\.10\.2026: …7890 \(Ощадбанк\)/);

    const anchors = [{ iban: OSCHAD, date: '2026-10-31', balanceKop: 7000, source: 'statement' }];
    const full = s.reconcileBank({ lastDay: '2026-10-31', today: '2026-11-13', rows, accounts, txs, anchors });
    assert.equal(full.done, true);
    assert.match(full.checks[0].text, /збігаються з обліком: 2 рах\./);

    const manual = s.reconcileBank({ lastDay: '2026-10-31', today: '2026-11-13', rows, accounts, txs, key: 'k', cut: { key: 'k', rows: [{ acc: '311', iban: OSCHAD, balanceKop: 7000 }] } });
    assert.equal(manual.done, true);
    assert.match(manual.checks[0].text, /1 — звірено вручну/);

    // Немає вхідного залишку: в обліку мінус, у банку плюс.
    const minus = s.reconcileBank({ lastDay: '2026-10-31', today: '2026-11-13', rows: [{ acc: '311', iban: PRIVAT, balanceKop: -4482676 }], accounts: [{ iban: PRIVAT, source: 'privat', balanceKop: 5386899, balanceDate: '2026-11-13' }] });
    assert.equal(minus.rows[0].state, 'diff');
    assert.match(minus.checks[0].text, /облік −?-?44 826,76, банк 53 868,99/);
    assert.match(minus.checks[0].text, /Вхідній ОСВ/);
});
