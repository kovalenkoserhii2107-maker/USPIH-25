'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const x = require('./expenses-core');

// РНОКПП з правильною контрольною цифрою — з перших дев'яти цифр.
function rnokpp(nine) {
    const d = nine.split('').map(Number);
    const sum = [-1, 5, 7, 9, 4, 6, 10, 5, 7].reduce((s, w, i) => s + w * d[i], 0);
    return nine + String(((sum % 11) + 11) % 11 % 10);
}
function iban(body = '3052990000026001234567890') {
    for (let k = 0; k < 100; k++) {
        const cand = `UA${String(k).padStart(2, '0')}${body}`;
        const digits = (cand.slice(4) + cand.slice(0, 4)).replace(/[A-Z]/g, c => String(c.charCodeAt(0) - 55));
        let rest = 0;
        for (const ch of digits) rest = (rest * 10 + Number(ch)) % 97;
        if (rest === 1) return cand;
    }
}

test('ЄДРПОУ й РНОКПП: контрольна цифра', () => {
    assert.equal(x.validEdrpou('14360570'), true);    // ПриватБанк
    assert.equal(x.validEdrpou('40075815'), true);    // Укрзалізниця
    assert.equal(x.validEdrpou('14360571'), false);
    assert.equal(x.validEdrpou('1436057'), false);
    const code = rnokpp('312456789');
    assert.equal(x.validRnokpp(code), true);
    assert.equal(x.validRnokpp(code.slice(0, 9) + String((Number(code[9]) + 1) % 10)), false);
    assert.equal(x.validRnokpp('12345'), false);
});

test('постачальник: перевірка й застереження', () => {
    assert.equal(x.checkSupplier({ name: 'ТОВ Ліфт', kind: 'company', code: '14360570', iban: iban() }), null);
    assert.match(x.checkSupplier({ name: 'ТОВ Ліфт', kind: 'company', code: '14360571' }), /ЄДРПОУ/);
    assert.match(x.checkSupplier({ name: 'ФОП Іваненко', kind: 'fop', code: '14360570' }), /РНОКПП/);
    assert.match(x.checkSupplier({ name: 'ТОВ', kind: 'company', code: '14360570', iban: 'UA00123' }), /IBAN/);
    assert.match(x.checkSupplier({ name: 'X', kind: 'company', code: '14360570' }), /назву/);
    assert.match(x.supplierWarnings({ kind: 'person' })[0], /ЦПД/);
    assert.match(x.supplierWarnings({ kind: 'fop' })[0], /витяг/);
    assert.deepEqual(x.supplierWarnings({ kind: 'fop', fopChecked: true }), []);
});

const contract = (extra = {}) => ({ supplierId: 's1', number: '12/26', date: '2026-09-20', subject: 'Обслуговування ліфтів', type: 'monthly',
    monthlyKop: 425000, validFrom: '2026-10-01', validTo: '2027-09-30', item: 'lift', status: 'approved', ...extra });

test('договір: ліміт 50 000 грн за статутом', () => {
    assert.equal(x.contractTotal(contract()), 425000 * 12);
    assert.equal(x.contractTotal(contract({ validTo: '' })), 425000 * 12);
    assert.equal(x.contractTotal(contract({ validTo: '2026-12-31' })), 425000 * 3);
    assert.equal(x.contractTotal({ type: 'fixed', amountKop: 900000 }), 900000);
    assert.match(x.checkContract(contract()), /загальних зборів/);
    assert.equal(x.checkContract(contract({ meetingDecision: 'Протокол зборів № 3 від 12.09.2026' })), null);
    assert.equal(x.checkContract(contract({ validTo: '2026-12-31' })), null);          // 12 750 грн — правління
    assert.equal(x.checkContract({ ...contract(), type: 'fixed', amountKop: 5_000_000 }), null);   // рівно 50 000 — ще правління
    assert.match(x.checkContract({ ...contract(), type: 'fixed', amountKop: 5_000_001 }), /50 000/);
    assert.match(x.checkContract(contract({ validTo: '2026-09-01' })), /раніше/);
    assert.match(x.checkContract(contract({ item: 'x' })), /статтю/);
});

