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
// Облік у застосунку починається з початку IV кварталу 2026 року:
// раніші операції лишаються в сервісі бухгалтера.
const DEFAULT_START = '2026-10-01';
// Банк може дооформити операцію заднім числом — перечитуємо кілька днів.
const OVERLAP_DAYS = 3;

module.exports = function bankFunctions({ db, FieldValue, Timestamp, requireAdmin, staffRole, balances, expenses, lock }) {
    // Баланс квартири з історії (charges.js): після кожної рознесеної оплати.
    const recompute = apts => (apts.length && balances ? balances.recompute(apts) : null);

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
            db.collection('payments').where('status', '==', 'sent').get()
        ]);
        const known = { apts: new Set(), accounts: new Map() };
        apts.forEach(d => {
            if (d.data().isAdmin === true) return;
            const apt = core.cleanApt(d.id);
            known.apts.add(apt);
            const account = String(d.data().personalAccount || '').trim();
            if (account) { known.accounts.set(account, apt); known.accounts.set(core.accountKey(account), apt); }
        });
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
            sentPayments: sent.docs.map(d => ({ id: d.id, ...d.data(), sentAt: d.data().sentAt?.toDate?.() || new Date(0) }))
        };
    }

    const ledgerRef = (apt, txId, index) => db.doc(`apartments/${apt}/ledger/bank-${txId}${index ? `-${index}` : ''}`);

    /** Записи «Оплата» в історії квартир — тим самим батчем, що й операція. */
    function writeAllocations(batch, txId, tx, allocations) {
        return allocations.map((a, index) => {
            const ref = ledgerRef(a.apt, txId, index);
            batch.set(ref, {
                at: tx.at, period: tx.period, kind: 'payment', amount: core.fromKop(a.amountKop),
                // Розділений платіж: призначення чужого платника іншим квартирам не показуємо.
                note: allocations.length > 1 ? 'Частина спільного платежу' : String(tx.purpose || '').slice(0, 200),
                source: 'bank', txId,
                createdAt: FieldValue.serverTimestamp()
            });
            return { apt: a.apt, amountKop: a.amountKop, ledgerId: ref.id };
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
        for (let i = 0; i < ids.length; i += 300) {
            const refs = ids.slice(i, i + 300).map(id => db.doc(`bank_tx/${id}`));
            (await db.getAll(...refs)).forEach(s => { if (s.exists) existing.add(s.id); });
        }
        let added = 0, matched = 0;
        const touched = new Set();
        let batch = db.batch(), ops = 0;
        const flush = async () => { if (ops) await batch.commit(); batch = db.batch(); ops = 0; };
        for (let i = 0; i < fresh.length; i++) {
            const id = ids[i];
            if (existing.has(id)) continue;
            existing.add(id);
            const t = fresh[i];
            const at = Timestamp.fromDate(t.at);
            const decision = core.classify(t, ctx);
            const paid = t.direction === 'out' ? (ctx.sentPayments || []).find(p => matchesPayment(t, p)) : null;
            const byDoc = t.direction === 'out' && !paid ? matchExpense(t, ctx.openExpenses || [], ctx.suppliers || []) : null;
            /** Привʼязати списання до документа витрат тим самим батчем. */
            const settle = expenseId => {
                const e = (ctx.openExpenses || []).find(x => x.id === expenseId);
                if (!e || !expenses) return false;
                batch.update(db.doc(`expenses/${e.id}`), expenses.linkUpdate(e, id, t.amountKop));
                e.paidKop = (e.paidKop || 0) + t.amountKop;
                if (e.paidKop >= e.amountKop) ctx.openExpenses = ctx.openExpenses.filter(x => x.id !== e.id);
                ops += 1;
                return true;
            };
            const doc = {
                bankId: String(t.bankId), account: t.account, at, period: core.periodOf(t.at),
                direction: t.direction, amountKop: t.amountKop, currency: t.currency || 'UAH',
                purpose: String(t.purpose || '').slice(0, 500),
                counterparty: {
                    name: String(t.counterparty?.name || '').slice(0, 200),
                    account: core.normIban(t.counterparty?.account).slice(0, 40),
                    code: String(t.counterparty?.code || '').slice(0, 20)
                },
                payerKey: core.payerKey(t.counterparty?.name, t.counterparty?.account),
                suggestions: decision.suggestions || [], allocations: [], source, auto: true,
                importedAt: FieldValue.serverTimestamp()
            };
            const beforeStart = core.periodOf(t.at) < ctx.startDate.slice(0, 7)
                || t.at < new Date(`${ctx.startDate}T00:00:00+03:00`);
            if (decision.status === 'matched') {
                doc.kind = 'payment';
                doc.method = decision.method;
                if (beforeStart) {
                    // До початку обліку — лише показуємо, історію квартири не чіпаємо.
                    doc.status = 'done';
                    doc.allocations = [{ apt: decision.apt, amountKop: t.amountKop, ledgerId: null }];
                } else {
                    doc.status = 'done';
                    doc.allocations = writeAllocations(batch, id, doc, [{ apt: decision.apt, amountKop: t.amountKop }]);
                    touched.add(decision.apt);
                    ops += 1;
                    matched += 1;
                }
            } else if (decision.status === 'internal') {
                Object.assign(doc, { kind: 'internal', status: 'done' });
            } else if (paid) {
                // Наш платіж через API: голова підписав, банк провів.
                Object.assign(doc, { kind: 'expense', category: paid.kind === 'tax' ? (core.isEsv(t.purpose) ? 'esv' : 'taxes') : paid.kind === 'salary' ? 'salary' : 'supplier',
                    status: 'done', paymentId: paid.id });
                batch.update(db.doc(`payments/${paid.id}`), { status: 'paid', paidAt: at, txId: id });
                if (paid.expenseId && settle(paid.expenseId)) doc.expenseId = paid.expenseId;
                ctx.sentPayments = ctx.sentPayments.filter(p => p.id !== paid.id);
                ops += 1;
            } else if (byDoc?.auto && settle(byDoc.auto)) {
                // Постачальник і сума збіглися з затвердженим документом.
                Object.assign(doc, { kind: 'expense', category: 'supplier', status: 'done', expenseId: byDoc.auto, method: 'document' });
            } else if (decision.status === 'expense') {
                Object.assign(doc, { kind: 'expense', category: decision.category || null, status: decision.category ? 'done' : 'review' });
            } else if (decision.status === 'other') {
                Object.assign(doc, { kind: 'income', category: decision.category || null, status: decision.category ? 'done' : 'review',
                    ...(decision.relatedApt ? { relatedApt: decision.relatedApt } : {}) });
            } else {
                Object.assign(doc, { kind: 'payment', status: beforeStart ? 'done' : 'review', reason: decision.reason || null });
            }
            if (byDoc?.suggestions.length && !doc.expenseId) doc.expenseSuggestions = byDoc.suggestions;
            batch.set(db.doc(`bank_tx/${id}`), doc);
            ops += 1;
            added += 1;
            if (ops >= 400) await flush();
        }
        await flush();
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
            if (tx.direction !== 'in') fail('failed-precondition', 'Рознести можна лише надходження');
            if (tx.status !== 'review') fail('failed-precondition', 'Операцію вже розібрано. Спершу поверніть її в «Розібрати».');
            const list = (allocations || []).map(a => ({ apt: core.cleanApt(a?.apt), amountKop: Number(a?.amountKop) }));
            const error = core.checkAllocations(list, tx.amountKop, ctx.known.apts);
            if (error) fail('invalid-argument', error);
            const batch = { set: (r, d) => t.set(r, d) };
            const written = writeAllocations(batch, txId, tx, list);
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
        const touched = new Set(result.list.map(a => a.apt));
        if (remember && result.list.length === 1 && result.tx.payerKey) {
            const others = await db.collection('bank_tx').where('payerKey', '==', result.tx.payerKey).where('status', '==', 'review').get();
            for (const other of others.docs) {
                if (other.data().direction !== 'in' || closed.has(other.data().period)) continue;
                const decision = core.classify(other.data(), { ...ctx, links: new Map([[result.tx.payerKey, result.list[0].apt]]) });
                if (decision.status !== 'matched') continue;
                const batch = db.batch();
                const written = writeAllocations(batch, other.id, other.data(), [{ apt: decision.apt, amountKop: other.data().amountKop }]);
                batch.update(other.ref, { kind: 'payment', status: 'done', method: decision.method, allocations: written, auto: true });
                await batch.commit();
                touched.add(decision.apt);
                alsoMatched += 1;
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

    async function unassign(actor, role, { txId }) {
        const ref = db.doc(`bank_tx/${core.safeId(txId)}`);
        await lock?.assertOpen((await ref.get()).data()?.period, 'Операція банку');
        const tx = await db.runTransaction(async t => {
            const snap = await t.get(ref);
            if (!snap.exists) fail('not-found', 'Операцію не знайдено');
            const data = snap.data();
            if (data.status !== 'done' || data.kind === 'internal') fail('failed-precondition', 'Цю операцію не можна повернути');
            for (const a of data.allocations || []) {
                if (a.ledgerId) t.delete(db.doc(`apartments/${a.apt}/ledger/${a.ledgerId}`));
            }
            t.update(ref, {
                kind: data.direction === 'in' ? 'payment' : 'expense', status: 'review', allocations: [],
                category: null, method: null, expenseId: null, auto: false, resolvedBy: actor, resolvedAt: FieldValue.serverTimestamp()
            });
            return data;
        });
        await audit(actor, role, 'bank.unassign', `bank_tx/${ref.id}`,
            `${core.fromKop(tx.amountKop)} грн повернуто в «Розібрати»`, { was: tx.allocations || [], category: tx.category || null });
        await recompute((tx.allocations || []).filter(a => a.ledgerId).map(a => a.apt));
        if (tx.expenseId) await expenses?.release(tx, ref.id);
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

    const bankAction = onCall({ region: REGION, maxInstances: 4, timeoutSeconds: 120 }, async request => {
        const actor = await requireAdmin(request, ['chair', 'accountant']);
        const role = await staffRole(actor);
        const data = request.data || {};
        switch (data.action) {
            case 'assign': return assign(actor, role, data);
            case 'classify': return classifyTx(actor, role, data);
            case 'unassign': return unassign(actor, role, data);
            case 'saveToken': return saveToken(actor, role, data);
            case 'removeToken': return removeToken(actor, role);
            case 'setAccount': return setAccount(actor, role, data);
            case 'sync':
                try { return await sync(`manual:${actor}`); }
                catch (error) { fail('unavailable', `Банк не відповів: ${String(error.message || error).slice(0, 200)}`); }
                break;
            default: fail('invalid-argument', 'Невідома дія');
        }
    });

    // Щогодини: оплати зʼявляються в історії квартир без участі людини.
    const syncBank = onSchedule(
        { schedule: 'every 60 minutes', timeZone: 'Europe/Kyiv', region: REGION, maxInstances: 1, timeoutSeconds: 300 },
        async () => { await sync('schedule'); }
    );

    // Для інтеграційних тестів на емуляторі (tests/rules/bank-server.test.mjs).
    return { bankAction, syncBank, storeTransactions, loadContext, actions: { assign, classifyTx, unassign } };
};
