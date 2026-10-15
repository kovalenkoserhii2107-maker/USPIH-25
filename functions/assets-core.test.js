'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const assets = require('./assets-core');
const annualReportCore = require('./annual-report-core');
const annualFormsCore = require('./annual-forms-core');

test('класифікація активів за НП(С)БО 7, НП(С)БО 9 та пп. 14.1.138 ПКУ (поріг 20 000 грн)', () => {
    assert.equal(assets.recommendClassification({ unitCostKop: 500_000, consumable: true }).acc, '20');
    assert.equal(assets.recommendClassification({ unitCostKop: 350_000, usefulLifeMonths: 12 }).acc, '22');
    const mnhma = assets.recommendClassification({ unitCostKop: 2_000_000, usefulLifeMonths: 36 });
    assert.equal(mnhma.acc, '11');
    assert.equal(mnhma.subacc, '112');
    assert.equal(mnhma.deprMethod, 'mnhma_100');
    const oz = assets.recommendClassification({ unitCostKop: 2_000_001, usefulLifeMonths: 60 });
    assert.equal(oz.acc, '10');
    assert.equal(oz.subacc, '104');
    assert.equal(oz.deprMethod, 'straight');

    assert.equal(assets.suggestAssetId('10', ['ОЗ-001', 'ОЗ-002']), 'ОЗ-003');
    assert.equal(assets.suggestAssetId('11', []), 'МНМА-001');
    assert.equal(assets.suggestAssetId('20', ['ТМЦ-001']), 'ТМЦ-002');
    assert.equal(assets.suggestAssetId('22', []), 'МШП-001');
});

test('амортизація ОЗ (10): прямолінійний метод з наступного місяця після введення в експлуатацію (п. 29 НП(С)БО 7)', () => {
    const gen = {
        id: 'ОЗ-001',
        acc: '10',
        name: 'Генератор дизельний 15 кВт',
        costKop: 12_000_000,
        salvageKop: 0,
        usefulLifeMonths: 60,
        deprMethod: 'straight',
        commissionedDate: '2026-10-15',
        wearBeforePeriodKop: 0,
        deprThisPeriodKop: 0
    };
    assert.equal(assets.monthlyDepreciationFor(gen, '2026-10'), 0);
    assert.equal(assets.monthlyDepreciationFor(gen, '2026-11'), 200_000);
    assert.equal(assets.monthlyDepreciationFor({ ...gen, wearBeforePeriodKop: 11_950_000 }, '2031-10'), 50_000);
    assert.equal(assets.monthlyDepreciationFor({ ...gen, wearBeforePeriodKop: 12_000_000 }, '2031-11'), 0);
});

test('амортизація МНМА (11): методи 100 % та 50 % / 50 % у першому місяці використання (п. 27 НП(С)БО 7)', () => {
    const pump100 = {
        id: 'МНМА-001',
        acc: '11',
        name: 'Мотопомпа дренажна',
        costKop: 1_500_000,
        deprMethod: 'mnhma_100',
        commissionedDate: '2026-10-20',
        wearBeforePeriodKop: 0,
        deprThisPeriodKop: 0
    };
    assert.equal(assets.monthlyDepreciationFor(pump100, '2026-09'), 0);
    assert.equal(assets.monthlyDepreciationFor(pump100, '2026-10'), 1_500_000);
    assert.equal(assets.monthlyDepreciationFor({ ...pump100, wearBeforePeriodKop: 1_500_000 }, '2026-11'), 0);

    const tool50 = {
        id: 'МНМА-002',
        acc: '11',
        name: 'Перфоратор професійний',
        costKop: 800_000,
        deprMethod: 'mnhma_50_50',
        commissionedDate: '2026-10-10',
        wearBeforePeriodKop: 0,
        deprThisPeriodKop: 0
    };
    assert.equal(assets.monthlyDepreciationFor(tool50, '2026-10'), 400_000);
    assert.equal(assets.monthlyDepreciationFor({ ...tool50, wearBeforePeriodKop: 400_000 }, '2026-11'), 0);
});

