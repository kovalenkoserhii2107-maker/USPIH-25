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

module.exports = function claimsFunctions({ db, FieldValue, requireAdmin, staffRole, youscoreApi = require('./youscore') }) {
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
                        restructureStart: claim.restructureStart || '',
                        events: Array.isArray(claim.events) ? claim.events.slice(-40) : [],
                        lastCourtCheck: claim.lastCourtCheck || null,
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

        const status = text(data.status || 'none', 40);
        if (!core.CLAIM_STATUSES[status]) fail('invalid-argument', 'Невідомий стан справи');
        const date = v => (/^\d{4}-\d{2}-\d{2}$/.test(text(v, 20)) ? text(v, 20) : '');
        const restructureMonths = Math.round(Number(data.restructureMonths || 0));
        if (!Number.isFinite(restructureMonths) || restructureMonths < 0 || restructureMonths > 36) fail('invalid-argument', 'Строк реструктуризації — від 1 до 36 місяців');
        const record = {
            apt,
            // Етап виводимо зі статусу: два поля, що можуть суперечити одне одному, справі не потрібні.
            stage: core.stageForStatus(status),
            status,
            caseNumber: text(data.caseNumber, 80),
            claimDate: date(data.claimDate),
            courtOrderDate: date(data.courtOrderDate),
            lawsuitDate: date(data.lawsuitDate),
            enforcementDate: date(data.enforcementDate),
            periodFrom: text(data.periodFrom, 30),
            periodTo: text(data.periodTo, 30),
            ownerNameOverride: text(data.ownerNameOverride, 200),
            ownerCodeOverride: text(data.ownerCodeOverride, 120),
            note: text(data.note, 500),
            restructureMonths,
            restructureStart: /^\d{4}-\d{2}$/.test(text(data.restructureStart, 20)) ? text(data.restructureStart, 20) : '',
            updatedBy: actor,
            updatedAt: FieldValue.serverTimestamp()
        };

        // Хід справи: кожна зміна стану — запис у хронології (останні 40).
        const ref = db.doc(`claims/${apt}`);
        await db.runTransaction(async t => {
            const old = (await t.get(ref)).data() || {};
            const events = Array.isArray(old.events) ? old.events : [];
            const next = (old.status || 'none') !== status
                ? [...events, { status, at: new Date().toISOString(), by: actor, note: text(data.eventNote, 200) }].slice(-40)
                : events;
            t.set(ref, { ...record, events: next }, { merge: true });
        });

        await audit(actor, role, 'claims.save', ref.path,
            `Претензійна робота кв. ${apt}: стан «${core.CLAIM_STATUSES[record.status] || record.status}»`,
            record);

        return { ok: true, apt, status: record.status };
    }

    async function loadYouscoreKey() {
        const [secSnap, expSnap] = await Promise.all([
            db.doc('bank_secrets/youscore').get(),
            db.doc('expense_settings/main').get()
        ]);
        const key = String(secSnap.data()?.apiKey || expSnap.data()?.youscoreApiKey || process.env.YOUSCORE_API_KEY || '').trim();
        const useSandbox = expSnap.data()?.youscoreSandbox === true || !key;
        return { apiKey: key || (useSandbox ? youscoreApi.SANDBOX_KEY : ''), isSandbox: !key || youscoreApi.isSandboxKey(key) };
    }

    async function checkDebtorCourt(actor, role, data) {
        const apt = text(data.apt, 20);
        const fullName = text(data.fullName || data.ownerName, 200);
        const code = text(data.code || data.ownerCode, 20);
        if (!fullName && !code) fail('invalid-argument', 'Вкажіть ПІБ співвласника або код РНОКПП/ЄДРПОУ для пошуку у судовому реєстрі');

        const { apiKey, isSandbox } = await loadYouscoreKey();
        if (!apiKey) fail('failed-precondition', 'API-ключ YouScore не налаштовано');

        let res;
        try {
            res = await youscoreApi.checkDebtorCourtAndEnforcement(apiKey, {
                apt,
                ownerName: fullName,
                fullName,
                ownerCode: code,
                code,
                region: text(data.region || 'Одес', 60),
                birthday: text(data.birthday, 20)
            });
        } catch (err) {
            fail('unavailable', `Помилка запиту до судового реєстру YouScore: ${String(err.message || err).slice(0, 200)}`);
        }

        if (apt) {
            await db.doc(`claims/${apt}`).set({
                lastCourtCheck: {
                    at: new Date().toISOString(),
                    by: actor,
                    isSandbox,
                    summary: res.summary,
                    cases: (res.courtCases || []).slice(0, 15),
                    hearings: (res.scheduledHearings || []).slice(0, 10),
                    enforcements: (res.enforcements || []).slice(0, 15)
                }
            }, { merge: true });
        }

        await audit(actor, role, 'claims.court.check', apt ? `claims/${apt}` : 'claims',
            `Перевірка судових справ та ВП YouScore (кв. ${apt || '—'}, ${fullName || code}): справ ${res.summary?.totalCases || 0}, засідань ${res.summary?.scheduledCount || 0}, ВП ${res.summary?.totalEnforcements || 0}`,
            { apt, fullName, code, isSandbox, summary: res.summary });

        return { ok: true, ...res };
    }

    async function checkPropertyOwner(actor, role, data) {
        const apt = text(data.apt, 20);
        let code = text(data.code || data.ownerCode, 20).replace(/\s+/g, '');
        let ownerName = text(data.ownerName, 200);
        let payerSource = null;

        const discoveredPayers = [];
        // Автоматичний пошук РНОКПП платників у вхідних банківських виписках квартири, якщо код не вказано
        if (!/^\d{8,10}$/.test(code) && apt) {
            const txSnap = await db.collection('bank_tx').where('apt', '==', apt).limit(25).get();
            const seenCodes = new Set();
            for (const doc of txSnap.docs) {
                const tx = doc.data() || {};
                const cpCode = String(tx.counterparty?.code || '').trim();
                const cpName = String(tx.counterparty?.name || '').trim();
                if ((/^\d{8,10}$/.test(cpCode) && !/^0+$/.test(cpCode)) || cpName) {
                    const key = `${cpCode}|${cpName}`;
                    if (!seenCodes.has(key)) {
                        seenCodes.add(key);
                        discoveredPayers.push({ txId: doc.id, name: cpName || 'Платник за випискою', code: /^\d{8,10}$/.test(cpCode) && !/^0+$/.test(cpCode) ? cpCode : '', date: tx.date || '' });
                    }
                }
            }
            const firstWithCode = discoveredPayers.find(p => /^\d{8,10}$/.test(p.code));
            if (firstWithCode && discoveredPayers.filter(p => /^\d{8,10}$/.test(p.code)).length === 1) {
                code = firstWithCode.code;
                if (!ownerName && firstWithCode.name) ownerName = firstWithCode.name;
                payerSource = firstWithCode;
            }
        }

        if (!/^\d{8,10}$/.test(code)) {
            return {
                ok: false,
                needsCode: true,
                apt,
                discoveredPayers,
                message: 'API YouScore (/v1/realEstate) виконує пошук нерухомості за кодом РНОКПП (10 цифр) або ЄДРПОУ (8 цифр). Введіть РНОКПП власника у поле нижче або оберіть платника з банківської виписки.'
            };
        }

        const { apiKey, isSandbox } = await loadYouscoreKey();
        if (!apiKey) fail('failed-precondition', 'API-ключ YouScore не налаштовано');

        let res;
        try {
            res = await youscoreApi.checkRealEstateByCode(apiKey, {
                code,
                apt,
                ownerName,
                houseHint: text(data.houseHint || 'Інглезі', 60),
                fetchDetails: data.fetchDetails !== false,
                landId: text(data.landId, 80)
            });
        } catch (err) {
            fail('unavailable', `Помилка запиту до реєстру нерухомості YouScore: ${String(err.message || err).slice(0, 200)}`);
        }

        // Якщо знайдено підтверджений об'єкт та передано autoApply / updateDirectory === true, оновлюємо довідник співвласників квартири
        let syncedOwners = false;
        const det = res.matchedAptObject?.details || res.matchedObject?.detailed || res.objects?.[0]?.details;
        if ((data.autoApply === true || data.updateDirectory === true) && apt && det) {
            const batch = db.batch();
            const aptRef = db.doc(`apartments/${apt}`);
            const updates = { ownersStatus: 'verified', ownersUpdatedAt: FieldValue.serverTimestamp(), ownersUpdatedBy: actor };
            if (det.totalArea > 0) updates.area = det.totalArea;
            batch.set(aptRef, updates, { merge: true });

            for (const ow of (det.owners || [])) {
                const owId = ow.code ? `yc_${ow.code}` : `yc_${Buffer.from(ow.name || 'owner').toString('hex').slice(0, 12)}`;
                const owRef = db.doc(`apartments/${apt}/owners/${owId}`);
                batch.set(owRef, {
                    name: ow.name || ownerName,
                    rnokpp: ow.code || code,
                    shareFrac: ow.share || '1/1',
                    docInfo: [ow.ownershipForm, ow.grounds, det.regNum ? `реєстр. № ${det.regNum}` : ''].filter(Boolean).join(', '),
                    source: isSandbox ? 'youscore_sandbox' : 'youscore_drrp',
                    updatedAt: FieldValue.serverTimestamp(),
                    updatedBy: actor
                }, { merge: true });
            }
            await batch.commit();
            syncedOwners = true;
        }

        await audit(actor, role, 'claims.realestate.check', apt ? `apartments/${apt}` : 'apartments',
            `Перевірка ДРРП YouScore (кв. ${apt || '—'}, код ${code}): знайдено обʼєктів ${res.totalObjects || 0}${syncedOwners ? ', синхронізовано з карткою квартири' : ''}`,
            { apt, code, isSandbox, totalObjects: res.totalObjects, syncedOwners });

        return { ok: true, ...res, payerSource, syncedOwners };
    }

    const claimsAction = onCall({ region: REGION, maxInstances: 4 }, callGuard('claimsAction', async request => {
        const actor = await requireAdmin(request, ['chair', 'accountant', 'board']);
        const role = await staffRole(actor);
        const data = request.data || {};
        switch (data.action) {
            case 'context': return context();
            case 'saveClaim': return saveClaim(actor, role, data);
            case 'checkDebtorCourt': return checkDebtorCourt(actor, role, data);
            case 'checkPropertyOwner': return checkPropertyOwner(actor, role, data);
            default: fail('invalid-argument', 'Невідома дія');
        }
    }));

    return { claimsAction, actions: { context, saveClaim, checkDebtorCourt, checkPropertyOwner } };
};
