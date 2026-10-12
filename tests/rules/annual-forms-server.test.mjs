import test,{before,after,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(new URL('../../functions/package.json',import.meta.url));
const {initializeApp,deleteApp}=require('firebase-admin/app'),{getFirestore,FieldValue}=require('firebase-admin/firestore');
const j=require('./journal-core');
if(!process.env.FIRESTORE_EMULATOR_HOST)throw new Error('Local emulator required');
let app,db,reports;const A=['900','accountant'],C=['298','chair'],blobs=new Map();
const bucket={file(path,{generation}={}){return{async getMetadata(){if(!blobs.has(path))throw Object.assign(new Error('missing'),{code:404});const b=blobs.get(path);return[{size:String(b.bytes.length),generation:b.generation}];},async download(){const b=blobs.get(path);if(!b||generation!==b.generation)throw new Error('Wrong generation');return[b.bytes];}};}};
function journalStub(){const policy={startDate:'2025-01-01',status:'approved',version:1,reportingForm:'micro',funds:[{id:'main',name:'Основний'}],incomeAccounts:{interest:'733'}};
 const input={start:'2025-01',startDate:policy.startDate,policy,opening:{status:'approved',lines:[{acc:'311',a:'bank',side:'dr',kop:100000},{acc:'48',a:'main',side:'cr',kop:100000}]},bankTx:[{id:'interest',period:'2025-12',at:new Date('2025-12-20T12:00:00Z'),account:'bank',direction:'in',kind:'income',category:'interest',status:'done',amountKop:1000}],expenses:[{id:'cost',date:'2025-12-10',period:'2025-12',amountKop:3000,item:'services',status:'approved',supplierName:'test'}]};
 const entries=j.journal(input,'2025-12'),closed=j.periodsUpTo('2025-12','2025-01');input.closedSnapshots=new Map(closed.map(p=>[p,entries.filter(e=>e.period===p)]));
 return{load:async()=>({input,closed,policy,opening:input.opening}),actions:{policy:async()=>policy}};
}
async function wipe(){for(const c of await db.listCollections())await db.recursiveDelete(c);blobs.clear();}
before(async()=>{app=initializeApp({projectId:'uspih-25-rules-test'},'annual-forms-server');db=getFirestore(app);await wipe();reports=require('./reports')({db,FieldValue,requireAdmin:async()=>'900',staffRole:async()=>'accountant',journal:journalStub(),reportBucket:bucket});});
afterEach(wipe);after(async()=>{await wipe();await deleteApp(app);});
async function prepareForms(){await db.doc('annual_comparatives/2025').set({status:'approved',incomeKop:200000,costKop:200000});const f=await reports.annualReports.forms({year:'2025'}),settings={financingTerm:'long',deposit351:'investment',noIncomeTax:true,noViolation:true,comparatives:{salesKop:0,operatingKop:200000,otherKop:0,costOfSalesKop:0,otherCostKop:0,otherOperatingCostKop:200000},assignments:{}};for(const g of f.calculation.sourceGroups)settings.assignments[g.id]={category:g.kind==='cost'?'maintenance':g.acc==='733'?'passive':'contributions',row:g.kind==='cost'?'2.3':g.acc==='733'?'1.7':'1.9'};return{year:'2025',sourceHash:f.sourceHash,settings,basis:'Тестова перевірка джерел'};}
test('annual forms: reviewed exact sources, concurrent immutable versions, corrections and stale approval rejection',async()=>{
 const p=await prepareForms();assert.equal((await reports.annualReports.forms(p)).reviewed,false);await assert.rejects(reports.annualReports.saveForms(...A,{...p,sourceHash:'stale'}),/змінилися/);await assert.rejects(reports.annualReports.saveForms(...A,{...p,settings:{...p.settings,noIncomeTax:false}}),/прибуток/);
 await reports.annualReports.saveForms(...A,p);const f=await reports.annualReports.forms(p);assert.equal(f.calculation.reviewReady,true,JSON.stringify(f.calculation.checks));
 const [first,second]=await Promise.all([reports.annualReports.snapshot(...A,{year:'2025',withForms:true,basis:'Первинний тестовий розрахунок'}),reports.annualReports.snapshot(...A,{year:'2025',withForms:true,basis:'Інший первинний розрахунок'})]);assert.deepEqual([first.version,second.version].sort(),[1,2]);
 const old=await reports.annualReports.packageData({id:first.id});assert.equal(old.type,'annual-calculation-forms');assert.equal(old.report.forms.npoTotals.incomeKop,4000);assert.equal(old.report.forms.npoTotals.costKop,3000);
 p.settings.comparatives.salesKop=50000;p.settings.comparatives.operatingKop-=50000;await reports.annualReports.saveForms(...A,p);
 await assert.rejects(reports.annualReports.snapshot(...A,{year:'2025',withForms:true,basis:'Виправлення',submissionKind:'correction',previousPackageId:'npo-2024--1'}),/попередню/);
 const correction=await reports.annualReports.snapshot(...A,{year:'2025',withForms:true,basis:'Виправлення порівняльних даних',submissionKind:'correction',previousPackageId:first.id});const revised=await reports.annualReports.packageData({id:correction.id});assert.equal(revised.previousPackageId,first.id);assert.notEqual(revised.hash,old.hash);assert.deepEqual(await reports.annualReports.packageData({id:first.id}),old);
 await assert.rejects(reports.actions.mark(...A,{key:'npo-2025',status:'accepted',packageId:first.id,regNumber:'old'}),/не є офіційним/);
 await db.doc('annual_comparatives/2025').update({incomeKop:200001});assert.equal((await reports.annualReports.forms(p)).calculation.reviewReady,false);await assert.rejects(reports.annualReports.saveForms(...A,p),/змінилися/);
});
function upload(key,name,bytes='external report'){const path=`reports/${key}/${name}`;blobs.set(path,{bytes:Buffer.from(bytes),generation:'123'});return{name,path};}
test('external annual filing: hash and generation, rejection, resubmission, own receipt and old acceptance preservation',async()=>{
 const key='npo-2025',files=[upload(key,'v1.xml')];const first=await reports.actions.externalAnnualPackage(...A,{key,files,basis:'Перевірено у зовнішньому сервісі'});let pack=await reports.actions.packageFiles({id:first.id});assert.equal(pack.type,'annual-external-filing');assert.equal(pack.files[0].generation,'123');assert.match(pack.files[0].sha256,/^[a-f0-9]{64}$/);
 await reports.actions.mark(...A,{key,status:'submitted',packageId:first.id});await reports.actions.mark(...A,{key,status:'rejected',note:'Виправити реквізити',addFiles:[{name:'reject.xml',path:`reports/${key}/reject.xml`,kind:'receipt2'}]});
 await assert.rejects(reports.actions.mark(...A,{key,status:'accepted',packageId:first.id}),/відмову/);
 const second=await reports.actions.externalAnnualPackage(...A,{key,files:[upload(key,'v2.xml','corrected')],basis:'Виправлено реквізити',submissionKind:'replacement',previousPackageId:first.id});
 await assert.rejects(reports.actions.mark(...A,{key,status:'accepted',packageId:second.id}),/саме цієї версії/);
 await assert.rejects(reports.actions.mark(...A,{key,status:'accepted',packageId:second.id,addFiles:[{name:'reject.xml',path:`reports/${key}/reject.xml`,kind:'receipt2'}]}),/Стара квитанція/);
 await reports.actions.mark(...A,{key,status:'submitted',packageId:second.id});await reports.actions.mark(...A,{key,status:'accepted',addFiles:[{name:'accept.xml',path:`reports/${key}/accept.xml`,kind:'receipt2'}]});
 const third=await reports.actions.externalAnnualPackage(...A,{key,files:[upload(key,'v3.pdf','correction')],basis:'Уточнення звіту',submissionKind:'correction',previousPackageId:second.id});
 await assert.rejects(reports.actions.mark(...A,{key,status:'accepted',packageId:third.id}),/саме цієї версії/);
 await reports.actions.mark(...A,{key,status:'submitted',packageId:third.id});const ctx=await reports.actions.context();assert.equal(ctx.statuses[key].packageId,third.id);assert.equal(ctx.statuses[key].files.length,0);assert.ok(ctx.submissionHistory.some(e=>e.key===key&&e.status==='accepted'&&e.packageId===second.id&&e.files[0].packageId===second.id));assert.ok(ctx.packages[key].every(p=>p.type==='annual-external-filing'&&p.filingReady));
 await reports.actions.mark(...A,{key,status:'accepted',regNumber:'NEW-REG'});await assert.rejects(reports.actions.mark(...A,{key,status:'open'}),/лише голова/);await reports.actions.mark(...C,{key,status:'open'});assert.ok((await reports.actions.context()).submissionHistory.some(e=>e.key===key&&e.status==='accepted'&&e.packageId===third.id));
});
test('external filing requires existing files in own report, correct previous filing and unchanged mark timestamps',async()=>{
 const key='fs-stat-2025';await assert.rejects(reports.actions.externalAnnualPackage(...A,{key,files:[{name:'x.xml',path:`reports/${key}/missing.xml`}],basis:'Перевірено'}),/не знайдено/);await assert.rejects(reports.actions.externalAnnualPackage(...A,{key,files:[upload('npo-2025','wrong.xml')],basis:'Перевірено'}),/теці/);
 const first=await reports.actions.externalAnnualPackage(...A,{key,files:[upload(key,'v1.xml')],basis:'Перевірено'});await assert.rejects(reports.actions.externalAnnualPackage(...A,{key,files:[upload(key,'v2.xml')],basis:'Перевірено',submissionKind:'correction',previousPackageId:'npo-2025--1'}),/цього року/);
 await reports.actions.mark(...A,{key,status:'submitted',packageId:first.id});const old=(await reports.actions.context()).statuses[key];await reports.actions.mark(...A,{key,status:'accepted',regNumber:'accepted'});await assert.rejects(reports.actions.mark(...C,{key,status:'submitted',seenAt:old.at}),/іншій вкладці/);
});

test('a financial-only external archive cannot collide with the paired annual worksheet versions',async()=>{
 const p=await prepareForms();await reports.annualReports.saveForms(...A,p);
 const external=await reports.actions.externalAnnualPackage(...A,{key:'fs-stat-2025',files:[upload('fs-stat-2025','external.pdf')],basis:'Перевірено у кабінеті'});assert.equal(external.version,1);
 const paired=await reports.annualReports.snapshot(...A,{year:'2025',withForms:true,basis:'Розрахунок після зовнішнього звіту'});assert.equal(paired.version,2);
 assert.equal((await reports.actions.packageFiles({id:external.id})).type,'annual-external-filing');assert.equal((await reports.annualReports.packageData({id:paired.id})).type,'annual-calculation-forms');
});
