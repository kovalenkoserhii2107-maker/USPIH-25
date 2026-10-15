'use strict';
const Module = require('node:module');
const origLoad = Module._load;
class MockHttpsError extends Error {
    constructor(code, message) {
        super(message);
        this.code = code;
    }
}
Module._load = function (request, parent, isMain) {
    if (request === 'firebase-functions/v2/https') {
        return {
            HttpsError: MockHttpsError,
            onCall: (_opts, handler) => handler
        };
    }
    if (request === 'firebase-functions/logger') {
        return { info: () => {}, warn: () => {}, error: () => {} };
    }
    return origLoad.apply(this, arguments);
};

// Ensure 'en-CA' DateTimeFormat returns ISO YYYY-MM-DD even on small-icu Node builds
const OrigDateTimeFormat = Intl.DateTimeFormat;
if (new OrigDateTimeFormat('en-CA', { timeZone: 'Europe/Kyiv' }).format(new Date('2026-11-05T12:00:00Z')) !== '2026-11-05') {
    const PatchedDateTimeFormat = function (locale, options = {}) {
        const fmt = new OrigDateTimeFormat('en-US', {
            ...options,
            year: options.year || 'numeric',
            month: options.month || '2-digit',
            day: options.day || '2-digit'
        });
        if (locale === 'en-CA' && !options.year && !options.month) {
            return {
                format(d) {
                    const parts = fmt.formatToParts(d);
                    const get = t => parts.find(x => x.type === t)?.value;
                    return `${get('year')}-${get('month')}-${get('day')}`;
                },
                formatToParts: d => fmt.formatToParts(d)
            };
        }
        return new OrigDateTimeFormat(locale, options);
    };
    PatchedDateTimeFormat.prototype = OrigDateTimeFormat.prototype;
    Intl.DateTimeFormat = PatchedDateTimeFormat;
}

const test = require('node:test');
const assert = require('node:assert/strict');
const chargesCore = require('./charges-core');
const journalFactory = require('./journal');
const chargesFactory = require('./charges');
const budgetFactory = require('./budget');
const annualReportsFactory = require('./annual-reports');
const periodLockFactory = require('./period-lock');

