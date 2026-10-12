import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,readdirSync} from 'node:fs';
import {createRequire} from 'node:module';
import readExcel from 'read-excel-file/node';
import {zipSync,strToU8} from 'fflate';
import {sections,parseDelimited,suggestAssignments,suggestMapping,compileImport,decimalString} from '../../js/migration-import-core.js';
import {unpackBounded} from '../../js/migration-workbook.js';
const require=createRequire(import.meta.url),server=require('../../functions/migration-core.js');
const root=new URL('../../docs/accounting/fixtures/external-export/',import.meta.url),names=readdirSync(root);
const keys={accounts:'01-',opening:'07-',owners:'02-',ledger:'04-',january:'05-',journal:'06-',suppliers:'09-',legacyExpenses:'10-'};
const files=Object.fromEntries(Object.entries(keys).map(([k,p])=>[k,readFileSync(new URL(names.find(n=>n.startsWith(p)),root),'utf8')]));
const expected=server.prepare(files,'2026-10-01');
function sourceFiles(){return Object.entries(keys).map(([k,p])=>({id:k,name:names.find(n=>n.startsWith(p)),...parseDelimited(files[k])}));}
function compiled(sources){return compileImport(sources,suggestAssignments(sources),'2026-10-01');}

test('all external CSV sheets and the independent XLSX reconcile to identical server results',async()=>{
 const csv=compiled(sourceFiles());assert.deepEqual(csv.issues,[]);assert.equal(server.prepare(csv.files,'2026-10-01').hash,expected.hash);
 const sheets=await readExcel(new URL('test-house-external-export.xlsx',root).pathname,{parseNumber:s=>s});const excel=compiled(sheets.map((s,i)=>({id:String(i),name:s.sheet,rows:s.data})));
 assert.deepEqual(excel.issues,[]);assert.equal(server.prepare(excel.files,'2026-10-01').hash,expected.hash);
});
test('manual vendor mappings accept arbitrary columns, title rows and ignore an explicitly excluded total',()=>{
 const s=sourceFiles(),a=s.find(x=>x.id==='accounts');a.rows.unshift(['Інша система, звіт']);a.sourceRows.unshift(1);a.rows[1]=['ACCOUNT','UNIT','TYPE','ENTRY','AREA','PEOPLE','DEBT','CREDIT','ASOF'];a.rows.push(['РАЗОМ']);a.sourceRows=a.rows.map((r,i)=>i+1);
 const assignments=suggestAssignments(s);assert.equal(assignments.accounts,undefined);assignments.accounts={source:'accounts',header:1,end:a.rows.length-1,mapping:[0,1,2,3,4,5,6,7,8]};
 const out=compileImport(s,assignments,'2026-10-01');assert.deepEqual(out.issues,[]);assert.equal(server.prepare(out.files,'2026-10-01').hash,expected.hash);
 a.rows[2][4]='bad';a.rows[3][6]='1.123';const bad=compileImport(s,assignments,'2026-10-01');assert.deepEqual(bad.issues.map(i=>i.row),[3,4]);assert.ok(bad.issues[0].column.includes('площа'));
 for(const row of a.rows.slice(2,-1))row[4]='bad';const many=compileImport(s,assignments,'2026-10-01');assert.equal(many.issues.length,100);assert.ok(many.issueCount>100);
});
test('ambiguous columns and incomplete annual pairs cannot silently map or import',()=>{
 const section=sections.find(s=>s.id==='accounts'),source=sourceFiles()[0];source.rows[0].push('Лицевой счет');assert.equal(suggestMapping(section,source)[0],-1);
 const out=compiled(sourceFiles().filter(s=>s.id!=='journal'));assert.ok(out.issues.some(i=>i.message.includes('разом')));
 const s=sourceFiles(),a=suggestAssignments(s);a.accounts.mapping[1]=a.accounts.mapping[0];assert.ok(compileImport(s,a,'2026-10-01').issues.some(i=>i.message.includes('кільком')));
});
test('CSV retains physical rows, multiline values and account strings; decimal exponent expansion is exact',()=>{
 const p=parseDelimited('A\tB\n\n"0000123"\t"a\nb"\n');assert.deepEqual(p.sourceRows,[1,2,3]);assert.deepEqual(p.rows[2],['0000123','a\nb']);assert.equal(decimalString('1.234567890123456e+17'),'123456789012345600');assert.equal(decimalString('3e-3'),'0.003');assert.throws(()=>parseDelimited('A;B\n"bad'));
 assert.deepEqual(parseDelimited('Назва звіту\nA\tB\n1\t2\n3\t4').rows[1],['A','B']);
});
test('duplicate account/analytic lines and invalid journal rows retain their source context',()=>{
 const opening=files.opening.trimEnd();assert.throws(()=>server.prepare({...files,opening:opening+'\n'+opening.split(/\r?\n/)[1]},'2026-10-01'),e=>{assert.ok(e.issues.some(i=>i.file==='opening'&&i.message.includes('повтор')));return true;});
 assert.throws(()=>server.prepare({...files,journal:files.journal.replace('01.09.2026','01.10.2026')},'2026-10-01'),e=>{assert.ok(e.issues.some(i=>i.file==='journal'&&i.row));return true;});
});
test('formula errors and long numeric identifiers are rejected, numeric ID warnings require review',()=>{
 const s=sourceFiles();s[0].cells={'1:0':{numeric:true},'2:0':{numeric:true,padded:20,unsafeId:true},'3:4':{error:true}};s[0].rows[2][0]='00001234567890123456';const out=compiled(s);
 assert.ok(out.issues.some(i=>i.row===3&&i.message.includes('15')));assert.ok(out.issues.some(i=>i.row===4&&i.message.includes('формула')));assert.equal(out.warnings.length,1);
});
test('server reports multiple bad rows with original spreadsheet row numbers and no writes',()=>{
 const s=sourceFiles(),assignments=suggestAssignments(s),out=compileImport(s,assignments,'2026-10-01');out.files.accounts=out.files.accounts.replace('"30.09.2026";2','"31.09.2026";17').replace('"30.09.2026";3','"31.09.2026";21');
 assert.throws(()=>server.prepare(out.files,'2026-10-01'),e=>{assert.deepEqual(e.issues.map(i=>i.row),[17,21]);assert.ok(e.issues.every(i=>i.file==='accounts'));return true;});
});
test('oversized zip expansion is rejected before allocating sheet data',()=>{
 const zip=zipSync({'huge.xml':new Uint8Array(13*1024*1024)},{level:6});assert.throws(()=>unpackBounded(zip),/завелика/);assert.throws(()=>unpackBounded(new Uint8Array([1,2,3])));
});
