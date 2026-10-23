'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const youscore = require('./youscore');

describe('YouScore API v1 integration module (Sandbox, Async Polling & Helpers)', () => {
    it('correctly identifies sandbox keys', () => {
        assert.equal(youscore.isSandboxKey(youscore.SANDBOX_KEY), true);
        assert.equal(youscore.isSandboxKey('YOUSCORE_TEST_KEY_USPIH25_SANDBOX'), true);
        assert.equal(youscore.isSandboxKey('real_prod_api_key_123456'), false);
    });

    it('parses Ukrainian full names into LastName, FirstName, MiddleName', () => {
        const p1 = youscore.parseFullName('Коваленко Сергій Миколайович');
        assert.equal(p1.lastName, 'Коваленко');
        assert.equal(p1.firstName, 'Сергій');
        assert.equal(p1.middleName, 'Миколайович');

        const p2 = youscore.parseFullName('Шевченко Тетяна Миколаївна, Кравчук Ігор Петрович');
        assert.equal(p2.lastName, 'Шевченко');
        assert.equal(p2.firstName, 'Тетяна');
        assert.equal(p2.middleName, 'Миколаївна');
    });

    it('returns sandbox rate limits when using sandbox key', async () => {
        const limits = await youscore.checkRateLimits(youscore.SANDBOX_KEY);
        assert.equal(limits.sandbox, true);
        assert.ok(limits.remainingTransactions > 0);
    });

    it('fetches full counterparty card for Legal Entity (8 digits) in sandbox mode', async () => {
        const card = await youscore.checkCounterpartyFull(youscore.SANDBOX_KEY, '39404434');
        assert.equal(card.found, true);
        assert.equal(card.edrpou, '39404434');
        assert.equal(card.kind, 'company');
        assert.ok(card.name.includes('ЛІФТСЕРВІС'));
        assert.ok(card.director.length > 5);
        assert.ok(card.address.includes('Одеса'));
        assert.ok(card.kveds.length >= 2);
        assert.equal(card.taxInfo.isVatPayer, true);
        assert.equal(card.isSafe, true);
    });

    it('fetches full counterparty card for FOP (10 digits) in sandbox mode', async () => {
        const card = await youscore.checkCounterpartyFull(youscore.SANDBOX_KEY, '2985412365');
        assert.equal(card.found, true);
        assert.equal(card.edrpou, '2985412365');
        assert.equal(card.kind, 'fop');
        assert.ok(card.name.startsWith('ФОП'));
        assert.equal(card.taxInfo.isSingleTax, true);
        assert.equal(card.taxInfo.singleTaxGroup, 3);
    });

    it('fetches court cases and enforcement proceedings for debtor in sandbox mode', async () => {
        const res = await youscore.checkDebtorCourtAndEnforcement(youscore.SANDBOX_KEY, {
            ownerName: 'Шевченко Сергій Іванович',
            ownerCode: '2845112390',
            apt: '14'
        });
        assert.equal(res.sandbox, true);
        assert.ok(res.courtCases.length > 0);
        assert.ok(res.scheduledHearings.length > 0);
        assert.ok(res.enforcements.length > 0);
        assert.equal(res.courtCases[0].courtName, 'Київський районний суд м. Одеси');
    });

    it('fetches real estate objects from DRRP (/v1/realEstate) in sandbox mode', async () => {
        const res = await youscore.checkRealEstateByCode(youscore.SANDBOX_KEY, {
            code: '2845112390',
            apt: '14',
            ownerName: 'Шевченко Сергій Іванович'
        });
        assert.equal(res.sandbox, true);
        assert.ok(res.objects.length >= 1);
        assert.equal(res.objects[0].matchesHouse, true);
        assert.equal(res.objects[0].matchesApt, true);
        assert.equal(res.objects[0].details.owners[0].code, '2845112390');
    });

    it('handles HTTP 202 async polling via resultId/resultUrl correctly', async () => {
        let calls = 0;
        const mockFetch = async () => {
            calls += 1;
            if (calls === 1) {
                return {
                    status: 202,
                    ok: true,
                    text: async () => JSON.stringify({
                        status: 'Update in progress',
                        resultId: 'abc-123',
                        resultUrl: 'https://api.youscore.com.ua/v1/realEstate/result/abc-123'
                    })
                };
            }
            return {
                status: 200,
                ok: true,
                text: async () => JSON.stringify([
                    {
                        id: '969625073-1234',
                        dataType: 0,
                        data: 'Одеська обл., м. Одеса, вулиця Інглезі, будинок 3/3, квартира 25',
                        region: 'Одеська область',
                        district: 'м. Одеса'
                    }
                ])
            };
        };

        const res = await youscore.checkRealEstateByCode('prod_key_test', {
            code: '1234567890',
            apt: '25'
        }, { fetchImpl: mockFetch, fetchDetails: false });

        assert.equal(res.sandbox, false);
        assert.equal(res.objects.length, 1);
        assert.equal(res.objects[0].matchesHouse, true);
        assert.equal(res.objects[0].matchesApt, true);
    });
});
