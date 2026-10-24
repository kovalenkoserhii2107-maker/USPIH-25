// Закриття місяця крок за кроком: стан кроків з даних кабінету.
import test from 'node:test';
import assert from 'node:assert/strict';
import { monthSteps, monthProgress, monthPhases, monthTotals } from '../../js/month-core.js';

const period = '2026-10';
const journal = {
    period, today: '2026-11-03', status: 'open', canClose: true, key: 'k1', checks: [{ level: 'ok', text: 'Проводки збалансовано' }],
    bankRows: [{ acc: '311', iban: 'UA213052990000026007054321001', balanceKop: 12845000 }], bankCut: { key: 'k1', note: 'виписка 31.10' },
    assetsSummary: { ozCount: 2, mnhmaCount: 1, dueDeprCount: 0, deprThisPeriodKop: 15000 },
    advanceSummary: { pendingCount: 0, toReimburseCount: 0, inBankCount: 0 }
};
const ready = {
    period, journal,
    charges: { runs: [{ period, count: 312, totalKop: 8663216, complete: true }] },
    bank: { count: 0, sumKop: 0 },
    expenses: { expenses: [{ id: 'e1', period, status: 'paid', amountKop: 684000, paidKop: 684000 }, { id: 'e0', period: '2026-09', status: 'pending', amountKop: 100 }], contracts: [], missing: [] },
    payroll: { status: 'approved', activePeople: 2, stages: { advance: { complete: true }, final: { complete: true } },
        run: { rows: [{ personId: 'e1', netKop: 1281819 }], totals: { grossKop: 1664700, pdfoKop: 299646, vzKop: 83235, esvKop: 366234 } },
        payments: [{ stage: 'final', key: 'e1', status: 'paid', amountKop: 1281819 }, { stage: 'final', key: 'pdfo', status: 'paid', amountKop: 299646 },
            { stage: 'final', key: 'vz', status: 'paid', amountKop: 83235 }, { stage: 'final', key: 'esv', status: 'paid', amountKop: 366234 }] },
    payments: [{ id: 'p1', expenseId: 'e1', status: 'paid', amountKop: 684000, createdAt: '2026-10-09T10:00:00Z' }],
    reports: [{ key: 'esv-2026-10', title: 'Сплатити ЄСВ', iso: '2026-11-20', left: 17, done: true }]
};
const by = (steps, key) => steps.find(s => s.key === key);

test('усе готово: кроки за фазами, закриття доступне тут же', () => {
    const steps = monthSteps(ready);
    assert.deepEqual(steps.map(s => s.key), ['charges', 'bank', 'bankcut', 'docs', 'payments', 'advance', 'payroll', 'reports', 'assets', 'checks', 'close']);
    assert.deepEqual(steps.map(s => s.state), ['done', 'done', 'done', 'done', 'done', 'done', 'done', 'done', 'done', 'done', 'work']);
    assert.equal(steps[0].short.replace(/\s/g, ' '), '312 квартир · 86 632,16 грн');
    assert.equal(by(steps, 'bankcut').short, 'звірено · виписка 31.10');
    assert.equal(by(steps, 'assets').short, 'амортизацію нараховано');
    const close = steps.at(-1);
    assert.equal(close.close, true);
    assert.equal(close.action, 'Закрити жовтень 2026');
    assert.deepEqual(monthProgress(steps), { done: 10, total: 11, next: close });
    assert.deepEqual(monthPhases(steps).map(p => [p.key, p.state, p.steps.length]),
        [['income', 'done', 1], ['bank', 'done', 2], ['costs', 'done', 3], ['payroll', 'done', 2], ['ledger', 'work', 3]]);
});

