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
//
// journal_opening/main: { lines: [{ acc, a, side: dr|cr, kop, memo }],
//   status: draft|approved, savedBy, savedAt, approvedBy, approvedAt }
//   Вхідна ОСВ на 30.09.2026: бухгалтер вносить, голова затверджує, коли
//   дебет = кредит разом з автоматичними залишками квартир і документів.
//   Після першого закритого місяця не змінюється.
// ============================================================
const crypto = require('crypto');
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const callGuard = require('./call-guard');
const core = require('./journal-core');
const { cleanApt } = require('./bank-core');
const { ITEMS } = require('./expenses-core');
const { INCOME_SOURCES } = require('./budget-core');
const { DEFAULT_COMPONENTS } = require('./charges-core');
const { reconcile } = require('./reconciliation-core');
const { activeIn } = require('./payroll-core');

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
    async function load(transaction = null) {
        const get = ref => transaction ? transaction.get(ref) : ref.get();
        const [ledgerSnap, txSnap, exSnap, supSnap, runSnap, periodSnap, aptSnap, chargeSettings, payrollSnap, payrollPaySnap, payrollPeople, openingSnap, bankSnap, openingPlanSnap] = await Promise.all([
            get(db.collectionGroup('ledger').where('kind', 'in', ['charge', 'opening', 'payment', 'refund'])),
            get(db.collection('bank_tx').where('period', '>=', core.START_PERIOD)),
            get(db.collection('expenses')),
            get(db.collection('suppliers')),
            get(db.collection('charges_runs')),
            get(db.collection('journal_periods')),
            get(db.collection('apartments')),
            get(db.doc('charges/settings')),
            get(db.collection('payroll_runs')),
            get(db.collection('payments')),
            get(db.collection('payroll_people').select('active', 'from', 'to', 'kind', 'name')),
            get(db.doc('journal_opening/main')),
            get(db.doc('bank/settings')),
            get(db.doc('charges/opening_plan'))
        ]);
        const opening = openingSnap.exists ? openingSnap.data() : null;
        // Платежі за відомістю зарплати: { paymentId → { key, name } } для погашення 661/641/651.
        const payrollPayments = new Map(payrollPaySnap.docs.filter(d => d.data().payroll?.period)
            .map(d => [d.id, { key: d.data().payroll.key, name: d.data().recipient?.name || '', period: d.data().payroll.period }]));
        const ledgers = new Map();
        ledgerSnap.forEach(d => {
            if (d.ref.parent.parent?.parent?.id !== 'apartments') return;
            const apt = cleanApt(d.ref.parent.parent.id);
            if (!ledgers.has(apt)) ledgers.set(apt, []);
            ledgers.get(apt).push({ _id: d.id, ...d.data() });
        });
        const periods = new Map(periodSnap.docs.map(d => [d.id, d.data()]));
        return {
            input: {
                ledgers,
                bankTx: txSnap.docs.map(d => ({ id: d.id, ...d.data() })),
                expenses: exSnap.docs.map(d => ({ id: d.id, ...d.data() })),
                suppliers: new Map(supSnap.docs.map(d => [d.id, d.data()])),
                payrollRuns: payrollSnap.docs.map(d => ({ period: d.id, ...d.data() })),
                payrollPayments,
                opening
            },
            opening,
            bankAccounts: Object.entries(bankSnap.data()?.accounts || {}).map(([iban, a]) => ({ iban, ...a })),
            people: payrollPeople.docs.map(d => ({ id: d.id, ...d.data() })),
            payments: payrollPaySnap.docs.map(d => ({ id: d.id, ...d.data() })),
            charged: new Set(runSnap.docs.map(d => d.id)),
            runs: runSnap.docs.map(d => ({ period: d.id, ...d.data() })),
            openingSet: Boolean(chargeSettings.data()?.opening?.set),
            openingPending: openingPlanSnap.exists,
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

    async function context({ period } = {}, transaction = null) {
        const now = today();
        const data = await load(transaction);
        const p = validPeriod(period) ? period : defaultPeriod(data.closed, now);
        const entries = core.journal(data.input, p);
        const tb = core.trialBalance(entries, p);
        const stored = data.periods.get(p);
        const isClosed = stored?.status === 'closed';
        const isClosing = stored?.status === 'closing' && stored.closingUntil > Date.now();
        const key = sha(core.entriesKey(entries, p));
        const checks = isClosed
            ? [stored.key === key
                ? { level: 'ok', text: 'Місяць закрито; операції відтоді не змінювались' }
                : { level: 'warn', text: 'Після закриття змінились операції цього місяця (наприклад, пізня виписка банку). Голова може відкрити місяць, щоб розібратися' }]
            : core.closeChecks({ period: p, today: now, bankTx: data.input.bankTx, expenses: data.input.expenses, chargedPeriods: data.charged, closed: data.closed, tb, openingStatus: data.opening?.status || 'none' });
        checks.push(...reconcile({ period: p, runs: data.runs, bankTx: data.input.bankTx, ledgers: data.input.ledgers,
            apartments: data.apartments, openingSet: data.openingSet, openingPending: data.openingPending, expenses: data.input.expenses, payments: data.payments, payrollRuns: data.input.payrollRuns }));
        // Є працівники, а відомість місяця не затверджено — зарплата не потрапить у проводки місяця.
        if (!isClosed && activeIn(data.people, p).length && data.input.payrollRuns.find(r => r.period === p)?.status !== 'approved') {
            const ok = checks.findIndex(c => c.level === 'ok');
            checks.splice(ok >= 0 ? ok : checks.length, 0, { level: 'block', text: 'Відомість зарплати за місяць не затверджено — нарахування зарплати не потрапить у проводки місяця' });
        }
        const payroll = data.input.payrollRuns.find(r => r.period === p);
        const payrollSent = [...data.input.payrollPayments.values()].some(payment => payment.period === p);
        if (!isClosed && ((payrollSent && payroll?.status !== 'approved') || Object.values(payroll?.stages || {}).some(stage => stage.complete === false))) {
            checks.push({ level: 'block', text: 'Виплату зарплати розпочато, але відомість не затверджена або відправку платежів не завершено' });
        }
        // Порівняння з балансами квартир має сенс для останнього місяця обліку.
        if (p === now.slice(0, 7) || p === core.shift(now.slice(0, 7), -1)) {
            const latest = core.trialBalance(core.journal(data.input, now.slice(0, 7)), now.slice(0, 7));
            const ok = isClosed ? -1 : checks.findIndex(c => c.level === 'ok');
            checks.splice(ok >= 0 ? ok : checks.length, 0, balanceCheck(latest, data.apartments));
            if (data.opening?.status === 'approved') {
                const bank = bankCheck(latest, data.bankAccounts);
                if (bank) checks.splice(ok >= 0 ? ok : checks.length, 0, bank);
            }
        }
        const lastClosed = data.closed.at(-1) || null;
        if (checks.some(c => c.level === 'block')) {
            const ready = checks.findIndex(c => c.level === 'ok' && c.text.startsWith('Можна закривати'));
            if (ready >= 0) checks.splice(ready, 1);
        }
        return {
            period: p, today: now, start: core.START_PERIOD,
            periods: core.periodsUpTo(now.slice(0, 7)).map(id => ({ id, status: data.periods.get(id)?.status === 'closed' ? 'closed' : 'open' })),
            status: isClosed ? 'closed' : isClosing ? 'closing' : 'open', key,
            closedAt: stored?.closedAt?.toDate?.()?.toISOString() || null, closedBy: stored?.closedBy || null,
            history: (stored?.history || []).map(h => ({ ...h, at: h.at?.toDate?.()?.toISOString?.() || h.at || null })),
            canClose: !isClosed && !isClosing && !checks.some(c => c.level === 'block'),
            canReopen: isClosed && lastClosed === p,
            accounts: core.ACCOUNTS,
            // Назви для аналітики: статті витрат (92), складові внеску (48), джерела доходу.
            labels: { 92: ITEMS, 641: { pdfo: 'ПДФО', vz: 'Військовий збір' }, 48: { ...Object.fromEntries(data.components.map(c => [c.id, c.name])), grant: INCOME_SOURCES.grant }, 703: INCOME_SOURCES, 719: INCOME_SOURCES, 733: INCOME_SOURCES },
            opening: { status: data.opening?.status || 'none', lines: data.opening?.lines?.length || 0 },
            tb,
            entries: entries.filter(e => e.period === p).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0)).slice(0, 6000),
            checks
        };
    }

    /** 311 за кожним рахунком (з вхідним залишком) проти останнього залишку з банку. */
    function bankCheck(tb, accounts) {
        const r311 = tb.rows.find(r => r.acc === '311');
        const byIban = new Map((r311?.byA || []).map(x => [String(x.a), x.closeDr - x.closeCr]));
        const off = accounts.filter(a => (!a.currency || a.currency === 'UAH') && Number.isSafeInteger(a.balanceKop) && (byIban.get(a.iban) || 0) !== a.balanceKop);
        if (!accounts.length) return null;
        return off.length
            ? { level: 'warn', text: `Рахунок 311 не збігається із залишком банку: ${off.map(a => `…${a.iban.slice(-4)} — облік ${((byIban.get(a.iban) || 0) / 100).toFixed(2)}, банк ${(a.balanceKop / 100).toFixed(2)} грн`).join('; ')}. Причина — вхідний залишок або операції, яких ще немає у виписці` }
            : { level: 'ok', text: 'Рахунок 311 збігається із залишками банку за всіма рахунками' };
    }

    /** Чистий рух за рахунком банку з початку обліку (без вхідного залишку). */
    function turnover311(entries, iban) {
        return entries.filter(e => e.src !== 'opening').reduce((s, e) => s + (e.dr === '311' && e.dA === iban ? e.kop : 0) - (e.cr === '311' && e.cA === iban ? e.kop : 0), 0);
    }

    /** Вхідна ОСВ: рядки, автоматичні залишки, підказки для банку, підсумки. */
    async function openingContext() {
        const data = await load();
        const now = today();
        const doc = data.opening;
        const auto = core.buildEntries({ ...data.input, opening: null }).filter(e => e.src === 'opening');
        // Квартири — двома рядками (борги й переплати), документи — за постачальниками.
        const autoLines = [];
        const debt = auto.filter(e => e.dr === '377'), over = auto.filter(e => e.cr === '377');
        if (debt.length) autoLines.push({ acc: '377', side: 'dr', kop: debt.reduce((s, e) => s + e.kop, 0), memo: `Борги співвласників: ${debt.length} прим.` });
        if (over.length) autoLines.push({ acc: '377', side: 'cr', kop: over.reduce((s, e) => s + e.kop, 0), memo: `Переплати співвласників: ${over.length} прим.` });
        const bySupplier = new Map();
        for (const e of auto.filter(x => x.cr === '631')) bySupplier.set(e.cA, (bySupplier.get(e.cA) || 0) + e.kop);
        for (const [a, kop] of bySupplier) autoLines.push({ acc: '631', a, side: 'cr', kop, memo: 'Документи до початку обліку' });
        const lines = doc?.lines || [];
        const all = core.journal(data.input, now.slice(0, 7));
        const banks = data.bankAccounts.filter(a => !a.currency || a.currency === 'UAH').map(a => {
            const moved = turnover311(all, a.iban);
            return { iban: a.iban, name: a.name || '', purpose: a.purpose || 'current', balanceKop: a.balanceKop ?? null,
                balanceAt: a.balanceAt?.toDate?.()?.toISOString() || null, turnoverKop: moved,
                suggestKop: Number.isSafeInteger(a.balanceKop) ? a.balanceKop - moved : null };
        });
        return {
            date: core.lastDay(core.shift(core.START_PERIOD, -1)), status: doc?.status || 'none', lines, auto: autoLines,
            totals: core.openingTotals(auto, lines), accounts: Object.fromEntries(core.OPENING_ACCOUNTS.map(a => [a, core.ACCOUNTS[a]])),
            needsA: core.OPENING_NEEDS_A, banks, suppliers: [...data.input.suppliers.values()].map(s => s.name).filter(Boolean).sort((a, b) => a.localeCompare(b, 'uk')),
            savedBy: doc?.savedBy || null, savedAt: doc?.savedAt?.toDate?.()?.toISOString() || null,
            approvedBy: doc?.approvedBy || null, approvedAt: doc?.approvedAt?.toDate?.()?.toISOString() || null,
            locked: data.closed.length > 0
        };
    }

    const cleanLines = lines => (Array.isArray(lines) ? lines : []).map(l => ({
        acc: String(l?.acc || ''), a: text(l?.acc === '311' ? String(l?.a || '').replace(/\s+/g, '').toUpperCase() : l?.a, 80),
        side: l?.side === 'cr' ? 'cr' : l?.side === 'dr' ? 'dr' : '', kop: Number(l?.kop), memo: text(l?.memo, 200)
    }));

    async function saveOpening(actor, role, { lines }) {
        const clean = cleanLines(lines);
        const error = core.checkOpening(clean);
        if (error) fail('invalid-argument', error);
        const ref = db.doc('journal_opening/main');
        await db.runTransaction(async t => {
            const closed = await t.get(db.collection('journal_periods').where('status', '==', 'closed').limit(1));
            if (!closed.empty) fail('failed-precondition', 'Вхідну ОСВ змінювати не можна: уже є закритий місяць. Спершу голова відкриває місяці знову');
            t.set(ref, { lines: clean, status: 'draft', savedBy: actor, savedAt: FieldValue.serverTimestamp(), approvedBy: null, approvedAt: null });
        });
        await audit(actor, role, 'journal.opening', 'journal_opening/main', `Вхідна ОСВ збережена: ${clean.length} рядк., чекає затвердження голови`,
            { lines: clean.length, dr: clean.filter(l => l.side === 'dr').reduce((s, l) => s + l.kop, 0), cr: clean.filter(l => l.side === 'cr').reduce((s, l) => s + l.kop, 0) });
        return { ok: true };
    }

    async function approveOpening(actor, role) {
        if (role !== 'chair') fail('permission-denied', 'Вхідну ОСВ затверджує голова');
        const ref = db.doc('journal_opening/main');
        const totals = await db.runTransaction(async t => {
            const data = await load(t);
            if (data.closed.length) fail('failed-precondition', 'Уже є закритий місяць — вхідну ОСВ не змінюють');
            if (data.opening?.status !== 'draft') fail('failed-precondition', data.opening ? 'Вхідну ОСВ уже затверджено' : 'Вхідну ОСВ ще не збережено');
            const auto = core.buildEntries({ ...data.input, opening: null }).filter(e => e.src === 'opening');
            const sums = core.openingTotals(auto, data.opening.lines);
            if (sums.diff) fail('failed-precondition', `Дебет не дорівнює кредиту: різниця ${(sums.diff / 100).toFixed(2)} грн. Зазвичай її закриває залишок цільового фінансування (48) або нерозподілений результат (44)`);
            t.update(ref, { status: 'approved', approvedBy: actor, approvedAt: FieldValue.serverTimestamp() });
            return sums;
        });
        await audit(actor, role, 'journal.opening.approve', 'journal_opening/main', `Вхідну ОСВ на 30.09.2026 затверджено: дебет = кредит = ${(totals.dr / 100).toFixed(2)} грн`, totals);
        return { ok: true };
    }

    async function close(actor, role, { period }) {
        if (!validPeriod(period)) fail('invalid-argument', 'Невідомий місяць');
        const ref = db.doc(`journal_periods/${period}`);
        const token = db.collection('_').doc().id;
        await db.runTransaction(async t => {
            const [previous, operation] = await Promise.all([t.get(ref), t.get(db.doc('charges/operation'))]);
            if (previous.data()?.status === 'closed') fail('failed-precondition', 'Місяць уже закрито');
            if (previous.data()?.status === 'closing' && previous.data().closingUntil > Date.now()) fail('aborted', 'Місяць уже закривається. Дочекайтеся завершення.');
            if (operation.data()?.active && operation.data().until > Date.now()) fail('aborted', 'Виконується операція нарахувань. Закрийте місяць після її завершення.');
            t.set(ref, { status: 'closing', closingToken: token, closingUntil: Date.now() + 10 * 60 * 1000 }, { merge: true });
        });
        try {
            const at = new Date().toISOString();
            // Узгоджений знімок усіх джерел і фінальна позначка —
            // в одній транзакції після резервування місяця.
            const ctx = await db.runTransaction(async t => {
                const current = await t.get(ref);
                if (current.data()?.closingToken !== token || current.data()?.status !== 'closing') fail('aborted', 'Стан закриття місяця змінився. Перевірте місяць знову.');
                const fresh = await context({ period }, t);
                const blocks = fresh.checks.filter(c => c.level === 'block');
                if (blocks.length) fail('failed-precondition', blocks.map(c => c.text).join('; '));
                t.set(ref, {
                    status: 'closed', key: fresh.key, totals: fresh.tb.totals,
                    tb: fresh.tb.rows.map(r => ({ ...r, byA: r.byA.slice(0, 2000) })), entries: fresh.entries.length,
                    closedBy: actor, closedAt: FieldValue.serverTimestamp(),
                    history: FieldValue.arrayUnion({ action: 'close', by: actor, at }),
                    closingToken: FieldValue.delete(), closingUntil: FieldValue.delete()
                }, { merge: true });
                return fresh;
            });
            await audit(actor, role, 'journal.close', `journal_periods/${period}`, `Місяць ${lock.monthName(period)} закрито: обороти ${(ctx.tb.totals.dr / 100).toFixed(2)} грн`,
                { period, totals: ctx.tb.totals });
            return { ok: true };
        } finally {
            await db.runTransaction(async t => {
                const current = await t.get(ref);
                if (current.data()?.status === 'closing' && current.data().closingToken === token) t.update(ref, {
                    status: 'open', closingToken: FieldValue.delete(), closingUntil: FieldValue.delete()
                });
            });
        }
    }

    async function reopen(actor, role, { period, reason }) {
        if (role !== 'chair') fail('permission-denied', 'Відкрити закритий місяць може лише голова');
        const why = text(reason, 300);
        if (why.length < 5) fail('invalid-argument', 'Вкажіть причину: її буде в журналі дій');
        const closed = await lock.closed();
        if (!closed.includes(period)) fail('failed-precondition', 'Цей місяць не закрито');
        if (closed.at(-1) !== period) fail('failed-precondition', `Спершу відкрийте пізніший місяць (${closed.at(-1)})`);
        await db.runTransaction(async t => {
            const ref = db.doc(`journal_periods/${period}`);
            if ((await t.get(ref)).data()?.status !== 'closed') fail('failed-precondition', 'Місяць ще не закрито або його стан змінився');
            t.update(ref, { status: 'open', history: FieldValue.arrayUnion({ action: 'reopen', by: actor, at: new Date().toISOString(), reason: why }) });
        });
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
            case 'opening': return openingContext();
            case 'saveOpening': return saveOpening(actor, role, data);
            case 'approveOpening': return approveOpening(actor, role);
            default: fail('invalid-argument', 'Невідома дія');
        }
    }));

    return { journalAction, actions: { context, close, reopen, openingContext, saveOpening, approveOpening } };
};
