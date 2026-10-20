'use strict';
// ============================================================
// Super-Admin Platform Control Plane (platformAction).
//
// Призначення:
//   1. Мульти-ОСББ реєстр (Multi-Tenant Control Plane): управління всіма
//      підключеними ОСББ, їхніми реквізитами, статусами, квотами та
//      режимами ізоляції БД (namespace_prefix / named_database / dedicated_project).
//   2. Статистика користувачів та активності: зведення за ролями,
//      квартирами, входами та потоком дій у журналі аудиту (audit_log).
//   3. Інспектор колекцій БД та контрольовані ручні коригування
//      (Break-Glass Manual Patch): перегляд документів будь-якої колекції,
//      попередній перегляд diff (dryRun), збереження з обовʼязковою підставою
//      в audit_log та автоматичним перерахунком балансу квартири.
//   4. Діагностика цілісності обліку та податкових звітів (Invariants):
//      перевірка тотожності балансів квартир та історії ledger, звірка
//      банківських транзакцій, платежів та закритих періодів ОСВ.
// ============================================================
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const callGuard = require('./call-guard');
const core = require('./platform-core');
const scopedDatabase = require('./accounting-test-db');
const { cleanApt, fromKop } = require('./bank-core');

const REGION = 'europe-central2';

function serializeValue(val) {
    if (val === null || val === undefined) return val;
    if (typeof val?.toDate === 'function') return val.toDate().toISOString();
    if (Array.isArray(val)) return val.map(serializeValue);
    if (typeof val === 'object') {
        const out = {};
        for (const [k, v] of Object.entries(val)) out[k] = serializeValue(v);
        return out;
    }
    return val;
}

