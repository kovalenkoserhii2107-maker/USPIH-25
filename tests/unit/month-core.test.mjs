// Закриття місяця крок за кроком: стан кроків з даних кабінету.
import test from 'node:test';
import assert from 'node:assert/strict';
import { monthSteps, monthProgress } from '../../js/month-core.js';

const period = '2026-10';
const ready = {
    period,
    journal: { period, status: 'open', canClose: true, checks: [{ level: 'ok', text: 'Проводки збалансовано' }] },
    charges: { runs: [{ period, count: 312, totalKop: 8663216, complete: true }] },
    bank: { count: 0, sumKop: 0 },
    expenses: { expenses: [{ period, status: 'approved', amountKop: 684000 }, { period: '2026-09', status: 'pending', amountKop: 100 }] },
    payroll: { status: 'approved', activePeople: 2, stages: { advance: { complete: true }, final: { complete: true } }, run: { totals: { grossKop: 1664700 } } }
};
const stateOf = (steps, key) => steps.find(s => s.key === key).state;

test('усе готово: пʼять кроків зроблено, закриття доступне тут же', () => {
    const steps = monthSteps(ready);
    assert.deepEqual(steps.map(s => s.key), ['charges', 'bank', 'docs', 'payroll', 'checks', 'close']);
    assert.deepEqual(steps.map(s => s.state), ['done', 'done', 'done', 'done', 'done', 'work']);
    assert.equal(steps[0].short.replace(/\s/g, ' '), '312 квартир · 86 632,16 грн');
    assert.equal(steps[2].short, '1 документ погоджено');
    const close = steps.at(-1);
    assert.equal(close.close, true);
    assert.equal(close.action, 'Закрити жовтень 2026');
    assert.deepEqual(monthProgress(steps), { done: 5, total: 6, next: close });
});

test('банк, документи й перевірки чекають — закриття заблоковане з переліком', () => {
    const steps = monthSteps({ ...ready,
        bank: { count: 6, sumKop: 921400 },
        expenses: { expenses: [...ready.expenses.expenses, { period, status: 'pending', amountKop: 1124560 }] },
        journal: { period, status: 'open', canClose: false, checks: [{ level: 'block', text: 'Виписку не розібрано' }, { level: 'warn', text: 'Комісія банку без документа' }] } });
    assert.equal(stateOf(steps, 'bank'), 'work');
    assert.equal(steps[1].short, '6 операцій чекають');
    assert.equal(steps[1].action, 'Розподілити 6');
    assert.equal(steps[2].short, '1 чекає погодження');
    assert.equal(stateOf(steps, 'checks'), 'work');
    assert.equal(steps[4].checks.length, 2);
    const close = steps.at(-1);
    assert.equal(close.state, 'locked');
    assert.equal(close.short, 'після: банк, документи витрат, перевірка обліку');
    assert.equal(monthProgress(steps).next.key, 'bank');
});

test('зарплата: немає працівників — не заважає; відомість не затверджена — дія', () => {
    assert.equal(monthSteps({ ...ready, payroll: { status: 'none', activePeople: 0, stages: {} } })[3].short, 'працівників немає');
    const draft = monthSteps({ ...ready, payroll: { status: 'draft', activePeople: 1, stages: {} } })[3];
    assert.deepEqual([draft.state, draft.short], ['work', 'чекає затвердження голови']);
    const paying = monthSteps({ ...ready, payroll: { status: 'approved', activePeople: 1, stages: { advance: { complete: true } } } })[3];
    assert.equal(paying.short, 'затверджено, виплату не завершено');
});

test('нарахування: не зроблено чи неповне; немає даних — не «готово»', () => {
    assert.equal(monthSteps({ ...ready, charges: { runs: [] } })[0].short, 'ще не нараховано');
    assert.equal(monthSteps({ ...ready, charges: { runs: [{ period, count: 300, totalKop: 1, complete: false }] } })[0].short, 'нарахування неповне');
    const unknown = monthSteps({ ...ready, charges: null, expenses: null, payroll: null });
    assert.deepEqual([unknown[0].state, unknown[2].state, unknown[3].state], ['unknown', 'unknown', 'unknown']);
});

test('закритий місяць: перевірка й закриття — готово, з датою', () => {
    const steps = monthSteps({ ...ready, journal: { period, status: 'closed', closedAt: '2026-11-14T10:00:00Z', checks: [] } });
    assert.equal(stateOf(steps, 'checks'), 'done');
    assert.equal(steps.at(-1).state, 'done');
    assert.match(steps.at(-1).short, /^закрито 14\.11\.2026$/);
    assert.equal(monthProgress(steps).done, 6);
});
