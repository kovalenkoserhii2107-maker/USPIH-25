'use strict';
// ============================================================
// Претензійно-позовна робота з боржниками ОСББ (серверна частина).
//
// Важливо:
// - Баланс у колекції apartments/{apt}.balance зберігається в ГРИВНЯХ
//   (відʼємне число — борг, додатне — переплата), тому переводимо його
//   в копійки через core.grnToKop(data.balance).
// - Співвласники зберігаються у підколекції apartments/{apt}/owners/{id},
//   яка читається одним запитом db.collectionGroup('owners').get().
// - Реквізити ОСББ (назва, ЄДРПОУ, IBAN, адреса будинку, ПІБ голови)
//   беруться з osbb_settings/finance, report_settings/main та bank/settings.
// ============================================================
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const callGuard = require('./call-guard');
const core = require('./claims-core');
const chargesCore = require('./charges-core');
const { cleanApt } = require('./bank-core');

const REGION = 'europe-central2';

module.exports = function claimsFunctions({ db, FieldValue, requireAdmin, staffRole }) {
    const fail = (code, message) => { throw new HttpsError(code, message); };
    const text = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
    const parseArea = v => {
        if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
        const n = parseFloat(String(v || '').replace(',', '.'));
        return Number.isFinite(n) ? n : 0;
    };

    function ownerApt(docRef) {
        const parts = String(docRef?.path || '').split('/');
        if (parts.length >= 3) return parts[parts.length - 3];
        return docRef?.parent?.parent?.id || '';
    }

    async function audit(actor, role, action, target, summary, details = {}) {
        await db.collection('audit_log').add({
            actor, role, action, target,
            summary: String(summary).slice(0, 300),
            details: JSON.parse(JSON.stringify(details)),
            at: FieldValue.serverTimestamp()
        });
    }

    async function context() {
        const [aptsSnap, ownersSnap, claimsSnap, finSnap, repSnap, bankSnap, chargesSnap] = await Promise.all([
            db.collection('apartments').get(),
            db.collectionGroup('owners').get(),
            db.collection('claims').get(),
            db.doc('osbb_settings/finance').get(),
            db.doc('report_settings/main').get(),
            db.doc('bank/settings').get(),
            db.doc('charges/settings').get()
        ]);

        // Групуємо співвласників за квартирою (apartments/{apt}/owners/{id})
        const ownersByApt = new Map();
        ownersSnap.forEach(d => {
            const rawApt = ownerApt(d.ref);
            const aptKey = cleanApt(rawApt) || rawApt;
            if (!aptKey) return;
            const o = d.data() || {};
            const name = String(o.name || '').trim();
            const docInfo = String(o.docInfo || '').trim();
            const shareFrac = String(o.shareFrac || '').trim();
            const explicitTin = String(o.rnokpp || o.tin || '').trim();
            const matchedTin = (docInfo.match(/\b(\d{10})\b/) || [])[1] || '';
            const rnokpp = explicitTin || matchedTin;
            const item = { id: d.id, name, docInfo, shareFrac, rnokpp };
            if (!ownersByApt.has(rawApt)) ownersByApt.set(rawApt, []);
            ownersByApt.get(rawApt).push(item);
            if (aptKey !== rawApt) {
                if (!ownersByApt.has(aptKey)) ownersByApt.set(aptKey, []);
                ownersByApt.get(aptKey).push(item);
            }
        });

        const claimsMap = new Map();
        claimsSnap.forEach(d => claimsMap.set(d.id, d.data()));

        // Розраховуємо місячний внесок по кожній квартирі для оцінки кількості місяців боргу
        const cData = chargesSnap.exists ? chargesSnap.data() : {};
        const nonAdminApts = aptsSnap.docs
            .filter(d => d.data().isAdmin !== true)
            .map(d => ({
                apt: cleanApt(d.id) || d.id,
                id: d.id,
                area: d.data().area ?? null,
                residents: d.data().residents ?? null,
                balance: d.data().balance ?? null,
                personalAccount: String(d.data().personalAccount || '').trim()
            }));

        const monthlyByApt = new Map();
        try {
            const preview = chargesCore.computeCharges({
                apartments: nonAdminApts,
                premises: cData.premises || {},
                tariffs: cData.tariffs || [],
                groups: cData.groups?.length ? cData.groups : chargesCore.DEFAULT_GROUPS,
                components: cData.components?.length ? cData.components : chargesCore.DEFAULT_COMPONENTS,
                period: chargesCore.currentPeriod()
            });
            for (const r of preview.rows || []) {
                monthlyByApt.set(String(r.apt), r.amountKop || 0);
            }
        } catch (_) {
            // Якщо тарифи ще не налаштовані, monthlyByApt лишається порожнім
        }

        const debtors = [];
        let totalDebtKop = 0;

        aptsSnap.forEach(d => {
            const data = d.data();
            if (data.isAdmin === true) return;

            // data.balance зберігається в гривнях (відʼємне — борг)
            const balanceKop = core.grnToKop(data.balance);
            if (balanceKop < 0) {
                const debtKop = Math.abs(balanceKop);
                totalDebtKop += debtKop;
                const aptId = d.id;
                const cleanId = cleanApt(aptId) || aptId;
                const claim = claimsMap.get(aptId) || claimsMap.get(cleanId) || { stage: 'pre_trial', status: 'none' };
                const owners = ownersByApt.get(aptId) || ownersByApt.get(cleanId) || [];

                const ownerNames = owners.map(o => o.name).filter(Boolean).join(', ')
                    || String(data.owner || (Array.isArray(data.owners) && data.owners[0]?.name) || '').trim();
                const ownerCodes = owners.map(o => o.rnokpp).filter(Boolean).join(', ')
                    || String((Array.isArray(data.owners) && data.owners[0]?.rnokpp) || '').trim();
                const docInfo = owners
                    .map(o => [o.name, o.shareFrac ? `частка ${o.shareFrac}` : '', o.docInfo].filter(Boolean).join(' — '))
                    .filter(Boolean)
                    .join('; ');

                const monthlyKop = monthlyByApt.get(cleanId) || monthlyByApt.get(aptId) || 0;
                const months = debtKop && monthlyKop ? Math.max(1, Math.round(debtKop / monthlyKop)) : 0;

                debtors.push({
                    apt: aptId,
                    entrance: String(data.entrance || '').trim(),
                    personalAccount: String(data.personalAccount || '').trim(),
                    ownersStatus: String(data.ownersStatus || 'pending'),
                    owners,
                    ownerName: claim.ownerNameOverride || ownerNames,
                    ownerCode: claim.ownerCodeOverride || ownerCodes,
                    docInfo,
                    area: parseArea(data.area != null && data.area !== '' ? data.area : (data.areaCenti ? data.areaCenti / 100 : 0)),
                    balance: Number((balanceKop / 100).toFixed(2)),
                    balanceKop,
                    debtKop,
                    monthlyKop,
                    months,
                    balanceParts: Array.isArray(data.balanceParts) ? data.balanceParts : [],
                    balanceUpdatedAt: data.balanceUpdatedAt?.toDate?.()?.toISOString() || (typeof data.balanceUpdatedAt === 'string' ? data.balanceUpdatedAt : null),
                    claim: {
                        stage: claim.stage || 'pre_trial',
                        status: claim.status || 'none',
                        caseNumber: claim.caseNumber || '',
                        claimDate: claim.claimDate || '',
                        courtOrderDate: claim.courtOrderDate || '',
                        lawsuitDate: claim.lawsuitDate || '',
                        enforcementDate: claim.enforcementDate || '',
                        periodFrom: claim.periodFrom || '',
                        periodTo: claim.periodTo || '',
                        ownerNameOverride: claim.ownerNameOverride || '',
                        ownerCodeOverride: claim.ownerCodeOverride || '',
                        note: claim.note || '',
                        restructureMonths: claim.restructureMonths || 0,
                        updatedAt: claim.updatedAt?.toDate?.()?.toISOString() || null
                    }
                });
            }
        });

        debtors.sort((a, b) => b.debtKop - a.debtKop);

        const fin = finSnap.exists ? finSnap.data() : {};
        const reg = fin.registry || {};
        const rep = repSnap.exists ? repSnap.data() : {};
        const bank = bankSnap.exists ? bankSnap.data() : {};
        const bankAccounts = Object.values(bank.accounts || {});
        const currentAcc = bankAccounts.find(a => a.purpose === 'current') || bankAccounts[0] || {};
        const iban = String(fin.iban || currentAcc.iban || '').replace(/\s+/g, '');

        const org = {
            name: fin.payeeName || reg.legalName || 'ОСББ «Успіх-25»',
            edrpou: fin.edrpou || reg.code || '40562894',
            address: fin.houseAddress || core.DEFAULT_HOUSE_ADDRESS,
            legalAddress: rep.address || reg.legalAddress || fin.houseAddress || core.DEFAULT_HOUSE_ADDRESS,
            zip: rep.zip || (String(reg.legalAddress || '').match(/\b(\d{5})\b/) || [])[1] || '65101',
            phone: rep.phone || fin.phone || '',
            email: rep.email || fin.email || '',
            headName: rep.headName || reg.headName || '',
            iban,
            purposeTemplate: fin.purposeTemplate || 'Внески на утримання будинку, кв. {apt}, особовий рахунок {account}'
        };

        const stats = {
            debtorsCount: debtors.length,
            totalDebtKop,
            over3MonthsCount: debtors.filter(d => d.months > 3).length,
            criticalCount: debtors.filter(d => d.debtKop >= 300000).length,
            claimsCount: debtors.filter(d => ['warning', 'claim'].includes(d.claim.status)).length,
            courtCount: debtors.filter(d => ['court_order_filed', 'court_order_issued', 'court_order_canceled', 'lawsuit_filed', 'lawsuit_satisfied'].includes(d.claim.status)).length,
            enforcementCount: debtors.filter(d => d.claim.status === 'enforcement').length,
            restructuredCount: debtors.filter(d => d.claim.status === 'restructured').length
        };

        return { debtors, stats, org, martialLaw: fin.martialLaw !== false };
    }

    async function saveClaim(actor, role, data) {
        const apt = text(data.apt, 20);
        if (!apt) fail('invalid-argument', 'Вкажіть номер квартири');

        const record = {
            apt,
            stage: text(data.stage || 'pre_trial', 40),
            status: text(data.status || 'none', 40),
            caseNumber: text(data.caseNumber, 80),
            claimDate: text(data.claimDate, 20),
            courtOrderDate: text(data.courtOrderDate, 20),
            lawsuitDate: text(data.lawsuitDate, 20),
            enforcementDate: text(data.enforcementDate, 20),
            periodFrom: text(data.periodFrom, 30),
            periodTo: text(data.periodTo, 30),
            ownerNameOverride: text(data.ownerNameOverride, 200),
            ownerCodeOverride: text(data.ownerCodeOverride, 120),
            note: text(data.note, 500),
            restructureMonths: Number(data.restructureMonths || 0),
            restructureStart: text(data.restructureStart, 20),
            updatedBy: actor,
            updatedAt: FieldValue.serverTimestamp()
        };

        const ref = db.doc(`claims/${apt}`);
        await ref.set(record, { merge: true });

        await audit(actor, role, 'claims.save', ref.path,
            `Претензійна робота кв. ${apt}: стан «${core.CLAIM_STATUSES[record.status] || record.status}»`,
            record);

        return { ok: true, apt, status: record.status };
    }

    const claimsAction = onCall({ region: REGION, maxInstances: 4 }, callGuard('claimsAction', async request => {
        const actor = await requireAdmin(request, ['chair', 'accountant', 'board']);
        const role = await staffRole(actor);
        const data = request.data || {};
        switch (data.action) {
            case 'context': return context();
            case 'saveClaim': return saveClaim(actor, role, data);
            default: fail('invalid-argument', 'Невідома дія');
        }
    }));

    return { claimsAction, actions: { context, saveClaim } };
};
