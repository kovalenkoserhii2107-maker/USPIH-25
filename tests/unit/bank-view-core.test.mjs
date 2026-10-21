// «Банк»: операції за днями, відбори, категорії, проводки та інтерактивні звʼязки.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    dayLabel, byDay, quickAssign, filterTx,
    txCategoryKey, txCategoryInfo, describeTxAccountingEntry, resolveTxLinks
} from '../../js/bank-view-core.js';

const now = new Date(2026, 9, 21, 15, 0); // 21 жовтня 2026
const at = (d, h = 10) => new Date(2026, 9, d, h);

test('дні: сьогодні, учора, дата; інший рік — з роком', () => {
    assert.equal(dayLabel(at(21, 1), now), 'Сьогодні');
    assert.equal(dayLabel(at(20, 23), now), 'Учора');
    assert.equal(dayLabel(at(19), now), '19 жовтня');
    assert.match(dayLabel(new Date(2025, 11, 31), now), /31 грудня 2025/);
    const groups = byDay([{ id: 1, at: at(21) }, { id: 2, at: at(21, 8) }, { id: 3, at: at(20) }, { id: 4, at: at(19) }], now);
    assert.deepEqual(groups.map(g => [g.label, g.rows.map(r => r.id)]), [['Сьогодні', [1, 2]], ['Учора', [3]], ['19 жовтня', [4]]]);
});

test('рішення в один дотик — лише одна квартира для надходження', () => {
    const tx = (extra) => ({ status: 'review', direction: 'in', kind: 'payment', ...extra });
    assert.deepEqual(quickAssign(tx({ suggestions: [{ apt: '112', reason: 'імʼя власника' }] })), { apt: '112', sure: true });
    assert.deepEqual(quickAssign(tx({ suggestions: [{ apt: 203, reason: 'число в призначенні' }] })), { apt: '203', sure: false });
    assert.equal(quickAssign(tx({ suggestions: [{ apt: '1' }, { apt: '2' }] })), null);
    assert.equal(quickAssign(tx({ suggestions: [] })), null);
    assert.equal(quickAssign(tx({ kind: 'income', suggestions: [{ apt: '1' }] })), null);
    assert.equal(quickAssign(tx({ direction: 'out', suggestions: [{ apt: '1' }] })), null);
    assert.equal(quickAssign({ status: 'done', direction: 'in', suggestions: [{ apt: '1' }] }), null);
});

