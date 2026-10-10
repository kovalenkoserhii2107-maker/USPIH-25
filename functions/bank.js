'use strict';
// ============================================================
// Банк ОСББ: синхронізація з ПриватБанком і рознесення оплат.
//
// Усі записи в bank_*, історію квартир (ledger) і журнал дій робить
// тільки сервер: клієнтські правила на ці колекції запис забороняють.
// Так сума частин завжди дорівнює сумі платежу, рознесення не
// дублюється, а токен банку ніколи не потрапляє в браузер.
//
// Колекції:
//   bank/settings      — підключення, рахунки ОСББ, остання синхронізація
//   bank_secrets/privat — токен Автоклієнта (правила: ніхто не читає)
//   bank_tx/{id}       — операції виписки з рішенням (див. TX нижче)
//   bank_links/{key}   — запамʼятовані платники: ключ → квартира
//
// TX: { bankId, account, at, period, direction: in|out, amountKop, currency,
//       purpose, counterparty: { name, account, code }, payerKey,
//       kind: payment|income|expense|internal, status: done|review,
//       category?, method?, suggestions: [{ apt, reason }],
//       allocations: [{ apt, amountKop, ledgerId }], source, auto,
//       resolvedBy?, resolvedAt? }
// ============================================================
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const callGuard = require('./call-guard');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const logger = require('firebase-functions/logger');
const core = require('./bank-core');
const { matchesPayment } = require('./payments-core');
const { matchExpense } = require('./expenses-core');
const privat = require('./privat');

const REGION = 'europe-central2';
const PURPOSES = ['current', 'repair', 'reserve', 'deposit', 'grant'];
const INCOME = ['rent', 'equipment', 'interest', 'grant', 'refund', 'other'];
const EXPENSE = ['bank_fee', 'supplier', 'salary', 'taxes', 'esv', 'other'];
// Повернення на рахунок ОСББ, привʼязане до списання: проводка — назад на рахунок, з якого платили.
const REFUND_REASONS = { bounce: 'банк повернув платіж (документ знову до сплати)', supplier: 'постачальник повернув кошти (сторно, знижка, переплата)', other: 'інше повернення списаного' };
// Облік у застосунку починається з початку IV кварталу 2026 року:
// раніші операції лишаються в сервісі бухгалтера.
const DEFAULT_START = '2026-10-01';
// Банк може дооформити операцію заднім числом — перечитуємо кілька днів.
const OVERLAP_DAYS = 3;