function createInMemoryFirestore() {
    const store = new Map();
    let idSeq = 1;

    const FieldValue = {
        serverTimestamp: () => ({ _serverTimestamp: true, toDate: () => new Date('2026-10-31T12:00:00Z'), toMillis: () => Date.parse('2026-10-31T12:00:00Z') }),
        delete: () => ({ _deleteField: true }),
        arrayUnion: (...els) => ({ _arrayUnion: els })
    };
    const Timestamp = {
        fromDate: d => ({ _ts: d, toDate: () => d, toMillis: () => d.getTime() })
    };

    function applyWrite(path, data, merge = false) {
        const prev = merge && store.has(path) ? { ...store.get(path) } : {};
        const next = { ...prev };
        for (const [k, v] of Object.entries(data || {})) {
            if (v && v._deleteField) delete next[k];
            else if (v && v._arrayUnion) next[k] = [...(Array.isArray(next[k]) ? next[k] : []), ...v._arrayUnion];
            else next[k] = v;
        }
        store.set(path, next);
    }

    function makeRef(path) {
        const parts = path.split('/');
        const id = parts[parts.length - 1];
        const parentColPath = parts.slice(0, -1).join('/');
        return {
            id,
            path,
            parent: parentColPath ? makeCol(parentColPath) : null,
            async get() {
                return makeDocSnap(path);
            },
            async set(data, opts) {
                applyWrite(path, data, Boolean(opts?.merge || opts?.mergeFields));
            },
            async update(data) {
                if (!store.has(path)) throw new Error(`Document ${path} not found`);
                applyWrite(path, data, true);
            },
            async create(data) {
                if (store.has(path)) throw new Error(`Document ${path} already exists`);
                applyWrite(path, data, false);
            },
            async delete() {
                store.delete(path);
            }
        };
    }

    function makeDocSnap(path) {
        const exists = store.has(path);
        const val = store.get(path);
        return {
            id: path.split('/').pop(),
            exists,
            ref: makeRef(path),
            data: () => (exists ? { ...val } : undefined)
        };
    }

    function matchesFilters(data, filters) {
        for (const [field, op, val] of filters) {
            const actual = data?.[field];
            if (op === '==' && actual !== val) return false;
            if (op === '>=' && !(actual >= val)) return false;
            if (op === '<=' && !(actual <= val)) return false;
            if (op === '<' && !(actual < val)) return false;
            if (op === '>' && !(actual > val)) return false;
            if (op === 'in' && (!Array.isArray(val) || !val.includes(actual))) return false;
            if (op === 'array-contains' && (!Array.isArray(actual) || !actual.includes(val))) return false;
        }
        return true;
    }

    function makeQuery(colPath, isGroup = false, filters = [], order = null, lim = null) {
        return {
            _isQuery: true,
            _colPath: colPath,
            _isGroup: isGroup,
            where(field, op, val) {
                return makeQuery(colPath, isGroup, [...filters, [field, op, val]], order, lim);
            },
            orderBy(field, dir = 'asc') {
                return makeQuery(colPath, isGroup, filters, { field, dir }, lim);
            },
            limit(n) {
                return makeQuery(colPath, isGroup, filters, order, n);
            },
            select() {
                return this;
            },
            async get() {
                const docs = [];
                for (const [path, data] of store.entries()) {
                    const parts = path.split('/');
                    const parentPath = parts.slice(0, -1).join('/');
                    const colName = parts[parts.length - 2];
                    if (isGroup ? colName !== colPath : parentPath !== colPath) continue;
                    if (!matchesFilters(data, filters)) continue;
                    docs.push(makeDocSnap(path));
                }
                if (order) {
                    docs.sort((a, b) => {
                        const va = a.data()[order.field];
                        const vb = b.data()[order.field];
                        const cmp = va < vb ? -1 : va > vb ? 1 : 0;
                        return order.dir === 'desc' ? -cmp : cmp;
                    });
                }
                const sliced = lim ? docs.slice(0, lim) : docs;
                return {
                    docs: sliced,
                    empty: sliced.length === 0,
                    size: sliced.length,
                    forEach: fn => sliced.forEach(fn)
                };
            }
        };
    }

    function makeCol(colPath) {
        const parts = colPath.split('/');
        const id = parts[parts.length - 1];
        const parentDocPath = parts.slice(0, -1).join('/');
        const q = makeQuery(colPath, false);
        return {
            ...q,
            id,
            path: colPath,
            parent: parentDocPath ? makeRef(parentDocPath) : null,
            doc(docId = `auto_${idSeq++}`) {
                return makeRef(`${colPath}/${docId}`);
            },
            async add(data) {
                const ref = this.doc();
                await ref.set(data);
                return ref;
            }
        };
    }

    const db = {
        doc: path => makeRef(path),
        collection: path => makeCol(path),
        collectionGroup: name => makeQuery(name, true),
        getAll: async (...refs) => Promise.all(refs.map(r => r.get())),
        batch() {
            const ops = [];
            return {
                set(ref, data, opts) { ops.push(() => ref.set(data, opts)); return this; },
                update(ref, data) { ops.push(() => ref.update(data)); return this; },
                create(ref, data) { ops.push(() => ref.create(data)); return this; },
                delete(ref) { ops.push(() => ref.delete()); return this; },
                async commit() { for (const op of ops) await op(); }
            };
        },
        async runTransaction(fn) {
            const txOps = [];
            const tx = {
                async get(refOrQuery) {
                    return refOrQuery.get();
                },
                async getAll(...refs) {
                    return Promise.all(refs.map(r => r.get()));
                },
                set(ref, data, opts) { txOps.push(() => ref.set(data, opts)); return this; },
                update(ref, data) { txOps.push(() => ref.update(data)); return this; },
                create(ref, data) { txOps.push(() => ref.create(data)); return this; },
                delete(ref) { txOps.push(() => ref.delete()); return this; }
            };
            const res = await fn(tx);
            for (const op of txOps) await op();
            return res;
        }
    };

    return { db, FieldValue, Timestamp };
}

