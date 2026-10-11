import test, { before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
const require = createRequire(new URL('../../functions/package.json', import.meta.url));
const { initializeApp, deleteApp } = require('firebase-admin/app');
const { getFirestore, FieldValue, Timestamp } = require('firebase-admin/firestore');
const privat = require('./privat');
const payrollCore = require('./payroll-core');
const journalCore = require('./journal-core');
const bankCore = require('./bank-core');
if (!process.env.FIRESTORE_EMULATOR_HOST) throw new Error('Only the local Firestore emulator is allowed');
const OWN = 'UA213052990000026001234567890', PAYEE = 'UA273052990000026001234567800';
const iban = n => { const b = `305299000002600123456789${n}`; return `UA${String(98 - Number(BigInt(b + '301000') % 97n)).padStart(2, '0')}${b}`; };
const SECOND = iban(9);
const tax = n => ({ name: 'ГУК Тест', iban: iban(n), code: '37607526' });
const A = ['900', 'accountant'], C = ['901', 'chair'];
const originalFetch = globalThis.fetch;
const originals = Object.fromEntries(['createPayment','deletePayment','fetchBalances','fetchTransactions','isReady'].map(k => [k, privat[k]]));
let app, db, payments, payroll, bank, reports, journal, calls;
before(async () => {
    app = initializeApp({ projectId: 'uspih-25-rules-test' }, 'bank-payroll-regressions');
    db = getFirestore(app);
    const deps = { db, FieldValue, Timestamp, requireAdmin: async () => '900', staffRole: async () => 'accountant', notify: async () => {} };
    const lock = require('./period-lock')(db);
    const charges = require('./charges')({ ...deps, lock });
    payments = require('./payments')({ ...deps, lock });
    payroll = require('./payroll')({ ...deps, payments, lock });
    bank = require('./bank')({ ...deps, lock, balances: charges });
    reports = require('./reports')(deps);
    journal = require('./journal')({ ...deps, lock });
    await wipe();
});
async function wipe() {
    Object.assign(privat, originals); globalThis.fetch = originalFetch;
    for (const col of ['apartments','bank','bank_secrets','bank_tx','bank_links','payments','payroll_people','payroll_runs','payroll_settings','osbb_settings','audit_log','journal_periods',
        'journal_opening','charges','charges_runs','reports','expenses','suppliers']) {
        const snap = await db.collection(col).get();
        await Promise.all(snap.docs.map(d => db.recursiveDelete(d.ref)));
    }
}
afterEach(wipe);
after(async () => { await wipe(); await deleteApp(app); });
const action = data => bank.bankAction.run({ data });
const snapshot = async path => (await db.doc(path).get()).data();
const docs = async col => (await db.collection(col).get()).docs.map(d => ({ id: d.id, ...d.data() }));
const balance = (account, amountKop = 0, currency = 'UAH') => ({ iban: account, currency, balanceKop: amountKop, name: 'Тестовий рахунок', at: new Date() });
const tx = (id, extra = {}) => ({ bankId: id, account: OWN, at: new Date('2026-10-11T09:00:00Z'),
    direction: 'in', currency: 'UAH', amountKop: 10000, purpose: 'Внесок кв. 1', counterparty: { name: 'Тестовий власник' }, ...extra });
async function seedBank() {
    calls = [];
    privat.createPayment = async (_, p) => { calls.push(p); return { bankRef: `B${calls.length}`, paymentRef: `R${calls.length}`, status: 'new' }; };
    privat.deletePayment = async () => true;
    privat.isReady = async () => true;
    privat.fetchBalances = async () => [balance(OWN)];
    privat.fetchTransactions = async () => [];
    await db.doc('bank/settings').set({ startDate: '2026-10-01', accounts: { [OWN]: { purpose: 'current', currency: 'UAH', balanceKop: 0 } } });
    await db.doc('bank_secrets/privat').set({ token: 'LOCAL-MOCK-NO-NETWORK' });
    await db.doc('osbb_settings/finance').set({ edrpou: '40562894' });
    await db.doc('apartments/1').set({ area: 64, personalAccount: '10001' });
}
async function seedPayroll(personId = 'e1') {
    await seedBank();
    await payroll.actions.savePerson(...A, { id: personId, name: 'Працівник Тестовий', kind: 'employee', salaryKop: 864700,
        fte: 1, mainJob: true, from: '2026-01-01', rnokpp: '3124567809', iban: PAYEE, taxNotified: true });
    await payroll.actions.saveSettings(...A, { advancePct: 50, taxes: { pdfo: tax(3), vz: tax(4), esv: tax(5) } });
    await payroll.actions.saveRun(...A, { period: '2026-10', inputs: {} });
    await payroll.actions.approve(...C, { period: '2026-10' });
}
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }

