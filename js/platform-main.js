// ============================================================
// Super-Admin Platform Control Plane (platform.html / js/platform-main.js).
//
// Єдиний центр управління платформою ОСББ:
//   1. Мульти-ОСББ та бази (tenants): реєстр усіх підключених ОСББ,
//      режими ізоляції БД, перемикання активного контексту, онбординг нового ОСББ.
//   2. Банк Приват24 — Симулятор Автоклієнт v3.0.0 (bank):
//      - віртуальний ключ Автоклієнта та рахунки ОСББ (поточний 311, резервний 311);
//      - черга всіх вихідних платежів ОСББ на підпис КЕП та проведення через
//        normalizeTransaction -> bank.storeTransactions;
//      - конструктор вхідних і вихідних операцій за шаблонами в 1 клік,
//        вибором реальної квартири або вільними реквізитами у форматі Приват24 API;
//      - живий журнал виписки (bank_tx) із симуляцією банківського сторно (PR_PR='t').
//   3. Тести й симуляції (testing): перевірка інваріантів бази, керування
//      ізольованим тестовим полігоном (банківські операції, нарахування,
//      зарплата, податкові та річні звіти).
//   4. Користувачі й активність (users): статистика ролей, кабінетів
//      співвласників, боржників/переплат та живий потік журналу аудиту.
//   5. Інспектор БД і ручне коригування (inspector): перегляд колекцій,
//      попередній перегляд diff (Було -> Стане), безпечне збереження з
//      обовʼязковою причиною для audit_log та перерахунком балансу квартири.
//   6. Архітектура Multi-Tenant (architecture): світові практики SaaS/Fintech
//      та дорожня карта масштабування платформи на сотні ОСББ.
// ============================================================
import { auth, db, session, currentApt, resetSession } from './firebase.js';
import { onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js';
import {
    collection, collectionGroup, doc, getDoc, getDocs, setDoc, addDoc, query, orderBy, limit, serverTimestamp
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js';
import { callBackend } from './backend.js';
import { escapeHtml as esc, toast, setBusy, hideAppLoader, confirmDialog, promptDialog } from './ui.js';
import { hasRight, ROLE_LABELS } from './staff-core.js';
import { loadProfile, sessionExpired, rememberWorkMode } from './app-common.js';
import { registerServiceWorker } from './install.js';
import { fmtKop, periodName, toKop } from './charges-core.js';
const cleanApt = v => String(v ?? '').trim().replace(/^0+(?=\d)/, '');
const normIban = v => String(v || '').replace(/\s+/g, '').toUpperCase();
import {
    TENANT_STATUSES,
    ISOLATION_MODES,
    INSPECTABLE_COLLECTIONS,
    SIMULATION_SCENARIOS,
    BANK_SIM_TEMPLATES,
    DEFAULT_SIM_ACCOUNTS,
    buildPrivatRawTransaction,
    buildPrivatPaymentApiLifecycle,
    normalizeTenantSlug,
    validateTenantInput,
    computePatchDiff,
    validateManualPatch,
    evaluateAccountingInvariants,
    summarizeUserActivity
} from './platform-core.js';

const VIEW_META = {
    tenants: {
        title: 'Управління всіма ОСББ та базами даних',
        sub: 'Реєстр підключених ОСББ, перемикання активного контуру БД, онбординг нових будинків та моніторинг стану'
    },
    bank: {
        title: 'Симулятор Приват24 Бізнес API «Автоклієнт» v3.0.0',
        sub: 'Підписання КЕП вихідних платежів ОСББ, генератор вхідних операцій за шаблонами й вільними реквізитами та жива виписка рахунків'
    },
    testing: {
        title: 'Тестовий полігон і симуляція операцій',
        sub: 'Перевірка бухгалтерських інваріантів, симуляція виписок Приват24, зарплати, податкових та річних звітів ДПС'
    },
    users: {
        title: 'Статистика користувачів та активність',
        sub: 'Аналітика входів співвласників, ролей правління й бухгалтерії та живий потік журналу аудиту (audit_log)'
    },
    inspector: {
        title: 'Інспектор колекцій БД та ручне коригування',
        sub: 'Перегляд документів, безпечний Break-Glass редактор із попереднім переглядом diff, обовʼязковою підставою та перерахунком балансу'
    },
    architecture: {
        title: 'Архітектура Multi-Tenant SaaS (Світові практики)',
        sub: 'Фундамент масштабування системи на сотні ОСББ: Control Plane, рівні ізоляції БД, подійний облік та безпека'
    }
};

const PAYMENT_KIND_LABELS = {
    supplier: 'Постачальнику (631)',
    salary: 'Зарплата (661)',
    tax: 'Податки / ЄСВ (641/651)',
    advance: 'Авансовий звіт (372)',
    other: 'Інший платіж'
};

let activeView = 'tenants';
let activeTenantId = 'uspih-25';
let overviewData = null;
let showNewTenantForm = false;
let editingTenant = null;

// Стан для вкладки «Банк Приват24»
const DEFAULT_TEST_TOKEN = 'PRIVAT24_TEST_KEY_USPIH25_SANDBOX_V3';
let bankSimData = null;
let autoSyncBank = true;
let showBankSetupForm = false;
let showTestOutPayForm = false;
let activeTemplateId = 'resident_exact';
let selectedSimApt = '';
let selectedSimApt2 = '';
let lastSimulatedTxResult = null;
let bankBuilderDraft = null;

// Стан для вкладки «Тести й симуляції»
let sandboxState = null;
let sandboxPeriod = '2025-10';
let sandboxVerifyResult = null;
let liveDiagnostics = null;

// Стан для вкладки «Користувачі й активність»
let auditQuery = '';

// Стан для вкладки «Інспектор БД і ручне коригування»
let inspectorCol = 'apartments';
let inspectorSubcol = '';
let inspectorAptId = '';
let inspectorQuery = '';
let inspectorDocs = [];
let selectedDoc = null;
let patchPreviewDiffs = null;
let showLedgerAdjustForm = false;

function serializeDocData(val) {
    if (val === null || val === undefined) return val;
    if (typeof val?.toDate === 'function') return val.toDate().toISOString();
    if (Array.isArray(val)) return val.map(serializeDocData);
    if (typeof val === 'object') {
        const out = {};
        for (const [k, v] of Object.entries(val)) out[k] = serializeDocData(v);
        return out;
    }
    return val;
}

/**
 * Універсальний виклик сервісу платформи з автоматичним клієнтським фолбеком
 * для читання даних, якщо Cloud Functions ще не оновлено.
 */
async function callPlatform(payload) {
    try {
        return await callBackend('platformAction', { tenantId: activeTenantId, ...payload });
    } catch (err) {
        const msg = String(err?.message || '');
        if (/not-found|unimplemented|function.*not.*exist|CORS|internal|Failed to fetch|Невідома дія платформи/i.test(msg)) {
            return clientFallbackPlatform({ tenantId: activeTenantId, ...payload });
        }
        throw err;
    }
}

async function clientFallbackPlatform(data) {
    const action = data.action;
    const uid = auth.currentUser?.uid || '';

    if (action === 'overview') {
        const [
            tenantsSnap,
            finSnap,
            aptsSnap,
            staffSnap,
            auditSnap,
            bankSnap,
            bankTxSnap,
            paymentsSnap,
            periodsSnap,
            expensesSnap,
            claimsSnap,
            chargesSnap
        ] = await Promise.all([
            getDocs(collection(db, 'platform_tenants')).catch(() => ({ docs: [] })),
            getDoc(doc(db, 'osbb_settings', 'finance')).catch(() => ({ exists: () => false })),
            getDocs(collection(db, 'apartments')).catch(() => ({ docs: [] })),
            getDocs(collection(db, 'staff')).catch(() => ({ docs: [] })),
            getDocs(query(collection(db, 'audit_log'), orderBy('at', 'desc'), limit(120))).catch(() => ({ docs: [] })),
            getDoc(doc(db, 'bank', 'settings')).catch(() => ({ exists: () => false })),
            getDocs(query(collection(db, 'bank_tx'), limit(250))).catch(() => ({ docs: [] })),
            getDocs(query(collection(db, 'payments'), limit(200))).catch(() => ({ docs: [] })),
            getDocs(collection(db, 'journal_periods')).catch(() => ({ docs: [] })),
            getDocs(query(collection(db, 'expenses'), limit(200))).catch(() => ({ docs: [] })),
            getDocs(collection(db, 'claims')).catch(() => ({ docs: [] })),
            getDoc(doc(db, 'charges', 'settings')).catch(() => ({ exists: () => false }))
        ]);

        const fin = finSnap.exists?.() ? finSnap.data() : {};
        const reg = fin.registry || {};
        const bank = bankSnap.exists?.() ? bankSnap.data() : {};
        const chargesCfg = chargesSnap.exists?.() ? chargesSnap.data() : {};
        const apartments = (aptsSnap.docs || []).map(d => ({ id: d.id, ...serializeDocData(d.data()) }));
        const realApts = apartments.filter(a => a.isAdmin !== true);
        let debtKop = 0;
        let overpaidKop = 0;
        for (const a of realApts) {
            const kop = Math.round(Number(a.balance || 0) * 100);
            if (kop < 0) debtKop += Math.abs(kop);
            else if (kop > 0) overpaidKop += kop;
        }

        const primaryTenant = {
            id: 'uspih-25',
            name: fin.payeeName || reg.legalName || 'ОСББ «Успіх-25»',
            edrpou: fin.edrpou || reg.code || '40562894',
            city: 'м. Одеса',
            address: fin.houseAddress || reg.legalAddress || 'вул. Інглезі, 3/3, м. Одеса',
            iban: fin.iban || Object.values(bank.accounts || {})[0]?.iban || '',
            apartmentsCount: realApts.length,
            debtKop,
            overpaidKop,
            bankConnected: Boolean(bank.tokenSet || Object.keys(bank.accounts || {}).length),
            openingSet: Boolean(chargesCfg.opening?.set),
            isolationMode: 'root_default',
            status: 'active',
            plan: 'enterprise',
            isPrimary: true
        };

        const customTenants = (tenantsSnap.docs || [])
            .filter(d => d.id !== 'uspih-25')
            .map(d => ({ id: d.id, ...serializeDocData(d.data()), isPrimary: false }));

        const sandboxTenant = uid ? [{
            id: `sandbox~${uid}`,
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

        const staff = (staffSnap.docs || []).map(d => ({ id: d.id, ...serializeDocData(d.data()) }));
        const auditLogs = (auditSnap.docs || []).map(d => ({ id: d.id, ...serializeDocData(d.data()) }));
        const bankTx = (bankTxSnap.docs || []).map(d => ({ id: d.id, ...serializeDocData(d.data()) }));
        const payments = (paymentsSnap.docs || []).map(d => ({ id: d.id, ...serializeDocData(d.data()) }));
        const closedPeriods = (periodsSnap.docs || []).map(d => ({ id: d.id, ...serializeDocData(d.data()) }));
        const expenses = (expensesSnap.docs || []).map(d => ({ id: d.id, ...serializeDocData(d.data()) }));
        const claims = (claimsSnap.docs || []).map(d => ({ id: d.id, ...serializeDocData(d.data()) }));

        return {
            ok: true,
            activeTenantId: data.tenantId || 'uspih-25',
            tenants: [primaryTenant, ...customTenants, ...sandboxTenant],
            counts: {
                apartments: realApts.length,
                staff: staff.length,
                bankTx: bankTx.length,
                bankReview: bankTx.filter(t => t.status === 'review').length,
                payments: payments.length,
                paymentsPending: payments.filter(p => ['sent', 'sending', 'unknown'].includes(p.status)).length,
                expenses: expenses.length,
                claims: claims.length,
                closedPeriods: closedPeriods.filter(p => p.status === 'closed').length
            },
            userStats: summarizeUserActivity({ apartments, staff, auditLogs, nowMs: Date.now() }),
            diagnostics: evaluateAccountingInvariants({ apartments, bankTx, payments, closedPeriods }),
            recentAudit: auditLogs.slice(0, 50)
        };
    }

    if (action === 'bankSimulatorContext') {
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
            getDoc(doc(db, 'bank', 'settings')).catch(() => ({ exists: () => false })),
            getDoc(doc(db, 'osbb_settings', 'finance')).catch(() => ({ exists: () => false })),
            getDocs(query(collection(db, 'payments'), limit(200))).catch(() => ({ docs: [] })),
            getDocs(query(collection(db, 'bank_tx'), limit(150))).catch(() => ({ docs: [] })),
            getDocs(collection(db, 'apartments')).catch(() => ({ docs: [] })),
            getDocs(collectionGroup(db, 'owners')).catch(() => ({ docs: [] })),
            getDocs(query(collection(db, 'expenses'), limit(150))).catch(() => ({ docs: [] })),
            getDocs(query(collection(db, 'advance_reports'), limit(80))).catch(() => ({ docs: [] })),
            getDocs(query(collection(db, 'suppliers'), limit(150))).catch(() => ({ docs: [] }))
        ]);

        const fin = finSnap.exists?.() ? finSnap.data() : {};
        const reg = fin.registry || {};
        const org = {
            name: fin.payeeName || reg.legalName || 'ОСББ «Успіх-25»',
            edrpou: fin.edrpou || reg.code || '40562894',
            address: fin.houseAddress || reg.legalAddress || 'вул. Інглезі, 3/3, м. Одеса',
            iban: fin.iban || ''
        };

        const bankSettings = bankSettingsSnap.exists?.() ? serializeDocData(bankSettingsSnap.data()) : {};
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

        const expensesById = new Map((expensesSnap.docs || []).map(d => [d.id, { id: d.id, ...serializeDocData(d.data()) }]));
        const advById = new Map((advSnap.docs || []).map(d => [d.id, { id: d.id, ...serializeDocData(d.data()) }]));
        const suppliers = (suppliersSnap.docs || []).map(d => ({ id: d.id, ...serializeDocData(d.data()) }));

        const allPayments = (paymentsSnap.docs || [])
            .map(d => {
                const p = { id: d.id, ...serializeDocData(d.data()) };
                const linkedExp = p.expenseId ? expensesById.get(p.expenseId) : null;
                const linkedAdv = p.advanceReportId ? advById.get(p.advanceReportId) : null;
                p.linkedInfo = linkedExp
                    ? `Документ № ${linkedExp.number || '—'} (${linkedExp.supplierName || ''})`
                    : linkedAdv
                        ? `Авансовий звіт № ${linkedAdv.number || linkedAdv.id} (${linkedAdv.personName || ''})`
                        : p.payroll
                            ? `Зарплатна відомість за ${p.payroll.period} (${p.payroll.stage === 'advance' ? 'аванс' : 'основна виплата'})`
                            : 'Прямий платіж';
                p.privatApi = buildPrivatPaymentApiLifecycle(p, {
                    myName: org.name,
                    myEdrpou: org.edrpou
                });
                return p;
            })
            .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));

        const pendingPayments = allPayments.filter(p => ['sent', 'sending', 'unknown'].includes(p.status));
        const historyPayments = allPayments.filter(p => !['sent', 'sending', 'unknown'].includes(p.status)).slice(0, 50);

        const recentTx = (txSnap.docs || [])
            .map(d => ({ id: d.id, ...serializeDocData(d.data()) }))
            .sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')))
            .slice(0, 80);

        const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Kyiv' }).format(new Date());

        return {
            ok: true,
            tenantId: data.tenantId || 'uspih-25',
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
            defaultSimAccounts: DEFAULT_SIM_ACCOUNTS,
            pendingPayments,
            historyPayments,
            recentTx,
            apartments,
            suppliers,
            openExpenses: [...expensesById.values()].filter(e => e.status === 'approved'),
            templates: BANK_SIM_TEMPLATES
        };
    }

    if (action === 'saveTenant') {
        const v = validateTenantInput(data);
        if (!v.ok) throw new Error(v.error);
        const t = v.tenant;
        await setDoc(doc(db, 'platform_tenants', t.id), {
            ...t,
            updatedBy: String(session.apt || 'admin'),
            updatedAt: serverTimestamp()
        }, { merge: true });
        return { ok: true, tenant: t };
    }

    if (action === 'inspectCollection') {
        const colName = String(data.collection || 'apartments').trim();
        const maxDocs = Math.min(300, Math.max(10, Number(data.limit || 100)));
        const search = String(data.query || '').trim().toLowerCase();

        let snap;
        if (colName === 'apartments' && data.aptId && ['ledger', 'owners'].includes(data.subcollection)) {
            snap = await getDocs(query(collection(db, 'apartments', String(data.aptId).trim(), data.subcollection), limit(maxDocs)));
        } else {
            snap = await getDocs(query(collection(db, colName), limit(maxDocs)));
        }

        let docs = (snap.docs || []).map(d => ({
            id: d.id,
            path: d.ref?.path || `${colName}/${d.id}`,
            data: serializeDocData(d.data())
        }));

        if (search) {
            docs = docs.filter(item =>
                item.id.toLowerCase().includes(search) ||
                JSON.stringify(item.data).toLowerCase().includes(search)
            );
        }

        return { ok: true, tenantId: data.tenantId, collection: colName, count: docs.length, docs };
    }

    if (action === 'manualPatch') {
        const v = validateManualPatch({
            collection: data.collection,
            docId: data.docId,
            patch: data.patch,
            reason: data.reason
        });
        if (!v.ok) throw new Error(v.error);

        const docPath = (data.collection === 'apartments' && data.aptId && ['ledger', 'owners'].includes(data.subcollection))
            ? `apartments/${data.aptId}/${data.subcollection}/${data.docId}`
            : `${data.collection}/${data.docId}`;
        const ref = doc(db, ...docPath.split('/'));
        const snap = await getDoc(ref);
        const beforeData = snap.exists() ? serializeDocData(snap.data()) : {};
        const diffs = computePatchDiff(beforeData, v.cleanPatch);

        if (data.dryRun === true) {
            return { ok: true, dryRun: true, docPath, exists: snap.exists(), diffs, before: beforeData };
        }
        await setDoc(ref, {
            ...v.cleanPatch,
            manualAdjustedBy: String(session.apt || 'admin'),
            manualAdjustedAt: serverTimestamp()
        }, { merge: true });

        await addDoc(collection(db, 'audit_log'), {
            actor: String(session.apt || 'admin'),
            role: session.role || 'chair',
            action: 'platform.manualPatch',
            target: docPath,
            summary: `Ручне коригування ${docPath}: ${v.reason}`,
            details: { diffs, reason: v.reason },
            at: serverTimestamp()
        }).catch(() => {});

        if (data.collection === 'apartments' && data.recomputeBalance !== false) {
            await callBackend('chargesAction', { action: 'recompute' }).catch(() => {});
        }
        return { ok: true, docPath, diffs };
    }

    if (action === 'runDiagnostics') {
        const [aptsSnap, ledgersSnap, bankTxSnap, paymentsSnap, periodsSnap] = await Promise.all([
            getDocs(collection(db, 'apartments')).catch(() => ({ docs: [] })),
            getDocs(collectionGroup(db, 'ledger')).catch(() => ({ docs: [] })),
            getDocs(collection(db, 'bank_tx')).catch(() => ({ docs: [] })),
            getDocs(collection(db, 'payments')).catch(() => ({ docs: [] })),
            getDocs(collection(db, 'journal_periods')).catch(() => ({ docs: [] }))
        ]);
        const apartments = (aptsSnap.docs || []).map(d => ({ id: d.id, ...serializeDocData(d.data()) }));
        const ledgersByApt = new Map();
        for (const d of ledgersSnap.docs || []) {
            const apt = d.ref?.parent?.parent?.id;
            if (!apt) continue;
            if (!ledgersByApt.has(apt)) ledgersByApt.set(apt, []);
            ledgersByApt.get(apt).push({ id: d.id, ...serializeDocData(d.data()) });
        }
        const bankTx = (bankTxSnap.docs || []).map(d => ({ id: d.id, ...serializeDocData(d.data()) }));
        const payments = (paymentsSnap.docs || []).map(d => ({ id: d.id, ...serializeDocData(d.data()) }));
        const closedPeriods = (periodsSnap.docs || []).map(d => ({ id: d.id, ...serializeDocData(d.data()) }));
        return {
            ok: true,
            tenantId: data.tenantId,
            ...evaluateAccountingInvariants({ apartments, ledgersByApt, bankTx, payments, closedPeriods })
        };
    }

    throw new Error(`Для дії «${action}» потрібне оновлення Cloud Functions (розгорніть функції з оновленого архіву)`);
}

