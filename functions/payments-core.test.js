'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const pay = require('./payments-core');

// Справжня контрольна сума для тестових рахунків.
function iban(bban) {
    const digits = `${bban}3010` + '00';   // U=30, A=10
    let rest = 0;
    for (const ch of digits) rest = (rest * 10 + Number(ch)) % 97;
    return `UA${String(98 - rest).padStart(2, '0')}${bban}`;
}
const OWN_IBAN = iban('3052990000026001234567890');
const OWN = new Set([OWN_IBAN]);
// IBAN з офіційного прикладу НБУ — контрольна сума правильна.
const SUPPLIER = 'UA906543210000000260323012024';
const base = { recipient: { name: 'ТОВ Ліфт-Сервіс', iban: SUPPLIER, code: '12345678' }, amountKop: 425000,
    purpose: 'Оплата за обслуговування ліфтів за жовтень 2026', account: OWN_IBAN };

test('перевірка платежу: зрозумілі помилки', () => {
    assert.equal(pay.checkPayment(base, OWN), null);
    assert.match(pay.checkPayment({ ...base, recipient: { ...base.recipient, iban: 'UA916543210000000260323012024' } }, OWN), /IBAN/);
    assert.match(pay.checkPayment({ ...base, recipient: { ...base.recipient, code: '123' } }, OWN), /Код/);
    assert.match(pay.checkPayment({ ...base, amountKop: 0 }, OWN), /більшою/);
    assert.match(pay.checkPayment({ ...base, amountKop: 10.5 }, OWN), /більшою/);
    assert.match(pay.checkPayment({ ...base, purpose: 'x' }, OWN), /призначення/);
    assert.match(pay.checkPayment({ ...base, purpose: 'а'.repeat(421) }, OWN), /420/);
    assert.match(pay.checkPayment({ ...base, account: 'UA00' }, OWN), /рахунок ОСББ/);
    assert.match(pay.checkPayment({ ...base, recipient: { ...base.recipient, iban: OWN_IBAN } }, OWN), /самого ОСББ/);
});

test('списання у виписці закриває відправлений платіж', () => {
    const sent = { ...base, status: 'sent', sentAt: new Date('2026-10-10T09:00:00Z'), bankRef: 'PACK1' };
    const tx = { account: OWN_IBAN, direction: 'out', amountKop: 425000, counterparty: { account: SUPPLIER }, at: new Date('2026-10-11T08:00:00Z') };
    assert.equal(pay.matchesPayment(tx, sent), true);
    assert.equal(pay.matchesPayment({ ...tx, amountKop: 425001 }, sent), false);
    assert.equal(pay.matchesPayment({ ...tx, at: new Date('2026-12-30') }, sent), false);
    assert.equal(pay.matchesPayment({ ...tx, direction: 'in' }, sent), false);
    // Пачка не є унікальною операцією: сума й рахунки також мають збігтися.
    assert.equal(pay.matchesPayment({ ...tx, amountKop: 1, dlr: 'PACK1' }, sent), false);
    assert.equal(pay.matchesPayment(tx, { ...sent, status: 'paid' }), false);
});

test('регулярні отримувачі за історією списань', () => {
    const tx = (date, amountKop, purpose, iban = SUPPLIER, name = 'ТОВ Ліфт-Сервіс') =>
        ({ at: new Date(date), amountKop, purpose, counterparty: { name, account: iban, code: '12345678' } });
    const history = [
        tx('2026-08-05', 420000, 'Обслуговування ліфтів за серпень 2026'),
        tx('2026-09-05', 425000, 'Обслуговування ліфтів за вересень 2026'),
        tx('2026-10-06', 425000, 'Обслуговування ліфтів за жовтень 2026'),
        tx('2026-10-06', 99000, 'Разова закупівля лампочок', iban('3220010000026007233566001'), 'ФОП Іванов'),
        tx('2026-09-20', 190234, 'ЄСВ за серпень', iban('8999980000031119101003011'), 'ГУ ДПС')
    ];
    const list = pay.recurringRecipients(history);
    assert.equal(list.length, 1);
    assert.deepEqual([list[0].recipient.name, list[0].amountKop, list[0].day, list[0].months], ['ТОВ Ліфт-Сервіс', 425000, 6, 3]);
});