test('token rotation keeps historical accounts but only imports accounts accessible to the new token', async () => {
    await seedBank();
    privat.fetchBalances = async () => [balance(SECOND,25000)];
    assert.equal((await action({action:'saveToken',token:'LOCAL-NEW-TOKEN-WITH-ONE-ACCOUNT'})).accounts,1);
    const settings=await snapshot('bank/settings');
    assert.equal(settings.accounts[OWN].available,false); assert.equal(settings.accounts[SECOND].available,true);
    assert.equal(settings.accounts[OWN].purpose,'current');
    const requested=[];
    privat.fetchTransactions=async (_,q)=>{requested.push(q.iban); if(q.iban===OWN) throw new Error('Unavailable old account'); return [tx('new-account',{account:SECOND})];};
    assert.equal((await action({action:'sync'})).added,1);
    assert.deepEqual(requested,[SECOND]);
    assert.equal((await docs('apartments/1/ledger')).reduce((s,e)=>s+e.amountKop,0),10000);
    await assert.rejects(payments.actions.create(...A,{kind:'salary',recipient:{name:'Тест',iban:PAYEE,code:'3124567809'},account:OWN,
        amountKop:10000,purpose:'Заробітна плата за місяць'}),/доступний гривневий/);
});

test('payroll rejects EUR and inaccessible accounts and selects the available UAH current account', async () => {
    await seedPayroll();
    await db.doc('bank/settings').set({accounts:{[OWN]:{purpose:'current',currency:'EUR'},[SECOND]:{purpose:'current',currency:'UAH',available:false}},startDate:'2026-10-01'});
    await assert.rejects(payroll.actions.pay(...A,{period:'2026-10',stage:'final'}),/немає поточного/);
    assert.equal(calls.length,0);
    await db.doc('bank/settings').update({[`accounts.${SECOND}.available`]:true});
    assert.equal((await payroll.actions.pay(...A,{period:'2026-10',stage:'final'})).ok,true);
    assert.equal(calls.length,4); assert.ok(calls.every(p=>p.account===SECOND&&privat.paymentBody(p).payment_ccy==='UAH'));
    assert.equal(calls.reduce((s,p)=>s+p.amountKop,0),1054934);
});

test('a failed account does not block the following account and retry preserves credits exactly once', async () => {
    await seedBank();
    await db.doc('bank/settings').set({accounts:{[SECOND]:{purpose:'reserve',currency:'UAH'}}},{merge:true});
    privat.fetchBalances=async()=>[balance(OWN,10000),balance(SECOND,20000)];
    let failing=true; const requested=[];
    privat.fetchTransactions=async(_,q)=>{requested.push(q.iban);if(q.iban===OWN&&failing)throw new Error('First account failed');
        return [tx(q.iban===OWN?'first':'second',{account:q.iban,amountKop:q.iban===OWN?10000:20000})];};
    const first=await action({action:'sync'});
    assert.equal(first.partial,true); assert.equal(first.added,1); assert.deepEqual(requested,[OWN,SECOND]);
    const partial=await snapshot('bank/settings');
    assert.equal(partial.accounts[OWN].lastSync.ok,false); assert.equal(partial.accounts[SECOND].lastSync.ok,true);
    assert.equal(partial.accounts[SECOND].balanceKop,20000);
    failing=false;
    assert.equal((await action({action:'sync'})).added,1);
    const ledger=await docs('apartments/1/ledger');
    assert.equal(ledger.length,2); assert.equal(ledger.reduce((s,e)=>s+e.amountKop,0),30000);
    assert.equal((await snapshot('bank/settings')).lastSync.ok,true);
});