// ============================================================
// НАВІГАЦІЯ ТА ПЕРЕМИКАЧ КОНТЕКСТУ БАЗИ
// ============================================================
function updateBankBadges(pendingCount) {
    const count = Number(pendingCount ?? bankSimData?.pendingPayments?.length ?? overviewData?.counts?.paymentsPending ?? 0);
    ['pfBankBadge', 'pfBankBadgeTab'].forEach(id => {
        const el = document.getElementById(id);
        if (!el) return;
        if (count > 0) {
            el.hidden = false;
            el.textContent = String(count);
        } else {
            el.hidden = true;
            el.textContent = '';
        }
    });
}

function updateTenantSwitcher() {
    const sel = document.getElementById('pfTenantSelect');
    const wrap = sel?.closest('.pf-db-switcher');
    if (!sel || !overviewData?.tenants) return;
    sel.innerHTML = overviewData.tenants.map(t =>
        `<option value="${esc(t.id)}"${t.id === activeTenantId ? ' selected' : ''}>${esc(t.name)} (${t.isSandbox ? 'Пісочниця' : `ЄДРПОУ ${t.edrpou}`})</option>`
    ).join('');
    if (wrap) wrap.classList.toggle('is-sandbox', activeTenantId.startsWith('sandbox~'));
    updateBankBadges();
}

async function switchView(viewName, { push = true } = {}) {
    if (!VIEW_META[viewName]) viewName = 'tenants';
    activeView = viewName;
    document.querySelectorAll('.pf-view').forEach(el => {
        el.hidden = el.dataset.view !== viewName;
    });
    document.querySelectorAll('[data-view]').forEach(btn => {
        if (btn.matches('.buh-nav-item, .buh-tab')) {
            btn.classList.toggle('active', btn.dataset.view === viewName);
        }
    });
    document.getElementById('pfTitle').textContent = VIEW_META[viewName].title;
    document.getElementById('pfSubtitle').textContent = VIEW_META[viewName].sub;
    if (push && location.hash !== `#${viewName}`) {
        history.pushState(null, '', `#${viewName}`);
    }
    await renderCurrentView();
}

async function refreshAllData() {
    overviewData = await callPlatform({ action: 'overview', tenantId: activeTenantId });
    if (activeView === 'bank') {
        bankSimData = await callPlatform({ action: 'bankSimulatorContext', tenantId: activeTenantId });
    }
    updateTenantSwitcher();
    await renderCurrentView();
}

async function renderCurrentView() {
    if (!overviewData) {
        overviewData = await callPlatform({ action: 'overview', tenantId: activeTenantId });
        updateTenantSwitcher();
    }
    if (activeView === 'tenants') renderTenantsView();
    else if (activeView === 'bank') await renderBankView();
    else if (activeView === 'testing') await renderTestingView();
    else if (activeView === 'users') renderUsersView();
    else if (activeView === 'inspector') await renderInspectorView();
    else if (activeView === 'architecture') renderArchitectureView();
}

// ============================================================
// ВКЛАДКА 1: МУЛЬТИ-ОСББ ТА БАЗИ ДАНИХ (tenants)
// ============================================================
function tenantFormHtml(t = {}) {
    const isEdit = Boolean(t.id);
    return `<section class="buh-card ex-form" id="pfTenantForm" style="margin-bottom:16px">
        <div class="buh-card-head">
            <h2>${isEdit ? `Налаштування ОСББ: ${esc(t.name)}` : 'Підключити нове ОСББ до платформи (Multi-Tenant Onboarding)'}</h2>
            <button type="button" class="btn-ghost-small" data-pf-act="close-tenant-form">Закрити</button>
        </div>
        <p class="buh-note">Кожне ОСББ отримує власний ізольований контур бази даних (Namespace або окрему Named Database Firestore), власний план рахунків, тарифи, інтеграцію з Приват24 Автоклієнт та незалежний журнал аудиту.</p>
        <div class="pay-grid">
            <label class="field"><span class="field-label">Повна або коротка назва ОСББ</span>
                <input id="tfName" class="field-input" maxlength="160" placeholder="ОСББ «Сонячний квартал»" value="${esc(t.name || '')}"></label>
            <label class="field"><span class="field-label">Код ЄДРПОУ (8 цифр, автоперевірка контрольного розряду)</span>
                <input id="tfEdrpou" class="field-input" inputmode="numeric" maxlength="8" placeholder="40562894" value="${esc(t.edrpou || '')}"></label>
            <label class="field"><span class="field-label">Системний ідентифікатор бази (slug)</span>
                <input id="tfSlug" class="field-input" maxlength="48" placeholder="osbb-sonyachny" value="${esc(t.id || '')}" ${isEdit ? 'readonly' : ''}></label>
            <label class="field"><span class="field-label">Місто / населений пункт</span>
                <input id="tfCity" class="field-input" maxlength="80" placeholder="м. Одеса" value="${esc(t.city || 'м. Одеса')}"></label>
            <label class="field pay-wide"><span class="field-label">Адреса багатоквартирного будинку</span>
                <input id="tfAddress" class="field-input" maxlength="200" placeholder="вул. Аркадійська, 12, м. Одеса" value="${esc(t.address || '')}"></label>
            <label class="field pay-wide"><span class="field-label">Основний поточний рахунок IBAN (необовʼязково на старті)</span>
                <input id="tfIban" class="field-input" maxlength="34" placeholder="UA…" value="${esc(t.iban || '')}"></label>
            <label class="field"><span class="field-label">Кількість квартир / приміщень</span>
                <input id="tfApts" class="field-input" type="number" min="0" max="5000" value="${esc(String(t.apartmentsCount || 120))}"></label>
            <label class="field"><span class="field-label">Статус організації</span>
                <select id="tfStatus" class="field-input field-select">
                    ${Object.entries(TENANT_STATUSES).map(([k, v]) => `<option value="${k}"${k === (t.status || 'onboarding') ? ' selected' : ''}>${esc(v.label)}</option>`).join('')}
                </select></label>
            <label class="field pay-wide"><span class="field-label">Архітектурний рівень ізоляції бази даних (Data Isolation Tier)</span>
                <select id="tfIsolation" class="field-input field-select">
                    ${Object.entries(ISOLATION_MODES).map(([k, v]) => `<option value="${k}"${k === (t.isolationMode || 'namespace_prefix') ? ' selected' : ''}>${esc(v.title)} — ${esc(v.desc)}</option>`).join('')}
                </select></label>
            <label class="field pay-wide"><span class="field-label">Примітка адміністратора платформи</span>
                <input id="tfNotes" class="field-input" maxlength="400" placeholder="Голова правління, контакти, дата переходу…" value="${esc(t.notes || '')}"></label>
            ${!isEdit ? `<label class="am-check pay-wide"><input type="checkbox" id="tfInitSchema" checked><span>Автоматично ініціалізувати базові налаштування обліку (osbb_settings/finance, charges/settings) в ізольованому просторі ОСББ</span></label>` : ''}
        </div>
        <div class="pay-form-actions">
            <button type="button" class="sv-btn" style="width:auto" data-pf-act="save-tenant" data-edit="${isEdit ? '1' : '0'}">${isEdit ? 'Зберегти зміни ОСББ' : 'Створити контур ОСББ'}</button>
        </div>
    </section>`;
}

function renderTenantsView() {
    const host = document.getElementById('viewTenants');
    if (!host || !overviewData) return;

    const tenants = overviewData.tenants || [];
    const c = overviewData.counts || {};
    const diag = overviewData.diagnostics || { allOk: true, passedCount: 0, checks: [] };

    host.innerHTML = `
        <div class="kpi-grid" style="margin-bottom: 14px;">
            <div class="kpi">
                <span>Підключені бази ОСББ</span>
                <b>${tenants.length}</b>
                <small>активний контур: ${esc(activeTenantId)}</small>
            </div>
            <div class="kpi">
                <span>Квартир в активній базі</span>
                <b>${c.apartments || 0}</b>
                <small>адмін-акаунтів: ${c.staff || 0} · судових справ: ${c.claims || 0}</small>
            </div>
            <div class="kpi">
                <span>Операцій банку та платежів</span>
                <b>${(c.bankTx || 0) + (c.payments || 0)}</b>
                <small>на підписі КЕП: ${c.paymentsPending || 0} · чекають рішення: ${c.bankReview || 0}</small>
            </div>
            <div class="kpi">
                <span>Цілісність обліку (Invariants)</span>
                <b style="color:${diag.allOk ? '#16A34A' : '#DC2626'}">${diag.allOk ? '100% ОК' : `Увага (${diag.failedCount})`}</b>
                <small>перевірено ${diag.passedCount}/${(diag.checks || []).length} контрольних тотожностей</small>
            </div>
        </div>

        ${showNewTenantForm ? tenantFormHtml(editingTenant || {}) : ''}

        <div class="buh-card">
            <div class="buh-toolbar">
                <div>
                    <h2 style="margin:0;font-size:17px">Реєстр організацій та баз даних (Multi-Tenant Control Plane)</h2>
                    <p class="buh-note" style="margin:2px 0 0">Перемикайте активну базу даних для огляду, симуляції банку Приват24, тестування, аудиту користувачів або точкового коригування записів.</p>
                </div>
                <div style="display:flex;gap:8px;flex-wrap:wrap">
                    <button type="button" class="sv-btn is-soft btn-compact" data-pf-act="open-bank-tab">Відкрити Банк Приват24 ›</button>
                    <button type="button" class="sv-btn" style="width:auto;min-height:40px;padding:0 18px" data-pf-act="open-new-tenant">+ Підключити нове ОСББ</button>
                </div>
            </div>

            <div class="pf-tenant-grid">
                ${tenants.map(t => {
                    const st = TENANT_STATUSES[t.status] || TENANT_STATUSES.active;
                    const iso = ISOLATION_MODES[t.isolationMode] || { title: t.isolationMode || 'Root Default' };
                    const isCurrent = t.id === activeTenantId;
                    return `<article class="pf-tenant-card${isCurrent ? ' is-active-context' : ''}">
                        <div>
                            <div class="pf-tenant-top">
                                <div>
                                    <h3 class="pf-tenant-title">${esc(t.name)}</h3>
                                    <p class="pf-tenant-sub">${esc(t.address || t.city || 'Адресу не вказано')}</p>
                                </div>
                                <span class="sv-chip ${st.cls}">${esc(st.label)}</span>
                            </div>
                            <div class="pf-tenant-meta" style="margin-top:12px">
                                <div><span>ID контуру БД</span><b>${esc(t.id)}</b></div>
                                <div><span>Код ЄДРПОУ</span><b>${esc(t.edrpou || '—')}</b></div>
                                <div><span>Приміщень</span><b>${t.apartmentsCount ?? '—'}</b></div>
                                <div><span>Ізоляція БД</span><b>${esc(iso.title.split('(')[0].trim())}</b></div>
                                ${t.debtKop !== undefined ? `<div><span>Загальний борг</span><b class="is-out">${fmtKop(t.debtKop)} грн</b></div>` : ''}
                                ${t.overpaidKop !== undefined ? `<div><span>Переплата</span><b>${fmtKop(t.overpaidKop)} грн</b></div>` : ''}
                            </div>
                        </div>
                        <div class="pf-tenant-actions">
                            <button type="button" class="sv-btn${isCurrent ? ' is-soft' : ''} btn-compact" data-pf-act="select-tenant" data-id="${esc(t.id)}">
                                ${isCurrent ? '✓ Активний контур' : 'Перемкнути на цю базу'}
                            </button>
                            <button type="button" class="sv-btn is-soft btn-compact" data-pf-act="open-tenant-bank" data-id="${esc(t.id)}">Банк Приват24 ›</button>
                            <button type="button" class="sv-btn is-soft btn-compact" data-pf-act="inspect-tenant" data-id="${esc(t.id)}">Інспектор БД ›</button>
                            ${!t.isSandbox ? `<button type="button" class="btn-ghost-small" data-pf-act="edit-tenant" data-id="${esc(t.id)}">Реквізити</button>` : `<a href="accounting-test.html" class="btn-ghost-small">Повний полігон ›</a>`}
                        </div>
                    </article>`;
                }).join('')}
            </div>
        </div>
    `;
}

