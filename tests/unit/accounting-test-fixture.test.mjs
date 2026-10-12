import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,readdirSync} from 'node:fs';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),fixture=require('../../functions/accounting-test-fixture.json'),core=require('../../functions/migration-core.js');
const root=new URL('../../docs/accounting/fixtures/external-export/',import.meta.url),names=readdirSync(root),text=p=>readFileSync(new URL(names.find(n=>n.startsWith(p)),root),'utf8');
test('deployed training fixture contains exactly the independent, anonymized external export',()=>{
 for(const [key,prefix]of Object.entries({accounts:'01-',opening:'07-',owners:'02-',ledger:'04-',january:'05-',journal:'06-',suppliers:'09-',legacyExpenses:'10-'}))assert.equal(fixture.files[key],text(prefix));
 assert.equal(fixture.bank,text('08-'));assert.equal(fixture.services,text('11-'));assert.equal(fixture.employee,text('12-'));assert.deepEqual(fixture.controls,JSON.parse(readFileSync(new URL('expected-controls.json',root),'utf8')));
 const p=core.prepare(fixture.files,fixture.controls.startDate);assert.equal(p.apartments.length,302);assert.equal(p.summary.owners,447);assert.ok(p.apartments.every(a=>a.owners.every(o=>o.name.startsWith('Тестовий'))));
});
test('cash and deposit reference totals reconcile independently to external statement plus gross wages and ESV',()=>{
 const raw=core.csv(fixture.bank);const delta=iban=>raw.filter(r=>core.value(r,'IBAN ОСББ')===iban).reduce((n,r)=>n+core.kop(core.value(r,'Кредит (надходження), грн'),true)-core.kop(core.value(r,'Дебет (списання), грн'),true),0);
 assert.equal(fixture.expected.finalBankKop,fixture.controls.cutBankKop+delta(fixture.controls.bank)-3*(1000000+220000));assert.equal(fixture.expected.finalDepositKop,fixture.controls.cutDepositKop+delta(fixture.controls.deposit));
});
test('refund reconciliation applies to a chosen accounting start before October 2026',()=>{
 const {reconcile}=require('../../functions/reconciliation-core.js');
 const checks=reconcile({period:'2025-10',start:'2025-10',startDate:'2025-10-01',openingSet:true,bankTx:[{id:'refund',period:'2025-10',kind:'refund',direction:'in',status:'done',amountKop:10000,refundOf:'missing-original'}]});
 assert.ok(checks.some(c=>c.level==='block'&&c.text.includes('Повернення refund')));
 const payout=reconcile({period:'2025-10',start:'2025-10',startDate:'2025-10-01',openingSet:true,bankTx:[{id:'out',period:'2025-10',kind:'expense',direction:'out',status:'done',amountKop:10000,refundedKop:1000,refundTxIds:[]}]});
 assert.ok(payout.some(c=>c.level==='block'&&c.text.includes('Списання out')));
});