test('account purpose edits survive a synchronization that read the previous purpose', async () => {
    await seedBank();
    const entered=deferred(), release=deferred();
    privat.fetchTransactions=async()=>{entered.resolve();await release.promise;return [];};
    const syncing=action({action:'sync'});
    try { await entered.promise;await action({action:'setAccount',iban:OWN,purpose:'reserve'});release.resolve();await syncing;
        assert.equal((await snapshot('bank/settings')).accounts[OWN].purpose,'reserve');
    } finally {release.resolve();await syncing.catch(()=>{});}
});

test('an imported contribution voided by the bank removes its ledger credit and cash posting', async () => {
    await seedBank();
    const charges=require('./charges')({db,FieldValue,Timestamp,requireAdmin:async()=>A[0],staffRole:async()=>A[1]});
    await charges.actions.setOpening(...A,{rows:[{apt:'1',amountKop:-50000}]});
    let voided=false;
    privat.fetchBalances=async()=>[balance(OWN,voided?0:10000)];
    privat.fetchTransactions=originals.fetchTransactions;
    globalThis.fetch=async()=>new Response(JSON.stringify({transactions:[{REF:'void-ref',REFN:'1',TRANTYPE:'C',SUM:'100.00',DAT_OD:'11.10.2026',TIM_P:'09:00',
        CCY:'UAH',FL_REAL:'r',PR_PR:voided?'t':'r',OSND:'Внесок кв. 1'}],exist_next_page:false}));
    await action({action:'sync'}); assert.equal((await snapshot('apartments/1')).balance,-400);
    voided=true; await action({action:'sync'});
    assert.equal((await snapshot('apartments/1')).balance,-500);
    assert.equal((await docs('apartments/1/ledger')).filter(e=>e.kind==='payment').length,0);
    assert.equal((await docs('bank_tx'))[0].bankVoided,true);
    await assert.rejects(bank.actions.unassign(...A,{txId:(await docs('bank_tx'))[0].id}),/Сторно банку/);
    assert.equal((await journal.actions.context({period:'2026-10'})).entries.filter(e=>e.src==='bank').length,0);
    await action({action:'sync'}); assert.equal((await snapshot('apartments/1')).balance,-500);
});

test('a bank void in a closed period preserves the closed ledger and surfaces a blocking conflict', async () => {
    await seedBank();
    const original=tx('closed-void');
    await bank.storeTransactions([original],'mock',await bank.loadContext());
    await db.doc('journal_periods/2026-10').set({status:'closed'});
    const result=await bank.storeTransactions([{...original,void:true}],'mock',await bank.loadContext());
    assert.equal(result.conflicts,1); assert.equal((await docs('apartments/1/ledger')).length,1);
    assert.equal((await docs('bank_tx'))[0].bankConflict,'void');
    assert.ok((await journal.actions.context({period:'2026-10'})).checks.some(c=>c.level==='block'&&/сторно/.test(c.text)));
    assert.ok((await reports.actions.payrollData({period:'2026-10'})).checks.some(c=>c.level==='block'&&/сторно/.test(c.text)));
    await db.doc('journal_periods/2026-10').set({status:'open'});
    await bank.storeTransactions([{...original,void:true}],'mock',await bank.loadContext());
    assert.equal((await docs('apartments/1/ledger')).length,0);
    assert.equal((await docs('bank_tx'))[0].bankConflict,undefined);
});

test('cancellation reserves the payroll stage before bank deletion and prevents concurrent resume', async () => {
    await seedPayroll();
    const create=privat.createPayment;
    let rejectOnce=true;
    privat.createPayment=async(token,p)=>{if(p.recipient.iban===tax(3).iban&&rejectOnce){rejectOnce=false;throw Object.assign(new Error('Tax rejected once'),{bankRejected:true});}return create(token,p);};
    assert.equal((await payroll.actions.pay(...A,{period:'2026-10',stage:'final'})).ok,false);
    const salaryId=(await docs('payments')).find(p=>p.kind==='salary').id;
    const entered=deferred(),release=deferred();const deleted=[];
    privat.deletePayment=async(_,ref)=>{entered.resolve();await release.promise;deleted.push(ref);return true;};
    const canceling=payments.actions.cancel(...A,{id:salaryId});
    try {
        await entered.promise;
        assert.ok((await snapshot('payroll_runs/2026-10')).canceling);
        await assert.rejects(payroll.actions.pay(...A,{period:'2026-10',stage:'final'}),/скасування/);
        await assert.rejects(payments.actions.cancel(...A,{id:salaryId}),/скасовується/);
        assert.equal(calls.length,1);
        release.resolve();assert.equal((await canceling).deletedInBank,true);
        assert.deepEqual(deleted,['R1']);assert.equal((await snapshot(`payments/${salaryId}`)).status,'canceled');
        assert.equal((await snapshot('payroll_runs/2026-10')).stages.final.complete,false);
        assert.equal((await payroll.actions.pay(...A,{period:'2026-10',stage:'final'})).ok,true);
        const active=(await docs('payments')).filter(p=>p.status==='sent');
        assert.equal(active.length,4);assert.equal(active.filter(p=>p.kind==='salary').length,1);
        assert.equal((await snapshot('payroll_runs/2026-10')).canceling,undefined);
    } finally {release.resolve();await canceling.catch(()=>{});}
});