test('відбори, пошук та розширені фільтри (дата, сума, контрагент, категорія, напрямок)', () => {
    const list = [
        {
            id: 'tx-telecom',
            status: 'done',
            direction: 'in',
            kind: 'income',
            category: 'equipment',
            amountKop: 250000,
            at: at(21, 8),
            account: 'UA213052990000026001234567890',
            counterparty: { name: 'ТОВ «Одеса-Телеком Мережа»', code: '38451920', account: 'UA443052990000026005556667771' },
            purpose: 'Оплата за договором сервітуту (доступ та розміщення телекомунікаційного обладнання) за жовтень 2026 р., без ПДВ'
        },
        {
            id: 'tx-fee',
            status: 'done',
            direction: 'out',
            kind: 'expense',
            category: 'bank_fee',
            amountKop: 15000,
            at: at(20, 14),
            account: 'UA213052990000026001234567890',
            counterparty: { name: 'АТ КБ «ПРИВАТБАНК»', code: '14360570' },
            purpose: 'Комісія за розрахунково-касове обслуговування рахунку згідно з тарифами банку'
        },
        {
            id: 'tx-apt',
            status: 'done',
            direction: 'in',
            kind: 'payment',
            amountKop: 85000,
            at: at(19, 11),
            account: 'UA213052990000026001234567890',
            allocations: [{ apt: '19', amountKop: 85000 }],
            counterparty: { name: 'Мельник Олена Іванівна' },
            purpose: 'Внески за утримання будинку, кв 19'
        },
        {
            id: 'tx-review',
            status: 'review',
            direction: 'in',
            kind: 'payment',
            amountKop: 27418,
            at: at(18, 9),
            account: 'UA213052990000026001234567890',
            counterparty: { name: 'Платник А' },
            purpose: 'внесок кв 47'
        }
    ];

    assert.deepEqual(filterTx(list, 'review').map(t => t.id), ['tx-review']);
    assert.deepEqual(filterTx(list, 'done').map(t => t.id), ['tx-telecom', 'tx-fee', 'tx-apt']);
    assert.deepEqual(filterTx(list, 'all', 'кв 19').map(t => t.id), ['tx-apt']);
    assert.deepEqual(filterTx(list, 'all', '2500').map(t => t.id), ['tx-telecom']);

    // Напрямок
    assert.deepEqual(filterTx(list, 'all', '', { direction: 'out' }, now).map(t => t.id), ['tx-fee']);
    assert.deepEqual(filterTx(list, 'all', '', { direction: 'in' }, now).map(t => t.id), ['tx-telecom', 'tx-apt', 'tx-review']);

    // Категорія платежу
    assert.deepEqual(filterTx(list, 'all', '', { category: 'equipment' }, now).map(t => t.id), ['tx-telecom']);
    assert.deepEqual(filterTx(list, 'all', '', { category: 'bank_fee' }, now).map(t => t.id), ['tx-fee']);
    assert.deepEqual(filterTx(list, 'all', '', { category: 'apt_payment' }, now).map(t => t.id), ['tx-apt']);

    // Дата (пресети Сьогодні / Учора та діапазон)
    assert.deepEqual(filterTx(list, 'all', '', { datePreset: 'today' }, now).map(t => t.id), ['tx-telecom']);
    assert.deepEqual(filterTx(list, 'all', '', { datePreset: 'yesterday' }, now).map(t => t.id), ['tx-fee']);
    assert.deepEqual(filterTx(list, 'all', '', { dateFrom: '2026-10-19', dateTo: '2026-10-20' }, now).map(t => t.id), ['tx-fee', 'tx-apt']);

    // Сума (від — до)
    assert.deepEqual(filterTx(list, 'all', '', { amountMinKop: 50000, amountMaxKop: 100000 }, now).map(t => t.id), ['tx-apt']);

    // Контрагент
    assert.deepEqual(filterTx(list, 'all', '', { counterparty: '38451920' }, now).map(t => t.id), ['tx-telecom']);
    assert.deepEqual(filterTx(list, 'all', '', { counterparty: 'приватбанк' }, now).map(t => t.id), ['tx-fee']);
});

test('категорії, проводки (Дт/Кт) та інтерактивні посилання на контрагента і договір', () => {
    const telecomTx = {
        id: 'tx-telecom',
        status: 'done',
        direction: 'in',
        kind: 'income',
        category: 'equipment',
        period: '2026-10',
        amountKop: 250000,
        at: at(21, 8),
        account: 'UA213052990000026001234567890',
        counterparty: { name: 'ТОВ «Одеса-Телеком Мережа»', code: '38451920', account: 'UA443052990000026005556667771' },
        purpose: 'Оплата за договором сервітуту (доступ та розміщення телекомунікаційного обладнання) за жовтень 2026 р., без ПДВ'
    };

    assert.equal(txCategoryKey(telecomTx), 'equipment');
    assert.equal(txCategoryInfo(telecomTx).label, 'Розміщення обладнання й реклами');

    const entry = describeTxAccountingEntry(telecomTx);
    assert.equal(entry.dr, '311');
    assert.equal(entry.cr, '48');
    assert.equal(entry.codeText, 'Дт 311 — Кт 48');
    assert.equal(entry.focusAcc, '48');

    const links = resolveTxLinks(telecomTx, {
        suppliers: [{ id: 'sup-1', name: 'ТОВ «Одеса-Телеком Мережа»', code: '38451920', iban: 'UA443052990000026005556667771' }],
        contracts: [{ id: 'con-1', supplierId: 'sup-1', supplierName: 'ТОВ «Одеса-Телеком Мережа»', number: 'С-10/26', date: '2026-01-15', subject: 'Договір сервітуту (доступ та розміщення телекомунікаційного обладнання)', status: 'approved' }]
    });
    assert.equal(links.counterpartyLink.kind, 'supplier');
    assert.equal(links.counterpartyLink.id, 'sup-1');
    assert.equal(links.contractLink.id, 'con-1');
    assert.equal(links.contractLink.number, 'С-10/26');
    assert.equal(links.contractLink.inDatabase, true);
});
