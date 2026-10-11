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

test('строки: сплачене й подане не нагадуємо; поданий без № 2 понад 5 днів — нагадати', async () => {
    const { reportTasks, nextDeadline, receiptOverdue } = await import('../../js/reports-view-core.js');
    const ctx = { today: '2026-11-10', start: '2026-10', hasPeople: true, payrollMonths: [], statuses: {
        'esv-2026-10': { status: 'paid' }, 'j0500111-2026-10': { status: 'submitted', date: '2026-11-03' } } };
    const tasks = reportTasks(ctx);
    const esv = tasks.find(t => t.key === 'esv-2026-10'), rep = tasks.find(t => t.key === 'j0500111-2026-10');
    assert.deepEqual([esv.done, rep.done, rep.waiting], [true, false, true]);
    // Ні сплачений ЄСВ, ні поданий розрахунок за жовтень не стають «наступним строком».
    const next = nextDeadline(tasks);
    assert.ok(next && !['esv-2026-10', 'j0500111-2026-10'].includes(next.key), next?.key);
    assert.equal(receiptOverdue(rep, '2026-11-07'), false);
    assert.equal(receiptOverdue(rep, '2026-11-08'), true);
    // Вересень — до початку обліку: його строки не показуємо зовсім.
    assert.ok(!tasks.some(t => t.key === 'esv-2026-9'));
    // Прострочене — першим.
    const late = nextDeadline(reportTasks({ ...ctx, today: '2026-11-25', statuses: {} }));
    assert.ok(late.left < 0, JSON.stringify(late));
});

test('кроки: завантажений пакет — «готово до підпису», подано — з номером версії', () => {
    const ready = reportSteps({ approved: true, pack: { version: 2 } });
    assert.deepEqual(states(ready), ['done', 'done', 'current', 'next']);
    assert.match(ready[1].note, /Версія 2/);
    assert.equal(nextAction(ready).label, 'Голова подав — додати квитанцію № 1');
    const sent = reportSteps({ approved: true, pack: { version: 3 }, mark: { status: 'submitted', packageVersion: 2 } });
    assert.match(sent[2].note, /версію 2/);
});
