'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const core=require('./annual-report-core'),j=require('./journal-core');
const BANK='UA213052990000026001234567890',DEPOSIT='UA273052990000026001234567800';
function fixture() {
    const policy={startDate:'2026-10-01',status:'approved',defaultFund:'main',funds:[{id:'main',name:'Основний'}],incomeAccounts:{interest:'733'},bankAccounts:{[DEPOSIT]:{acc:'351'}},reportingForm:'micro',version:2};
    const history={status:'approved',openingLines:[{acc:'311',a:BANK,side:'dr',kop:100000},{acc:'48',a:'main',side:'cr',kop:100000}],
        previousIncome:{incomeKop:20000,costKop:20000},entries:[
            {date:'2026-09-30',dr:'92',cr:'631',dA:'repair',cA:'supplier',kop:9000},
            {date:'2026-09-30',dr:'631',cr:'311',dA:'supplier',cA:BANK,kop:9000},
            {date:'2026-09-30',dr:'48',cr:'719',dA:'main',kop:9000},
            {date:'2026-09-30',dr:'719',cr:'79',kop:9000},
            {date:'2026-09-30',dr:'79',cr:'92',cA:'repair',kop:9000}]};
    const bankTx=[{id:'deposit',period:'2026-10',at:new Date('2026-10-10T12:00:00Z'),account:BANK,direction:'out',kind:'internal',amountKop:50000,counterparty:{account:DEPOSIT}},
        {id:'interest',period:'2026-11',at:new Date('2026-11-30T12:00:00Z'),account:BANK,direction:'in',kind:'income',category:'interest',status:'done',amountKop:1000},
        {id:'supplier-pay',period:'2026-11',at:new Date('2026-11-30T12:00:00Z'),account:BANK,direction:'out',kind:'expense',category:'supplier',expenseId:'cost',status:'done',amountKop:3000,counterparty:{name:'supplier'}}];
    const input={start:'2026-10',startDate:policy.startDate,policy,opening:{status:'approved',lines:[{acc:'311',a:BANK,side:'dr',kop:91000},{acc:'48',a:'main',side:'cr',kop:91000}]},bankTx,
        expenses:[{id:'cost',period:'2026-11',date:'2026-11-30',status:'approved',supplierName:'supplier',item:'repair',amountKop:3000}]};
    return {year:'2026',input,history,policy,openingStatus:'approved',closed:['2026-10','2026-11','2026-12'],today:'2027-01-05'};
}
test('annual migration, deposit, supplier payments and all report totals reconcile in kop',()=>{
    const data=fixture(),r=core.annual(data);
    assert.equal(r.complete,true,JSON.stringify(r.checks));
    assert.deepEqual(r.summary,{incomeKop:13000,costKop:12000,resultKop:1000,receiptsKop:1000,payoutsKop:12000,balanceDiff:0});
    const byAcc=a=>r.osv.find(x=>x.acc===a);
    assert.equal(byAcc('311').openDr,100000);assert.equal(byAcc('311').closeDr,39000);
    assert.equal(byAcc('351').closeDr,50000);assert.equal(byAcc('48').closeCr,88000);
    assert.equal(r.funds[0].closeKop,88000);assert.equal(r.funds[0].usedKop,12000);
    assert.equal(byAcc('311').byA[0].openDr,100000);
});
test('annual report refuses to label missing or mismatched migration as complete',()=>{
    const data=fixture();
    assert.equal(core.annual({...data,history:null}).complete,false);
    data.history.entries[1].kop--;
    assert.ok(core.annual(data).checks.some(c=>c.level==='block'&&/вхідну ОСВ/.test(c.text)));
    assert.match(core.historyProblem({...data.history,entries:[{date:'2026-10-01',dr:'311',cr:'48',kop:1}]},'2026','2026-10-01'),/помилка дати/);
});
test('a closed snapshot preserves figures when subsequent rules or editable source documents change',()=>{
    const data=fixture();
    const old=j.journal(data.input,'2026-12');
    data.input.closedSnapshots=new Map(['2026-10','2026-11','2026-12'].map(p=>[p,old.filter(e=>e.period===p)]));
    data.input.expenses[0].amountKop=999999;
    const result=core.annual(data);
    assert.equal(result.summary.costKop,12000);assert.equal(result.summary.resultKop,1000);
});
test('capitalized OSBB property does not become an expense until depreciation or consumption',()=>{
    const data=fixture();
    data.input.expenses.push({id:'asset',period:'2026-10',date:'2026-10-15',status:'approved',supplierName:'hardware',postingAcc:'10',assetId:'PC-1',amountKop:10000});
    data.input.adjustments=[{id:'depreciation',status:'approved',date:'2026-11-30',period:'2026-11',lines:[{dr:'92',cr:'131',dA:'office',cA:'PC-1',kop:1000}]}];
    const result=core.annual(data);
    assert.equal(result.osv.find(r=>r.acc==='10').closeDr,10000);assert.equal(result.osv.find(r=>r.acc==='131').closeCr,1000);
    assert.equal(result.summary.costKop,13000);
});
test('own income and expenses retain a real financial result instead of forcing it to zero',()=>{
    const data=fixture();data.input.expenses[0].fundId='own';
    const result=core.annual(data);
    assert.equal(result.summary.incomeKop,10000);assert.equal(result.summary.costKop,12000);assert.equal(result.summary.resultKop,-2000);
    assert.equal(result.osv.find(r=>r.acc==='44').closeDr,2000);
    assert.equal(result.funds[0].usedKop,9000);assert.equal(result.funds[0].closeKop,91000);
});