test('uncertain deletion blocks resending until the chair confirms the draft is absent', async () => {
    await seedPayroll();await payroll.actions.pay(...A,{period:'2026-10',stage:'final'});
    const salary=(await docs('payments')).find(p=>p.kind==='salary');
    privat.deletePayment=async()=>{throw new Error('Mock: deletion response lost');};
    await assert.rejects(payments.actions.cancel(...A,{id:salary.id}),/результат видалення/);
    assert.equal((await snapshot(`payments/${salary.id}`)).status,'unknown');
    assert.equal((await snapshot('payroll_runs/2026-10')).canceling,undefined);
    const callsBefore=calls.length;
    assert.equal((await payroll.actions.pay(...A,{period:'2026-10',stage:'final'})).ok,false);
    assert.equal(calls.length,callsBefore);
    await payments.actions.resolve(...C,{id:salary.id,outcome:'not_created',reason:'Чернетки немає у Приват24, перевірено'});
    assert.equal((await snapshot(`payments/${salary.id}`)).status,'canceled');
    assert.equal((await payroll.actions.pay(...A,{period:'2026-10',stage:'final'})).ok,true);
    assert.equal(calls.length,callsBefore+1);
});

test('the real client loader includes old pending payments beyond 200 history rows without duplicates', async () => {
    await seedBank();const batch=db.batch();
    for(const status of ['sent','unknown','sending'])batch.set(db.doc(`payments/old-${status}`),{status,amountKop:10000,createdAt:Timestamp.fromDate(new Date('2026-10-02T00:00:00Z'))});
    for(let i=0;i<200;i++)batch.set(db.doc(`payments/paid-${i}`),{status:'paid',createdAt:Timestamp.fromDate(new Date(Date.parse('2026-10-03T00:00:00Z')+i*60000))});
    await batch.commit();
    const source=readFileSync(new URL('../../js/buh-data.js',import.meta.url),'utf8');
    const body=source.match(/export const loadPayments = \(\) => once\('payments', async \(\) => \{([\s\S]*?)\n\}\);/)[1];
    const load=new Function('db','getDocs','query','collection','orderBy','limit','where',`return (async()=>{${body}})();`);
    const rows=await load(db,q=>q.get(),(ref,...cs)=>cs.reduce((r,c)=>c(r),ref),(d,n)=>d.collection(n),
        (f,d)=>r=>r.orderBy(f,d),n=>r=>r.limit(n),(f,op,v)=>r=>r.where(f,op,v));
    assert.equal(rows.length,203);assert.equal(new Set(rows.map(p=>p.id)).size,203);
    assert.deepEqual(rows.filter(p=>p.status!=='paid').map(p=>p.status).sort(),['sending','sent','unknown']);
});

