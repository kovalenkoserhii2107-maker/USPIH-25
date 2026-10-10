'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const bank = require('./bank-core');

const known = {
    apts: new Set(['3', '10', '11', '45', '46', '298', '12а']),
    accounts: new Map([['1045', '45'], ['1298', '298']])
};
const ctx = (extra = {}) => ({
    known, ownAccounts: new Set(['UA213052990000026001234567890']), links: new Map(),
    owners: [
        { apt: '45', name: 'Шевченко Ірина Миколаївна' },
        { apt: '45', name: 'Шевченко Петро Олегович' },
        { apt: '46', name: 'Бондар Ганна Сергіївна' },
        { apt: '10', name: 'Коваленко Олена Петрівна' }
    ],
    ...extra
});
const incoming = (purpose, counterparty = {}) => ({ direction: 'in', amountKop: 125040, purpose, counterparty });

test('копійки рахуються без похибки float', () => {
    assert.equal(bank.toKop('1 250,40'), 125040);
    assert.equal(bank.toKop(0.1 + 0.2), 30);
    assert.equal(bank.toKop('-320.5'), -32050);
    assert.ok(Number.isNaN(bank.toKop('')));
});

test('номер квартири з позначкою в будь-якому написанні', () => {
    for (const purpose of ['кв.45', 'Кв 45 внесок', 'кв№45', 'квартира №45', 'КВ-РА 45', 'оплата за кв. 045 жовтень',
        'Інглезі 3/3 кв 45', 'внесок ОСББ, квартиры 45', 'apt 45']) {
        const r = bank.classify(incoming(purpose), ctx());
        assert.equal(r.status, 'matched', purpose);
        assert.equal(r.apt, '45', purpose);
        assert.equal(r.method, 'marked', purpose);
    }
});

test('особовий рахунок — з позначкою і без', () => {
    assert.deepEqual(bank.classify(incoming('о/р 1298 за жовтень'), ctx()).apt, '298');
    const bare = bank.classify(incoming('Оплата 1045 внески'), ctx());
    assert.equal(bare.apt, '45');
    assert.equal(bare.method, 'account');
});

test('номер будинку, дата й сума не плутаються з квартирою', () => {
    const r = bank.classify(incoming('Інглезі 3/3 за 10.2026 1250,40 грн'), ctx({ owners: [] }));
    assert.equal(r.status, 'review');
    assert.deepEqual(r.suggestions, []);
});

test('«голе» число — лише підказка', () => {
    const r = bank.classify(incoming('внесок 298 жовтень'), ctx());
    assert.equal(r.status, 'review');
    assert.deepEqual(r.suggestions.map(s => s.apt), ['298']);
});

test('дві квартири в одному платежі — на розгляд з обома', () => {
    const r = bank.classify(incoming('кв 45 та кв 46'), ctx());
    assert.equal(r.status, 'review');
    assert.equal(r.reason, 'several');
    assert.deepEqual(r.suggestions.map(s => s.apt).sort(), ['45', '46']);
});

test('перелік квартир після однієї позначки', () => {
    for (const purpose of ['кв 45 і кв 46', 'кв 45, 46', 'кв. 45 та 46', 'квартири 45 і 46 жовтень']) {
        const r = bank.classify(incoming(purpose), ctx());
        assert.equal(r.reason, 'several', purpose);
        assert.deepEqual(r.suggestions.map(s => s.apt).sort(), ['45', '46'], purpose);
    }
    // Сума після переліку не стає квартирою.
    assert.equal(bank.classify(incoming('кв 45, 1250,40 грн'), ctx()).apt, '45');
});

test('невідома квартира не розноситься', () => {
    const r = bank.classify(incoming('кв 999'), ctx({ owners: [] }));
    assert.equal(r.status, 'review');
});

test('літерна квартира', () => {
    assert.equal(bank.classify(incoming('кв 12а'), ctx()).apt, '12а');
});

test('запамʼятований платник розноситься сам, явна квартира важливіша', () => {
    const cp = { name: 'ШЕВЧЕНКО ІРИНА МИКОЛАЇВНА', account: 'UA00TRANSIT' };
    const links = new Map([[bank.payerKey(cp.name, cp.account), '45']]);
    const r = bank.classify(incoming('комунальні', cp), ctx({ links }));
    assert.deepEqual([r.status, r.apt, r.method], ['matched', '45', 'link']);
    const explicit = bank.classify(incoming('кв 46', cp), ctx({ links }));
    assert.equal(explicit.apt, '46');
});

test('ключ платника не залежить від регістру й пробілів', () => {
    assert.equal(bank.payerKey('Шевченко  Ірина', 'ua 00 1'), bank.payerKey('ШЕВЧЕНКО ІРИНА', 'UA001'));
    assert.notEqual(bank.payerKey('Шевченко Ірина', 'UA1'), bank.payerKey('Бондар Ганна', 'UA1'));
});

test('імʼя власника — підказка, а не автоматичне рознесення', () => {
    const r = bank.classify(incoming('внесок за жовтень', { name: 'Бондар Ганна Сергіївна' }), ctx());
    assert.equal(r.status, 'review');
    assert.deepEqual(r.suggestions, [{ apt: '46', reason: 'імʼя власника' }]);
    const initials = bank.classify(incoming('внесок', { name: 'БОНДАР Г.С.' }), ctx());
    assert.deepEqual(initials.suggestions.map(s => s.apt), ['46']);
});