const doc = (extra = {}) => ({ supplierId: 's1', docType: 'act', number: '101', date: '2026-10-31', amountKop: 425000, period: '2026-10',
    item: 'lift', description: 'Обслуговування ліфтів за жовтень 2026', ...extra });

test('документ: перевірка й хто затверджує', () => {
    assert.equal(x.checkExpense(doc()), null);
    assert.match(x.checkExpense(doc({ amountKop: 0 })), /суму/);
    assert.match(x.checkExpense(doc({ vatKop: 425000 })), /ПДВ/);
    assert.match(x.checkExpense(doc({ date: '2026-02-30' })), /дату/);
    assert.match(x.checkExpense(doc({ period: '2026-13' })), /місяць/);
    // За договором у межах місячної суми — бухгалтер.
    assert.deepEqual(x.approvalLevel(doc(), contract(), 0), { level: 'accountant', reason: 'за договором № 12/26' });
    // Другий акт за той самий місяць — понад договір, голова.
    assert.equal(x.approvalLevel(doc(), contract(), 425000).level, 'chair');
    // Договір ще не затверджено або документ поза строком дії.
    assert.equal(x.approvalLevel(doc(), contract({ status: 'pending' }), 0).level, 'chair');
    assert.equal(x.approvalLevel(doc({ date: '2027-10-05' }), contract(), 0).level, 'chair');
    // Без договору — голова, якщо поріг дрібних витрат не задано.
    assert.equal(x.approvalLevel(doc({ amountKop: 30000 }), null, 0).level, 'chair');
    assert.equal(x.approvalLevel(doc({ amountKop: 30000 }), null, 0, { smallKop: 50000 }).level, 'accountant');
});

test('списання → документ: точна сума — сама, інакше підказки', () => {
    const suppliers = [{ id: 's1', code: '14360570', iban: iban() }, { id: 's2', code: '40075815' }];
    const expenses = [
        { id: 'e1', supplierId: 's1', status: 'approved', amountKop: 425000 },
        { id: 'e2', supplierId: 's1', status: 'approved', amountKop: 120000, paidKop: 20000 },
        { id: 'e3', supplierId: 's1', status: 'pending', amountKop: 100000 },
        { id: 'e4', supplierId: 's2', status: 'paid', amountKop: 100000, paidKop: 100000 }
    ];
    const tx = (amountKop, cp) => ({ direction: 'out', amountKop, counterparty: cp });
    assert.deepEqual(x.matchExpense(tx(425000, { code: '14360570' }), expenses, suppliers), { auto: 'e1', suggestions: ['e1'] });
    assert.deepEqual(x.matchExpense(tx(100000, { account: iban() }), expenses, suppliers), { auto: 'e2', suggestions: ['e2'] });
    assert.deepEqual(x.matchExpense(tx(5000, { code: '14360570' }), expenses, suppliers), { auto: null, suggestions: ['e1', 'e2'] });
    assert.deepEqual(x.matchExpense(tx(100000, { code: '40075815' }), expenses, suppliers), { auto: null, suggestions: [] });
    assert.deepEqual(x.matchExpense({ ...tx(425000, { code: '14360570' }), direction: 'in' }, expenses, suppliers), { auto: null, suggestions: [] });
});

test('призначення платежу й нагадування про акти', () => {
    assert.equal(x.purposeFor(doc()), 'Оплата за актом № 101 від 31.10.2026, Обслуговування ліфтів за жовтень 2026, без ПДВ');
    assert.equal(x.purposeFor(doc({ docType: 'invoice', vatKop: 70833 })), 'Оплата за рахунком № 101 від 31.10.2026, Обслуговування ліфтів за жовтень 2026, у т.ч. ПДВ 708.33 грн');
    const c = { ...contract(), id: 'c1' };
    assert.deepEqual(x.missingDocs([c], [], '2026-11-06'), [{ contractId: 'c1', period: '2026-10' }]);
    assert.deepEqual(x.missingDocs([c], [], '2026-11-04'), []);
    assert.deepEqual(x.missingDocs([c], [{ contractId: 'c1', period: '2026-10', status: 'approved' }], '2026-11-06'), []);
    assert.deepEqual(x.missingDocs([c], [], '2026-10-06'), []);       // за вересень договір ще не діяв
    assert.deepEqual(x.missingDocs([{ ...c, status: 'pending' }], [], '2026-11-06'), []);
});