test('Bottleneck 1: assetsContext and advanceContext use lightweight loaders and do not scan ledger or bank_tx', async () => {
    const { db, FieldValue } = createInMemoryFirestore();
    const lock = periodLockFactory(db);
    const journal = journalFactory({
        db,
        FieldValue,
        requireAdmin: async () => 'u1',
        staffRole: async () => 'chair',
        lock,
        now: () => new Date('2026-10-31T12:00:00Z')
    });

    await db.doc('accounting_settings/main').set({
        startDate: '2026-10-01',
        status: 'approved',
        defaultFund: 'main',
        funds: [{ id: 'main', name: 'Основний фонд' }],
        componentFunds: { main: 'main' },
        incomeAccounts: { rent: '48' },
        bankAccounts: {}
    });

    let ledgerReads = 0;
    let bankTxReads = 0;
    const origCollectionGroup = db.collectionGroup.bind(db);
    const origCollection = db.collection.bind(db);
    db.collectionGroup = name => {
        if (name === 'ledger') ledgerReads++;
        return origCollectionGroup(name);
    };
    db.collection = path => {
        if (path === 'bank_tx') bankTxReads++;
        return origCollection(path);
    };

    const assetsCtx = await journal.actions.assetsContext({ period: '2026-10' });
    assert.equal(assetsCtx.period, '2026-10');
    assert.equal(ledgerReads, 0, 'assetsContext should not query collectionGroup("ledger")');
    assert.equal(bankTxReads, 0, 'assetsContext should not query bank_tx');

    await journal.actions.saveAsset('u1', 'chair', {
        id: 'ОЗ-001',
        acc: '10',
        subacc: '104',
        name: 'Генератор 5.5 кВт',
        item: 'systems',
        fundId: 'main',
        acquiredDate: '2026-10-10',
        usefulLifeMonths: 60,
        deprMethod: 'straight',
        sourceMode: 'donated_or_surplus',
        initialCostKop: 4500000
    });
    assert.equal(ledgerReads, 0, 'saveAsset should not query collectionGroup("ledger")');
    assert.equal(bankTxReads, 0, 'saveAsset should not query bank_tx');

    await journal.actions.commissionAsset('u1', 'chair', {
        id: 'ОЗ-001',
        commissionedDate: '2026-10-15',
        commissionActNo: 'ОЗ-1/1'
    });
    assert.equal(ledgerReads, 0, 'commissionAsset should not query collectionGroup("ledger")');
    assert.equal(bankTxReads, 0, 'commissionAsset should not query bank_tx');

    const advCtx = await journal.actions.advanceContext({ period: '2026-10' });
    assert.equal(advCtx.period, '2026-10');
    assert.equal(ledgerReads, 0, 'advanceContext should not query collectionGroup("ledger")');
    assert.equal(bankTxReads, 0, 'advanceContext should not query bank_tx');

    await journal.actions.saveAdvanceReport('u1', 'chair', {
        number: 'АЗ-2026-10/01',
        date: '2026-10-20',
        period: '2026-10',
        personName: 'Коваленко Сергій Миколайович',
        personCode: '1234567890',
        personIban: 'UA213223130000026007233566001',
        purpose: 'Господарські витрати',
        lines: [{
            docType: 'fiscal_receipt',
            number: 'Ч-101',
            date: '2026-10-20',
            supplier: 'Епіцентр',
            amountKop: 50000,
            item: 'systems',
            postingAcc: '92',
            desc: 'Замок навісний'
        }]
    });
    assert.equal(ledgerReads, 0, 'saveAdvanceReport should not query collectionGroup("ledger")');
    assert.equal(bankTxReads, 0, 'saveAdvanceReport should not query bank_tx');
});

