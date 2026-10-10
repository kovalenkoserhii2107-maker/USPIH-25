'use strict';
// Звірка джерел обліку: рівність дебету й кредиту сама по собі
// не виявляє пропущене нарахування або загублений рознос оплати.
const { entryKop, balanceFromLedger, START_PERIOD } = require('./charges-core');

function reconcile({ period, runs = [], bankTx = [], ledgers = new Map(), apartments = [], openingSet = false, expenses = [], payments = [], payrollRuns = [] }) {
    const issues = new Set();
    const block = text => issues.add(text);
    const managed = p => p >= START_PERIOD && p <= period;
    const positive = n => Number.isSafeInteger(n) && n > 0;
    const expected = new Map();
    for (const run of runs.filter(r => managed(r.period))) {
        if (run.complete === false || run.problems?.length) block(`Неповне нарахування за ${run.period}: виправте проблемні приміщення й перерахуйте`);
        const amounts = run.amounts || {};
        const coverage = run.expectedApts || apartments.map(a => a.apt);
        if (coverage.some(apt => !(apt in amounts))) block(`Нарахування за ${run.period} охоплює не всі приміщення відомості`);
        if (Object.keys(amounts).length !== run.count || Object.values(amounts).reduce((s, k) => s + k, 0) !== run.totalKop) block(`Підсумок нарахування за ${run.period} не відповідає списку квартир`);
        for (const [apt, kop] of Object.entries(amounts)) {
            const entries = (ledgers.get(apt) || []).filter(e => e.kind === 'charge' && e.period === run.period && (e.source === 'charges' || e._id === `charge-${run.period}`));
            if (entries.length !== 1 || entryKop(entries[0]) !== kop) block(`Нарахування ${run.period}, прим. ${apt}: сума в історії не відповідає відомості`);
        }
    }
    const byPeriod = new Map(runs.map(r => [r.period, r]));
    const expenseMap = new Map(expenses.map(e => [e.id, e]));
    const paymentMap = new Map(payments.map(p => [p.id, p]));
    const txMap = new Map(bankTx.map(t => [t.id, t]));
    for (const tx of bankTx.filter(t => managed(t.period))) {
        if (!positive(tx.amountKop) || !['in', 'out'].includes(tx.direction)) block(`Операція виписки ${tx.id}: некоректна сума або напрямок`);
        if (tx.expenseId) {
            const e = expenseMap.get(tx.expenseId);
            if (!e || !['approved', 'paid'].includes(e.status) || !e.txIds?.includes(tx.id) || tx.direction !== 'out' || tx.status !== 'done') block(`Оплата ${tx.id}: зв'язок з документом витрат не відповідає джерелам`);
        }
        if (tx.paymentId) {
            const p = paymentMap.get(tx.paymentId);
            if (!p || p.status !== 'paid' || p.txId !== tx.id || p.amountKop !== tx.amountKop || tx.direction !== 'out' || tx.status !== 'done') block(`Платіж ${tx.paymentId}: підтвердження випискою не відповідає платіжному документу`);
        }
    }
    for (const e of expenses.filter(e => managed(e.period) && ['approved', 'paid'].includes(e.status))) {
        const txIds = e.txIds || [];
        const paid = txIds.reduce((s, id) => s + (txMap.get(id)?.amountKop || 0), 0);
        if (new Set(txIds).size !== txIds.length || paid !== (e.paidKop || 0) || paid > e.amountKop || txIds.some(id => txMap.get(id)?.expenseId !== e.id)) block(`Документ витрат ${e.id}: сума оплат або зв'язки не відповідають виписці`);
    }
    for (const p of payrollRuns.filter(p => managed(p.period) && p.status === 'approved')) {
        for (const field of ['grossKop', 'pdfoKop', 'vzKop', 'netKop', 'esvKop']) {
            if ((p.run?.rows || []).reduce((s, r) => s + (r[field] || 0), 0) !== p.run?.totals?.[field]) block(`Відомість зарплати ${p.period}: підсумки не відповідають нарахуванням за людьми`);
        }
    }
    for (const tx of bankTx.filter(t => managed(t.period) && t.direction === 'in' && t.kind === 'payment' && t.status === 'done')) {
        const list = tx.allocations || [];
        if (!positive(tx.amountKop) || !list.length || list.some(a => !positive(a.amountKop)) || list.reduce((s, a) => s + a.amountKop, 0) !== tx.amountKop) {
            block(`Оплата ${tx.id}: сума розносу не відповідає сумі виписки`);
        }
        for (const a of list) {
            const key = `${a.apt}/${a.ledgerId}`;
            if (!a.ledgerId || expected.has(key)) block(`Оплата ${tx.id}: немає унікального запису історії для прим. ${a.apt}`);
            expected.set(key, { tx, a });
            const entry = (ledgers.get(a.apt) || []).find(e => e._id === a.ledgerId);
            if (!entry || entry.kind !== 'payment' || entry.source !== 'bank' || entry.txId !== tx.id || entry.period !== tx.period || entryKop(entry) !== a.amountKop) {
                block(`Оплата ${tx.id}, прим. ${a.apt}: запис історії відсутній або не відповідає виписці`);
            }
        }
    }
    const known = new Set(apartments.map(a => a.apt));
    for (const [apt, entries] of ledgers) for (const e of entries.filter(e => managed(e.period))) {
        if (apartments.length && !known.has(apt)) block(`Прим. ${apt}: записи обліку є, але приміщення відсутнє в довіднику`);
        if (e.kind === 'charge' && e.source !== 'charges') block(`Нарахування ${e.period}, прим. ${apt}: походження запису не підтверджено відомістю нарахувань; перевірте імпорт історії`);
        const parts = e.kind === 'charge' ? e.parts : e.kind === 'payment' ? e.alloc : null;
        if (Array.isArray(parts) && parts.length && (parts.some(p => !Number.isSafeInteger(p.amountKop)) || parts.reduce((s, p) => s + p.amountKop, 0) !== entryKop(e))) block(`Прим. ${apt}, ${e.period}: сума складових не відповідає сумі запису історії`);
        if (e.kind === 'charge' && e.source === 'charges' && !(apt in (byPeriod.get(e.period)?.amounts || {}))) block(`Нарахування ${e.period}, прим. ${apt}: запис історії не включено у відомість`);
        if (e.kind === 'payment' && !expected.has(`${apt}/${e._id}`)) block(`Оплата ${e.period}, прим. ${apt}: запис історії не підтверджено розносом виписки`);
    }
    if (openingSet) for (const apt of apartments) {
        const entries = ledgers.get(apt.apt) || [];
        const opening = entries.filter(e => e.kind === 'opening');
        if (opening.length !== 1) block(`Прим. ${apt.apt}: немає єдиного вхідного залишку для розрахунку балансу`);
        if (opening[0]?.parts && Object.values(opening[0].parts).reduce((s, p) => s + p, 0) !== entryKop(opening[0])) block(`Прим. ${apt.apt}: складові вхідного залишку не відповідають його сумі`);
        // Баланс — стан на сьогодні, тому включаємо також пізніші місяці.
        const balance = Math.round(Number(apt.balance) * 100);
        if (!Number.isSafeInteger(balance) || balance !== balanceFromLedger(entries)) block(`Прим. ${apt.apt}: збережений баланс не відповідає історії; перерахуйте баланси`);
    }
    return [...issues].map(text => ({ level: 'block', text }));
}

module.exports = { reconcile };
