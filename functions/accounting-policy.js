'use strict';
let HttpsError; try { ({ HttpsError } = require('firebase-functions/v2/https')); } catch { HttpsError = class HttpsError extends Error { constructor(code, message) { super(message); this.code = code; } }; }
const { validDate } = require('./expenses-core');
const DEFAULT = { startDate:'2026-10-01', defaultFund:'main', funds:[{id:'main',name:'Основний фонд — утримання будинку'}],
    incomeAccounts:{rent:'48',equipment:'48',interest:'48',grant:'48',refund:'48',other:'48',sick_fund:'378'},
    mnhmaLimitKop: 2000000, reportingForm:'unspecified', status:'draft', version:1 };
function read(data) {
    const mnhmaLimitKop = Number.isInteger(Number(data?.mnhmaLimitKop)) && Number(data?.mnhmaLimitKop) > 0
        ? Number(data.mnhmaLimitKop)
        : DEFAULT.mnhmaLimitKop;
    return {...DEFAULT,...data,mnhmaLimitKop,incomeAccounts:{...DEFAULT.incomeAccounts,...data?.incomeAccounts},funds:data?.funds?.length?data.funds:DEFAULT.funds};
}
const previousDay = date => new Date(Date.parse(`${date}T12:00:00Z`)-86400000).toISOString().slice(0,10);
function bankAccount(account, policy) {
    return policy?.bankAccounts?.[account]?.acc || '311';
}
module.exports = { DEFAULT, read, previousDay, bankAccount, create: function({db,FieldValue}) {
    const ref=db.doc('accounting_settings/main');
    async function context(transaction) { return read((await (transaction?transaction.get(ref):ref.get())).data()); }
    async function save(actor,role,data) {
        if(role!=='chair') throw new HttpsError('permission-denied','Налаштування обліку затверджує голова');
        const funds=(Array.isArray(data.funds)?data.funds:DEFAULT.funds).map(f=>({id:String(f.id||'').trim(),name:String(f.name||'').trim().slice(0,100)}));
        if(!validDate(data.startDate)||data.startDate<'2000-01-01'||data.startDate>'2100-12-31') throw new HttpsError('invalid-argument','Укажіть дату початку обліку');
        if(!funds.length||funds.length>20||funds.some(f=>!/^[a-z][\w-]{0,39}$/.test(f.id)||!f.name)||new Set(funds.map(f=>f.id)).size!==funds.length) throw new HttpsError('invalid-argument','Фонди: унікальні коди й назви, до 20');
        if(!funds.some(f=>f.id===data.defaultFund)) throw new HttpsError('invalid-argument','Оберіть основний фонд');
        if(!['unspecified','micro','small','full'].includes(data.reportingForm)) throw new HttpsError('invalid-argument','Оберіть форму фінзвітності');
        const incomeAccounts={...DEFAULT.incomeAccounts,...data.incomeAccounts};
        if(Object.entries(incomeAccounts).some(([key,acc])=>!Object.hasOwn(DEFAULT.incomeAccounts,key)||!['48','703','719','733','378'].includes(acc))) throw new HttpsError('invalid-argument','Невідома схема обліку доходу');
        if(incomeAccounts.sick_fund!=='378') throw new HttpsError('invalid-argument','Лікарняні ПФУ обліковуються окремо на 378');
        const mnhmaLimitKop = data.mnhmaLimitKop !== undefined && data.mnhmaLimitKop !== null && data.mnhmaLimitKop !== ''
            ? Number(data.mnhmaLimitKop)
            : DEFAULT.mnhmaLimitKop;
        if (!Number.isInteger(mnhmaLimitKop) || mnhmaLimitKop < 100000 || mnhmaLimitKop > 100000000) {
            throw new HttpsError('invalid-argument', 'Вартісний поріг МНМА має бути від 1 000 до 1 000 000 грн (за замовчуванням 20 000 грн за пп. 14.1.138 ПКУ)');
        }
        const bankAccounts={};
        for(const [iban,a] of Object.entries(data.bankAccounts||{})) {
            if(!/^UA\d{27}$/.test(iban)||!['311','313','351','143'].includes(a.acc)||a.maturity&&!validDate(a.maturity)) throw new HttpsError('invalid-argument','Перевірте рахунок обліку та дату завершення депозиту');
            bankAccounts[iban]={acc:a.acc,maturity:a.maturity||'',agreement:String(a.agreement||'').trim().slice(0,200)};
        }
        const approved=data.approve===true;
        if(approved&&String(data.basis||'').trim().length<5) throw new HttpsError('invalid-argument','Укажіть підставу затвердження облікової політики (наказ або рішення)');
        await db.runTransaction(async t=>{
            const [oldSnap,closed,runs,payroll,opening,charges,expenses,operation]=await Promise.all([t.get(ref),t.get(db.collection('journal_periods')),
                t.get(db.collection('charges_runs')),t.get(db.collection('payroll_runs')),t.get(db.doc('journal_opening/main')),t.get(db.doc('charges/settings')),
                t.get(db.collection('expenses')),t.get(db.doc('charges/operation'))]);
            const old=read(oldSnap.data());
            if(operation.data()?.active&&operation.data().until>Date.now()) throw new HttpsError('aborted','Дочекайтеся завершення переносу залишків або нарахувань');
            const protectedPeriods=closed.docs.filter(d=>['closed','closing'].includes(d.data().status));
            const baseChanged=data.startDate!==old.startDate || data.defaultFund!==old.defaultFund || JSON.stringify(incomeAccounts)!==JSON.stringify(old.incomeAccounts)
                || old.funds.some(f=>!funds.some(x=>x.id===f.id));
            const changedBank=[...new Set([...Object.keys(bankAccounts),...Object.keys(old.bankAccounts || {})])].some(iban=>(bankAccounts[iban]?.acc || '311')!==(old.bankAccounts?.[iban]?.acc || '311')
                && protectedPeriods.some(d=>d.data().tb?.some(r=>r.byA?.some(x=>x.a===iban))));
            if(protectedPeriods.length&&(baseChanged||changedBank)) throw new HttpsError('failed-precondition','Схема впливає на вже закриті періоди. Потрібен окремий перехід; архів не переписується');
            if(data.startDate!==old.startDate&&(runs.size||payroll.docs.some(d=>d.data().status==='approved')||opening.data()?.status==='approved'||charges.data()?.opening?.set||expenses.docs.some(d=>['approved','paid'].includes(d.data().status)))) throw new HttpsError('failed-precondition','Дата початку вже використана у проведених операціях. Змінюйте її до переносу залишків і затвердження документів');
            t.set(ref,{startDate:data.startDate,startPeriod:data.startDate.slice(0,7),startAt:new Date(`${data.startDate}T00:00:00Z`),defaultFund:data.defaultFund,funds,incomeAccounts,bankAccounts,mnhmaLimitKop,reportingForm:data.reportingForm,
                basis:String(data.basis||'').trim().slice(0,500),status:approved?'approved':'draft',version:(old.version||0)+1,by:actor,at:FieldValue.serverTimestamp()});
            t.set(db.doc('charges/settings'),{startPeriod:data.startDate.slice(0,7),startDate:data.startDate},{merge:true});
            t.set(db.doc('bank/settings'),{startDate:data.startDate},{merge:true});
            t.create(db.collection('audit_log').doc(),{actor,role,action:'accounting.policy',target:ref.path,summary:approved?'Облікову політику затверджено':'Параметри обліку збережено для погодження',
                details:{startDate:data.startDate,funds:funds.map(f=>f.id),mnhmaLimitKop,version:(old.version||0)+1},at:FieldValue.serverTimestamp()});
        });
        return {ok:true};
    }
    return {context,save};
} };
