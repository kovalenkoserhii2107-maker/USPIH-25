'use strict';
const { HttpsError }=require('firebase-functions/v2/https');
module.exports=function({db,FieldValue,lock}) {
    const fail=message=>{throw new HttpsError('failed-precondition',message);};
    const safe=x=>String(x||'').replace(/[^\w-]/g,'');
    function appropriate(tx,note) {return note.status==='approved'&&!note.reversedBy&&((tx.direction==='in'&&note.type==='rentAccrual')||(tx.direction==='out'&&note.type==='accrual'));}
    async function candidates({txId}) {
        const [txSnap,notes,paid]=await Promise.all([db.doc(`bank_tx/${safe(txId)}`).get(),db.collection('accounting_notes').get(),db.collection('bank_tx').get()]);
        const tx=txSnap.data();
        const unlinked = tx && tx.status === 'review' && (tx.reason === 'payroll-unlinked' || (!tx.expenseId && !tx.notePaymentId));
        if(!tx||tx.kind==='internal'||(tx.paymentId&&!unlinked)||tx.expenseId||tx.notePaymentId||tx.bankConflict||tx.bankVoided)return[];
        return notes.docs.filter(d=>appropriate(tx,d.data())).map(d=>{
            const n=d.data(),paidKop=paid.docs.filter(p=>p.data().notePaymentId===d.id&&!p.data().bankVoided&&p.data().status==='done').reduce((s,p)=>s+p.data().amountKop,0);
            return{id:d.id,date:n.date,analytic:n.analytic,note:n.note,leftKop:n.amountKop-paidKop};
        }).filter(n=>n.leftKop>=tx.amountKop).sort((a,b)=>b.date.localeCompare(a.date));
    }
    async function link(actor,role,{txId,noteId}) {
        const ref=db.doc(`bank_tx/${safe(txId)}`),nref=db.doc(`accounting_notes/${safe(noteId)}`);
        await db.runTransaction(async t=>{
            const [txSnap,noteSnap,paid]=await Promise.all([t.get(ref),t.get(nref),t.get(db.collection('bank_tx').where('notePaymentId','==',nref.id))]);
            const tx=txSnap.data(),n=noteSnap.data();
            const unlinked = tx && tx.status === 'review' && (tx.reason === 'payroll-unlinked' || (!tx.expenseId && !tx.notePaymentId));
            if(!tx||!n||tx.kind==='internal'||!appropriate(tx,n)||tx.currency!=='UAH'||(tx.paymentId&&!unlinked)||tx.expenseId||tx.notePaymentId||tx.bankConflict||tx.bankVoided||tx.allocations?.length)fail('Операцію або бухгалтерську довідку не можна привʼязати');
            await lock?.assertOpen(tx.period,'Рознесення за бухгалтерською довідкою',t);
            const paidKop=paid.docs.filter(p=>!p.data().bankVoided&&p.data().status==='done').reduce((s,p)=>s+p.data().amountKop,0);
            if(tx.amountKop>n.amountKop-paidKop)fail('Оплата перевищує невиплачений залишок довідки');
            t.update(ref,{kind:tx.direction==='in'?'income':'expense',category:tx.direction==='in'?'rent':'other',status:'done',notePaymentId:nref.id,reason:FieldValue.delete(),method:'note',resolvedBy:actor,resolvedAt:FieldValue.serverTimestamp()});
            t.create(db.collection('audit_log').doc(),{actor,role,action:'bank.note',target:ref.path,summary:'Оплата погасила нарахування за бухгалтерською довідкою',details:{noteId:nref.id,amountKop:tx.amountKop},at:FieldValue.serverTimestamp()});
        });
        return{ok:true};
    }
    return{candidates,link};
};
