// «Звіти»: кроки Податкового розрахунку й вибір головного строку.
import test from 'node:test';
import assert from 'node:assert/strict';
import { reportSteps, nextAction, pickFocus } from '../../js/reports-view-core.js';

const states = s => s.map(x => x.state);

test('кроки: від відомості до квитанції № 2', () => {
    assert.deepEqual(states(reportSteps({ approved: false })), ['current', 'next', 'next', 'next']);
    assert.equal(nextAction(reportSteps({ approved: false })).act, 'go-payroll');
    const ready = reportSteps({ approved: true });
    assert.deepEqual(states(ready), ['done', 'current', 'next', 'next']);
    assert.equal(nextAction(ready).act, 'hero-xml');
    const sent = reportSteps({ approved: true, mark: { status: 'submitted', regNumber: '9001' } });
    assert.deepEqual(states(sent), ['done', 'done', 'done', 'current']);
    assert.match(sent[2].note, /№ 9001/);
    assert.equal(nextAction(sent).label, 'Додати квитанцію № 2');
    assert.deepEqual(states(reportSteps({ approved: true, mark: { status: 'accepted' } })), ['done', 'done', 'done', 'done']);
    assert.equal(nextAction(reportSteps({ approved: true, mark: { status: 'accepted' } })), null);
});

test('відхилено й «не потрібно»', () => {
    const bad = reportSteps({ approved: true, mark: { status: 'rejected', note: 'помилка в Д1' } });
    assert.equal(bad[3].state, 'bad');
    assert.match(bad[3].note, /помилка в Д1/);
    assert.equal(nextAction(bad).label, 'Подати знову');
    assert.deepEqual(states(reportSteps({ approved: false, mark: { status: 'not_required' } })), ['done', 'done', 'done', 'done']);
});

test('головний строк — найближчий розрахунок, збоку — інші найближчі', () => {
    const tasks = [
        { key: 'esv-2026-10', left: 9, done: false },
        { key: 'j0500111-2026-10', left: 30, done: false },
        { key: 'budget-2027', left: 81, done: false },
        { key: 'npo-2026', left: 40, done: false },
        { key: 'j0500111-2026-09', left: -5, done: true }
    ];
    const f = pickFocus(tasks);
    assert.equal(f.hero.key, 'j0500111-2026-10');
    assert.deepEqual(f.side.map(t => t.key), ['esv-2026-10', 'npo-2026']);
    assert.equal(pickFocus([{ key: 'esv-2026-10', left: 9, done: false }]).hero.key, 'esv-2026-10');
    assert.equal(pickFocus([]).hero, null);
    // Поданий, але без квитанції № 2 — усе ще головний.
    const sent = [{ key: 'j0500111-2026-10', left: 8, done: true, mark: { status: 'submitted' } }, { key: 'j0500111-2026-11', left: 39, done: false }];
    assert.equal(pickFocus(sent).hero.key, 'j0500111-2026-10');
    assert.equal(pickFocus([{ ...sent[0], mark: { status: 'accepted' } }, sent[1]]).hero.key, 'j0500111-2026-11');
});