module.exports = function bankFunctions({ db, FieldValue, Timestamp, requireAdmin, staffRole, balances, expenses, lock }) {
    // Баланс квартири з історії (charges.js): після кожної рознесеної оплати.
    const recompute = async apts => {
        const result = apts.length && balances ? await balances.recompute(apts) : null;
        if (result?.error) throw new Error('Оплати збережено, але баланси не перераховано. Повторіть синхронізацію або перерахунок балансів.');
        return result;
    };

    const settingsRef = db.doc('bank/settings');
    const secretRef = db.doc('bank_secrets/privat');

    // --------------------------------------------------------
    // КОНТЕКСТ РОЗПІЗНАВАННЯ
    // --------------------------------------------------------
    async function loadContext() {
        const [apts, owners, links, settings, sent] = await Promise.all([
            db.collection('apartments').get(),
            db.collectionGroup('owners').get(),
            db.collection('bank_links').get(),
            settingsRef.get(),
            db.collection('payments').where('status', 'in', ['sent', 'unknown']).get()
        ]);
        const known = { apts: new Set(), ids: new Map(), accounts: new Map(), ambiguousAccounts: new Set() };
        const ambiguousApts = new Set();
        apts.forEach(d => {
            if (d.data().isAdmin === true) return;
            const apt = core.cleanApt(d.id);
            known.apts.add(apt);
            if (known.ids.has(apt)) ambiguousApts.add(apt);
            known.ids.set(apt, d.id);
            const account = String(d.data().personalAccount || '').trim();
            if (account) {
                const key = core.accountKey(account);
                if (known.accounts.has(key) && known.accounts.get(key) !== apt) known.ambiguousAccounts.add(key);
                known.accounts.set(account, apt); known.accounts.set(key, apt);
            }
        });
        for (const apt of ambiguousApts) { known.apts.delete(apt); known.ids.delete(apt); }
        for (const [key, apt] of known.accounts) if (known.ambiguousAccounts.has(core.accountKey(key)) || ambiguousApts.has(apt)) known.accounts.delete(key);
        const ownerList = [];
        owners.forEach(d => ownerList.push({ apt: core.cleanApt(d.ref.parent.parent.id), name: d.data().name || '' }));
        const linkMap = new Map();
        links.forEach(d => linkMap.set(d.id, d.data().apt));
        const data = settings.exists ? settings.data() : {};
        // Документи витрат, що чекають оплати: списання постачальнику закриває їх саме.
        const open = expenses ? await expenses.openForMatching() : { suppliers: [], expenses: [] };
        return {
            suppliers: open.suppliers, openExpenses: open.expenses,
            known, owners: ownerList, links: linkMap,
            ownAccounts: new Set(Object.keys(data.accounts || {}).map(core.normIban)),
            startDate: data.startDate || DEFAULT_START,
            settings: data,
            // Платежі, що чекають підпису: їх закриваємо, коли списання зʼявиться у виписці.
            sentPayments: sent.docs.map(d => ({ id: d.id, ...d.data(), sentAt: d.data().sentAt?.toDate?.() || d.data().createdAt?.toDate?.() || new Date(0) }))
        };
    }

    const ledgerRef = (apt, txId, index) => db.doc(`apartments/${apt}/ledger/bank-${txId}${index ? `-${index}` : ''}`);

    /** Записи «Оплата» в історії квартир — тим самим батчем, що й операція. */
    function writeAllocations(batch, txId, tx, allocations, ctx) {
        return allocations.map((a, index) => {
            const aptId = ctx.known.ids?.get(a.apt) || a.apt;
            const ref = ledgerRef(aptId, txId, index);
            batch.set(ref, {
                at: tx.at, period: tx.period, kind: 'payment', amount: core.fromKop(a.amountKop),
                // Розділений платіж: призначення чужого платника іншим квартирам не показуємо.
                note: allocations.length > 1 ? 'Частина спільного платежу' : String(tx.purpose || '').slice(0, 200),
                source: 'bank', txId, amountKop: a.amountKop,
                createdAt: FieldValue.serverTimestamp()
            });
            return { apt: a.apt, aptId, amountKop: a.amountKop, ledgerId: ref.id };
        });
    }

    async function audit(actor, role, action, target, summary, details = {}) {
        await db.collection('audit_log').add({
            actor, role, action, target, summary: String(summary).slice(0, 300),
            details: JSON.parse(JSON.stringify(details)), at: FieldValue.serverTimestamp()
        });
    }

    // --------------------------------------------------------
    // ЗБЕРЕЖЕННЯ ОПЕРАЦІЙ ВИПИСКИ
    // --------------------------------------------------------
    /**
     * Нові операції (вже нормалізовані privat.js або імпортом файлу):
     * класифікує, рознесені пише в історію квартир. Наявні не чіпає —
     * повторна синхронізація того самого дня нічого не дублює.
     */
    async function storeTransactions(list, source, ctx) {
        const fresh = list.filter(t => t && t.bankId && Number.isInteger(t.amountKop) && t.amountKop > 0);
        if (!fresh.length) return { added: 0, matched: 0 };
        const ids = fresh.map(t => core.safeId(`${t.account}_${t.bankId}`));
        const existing = new Set();
        const touched = new Set();
        for (let i = 0; i < ids.length; i += 300) {
            const refs = ids.slice(i, i + 300).map(id => db.doc(`bank_tx/${id}`));
            (await db.getAll(...refs)).forEach(s => {
                if (s.exists && !(s.data().reason === 'closed-period' && s.data().status === 'review' && !s.data().resolvedBy)) existing.add(s.id);
                for (const a of s.data()?.allocations || []) if (a.ledgerId) touched.add(a.aptId || ctx.known.ids?.get(a.apt) || a.apt);
            });
        }
        let added = 0, matched = 0;
        for (let i = 0; i < fresh.length; i++) {
            const id = ids[i];
            if (existing.has(id)) continue;
            const raw = fresh[i];
            if ((raw.currency && raw.currency !== 'UAH') || !['in', 'out'].includes(raw.direction)) continue;
            const ref = db.doc(`bank_tx/${id}`);
            const saved = await db.runTransaction(async t => {
                const previous = await t.get(ref);
                if (previous.exists && !(previous.data().reason === 'closed-period' && previous.data().status === 'review' && !previous.data().resolvedBy)) return null;
                const at = Timestamp.fromDate(raw.at);
                const period = core.periodOf(raw.at);
                const closed = ['closed', 'closing'].includes((await t.get(db.doc(`journal_periods/${period}`))).data()?.status);
                if (previous.exists && closed) return null;
                let decision = core.classify(raw, ctx);
                if (decision.status === 'matched') {
                    const apartment = await t.get(db.doc(`apartments/${ctx.known.ids?.get(decision.apt) || decision.apt}`));
                    if (!apartment.exists || apartment.data().isAdmin === true) decision = { status: 'review', reason: 'missing-apartment', suggestions: [] };
                }
                const candidates = raw.direction === 'out' ? (ctx.sentPayments || []).filter(p => matchesPayment(raw, p)) : [];
                let paid = candidates.length === 1 ? candidates[0] : null;
                if (paid) {
                    const p = await t.get(db.doc(`payments/${paid.id}`));
                    if (!p.exists || !matchesPayment(raw, { ...p.data(), sentAt: p.data().sentAt?.toDate?.() || p.data().createdAt?.toDate?.() })) paid = null;
                }
                const byDoc = raw.direction === 'out' && !paid ? matchExpense(raw, ctx.openExpenses || [], ctx.suppliers || []) : null;
                const expenseId = paid?.expenseId || byDoc?.auto;
                const expenseSnap = expenseId ? await t.get(db.doc(`expenses/${expenseId}`)) : null;
                const expense = expenseSnap?.exists ? { id: expenseSnap.id, ...expenseSnap.data() } : null;
                const canSettle = !closed && expenses && expense?.status === 'approved' && raw.amountKop <= expense.amountKop - (expense.paidKop || 0);
                const doc = {
                    bankId: String(raw.bankId), account: raw.account, at, period,
                    direction: raw.direction, amountKop: raw.amountKop, currency: 'UAH',
                    purpose: String(raw.purpose || '').slice(0, 500),
                    counterparty: { name: String(raw.counterparty?.name || '').slice(0, 200), account: core.normIban(raw.counterparty?.account).slice(0, 40), code: String(raw.counterparty?.code || '').slice(0, 20) },
                    payerKey: core.payerKey(raw.counterparty?.name, raw.counterparty?.account),
                    suggestions: decision.suggestions || [], allocations: [], source, auto: true, importedAt: FieldValue.serverTimestamp()
                };
                const beforeStart = period < ctx.startDate.slice(0, 7) || raw.at < new Date(`${ctx.startDate}T00:00:00+03:00`);
                if (closed) {
                    Object.assign(doc, { kind: raw.direction === 'in' ? 'payment' : 'expense', status: 'review', reason: 'closed-period' });
                    if (decision.apt) doc.suggestions = [{ apt: decision.apt, reason: 'призначення' }];
                } else if (decision.status === 'matched') {
                    Object.assign(doc, { kind: 'payment', status: 'done', method: decision.method });
                    doc.allocations = beforeStart ? [{ apt: decision.apt, amountKop: raw.amountKop, ledgerId: null }]
                        : writeAllocations(t, id, doc, [{ apt: decision.apt, amountKop: raw.amountKop }], ctx);
                } else if (decision.status === 'internal') {
                    Object.assign(doc, { kind: 'internal', status: 'done' });
                } else if (paid) {
                    Object.assign(doc, { kind: 'expense', category: paid.kind === 'tax' ? (core.isEsv(raw.purpose) ? 'esv' : 'taxes') : paid.kind === 'salary' ? 'salary' : 'supplier', status: 'done', paymentId: paid.id });
                    t.update(db.doc(`payments/${paid.id}`), { status: 'paid', paidAt: at, txId: id });
                } else if (byDoc?.auto && canSettle) {
                    Object.assign(doc, { kind: 'expense', category: 'supplier', status: 'done', method: 'document' });
                } else if (decision.status === 'expense') {
                    Object.assign(doc, { kind: 'expense', category: decision.category || null, status: decision.category ? 'done' : 'review' });
                } else if (decision.status === 'other') {
                    Object.assign(doc, { kind: 'income', category: decision.category || null, status: decision.category ? 'done' : 'review', ...(decision.relatedApt ? { relatedApt: decision.relatedApt } : {}) });
                } else {
                    Object.assign(doc, { kind: 'payment', status: beforeStart ? 'done' : 'review', reason: decision.reason || null });
                }
                if (canSettle && doc.kind === 'expense' && doc.status === 'done') {
                    t.update(expenseSnap.ref, expenses.linkUpdate(expense, id, raw.amountKop));
                    doc.expenseId = expense.id;
                }
                if (byDoc?.suggestions.length && !doc.expenseId) doc.expenseSuggestions = byDoc.suggestions;
                if (previous.exists) t.set(ref, doc); else t.create(ref, doc);
                return { ...doc, newDocument: !previous.exists };
            });
            if (!saved) continue;
            existing.add(id);
            if (saved.newDocument) added++;
            if (saved.allocations.some(a => a.ledgerId)) { matched++; saved.allocations.forEach(a => touched.add(a.aptId || a.apt)); }
            if (saved.paymentId) ctx.sentPayments = ctx.sentPayments.filter(p => p.id !== saved.paymentId);
            if (saved.expenseId) {
                const e = ctx.openExpenses.find(e => e.id === saved.expenseId);
                if (e) { e.paidKop = (e.paidKop || 0) + raw.amountKop; if (e.paidKop >= e.amountKop) ctx.openExpenses = ctx.openExpenses.filter(x => x.id !== e.id); }
            }
        }
        await recompute([...touched]);
        return { added, matched };
    }

    // --------------------------------------------------------
    // СИНХРОНІЗАЦІЯ З ПРИВАТБАНКОМ
    // --------------------------------------------------------
    async function sync(trigger) {
        const secret = await secretRef.get();
        if (!secret.exists || !secret.data().token) return { skipped: true, added: 0 };
        const token = secret.data().token;
        try {
            if (!await privat.isReady(token)) {
                // Нічний регламент банку — спробуємо наступної години.
                await settingsRef.set({ lastSync: { at: FieldValue.serverTimestamp(), ok: true, added: 0, waiting: true, trigger } }, { merge: true });
                return { added: 0, waiting: true };
            }
            const balances = await privat.fetchBalances(token);
            const ctx = await loadContext();
            const accounts = { ...(ctx.settings.accounts || {}) };
            for (const b of balances) {
                accounts[b.iban] = {
                    ...(accounts[b.iban] || { purpose: 'current' }),
                    currency: b.currency, balanceKop: b.balanceKop, balanceAt: Timestamp.fromDate(b.at || new Date()),
                    name: b.name || accounts[b.iban]?.name || ''
                };
            }
            ctx.ownAccounts = new Set(Object.keys(accounts).map(core.normIban));
            const last = ctx.settings.lastSync?.ok && ctx.settings.syncedTo ? ctx.settings.syncedTo : ctx.startDate;
            const from = new Date(`${last}T00:00:00+03:00`);
            from.setDate(from.getDate() - OVERLAP_DAYS);
            const start = new Date(`${ctx.startDate}T00:00:00+03:00`);
            const since = from < start ? start : from;
            let added = 0, matched = 0;
            for (const iban of Object.keys(accounts)) {
                const list = await privat.fetchTransactions(token, { iban, from: since, to: new Date() });
                const r = await storeTransactions(list, 'privat', ctx);
                added += r.added;
                matched += r.matched;
            }
            const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Kyiv' }).format(new Date());
            await settingsRef.set({
                accounts, syncedTo: today,
                lastSync: { at: FieldValue.serverTimestamp(), ok: true, added, matched, trigger }
            }, { merge: true });
            return { added, matched };
        } catch (error) {
            logger.error('Синхронізація з ПриватБанком', error);
            await settingsRef.set({
                lastSync: { at: FieldValue.serverTimestamp(), ok: false, error: String(error.message || error).slice(0, 300), trigger }
            }, { merge: true });
            throw error;
        }
    }

    // --------------------------------------------------------
    // ДІЇ БУХГАЛТЕРА Й ГОЛОВИ
    // --------------------------------------------------------
    const fail = (code, message) => { throw new HttpsError(code, message); };

    async function assign(actor, role, { txId, allocations, remember }) {
        if (!core.safeId(txId) || core.safeId(txId) !== txId) fail('invalid-argument', 'Невідома операція');
        const ctx = await loadContext();
        const ref = db.doc(`bank_tx/${txId}`);
        await lock?.assertOpen((await ref.get()).data()?.period, 'Операція банку');
        const closed = new Set(await lock?.closed() || []);
        const result = await db.runTransaction(async t => {
            const snap = await t.get(ref);
            if (!snap.exists) fail('not-found', 'Операцію не знайдено');
            const tx = snap.data();
            await lock?.assertOpen(tx.period, 'Операція банку', t);
            if (tx.direction !== 'in') fail('failed-precondition', 'Рознести можна лише надходження');
            if (tx.status !== 'review') fail('failed-precondition', 'Операцію вже розібрано. Спершу поверніть її в «Розібрати».');
            const list = (allocations || []).map(a => ({ apt: core.cleanApt(a?.apt), amountKop: Number(a?.amountKop) }));
            const error = core.checkAllocations(list, tx.amountKop, ctx.known.apts);
            if (error) fail('invalid-argument', error);
            const apartments = await Promise.all(list.map(a => t.get(db.doc(`apartments/${ctx.known.ids?.get(a.apt) || a.apt}`))));
            if (apartments.some(a => !a.exists || a.data().isAdmin === true)) fail('failed-precondition', 'Довідник квартир змінився. Перегляньте рознос ще раз.');
            const batch = { set: (r, d) => t.set(r, d) };
            const written = writeAllocations(batch, txId, tx, list, ctx);
            t.update(ref, {
                kind: 'payment', status: 'done', method: 'manual', auto: false, allocations: written,
                category: null, resolvedBy: actor, resolvedAt: FieldValue.serverTimestamp()
            });
            if (remember && list.length === 1 && tx.payerKey) {
                t.set(db.doc(`bank_links/${tx.payerKey}`), {
                    apt: list[0].apt, name: tx.counterparty?.name || '', account: tx.counterparty?.account || '',
                    by: actor, at: FieldValue.serverTimestamp()
                });
            }
            return { tx, list };
        });
        await audit(actor, role, 'bank.assign', `bank_tx/${txId}`,
            `${core.fromKop(result.tx.amountKop)} грн → кв. ${result.list.map(a => a.apt).join(', ')}`,
            { allocations: result.list, payer: result.tx.counterparty?.name || '', remember: Boolean(remember) });

        // Запамʼятали платника — його інші платежі в черзі розносимо одразу.
        let alsoMatched = 0;
        const touched = new Set(result.list.map(a => ctx.known.ids?.get(a.apt) || a.apt));
        if (remember && result.list.length === 1 && result.tx.payerKey) {
            const others = await db.collection('bank_tx').where('payerKey', '==', result.tx.payerKey).where('status', '==', 'review').get();
            for (const other of others.docs) {
                if (other.data().direction !== 'in' || closed.has(other.data().period)) continue;
                const decision = core.classify(other.data(), { ...ctx, links: new Map([[result.tx.payerKey, result.list[0].apt]]) });
                if (decision.status !== 'matched') continue;
                const assigned = await db.runTransaction(async t => {
                    const snap = await t.get(other.ref);
                    if (!snap.exists || snap.data().status !== 'review' || snap.data().direction !== 'in') return false;
                    await lock?.assertOpen(snap.data().period, 'Операція банку', t);
                    const apartment = await t.get(db.doc(`apartments/${ctx.known.ids?.get(decision.apt) || decision.apt}`));
                    if (!apartment.exists || apartment.data().isAdmin === true) return false;
                    const written = writeAllocations(t, other.id, snap.data(), [{ apt: decision.apt, amountKop: snap.data().amountKop }], ctx);
                    t.update(other.ref, { kind: 'payment', status: 'done', method: decision.method, allocations: written, auto: true });
                    return true;
                });
                if (assigned) { touched.add(ctx.known.ids?.get(decision.apt) || decision.apt); alsoMatched++; }
            }
        }
        await recompute([...touched]);
        return { ok: true, alsoMatched };
    }

    async function classifyTx(actor, role, { txId, kind, category }) {
        if (!['income', 'expense', 'internal'].includes(kind)) fail('invalid-argument', 'Невідомий вид операції');
        const allowed = kind === 'income' ? INCOME : kind === 'expense' ? EXPENSE : [null, undefined];
        if (!allowed.includes(category)) fail('invalid-argument', 'Невідома категорія');
        const ref = db.doc(`bank_tx/${core.safeId(txId)}`);
        await lock?.assertOpen((await ref.get()).data()?.period, 'Операція банку');
        const tx = await db.runTransaction(async t => {
            const snap = await t.get(ref);
            if (!snap.exists) fail('not-found', 'Операцію не знайдено');
            const data = snap.data();
            await lock?.assertOpen(data.period, 'Операція банку', t);
            if (data.expenseId || data.paymentId) fail('failed-precondition', 'Операцію привʼязано до документа або платежу. Спершу поверніть її у «Вхідні».');
            if ((data.allocations || []).some(a => a.ledgerId)) fail('failed-precondition', 'Спершу поверніть оплату в «Розібрати»');
            if (kind === 'income' && data.direction !== 'in') fail('invalid-argument', 'Це списання, а не надходження');
            if (kind === 'expense' && data.direction !== 'out') fail('invalid-argument', 'Це надходження, а не витрата');
            t.update(ref, { kind, category: category || null, status: 'done', auto: false, resolvedBy: actor, resolvedAt: FieldValue.serverTimestamp() });
            return data;
        });
        await audit(actor, role, 'bank.classify', `bank_tx/${ref.id}`,
            `${core.fromKop(tx.amountKop)} грн: ${kind}${category ? ` / ${category}` : ''}`, { kind, category: category || null });
        return { ok: true };
    }

    /**
     * Надходження — повернення раніше списаних коштів. Залишок, який ще
     * можна повернути, — сума списання мінус уже повернене. Якщо банк
     * повернув оплату документа, документ знову чекає оплати; зарплатний
     * платіж позначаємо поверненим — його можна відправити знову.
     */
    async function refund(actor, role, { txId, refundOf, reason }) {
        if (!REFUND_REASONS[reason]) fail('invalid-argument', 'Оберіть, що це за повернення');
        const ref = db.doc(`bank_tx/${core.safeId(txId)}`), origRef = db.doc(`bank_tx/${core.safeId(refundOf)}`);
        await lock?.assertOpen((await ref.get()).data()?.period, 'Операція банку');
        const result = await db.runTransaction(async t => {
            const [snap, osnap] = await Promise.all([t.get(ref), t.get(origRef)]);
            if (!snap.exists || !osnap.exists) fail('not-found', 'Операцію не знайдено');
            const tx = snap.data(), o = osnap.data();
            await lock?.assertOpen(tx.period, 'Операція банку', t);
            if (tx.direction !== 'in') fail('invalid-argument', 'Повернення — це надходження');
            if (tx.status !== 'review' || (tx.allocations || []).some(a => a.ledgerId)) fail('failed-precondition', 'Операцію вже розібрано. Спершу поверніть її у «Вхідні».');
            if (o.direction !== 'out' || o.status !== 'done' || o.kind === 'internal') fail('failed-precondition', 'Повернути можна лише розібране списання ОСББ');
            const left = o.amountKop - (o.refundedKop || 0);
            if (tx.amountKop > left) fail('invalid-argument', `Повернення ${core.fromKop(tx.amountKop)} грн більше за неповернений залишок списання ${core.fromKop(left)} грн`);
            const exRef = o.expenseId ? db.doc(`expenses/${o.expenseId}`) : null;
            const payRef = o.paymentId ? db.doc(`payments/${o.paymentId}`) : null;
            const [ex, pay] = await Promise.all([exRef ? t.get(exRef) : null, payRef ? t.get(payRef) : null]);
            t.update(ref, { kind: 'refund', category: 'refund', status: 'done', refundOf: origRef.id, refundReason: reason, auto: false, resolvedBy: actor, resolvedAt: FieldValue.serverTimestamp() });
            t.update(origRef, { refundedKop: (o.refundedKop || 0) + tx.amountKop, refundTxIds: FieldValue.arrayUnion(ref.id) });
            if (reason === 'bounce' && ex?.exists) {
                t.update(exRef, { paidKop: Math.max(0, (ex.data().paidKop || 0) - tx.amountKop), status: 'approved', paidAt: null, refundTxIds: FieldValue.arrayUnion(ref.id) });
            }
            if (reason === 'bounce' && pay?.exists) t.update(payRef, { returnedKop: (pay.data().returnedKop || 0) + tx.amountKop, returnTxIds: FieldValue.arrayUnion(ref.id) });
            return { tx, o, payroll: pay?.data()?.payroll || null };
        });
        await audit(actor, role, 'bank.refund', `bank_tx/${ref.id}`,
            `${core.fromKop(result.tx.amountKop)} грн — повернення списання ${core.fromKop(result.o.amountKop)} грн (${result.o.counterparty?.name || ''}): ${REFUND_REASONS[reason]}`,
            { refundOf: origRef.id, reason, payroll: result.payroll });
        return { ok: true, payroll: result.payroll };
    }

    /** Списання, які могло повернути це надходження: той самий контрагент і сума, за пів року. */
    async function refundCandidates({ txId }) {
        const snap = await db.doc(`bank_tx/${core.safeId(txId)}`).get();
        if (!snap.exists) fail('not-found', 'Операцію не знайдено');
        const tx = snap.data();
        const since = new Date(Date.parse(`${tx.period}-01T00:00:00Z`) - 183 * 86400000).toISOString().slice(0, 7);
        const list = (await db.collection('bank_tx').where('period', '>=', since).get()).docs
            .map(d => ({ id: d.id, ...d.data() }))
            .filter(o => o.direction === 'out' && o.status === 'done' && o.kind !== 'internal' && o.amountKop - (o.refundedKop || 0) >= tx.amountKop);
        const iban = core.normIban(tx.counterparty?.account), code = String(tx.counterparty?.code || '');
        const name = core.normText(tx.counterparty?.name || '');
        const score = o => (iban && core.normIban(o.counterparty?.account) === iban ? 4 : 0) + (code && o.counterparty?.code === code ? 3 : 0)
            + (name && core.normText(o.counterparty?.name || '') === name ? 2 : 0) + (o.amountKop === tx.amountKop ? 2 : 0);
        return list.map(o => ({ id: o.id, at: o.at?.toDate?.()?.toISOString() || null, name: o.counterparty?.name || '', purpose: String(o.purpose || '').slice(0, 120),
            amountKop: o.amountKop, refundedKop: o.refundedKop || 0, expense: Boolean(o.expenseId), payroll: Boolean(o.paymentId), score: score(o) }))
            .filter(o => o.score > 0).sort((a, b) => b.score - a.score || String(b.at).localeCompare(String(a.at))).slice(0, 8);
    }

    /** Списання — повернення переплати співвласнику: запис «Повернення» в історії квартири (Дт 377 Кт 311). */
    async function refundResident(actor, role, { txId, apt }) {
        const ctx = await loadContext();
        const clean = core.cleanApt(apt);
        if (!ctx.known.apts.has(clean)) fail('invalid-argument', `Приміщення ${clean || '—'} немає в довіднику`);
        const aptId = ctx.known.ids?.get(clean) || clean;
        const ref = db.doc(`bank_tx/${core.safeId(txId)}`);
        await lock?.assertOpen((await ref.get()).data()?.period, 'Операція банку');
        const tx = await db.runTransaction(async t => {
            const [snap, aptSnap] = await Promise.all([t.get(ref), t.get(db.doc(`apartments/${aptId}`))]);
            if (!snap.exists) fail('not-found', 'Операцію не знайдено');
            if (!aptSnap.exists) fail('failed-precondition', 'Приміщення видалено з довідника');
            const data = snap.data();
            await lock?.assertOpen(data.period, 'Операція банку', t);
            if (data.direction !== 'out') fail('invalid-argument', 'Повернення співвласнику — це списання');
            if (data.status !== 'review' || data.expenseId || data.paymentId) fail('failed-precondition', 'Операцію вже розібрано. Спершу поверніть її у «Вхідні».');
            const overpaid = Math.round(Number(aptSnap.data().balance || 0) * 100);
            if (data.amountKop > overpaid) fail('failed-precondition', `Переплата прим. ${clean} — ${core.fromKop(Math.max(0, overpaid))} грн: повернути більше не можна`);
            const ledger = db.doc(`apartments/${aptId}/ledger/refund-${ref.id}`);
            t.set(ledger, { at: data.at, period: data.period, kind: 'refund', amount: core.fromKop(data.amountKop), amountKop: data.amountKop,
                note: 'Повернення переплати на рахунок співвласника', source: 'bank', txId: ref.id, createdAt: FieldValue.serverTimestamp() });
            t.update(ref, { kind: 'expense', category: 'resident_refund', status: 'done', allocations: [{ apt: clean, aptId, amountKop: data.amountKop, ledgerId: ledger.id }],
                auto: false, resolvedBy: actor, resolvedAt: FieldValue.serverTimestamp() });
            return data;
        });
        await audit(actor, role, 'bank.refundResident', `bank_tx/${ref.id}`, `${core.fromKop(tx.amountKop)} грн — повернення переплати, прим. ${clean}`, { apt: clean });
        await recompute([aptId]);
        return { ok: true };
    }

    async function unassign(actor, role, { txId }) {
        const ref = db.doc(`bank_tx/${core.safeId(txId)}`);
        await lock?.assertOpen((await ref.get()).data()?.period, 'Операція банку');
        const tx = await db.runTransaction(async t => {
            const snap = await t.get(ref);
            if (!snap.exists) fail('not-found', 'Операцію не знайдено');
            const data = snap.data();
            await lock?.assertOpen(data.period, 'Операція банку', t);
            const expenseRef = data.expenseId ? db.doc(`expenses/${data.expenseId}`) : null;
            const expense = expenseRef ? await t.get(expenseRef) : null;
            const payment = data.paymentId ? await t.get(db.doc(`payments/${data.paymentId}`)) : null;
            if (payment?.data()?.payroll) fail('failed-precondition', 'Проведений платіж за відомістю зарплати не можна рознести як іншу витрату');
            if ((data.refundTxIds || []).length) fail('failed-precondition', 'До цього списання привʼязано повернення — спершу поверніть у «Вхідні» його');
            // Повернення списаного: знімаємо привʼязку з оригіналу, документа й платежу.
            const origRef = data.kind === 'refund' && data.refundOf ? db.doc(`bank_tx/${data.refundOf}`) : null;
            const orig = origRef ? await t.get(origRef) : null;
            const origEx = orig?.data()?.expenseId && data.refundReason === 'bounce' ? await t.get(db.doc(`expenses/${orig.data().expenseId}`)) : null;
            const origPay = orig?.data()?.paymentId && data.refundReason === 'bounce' ? await t.get(db.doc(`payments/${orig.data().paymentId}`)) : null;
            if (origPay?.data()?.payroll && (origPay.data().repaidBy || []).length) fail('failed-precondition', 'Повернену зарплату вже відправлено знову — це повернення не знімається');
            if (orig?.exists) t.update(origRef, { refundedKop: Math.max(0, (orig.data().refundedKop || 0) - data.amountKop), refundTxIds: FieldValue.arrayRemove(ref.id) });
            if (origEx?.exists) {
                const paid = (origEx.data().paidKop || 0) + data.amountKop;
                const due = origEx.data().amountKop - (origEx.data().stornoKop || 0);
                t.update(origEx.ref, { paidKop: paid, status: paid >= due ? 'paid' : 'approved', refundTxIds: FieldValue.arrayRemove(ref.id) });
            }
            if (origPay?.exists) t.update(origPay.ref, { returnedKop: Math.max(0, (origPay.data().returnedKop || 0) - data.amountKop), returnTxIds: FieldValue.arrayRemove(ref.id) });
            if (data.status !== 'done' || data.kind === 'internal') fail('failed-precondition', 'Цю операцію не можна повернути');
            if (expense?.exists && (expense.data().txIds || []).includes(ref.id)) {
                t.update(expenseRef, { paidKop: Math.max(0, (expense.data().paidKop || 0) - data.amountKop), txIds: FieldValue.arrayRemove(ref.id), status: 'approved', paidAt: null });
            }
            for (const a of data.allocations || []) {
                if (a.ledgerId) t.delete(db.doc(`apartments/${a.aptId || a.apt}/ledger/${a.ledgerId}`));
            }
            t.update(ref, {
                kind: data.direction === 'in' ? 'payment' : 'expense', status: 'review', allocations: [],
                category: null, method: null, expenseId: null, paymentId: null, refundOf: null, refundReason: null, auto: false, resolvedBy: actor, resolvedAt: FieldValue.serverTimestamp()
            });
            return data;
        });
        await audit(actor, role, 'bank.unassign', `bank_tx/${ref.id}`,
            `${core.fromKop(tx.amountKop)} грн повернуто в «Розібрати»`, { was: tx.allocations || [], category: tx.category || null });
        await recompute((tx.allocations || []).filter(a => a.ledgerId).map(a => a.aptId || a.apt));
        return { ok: true };
    }

    async function saveToken(actor, role, { token }) {
        const value = String(token || '').trim();
        if (value.length < 20 || value.length > 1000 || /\s/.test(value)) fail('invalid-argument', 'Це не схоже на токен Автоклієнта');
        let balances;
        try {
            balances = await privat.fetchBalances(value);
        } catch (error) {
            fail('failed-precondition', `Банк не прийняв токен: ${String(error.message || error).slice(0, 200)}`);
        }
        const current = (await settingsRef.get()).data()?.accounts || {};
        const accounts = { ...current };
        for (const b of balances) {
            accounts[b.iban] = { ...(current[b.iban] || { purpose: 'current' }), currency: b.currency,
                balanceKop: b.balanceKop, balanceAt: Timestamp.fromDate(b.at || new Date()), name: b.name || '' };
        }
        await secretRef.set({ token: value, savedBy: actor, savedAt: FieldValue.serverTimestamp() });
        await settingsRef.set({
            tokenSet: true, tokenHint: value.slice(-4), tokenSavedBy: actor, tokenSavedAt: FieldValue.serverTimestamp(),
            accounts, startDate: (await settingsRef.get()).data()?.startDate || DEFAULT_START
        }, { merge: true });
        await audit(actor, role, 'bank.connect', 'bank/settings', `ПриватБанк підключено, рахунків: ${balances.length}`, { accounts: balances.length });
        return { accounts: balances.length };
    }

    async function removeToken(actor, role) {
        await secretRef.delete();
        await settingsRef.set({ tokenSet: false, tokenHint: FieldValue.delete() }, { merge: true });
        await audit(actor, role, 'bank.disconnect', 'bank/settings', 'ПриватБанк відключено');
        return { ok: true };
    }

    async function setAccount(actor, role, { iban, purpose }) {
        const key = core.normIban(iban);
        if (!PURPOSES.includes(purpose)) fail('invalid-argument', 'Невідоме призначення рахунку');
        const settings = (await settingsRef.get()).data() || {};
        if (!settings.accounts?.[key]) fail('not-found', 'Рахунок не знайдено');
        await settingsRef.update({ [`accounts.${key}.purpose`]: purpose });
        await audit(actor, role, 'bank.account', 'bank/settings', `Рахунок …${key.slice(-4)}: ${purpose}`, { iban: key, purpose });
        return { ok: true };
    }

    const bankAction = onCall({ region: REGION, maxInstances: 4, timeoutSeconds: 120 }, callGuard('bankAction', async request => {
        const actor = await requireAdmin(request, ['chair', 'accountant']);
        const role = await staffRole(actor);
        const data = request.data || {};
        switch (data.action) {
            case 'assign': return assign(actor, role, data);
            case 'classify': return classifyTx(actor, role, data);
            case 'unassign': return unassign(actor, role, data);
            case 'refund': return refund(actor, role, data);
            case 'refundCandidates': return refundCandidates(data);
            case 'refundResident': return refundResident(actor, role, data);
            case 'saveToken': return saveToken(actor, role, data);
            case 'removeToken': return removeToken(actor, role);
            case 'setAccount': return setAccount(actor, role, data);
            case 'sync':
                try { return await sync(`manual:${actor}`); }
                catch (error) { fail('unavailable', `Банк не відповів: ${String(error.message || error).slice(0, 200)}`); }
                break;
            default: fail('invalid-argument', 'Невідома дія');
        }
    }));

    // Щогодини: оплати зʼявляються в історії квартир без участі людини.
    const syncBank = onSchedule(
        { schedule: 'every 60 minutes', timeZone: 'Europe/Kyiv', region: REGION, maxInstances: 1, timeoutSeconds: 300 },
        async () => { await sync('schedule'); }
    );

    // Для інтеграційних тестів на емуляторі (tests/rules/bank-server.test.mjs).
    return { bankAction, syncBank, storeTransactions, loadContext, actions: { assign, classifyTx, unassign, refund, refundResident } };
};
