// «Документи»: вкладки, позначки стану, рахунок і акт однієї послуги, вигляд скана.
import test from 'node:test';
import assert from 'node:assert/strict';
import { bucketOf, chipOf, filterDocs, docCounts, mainsFor, twinOf, scanKind, remaining } from '../../js/docs-core.js';

const docs = [
    { id: 'a', status: 'pending', supplierId: 's1', docType: 'invoice', period: '2026-10', amountKop: 684000, date: '2026-10-31', supplierName: 'Постачальник Перший', number: '418', description: 'Вивезення сміття' },
    { id: 'b', status: 'approved', supplierId: 's1', docType: 'act', period: '2026-10', amountKop: 684000, date: '2026-10-31', supplierName: 'Постачальник Перший', number: '418', description: 'Вивезення сміття' },
    { id: 'c', status: 'approved', supplierId: 's2', docType: 'invoice', period: '2026-10', amountKop: 814000, paidKop: 400000, date: '2026-11-03', supplierName: 'Постачальник Другий', number: '77', description: 'Ліфти' },
    { id: 'd', status: 'paid', supplierId: 's3', docType: 'waybill', period: '2026-10', amountKop: 186000, paidKop: 186000, date: '2026-10-20', supplierName: 'Постачальник Третій', number: '3381', description: 'Лампи' },
    { id: 'e', status: 'approved', supplierId: 's3', docType: 'invoice', period: '2026-10', amountKop: 50000, stornoKop: 50000, date: '2026-10-21', supplierName: 'Постачальник Третій', number: '9', description: 'Повернено' },
    { id: 'f', status: 'canceled', supplierId: 's3', docType: 'invoice', period: '2026-09', amountKop: 1000, date: '2026-09-01', supplierName: 'Постачальник Третій', number: '1', description: '' },
    { id: 'g', status: 'rejected', supplierId: 's2', docType: 'act', period: '2026-10', amountKop: 2000, date: '2026-10-02', supplierName: 'Постачальник Другий', number: '5', description: '' }
];

test('вкладки: у «Витратах» — що чекає дії, решта — в архіві', () => {
    assert.deepEqual(docs.map(bucketOf), ['work', 'work', 'work', 'archive', 'archive', 'archive', 'work']);
    assert.deepEqual(docCounts(docs), { work: 4, archive: 2 });
    assert.equal(remaining(docs[2]), 414000);
});

test('порядок і пошук: спершу на затвердження, далі до оплати, далі від новіших', () => {
    assert.deepEqual(filterDocs(docs, 'work').map(e => e.id), ['a', 'c', 'b', 'g']);
    assert.deepEqual(filterDocs(docs, 'archive').map(e => e.id), ['e', 'd', 'f']);
    assert.deepEqual(filterDocs(docs, 'work', 'ліфти').map(e => e.id), ['c']);
    assert.deepEqual(filterDocs(docs, 'work', '418').map(e => e.id), ['a', 'b']);
});

test('позначки: жовтим — дія того, хто дивиться', () => {
    assert.deepEqual(chipOf(docs[0]), ['Чекає голову', '']);
    assert.deepEqual(chipOf(docs[0], { chair: true }), ['Затвердити', 'is-work']);
    assert.deepEqual(chipOf(docs[1]), ['Сплатити', 'is-work']);
    assert.deepEqual(chipOf(docs[1], { paying: true }), ['На підписі', '']);
    assert.deepEqual(chipOf(docs[2]), ['Доплатити', 'is-work']);
    assert.deepEqual(chipOf(docs[3]), ['Оплачено', 'is-done']);
    assert.deepEqual(chipOf(docs[4]), ['Сторновано', '']);
    assert.deepEqual(chipOf(docs[6]), ['Відхилено', 'is-bad']);
});

test('рахунок і акт однієї послуги: пропонуємо обʼєднати', () => {
    assert.deepEqual(mainsFor(docs[0], docs).map(e => e.id), ['b']);
    assert.equal(twinOf(docs[0], docs)?.id, 'b');
    // Інша сума чи вже оплачений документ — не пара.
    assert.equal(twinOf(docs[6], docs), null);
    assert.equal(twinOf(docs[3], docs), null);
});

test('скан: картинка, PDF чи просто файл', () => {
    assert.equal(scanKind({ name: 'akt.JPG' }), 'image');
    assert.equal(scanKind({ name: 'x', type: 'image/png' }), 'image');
    assert.equal(scanKind({ name: 'rahunok.pdf' }), 'pdf');
    assert.equal(scanKind({ name: 'dogovir.docx' }), 'file');
    assert.equal(scanKind({ name: 'photo.heic' }), 'file');
});