test('банк, документи й перевірки чекають — закриття заблоковане з переліком', () => {
    const steps = monthSteps({ ...ready,
        bank: { count: 6, sumKop: 921400 },
        expenses: { ...ready.expenses, expenses: [...ready.expenses.expenses, { id: 'e2', period, status: 'pending', amountKop: 1124560 }] },
        journal: { ...journal, canClose: false, checks: [{ level: 'block', text: 'Виписку не розібрано' }, { level: 'warn', text: 'Комісія банку без документа' }] } });
    assert.equal(by(steps, 'bank').state, 'work');
    assert.equal(by(steps, 'bank').short, '6 операцій чекають');
    assert.equal(by(steps, 'bank').action, 'Розподілити 6');
    assert.deepEqual([by(steps, 'docs').short, by(steps, 'docs').who], ['1 чекає погодження голови', 'chair']);
    assert.equal(by(steps, 'checks').state, 'work');
    assert.equal(by(steps, 'checks').checks.length, 2);
    const close = steps.at(-1);
    assert.equal(close.state, 'locked');
    assert.equal(close.short, 'після: операції виписки, документи витрат, перевірка обліку');
    assert.equal(monthProgress(steps).next.key, 'bank');
});

test('звірка банку: до кінця місяця недоступна, змінились операції — знову', () => {
    const early = by(monthSteps({ ...ready, journal: { ...journal, today: '2026-10-24', bankCut: null } }), 'bankcut');
    assert.deepEqual([early.state, early.short], ['locked', 'після 31.10.2026']);
    const changed = by(monthSteps({ ...ready, journal: { ...journal, bankCut: { key: 'old' } } }), 'bankcut');
    assert.deepEqual([changed.state, changed.short, changed.inline], ['work', 'операції змінились — звірте знову', 'bankcut']);
    assert.equal(by(monthSteps({ ...ready, journal: { ...journal, bankRows: [] } }), 'bankcut').short, 'рахунків для звірки немає');
});

test('документи: бракує акта за щомісячним договором', () => {
    const docs = by(monthSteps({ ...ready, expenses: { ...ready.expenses, contracts: [{ id: 'c1', supplierName: 'Ліфт (демо)' }], missing: [{ contractId: 'c1', period }, { contractId: 'c1', period: '2026-09' }] } }), 'docs');
    assert.deepEqual([docs.state, docs.short, docs.action], ['work', 'бракує 1 акта за договорами', 'Додати акти']);
    assert.deepEqual(docs.facts.at(-1), ['Бракує актів', 'Ліфт (демо)']);
});

test('платежі й авансові звіти: відхилене — дія, на підписі й до оплати — не заважають', () => {
    const bad = by(monthSteps({ ...ready, payments: [...ready.payments, { id: 'p2', status: 'failed', amountKop: 10, createdAt: '2026-10-12T10:00:00Z' }] }), 'payments');
    assert.equal(bad.state, 'work');
    const signing = by(monthSteps({ ...ready, payments: [{ id: 'p3', status: 'sent', amountKop: 50, payroll: { period } }] }), 'payments');
    assert.deepEqual([signing.state, signing.who], ['wait', 'chair']);
    const toPay = by(monthSteps({ ...ready, payments: [], expenses: { ...ready.expenses, expenses: [{ id: 'e3', period, status: 'approved', amountKop: 300 }] } }), 'payments');
    assert.deepEqual([toPay.state, toPay.short], ['wait', '1 документ до оплати']);
    assert.equal(by(monthSteps({ ...ready, payments: null }), 'payments').state, 'unknown');
    const adv = by(monthSteps({ ...ready, journal: { ...journal, advanceSummary: { pendingCount: 2, toReimburseCount: 0 } } }), 'advance');
    assert.deepEqual([adv.state, adv.who], ['wait', 'chair']);
    const steps = monthSteps({ ...ready, journal: { ...journal, advanceSummary: { pendingCount: 2 } } });
    assert.equal(monthProgress(steps).done, 10, 'крок, що не заважає закриттю, — пройдений');
});