test('призначення переноситься на новий місяць', () => {
    const nov = new Date('2026-11-03');
    assert.equal(pay.purposeForMonth('Обслуговування ліфтів за жовтень 2026', nov), 'Обслуговування ліфтів за листопад 2026');
    assert.equal(pay.purposeForMonth('Прибирання за 10.2026', nov), 'Прибирання за 11.2026');
    assert.equal(pay.purposeForMonth('Оплата згідно рахунку', nov), 'Оплата згідно рахунку');
    assert.equal(pay.purposeForMonth('Послуги до 15 жовтня', nov), 'Послуги до 15 листопада');
});

test('платіж цього місяця вже є — не пропонуємо вдруге', () => {
    const rec = { key: SUPPLIER };
    const now = new Date('2026-11-10');
    assert.equal(pay.alreadyPaidThisMonth(rec, [], [{ at: new Date('2026-11-05'), counterparty: { account: SUPPLIER } }], now), true);
    assert.equal(pay.alreadyPaidThisMonth(rec, [{ recipient: { iban: SUPPLIER }, status: 'sent', createdAt: new Date('2026-11-02') }], [], now), true);
    assert.equal(pay.alreadyPaidThisMonth(rec, [{ recipient: { iban: SUPPLIER }, status: 'canceled', createdAt: new Date('2026-11-02') }], [], now), false);
    assert.equal(pay.alreadyPaidThisMonth(rec, [], [{ at: new Date('2026-10-05'), counterparty: { account: SUPPLIER } }], now), false);
});

test('нагадування голові: кількість, сума й перші три отримувачі', () => {
    const one = pay.reminderText([{ recipient: { name: 'Отримувач А' }, amountKop: 665819 }]);
    assert.equal(one.title, '1 платіж чекає вашого підпису');
    assert.equal(one.body.replace(/\s/g, ' '), 'Отримувач А: разом 6 658,19 грн. Підпишіть у Приват24 для бізнесу.');
    const five = pay.reminderText(['А', 'Б', 'В', 'Г', 'Ґ'].map(n => ({ recipient: { name: n }, amountKop: 100 })));
    assert.equal(five.title, '5 платежів чекають вашого підпису');
    assert.match(five.body, /^А, Б, В і ще 2: разом 5,00 грн/);
    assert.equal(pay.reminderText([{ amountKop: 1 }, { amountKop: 1 }]).title, '2 платежі чекають вашого підпису');
});

