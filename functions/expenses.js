'use strict';
// ============================================================
// Витрати й договори ОСББ: постачальники, договори, рахунки й акти
// з файлами, затвердження, оплата й звірка зі списаннями банку.
//
// Потік: бухгалтер вносить документ (рахунок, акт) з файлом →
// система визначає, хто затверджує (expenses-core.approvalLevel) →
// затверджений документ бухгалтер одним «Так» відправляє в Приват24
// (payments.js) → голова підписує КЕП → виписка знаходить списання й
// закриває документ (bank.js → linkUpdate).
//
// Колекції (запис — лише сервер, читання — голова й бухгалтер):
//   suppliers/{id}  — { name, kind, code, iban, fopChecked, note }
//   contracts/{id}  — { supplierId, number, date, subject, type, amountKop|monthlyKop,
//                       validFrom, validTo, item, boardDecision, meetingDecision,
//                       files, status: pending|approved|rejected, … }
//   expenses/{id}   — { supplierId, contractId, docType, number, date, amountKop, vatKop,
//                       period, item, description, files, status: pending|approved|paid|
//                       rejected|canceled|linked|storno, approval: { level, reason, by, at }, paidKop, txIds,
//                       linkedTo (основний документ тієї самої операції), linkedIds,
//                       stornoOf / stornoKop, stornoIds (коригування), refundTxIds (повернені банком оплати) }
//   expense_settings/main — { smallKop } (поріг дрібних витрат, задає голова)
// ============================================================
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const callGuard = require('./call-guard');
const logger = require('firebase-functions/logger');
const core = require('./expenses-core');
const { normIban, fromKop, safeId } = require('./bank-core');

const REGION = 'europe-central2';
const FILE_URL = /^https:\/\/firebasestorage\.googleapis\.com\/v0\/b\/uspih-25\.(firebasestorage\.app|appspot\.com)\/o\/expenses%2F/;