test('Bottleneck 2: runTransaction in journal.js and annual-reports.js never reads full database inside transaction', async () => {
    const { db, FieldValue, Timestamp } = createInMemoryFirestore();
    const lock = periodLockFactory(db);
    const journal = journalFactory({
        db,
        FieldValue,
        requireAdmin: async () => 'u1',
        staffRole: async () => 'chair',
        lock,
        now: () => new Date('2026-11-05T12:00:00Z')
    });
    const annual = annualReportsFactory({ db, FieldValue, journal });

    await db.doc('accounting_settings/main').set({
        startDate: '2026-10-01',
        status: 'approved',
        defaultFund: 'main',
        funds: [{ id: 'main', name: 'Основний фонд' }],
        componentFunds: { main: 'main' },
        incomeAccounts: { rent: '48' },
        bankAccounts: {}
    });
    await db.doc('charges/settings').set({
        startPeriod: '2026-10',
        startDate: '2026-10-01',
        opening: { set: true, count: 1, debtKop: 0, overpaidKop: 0 }
    });
    await db.doc('apartments/1').set({ area: '50', balance: -500, balanceSource: 'ledger' });
    await db.doc('apartments/1/ledger/opening').set({
        at: Timestamp.fromDate(new Date('2026-09-30T12:00:00Z')),
        period: '2026-09',
        kind: 'opening',
        amount: 0,
        amountKop: 0
    });
    await db.doc('apartments/1/ledger/charge-2026-10').set({
        at: Timestamp.fromDate(new Date('2026-10-31T12:00:00Z')),
        period: '2026-10',
        kind: 'charge',
        amount: 500,
        amountKop: 50000,
        source: 'charges',
        parts: [{ component: 'main', name: 'Утримання будинку', amountKop: 50000 }]
    });
    await db.doc('charges_runs/2026-10').set({
        status: 'complete',
        period: '2026-10',
        complete: true,
        count: 1,
        expectedApts: ['1'],
        totalKop: 50000,
        amounts: { '1': 50000 },
        byComponent: { main: 50000 },
        problems: []
    });

    const txReadCounts = [];
    const origRunTransaction = db.runTransaction.bind(db);
    db.runTransaction = async fn => origRunTransaction(async t => {
        let reads = 0;
        const origGet = t.get.bind(t);
        t.get = async ref => {
            reads++;
            return origGet(ref);
        };
        const res = await fn(t);
        txReadCounts.push(reads);
        return res;
    });

    await journal.actions.saveOpening('u1', 'chair', { lines: [] });
    await journal.actions.approveOpening('u1', 'chair');
    await journal.actions.close('u1', 'chair', { period: '2026-10' });
    await annual.snapshot('u1', 'chair', { year: '2026' });

    for (const count of txReadCounts) {
        assert.ok(count <= 10, `Expected <= 10 t.get() calls inside runTransaction, got ${count}`);
    }
});

test('Bottleneck 3: recompute() runs in parallel batches and persists alloc on both payment and refund entries', async () => {
    const { db, FieldValue, Timestamp } = createInMemoryFirestore();
    const lock = periodLockFactory(db);
    const charges = chargesFactory({
        db,
        FieldValue,
        Timestamp,
        requireAdmin: async () => 'u1',
        staffRole: async () => 'chair',
        lock
    });

    await db.doc('charges/settings').set({
        startPeriod: '2026-10',
        startDate: '2026-10-01',
        components: [
            { id: 'main', name: 'Утримання будинку', base: 'area', item: 'other' },
            { id: 'lift', name: 'Ліфти', base: 'area', item: 'lift' }
        ],
        opening: { set: true, count: 25, debtKop: 0, overpaidKop: 0 }
    });

    for (let i = 1; i <= 25; i++) {
        const apt = String(i);
        await db.doc(`apartments/${apt}`).set({ area: '50', balance: 0 });
        await db.doc(`apartments/${apt}/ledger/opening`).set({
            at: Timestamp.fromDate(new Date('2026-09-30T12:00:00Z')),
            period: '2026-09',
            kind: 'opening',
            amount: 0,
            amountKop: 0
        });
        await db.doc(`apartments/${apt}/ledger/charge-2026-10`).set({
            at: Timestamp.fromDate(new Date('2026-10-31T12:00:00Z')),
            period: '2026-10',
            kind: 'charge',
            amount: 500,
            amountKop: 50000,
            parts: [
                { component: 'main', name: 'Утримання будинку', amountKop: 40000 },
                { component: 'lift', name: 'Ліфти', amountKop: 10000 }
            ]
        });
        await db.doc(`apartments/${apt}/ledger/pay-1`).set({
            at: Timestamp.fromDate(new Date('2026-10-15T12:00:00Z')),
            period: '2026-10',
            kind: 'payment',
            amount: 600,
            amountKop: 60000
        });
        await db.doc(`apartments/${apt}/ledger/ref-1`).set({
            at: Timestamp.fromDate(new Date('2026-10-20T12:00:00Z')),
            period: '2026-10',
            kind: 'refund',
            amount: 50,
            amountKop: 5000
        });
    }

    const res = await charges.actions.recompute();
    assert.equal(res.updated, 25);

    const payDoc = (await db.doc('apartments/1/ledger/pay-1').get()).data();
    const refDoc = (await db.doc('apartments/1/ledger/ref-1').get()).data();
    assert.ok(Array.isArray(payDoc.alloc) && payDoc.alloc.length > 0, 'payment entry should have saved alloc');
    assert.ok(Array.isArray(refDoc.alloc) && refDoc.alloc.length > 0, 'refund entry should have saved alloc');
});

