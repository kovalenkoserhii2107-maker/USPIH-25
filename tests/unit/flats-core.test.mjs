// «Квартири»: список, відбори, пошук, історія з сальдо й акт звірки.
import test from 'node:test';
import assert from 'node:assert/strict';
import { flatRows, flatCounts, filterFlats, ledgerRows, lastPayment, reconciliationCsv } from '../../js/flats-core.js';

const apartments = [
    { apt: '7', area: 61.4, balance: -1243.28, personalAccount: '10007' },
    { apt: '19', area: 48, balance: 0 },
    { apt: '112', area: 74.6, balance: 312.4 },
    { apt: '156', area: 48, balance: -3012 },
    { apt: '23', area: 52.1, balance: -548.36 }
];
const monthly = new Map([['7', 31082], ['19', 24750], ['112', 44380], ['156', 25095], ['23', 27416]]);
const owners = new Map([['7', 'Власник Перший'], ['156', 'Власник Другий']]);
const rows = flatRows({ apartments, monthly, owners });

test('рядки: борг у копійках і скільки це місячних внесків', () => {
    assert.deepEqual(rows.map(r => r.apt), ['7', '19', '23', '112', '156']);
    const r7 = rows.find(r => r.apt === '7');
    assert.deepEqual([r7.debtKop, r7.months, r7.owner, r7.personalAccount], [124328, 4, 'Власник Перший', '10007']);
    assert.equal(rows.find(r => r.apt === '156').months, 12);
    assert.equal(rows.find(r => r.apt === '23').months, 2);
    assert.equal(rows.find(r => r.apt === '112').debtKop, 0);
});

test('відбори й пошук', () => {
    assert.deepEqual(flatCounts(rows), { debt: 3, long: 2, over: 1, all: 5 });
    assert.deepEqual(filterFlats(rows, 'debt').map(r => r.apt), ['156', '7', '23']);
    assert.deepEqual(filterFlats(rows, 'long').map(r => r.apt), ['156', '7']);
    assert.deepEqual(filterFlats(rows, 'over').map(r => r.apt), ['112']);
    assert.deepEqual(filterFlats(rows, 'all').map(r => r.apt), ['7', '19', '23', '112', '156']);
    // Номер — серед усіх квартир, незалежно від відбору; імʼя — без регістру.
    assert.deepEqual(filterFlats(rows, 'debt', '1').map(r => r.apt), ['19', '112', '156']);
    assert.deepEqual(filterFlats(rows, 'over', 'другий').map(r => r.apt), ['156']);
});

const at = s => new Date(`${s}T12:00:00`);
const entries = [
    { kind: 'payment', amount: 274.18, at: at('2026-11-12'), note: 'Оплата' },
    { kind: 'charge', amount: 274.18, at: at('2026-10-01'), period: '2026-10' },
    { kind: 'opening', amount: -548.36, at: at('2026-09-30') },
    { kind: 'charge', amount: 100, at: at('2026-09-01') }
];

test('історія: сальдо після кожного запису, вхідний залишок перекриває попередні', () => {
    const list = ledgerRows(entries);
    assert.deepEqual(list.map(r => [r.kind, r.signedKop, r.balanceKop]), [
        ['payment', 27418, -54836], ['charge', -27418, -82254], ['opening', -54836, -54836], ['charge', -10000, -10000]
    ]);
    assert.deepEqual(lastPayment(entries), { at: at('2026-11-12'), amountKop: 27418 });
    assert.equal(lastPayment([]), null);
});

test('акт звірки: CSV з BOM, нараховано й сплачено окремими стовпцями', () => {
    const csv = reconciliationCsv('23', ledgerRows(entries));
    assert.ok(csv.startsWith('﻿Квартира;23'));
    const lines = csv.split('\r\n');
    assert.equal(lines[2], 'Дата;Операція;Нараховано;Сплачено;Сальдо (мінус — борг);Примітка');
    assert.equal(lines[3], '01.09.2026;Нараховано;100,00;;-100,00;');
    assert.equal(lines.at(-1), '12.11.2026;Оплата;;274,18;-548,36;Оплата');
});

test('будинок: глибина боргу, підсумки, відбори, підʼїзди, графік сальдо', async () => {
    const { depthOf, depthBuckets, houseKpis, selectFlats, byEntrance, balanceSeries } = await import('../../js/flats-core.js');
    const withMore = rows.map(r => ({ ...r, entrance: Number(r.apt) > 50 ? '2' : '1', ownersStatus: r.apt === '19' ? 'pending' : 'confirmed',
        claimStep: r.apt === '156' ? 'pretrial' : 'start' }));
    assert.deepEqual(withMore.map(depthOf), ['m6', 'ok', 'm3', 'over', 'm12']);
    const b = depthBuckets(withMore);
    assert.deepEqual([b.over.n, b.ok.n, b.m3.kop, b.m12.n], [1, 1, 54836, 1]);
    const k = houseKpis(withMore);
    assert.deepEqual([k.total, k.debtors, k.debtKop, k.long, k.over, k.overKop, k.claims, k.unverified], [5, 3, 124328 + 301200 + 54836, 2, 1, 31240, 1, 1]);
    assert.deepEqual(selectFlats(withMore, { filter: 'claims' }).map(r => r.apt), ['156']);
    assert.deepEqual(selectFlats(withMore, { filter: 'unverified' }).map(r => r.apt), ['19']);
    assert.deepEqual(selectFlats(withMore, { filter: 'm6' }).map(r => r.apt), ['7']);
    assert.deepEqual(selectFlats(withMore, { entrance: '2', sort: 'debt' }).map(r => r.apt), ['156', '112']);
    assert.deepEqual(selectFlats(withMore, { query: '1000' }).map(r => r.apt), ['7']);
    assert.deepEqual(byEntrance(withMore).map(([e, list]) => [e, list.length]), [['1', 3], ['2', 2]]);
    const s = balanceSeries(ledgerRows(entries), 100, 50, 0);
    assert.equal(s.points.length, 4);
    assert.deepEqual([s.points[0].x, s.points.at(-1).x, s.max], [0, 100, 0]);
    assert.equal(s.zeroY, 0);
});
