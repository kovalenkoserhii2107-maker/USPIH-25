'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),core=require('./annual-forms-core');
function fixture(){
 const entries=[{dr:'48',cr:'719',dA:'main',kop:200000,date:'2025-12-31'},{dr:'311',cr:'733',kop:50000,date:'2025-12-31'},{dr:'92',cr:'631',dA:'services',kop:200000,date:'2025-12-31'},{dr:'733',cr:'79',kop:50000,date:'2025-12-31'}];
 const osv=[['311',900000,0,500000,0],['351',0,0,600000,0],['377',150000,25000,250000,75000],['48',0,925000,0,1125000],['44',0,100000,0,150000]].map(([acc,openDr,openCr,closeDr,closeCr])=>({acc,openDr,openCr,closeDr,closeCr}));
 const report={year:'2025',reportingForm:'micro',complete:true,entries,osv,income:[{acc:'719',kop:200000},{acc:'733',kop:50000}],previousIncome:{incomeKop:100000,costKop:100000},summary:{incomeKop:250000,costKop:200000,resultKop:50000}};
 const settings={financingTerm:'long',deposit351:'investment',noViolation:true,noIncomeTax:true,comparatives:{salesKop:0,operatingKop:100000,otherKop:0,costOfSalesKop:0,otherCostKop:0,otherOperatingCostKop:100000},assignments:{}};
 for(const g of core.groups(report))settings.assignments[g.id]={category:g.kind==='cost'?'maintenance':g.acc==='733'?'passive':'contributions',row:g.kind==='cost'?'2.3':g.acc==='733'?'1.7':'1.9'};
 return {report,settings};
}
test('forms reconcile exact gross balances, recognised incomes, costs and deposit without counting principal as income',()=>{
 const {report,settings}=fixture(),r=core.build(report,settings);assert.equal(r.reviewReady,true,JSON.stringify(r.checks));assert.equal(r.filingReady,false);assert.equal(r.xmlAvailable,false);
 const row=c=>r.balance.find(x=>x.code===c);assert.equal(row('1300').startKop,1050000);assert.equal(row('1900').startKop,1050000);assert.equal(row('1300').endKop,1350000);assert.equal(row('1900').endKop,1350000);
 assert.equal(row('1155').endKop,250000);assert.equal(row('1690').endKop,75000);assert.equal(row('1190').endKop,600000);assert.equal(r.npoTotals.incomeKop,250000);assert.equal(r.npoTotals.costKop,200000);
 assert.equal(r.sourceGroups.find(x=>x.acc==='733').entryIndexes.length,1);assert.equal(r.results.find(x=>x.code==='2350').kop,50000);
});
test('deposit classification moves the same amount to another row and never changes the total',()=>{
 const {report,settings}=fixture();const a=core.build(report,settings),b=core.build(report,{...settings,deposit351:'cashEquivalent'});
 assert.equal(b.balance.find(x=>x.code==='1165').endKop,1100000);assert.equal(b.balance.find(x=>x.code==='1300').endKop,a.balance.find(x=>x.code==='1300').endKop);
 const s=core.build({...report,reportingForm:'small'},settings);assert.equal(s.balance.find(x=>x.code==='1160').endKop,600000);assert.equal(s.reviewReady,true);
});
test('incomplete journal, missing breakdown and unsupported balance sides block approval without making up prior zeros',()=>{
 const {report,settings}=fixture(),r=core.build({...report,complete:false},{...settings,comparatives:{}});
 assert.equal(r.reviewReady,false);assert.equal(r.results.find(x=>x.code==='2000').previousKop,null);
 const bad=core.build({...report,osv:[...report.osv,{acc:'143',openCr:1,closeCr:1}]},settings);assert.ok(bad.checks.some(x=>/143 cr/.test(x.text)));
 assert.equal(core.build({...report,reportingForm:'full'},settings).reviewReady,false);
});
test('overlapping NPO parent and child rows, invalid categories, absence of tax review and unclosed income are rejected',()=>{
 const {report,settings}=fixture();const g=core.groups(report).filter(g=>g.kind==='income');settings.assignments[g[0].id].row='1.9';settings.assignments[g[1].id].row='1.9.1';
 let r=core.build(report,settings);assert.ok(r.checks.some(x=>/підрядок/.test(x.text)));
 settings.assignments[g[0].id].category='payroll';r=core.build({...report,osv:[...report.osv,{acc:'703',closeCr:100}]},{...settings,noIncomeTax:false});assert.equal(r.reviewReady,false);assert.ok(r.checks.some(x=>/Не закритий/.test(x.text)));
});
test('reversals reduce recognised groups and debit taxes / supplier advances remain assets',()=>{
 const {report,settings}=fixture();report.entries.push({dr:'733',cr:'311',kop:10000,date:'2025-12-31'});report.income.find(x=>x.acc==='733').kop-=10000;report.summary.incomeKop-=10000;report.summary.resultKop-=10000;
 report.osv.find(x=>x.acc==='311').closeDr-=10000;report.osv.find(x=>x.acc==='44').closeCr-=10000;report.osv.push({acc:'641',openDr:0,openCr:0,closeDr:30000,closeCr:30000});
 const r=core.build(report,settings);assert.equal(r.reviewReady,true,JSON.stringify(r.checks));assert.equal(r.npoRows.find(x=>x.code==='1.7').kop,40000);assert.equal(r.balance.find(x=>x.code==='1155').endKop,280000);assert.equal(r.balance.find(x=>x.code==='1620').endKop,30000);
});
test('rounding is symmetric, sums are rounded from exact totals and differences are visible',()=>{
 assert.equal(core.roundUnits(5000),1);assert.equal(core.roundUnits(-5000),-1);assert.equal(core.roundUnits(4999),0);assert.equal(core.roundUnits(-4999),0);
 const {report,settings}=fixture();report.osv.find(x=>x.acc==='311').closeDr+=4999;report.osv.find(x=>x.acc==='351').closeDr+=4999;report.osv.find(x=>x.acc==='48').closeCr+=9998;
 const r=core.build(report,settings);assert.ok(r.checks.some(x=>x.level==='warn'&&/Округлення/.test(x.text)));assert.equal(r.balance.find(x=>x.code==='1300').endKop,1359998);
});
