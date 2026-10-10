'use strict';
// ============================================================
// Проводки й закриття місяця (частина 6).
//
// journal_periods/{місяць}: { status: 'closed'|'open', key, tb, totals,
//   closedBy, closedAt, history: [{ action, by, at, reason }] }
//   Проводки будуються з операцій щоразу (journal-core.js); при закритті
//   зберігаються оборотно-сальдова й відбиток проводок місяця — якщо
//   операції потім зміняться (пізня виписка банку), розбіжність видно.
//
// Закрити місяць може бухгалтер або голова, коли перевірки пройдено.
// Відкрити знову — лише голова, з причиною; лише останній закритий.
// Операції закритого місяця інші модулі не змінюють (period-lock.js).
// ============================================================
const crypto = require('crypto');
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const callGuard = require('./call-guard');
const core = require('./journal-core');
const { cleanApt } = require('./bank-core');
const { ITEMS } = require('./expenses-core');
const { INCOME_SOURCES } = require('./budget-core');
const { DEFAULT_COMPONENTS } = require('./charges-core');

const REGION = 'europe-central2';

module.exports = function journalFunctions({ db, FieldValue, requireAdmin, staffRole, lock, now: clock = () => new Date() }) {
    const fail = (code, message) => { throw new HttpsError(code, message); };
    const text = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
    const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Kyiv' }).format(clock());
    const sha = s => crypto.createHash('sha1').update(s).digest('hex').slice(0, 20);
    const validPeriod = p => /^\d{4}-(0[1-9]|1[0-2])$/.test(String(p || ''));

    async function audit(actor, role, action, target, summary, details = {}) {
        await db.collection('audit_log').add({ actor, role, action, target, summary: String(summary).slice(0, 300), details, at: FieldValue.serverTimestamp() });
    }

    /** Усе, з чого будуються проводки. */
    async function load() {
        const [ledgerSnap, txSnap, exSnap, supSnap, runSnap, periodSnap, aptSnap, chargeSettings, payrollSnap, payrollPaySnap, payrollPeople] = await Promise.all([
            db.collectionGroup('ledger').where('kind', 'in', ['charge', 'opening']).get(),
            db.collection('bank_tx').where('period', '>=', core.START_PERIOD).get(),
            db.collection('expenses').get(),
            db.collection('suppliers').get(),
            db.collection('charges_runs').select().get(),
            db.collection('journal_periods').get(),
            db.collection('apartments').get(),
            db.doc('charges/settings').get(),
            db.collection('payroll_runs').get(),
            db.collection('payments').where('kind', 'in', ['salary', 'tax']).get(),
            db.collection('payroll_people').select('active').get()
        ]);
        // Платежі за відомістю зарплати: { paymentId → { key, name } } для погашення 661/641/651.
        const payrollPayments = new Map(payrollPaySnap.docs.filter(d => d.data().payroll?.period)
            .map(d => [d.id, { key: d.data().payroll.key, name: d.data().recipient?.name || '' }]));
        const ledgers = new Map();
        ledgerSnap.forEach(d => {
            if (d.ref.parent.parent?.parent?.id !== 'apartments') return;
            const apt = cleanApt(d.ref.parent.parent.id);
            if (!ledgers.has(apt)) ledgers.set(apt, []);
            ledgers.get(apt).push(d.data());
        });
        const periods = new Map(periodSnap.docs.map(d => [d.id, d.data()]));
        return {
            input: {
                ledgers,
                bankTx: txSnap.docs.map(d => ({ id: d.id, ...d.data() })),
                expenses: exSnap.docs.map(d => ({ id: d.id, ...d.data() })),
                suppliers: new Map(supSnap.docs.map(d => [d.id, d.data()])),
                payrollRuns: payrollSnap.docs.map(d => ({ period: d.id, ...d.data() })),
                payrollPayments
            },
            payrollActive: payrollPeople.docs.filter(d => d.data().active !== false).length,
            charged: new Set(runSnap.docs.map(d => d.id)),
            periods,
            closed: [...periods.entries()].filter(([, p]) => p.status === 'closed').map(([id]) => id).sort(),
            apartments: aptSnap.docs.map(d => ({ apt: cleanApt(d.id), ...d.data() })).filter(a => !a.isAdmin),
            components: chargeSettings.data()?.components?.length ? chargeSettings.data().components : DEFAULT_COMPONENTS
        };
    }

    /** Місяць за замовчуванням — перший незакритий, що вже скінчився, або поточний. */
    function defaultPeriod(closed, now) {
        const current = now.slice(0, 7);
        for (const p of core.periodsUpTo(current)) if (!closed.includes(p)) return p;
        return current;
    }

    /** Чи збігається 377 за приміщеннями з балансами співвласників (на сьогодні). */
    function balanceCheck(tb, apartments) {
        const r377 = tb.rows.find(r => r.acc === '377');
        const byApt = new Map((r377?.byA || []).map(x => [String(x.a), x.closeCr - x.closeDr]));
        const diff = apartments.filter(a => {
            const kop = Math.round(Number(a.balance || 0) * 100);
            return (byApt.get(a.apt) || 0) !== kop;
        });
        return diff.length
            ? { level: 'warn', text: `Рахунок 377 не збігається з балансом співвласників: ${diff.length} прим. (${diff.slice(0, 8).map(a => a.apt).join(', ')}${diff.length > 8 ? '…' : ''}). Можливо, оплату внесено не з виписки` }
            : { level: 'ok', text: 'Рахунок 377 збігається з балансами всіх співвласників' };
    }

    async function context({ period } = {}) {
        const now = today();
        const data = await load();
        const p = validPeriod(period) ? period : defaultPeriod(data.closed, now);
        const entries = core.journal(data.input, p);
        const tb = core.trialBalance(entries, p);
        const stored = data.periods.get(p);
        const isClosed = stored?.status === 'closed';
        const key = sha(core.entriesKey(entries, p));
        const checks = isClosed
            ? [stored.key === key
                ? { level: 'ok', text: 'Місяць закрито; операції відтоді не змінювались' }
                : { level: 'warn', text: 'Після закриття змінились операції цього місяця (наприклад, пізня виписка банку). Голова може відкрити місяць, щоб розібратися' }]
            : core.closeChecks({ period: p, today: now, bankTx: data.input.bankTx, expenses: data.input.expenses, chargedPeriods: data.charged, closed: data.closed, tb });
        // Є працівники, а відомість місяця не затверджено — зарплата не потрапить у проводки місяця.
        if (!isClosed && data.payrollActive && data.input.payrollRuns.find(r => r.period === p)?.status !== 'approved') {
            const ok = checks.findIndex(c => c.level === 'ok');
            checks.splice(ok >= 0 ? ok : checks.length, 0, { level: 'warn', text: 'Відомість зарплати за місяць не затверджено — нарахування зарплати не потрапить у проводки місяця' });
        }
        // Порівняння з балансами квартир має сенс для останнього місяця обліку.
        if (p === now.slice(0, 7) || p === core.shift(now.slice(0, 7), -1)) {
            const latest = core.trialBalance(core.journal(data.input, now.slice(0, 7)), now.slice(0, 7));
            const ok = isClosed ? -1 : checks.findIndex(c => c.level === 'ok');
            checks.splice(ok >= 0 ? ok : checks.length, 0, balanceCheck(latest, data.apartments));
        }
        const lastClosed = data.closed.at(-1) || null;
        return {
            period: p, today: now, start: core.START_PERIOD,
            periods: core.periodsUpTo(now.slice(0, 7)).map(id => ({ id, status: data.periods.get(id)?.status === 'closed' ? 'closed' : 'open' })),
            status: isClosed ? 'closed' : 'open', key,
            closedAt: stored?.closedAt?.toDate?.()?.toISOString() || null, closedBy: stored?.closedBy || null,
            history: (stored?.history || []).map(h => ({ ...h, at: h.at?.toDate?.()?.toISOString?.() || h.at || null })),
            canClose: !isClosed && !checks.some(c => c.level === 'block'),
            canReopen: isClosed && lastClosed === p,
            accounts: core.ACCOUNTS,
            // Назви для аналітики: статті витрат (92), складові внеску (48), джерела доходу.
            labels: { 92: ITEMS, 641: { pdfo: 'ПДФО', vz: 'Військовий збір' }, 48: { ...Object.fromEntries(data.components.map(c => [c.id, c.name])), grant: INCOME_SOURCES.grant }, 703: INCOME_SOURCES, 719: INCOME_SOURCES, 733: INCOME_SOURCES },
            tb,
            entries: entries.filter(e => e.period === p).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0)).slice(0, 6000),
            checks
        };
    }

    async function close(actor, role, { period }) {
        if (!validPeriod(period)) fail('invalid-argument', 'Невідомий місяць');
        const ctx = await context({ period });
        if (ctx.status === 'closed') fail('failed-precondition', 'Місяць уже закрито');
        const blocks = ctx.checks.filter(c => c.level === 'block');
        if (blocks.length) fail('failed-precondition', blocks.map(c => c.text).join('; '));
        const at = new Date().toISOString();
        await db.doc(`journal_periods/${period}`).set({
            status: 'closed', key: ctx.key, totals: ctx.tb.totals,
            tb: ctx.tb.rows.map(r => ({ ...r, byA: r.byA.slice(0, 2000) })), entries: ctx.entries.length,
            closedBy: actor, closedAt: FieldValue.serverTimestamp(),
            history: FieldValue.arrayUnion({ action: 'close', by: actor, at })
        }, { merge: true });
        await audit(actor, role, 'journal.close', `journal_periods/${period}`, `Місяць ${lock.monthName(period)} закрито: обороти ${(ctx.tb.totals.dr / 100).toFixed(2)} грн`,
            { period, totals: ctx.tb.totals });
        return { ok: true };
    }

    async function reopen(actor, role, { period, reason }) {
        if (role !== 'chair') fail('permission-denied', 'Відкрити закритий місяць може лише голова');
        const why = text(reason, 300);
        if (why.length < 5) fail('invalid-argument', 'Вкажіть причину: її буде в журналі дій');
        const closed = await lock.closed();
        if (!closed.includes(period)) fail('failed-precondition', 'Цей місяць не закрито');
        if (closed.at(-1) !== period) fail('failed-precondition', `Спершу відкрийте пізніший місяць (${closed.at(-1)})`);
        await db.doc(`journal_periods/${period}`).update({ status: 'open', history: FieldValue.arrayUnion({ action: 'reopen', by: actor, at: new Date().toISOString(), reason: why }) });
        await audit(actor, role, 'journal.reopen', `journal_periods/${period}`, `Місяць ${lock.monthName(period)} відкрито знову: ${why}`, { period, reason: why });
        return { ok: true };
    }

    const journalAction = onCall({ region: REGION, maxInstances: 4, timeoutSeconds: 120, memory: '512MiB' }, callGuard('journalAction', async request => {
        const actor = await requireAdmin(request, ['chair', 'accountant']);
        const role = await staffRole(actor);
        const data = request.data || {};
        switch (data.action) {
            case 'context': return context(data);
            case 'close': return close(actor, role, data);
            case 'reopen': return reopen(actor, role, data);
            default: fail('invalid-argument', 'Невідома дія');
        }
    }));

    return { journalAction, actions: { context, close, reopen } };
};
