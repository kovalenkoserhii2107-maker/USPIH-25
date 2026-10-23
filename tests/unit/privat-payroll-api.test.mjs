import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require=createRequire(new URL('../../functions/package.json',import.meta.url));
const api=require('./privat-payroll-api');
const original=globalThis.fetch;
api.settings.minIntervalMs=0;
afterEach(()=>{globalThis.fetch=original;});
test('receiver pagination continues to an empty page even after a short nonempty page',async()=>{
    const urls=[];
    globalThis.fetch=async url=>{urls.push(String(url));return new Response(JSON.stringify(urls.length<3?[{id:`r${urls.length}`}]:[]));};
    assert.equal((await api.receivers('LOCAL-MOCK','SALARY')).length,2);
    assert.equal(urls.length,3);assert.match(urls[2],/page=2&page-size=100/);
});
test('maspay API uses the documented routes, kop conversion and validation body',async()=>{
    const calls=[];
    globalThis.fetch=async(url,opts)=>{calls.push({url:String(url),opts});return new Response(JSON.stringify({reference:'REF-1',ref:'ROW-1'}));};
    await api.create('LOCAL-MOCK','SALARY','Тестова відомість');
    await api.add('LOCAL-MOCK','REF-1','receiver-1','Зарплата',12345);
    await api.validate('LOCAL-MOCK','REF-1');
    assert.match(calls[0].url,/\/maspay\/create$/);
    assert.deepEqual(JSON.parse(calls[0].opts.body),{group:'SALARY',salary:true,packetName:'Тестова відомість'});
    assert.deepEqual(JSON.parse(calls[1].opts.body),{receiver:'receiver-1',comment:'Зарплата',amount:123.45});
    assert.equal(calls.filter(c=>/sign|send/.test(c.url)).length,0);
});
test('HTTP 200 bank error and an ambiguous write are never retried automatically',async()=>{
    let count=0;
    globalThis.fetch=async()=>{count++;return new Response(JSON.stringify({status:'err',error:{system:'maspay',code:'V_BAD_PARAM'}}));};
    await assert.rejects(api.create('LOCAL-MOCK','SALARY','Тест'),/V_BAD_PARAM/);assert.equal(count,1);
    globalThis.fetch=async()=>{count++;throw new Error('Connection lost after accept');};
    await assert.rejects(api.add('LOCAL-MOCK','REF','receiver','Зарплата',100),/Connection lost/);assert.equal(count,2);
    assert.throws(()=>api.header('LOCAL-MOCK','../reqpay'),/референс/);assert.equal(count,2);
});
test('lists packets by the documented route and requires a period for processed packets',async()=>{
    const urls=[];
    globalThis.fetch=async url=>{urls.push(String(url));return new Response(JSON.stringify([]));};
    await api.packets('LOCAL-MOCK','A');
    assert.match(urls[0],/\/api\/pay\/apay24\/packets\/list\?status=A&page=0&page-size=100$/);
    assert.throws(()=>api.packets('LOCAL-MOCK','F'),/період/);
    await api.packets('LOCAL-MOCK','F',{from:'2026-08-01',to:'2026-11-01'});
    assert.match(urls[1],/status=F&from=2026-08-01&to=2026-11-01&page=0/);
});
test('update-receiver sends digits-only card, tab number, RNOKPP and FIO as an array',async()=>{
    const calls=[];
    globalThis.fetch=async(url,opts)=>{calls.push({url:String(url),body:JSON.parse(opts.body)});return new Response(JSON.stringify({status:'OK',id:'77'}));};
    const r=await api.updateReceiver('LOCAL-MOCK',{pan:'5168 7422 0000 1234',group:'SALARY',tabn:'5',inn:'3124567809',fio:api.fioParts('Працівник Тестовий Петрович')});
    assert.equal(r.id,'77');assert.match(calls[0].url,/\/mp\/update-receiver$/);
    assert.deepEqual(calls[0].body,{pan:'5168742200001234',group:'SALARY',tabn:'5',inn:'3124567809',fio:['Працівник','Тестовий','Петрович']});
    assert.equal(api.fioText(['Працівник','Тестовий','']),'Працівник Тестовий');
});
test('bank error object keeps system, code and argument',async()=>{
    globalThis.fetch=async()=>new Response(JSON.stringify({status:'err',error:{system:'maspay',code:'V_BAD_PARAM',args:['amount']}}));
    await assert.rejects(api.add('LOCAL-MOCK','REF','r','Зарплата',100),e=>/maspay:V_BAD_PARAM \(amount\)/.test(e.message)&&e.bankRejected===true);
});
test('requests to the real bank are spaced at least the minimum interval apart',async()=>{
    const at=[];api.settings.minIntervalMs=120;
    globalThis.fetch=async()=>{at.push(Date.now());return new Response(JSON.stringify([]));};
    await Promise.all([api.groups('LOCAL-MOCK'),api.groups('LOCAL-MOCK'),api.groups('LOCAL-MOCK')]);
    api.settings.minIntervalMs=0;
    assert.ok(at[1]-at[0]>=110&&at[2]-at[1]>=110);
});
