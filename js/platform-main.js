// ============================================================
// Super-Admin Platform Control Plane (platform.html / js/platform-main.js).
//
// Єдиний центр управління платформою ОСББ:
//   1. Мульти-ОСББ та бази (tenants): реєстр усіх підключених ОСББ,
//      режими ізоляції БД, перемикання активного контексту, онбординг нового ОСББ.
//   2. Тести й симуляції (testing): перевірка інваріантів бази, керування
//      ізольованим тестовим полігоном (банківські операції, нарахування,
//      зарплата, податкові та річні звіти).
//   3. Користувачі й активність (users): статистика ролей, кабінетів
//      співвласників, боржників/переплат та живий потік журналу аудиту.
//   4. Інспектор БД і ручне коригування (inspector): перегляд колекцій,
//      попередній перегляд diff (Було -> Стане), безпечне збереження з
//      обовʼязковою причиною для audit_log та перерахунком балансу квартири.
//   5. Архітектура Multi-Tenant (architecture): світові практики SaaS/Fintech
//      та дорожня карта масштабування платформи на сотні ОСББ.
// ============================================================
import { auth, db, session, currentApt, resetSession } from './firebase.js';
import { onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js';
import {
    collection, collectionGroup, doc, getDoc, getDocs, setDoc, addDoc, query, orderBy, limit, serverTimestamp
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js';
import { callBackend } from './backend.js';
import { escapeHtml as esc, toast, setBusy, hideAppLoader, confirmDialog } from './ui.js';
import { hasRight, ROLE_LABELS } from './staff-core.js';
import { loadProfile, sessionExpired, rememberWorkMode } from './app-common.js';
import { registerServiceWorker } from './install.js';
import { fmtKop, periodName, toKop } from './charges-core.js';
import {
    TENANT_STATUSES,
    ISOLATION_MODES,
    INSPECTABLE_COLLECTIONS,
    SIMULATION_SCENARIOS,
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

let activeView = 'tenants';
let activeTenantId = 'uspih-25';
let overviewData = null;
let showNewTenantForm = false;
let editingTenant = null;

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
 * Універсальний виклик сервісу платформи з автоматичним клієнтським фолбеком,
 * щоб адмін-панель миттєво працювала з реальними даними Firestore навіть до
 * оновлення Cloud Functions.
 */
async function callPlatform(payload) {
    try {
        return await callBackend('platformAction', { tenantId: activeTenantId, ...payload });
    } catch (err) {
        const msg = String(err?.message || '');
        if (/not-found|unimplemented|function.*not.*exist|CORS|internal|Failed to fetch/i.test(msg)) {
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
                expenses: expenses.length,
                claims: claims.length,
                closedPeriods: closedPeriods.filter(p => p.status === 'closed').length
            },
            userStats: summarizeUserActivity({ apartments, staff, auditLogs, nowMs: Date.now() }),
            diagnostics: evaluateAccountingInvariants({ apartments, bankTx, payments, closedPeriods }),
            recentAudit: auditLogs.slice(0, 50)
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

    throw new Error(`Непідтримувана дія: ${action}`);
}

// ============================================================
// НАВІГАЦІЯ ТА ПЕРЕМИКАЧ КОНТЕКСТУ БАЗИ
// ============================================================
function updateTenantSwitcher() {
    const sel = document.getElementById('pfTenantSelect');
    const wrap = sel?.closest('.pf-db-switcher');
    if (!sel || !overviewData?.tenants) return;
    sel.innerHTML = overviewData.tenants.map(t =>
        `<option value="${esc(t.id)}"${t.id === activeTenantId ? ' selected' : ''}>${esc(t.name)} (${t.isSandbox ? 'Пісочниця' : `ЄДРПОУ ${t.edrpou}`})</option>`
    ).join('');
    if (wrap) wrap.classList.toggle('is-sandbox', activeTenantId.startsWith('sandbox~'));
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
    updateTenantSwitcher();
    await renderCurrentView();
}

async function renderCurrentView() {
    if (!overviewData) {
        overviewData = await callPlatform({ action: 'overview', tenantId: activeTenantId });
        updateTenantSwitcher();
    }
    if (activeView === 'tenants') renderTenantsView();
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
                <span>Операцій банку та витрат</span>
                <b>${(c.bankTx || 0) + (c.expenses || 0)}</b>
                <small>виписка: ${c.bankTx || 0} (чекають: ${c.bankReview || 0}) · док.: ${c.expenses || 0}</small>
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
                    <p class="buh-note" style="margin:2px 0 0">Перемикайте активну базу даних для огляду, тестування, аудиту користувачів або точкового коригування записів.</p>
                </div>
                <button type="button" class="sv-btn" style="width:auto;min-height:40px;padding:0 18px" data-pf-act="open-new-tenant">+ Підключити нове ОСББ</button>
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
// ВКЛАДКА 2: ТЕСТОВИЙ ПОЛІГОН І СИМУЛЯЦІЇ (testing)
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
// ВКЛАДКА 3: КОРИСТУВАЧІ ТА АКТИВНІСТЬ (users)
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
// ВКЛАДКА 4: ІНСПЕКТОР БД І РУЧНЕ КОРИГУВАННЯ (inspector)
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
// ВКЛАДКА 5: АРХІТЕКТУРА MULTI-TENANT (architecture)
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
                    <span class="pf-tier-badge">4. Shadow Sandbox & Closed Drivers</span>
                    <h3>Ізольований полігон для банку і податкової</h3>
                    <p>Реальні зовнішні сервіси (Приват24 Автоклієнт, FCM-сповіщення, форми ДПС) замінюються у тестовому контурі на детерміновані Closed-Loop драйвери. Це дозволяє проганяти повний річний цикл ОСББ та податкові звіти без ризику відправити реальний платіж.</p>
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
                        <td>Super-Admin Control Plane (<code>platform.html</code>), реєстр ОСББ (<code>platform_tenants</code>), перемикач контексту БД, інспектор колекцій з Diff-превʼю та обовʼязковим аудитом, інтеграція тестового полігону й діагностики інваріантів.</td>
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
                toast(`Активний контур перемкнено на: ${activeTenantId}`, 'info');
                await refreshAllData();
            } else if (act === 'inspect-tenant') {
                activeTenantId = actBtn.dataset.id;
                inspectorDocs = [];
                selectedDoc = null;
                overviewData = await callPlatform({ action: 'overview', tenantId: activeTenantId });
                updateTenantSwitcher();
                await switchView('inspector');
            } else if (act === 'run-diagnostics') {
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
        if (e.target.id === 'pfTenantSelect') {
            activeTenantId = e.target.value;
            inspectorDocs = [];
            selectedDoc = null;
            liveDiagnostics = null;
            await refreshAllData();
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
        }
    });

    document.getElementById('pfRefreshBtn')?.addEventListener('click', async e => {
        const btn = e.currentTarget;
        setBusy(btn, true, 'Оновлюю…');
        try {
            if (activeView === 'inspector') await loadInspectorDocs();
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
