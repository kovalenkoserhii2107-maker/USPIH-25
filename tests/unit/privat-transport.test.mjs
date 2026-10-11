import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(new URL('../../functions/package.json', import.meta.url));
const privat = require('./privat');
const originalFetch = globalThis.fetch;
const OWN = 'UA213052990000026001234567890';
const query = { iban: OWN, from: new Date('2026-10-10T23:00:00Z'), to: new Date('2026-10-11T09:00:00Z') };
const raw = (id, extra = {}) => ({ REF: id, REFN: '1', TRANTYPE: 'C', SUM: '123,45',
    DAT_OD: '11.10.2026', TIM_P: '09:00', CCY: 'UAH', FL_REAL: 'r', PR_PR: 'r',
    OSND: 'Внесок співвласника, кв. 1', ...extra });
const draft = { account: OWN, recipient: { iban: 'UA273052990000026001234567800', name: 'Тест', code: '3124567809' },
    amountKop: 12345, purpose: 'Заробітна плата, без ПДВ', docNumber: 'LOCAL001' };
const response = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers });
afterEach(() => { globalThis.fetch = originalFetch; });

test('T1 protection: complete pagination preserves order, filters pending rows, and sends Kyiv dates and UTF-8', async () => {
    const requests = [];
    const replies = [
        { transactions: [raw('A'), raw('pending', { FL_REAL: 'p' })], exist_next_page: true, next_page_id: 'cursor-А' },
        { transactions: [raw('B')], exist_next_page: 'true', next_page_id: 'cursor-Б' },
        { transactions: [raw('C')], exist_next_page: false }
    ];
    globalThis.fetch = async (url, opts) => { requests.push({ url: new URL(url), opts }); return response(replies[requests.length - 1]); };
    const rows = await privat.fetchTransactions('LOCAL-MOCK-TOKEN', query);
    assert.deepEqual(rows.map(r => r.bankId), ['A_1', 'B_1', 'C_1']);
    assert.ok(rows.every(r => r.amountKop === 12345 && r.account === OWN && r.purpose.includes('співвласника')));
    assert.deepEqual(requests.map(r => r.url.searchParams.get('followId')), [null, 'cursor-А', 'cursor-Б']);
    assert.ok(requests.every(r => r.url.searchParams.get('startDate') === '11-10-2026'));
    assert.ok(requests.every(r => r.opts.headers['Content-Type'] === 'application/json;charset=utf8'));
});

test('T2 protection: page 50 with a continuation aborts rather than returning incomplete statements', async () => {
    let count = 0;
    globalThis.fetch = async () => response({ transactions: [raw(`page${++count}`)], exist_next_page: true, next_page_id: `cursor-${count}` });
    await assert.rejects(privat.fetchTransactions('LOCAL-MOCK-TOKEN', query), /ліміт сторінок/);
    assert.equal(count, 50);
});

test('T3 protection: a throttled statement GET is retried once and then succeeds', async () => {
    let count = 0;
    globalThis.fetch = async () => ++count === 1 ? response({ message: 'throttle' }, 429, { 'Retry-After': '0.001' })
        : response({ transactions: [raw('after429')], exist_next_page: false });
    const rows = await privat.fetchTransactions('LOCAL-MOCK-TOKEN', query);
    assert.equal(count, 2); assert.equal(rows.length, 1);
});

test('T4 protection: repeated GET throttling stops after one retry', async () => {
    let count = 0;
    globalThis.fetch = async () => { count++; return response({ message: 'throttle' }, 429, { 'Retry-After': '0.001' }); };
    await assert.rejects(privat.fetchTransactions('LOCAL-MOCK-TOKEN', query), /throttle/);
    assert.equal(count, 2);
});

test('T5 protection: payment HTTP failures distinguish definite refusal from unknown result without automatic resending', async () => {
    const matrix = [];
    for (const status of [400, 401, 403, 408, 429, 500, 502]) {
        let count = 0;
        globalThis.fetch = async (url, opts) => { count++; assert.equal(opts.method, 'POST'); return response({ message: `HTTP ${status}` }, status); };
        const definite = [400, 401, 403].includes(status);
        await assert.rejects(privat.createPayment('LOCAL-MOCK-TOKEN', draft), e => e.bankRejected === definite);
        assert.equal(count, 1);
        matrix.push({ status, bankRejected: definite, requests: count });
    }
});

test('T6 protection: a successful HTTP response without bank references is not treated as a confirmed draft', async () => {
    let count = 0;
    globalThis.fetch = async () => { count++; return response({ status: 'SUCCESS' }); };
    await assert.rejects(privat.createPayment('LOCAL-MOCK-TOKEN', draft), e => /номер платежу/.test(e.message) && e.bankRejected !== true);
    assert.equal(count, 1);
});

test('T7 protection: a malformed finalized operation on a later page aborts the complete fetch', async () => {
    let count = 0;
    globalThis.fetch = async () => ++count === 1
        ? response({ transactions: [raw('good')], exist_next_page: true, next_page_id: 'next' })
        : response({ transactions: [raw('bad', { SUM: 'not-money' })], exist_next_page: false });
    await assert.rejects(privat.fetchTransactions('LOCAL-MOCK-TOKEN', query), /некоректну проведену операцію/);
    assert.equal(count, 2);
});

test('T8 readiness rejects absent and unrecognized work_balance flags', async () => {
    const matrix = [];
    for (const settings of [{ phase:'WRK', work_balance:'N' }, { phase:'WRK', work_balance:'Y' },
        { phase:'REG', work_balance:'N' }, { phase:'WRK' }, { phase:'WRK', work_balance:'UNKNOWN' }]) {
        globalThis.fetch = async () => response({ settings });
        matrix.push({ settings, ready: await privat.isReady('LOCAL-MOCK-TOKEN') });
    }
    assert.deepEqual(matrix.map(m => m.ready), [true, false, false, false, false]);
});

test('T9 protection: confirmed draft deletion handles HTTP 204 and escapes the reference', async () => {
    const requests = [];
    globalThis.fetch = async (url, opts) => { requests.push({ url: String(url), opts }); return new Response(null, { status: 204 }); };
    assert.equal(await privat.deletePayment('LOCAL-MOCK-TOKEN', 'ref/with & spaces'), true);
    assert.equal(requests.length, 1);
    assert.equal(new URL(requests[0].url).searchParams.get('ref'), 'ref/with & spaces');
    assert.equal(requests[0].opts.method, 'POST'); assert.equal(requests[0].opts.body, undefined);
});

test('bank voids reach reconciliation while pending transactions remain excluded', async () => {
    globalThis.fetch=async()=>response({transactions:[raw('final'),raw('pending',{PR_PR:'p'}),raw('void',{PR_PR:'t'}),raw('rejected',{PR_PR:'n'})],exist_next_page:false});
    const rows=await privat.fetchTransactions('LOCAL-MOCK-TOKEN',query);
    assert.deepEqual(rows.map(r=>[r.bankId,r.final,r.void]),[['final_1',true,false],['void_1',false,true],['rejected_1',false,true]]);
});
