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
const { createHash, randomUUID } = require('crypto');
const { payable } = require('./bank-accounts');
const identity = require('./payroll-payment-core');

const REGION = 'europe-central2';
const KINDS = ['supplier', 'tax', 'salary', 'other'];

module.exports = function paymentFunctions({ db, FieldValue, requireAdmin, staffRole, notify, lock }) {
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
        return { accounts, connectionId: settings.data()?.connectionId || null,
            ownAccounts: new Set(Object.keys(accounts).map(normIban)), token: secret.exists ? secret.data().token : null };
    }

    const sameRecipient = (a, b) => ['name', 'iban', 'code'].every(k => String(a?.[k] || '') === String(b?.[k] || ''));
    function approvedPlan(stored, payment, accounts) {
        const stage = stored?.stages?.[payment.payroll.stage];
        const plan = identity.findPlan(stage, payment.payroll);
        const account = stage?.account || Object.entries(accounts).find(([, a]) => payable(a) && (a.purpose || 'current') === 'current')?.[0];
        if (stored?.status !== 'approved' || !plan || plan.amountKop !== payment.amountKop || !sameRecipient(plan.recipient, payment.recipient)
            || plan.kind !== payment.kind || String(plan.purpose).replace(/\s+/g, ' ').trim() !== payment.purpose || account !== payment.account) {
            fail('failed-precondition', 'Платіж має повністю відповідати затвердженому плану виплати зарплати');
        }
        if (stored.canceling) fail('failed-precondition', 'Зачекайте завершення скасування зарплатного платежу');
        return plan;
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
        const { ownAccounts, token, accounts, connectionId } = await context();
        const error = core.checkPayment(payment, ownAccounts);
        if (error) fail('invalid-argument', error);
        if (!token) fail('failed-precondition', 'Банк не підключено: вставте токен у «Налаштуваннях»');
        if (!payable(accounts[payment.account])) fail('failed-precondition', 'Для платежу потрібен доступний гривневий рахунок ОСББ');

        // Повторне «Так» на ту саму пропозицію не створює другий платіж.
        let proposalKey = data.proposalKey ? String(data.proposalKey).slice(0, 80) : null;
        // Платіж за документом витрат (expenses.js → pay): виписка закриє й документ.
        payment.expenseId = data.expenseId ? String(data.expenseId).replace(/[^\w-]/g, '').slice(0, 60) : null;
        // Платіж за відомістю зарплати (payroll.js): у проводках — погашення 661/641/651.
        if (data.payroll?.period) {
            if (!['advance', 'final'].includes(data.payroll.stage) || !/^[\w-]{1,200}$/.test(String(data.payroll.key || ''))) fail('invalid-argument', 'Невідомий отримувач або етап зарплатного платежу');
            payment.payroll = { period: String(data.payroll.period).slice(0, 7), stage: data.payroll.stage === 'advance' ? 'advance' : 'final',
                key: String(data.payroll.key), recipientType: identity.recipientType({ kind: payment.kind, key: data.payroll.key, recipientType: data.payroll.recipientType }) };
            if (data.payroll.planKey) payment.payroll.planKey = String(data.payroll.planKey);
            if (data.payroll.repayOf) Object.assign(payment.payroll, { repayOf: String(data.payroll.repayOf).replace(/[^\w-]/g, '').slice(0, 80), retry: Number(data.payroll.retry) || 1 });
        }
        if (payment.expenseId) {
            const expense = (await db.doc(`expenses/${payment.expenseId}`).get()).data();
            if (!expense || expense.status !== 'approved' || expense.amountKop - (expense.stornoKop || 0) - (expense.paidKop || 0) !== payment.amountKop) fail('failed-precondition', 'Документ витрат змінився або вже оплачено. Оновіть його перед відправкою.');
        }
        if (payment.payroll?.repayOf) {
            // Повторна виплата поверненого банком платежу: та сама сума й призначення, рахунок — з виправленої картки.
            const old = (await db.doc(`payments/${payment.payroll.repayOf}`).get()).data();
            const same = old?.payroll && ['period', 'stage', 'key'].every(k => old.payroll[k] === payment.payroll[k])
                && old.kind === payment.kind && old.account === payment.account && old.purpose === payment.purpose;
            if (!same || old.status !== 'paid' || (old.returnedKop || 0) < old.amountKop || old.amountKop !== payment.amountKop || (old.repaidBy || []).length) {
                fail('failed-precondition', 'Повторити можна лише повністю повернений банком зарплатний платіж');
            }
        } else if (payment.payroll) {
            const payroll = (await db.doc(`payroll_runs/${payment.payroll.period}`).get()).data();
            const plan = approvedPlan(payroll, payment, accounts);
            payment.payroll.planKey = plan.key;
            // Ключ задає сервер. Інша форма чи клієнтський proposalKey не
            // можуть створити другу виплату тієї самої строки відомості.
            proposalKey = `payroll:${payment.payroll.period}:${plan.key}`;
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
            const currentBank = (await t.get(db.doc('bank/settings'))).data() || {};
            if ((currentBank.connectionId || null) !== connectionId || !payable(currentBank.accounts?.[payment.account])) fail('aborted', 'Доступ до банку змінився. Оновіть сторінку.');
            if (existing.data()?.canceling) fail('failed-precondition', 'Платіж ще скасовується — зачекайте завершення');
            if (payment.payroll && !payment.payroll.repayOf) {
                const stored = (await t.get(db.doc(`payroll_runs/${payment.payroll.period}`))).data();
                await lock?.assertOpen(payment.payroll.period, 'Виплата зарплати', t);
                approvedPlan(stored, payment, currentBank.accounts || {});
            }
            if (payment.expenseId) {
                const [es, live] = await Promise.all([t.get(db.doc(`expenses/${payment.expenseId}`)),
                    t.get(db.collection('payments').where('expenseId', '==', payment.expenseId).where('status', 'in', ['sending', 'unknown', 'sent']).limit(2))]);
                const e = es.data();
                if (!e || e.status !== 'approved' || e.amountKop - (e.stornoKop || 0) - (e.paidKop || 0) !== payment.amountKop) fail('aborted', 'Документ витрат змінився. Оновіть сторінку.');
                // Один документ — один платіж у дорозі, хоч би з якої форми його відправили.
                if (live.docs.some(d => d.id !== ref.id)) fail('already-exists', 'За цим документом уже є платіж у Приват24 — дочекайтеся виписки або скасуйте його в «Платежах»');
            }
            const oldRef = payment.payroll?.repayOf ? db.doc(`payments/${payment.payroll.repayOf}`) : null;
            const old = oldRef ? await t.get(oldRef) : null;
            if (oldRef && (!old.exists || old.data().status !== 'paid' || (old.data().returnedKop || 0) !== payment.amountKop || (old.data().repaidBy || []).length)) {
                fail('aborted', 'Повернений платіж уже повторюється або його стан змінився');
            }
            if (existing.exists && !['failed', 'canceled'].includes(existing.data().status)) {
                const p = existing.data();
                if (data.reuseExisting && ['sent', 'paid'].includes(p.status) && p.amountKop === payment.amountKop && p.account === payment.account
                    && JSON.stringify(p.recipient) === JSON.stringify(payment.recipient) && p.purpose === payment.purpose) return false;
                fail('already-exists', 'Цей платіж уже відправлено в банк або ще перевіряється');
            }
            t.set(ref, { ...payment, status: 'sending', proposalKey, docNumber, createdBy: actor, createdAt: FieldValue.serverTimestamp() });
            if (oldRef) t.update(oldRef, { repaidBy: FieldValue.arrayUnion(ref.id) });
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
            await db.runTransaction(async t => {
                const current = await t.get(ref);
                const oldRef = payment.payroll?.repayOf ? db.doc(`payments/${payment.payroll.repayOf}`) : null;
                if (oldRef) await t.get(oldRef);
                // Пізня виписка могла вже підтвердити платіж.
                if (current.data()?.status === 'paid') return;
                t.update(ref, { status, error: String(e.message || e).slice(0, 300) });
                if (oldRef && status === 'failed') t.update(oldRef, { repaidBy: FieldValue.arrayRemove(ref.id) });
            });
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

    /**
     * Банк не підтвердив результат (unknown) або відправка зависла (sending
     * понад 10 хв): голова перевіряє в Приват24 і фіксує, що сталося.
     *   not_created — платежу в банку немає: статус failed, його можна
     *     відправити знову (зарплатна пачка продовжить саме цей платіж);
     *   created — платіж є в Приват24: статус sent, далі його закриє виписка.
     * Лише голова: вона бачить список платежів у Приват24.
     */
    const STALE_MS = 10 * 60 * 1000;
    async function resolve(actor, role, { id, outcome, reason, bankRef }) {
        if (role !== 'chair') fail('permission-denied', 'Результат у Приват24 підтверджує голова');
        if (!['not_created', 'created'].includes(outcome)) fail('invalid-argument', 'Оберіть, що показав Приват24');
        const why = String(reason || '').replace(/\s+/g, ' ').trim().slice(0, 300);
        if (why.length < 5) fail('invalid-argument', 'Опишіть, що саме перевірили (дата, сума, отримувач у Приват24)');
        const ref = db.doc(`payments/${String(id || '').replace(/[^\w-]/g, '')}`);
        const p = await db.runTransaction(async t => {
            const snap = await t.get(ref);
            if (!snap.exists) fail('not-found', 'Платіж не знайдено');
            const data = snap.data();
            const created = data.createdAt?.toMillis?.() || 0;
            const stale = data.status === 'sending' && Date.now() - created > STALE_MS;
            const staleCancel = data.canceling && Date.now() - Date.parse(data.canceling.at) > STALE_MS;
            if (data.status === 'paid' || (data.status !== 'unknown' && !stale && !staleCancel)) fail('failed-precondition', data.status === 'sending' ? 'Платіж ще відправляється — зачекайте 10 хвилин' : 'Результат цього платежу вже відомий');
            const deleting = data.uncertainAction === 'delete' || Boolean(data.canceling);
            const payrollRef = (outcome === 'not_created' || staleCancel) && data.payroll && !data.payroll.repayOf ? db.doc(`payroll_runs/${data.payroll.period}`) : null;
            const payroll = payrollRef ? await t.get(payrollRef) : null;
            if (payroll?.data()?.canceling?.paymentId === ref.id) t.update(payrollRef, { canceling: FieldValue.delete() });
            if (outcome === 'not_created') {
                t.update(ref, { status: deleting ? 'canceled' : 'failed', canceling: FieldValue.delete(), uncertainAction: FieldValue.delete(),
                    error: `Платежу в Приват24 немає (перевірила голова): ${why}`, resolvedBy: actor, resolvedAt: FieldValue.serverTimestamp() });
                // Пачка зарплати: цей платіж знову «не створено» — повторна відправка відомості створить лише його.
                const stage = payroll?.data()?.stages?.[data.payroll.stage];
                if (stage) {
                    const completed = identity.withoutCompleted(stage.completed, ref.id);
                    t.update(payrollRef, { [`stages.${data.payroll.stage}.complete`]: false, [`stages.${data.payroll.stage}.completed`]: completed });
                }
                if (data.payroll?.repayOf) t.update(db.doc(`payments/${data.payroll.repayOf}`), { repaidBy: FieldValue.arrayRemove(ref.id) });
            } else {
                t.update(ref, { status: 'sent', canceling: FieldValue.delete(), uncertainAction: FieldValue.delete(),
                    bankRef: String(bankRef || '').trim().slice(0, 60) || data.bankRef || null, error: null,
                    sentAt: FieldValue.serverTimestamp(), resolvedBy: actor, resolvedAt: FieldValue.serverTimestamp() });
            }
            return data;
        });
        await audit(actor, role, outcome === 'not_created' ? 'payment.notCreated' : 'payment.foundInBank', `payments/${ref.id}`,
            `${p.recipient?.name}: ${fromKop(p.amountKop)} грн — ${outcome === 'not_created' ? 'у Приват24 платежу немає, можна відправити знову' : 'платіж є в Приват24'} (${why})`, { was: p.status, reason: why });
        return { ok: true };
    }

    async function cancel(actor, role, { id }) {
        const ref = db.doc(`payments/${String(id || '').replace(/[^\w-]/g, '')}`);
        const attempt = randomUUID();
        // Резервуємо платіж і відомість ДО зовнішнього видалення. Інша
        // відправка не зможе пропустити чернетку, яку банк уже видалив.
        const p = await db.runTransaction(async t => {
            const snap = await t.get(ref);
            if (!snap.exists) fail('not-found', 'Платіж не знайдено');
            const data = snap.data();
            if (!['sent', 'failed'].includes(data.status) || data.canceling) fail('failed-precondition', 'Платіж уже проведено, скасовується або його результат потребує перевірки');
            const payrollRef = data.payroll && !data.payroll.repayOf ? db.doc(`payroll_runs/${data.payroll.period}`) : null;
            const run = payrollRef ? (await t.get(payrollRef)).data() : null;
            if (data.payroll) await lock?.assertOpen(data.payroll.period, 'Скасування зарплатного платежу', t);
            if (payrollRef) {
                if (run?.sending || run?.canceling) fail('failed-precondition', 'Зачекайте завершення відправки або скасування відомості');
                if (!run?.stages?.[data.payroll.stage]?.plan) fail('failed-precondition', 'Стару зарплатну виплату треба виправити через окрему коригувальну відомість');
                if (data.payroll.stage === 'advance' && run.stages.final) fail('failed-precondition', 'Остаточний розрахунок уже підготовлено. Аванс змінюється лише через коригування.');
            }
            const canceling = { attempt, at: new Date().toISOString(), by: actor, paymentId: ref.id };
            t.update(ref, { canceling });
            if (payrollRef) t.update(payrollRef, { canceling });
            return data;
        });
        const repayOfRef = p.payroll?.repayOf ? db.doc(`payments/${p.payroll.repayOf}`) : null;
        const payrollRef = p.payroll && !repayOfRef ? db.doc(`payroll_runs/${p.payroll.period}`) : null;
        let deletedInBank = false;
        let error = null;
        if (p.status === 'sent' && p.paymentRef) {
            const { token } = await context();
            try { deletedInBank = token ? await privat.deletePayment(token, p.paymentRef) : false; }
            catch (e) { error = e; logger.warn('Видалення платежу в банку', e); }
        }
        const uncertain = p.status === 'sent' && error && error.bankRejected !== true;
        const confirmed = p.status === 'failed' || deletedInBank;
        const outcome = await db.runTransaction(async t => {
            const [fresh, payroll] = await Promise.all([t.get(ref), payrollRef ? t.get(payrollRef) : null]);
            if (fresh.data()?.canceling?.attempt !== attempt) fail('aborted', 'Скасування вже перевірено іншим оператором. Оновіть сторінку.');
            if (payroll && payroll.data()?.canceling?.attempt !== attempt) fail('aborted', 'Стан відомості змінився. Оновіть сторінку.');
            if (payroll) {
                const stage = payroll.data().stages[p.payroll.stage];
                const update = { canceling: FieldValue.delete() };
                if (fresh.data().status !== 'paid' && (confirmed || uncertain)) Object.assign(update, { [`stages.${p.payroll.stage}.complete`]: false,
                    [`stages.${p.payroll.stage}.completed`]: identity.withoutCompleted(stage.completed, ref.id) });
                t.update(payrollRef, update);
            }
            if (fresh.data().status === 'paid') { t.update(ref, { canceling: FieldValue.delete() }); return 'paid'; }
            if (repayOfRef && confirmed) t.update(repayOfRef, { repaidBy: FieldValue.arrayRemove(ref.id) });
            if (confirmed) t.update(ref, { status: 'canceled', canceling: FieldValue.delete(), uncertainAction: FieldValue.delete(),
                canceledBy: actor, canceledAt: FieldValue.serverTimestamp(), deletedInBank });
            else if (uncertain) t.update(ref, { status: 'unknown', canceling: FieldValue.delete(), uncertainAction: 'delete',
                error: 'Банк не підтвердив результат видалення. Голова має перевірити наявність чернетки у Приват24.' });
            else t.update(ref, { canceling: FieldValue.delete() });
            return confirmed ? 'canceled' : uncertain ? 'unknown' : 'sent';
        });
        if (outcome === 'paid') fail('failed-precondition', 'Виписка вже підтвердила оплату — скасувати чернетку не можна');
        if (outcome !== 'canceled') fail('failed-precondition', uncertain ? 'Банк не підтвердив результат видалення. Перевірте чернетку у Приват24 перед повторною виплатою.'
            : 'Банк не підтвердив видалення. Платіж залишається на підписі: перевірте його у Приват24.');
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
        const accounts = Object.entries(settings.exists ? settings.data().accounts || {} : {}).filter(([, a]) => payable(a))
            .map(([iban, a]) => ({ iban, purpose: a.purpose || 'current', balanceKop: a.balanceKop ?? null }));
        return { proposals, recipients: [...recipients.values()], accounts };
    }

    /**
     * Нагадати голові про платежі на підписі: одне push-сповіщення з
     * переліком, не частіше ніж раз на годину (позначка — bank/payReminder).
     */
    async function remind(actor, role) {
        const snap = await db.collection('payments').where('status', '==', 'sent').get();
        const waiting = snap.docs.map(d => d.data());
        if (!waiting.length) fail('failed-precondition', 'Немає платежів, що чекають підпису голови');
        const mark = db.doc('bank/payReminder');
        await db.runTransaction(async t => {
            const last = (await t.get(mark)).data()?.at?.toMillis?.() || 0;
            if (Date.now() - last < core.REMIND_EVERY_MS) fail('resource-exhausted', 'Голові вже нагадали протягом останньої години');
            t.set(mark, { at: FieldValue.serverTimestamp(), by: actor });
        });
        const { title, body } = core.reminderText(waiting);
        try {
            await notify?.({ roles: ['chair'], title, body, link: 'admin.html' });
        } catch (e) {
            // Сповіщення не пішло — знімаємо позначку, щоб можна було повторити одразу.
            await mark.delete().catch(() => {});
            logger.warn('Нагадування голові', e);
            fail('unavailable', 'Не вдалося надіслати сповіщення голові — спробуйте ще раз');
        }
        await audit(actor, role, 'payment.remind', 'payments', title, { count: waiting.length });
        return { count: waiting.length };
    }

    const paymentAction = onCall({ region: REGION, maxInstances: 4, timeoutSeconds: 60 }, callGuard('paymentAction', async request => {
        const actor = await requireAdmin(request, ['chair', 'accountant']);
        const role = await staffRole(actor);
        const data = request.data || {};
        if (data.action === 'create') return create(actor, role, data);
        if (data.action === 'cancel') return cancel(actor, role, data);
        if (data.action === 'resolve') return resolve(actor, role, data);
        if (data.action === 'remind') return remind(actor, role);
        if (data.action === 'context') return contextFor();
        fail('invalid-argument', 'Невідома дія');
    }));

    return { paymentAction, actions: { create, cancel, resolve, remind } };
};
