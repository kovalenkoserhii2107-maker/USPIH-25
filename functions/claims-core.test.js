'use strict';
const test = require("node:test");
const assert = require("node:assert/strict");
const claims = require("./claims-core");

const org = {
    edrpou: "40562894",
    name: "ОСББ «Успіх-25»",
    address: "вул. Інглезі, 3/3, м. Одеса",
    legalAddress: "65101, Одеська обл., м. Одеса, вул. Інглезі, 3/3",
    iban: "UA213052990000026001234567890",
    phone: "+380487000000",
    email: "uspih25@example.com",
    headName: "Сергій Миколайович"
};

test("grnToKop коректно переводить гривневий баланс квартири (напр. -8277.40 грн) у копійки (-827740 коп.)", () => {
    assert.equal(claims.grnToKop(-8277.4), -827740);
    assert.equal(claims.grnToKop("-8277,40"), -827740);
    assert.equal(claims.grnToKop("-20 264,53"), -2026453);
    assert.equal(claims.fmtKop(Math.abs(claims.grnToKop(-8277.4))), "8\u00a0277,40");
});

test("розрахунок претензійних сум у режимі воєнного стану (пеня = 0, судовий збір = 302,80 грн)", () => {
    const res = claims.calculateClaimTotals({
        debtKop: 827740, // 8 277,40 грн
        monthsOverdue: 14,
        isMartialLaw: true,
        daysOverdue: 150,
        penaltyPerDayKop: 83
    });

    assert.equal(res.principalKop, 827740);
    assert.equal(res.penaltyKop, 0); // У воєнний стан пеня заборонена
    assert.equal(res.threePercentKop, 0);
    assert.equal(res.courtFeeOrderKop, 30280); // 302,80 грн
    assert.equal(res.totalClaimKop, 827740);
    assert.equal(res.isMartialLaw, true);
});

test("розрахунок претензійних сум у мирний час (після скасування воєнного стану: 3% річних, інфляційні та пеня)", () => {
    const res = claims.calculateClaimTotals({
        debtKop: 1000000, // 10 000 грн
        monthsOverdue: 6,
        isMartialLaw: false,
        daysOverdue: 180,
        penaltyPerDayKop: 100, // 1 грн/день
        inflationRate: 0.05 // 5% інфляції
    });

    assert.equal(res.principalKop, 1000000);
    assert.equal(res.penaltyKop, 18000); // 180 днів * 1 грн = 180 грн = 18000 коп
    assert.equal(res.threePercentKop, Math.round(1000000 * 0.03 * (180 / 365)));
    assert.equal(res.inflationKop, 50000); // 5% від 10 000 грн = 500 грн = 50000 коп
    assert.ok(res.totalClaimKop > 1000000);
    assert.equal(res.isMartialLaw, false);
});

test("генерація досудової претензії (вимоги): містить ПІБ власника, о/р, площу, ст. 15 ЗУ Про ОСББ та Постанову КМУ № 1405", () => {
    const text = claims.generatePreTrialClaim({
        org,
        apt: "208",
        ownerName: "Кузьменко Оксана Сергіївна",
        personalAccount: "401230208",
        area: 63.3,
        debtKop: 827740,
        monthlyKop: 58426,
        periodFrom: "2025-08",
        periodTo: "2026-10",
        isMartialLaw: true,
        claimDate: "2026-10-15"
    });

    assert.match(text, /ДОСУДОВА ПРЕТЕНЗІЯ/);
    assert.match(text, /Кузьменко Оксана Сергіївна/);
    assert.match(text, /401230208/);
    assert.match(text, /кв\. 208/);
    assert.match(text, /8\s*277,40\s*грн/);
    assert.match(text, /статті 15 Закону України «Про обʼєднання співвласників/);
    assert.match(text, /постанови Кабінету Міністрів України від 29\.12\.2023 № 1405/);
    assert.match(text, /UA213052990000026001234567890/);
});

test("генерація заяви про видачу судового наказу: містить ст. 161 ЦПК, Київський районний суд м. Одеси та судовий збір 302,80 грн", () => {
    const text = claims.generateCourtOrderApp({
        org,
        apt: "208",
        ownerName: "Кузьменко Оксана Сергіївна",
        ownerCode: "2987654321",
        personalAccount: "401230208",
        area: 63.3,
        debtKop: 827740,
        periodFrom: "2025-08",
        periodTo: "2026-10",
        isMartialLaw: true,
        appDate: "2026-10-15"
    });

    assert.match(text, /Київський районний суд м\. Одеси/);
    assert.match(text, /ЗАЯВА[\s\S]*про видачу судового наказу/);
    assert.match(text, /Кузьменко Оксана Сергіївна/);
    assert.match(text, /пункту 3 частини 1 статті 161 Цивільного процесуального кодексу/);
    assert.match(text, /8\s*277,40\s*грн/);
    assert.match(text, /302,80 грн/); // судовий збір
    assert.match(text, /ПРОШУ СУД:/);
});

test("генерація довідки-розрахунку заборгованості за особовим рахунком з записами ledger", () => {
    const text = claims.generateDebtCalculation({
        org,
        apt: "208",
        ownerName: "Кузьменко Оксана Сергіївна",
        personalAccount: "401230208",
        area: 63.3,
        debtKop: 827740,
        periodFrom: "2026-09",
        periodTo: "2026-10",
        ledgerEntries: [
            { kind: "opening", amount: -7693.14, period: "2026-09", at: new Date("2026-09-30T00:00:00Z") },
            { kind: "charge", amount: 584.26, period: "2026-10", at: new Date("2026-10-01T00:00:00Z") }
        ],
        calcDate: "2026-10-15"
    });

    assert.match(text, /ДОВІДКА-РОЗРАХУНОК ЗАБОРГОВАНОСТІ/);
    assert.match(text, /401230208/);
    assert.match(text, /Кузьменко Оксана Сергіївна/);
    assert.match(text, /Вхідний залишок/);
    assert.match(text, /Нараховано внесок/);
    assert.match(text, /8\s*277,40\s*грн/);
});

test("генерація договору реструктуризації боргу: помісячний графік погашення та обовʼязок сплати поточних внесків", () => {
    const text = claims.generateRestructureAgreement({
        org,
        apt: "78",
        ownerName: "Сидоренко Світлана Олексіївна",
        debtKop: 1200000, // 12 000 грн
        monthsCount: 6,
        startDate: "2026-11-01",
        agreementDate: "2026-10-15"
    });

    assert.match(text, /ДОГОВІР[\s\S]*про реструктуризацію заборгованості/);
    assert.match(text, /12\s*000,00\s*грн/);
    assert.match(text, /розстрочення.*на 6 місяців/);
    assert.match(text, /2\s*000,00\s*грн/); // 12 000 / 6 = 2 000 грн/міс
    assert.match(text, /своєчасно і в повному обсязі сплачувати щомісячні поточні внески/);
});