test('повторна відправка невдалого платежу (replaceId) скасовує старий failed-платіж, а classifyTx розносить payroll-unlinked без помилки', async () => {
    const Module = require('node:module');
    const origLoad = Module._load;
    Module._load = function (request, parent, isMain) {
        if (request === 'firebase-functions/v2/https') {
            class HttpsError extends Error {
                constructor(code, message, details) { super(message); this.code = code; this.details = details; }
            }
            return { onCall: (opts, fn) => typeof opts === 'function' ? opts : fn, HttpsError };
        }
        if (request === 'firebase-functions/v2/scheduler') return { onSchedule: (opts, fn) => fn };
        if (request === 'firebase-functions/logger') return { info: () => {}, warn: () => {}, error: () => {} };
        return origLoad.apply(this, arguments);
    };

    try {
        const docs = new Map();
        const FieldValue = {
            serverTimestamp: () => 'TS',
            delete: () => '__DELETE__',
            increment: n => n,
            arrayUnion: (...x) => x,
            arrayRemove: (...x) => x
        };
        const applyPatch = (old = {}, patch = {}) => {
            const next = { ...old };
            for (const [k, v] of Object.entries(patch)) {
                if (v === '__DELETE__') delete next[k];
                else next[k] = v;
            }
            return next;
        };
        const docRef = path => ({
            id: path.split('/').pop(),
            path,
            async get() {
                const d = docs.get(path);
                return { id: this.id, exists: d !== undefined, ref: this, data: () => d ? { ...d } : undefined };
            },
            async set(data, opts) {
                docs.set(path, opts?.merge ? applyPatch(docs.get(path) || {}, data) : applyPatch({}, data));
            },
            async update(patch) {
                docs.set(path, applyPatch(docs.get(path) || {}, patch));
            }
        });
        const queryCollection = (col, filters = []) => ({
            where(field, op, val) { return queryCollection(col, [...filters, { field, op, val }]); },
            limit() { return this; },
            async get() {
                const res = [];
                for (const [k, v] of docs.entries()) {
                    if (!k.startsWith(col + '/')) continue;
                    const match = filters.every(f => {
                        const fieldVal = f.field.split('.').reduce((o, p) => o?.[p], v);
                        if (f.op === '==') return fieldVal === f.val;
                        if (f.op === 'in') return Array.isArray(f.val) && f.val.includes(fieldVal);
                        return true;
                    });
                    if (match) {
                        const r = docRef(k);
                        res.push({ id: r.id, exists: true, ref: r, data: () => ({ ...v }) });
                    }
                }
                return { empty: res.length === 0, size: res.length, docs: res };
            }
        });
        let seq = 0;
        const db = {
            doc: path => docRef(path),
            collection: name => ({
                doc: (id) => docRef(`${name}/${id || `auto-${++seq}`}`),
                add: async data => { const r = docRef(`${name}/auto-${++seq}`); await r.set(data); return r; },
                where: (f, op, v) => queryCollection(name, [{ field: f, op, val: v }]),
                get: () => queryCollection(name, []).get()
            }),
            async runTransaction(fn) {
                const t = {
                    get: r => r.get(),
                    set: (r, d, o) => r.set(d, o),
                    update: (r, p) => r.update(p),
                    create: (r, d) => r.set(d),
                    delete: r => { docs.delete(r.path); }
                };
                return fn(t);
            }
        };

        const ownIban = 'UA213223130000026007233566001';
        const recIban = 'UA903052992990004149123456789';
        docs.set('bank/settings', {
            demo: true,
            accounts: { [ownIban]: { currency: 'UAH', available: true, purpose: 'current', balanceKop: 500000 } }
        });
        // Старий невдалий платіж із довільним ID (як у демо чи старій базі)
        docs.set('payments/legacy-failed-id', {
            kind: 'tax',
            recipient: { name: 'ГУ ДПС', iban: recIban, code: '43005393' },
            amountKop: 33294,
            purpose: '*;101;Військовий збір за вересень 2026',
            account: ownIban,
            status: 'failed',
            proposalKey: 'manual:demo-failed'
        });

        const paymentsMod = require('./payments')({
            db, FieldValue, Timestamp: { fromDate: d => d },
            requireAdmin: async () => '1', staffRole: async () => 'chair',
            notify: async () => {}, lock: { assertOpen: async () => {} }
        });

        // 1. Повторна відправка з replaceId автоматично скасовує старий failed-платіж
        const created = await paymentsMod.actions.create('1', 'chair', {
            kind: 'tax',
            recipient: { name: 'ГУ ДПС в Одеській обл.', iban: recIban, code: '43005393' },
            amountKop: 33294,
            purpose: '*;101;Військовий збір за вересень 2026',
            account: ownIban,
            proposalKey: 'manual:demo-failed',
            replaceId: 'legacy-failed-id'
        });
        assert.equal(docs.get('payments/legacy-failed-id').status, 'canceled');
        assert.equal(docs.get('payments/legacy-failed-id').replacedBy, created.id);
        assert.equal(docs.get(`payments/${created.id}`).status, 'sent');

        // 2. Класифікація списання з виписки, яке отримало paymentId + status: 'review' (payroll-unlinked)
        const txId = `${ownIban}_TX-TAX-1`;
        docs.set(`payments/${created.id}`, {
            ...docs.get(`payments/${created.id}`),
            status: 'paid',
            txId
        });
        docs.set(`bank_tx/${txId}`, {
            bankId: 'TX-TAX-1',
            account: ownIban,
            period: '2026-10',
            direction: 'out',
            currency: 'UAH',
            amountKop: 33294,
            purpose: '*;101;Військовий збір за вересень 2026',
            kind: 'expense',
            category: 'taxes',
            status: 'review',
            reason: 'payroll-unlinked',
            paymentId: created.id
        });

        const bankMod = require('./bank')({
            db, FieldValue, Timestamp: { fromDate: d => d },
            requireAdmin: async () => '1', staffRole: async () => 'chair',
            balances: { recompute: async () => {} },
            lock: { assertOpen: async () => {} }
        });

        const clRes = await bankMod.actions.classifyTx('1', 'chair', { txId, kind: 'expense', category: 'taxes' });
        assert.equal(clRes.ok, true);
        const updatedTx = docs.get(`bank_tx/${txId}`);
        assert.equal(updatedTx.status, 'done');
        assert.equal(updatedTx.category, 'taxes');
        assert.equal(updatedTx.paymentId, created.id);
        assert.equal(updatedTx.reason, undefined);

        // Перевіряємо, що reconciliation-core проходить без жодної помилки
        const { reconcile } = require('./reconciliation-core');
        const issues = reconcile({
            period: '2026-10',
            bankTx: [{ id: txId, ...updatedTx }],
            payments: [{ id: created.id, ...docs.get(`payments/${created.id}`) }]
        });
        assert.deepEqual(issues, []);
    } finally {
        Module._load = origLoad;
    }
});
