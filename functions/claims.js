'use strict';
// ============================================================
// Претензійно-позовна робота з боржниками ОСББ (серверна частина).
// ============================================================
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const callGuard = require('./call-guard');
const core = require('./claims-core');

const REGION = 'europe-central2';

module.exports = function claimsFunctions({ db, FieldValue, requireAdmin, staffRole }) {
    const fail = (code, message) => { throw new HttpsError(code, message); };
    const text = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

    async function audit(actor, role, action, target, summary, details = {}) {
        await db.collection('audit_log').add({
            actor, role, action, target,
            summary: String(summary).slice(0, 300),
            details: JSON.parse(JSON.stringify(details)),
            at: FieldValue.serverTimestamp()
        });
    }

    async function context() {
        const [aptsSnap, claimsSnap, settingsSnap] = await Promise.all([
            db.collection('apartments').get(),
            db.collection('claims').get(),
            db.doc('report_settings/main').get()
        ]);

        const claimsMap = new Map();
        claimsSnap.forEach(d => claimsMap.set(d.id, d.data()));

        const debtors = [];
        let totalDebtKop = 0;

        aptsSnap.forEach(d => {
            const data = d.data();
            const balance = Number(data.balance || 0);
            if (balance < 0) {
                const debtKop = Math.abs(balance);
                totalDebtKop += debtKop;
                const claim = claimsMap.get(d.id) || { stage: 'pre_trial', status: 'none' };
                debtors.push({
                    apt: d.id,
                    ownerName: data.owner || (data.owners && data.owners[0]?.name) || '',
                    ownerCode: (data.owners && data.owners[0]?.rnokpp) || '',
                    area: data.area || (data.areaCenti ? data.areaCenti / 100 : 0),
                    balance,
                    debtKop,
                    claim: {
                        stage: claim.stage || 'pre_trial',
                        status: claim.status || 'none',
                        caseNumber: claim.caseNumber || '',
                        claimDate: claim.claimDate || '',
                        courtOrderDate: claim.courtOrderDate || '',
                        lawsuitDate: claim.lawsuitDate || '',
                        enforcementDate: claim.enforcementDate || '',
                        note: claim.note || '',
                        restructureMonths: claim.restructureMonths || 0,
                        updatedAt: claim.updatedAt?.toDate?.()?.toISOString() || null
                    }
                });
            }
        });

        debtors.sort((a, b) => b.debtKop - a.debtKop);

        const repSettings = settingsSnap.data() || {};
        const org = {
            name: 'ОСББ «Успіх-25»',
            edrpou: '40562894',
            address: repSettings.address || 'м. Одеса, вул. Академіка Корольова, 25',
            phone: repSettings.phone || '',
            email: repSettings.email || '',
            headName: repSettings.headName || 'Сергій Миколайович',
            iban: 'UA213052990000026001234567890'
        };

        const stats = {
            debtorsCount: debtors.length,
            totalDebtKop,
            claimsCount: debtors.filter(d => ['warning', 'claim'].includes(d.claim.status)).length,
            courtCount: debtors.filter(d => ['court_order_filed', 'court_order_issued', 'lawsuit_filed', 'lawsuit_satisfied'].includes(d.claim.status)).length,
            enforcementCount: debtors.filter(d => d.claim.status === 'enforcement').length,
            restructuredCount: debtors.filter(d => d.claim.status === 'restructured').length
        };

        return { debtors, stats, org, martialLaw: true };
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
