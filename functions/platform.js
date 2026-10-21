'use strict';
// ============================================================
// Super-Admin Platform Control Plane (platformAction).
//
// Призначення:
//   1. Мульти-ОСББ реєстр (Multi-Tenant Control Plane): управління всіма
//      підключеними ОСББ, їхніми реквізитами, статусами, квотами та
//      режимами ізоляції БД (namespace_prefix / named_database / dedicated_project).
//   2. Повністю зовнішній симулятор Приват24 Бізнес API «Автоклієнт» v3.0.0:
//      - працює як незалежний зовнішній сервер банку у колекціях _privat24_sandbox*;
//      - не модифікує напряму бухгалтерські колекції (bank_tx, payments, expenses, apartments);
//      - бухгалтерія взаємодіє з ним виключно через штатний клієнт privat.js за тестовим
//        ключем SANDBOX_TOKEN ('PRIVAT24_TEST_KEY_USPIH25_SANDBOX_V3') та стандартний bank.sync();
//      - якщо в «Налаштуваннях» бухгалтерії замінити тестовий ключ на реальний токен ПриватБанку,
//        уся система без жодних змін у коді переключається на https://acp.privatbank.ua.
//   3. Статистика користувачів та активності: зведення за ролями,
//      квартирами, входами та потоком дій у журналі аудиту (audit_log).
//   4. Інспектор колекцій БД та контрольовані ручні коригування
//      (Break-Glass Manual Patch): перегляд документів будь-якої колекції,
//      попередній перегляд diff (dryRun), збереження з обовʼязковою підставою
//      в audit_log та автоматичним перерахунком балансу квартири.
//   5. Діагностика цілісності обліку та податкових звітів (Invariants):
//      перевірка тотожності балансів квартир та історії ledger, звірка
//      банківських транзакцій, платежів та закритих періодів ОСВ.
// ============================================================
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { createHash } = require('crypto');
const callGuard = require('./call-guard');
const core = require('./platform-core');
const scopedDatabase = require('./accounting-test-db');
const privat = require('./privat');
const { cleanApt, fromKop, normIban, safeId } = require('./bank-core');

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