module.exports = function platformFunctions({ db, FieldValue, Timestamp, requireAdmin, staffRole, charges }) {
    const fail = (code, message) => { throw new HttpsError(code, message); };

    function resolveTenantDb(tenantId) {
        const clean = String(tenantId || 'uspih-25').trim();
        if (!clean || clean === 'uspih-25' || clean === 'default') return db;
        if (clean.startsWith('sandbox~')) {
            const uid = clean.slice('sandbox~'.length);
            return scopedDatabase(db, uid);
        }
        const slug = core.normalizeTenantSlug(clean);
        if (!slug) fail('invalid-argument', 'Некоректний ідентифікатор ОСББ');
        return scopedDatabase(db, `tenant_${slug}`);
    }

    async function writeAudit(targetDb, actor, role, action, target, summary, details = {}) {
        const payload = {
            actor,
            role,
            action,
            target,
            summary: String(summary).slice(0, 300),
            details: JSON.parse(JSON.stringify(details)),
            at: FieldValue.serverTimestamp()
        };
        await db.collection('audit_log').add(payload);
        if (targetDb !== db) {
            await targetDb.collection('audit_log').add(payload).catch(() => {});
        }
    }

    async function listTenants(actorUid) {
        const [tenantsSnap, finSnap, aptsSnap, bankSnap, chargesSnap] = await Promise.all([
            db.collection('platform_tenants').get().catch(() => ({ docs: [] })),
            db.doc('osbb_settings/finance').get().catch(() => ({ exists: false })),
            db.collection('apartments').get().catch(() => ({ docs: [] })),
            db.doc('bank/settings').get().catch(() => ({ exists: false })),
            db.doc('charges/settings').get().catch(() => ({ exists: false }))
        ]);

        const fin = finSnap.exists ? finSnap.data() : {};
        const reg = fin.registry || {};
        const bank = bankSnap.exists ? bankSnap.data() : {};
        const chargesCfg = chargesSnap.exists ? chargesSnap.data() : {};
        const realApts = (aptsSnap.docs || []).filter(d => d.data().isAdmin !== true);
        let totalDebtKop = 0;
        let totalOverpaidKop = 0;
        for (const d of realApts) {
            const bal = Number(d.data().balance || 0);
            const kop = Math.round(bal * 100);
            if (kop < 0) totalDebtKop += Math.abs(kop);
            else if (kop > 0) totalOverpaidKop += kop;
        }

        const primaryTenant = {
            id: 'uspih-25',
            name: fin.payeeName || reg.legalName || 'ОСББ «Успіх-25»',
            edrpou: fin.edrpou || reg.code || '40562894',
            city: 'м. Одеса',
            address: fin.houseAddress || reg.legalAddress || 'вул. Інглезі, 3/3, м. Одеса',
            iban: fin.iban || Object.values(bank.accounts || {})[0]?.iban || '',
            apartmentsCount: realApts.length,
            debtKop: totalDebtKop,
            overpaidKop: totalOverpaidKop,
            bankConnected: Boolean(bank.tokenSet || Object.keys(bank.accounts || {}).length),
            openingSet: Boolean(chargesCfg.opening?.set),
            isolationMode: 'root_default',
            status: 'active',
            plan: 'enterprise',
            isPrimary: true
        };

        const customTenants = (tenantsSnap.docs || [])
            .filter(d => d.id !== 'uspih-25')
            .map(d => ({
                id: d.id,
                ...serializeValue(d.data()),
                isPrimary: false
            }));

        const sandboxTenant = actorUid ? [{
            id: `sandbox~${actorUid}`,
            name: 'Тестовий полігон (Ізольована пісочниця)',
            edrpou: '00000000',
            city: 'м. Одеса',
            address: 'Навчальний будинок (жовтень–грудень 2025)',
            iban: 'UA000000000000000000000000000',
            apartmentsCount: 4,
            isolationMode: 'namespace_prefix',
            status: 'sandbox',
            plan: 'sandbox',
            isSandbox: true
        }] : [];

        return [primaryTenant, ...customTenants, ...sandboxTenant];
    }

    async function overview(actor, role, data, actorUid) {
        const tenantId = String(data.tenantId || 'uspih-25').trim();
        const targetDb = resolveTenantDb(tenantId);

        const [
            tenants,
            aptsSnap,
            staffSnap,
            auditSnap,
            bankTxSnap,
            paymentsSnap,
            periodsSnap,
            expensesSnap,
            claimsSnap
        ] = await Promise.all([
            listTenants(actorUid),
            targetDb.collection('apartments').get().catch(() => ({ docs: [] })),
            targetDb.collection('staff').get().catch(() => ({ docs: [] })),
            targetDb.collection('audit_log').orderBy('at', 'desc').limit(150).get().catch(() => ({ docs: [] })),
            targetDb.collection('bank_tx').limit(300).get().catch(() => ({ docs: [] })),
            targetDb.collection('payments').limit(200).get().catch(() => ({ docs: [] })),
            targetDb.collection('journal_periods').get().catch(() => ({ docs: [] })),
            targetDb.collection('expenses').limit(200).get().catch(() => ({ docs: [] })),
            targetDb.collection('claims').get().catch(() => ({ docs: [] }))
        ]);

        const apartments = (aptsSnap.docs || []).map(d => ({ id: d.id, ...serializeValue(d.data()) }));
        const staff = (staffSnap.docs || []).map(d => ({ id: d.id, ...serializeValue(d.data()) }));
        const auditLogs = (auditSnap.docs || []).map(d => ({ id: d.id, ...serializeValue(d.data()) }));
        const bankTx = (bankTxSnap.docs || []).map(d => ({ id: d.id, ...serializeValue(d.data()) }));
        const payments = (paymentsSnap.docs || []).map(d => ({ id: d.id, ...serializeValue(d.data()) }));
        const closedPeriods = (periodsSnap.docs || []).map(d => ({ id: d.id, ...serializeValue(d.data()) }));
        const expenses = (expensesSnap.docs || []).map(d => ({ id: d.id, ...serializeValue(d.data()) }));
        const claims = (claimsSnap.docs || []).map(d => ({ id: d.id, ...serializeValue(d.data()) }));

        const userStats = core.summarizeUserActivity({
            apartments,
            staff,
            auditLogs,
            nowMs: Date.now()
        });

        const diagnostics = core.evaluateAccountingInvariants({
            apartments,
            bankTx,
            payments,
            closedPeriods
        });

        return {
            ok: true,
            activeTenantId: tenantId,
            tenants,
            counts: {
                apartments: apartments.filter(a => a.isAdmin !== true).length,
                staff: staff.length,
                bankTx: bankTx.length,
                bankReview: bankTx.filter(t => t.status === 'review').length,
                payments: payments.length,
                expenses: expenses.length,
                claims: claims.length,
                closedPeriods: closedPeriods.filter(p => p.status === 'closed').length
            },
            userStats,
            diagnostics,
            recentAudit: auditLogs.slice(0, 50)
        };
    }

    async function saveTenant(actor, role, data) {
        if (role !== 'chair') fail('permission-denied', 'Додавати або змінювати ОСББ у платформі може лише супер-адмін (голова)');
        const v = core.validateTenantInput(data);
        if (!v.ok) fail('invalid-argument', v.error);
        const t = v.tenant;
        const ref = db.doc(`platform_tenants/${t.id}`);
        await ref.set({
            ...t,
            updatedBy: actor,
            updatedAt: FieldValue.serverTimestamp(),
            ...(data.isEdit ? {} : { createdBy: actor, createdAt: FieldValue.serverTimestamp() })
        }, { merge: true });

        if (data.initializeSchema && t.id !== 'uspih-25') {
            const tenantDb = resolveTenantDb(t.id);
            await Promise.all([
                tenantDb.doc('osbb_settings/finance').set({
                    payeeName: t.name,
                    edrpou: t.edrpou,
                    houseAddress: t.address,
                    iban: t.iban || '',
                    updatedAt: FieldValue.serverTimestamp()
                }, { merge: true }),
                tenantDb.doc('charges/settings').set({
                    startPeriod: '2026-10',
                    startDate: '2026-10-01',
                    updatedAt: FieldValue.serverTimestamp()
                }, { merge: true })
            ]);
        }

        await writeAudit(db, actor, role, 'platform.tenant.save', `platform_tenants/${t.id}`,
            `Збережено конфігурацію ОСББ «${t.name}» (${t.edrpou}, режим: ${t.isolationMode})`, t);

        return { ok: true, tenant: t };
    }

    async function inspectCollection(actor, role, data) {
        const tenantId = String(data.tenantId || 'uspih-25').trim();
        const colName = String(data.collection || 'apartments').trim();
        if (!core.INSPECTABLE_COLLECTIONS[colName]) {
            fail('invalid-argument', `Колекція «${colName}» не входить до переліку дозволених для інспекції`);
        }
        const targetDb = resolveTenantDb(tenantId);
        const search = String(data.query || '').trim().toLowerCase();
        const maxDocs = Math.min(300, Math.max(10, Number(data.limit || 100)));

        let snap;
        if (colName === 'apartments' && data.aptId && ['ledger', 'owners'].includes(data.subcollection)) {
            const aptId = cleanApt(data.aptId) || String(data.aptId).trim();
            snap = await targetDb.collection(`apartments/${aptId}/${data.subcollection}`).limit(maxDocs).get();
        } else {
            snap = await targetDb.collection(colName).limit(maxDocs).get();
        }

        let docs = (snap.docs || []).map(d => ({
            id: d.id,
            path: d.ref?.path || `${colName}/${d.id}`,
            data: serializeValue(d.data())
        }));

        if (search) {
            docs = docs.filter(item =>
                item.id.toLowerCase().includes(search) ||
                JSON.stringify(item.data).toLowerCase().includes(search)
            );
        }

        return {
            ok: true,
            tenantId,
            collection: colName,
            subcollection: data.subcollection || null,
            aptId: data.aptId || null,
            count: docs.length,
            docs
        };
    }

    async function manualPatch(actor, role, data) {
        if (role !== 'chair') fail('permission-denied', 'Ручне коригування бази даних доступне лише супер-адміну (голові) з фіксацією в журналі аудиту');
        const tenantId = String(data.tenantId || 'uspih-25').trim();
        const colName = String(data.collection || '').trim();
        const docId = String(data.docId || '').trim();
        const subcollection = data.subcollection ? String(data.subcollection).trim() : '';
        const aptId = data.aptId ? (cleanApt(data.aptId) || String(data.aptId).trim()) : '';

        const validation = core.validateManualPatch({
            collection: colName,
            docId,
            patch: data.patch,
            reason: data.reason
        });
        if (!validation.ok) fail('invalid-argument', validation.error);

        const targetDb = resolveTenantDb(tenantId);
        const docPath = (colName === 'apartments' && aptId && ['ledger', 'owners'].includes(subcollection))
            ? `apartments/${aptId}/${subcollection}/${docId}`
            : `${colName}/${docId}`;

        const ref = targetDb.doc(docPath);
        const snap = await ref.get();
        const beforeData = snap.exists ? serializeValue(snap.data()) : {};
        const diffs = core.computePatchDiff(beforeData, validation.cleanPatch);

        if (data.dryRun === true) {
            return {
                ok: true,
                dryRun: true,
                docPath,
                exists: snap.exists,
                diffs,
                before: beforeData
            };
        }

        if (!diffs.length) {
            return { ok: true, unchanged: true, docPath, diffs: [] };
        }

        const updatePayload = { ...validation.cleanPatch };
        for (const [k, v] of Object.entries(updatePayload)) {
            if (v === null) updatePayload[k] = FieldValue.delete();
        }
        updatePayload.manualAdjustedBy = actor;
        updatePayload.manualAdjustedAt = FieldValue.serverTimestamp();

        await ref.set(updatePayload, { merge: true });

        await writeAudit(targetDb, actor, role, 'platform.manualPatch', docPath,
            `Ручне коригування ${docPath} (${diffs.length} полів): ${validation.reason}`,
            { tenantId, docPath, reason: validation.reason, diffs });

        let recomputed = null;
        const targetApt = colName === 'apartments' ? (aptId || docId) : null;
        if (targetApt && data.recomputeBalance !== false && tenantId === 'uspih-25' && charges?.recompute) {
            recomputed = await charges.recompute([targetApt]);
        }

        return {
            ok: true,
            docPath,
            diffs,
            recomputed
        };
    }

    async function ledgerAdjustment(actor, role, data) {
        if (role !== 'chair') fail('permission-denied', 'Коригувальні записи в історію квартири вносить лише супер-адмін (голова)');
        const tenantId = String(data.tenantId || 'uspih-25').trim();
        const apt = cleanApt(data.apt) || String(data.apt || '').trim();
        const kind = String(data.kind || 'payment').trim();
        const period = String(data.period || '').trim();
        const amountKop = Math.round(Number(data.amountKop || 0));
        const reason = String(data.reason || '').replace(/\s+/g, ' ').trim();

        if (!apt) fail('invalid-argument', 'Вкажіть номер квартири');
        if (!['charge', 'payment', 'refund', 'opening'].includes(kind)) fail('invalid-argument', 'Непідтримуваний вид запису');
        if (!/^\d{4}-\d{2}$/.test(period)) fail('invalid-argument', 'Вкажіть період у форматі РРРР-ММ');
        if (!Number.isSafeInteger(amountKop) || amountKop === 0) fail('invalid-argument', 'Вкажіть ненульову суму в копійках');
        if (reason.length < 5) fail('invalid-argument', 'Вкажіть детальну підставу коригування (щонайменше 5 символів)');

        const targetDb = resolveTenantDb(tenantId);
        const entryId = String(data.entryId || `manual-${period}-${Date.now().toString(36)}`).trim();
        const ref = targetDb.doc(`apartments/${apt}/ledger/${entryId}`);

        const entryData = {
            at: Timestamp.fromDate(new Date()),
            period,
            kind,
            amount: fromKop(amountKop),
            amountKop,
            note: `[Ручне коригування] ${reason}`,
            source: 'manual_adjustment',
            adjustedBy: actor,
            updatedAt: FieldValue.serverTimestamp()
        };

        await ref.set(entryData, { merge: true });

        await writeAudit(targetDb, actor, role, 'platform.ledgerAdjustment', `apartments/${apt}/ledger/${entryId}`,
            `Коригувальний запис кв. ${apt} (${kind}, ${fromKop(amountKop)} грн за ${period}): ${reason}`,
            { tenantId, apt, entryId, kind, period, amountKop, reason });

        let recomputed = null;
        if (tenantId === 'uspih-25' && charges?.recompute) {
            recomputed = await charges.recompute([apt]);
        }

        return { ok: true, apt, entryId, recomputed };
    }

    async function runDiagnostics(actor, role, data) {
        const tenantId = String(data.tenantId || 'uspih-25').trim();
        const targetDb = resolveTenantDb(tenantId);

        const [aptsSnap, ledgersSnap, bankTxSnap, paymentsSnap, periodsSnap] = await Promise.all([
            targetDb.collection('apartments').get().catch(() => ({ docs: [] })),
            targetDb.collectionGroup('ledger').get().catch(() => ({ docs: [] })),
            targetDb.collection('bank_tx').get().catch(() => ({ docs: [] })),
            targetDb.collection('payments').get().catch(() => ({ docs: [] })),
            targetDb.collection('journal_periods').get().catch(() => ({ docs: [] }))
        ]);

        const apartments = (aptsSnap.docs || []).map(d => ({ id: d.id, ...serializeValue(d.data()) }));
        const ledgersByApt = new Map();
        for (const d of ledgersSnap.docs || []) {
            const apt = d.ref?.parent?.parent?.id;
            if (!apt) continue;
            if (!ledgersByApt.has(apt)) ledgersByApt.set(apt, []);
            ledgersByApt.get(apt).push({ id: d.id, ...serializeValue(d.data()) });
        }

        const bankTx = (bankTxSnap.docs || []).map(d => ({ id: d.id, ...serializeValue(d.data()) }));
        const payments = (paymentsSnap.docs || []).map(d => ({ id: d.id, ...serializeValue(d.data()) }));
        const closedPeriods = (periodsSnap.docs || []).map(d => ({ id: d.id, ...serializeValue(d.data()) }));

        const result = core.evaluateAccountingInvariants({
            apartments,
            ledgersByApt,
            bankTx,
            payments,
            closedPeriods
        });

        await writeAudit(targetDb, actor, role, 'platform.diagnostics', `diagnostics/${tenantId}`,
            `Перевірка цілісності бази ${tenantId}: ${result.allOk ? 'усі перевірки пройдено' : `розбіжностей: ${result.failedCount}`}`,
            { tenantId, passedCount: result.passedCount, failedCount: result.failedCount });

        return { ok: true, tenantId, ...result };
    }

    const platformAction = onCall({ region: REGION, maxInstances: 4, timeoutSeconds: 120 }, callGuard('platformAction', async request => {
        const actor = await requireAdmin(request, ['chair', 'accountant']);
        const role = await staffRole(actor);
        const actorUid = request.auth?.uid || '';
        const data = request.data || {};
        switch (data.action) {
            case 'overview': return overview(actor, role, data, actorUid);
            case 'saveTenant': return saveTenant(actor, role, data);
            case 'inspectCollection': return inspectCollection(actor, role, data);
            case 'manualPatch': return manualPatch(actor, role, data);
            case 'ledgerAdjustment': return ledgerAdjustment(actor, role, data);
            case 'runDiagnostics': return runDiagnostics(actor, role, data);
            default: fail('invalid-argument', 'Невідома дія платформи');
        }
    }));

    return {
        platformAction,
        actions: { overview, saveTenant, inspectCollection, manualPatch, ledgerAdjustment, runDiagnostics }
    };
};
