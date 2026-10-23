// «Нарахування»: що зробити зараз, підсумки збору, стан квартири, тарифи клітинки.
import test from 'node:test';
import assert from 'node:assert/strict';
import { nextChargesAction, collectionStats, rowState, filterStatement, tariffCell } from '../../js/charges-view-core.js';

const base = { period: '2026-10', current: '2026-10', tariffs: [{ id: 't' }], opening: true, due: ['2026-10'],
    preview: { totalKop: 2325270, rows: new Array(60).fill({}), problems: [] } };

test('головна підказка: від тарифів до нарахованого місяця', () => {
    assert.equal(nextChargesAction({ ...base, unfinished: [{ kind: 'run' }] }).act, 'resume');
    assert.equal(nextChargesAction({ ...base, tariffs: [] }).tab, 'tariffs');
    const run = nextChargesAction(base);
    assert.deepEqual([run.act, run.tone, run.key], ['run', 'todo', true]);
    assert.match(run.title, /23\s252,70/);
    const early = nextChargesAction({ ...base, due: [] });
    assert.deepEqual([early.act, early.tone, early.btn], ['run', 'wait', 'Нарахувати зараз']);
    assert.equal(nextChargesAction({ ...base, period: '2026-11' }).tone, 'wait');
    assert.equal(nextChargesAction({ ...base, preview: { rows: [], problems: [{}] } }).tab, 'premises');
    const done = { totalKop: 2325270, count: 60, problems: [] };
    assert.equal(nextChargesAction({ ...base, run: { ...done, problems: [{ apt: '5', reason: 'немає площі' }] } }).tab, 'premises');
    assert.equal(nextChargesAction({ ...base, run: done, preview: { ...base.preview, totalKop: 2400000 } }).act, 'recalc');
    assert.equal(nextChargesAction({ ...base, run: done, opening: false }).go, 'settings');
    const ok = nextChargesAction({ ...base, run: done, stats: { pct: 28, debtKop: 31662905, debtors: 52 } });
    assert.equal(ok.tone, 'done');
    assert.match(ok.title, /сплачено 28%/);
});

test('збір внесків і стан квартири', () => {
    const st = { totals: { charged: 1000, paid: 280, debt: -5000, debtors: 2 }, rows: [
        { apt: '1', charged: 100, paid: 0, closing: -500 }, { apt: '2', charged: 100, paid: 50, closing: -50 },
        { apt: '3', charged: 100, paid: 300, closing: 200 }, { apt: '4', charged: 100, paid: 100, closing: 0 }] };
    assert.deepEqual(collectionStats(st), { chargedKop: 1000, paidKop: 280, pct: 28, debtKop: 5000, debtors: 2, overKop: 200, overCount: 1, paidCount: 3, total: 4 });
    assert.deepEqual(st.rows.map(rowState).map(s => s[0]), ['борг ≈ 5 міс.', 'сплачено частково', 'переплата', 'розраховано']);
    assert.deepEqual(filterStatement(st.rows, 'debt').map(r => r.apt), ['1', '2']);
    assert.deepEqual(filterStatement(st.rows, 'unpaid').map(r => r.apt), ['1']);
    assert.deepEqual(filterStatement(st.rows, 'deep').map(r => r.apt), ['1']);
    assert.deepEqual(filterStatement(st.rows, 'all', 'кв. 3').map(r => r.apt), ['3']);
});

test('тарифи клітинки: чинний, наступний, історія', () => {
    const t = [{ group: 'res', component: 'main', from: '2026-01', rate4: 1 }, { group: 'res', from: '2026-10', rate4: 2 },
        { group: 'res', component: 'main', from: '2027-01', rate4: 3 }, { group: 'nonres', component: 'main', from: '2026-01', rate4: 9 }];
    const c = tariffCell(t, 'res', 'main', '2026-10');
    assert.deepEqual([c.current.rate4, c.next.rate4, c.history.length], [2, 3, 3]);
    assert.equal(tariffCell(t, 'res', 'lift', '2026-10').current, null);
});
