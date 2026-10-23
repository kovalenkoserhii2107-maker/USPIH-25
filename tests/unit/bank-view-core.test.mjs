// «Банк»: операції за днями, відбори, категорії, спосіб розподілу, проводки та інтерактивні звʼязки.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    dayLabel, byDay, quickAssign, filterTx,
    txCategoryKey, txCategoryInfo, txDistributionInfo,
    describeTxAccountingEntry, resolveTxLinks, sameEntity
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

test('спосіб розподілу платежу: автоматично, вручну, очікує рішення', () => {
    const autoTx = { status: 'done', kind: 'payment', auto: true, method: 'account' };
    assert.equal(txDistributionInfo(autoTx).mode, 'auto');
    assert.equal(txDistributionInfo(autoTx).shortLabel, 'Автоматично');
    assert.equal(txDistributionInfo(autoTx).label, 'Розподілено автоматично');
    assert.equal(txDistributionInfo(autoTx).reason, 'за особовим рахунком');

    const manualTx = { status: 'done', kind: 'payment', auto: false, method: 'manual', resolvedBy: 'Бухгалтер' };
    assert.equal(txDistributionInfo(manualTx).mode, 'manual');
    assert.equal(txDistributionInfo(manualTx).shortLabel, 'Вручну');
    assert.equal(txDistributionInfo(manualTx).label, 'Розподілено вручну');
    assert.match(txDistributionInfo(manualTx).reason, /Бухгалтер/);

    const reviewTx = { status: 'review', kind: 'payment' };
    assert.equal(txDistributionInfo(reviewTx).mode, 'review');
    assert.equal(txDistributionInfo(reviewTx).shortLabel, 'Очікує рішення');
});