test('a person named esv has a distinct payment from the ESV tax and stays separate in journal, reports and UI', async () => {
    await seedPayroll('esv');
    assert.equal((await payroll.actions.pay(...A,{period:'2026-10',stage:'final'})).ok,true);
    assert.equal(calls.length,4);
    const stored=await snapshot('payroll_runs/2026-10');
    assert.equal(new Set(stored.stages.final.plan.map(p=>p.key)).size,4);
    assert.ok(stored.stages.final.completed['final:person:esv']);
    assert.ok(stored.stages.final.completed['final:tax:esv']);
    const salary=(await docs('payments')).find(p=>p.kind==='salary');
    await bank.storeTransactions([tx('esv-person-wage',{direction:'out',amountKop:salary.amountKop,purpose:salary.purpose,dlr:salary.bankRef,
        counterparty:{name:salary.recipient.name,account:salary.recipient.iban,code:salary.recipient.code}})],'mock',await bank.loadContext());
    const posting=(await journal.actions.context({period:'2026-10'})).entries.find(e=>e.src==='bank'&&e.cr==='311');
    assert.equal(posting.dr,'661');
    const report=await reports.actions.payrollData({period:'2026-10'});
    assert.equal(report.summary.paidKop,864700);assert.equal(report.summary.esvPaidKop,0);
    const ctx=await payroll.actions.context({period:'2026-10'});
    const ui=await import('../../js/payroll-view-core.js');
    assert.equal(ui.personPayments(ctx.payments,'esv').length,1);
    assert.equal(ui.payrollTotals(ctx).netPaidKop,665819);assert.equal(ui.payrollTotals(ctx).taxPaidKop,0);
});

test('payment creation rejects changed payroll account, kind and purpose and another proposal cannot duplicate a row', async () => {
    await seedPayroll();await payroll.actions.pay(...A,{period:'2026-10',stage:'final'});
    await db.doc('bank/settings').set({accounts:{[SECOND]:{purpose:'reserve',currency:'UAH'}}},{merge:true});
    const row=(await snapshot('payroll_runs/2026-10')).stages.final.plan.find(p=>p.kind==='salary');
    const data={...row,account:OWN,proposalKey:'different-client-key',payroll:{period:'2026-10',stage:'final',key:'e1',recipientType:'person'}};
    for(const changes of [{account:SECOND},{kind:'other'},{purpose:'Інший платіж замість зарплати'}])
        await assert.rejects(payments.actions.create(...A,{...data,...changes}),/повністю відповідати/);
    await assert.rejects(payments.actions.create(...A,data),/уже відправлено/);
    assert.equal(calls.length,4);assert.equal((await docs('payments')).filter(p=>p.kind==='salary').length,1);
});

async function returnedSalary() {
    await seedPayroll();await payroll.actions.pay(...A,{period:'2026-10',stage:'final'});
    const salary=(await docs('payments')).find(p=>p.kind==='salary');
    const counterparty={name:salary.recipient.name,account:salary.recipient.iban,code:salary.recipient.code};
    await db.doc(`bank_links/${bankCore.payerKey(counterparty.name,counterparty.account)}`).set({apt:'1'});
    await bank.storeTransactions([
        tx('salary-paid',{direction:'out',amountKop:salary.amountKop,purpose:salary.purpose,dlr:salary.bankRef,counterparty}),
        tx('salary-return',{direction:'in',amountKop:salary.amountKop,purpose:'Повернення заробітної плати. Помилкове зарахування, кв. 1.',counterparty})
    ],'mock',await bank.loadContext());
    const rows=await docs('bank_tx');
    return {salary,outgoing:rows.find(r=>r.bankId==='salary-paid'),incoming:rows.find(r=>r.bankId==='salary-return')};
}

test('a return from a remembered resident waits for matching and then consistently reverses salary and reporting', async () => {
    const {salary,outgoing,incoming}=await returnedSalary();
    assert.equal(incoming.status,'review');assert.equal(incoming.reason,'possible-refund');
    assert.equal((await docs('apartments/1/ledger')).length,0);
    assert.ok((await reports.actions.payrollData({period:'2026-10'})).checks.some(c=>c.level==='block'&&/можливе повернення/.test(c.text)));
    await bank.actions.refund(...A,{txId:incoming.id,refundOf:outgoing.id,reason:'bounce'});
    assert.equal((await snapshot(`payments/${salary.id}`)).returnedKop,665819);
    assert.equal((await reports.actions.payrollData({period:'2026-10'})).summary.paidKop,0);
    const postings=(await journal.actions.context({period:'2026-10'})).entries.filter(e=>e.src==='bank');
    assert.ok(postings.some(e=>e.dr==='661'&&e.cr==='311'&&e.kop===665819));
    assert.ok(postings.some(e=>e.dr==='311'&&e.cr==='661'&&e.kop===665819));
    assert.equal(postings.reduce((s,e)=>s+(e.dr==='311'?e.kop:0)-(e.cr==='311'?e.kop:0),0),0);
});

