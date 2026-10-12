import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFile} from 'node:fs/promises';
import {initializeTestEnvironment,assertFails,assertSucceeds} from '@firebase/rules-unit-testing';
import {doc,getDoc,getDocs,collectionGroup,query,where,setDoc} from 'firebase/firestore';
const require=createRequire(new URL('../../functions/package.json',import.meta.url));
const {initializeApp,deleteApp}=require('firebase-admin/app'),{getFirestore,FieldValue,Timestamp}=require('firebase-admin/firestore');
if(!process.env.FIRESTORE_EMULATOR_HOST)throw new Error('Local emulator only');
let app,db,service;const oldFetch=globalThis.fetch;
before(async()=>{app=initializeApp({projectId:'uspih-25-rules-test'},'private-accounting-test');db=getFirestore(app);for(const c of await db.listCollections())await db.recursiveDelete(c);service=require('./accounting-test')({db,FieldValue,Timestamp,requireAdmin:async request=>{if(!['chair','accountant'].includes(request.auth.token.role))throw new Error('Permission denied');return request.auth.token.email.split('@')[0];}});globalThis.fetch=async(url,...args)=>{if(/^http:\/\/(?:127\.0\.0\.1|localhost):\d+\//.test(String(url)))return oldFetch(url,...args);throw new Error('A training action must never make a live HTTP request');};});
after(async()=>{for(const c of await db.listCollections())await db.recursiveDelete(c);await deleteApp(app);globalThis.fetch=oldFetch;});
const request=(uid,data,role='chair')=>({auth:{uid,token:{email:'298@uspih-25.com',role}},data});
test('legacy public demo start directs the user to isolated books before writing anything',async()=>{
 const legacy=require('./demo')({db,FieldValue,Timestamp,requireAdmin:async()=>'298',staffRole:async()=>'chair'});
 await assert.rejects(legacy.demoAction.run(request('legacy',{action:'run'})),e=>e.code==='failed-precondition'&&e.message.includes('accounting-test.html'));
 assert.equal((await db.doc('demo/state').get()).exists,false);
});
test('private three-month accounting cycle preserves production and another user, retries do not duplicate records',async()=>{
 await db.doc('apartments/298').set({balance:123.45,personalAccount:'PRODUCTION'});await db.doc('apartments/298/owners/real').set({name:'Production owner'});await db.doc('apartments/298/ledger/real').set({kind:'payment',period:'2026-10',amount:123.45});await db.doc('bank_secrets/privat').set({token:'PRODUCTION-NOT-FOR-TRAINING'});await db.doc('finance/current').set({sentinel:'production'});
 const run=data=>service.handle(request('user_A',data));
 await assert.rejects(service.handle(request('bad',{action:'prepare'},'board')),/Permission/);await assert.rejects(service.handle({...request('bad',{action:'prepare'}),auth:{uid:'bad',token:{email:'298@other.test',role:'chair'}}}),/службовий/);
 let status=await run({action:'status'});assert.equal(status.ready,false);assert.equal(status.premises,0);
 await run({action:'prepare'});status=await run({action:'prepare'});assert.equal(status.premises,302);assert.equal(status.owners,447);
 await assert.rejects(run({action:'saveToken',value:'a real token'}),/Невідома/);
 const other=service.engine('user_B','298');await other.db.doc('apartments/298').set({balance:77});await other.db.doc('apartments/298/ledger/only').set({kind:'payment',amount:77,period:'2025-10'});
 const scoped=service.engine('user_A','298').db;assert.equal((await db.collectionGroup('owners').get()).size,1);assert.equal((await scoped.collectionGroup('owners').get()).size,447);assert.equal((await other.db.collectionGroup('ledger').get()).size,1);
 await assert.rejects(scoped.runTransaction(async t=>t.set(db.doc('apartments/298'),{balance:0})),/поза тестовою/);
 let result;
 for(const period of ['2025-10','2025-11','2025-12']){
  await assert.rejects(run({action:'close',period}),/Завершіть/);
  for(const action of ['charge','services','bank','payroll','settle','close']){await run({action,period});await run({action,period});}
  result=await run({action:'verify',period});assert.ok(result.checks.every(c=>c.ok),JSON.stringify(result.checks));
 }
 await run({action:'publish'});result=await run({action:'verify',period:'2025-12'});assert.equal(result.complete,true);assert.ok(result.checks.every(c=>c.ok),JSON.stringify(result.checks));assert.equal(result.annual.summary.costKop,5960000);assert.equal(result.annual.summary.incomeKop,6110000);assert.equal(result.annual.summary.balanceDiff,0);assert.equal(result.review.length,0);
 const pack=await run({action:'archive'});assert.equal(pack.report.summary.resultKop,150000);assert.ok(pack.report.complete);
 const forms=await run({action:'formsCycle'});assert.ok(forms.checks.every(c=>c.ok),JSON.stringify(forms.checks));assert.equal(forms.first.report.forms.npoTotals.incomeKop,6110000);assert.equal(forms.first.report.forms.npoTotals.costKop,5960000);assert.equal(forms.correction.previousPackageId,forms.first.id);assert.equal((await run({action:'formsCycle'})).correction.id,forms.correction.id);
 const apartment=await run({action:'apartment',apt:'298'});assert.equal(apartment.area,64);assert.equal(apartment.owners.length,2);assert.ok(apartment.ledger.length>6);
 assert.deepEqual((await db.doc('apartments/298').get()).data(),{balance:123.45,personalAccount:'PRODUCTION'});assert.equal((await db.doc('bank_secrets/privat').get()).data().token,'PRODUCTION-NOT-FOR-TRAINING');assert.equal((await db.doc('finance/current').get()).data().sentinel,'production');assert.equal((await other.db.doc('apartments/298').get()).data().balance,77);
 await run({action:'reset',uid:'user_B'});assert.equal((await run({action:'status'})).premises,0);assert.equal((await db.collectionGroup('owners').get()).size,1);assert.equal((await other.db.collectionGroup('ledger').get()).size,1);assert.equal((await db.doc('apartments/298').get()).data().balance,123.45);
});
test('manual receipt without purpose remains in inbox, allocation updates only training apartment and duplicate reference is safe',async()=>{
 const run=data=>service.handle(request('user_C',data,'accountant'));await run({action:'prepare'});const scoped=service.engine('user_C','298').db;
 const before=(await scoped.doc('apartments/298').get()).data().balance;const receipt={action:'manualPayment',key:'MANUAL-1',period:'2025-10',apt:'298',amount:'100,00',recognize:false};await run(receipt);await run(receipt);
 let v=await run({action:'verify',period:'2025-10'});assert.equal(v.review.length,1);assert.equal((await scoped.doc('apartments/298').get()).data().balance,before);
 await assert.rejects(run({...receipt,amount:'200'}),/інші дані/);
 await run({action:'assign',txId:v.review[0].id,apt:'298',amountKop:10000});v=await run({action:'verify',period:'2025-10'});assert.equal(v.review.length,0);assert.equal(v.baseline,false);assert.ok(v.checks.every(c=>c.ok),JSON.stringify(v.checks));assert.equal((await scoped.doc('apartments/298').get()).data().balance,before+100);
});
test('client SDK cannot read or write private training roots/groups even as the real chair',async()=>{
 await db.doc('staff/298').set({role:'chair',active:true});
 const env=await initializeTestEnvironment({projectId:'uspih-25-rules-test',firestore:{rules:await readFile('firestore.rules','utf8')}});
 try{const client=env.authenticatedContext('user_C',{email:'298@uspih-25.com'}).firestore();
  await assertSucceeds(getDoc(doc(client,'apartments/298')));
  await assertFails(getDoc(doc(client,'sandbox~user_C~apartments/298')));
  await assertFails(setDoc(doc(client,'sandbox~user_C~bank_secrets/privat'),{token:'real'}));
  await assertFails(getDocs(query(collectionGroup(client,'sandbox_owners'),where('_sandboxUid','==','user_C'))));
 }finally{await env.cleanup();}
});
