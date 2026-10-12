import test,{before,after,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {clearAccounting,completeClosingPrerequisites} from './accounting-fixture.mjs';
const require=createRequire(new URL('../../functions/package.json',import.meta.url));
const {initializeApp,deleteApp}=require('firebase-admin/app');
const {getFirestore,FieldValue,Timestamp}=require('firebase-admin/firestore');
const OWN='UA213052990000026001234567890',DEP='UA273052990000026001234567800';
const A=['900','accountant'],C=['10','chair'];
let app,db,charges,bank,journal,payroll,reports;
before(()=>{
    app=initializeApp({projectId:'uspih-25-rules-test'},'accounting-foundation');db=getFirestore(app);
    const deps={db,FieldValue,Timestamp,requireAdmin:async()=>A[0],staffRole:async()=>A[1],notify:async()=>{},lock:require('./period-lock')(db)};
    charges=require('./charges')(deps);bank=require('./bank')({...deps,balances:charges});
    journal=require('./journal')({...deps,now:()=>new Date('2027-01-10T12:00:00Z')});
    const payments=require('./payments')(deps);payroll=require('./payroll')({...deps,payments});reports=require('./reports')({...deps,journal});
});
async function wipe(){await clearAccounting(db);for(const col of ['apartments','bank','bank_tx','bank_links','audit_log','charges','charges_runs','payroll_people','payroll_runs','payroll_settings','payments','journal_periods','expenses','suppliers','report_packages'])for(const d of(await db.collection(col).get()).docs)await db.recursiveDelete(d.ref);}
afterEach(wipe);after(async()=>{await wipe();await deleteApp(app);});
const get=async path=>(await db.doc(path).get()).data();
const tx=(id,extra={})=>({bankId:id,account:OWN,direction:'in',amountKop:500,at:new Date('2026-10-10T12:00:00Z'),currency:'UAH',purpose:'Внесок кв. 1',counterparty:{name:'Тест'},...extra});
const policy=(extra={})=>({startDate:'2026-10-01',defaultFund:'main',funds:[{id:'main',name:'Основний'}],reportingForm:'micro',basis:'Рішення правління, тест',approve:true,...extra});
async function seed(extra={}){await journal.actions.savePolicy(...C,policy(extra));await db.doc('apartments/1').set({area:50,personalAccount:'10001'});await db.doc('bank/settings').set({accounts:{[OWN]:{purpose:'current',currency:'UAH'}}},{merge:true});}

test('an arbitrary start date, late historical payments and resident balances agree without double counting',async()=>{
    await seed({startDate:'2025-03-15'});
    await charges.actions.addTariff(...A,{group:'res',rate:'1',from:'2025-03',decision:'Тестовий протокол'});
    await charges.actions.setOpening(...A,{rows:[{apt:'1',amountKop:-10000}]});
    const opening=await get('apartments/1/ledger/opening');
    assert.equal(opening.cutoffDate,'2025-03-15');assert.equal(require('./journal-core').kyivDate(opening.at),'2025-03-14');
    const historic={apt:'1',entryId:'legacy-late',at:'2025-03-14T21:30:00Z',period:'2025-03',kind:'payment',amountKop:99999,note:'Історична оплата, врахована у залишку'};
    await charges.actions.importHistory(...A,{rows:[historic]});await charges.actions.importHistory(...A,{rows:[historic]});
    await assert.rejects(charges.actions.importHistory(...A,{rows:[{...historic,amountKop:111}]}),/інші дані/);
    await assert.rejects(charges.actions.importHistory(...A,{rows:[{...historic,entryId:'active',at:'2025-03-15T00:00:00Z'}]}),/передувати/);
    await charges.actions.run(...A,{period:'2025-03'});
    await bank.storeTransactions([tx('new-payment',{at:new Date('2025-03-16T12:00:00Z')})],'mock',await bank.loadContext());
    const statement=await charges.actions.getStatement({period:'2025-03'});
    assert.deepEqual([statement.rows[0].opening,statement.rows[0].charged,statement.rows[0].paid,statement.rows[0].closing],[-10000,5000,500,-14500]);
    assert.equal((await get('apartments/1')).balance,-145);
    const view=await journal.actions.context({period:'2025-03'});
    assert.equal(view.tb.rows.find(r=>r.acc==='377').closeDr,14500);
    assert.equal(view.entries.filter(e=>e.dr==='311').reduce((s,e)=>s+e.kop,0),500);
});

test('closing requires approved opening and dated bank proof and freezes actual entries',async()=>{
    await seed();await charges.actions.addTariff(...A,{group:'res',rate:'1',from:'2026-10',decision:'Протокол'});
    await charges.actions.setOpening(...A,{rows:[{apt:'1',amountKop:-10000}]});await charges.actions.run(...A,{period:'2026-10'});
    await bank.storeTransactions([tx('paid')],'mock',await bank.loadContext());
    assert.ok((await journal.actions.context({period:'2026-10'})).checks.some(c=>c.level==='block'&&/Вхідну/.test(c.text)));
    await completeClosingPrerequisites(journal,db);
    const before=await journal.actions.context({period:'2026-10'});
    await assert.rejects(journal.actions.bankCut(...A,{period:'2026-10',rows:[{...before.bankRows[0],balanceKop:501}],note:'Хибна тестова виписка'}),/не збігаються/);
    await journal.actions.close(...A,{period:'2026-10'});
    const stored=await get('journal_periods/2026-10');assert.equal(stored.archiveVersion,1);
    await db.doc('bank_tx/late').set({id:'late',account:OWN,at:new Date('2026-10-30T12:00:00Z'),period:'2026-10',direction:'out',kind:'expense',category:'bank_fee',status:'done',amountKop:1});
    const closed=await journal.actions.context({period:'2026-10'});
    assert.deepEqual(closed.entries,before.entries);assert.equal(closed.tb.rows.find(r=>r.acc==='311').closeDr,500);
    assert.ok(closed.checks.some(c=>/змінились операції/.test(c.text)));
});
test('a transition month already charged in the old system cannot be billed a second time',async()=>{
    await seed({startDate:'2025-03-15'});await charges.actions.setOpening(...A,{rows:[{apt:'1',amountKop:-10000}]});
    await charges.actions.addTariff(...A,{group:'res',rate:'1',from:'2025-03',decision:'Протокол'});
    await charges.actions.importHistory(...A,{rows:[{apt:'1',entryId:'old-bill',at:'2025-03-01T12:00:00Z',period:'2025-03',kind:'charge',amountKop:5000}]});
    await assert.rejects(charges.actions.run(...A,{period:'2025-03'}),/попередні нарахування/);
    await charges.actions.confirmImportedStartMonth(...C,{note:'Повний місяць нараховано попереднім сервісом'});
    await assert.rejects(charges.actions.run(...A,{period:'2025-03'}),/повторне нарахування не потрібне/);
    const ctx=await journal.actions.context({period:'2025-03'});
    assert.equal(ctx.tb.rows.find(r=>r.acc==='377').closeDr,10000);
    assert.equal(ctx.checks.some(c=>/перенесене нарахування.*не відповідає/.test(c.text)),false);
    assert.equal((await get('apartments/1')).balance,-100);
    await db.doc('apartments/1/ledger/old-bill').delete();
    assert.ok((await journal.actions.context({period:'2025-03'})).checks.some(c=>/перенесене нарахування.*не відповідає/.test(c.text)));
});

test('changed final bank row preserves old postings until a chair reconciles and then credits the new amount once',async()=>{
    await seed();await charges.actions.setOpening(...A,{rows:[{apt:'1',amountKop:-10000}]});
    await bank.storeTransactions([tx('revision')],'mock',await bank.loadContext());
    const ref=(await db.collection('bank_tx').get()).docs[0].ref;
    assert.equal((await bank.storeTransactions([tx('revision',{amountKop:700})],'mock',await bank.loadContext())).conflicts,1);
    assert.equal((await get('apartments/1')).balance,-95);
    await assert.rejects(bank.bankAction.run({data:{action:'acceptChanged',txId:ref.id}}),/голова/);
    const chairBank=require('./bank')({db,FieldValue,Timestamp,requireAdmin:async()=>C[0],staffRole:async()=>C[1],balances:charges,lock:require('./period-lock')(db)});
    await chairBank.bankAction.run({data:{action:'acceptChanged',txId:ref.id}});
    assert.equal((await get('apartments/1')).balance,-100);
    await bank.actions.assign(...A,{txId:ref.id,allocations:[{apt:'1',amountKop:700}]});
    assert.equal((await get('apartments/1')).balance,-93);
    assert.equal((await bank.storeTransactions([tx('revision',{amountKop:700})],'mock',await bank.loadContext())).conflicts || 0,0);
    assert.equal((await db.collection('apartments/1/ledger').get()).docs.filter(d=>d.data().kind==='payment').length,1);
});

test('depreciation is capped at owned asset value and accrued rent is not recognized twice on bank receipt',async()=>{
    await seed();
    await journal.actions.saveOpening(...A,{lines:[{acc:'10',a:'PC-1',side:'dr',kop:10000},{acc:'48',a:'main',side:'cr',kop:10000}]});await journal.actions.approveOpening(...C);
    const d=await journal.notes.save(...A,{type:'depreciation',date:'2026-10-31',amountKop:1000,analytic:'PC-1',assetAcc:'10',source:'Акт введення ПК № 1',note:'Амортизація за жовтень'});
    await journal.notes.approve(...C,{id:d.id});
    const too=await journal.notes.save(...A,{type:'depreciation',date:'2026-10-31',amountKop:10000,analytic:'PC-1',assetAcc:'10',source:'Акт введення ПК № 1',note:'Надмірне списання'});
    await assert.rejects(journal.notes.approve(...C,{id:too.id}),/залишкову вартість/);
    const rent=await journal.notes.save(...A,{type:'rentAccrual',date:'2026-10-31',amountKop:5000,analytic:'tenant-1',source:'Договір оренди № 1',note:'Оренда за жовтень'});
    await journal.notes.approve(...C,{id:rent.id});
    await bank.storeTransactions([tx('rent',{amountKop:5000,purpose:'Оплата оренди'})],'mock',await bank.loadContext());
    const rentTx=(await db.collection('bank_tx').get()).docs[0];
    await bank.bankAction.run({data:{action:'matchNote',txId:rentTx.id,noteId:rent.id}});
    const view=await journal.actions.context({period:'2026-10'});
    assert.equal(view.tb.rows.find(r=>r.acc==='361').closeDr+view.tb.rows.find(r=>r.acc==='361').closeCr,0);
    assert.equal(view.entries.filter(e=>e.cr==='48'&&e.src!=='opening').reduce((s,e)=>s+e.kop,0),5000);
});

test('new-year payroll rates require explicit dates while approved old runs retain their own rates',async()=>{
    await payroll.actions.savePerson(...A,{name:'Працівник Тестовий',kind:'employee',salaryKop:864700,fte:1,mainJob:true,from:'2026-01-01',rnokpp:'3124567809',iban:DEP,taxNotified:true});
    await payroll.actions.saveRun(...A,{period:'2026-10',inputs:{}});await payroll.actions.approve(...C,{period:'2026-10'});
    await assert.rejects(payroll.actions.saveRun(...A,{period:'2027-01',inputs:{}}),/Немає ставок/);
    const defaults=require('./payroll-core').DEFAULT_RATES;
    await payroll.actions.saveRates(...C,{rates:[...defaults,{...defaults[0],from:'2027-01',to:'2027-12',pdfo:1700}],basis:'Фіктивні параметри тільки для тесту'});
    await payroll.actions.saveRun(...A,{period:'2027-01',inputs:{}});
    assert.equal((await get('payroll_runs/2027-01')).run.rate.pdfo,1700);
    assert.equal((await get('payroll_runs/2026-10')).run.rate.pdfo,1800);
});

test('year history is reconciled before approval and an archived report version stays unchanged',async()=>{
    await seed();
    await journal.actions.saveOpening(...A,{lines:[{acc:'311',a:OWN,side:'dr',kop:91000},{acc:'48',a:'main',side:'cr',kop:91000}]});await journal.actions.approveOpening(...C);
    const history={year:'2026',basis:'Звірка з попереднім тестовим обліком',openingLines:[{acc:'311',a:OWN,side:'dr',kop:100000},{acc:'48',a:'main',side:'cr',kop:100000}],
        entries:[{date:'2026-09-30',dr:'48',cr:'311',dA:'main',cA:OWN,kop:9000}],previousIncome:{incomeKop:10000,costKop:10000}};
    await reports.annualReports.importHistory(...A,history);await reports.annualReports.approveHistory(...C,{year:'2026'});
    const first=await reports.annualReports.snapshot(...A,{year:'2026'});
    const old=await reports.annualReports.packageData({id:first.id});
    await db.doc('bank_tx/interest').set({...tx('interest',{amountKop:1000}),period:'2026-10',kind:'income',category:'interest',status:'done'});
    const second=await reports.annualReports.snapshot(...A,{year:'2026'});
    assert.equal(second.version,first.version+1);
    assert.deepEqual((await reports.annualReports.packageData({id:first.id})).report,old.report);
    await reports.annualReports.importHistory(...A,{...history,entries:[{...history.entries[0],kop:8000}]});
    await assert.rejects(reports.annualReports.approveHistory(...C,{year:'2026'}),/не дає погоджену/);
    const part=db.doc(`annual_package_parts/${first.id}-0`);
    const entries=(await part.get()).data().entries;
    await part.update({entries:[{...entries[0],kop:entries[0].kop+1},...entries.slice(1)]});
    await assert.rejects(reports.annualReports.packageData({id:first.id}),/Контрольна сума/);
});