test('an old incorrect apartment allocation can still be undone and matched as a salary return', async () => {
    const {salary,outgoing,incoming}=await returnedSalary();
    // Simulate a legacy mistaken allocation using the supported manual action.
    await bank.actions.assign(...A,{txId:incoming.id,allocations:[{apt:'1',amountKop:salary.amountKop}],remember:true});
    assert.equal((await docs('apartments/1/ledger')).length,1);
    await bank.actions.unassign(...A,{txId:incoming.id});
    await bank.actions.refund(...A,{txId:incoming.id,refundOf:outgoing.id,reason:'bounce'});
    assert.equal((await docs('apartments/1/ledger')).length,0);
    assert.equal((await reports.actions.payrollData({period:'2026-10'})).summary.paidKop,0);
});

test('a successful HTTP response without references remains unknown and never sends the same proposal twice', async () => {
    await seedBank();privat.createPayment=originals.createPayment;let requests=0;
    globalThis.fetch=async()=>{requests++;return new Response(JSON.stringify({status:'SUCCESS'}));};
    const data={kind:'salary',recipient:{name:'Працівник Тестовий',iban:PAYEE,code:'3124567809'},account:OWN,amountKop:12345,
        purpose:'Заробітна плата за жовтень 2026, без ПДВ',proposalKey:'missing-reference'};
    await assert.rejects(payments.actions.create(...A,data),/Перевірте платіж/);
    assert.equal((await docs('payments'))[0].status,'unknown');
    await assert.rejects(payments.actions.create(...A,data),/уже відправлено/);assert.equal(requests,1);
});

test('a frozen legacy plan with two-part keys resumes and cancels without creating duplicate salary drafts', async () => {
    await seedPayroll();
    const stored=await snapshot('payroll_runs/2026-10');
    const run=JSON.parse(JSON.stringify(stored.run));
    for(const r of run.rows)r.final={grossKop:r.grossKop,pdfoKop:r.pdfoKop,vzKop:r.vzKop,netKop:r.netKop,esvKop:r.esvKop};
    const plan=payrollCore.stagePayments(run,'final',{code:'40562894',taxes:{pdfo:tax(3),vz:tax(4),esv:tax(5)}})
        .map(p=>({...p,key:`final:${p.personId||p.taxKey}`}));
    await db.doc('payroll_runs/2026-10').update({'stages.final':{plan,account:OWN,complete:false,completed:{}}});
    assert.equal((await payroll.actions.pay(...A,{period:'2026-10',stage:'final'})).ok,true);assert.equal(calls.length,4);
    const salary=(await docs('payments')).find(p=>p.kind==='salary');
    await payments.actions.cancel(...A,{id:salary.id});
    assert.equal((await snapshot('payroll_runs/2026-10')).stages.final.completed['final:e1'],undefined);
    assert.equal((await payroll.actions.pay(...A,{period:'2026-10',stage:'final'})).ok,true);
    assert.equal(calls.length,5);assert.equal((await docs('payments')).filter(p=>p.kind==='salary'&&p.status==='sent').length,1);
});

test('a voided payroll withdrawal restores the liability and cannot be automatically resent', async () => {
    await seedPayroll();await payroll.actions.pay(...A,{period:'2026-10',stage:'final'});
    const salary=(await docs('payments')).find(p=>p.kind==='salary');
    const raw=tx('withdrawal-void',{direction:'out',amountKop:salary.amountKop,purpose:salary.purpose,dlr:salary.bankRef,
        counterparty:{name:salary.recipient.name,account:salary.recipient.iban,code:salary.recipient.code}});
    await bank.storeTransactions([raw],'mock',await bank.loadContext());
    assert.equal((await reports.actions.payrollData({period:'2026-10'})).summary.paidKop,864700);
    await bank.storeTransactions([{...raw,void:true}],'mock',await bank.loadContext());
    assert.equal((await snapshot(`payments/${salary.id}`)).status,'unknown');
    assert.equal((await reports.actions.payrollData({period:'2026-10'})).summary.paidKop,0);
    const ledger=await journal.actions.context({period:'2026-10'});
    assert.equal(ledger.entries.filter(e=>e.src==='bank').length,0);
    assert.equal(ledger.checks.some(c=>c.level==='block'&&c.text.includes(`Платіж ${salary.id}: підтвердження`)),false);
    const n=calls.length;assert.equal((await payroll.actions.pay(...A,{period:'2026-10',stage:'final'})).ok,false);assert.equal(calls.length,n);
});

