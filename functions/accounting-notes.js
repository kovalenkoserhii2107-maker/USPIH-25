'use strict';
const { HttpsError }=require('firebase-functions/v2/https');
const { validDate }=require('./expenses-core');
const jcore=require('./journal-core');
const TYPES={fundTransfer:'Перенесення між фондами',depreciation:'Амортизація власного активу ОСББ',inventory:'Списання використаних запасів',rentAccrual:'Нарахування оренди / послуги покупцю',accrual:'Витрата з нарахованим зобовʼязанням',reverse:'Сторно бухгалтерської довідки'};
module.exports=function notes({db,FieldValue,lock,load}) {
    const fail=message=>{throw new HttpsError('failed-precondition',message);};
    const text=(v,n=300)=>String(v||'').trim().slice(0,n);
    async function context() {
        const rows=(await db.collection('accounting_notes').get()).docs.map(d=>({id:d.id,...d.data()}));
        return {types:TYPES,notes:rows.sort((a,b)=>b.date.localeCompare(a.date))};
    }
    async function save(actor,role,{type,date,amountKop,analytic,fromFund,toFund,assetAcc,source,note,reverseOf}) {
        if(!TYPES[type]||!validDate(date)||!Number.isSafeInteger(amountKop)||amountKop<=0||amountKop>100000000000||text(source).length<5||text(note).length<5)fail('Укажіть вид, дату, суму, підставу та пояснення бухгалтерської довідки');
        const period=date.slice(0,7),ref=db.collection('accounting_notes').doc();
        await db.runTransaction(async t=>{
            const data=await load(t),policy=data.policy;
            await lock?.assertOpen(period,'Бухгалтерська довідка',t);
            if(date<policy.startDate)fail('Раніші операції переносять через річний журнал');
            let line;
            const base={kop:amountKop};
            if(type==='fundTransfer') {
                if(fromFund===toFund||[fromFund,toFund].some(f=>!policy.funds.some(x=>x.id===f)))fail('Оберіть два різні фонди');
                line={...base,dr:'48',cr:'48',dA:fromFund,cA:toFund};
            } else if(type==='reverse') {
                const old=(await t.get(db.doc(`accounting_notes/${String(reverseOf||'').replace(/[^\w-]/g,'')}`))).data();
                if(old?.status!=='approved'||old.reversedBy||old.lines.length!==1||old.lines[0].kop!==amountKop)fail('Потрібна проведена довідка на ту саму суму, яку ще не сторновано');
                const l=old.lines[0];line={kop:l.kop,dr:l.cr,cr:l.dr,dA:l.cA||'',cA:l.dA||'',fund:l.fund||old.fundId};
            } else {
                if(text(analytic,200).length<2)fail('Укажіть інвентарний код, покупця або кредитора');
                const a=text(analytic,200);
                if(type==='depreciation') {
                    if(!['10','11'].includes(assetAcc))fail('Оберіть рахунок власного активу');
                    line={...base,dr:'92',cr:assetAcc==='10'?'131':'132',dA:'office',cA:a};
                }
                if(type==='inventory') {
                    if(!['20','22'].includes(assetAcc))fail('Оберіть рахунок запасів');
                    line={...base,dr:'92',cr:assetAcc,dA:'office',cA:a};
                }
                if(type==='rentAccrual') {const acc=policy.incomeAccounts.rent;line={...base,dr:'361',cr:acc,dA:a,cA:acc==='48'?policy.defaultFund:'rent'};}
                if(type==='accrual')line={...base,dr:'92',cr:'685',dA:'other',cA:a};
            }
            t.create(ref,{type,date,period,amountKop,analytic:text(analytic,200),assetAcc:assetAcc||null,lines:[line],fundId:policy.defaultFund,source:text(source),note:text(note),
                status:'draft',reverseOf:type==='reverse'?reverseOf:null,by:actor,at:FieldValue.serverTimestamp()});
            t.create(db.collection('audit_log').doc(),{actor,role,action:'accounting.note',target:ref.path,summary:'Бухгалтерську довідку підготовлено для погодження',details:{type,period,amountKop},at:FieldValue.serverTimestamp()});
        });
        return {ok:true,id:ref.id};
    }
    async function approve(actor,role,{id}) {
        if(role!=='chair')throw new HttpsError('permission-denied','Бухгалтерську довідку погоджує голова');
        await db.runTransaction(async t=>{
            const ref=db.doc(`accounting_notes/${String(id||'').replace(/[^\w-]/g,'')}`),data=await load(t),snap=await t.get(ref),doc=snap.data();
            if(data.policy.status!=='approved')fail('Спочатку погодьте параметри обліку');
            if(doc?.status!=='draft')fail('Довідку вже погоджено або не знайдено');
            await lock?.assertOpen(doc.period,'Бухгалтерська довідка',t);
            const tb=jcore.trialBalance(jcore.journal(data.input,doc.period),doc.period);
            const balance=(acc,a)=>{const r=tb.rows.find(x=>x.acc===acc)?.byA.find(x=>x.a===a);return (r?.closeDr||0)-(r?.closeCr||0);};
            if(doc.type==='depreciation') {
                const cost=balance(doc.assetAcc,doc.analytic),depreciated=-balance(doc.assetAcc==='10'?'131':'132',doc.analytic);
                if(doc.amountKop>cost-depreciated)fail('Амортизація перевищує залишкову вартість цього активу');
            }
            if(doc.type==='inventory'&&doc.amountKop>balance(doc.assetAcc,doc.analytic))fail('Немає такої кількості запасів у вартісному обліку');
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