module.exports = function expenseFunctions({ db, FieldValue, requireAdmin, staffRole, notify, payments, budget, lock }) {
    const fail = (code, message) => { throw new HttpsError(code, message); };
    const settingsRef = db.doc('expense_settings/main');

    async function audit(actor, role, action, target, summary, details = {}) {
        await db.collection('audit_log').add({
            actor, role, action, target, summary: String(summary).slice(0, 300),
            details: JSON.parse(JSON.stringify(details)), at: FieldValue.serverTimestamp()
        });
    }
    const tellChair = (title, body) => notify?.({ roles: ['chair'], title, body, link: 'buh.html#inbox' })
        .catch(e => logger.warn('Сповіщення голові', e));

    const text = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
    const kop = v => (v === null || v === undefined || v === '' ? null : Number(v));
    const id = v => safeId(v);

    /** Файли лише з теки expenses/ сховища цього застосунку. */
    function cleanFiles(files) {
        const list = (Array.isArray(files) ? files : []).slice(0, 10).map(f => ({
            name: text(f?.name, 160), url: String(f?.url || ''), path: String(f?.path || ''),
            size: Number(f?.size) || 0, type: text(f?.type, 100)
        }));
        if (list.some(f => !FILE_URL.test(f.url) || !f.path.startsWith('expenses/'))) fail('invalid-argument', 'Файл має бути завантажений у застосунок');
        return list;
    }

    async function get(path, what) {
        const snap = await db.doc(path).get();
        if (!snap.exists) fail('not-found', `${what} не знайдено`);
        return { id: snap.id, ...snap.data() };
    }

    // --------------------------------------------------------
    // ПОСТАЧАЛЬНИКИ
    // --------------------------------------------------------
    async function saveSupplier(actor, role, data) {
        const s = {
            name: text(data.name, 200), kind: String(data.kind || ''), code: text(data.code, 10),
            iban: normIban(data.iban), fopChecked: data.kind === 'fop' && data.fopChecked === true, note: text(data.note, 300)
        };
        const error = core.checkSupplier(s);
        if (error) fail('invalid-argument', error);
        const same = await db.collection('suppliers').where('code', '==', s.code).limit(2).get();
        const other = same.docs.find(d => d.id !== data.id);
        if (other) fail('already-exists', `Постачальник з цим кодом уже є: ${other.data().name}`);
        const ref = data.id ? db.doc(`suppliers/${id(data.id)}`) : db.collection('suppliers').doc();
        if (data.id && !(await ref.get()).exists) fail('not-found', 'Постачальника не знайдено');
        await ref.set({ ...s, ...(s.fopChecked ? { fopCheckedBy: actor, fopCheckedAt: FieldValue.serverTimestamp() } : {}),
            updatedBy: actor, updatedAt: FieldValue.serverTimestamp(), ...(data.id ? {} : { createdBy: actor, createdAt: FieldValue.serverTimestamp() }) }, { merge: true });
        await audit(actor, role, data.id ? 'expenses.supplier.update' : 'expenses.supplier', `suppliers/${ref.id}`, `${s.name} (${s.code})`, s);
        return { id: ref.id, warnings: core.supplierWarnings(s) };
    }

    // --------------------------------------------------------
    // ДОГОВОРИ
    // --------------------------------------------------------
    async function saveContract(actor, role, data) {
        const c = {
            supplierId: id(data.supplierId), number: text(data.number, 60), date: String(data.date || ''), subject: text(data.subject, 300),
            type: data.type === 'monthly' ? 'monthly' : 'fixed', amountKop: kop(data.amountKop), monthlyKop: kop(data.monthlyKop),
            validFrom: String(data.validFrom || ''), validTo: String(data.validTo || ''), item: String(data.item || ''),
            boardDecision: text(data.boardDecision, 200), meetingDecision: text(data.meetingDecision, 200), files: cleanFiles(data.files)
        };
        if (c.type === 'monthly') c.amountKop = null; else c.monthlyKop = null;
        const error = core.checkContract(c);
        if (error) fail('invalid-argument', error);
        const supplier = await get(`suppliers/${c.supplierId}`, 'Постачальника');
        const ref = data.id ? db.doc(`contracts/${id(data.id)}`) : db.collection('contracts').doc();
        if (data.id) {
            const prev = await get(`contracts/${ref.id}`, 'Договір');
            if (prev.status === 'approved' && role !== 'chair') fail('failed-precondition', 'Затверджений договір змінює лише голова');
        }
        // Договори підписує голова: його збереження — це й затвердження.
        const status = role === 'chair' ? 'approved' : 'pending';
        c.totalKop = core.contractTotal(c);
        await ref.set({ ...c, supplierName: supplier.name, status,
            ...(status === 'approved' ? { approvedBy: actor, approvedAt: FieldValue.serverTimestamp() } : { approvedBy: null }),
            updatedBy: actor, updatedAt: FieldValue.serverTimestamp(), ...(data.id ? {} : { createdBy: actor, createdAt: FieldValue.serverTimestamp() }) }, { merge: true });
        await audit(actor, role, 'expenses.contract', `contracts/${ref.id}`,
            `Договір № ${c.number} з ${supplier.name}: ${fromKop(c.totalKop)} грн${status === 'pending' ? ' — на затвердження голові' : ''}`, { ...c, files: c.files.length });
        if (status === 'pending') await tellChair('Договір чекає затвердження', `${supplier.name}: № ${c.number}, ${fromKop(c.totalKop).toLocaleString('uk-UA')} грн`);
        return { id: ref.id, status };
    }

    async function decideContract(actor, role, { id: cid, approve, comment }) {
        if (role !== 'chair') fail('permission-denied', 'Договори затверджує голова');
        const c = await get(`contracts/${id(cid)}`, 'Договір');
        if (c.status !== 'pending') fail('failed-precondition', 'Договір уже розглянуто');
        await db.doc(`contracts/${c.id}`).update({ status: approve ? 'approved' : 'rejected', approvedBy: actor, approvedAt: FieldValue.serverTimestamp(), comment: text(comment, 300) });
        await audit(actor, role, approve ? 'expenses.contract.approve' : 'expenses.contract.reject', `contracts/${c.id}`,
            `Договір № ${c.number} з ${c.supplierName}: ${approve ? 'затверджено' : 'відхилено'}`, { comment: text(comment, 300) });
        return { ok: true };
    }

    async function endContract(actor, role, { id: cid, date }) {
        const c = await get(`contracts/${id(cid)}`, 'Договір');
        if (!core.validDate(date) || date < c.validFrom) fail('invalid-argument', 'Вкажіть дату закінчення, не раніше за початок дії');
        await db.doc(`contracts/${c.id}`).update({ validTo: date, endedBy: actor, endedAt: FieldValue.serverTimestamp() });
        await audit(actor, role, 'expenses.contract.end', `contracts/${c.id}`, `Договір № ${c.number} з ${c.supplierName} діє до ${core.humanDate(date)}`, { date });
        return { ok: true };
    }

    // --------------------------------------------------------
    // ДОКУМЕНТИ ВИТРАТ
    // --------------------------------------------------------
    async function saveExpense(actor, role, data) {
        const e = {
            supplierId: id(data.supplierId), contractId: data.contractId ? id(data.contractId) : null, docType: String(data.docType || ''),
            number: text(data.number, 60), date: String(data.date || ''), amountKop: kop(data.amountKop), vatKop: data.vatKop === undefined || data.vatKop === null || data.vatKop === '' ? 0 : kop(data.vatKop),
            period: String(data.period || ''), item: String(data.item || ''), description: text(data.description, 300), files: cleanFiles(data.files)
        };
        const error = core.checkExpense(e);
        if (error) fail('invalid-argument', error);
        if (data.linkedTo && !data.id) return saveLinked(actor, role, e, id(data.linkedTo));
        await lock?.assertOpen(e.period, 'Документ витрат');
        if (data.id) {
            const prev = await db.doc(`expenses/${id(data.id)}`).get();
            if (prev.exists) await lock?.assertOpen(prev.data().period, 'Документ витрат');
        }
        const supplier = await get(`suppliers/${e.supplierId}`, 'Постачальника');
        const contract = e.contractId ? await get(`contracts/${e.contractId}`, 'Договір') : null;
        if (contract && contract.supplierId !== e.supplierId) fail('invalid-argument', 'Договір укладено з іншим постачальником');
        const ref = data.id ? db.doc(`expenses/${id(data.id)}`) : db.collection('expenses').doc();
        if (data.id) {
            const prev = await get(`expenses/${ref.id}`, 'Документ');
            if (!['pending', 'rejected'].includes(prev.status)) fail('failed-precondition', 'Затверджений документ не змінюється. Скасуйте його й внесіть новий.');
        } else {
            const dup = await db.collection('expenses').where('supplierId', '==', e.supplierId).where('number', '==', e.number).get();
            if (dup.docs.some(d => d.data().date === e.date && d.data().status !== 'canceled')) fail('already-exists', `Документ № ${e.number} від ${core.humanDate(e.date)} цього постачальника вже внесено`);
            // Рахунок і акт на ту саму суму — ймовірно, одна послуга: друга витрата подвоїла б і витрати, і борг.
            if (!data.distinct) {
                const same = await db.collection('expenses').where('supplierId', '==', e.supplierId).get();
                const similar = core.similarDocument(e, same.docs.map(d => ({ id: d.id, ...d.data() })));
                if (similar) {
                    throw new HttpsError('already-exists', `Схоже, це та сама послуга, що й ${core.DOC_TYPES[similar.docType].toLowerCase()} № ${similar.number} від ${core.humanDate(similar.date)} на ту саму суму. Привʼяжіть документ до нього або підтвердьте, що це окрема послуга.`,
                        { similar: { id: similar.id, docType: similar.docType, number: similar.number, date: similar.date } });
                }
            }
        }
        const result = await db.runTransaction(async t => {
            const [settingsSnap, previous, currentContract] = await Promise.all([
                t.get(settingsRef), t.get(ref), e.contractId ? t.get(db.doc(`contracts/${e.contractId}`)) : null
            ]);
            await lock?.assertOpen(e.period, 'Документ витрат', t);
            if (previous.exists) {
                await lock?.assertOpen(previous.data().period, 'Документ витрат', t);
                if (!data.id || !['pending', 'rejected'].includes(previous.data().status)) fail('aborted', 'Документ змінився. Оновіть сторінку.');
            }
            const actualContract = currentContract?.exists ? { id: currentContract.id, ...currentContract.data() } : null;
            if (e.contractId && (!actualContract || actualContract.supplierId !== e.supplierId)) fail('failed-precondition', 'Договір змінився. Оновіть сторінку.');
            const used = actualContract ? await t.get(db.collection('expenses').where('contractId', '==', actualContract.id)) : null;
            const spent = used ? used.docs.filter(d => d.id !== ref.id && ['approved', 'paid'].includes(d.data().status) && (actualContract.type !== 'monthly' || d.data().period === e.period)).reduce((sum, d) => sum + d.data().amountKop, 0) : 0;
            const duplicates = await t.get(db.collection('expenses').where('supplierId', '==', e.supplierId).where('number', '==', e.number));
            if (duplicates.docs.some(d => d.id !== ref.id && d.data().date === e.date && d.data().status !== 'canceled')) fail('already-exists', 'Цей документ постачальника вже внесено');
            let need = core.approvalLevel(e, actualContract, spent, settingsSnap.data() || {});
            if (need.level === 'accountant' && budget) {
                const over = await budget.guard(e, ref.id, t);
                if (over) need = { level: 'chair', reason: over };
            }
            const approved = role === 'chair' || need.level === 'accountant';
            // Serialize automatic approvals, including initially empty queries.
            t.set(settingsRef, { revision: FieldValue.increment(1) }, { merge: true });
            t.set(ref, { ...e, supplierName: supplier.name, contractNumber: actualContract?.number || null,
                status: approved ? 'approved' : 'pending',
                approval: { level: need.level, reason: need.reason, by: approved ? actor : null, at: approved ? FieldValue.serverTimestamp() : null },
                paidKop: 0, txIds: [], updatedBy: actor, updatedAt: FieldValue.serverTimestamp(),
                ...(data.id ? {} : { createdBy: actor, createdAt: FieldValue.serverTimestamp() }) }, { merge: true });
            return { approved, need };
        });
        const { approved, need } = result;
        await audit(actor, role, 'expenses.save', `expenses/${ref.id}`,
            `${core.DOC_TYPES[e.docType]} № ${e.number} ${supplier.name}: ${fromKop(e.amountKop)} грн — ${approved ? 'затверджено' : 'на затвердження голові'} (${need.reason})`,
            { ...e, files: e.files.length, level: need.level });
        if (!approved) await tellChair('Витрата чекає затвердження', `${supplier.name}: ${fromKop(e.amountKop).toLocaleString('uk-UA')} грн — ${need.reason}`);
        return { id: ref.id, status: approved ? 'approved' : 'pending', approval: need, warnings: core.supplierWarnings(supplier) };
    }

    /** Підтвердний документ (акт до рахунку тощо): та сама операція — без другої витрати й боргу. */
    async function saveLinked(actor, role, e, mainId) {
        const ref = db.collection('expenses').doc();
        const mainRef = db.doc(`expenses/${mainId}`);
        const main = await db.runTransaction(async t => {
            const [snap, dups] = await Promise.all([t.get(mainRef), t.get(db.collection('expenses').where('supplierId', '==', e.supplierId).where('number', '==', e.number))]);
            const m = snap.exists ? { id: snap.id, ...snap.data() } : null;
            const why = core.checkLink(e, m);
            if (why) fail('failed-precondition', why);
            if (dups.docs.some(d => d.data().date === e.date && d.data().status !== 'canceled')) fail('already-exists', 'Цей документ постачальника вже внесено');
            t.set(ref, { ...e, supplierName: m.supplierName, contractId: m.contractId || null, contractNumber: m.contractNumber || null,
                period: m.period, item: m.item, status: 'linked', linkedTo: m.id,
                approval: { level: 'none', reason: `підтверджує ${core.DOC_TYPES[m.docType].toLowerCase()} № ${m.number}`, by: actor, at: FieldValue.serverTimestamp() },
                paidKop: 0, txIds: [], createdBy: actor, createdAt: FieldValue.serverTimestamp(), updatedBy: actor, updatedAt: FieldValue.serverTimestamp() });
            t.update(mainRef, { linkedIds: FieldValue.arrayUnion(ref.id) });
            return m;
        });
        await audit(actor, role, 'expenses.attach', `expenses/${ref.id}`, `${core.DOC_TYPES[e.docType]} № ${e.number} привʼязано до № ${main.number} (${main.supplierName}) — одна операція, без другої витрати`, { linkedTo: main.id });
        return { id: ref.id, status: 'linked', approval: { level: 'none', reason: 'підтвердний документ' }, warnings: [] };
    }

    /**
     * Уже внесений другим документом рахунок чи акт тієї самої послуги
     * стає підтвердним: витрата й борг лишаються лише за основним.
     */
    async function linkExisting(actor, role, { id: did, to }) {
        const ref = db.doc(`expenses/${id(did)}`), mainRef = db.doc(`expenses/${id(to)}`);
        if (ref.id === mainRef.id) fail('invalid-argument', 'Документ не привʼязують до самого себе');
        const result = await db.runTransaction(async t => {
            const [snap, mainSnap, sent] = await Promise.all([t.get(ref), t.get(mainRef),
                t.get(db.collection('payments').where('expenseId', '==', ref.id).where('status', 'in', ['sending', 'unknown', 'sent']).limit(1)), t.get(settingsRef)]);
            if (!snap.exists) fail('not-found', 'Документ не знайдено');
            const doc = { id: snap.id, ...snap.data() };
            if (!['pending', 'approved', 'rejected'].includes(doc.status) || doc.linkedTo) fail('failed-precondition', 'Привʼязати можна лише неоплачений основний документ');
            const why = core.checkLink(doc, mainSnap.exists ? { id: mainSnap.id, ...mainSnap.data() } : null);
            if (why) fail('failed-precondition', why);
            if (!sent.empty) fail('failed-precondition', 'По документу є платіж на підписі — спершу скасуйте його в «Платежах»');
            await lock?.assertOpen(doc.period, 'Документ витрат', t);
            t.set(settingsRef, { revision: FieldValue.increment(1) }, { merge: true });
            t.update(ref, { status: 'linked', linkedTo: mainRef.id, statusBefore: doc.status, period: mainSnap.data().period, item: mainSnap.data().item,
                updatedBy: actor, updatedAt: FieldValue.serverTimestamp() });
            t.update(mainRef, { linkedIds: FieldValue.arrayUnion(ref.id) });
            return { doc, main: mainSnap.data() };
        });
        await audit(actor, role, 'expenses.attach', `expenses/${ref.id}`,
            `№ ${result.doc.number} став підтвердним до № ${result.main.number} (${result.main.supplierName}): витрата ${fromKop(result.doc.amountKop)} грн більше не дублюється`, { linkedTo: mainRef.id, was: result.doc.status });
        return { ok: true };
    }

    /** Сторно документа датою коригування: витрата й борг постачальнику зменшуються в поточному місяці. */
    async function storno(actor, role, { id: did, amountKop, date, number, reason, files }) {
        const s = { amountKop: kop(amountKop), date: String(date || ''), number: text(number, 60), reason: text(reason, 300) };
        const origRef = db.doc(`expenses/${id(did)}`);
        const ref = db.collection('expenses').doc();
        const period = s.date.slice(0, 7);
        await lock?.assertOpen(period, 'Сторно документа');
        const original = await db.runTransaction(async t => {
            const [snap] = await Promise.all([t.get(origRef), t.get(settingsRef)]);
            const o = snap.exists ? { id: snap.id, ...snap.data() } : null;
            const why = core.checkStorno(o, s);
            if (why) fail('invalid-argument', why);
            await lock?.assertOpen(period, 'Сторно документа', t);
            const total = (o.stornoKop || 0) + s.amountKop;
            t.set(settingsRef, { revision: FieldValue.increment(1) }, { merge: true });
            t.set(ref, { supplierId: o.supplierId, supplierName: o.supplierName, contractId: o.contractId || null, contractNumber: o.contractNumber || null,
                docType: o.docType, number: s.number, date: s.date, amountKop: -s.amountKop, vatKop: 0, period, item: o.item,
                description: `Сторно № ${o.number} від ${core.humanDate(o.date)}: ${s.reason}`, files: cleanFiles(files), status: 'storno', stornoOf: o.id,
                approval: { level: role, reason: s.reason, by: actor, at: FieldValue.serverTimestamp() }, paidKop: 0, txIds: [],
                createdBy: actor, createdAt: FieldValue.serverTimestamp(), updatedBy: actor, updatedAt: FieldValue.serverTimestamp() });
            const fullyPaid = (o.paidKop || 0) >= o.amountKop - total;
            t.update(origRef, { stornoKop: total, stornoIds: FieldValue.arrayUnion(ref.id),
                ...(o.status === 'approved' && fullyPaid ? { status: 'paid', paidAt: FieldValue.serverTimestamp() } : {}) });
            return o;
        });
        const overpaid = (original.paidKop || 0) - (original.amountKop - (original.stornoKop || 0) - s.amountKop);
        await audit(actor, role, 'expenses.storno', `expenses/${ref.id}`,
            `Сторно ${fromKop(s.amountKop)} грн до № ${original.number} (${original.supplierName}): ${s.reason}`, { stornoOf: original.id, amountKop: s.amountKop, date: s.date });
        if (role !== 'chair') await tellChair('Сторно документа витрат', `${original.supplierName}: −${fromKop(s.amountKop).toLocaleString('uk-UA')} грн — ${s.reason}`);
        return { id: ref.id, overpaidKop: Math.max(0, overpaid) };
    }

    async function decideExpense(actor, role, { id: eid, approve, comment }) {
        if (role !== 'chair') fail('permission-denied', 'Цей документ затверджує голова');
        const e = await get(`expenses/${id(eid)}`, 'Документ');
        if (e.status !== 'pending') fail('failed-precondition', 'Документ уже розглянуто');
        await lock?.assertOpen(e.period, 'Документ витрат');
        if (!approve && text(comment, 300).length < 3) fail('invalid-argument', 'Напишіть, чому відхиляєте — бухгалтер побачить причину');
        await db.runTransaction(async t => {
            const ref = db.doc(`expenses/${e.id}`);
            const [fresh] = await Promise.all([t.get(ref), t.get(settingsRef)]);
            await lock?.assertOpen(fresh.data()?.period, 'Документ витрат', t);
            if (fresh.data()?.status !== 'pending') fail('aborted', 'Документ уже розглянуто');
            t.set(settingsRef, { revision: FieldValue.increment(1) }, { merge: true });
            t.update(ref, { status: approve ? 'approved' : 'rejected', 'approval.by': actor, 'approval.at': FieldValue.serverTimestamp(), comment: text(comment, 300) });
        });
        await audit(actor, role, approve ? 'expenses.approve' : 'expenses.reject', `expenses/${e.id}`,
            `${e.supplierName}: ${fromKop(e.amountKop)} грн — ${approve ? 'затверджено' : 'відхилено'}`, { comment: text(comment, 300) });
        return { ok: true };
    }

    async function cancelExpense(actor, role, { id: eid }) {
        const e = await get(`expenses/${id(eid)}`, 'Документ');
        if (e.paidKop > 0 || e.status === 'paid') fail('failed-precondition', 'Документ уже оплачено. Спершу поверніть списання у «Вхідні».');
        await lock?.assertOpen(e.period, 'Документ витрат');
        await db.runTransaction(async t => {
            const ref = db.doc(`expenses/${e.id}`);
            const [fresh, sent] = await Promise.all([t.get(ref), t.get(db.collection('payments').where('expenseId', '==', e.id).where('status', 'in', ['sending', 'unknown', 'sent']).limit(1)), t.get(settingsRef)]);
            await lock?.assertOpen(fresh.data()?.period, 'Документ витрат', t);
            if (fresh.data()?.paidKop > 0 || fresh.data()?.status === 'paid') fail('failed-precondition', 'Документ уже оплачено. Спершу поверніть списання у «Вхідні».');
            if (!sent.empty) fail('failed-precondition', 'По документу є платіж на підписі — спершу скасуйте його в «Платежах»');
            if (fresh.data()?.status === 'storno' || (fresh.data()?.stornoIds || []).length) fail('failed-precondition', 'Сторно й сторнований документ не скасовують — внесіть нове коригування');
            t.set(settingsRef, { revision: FieldValue.increment(1) }, { merge: true });
            t.update(ref, { status: 'canceled', canceledBy: actor, canceledAt: FieldValue.serverTimestamp() });
            // Підтвердний документ відвʼязуємо від основного; скасований основний скасовує й підтвердні.
            if (fresh.data()?.linkedTo) t.update(db.doc(`expenses/${fresh.data().linkedTo}`), { linkedIds: FieldValue.arrayRemove(ref.id) });
            for (const lid of fresh.data()?.linkedIds || []) t.update(db.doc(`expenses/${lid}`), { status: 'canceled', canceledBy: actor, canceledAt: FieldValue.serverTimestamp() });
        });
        await audit(actor, role, 'expenses.cancel', `expenses/${e.id}`, `${e.supplierName}: № ${e.number} скасовано`);
        return { ok: true };
    }

    /** Відправити затверджений документ в Приват24 на підпис голови. */
    async function pay(actor, role, { id: eid, account }) {
        const e = await get(`expenses/${id(eid)}`, 'Документ');
        if (e.status !== 'approved') fail('failed-precondition', e.status === 'pending' ? 'Документ ще не затверджено' : 'Цей документ не чекає оплати');
        const supplier = await get(`suppliers/${e.supplierId}`, 'Постачальника');
        if (supplier.kind === 'person') fail('failed-precondition', 'Фізособі без ФОП платять як за ЦПД, з утриманням податків — не через «Витрати»');
        if (supplier.kind === 'fop' && !supplier.fopChecked) fail('failed-precondition', 'Позначте в картці постачальника, що витяг з ЄДР і КВЕД ФОП перевірено (п. 177.8 ПКУ)');
        if (!supplier.iban) fail('failed-precondition', 'У постачальника немає IBAN — додайте його в картці');
        return payments.actions.create(actor, role, {
            kind: 'supplier', recipient: { name: supplier.name, iban: supplier.iban, code: supplier.code },
            amountKop: core.remaining(e), purpose: core.purposeFor(e), account, proposalKey: `exp-${e.id}`, expenseId: e.id
        });
    }

    // --------------------------------------------------------
    // ЗВʼЯЗОК ЗІ СПИСАННЯМИ БАНКУ
    // --------------------------------------------------------
    /** Оновлення документа, коли до нього привʼязали списання (для батчу чи транзакції). */
    function linkUpdate(expense, txId, amountKop) {
        const paid = (expense.paidKop || 0) + amountKop;
        const due = expense.amountKop - (expense.stornoKop || 0);
        return { paidKop: paid, txIds: FieldValue.arrayUnion(txId), status: paid >= due ? 'paid' : 'approved',
            ...(paid >= due ? { paidAt: FieldValue.serverTimestamp() } : {}) };
    }

    async function linkTx(actor, role, { txId, expenseId }) {
        const txRef = db.doc(`bank_tx/${id(txId)}`);
        await lock?.assertOpen((await txRef.get()).data()?.period, 'Списання банку');
        const exRef = db.doc(`expenses/${id(expenseId)}`);
        const result = await db.runTransaction(async t => {
            const [txSnap, exSnap] = await Promise.all([t.get(txRef), t.get(exRef)]);
            if (!txSnap.exists || !exSnap.exists) fail('not-found', 'Операцію або документ не знайдено');
            const tx = txSnap.data(), e = exSnap.data();
            await lock?.assertOpen(tx.period, 'Списання банку', t);
            const payment = tx.paymentId ? await t.get(db.doc(`payments/${tx.paymentId}`)) : null;
            if (payment?.data()?.payroll) fail('failed-precondition', 'Зарплатний платіж не привʼязується до документа постачальника');
            if (tx.direction !== 'out') fail('invalid-argument', 'Привʼязати можна лише списання');
            if (tx.expenseId) fail('failed-precondition', 'Списання вже привʼязане до документа');
            if (tx.status === 'done' && tx.kind !== 'expense') fail('failed-precondition', 'Спершу поверніть операцію у «Вхідні»');
            if (e.status !== 'approved') fail('failed-precondition', 'Документ не затверджено або вже оплачено');
            if (tx.amountKop > core.remaining(e)) fail('invalid-argument', `Списання ${fromKop(tx.amountKop)} грн більше за залишок до сплати ${fromKop(core.remaining(e))} грн`);
            t.update(exRef, linkUpdate(e, txRef.id, tx.amountKop));
            t.update(txRef, { kind: 'expense', category: 'supplier', status: 'done', expenseId: exRef.id, auto: false, resolvedBy: actor, resolvedAt: FieldValue.serverTimestamp() });
            return { tx, e };
        });
        await audit(actor, role, 'expenses.link', `expenses/${exRef.id}`, `Списання ${fromKop(result.tx.amountKop)} грн → ${result.e.supplierName}, № ${result.e.number}`, { txId: txRef.id });
        return { ok: true };
    }

    /** Списання повернули у «Вхідні» (bank.js unassign) — документ знову чекає оплати. */
    async function release(tx, txId) {
        if (!tx?.expenseId) return;
        try {
            await db.runTransaction(async t => {
                const ref = db.doc(`expenses/${tx.expenseId}`);
                const snap = await t.get(ref);
                if (!snap.exists) return;
                const paid = Math.max(0, (snap.data().paidKop || 0) - tx.amountKop);
                t.update(ref, { paidKop: paid, txIds: FieldValue.arrayRemove(txId), status: 'approved', paidAt: null });
            });
        } catch (e) { logger.error('Повернення оплати документа', e); }
    }

    /** Для bank.js: постачальники й документи, що чекають оплати. */
    async function openForMatching() {
        const [suppliers, open] = await Promise.all([
            db.collection('suppliers').get(), db.collection('expenses').where('status', '==', 'approved').get()
        ]);
        return {
            suppliers: suppliers.docs.map(d => ({ id: d.id, code: d.data().code, iban: d.data().iban })),
            expenses: open.docs.map(d => ({ id: d.id, ...d.data() }))
        };
    }

    // --------------------------------------------------------
    // СТАН ДЛЯ КАБІНЕТУ
    // --------------------------------------------------------
    async function context() {
        const [suppliers, contracts, expenses, settings] = await Promise.all([
            db.collection('suppliers').orderBy('name').limit(500).get(),
            db.collection('contracts').orderBy('date', 'desc').limit(300).get(),
            db.collection('expenses').orderBy('date', 'desc').limit(400).get(),
            settingsRef.get()
        ]);
        const plain = d => {
            const out = { id: d.id, ...d.data() };
            for (const [k, v] of Object.entries(out)) if (v?.toDate) out[k] = v.toDate().toISOString();
            if (out.approval?.at?.toDate) out.approval = { ...out.approval, at: out.approval.at.toDate().toISOString() };
            return out;
        };
        const list = { suppliers: suppliers.docs.map(plain), contracts: contracts.docs.map(plain), expenses: expenses.docs.map(plain) };
        const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Kyiv' }).format(new Date());
        return { ...list, settings: { smallKop: settings.data()?.smallKop || 0 }, today,
            missing: core.missingDocs(list.contracts, list.expenses, today), items: core.ITEMS, docTypes: core.DOC_TYPES, kinds: core.SUPPLIER_KINDS,
            limitKop: core.CONTRACT_LIMIT_KOP };
    }

    async function setSettings(actor, role, { smallKop }) {
        if (role !== 'chair') fail('permission-denied', 'Поріг задає голова');
        const v = Number(smallKop);
        if (!Number.isInteger(v) || v < 0 || v > 2_000_000) fail('invalid-argument', 'Поріг — від 0 до 20 000 грн');
        await settingsRef.set({ smallKop: v, by: actor, at: FieldValue.serverTimestamp() }, { merge: true });
        await audit(actor, role, 'expenses.settings', 'expense_settings/main', `Дрібні витрати без договору до ${fromKop(v)} грн затверджує бухгалтер`, { smallKop: v });
        return { ok: true };
    }

    const expenseAction = onCall({ region: REGION, maxInstances: 4, timeoutSeconds: 60 }, callGuard('expenseAction', async request => {
        const actor = await requireAdmin(request, ['chair', 'accountant']);
        const role = await staffRole(actor);
        const data = request.data || {};
        switch (data.action) {
            case 'context': return context();
            case 'saveSupplier': return saveSupplier(actor, role, data);
            case 'saveContract': return saveContract(actor, role, data);
            case 'decideContract': return decideContract(actor, role, data);
            case 'endContract': return endContract(actor, role, data);
            case 'saveExpense': return saveExpense(actor, role, data);
            case 'decideExpense': return decideExpense(actor, role, data);
            case 'cancelExpense': return cancelExpense(actor, role, data);
            case 'linkExisting': return linkExisting(actor, role, data);
            case 'storno': return storno(actor, role, data);
            case 'pay': return pay(actor, role, data);
            case 'linkTx': return linkTx(actor, role, data);
            case 'settings': return setSettings(actor, role, data);
            default: fail('invalid-argument', 'Невідома дія');
        }
    }));

    return { expenseAction, linkUpdate, release, openForMatching,
        actions: { saveSupplier, saveContract, decideContract, endContract, saveExpense, decideExpense, cancelExpense, linkExisting, storno, pay, linkTx, setSettings, context } };
};
