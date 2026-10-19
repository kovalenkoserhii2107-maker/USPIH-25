'use strict';
// Зв'язок виписки із затвердженою відомістю. Жодних запитів на переказ грошей.
const { HttpsError } = require('firebase-functions/v2/https');
const core = require('./payroll-core');
const identity = require('./payroll-payment-core');
const { normIban } = require('./bank-core');
const fail = (message) => { throw new HttpsError('failed-precondition', message); };
const live = p => ['paid', 'sent', 'sending', 'unknown'].includes(p.status) || p.canceling;

module.exports = function settlements({ db, FieldValue, lock }) {
    function planFor(stored, stage, settings, code) {
        return stored.stages?.[stage]?.plan || core.stagePayments(core.paymentRun(stored), stage, { code, taxes: settings.taxes });
    }
    function paidFor(payments, period, stage, row) {
        const who = identity.planRecipient(row);
        return payments.filter(p => p.payroll?.period === period && p.payroll.stage === stage
            && p.payroll.key === who.key && identity.recipientType(p) === who.recipientType && live(p));
    }
    async function candidates({ txId, period }) {
        const [txSnap, runs, settings, finance, paySnap] = await Promise.all([
            db.doc(`bank_tx/${String(txId || '').replace(/[^\w-]/g, '')}`).get(), db.collection('payroll_runs').where('status', '==', 'approved').get(),
            db.doc('payroll_settings/main').get(), db.doc('osbb_settings/finance').get(), db.collection('payments').get()
        ]);
        const tx = txSnap.data();
        const original=tx?.paymentId?paySnap.docs.find(d=>d.id===tx.paymentId)?.data():null;
        if (!tx || tx.direction !== 'out' || tx.kind==='internal' || tx.paymentId&&original?.payroll || tx.paymentId&&(!original||original.status!=='paid'||!['salary','tax'].includes(original.kind)) || tx.expenseId || tx.bankVoided || tx.bankConflict) return [];
        const payments = paySnap.docs.map(d => d.data());
        return runs.docs.flatMap(d => {
            const stored = d.data();
            if (period && d.id !== period) return [];
            return ['advance', 'final'].flatMap(stage => {
                if (stage === 'advance' && stored.stages?.final) return [];
                if (stage === 'final' && stored.stages?.advance?.complete === false) return [];
                return planFor(stored, stage, settings.data() || {}, finance.data()?.edrpou || '').flatMap(row => {
                    const paid = paidFor(payments, d.id, stage, row);
                    if (paid.some(p => p.status !== 'paid' || p.canceling)) return [];
                    const leftKop = row.amountKop - paid.reduce((s, p) => s + p.amountKop - (p.returnedKop || 0), 0);
                    const who = identity.planRecipient(row);
                    const samePerson=who.recipientType==='person'&&tx.counterparty?.code===row.recipient.code;
                    if (leftKop < tx.amountKop || !samePerson&&normIban(row.recipient.iban) !== normIban(tx.counterparty?.account)) return [];
                    const runRow = stored.run.rows.find(r => r.personId === who.key);
                    const grossKop = who.recipientType === 'person' ? core.paymentRun(stored).rows.find(r => r.personId === who.key)[stage].grossKop : null;
                    return [{ period: d.id, stage, ...who, name: row.recipient.name, leftKop, amountKop: tx.amountKop, grossKop,
                        requiresGross: who.recipientType === 'person' && (tx.amountKop !== row.amountKop || paid.length > 0), kind: runRow?.kind || 'tax' }];
                });
            });
        }).sort((a, b) => b.period.localeCompare(a.period));
    }
    async function link(actor, role, { txId, period, stage, key, recipientType, paidGrossKop, withheldPdfoKop, withheldVzKop, note }) {
        if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(String(period)) || !['advance', 'final'].includes(stage) || !['person', 'tax'].includes(recipientType)) fail('Оберіть відомість, етап і отримувача');
        const txRef = db.doc(`bank_tx/${String(txId || '').replace(/[^\w-]/g, '')}`), runRef = db.doc(`payroll_runs/${period}`);
        let linkedId=`external-${txRef.id}`;
        await db.runTransaction(async t => {
            const txSnap=await t.get(txRef),tx=txSnap.data();
            const payRef=db.doc(`payments/${tx?.paymentId || linkedId}`);linkedId=payRef.id;
            const [runSnap, settings, finance, paySnap, existing] = await Promise.all([
                t.get(runRef), t.get(db.doc('payroll_settings/main')), t.get(db.doc('osbb_settings/finance')),
                t.get(db.collection('payments').where('payroll.period', '==', period)), t.get(payRef)
            ]);
            const stored = runSnap.data();
            if (existing.exists && tx?.paymentId === payRef.id && existing.data().payroll?.period === period && existing.data().payroll.stage === stage && existing.data().payroll.key === key) return;
            const upgrading=tx?.paymentId&&existing.exists&&!existing.data().payroll&&['salary','tax'].includes(existing.data().kind)&&existing.data().status==='paid'&&existing.data().txId===txRef.id&&!existing.data().returnedKop;
            if (!tx || tx.direction !== 'out' || tx.kind==='internal' || tx.currency !== 'UAH' || tx.paymentId&&!upgrading || tx.expenseId || tx.bankVoided || tx.bankConflict || tx.allocations?.length) fail('Списання вже привʼязане або його потрібно звірити з банком');
            await lock?.assertOpen(tx.period, 'Рознесення зарплатної оплати', t);
            const originalPeriod=await t.get(db.doc(`journal_periods/${period}`));
            if(['closed','closing'].includes(originalPeriod.data()?.status)&&stage==='advance')fail('Для закритого місяця вказуйте остаточний розрахунок; часткова оплата не змінює старі нарахування');
            if (stored?.status !== 'approved' || stored.sending || stored.canceling) fail('Потрібна затверджена відомість без поточної відправки');
            if ((stage === 'advance' && stored.stages?.final) || (stage === 'final' && stored.stages?.advance?.complete === false)) fail('Спершу завершіть попередній етап');
            const plan = planFor(stored, stage, settings.data() || {}, finance.data()?.edrpou || '');
            const row = identity.findPlan({ plan }, { key, recipientType });
            if (!row) fail('Отримувача немає у відомості');
            const paid = paySnap.docs.map(d => ({ id: d.id, ...d.data() }));
            const related = paidFor(paid, period, stage, row);
            if (related.some(p => p.status !== 'paid' || p.canceling)) fail('Є платіж на підписі або з невідомим результатом. Спершу звірте його');
            if(related.some(p=>p.returnedKop>0&&p.returnedKop<p.amountKop))fail('Часткове повернення виплати потребує окремого розподілу доходу та утримань');
            const left = row.amountKop - related.reduce((s, p) => s + p.amountKop - (p.returnedKop || 0), 0);
            if (!Number.isSafeInteger(tx.amountKop) || tx.amountKop <= 0 || tx.amountKop > left) fail('Списання перевищує невиплачений залишок');
            const sameIban=normIban(row.recipient.iban)===normIban(tx.counterparty?.account);
            const samePerson=recipientType==='person'&&tx.counterparty?.code===row.recipient.code;
            if (!sameIban&&!samePerson || (tx.counterparty?.code && row.recipient.code !== tx.counterparty.code)) fail('Реквізити отримувача не відповідають відомості');
            if(!sameIban&&String(note||'').trim().length<5)fail('Поясніть виплату цій фізособі на інший IBAN');
            const partial = recipientType === 'person' && (related.length > 0 || tx.amountKop !== row.amountKop);
            const run = core.paymentRun(stored);
            const part=recipientType === 'person' ? run.rows.find(r => r.personId === key)[stage] : null;
            const expectedGross = part?.grossKop || 0;
            const previousGross = related.reduce((s, p) => s + (p.returnedKop ? 0 : (p.paidGrossKop ?? (p.amountKop === row.amountKop ? expectedGross : 0))), 0);
            const gross = recipientType === 'person' ? (partial ? Number(paidGrossKop) : expectedGross) : 0;
            if (recipientType === 'person' && (!Number.isSafeInteger(gross) || gross < tx.amountKop || gross > expectedGross - previousGross
                || (tx.amountKop === left && gross !== expectedGross - previousGross))) fail('Укажіть начислений дохід цієї виплати; після останньої виплати сума має збігтись з відомістю');
            if (partial && String(note || '').trim().length < 5) fail('Для часткової виплати поясніть розподіл нарахованого доходу');
            const taxParts={pdfoKop:partial?Number(withheldPdfoKop):part?.pdfoKop || 0,vzKop:partial?Number(withheldVzKop):part?.vzKop || 0};
            if(recipientType==='person') {
                const old=related.filter(p=>!p.returnedKop);
                for(const [field,value] of Object.entries(taxParts)) {
                    const prop=field==='pdfoKop'?'withheldPdfoKop':'withheldVzKop';
                    const used=old.reduce((s,p)=>s+(p[prop] ?? (p.amountKop===row.amountKop?part[field]:0)),0);
                    if(!Number.isSafeInteger(value)||value<0||value>part[field]-used||tx.amountKop===left&&value!==part[field]-used)fail('Розподіл утримань має збігатися із затвердженим етапом');
                }
                if(gross!==tx.amountKop+taxParts.pdfoKop+taxParts.vzKop)fail('Нарахований дохід цієї виплати має дорівнювати сумі на руки + ПДФО + ВЗ');
            }
            const meta = { period, stage, ...identity.planRecipient(row) };
            const payment={ kind: row.kind, recipient: {...row.recipient,iban:tx.counterparty.account}, account: tx.account, amountKop: tx.amountKop, purpose: tx.purpose,
                payroll: meta, status: 'paid', source: 'bank', txId: txRef.id, paidAt: tx.at, createdAt: FieldValue.serverTimestamp(), createdBy: actor,
                ...(recipientType === 'person' ? { paidGrossKop: gross,withheldPdfoKop:taxParts.pdfoKop,withheldVzKop:taxParts.vzKop } : {}), settlementNote: String(note || '').trim().slice(0, 300) };
            if(upgrading)t.set(payRef,{...existing.data(),...payment,createdAt:existing.data().createdAt || FieldValue.serverTimestamp(),createdBy:existing.data().createdBy || actor},{merge:true});
            else t.create(payRef,payment);
            t.update(txRef, { kind: 'expense', category: row.kind === 'salary' ? 'salary' : key === 'esv' ? 'esv' : 'taxes', status: 'done',
                paymentId: payRef.id, method: 'payroll', auto: false, resolvedBy: actor, resolvedAt: FieldValue.serverTimestamp() });
            const s = stored.stages?.[stage] || {};
            const allPaid = [...paid, { ...meta, payroll: meta, amountKop: tx.amountKop, status: 'paid' }];
            const completed = { ...(s.completed || {}) };
            const states = plan.map(p => {
                const list = paidFor(allPaid, period, stage, p);
                const sum = list.reduce((n, x) => n + x.amountKop - (x.returnedKop || 0), 0);
                if (sum === p.amountKop && p.key === row.key) completed[p.key] = payRef.id;
                return sum === p.amountKop;
            });
            const complete = states.every(Boolean);
            t.update(runRef, { [`stages.${stage}`]: { ...s, plan, external: true, account: s.account || tx.account, complete,
                completed, payments: [...new Set([...(s.payments || []), payRef.id])], at: new Date().toISOString(), by: actor },
                ...(stage === 'advance' ? { paidAdvance: Object.fromEntries(run.rows.map(r => [r.personId, r.advance])) } : {}) });
            t.create(db.collection('audit_log').doc(), { actor, role, action: 'bank.payroll', target: txRef.path,
                summary: 'Проведене в банку списання привʼязане до відомості; новий переказ не створено', details: { period, stage, paymentId: payRef.id, paidGrossKop: gross }, at: FieldValue.serverTimestamp() });
        });
        return { ok: true, id: linkedId };
    }
    return { candidates, link };
};