// ============================================================
// ВКЛАДКА 2: БАНК ПРИВАТ24 — СИМУЛЯТОР АВТОКЛІЄНТ v3.0.0 (bank)
// ============================================================
function buildDefaultBuilderDraft() {
    if (!bankSimData) return {};
    const tpl = BANK_SIM_TEMPLATES.find(t => t.id === activeTemplateId) || BANK_SIM_TEMPLATES[0];
    const currentAcc = bankSimData.accounts.find(a => a.purpose === 'current')?.iban
        || bankSimData.accounts[0]?.iban
        || DEFAULT_SIM_ACCOUNTS[0].iban;

    const apts = bankSimData.apartments || [];
    const defaultAptObj = apts.find(a => String(a.apt) === String(selectedSimApt))
        || apts.find(a => a.balanceKop < 0 && a.ownerName)
        || apts[0]
        || { apt: '12', personalAccount: '0012', ownerName: 'Коваленко Олена Василівна', ownerCode: '3124567890', balanceKop: -85000 };

    if (!selectedSimApt && defaultAptObj?.apt) {
        selectedSimApt = String(defaultAptObj.apt);
    }
    const secondAptObj = apts.find(a => String(a.apt) === String(selectedSimApt2))
        || apts.find(a => String(a.apt) !== String(selectedSimApt))
        || { apt: '14' };
    if (!selectedSimApt2 && secondAptObj?.apt) {
        selectedSimApt2 = String(secondAptObj.apt);
    }

    let purpose = tpl.purposeTemplate || '';
    let counterpartyName = tpl.counterpartyName || '';
    let counterpartyCode = tpl.counterpartyCode || '';
    let counterpartyIban = tpl.counterpartyIban || 'UA213052990000026201234567891';
    let amountGrn = tpl.defaultAmountGrn || '850,00';

    if (tpl.id === 'resident_exact') {
        const owner = defaultAptObj.ownerName || `Мешканець кв. ${defaultAptObj.apt}`;
        const accNo = defaultAptObj.personalAccount || String(defaultAptObj.apt).padStart(4, '0');
        purpose = `Внески на утримання будинку, кв. ${defaultAptObj.apt}, особовий рахунок ${accNo}, ${owner}`;
        counterpartyName = owner;
        counterpartyCode = defaultAptObj.ownerCode || '3124567890';
        if (defaultAptObj.balanceKop < 0) {
            amountGrn = (Math.abs(defaultAptObj.balanceKop) / 100).toFixed(2).replace('.', ',');
        }
    } else if (tpl.id === 'resident_split') {
        purpose = `Сплата внесків на утримання будинку за кв. ${defaultAptObj.apt} та кв. ${secondAptObj.apt}`;
        if (defaultAptObj.ownerName) counterpartyName = defaultAptObj.ownerName;
        if (defaultAptObj.ownerCode) counterpartyCode = defaultAptObj.ownerCode;
    }

    const nowTime = new Intl.DateTimeFormat('uk-UA', {
        timeZone: 'Europe/Kyiv', hour: '2-digit', minute: '2-digit', hour12: false
    }).format(new Date());

    return {
        trantype: tpl.trantype || 'C',
        account: currentAcc,
        amountGrn,
        date: bankSimData.today || '2026-10-20',
        time: nowTime,
        counterpartyName,
        counterpartyCode,
        counterpartyIban,
        purpose,
        ref: `P24SIM${Date.now().toString(36).toUpperCase().slice(-6)}`,
        dlr: ''
    };
}

function readBuilderFormValues() {
    const amountKop = toKop(document.getElementById('bsAmount')?.value || '0') || 0;
    const trantype = document.getElementById('bsTrantype')?.value || 'C';
    return {
        trantype,
        direction: trantype === 'D' ? 'out' : 'in',
        account: document.getElementById('bsAccount')?.value || DEFAULT_SIM_ACCOUNTS[0].iban,
        amountKop,
        amountGrn: document.getElementById('bsAmount')?.value || '0,00',
        date: document.getElementById('bsDate')?.value || bankSimData?.today || '2026-10-20',
        time: document.getElementById('bsTime')?.value || '14:30',
        counterpartyName: document.getElementById('bsCntrName')?.value?.trim() || '',
        counterpartyCode: document.getElementById('bsCntrCode')?.value?.trim() || '',
        counterpartyIban: document.getElementById('bsCntrIban')?.value?.trim() || '',
        purpose: document.getElementById('bsPurpose')?.value?.trim() || '',
        ref: document.getElementById('bsRef')?.value?.trim() || `P24SIM${Date.now().toString(36).toUpperCase().slice(-6)}`,
        dlr: document.getElementById('bsDlr')?.value?.trim() || '',
        myName: bankSimData?.org?.name || 'ОСББ «Успіх-25»',
        myEdrpou: bankSimData?.org?.edrpou || '40562894'
    };
}

function updateLivePrivatJsonPreview() {
    const pre = document.getElementById('bsJsonPreview');
    if (!pre) return;
    const vals = readBuilderFormValues();
    const rawTx = buildPrivatRawTransaction(vals);
    pre.textContent = JSON.stringify({
        status: 'SUCCESS',
        exist_next_page: false,
        transactions: [rawTx]
    }, null, 2);
}

function bankSetupFormHtml() {
    const accs = bankSimData?.accounts || [];
    const curAcc = accs.find(a => a.purpose === 'current') || accs[0] || DEFAULT_SIM_ACCOUNTS[0];
    const resAcc = accs.find(a => a.purpose === 'reserve') || accs[1] || DEFAULT_SIM_ACCOUNTS[1];
    const curGrn = ((curAcc.balanceKop ?? curAcc.defaultBalanceKop ?? 28540000) / 100).toFixed(2).replace('.', ',');
    const resGrn = ((resAcc.balanceKop ?? resAcc.defaultBalanceKop ?? 15000000) / 100).toFixed(2).replace('.', ',');

    return `<section class="buh-card ex-form" id="pfBankSetupForm" style="margin-bottom:14px">
        <div class="buh-card-head">
            <h2>Налаштування віртуального підключення Приват24 Автоклієнт v3.0.0 та рахунків ОСББ</h2>
            <button type="button" class="btn-ghost-small" data-pf-act="toggle-bank-setup">Закрити</button>
        </div>
        <p class="buh-note">Після активації віртуального ключа всі розділи Бухгалтерії (<code>buh.html</code>: «Документи», «Зарплата», «Авансові звіти», «Платежі», «Банк») працюють так, ніби введено бойовий токен ПриватБанку: рахунки доступні для оплати, а всі відправлені платежі потрапляють сюди в чергу на КЕП-підпис.</p>
        <div class="pay-grid">
            <label class="field"><span class="field-label">Поточний рахунок ОСББ (IBAN, рах. 311)</span>
                <input id="bsSetupCurIban" class="field-input" maxlength="34" value="${esc(curAcc.iban || DEFAULT_SIM_ACCOUNTS[0].iban)}"></label>
            <label class="field"><span class="field-label">Початковий / поточний залишок на рахунку, грн</span>
                <input id="bsSetupCurBal" class="field-input" inputmode="decimal" value="${esc(curGrn)}"></label>
            <label class="field"><span class="field-label">Резервний / Ремонтний фонд (IBAN, рах. 311)</span>
                <input id="bsSetupResIban" class="field-input" maxlength="34" value="${esc(resAcc.iban || DEFAULT_SIM_ACCOUNTS[1].iban)}"></label>
            <label class="field"><span class="field-label">Залишок резервного фонду, грн</span>
                <input id="bsSetupResBal" class="field-input" inputmode="decimal" value="${esc(resGrn)}"></label>
        </div>
        <div class="pay-form-actions" style="display:flex;gap:10px;flex-wrap:wrap">
            <button type="button" class="sv-btn" style="width:auto" data-pf-act="save-bank-setup">✓ Активувати віртуальний ключ Приват24 та зберегти рахунки</button>
            ${bankSimData?.bankSettings?.simulator ? `<button type="button" class="btn-ghost-small" style="color:#B91C1C" data-pf-act="disable-bank-sim">Вимкнути режим симулятора</button>` : ''}
        </div>
    </section>`;
}

function testOutPaymentFormHtml() {
    const accs = bankSimData?.accounts || [];
    const curIban = accs.find(a => a.purpose === 'current')?.iban || accs[0]?.iban || DEFAULT_SIM_ACCOUNTS[0].iban;
    const openExps = bankSimData?.openExpenses || [];
    const sups = bankSimData?.suppliers || [];
    const defaultSup = sups[0] || { name: 'ТОВ «Одесаліфт-Сервіс»', code: '34512890', iban: 'UA053052990000026007778889991' };

    return `<section class="buh-card ex-form" id="pfTestOutPayForm" style="margin-bottom:14px">
        <div class="buh-card-head">
            <h2>Створити тестовий вихідний платіж ОСББ (відправити в Приват24 на підпис КЕП)</h2>
            <button type="button" class="btn-ghost-small" data-pf-act="toggle-test-out-pay">Закрити</button>
        </div>
        <p class="buh-note">Ви можете створити платіж у розділах Бухгалтерії (<a href="buh.html#expenses">«Документи»</a>, <a href="buh.html#payroll">«Зарплата»</a>, <a href="buh.html#advance">«Авансові звіти»</a>, <a href="buh.html#payments">«Платежі»</a>) або прямо тут — він одразу зʼявиться в черзі на підпис КЕП нижче.</p>
        <div class="pay-grid">
            ${openExps.length ? `
                <label class="field pay-wide"><span class="field-label">Швидке заповнення із затвердженого документа витрат (необовʼязково)</span>
                    <select id="tpExpenseSelect" class="field-input field-select">
                        <option value="">— Вільний платіж (без привʼязки або оберіть документ) —</option>
                        ${openExps.map(e => `<option value="${esc(e.id)}">№ ${esc(e.number || '—')} від ${esc(e.date || '')} · ${esc(e.supplierName || '')} — ${fmtKop((e.amountKop || 0) - (e.paidKop || 0))} грн</option>`).join('')}
                    </select>
                </label>
            ` : ''}
            <label class="field"><span class="field-label">З рахунку ОСББ</span>
                <select id="tpAccount" class="field-input field-select">
                    ${(accs.length ? accs : DEFAULT_SIM_ACCOUNTS).map(a => `<option value="${esc(a.iban)}"${a.iban === curIban ? ' selected' : ''}>${esc(a.iban)} (${fmtKop(a.balanceKop ?? a.defaultBalanceKop ?? 0)} грн)</option>`).join('')}
                </select>
            </label>
            <label class="field"><span class="field-label">Вид платежу</span>
                <select id="tpKind" class="field-input field-select">
                    ${Object.entries(PAYMENT_KIND_LABELS).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join('')}
                </select>
            </label>
            <label class="field"><span class="field-label">Отримувач (назва ТОВ / ФОП / ДПС / ПІБ)</span>
                <input id="tpRecName" class="field-input" maxlength="140" value="${esc(defaultSup.name || 'ТОВ «Одесаліфт-Сервіс»')}"></label>
            <label class="field"><span class="field-label">Код ЄДРПОУ або РНОКПП отримувача</span>
                <input id="tpRecCode" class="field-input" maxlength="10" value="${esc(defaultSup.code || '34512890')}"></label>
            <label class="field"><span class="field-label">IBAN отримувача</span>
                <input id="tpRecIban" class="field-input" maxlength="34" value="${esc(defaultSup.iban || 'UA053052990000026007778889991')}"></label>
            <label class="field"><span class="field-label">Сума платежу, грн</span>
                <input id="tpAmount" class="field-input" inputmode="decimal" value="4200,00"></label>
            <label class="field pay-wide"><span class="field-label">Призначення платежу (payment_destination)</span>
                <input id="tpPurpose" class="field-input" maxlength="160" value="Оплата за технічне обслуговування ліфтів згідно з актом № 10/26, без ПДВ"></label>
        </div>
        <div class="pay-form-actions">
            <button type="button" class="sv-btn" style="width:auto" data-pf-act="create-test-out-pay">Відправити платіж у Приват24 на підпис КЕП</button>
        </div>
    </section>`;
}

