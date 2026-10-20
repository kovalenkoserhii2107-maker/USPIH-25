'use strict';
// ============================================================
// Super-Admin Platform Control Plane (platformAction).
//
// Призначення:
//   1. Мульти-ОСББ реєстр (Multi-Tenant Control Plane): управління всіма
//      підключеними ОСББ, їхніми реквізитами, статусами, квотами та
//      режимами ізоляції БД (namespace_prefix / named_database / dedicated_project).
//   2. Симулятор Приват24 Бізнес API «Автоклієнт» v3.0.0:
//      - черга вихідних платежів ОСББ на підпис КЕП та проведення через
//        normalizeTransaction -> bank.storeTransactions;
//      - генератор вхідних і вихідних банківських операцій (шаблони + вільні
//        реквізити) у точному форматі /api/statements/transactions;
//      - симуляція відхилення платежу банком та сторнування операцій (PR_PR: 't').
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
const { randomUUID, createHash } = require('crypto');
const callGuard = require('./call-guard');
const core = require('./platform-core');
const scopedDatabase = require('./accounting-test-db');
const privat = require('./privat');
const { cleanApt, fromKop, normIban, safeId } = require('./bank-core');
const payrollIdentity = require('./payroll-payment-core');

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

    /**
     * Повертає сервіси { bankSvc, chargesSvc, expensesSvc } для обраного контуру БД.
     * Для основного ОСББ «Успіх-25» використовує основні інстанси, для ізольованих
     * тенантів створює привʼязані до targetDb сервіси.
     */
    function resolveServices(targetDb, actor) {
        if (targetDb === db && bank && charges) {
            return { bankSvc: bank, chargesSvc: charges, expensesSvc: expenses };
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
        return { bankSvc, chargesSvc, expensesSvc };
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
    // МОДУЛЬ СИМУЛЯТОРА БАНКУ ПРИВАТ24 (API АВТОКЛІЄНТ v3.0.0)
    // ============================================================
    async function bankSimulatorContext(actor, role, data) {
        const tenantId = String(data.tenantId || 'uspih-25').trim();
        const targetDb = resolveTenantDb(tenantId);

        const [
            bankSettingsSnap,
            finSnap,
            paymentsSnap,
            txSnap,
            aptsSnap,
            ownersSnap,
            expensesSnap,
            advSnap,
            suppliersSnap
        ] = await Promise.all([
            targetDb.doc('bank/settings').get().catch(() => ({ exists: false })),
            targetDb.doc('osbb_settings/finance').get().catch(() => ({ exists: false })),
            targetDb.collection('payments').limit(200).get().catch(() => ({ docs: [] })),
            targetDb.collection('bank_tx').limit(150).get().catch(() => ({ docs: [] })),
            targetDb.collection('apartments').get().catch(() => ({ docs: [] })),
            targetDb.collectionGroup('owners').get().catch(() => ({ docs: [] })),
            targetDb.collection('expenses').limit(150).get().catch(() => ({ docs: [] })),
            targetDb.collection('advance_reports').limit(80).get().catch(() => ({ docs: [] })),
            targetDb.collection('suppliers').limit(150).get().catch(() => ({ docs: [] }))
        ]);

        const fin = finSnap.exists ? finSnap.data() : {};
        const reg = fin.registry || {};
        const org = {
            name: fin.payeeName || reg.legalName || 'ОСББ «Успіх-25»',
            edrpou: fin.edrpou || reg.code || '40562894',
            address: fin.houseAddress || reg.legalAddress || 'вул. Інглезі, 3/3, м. Одеса',
            iban: fin.iban || ''
        };

        const bankSettings = bankSettingsSnap.exists ? serializeValue(bankSettingsSnap.data()) : {};
        const rawAccounts = bankSettings.accounts || {};
        const accounts = Object.entries(rawAccounts).map(([iban, acc]) => ({
            iban: normIban(iban),
            purpose: acc.purpose || 'current',
            name: acc.name || (acc.purpose === 'reserve' ? 'Резервний фонд ОСББ' : 'Поточний рахунок ОСББ'),
            currency: acc.currency || 'UAH',
            balanceKop: Number(acc.balanceKop || 0),
            active: acc.active !== false,
            syncedTo: acc.syncedTo || bankSettings.syncedTo || null
        }));

        // Власники за квартирами
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

        const allPayments = (paymentsSnap.docs || [])
            .map(d => {
                const p = { id: d.id, ...serializeValue(d.data()) };
                const linkedExp = p.expenseId ? expensesById.get(p.expenseId) : null;
                const linkedAdv = p.advanceReportId ? advById.get(p.advanceReportId) : null;
                p.linkedInfo = linkedExp
                    ? `Документ № ${linkedExp.number || '—'} (${linkedExp.supplierName || ''})`
                    : linkedAdv
                        ? `Авансовий звіт № ${linkedAdv.number || linkedAdv.id} (${linkedAdv.personName || ''})`
                        : p.payroll
                            ? `Зарплатна відомість за ${p.payroll.period} (${p.payroll.stage === 'advance' ? 'аванс' : 'основна виплата'})`
                            : 'Прямий платіж';
                p.privatApi = core.buildPrivatPaymentApiLifecycle(p, {
                    myName: org.name,
                    myEdrpou: org.edrpou
                });
                return p;
            })
            .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));

        const pendingPayments = allPayments.filter(p => ['sent', 'sending', 'unknown'].includes(p.status));
        const historyPayments = allPayments.filter(p => !['sent', 'sending', 'unknown'].includes(p.status)).slice(0, 50);

        const recentTx = (txSnap.docs || [])
            .map(d => ({ id: d.id, ...serializeValue(d.data()) }))
            .sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')))
            .slice(0, 80);

        const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Kyiv' }).format(new Date());

        return {
            ok: true,
            tenantId,
            today,
            org,
            bankSettings: {
                connected: Boolean(bankSettings.tokenSet || accounts.length > 0),
                simulator: Boolean(bankSettings.simulator || bankSettings.demo),
                tokenSet: Boolean(bankSettings.tokenSet),
                tokenHint: bankSettings.tokenHint || (bankSettings.simulator ? 'SIM3' : ''),
                startDate: bankSettings.startDate || '2026-10-01',
                syncedTo: bankSettings.syncedTo || null,
                lastSync: bankSettings.lastSync || null
            },
            accounts,
            defaultSimAccounts: core.DEFAULT_SIM_ACCOUNTS,
            pendingPayments,
            historyPayments,
            recentTx,
            apartments,
            suppliers,
            openExpenses: [...expensesById.values()].filter(e => e.status === 'approved'),
            templates: core.BANK_SIM_TEMPLATES
        };
    }

    async function bankSetupSimulator(actor, role, data) {
        if (role !== 'chair') fail('permission-denied', 'Налаштування банківського контуру доступне лише супер-адміну (голові)');
        const tenantId = String(data.tenantId || 'uspih-25').trim();
        const targetDb = resolveTenantDb(tenantId);

        const settingsRef = targetDb.doc('bank/settings');
        const currentSnap = await settingsRef.get();
        const current = currentSnap.exists ? currentSnap.data() : {};
        const existingAccounts = current.accounts || {};

        const currentIban = normIban(data.currentIban || Object.entries(existingAccounts).find(([, a]) => a.purpose === 'current')?.[0] || core.DEFAULT_SIM_ACCOUNTS[0].iban);
        const reserveIban = normIban(data.reserveIban || Object.entries(existingAccounts).find(([, a]) => a.purpose === 'reserve')?.[0] || core.DEFAULT_SIM_ACCOUNTS[1].iban);

        if (!/^UA\d{27}$/.test(currentIban)) fail('invalid-argument', 'IBAN поточного рахунку має починатися з UA та містити 29 символів');
        if (reserveIban && !/^UA\d{27}$/.test(reserveIban)) fail('invalid-argument', 'IBAN резервного рахунку має починатися з UA та містити 29 символів');

        const currentBalanceKop = data.currentBalanceKop !== undefined
            ? Math.round(Number(data.currentBalanceKop))
            : (existingAccounts[currentIban]?.balanceKop ?? core.DEFAULT_SIM_ACCOUNTS[0].defaultBalanceKop);
        const reserveBalanceKop = data.reserveBalanceKop !== undefined
            ? Math.round(Number(data.reserveBalanceKop))
            : (existingAccounts[reserveIban]?.balanceKop ?? core.DEFAULT_SIM_ACCOUNTS[1].defaultBalanceKop);

        const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Kyiv' }).format(new Date());
        const nowTs = Timestamp.now();

        const nextAccounts = { ...existingAccounts };
        nextAccounts[currentIban] = {
            ...(existingAccounts[currentIban] || {}),
            iban: currentIban,
            purpose: 'current',
            currency: 'UAH',
            name: String(data.currentName || existingAccounts[currentIban]?.name || core.DEFAULT_SIM_ACCOUNTS[0].name),
            balanceKop: currentBalanceKop,
            balanceAt: nowTs,
            active: true,
            syncedTo: today
        };

        if (reserveIban && reserveIban !== currentIban) {
            nextAccounts[reserveIban] = {
                ...(existingAccounts[reserveIban] || {}),
                iban: reserveIban,
                purpose: 'reserve',
                currency: 'UAH',
                name: String(data.reserveName || existingAccounts[reserveIban]?.name || core.DEFAULT_SIM_ACCOUNTS[1].name),
                balanceKop: reserveBalanceKop,
                balanceAt: nowTs,
                active: true,
                syncedTo: today
            };
        }

        const connectionId = current.connectionId || `sim-${randomUUID()}`;
        await settingsRef.set({
            connectionId,
            simulator: true,
            demo: true,
            tokenSet: true,
            tokenHint: 'SIM3',
            tokenSavedBy: actor,
            tokenSavedAt: FieldValue.serverTimestamp(),
            startDate: current.startDate || '2026-10-01',
            syncedTo: today,
            accounts: nextAccounts,
            lastSync: {
                at: FieldValue.serverTimestamp(),
                ok: true,
                added: 0,
                matched: 0,
                waiting: false,
                partial: false,
                error: null,
                trigger: 'simulator:setup',
                simulator: true
            }
        }, { merge: true });

        // Синхронізуємо основний IBAN у фінансових реквізитах ОСББ, якщо він ще не заданий
        const finRef = targetDb.doc('osbb_settings/finance');
        const finSnap = await finRef.get();
        if (!finSnap.exists || !finSnap.data()?.iban) {
            await finRef.set({ iban: currentIban, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
        }

        await writeAudit(targetDb, actor, role, 'platform.bank.setup', 'bank/settings',
            `Активовано симулятор Приват24 Автоклієнт v3.0.0: поточний ${currentIban} (${fromKop(currentBalanceKop)} грн)`,
            { tenantId, currentIban, currentBalanceKop, reserveIban, reserveBalanceKop });

        return { ok: true, currentIban, reserveIban, currentBalanceKop, reserveBalanceKop };
    }

    async function bankDisableSimulator(actor, role, data) {
        if (role !== 'chair') fail('permission-denied', 'Керувати підключенням банку може лише супер-адмін (голова)');
        const tenantId = String(data.tenantId || 'uspih-25').trim();
        const targetDb = resolveTenantDb(tenantId);
        const [secretSnap] = await Promise.all([
            targetDb.doc('bank_secrets/privat').get().catch(() => ({ exists: false }))
        ]);
        const hasRealToken = Boolean(secretSnap.exists && secretSnap.data()?.token && !String(secretSnap.data().token).startsWith('PRIVAT24_SIM_'));

        await targetDb.doc('bank/settings').set({
            simulator: false,
            demo: false,
            tokenSet: hasRealToken,
            ...(hasRealToken ? {} : { tokenHint: FieldValue.delete() })
        }, { merge: true });

        await writeAudit(targetDb, actor, role, 'platform.bank.disableSimulator', 'bank/settings',
            'Режим симулятора Приват24 вимкнено', { tenantId, hasRealToken });

        return { ok: true, hasRealToken };
    }

    /**
     * Допоміжне оновлення балансу рахунку в bank/settings після проведення симульованих операцій.
     */
    async function adjustSimulatedAccountBalance(targetDb, accountIban, deltaKop, addedCount = 1, matchedCount = 0) {
        const cleanIban = normIban(accountIban);
        if (!cleanIban) return;
        const settingsRef = targetDb.doc('bank/settings');
        const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Kyiv' }).format(new Date());
        await targetDb.runTransaction(async t => {
            const snap = await t.get(settingsRef);
            const cur = snap.exists ? snap.data() : {};
            const accounts = { ...(cur.accounts || {}) };
            const prevAcc = accounts[cleanIban] || {
                iban: cleanIban,
                purpose: 'current',
                currency: 'UAH',
                name: 'Поточний рахунок ОСББ (311 · ПриватБанк)',
                balanceKop: core.DEFAULT_SIM_ACCOUNTS[0].defaultBalanceKop,
                active: true
            };
            accounts[cleanIban] = {
                ...prevAcc,
                balanceKop: Number(prevAcc.balanceKop || 0) + Number(deltaKop || 0),
                balanceAt: Timestamp.now(),
                syncedTo: today
            };
            t.set(settingsRef, {
                accounts,
                syncedTo: today,
                lastSync: {
                    at: FieldValue.serverTimestamp(),
                    ok: true,
                    added: addedCount,
                    matched: matchedCount,
                    waiting: false,
                    partial: false,
                    error: null,
                    trigger: 'simulator:tx',
                    simulator: true
                }
            }, { merge: true });
        });
    }

    /**
     * Симуляція підписання вихідного платежу КЕП голови у застосунку Приват24 для бізнесу:
     *   1. Оновлює підписантів у payments/{id} (POST /api/proxy/payment/add-sign).
     *   2. Формує проведену дебетову транзакцію виписки (GET /api/statements/transactions, TRANTYPE: 'D', FL_REAL: 'r', PR_PR: 'r', DLR: bankRef).
     *   3. Проганяє її через privat.normalizeTransaction та bank.storeTransactions, що автоматично:
     *      - переводить платіж у status: 'paid' і привʼязує txId;
     *      - закриває повʼязаний документ витрат (expenses/{id}) або авансовий звіт (advance_reports/{id});
     *      - оновлює залишок на рахунку ОСББ.
     */
    async function signSinglePayment(targetDb, bankSvc, paymentDoc, options, actor) {
        const pRef = targetDb.doc(`payments/${paymentDoc.id}`);
        const docNumber = String(paymentDoc.docNumber || createHash('sha256').update(paymentDoc.id).digest('hex').slice(0, 10)).toUpperCase();
        const bankRef = String(paymentDoc.bankRef || `P24PACK-${docNumber}`);
        const paymentRef = String(paymentDoc.paymentRef || `P24DOC-${docNumber}`);
        const nowIso = new Date().toISOString();
        const signerName = String(options.signerName || 'Голова правління ОСББ (КЕП Приват24)');

        // Переконуємось, що платіж має статус 'sent', bankRef та sentAt <= часу виписки
        const txDateObj = options.date ? new Date(`${options.date}T00:00:00+02:00`) : new Date(Date.now() - 60000);
        await pRef.set({
            status: 'sent',
            docNumber,
            bankRef,
            paymentRef,
            bankStatus: 'підписано КЕП, проведено',
            signers: [{
                level: '1',
                fio: signerName,
                state: 'Підписано КЕП (Перший підпис)',
                at: nowIso
            }],
            signCheckedAt: FieldValue.serverTimestamp(),
            ...(paymentDoc.sentAt ? {} : { sentAt: Timestamp.fromDate(txDateObj) })
        }, { merge: true });

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
            ref: `P24OUT${docNumber}${Date.now().toString(36).slice(-3).toUpperCase()}`,
            refn: '1',
            dlr: bankRef,
            docNumber,
            myName: options.myName,
            myEdrpou: options.myEdrpou
        });

        const rawList = [rawOut];
        let totalDebitKop = Number(paymentDoc.amountKop || 0);

        // Опціональна комісія РКО ПриватБанку за платіж (напр. 5,00 грн)
        const feeKop = Math.max(0, Math.round(Number(options.feeKop || 0)));
        if (feeKop > 0) {
            rawList.push(core.buildPrivatRawTransaction({
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
            }));
            totalDebitKop += feeKop;
        }

        const normalized = rawList.map(r => privat.normalizeTransaction(r)).filter(Boolean);
        const ctx = await bankSvc.loadContext();
        const storeResult = await bankSvc.storeTransactions(normalized, 'privat', ctx);

        await adjustSimulatedAccountBalance(
            targetDb,
            paymentDoc.account || core.DEFAULT_SIM_ACCOUNTS[0].iban,
            -totalDebitKop,
            storeResult.added || 1,
            storeResult.matched || 0
        );

        const txId = safeId(`${normIban(rawOut.AUT_MY_ACC)}_${rawOut.REF}_${rawOut.REFN}`);
        return {
            paymentId: paymentDoc.id,
            txId,
            bankRef,
            paymentRef,
            amountKop: paymentDoc.amountKop,
            feeKop,
            rawTransaction: rawOut,
            storeResult
        };
    }

    async function bankSignPayment(actor, role, data) {
        if (role !== 'chair') fail('permission-denied', 'Підписувати платежі КЕП у симуляторі Приват24 може лише голова (супер-адмін)');
        const tenantId = String(data.tenantId || 'uspih-25').trim();
        const paymentId = String(data.paymentId || '').trim();
        if (!paymentId) fail('invalid-argument', 'Вкажіть ID платежу для підпису');

        const targetDb = resolveTenantDb(tenantId);
        const { bankSvc } = resolveServices(targetDb, actor);

        const [paySnap, finSnap] = await Promise.all([
            targetDb.doc(`payments/${paymentId}`).get(),
            targetDb.doc('osbb_settings/finance').get().catch(() => ({ exists: false }))
        ]);
        if (!paySnap.exists) fail('not-found', 'Платіж не знайдено');
        const p = { id: paySnap.id, ...paySnap.data() };
        if (p.status === 'paid') fail('failed-precondition', 'Цей платіж уже підписано та проведено у виписці');
        if (p.status === 'canceled') fail('failed-precondition', 'Скасований платіж не можна підписати');

        const fin = finSnap.exists ? finSnap.data() : {};
        const signed = await signSinglePayment(targetDb, bankSvc, p, {
            date: data.date,
            time: data.time,
            feeKop: data.feeKop || 0,
            signerName: data.signerName,
            myName: fin.payeeName || 'ОСББ «Успіх-25»',
            myEdrpou: fin.edrpou || '40562894'
        }, actor);

        await writeAudit(targetDb, actor, role, 'platform.bank.signPayment', `payments/${paymentId}`,
            `КЕП-підпис та проведення платежу в Приват24: ${p.recipient?.name || ''} — ${fromKop(p.amountKop)} грн (DLR: ${signed.bankRef})`,
            { tenantId, paymentId, txId: signed.txId, bankRef: signed.bankRef, amountKop: p.amountKop });

        return { ok: true, ...signed };
    }

    async function bankSignAllPayments(actor, role, data) {
        if (role !== 'chair') fail('permission-denied', 'Підписувати пачку платежів КЕП може лише голова (супер-адмін)');
        const tenantId = String(data.tenantId || 'uspih-25').trim();
        const targetDb = resolveTenantDb(tenantId);
        const { bankSvc } = resolveServices(targetDb, actor);

        const [pendingSnap, finSnap] = await Promise.all([
            targetDb.collection('payments').where('status', 'in', ['sent', 'sending', 'unknown']).get(),
            targetDb.doc('osbb_settings/finance').get().catch(() => ({ exists: false }))
        ]);

        if (pendingSnap.empty) {
            return { ok: true, signedCount: 0, results: [] };
        }

        const fin = finSnap.exists ? finSnap.data() : {};
        const results = [];
        for (const docSnap of pendingSnap.docs) {
            const p = { id: docSnap.id, ...docSnap.data() };
            const res = await signSinglePayment(targetDb, bankSvc, p, {
                date: data.date,
                time: data.time,
                feeKop: data.feeKop || 0,
                signerName: data.signerName,
                myName: fin.payeeName || 'ОСББ «Успіх-25»',
                myEdrpou: fin.edrpou || '40562894'
            }, actor);
            results.push(res);
        }

        const totalKop = pendingSnap.docs.reduce((s, d) => s + Number(d.data().amountKop || 0), 0);
        await writeAudit(targetDb, actor, role, 'platform.bank.signAll', 'payments',
            `Пачковий КЕП-підпис у Приват24: проведено ${results.length} платежів на суму ${fromKop(totalKop)} грн`,
            { tenantId, signedCount: results.length, totalKop });

        return { ok: true, signedCount: results.length, totalKop, results };
    }

    async function bankRejectPayment(actor, role, data) {
        if (role !== 'chair') fail('permission-denied', 'Відхиляти платежі в симуляторі банку може лише голова (супер-адмін)');
        const tenantId = String(data.tenantId || 'uspih-25').trim();
        const paymentId = String(data.paymentId || '').trim();
        const reason = String(data.reason || 'Відхилено банком при перевірці підпису / реквізитів у Приват24').trim().slice(0, 260);
        if (!paymentId) fail('invalid-argument', 'Вкажіть ID платежу');

        const targetDb = resolveTenantDb(tenantId);
        const ref = targetDb.doc(`payments/${paymentId}`);
        const snap = await ref.get();
        if (!snap.exists) fail('not-found', 'Платіж не знайдено');
        const p = snap.data();
        if (p.status === 'paid') fail('failed-precondition', 'Уже проведений у виписці платіж не можна відхилити як чернетку (використайте сторно виписки)');

        await targetDb.runTransaction(async t => {
            const fresh = await t.get(ref);
            const cur = fresh.data();
            const payrollRef = cur.payroll && !cur.payroll.repayOf ? targetDb.doc(`payroll_runs/${cur.payroll.period}`) : null;
            const payroll = payrollRef ? await t.get(payrollRef) : null;
            t.update(ref, {
                status: 'failed',
                bankStatus: 'відхилений банком',
                error: reason,
                rejectedBy: actor,
                rejectedAt: FieldValue.serverTimestamp()
            });
            if (payroll?.exists) {
                const stage = payroll.data().stages?.[cur.payroll.stage];
                if (stage) {
                    t.update(payrollRef, {
                        [`stages.${cur.payroll.stage}.complete`]: false,
                        [`stages.${cur.payroll.stage}.completed`]: payrollIdentity.withoutCompleted(stage.completed, ref.id)
                    });
                }
            }
            if (cur.payroll?.repayOf) {
                t.update(targetDb.doc(`payments/${cur.payroll.repayOf}`), {
                    repaidBy: FieldValue.arrayRemove(ref.id)
                });
            }
        });

        await writeAudit(targetDb, actor, role, 'platform.bank.rejectPayment', `payments/${paymentId}`,
            `Платіж ${p.recipient?.name || ''} (${fromKop(p.amountKop)} грн) відхилено в симуляторі Приват24: ${reason}`,
            { tenantId, paymentId, reason });

        return { ok: true, paymentId, status: 'failed' };
    }

    /**
     * Створення вхідної (TRANTYPE: 'C') або вихідної (TRANTYPE: 'D') банківської операції
     * за шаблоном або з довільними реквізитами. Проходить повний конвеєр:
     * buildPrivatRawTransaction -> privat.normalizeTransaction -> bank.storeTransactions.
     */
    async function bankSimulateTransaction(actor, role, data) {
        const tenantId = String(data.tenantId || 'uspih-25').trim();
        const targetDb = resolveTenantDb(tenantId);
        const { bankSvc } = resolveServices(targetDb, actor);

        const amountKop = Math.abs(Math.round(Number(data.amountKop || 0)));
        if (!Number.isSafeInteger(amountKop) || amountKop <= 0) {
            fail('invalid-argument', 'Вкажіть суму операції більшу за 0,00 грн');
        }
        const purpose = String(data.purpose || '').replace(/\s+/g, ' ').trim();
        if (purpose.length < 3) {
            fail('invalid-argument', 'Вкажіть призначення платежу (поле OSND у Приват24)');
        }

        const [settingsSnap, finSnap] = await Promise.all([
            targetDb.doc('bank/settings').get().catch(() => ({ exists: false })),
            targetDb.doc('osbb_settings/finance').get().catch(() => ({ exists: false }))
        ]);

        const settings = settingsSnap.exists ? settingsSnap.data() : {};
        const fin = finSnap.exists ? finSnap.data() : {};
        const existingAccounts = Object.keys(settings.accounts || {});
        const myAccount = normIban(data.account || existingAccounts[0] || fin.iban || core.DEFAULT_SIM_ACCOUNTS[0].iban);

        // Якщо рахунку ще немає в bank/settings — автоматично ініціалізуємо симулятор
        if (!settings.accounts?.[myAccount]) {
            await bankSetupSimulator(actor, role === 'chair' ? 'chair' : 'chair', {
                tenantId,
                currentIban: myAccount
            });
        }

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
            ref: data.ref || `P24SIM${Date.now().toString(36).toUpperCase()}`,
            refn: data.refn || '1',
            dlr: data.dlr || '',
            docNumber: data.docNumber || '',
            myName: fin.payeeName || 'ОСББ «Успіх-25»',
            myEdrpou: fin.edrpou || '40562894'
        });

        const normalized = privat.normalizeTransaction(rawPrivatTx);
        if (!normalized) {
            fail('invalid-argument', 'Не вдалося нормалізувати банківську транзакцію за правилами Приват24 (перевірте дату та реквізити)');
        }

        const ctx = await bankSvc.loadContext();
        const storeResult = await bankSvc.storeTransactions([normalized], 'privat', ctx);

        const deltaKop = direction === 'in' ? amountKop : -amountKop;
        await adjustSimulatedAccountBalance(targetDb, myAccount, deltaKop, storeResult.added || 1, storeResult.matched || 0);

        const txId = safeId(`${normalized.account}_${normalized.bankId}`);
        const txSnap = await targetDb.doc(`bank_tx/${txId}`).get();
        const storedTx = txSnap.exists ? { id: txSnap.id, ...serializeValue(txSnap.data()) } : null;

        await writeAudit(targetDb, actor, role, 'platform.bank.simulateTx', `bank_tx/${txId}`,
            `Симуляція операції Приват24 (${direction === 'in' ? '+' : '−'}${fromKop(amountKop)} грн, ${rawPrivatTx.AUT_CNTR_NAM}): ${storedTx?.status === 'done' ? `рознесено автоматично (${storedTx.kind})` : 'у черзі «Рішення»'}`,
            { tenantId, txId, direction, amountKop, status: storedTx?.status, kind: storedTx?.kind, allocations: storedTx?.allocations || [] });

        return {
            ok: true,
            txId,
            rawPrivatTx,
            storedTx,
            storeResult
        };
    }

    /**
     * Симуляція банківського сторно (PR_PR: 't') для вже проведеної операції виписки.
     */
    async function bankVoidTransaction(actor, role, data) {
        if (role !== 'chair') fail('permission-denied', 'Симулювати банківське сторно може лише голова (супер-адмін)');
        const tenantId = String(data.tenantId || 'uspih-25').trim();
        const txId = safeId(data.txId);
        if (!txId) fail('invalid-argument', 'Вкажіть ID транзакції для сторнування');

        const targetDb = resolveTenantDb(tenantId);
        const { bankSvc } = resolveServices(targetDb, actor);

        const txSnap = await targetDb.doc(`bank_tx/${txId}`).get();
        if (!txSnap.exists) fail('not-found', 'Транзакцію у виписці не знайдено');
        const oldTx = txSnap.data();
        if (oldTx.bankVoided) fail('failed-precondition', 'Цю операцію вже сторновано банком');

        const [refPart, refnPart = '1'] = String(oldTx.bankId || '').split('_');
        const rawVoid = core.buildPrivatRawTransaction({
            account: oldTx.account,
            direction: oldTx.direction,
            trantype: oldTx.direction === 'out' ? 'D' : 'C',
            amountKop: oldTx.amountKop,
            counterpartyName: oldTx.counterparty?.name || '',
            counterpartyCode: oldTx.counterparty?.code || '',
            counterpartyIban: oldTx.counterparty?.account || '',
            purpose: oldTx.purpose || '',
            ref: oldTx.statementRef || refPart,
            refn: oldTx.statementRefn || refnPart,
            flReal: 'r',
            prPr: 't' // PR_PR: 't' — сторнована банком операція за документацією Автоклієнта
        });

        const normVoid = privat.normalizeTransaction(rawVoid);
        const ctx = await bankSvc.loadContext();
        const storeResult = await bankSvc.storeTransactions([normVoid], 'privat', ctx);

        if (storeResult.voided) {
            const reverseDelta = oldTx.direction === 'in' ? -oldTx.amountKop : oldTx.amountKop;
            await adjustSimulatedAccountBalance(targetDb, oldTx.account, reverseDelta, 0, 0);
        }

        await writeAudit(targetDb, actor, role, 'platform.bank.voidTx', `bank_tx/${txId}`,
            `Симуляція банківського сторно Приват24 (PR_PR='t') для ${txId} на суму ${fromKop(oldTx.amountKop)} грн`,
            { tenantId, txId, storeResult });

        return { ok: true, txId, storeResult };
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
        const { chargesSvc } = resolveServices(targetDb, actor);
        if (chargesSvc?.recompute) {
            recomputed = await chargesSvc.recompute([apt]);
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
        const paymentsList = (paymentsSnap.docs || []).map(d => ({ id: d.id, ...serializeValue(d.data()) }));
        const closedPeriods = (periodsSnap.docs || []).map(d => ({ id: d.id, ...serializeValue(d.data()) }));

        const result = core.evaluateAccountingInvariants({
            apartments,
            ledgersByApt,
            bankTx,
            payments: paymentsList,
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
            case 'bankSimulatorContext': return bankSimulatorContext(actor, role, data);
            case 'bankSetupSimulator': return bankSetupSimulator(actor, role, data);
            case 'bankDisableSimulator': return bankDisableSimulator(actor, role, data);
            case 'bankSignPayment': return bankSignPayment(actor, role, data);
            case 'bankSignAllPayments': return bankSignAllPayments(actor, role, data);
            case 'bankRejectPayment': return bankRejectPayment(actor, role, data);
            case 'bankSimulateTransaction': return bankSimulateTransaction(actor, role, data);
            case 'bankVoidTransaction': return bankVoidTransaction(actor, role, data);
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
        actions: {
            overview,
            bankSimulatorContext,
            bankSetupSimulator,
            bankDisableSimulator,
            bankSignPayment,
            bankSignAllPayments,
            bankRejectPayment,
            bankSimulateTransaction,
            bankVoidTransaction,
            saveTenant,
            inspectCollection,
            manualPatch,
            ledgerAdjustment,
            runDiagnostics
        }
    };
};