test('зарплата: немає працівників — не заважає; відомість не затверджена; нові відпустки', () => {
    assert.equal(by(monthSteps({ ...ready, payroll: { status: 'none', activePeople: 0, stages: {} } }), 'payroll').short, 'працівників немає');
    const draft = by(monthSteps({ ...ready, payroll: { status: 'draft', activePeople: 1, stages: {} } }), 'payroll');
    assert.deepEqual([draft.state, draft.short], ['work', 'чекає затвердження голови']);
    const paying = by(monthSteps({ ...ready, payroll: { status: 'approved', activePeople: 1, stages: { advance: { complete: true } } } }), 'payroll');
    assert.equal(paying.short, 'затверджено, виплату не завершено');
    const leaves = by(monthSteps({ ...ready, payroll: { status: 'draft', activePeople: 1, pendingLeaves: 2, stages: {} } }), 'payroll');
    assert.equal(leaves.short, 'нові відпустки чи лікарняні не враховано');
    const signing = by(monthSteps({ ...ready, payroll: { ...ready.payroll, payments: ready.payroll.payments.map(p => ({ ...p, status: 'sent' })) } }), 'payroll');
    assert.deepEqual([signing.state, signing.who], ['wait', 'chair']);
});

test('звітність, майно й нарахування', () => {
    const rep = by(monthSteps({ ...ready, reports: [{ title: 'Сплатити ЄСВ', iso: '2026-11-20', left: 17, done: false }] }), 'reports');
    assert.deepEqual([rep.state, rep.short], ['wait', 'строк 20.11.2026']);
    assert.equal(by(monthSteps({ ...ready, reports: [{ title: 'Сплатити ЄСВ', iso: '2026-11-20', left: -1 }] }), 'reports').state, 'work');
    assert.equal(by(monthSteps({ ...ready, reports: [] }), 'reports').short, 'звітувати за місяць не потрібно');
    const dep = by(monthSteps({ ...ready, journal: { ...journal, assetsSummary: { ozCount: 1, dueDeprCount: 1, dueDeprKop: 2500 } } }), 'assets');
    assert.deepEqual([dep.state, dep.short], ['work', 'нарахуйте амортизацію: 1 обʼєкт · 25,00 грн']);
    assert.equal(by(monthSteps({ ...ready, charges: { runs: [] } }), 'charges').short, 'ще не нараховано');
    const unknown = monthSteps({ ...ready, charges: null, expenses: null, payroll: null, reports: null, payments: null, journal: null });
    assert.ok(unknown.slice(0, -1).every(s => ['unknown', 'done'].includes(s.state)));
    assert.equal(by(unknown, 'charges').state, 'unknown');
});

test('закритий місяць: перевірка й закриття — готово, з датою; голова може відкрити останній', () => {
    const steps = monthSteps({ ...ready, journal: { ...journal, status: 'closed', closedAt: '2026-11-14T10:00:00Z', canReopen: true, checks: [] } });
    assert.equal(by(steps, 'checks').state, 'done');
    assert.equal(steps.at(-1).state, 'done');
    assert.match(steps.at(-1).short, /^закрито 14\.11\.2026$/);
    assert.equal(steps.at(-1).reopen, true);
    assert.equal(monthProgress(steps).done, 11);
});

test('підсумки місяця з оборотно-сальдової відомості', () => {
    const r = (acc, f) => ({ acc, openDr: 0, openCr: 0, dr: 0, cr: 0, closeDr: 0, closeCr: 0, ...f });
    const t = monthTotals({ balanced: true, rows: [r('311', { openDr: 1000, dr: 500, cr: 300, closeDr: 1200 }), r('313', { openDr: 100, closeDr: 100 }),
        r('377', { dr: 800, cr: 500, closeDr: 900, closeCr: 100 }), r('92', { dr: 250 }), r('631', { closeCr: 70 }), r('661', { cr: 400 }), r('651', { cr: 88 }), r('703', { cr: 30 })] });
    assert.deepEqual(t, { moneyOpenKop: 1100, moneyInKop: 500, moneyOutKop: 300, moneyCloseKop: 1300, chargedKop: 800, residentsPaidKop: 500, residentsDebtKop: 800,
        expensesKop: 250, incomeKop: 30, suppliersDebtKop: 70, payrollKop: 400, esvKop: 88, balanced: true });
    assert.equal(monthTotals(null), null);
});