async function renderBankView() {
    const host = document.getElementById('viewBank');
    if (!host) return;

    if (!bankSimData) {
        bankSimData = await callPlatform({ action: 'bankSimulatorContext', tenantId: activeTenantId });
    }
    updateBankBadges(bankSimData.pendingPayments?.length || 0);

    if (!bankBuilderDraft) {
        bankBuilderDraft = buildDefaultBuilderDraft();
    }

    const bs = bankSimData.bankSettings || {};
    const accs = bankSimData.accounts || [];
    const curAcc = accs.find(a => a.purpose === 'current') || accs[0] || null;
    const resAcc = accs.find(a => a.purpose === 'reserve') || accs[1] || null;
    const pending = bankSimData.pendingPayments || [];
    const pendingTotalKop = pending.reduce((s, p) => s + Number(p.amountKop || 0), 0);
    const recentTx = bankSimData.recentTx || [];
    const reviewTxCount = recentTx.filter(t => t.status === 'review').length;
    const apts = bankSimData.apartments || [];
    const activeTpl = BANK_SIM_TEMPLATES.find(t => t.id === activeTemplateId) || BANK_SIM_TEMPLATES[0];

    const nowTime = new Intl.DateTimeFormat('uk-UA', {
        timeZone: 'Europe/Kyiv', hour: '2-digit', minute: '2-digit', hour12: false
    }).format(new Date());

    const previewRawTx = buildPrivatRawTransaction({
        ...bankBuilderDraft,
        amountKop: toKop(bankBuilderDraft.amountGrn) || 0,
        myName: bankSimData.org?.name,
        myEdrpou: bankSimData.org?.edrpou
    });

    host.innerHTML = `
        <!-- Статус підключення Приват24 Автоклієнт v3.0.0 та Тестовий ключ -->
        <div class="buh-card pf-bank-banner ${bs.connected ? '' : 'is-disconnected'}" style="margin-bottom: 14px; flex-direction: column; align-items: stretch;">
            <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:14px;flex-wrap:wrap">
                <div style="flex: 1 1 320px;">
                    <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:6px">
                        <span class="pf-p24-pill ${bs.connected ? '' : 'is-warn'}">
                            ${bs.connected ? '● Приват24 Автоклієнт v3.0.0 ПІДКЛЮЧЕНО' : '○ Приват24 Автоклієнт не активовано'}
                        </span>
                        ${bs.simulator
                            ? `<span class="buh-tag is-payment">Тестове середовище Приват24 (Ключ ••••${esc(bs.tokenHint || '_V3')})</span>`
                            : bs.tokenSet
                                ? `<span class="buh-tag is-work">Бойовий сервер acp.privatbank.ua (Ключ ••••${esc(bs.tokenHint || '')})</span>`
                                : ''}
                        <span class="buh-note">Контур: <b>${esc(bankSimData.org?.name || activeTenantId)}</b> (ЄДРПОУ ${esc(bankSimData.org?.edrpou || '—')})</span>
                    </div>
                    <p class="buh-note" style="margin:0">
                        Зовнішня симуляція на рівні HTTP-транспорту (<code>functions/privat.js</code> та <code>functions/privat-payroll-api.js</code>): якщо в «Налаштуваннях» бухгалтерії введено <b>тестовий ключ</b>, усі запити йдуть у ізольоване тестове середовище банку (<code>_privat24_sandbox*</code>). Якщо ввести <b>реальний ключ Автоклієнта</b> — система автоматично перемикається на бойовий сервер <code>https://acp.privatbank.ua</code> без жодних змін у коді бухгалтерії.
                    </p>
                </div>
                <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
                    ${!bs.connected || !bs.simulator ? `
                        <button type="button" class="sv-btn btn-compact" data-pf-act="quick-enable-sim">⚡ Підключити тестовий ключ (saveToken)</button>
                    ` : ''}
                    <button type="button" class="sv-btn is-soft btn-compact" data-pf-act="bank-trigger-sync" title="Викликати штатний bank.sync() так само, як кнопка «Виписка» у бухгалтерії">
                        🔄 Синхронізувати виписку (bank.sync)
                    </button>
                    <button type="button" class="sv-btn is-soft btn-compact" data-pf-act="toggle-bank-setup">
                        ${showBankSetupForm ? 'Сховати рахунки банку' : 'Рахунки та баланси в банку'}
                    </button>
                </div>
            </div>

            <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;padding:10px 14px;background:#F8FAFC;border:1px solid #E2E8F0;border-radius:10px;margin-top:8px">
                <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
                    <span class="buh-note" style="font-weight:700;color:#0F172A">Тестовий ключ Автоклієнта (для введення в <a href="buh.html#settings">«Налаштуваннях»</a>):</span>
                    <code id="pfTestTokenCode" style="background:#EFF6FF;color:#1D4ED8;padding:4px 10px;border-radius:6px;font-weight:700;font-size:13px;border:1px solid #BFDBFE;user-select:all">${esc(bs.testTokenForTenant || bs.sandboxToken || DEFAULT_TEST_TOKEN)}</code>
                    <button type="button" class="btn-ghost-small" data-pf-act="copy-test-token">📋 Скопіювати ключ</button>
                </div>
                <div style="display:flex;align-items:center;gap:14px;flex-wrap:wrap">
                    <label style="display:flex;align-items:center;gap:6px;font-size:12.5px;color:#334155;cursor:pointer" title="Якщо увімкнено, після підписання платежу або генерації вхідної транзакції в банку одразу викликається штатний bank.sync(). Якщо вимкнути — подія залишиться тільки на боці банку до натискання кнопки «Виписка» у бухгалтерії.">
                        <input type="checkbox" id="pfAutoSync" ${autoSyncBank ? 'checked' : ''}>
                        <span>Авто-виклик <code>bank.sync()</code> після події в банку</span>
                    </label>
                    <a href="buh.html#settings" class="btn-ghost-small">У «Налаштування» ↗</a>
                    <a href="buh.html#bank" class="btn-ghost-small">У «Банк» ↗</a>
                    <a href="buh.html#inbox" class="btn-ghost-small">У «Рішення» ↗</a>
                    <a href="buh.html#payments" class="btn-ghost-small">У «Платежі» ↗</a>
                </div>
            </div>
        </div>

        ${showBankSetupForm ? bankSetupFormHtml() : ''}

        <!-- KPI Рахунків та черги -->
        <div class="kpi-grid" style="margin-bottom: 16px;">
            <div class="kpi">
                <span>Поточний рахунок (311)</span>
                <b>${curAcc ? `${fmtKop(curAcc.balanceKop)} грн` : 'Не підключено'}</b>
                <small>${curAcc ? esc(curAcc.iban) : 'активуйте ключ вище'}</small>
            </div>
            <div class="kpi">
                <span>Резервний / Ремонтний фонд (311)</span>
                <b>${resAcc ? `${fmtKop(resAcc.balanceKop)} грн` : '—'}</b>
                <small>${resAcc ? esc(resAcc.iban) : 'другий рахунок ОСББ'}</small>
            </div>
            <div class="kpi">
                <span>Очікують підпису КЕП у Приват24</span>
                <b style="color:${pending.length ? '#2563EB' : '#0F172A'}">${pending.length} пл. (${fmtKop(pendingTotalKop)} грн)</b>
                <small>${pending.length ? 'готові до підписання нижче' : 'усі вихідні платежі проведено'}</small>
            </div>
            <div class="kpi">
                <span>Виписка рахунку (bank_tx)</span>
                <b>${recentTx.length} опер.</b>
                <small>чекають рішення: ${reviewTxCount} · авто-рознесено: ${recentTx.length - reviewTxCount}</small>
            </div>
        </div>

        <!-- БЛОК 1: ЧЕРГА ВИХІДНИХ ПЛАТЕЖІВ НА ПІДПИС КЕП -->
        <div class="buh-card" style="margin-bottom: 16px;">
            <div class="buh-toolbar">
                <div>
                    <h2 style="margin:0;font-size:17.5px">1. Приват24 для бізнесу — Платежі ОСББ, що очікують підпису КЕП (${pending.length})</h2>
                    <p class="buh-note" style="margin:3px 0 0">
                        Сюди автоматично потрапляють усі платежі, відправлені з <a href="buh.html#expenses">«Документів»</a>, <a href="buh.html#payroll">«Зарплати»</a>, <a href="buh.html#advance">«Авансових звітів»</a> та <a href="buh.html#payments">«Платежів»</a>.
                        Натисніть <b>«Підписати КЕП і провести»</b> — система виконає <code>POST /api/proxy/payment/add-sign</code> і <code>GET /api/statements/transactions</code> (<code>TRANTYPE: "D"</code>, <code>DLR</code>), спише кошти з рахунку та закриє платіж і первинний документ.
                    </p>
                </div>
                <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
                    <button type="button" class="sv-btn is-soft btn-compact" data-pf-act="toggle-test-out-pay">+ Створити платіж на підпис</button>
                    ${pending.length > 1 ? `<button type="button" class="sv-btn btn-compact" data-pf-act="bank-sign-all">✍️ Підписати КЕП всі (${pending.length})</button>` : ''}
                </div>
            </div>

            ${showTestOutPayForm ? testOutPaymentFormHtml() : ''}

            <div style="display:flex;gap:14px;flex-wrap:wrap;align-items:center;padding:10px 12px;background:#F8FAFC;border-radius:10px;margin-top:10px">
                <label style="display:flex;align-items:center;gap:6px;font-size:13px">
                    <span class="t-muted">Дата проведення банком (DAT_OD):</span>
                    <input type="date" id="pfSignDate" class="field-input" style="width:auto;height:34px;padding:0 10px" value="${esc(bankSimData.today || '2026-10-20')}">
                </label>
                <label style="display:flex;align-items:center;gap:6px;font-size:13px">
                    <span class="t-muted">Час (TIM_P):</span>
                    <input type="time" id="pfSignTime" class="field-input" style="width:auto;height:34px;padding:0 10px" value="${esc(nowTime)}">
                </label>
                <label style="display:flex;align-items:center;gap:6px;font-size:13px;cursor:pointer">
                    <input type="checkbox" id="pfSignFee">
                    <span>Одночасно списати комісію ПриватБанку за платіж (5,00 грн, Дт 92 Кт 311)</span>
                </label>
            </div>

            ${pending.length ? `
                <div class="pf-pay-queue">
                    ${pending.map(p => `
                        <article class="pf-pay-card" data-id="${esc(p.id)}">
                            <div class="pf-pay-head">
                                <div>
                                    <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:4px">
                                        <span class="buh-tag is-review">Чекає підпису КЕП</span>
                                        <span class="buh-tag">${esc(PAYMENT_KIND_LABELS[p.kind] || p.kind || 'Платіж')}</span>
                                        <small class="t-muted">${esc(p.linkedInfo || '')}</small>
                                    </div>
                                    <h3 style="margin:0;font-size:16px;color:#0F172A">${esc(p.recipient?.name || 'Отримувач')}</h3>
                                </div>
                                <div class="pf-pay-amount">−${fmtKop(p.amountKop)} грн</div>
                            </div>

                            <div class="pf-pay-meta">
                                <div><span>Рахунок платника (ОСББ)</span><b>${esc(p.account || '—')}</b></div>
                                <div><span>IBAN отримувача</span><b>${esc(p.recipient?.iban || '—')}</b></div>
                                <div><span>Код ЄДРПОУ / РНОКПП</span><b>${esc(p.recipient?.code || '—')}</b></div>
                                <div><span>Референс пачки (DLR / bankRef)</span><b>${esc(p.bankRef || `P24PACK-${p.docNumber || ''}`)}</b></div>
                            </div>

                            <div style="font-size:13px;color:#1E293B">
                                <b>Призначення (OSND):</b> ${esc(p.purpose || '')}
                            </div>

                            <div class="pf-pay-actions">
                                <div style="display:flex;gap:8px;flex-wrap:wrap">
                                    <button type="button" class="sv-btn btn-compact" data-pf-act="bank-sign-one" data-id="${esc(p.id)}">✍️ Підписати КЕП і провести в Приват24</button>
                                    <button type="button" class="sv-btn is-soft btn-compact" style="color:#B91C1C" data-pf-act="bank-reject-one" data-id="${esc(p.id)}">✕ Відхилити банком</button>
                                </div>
                                <details>
                                    <summary class="buh-note" style="cursor:pointer;font-weight:600;color:#2563EB">{ } Показати JSON-пакети API Приват24 v3.0.0</summary>
                                    <pre class="pf-api-preview">${esc(JSON.stringify(p.privatApi, null, 2))}</pre>
                                </details>
                            </div>
                        </article>
                    `).join('')}
                </div>
            ` : `
                <div class="list-empty" style="margin-top:12px;padding:18px;background:#F8FAFC;border-radius:12px">
                    <b>Зараз немає вихідних платежів, що очікують підпису КЕП</b>
                    <div class="buh-note" style="margin-top:4px">
                        Створіть платіж у розділі <a href="buh.html#expenses">«Документи»</a> (кнопка «Створити платіж» на затвердженому рахунку/акті), у <a href="buh.html#payments">«Платежах»</a> або натисніть <b>«+ Створити платіж на підпис»</b> вище.
                    </div>
                </div>
            `}
        </div>

        <!-- БЛОК 2: КОНСТРУКТОР ВХІДНИХ (І ВИХІДНИХ) ПЛАТЕЖІВ НА БАНК -->
        <div class="buh-card" style="margin-bottom: 16px;">
            <div class="buh-toolbar">
                <div>
                    <h2 style="margin:0;font-size:17.5px">2. Генератор вхідних (та вихідних) операцій по рахунку Приват24 (Шаблони + Вільні реквізити)</h2>
                    <p class="buh-note" style="margin:3px 0 0">
                        Оберіть готовий шаблон або введіть будь-які власні реквізити. Операція формується рівно за специфікацією <code>GET https://acp.privatbank.ua/api/statements/transactions</code> і проходить через штатний класифікатор <code>bank.js</code>.
                    </p>
                </div>
            </div>

            <h3 style="margin:12px 0 6px;font-size:14.5px;color:#334155">Швидкі шаблони операцій Приват24 (натисніть картку для заповнення форми або «⚡ В 1 клік» для миттєвого проведення):</h3>
            <div class="pf-tpl-grid">
                ${BANK_SIM_TEMPLATES.map(tpl => `
                    <div class="pf-tpl-card${tpl.id === activeTemplateId ? ' is-active' : ''}" data-pf-act="bank-pick-tpl" data-tpl="${esc(tpl.id)}">
                        <div>
                            <div style="display:flex;justify-content:space-between;align-items:center;gap:6px">
                                <span class="sv-chip ${tpl.badgeCls || 'is-soft'}">${esc(tpl.badge)}</span>
                                <small class="t-muted"><b>TRANTYPE: "${esc(tpl.trantype)}"</b> · ${esc(tpl.defaultAmountGrn)} грн</small>
                            </div>
                            <h4>${esc(tpl.title)}</h4>
                            <p>${esc(tpl.subtitle)}</p>
                        </div>
                        <div class="pf-tpl-foot">
                            <span class="buh-note" style="font-size:11.5px">${tpl.id === activeTemplateId ? '✓ Обрано у формі нижче' : 'Натисніть для редагування'}</span>
                            <button type="button" class="sv-btn is-soft btn-compact" style="min-height:30px;padding:0 10px;font-size:12px" data-pf-act="bank-quick-tpl" data-tpl="${esc(tpl.id)}">⚡ В 1 клік</button>
                        </div>
                    </div>
                `).join('')}
            </div>

            <!-- Вибір реальної квартири будинку для шаблонів мешканців -->
            ${apts.length ? `
                <div style="padding:12px 14px;background:#EFF6FF;border:1px solid #BFDBFE;border-radius:12px;margin-bottom:14px">
                    <div class="pay-grid">
                        <label class="field ${activeTpl.id === 'resident_split' ? '' : 'pay-wide'}">
                            <span class="field-label">Швидка підстановка реальної квартири з бази ОСББ (автозаповнення ПІБ власника, особового рахунку та суми боргу)</span>
                            <select id="bsAptSelect" class="field-input field-select">
                                ${apts.map(a => `<option value="${esc(a.apt)}"${String(a.apt) === String(selectedSimApt) ? ' selected' : ''}>кв. ${esc(a.apt)}${a.personalAccount ? ` · о/р ${esc(a.personalAccount)}` : ''}${a.ownerName ? ` · ${esc(a.ownerName)}` : ''} · баланс: ${a.balance >= 0 ? '+' : ''}${a.balance.toFixed(2)} грн</option>`).join('')}
                            </select>
                        </label>
                        ${activeTpl.id === 'resident_split' ? `
                            <label class="field">
                                <span class="field-label">Друга квартира (для спільного платежу за 2 квартири)</span>
                                <select id="bsApt2Select" class="field-input field-select">
                                    ${apts.map(a => `<option value="${esc(a.apt)}"${String(a.apt) === String(selectedSimApt2) ? ' selected' : ''}>кв. ${esc(a.apt)}${a.ownerName ? ` · ${esc(a.ownerName)}` : ''}</option>`).join('')}
                                </select>
                            </label>
                        ` : ''}
                    </div>
                </div>
            ` : ''}

            <!-- Форма вільних реквізитів Приват24 API -->
            <div class="pay-grid" id="bsBuilderForm">
                <label class="field">
                    <span class="field-label">Тип операції (TRANTYPE)</span>
                    <select id="bsTrantype" class="field-input field-select">
                        <option value="C"${bankBuilderDraft.trantype === 'C' ? ' selected' : ''}>C — Вхідне надходження на рахунок ОСББ (Кредит)</option>
                        <option value="D"${bankBuilderDraft.trantype === 'D' ? ' selected' : ''}>D — Вихідне списання з рахунку ОСББ (Дебет)</option>
                    </select>
                </label>
                <label class="field">
                    <span class="field-label">Рахунок ОСББ (AUT_MY_ACC)</span>
                    <select id="bsAccount" class="field-input field-select">
                        ${(accs.length ? accs : DEFAULT_SIM_ACCOUNTS).map(a => `<option value="${esc(a.iban)}"${a.iban === bankBuilderDraft.account ? ' selected' : ''}>${esc(a.iban)} (${esc(a.name || a.purpose)})</option>`).join('')}
                    </select>
                </label>
                <label class="field">
                    <span class="field-label">Сума операції (SUM), грн</span>
                    <input id="bsAmount" class="field-input" inputmode="decimal" placeholder="850,00" value="${esc(bankBuilderDraft.amountGrn || '850,00')}">
                </label>
                <label class="field">
                    <span class="field-label">Дата та час проведення (DAT_OD / TIM_P)</span>
                    <div style="display:flex;gap:6px">
                        <input id="bsDate" type="date" class="field-input" value="${esc(bankBuilderDraft.date || bankSimData.today || '2026-10-20')}">
                        <input id="bsTime" type="time" class="field-input" style="max-width:110px" value="${esc(bankBuilderDraft.time || nowTime)}">
                    </div>
                </label>
                <label class="field">
                    <span class="field-label">Назва / ПІБ контрагента (AUT_CNTR_NAM)</span>
                    <input id="bsCntrName" class="field-input" maxlength="160" placeholder="Коваленко Олена Василівна" value="${esc(bankBuilderDraft.counterpartyName || '')}">
                </label>
                <label class="field">
                    <span class="field-label">ЄДРПОУ або РНОКПП контрагента (AUT_CNTR_CRF)</span>
                    <input id="bsCntrCode" class="field-input" maxlength="10" placeholder="3124567890" value="${esc(bankBuilderDraft.counterpartyCode || '')}">
                </label>
                <label class="field">
                    <span class="field-label">IBAN контрагента (AUT_CNTR_ACC)</span>
                    <input id="bsCntrIban" class="field-input" maxlength="34" placeholder="UA…" value="${esc(bankBuilderDraft.counterpartyIban || '')}">
                </label>
                <label class="field">
                    <span class="field-label">Референс банку (REF) та пачки (DLR)</span>
                    <div style="display:flex;gap:6px">
                        <input id="bsRef" class="field-input" maxlength="40" placeholder="REF" value="${esc(bankBuilderDraft.ref || '')}">
                        <input id="bsDlr" class="field-input" maxlength="40" placeholder="DLR (опц.)" value="${esc(bankBuilderDraft.dlr || '')}">
                    </div>
                </label>
                <label class="field pay-wide">
                    <span class="field-label">Призначення платежу (OSND)</span>
                    <input id="bsPurpose" class="field-input" maxlength="420" placeholder="Внески на утримання будинку, кв. 12, особовий рахунок 0012…" value="${esc(bankBuilderDraft.purpose || '')}">
                </label>
            </div>

            <details style="margin-top:10px">
                <summary class="buh-note" style="cursor:pointer;font-weight:600;color:#2563EB">{ } Живий попередній перегляд JSON-відповіді Приват24 API (GET /api/statements/transactions)</summary>
                <pre id="bsJsonPreview" class="pf-api-preview">${esc(JSON.stringify({ status: 'SUCCESS', exist_next_page: false, transactions: [previewRawTx] }, null, 2))}</pre>
            </details>

            <div class="pay-form-actions" style="margin-top:14px;display:flex;gap:10px;align-items:center;flex-wrap:wrap">
                <button type="button" class="sv-btn" style="width:auto" data-pf-act="bank-sim-submit">
                    🚀 Провести операцію через API Приват24 у виписку ОСББ
                </button>
                <span class="buh-note">Операція одразу зʼявиться у виписці нижче та в Бухгалтерії (<a href="buh.html#bank">«Банк»</a> / <a href="buh.html#inbox">«Рішення»</a>).</span>
            </div>

            ${lastSimulatedTxResult ? renderLastSimResultHtml(lastSimulatedTxResult) : ''}
        </div>

        <!-- БЛОК 3: ЖИВИЙ ЖУРНАЛ БАНКІВСЬКОЇ ВИПИСКИ (bank_tx) -->
        <div class="buh-card">
            <div class="buh-toolbar">
                <div>
                    <h2 style="margin:0;font-size:17.5px">3. Живий журнал банківської виписки ОСББ (bank_tx · ${recentTx.length})</h2>
                    <p class="buh-note" style="margin:3px 0 0">Усі проведені вхідні та вихідні операції. Ви можете протестувати навіть банківське сторно (<code>PR_PR: "t"</code>) будь-якої операції.</p>
                </div>
                <div style="display:flex;gap:8px">
                    <a href="buh.html#bank" class="sv-btn is-soft btn-compact">Відкрити у Бухгалтерії ›</a>
                </div>
            </div>

            <div class="jr-scroll" tabindex="0">
                <table class="buh-table is-compact">
                    <thead>
                        <tr>
                            <th>Дата / REF</th>
                            <th>Контрагент (AUT_CNTR_*)</th>
                            <th>Призначення (OSND)</th>
                            <th>Статус і класифікація</th>
                            <th class="t-sum">Сума, грн</th>
                            <th>Дії симулятора</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${recentTx.length ? recentTx.map(tx => {
                            const isOut = tx.direction === 'out';
                            const aptsList = (tx.allocations || []).map(a => a.apt).filter(Boolean);
                            const badgeText = tx.bankVoided
                                ? 'Сторновано банком (PR_PR=t)'
                                : tx.status === 'review'
                                    ? 'Чекає рішення (review)'
                                    : tx.kind === 'payment' && aptsList.length
                                        ? `Авто: кв. ${aptsList.join(', ')}`
                                        : tx.paymentId
                                            ? `Платіж КЕП (${tx.category || 'expense'})`
                                            : `${tx.kind || ''} ${tx.category ? `· ${tx.category}` : ''}`;
                            const badgeCls = tx.bankVoided
                                ? 'is-bad'
                                : tx.status === 'review'
                                    ? 'is-review'
                                    : isOut
                                        ? 'is-soft'
                                        : 'is-payment';
                            return `<tr>
                                <td class="t-date" style="white-space:nowrap">
                                    <b>${esc(tx.at ? new Date(tx.at).toLocaleString('uk-UA', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—')}</b>
                                    <br><small class="t-muted">${esc(tx.bankId || tx.id)}</small>
                                </td>
                                <td>
                                    <b>${esc(tx.counterparty?.name || '—')}</b>
                                    <br><small class="t-muted">${esc(tx.counterparty?.code || '')}${tx.counterparty?.account ? ` · ${esc(tx.counterparty.account.slice(0, 8))}…${esc(tx.counterparty.account.slice(-4))}` : ''}</small>
                                </td>
                                <td>
                                    <div style="max-width:340px">${esc(tx.purpose || '')}</div>
                                    ${tx.dlr ? `<small class="t-muted">DLR: ${esc(tx.dlr)}</small>` : ''}
                                </td>
                                <td>
                                    <span class="buh-tag ${badgeCls}">${esc(badgeText)}</span>
                                    ${tx.suggestions?.length && tx.status === 'review' ? `<br><small class="t-muted">Підказка: кв. ${esc(tx.suggestions.map(s => s.apt).join(', '))}</small>` : ''}
                                </td>
                                <td class="t-sum ${isOut ? 'is-out' : ''}" style="white-space:nowrap">
                                    <b>${isOut ? '−' : '+'}${fmtKop(tx.amountKop)}</b>
                                </td>
                                <td style="white-space:nowrap">
                                    ${!tx.bankVoided ? `<button type="button" class="btn-ghost-small" style="color:#B91C1C" data-pf-act="bank-void-tx" data-id="${esc(tx.id)}" title="Симулювати сторнування цієї операції банком (PR_PR='t')">Сторно (PR_PR='t')</button>` : '<span class="t-muted">сторновано</span>'}
                                </td>
                            </tr>`;
                        }).join('') : '<tr><td colspan="6" class="list-empty">У виписці ще немає операцій. Запустіть будь-який шаблон вище!</td></tr>'}
                    </tbody>
                </table>
            </div>
        </div>
    `;
}

function renderLastSimResultHtml(res) {
    const tx = res.storedTx || {};
    const isReview = tx.status === 'review';
    const aptsList = (tx.allocations || []).map(a => a.apt).filter(Boolean);
    const outcomeText = isReview
        ? `Операція потрапила в чергу «Рішення» (status: review${tx.reason ? `, причина: ${tx.reason}` : ''})${tx.suggestions?.length ? ` · Підказки квартир: ${tx.suggestions.map(s => s.apt).join(', ')}` : ''}. Перейдіть у «Рішення» або «Банк» у Бухгалтерії, щоб рознести її.`
        : tx.kind === 'payment' && aptsList.length
            ? `Автоматично розпізнано та рознесено на кв. ${aptsList.join(', ')} (метод: ${tx.method || 'auto'}). Запис додано в історію квартири (ledger), баланс квартири перераховано!`
            : `Автоматично проведено як «${tx.kind || 'done'}${tx.category ? ` / ${tx.category}` : ''}».`;

    return `<div class="pf-tx-result ${isReview ? 'is-review' : ''}">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap">
            <div>
                <b>${isReview ? '⏳ Операцію імпортовано у виписку — очікує рішення бухгалтера' : '✓ Операцію імпортовано та автоматично рознесено системою!'}</b>
                <p class="buh-note" style="margin:4px 0 0;color:#0F172A">
                    ID у виписці: <code>bank_tx/${esc(res.txId || '')}</code> · Сума: <b>${tx.direction === 'out' ? '−' : '+'}${fmtKop(tx.amountKop || 0)} грн</b> · ${esc(outcomeText)}
                </p>
            </div>
            <div style="display:flex;gap:8px">
                ${isReview ? `<a href="buh.html#inbox" class="sv-btn is-soft btn-compact">Розібрати у «Рішеннях» ↗</a>` : `<a href="buh.html#bank" class="sv-btn is-soft btn-compact">Переглянути в Бухгалтерії ↗</a>`}
            </div>
        </div>
    </div>`;
}

// ============================================================
// ВКЛАДКА 3: ТЕСТОВИЙ ПОЛІГОН І СИМУЛЯЦІЇ (testing)
// ============================================================
const SANDBOX_STAGES = [
    ['charge', '1. Нарахування внесків', 'Масове нарахування за площу та кількість проживаючих (Дт 377 Кт 48).'],
    ['services', '2. Первинні документи постачальників', 'Внесення акта послуг на 1 000 грн та перевірка лімітів погодження (Дт 92 Кт 631).'],
    ['bank', '3. Імпорт банківської виписки Приват24', 'Автоматичне розпізнавання оплат квартир, оплата рахунків, депозит і відсотки банку.'],
    ['payroll', '4. Зарплата та податки (ПДФО 18%, ВЗ 5%, ЄСВ 22%)', 'Розрахунок відомості (оклад 10 000 грн) і створення платежів у імітованому банку.'],
    ['settle', '5. Звірка вихідних платежів з випискою', 'Автоматичне закриття зарплатних і податкових відомостей проведеними списаннями.'],
    ['close', '6. Закриття місяця та архів ОСВ', 'Перевірка балансу Дт = Кт та блокування періоду від змін заднім числом.']
];

async function renderTestingView() {
    const host = document.getElementById('viewTesting');
    if (!host) return;

    const diag = liveDiagnostics || overviewData?.diagnostics || { allOk: true, checks: [], passedCount: 0, failedCount: 0 };

    if (!sandboxState) {
        try {
            sandboxState = await callBackend('accountingTestAction', { action: 'status' });
        } catch (_) {
            sandboxState = null;
        }
    }

    const doneSteps = sandboxState?.steps?.[sandboxPeriod] || {};

    host.innerHTML = `
        <div class="buh-card" style="margin-bottom:16px">
            <div class="buh-toolbar">
                <div>
                    <h2 style="margin:0;font-size:17px">1. Автоматична перевірка цілісності та податкових інваріантів бази (${esc(activeTenantId)})</h2>
                    <p class="buh-note" style="margin:2px 0 0">Перевіряє тотожність балансів квартир з історією операцій (ledger replay), узгодженість банківських списань із документами та рівність оборотів ОСВ.</p>
                </div>
                <button type="button" class="sv-btn" style="width:auto" data-pf-act="run-diagnostics">Перевірити інваріанти бази</button>
            </div>

            <ul class="pf-check-list">
                ${(diag.checks || []).map(c => `
                    <li class="pf-check-item ${c.ok ? 'is-ok' : 'is-fail'}">
                        <div>
                            <b>${esc(c.label)}</b>
                            <div class="buh-note" style="margin-top:2px">Очікується: <b>${esc(String(c.expected))}</b> · Фактично: <b>${esc(String(c.actual))}</b></div>
                            ${!c.ok && c.details?.length ? `<div class="buh-note is-bad" style="margin-top:4px">Розбіжності: ${esc(JSON.stringify(c.details))}</div>` : ''}
                        </div>
                        <span class="pf-check-badge ${c.ok ? 'is-ok' : 'is-fail'}">${c.ok ? '✓ Норма' : '✕ Помилка'}</span>
                    </li>
                `).join('')}
            </ul>
        </div>

        <div class="buh-card" style="margin-bottom:16px">
            <div class="buh-toolbar">
                <div>
                    <h2 style="margin:0;font-size:17px">2. Ізольований тестовий полігон (Банк, Нарахування, Зарплата, Податкові звіти)</h2>
                    <p class="buh-note" style="margin:2px 0 0">Повністю ізольована база даних (<code>sandbox~{uid}~*</code>) з імітованим драйвером Приват24 Автоклієнт та перевіркою річної звітності неприбуткової організації.</p>
                </div>
                <div style="display:flex;gap:8px;flex-wrap:wrap">
                    <button type="button" class="sv-btn is-soft btn-compact" data-pf-act="sb-prepare">${sandboxState?.ready ? 'Оновити тестовий будинок' : 'Підготувати тестовий будинок'}</button>
                    <button type="button" class="sv-btn btn-compact" data-pf-act="sb-full">Прогнати повний цикл (3 місяці)</button>
                    <a href="accounting-test.html" class="sv-btn is-soft btn-compact">Розгорнути полігон на весь екран ›</a>
                </div>
            </div>

            ${sandboxState ? `
                <div class="kpi-grid" style="margin:12px 0">
                    <div class="kpi"><span>Тестових приміщень</span><b>${sandboxState.premises || 0}</b><small>співвласників: ${sandboxState.owners || 0}</small></div>
                    <div class="kpi"><span>Імітованих операцій банку</span><b>${sandboxState.bankTx || 0}</b><small>вхідні та вихідні</small></div>
                    <div class="kpi"><span>Платежів у Приват24 (Mock)</span><b>${sandboxState.payments || 0}</b><small>зарплата, податки, постачальники</small></div>
                    <div class="kpi"><span>Тестовий період</span>
                        <select id="pfSbPeriod" class="field-input field-select" style="margin-top:4px;height:34px;padding:0 10px">
                            ${(sandboxState.periods || ['2025-10', '2025-11', '2025-12']).map(p => `<option value="${esc(p)}"${p === sandboxPeriod ? ' selected' : ''}>${esc(periodName(p))}</option>`).join('')}
                        </select>
                    </div>
                </div>

                <div class="pf-check-list">
                    ${SANDBOX_STAGES.map(([stepKey, label, desc]) => `
                        <div class="pf-check-item ${doneSteps[stepKey] ? 'is-ok' : ''}">
                            <div>
                                <b>${esc(label)}</b>
                                <div class="buh-note">${esc(desc)}</div>
                            </div>
                            <button type="button" class="sv-btn ${doneSteps[stepKey] ? 'is-soft' : ''} btn-compact" data-pf-act="sb-step" data-step="${esc(stepKey)}" ${!sandboxState.ready || doneSteps[stepKey] ? 'disabled' : ''}>
                                ${doneSteps[stepKey] ? '✓ Виконано' : 'Запустити крок'}
                            </button>
                        </div>
                    `).join('')}
                </div>

                <div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:14px">
                    <button type="button" class="sv-btn is-soft btn-compact" data-pf-act="sb-verify" ${!sandboxState.ready ? 'disabled' : ''}>Звірити баланс, податки та ОСВ</button>
                    <button type="button" class="sv-btn is-soft btn-compact" data-pf-act="sb-forms" ${!(sandboxState.periods || []).every(p => sandboxState.steps?.[p]?.close) ? 'disabled' : ''}>Перевірити річні податкові форми (Неприбутковість + Фінзвітність 1-м/2-м)</button>
                    <button type="button" class="btn-ghost-small" style="color:#B91C1C" data-pf-act="sb-reset">Очистити тестовий полігон</button>
                </div>
            ` : `<p class="buh-note">Натисніть «Підготувати тестовий будинок» або відкрийте <a href="accounting-test.html">Тестовий полігон</a> для запуску імітації банку та звітності.</p>`}

            ${sandboxVerifyResult ? `
                <div class="pf-diff-box" style="margin-top:14px;background:#F8FAFC;border-color:#CBD5E1">
                    <b>Результати контрольної звірки тестового полігону (${esc(periodName(sandboxPeriod))}):</b>
                    <ul class="pf-check-list" style="margin-top:8px">
                        ${(sandboxVerifyResult.checks || []).map(c => `
                            <li class="pf-check-item ${c.ok ? 'is-ok' : 'is-fail'}">
                                <span>${esc(c.label)}</span>
                                <span class="pf-check-badge ${c.ok ? 'is-ok' : 'is-fail'}">${c.ok ? '✓ ОК' : `✕ ${esc(String(c.actual))} vs ${esc(String(c.expected))}`}</span>
                            </li>
                        `).join('')}
                    </ul>
                </div>
            ` : ''}
        </div>

        <div class="buh-card">
            <h2 style="margin:0 0 8px;font-size:17px">3. Каталог еталонних сценаріїв тестування платформи</h2>
            <div class="pf-arch-grid">
                ${Object.values(SIMULATION_SCENARIOS).map(sc => `
                    <div class="pf-arch-card">
                        <span class="pf-tier-badge">Автотест / Симуляція</span>
                        <h3>${esc(sc.title)}</h3>
                        <p>${esc(sc.description)}</p>
                        <p class="buh-note" style="margin-top:8px">Етапів: <b>${sc.steps.length}</b> (${sc.steps.join(' → ')})</p>
                    </div>
                `).join('')}
            </div>
        </div>
    `;
}

// ============================================================
// ВКЛАДКА 4: КОРИСТУВАЧІ ТА АКТИВНІСТЬ (users)
// ============================================================
function renderUsersView() {
    const host = document.getElementById('viewUsers');
    if (!host || !overviewData) return;

    const u = overviewData.userStats || {
        totalApartments: 0,
        activatedApartments: 0,
        activationRatePct: 0,
        debtorsCount: 0,
        overpaidCount: 0,
        zeroBalanceCount: 0,
        staffByRole: { chair: 0, accountant: 0, board: 0 },
        events24h: 0,
        events7d: 0,
        topActors: [],
        actionBreakdown: {}
    };

    const q = auditQuery.trim().toLowerCase();
    const logs = (overviewData.recentAudit || []).filter(item => {
        if (!q) return true;
        return [item.actor, item.role, item.action, item.target, item.summary]
            .filter(Boolean).join(' ').toLowerCase().includes(q);
    });

    host.innerHTML = `
        <div class="kpi-grid" style="margin-bottom: 14px;">
            <div class="kpi">
                <span>Активовані кабінети мешканців</span>
                <b>${u.activatedApartments} / ${u.totalApartments}</b>
                <small>рівень активації: ${u.activationRatePct}% приміщень</small>
            </div>
            <div class="kpi">
                <span>Стан розрахунків квартир</span>
                <b>${u.debtorsCount} боржн.</b>
                <small>переплата: ${u.overpaidCount} · нульовий баланс: ${u.zeroBalanceCount}</small>
            </div>
            <div class="kpi">
                <span>Команда управління (Staff)</span>
                <b>${(u.staffByRole.chair || 0) + (u.staffByRole.accountant || 0) + (u.staffByRole.board || 0)}</b>
                <small>голова: ${u.staffByRole.chair || 0} · бухг.: ${u.staffByRole.accountant || 0} · правління: ${u.staffByRole.board || 0}</small>
            </div>
            <div class="kpi">
                <span>Активність у журналі аудиту</span>
                <b>${u.events24h} за 24 год</b>
                <small>за 7 днів: ${u.events7d} операцій</small>
            </div>
        </div>

        <div class="pf-arch-grid" style="margin-bottom:16px">
            <div class="buh-card" style="margin:0">
                <h3 style="margin:0 0 10px;font-size:15.5px">Найактивніші користувачі (за журналом дій)</h3>
                ${u.topActors?.length ? `
                    <table class="buh-table is-compact">
                        <thead><tr><th>Користувач / вхід</th><th class="t-sum">Кількість дій</th></tr></thead>
                        <tbody>
                            ${u.topActors.map(a => `<tr><td><b>${esc(a.actor)}</b></td><td class="t-sum">${a.count}</td></tr>`).join('')}
                        </tbody>
                    </table>
                ` : '<p class="buh-note">Записів активності ще немає</p>'}
            </div>

            <div class="buh-card" style="margin:0">
                <h3 style="margin:0 0 10px;font-size:15.5px">Розподіл операцій за модулями системи</h3>
                ${Object.keys(u.actionBreakdown || {}).length ? `
                    <table class="buh-table is-compact">
                        <thead><tr><th>Модуль (префікс дії)</th><th class="t-sum">Операцій</th></tr></thead>
                        <tbody>
                            ${Object.entries(u.actionBreakdown).sort((a, b) => b[1] - a[1]).map(([mod, cnt]) =>
                                `<tr><td><code>${esc(mod)}.*</code></td><td class="t-sum"><b>${cnt}</b></td></tr>`
                            ).join('')}
                        </tbody>
                    </table>
                ` : '<p class="buh-note">Немає даних про операції</p>'}
            </div>
        </div>

        <div class="buh-card">
            <div class="buh-toolbar">
                <div>
                    <h2 style="margin:0;font-size:17px">Незмінний журнал аудиту системи (Immutable Audit Trail)</h2>
                    <p class="buh-note" style="margin:2px 0 0">Усі дії бухгалтера, голови правління, автоматики банку та ручні корекції супер-адміна фіксуються у <code>audit_log</code>.</p>
                </div>
                <input type="search" id="pfAuditSearch" class="field-input buh-search" placeholder="Пошук за дією, автором, обʼєктом…" value="${esc(auditQuery)}">
            </div>

            <div class="jr-scroll" tabindex="0">
                <table class="buh-table is-compact">
                    <thead>
                        <tr>
                            <th>Час</th>
                            <th>Автор і роль</th>
                            <th>Дія</th>
                            <th>Цільовий обʼєкт</th>
                            <th>Зміст операції</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${logs.length ? logs.map(l => `
                            <tr>
                                <td class="t-date" style="white-space:nowrap">${esc(l.at ? new Date(l.at).toLocaleString('uk-UA') : '—')}</td>
                                <td><b>${esc(l.actor || 'system')}</b><br><small class="t-muted">${esc(ROLE_LABELS[l.role] || l.role || '')}</small></td>
                                <td><code>${esc(l.action || '')}</code></td>
                                <td><small>${esc(l.target || '')}</small></td>
                                <td>
                                    <div>${esc(l.summary || '')}</div>
                                    ${l.details && Object.keys(l.details).length ? `<details style="margin-top:4px"><summary class="buh-note" style="cursor:pointer">Деталі JSON</summary><pre style="font-size:11.5px;background:#F8FAFC;padding:6px;border-radius:6px;overflow-x:auto">${esc(JSON.stringify(l.details, null, 2))}</pre></details>` : ''}
                                </td>
                            </tr>
                        `).join('') : '<tr><td colspan="5" class="list-empty">Записів за цим фільтром не знайдено</td></tr>'}
                    </tbody>
                </table>
            </div>
        </div>
    `;
}

// ============================================================
// ВКЛАДКА 5: ІНСПЕКТОР БД І РУЧНЕ КОРИГУВАННЯ (inspector)
// ============================================================
function docSummaryLine(col, d) {
    const data = d.data || {};
    if (col === 'apartments') {
        if (inspectorSubcol === 'ledger') return `${data.kind || ''} · ${data.period || ''} · ${data.amount ?? (data.amountKop ? data.amountKop / 100 : 0)} грн`;
        if (inspectorSubcol === 'owners') return `${data.name || ''} · частка ${data.shareFrac || '1/1'}`;
        return `Площа: ${data.area ?? '—'} м² · Баланс: ${data.balance ?? 0} грн · о/р: ${data.personalAccount || '—'}`;
    }
    if (col === 'bank_tx') return `${data.direction === 'out' ? '−' : '+'}${fmtKop(data.amountKop || 0)} грн · ${data.counterparty?.name || data.purpose || ''}`;
    if (col === 'expenses') return `${data.supplierName || ''} · № ${data.number || ''} · ${fmtKop(data.amountKop || 0)} грн (${data.status || ''})`;
    if (col === 'payments') return `${data.recipient?.name || ''} · ${fmtKop(data.amountKop || 0)} грн (${data.status || ''})`;
    if (col === 'claims') return `Статус: ${data.status || ''} · Справа: ${data.caseNumber || '—'}`;
    return JSON.stringify(data).slice(0, 90);
}

async function loadInspectorDocs() {
    const res = await callPlatform({
        action: 'inspectCollection',
        tenantId: activeTenantId,
        collection: inspectorCol,
        subcollection: inspectorCol === 'apartments' ? inspectorSubcol : '',
        aptId: inspectorCol === 'apartments' ? inspectorAptId : '',
        query: inspectorQuery,
        limit: 120
    });
    inspectorDocs = res.docs || [];
    if (selectedDoc) {
        selectedDoc = inspectorDocs.find(d => d.id === selectedDoc.id) || inspectorDocs[0] || null;
    } else {
        selectedDoc = inspectorDocs[0] || null;
    }
    patchPreviewDiffs = null;
}

async function renderInspectorView() {
    const host = document.getElementById('viewInspector');
    if (!host) return;
    if (!inspectorDocs.length && !inspectorQuery) {
        await loadInspectorDocs().catch(e => toast(e.message, 'error'));
    }

    const editableJson = selectedDoc ? JSON.stringify(selectedDoc.data, null, 2) : '{}';

    host.innerHTML = `
        <div class="buh-card is-note" style="border-left: 4px solid #D97706; margin-bottom: 14px;">
            <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap">
                <div>
                    <b>Контрольоване ручне коригування бази даних (Break-Glass Audited Manual Adjustment)</b>
                    <p class="buh-note" style="margin:4px 0 0">У світовій фінансовій практиці прямі виправлення бази даних ніколи не робляться «всліпу»: система спершу показує таблицю змін (<code>Було → Стане</code>), вимагає обовʼязкову підставу для незмінного журналу аудиту (<code>audit_log</code>) і автоматично перераховує похідні баланси.</p>
                </div>
                <button type="button" class="sv-btn is-soft btn-compact" data-pf-act="toggle-ledger-adj">
                    ${showLedgerAdjustForm ? 'Сховати форму запису в ledger' : '+ Коригувальний запис в історію квартири (ledger)'}
                </button>
            </div>
        </div>

        ${showLedgerAdjustForm ? `
            <section class="buh-card ex-form" style="margin-bottom:14px">
                <div class="buh-card-head">
                    <h2>Новий коригувальний запис в історію квартири (apartments/{apt}/ledger)</h2>
                    <button type="button" class="btn-ghost-small" data-pf-act="toggle-ledger-adj">Закрити</button>
                </div>
                <div class="pay-grid">
                    <label class="field"><span class="field-label">Номер квартири</span>
                        <input id="laApt" class="field-input" placeholder="Напр.: 25" value="${esc(inspectorAptId || (inspectorCol === 'apartments' && selectedDoc ? selectedDoc.id : ''))}"></label>
                    <label class="field"><span class="field-label">Вид операції</span>
                        <select id="laKind" class="field-input field-select">
                            <option value="payment">Оплата (збільшує баланс / зменшує борг)</option>
                            <option value="charge">Донарахування (зменшує баланс / збільшує борг)</option>
                            <option value="refund">Повернення коштів</option>
                            <option value="opening">Коригування вхідного сальдо</option>
                        </select></label>
                    <label class="field"><span class="field-label">Період (РРРР-ММ)</span>
                        <input id="laPeriod" class="field-input" type="month" value="2026-10"></label>
                    <label class="field"><span class="field-label">Сума, грн</span>
                        <input id="laAmount" class="field-input" inputmode="decimal" placeholder="150,00"></label>
                    <label class="field pay-wide"><span class="field-label">Обовʼязкова підстава коригування (записується в audit_log та примітку)</span>
                        <input id="laReason" class="field-input" maxlength="240" placeholder="Бухгалтерська довідка № 4: уточнення оплати за квитанцією від 12.10.2026"></label>
                </div>
                <div class="pay-form-actions">
                    <button type="button" class="sv-btn" style="width:auto" data-pf-act="save-ledger-adj">Внести запис і перерахувати баланс квартири</button>
                </div>
            </section>
        ` : ''}

        <div class="buh-card" style="margin-bottom:14px">
            <div class="pay-grid">
                <label class="field">
                    <span class="field-label">Колекція бази даних (${esc(activeTenantId)})</span>
                    <select id="pfColSelect" class="field-input field-select">
                        ${Object.entries(INSPECTABLE_COLLECTIONS).map(([k, v]) => `<option value="${esc(k)}"${k === inspectorCol ? ' selected' : ''}>${esc(v.title)} (${esc(k)})</option>`).join('')}
                    </select>
                </label>
                ${inspectorCol === 'apartments' ? `
                    <label class="field">
                        <span class="field-label">Підколекція квартири (необовʼязково)</span>
                        <select id="pfSubcolSelect" class="field-input field-select">
                            <option value=""${!inspectorSubcol ? ' selected' : ''}>Кореневі документи квартир (apartments)</option>
                            <option value="ledger"${inspectorSubcol === 'ledger' ? ' selected' : ''}>Історія нарахувань та оплат (apartments/{apt}/ledger)</option>
                            <option value="owners"${inspectorSubcol === 'owners' ? ' selected' : ''}>Співвласники (apartments/{apt}/owners)</option>
                        </select>
                    </label>
                    ${inspectorSubcol ? `
                        <label class="field">
                            <span class="field-label">Номер квартири для підколекції</span>
                            <input id="pfSubcolApt" class="field-input" placeholder="Напр.: 1" value="${esc(inspectorAptId || '1')}">
                        </label>
                    ` : ''}
                ` : ''}
                <label class="field">
                    <span class="field-label">Пошук за ID або вмістом JSON</span>
                    <div style="display:flex;gap:8px">
                        <input id="pfInspectQuery" class="field-input" type="search" placeholder="ID або текст…" value="${esc(inspectorQuery)}">
                        <button type="button" class="sv-btn is-soft btn-compact" data-pf-act="reload-inspector">Знайти</button>
                    </div>
                </label>
            </div>
        </div>

        <div class="pf-inspector-layout">
            <section class="buh-card" style="margin:0">
                <div style="display:flex;justify-content:space-between;align-items:center">
                    <b>Документи (${inspectorDocs.length})</b>
                    <small class="t-muted">${esc(inspectorCol)}${inspectorSubcol ? `/${inspectorAptId}/${inspectorSubcol}` : ''}</small>
                </div>
                ${inspectorDocs.length ? `
                    <ul class="pf-doc-list">
                        ${inspectorDocs.map(d => `
                            <li>
                                <button type="button" class="pf-doc-btn${selectedDoc?.id === d.id ? ' is-selected' : ''}" data-pf-act="pick-doc" data-id="${esc(d.id)}">
                                    <b>${esc(d.id)}</b>
                                    <small>${esc(docSummaryLine(inspectorCol, d))}</small>
                                </button>
                            </li>
                        `).join('')}
                    </ul>
                ` : '<p class="list-empty">Документів не знайдено</p>'}
            </section>

            <section class="buh-card" style="margin:0">
                ${selectedDoc ? `
                    <div class="buh-card-head">
                        <div>
                            <span class="buh-tag">Шлях: ${esc(selectedDoc.path)}</span>
                            <h2 style="margin:6px 0 0">Документ ID: ${esc(selectedDoc.id)}</h2>
                        </div>
                        ${inspectorCol === 'apartments' && !inspectorSubcol ? `
                            <div style="display:flex;gap:6px">
                                <button type="button" class="btn-ghost-small" data-pf-act="open-apt-sub" data-sub="ledger" data-apt="${esc(selectedDoc.id)}">Історія ledger ›</button>
                                <button type="button" class="btn-ghost-small" data-pf-act="open-apt-sub" data-sub="owners" data-apt="${esc(selectedDoc.id)}">Співвласники ›</button>
                            </div>
                        ` : ''}
                    </div>

                    <p class="buh-note" style="margin:8px 0">Відредагуйте потрібні поля у JSON-форматі нижче та натисніть <b>«Перевірити зміни (Diff Preview)»</b> перед збереженням.</p>
                    <textarea id="pfJsonEditor" class="pf-json-editor" spellcheck="false">${esc(editableJson)}</textarea>

                    <div class="pay-grid" style="margin-top:12px">
                        <label class="field pay-wide">
                            <span class="field-label">Обовʼязкова підстава коригування (записується в audit_log разом зі старими й новими значеннями)</span>
                            <input id="pfPatchReason" class="field-input" maxlength="260" placeholder="Напр.: Виправлення площі за техпаспортом / уточнення особового рахунку">
                        </label>
                        ${inspectorCol === 'apartments' ? `
                            <label class="am-check pay-wide">
                                <input type="checkbox" id="pfRecomputeApt" checked>
                                <span>Після збереження автоматично перерахувати баланс квартири з історії (charges.recompute)</span>
                            </label>
                        ` : ''}
                    </div>

                    ${patchPreviewDiffs ? `
                        <div class="pf-diff-box">
                            <b>Попередній перегляд змін (${patchPreviewDiffs.length} полів):</b>
                            ${patchPreviewDiffs.length ? `
                                <table class="pf-diff-table">
                                    <thead><tr><th>Поле</th><th>Було (Before)</th><th>Стане (After)</th></tr></thead>
                                    <tbody>
                                        ${patchPreviewDiffs.map(df => `
                                            <tr>
                                                <td><b>${esc(df.field)}</b></td>
                                                <td class="pf-diff-before">${esc(JSON.stringify(df.before))}</td>
                                                <td class="pf-diff-after">${esc(JSON.stringify(df.after))}</td>
                                            </tr>
                                        `).join('')}
                                    </tbody>
                                </table>
                            ` : '<p class="buh-note" style="margin:6px 0 0">Жодне поле не змінилося порівняно з поточним станом документа.</p>'}
                        </div>
                    ` : ''}

                    <div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:14px">
                        <button type="button" class="sv-btn is-soft" style="width:auto" data-pf-act="preview-patch">1. Перевірити зміни (Diff Preview)</button>
                        <button type="button" class="sv-btn" style="width:auto" data-pf-act="commit-patch">2. Застосувати зміни з записом в аудит</button>
                    </div>
                ` : '<p class="list-empty">Оберіть документ ліворуч для перегляду та коригування</p>'}
            </section>
        </div>
    `;
}

// ============================================================
// ВКЛАДКА 6: АРХІТЕКТУРА MULTI-TENANT (architecture)
// ============================================================
function renderArchitectureView() {
    const host = document.getElementById('viewArchitecture');
    if (!host) return;

    host.innerHTML = `
        <div class="buh-card" style="margin-bottom:16px">
            <h2 style="margin:0 0 8px;font-size:18px">Світові практики побудови Multi-Tenant SaaS та фінансових платформ для багатьох ОСББ</h2>
            <p class="buh-note">Архітектура платформи побудована за принципами <b>Stripe, Linear, Buildium та AppFolio</b> (провідних світових Property Management & Fintech систем), щоб масштабуватися від одного будинку до сотень ОСББ без переписування бізнес-логіки.</p>

            <div class="pf-arch-grid">
                <div class="pf-arch-card">
                    <span class="pf-tier-badge">1. Control Plane vs. Data Plane</span>
                    <h3>Розділення площини управління і даних</h3>
                    <p>Всі бухгалтерські модулі (<code>charges.js</code>, <code>bank.js</code>, <code>expenses.js</code>, <code>payroll.js</code>, <code>journal.js</code>, <code>claims.js</code>) приймають екземпляр <code>db</code> через <b>Dependency Injection</b>. Глобальна адмін-панель (Control Plane) керує реєстром <code>platform_tenants</code> і динамічно підставляє потрібний контур БД (Data Plane).</p>
                </div>

                <div class="pf-arch-card">
                    <span class="pf-tier-badge">2. 3-Tier Database Isolation</span>
                    <h3>Гнучка ізоляція баз для різних ОСББ</h3>
                    <p>Підтримуються 3 рівні ізоляції: <b>Tier 1 (Namespace Prefix)</b> — миттєвий запуск нових ОСББ і пісочниць у поточному проекті; <b>Tier 2 (Firestore Named Databases)</b> — фізично окремі бази всередині одного GCP-проекту; <b>Tier 3 (Dedicated Project)</b> — окремий проект для великих керуючих компаній.</p>
                </div>

                <div class="pf-arch-card">
                    <span class="pf-tier-badge">3. Event-Sourced Double-Entry Ledger</span>
                    <h3>Подійний облік у копійках (Zero-Float)</h3>
                    <p>Жодна сума не зберігається у рухомій комі для розрахунків: усі гроші в цілих копійках (<code>amountKop</code>), тарифи у <code>rate4</code>, площа у <code>areaCenti</code>. Баланс квартири завжди відтворюється з історії <code>ledger</code> (<code>core.replay</code>), що виключає розходження цифр.</p>
                </div>

                <div class="pf-arch-card">
                    <span class="pf-tier-badge">4. Privat24 Autoclient v3.0.0 Twin</span>
                    <h3>Цифровий двійник Приват24 API</h3>
                    <p>Модуль «Банк Приват24» відтворює 100% специфікації <code>acp.privatbank.ua</code>: чергу платежів на підпис КЕП (<code>/api/proxy/payment/*</code>), пакетні референси <code>DLR</code>, дебетові та кредитові транзакції (<code>TRANTYPE: C/D</code>, <code>FL_REAL: r</code>, <code>PR_PR: r/t</code>) і автоматичне закриття рахунків та відомостей.</p>
                </div>

                <div class="pf-arch-card">
                    <span class="pf-tier-badge">5. Break-Glass Audited Adjustments</span>
                    <h3>Безпечне ручне втручання з Diff-аудитом</h3>
                    <p>Заборонено змінювати закриті періоди або редагувати БД без сліду. Будь-яка ручна корекція супер-адміна проходить через <b>Dry-Run Diff</b>, вимагає юридичну/бухгалтерську підставу і назавжди записує старі та нові значення полів у <code>audit_log</code>.</p>
                </div>

                <div class="pf-arch-card">
                    <span class="pf-tier-badge">6. Continuous Invariant Verification</span>
                    <h3>Автоматичний контроль тотожностей</h3>
                    <p>Система безперервно перевіряє ключові інваріанти: <code>∑ Балансів квартир == ∑ Записів ledger</code>, <code>Оплачені документи == Банківські списання</code>, <code>Дебет ОСВ == Кредит ОСВ</code>. Будь-яка аномалія миттєво підсвічується на дашборді платформи.</p>
                </div>
            </div>
        </div>

        <div class="buh-card">
            <h2 style="margin:0 0 10px;font-size:17px">Дорожня карта поетапного масштабування (Phased Rollout Roadmap)</h2>
            <table class="buh-table is-compact">
                <thead>
                    <tr>
                        <th>Етап</th>
                        <th>Фокус розширення</th>
                        <th>Статус реалізації</th>
                    </tr>
                </thead>
                <tbody>
                    <tr>
                        <td><b>Етап 1 (Поточний фундамент)</b></td>
                        <td>Super-Admin Control Plane (<code>platform.html</code>), реєстр ОСББ (<code>platform_tenants</code>), симулятор Приват24 Автоклієнт v3.0.0 з КЕП-підписом платежів, інспектор колекцій з Diff-превʼю та обовʼязковим аудитом.</td>
                        <td><span class="sv-chip is-done">✓ Запроваджено</span></td>
                    </tr>
                    <tr>
                        <td><b>Етап 2 (Мульти-вхід та роутинг)</b></td>
                        <td>Привʼязка Custom Claims у Firebase Auth (<code>{ tenantId, role, apt }</code>), щоб мешканець або бухгалтер при вході автоматично потрапляв у контур свого ОСББ (або мав перемикач між кількома ОСББ, якщо бухгалтер веде 5–10 будинків одночасно).</td>
                        <td><span class="sv-chip is-work">Готова архітектура БД</span></td>
                    </tr>
                    <tr>
                        <td><b>Етап 3 (Шаблони та масові оновлення)</b></td>
                        <td>Централізоване оновлення податкових ставок (ПДФО, ВЗ, ЄСВ, МЗП, прожитковий мінімум для судового збору) та форм звітності ДПС одразу для всіх підключених ОСББ з єдиного центру.</td>
                        <td><span class="sv-chip is-work">Наступний крок</span></td>
                    </tr>
                </tbody>
            </table>
        </div>
    `;
}

// ============================================================
// ОБРОБНИКИ ПОДІЙ
// ============================================================
function initEvents() {
    document.addEventListener('click', async e => {
        const navBtn = e.target.closest('.buh-nav-item[data-view], .buh-tab[data-view]');
        if (navBtn) {
            await switchView(navBtn.dataset.view);
            return;
        }

        const actBtn = e.target.closest('[data-pf-act]');
        if (!actBtn || actBtn.disabled) return;
        const act = actBtn.dataset.pfAct;

        try {
            if (act === 'open-new-tenant') {
                editingTenant = null;
                showNewTenantForm = true;
                renderTenantsView();
                document.getElementById('tfName')?.focus();
            } else if (act === 'close-tenant-form') {
                showNewTenantForm = false;
                editingTenant = null;
                renderTenantsView();
            } else if (act === 'edit-tenant') {
                const t = (overviewData?.tenants || []).find(x => x.id === actBtn.dataset.id);
                if (t) {
                    editingTenant = t;
                    showNewTenantForm = true;
                    renderTenantsView();
                }
            } else if (act === 'save-tenant') {
                setBusy(actBtn, true, 'Зберігаю…');
                const payload = {
                    action: 'saveTenant',
                    isEdit: actBtn.dataset.edit === '1',
                    name: document.getElementById('tfName')?.value || '',
                    edrpou: document.getElementById('tfEdrpou')?.value || '',
                    slug: document.getElementById('tfSlug')?.value || '',
                    city: document.getElementById('tfCity')?.value || '',
                    address: document.getElementById('tfAddress')?.value || '',
                    iban: document.getElementById('tfIban')?.value || '',
                    apartmentsCount: Number(document.getElementById('tfApts')?.value || 0),
                    status: document.getElementById('tfStatus')?.value || 'onboarding',
                    isolationMode: document.getElementById('tfIsolation')?.value || 'namespace_prefix',
                    notes: document.getElementById('tfNotes')?.value || '',
                    initializeSchema: document.getElementById('tfInitSchema')?.checked === true
                };
                await callPlatform(payload);
                showNewTenantForm = false;
                editingTenant = null;
                toast('Контур ОСББ успішно збережено в реєстрі платформи', 'success');
                await refreshAllData();
            } else if (act === 'select-tenant') {
                activeTenantId = actBtn.dataset.id;
                inspectorDocs = [];
                selectedDoc = null;
                liveDiagnostics = null;
                bankSimData = null;
                bankBuilderDraft = null;
                toast(`Активний контур перемкнено на: ${activeTenantId}`, 'info');
                await refreshAllData();
            } else if (act === 'open-bank-tab') {
                await switchView('bank');
            } else if (act === 'open-tenant-bank') {
                activeTenantId = actBtn.dataset.id;
                bankSimData = null;
                bankBuilderDraft = null;
                overviewData = await callPlatform({ action: 'overview', tenantId: activeTenantId });
                updateTenantSwitcher();
                await switchView('bank');
            } else if (act === 'inspect-tenant') {
                activeTenantId = actBtn.dataset.id;
                inspectorDocs = [];
                selectedDoc = null;
                overviewData = await callPlatform({ action: 'overview', tenantId: activeTenantId });
                updateTenantSwitcher();
                await switchView('inspector');
            }
            // ---- ПОДІЇ СИМУЛЯТОРА БАНКУ ПРИВАТ24 ----
            else if (act === 'copy-test-token') {
                const tokenStr = bankSimData?.bankSettings?.testTokenForTenant || bankSimData?.bankSettings?.sandboxToken || DEFAULT_TEST_TOKEN;
                if (navigator.clipboard?.writeText) {
                    await navigator.clipboard.writeText(tokenStr);
                }
                toast(`Тестовий ключ скопійовано: ${tokenStr}`, 'success');
            } else if (act === 'bank-trigger-sync') {
                setBusy(actBtn, true, 'Синхронізую виписку…');
                const res = await callPlatform({ action: 'bankTriggerSync', tenantId: activeTenantId });
                bankSimData = await callPlatform({ action: 'bankSimulatorContext', tenantId: activeTenantId });
                const s = res.syncResult || {};
                toast(`Штатний bank.sync() виконано! Імпортовано: ${s.imported ?? 0}, авто-рознесено: ${s.autoAssigned ?? 0}, на перевірку: ${s.review ?? 0}`, 'success');
                await refreshAllData();
            } else if (act === 'toggle-bank-setup') {
                showBankSetupForm = !showBankSetupForm;
                await renderBankView();
            } else if (act === 'quick-enable-sim') {
                setBusy(actBtn, true, 'Активую ключ Приват24…');
                await callPlatform({ action: 'bankSetupSimulator', tenantId: activeTenantId });
                bankSimData = await callPlatform({ action: 'bankSimulatorContext', tenantId: activeTenantId });
                bankBuilderDraft = buildDefaultBuilderDraft();
                toast('Віртуальний ключ Приват24 Автоклієнт v3.0.0 та рахунки ОСББ активовано!', 'success');
                await refreshAllData();
            } else if (act === 'save-bank-setup') {
                setBusy(actBtn, true, 'Зберігаю рахунки…');
                const currentIban = document.getElementById('bsSetupCurIban')?.value?.trim() || '';
                const currentBalanceKop = toKop(document.getElementById('bsSetupCurBal')?.value || '0') ?? 28540000;
                const reserveIban = document.getElementById('bsSetupResIban')?.value?.trim() || '';
                const reserveBalanceKop = toKop(document.getElementById('bsSetupResBal')?.value || '0') ?? 15000000;
                await callPlatform({
                    action: 'bankSetupSimulator',
                    tenantId: activeTenantId,
                    currentIban,
                    currentBalanceKop,
                    reserveIban,
                    reserveBalanceKop
                });
                showBankSetupForm = false;
                bankSimData = await callPlatform({ action: 'bankSimulatorContext', tenantId: activeTenantId });
                bankBuilderDraft = buildDefaultBuilderDraft();
                toast('Рахунки та віртуальний ключ Приват24 успішно збережено', 'success');
                await refreshAllData();
            } else if (act === 'disable-bank-sim') {
                setBusy(actBtn, true, 'Вимикаю…');
                await callPlatform({ action: 'bankDisableSimulator', tenantId: activeTenantId });
                showBankSetupForm = false;
                bankSimData = await callPlatform({ action: 'bankSimulatorContext', tenantId: activeTenantId });
                toast('Режим симулятора Приват24 вимкнено', 'info');
                await refreshAllData();
            } else if (act === 'toggle-test-out-pay') {
                showTestOutPayForm = !showTestOutPayForm;
                await renderBankView();
            } else if (act === 'create-test-out-pay') {
                const amountKop = toKop(document.getElementById('tpAmount')?.value || '');
                if (!amountKop || amountKop <= 0) {
                    toast('Вкажіть суму платежу більшу за 0,00 грн', 'error');
                    return;
                }
                setBusy(actBtn, true, 'Відправляю на підпис…');
                // Переконуємося, що віртуальний банк підключено
                if (!bankSimData?.bankSettings?.connected) {
                    await callPlatform({ action: 'bankSetupSimulator', tenantId: activeTenantId });
                }
                const expId = document.getElementById('tpExpenseSelect')?.value || null;
                await callBackend('paymentAction', {
                    action: 'create',
                    kind: document.getElementById('tpKind')?.value || 'supplier',
                    account: document.getElementById('tpAccount')?.value || DEFAULT_SIM_ACCOUNTS[0].iban,
                    recipient: {
                        name: document.getElementById('tpRecName')?.value?.trim() || '',
                        code: document.getElementById('tpRecCode')?.value?.trim() || '',
                        iban: document.getElementById('tpRecIban')?.value?.trim() || ''
                    },
                    amountKop,
                    purpose: document.getElementById('tpPurpose')?.value?.trim() || '',
                    ...(expId ? { expenseId: expId } : {})
                });
                showTestOutPayForm = false;
                bankSimData = await callPlatform({ action: 'bankSimulatorContext', tenantId: activeTenantId });
                toast('Платіж створено і доставлено в чергу Приват24 на підпис КЕП!', 'success');
                await refreshAllData();
            } else if (act === 'bank-sign-one') {
                const paymentId = actBtn.dataset.id;
                const date = document.getElementById('pfSignDate')?.value || bankSimData?.today;
                const time = document.getElementById('pfSignTime')?.value || '14:35';
                const feeKop = document.getElementById('pfSignFee')?.checked ? 500 : 0;
                setBusy(actBtn, true, 'Підписую КЕП і проводжу…');
                const res = await callPlatform({
                    action: 'bankSignPayment',
                    tenantId: activeTenantId,
                    paymentId,
                    date,
                    time,
                    feeKop,
                    autoSync: autoSyncBank
                });
                bankSimData = await callPlatform({ action: 'bankSimulatorContext', tenantId: activeTenantId });
                toast(`Платіж підписано КЕП у Приват24 та проведено у виписці (${fmtKop(res.amountKop)} грн, DLR: ${res.bankRef})!`, 'success');
                await refreshAllData();
            } else if (act === 'bank-sign-all') {
                const date = document.getElementById('pfSignDate')?.value || bankSimData?.today;
                const time = document.getElementById('pfSignTime')?.value || '14:35';
                const feeKop = document.getElementById('pfSignFee')?.checked ? 500 : 0;
                setBusy(actBtn, true, 'Підписую пачку КЕП…');
                const res = await callPlatform({
                    action: 'bankSignAllPayments',
                    tenantId: activeTenantId,
                    date,
                    time,
                    feeKop,
                    autoSync: autoSyncBank
                });
                bankSimData = await callPlatform({ action: 'bankSimulatorContext', tenantId: activeTenantId });
                toast(`Пачку з ${res.signedCount} платежів на суму ${fmtKop(res.totalKop)} грн підписано КЕП та проведено у виписці!`, 'success');
                await refreshAllData();
            } else if (act === 'bank-reject-one') {
                const paymentId = actBtn.dataset.id;
                const reason = await promptDialog(
                    'Відхилити платіж у Приват24?',
                    'Симулюється забракування платежу банком або відмова підписанта. Вкажіть причину відхилення:',
                    { confirmLabel: 'Відхилити платіж', placeholder: 'Невірний рахунок отримувача / скасовано підписантом' }
                );
                if (!reason) return;
                setBusy(actBtn, true, 'Відхиляю…');
                await callPlatform({
                    action: 'bankRejectPayment',
                    tenantId: activeTenantId,
                    paymentId,
                    reason
                });
                bankSimData = await callPlatform({ action: 'bankSimulatorContext', tenantId: activeTenantId });
                toast('Платіж позначено як відхилений банком (status: failed)', 'info');
                await refreshAllData();
            } else if (act === 'bank-quick-tpl') {
                e.stopPropagation();
                activeTemplateId = actBtn.dataset.tpl;
                bankBuilderDraft = buildDefaultBuilderDraft();
                await renderBankView();
                const vals = readBuilderFormValues();
                setBusy(actBtn, true, 'Проводжу…');
                const res = await callPlatform({
                    action: 'bankSimulateTransaction',
                    tenantId: activeTenantId,
                    ...vals,
                    autoSync: autoSyncBank
                });
                lastSimulatedTxResult = res;
                bankSimData = await callPlatform({ action: 'bankSimulatorContext', tenantId: activeTenantId });
                bankBuilderDraft.ref = `P24SIM${Date.now().toString(36).toUpperCase().slice(-6)}`;
                toast(res.storedTx?.status === 'done'
                    ? `Операцію проведено в 1 клік та автоматично рознесено (${fmtKop(vals.amountKop)} грн)!`
                    : `Операцію проведено в 1 клік — очікує рішення в Бухгалтерії (${fmtKop(vals.amountKop)} грн)`, 'success');
                await refreshAllData();
            } else if (act === 'bank-pick-tpl') {
                activeTemplateId = actBtn.dataset.tpl;
                bankBuilderDraft = buildDefaultBuilderDraft();
                await renderBankView();
            } else if (act === 'bank-sim-submit') {
                const vals = readBuilderFormValues();
                if (!vals.amountKop || vals.amountKop <= 0) {
                    toast('Вкажіть суму операції більшу за 0,00 грн', 'error');
                    return;
                }
                setBusy(actBtn, true, 'Проводжу через API Приват24…');
                const res = await callPlatform({
                    action: 'bankSimulateTransaction',
                    tenantId: activeTenantId,
                    ...vals,
                    autoSync: autoSyncBank
                });
                lastSimulatedTxResult = res;
                bankSimData = await callPlatform({ action: 'bankSimulatorContext', tenantId: activeTenantId });
                bankBuilderDraft = {
                    ...vals,
                    ref: `P24SIM${Date.now().toString(36).toUpperCase().slice(-6)}`
                };
                toast(res.storedTx?.status === 'done'
                    ? `Операцію проведено у виписці Приват24 та автоматично рознесено!`
                    : `Операцію проведено у виписці Приват24 — чекає рішення в «Рішеннях»`, 'success');
                await refreshAllData();
            } else if (act === 'bank-void-tx') {
                const txId = actBtn.dataset.id;
                if (!await confirmDialog(
                    'Симулювати банківське сторно (PR_PR="t")?',
                    `ПриватБанк надішле у виписці ознаку сторнування PR_PR="t" для операції ${txId}. Рознесення в історії квартири або оплату документа буде автоматично скасовано.`,
                    'Провести сторно банку'
                )) return;
                setBusy(actBtn, true, 'Сторную…');
                await callPlatform({
                    action: 'bankVoidTransaction',
                    tenantId: activeTenantId,
                    txId,
                    autoSync: autoSyncBank
                });
                bankSimData = await callPlatform({ action: 'bankSimulatorContext', tenantId: activeTenantId });
                toast('Операцію сторновано банком (PR_PR="t"), повʼязані баланси оновлено', 'info');
                await refreshAllData();
            }
            // ---- ПОДІЇ ТЕСТОВОГО ПОЛІГОНУ ТА ІНСПЕКТОРА ----
            else if (act === 'run-diagnostics') {
                setBusy(actBtn, true, 'Перевіряю базу…');
                liveDiagnostics = await callPlatform({ action: 'runDiagnostics', tenantId: activeTenantId });
                toast(liveDiagnostics.allOk ? 'Усі перевірки цілісності пройдено успішно!' : `Виявлено розбіжностей: ${liveDiagnostics.failedCount}`, liveDiagnostics.allOk ? 'success' : 'error');
                await renderTestingView();
            } else if (act === 'sb-prepare') {
                setBusy(actBtn, true, 'Готую тестовий будинок…');
                sandboxState = await callBackend('accountingTestAction', { action: 'prepare' }, 240000);
                toast('Тестовий будинок підготовлено', 'success');
                await renderTestingView();
            } else if (act === 'sb-step') {
                const step = actBtn.dataset.step;
                setBusy(actBtn, true, 'Виконую…');
                sandboxState = await callBackend('accountingTestAction', { action: step, period: sandboxPeriod }, 240000);
                toast(`Крок «${step}» за ${periodName(sandboxPeriod)} виконано`, 'success');
                await renderTestingView();
            } else if (act === 'sb-verify') {
                setBusy(actBtn, true, 'Звіряю числа…');
                sandboxVerifyResult = await callBackend('accountingTestAction', { action: 'verify', period: sandboxPeriod }, 240000);
                toast(sandboxVerifyResult.checks?.every(c => c.ok) ? 'Усі контрольні суми полігону зійшлися!' : 'Виявлено розбіжності в тестовому полігоні', 'info');
                await renderTestingView();
            } else if (act === 'sb-forms') {
                setBusy(actBtn, true, 'Перевіряю річні форми…');
                const res = await callBackend('accountingTestAction', { action: 'formsCycle', period: sandboxPeriod }, 240000);
                sandboxVerifyResult = { checks: res.checks || [] };
                toast('Річні форми неприбутковості та фінзвітності перевірено!', 'success');
                await renderTestingView();
            } else if (act === 'sb-full') {
                setBusy(actBtn, true, 'Проганяю 3 місяці…');
                sandboxState = await callBackend('accountingTestAction', { action: 'prepare' }, 240000);
                for (const p of sandboxState.periods || ['2025-10', '2025-11', '2025-12']) {
                    sandboxPeriod = p;
                    for (const [stKey] of SANDBOX_STAGES) {
                        sandboxState = await callBackend('accountingTestAction', { action: stKey, period: p }, 240000);
                    }
                }
                sandboxState = await callBackend('accountingTestAction', { action: 'publish' }, 240000);
                sandboxVerifyResult = await callBackend('accountingTestAction', { action: 'verify', period: sandboxPeriod }, 240000);
                toast('Повний тримісячний цикл симуляції успішно завершено!', 'success');
                await renderTestingView();
            } else if (act === 'sb-reset') {
                if (!await confirmDialog('Очистити тестовий полігон?', 'Усі дані вашої навчальної бази буде видалено. Робоча база ОСББ не зачіпається.', 'Очистити тест')) return;
                setBusy(actBtn, true, 'Очищую…');
                sandboxState = await callBackend('accountingTestAction', { action: 'reset' }, 240000);
                sandboxVerifyResult = null;
                toast('Тестовий полігон очищено', 'info');
                await renderTestingView();
            } else if (act === 'reload-inspector') {
                setBusy(actBtn, true, 'Завантажую…');
                inspectorQuery = document.getElementById('pfInspectQuery')?.value || '';
                if (document.getElementById('pfSubcolApt')) {
                    inspectorAptId = document.getElementById('pfSubcolApt').value.trim();
                }
                await loadInspectorDocs();
                await renderInspectorView();
            } else if (act === 'pick-doc') {
                const id = actBtn.dataset.id;
                selectedDoc = inspectorDocs.find(d => d.id === id) || null;
                patchPreviewDiffs = null;
                await renderInspectorView();
            } else if (act === 'open-apt-sub') {
                inspectorCol = 'apartments';
                inspectorSubcol = actBtn.dataset.sub;
                inspectorAptId = actBtn.dataset.apt;
                inspectorQuery = '';
                await loadInspectorDocs();
                await renderInspectorView();
            } else if (act === 'preview-patch') {
                if (!selectedDoc) return;
                const rawJson = document.getElementById('pfJsonEditor')?.value || '{}';
                let parsed;
                try {
                    parsed = JSON.parse(rawJson);
                } catch (syntaxErr) {
                    toast(`Помилка синтаксису JSON: ${syntaxErr.message}`, 'error');
                    return;
                }
                patchPreviewDiffs = computePatchDiff(selectedDoc.data, parsed);
                await renderInspectorView();
                document.getElementById('pfJsonEditor').value = JSON.stringify(parsed, null, 2);
                toast(`Знайдено змінених полів: ${patchPreviewDiffs.length}`, 'info');
            } else if (act === 'commit-patch') {
                if (!selectedDoc) return;
                const rawJson = document.getElementById('pfJsonEditor')?.value || '{}';
                const reason = document.getElementById('pfPatchReason')?.value?.trim() || '';
                let parsed;
                try {
                    parsed = JSON.parse(rawJson);
                } catch (syntaxErr) {
                    toast(`Помилка синтаксису JSON: ${syntaxErr.message}`, 'error');
                    return;
                }
                const diffs = computePatchDiff(selectedDoc.data, parsed);
                if (!diffs.length) {
                    toast('Немає змін для збереження', 'info');
                    return;
                }
                if (reason.length < 5) {
                    toast('Вкажіть обовʼязкову підставу коригування (щонайменше 5 символів) для журналу аудиту', 'error');
                    document.getElementById('pfPatchReason')?.focus();
                    return;
                }
                if (!await confirmDialog(
                    `Застосувати ручне коригування (${diffs.length} полів)?`,
                    `Документ: ${selectedDoc.path}. Зміни та причина («${reason}») будуть назавжди зафіксовані в audit_log.`,
                    'Підтвердити і зберегти'
                )) return;

                setBusy(actBtn, true, 'Зберігаю та пишу аудит…');
                const recomputeBalance = document.getElementById('pfRecomputeApt')?.checked !== false;
                await callPlatform({
                    action: 'manualPatch',
                    tenantId: activeTenantId,
                    collection: inspectorCol,
                    subcollection: inspectorSubcol,
                    aptId: inspectorAptId,
                    docId: selectedDoc.id,
                    patch: parsed,
                    reason,
                    recomputeBalance
                });
                toast('Зміни успішно збережено та зафіксовано в журналі аудиту', 'success');
                await loadInspectorDocs();
                await renderInspectorView();
            } else if (act === 'toggle-ledger-adj') {
                showLedgerAdjustForm = !showLedgerAdjustForm;
                await renderInspectorView();
            } else if (act === 'save-ledger-adj') {
                const apt = document.getElementById('laApt')?.value?.trim() || '';
                const kind = document.getElementById('laKind')?.value || 'payment';
                const period = document.getElementById('laPeriod')?.value || '';
                const amountKop = toKop(document.getElementById('laAmount')?.value || '');
                const reason = document.getElementById('laReason')?.value?.trim() || '';
                if (!apt || !amountKop || reason.length < 5) {
                    toast('Заповніть квартиру, суму та детальну підставу коригування (мін. 5 символів)', 'error');
                    return;
                }
                setBusy(actBtn, true, 'Проводжу коригування…');
                await callPlatform({
                    action: 'ledgerAdjustment',
                    tenantId: activeTenantId,
                    apt,
                    kind,
                    period,
                    amountKop,
                    reason
                });
                showLedgerAdjustForm = false;
                toast(`Коригувальний запис внесено в історію кв. ${apt}, баланс перераховано`, 'success');
                await refreshAllData();
            }
        } catch (err) {
            toast(err.message || 'Помилка виконання операції', 'error');
        } finally {
            if (actBtn.isConnected) setBusy(actBtn, false);
        }
    });

    document.addEventListener('change', async e => {
        if (e.target.id === 'pfAutoSync') {
            autoSyncBank = e.target.checked === true;
            return;
        }
        if (e.target.id === 'pfTenantSelect') {
            activeTenantId = e.target.value;
            inspectorDocs = [];
            selectedDoc = null;
            liveDiagnostics = null;
            bankSimData = null;
            bankBuilderDraft = null;
            await refreshAllData();
        } else if (e.target.id === 'bsAptSelect') {
            selectedSimApt = e.target.value;
            if (activeTemplateId !== 'resident_exact' && activeTemplateId !== 'resident_split') {
                activeTemplateId = 'resident_exact';
            }
            bankBuilderDraft = buildDefaultBuilderDraft();
            await renderBankView();
        } else if (e.target.id === 'bsApt2Select') {
            selectedSimApt2 = e.target.value;
            bankBuilderDraft = buildDefaultBuilderDraft();
            await renderBankView();
        } else if (e.target.id === 'tpExpenseSelect' && e.target.value) {
            const exp = (bankSimData?.openExpenses || []).find(x => x.id === e.target.value);
            const sup = exp ? (bankSimData?.suppliers || []).find(s => s.id === exp.supplierId) : null;
            if (exp) {
                const remKop = Math.max(0, (exp.amountKop || 0) - (exp.stornoKop || 0) - (exp.paidKop || 0));
                if (document.getElementById('tpRecName')) document.getElementById('tpRecName').value = sup?.name || exp.supplierName || '';
                if (document.getElementById('tpRecCode') && sup?.code) document.getElementById('tpRecCode').value = sup.code;
                if (document.getElementById('tpRecIban') && sup?.iban) document.getElementById('tpRecIban').value = sup.iban;
                if (document.getElementById('tpAmount')) document.getElementById('tpAmount').value = (remKop / 100).toFixed(2).replace('.', ',');
                if (document.getElementById('tpPurpose')) document.getElementById('tpPurpose').value = `${exp.description || 'Оплата згідно з документом'} № ${exp.number || ''} від ${exp.date || ''}, без ПДВ`;
            }
        } else if (e.target.id === 'pfSbPeriod') {
            sandboxPeriod = e.target.value;
            sandboxVerifyResult = null;
            await renderTestingView();
        } else if (e.target.id === 'pfColSelect') {
            inspectorCol = e.target.value;
            inspectorSubcol = '';
            inspectorAptId = '';
            inspectorQuery = '';
            selectedDoc = null;
            await loadInspectorDocs();
            await renderInspectorView();
        } else if (e.target.id === 'pfSubcolSelect') {
            inspectorSubcol = e.target.value;
            if (inspectorSubcol && !inspectorAptId) {
                inspectorAptId = selectedDoc?.id || '1';
            }
            selectedDoc = null;
            await loadInspectorDocs();
            await renderInspectorView();
        } else if (e.target.closest('#bsBuilderForm')) {
            bankBuilderDraft = readBuilderFormValues();
            updateLivePrivatJsonPreview();
        }
    });

    document.addEventListener('input', e => {
        if (e.target.id === 'tfName' && !editingTenant) {
            const slugInput = document.getElementById('tfSlug');
            if (slugInput) slugInput.value = normalizeTenantSlug(e.target.value);
        } else if (e.target.id === 'pfAuditSearch') {
            auditQuery = e.target.value;
            const pos = e.target.selectionStart;
            renderUsersView();
            const next = document.getElementById('pfAuditSearch');
            next?.focus();
            next?.setSelectionRange(pos, pos);
        } else if (e.target.closest('#bsBuilderForm')) {
            bankBuilderDraft = readBuilderFormValues();
            updateLivePrivatJsonPreview();
        }
    });

    document.getElementById('pfRefreshBtn')?.addEventListener('click', async e => {
        const btn = e.currentTarget;
        setBusy(btn, true, 'Оновлюю…');
        try {
            if (activeView === 'inspector') await loadInspectorDocs();
            if (activeView === 'bank') bankSimData = null;
            await refreshAllData();
            toast('Дані платформи оновлено', 'success');
        } catch (err) {
            toast(err.message, 'error');
        } finally {
            setBusy(btn, false);
        }
    });
}

// ============================================================
// ІНІЦІАЛІЗАЦІЯ ТА АВТОРИЗАЦІЯ
// ============================================================
initEvents();
window.addEventListener('popstate', () => {
    switchView(location.hash.replace('#', '') || 'tenants', { push: false });
});

let activeUserKey = null;
onAuthStateChanged(auth, async user => {
    if (!user) {
        activeUserKey = null;
        resetSession();
        location.replace('index.html');
        return;
    }
    if (await sessionExpired(user)) {
        activeUserKey = null;
        resetSession();
        location.replace('index.html');
        return;
    }
    const apt = currentApt(user);
    if (!apt) {
        activeUserKey = null;
        resetSession();
        location.replace('index.html');
        return;
    }
    const key = `${user.uid}:${apt}`;
    if (key === activeUserKey) return;
    activeUserKey = key;

    try {
        await loadProfile(apt);
        if (!session.role || !hasRight(session.role, 'account')) {
            location.replace('index.html');
            return;
        }
        rememberWorkMode('buh');
        document.getElementById('pfApp').hidden = false;
        hideAppLoader();
        await switchView(location.hash.replace('#', '') || 'tenants', { push: false });
    } catch (err) {
        activeUserKey = null;
        console.error('Помилка завантаження платформи:', err);
        hideAppLoader();
        toast('Не вдалося завантажити панель платформи', 'error');
    }
});

registerServiceWorker();
