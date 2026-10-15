'use strict';
const { HttpsError }=require('firebase-functions/v2/https');
const { validDate }=require('./expenses-core');
const jcore=require('./journal-core');
const policyStoreFactory=require('./accounting-policy');
const TYPES={fundTransfer:'Перенесення між фондами',depreciation:'Амортизація власного активу ОСББ',inventory:'Списання використаних запасів / МШП',assetDisposal:'Ліквідація (списання) ОЗ / МНМА (Акт ОЗ-3)',rentAccrual:'Нарахування оренди / послуги покупцю',accrual:'Витрата з нарахованим зобовʼязанням',reverse:'Сторно бухгалтерської довідки'};
module.exports=function notes({db,FieldValue,lock,load}) {
    const fail=message=>{throw new HttpsError('failed-precondition',message);};
    const text=(v,n=300)=>String(v||'').trim().slice(0,n);
    const policyStore=policyStoreFactory.create({db,FieldValue});
    async function context() {
        const rows=(await db.collection('accounting_notes').get()).docs.map(d=>({id:d.id,...d.data()}));
        return {types:TYPES,notes:rows.sort((a,b)=>b.date.localeCompare(a.date))};
    }
    async function save(actor,role,{type,date,amountKop,analytic,fromFund,toFund,assetAcc,source,note,reverseOf}) {
        if(!TYPES[type]||!validDate(date)||!Number.isSafeInteger(amountKop)||amountKop<=0||amountKop>100000000000||text(source).length<5||text(note).length<5)fail('Укажіть вид, дату, суму, підставу та пояснення бухгалтерської довідки');
        const period=date.slice(0,7),ref=db.collection('accounting_notes').doc();
        await db.runTransaction(async t=>{
            const policy=await policyStore.context(t);
            await lock?.assertOpen(period,'Бухгалтерська довідка',t);
            if(date<policy.startDate)fail('Раніші операції переносять через річний журнал');
            let lines;
            const base={kop:amountKop};
            if(type==='fundTransfer') {
                if(fromFund===toFund||[fromFund,toFund].some(f=>!policy.funds.some(x=>x.id===f)))fail('Оберіть два різні фонди');
                lines=[{...base,dr:'48',cr:'48',dA:fromFund,cA:toFund}];
            } else if(type==='reverse') {
                const old=(await t.get(db.doc(`accounting_notes/${String(reverseOf||'').replace(/[^\w-]/g,'')}`))).data();
                if(old?.status!=='approved'||old.reversedBy||!Array.isArray(old.lines)||!old.lines.length||old.amountKop!==amountKop)fail('Потрібна проведена довідка на ту саму суму, яку ще не сторновано');
                lines=old.lines.map(l=>({kop:l.kop,dr:l.cr,cr:l.dr,dA:l.cA||'',cA:l.dA||'',...(l.qty?{qty:-l.qty}:{}),fund:l.fund||old.fundId}));
            } else {
                if(text(analytic,200).length<2)fail('Укажіть інвентарний код, покупця або кредитора');
                const a=text(analytic,200);
                if(type==='depreciation') {
                    if(!['10','11'].includes(assetAcc))fail('Оберіть рахунок власного активу');
                    lines=[{...base,dr:'92',cr:assetAcc==='10'?'131':'132',dA:'office',cA:a}];
                }
                if(type==='inventory') {
                    if(!['20','22'].includes(assetAcc))fail('Оберіть рахунок запасів');
                    lines=[{...base,dr:'92',cr:assetAcc,dA:'office',cA:a}];
                }
                if(type==='rentAccrual') {const acc=policy.incomeAccounts.rent;lines=[{...base,dr:'361',cr:acc,dA:a,cA:acc==='48'?policy.defaultFund:'rent'}];}
                if(type==='accrual')lines=[{...base,dr:'92',cr:'685',dA:'other',cA:a}];
            }
            if(!lines?.length)fail('Не вдалося сформувати проводку для довідки');
            t.create(ref,{type,date,period,amountKop,analytic:text(analytic,200),assetAcc:assetAcc||null,lines,fundId:policy.defaultFund,source:text(source),note:text(note),
                status:'draft',reverseOf:type==='reverse'?reverseOf:null,by:actor,at:FieldValue.serverTimestamp()});
            t.create(db.collection('audit_log').doc(),{actor,role,action:'accounting.note',target:ref.path,summary:'Бухгалтерську довідку підготовлено для погодження',details:{type,period,amountKop},at:FieldValue.serverTimestamp()});
        });
        return {ok:true,id:ref.id};
    }
    async function approve(actor,role,{id}) {
        if(role!=='chair')throw new HttpsError('permission-denied','Бухгалтерську довідку погоджує голова');
        const ref=db.doc(`accounting_notes/${String(id||'').replace(/[^\w-]/g,'')}`);
        const data=await load();
        if(data.policy.status!=='approved')fail('Спочатку погодьте параметри обліку');
        await db.runTransaction(async t=>{
            const [snap,policy]=await Promise.all([t.get(ref),policyStore.context(t)]);
            const doc=snap.data();
            if(policy.status!=='approved')fail('Спочатку погодьте параметри обліку');
            if(doc?.status!=='draft')fail('Довідку вже погоджено або не знайдено');
            await lock?.assertOpen(doc.period,'Бухгалтерська довідка',t);
            const tb=jcore.trialBalance(jcore.journal(data.input,doc.period),doc.period);
            const balance=(acc,a)=>{const r=tb.rows.find(x=>x.acc===acc)?.byA.find(x=>x.a===a);return (r?.closeDr||0)-(r?.closeCr||0);};
            if(doc.type==='depreciation'&&doc.analytic) {
                const cost=balance(doc.assetAcc,doc.analytic),depreciated=-balance(doc.assetAcc==='10'?'131':'132',doc.analytic);
                if(doc.amountKop>cost-depreciated)fail('Амортизація перевищує залишкову вартість цього активу');
            }
            if(doc.type==='inventory'&&doc.analytic&&doc.amountKop>balance(doc.assetAcc,doc.analytic))fail('Немає такої кількості запасів у вартісному обліку');
            if(doc.type==='fundTransfer'&&doc.amountKop>-balance('48',doc.lines[0].dA))fail('Перенесення перевищує залишок фонду');
            const oldRef=doc.reverseOf?db.doc(`accounting_notes/${doc.reverseOf}`):null,old=oldRef?await t.get(oldRef):null;
            if(oldRef&&(old.data()?.status!=='approved'||old.data().reversedBy))fail('Довідку вже сторновано або її стан змінився');
            if(oldRef)t.update(oldRef,{reversedBy:ref.id});
            t.update(ref,{status:'approved',approvedBy:actor,approvedAt:FieldValue.serverTimestamp()});
            t.create(db.collection('audit_log').doc(),{actor,role,action:'accounting.note.approve',target:ref.path,summary:'Бухгалтерську довідку проведено',details:{type:doc.type,period:doc.period},at:FieldValue.serverTimestamp()});
        });
        return {ok:true};
    }
    return {context,save,approve};
};