test('наскрізний цикл ОЗ, МНМА, Запасів (20) та МШП (22) у проводках, ОСВ та річному Балансі (Форма № 1-мс / 2-мс)', () => {
    const expenses = [
        {
            id: 'exp-oz',
            supplierId: 's1',
            supplierName: 'ТОВ ЕНЕРГОМАШ',
            docType: 'waybill',
            number: 'ВН-101',
            date: '2026-10-05',
            period: '2026-10',
            amountKop: 9_000_000,
            item: 'systems',
            postingAcc: '10',
            assetId: 'ОЗ-001',
            ownedByOsbb: true,
            fundId: 'main',
            description: 'Генератор дизельний 12 кВт',
            status: 'approved'
        },
        {
            id: 'exp-mnhma',
            supplierId: 's1',
            supplierName: 'ТОВ ЕНЕРГОМАШ',
            docType: 'waybill',
            number: 'ВН-102',
            date: '2026-10-06',
            period: '2026-10',
            amountKop: 1_200_000,
            item: 'cleaning',
            postingAcc: '11',
            assetId: 'МНМА-001',
            ownedByOsbb: true,
            fundId: 'main',
            description: 'Мотокоса бензинова',
            status: 'approved'
        },
        {
            id: 'exp-fuel',
            supplierId: 's2',
            supplierName: 'ТОВ ОККО',
            docType: 'waybill',
            number: 'ВН-205',
            date: '2026-10-10',
            period: '2026-10',
            amountKop: 1_100_000,
            item: 'systems',
            postingAcc: '20',
            assetId: 'ТМЦ-001',
            assetQty: 200,
            assetUnit: 'л',
            ownedByOsbb: true,
            fundId: 'main',
            description: 'Паливо дизельне для генератора',
            status: 'approved'
        },
        {
            id: 'exp-mshp',
            supplierId: 's2',
            supplierName: 'ТОВ ЕПІЦЕНТР',
            docType: 'waybill',
            number: 'ВН-301',
            date: '2026-10-12',
            period: '2026-10',
            amountKop: 400_000,
            item: 'cleaning',
            postingAcc: '22',
            assetId: 'МШП-001',
            assetQty: 10,
            assetUnit: 'шт.',
            ownedByOsbb: true,
            fundId: 'main',
            description: 'Лопати снігоприбиральні посилені',
            status: 'approved'
        }
    ];

    const assetCards = [
        { id: 'ОЗ-001', acc: '10', subacc: '104', name: 'Генератор дизельний 12 кВт', commissionedDate: '2026-10-05', deprMethod: 'straight', usefulLifeMonths: 60, item: 'systems', fundId: 'main' },
        { id: 'МНМА-001', acc: '11', subacc: '112', name: 'Мотокоса бензинова', commissionedDate: '2026-10-06', deprMethod: 'mnhma_100', usefulLifeMonths: 36, item: 'cleaning', fundId: 'main' },
        { id: 'ТМЦ-001', acc: '20', subacc: '203', name: 'Паливо дизельне для генератора', initialQty: 200, unit: 'л', item: 'systems', fundId: 'main' },
        { id: 'МШП-001', acc: '22', subacc: '22', name: 'Лопати снігоприбиральні посилені', initialQty: 10, unit: 'шт.', custodian: 'Двірник Іваненко П.П.', item: 'cleaning', fundId: 'main', retiredQty: 2 }
    ];

    const octInitial = assets.reconcileAssets({ assets: assetCards, expenses, period: '2026-10' });
    const octDepr = assets.planMonthlyDepreciation(octInitial.items, '2026-10');
    assert.equal(octDepr.items.length, 1);
    assert.equal(octDepr.items[0].id, 'МНМА-001');
    assert.equal(octDepr.totalKop, 1_200_000);

    const fuelWriteOff = assets.planInventoryWriteOff(octInitial.items.find(x => x.id === 'ТМЦ-001'), {
        date: '2026-10-25', qty: 50, reason: 'Робота генератора під час відключень у жовтні'
    });
    assert.equal(fuelWriteOff.error, null);
    assert.equal(fuelWriteOff.amountKop, 275_000);

    const mshpHandover = assets.planInventoryWriteOff(octInitial.items.find(x => x.id === 'МШП-001'), {
        date: '2026-10-15', qty: 10, reason: 'Видано двірнику для зимового прибирання'
    });
    assert.equal(mshpHandover.error, null);
    assert.equal(mshpHandover.amountKop, 400_000);

    const adjustments = [
        { id: 'n-oct-depr', period: '2026-10', date: '2026-10-31', status: 'approved', lines: octDepr.lines, note: 'Амортизація МНМА за жовтень' },
        { id: 'n-oct-fuel', period: '2026-10', date: '2026-10-25', status: 'approved', qty: 50, lines: [fuelWriteOff.line], note: fuelWriteOff.note },
        { id: 'n-oct-mshp', period: '2026-10', date: '2026-10-15', status: 'approved', qty: 10, lines: [mshpHandover.line], note: mshpHandover.note }
    ];
    const novBefore = assets.reconcileAssets({ assets: assetCards, expenses, adjustments, period: '2026-11' });
    const novDepr = assets.planMonthlyDepreciation(novBefore.items, '2026-11');
    assert.equal(novDepr.items.length, 1);
    assert.equal(novDepr.items[0].id, 'ОЗ-001');
    assert.equal(novDepr.totalKop, 150_000);
    adjustments.push({ id: 'n-nov-depr', period: '2026-11', date: '2026-11-30', status: 'approved', lines: novDepr.lines, note: 'Амортизація ОЗ за листопад' });

    const novAfter = assets.reconcileAssets({ assets: assetCards, expenses, adjustments, period: '2026-11' });
    assert.equal(novAfter.summary.fixedCostKop, 10_200_000);
    assert.equal(novAfter.summary.fixedWearKop, 1_350_000);
    assert.equal(novAfter.summary.fixedNetKop, 8_850_000);
    const fuelCard = novAfter.items.find(x => x.id === 'ТМЦ-001');
    assert.equal(fuelCard.remainingQty, 150);
    assert.equal(fuelCard.costKop, 825_000);
    const mshpCard = novAfter.items.find(x => x.id === 'МШП-001');
    assert.equal(mshpCard.costKop, 0);
    assert.equal(mshpCard.inUseQty, 8);
    assert.equal(mshpCard.status, 'in_use_offbalance');

    const policy = {
        startDate: '2026-01-01',
        status: 'approved',
        defaultFund: 'main',
        funds: [{ id: 'main', name: 'Основний фонд' }],
        incomeAccounts: {},
        reportingForm: 'micro',
        version: 1
    };
    const report = annualReportCore.annual({
        year: '2026',
        previousIncome: { incomeKop: 0, costKop: 0 },
        policy,
        openingStatus: 'approved',
        closed: ['2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10', '2026-11', '2026-12'],
        today: '2027-01-05',
        input: {
            start: '2026-01',
            startDate: '2026-01-01',
            policy,
            opening: {
                status: 'approved',
                lines: [
                    { acc: '311', a: 'UA213052990000026001234567890', side: 'dr', kop: 15_000_000 },
                    { acc: '48', a: 'main', side: 'cr', kop: 15_000_000 }
                ]
            },
            expenses,
            adjustments,
            ledgers: new Map()
        }
    });
    assert.equal(report.complete, true, JSON.stringify(report.checks));
    const settings = {
        financingTerm: 'long',
        deposit351: 'investment',
        noViolation: true,
        noIncomeTax: true,
        comparatives: { salesKop: 0, operatingKop: 0, otherKop: 0, costOfSalesKop: 0, otherCostKop: 0, otherOperatingCostKop: 0 },
        assignments: {}
    };
    for (const g of annualFormsCore.groups(report)) {
        settings.assignments[g.id] = {
            category: g.kind === 'cost' ? 'maintenance' : 'contributions',
            row: g.kind === 'cost' ? '2.3' : '1.9'
        };
    }
    const forms = annualFormsCore.build(report, settings);
    assert.equal(forms.reviewReady, true, JSON.stringify(forms.checks));
    const bRow = code => forms.balance.find(r => r.code === code);
    assert.equal(bRow('1011').endKop, 10_200_000);
    assert.equal(bRow('1012').endKop, 1_350_000);
    assert.equal(bRow('1010').endKop, 8_850_000);
    assert.equal(bRow('1100').endKop, 825_000);
    const fRow = code => forms.results.find(r => r.code === code);
    assert.equal(fRow('2160').kop, 2_025_000);
    assert.equal(fRow('2165').kop, 2_025_000);
    assert.equal(fRow('2280').kop, 2_025_000);
    assert.equal(fRow('2285').kop, 2_025_000);
    assert.equal(fRow('2350').kop, 0);
});

