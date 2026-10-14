'use strict';
// ============================================================
// Проводки й закриття місяця (частина 6) + Реєстр ОЗ, МНМА та ТМЦ.
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
const { randomUUID } = crypto;
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const callGuard = require('./call-guard');
const core = require('./journal-core');
const assetsCore = require('./assets-core');
const advanceCore = require('./advance-core');
const { cleanApt, safeId } = require('./bank-core');
const { ITEMS, validDate } = require('./expenses-core');
const { INCOME_SOURCES } = require('./budget-core');
const { DEFAULT_COMPONENTS } = require('./charges-core');
const { reconcile } = require('./reconciliation-core');
const { activeIn } = require('./payroll-core');

const REGION = 'europe-central2';

module.exports = function journalFunctions({ db, FieldValue, requireAdmin, staffRole, lock, payments: paymentsMod, now: clock = () => new Date() }) {
    const payments = paymentsMod || require('./payments')({ db, FieldValue, requireAdmin, staffRole, lock });
    const policyStore = require('./accounting-policy').create({ db, FieldValue });
    const policyCore = require('./accounting-policy');
    const notes = require('./accounting-notes')({ db, FieldValue, lock, load });
    const fail = (code, message) => { throw new HttpsError(code, message); };
    const text = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
    const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Kyiv' }).format(clock());
    const sha = s => crypto.createHash('sha1').update(s).digest('hex').slice(0, 20);
    const validPeriod = p => /^\d{4}-(0[1-9]|1[0-2])$/.test(String(p || ''));

    async function audit(actor, role, action, target, summary, details = {}) {
        await db.collection('audit_log').add({ actor, role, action, target, summary: String(summary).slice(0, 300), details, at: FieldValue.serverTimestamp() });
    }

    /** Усе, з чого будуються проводки та інвентарна книга. */
    async function load(transaction = null) {
        const get = ref => transaction ? transaction.get(ref) : ref.get();
        const policy = await policyStore.context(transaction);
        const [ledgerSnap, txSnap, exSnap, supSnap, runSnap, periodSnap, aptSnap, chargeSettings, payrollSnap, payrollPaySnap, payrollPeople, openingSnap, bankSnap, openingPlanSnap] = await Promise.all([
            get(db.collectionGroup('ledger').where('kind', 'in', ['charge', 'opening', 'payment', 'refund'])),
            get(db.collection('bank_tx').where('period', '>=', policy.startDate.slice(0, 7))),
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
            .map(d => [d.id, { key: d.data().payroll.key, kind: d.data().kind, recipientType: d.data().payroll.recipientType,
                personAccount: require('./payroll-payment-core').personAccount(payrollSnap.docs.find(s=>s.id===d.data().payroll.period)?.data().run?.rows?.find(r=>r.personId===d.data().payroll.key)),
                name: d.data().recipient?.name || '', period: d.data().payroll.period }]));
        const ledgers = new Map();
        ledgerSnap.forEach(d => {
            if (d.ref.parent.parent?.parent?.id !== 'apartments') return;
            const apt = cleanApt(d.ref.parent.parent.id);
            if (!ledgers.has(apt)) ledgers.set(apt, []);
            ledgers.get(apt).push({ _id: d.id, ...d.data() });
        });
        const periods = new Map(periodSnap.docs.map(d => [d.id, d.data()]));
        const [notesSnap, snapshots, cuts, assetsSnap, advanceSnap, staffSnap] = await Promise.all([
            get(db.collection('accounting_notes')),
            get(db.collection('journal_snapshots')),
            get(db.collection('journal_bank_checks')),
            Promise.resolve().then(() => get(db.collection('assets'))).catch(() => ({ docs: [] })),
            Promise.resolve().then(() => get(db.collection('advance_reports'))).catch(() => ({ docs: [] })),
            Promise.resolve().then(() => get(db.collection('staff'))).catch(() => ({ docs: [] }))
        ]);
        const advanceReports = (advanceSnap?.docs || []).map(d => ({ id: d.id, ...d.data() }));
        const closedSnapshots = new Map();
        for (const [p, d] of periods) if (d.status === 'closed' && d.archiveVersion === 1) {
            const parts = snapshots.docs.filter(s => s.data().period === p).sort((a,b) => a.data().index - b.data().index);
            if (parts.length === d.archiveParts && parts.every((s,i)=>s.data().index===i) && parts.reduce((n,s)=>n+s.data().entries.length,0)===d.entries) closedSnapshots.set(p, parts.flatMap(s => s.data().entries));
        }
        return {
            policy,
            assets: (assetsSnap?.docs || []).map(d => ({ id: d.id, ...d.data() })),
            advanceReports,
            staff: (staffSnap?.docs || []).map(d => ({ id: d.id, ...d.data() })),
            bankCuts: new Map(cuts.docs.map(d => [d.id,d.data()])),
            input: {
                start: policy.startDate.slice(0, 7), startDate: policy.startDate, policy, closedSnapshots,
                adjustments: notesSnap.docs.map(d => ({ id:d.id, ...d.data() })),
                ledgers,
                bankTx: txSnap.docs.map(d => ({ id: d.id, ...d.data() })),
                expenses: exSnap.docs.map(d => ({ id: d.id, ...d.data() })),
                suppliers: new Map(supSnap.docs.map(d => [d.id, d.data()])),
                payrollRuns: payrollSnap.docs.map(d => ({ period: d.id, ...d.data() })),
                payrollPayments,
                opening,
                advanceReports
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
    function defaultPeriod(closed, now, start) {
        const current = now.slice(0, 7);
        for (const p of core.periodsUpTo(current, start)) if (!closed.includes(p)) return p;
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
        const p = validPeriod(period) ? period : defaultPeriod(data.closed, now, data.input.start);
        const entries = core.journal(data.input, p);
        const tb = core.trialBalance(entries, p);
        const assetsState = assetsCore.reconcileAssets({
            assets: data.assets,
            expenses: data.input.expenses,
            opening: data.opening,
            adjustments: data.input.adjustments,
            policy: data.policy,
            period: p
        });
        const stored = data.periods.get(p);
        const isClosed = stored?.status === 'closed';
        const isClosing = stored?.status === 'closing' && stored.closingUntil > Date.now();
        const key = sha(core.entriesKey(entries, p));
        const liveKey = sha(core.entriesKey(core.journal({ ...data.input, closedSnapshots: null }, p), p));
        const checks = isClosed
            ? [stored.key === liveKey
                ? { level: 'ok', text: 'Місяць закрито; операції відтоді не змінювались' }
                : { level: 'warn', text: 'Після закриття змінились операції цього місяця (наприклад, пізня виписка банку). Голова може відкрити місяць, щоб розібратися' }]
            : core.closeChecks({ period: p, today: now, bankTx: data.input.bankTx, expenses: data.input.expenses, chargedPeriods: data.charged, closed: data.closed, tb, openingStatus: data.opening?.status || 'none', start: data.input.start });
        if (!isClosed && data.policy.status !== 'approved') checks.push({ level:'block', text:'Параметри обліку ще не погоджені головою: дата початку, фонди та схема доходів («Налаштування»)' });
        if(!isClosed && data.bankAccounts.some(a=>a.purpose==='deposit' && policyCore.bankAccount(a.iban,data.policy)==='311'))checks.push({level:'block',text:'Для депозитного рахунку оберіть субрахунок за його договором у налаштуваннях обліку'});
        if (isClosed && stored.archiveVersion === 1 && !data.input.closedSnapshots.has(p)) checks.push({level:'block',text:'Архів проводок цього періоду неповний; відновіть його перед подальшим обліком'});
        const bankRows = tb.rows.filter(r=>['311','313','351','143'].includes(r.acc)).flatMap(r=>r.byA.map(a=>({acc:r.acc,iban:a.a,balanceKop:a.closeDr-a.closeCr})));
        if(!isClosed && data.input.adjustments.some(n=>n.period===p&&n.status==='draft'))checks.push({level:'block',text:'Бухгалтерські довідки цього місяця ще не погоджені'});
        if (!isClosed && assetsState.summary.dueDeprCount > 0) {
            checks.push({
                level: 'warn',
                text: `За цей місяць ще не нараховано амортизацію для ${assetsState.summary.dueDeprCount} обʼєктів ОЗ/МНМА на суму ${(assetsState.summary.dueDeprKop / 100).toFixed(2)} грн (розділ «Майно та ТМЦ»)`
            });
        }
        const cut = data.bankCuts.get(p);
        if (!isClosed && bankRows.length && (!cut || cut.key !== key || cut.rows.length !== bankRows.length || bankRows.some(r=>!cut.rows.some(c=>c.iban===r.iban&&c.acc===r.acc&&c.balanceKop===r.balanceKop)))) checks.push({level:'block',text:'Звірте залишки поточного і депозитного рахунків з випискою на кінець саме цього місяця'});
        checks.push(...reconcile({ period: p, start:data.input.start, startDate:data.policy.startDate, runs: data.runs, bankTx: data.input.bankTx, ledgers: data.input.ledgers,
            apartments: data.apartments, openingSet: data.openingSet, openingPending: data.openingPending, expenses: data.input.expenses, payments: data.payments, payrollRuns: data.input.payrollRuns }));
        // Є працівники, а відомість місяця не затверджено — зарплата не потрапить у проводки місяця.
        if (!isClosed && activeIn(data.people, p).length && data.input.payrollRuns.find(r => r.period === p)?.status !== 'approved') {
            const ok = checks.findIndex(c => c.level === 'ok');
            checks.splice(ok >= 0 ? ok : checks.length, 0, { level: 'block', text: 'Відомість зарплати за місяць не затверджено — нарахування зарплати не потрапить у проводки місяця' });
        }
        const payroll = data.input.payrollRuns.find(r => r.period === p);
        const payrollSent = [...data.input.payrollPayments.values()].some(payment => payment.period === p);
        if (!isClosed && ((payrollSent && payroll?.status !== 'approved') || Object.values(payroll?.stages || {}).some(stage => !stage.external && stage.complete === false))) {
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
        const assetLabels = Object.fromEntries(assetsState.items.map(a => [a.id, a.name && a.name !== a.id ? `${a.id} · ${a.name}` : a.id]));
        return {
            period: p, today: now, start: data.input.start, startDate: data.policy.startDate, policy: data.policy, bankRows, bankCut: cut ? {note:cut.note, date:cut.date, key:cut.key} : null,
            periods: core.periodsUpTo(now.slice(0, 7), data.input.start).map(id => ({ id, status: data.periods.get(id)?.status === 'closed' ? 'closed' : 'open' })),
            status: isClosed ? 'closed' : isClosing ? 'closing' : 'open', key,
            closedAt: stored?.closedAt?.toDate?.()?.toISOString() || null, closedBy: stored?.closedBy || null,
            history: (stored?.history || []).map(h => ({ ...h, at: h.at?.toDate?.()?.toISOString?.() || h.at || null })),
            canClose: !isClosed && !isClosing && !checks.some(c => c.level === 'block'),
            canReopen: isClosed && lastClosed === p,
            accounts: core.ACCOUNTS,
            assetsSummary: assetsState.summary,
            advanceSummary: {
                pendingCount: data.advanceReports.filter(a => a.status === 'pending').length,
                toReimburseCount: data.advanceReports.filter(a => a.status === 'approved' && (a.reimburseKop || 0) > (a.reimbursedKop || 0)).length,
                toReimburseKop: data.advanceReports.filter(a => a.status === 'approved' && (a.reimburseKop || 0) > (a.reimbursedKop || 0)).reduce((s, a) => s + Math.max(0, (a.reimburseKop || 0) - (a.reimbursedKop || 0)), 0)
            },
            // Назви для аналітики: статті витрат (92), складові внеску (48), джерела доходу, об'єкти ОЗ/МНМА/ТМЦ.
            labels: {
                10: assetLabels, 11: assetLabels, 131: assetLabels, 132: assetLabels, 20: assetLabels, 22: assetLabels,
                372: Object.fromEntries(data.advanceReports.map(a => [a.personName, a.personName])),
                92: ITEMS, 641: { pdfo: 'ПДФО', vz: 'Військовий збір' }, 651: {esv:'ЄСВ'},
                661: Object.fromEntries(data.input.payrollRuns.flatMap(p=>p.run?.rows || []).map(r=>[require('./payroll-payment-core').personAccount(r),r.name])),
                48: Object.fromEntries(data.policy.funds.map(f=>[f.id,f.name])), 703: INCOME_SOURCES, 719: INCOME_SOURCES, 733: INCOME_SOURCES
            },
            opening: { status: data.opening?.status || 'none', lines: data.opening?.lines?.length || 0 },
            tb,
            entries: entries.filter(e => e.period === p).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0)),
            checks
        };
    }

    /** 311 за кожним рахунком (з вхідним залишком) проти останнього залишку з банку. */
    function bankCheck(tb, accounts) {
        const byIban = new Map(tb.rows.filter(r=>['311','313','351','143'].includes(r.acc)).flatMap(r=>(r.byA || []).map(x => [String(x.a), x.closeDr - x.closeCr])));
        const off = accounts.filter(a => (!a.currency || a.currency === 'UAH') && Number.isSafeInteger(a.balanceKop) && (byIban.get(a.iban) || 0) !== a.balanceKop);
        if (!accounts.length) return null;
        return off.length
            ? { level: 'warn', text: `Рахунок 311 не збігається із залишком банку: ${off.map(a => `…${a.iban.slice(-4)} — облік ${((byIban.get(a.iban) || 0) / 100).toFixed(2)}, банк ${(a.balanceKop / 100).toFixed(2)} грн`).join('; ')}. Причина — вхідний залишок або операції, яких ще немає у виписці` }
            : { level: 'ok', text: 'Рахунок 311 збігається із залишками банку за всіма рахунками' };
    }

    /** Чистий рух за рахунком банку з початку обліку (без вхідного залишку). */
    function turnover311(entries, iban, acc = '311') {
        return entries.filter(e => e.src !== 'opening').reduce((s, e) => s + (e.dr === acc && e.dA === iban ? e.kop : 0) - (e.cr === acc && e.cA === iban ? e.kop : 0), 0);
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
            const acc=policyCore.bankAccount(a.iban,data.policy), moved = turnover311(all, a.iban,acc);
            return { iban: a.iban, acc, name: a.name || '', purpose: a.purpose || 'current', balanceKop: a.balanceKop ?? null,
                balanceAt: a.balanceAt?.toDate?.()?.toISOString() || null, turnoverKop: moved,
                suggestKop: Number.isSafeInteger(a.balanceKop) ? a.balanceKop - moved : null };
        });
        return {
            date: policyCore.previousDay(data.policy.startDate), status: doc?.status || 'none', lines, auto: autoLines,
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
        await audit(actor, role, 'journal.opening.approve', 'journal_opening/main', `Вхідну ОСВ затверджено: дебет = кредит = ${(totals.dr / 100).toFixed(2)} грн`, totals);
        return { ok: true };
    }

    // --------------------------------------------------------
    // РЕЄСТР ОСНОВНИХ ЗАСОБІВ (10, 11) ТА ТМЦ (20, 22)
    // --------------------------------------------------------
    async function assetsContext({ period } = {}, transaction = null) {
        const now = today();
        const data = await load(transaction);
        const p = validPeriod(period) ? period : defaultPeriod(data.closed, now, data.input.start);
        const stored = data.periods.get(p);
        const isClosed = stored?.status === 'closed';
        const state = assetsCore.reconcileAssets({
            assets: data.assets,
            expenses: data.input.expenses,
            opening: data.opening,
            adjustments: data.input.adjustments,
            policy: data.policy,
            period: p
        });
        const deprPlan = assetsCore.planMonthlyDepreciation(state.items, p);
        return {
            period: p,
            today: now,
            start: data.input.start,
            startDate: data.policy.startDate,
            status: isClosed ? 'closed' : 'open',
            periods: core.periodsUpTo(now.slice(0, 7), data.input.start).map(id => ({ id, status: data.periods.get(id)?.status === 'closed' ? 'closed' : 'open' })),
            items: state.items,
            summary: state.summary,
            mnhmaLimitKop: state.mnhmaLimitKop,
            deprPlan,
            accounts: assetsCore.ASSET_ACCOUNTS,
            subaccounts: assetsCore.ASSET_SUBACCOUNTS,
            deprMethods: assetsCore.DEPR_METHODS,
            units: assetsCore.UNITS,
            expenseItems: ITEMS,
            funds: data.policy.funds
        };
    }

    async function saveAsset(actor, role, data) {
        const card = {
            id: text(data.id, 80),
            acc: String(data.acc || '10'),
            subacc: text(data.subacc, 10) || assetsCore.defaultSubacc(String(data.acc || '10')),
            name: text(data.name, 200),
            item: ITEMS[data.item] ? String(data.item) : 'systems',
            fundId: text(data.fundId || 'main', 40),
            acquiredDate: validDate(data.acquiredDate) ? String(data.acquiredDate) : '',
            commissionedDate: validDate(data.commissionedDate) ? String(data.commissionedDate) : '',
            commissionActNo: text(data.commissionActNo, 60),
            usefulLifeMonths: Number(data.usefulLifeMonths) > 0 ? Math.round(Number(data.usefulLifeMonths)) : (String(data.acc) === '10' ? 60 : 36),
            deprMethod: text(data.deprMethod, 30) || assetsCore.defaultDeprMethod(String(data.acc || '10')),
            salvageKop: Number(data.salvageKop) >= 0 ? Math.round(Number(data.salvageKop)) : 0,
            unit: text(data.unit || 'шт.', 20),
            initialQty: Number(data.initialQty) > 0 ? Number(data.initialQty) : 1,
            custodian: text(data.custodian, 160),
            location: text(data.location, 200),
            serialNumber: text(data.serialNumber, 100),
            passportNote: text(data.passportNote, 300)
        };
        const err = assetsCore.checkAssetCard(card);
        if (err) fail('invalid-argument', err);
        const docId = safeId(card.id);
        const ref = db.doc(`assets/${docId}`);
        const initialCostKop = Number(data.initialCostKop || 0);
        const sourceMode = String(data.sourceMode || 'card_only');

        await db.runTransaction(async t => {
            const loaded = await load(t);
            if (!loaded.policy.funds.some(f => f.id === card.fundId)) card.fundId = loaded.policy.defaultFund;
            if (sourceMode === 'donated_or_surplus' && initialCostKop > 0) {
                if (!validDate(card.acquiredDate)) fail('invalid-argument', 'Вкажіть дату оприбуткування для безоплатно отриманого майна або лишку');
                const p = card.acquiredDate.slice(0, 7);
                await lock?.assertOpen(p, 'Оприбуткування активу', t);
                const noteRef = db.collection('accounting_notes').doc();
                t.create(noteRef, {
                    type: 'assetCapitalize',
                    date: card.acquiredDate,
                    period: p,
                    amountKop: initialCostKop,
                    analytic: card.id,
                    assetAcc: card.acc,
                    lines: [{
                        dr: card.acc,
                        cr: '48',
                        dA: card.id,
                        cA: card.fundId,
                        kop: initialCostKop,
                        fund: card.fundId
                    }],
                    fundId: card.fundId,
                    source: text(data.sourceDoc || `Акт оприбуткування № ${card.commissionActNo || '1'}`, 200),
                    note: `Безоплатне одержання / оприбуткування власного активу ОСББ «${card.name}» (${card.id})`,
                    status: 'approved',
                    approvedBy: actor,
                    approvedAt: FieldValue.serverTimestamp(),
                    by: actor,
                    at: FieldValue.serverTimestamp()
                });
            }
            t.set(ref, {
                ...card,
                updatedBy: actor,
                updatedAt: FieldValue.serverTimestamp()
            }, { merge: true });
        });
        await audit(actor, role, 'assets.save', `assets/${docId}`, `Картку ${card.id} «${card.name}» (рахунок ${card.acc}) збережено`, card);
        return { ok: true, id: card.id };
    }

    async function commissionAsset(actor, role, data) {
        const assetId = text(data.id, 80);
        if (!assetId) fail('invalid-argument', 'Оберіть обʼєкт для введення в експлуатацію');
        const commDate = String(data.commissionedDate || today());
        if (!validDate(commDate)) fail('invalid-argument', 'Вкажіть коректну дату Акта введення в експлуатацію (Форма ОЗ-1)');
        const actNo = text(data.commissionActNo || '1', 60);
        const period = commDate.slice(0, 7);

        let accruedKop = 0;
        await db.runTransaction(async t => {
            const loaded = await load(t);
            const state = assetsCore.reconcileAssets({
                assets: loaded.assets,
                expenses: loaded.input.expenses,
                opening: loaded.opening,
                adjustments: loaded.input.adjustments,
                policy: loaded.policy,
                period
            });
            const current = state.items.find(x => x.id === assetId);
            if (!current || !assetsCore.isNonCurrent(current.acc)) fail('not-found', 'Обʼєкт ОЗ/МНМА не знайдено');
            if (current.costKop <= 0) fail('failed-precondition', 'Первісна вартість обʼєкта ще не оприбуткована на баланс (проведіть документ постачальника або вхідний залишок)');
            const method = data.deprMethod && assetsCore.DEPR_METHODS[data.deprMethod] ? data.deprMethod : (current.deprMethod || assetsCore.defaultDeprMethod(current.acc));
            const months = Number(data.usefulLifeMonths) > 0 ? Math.round(Number(data.usefulLifeMonths)) : (current.usefulLifeMonths || (current.acc === '10' ? 60 : 36));
            const custodian = text(data.custodian ?? current.custodian, 160);
            const location = text(data.location ?? current.location, 200);

            const ref = db.doc(`assets/${safeId(assetId)}`);
            t.set(ref, {
                id: assetId,
                acc: current.acc,
                subacc: current.subacc || assetsCore.defaultSubacc(current.acc),
                name: current.name,
                item: data.item && ITEMS[data.item] ? String(data.item) : (current.item || 'systems'),
                fundId: current.fundId || loaded.policy.defaultFund,
                commissionedDate: commDate,
                commissionActNo: actNo,
                deprMethod: method,
                usefulLifeMonths: months,
                custodian,
                location,
                updatedBy: actor,
                updatedAt: FieldValue.serverTimestamp()
            }, { merge: true });

            // Якщо це МНМА (11) з методом 100% або 50%/50% і період відкритий — одразу нараховуємо знос першого місяця експлуатації (п. 27 НП(С)БО 7)
            if (current.acc === '11' && (method === 'mnhma_100' || method === 'mnhma_50_50') && data.accrueFirstMonth !== false && !loaded.closed.includes(period)) {
                const updatedCard = { ...current, commissionedDate: commDate, deprMethod: method, usefulLifeMonths: months };
                const firstDepr = assetsCore.monthlyDepreciationFor(updatedCard, period);
                if (firstDepr > 0) {
                    accruedKop = firstDepr;
                    const noteRef = db.collection('accounting_notes').doc();
                    t.create(noteRef, {
                        type: 'depreciation',
                        autoAssetOp: 'commission_mnhma',
                        date: commDate,
                        period,
                        amountKop: firstDepr,
                        analytic: assetId,
                        assetAcc: '11',
                        lines: [{
                            dr: '92',
                            cr: '132',
                            dA: data.item && ITEMS[data.item] ? String(data.item) : (current.item || 'systems'),
                            cA: assetId,
                            kop: firstDepr,
                            fund: current.fundId || loaded.policy.defaultFund
                        }],
                        fundId: current.fundId || loaded.policy.defaultFund,
                        source: `Акт ОЗ-1 № ${actNo} від ${commDate.split('-').reverse().join('.')}`,
                        note: `Амортизація МНМА при введенні в експлуатацію (${method === 'mnhma_100' ? '100 %' : '50 %'}): «${current.name}» (${assetId})`,
                        status: 'approved',
                        approvedBy: actor,
                        approvedAt: FieldValue.serverTimestamp(),
                        by: actor,
                        at: FieldValue.serverTimestamp()
                    });
                }
            }
        });
        await audit(actor, role, 'assets.commission', `assets/${safeId(assetId)}`,
            `Введено в експлуатацію ${assetId} (Акт ОЗ-1 № ${actNo} від ${commDate.split('-').reverse().join('.')})${accruedKop ? `, нараховано знос ${(accruedKop / 100).toFixed(2)} грн` : ''}`,
            { id: assetId, commissionedDate: commDate, actNo, accruedKop });
        return { ok: true, id: assetId, accruedKop };
    }

    async function depreciateMonth(actor, role, { period } = {}) {
        const now = today();
        const result = await db.runTransaction(async t => {
            const loaded = await load(t);
            const p = validPeriod(period) ? period : defaultPeriod(loaded.closed, now, loaded.input.start);
            await lock?.assertOpen(p, 'Нарахування амортизації за місяць', t);
            const state = assetsCore.reconcileAssets({
                assets: loaded.assets,
                expenses: loaded.input.expenses,
                opening: loaded.opening,
                adjustments: loaded.input.adjustments,
                policy: loaded.policy,
                period: p
            });
            const plan = assetsCore.planMonthlyDepreciation(state.items, p);
            if (!plan.lines.length || plan.totalKop <= 0) {
                return { period: p, count: 0, totalKop: 0 };
            }
            const noteRef = db.collection('accounting_notes').doc();
            t.create(noteRef, {
                type: 'depreciation',
                autoAssetOp: 'monthly_depreciation',
                date: plan.date,
                period: p,
                amountKop: plan.totalKop,
                analytic: plan.items.length === 1 ? plan.items[0].id : `ОЗ/МНМА (${plan.items.length} об.)`,
                assetAcc: plan.items.every(i => i.acc === '11') ? '11' : '10',
                lines: plan.lines,
                fundId: loaded.policy.defaultFund,
                source: `Відомість нарахування амортизації за ${p}`,
                note: `Нарахування амортизації ОЗ та МНМА за ${p} (${plan.items.map(i => `${i.id}: ${(i.kop / 100).toFixed(2)} грн`).join('; ')})`.slice(0, 300),
                status: 'approved',
                approvedBy: actor,
                approvedAt: FieldValue.serverTimestamp(),
                by: actor,
                at: FieldValue.serverTimestamp()
            });
            return { period: p, count: plan.items.length, totalKop: plan.totalKop, noteId: noteRef.id };
        });
        if (result.count > 0) {
            await audit(actor, role, 'assets.depreciate', `accounting_notes/${result.noteId}`,
                `Нараховано амортизацію за ${result.period}: ${result.count} обʼєктів на суму ${(result.totalKop / 100).toFixed(2)} грн`, result);
        }
        return { ok: true, ...result };
    }

    async function writeOffInventory(actor, role, data) {
        const assetId = text(data.id, 80);
        if (!assetId) fail('invalid-argument', 'Оберіть ТМЦ або МШП для списання');
        const date = String(data.date || today());
        if (!validDate(date)) fail('invalid-argument', 'Вкажіть коректну дату акта списання');
        const period = date.slice(0, 7);

        const out = await db.runTransaction(async t => {
            const loaded = await load(t);
            await lock?.assertOpen(period, 'Списання ТМЦ / МШП', t);
            const state = assetsCore.reconcileAssets({
                assets: loaded.assets,
                expenses: loaded.input.expenses,
                opening: loaded.opening,
                adjustments: loaded.input.adjustments,
                policy: loaded.policy,
                period
            });
            const asset = state.items.find(x => x.id === assetId);
            const plan = assetsCore.planInventoryWriteOff(asset, {
                date,
                qty: data.qty,
                item: data.item,
                actNo: data.actNo,
                reason: data.reason,
                custodian: data.custodian,
                location: data.location
            });
            if (plan.error) fail('invalid-argument', plan.error);

            const noteRef = db.collection('accounting_notes').doc();
            t.create(noteRef, {
                type: 'inventory',
                autoAssetOp: asset.acc === '22' ? 'mshp_handover' : 'inventory_writeoff',
                date: plan.date,
                period: plan.period,
                amountKop: plan.amountKop,
                qty: plan.qty,
                analytic: asset.id,
                assetAcc: asset.acc,
                lines: [plan.line],
                fundId: asset.fundId || loaded.policy.defaultFund,
                source: plan.source,
                note: plan.note.slice(0, 300),
                status: 'approved',
                approvedBy: actor,
                approvedAt: FieldValue.serverTimestamp(),
                by: actor,
                at: FieldValue.serverTimestamp()
            });
            t.set(db.doc(`assets/${safeId(asset.id)}`), {
                id: asset.id,
                acc: asset.acc,
                name: asset.name,
                ...(plan.custodian ? { custodian: plan.custodian } : {}),
                ...(plan.location ? { location: plan.location } : {}),
                updatedBy: actor,
                updatedAt: FieldValue.serverTimestamp()
            }, { merge: true });
            return { id: asset.id, acc: asset.acc, name: asset.name, amountKop: plan.amountKop, qty: plan.qty, unit: asset.unit, noteId: noteRef.id };
        });

        await audit(actor, role, 'assets.writeoff', `accounting_notes/${out.noteId}`,
            `${out.acc === '22' ? 'Передано МШП в експлуатацію' : 'Списано запаси'} ${out.id} «${out.name}»: ${out.qty} ${out.unit || 'шт.'} на ${(out.amountKop / 100).toFixed(2)} грн`, out);
        return { ok: true, ...out };
    }

    async function disposeAsset(actor, role, data) {
        if (role !== 'chair') fail('permission-denied', 'Ліквідацію (списання з балансу) основних засобів за Актом ОЗ-3 затверджує голова правління');
        const assetId = text(data.id, 80);
        if (!assetId) fail('invalid-argument', 'Оберіть обʼєкт ОЗ/МНМА для списання');
        const date = String(data.date || today());
        if (!validDate(date)) fail('invalid-argument', 'Вкажіть дату Акта ОЗ-3');
        const period = date.slice(0, 7);

        const out = await db.runTransaction(async t => {
            const loaded = await load(t);
            await lock?.assertOpen(period, 'Ліквідація ОЗ/МНМА (Акт ОЗ-3)', t);
            const state = assetsCore.reconcileAssets({
                assets: loaded.assets,
                expenses: loaded.input.expenses,
                opening: loaded.opening,
                adjustments: loaded.input.adjustments,
                policy: loaded.policy,
                period
            });
            const asset = state.items.find(x => x.id === assetId);
            const plan = assetsCore.planAssetDisposal(asset, {
                date,
                actNo: data.actNo,
                reason: data.reason
            });
            if (plan.error) fail('invalid-argument', plan.error);

            const noteRef = db.collection('accounting_notes').doc();
            t.create(noteRef, {
                type: 'assetDisposal',
                autoAssetOp: 'asset_disposal',
                date: plan.date,
                period: plan.period,
                amountKop: plan.amountKop,
                analytic: asset.id,
                assetAcc: asset.acc,
                lines: plan.lines,
                fundId: asset.fundId || loaded.policy.defaultFund,
                source: plan.source,
                note: plan.note.slice(0, 300),
                status: 'approved',
                approvedBy: actor,
                approvedAt: FieldValue.serverTimestamp(),
                by: actor,
                at: FieldValue.serverTimestamp()
            });
            t.set(db.doc(`assets/${safeId(asset.id)}`), {
                id: asset.id,
                acc: asset.acc,
                name: asset.name,
                disposedDate: plan.date,
                disposalActNo: text(data.actNo, 60),
                disposalReason: text(data.reason, 240),
                updatedBy: actor,
                updatedAt: FieldValue.serverTimestamp()
            }, { merge: true });
            return { id: asset.id, name: asset.name, amountKop: plan.amountKop, wearKop: plan.wearKop, netKop: plan.netKop, noteId: noteRef.id };
        });

        await audit(actor, role, 'assets.dispose', `assets/${safeId(out.id)}`,
            `Ліквідовано за Актом ОЗ-3 обʼєкт ${out.id} «${out.name}»: списано знос ${(out.wearKop / 100).toFixed(2)} грн, залишкову вартість ${(out.netKop / 100).toFixed(2)} грн`, out);
        return { ok: true, ...out };
    }

    async function retireMshp(actor, role, data) {
        const assetId = text(data.id, 80);
        const qty = Number(data.qty || 0);
        const date = String(data.date || today());
        const actNo = text(data.actNo || '1', 60);
        const reason = text(data.reason, 240);
        if (!assetId || !validDate(date) || !Number.isFinite(qty) || qty <= 0 || reason.length < 4) {
            fail('invalid-argument', 'Вкажіть дату, номер акта, кількість та причину списання зношеного МШП з позабалансового обліку');
        }
        await db.runTransaction(async t => {
            const loaded = await load(t);
            const state = assetsCore.reconcileAssets({
                assets: loaded.assets,
                expenses: loaded.input.expenses,
                opening: loaded.opening,
                adjustments: loaded.input.adjustments,
                policy: loaded.policy,
                period: date.slice(0, 7)
            });
            const asset = state.items.find(x => x.id === assetId);
            if (!asset || asset.acc !== '22') fail('not-found', 'Картку МШП (рахунок 22) не знайдено');
            if (qty > (asset.inUseQty || 0) + 1e-6) {
                fail('invalid-argument', `В оперативному обліку за МВО рахується лише ${asset.inUseQty || 0} ${asset.unit || 'шт.'}`);
            }
            const newRetired = Number(((asset.retiredQty || 0) + qty).toFixed(3));
            const ref = db.doc(`assets/${safeId(asset.id)}`);
            t.set(ref, {
                id: asset.id,
                acc: '22',
                name: asset.name,
                retiredQty: newRetired,
                retirementActs: FieldValue.arrayUnion({ date, actNo, qty: Number(qty.toFixed(3)), reason, by: actor }),
                updatedBy: actor,
                updatedAt: FieldValue.serverTimestamp()
            }, { merge: true });
        });
        await audit(actor, role, 'assets.retireMshp', `assets/${safeId(assetId)}`,
            `Списано з позабалансового обліку МШП ${assetId} (${qty} од., Акт № ${actNo}): ${reason}`, { id: assetId, qty, date, actNo, reason });
        return { ok: true, id: assetId };
    }


    // --------------------------------------------------------
    // АВАНСОВІ ЗВІТИ ТА РОЗРАХУНКИ З ПІДЗВІТНИМИ ОСОБАМИ (372)
    // --------------------------------------------------------
    async function advanceContext({ period } = {}, transaction = null) {
        const now = today();
        const data = await load(transaction);
        const p = validPeriod(period) ? period : defaultPeriod(data.closed, now, data.input.start);
        const stored = data.periods.get(p);
        const isClosed = stored?.status === 'closed';

        // Збираємо список кандидатів у підзвітні особи: працівники та члени правління
        const peopleMap = new Map();
        for (const pr of data.people || []) {
            if (pr.name && pr.active !== false) {
                peopleMap.set(pr.name, {
                    id: pr.id,
                    name: pr.name,
                    code: pr.rnokpp || '',
                    iban: pr.iban || '',
                    kind: pr.kind || 'employee'
                });
            }
        }
        for (const st of data.staff || []) {
            if (st.name && st.active !== false && !peopleMap.has(st.name)) {
                peopleMap.set(st.name, {
                    id: st.id,
                    name: st.name,
                    code: st.code || '',
                    iban: st.iban || '',
                    kind: st.role || 'board'
                });
            }
        }

        const reportsWithTotals = (data.advanceReports || []).map(r => ({
            ...r,
            totals: advanceCore.calculateReportTotals(r)
        })).sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));

        const periodReports = reportsWithTotals.filter(r => r.period === p);
        const totalSpentPeriodKop = periodReports.reduce((s, r) => s + (r.totals.spentKop || 0), 0);
        const totalPendingReimburseKop = reportsWithTotals.filter(r => r.status === 'approved')
            .reduce((s, r) => s + (r.totals.pendingReimburseKop || 0), 0);
        const totalPendingReturnKop = reportsWithTotals.filter(r => r.status === 'approved')
            .reduce((s, r) => s + (r.totals.pendingReturnKop || 0), 0);
        const pendingCount = reportsWithTotals.filter(r => r.status === 'pending').length;

        return {
            period: p,
            today: now,
            status: isClosed ? 'closed' : 'open',
            periods: core.periodsUpTo(now.slice(0, 7), data.input.start).map(id => ({ id, status: data.periods.get(id)?.status === 'closed' ? 'closed' : 'open' })),
            reports: reportsWithTotals,
            people: [...peopleMap.values()],
            summary: {
                totalSpentPeriodKop,
                totalPendingReimburseKop,
                totalPendingReturnKop,
                pendingCount,
                toReimburseCount: reportsWithTotals.filter(r => r.status === 'approved' && r.totals.pendingReimburseKop > 0).length
            },
            docTypes: advanceCore.ADVANCE_DOC_TYPES,
            statusLabels: advanceCore.ADVANCE_STATUS_LABELS,
            postingAccounts: advanceCore.POSTING_ACCOUNTS,
            expenseItems: ITEMS,
            funds: data.policy.funds
        };
    }

    async function saveAdvanceReport(actor, role, data) {
        const p = String(data.period || today().slice(0, 7)).trim();
        const date = String(data.date || today()).trim();
        const report = {
            id: text(data.id, 80),
            number: text(data.number, 60),
            date,
            period: p,
            personId: text(data.personId, 60),
            personName: text(data.personName, 200),
            personCode: text(data.personCode, 10),
            personIban: text(data.personIban, 34).replace(/\s+/g, '').toUpperCase(),
            purpose: text(data.purpose, 300),
            fundId: text(data.fundId || 'main', 40),
            advanceKop: Number(data.advanceKop || 0),
            advanceTxIds: Array.isArray(data.advanceTxIds) ? data.advanceTxIds : [],
            lines: (Array.isArray(data.lines) ? data.lines : []).map(l => ({
                id: text(l.id || (typeof randomUUID === 'function' ? randomUUID().slice(0, 8) : crypto.randomBytes(4).toString('hex')), 40),
                docType: String(l.docType || 'fiscal_receipt'),
                number: text(l.number, 60),
                date: String(l.date || date),
                supplier: text(l.supplier, 200),
                amountKop: Number(l.amountKop || 0),
                item: ITEMS[l.item] ? String(l.item) : 'office',
                postingAcc: String(l.postingAcc || '92'),
                assetId: text(l.assetId, 80),
                assetQty: Number(l.assetQty || 1),
                assetUnit: text(l.assetUnit || 'шт.', 20),
                desc: text(l.desc, 300),
                files: Array.isArray(l.files) ? l.files : []
            }))
        };

        const error = advanceCore.checkAdvanceReport(report);
        if (error) fail('invalid-argument', error);

        const totals = advanceCore.calculateReportTotals(report);
        report.spentKop = totals.spentKop;
        report.balanceKop = totals.balanceKop;
        report.reimburseKop = totals.reimburseKop;
        report.returnKop = totals.returnKop;
        report.reimbursedKop = Number(data.reimbursedKop || 0);
        report.returnedKop = Number(data.returnedKop || 0);

        const approved = role === 'chair' || data.approve === true && role === 'chair';
        report.status = approved ? (totals.isFullySettled ? 'settled' : 'approved') : 'pending';
        if (approved) {
            report.approvedBy = actor;
            report.approvedAt = FieldValue.serverTimestamp();
        }

        if (!report.number) report.number = advanceCore.suggestReportNumber(p, []);
        const docId = report.id || safeId(report.number);
        report.id = docId;
        const ref = db.doc(`advance_reports/${safeId(docId)}`);

        await db.runTransaction(async t => {
            const loaded = await load(t);
            await lock?.assertOpen(p, 'Авансовий звіт', t);
            if (!loaded.policy.funds.some(f => f.id === report.fundId)) report.fundId = loaded.policy.defaultFund;

            t.set(ref, {
                ...report,
                updatedBy: actor,
                updatedAt: FieldValue.serverTimestamp(),
                createdBy: actor,
                createdAt: FieldValue.serverTimestamp()
            }, { merge: true });

            // Автоматичне створення / оприбуткування карток ТМЦ або МНМА на складі
            if (approved) {
                for (const l of report.lines) {
                    if (l.postingAcc !== '92' && l.assetId) {
                        const aRef = db.doc(`assets/${safeId(l.assetId)}`);
                        t.set(aRef, {
                            id: l.assetId,
                            acc: l.postingAcc,
                            name: l.desc || l.supplier || l.assetId,
                            item: l.item,
                            fundId: report.fundId,
                            initialQty: Number(l.assetQty || 1),
                            unit: l.assetUnit || 'шт.',
                            acquiredDate: l.date,
                            updatedBy: actor,
                            updatedAt: FieldValue.serverTimestamp()
                        }, { merge: true });
                    }
                }
            }
        });

        await audit(actor, role, 'advance.save', ref.path,
            `Авансовий звіт № ${report.number} (${report.personName}): витрачено ${(report.spentKop / 100).toFixed(2)} грн, до відшкодування ${(report.reimburseKop / 100).toFixed(2)} грн — ${report.status}`,
            { id: report.id, spentKop: report.spentKop, reimburseKop: report.reimburseKop, status: report.status });
        return { ok: true, id: report.id, status: report.status };
    }

    async function approveAdvanceReport(actor, role, { id, comment }) {
        if (role !== 'chair') fail('permission-denied', 'Авансові звіти затверджує голова правління');
        const ref = db.doc(`advance_reports/${safeId(id)}`);
        const result = await db.runTransaction(async t => {
            const snap = await t.get(ref);
            if (!snap.exists) fail('not-found', 'Авансовий звіт не знайдено');
            const rep = snap.data();
            await lock?.assertOpen(rep.period, 'Авансовий звіт', t);
            if (rep.status === 'settled') fail('failed-precondition', 'Звіт уже розраховано');
            const totals = advanceCore.calculateReportTotals(rep);
            const status = totals.isFullySettled ? 'settled' : 'approved';

            t.update(ref, {
                status,
                approvedBy: actor,
                approvedAt: FieldValue.serverTimestamp(),
                comment: text(comment, 300)
            });

            // Автоматично створюємо / оновлюємо картки ТМЦ у разі оприбуткування матеріалів
            for (const l of rep.lines || []) {
                if (l.postingAcc !== '92' && l.assetId) {
                    const aRef = db.doc(`assets/${safeId(l.assetId)}`);
                    t.set(aRef, {
                        id: l.assetId,
                        acc: l.postingAcc,
                        name: l.desc || l.supplier || l.assetId,
                        item: l.item,
                        fundId: rep.fundId || 'main',
                        initialQty: Number(l.assetQty || 1),
                        unit: l.assetUnit || 'шт.',
                        acquiredDate: l.date,
                        updatedBy: actor,
                        updatedAt: FieldValue.serverTimestamp()
                    }, { merge: true });
                }
            }
            return { id: rep.id, personName: rep.personName, reimburseKop: totals.reimburseKop, status };
        });

        await audit(actor, role, 'advance.approve', ref.path,
            `Авансовий звіт № ${result.id} (${result.personName}) затверджено (до відшкодування ${(result.reimburseKop / 100).toFixed(2)} грн)`, result);
        return { ok: true, ...result };
    }

    async function rejectAdvanceReport(actor, role, { id, comment }) {
        if (role !== 'chair') fail('permission-denied', 'Авансові звіти відхиляє голова правління');
        const ref = db.doc(`advance_reports/${safeId(id)}`);
        const why = text(comment, 300);
        if (why.length < 3) fail('invalid-argument', 'Вкажіть причину відхилення авансового звіту');
        await db.runTransaction(async t => {
            const snap = await t.get(ref);
            if (!snap.exists) fail('not-found', 'Авансовий звіт не знайдено');
            const rep = snap.data();
            await lock?.assertOpen(rep.period, 'Авансовий звіт', t);
            if (rep.reimbursedKop > 0) fail('failed-precondition', 'За звітом уже частково виплачено кошти');
            t.update(ref, {
                status: 'rejected',
                rejectedBy: actor,
                rejectedAt: FieldValue.serverTimestamp(),
                comment: why
            });
        });
        await audit(actor, role, 'advance.reject', ref.path, `Авансовий звіт № ${id} відхилено: ${why}`, { id, reason: why });
        return { ok: true, id };
    }

    async function reimburseAdvanceReport(actor, role, { id, account }) {
        const ref = db.doc(`advance_reports/${safeId(id)}`);
        const snap = await ref.get();
        if (!snap.exists) fail('not-found', 'Авансовий звіт не знайдено');
        const rep = snap.data();
        if (rep.status !== 'approved') fail('failed-precondition', 'Створити виплату можна лише для затвердженого авансового звіту');
        const totals = advanceCore.calculateReportTotals(rep);
        if (totals.pendingReimburseKop <= 0) fail('failed-precondition', 'Уся сума перевитрати вже відшкодована');
        if (!rep.personIban || !/^UA\d{27}$/.test(rep.personIban)) fail('failed-precondition', 'Укажіть коректний IBAN особистої картки підзвітної особи для виплати компенсації');

        const purpose = advanceCore.reimbursementPurpose(rep);
        const created = await payments.actions.create(actor, role, {
            kind: 'advance',
            recipient: {
                name: rep.personName,
                iban: rep.personIban,
                code: rep.personCode || ''
            },
            amountKop: totals.pendingReimburseKop,
            purpose,
            account,
            proposalKey: `adv-${rep.id}-${rep.reimbursedKop || 0}`,
            advanceReportId: rep.id
        });

        await ref.update({
            paymentId: created.id,
            reimbursePaymentAt: FieldValue.serverTimestamp()
        });

        await audit(actor, role, 'advance.reimburse', ref.path,
            `Створено платіж у Приват24 на відшкодування ${(totals.pendingReimburseKop / 100).toFixed(2)} грн за авансовим звітом № ${rep.number} (${rep.personName})`,
            { id: rep.id, paymentId: created.id, amountKop: totals.pendingReimburseKop });
        return { ok: true, paymentId: created.id, amountKop: totals.pendingReimburseKop };
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
                const archiveParts = Math.ceil(fresh.entries.length / 250);
                for(let i=archiveParts;i<(current.data().archiveParts || 0);i++)t.delete(db.doc(`journal_snapshots/${period}-${i}`));
                for (let i = 0; i < archiveParts; i++) t.set(db.doc(`journal_snapshots/${period}-${i}`), { period,index:i,entries:fresh.entries.slice(i*250,(i+1)*250),version:1 });
                t.set(ref, {
                    status: 'closed', key: fresh.key, totals: fresh.tb.totals,
                    tb: fresh.tb.rows, entries: fresh.entries.length,
                    archiveVersion: 1, archiveParts, rulesVersion: 2, policy: JSON.parse(JSON.stringify(fresh.policy)), startDate: fresh.startDate,
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

    async function bankCut(actor, role, { period, rows, note }) {
        if (!validPeriod(period) || text(note, 300).length < 5 || !Array.isArray(rows)) fail('invalid-argument', 'Укажіть період, залишки з виписки та її реквізити');
        await db.runTransaction(async t => {
            const current = await context({ period }, t);
            if (current.status !== 'open') fail('failed-precondition', 'Місяць уже закрито або закривається');
            if(current.today<core.lastDay(period))fail('failed-precondition','Залишок на кінець місяця звіряють після настання цієї дати');
            const clean = rows.map(r => ({ acc:String(r.acc), iban:String(r.iban), balanceKop:Number(r.balanceKop) }));
            if (clean.length !== current.bankRows.length || new Set(clean.map(r=>`${r.acc}:${r.iban}`)).size !== clean.length || clean.some(r=>!Number.isSafeInteger(r.balanceKop)
                || !current.bankRows.some(x=>x.acc===r.acc && x.iban===r.iban && x.balanceKop===r.balanceKop))) fail('failed-precondition', 'Залишки виписки не збігаються з обліком. Знайдіть пропущені операції або виправте вхідну ОСВ');
            t.set(db.doc(`journal_bank_checks/${period}`), { period,date:core.lastDay(period),key:current.key,rows:clean,note:text(note,300),by:actor,at:FieldValue.serverTimestamp() });
            t.create(db.collection('audit_log').doc(),{actor,role,action:'journal.bankCut',target:`journal_bank_checks/${period}`,summary:'Банк звірено з обліком на кінець періоду',details:{period,note:text(note,300)},at:FieldValue.serverTimestamp()});
        });
        return {ok:true};
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
            case 'policy': return policyStore.context();
            case 'savePolicy': return policyStore.save(actor, role, data);
            case 'bankCut': return bankCut(actor, role, data);
            case 'notes': return notes.context();
            case 'saveNote': return notes.save(actor, role, data);
            case 'approveNote': return notes.approve(actor, role, data);
            case 'assetsContext': return assetsContext(data);
            case 'saveAsset': return saveAsset(actor, role, data);
            case 'commissionAsset': return commissionAsset(actor, role, data);
            case 'depreciateMonth': return depreciateMonth(actor, role, data);
            case 'writeOffInventory': return writeOffInventory(actor, role, data);
            case 'disposeAsset': return disposeAsset(actor, role, data);
            case 'retireMshp': return retireMshp(actor, role, data);
            case 'advanceContext': return advanceContext(data);
            case 'saveAdvanceReport': return saveAdvanceReport(actor, role, data);
            case 'approveAdvanceReport': return approveAdvanceReport(actor, role, data);
            case 'rejectAdvanceReport': return rejectAdvanceReport(actor, role, data);
            case 'reimburseAdvanceReport': return reimburseAdvanceReport(actor, role, data);
            default: fail('invalid-argument', 'Невідома дія');
        }
    }));

    return {
        journalAction, load, notes,
        actions: {
            context, close, reopen, openingContext, saveOpening, approveOpening, bankCut,
            policy: policyStore.context, savePolicy: policyStore.save,
            assetsContext, saveAsset, commissionAsset, depreciateMonth, writeOffInventory, disposeAsset, retireMshp,
            advanceContext, saveAdvanceReport, approveAdvanceReport, rejectAdvanceReport, reimburseAdvanceReport
        }
    };
};