test('юрособа без квартири — інше надходження з категорією', () => {
    const rent = bank.classify(incoming('Оплата за оренду місця на даху за жовтень', { name: 'ТОВ Київстар', code: '21673832' }), ctx());
    assert.deepEqual([rent.status, rent.category], ['other', 'rent']);
    const interest = bank.classify(incoming('Нарахування відсотків на залишок', { name: 'АТ КБ ПРИВАТБАНК', code: '14360570' }), ctx());
    assert.deepEqual([interest.status, interest.category], ['other', 'interest']);
    const grant = bank.classify(incoming('Співфінансування програми Енергодім'), ctx({ owners: [] }));
    assert.deepEqual([grant.status, grant.category], ['other', 'grant']);
});

test('переказ між своїми рахунками й списання', () => {
    const own = bank.classify(incoming('переказ на депозит', { account: 'UA21 3052 9900 0002 6001 2345 6789 0' }), ctx());
    assert.equal(own.status, 'internal');
    const fee = bank.classify({ direction: 'out', amountKop: 5000, purpose: 'Комісія за обслуговування рахунку', counterparty: {} }, ctx());
    assert.deepEqual([fee.status, fee.category], ['expense', 'bank_fee']);
});

test('період — за київською датою', () => {
    // 30 вересня 22:30 UTC — це вже 1 жовтня в Києві.
    assert.equal(bank.periodOf(new Date('2026-09-30T22:30:00Z')), '2026-10');
});

test('перевірка розбиття платежу', () => {
    const apts = known.apts;
    assert.equal(bank.checkAllocations([{ apt: '45', amountKop: 125040 }], 125040, apts), null);
    assert.equal(bank.checkAllocations([{ apt: '45', amountKop: 100000 }, { apt: '46', amountKop: 25040 }], 125040, apts), null);
    assert.match(bank.checkAllocations([{ apt: '45', amountKop: 100000 }], 125040, apts), /разом/);
    assert.match(bank.checkAllocations([{ apt: '999', amountKop: 125040 }], 125040, apts), /немає/);
    assert.match(bank.checkAllocations([{ apt: '45', amountKop: 1 }, { apt: '45', amountKop: 125039 }], 125040, apts), /двічі/);
    assert.match(bank.checkAllocations([], 1, apts), /Вкажіть/);
});

test('оренда й розміщення обладнання — дохід ОСББ, навіть з номером квартири', () => {
    const tx = (purpose, cp = {}) => ({ direction: 'in', amountKop: 120000, purpose, counterparty: { name: 'Петренко', account: '', code: '', ...cp } });
    const rent = bank.classify(tx('Оренда нежитлового приміщення по договору, кв. 45'), ctx());
    assert.deepEqual([rent.status, rent.category, rent.relatedApt], ['other', 'rent', '45']);
    const eq = bank.classify(tx('Плата за розміщення обладнання зв’язку за жовтень', { name: 'ТОВ ПРОВАЙДЕР', code: '14360570' }), ctx());
    assert.deepEqual([eq.status, eq.category], ['other', 'equipment']);
    // Звичайний внесок з номером квартири — як і раніше, у квартиру.
    assert.equal(bank.classify(tx('Утримання будинку кв. 45'), ctx()).status, 'matched');
});

test('повний формат призначення з сервісу ОСББ: о/р з нулями, адреса, корпус', () => {
    // Структура — як у реальних оплатах; цифри й імʼя умовні.
    const purpose = 'О/р 00401230045, м. Одеса, вул. Садова, буд. 3, корп. 3, кв. 45, від Іван Петренко, за комунальні послуги';
    const k = { apts: new Set(['3', '45']), accounts: new Map([['401230045', '45']]) };
    const r = bank.classify({ direction: 'in', amountKop: 40000, purpose, counterparty: { name: 'ПЕТРЕНКО ІВАН' } }, ctx({ known: k }));
    assert.deepEqual([r.status, r.apt, r.method], ['matched', '45', 'account']);
    // «буд. 3» і «корп. 3» — не квартира 3.
    assert.ok(!bank.aptCandidates(purpose, k).some(c => c.apt === '3'));
    // Нежитлове й «особовий рахунок» кирилицею повністю.
    const k2 = { apts: new Set(['302']), accounts: new Map([['1045', '45']]) };
    assert.ok(bank.aptCandidates('Нежитлове приміщення 302 оренда', k2).some(c => c.apt === '302' && c.strong));
    assert.ok(bank.aptCandidates('особовий рахунок 1045', { apts: new Set(['45']), accounts: new Map([['1045', '45']]) }).some(c => c.apt === '45' && c.method === 'account'));
});

test('ЄСВ — окрема стаття, ПДФО й військовий збір — податки', () => {
    const ctx = { known: { apts: new Set(), accounts: new Map(), byAccount: new Map() }, ownAccounts: new Set(), links: new Map(), owners: [] };
    const cat = purpose => bank.classify({ direction: 'out', amountKop: 100, purpose, counterparty: { name: 'ГУ ДПС', account: '', code: '' } }, ctx).category;
    assert.equal(cat('*;101;ЄСВ за вересень 2026'), 'esv');
    assert.equal(cat('Єдиний соціальний внесок із заробітної плати'), 'esv');
    assert.equal(cat('*;101;ПДФО із зарплати за вересень'), 'taxes');
    assert.equal(cat('Заробітна плата за вересень'), 'salary');
    assert.equal(bank.isEsv('єдиний внесок'), true);
});
