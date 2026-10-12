'use strict';
const {onCall,HttpsError}=require('firebase-functions/v2/https');
const core=require('./migration-core'),jcore=require('./journal-core'),annual=require('./annual-report-core');
const guard=require('./call-guard');
module.exports=function({db,FieldValue,Timestamp,requireAdmin,staffRole,charges,journal,reports}) {
 const fail=message=>{throw new HttpsError('failed-precondition',message);};
 function prepared(data){try{const p=core.prepare(data.files,data.startDate);const error=jcore.checkOpening(p.opening.filter(r=>!['377','631'].includes(r.acc)))||p.history&&annual.historyProblem(p.history,data.startDate.slice(0,4),data.startDate);if(error)fail(error);return p;}catch(e){if(e instanceof HttpsError)throw e;throw new HttpsError('invalid-argument',e.message,{issues:e.issues||[]});}}
 async function inspect(data){const p=prepared(data);return{hash:p.hash,summary:p.summary,bankRows:p.bankRows,startDate:p.startDate,unverifiedOwners:true};}
 async function step(actor,role,data){
  if(role!=='chair')throw new HttpsError('permission-denied','Початок обліку погоджує голова');
  const p=prepared(data);if(data.hash!==p.hash)fail('Файли змінилися після перевірки');
  if(String(data.basis||'').trim().length<5)fail('Укажіть джерело перенесення');
  const ref=db.doc(`migration_jobs/${p.hash}`),active=db.doc('migration_jobs/active');let job;
  const lease=db.collection('_').doc().id;
  await db.runTransaction(async t=>{const [old,other,apts,runs,opening,reset]=await Promise.all([t.get(ref),t.get(active),t.get(db.collection('apartments')),t.get(db.collection('charges_runs').limit(1)),t.get(db.doc('journal_opening/main')),t.get(db.doc('_maintenance/reset'))]);
   if(reset.data()?.active)fail('Триває очищення бази');
   if(other.data()?.active&&other.data().hash!==p.hash)fail('Спочатку завершіть попереднє перенесення');
   job=old.data();if(job?.busyUntil>Date.now())fail('Перенесення вже виконується в іншій вкладці');
   if(!job){if(apts.docs.some(d=>!d.data().isAdmin)||!runs.empty||opening.exists)fail('Перенесення початкової бази доступне лише до введення квартир, залишків і проводок. Поточні дані не замінюються');job={phase:'settings',cursor:0,hash:p.hash,actor,summary:p.summary,basis:String(data.basis).trim().slice(0,300)};}
   if(job.actor!==actor)fail('Перенесення має завершити голова, який його почав');
   t.set(ref,{...job,lease,busyUntil:Date.now()+600000,updatedAt:FieldValue.serverTimestamp()});t.set(active,{active:job.phase!=='done',hash:p.hash});
  });
  try{
   if(job.phase==='settings'){
    await journal.actions.savePolicy(actor,role,{startDate:p.startDate,funds:[{id:'main',name:'Внески на утримання будинку'}],defaultFund:'main',reportingForm:'unspecified',basis:job.basis,approve:false,bankAccounts:Object.fromEntries(p.bankRows.map(r=>[r.a,{acc:r.acc,agreement:'',maturity:''}]))});
    await db.doc('bank/settings').set({startDate:p.startDate,accounts:Object.fromEntries(p.bankRows.map(r=>[r.a,{purpose:r.acc==='311'?'current':'deposit',currency:'UAH',balanceKop:r.kop,balanceAt:Timestamp.fromDate(new Date(p.startDate+'T00:00:00Z')),available:false,name:'Перенесений рахунок'}]))},{merge:true});
    job.phase='apartments';
   }else if(job.phase==='apartments'){
    const reset=(await db.doc('_maintenance/reset').get()).data();
    const batch=db.batch();const rows=[];let writes=0;for(const a of p.apartments.slice(job.cursor,job.cursor+60)){if(writes+1+a.owners.length>450)break;rows.push(a);writes+=1+a.owners.length;}
    for(const a of rows){const r=db.doc(`apartments/${a.apt}`);batch.set(r,{area:a.area,residents:a.residents,entrance:a.entrance,personalAccount:a.account,balance:a.balanceKop/100,isAdmin:false,ownersStatus:'pending',migrationId:p.hash,authAfter:reset?.authCutoff||0,authKeeperUid:reset?.actor===a.apt?reset.keeperUid:''});
     for(let i=0;i<a.owners.length;i++)batch.set(r.collection('owners').doc(`import-${i}`),{...a.owners[i],source:'migration',status:'pending'});
    }
    job.cursor+=rows.length;if(job.cursor>=p.apartments.length){job.phase='sourceDocs';job.cursor=0;}
    batch.update(ref,{phase:job.phase,cursor:job.cursor});await batch.commit();
   }else if(job.phase==='sourceDocs'){
    const rows=[...p.suppliers.map(s=>({path:'suppliers/'+s.id,data:s})),...p.legacyExpenses.map(e=>({path:'expenses/'+e.id,data:{...e,fundId:'main'}}))].slice(job.cursor,job.cursor+200);const batch=db.batch();for(const r of rows)batch.set(db.doc(r.path),{...r.data,migrationId:p.hash});job.cursor+=rows.length;if(job.cursor>=p.suppliers.length+p.legacyExpenses.length){job.phase='opening';job.cursor=0;}batch.update(ref,{phase:job.phase,cursor:job.cursor});await batch.commit();
   }else if(job.phase==='opening'){
    await db.doc('charges/settings').set({premises:Object.fromEntries(p.apartments.map(a=>[a.apt,a.group]))},{merge:true});
    await charges.actions.setOpening(actor,role,{rows:p.apartments.map(a=>({apt:a.apt,amountKop:a.balanceKop}))});
    await journal.actions.saveOpening(actor,role,{lines:p.opening.filter(r=>!['377','631'].includes(r.acc))});job.phase='history';
   }else if(job.phase==='history'){
    const rows=p.apartmentHistory.slice(job.cursor,job.cursor+400);
    if(rows.length)await charges.actions.importHistory(actor,role,{rows});
    job.cursor+=rows.length;if(job.cursor>=p.apartmentHistory.length){job.phase='annual';job.cursor=0;}
   }else if(job.phase==='annual'){
    if(p.history)await reports.annualReports.importHistory(actor,role,{...p.history,year:p.startDate.slice(0,4),basis:job.basis});job.phase='done';
    await db.collection('audit_log').add({actor,role,action:'migration.complete',summary:'База з бухгалтерських CSV перенесена; параметри й ОСВ очікують погодження',details:p.summary,at:FieldValue.serverTimestamp()});
   }
   await ref.update({phase:job.phase,cursor:job.cursor,busyUntil:0,lease:FieldValue.delete()});if(job.phase==='done')await active.set({active:false,hash:p.hash});
   return{phase:job.phase,cursor:job.cursor,total:p.apartments.length,summary:p.summary,done:job.phase==='done'};
  }catch(e){await ref.update({busyUntil:0,error:String(e.message).slice(0,300),lease:FieldValue.delete()});throw e;}
 }
 const migrationAction=onCall({region:'europe-central2',maxInstances:2,timeoutSeconds:540,memory:'512MiB'},guard('migrationAction',async request=>{if(!request.auth?.uid||!request.auth.token?.email?.endsWith('@uspih-25.com'))throw new HttpsError('permission-denied','Потрібен службовий вхід у цей застосунок');const actor=await requireAdmin(request,['chair']);const role=await staffRole(actor);if(request.data?.action==='inspect')return inspect(request.data);if(request.data?.action==='step')return step(actor,role,request.data);throw new HttpsError('invalid-argument','Невідома дія');}));
 return{migrationAction,actions:{inspect,step}};
};