test('ліквідація обʼєкта ОЗ / МНМА за Актом ОЗ-3 списує накопичений знос і залишкову вартість', () => {
    const asset = {
        id: 'МНМА-002',
        acc: '11',
        name: 'Перфоратор',
        item: 'repair',
        fundId: 'main',
        costKop: 800_000,
        wearKop: 400_000,
        netKop: 400_000
    };
    const plan = assets.planAssetDisposal(asset, {
        date: '2026-12-20',
        actNo: 'ОЗ-3/2',
        reason: 'Вихід з ладу електродвигуна, ремонт економічно недоцільний'
    });
    assert.equal(plan.error, null);
    assert.equal(plan.lines.length, 2);
    assert.deepEqual(plan.lines[0], { dr: '132', cr: '11', dA: 'МНМА-002', cA: 'МНМА-002', kop: 400_000, fund: 'main' });
    assert.deepEqual(plan.lines[1], { dr: '92', cr: '11', dA: 'repair', cA: 'МНМА-002', kop: 400_000, fund: 'main' });
});

test('єдина система інвентарних номерів та збереження старого номера (legacyId) при міграції з попередньої системи обліку', () => {
    const opening = {
        status: 'approved',
        lines: [
            { acc: '131', a: 'Інв-104/12', side: 'cr', kop: 1_500_000, memo: 'Знос генератора' },
            { acc: '10', a: 'Інв-104/12', side: 'dr', kop: 6_000_000, memo: 'Генератор інверторний 5,5 кВт' },
            { acc: '20', a: 'СКЛ-0045', side: 'dr', kop: 800_000, memo: 'Дизельне паливо зимове' }
        ]
    };
    const policy = { startDate: '2026-10-01', defaultFund: 'main' };
    const state = assets.reconcileAssets({ opening, policy, period: '2026-10' });

    const gen = state.items.find(x => x.legacyId === 'Інв-104/12');
    assert.ok(gen, 'Обʼєкт ОЗ має знаходитися за старим інвентарним номером Інв-104/12');
    assert.equal(gen.id, 'ОЗ-001', 'Обʼєкту автоматично присвоєно єдиний інвентарний номер ОЗ-001');
    assert.equal(gen.name, 'Генератор інверторний 5,5 кВт');
    assert.equal(gen.costKop, 6_000_000);
    assert.equal(gen.wearKop, 1_500_000);
    assert.equal(gen.netKop, 4_500_000);

    const fuel = state.items.find(x => x.legacyId === 'СКЛ-0045');
    assert.ok(fuel, 'ТМЦ має знаходитися за старим номенклатурним номером СКЛ-0045');
    assert.equal(fuel.id, 'ТМЦ-001', 'ТМЦ автоматично присвоєно єдиний номенклатурний номер ТМЦ-001');
    assert.equal(fuel.costKop, 800_000);

    // Перевірка наскрізної підстановки наступного вільного номера з урахуванням усіх джерел
    const allIds = assets.collectExistingAssetIds({
        assets: state.items,
        opening,
        expenses: [{ status: 'approved', assetId: 'ОЗ-002' }],
        advanceReports: [{ status: 'approved', lines: [{ postingAcc: '20', assetId: 'ТМЦ-002' }] }]
    });
    assert.equal(assets.suggestAssetId('10', allIds), 'ОЗ-003');
    assert.equal(assets.suggestAssetId('20', allIds), 'ТМЦ-003');
});
