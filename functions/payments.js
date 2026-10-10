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
//   account, status: sending|unknown|sent|failed|paid|canceled, bankRef?, error?, createdBy,
//   createdAt, sentAt?, paidAt?, txId?, proposalKey? }
// ============================================================
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const callGuard = require('./call-guard');
const logger = require('firebase-functions/logger');
const core = require('./payments-core');
const { normIban, fromKop } = require('./bank-core');
const privat = require('./privat');
const { createHash } = require('crypto');

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
        // Платіж за відомістю зарплати (payroll.js): у проводках — погашення 661/641/651.
        if (data.payroll?.period) {
            payment.payroll = { period: String(data.payroll.period).slice(0, 7), stage: data.payroll.stage === 'advance' ? 'advance' : 'final',
                key: String(data.payroll.key || '').replace(/[^\w-]/g, '').slice(0, 60) };
            if (data.payroll.repayOf) Object.assign(payment.payroll, { repayOf: String(data.payroll.repayOf).replace(/[^\w-]/g, '').slice(0, 80), retry: Number(data.payroll.retry) || 1 });
        }
        if (payment.expenseId) {
            const expense = (await db.doc(`expenses/${payment.expenseId}`).get()).data();
            if (!expense || expense.status !== 'approved' || expense.amountKop - (expense.stornoKop || 0) - (expense.paidKop || 0) !== payment.amountKop) fail('failed-precondition', 'Документ витрат змінився або вже оплачено. Оновіть його перед відправкою.');
        }
        if (payment.payroll?.repayOf) {
            // Повторна виплата поверненого банком платежу: та сама сума й призначення, рахунок — з виправленої картки.
            const old = (await db.doc(`payments/${payment.payroll.repayOf}`).get()).data();
            const same = old?.payroll && ['period', 'stage', 'key'].every(k => old.payroll[k] === payment.payroll[k]);
            if (!same || old.status !== 'paid' || (old.returnedKop || 0) < old.amountKop || old.amountKop !== payment.amountKop || (old.repaidBy || []).length) {
                fail('failed-precondition', 'Повторити можна лише повністю повернений банком зарплатний платіж');
            }
        } else if (payment.payroll) {
            const payroll = (await db.doc(`payroll_runs/${payment.payroll.period}`).get()).data();
            const plan = payroll?.stages?.[payment.payroll.stage]?.plan?.find(p => p.key === `${payment.payroll.stage}:${payment.payroll.key}`);
            if (payroll?.status !== 'approved' || !plan || plan.amountKop !== payment.amountKop || JSON.stringify(plan.recipient) !== JSON.stringify(payment.recipient)) fail('failed-precondition', 'Платіж має відповідати затвердженій відомості зарплати');
        }
        if (proposalKey) {
            const dup = await db.collection('payments').where('proposalKey', '==', proposalKey).where('status', 'in', ['sending', 'unknown', 'sent', 'paid']).limit(1).get();
            if (!dup.empty) {
                const p = dup.docs[0].data();
                if (data.reuseExisting && ['sent', 'paid'].includes(p.status) && p.amountKop === payment.amountKop && p.account === payment.account
                    && JSON.stringify(p.recipient) === JSON.stringify(payment.recipient) && p.purpose === payment.purpose) return { id: dup.docs[0].id };
                fail('already-exists', 'Цей платіж уже відправлено в банк або ще перевіряється');
            }
        }

        const ref = proposalKey ? db.doc(`payments/proposal-${createHash('sha256').update(proposalKey).digest('hex').slice(0, 32)}`) : db.collection('payments').doc();
        const docNumber = createHash('sha256').update(ref.id).digest('hex').slice(0, 10).toUpperCase();
        const reserved = await db.runTransaction(async t => {
            const existing = await t.get(ref);
            if (payment.expenseId) {
                const e = (await t.get(db.doc(`expenses/${payment.expenseId}`))).data();
                if (!e || e.status !== 'approved' || e.amountKop - (e.stornoKop || 0) - (e.paidKop || 0) !== payment.amountKop) fail('aborted', 'Документ витрат змінився. Оновіть сторінку.');
            }
            if (existing.exists && !['failed', 'canceled'].includes(existing.data().status)) {
                const p = existing.data();
                if (data.reuseExisting && ['sent', 'paid'].includes(p.status) && p.amountKop === payment.amountKop && p.account === payment.account
                    && JSON.stringify(p.recipient) === JSON.stringify(payment.recipient) && p.purpose === payment.purpose) return false;
                fail('already-exists', 'Цей платіж уже відправлено в банк або ще перевіряється');
            }
            t.set(ref, { ...payment, status: 'sending', proposalKey, docNumber, createdBy: actor, createdAt: FieldValue.serverTimestamp() });
            return true;
        });
        if (!reserved) return { id: ref.id };
        try {
            const result = await privat.createPayment(token, { ...payment, docNumber });
            await ref.update({ status: 'sent', bankRef: result.bankRef || null, paymentRef: result.paymentRef || null,
                bankStatus: result.status || null, sentAt: FieldValue.serverTimestamp() });
        } catch (e) {
            logger.error('Створення платежу в ПриватБанку', e);
            const status = e.bankRejected === true ? 'failed' : 'unknown';
            await ref.update({ status, error: String(e.message || e).slice(0, 300) });
            await audit(actor, role, status === 'failed' ? 'payment.failed' : 'payment.unknown', `payments/${ref.id}`, `${payment.recipient.name}: ${fromKop(payment.amountKop)} грн — ${status === 'failed' ? 'банк не прийняв' : 'результат не підтверджено'}`, { error: String(e.message || e).slice(0, 300) });
            fail('unavailable', status === 'failed' ? `Банк не прийняв платіж: ${String(e.message || e).slice(0, 200)}`
                : 'Банк не підтвердив результат. Перевірте платіж у Приват24 перед повторною відправкою.');
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
        if (!['sent', 'failed'].includes(p.status)) fail('failed-precondition', 'Платіж уже проведено, скасовано або його результат ще не підтверджено банком');
        // Повторна виплата не входить у план відомості: скасування лише знімає позначку на поверненому платежі.
        const repayOfRef = p.payroll?.repayOf ? db.doc(`payments/${p.payroll.repayOf}`) : null;
        const payrollRef = p.payroll && !repayOfRef ? db.doc(`payroll_runs/${p.payroll.period}`) : null;
        const canCancelPayroll = run => {
            if (run?.sending) fail('failed-precondition', 'Зачекайте завершення відправки відомості');
            if (!run?.stages?.[p.payroll.stage]?.plan) fail('failed-precondition', 'Стару зарплатну виплату треба виправити через окрему коригувальну відомість');
            if (p.payroll.stage === 'advance' && run.stages.final) fail('failed-precondition', 'Остаточний розрахунок уже підготовлено. Аванс змінюється лише через коригування.');
        };
        if (payrollRef) canCancelPayroll((await payrollRef.get()).data());
        let deletedInBank = false;
        if (p.status === 'sent' && p.paymentRef) {
            const { token } = await context();
            try { deletedInBank = token ? await privat.deletePayment(token, p.paymentRef) : false; }
            catch (e) { logger.warn('Видалення платежу в банку', e); }
        }
        if (p.status === 'sent' && !deletedInBank) fail('failed-precondition', 'Банк не підтвердив видалення. Платіж залишається на підписі: перевірте його у Приват24.');
        await db.runTransaction(async t => {
            const [fresh, payroll] = await Promise.all([t.get(ref), payrollRef ? t.get(payrollRef) : null]);
            if (fresh.data()?.status !== p.status) fail('aborted', 'Статус платежу змінився. Оновіть сторінку.');
            if (payroll) {
                canCancelPayroll(payroll.data());
                const stage = payroll.data().stages[p.payroll.stage];
                const completed = { ...(stage.completed || {}) };
                delete completed[`${p.payroll.stage}:${p.payroll.key}`];
                t.update(payrollRef, { [`stages.${p.payroll.stage}.complete`]: false, [`stages.${p.payroll.stage}.completed`]: completed });
            }
            if (repayOfRef) t.update(repayOfRef, { repaidBy: FieldValue.arrayRemove(ref.id) });
            t.update(ref, { status: 'canceled', canceledBy: actor, canceledAt: FieldValue.serverTimestamp(), deletedInBank });
        });
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
        // Зарплату й податки з неї платить відомість (payroll.js) — «за історією» не пропонуємо, щоб не заплатити двічі.
        const payroll = new Set();
        (await db.collection('payroll_people').select('iban').get()).forEach(d => d.data().iban && payroll.add(normIban(d.data().iban)));
        Object.values((await db.doc('payroll_settings/main').get()).data()?.taxes || {}).forEach(t => t?.iban && payroll.add(normIban(t.iban)));
        const proposals = core.recurringRecipients(history)
            .filter(r => !payroll.has(normIban(r.recipient.iban)))
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
