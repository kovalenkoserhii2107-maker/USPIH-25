'use strict';
// ============================================================
// Вихідні платежі через API ПриватБанку.
//
// Бухгалтер підтверджує платіж (Enter у кабінеті) → сервер перевіряє
// його й створює в Приват24 через API Автоклієнта → платіж чекає
// підпису КЕП голови в Приват24 → щогодинна виписка знаходить
// списання й закриває платіж (bank.js, matchSentPayment).
//
// Гроші без підпису голови не рухаються: так влаштований банк, і
// застосунок цього не обходить.
//
// payments/{id}: { kind, recipient: { name, iban, code }, amountKop, purpose,
//   account, status: sent|failed|paid|canceled, bankRef?, error?, createdBy,
//   createdAt, sentAt?, paidAt?, txId?, proposalKey? }
// ============================================================
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const callGuard = require('./call-guard');
const logger = require('firebase-functions/logger');
const core = require('./payments-core');
const { normIban, fromKop } = require('./bank-core');
const privat = require('./privat');

const REGION = 'europe-central2';
const KINDS = ['supplier', 'tax', 'salary', 'other'];

module.exports = function paymentFunctions({ db, FieldValue, requireAdmin, staffRole, notify }) {
    const fail = (code, message) => { throw new HttpsError(code, message); };

    async function audit(actor, role, action, target, summary, details = {}) {
        await db.collection('audit_log').add({
            actor, role, action, target, summary: String(summary).slice(0, 300),
            details: JSON.parse(JSON.stringify(details)), at: FieldValue.serverTimestamp()
        });
    }

    async function context() {
        const [settings, secret] = await Promise.all([db.doc('bank/settings').get(), db.doc('bank_secrets/privat').get()]);
        const accounts = settings.exists ? settings.data().accounts || {} : {};
        return { ownAccounts: new Set(Object.keys(accounts).map(normIban)), token: secret.exists ? secret.data().token : null };
    }

    /** Платіж підтверджено — перевіряємо й створюємо в банку. */
    async function create(actor, role, data) {
        const payment = {
            kind: KINDS.includes(data.kind) ? data.kind : 'supplier',
            recipient: {
                name: String(data.recipient?.name || '').trim().slice(0, 140),
                iban: normIban(data.recipient?.iban),
                code: String(data.recipient?.code || '').trim()
            },
            amountKop: Number(data.amountKop),
            purpose: String(data.purpose || '').replace(/\s+/g, ' ').trim(),
            account: normIban(data.account)
        };
        const { ownAccounts, token } = await context();
        const error = core.checkPayment(payment, ownAccounts);
        if (error) fail('invalid-argument', error);
        if (!token) fail('failed-precondition', 'Банк не підключено: вставте токен у «Налаштуваннях»');

        // Повторне «Так» на ту саму пропозицію не створює другий платіж.
        const proposalKey = data.proposalKey ? String(data.proposalKey).slice(0, 80) : null;
        // Платіж за документом витрат (expenses.js → pay): виписка закриє й документ.
        payment.expenseId = data.expenseId ? String(data.expenseId).replace(/[^\w-]/g, '').slice(0, 60) : null;
        if (proposalKey) {
            const dup = await db.collection('payments').where('proposalKey', '==', proposalKey).where('status', 'in', ['sent', 'paid']).limit(1).get();
            if (!dup.empty) fail('already-exists', 'Цей платіж уже відправлено в банк');
        }

        const ref = db.collection('payments').doc();
        const docNumber = ref.id.slice(0, 10).toUpperCase();
        await ref.set({ ...payment, status: 'sending', proposalKey, docNumber, createdBy: actor, createdAt: FieldValue.serverTimestamp() });
        try {
            const result = await privat.createPayment(token, { ...payment, docNumber });
            await ref.update({ status: 'sent', bankRef: result.bankRef || null, paymentRef: result.paymentRef || null,
                bankStatus: result.status || null, sentAt: FieldValue.serverTimestamp() });
        } catch (e) {
            logger.error('Створення платежу в ПриватБанку', e);
            await ref.update({ status: 'failed', error: String(e.message || e).slice(0, 300) });
            await audit(actor, role, 'payment.failed', `payments/${ref.id}`, `${payment.recipient.name}: ${fromKop(payment.amountKop)} грн — банк не прийняв`, { error: String(e.message || e).slice(0, 300) });
            fail('unavailable', `Банк не прийняв платіж: ${String(e.message || e).slice(0, 200)}`);
        }
        await audit(actor, role, 'payment.send', `payments/${ref.id}`,
            `${payment.recipient.name}: ${fromKop(payment.amountKop)} грн — у Приват24 на підпис`,
            { recipient: payment.recipient, amountKop: payment.amountKop, purpose: payment.purpose });
        // Голові — сповіщення: у банку чекає підпис.
        await notify?.({ roles: ['chair'], title: 'Платіж чекає вашого підпису',
            body: `${payment.recipient.name}: ${fromKop(payment.amountKop).toLocaleString('uk-UA')} грн. Підпишіть у Приват24 для бізнесу.`, link: 'admin.html' })
            .catch(e => logger.warn('Сповіщення голові', e));
        return { id: ref.id };
    }

    async function cancel(actor, role, { id }) {
        const ref = db.doc(`payments/${String(id || '').replace(/[^\w-]/g, '')}`);
        const snap = await ref.get();
        if (!snap.exists) fail('not-found', 'Платіж не знайдено');
        const p = snap.data();
        if (!['sent', 'failed', 'sending'].includes(p.status)) fail('failed-precondition', 'Цей платіж уже проведено або скасовано');
        let deletedInBank = false;
        if (p.status === 'sent' && p.paymentRef) {
            const { token } = await context();
            try { deletedInBank = token ? await privat.deletePayment(token, p.paymentRef) : false; }
            catch (e) { logger.warn('Видалення платежу в банку', e); }
        }
        await ref.update({ status: 'canceled', canceledBy: actor, canceledAt: FieldValue.serverTimestamp(), deletedInBank });
        await audit(actor, role, 'payment.cancel', `payments/${ref.id}`, `${p.recipient?.name}: ${fromKop(p.amountKop)} грн скасовано`, { deletedInBank });
        return { ok: true, deletedInBank };
    }

    /**
     * Що система пропонує заплатити цього місяця (регулярні отримувачі,
     * яким ще не платили) і довідник отримувачів для форми — з історії
     * списань за пів року. Рахується на сервері: одна логіка для
     * «Платежів» і «Вхідних».
     */
    async function contextFor() {
        const since = new Date();
        since.setMonth(since.getMonth() - 6, 1);
        const [out, list, settings] = await Promise.all([
            db.collection('bank_tx').where('at', '>=', since).orderBy('at', 'desc').limit(2000).get(),
            db.collection('payments').orderBy('createdAt', 'desc').limit(300).get(),
            db.doc('bank/settings').get()
        ]);
        const history = out.docs.map(d => d.data()).filter(t => t.direction === 'out' && t.kind !== 'internal')
            .map(t => ({ ...t, at: t.at.toDate() }));
        const payments = list.docs.map(d => ({ id: d.id, ...d.data(), createdAt: d.data().createdAt?.toDate?.() || null, sentAt: d.data().sentAt?.toDate?.() || null }));
        const now = new Date();
        const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
        const proposals = core.recurringRecipients(history)
            .filter(r => !core.alreadyPaidThisMonth(r, payments, history, now))
            .map(r => ({ ...r, lastAt: r.lastAt.toISOString(), purpose: core.purposeForMonth(r.purpose, now), proposalKey: `${r.key}-${month}` }));
        const recipients = new Map();
        for (const t of history) {
            const iban = normIban(t.counterparty?.account);
            if (!core.validIban(iban) || recipients.has(iban)) continue;
            recipients.set(iban, { name: t.counterparty?.name || '', iban, code: String(t.counterparty?.code || ''), purpose: t.purpose || '', amountKop: t.amountKop });
        }
        const accounts = Object.entries(settings.exists ? settings.data().accounts || {} : {}).map(([iban, a]) => ({ iban, purpose: a.purpose || 'current', balanceKop: a.balanceKop ?? null }));
        return { proposals, recipients: [...recipients.values()], accounts };
    }

    const paymentAction = onCall({ region: REGION, maxInstances: 4, timeoutSeconds: 60 }, callGuard('paymentAction', async request => {
        const actor = await requireAdmin(request, ['chair', 'accountant']);
        const role = await staffRole(actor);
        const data = request.data || {};
        if (data.action === 'create') return create(actor, role, data);
        if (data.action === 'cancel') return cancel(actor, role, data);
        if (data.action === 'context') return contextFor();
        fail('invalid-argument', 'Невідома дія');
    }));

    return { paymentAction, actions: { create, cancel } };
};