test('Bottleneck 4: paidByComponent, paymentOps, and budget.js gather(year) use saved alloc without reading prior years', async () => {
    const order = ['main', 'lift'];
    const fullHistory = new Map([
        ['1', [
            { kind: 'opening', period: '2026-09', at: new Date('2026-09-30T12:00:00Z'), amountKop: -10000, parts: { main: -8000, lift: -2000 } },
            { kind: 'charge', period: '2026-10', at: new Date('2026-10-31T12:00:00Z'), amountKop: 50000, parts: [{ component: 'main', amountKop: 40000 }, { component: 'lift', amountKop: 10000 }] },
            { kind: 'payment', period: '2026-11', at: new Date('2026-11-10T12:00:00Z'), amountKop: 60000 },
            { kind: 'charge', period: '2027-01', at: new Date('2027-01-31T12:00:00Z'), amountKop: 50000, parts: [{ component: 'main', amountKop: 40000 }, { component: 'lift', amountKop: 10000 }] },
            { kind: 'payment', period: '2027-02', at: new Date('2027-02-10T12:00:00Z'), amountKop: 50000 }
        ]]
    ]);

    const replayed = chargesCore.replay(fullHistory.get('1'), { startPeriod: '2026-10', order });
    const febStep = replayed.steps.find(s => s.entry.period === '2027-02');
    const febAlloc = Object.entries(febStep.parts).map(([component, amountKop]) => ({ component, name: component, amountKop }));

    const yearOnlyWithAlloc = new Map([
        ['1', [
            { kind: 'charge', period: '2027-01', at: new Date('2027-01-31T12:00:00Z'), amountKop: 50000, parts: [{ component: 'main', amountKop: 40000 }, { component: 'lift', amountKop: 10000 }] },
            { kind: 'payment', period: '2027-02', at: new Date('2027-02-10T12:00:00Z'), amountKop: 50000, alloc: febAlloc }
        ]]
    ]);

    assert.equal(chargesCore.canUseSavedAlloc(yearOnlyWithAlloc.get('1'), '2027', '2026-10', order), true);
    assert.deepEqual(
        chargesCore.paidByComponent(yearOnlyWithAlloc, '2027', { startPeriod: '2026-10', order }),
        chargesCore.paidByComponent(fullHistory, '2027', { startPeriod: '2026-10', order })
    );
    assert.deepEqual(
        chargesCore.paymentOps(yearOnlyWithAlloc, '2027', { startPeriod: '2026-10', order }),
        chargesCore.paymentOps(fullHistory, '2027', { startPeriod: '2026-10', order })
    );

    const { db, FieldValue, Timestamp } = createInMemoryFirestore();
    await db.doc('accounting_settings/main').set({
        startDate: '2026-10-01',
        status: 'approved',
        defaultFund: 'main',
        funds: [{ id: 'main', name: 'Основний фонд' }],
        componentFunds: { main: 'main', lift: 'main' },
        incomeAccounts: { rent: '48' },
        bankAccounts: {}
    });
    await db.doc('charges/settings').set({
        startPeriod: '2026-10',
        startDate: '2026-10-01',
        components: [
            { id: 'main', name: 'Утримання будинку', base: 'area', item: 'other' },
            { id: 'lift', name: 'Ліфти', base: 'area', item: 'lift' }
        ],
        opening: { set: true, count: 1, debtKop: -10000, overpaidKop: 0 }
    });
    await db.doc('apartments/1').set({ area: '50', balance: 0 });
    await db.doc('apartments/1/ledger/opening').set({
        at: Timestamp.fromDate(new Date('2026-09-30T12:00:00Z')),
        period: '2026-09',
        kind: 'opening',
        amountKop: -10000,
        parts: { main: -8000, lift: -2000 }
    });
    await db.doc('apartments/1/ledger/pay-2027').set({
        at: Timestamp.fromDate(new Date('2027-02-10T12:00:00Z')),
        period: '2027-02',
        kind: 'payment',
        amountKop: 50000,
        alloc: febAlloc
    });

    let ledgerGroupQueries = 0;
    const origCollectionGroup = db.collectionGroup.bind(db);
    db.collectionGroup = name => {
        if (name === 'ledger') ledgerGroupQueries++;
        return origCollectionGroup(name);
    };

    const budget = budgetFactory({
        db,
        FieldValue,
        requireAdmin: async () => 'u1',
        staffRole: async () => 'chair'
    });
    const ctx2027 = await budget.actions.context({ year: '2027' });
    assert.equal(ctx2027.year, '2027');
    assert.equal(ledgerGroupQueries, 1, 'budget gather(2027) should execute only 1 ledger query for 2027 without reading 2026 or opening');
});