test('відбори, пошук та розширені фільтри (дата, сума, контрагент, категорія, напрямок)', () => {
    const list = [
        {
            id: 'tx-telecom',
            status: 'done',
            direction: 'in',
            kind: 'income',
            category: 'equipment',
            auto: true,
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
            auto: true,
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
            auto: false,
            method: 'manual',
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
    assert.deepEqual(filterTx(list, 'all', 'вручну').map(t => t.id), ['tx-apt']);

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

    // Коли договір є в реєстрі
    const links = resolveTxLinks(telecomTx, {
        suppliers: [{ id: 'sup-1', name: 'ТОВ «Одеса-Телеком Мережа»', code: '38451920', iban: 'UA443052990000026005556667771' }],
        contracts: [{ id: 'con-1', supplierId: 'sup-1', supplierName: 'ТОВ «Одеса-Телеком Мережа»', number: 'С-10/26', date: '2026-01-15', subject: 'Договір сервітуту (доступ та розміщення телекомунікаційного обладнання)', status: 'approved' }]
    });
    assert.equal(links.counterpartyLink.kind, 'supplier');
    assert.equal(links.counterpartyLink.id, 'sup-1');
    assert.equal(links.contractLink.id, 'con-1');
    assert.equal(links.contractLink.number, 'С-10/26');
    assert.equal(links.contractLink.inDatabase, true);

    // Коли договір витягується з призначення платежу
    const fallbackLinks = resolveTxLinks(telecomTx, { suppliers: [], contracts: [] });
    assert.equal(fallbackLinks.contractLink.subject, 'Договір сервітуту (доступ та розміщення телекомунікаційного обладнання)');
});

test('назви контрагентів: організаційна форма — лише окремим словом, договір іншого постачальника не підставляється', () => {
    assert.equal(sameEntity('ТОВ «Водоканал»', 'водоканал'), true);
    assert.equal(sameEntity('ФОП Іваненко', 'ФОП Іваненко Петро'), true);
    assert.equal(sameEntity('ТОВ «Атлант»', 'ТОВ «Лант»'), false);
    assert.equal(sameEntity('ат', 'Атлант'), false);
    const contracts = [{ id: 'c-other', number: '1', supplierName: 'ТОВ «Ліфт-Сервіс» (демо)', status: 'approved' }];
    const tx = { id: 't1', direction: 'out', amountKop: 10000, status: 'review', purpose: 'Оплата за договором № 1 від 01.10.2026', counterparty: { name: 'ТОВ «Клінінг» (демо)' } };
    assert.equal(resolveTxLinks(tx, { contracts }).contractLink?.inDatabase, false);
});

test('пошук за сумою розуміє кому й пробіли: «1 250,50»', () => {
    const list = [{ id: 'a', amountKop: 125050, status: 'done' }, { id: 'b', amountKop: 30000, status: 'done' }];
    assert.deepEqual(filterTx(list, 'all', '1 250,50').map(t => t.id), ['a']);
    assert.deepEqual(filterTx(list, 'all', '300,00').map(t => t.id), ['b']);
});

test('сторнована банком операція не має проводки', () => {
    assert.equal(describeTxAccountingEntry({ id: 'v', direction: 'in', kind: 'payment', status: 'done', bankVoided: true, amountKop: 100 }), null);
});

// ------------------------------------------------------------
// Підсумки, контрагенти з виписки, досьє YouControl
// ------------------------------------------------------------
import { bankSummary, counterpartyKey, counterparties, filterCounterparties, dossierView, supplierDraft } from '../../js/bank-view-core.js';

const OPS = [
    { id: 't1', direction: 'in', kind: 'payment', status: 'done', amountKop: 50000, allocations: [{ apt: '7', amountKop: 50000 }], counterparty: { name: 'Власник Тестовий 7' }, at: '2026-10-05T10:00:00Z' },
    { id: 't2', direction: 'out', kind: 'expense', category: 'supplier', status: 'done', amountKop: 1480000, counterparty: { name: 'ТОВ «Буд-Ремонт» (демо)', code: '43555062', account: 'UA00 0000' }, at: '2026-10-04T10:00:00Z' },
    { id: 't3', direction: 'out', kind: 'expense', category: 'supplier', status: 'done', amountKop: 20000, counterparty: { name: 'ТОВ Буд-Ремонт', code: '43555062' }, at: '2026-10-08T10:00:00Z' },
    { id: 't4', direction: 'out', kind: 'expense', category: 'bank_fee', status: 'done', amountKop: 500, counterparty: { name: 'АТ КБ «ПриватБанк»', code: '14360570' }, at: '2026-10-04T11:00:00Z' },
    { id: 't5', direction: 'out', kind: 'internal', status: 'done', amountKop: 3000000, counterparty: { name: 'ОСББ' }, at: '2026-10-08T12:00:00Z' },
    { id: 't6', direction: 'in', kind: 'income', category: 'equipment', status: 'done', amountKop: 1925408, counterparty: { name: 'ТОВ «Телеком-Сервіс» (демо)', code: '36555074' }, at: '2026-10-05T12:00:00Z' },
    { id: 't7', direction: 'out', kind: 'expense', category: 'salary', status: 'review', amountKop: 206920, counterparty: { name: 'Працівник ОСББ (демо)' }, at: '2026-10-01T09:00:00Z' },
    { id: 't8', direction: 'out', kind: 'expense', status: 'review', amountKop: 279400, counterparty: { name: 'ТОВ «Дах-Сервіс» (демо)', code: '42444058' }, at: '2026-10-01T08:00:00Z' },
    { id: 't9', direction: 'in', kind: 'payment', status: 'review', amountKop: 28522, counterparty: { name: 'Власник Тестовий 38' }, at: '2026-10-06T08:00:00Z' }
];

test('підсумки: надійшло, списано, категорії; власні перекази не рахуються', () => {
    const s = bankSummary(OPS);
    assert.equal(s.inKop, 50000 + 1925408 + 28522);
    assert.equal(s.outKop, 1480000 + 20000 + 500 + 206920 + 279400);
    assert.equal(s.internal, 1);
    assert.equal(s.netKop, s.inKop - s.outKop);
    assert.equal(s.inCats[0].key, 'equipment');
    assert.equal(s.outCats[0].key, 'supplier');
    assert.equal(s.outCats[0].kop, 1500000);
    assert.ok(Math.abs(s.outCats.reduce((a, c) => a + c.share, 0) - 1) < 1e-9);
});

test('контрагенти: групування за кодом, ролі, картка в довіднику, без співвласників і зарплати', () => {
    assert.equal(counterpartyKey({ code: '43555062', name: 'x' }), 'c:43555062');
    assert.equal(counterpartyKey({ account: 'ua 12 34' }), 'i:UA1234');
    assert.equal(counterpartyKey({ name: 'ТОВ «Дах»' }), 'n:дах');
    const list = counterparties(OPS, [{ id: 's1', name: 'Буд-Ремонт', code: '43555062', iban: 'UA1' }]);
    assert.deepEqual(list.map(c => c.code), ['36555074', '43555062', '42444058', '14360570']);
    const bud = list.find(c => c.code === '43555062');
    assert.equal(bud.n, 2);
    assert.equal(bud.outKop, 1500000);
    assert.equal(bud.supplier.id, 's1');
    assert.equal(bud.role, 'supplier');
    assert.equal(bud.checkable, true);
    assert.deepEqual(bud.txIds, ['t2', 't3']);
    assert.equal(list.find(c => c.code === '36555074').role, 'income');
    assert.equal(list.find(c => c.code === '14360570').role, 'bank');
    assert.equal(list.find(c => c.code === '42444058').review, 1);
    assert.ok(!list.some(c => /Власник|Працівник|ОСББ$/.test(c.name)));
});

test('контрагенти: відбори', () => {
    const list = counterparties(OPS, [{ id: 's1', name: 'Буд-Ремонт', code: '43555062' }]).map(c => ({ ...c, risk: c.code === '42444058' ? 'bad' : '' }));
    assert.deepEqual(filterCounterparties(list, 'unknown').map(c => c.code), ['42444058']);
    assert.deepEqual(filterCounterparties(list, 'risk').map(c => c.code), ['42444058']);
    assert.deepEqual(filterCounterparties(list, 'income').map(c => c.code), ['36555074']);
    assert.deepEqual(filterCounterparties(list, 'all', 'телеком').map(c => c.code), ['36555074']);
    assert.deepEqual(filterCounterparties(list, 'all', '4244').map(c => c.code), ['42444058']);
});

test('досьє YouControl: рівень ризику, факти, чернетка картки', () => {
    assert.equal(dossierView(null), null);
    assert.equal(dossierView({ found: false, needRetry: true }).level, 'wait');
    assert.equal(dossierView({ found: false }).level, 'bad');
    const ok = dossierView({ found: true, isRegistered: true, stateText: 'Зареєстровано', director: 'Директор Тестовий', taxSystem: 'Загальна система, платник ПДВ', vatCode: '435550626543', registrationDate: '2016-06-13', mainKved: { code: '43.91', name: 'Покрівельні роботи' }, taxDebtTotal: 0, riskFlags: [], sandbox: true });
    assert.equal(ok.level, 'ok');
    assert.equal(ok.sandbox, true);
    assert.deepEqual(ok.facts.find(f => f[0] === 'Дата реєстрації'), ['Дата реєстрації', '13.06.2016']);
    assert.deepEqual(ok.facts.find(f => f[0] === 'Основний КВЕД'), ['Основний КВЕД', '43.91 Покрівельні роботи']);
    assert.deepEqual(ok.facts.find(f => f[0] === 'Податковий борг'), ['Податковий борг', 'немає']);
    const bad = dossierView({ found: true, isRegistered: true, taxDebtTotal: 12500, openPenalties: 2, totalEnforcements: 5, riskFlags: ['Податковий борг: 12 500 грн', 'Відкритих виконавчих проваджень (боржник): 2'] });
    assert.equal(bad.level, 'bad');
    assert.deepEqual(bad.flags.map(f => f.level), ['bad', 'warn']);
    assert.deepEqual(bad.facts.find(f => f[0] === 'Виконавчі провадження'), ['Виконавчі провадження', '2 відкритих з 5']);
    assert.equal(dossierView({ found: true, isRegistered: true, riskFlags: ['ФОП на загальній системі'] }).level, 'warn');
    assert.equal(dossierView({ found: true, isRegistered: false, stateText: 'Припинено', riskFlags: [] }).level, 'bad');
    const same = { found: true, isRegistered: true, fullName: 'ТОВАРИСТВО З ОБМЕЖЕНОЮ ВІДПОВІДАЛЬНІСТЮ «ДАХ-СЕРВІС»', riskFlags: [] };
    assert.equal(dossierView(same, 'ТОВ «Дах-Сервіс» (демо)').level, 'ok');
    const other = dossierView({ ...same, fullName: 'ТОВ «ОДЕСА-ЛІФТСЕРВІС»' }, 'ТОВ «Дах-Сервіс» (демо)');
    assert.equal(other.level, 'warn');
    assert.match(other.flags[0].text, /не збігається/);

    const draft = supplierDraft({ edrpou: '42444058', shortName: 'ТОВ «Дах-Сервіс»', director: 'Д. Т.', mainKved: { code: '43.91', name: 'Покрівля' }, taxDebtTotal: 0, stateText: 'Зареєстровано' }, { iban: 'UA213052990000026007054321001' });
    assert.equal(draft.kind, 'company');
    assert.equal(draft.iban, 'UA213052990000026007054321001');
    assert.equal(draft.mainKved, '43.91 Покрівля');
    assert.equal(draft.registrationStatus, 'Зареєстровано');
    const upd = supplierDraft({ edrpou: '3124567809', name: 'ФОП Тест' }, {}, { id: 's9', iban: 'UA1', note: 'стара' });
    assert.equal(upd.id, 's9');
    assert.equal(upd.kind, 'fop');
    assert.equal(upd.iban, 'UA1');
    assert.equal(upd.note, 'стара');
});

test('операції одного контрагента: відбір за ключем', () => {
    assert.deepEqual(filterTx(OPS, 'all', '', { cpKey: 'c:43555062' }).map(t => t.id), ['t2', 't3']);
});