test('a voided supplier withdrawal reopens the expense without leaving inconsistent payment links', async () => {
    await seedBank();
    const id=`${OWN}_supplier-void`;
    await db.doc('expenses/supplier-doc').set({status:'paid',period:'2026-10',amountKop:10000,paidKop:10000,txIds:[id]});
    await db.doc('payments/supplier-pay').set({kind:'supplier',status:'paid',amountKop:10000,txId:id,expenseId:'supplier-doc'});
    await db.doc(`bank_tx/${id}`).set({...tx('supplier-void',{direction:'out'}),period:'2026-10',kind:'expense',status:'done',
        allocations:[],category:'supplier',expenseId:'supplier-doc',paymentId:'supplier-pay'});
    assert.equal((await bank.storeTransactions([tx('supplier-void',{direction:'out',void:true})],'mock',await bank.loadContext())).voided,1);
    const expense=await snapshot('expenses/supplier-doc');
    assert.equal(expense.status,'approved');assert.equal(expense.paidKop,0);assert.deepEqual(expense.txIds,[]);
    assert.equal((await snapshot('payments/supplier-pay')).status,'unknown');
    const ledger=await journal.actions.context({period:'2026-10'});
    assert.equal(ledger.entries.filter(e=>e.src==='bank').length,0);
    assert.equal(ledger.checks.some(c=>c.level==='block'&&/зв'язок з документом|підтвердження випискою/.test(c.text)),false);
    await bank.storeTransactions([tx('refund-check',{purpose:'Повернення оплати'})],'mock',await bank.loadContext());
    const incoming=`${OWN}_refund-check`;
    assert.deepEqual(await action({action:'refundCandidates',txId:incoming}),[]);
    await assert.rejects(bank.actions.refund(...A,{txId:incoming,refundOf:id,reason:'bounce'}),/без сторно банку/);
});

test('the chair can resolve an interrupted cancellation after ten minutes and release the payroll reservation', async () => {
    await seedPayroll();await payroll.actions.pay(...A,{period:'2026-10',stage:'final'});
    const salary=(await docs('payments')).find(p=>p.kind==='salary');
    const canceling={attempt:'interrupted',paymentId:salary.id,at:new Date(Date.now()-11*60000).toISOString(),by:A[0]};
    await db.doc(`payments/${salary.id}`).update({canceling});await db.doc('payroll_runs/2026-10').update({canceling});
    await payments.actions.resolve(...C,{id:salary.id,outcome:'not_created',reason:'Видалення завершено, чернетки у банку немає'});
    assert.equal((await snapshot(`payments/${salary.id}`)).status,'canceled');
    assert.equal((await snapshot('payroll_runs/2026-10')).canceling,undefined);
    assert.equal((await payroll.actions.pay(...A,{period:'2026-10',stage:'final'})).ok,true);
    assert.equal(calls.length,5);
});

test('bank confirmation during cancellation preserves the paid payment and releases the reservation', async () => {
    await seedPayroll();await payroll.actions.pay(...A,{period:'2026-10',stage:'final'});
    const salary=(await docs('payments')).find(p=>p.kind==='salary');
    const entered=deferred(),release=deferred();
    privat.deletePayment=async()=>{entered.resolve();await release.promise;return false;};
    const canceling=payments.actions.cancel(...A,{id:salary.id}).then(result=>({result}),error=>({error}));
    try {
        await entered.promise;
        await bank.storeTransactions([tx('paid-during-cancel',{direction:'out',amountKop:salary.amountKop,purpose:salary.purpose,dlr:salary.bankRef,
            counterparty:{name:salary.recipient.name,account:salary.recipient.iban,code:salary.recipient.code}})],'mock',await bank.loadContext());
        release.resolve();assert.match((await canceling).error.message,/Виписка вже підтвердила/);
        assert.equal((await snapshot(`payments/${salary.id}`)).status,'paid');
        assert.equal((await snapshot('payroll_runs/2026-10')).canceling,undefined);
        assert.equal((await reports.actions.payrollData({period:'2026-10'})).summary.paidKop,864700);
    } finally {release.resolve();await canceling;}
});