module.exports = function platformFunctions({ db, FieldValue, Timestamp, requireAdmin, staffRole, charges, bank, payments, expenses }) {
    privat.setSandboxDb(db);
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

    // Ключ симулятора рахуємо з того самого нормалізованого ідентифікатора, що й контур БД,
    // інакше privat.js шукав би «банк» в іншому контурі, ніж той, куди пише платформа.
    function testTokenFor(tenantId) {
        const clean = String(tenantId || 'uspih-25').trim();
        if (!clean || clean === 'uspih-25' || clean === 'default' || clean.startsWith('sandbox~')) return privat.tokenForTenant(clean);
        return privat.tokenForTenant(core.normalizeTenantSlug(clean));
    }

    // Симулятор має право писати «банківські» операції лише туди, де стоїть тестовий ключ
    // або ключа немає. Зі справжнім токеном Приват24 тестові надходження, підписи й сторно
    // потрапили б у живий облік квартир — тому всі дії симулятора тоді відхиляються.
    async function assertSimulatorAllowed(targetDb) {
        const snap = await targetDb.doc('bank_secrets/privat').get();
        const token = snap.exists ? String(snap.data()?.token || '').trim() : '';
        if (token && !privat.isSandboxToken(token)) {
            fail('failed-precondition', 'Підключено справжній Приват24 — симулятор банку вимкнено, щоб тестові операції не потрапили в облік');
        }
    }

    function kopOrFail(value, label) {
        const kop = Math.round(Number(value));
        if (!Number.isSafeInteger(kop)) fail('invalid-argument', `Вкажіть залишок «${label}» числом`);
        return kop;
    }

    /**
     * Повертає сервіси { bankSvc, chargesSvc, expensesSvc, paymentsSvc } для обраного контуру БД.
     * Для основного ОСББ «Успіх-25» використовує основні інстанси, для ізольованих
     * тенантів створює привʼязані до targetDb сервіси.
     */
    function resolveServices(targetDb, actor) {
        if (targetDb === db && bank && charges) {
            return { bankSvc: bank, chargesSvc: charges, expensesSvc: expenses, paymentsSvc: payments };
        }
        const localReqAdmin = async () => actor || 'admin';
        const localRole = async () => 'chair';
        const localLock = require('./period-lock')(targetDb);
        const chargesSvc = require('./charges')({
            db: targetDb, FieldValue, Timestamp, requireAdmin: localReqAdmin, staffRole: localRole, lock: localLock
        });
        const paymentsSvc = require('./payments')({
            db: targetDb, FieldValue, requireAdmin: localReqAdmin, staffRole: localRole, notify: async () => {}, lock: localLock
        });
        const budgetSvc = require('./budget')({
            db: targetDb, FieldValue, requireAdmin: localReqAdmin, staffRole: localRole
        });
        const expensesSvc = require('./expenses')({
            db: targetDb, FieldValue, requireAdmin: localReqAdmin, staffRole: localRole, notify: async () => {},
            payments: paymentsSvc, budget: budgetSvc, lock: localLock
        });
        const bankSvc = require('./bank')({
            db: targetDb, FieldValue, Timestamp, requireAdmin: localReqAdmin, staffRole: localRole,
            balances: chargesSvc, expenses: expensesSvc, lock: localLock
        });
        return { bankSvc, chargesSvc, expensesSvc, paymentsSvc };
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
        const bankCfg = bankSnap.exists ? bankSnap.data() : {};
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
            iban: fin.iban || Object.values(bankCfg.accounts || {})[0]?.iban || '',
            apartmentsCount: realApts.length,
            debtKop: totalDebtKop,
            overpaidKop: totalOverpaidKop,
            bankConnected: Boolean(bankCfg.tokenSet || Object.keys(bankCfg.accounts || {}).length),
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
        const paymentsList = (paymentsSnap.docs || []).map(d => ({ id: d.id, ...serializeValue(d.data()) }));
        const closedPeriods = (periodsSnap.docs || []).map(d => ({ id: d.id, ...serializeValue(d.data()) }));
        const expensesList = (expensesSnap.docs || []).map(d => ({ id: d.id, ...serializeValue(d.data()) }));
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
            payments: paymentsList,
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
                payments: paymentsList.length,
                paymentsPending: paymentsList.filter(p => ['sent', 'sending', 'unknown'].includes(p.status)).length,
                expenses: expensesList.length,
                claims: claims.length,
                closedPeriods: closedPeriods.filter(p => p.status === 'closed').length
            },
            userStats,
            diagnostics,
            recentAudit: auditLogs.slice(0, 50)
        };
    }

    // ============================================================
    // МОДУЛЬ ЗОВНІШНЬОГО СИМУЛЯТОРА БАНКУ ПРИВАТ24 (SANDBOX SERVER)
    // ============================================================

    /**
     * Оновлює баланс рахунку на боці ЗОВНІШНЬОГО тестового сервера Приват24 (_privat24_sandbox/state).
     * Бухгалтерська колекція bank/settings при цьому НЕ змінюється напряму — вона оновиться
     * лише під час виклику штатного bank.sync() -> privat.fetchBalances(token)!
     */
    async function adjustSandboxServerBalance(targetDb, accountIban, deltaKop, direction = 'in') {
        const cleanIban = normIban(accountIban);
        if (!cleanIban) return;
        await privat.ensureSandboxState(targetDb);
        const stateRef = targetDb.doc('_privat24_sandbox/state');
        await targetDb.runTransaction(async t => {
            const snap = await t.get(stateRef);
            const cur = snap.exists ? snap.data() : { phase: 'WRK', work_balance: 'N', accounts: {} };
            const accounts = { ...(cur.accounts || {}) };
            const prev = accounts[cleanIban] || {
                iban: cleanIban,
                purpose: 'current',
                currency: 'UAH',
                name: 'Поточний рахунок ОСББ (311 · ПриватБанк)',
                balanceInKop: core.DEFAULT_SIM_ACCOUNTS[0].defaultBalanceKop,
                balanceKop: core.DEFAULT_SIM_ACCOUNTS[0].defaultBalanceKop,
                turnoverDebtKop: 0,
                turnoverCredKop: 0,
                active: true
            };
            const absKop = Math.abs(Number(deltaKop || 0));
            accounts[cleanIban] = {
                ...prev,
                balanceKop: Number(prev.balanceKop || 0) + Number(deltaKop || 0),
                turnoverCredKop: Number(prev.turnoverCredKop || 0) + (direction === 'in' ? absKop : 0),
                turnoverDebtKop: Number(prev.turnoverDebtKop || 0) + (direction === 'out' ? absKop : 0),
                updatedAt: new Date().toISOString()
            };
            t.set(stateRef, {
                accounts,
                updatedAt: new Date().toISOString()
            }, { merge: true });
        });
    }

    async function bankSimulatorContext(actor, role, data) {
        const tenantId = String(data.tenantId || 'uspih-25').trim();
        const targetDb = resolveTenantDb(tenantId);
        const testToken = testTokenFor(tenantId);

        const [
            { state: sandboxState },
            secretSnap,
            bankSettingsSnap,
            finSnap,
            sandboxPaySnap,
            sandboxTxSnap,
            sandboxRepSnap,
            sandboxEdrSnap,
            paymentsSnap,
            txSnap,
            aptsSnap,
            ownersSnap,
            expensesSnap,
            advSnap,
            suppliersSnap
        ] = await Promise.all([
            privat.ensureSandboxState(targetDb),
            targetDb.doc('bank_secrets/privat').get().catch(() => ({ exists: false })),
            targetDb.doc('bank/settings').get().catch(() => ({ exists: false })),
            targetDb.doc('osbb_settings/finance').get().catch(() => ({ exists: false })),
            targetDb.collection('_privat24_sandbox_payments').limit(200).get().catch(() => ({ docs: [] })),
            targetDb.collection('_privat24_sandbox_tx').limit(200).get().catch(() => ({ docs: [] })),
            targetDb.collection('_privat24_sandbox_reports').limit(50).get().catch(() => ({ docs: [] })),
            targetDb.collection('_privat24_sandbox_edr').limit(50).get().catch(() => ({ docs: [] })),
            targetDb.collection('payments').limit(200).get().catch(() => ({ docs: [] })),
            targetDb.collection('bank_tx').limit(150).get().catch(() => ({ docs: [] })),
            targetDb.collection('apartments').get().catch(() => ({ docs: [] })),
            targetDb.collectionGroup('owners').get().catch(() => ({ docs: [] })),
            targetDb.collection('expenses').limit(150).get().catch(() => ({ docs: [] })),
            targetDb.collection('advance_reports').limit(80).get().catch(() => ({ docs: [] })),
            targetDb.collection('suppliers').limit(150).get().catch(() => ({ docs: [] }))
        ]);

        const savedToken = secretSnap.exists ? String(secretSnap.data()?.token || '').trim() : '';
        const tokenMode = !savedToken
            ? 'none'
            : privat.isSandboxToken(savedToken)
                ? 'sandbox'
                : 'production';

        const fin = finSnap.exists ? finSnap.data() : {};
        const reg = fin.registry || {};
        const org = {
            name: fin.payeeName || reg.legalName || 'ОСББ «Успіх-25»',
            edrpou: fin.edrpou || reg.code || '40562894',
            address: fin.houseAddress || reg.legalAddress || 'вул. Інглезі, 3/3, м. Одеса',
            iban: fin.iban || ''
        };

        const bankSettings = bankSettingsSnap.exists ? serializeValue(bankSettingsSnap.data()) : {};
        const osbbAccounts = bankSettings.accounts || {};

        // Рахунки на зовнішньому сервері Приват24 (_privat24_sandbox/state)
        const sandboxAccounts = Object.values(sandboxState.accounts || {}).map(acc => {
            const iban = normIban(acc.iban);
            const syncedAcc = osbbAccounts[iban];
            return {
                iban,
                purpose: syncedAcc?.purpose || acc.purpose || 'current',
                name: acc.name || syncedAcc?.name || 'Поточний рахунок ОСББ (311 · ПриватБанк)',
                currency: acc.currency || 'UAH',
                balanceKop: Number(acc.balanceKop || 0),
                osbbSyncedBalanceKop: syncedAcc?.balanceKop !== undefined ? Number(syncedAcc.balanceKop) : null,
                active: acc.active !== false,
                syncedTo: syncedAcc?.syncedTo || bankSettings.syncedTo || null
            };
        });

        // Власники за квартирами (для зручної підстановки в генератор платежів)
        const ownersByApt = new Map();
        for (const d of ownersSnap.docs || []) {
            const aptId = cleanApt(d.ref?.parent?.parent?.id || '');
            if (!aptId) continue;
            const o = d.data() || {};
            const name = String(o.name || '').trim();
            if (!name) continue;
            const docInfo = String(o.docInfo || '');
            const rnokpp = String(o.rnokpp || o.tin || (docInfo.match(/\b(\d{10})\b/) || [])[1] || '').trim();
            if (!ownersByApt.has(aptId)) ownersByApt.set(aptId, []);
            ownersByApt.get(aptId).push({ name, rnokpp });
        }

        const apartments = (aptsSnap.docs || [])
            .filter(d => d.data().isAdmin !== true)
            .map(d => {
                const a = d.data();
                const apt = cleanApt(d.id) || d.id;
                const owners = ownersByApt.get(apt) || [];
                return {
                    apt,
                    id: d.id,
                    personalAccount: String(a.personalAccount || '').trim(),
                    area: Number(a.area || 0),
                    balance: Number(a.balance || 0),
                    balanceKop: Math.round(Number(a.balance || 0) * 100),
                    ownerName: owners[0]?.name || '',
                    ownerCode: owners[0]?.rnokpp || ''
                };
            })
            .sort((a, b) => Number(a.apt) - Number(b.apt) || String(a.apt).localeCompare(String(b.apt), 'uk', { numeric: true }));

        const expensesById = new Map((expensesSnap.docs || []).map(d => [d.id, { id: d.id, ...serializeValue(d.data()) }]));
        const advById = new Map((advSnap.docs || []).map(d => [d.id, { id: d.id, ...serializeValue(d.data()) }]));
        const suppliers = (suppliersSnap.docs || []).map(d => ({ id: d.id, ...serializeValue(d.data()) }));
        const osbbPayments = (paymentsSnap.docs || []).map(d => ({ id: d.id, ...serializeValue(d.data()) }));

        // Індексуємо платежі, які надійшли на сервер Приват24 (_privat24_sandbox_payments)
        const sandboxPayByRef = new Map();
        for (const d of sandboxPaySnap.docs || []) {
            const sp = { id: d.id, ...serializeValue(d.data()) };
            sandboxPayByRef.set(sp.paymentRef || sp.id, sp);
            if (sp.bankRef) sandboxPayByRef.set(sp.bankRef, sp);
        }

        // Якщо в БД ОСББ є платежі зі статусом 'sent' (створені раніше), яких ще немає в _privat24_sandbox_payments,
        // реєструємо їх у черзі сервера Приват24, щоб голова міг підписати їх КЕП.
        for (const p of osbbPayments) {
            if (['sent', 'sending', 'unknown'].includes(p.status)) {
                const docNum = String(p.docNumber || createHash('sha256').update(p.id).digest('hex').slice(0, 10)).toUpperCase();
                const payRef = p.paymentRef || `P24DOC-${docNum}`;
                const bRef = p.bankRef || `P24PACK-${docNum}`;
                if (!sandboxPayByRef.has(payRef) && !sandboxPayByRef.has(bRef)) {
                    const bodyPayload = privat.paymentBody({
                        ...p,
                        docNumber: docNum,
                        account: p.account || sandboxAccounts[0]?.iban || core.DEFAULT_SIM_ACCOUNTS[0].iban
                    });
                    const sp = {
                        id: payRef,
                        paymentRef: payRef,
                        bankRef: bRef,
                        docNumber: docNum,
                        osbbPaymentId: p.id,
                        endpoint: 'POST https://acp.privatbank.ua/api/proxy/payment/create',
                        status: 'wait_sign',
                        payment_status: 'new',
                        body: bodyPayload,
                        account: normIban(p.account || sandboxAccounts[0]?.iban || core.DEFAULT_SIM_ACCOUNTS[0].iban),
                        recipient: p.recipient || {},
                        amountKop: Number(p.amountKop || 0),
                        currency: 'UAH',
                        purpose: String(p.purpose || ''),
                        signers: [],
                        createdAt: p.createdAt || new Date().toISOString()
                    };
                    await targetDb.doc(`_privat24_sandbox_payments/${payRef}`).set(sp, { merge: true });
                    sandboxPayByRef.set(payRef, sp);
                }
            }
        }

        // Обʼєднуємо дані черги Приват24 з інформацією про документи ОСББ для зручного відображення
        const allPayments = osbbPayments
            .map(p => {
                const sp = (p.paymentRef && sandboxPayByRef.get(p.paymentRef)) || (p.bankRef && sandboxPayByRef.get(p.bankRef)) || null;
                const linkedExp = p.expenseId ? expensesById.get(p.expenseId) : null;
                const linkedAdv = p.advanceReportId ? advById.get(p.advanceReportId) : null;
                p.linkedInfo = linkedExp
                    ? `Документ № ${linkedExp.number || '—'} (${linkedExp.supplierName || ''})`
                    : linkedAdv
                        ? `Авансовий звіт № ${linkedAdv.number || linkedAdv.id} (${linkedAdv.personName || ''})`
                        : p.payroll
                            ? `Зарплатна відомість за ${p.payroll.period} (${p.payroll.stage === 'advance' ? 'аванс' : 'основна виплата'})`
                            : 'Прямий платіж';
                p.sandboxStatus = sp?.payment_status || (p.status === 'paid' ? 'signed' : 'new');
                p.sandboxTxRef = sp?.txRef || null;
                p.privatApi = core.buildPrivatPaymentApiLifecycle(p, {
                    myName: org.name,
                    myEdrpou: org.edrpou
                });
                return p;
            })
            .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));

        const pendingPayments = allPayments.filter(p => ['sent', 'sending', 'unknown'].includes(p.status));
        const historyPayments = allPayments.filter(p => !['sent', 'sending', 'unknown'].includes(p.status)).slice(0, 50);

        // Сирі транзакції на боці сервера Приват24 (_privat24_sandbox_tx)
        const osbbTxById = new Map((txSnap.docs || []).map(d => [d.id, { id: d.id, ...serializeValue(d.data()) }]));
        const sandboxRawTx = (sandboxTxSnap.docs || [])
            .map(d => {
                const raw = serializeValue(d.data());
                const norm = privat.normalizeTransaction(raw);
                const osbbTxId = norm ? safeId(`${norm.account}_${norm.bankId}`) : null;
                const syncedTx = osbbTxId ? osbbTxById.get(osbbTxId) : null;
                return {
                    id: d.id,
                    raw,
                    osbbTxId,
                    syncedInOsbb: Boolean(syncedTx),
                    osbbStatus: syncedTx?.status || null,
                    osbbKind: syncedTx?.kind || null,
                    osbbAllocations: syncedTx?.allocations || []
                };
            })
            .sort((a, b) => String(b.raw.createdAtIso || b.raw.DATE_TIME_DAT_OD_TIM_P || '').localeCompare(String(a.raw.createdAtIso || a.raw.DATE_TIME_DAT_OD_TIM_P || '')));

        const recentTx = (txSnap.docs || [])
            .map(d => ({ id: d.id, ...serializeValue(d.data()) }))
            .sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')))
            .slice(0, 80);

        const uploadedReports = (sandboxRepSnap.docs || [])
            .map(d => ({ id: d.id, ...serializeValue(d.data()) }))
            .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));

        const edrChecks = (sandboxEdrSnap.docs || [])
            .map(d => ({ id: d.id, ...serializeValue(d.data()) }))
            .sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')));

        const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Kyiv' }).format(new Date());

        return {
            ok: true,
            tenantId,
            today,
            org,
            testToken,
            tokenMode, // 'sandbox' | 'production' | 'none'
            sandboxServer: {
                phase: sandboxState.phase || 'WRK',
                workBalance: sandboxState.work_balance || 'N',
                rawTxCount: sandboxRawTx.length,
                unsyncedTxCount: sandboxRawTx.filter(x => !x.syncedInOsbb && x.raw.PR_PR === 'r').length,
                uploadedReports,
                edrChecks
            },
            bankSettings: {
                connected: Boolean(bankSettings.tokenSet && savedToken),
                simulator: tokenMode === 'sandbox',
                tokenMode,
                tokenSet: Boolean(bankSettings.tokenSet),
                tokenHint: bankSettings.tokenHint || (savedToken ? savedToken.slice(-4) : ''),
                startDate: bankSettings.startDate || '2026-10-01',
                syncedTo: bankSettings.syncedTo || null,
                lastSync: bankSettings.lastSync || null
            },
            accounts: sandboxAccounts,
            defaultSimAccounts: core.DEFAULT_SIM_ACCOUNTS,
            pendingPayments,
            historyPayments,
            sandboxRawTx: sandboxRawTx.slice(0, 80),
            recentTx,
            apartments,
            suppliers,
            openExpenses: [...expensesById.values()].filter(e => e.status === 'approved'),
            templates: core.BANK_SIM_TEMPLATES
        };
    }

    /**
     * Налаштування тестового середовища Приват24 (_privat24_sandbox/state) та, за потреби,
     * підключення тестового ключа (SANDBOX_TOKEN) через штатну функцію бухгалтерії bank.actions.saveToken!
     */
    async function bankSetupSimulator(actor, role, data) {
        if (role !== 'chair') fail('permission-denied', 'Налаштування банківського контуру доступне лише супер-адміну (голові)');
        const tenantId = String(data.tenantId || 'uspih-25').trim();
        const targetDb = resolveTenantDb(tenantId);
        await assertSimulatorAllowed(targetDb);
        const { bankSvc } = resolveServices(targetDb, actor);
        const testToken = testTokenFor(tenantId);

        const { ref: stateRef, state: curState } = await privat.ensureSandboxState(targetDb);
        const existingAccounts = curState.accounts || {};

        const currentIban = normIban(data.currentIban || Object.values(existingAccounts).find(a => a.purpose === 'current')?.iban || core.DEFAULT_SIM_ACCOUNTS[0].iban);
        const reserveIban = normIban(data.reserveIban || Object.values(existingAccounts).find(a => a.purpose === 'reserve')?.iban || core.DEFAULT_SIM_ACCOUNTS[1].iban);

        if (!/^UA\d{27}$/.test(currentIban)) fail('invalid-argument', 'IBAN поточного рахунку має починатися з UA та містити 29 символів');
        if (reserveIban && !/^UA\d{27}$/.test(reserveIban)) fail('invalid-argument', 'IBAN резервного рахунку має починатися з UA та містити 29 символів');

        const currentBalanceKop = data.currentBalanceKop !== undefined
            ? kopOrFail(data.currentBalanceKop, 'поточний рахунок')
            : (existingAccounts[currentIban]?.balanceKop ?? core.DEFAULT_SIM_ACCOUNTS[0].defaultBalanceKop);
        const reserveBalanceKop = data.reserveBalanceKop !== undefined
            ? kopOrFail(data.reserveBalanceKop, 'резервний рахунок')
            : (existingAccounts[reserveIban]?.balanceKop ?? core.DEFAULT_SIM_ACCOUNTS[1].defaultBalanceKop);

        const nextAccounts = { ...existingAccounts };
        nextAccounts[currentIban] = {
            ...(existingAccounts[currentIban] || {}),
            iban: currentIban,
            purpose: 'current',
            currency: 'UAH',
            name: String(data.currentName || existingAccounts[currentIban]?.name || core.DEFAULT_SIM_ACCOUNTS[0].name),
            balanceInKop: currentBalanceKop,
            balanceKop: currentBalanceKop,
            active: true,
            updatedAt: new Date().toISOString()
        };

        if (reserveIban && reserveIban !== currentIban) {
            nextAccounts[reserveIban] = {
                ...(existingAccounts[reserveIban] || {}),
                iban: reserveIban,
                purpose: 'reserve',
                currency: 'UAH',
                name: String(data.reserveName || existingAccounts[reserveIban]?.name || core.DEFAULT_SIM_ACCOUNTS[1].name),
                balanceInKop: reserveBalanceKop,
                balanceKop: reserveBalanceKop,
                active: true,
                updatedAt: new Date().toISOString()
            };
        }

        const phase = data.phase === 'NGT' ? 'NGT' : 'WRK';
        const workBalance = data.workBalance === 'Y' ? 'Y' : 'N';

        await stateRef.set({
            phase,
            work_balance: workBalance,
            accounts: nextAccounts,
            updatedAt: new Date().toISOString()
        }, { merge: true });

        // Якщо запрошено підключення тестового ключа — викликаємо ШТАТНИЙ bankSvc.actions.saveToken
        // рівно так само, якби бухгалтер вставив ключ у полі «Токен Автоклієнта» в «Налаштуваннях»!
        let syncResult = null;
        if (data.connectTestToken !== false && bankSvc?.actions?.saveToken) {
            await bankSvc.actions.saveToken(actor, role, { token: testToken });
            if (reserveIban && reserveIban !== currentIban && bankSvc?.actions?.setAccount) {
                await bankSvc.actions.setAccount(actor, role, { iban: reserveIban, purpose: 'reserve' }).catch(() => {});
            }
            if (data.autoSync !== false && typeof bankSvc.sync === 'function') {
                syncResult = await bankSvc.sync(`simulator:connect:${actor}`).catch(() => null);
            }
        }

        // Якщо основний IBAN у фінансових реквізитах ще не заданий — підставляємо його
        const finRef = targetDb.doc('osbb_settings/finance');
        const finSnap = await finRef.get();
        if (!finSnap.exists || !finSnap.data()?.iban) {
            await finRef.set({ iban: currentIban, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
        }

        await writeAudit(targetDb, actor, role, 'platform.bank.setup', '_privat24_sandbox/state',
            `Налаштовано тестове середовище Приват24 (ключ ${testToken.slice(0, 18)}…${testToken.slice(-4)}): ${currentIban} (${fromKop(currentBalanceKop)} грн)`,
            { tenantId, testToken, currentIban, currentBalanceKop, reserveIban, reserveBalanceKop, phase });

        return { ok: true, testToken, currentIban, reserveIban, currentBalanceKop, reserveBalanceKop, syncResult };
    }

    async function bankDisableSimulator(actor, role, data) {
        if (role !== 'chair') fail('permission-denied', 'Керувати підключенням банку може лише супер-адмін (голова)');
        const tenantId = String(data.tenantId || 'uspih-25').trim();
        const targetDb = resolveTenantDb(tenantId);
        const { bankSvc } = resolveServices(targetDb, actor);
        // Відключаємо лише тестовий ключ: справжній токен банку знімають у «Налаштуваннях» бухгалтерії.
        await assertSimulatorAllowed(targetDb);

        if (bankSvc?.actions?.removeToken) {
            await bankSvc.actions.removeToken(actor, role);
        } else {
            await targetDb.doc('bank_secrets/privat').delete().catch(() => {});
            await targetDb.doc('bank/settings').set({ tokenSet: false, tokenHint: FieldValue.delete() }, { merge: true });
        }

        await writeAudit(targetDb, actor, role, 'platform.bank.disableSimulator', 'bank/settings',
            'Тестовий ключ Приват24 відключено у Налаштуваннях бухгалтерії', { tenantId });

        return { ok: true };
    }

    /**
     * Ручний запуск штатної синхронізації виписки ОСББ (bank.sync) —
     * рівно те саме, що натискання кнопки «Виписка» у кабінеті бухгалтера (buh.html).
     */
    async function bankTriggerSync(actor, role, data) {
        const tenantId = String(data.tenantId || 'uspih-25').trim();
        const targetDb = resolveTenantDb(tenantId);
        const { bankSvc } = resolveServices(targetDb, actor);
        if (typeof bankSvc?.sync !== 'function') {
            fail('failed-precondition', 'Сервіс синхронізації банку недоступний');
        }
        const res = await bankSvc.sync(`manual:${actor}`);
        return { ok: true, syncResult: res };
    }

    /**
     * Підписання вихідного платежу КЕП голови на боці ЗОВНІШНЬОГО сервера Приват24:
     *   1. Оновлює статус платіжної інструкції в _privat24_sandbox_payments на 'signed' (додає КЕП).
     *   2. Додає проведену дебетову транзакцію (TRANTYPE: 'D', FL_REAL: 'r', PR_PR: 'r', DLR: bankRef)
     *      у таблицю виписки банку _privat24_sandbox_tx.
     *   3. Зменшує залишок на рахунку в _privat24_sandbox/state.
     *   4. НЕ торкається напряму payments/{id}, expenses/{id} або bank_tx/{id}!
     *      Якщо увімкнено autoSync (за замовчуванням true), викликає штатний bankSvc.sync(),
     *      який сам забирає виписку через privat.fetchTransactions(token) і закриває платіж та рахунок!
     */
    async function signSinglePaymentOnBankServer(targetDb, paymentDoc, options) {
        const docNumber = String(paymentDoc.docNumber || createHash('sha256').update(paymentDoc.id).digest('hex').slice(0, 10)).toUpperCase();
        const bankRef = String(paymentDoc.bankRef || `P24PACK-${docNumber}`);
        const paymentRef = String(paymentDoc.paymentRef || `P24DOC-${docNumber}`);
        const nowIso = new Date().toISOString();
        const signerName = String(options.signerName || 'Голова правління ОСББ (КЕП Приват24)');
        const sandboxPayRef = targetDb.doc(`_privat24_sandbox_payments/${paymentRef}`);
        const prevSandbox = await sandboxPayRef.get();
        if (prevSandbox.exists && prevSandbox.data()?.status === 'signed') {
            // Повторний підпис уже підписаного платежу списав би гроші з рахунку вдруге.
            return { paymentId: paymentDoc.id, bankRef, paymentRef, amountKop: paymentDoc.amountKop, feeKop: 0, alreadySigned: true };
        }
        const txRef = `P24OUT${docNumber}${Date.now().toString(36).slice(-3).toUpperCase()}`;

        const rawOut = core.buildPrivatRawTransaction({
            account: paymentDoc.account || core.DEFAULT_SIM_ACCOUNTS[0].iban,
            direction: 'out',
            trantype: 'D',
            amountKop: paymentDoc.amountKop,
            counterpartyName: paymentDoc.recipient?.name || 'Отримувач',
            counterpartyCode: paymentDoc.recipient?.code || '00000000',
            counterpartyIban: paymentDoc.recipient?.iban || '',
            purpose: paymentDoc.purpose || '',
            date: options.date,
            time: options.time,
            ref: txRef,
            refn: '1',
            dlr: bankRef,
            docNumber,
            myName: options.myName,
            myEdrpou: options.myEdrpou
        });

        // 1. Записуємо проведену дебетову транзакцію на сервері Приват24 (_privat24_sandbox_tx)
        await targetDb.doc(`_privat24_sandbox_tx/${rawOut.REF}_${rawOut.REFN}`).create({
            ...rawOut,
            createdAtIso: nowIso
        });

        let totalDebitKop = Number(paymentDoc.amountKop || 0);

        // Опціональна комісія РКО ПриватБанку за платіж
        const feeKop = Math.max(0, Math.round(Number(options.feeKop || 0)));
        if (feeKop > 0) {
            const rawFee = core.buildPrivatRawTransaction({
                account: paymentDoc.account || core.DEFAULT_SIM_ACCOUNTS[0].iban,
                direction: 'out',
                trantype: 'D',
                amountKop: feeKop,
                counterpartyName: 'АТ КБ «ПРИВАТБАНК»',
                counterpartyCode: '14360570',
                counterpartyIban: 'UA173052990000026000000000001',
                purpose: `Комісія банку за проведення платіжної інструкції № ${docNumber} у Приват24`,
                date: options.date,
                time: options.time,
                ref: `P24FEE${docNumber}${Date.now().toString(36).slice(-3).toUpperCase()}`,
                refn: '1',
                docNumber: `FEE${docNumber.slice(-5)}`,
                myName: options.myName,
                myEdrpou: options.myEdrpou
            });
            await targetDb.doc(`_privat24_sandbox_tx/${rawFee.REF}_${rawFee.REFN}`).set({
                ...rawFee,
                createdAtIso: nowIso
            });
            totalDebitKop += feeKop;
        }

        // 2. Оновлюємо статус платіжної інструкції на сервері Приват24 (_privat24_sandbox_payments)
        await sandboxPayRef.set({
            id: paymentRef,
            paymentRef,
            bankRef,
            docNumber,
            status: 'signed',
            payment_status: 'signed',
            txRef: `${rawOut.REF}_${rawOut.REFN}`,
            signers: [{
                level: '1',
                fio: signerName,
                state: 'Підписано КЕП (Перший підпис)',
                date: nowIso
            }],
            updatedAt: nowIso
        }, { merge: true });

        // 3. Зменшуємо баланс на сервері Приват24 (_privat24_sandbox/state)
        await adjustSandboxServerBalance(
            targetDb,
            paymentDoc.account || core.DEFAULT_SIM_ACCOUNTS[0].iban,
            -totalDebitKop,
            'out'
        );

        const expectedOsbbTxId = safeId(`${normIban(rawOut.AUT_MY_ACC)}_${rawOut.REF}_${rawOut.REFN}`);
        return {
            paymentId: paymentDoc.id,
            txId: expectedOsbbTxId,
            bankRef,
            paymentRef,
            amountKop: paymentDoc.amountKop,
            feeKop,
            rawTransaction: rawOut
        };
    }

    async function bankSignPayment(actor, role, data) {
        if (role !== 'chair') fail('permission-denied', 'Підписувати платежі КЕП у Приват24 може лише голова (супер-адмін)');
        const tenantId = String(data.tenantId || 'uspih-25').trim();
        const paymentId = String(data.paymentId || '').trim();
        if (!paymentId) fail('invalid-argument', 'Вкажіть ID платежу для підпису');

        const targetDb = resolveTenantDb(tenantId);
        await assertSimulatorAllowed(targetDb);
        const { bankSvc } = resolveServices(targetDb, actor);

        const [paySnap, finSnap] = await Promise.all([
            targetDb.doc(`payments/${paymentId}`).get(),
            targetDb.doc('osbb_settings/finance').get().catch(() => ({ exists: false }))
        ]);
        if (!paySnap.exists) fail('not-found', 'Платіж не знайдено');
        const p = { id: paySnap.id, ...paySnap.data() };
        if (p.status === 'paid') fail('failed-precondition', 'Цей платіж уже підписано та проведено у виписці');
        if (p.status === 'canceled') fail('failed-precondition', 'Скасований платіж не можна підписати');
        if (!['sent', 'unknown'].includes(p.status)) fail('failed-precondition', 'Підписати можна лише платіж, уже переданий у Приват24');

        const fin = finSnap.exists ? finSnap.data() : {};
        const signed = await signSinglePaymentOnBankServer(targetDb, p, {
            date: data.date,
            time: data.time,
            feeKop: data.feeKop || 0,
            signerName: data.signerName,
            myName: fin.payeeName || 'ОСББ «Успіх-25»',
            myEdrpou: fin.edrpou || '40562894'
        });
        if (signed.alreadySigned) fail('failed-precondition', 'Цей платіж уже підписано в Приват24 — він зʼявиться після синхронізації виписки');

        // Якщо увімкнено авто-синхронізацію (за замовчуванням так) — запускаємо штатний bankSvc.sync(),
        // який через privat.fetchTransactions(token) забирає виписку з тестового банку!
        let syncResult = null;
        if (data.autoSync !== false && typeof bankSvc?.sync === 'function') {
            syncResult = await bankSvc.sync(`simulator:sign:${actor}`).catch(() => null);
        }

        await writeAudit(targetDb, actor, role, 'platform.bank.signPayment', `_privat24_sandbox_payments/${signed.paymentRef}`,
            `КЕП-підпис платежу на сервері Приват24: ${p.recipient?.name || ''} — ${fromKop(p.amountKop)} грн (DLR: ${signed.bankRef})`,
            { tenantId, paymentId, bankRef: signed.bankRef, amountKop: p.amountKop, synced: Boolean(syncResult) });

        return { ok: true, ...signed, syncResult };
    }

    async function bankSignAllPayments(actor, role, data) {
        if (role !== 'chair') fail('permission-denied', 'Підписувати пачку платежів КЕП може лише голова (супер-адмін)');
        const tenantId = String(data.tenantId || 'uspih-25').trim();
        const targetDb = resolveTenantDb(tenantId);
        await assertSimulatorAllowed(targetDb);
        const { bankSvc } = resolveServices(targetDb, actor);

        // 'sending' — платіж ще передається в банк: підписувати його рано.
        const [pendingSnap, finSnap] = await Promise.all([
            targetDb.collection('payments').where('status', 'in', ['sent', 'unknown']).get(),
            targetDb.doc('osbb_settings/finance').get().catch(() => ({ exists: false }))
        ]);

        if (pendingSnap.empty) {
            return { ok: true, signedCount: 0, results: [] };
        }

        const fin = finSnap.exists ? finSnap.data() : {};
        const results = [];
        for (const docSnap of pendingSnap.docs) {
            const p = { id: docSnap.id, ...docSnap.data() };
            const res = await signSinglePaymentOnBankServer(targetDb, p, {
                date: data.date,
                time: data.time,
                feeKop: data.feeKop || 0,
                signerName: data.signerName,
                myName: fin.payeeName || 'ОСББ «Успіх-25»',
                myEdrpou: fin.edrpou || '40562894'
            });
            if (!res.alreadySigned) results.push(res);
        }

        let syncResult = null;
        if (data.autoSync !== false && typeof bankSvc?.sync === 'function') {
            syncResult = await bankSvc.sync(`simulator:signAll:${actor}`).catch(() => null);
        }

        const totalKop = results.reduce((s, r) => s + Number(r.amountKop || 0), 0);
        await writeAudit(targetDb, actor, role, 'platform.bank.signAll', '_privat24_sandbox_payments',
            `Пачковий КЕП-підпис на сервері Приват24: підписано ${results.length} платежів на суму ${fromKop(totalKop)} грн`,
            { tenantId, signedCount: results.length, totalKop, synced: Boolean(syncResult) });

        return { ok: true, signedCount: results.length, totalKop, results, syncResult };
    }

    /**
     * Відхилення чернетки платежу на сервері Приват24 (_privat24_sandbox_payments).
     * Сама бухгалтерська база дізнається про це через штатну кнопку «Перевірити стан підпису в Приват24»
     * (GET /api/proxy/payment/get) або при скасуванні платежу (POST /api/proxy/payment/delete).
     */
    async function bankRejectPayment(actor, role, data) {
        if (role !== 'chair') fail('permission-denied', 'Відхиляти платежі в симуляторі банку може лише голова (супер-адмін)');
        const tenantId = String(data.tenantId || 'uspih-25').trim();
        const paymentId = String(data.paymentId || '').trim();
        const reason = String(data.reason || 'Відхилено банком / забраковано підпис у Приват24').trim().slice(0, 260);
        if (!paymentId) fail('invalid-argument', 'Вкажіть ID платежу');

        const targetDb = resolveTenantDb(tenantId);
        await assertSimulatorAllowed(targetDb);
        const snap = await targetDb.doc(`payments/${paymentId}`).get();
        if (!snap.exists) fail('not-found', 'Платіж не знайдено');
        const p = snap.data();
        if (p.status === 'paid') fail('failed-precondition', 'Уже проведений у виписці платіж не можна відхилити як чернетку (використайте сторно виписки)');

        const docNumber = String(p.docNumber || createHash('sha256').update(paymentId).digest('hex').slice(0, 10)).toUpperCase();
        const paymentRef = String(p.paymentRef || `P24DOC-${docNumber}`);
        const bankRef = String(p.bankRef || `P24PACK-${docNumber}`);
        const nowIso = new Date().toISOString();

        await targetDb.doc(`_privat24_sandbox_payments/${paymentRef}`).set({
            id: paymentRef,
            paymentRef,
            bankRef,
            docNumber,
            status: 'rejected',
            payment_status: 'відхилений банком',
            error: reason,
            signers: [{
                level: '1',
                fio: 'Приват24 Бізнес (Контроль платежів)',
                state: `Відхилено: ${reason}`,
                date: nowIso
            }],
            updatedAt: nowIso
        }, { merge: true });

        // Якщо увімкнено авто-перевірку статусу підпису — викликаємо штатний paymentsSvc.actions.checkSignStatus
        const { paymentsSvc } = resolveServices(targetDb, actor);
        if (data.autoSync !== false && paymentsSvc?.actions?.checkSignStatus) {
            await paymentsSvc.actions.checkSignStatus(actor, role, { id: paymentId }).catch(() => {});
        }

        await writeAudit(targetDb, actor, role, 'platform.bank.rejectPayment', `_privat24_sandbox_payments/${paymentRef}`,
            `Платіж ${p.recipient?.name || ''} (${fromKop(p.amountKop)} грн) забраковано на сервері Приват24: ${reason}`,
            { tenantId, paymentId, paymentRef, reason });

        return { ok: true, paymentId, paymentRef, status: 'rejected' };
    }

    /**
     * Створення вхідної (TRANTYPE: 'C') або вихідної (TRANTYPE: 'D') банківської операції
     * на ЗОВНІШНЬОМУ сервері Приват24 (_privat24_sandbox_tx).
     * Бухгалтерія отримує її виключно через штатний bankSvc.sync() -> privat.fetchTransactions(token)!
     */
    async function bankSimulateTransaction(actor, role, data) {
        if (role !== 'chair') fail('permission-denied', 'Створювати операції в симуляторі банку може лише голова (супер-адмін)');
        const tenantId = String(data.tenantId || 'uspih-25').trim();
        const targetDb = resolveTenantDb(tenantId);
        await assertSimulatorAllowed(targetDb);
        const { bankSvc } = resolveServices(targetDb, actor);

        const amountKop = Math.abs(Math.round(Number(data.amountKop || 0)));
        if (!Number.isSafeInteger(amountKop) || amountKop <= 0) {
            fail('invalid-argument', 'Вкажіть суму операції більшу за 0,00 грн');
        }
        const purpose = String(data.purpose || '').replace(/\s+/g, ' ').trim();
        if (purpose.length < 3) {
            fail('invalid-argument', 'Вкажіть призначення платежу (поле OSND у Приват24)');
        }

        const [{ state: sandboxState }, finSnap] = await Promise.all([
            privat.ensureSandboxState(targetDb),
            targetDb.doc('osbb_settings/finance').get().catch(() => ({ exists: false }))
        ]);

        const fin = finSnap.exists ? finSnap.data() : {};
        const sandboxAccounts = Object.keys(sandboxState.accounts || {});
        const myAccount = normIban(data.account || sandboxAccounts[0] || fin.iban || core.DEFAULT_SIM_ACCOUNTS[0].iban);

        const direction = data.trantype === 'D' || data.direction === 'out' ? 'out' : 'in';
        const rawPrivatTx = core.buildPrivatRawTransaction({
            account: myAccount,
            direction,
            trantype: direction === 'out' ? 'D' : 'C',
            amountKop,
            counterpartyName: String(data.counterpartyName || 'Платник').trim(),
            counterpartyCode: String(data.counterpartyCode || '00000000').trim(),
            counterpartyIban: normIban(data.counterpartyIban || 'UA213052990000026201234567891'),
            purpose,
            date: data.date,
            time: data.time,
            // Номер операції видає «банк», а не клієнт: інакше чужий REF перезаписав би наявний рядок виписки.
            ref: `P24SIM${Date.now().toString(36).toUpperCase()}${createHash('sha256').update(`${actor}:${Math.random()}`).digest('hex').slice(0, 4).toUpperCase()}`,
            refn: '1',
            dlr: data.dlr || '',
            docNumber: data.docNumber || '',
            myName: fin.payeeName || 'ОСББ «Успіх-25»',
            myEdrpou: fin.edrpou || '40562894'
        });

        const normalized = privat.normalizeTransaction(rawPrivatTx);
        if (!normalized) {
            fail('invalid-argument', 'Не вдалося нормалізувати банківську транзакцію за правилами Приват24 (перевірте дату та реквізити)');
        }

        // 1. Записуємо сиру транзакцію у виписку на сервері Приват24 (_privat24_sandbox_tx)
        const sandboxDocId = `${rawPrivatTx.REF}_${rawPrivatTx.REFN}`;
        await targetDb.doc(`_privat24_sandbox_tx/${sandboxDocId}`).create({
            ...rawPrivatTx,
            createdAtIso: new Date().toISOString()
        });

        // 2. Оновлюємо баланс рахунку на сервері Приват24 (_privat24_sandbox/state)
        const deltaKop = direction === 'in' ? amountKop : -amountKop;
        await adjustSandboxServerBalance(targetDb, myAccount, deltaKop, direction);

        // 3. Якщо увімкнено autoSync — запускаємо штатний bankSvc.sync(), який через privat.fetchTransactions(token)
        // завантажує нову операцію в бухгалтерію і розносить її за квартирами / документами!
        let syncResult = null;
        if (data.autoSync !== false && typeof bankSvc?.sync === 'function') {
            syncResult = await bankSvc.sync(`simulator:tx:${actor}`).catch(() => null);
        }

        const txId = safeId(`${normalized.account}_${normalized.bankId}`);
        const txSnap = await targetDb.doc(`bank_tx/${txId}`).get();
        const storedTx = txSnap.exists ? { id: txSnap.id, ...serializeValue(txSnap.data()) } : null;

        await writeAudit(targetDb, actor, role, 'platform.bank.simulateTx', `_privat24_sandbox_tx/${sandboxDocId}`,
            `Операція на сервері Приват24 (${direction === 'in' ? '+' : '−'}${fromKop(amountKop)} грн, ${rawPrivatTx.AUT_CNTR_NAM}): ${storedTx ? (storedTx.status === 'done' ? `синхронізовано й рознесено (${storedTx.kind})` : 'синхронізовано у «Рішення»') : 'очікує синхронізації виписки'}`,
            { tenantId, sandboxDocId, txId, direction, amountKop, synced: Boolean(storedTx), status: storedTx?.status, kind: storedTx?.kind });

        return {
            ok: true,
            sandboxDocId,
            txId,
            rawPrivatTx,
            storedTx,
            syncResult
        };
    }

    /**
     * Симуляція банківського сторно (PR_PR: 't') на ЗОВНІШНЬОМУ сервері Приват24 (_privat24_sandbox_tx).
     * Бухгалтерія дізнається про сторно виключно під час штатного bankSvc.sync()!
     */
    async function bankVoidTransaction(actor, role, data) {
        if (role !== 'chair') fail('permission-denied', 'Симулювати банківське сторно може лише голова (супер-адмін)');
        const tenantId = String(data.tenantId || 'uspih-25').trim();
        const txId = safeId(data.txId);
        if (!txId) fail('invalid-argument', 'Вкажіть ID транзакції для сторнування');

        const targetDb = resolveTenantDb(tenantId);
        await assertSimulatorAllowed(targetDb);
        const { bankSvc } = resolveServices(targetDb, actor);

        // Можемо прийняти або ID з bank_tx, або REF_REFN з _privat24_sandbox_tx
        const [osbbTxSnap, sandboxTxSnap] = await Promise.all([
            targetDb.doc(`bank_tx/${txId}`).get(),
            targetDb.doc(`_privat24_sandbox_tx/${txId}`).get()
        ]);

        let rawVoid;
        let accountIban;
        let direction;
        let amountKop;
        let sandboxDocId;

        if (sandboxTxSnap.exists) {
            const sData = sandboxTxSnap.data();
            if (sData.PR_PR === 't') fail('failed-precondition', 'Цю операцію вже сторновано на сервері Приват24');
            sandboxDocId = sandboxTxSnap.id;
            accountIban = normIban(sData.AUT_MY_ACC);
            direction = sData.TRANTYPE === 'D' ? 'out' : 'in';
            amountKop = Math.abs(Math.round(Number(sData.SUM || 0) * 100));
            rawVoid = { ...sData, FL_REAL: 'r', PR_PR: 't', updatedAtIso: new Date().toISOString() };
        } else if (osbbTxSnap.exists) {
            const oldTx = osbbTxSnap.data();
            if (oldTx.bankVoided) fail('failed-precondition', 'Цю операцію вже сторновано банком');
            const [refPart, refnPart = '1'] = String(oldTx.bankId || '').split('_');
            const ref = oldTx.statementRef || refPart;
            const refn = oldTx.statementRefn || refnPart;
            sandboxDocId = `${ref}_${refn}`;
            const sandboxTwin = await targetDb.doc(`_privat24_sandbox_tx/${sandboxDocId}`).get();
            if (!sandboxTwin.exists) fail('failed-precondition', 'Ця операція прийшла не з симулятора — сторнувати її тут не можна');
            if (sandboxTwin.data()?.PR_PR === 't') fail('failed-precondition', 'Цю операцію вже сторновано на сервері Приват24');
            accountIban = oldTx.account;
            direction = oldTx.direction;
            amountKop = oldTx.amountKop;
            rawVoid = core.buildPrivatRawTransaction({
                account: oldTx.account,
                direction: oldTx.direction,
                trantype: oldTx.direction === 'out' ? 'D' : 'C',
                amountKop: oldTx.amountKop,
                counterpartyName: oldTx.counterparty?.name || '',
                counterpartyCode: oldTx.counterparty?.code || '',
                counterpartyIban: oldTx.counterparty?.account || '',
                purpose: oldTx.purpose || '',
                ref,
                refn,
                flReal: 'r',
                prPr: 't' // PR_PR: 't' — сторнована банком операція за документацією Автоклієнта
            });
        } else {
            fail('not-found', 'Транзакцію не знайдено');
        }

        // 1. Оновлюємо запис у _privat24_sandbox_tx на PR_PR = 't'
        await targetDb.doc(`_privat24_sandbox_tx/${sandboxDocId}`).set(rawVoid, { merge: true });

        // 2. Сторнуємо баланс на сервері Приват24 (_privat24_sandbox/state)
        const reverseDelta = direction === 'in' ? -amountKop : amountKop;
        await adjustSandboxServerBalance(targetDb, accountIban, reverseDelta, direction === 'in' ? 'out' : 'in');

        // 3. Якщо увімкнено autoSync — запускаємо штатний bankSvc.sync(), який прочитає PR_PR='t' і виконає voidTransaction!
        let syncResult = null;
        if (data.autoSync !== false && typeof bankSvc?.sync === 'function') {
            syncResult = await bankSvc.sync(`simulator:void:${actor}`).catch(() => null);
        }

        await writeAudit(targetDb, actor, role, 'platform.bank.voidTx', `_privat24_sandbox_tx/${sandboxDocId}`,
            `Банківське сторно на сервері Приват24 (PR_PR='t') для ${sandboxDocId} на суму ${fromKop(amountKop)} грн`,
            { tenantId, txId, sandboxDocId, syncResult });

        return { ok: true, txId, sandboxDocId, syncResult };
    }

    // ============================================================
    // РЕЄСТР ОСББ, ІНСПЕКТОР ТА ДІАГНОСТИКА
    // ============================================================
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
        // Дозволені лише поля зі списку інспектора; гроші — цілими копійками.
        // Рядки історії квартири (ledger) — це гроші: їх змінюють лише операціями, не латкою.
        if (subcollection === 'ledger') fail('invalid-argument', 'Рядки історії квартири змінюються лише через операції бухгалтерії (сторно, повернення)');
        const meta = core.INSPECTABLE_COLLECTIONS[colName];
        if (!subcollection) {
            const allowed = new Set(meta.editableFields || []);
            const bad = Object.keys(validation.cleanPatch).filter(k => !allowed.has(k));
            if (bad.length) fail('invalid-argument', `Ці поля не можна змінювати вручну: ${bad.join(', ')}`);
        }
        for (const [k, v] of Object.entries(validation.cleanPatch)) {
            if (/Kop$/.test(k) && v !== null && !Number.isSafeInteger(v)) fail('invalid-argument', `Поле ${k} має бути цілим числом копійок`);
        }

        const targetDb = resolveTenantDb(tenantId);
        const docPath = (colName === 'apartments' && aptId && ['ledger', 'owners'].includes(subcollection))
            ? `apartments/${aptId}/${subcollection}/${docId}`
            : `${colName}/${docId}`;

        const ref = targetDb.doc(docPath);
        const snap = await ref.get();
        const beforeData = snap.exists ? serializeValue(snap.data()) : {};
        // Закритий місяць не правиться ні старим, ні новим періодом документа.
        const periodLock = require('./period-lock')(targetDb);
        if (colName !== 'journal_periods') for (const period of new Set([beforeData.period, validation.cleanPatch.period].filter(v => typeof v === 'string' && /^\d{4}-\d{2}$/.test(v)))) {
            await periodLock.assertOpen(period, 'Ручне коригування');
        }
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
        const { chargesSvc } = resolveServices(targetDb, actor);
        if (targetApt && data.recomputeBalance !== false && chargesSvc?.recompute) {
            recomputed = await chargesSvc.recompute([targetApt]);
        }

        return {
            ok: true,
            docPath,
            diffs,
            recomputed
        };
    }

    async function repairInvariants(actor, role, data) {
        if (role !== 'chair') fail('permission-denied', 'Запускати перерахунок балансів може лише супер-адмін (голова)');
        const tenantId = String(data.tenantId || 'uspih-25').trim();
        const targetDb = resolveTenantDb(tenantId);
        const { chargesSvc } = resolveServices(targetDb, actor);

        let result = { updated: 0 };
        if (chargesSvc?.recompute) {
            result = await chargesSvc.recompute();
        }

        await writeAudit(targetDb, actor, role, 'platform.repairInvariants', 'apartments',
            `Глобальна звірка та перерахунок балансів квартир з історії ledger: оновлено ${result.updated || 0} кв.`,
            { tenantId, ...result });

        return { ok: true, ...result };
    }

    const platformAction = onCall({ region: REGION, maxInstances: 4, timeoutSeconds: 120 }, callGuard('platformAction', async request => {
        if (!request.auth?.uid || !request.auth.token?.email?.endsWith('@uspih-25.com')) fail('permission-denied', 'Потрібен службовий вхід у цей застосунок');
        const actor = await requireAdmin(request, ['chair', 'accountant']);
        const role = await staffRole(actor);
        const actorUid = request.auth?.uid || actor;
        const data = request.data || {};
        // Тестовий контур бухгалтерії (sandbox~uid) належить тому, хто його створив.
        const tenantRaw = String(data.tenantId || '').trim();
        if (tenantRaw.startsWith('sandbox~') && tenantRaw.slice('sandbox~'.length) !== actorUid && role !== 'chair') {
            fail('permission-denied', 'Це тестовий контур іншого користувача');
        }

        switch (data.action) {
            case 'overview':
                return overview(actor, role, data, actorUid);
            case 'bankContext':
            case 'bankSimulatorContext':
                return bankSimulatorContext(actor, role, data);
            case 'bankSetupSimulator':
                return bankSetupSimulator(actor, role, data);
            case 'bankDisableSimulator':
                return bankDisableSimulator(actor, role, data);
            case 'bankTriggerSync':
                return bankTriggerSync(actor, role, data);
            case 'bankSignPayment':
                return bankSignPayment(actor, role, data);
            case 'bankSignAllPayments':
                return bankSignAllPayments(actor, role, data);
            case 'bankRejectPayment':
                return bankRejectPayment(actor, role, data);
            case 'bankSimulateTx':
            case 'bankSimulateTransaction':
                return bankSimulateTransaction(actor, role, data);
            case 'bankVoidTx':
            case 'bankVoidTransaction':
                return bankVoidTransaction(actor, role, data);
            case 'saveTenant':
                return saveTenant(actor, role, data);
            case 'inspectCollection':
                return inspectCollection(actor, role, data);
            case 'manualPatch':
                return manualPatch(actor, role, data);
            case 'repairInvariants':
                return repairInvariants(actor, role, data);
            default:
                fail('invalid-argument', 'Невідома дія платформи управління');
        }
    }));

    return {
        platformAction,
        actions: {
            overview,
            bankSimulatorContext,
            bankSetupSimulator,
            bankDisableSimulator,
            bankTriggerSync,
            bankSignPayment,
            bankSignAllPayments,
            bankRejectPayment,
            bankSimulateTransaction,
            bankVoidTransaction,
            saveTenant,
            inspectCollection,
            manualPatch,
            repairInvariants
        }
    };
};
