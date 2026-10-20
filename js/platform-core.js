// ============================================================
// Чисте ядро Центру керування платформою ОСББ (Super-Admin Control Plane).
//
// Закладає фундамент для масштабування системи на множину ОСББ
// (Multi-Tenant SaaS Architecture):
//   1. Реєстр ОСББ (Tenants) та ізоляція баз даних (Scoped Prefix /
//      Named Firestore DB / Dedicated Project).
//   2. Тестовий полігон і симуляція банківських операцій, нарахувань
//      та податкових звітів (J0500111, Д1, 4ДФ, Д5, Звіт НПО).
//   3. Статистика користувачів, ролей та активності (Audit & Telemetry).
//   4. Інспектор колекцій бази даних та безпечні ручні коригування
//      (Break-Glass Manual Overrides з обовʼязковою причиною та diff у audit_log).
// ============================================================

const TENANT_STATUSES = {
    active: { label: 'Активне (Промислова база)', badge: 'is-payment', cls: 'is-done' },
    onboarding: { label: 'Впровадження / Міграція', badge: 'is-review', cls: 'is-work' },
    sandbox: { label: 'Тестовий полігон (Пісочниця)', badge: 'is-soft', cls: 'is-soft' },
    suspended: { label: 'Призупинено', badge: 'is-bad', cls: 'is-bad' }
};

const ISOLATION_MODES = {
    root_default: {
        label: 'Основна база проекту (Root Default)',
        title: 'Основна база проекту (Root Default)',
        description: 'Поточна база першого ОСББ «Успіх-25» у кореневих колекціях Firestore (100% зворотна сумісність).',
        desc: 'Кореневі колекції поточного проекту Firebase (100% зворотна сумісність).'
    },
    namespace_prefix: {
        label: 'Ізольований префікс колекцій (Namespace Prefix)',
        title: 'Ізольований префікс колекцій (Namespace Prefix)',
        description: 'Колекції з префіксом tenant~{id}~ та маркером _tenantId для повної ізоляції collectionGroup-запитів в одній БД.',
        desc: 'Ізоляція через префікс колекцій tenant~{id}~ без додаткової вартості інфраструктури.'
    },
    scoped_prefix: {
        label: 'Ізольований префікс колекцій (Scoped Tenant Namespace)',
        title: 'Ізольований префікс колекцій (Scoped Tenant Namespace)',
        description: 'Колекції з префіксом tenant~{id}~ та маркером _tenantId для повної ізоляції collectionGroup-запитів в одній БД.',
        desc: 'Ізоляція через префікс колекцій tenant~{id}~ в межах однієї бази Firestore.'
    },
    named_database: {
        label: 'Окрема база Firestore (Named Database)',
        title: 'Окрема база Firestore (Named Database)',
        description: 'Фізично окрема база даних Firestore (getFirestore(app, dbName)) в межах одного GCP/Firebase проекту.',
        desc: 'Фізично окрема база даних Firestore всередині одного GCP/Firebase проекту.'
    },
    dedicated_project: {
        label: 'Виділений проект Firebase (Enterprise Silo)',
        title: 'Виділений проект Firebase (Enterprise Silo)',
        description: 'Повністю окремий Firebase/GCP проект з власними ключами банку та сховищем документів.',
        desc: 'Повністю окремий Firebase/GCP проект для великих керуючих компаній та асоціацій.'
    }
};

const INSPECTABLE_COLLECTIONS = {
    apartments: {
        label: 'Квартири та приміщення (apartments)',
        title: 'Квартири та приміщення',
        group: 'Реєстр та мешканці',
        pkLabel: 'Номер приміщення (ID)',
        summaryFields: ['personalAccount', 'area', 'residents', 'balance', 'entrance', 'ownersStatus'],
        editableFields: ['personalAccount', 'area', 'residents', 'balance', 'entrance', 'floor', 'ownersStatus', 'notes']
    },
    bank_tx: {
        label: 'Банківська виписка (bank_tx)',
        title: 'Банківська виписка',
        group: 'Фінанси та банк',
        pkLabel: 'ID транзакції',
        summaryFields: ['period', 'direction', 'amountKop', 'status', 'kind', 'purpose'],
        editableFields: ['status', 'kind', 'category', 'purpose', 'period', 'expenseId', 'paymentId']
    },
    payments: {
        label: 'Платіжні доручення Приват24 (payments)',
        title: 'Вихідні платежі Приват24',
        group: 'Фінанси та банк',
        pkLabel: 'ID платежу',
        summaryFields: ['kind', 'amountKop', 'status', 'account', 'purpose'],
        editableFields: ['status', 'purpose', 'amountKop', 'bankRef', 'error']
    },
    expenses: {
        label: 'Документи витрат (expenses)',
        title: 'Первинні документи витрат',
        group: 'Бухгалтерія та договори',
        pkLabel: 'ID документа',
        summaryFields: ['docType', 'number', 'date', 'period', 'supplierName', 'amountKop', 'status'],
        editableFields: ['number', 'date', 'period', 'amountKop', 'vatKop', 'item', 'postingAcc', 'assetId', 'status', 'description']
    },
    contracts: {
        label: 'Договори з постачальниками (contracts)',
        title: 'Договори з постачальниками',
        group: 'Бухгалтерія та договори',
        pkLabel: 'ID договору',
        summaryFields: ['number', 'date', 'supplierName', 'type', 'monthlyKop', 'amountKop', 'status'],
        editableFields: ['number', 'date', 'subject', 'type', 'monthlyKop', 'amountKop', 'validFrom', 'validTo', 'item', 'status']
    },
    suppliers: {
        label: 'Постачальники (suppliers)',
        title: 'Контрагенти та постачальники',
        group: 'Бухгалтерія та договори',
        pkLabel: 'ID постачальника',
        summaryFields: ['name', 'kind', 'code', 'iban', 'fopChecked'],
        editableFields: ['name', 'kind', 'code', 'iban', 'fopChecked', 'note']
    },
    charges_runs: {
        label: 'Відомості нарахувань (charges_runs)',
        title: 'Відомості нарахувань за місяцями',
        group: 'Облік та закриття',
        pkLabel: 'Період (YYYY-MM)',
        summaryFields: ['period', 'count', 'totalKop', 'complete', 'status'],
        editableFields: ['complete', 'status', 'note']
    },
    journal_periods: {
        label: 'Періоди журналу проводок / ОСВ (journal_periods)',
        title: 'Періоди бухгалтерського журналу (ОСВ)',
        group: 'Облік та закриття',
        pkLabel: 'Період (YYYY-MM)',
        summaryFields: ['status', 'closedBy', 'closedAt'],
        editableFields: ['status', 'reopenReason']
    },
    claims: {
        label: 'Претензійно-позовні справи (claims)',
        title: 'Претензійно-позовні справи боржників',
        group: 'Юридичний блок',
        pkLabel: 'Квартира (ID)',
        summaryFields: ['apt', 'stage', 'status', 'caseNumber', 'courtOrderDate'],
        editableFields: ['stage', 'status', 'caseNumber', 'claimDate', 'courtOrderDate', 'lawsuitDate', 'enforcementDate', 'periodFrom', 'periodTo', 'ownerNameOverride', 'ownerCodeOverride', 'note', 'restructureMonths']
    },
    assets: {
        label: 'Майно, ОЗ, МНМА та ТМЦ (assets)',
        title: 'Інвентарна книга ОЗ, МНМА та ТМЦ',
        group: 'Облік та закриття',
        pkLabel: 'Інвентарний код (ID)',
        summaryFields: ['id', 'legacyId', 'acc', 'subacc', 'name', 'custodian', 'location'],
        editableFields: ['legacyId', 'name', 'subacc', 'item', 'fundId', 'usefulLifeMonths', 'deprMethod', 'custodian', 'location', 'serialNumber', 'passportNote']
    },
    advance_reports: {
        label: 'Авансові звіти 372 (advance_reports)',
        title: 'Авансові звіти підзвітних осіб (372)',
        group: 'Облік та закриття',
        pkLabel: 'ID звіту',
        summaryFields: ['number', 'date', 'period', 'personName', 'advanceKop', 'status'],
        editableFields: ['number', 'date', 'period', 'personName', 'personCode', 'personIban', 'purpose', 'advanceKop', 'status', 'comment']
    },
    staff: {
        label: 'Команда правління та ролі (staff)',
        title: 'Команда правління та бухгалтерія',
        group: 'Реєстр та мешканці',
        pkLabel: 'Логін / вхід (ID)',
        summaryFields: ['name', 'role', 'active'],
        editableFields: ['name', 'role', 'active', 'note']
    }
};

const SIMULATION_SCENARIOS = [
    {
        id: 'bank_inflow_exact',
        category: 'bank',
        title: 'Оплата внеску мешканцем (точний збіг квартири)',
        description: 'Імітує надходження 850,00 грн у виписці ПриватБанку з чітким призначенням «Внески на утримання будинку, кв. {apt}». Перевіряє автоматичне рознесення (Дт 311 Кт 377) та перерахунок балансу квартири.',
        steps: ['bank', 'verify'],
        defaultAmountGrn: '850,00',
        defaultApt: '298',
        direction: 'in'
    },
    {
        id: 'bank_inflow_unknown',
        category: 'bank',
        title: 'Невизначений платіж без номера квартири (у чергу «Рішення»)',
        description: 'Імітує банківське надходження 420,00 грн із розмитим призначенням «Сплата за комунальні послуги від родичів». Перевіряє потрапляння в чергу нерозібраних операцій (status: review).',
        steps: ['manualPayment', 'assign', 'verify'],
        defaultAmountGrn: '420,00',
        defaultApt: '298',
        direction: 'in'
    },
    {
        id: 'bank_outflow_supplier',
        category: 'bank',
        title: 'Списання за рахунком постачальника (Дт 631 Кт 311)',
        description: 'Імітує проведення банком вихідного платежу постачальнику послуг та перевіряє автоматичне закриття затвердженого документа витрат.',
        steps: ['services', 'bank', 'verify'],
        defaultAmountGrn: '1000,00',
        defaultApt: '',
        direction: 'out'
    },
    {
        id: 'tax_j0500111_check',
        category: 'tax',
        title: 'Контроль Податкового розрахунку ДПС (J0500111 + Д1, 4ДФ, Д5)',
        description: 'Перевіряє математичну узгодженість відомості зарплати та податкових додатків: ПДФО (18%), Військовий збір (5%), ЄСВ (22%), дотяжку бази ЄСВ до МЗП та готовність структури XML.',
        steps: ['payroll', 'settle', 'verify'],
        defaultAmountGrn: '',
        defaultApt: '',
        direction: 'check'
    },
    {
        id: 'npo_annual_check',
        category: 'tax',
        title: 'Контроль Річного звіту неприбуткової організації та Балансу (Форма 1-м / 2-м)',
        description: 'Перевіряє рівність Активу й Пасиву (ряд. 1300 = ряд. 1900), відповідність доходів та витрат неприбуткового звіту оборотам рахунків 70/71/73 та 92, і закриття рахунку 00.',
        steps: ['close', 'formsCycle'],
        defaultAmountGrn: '',
        defaultApt: '',
        direction: 'check'
    }
];

const IMMUTABLE_FIELDS = new Set(['id', '_id', '_tenantId', '_sandboxUid', 'createdAt', 'createdBy']);

const CYR_MAP = {
    'а': 'a', 'б': 'b', 'в': 'v', 'г': 'h', 'ґ': 'g', 'д': 'd', 'е': 'e', 'є': 'ye',
    'ж': 'zh', 'з': 'z', 'и': 'y', 'і': 'i', 'ї': 'yi', 'й': 'i', 'к': 'k', 'л': 'l',
    'м': 'm', 'н': 'n', 'о': 'o', 'п': 'p', 'р': 'r', 'с': 's', 'т': 't', 'у': 'u',
    'ф': 'f', 'х': 'kh', 'ц': 'ts', 'ч': 'ch', 'ш': 'sh', 'щ': 'shch', 'ь': '', 'ю': 'yu',
    'я': 'ia', "'": '', '’': '', 'ʼ': ''
};

const fmtKop = kop => (Number(kop || 0) / 100).toLocaleString('uk-UA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function validEdrpouChecksum(code) {
    const s = String(code || '').trim();
    if (!/^\d{8}$/.test(s)) return false;
    if (/^(\d)\1{7}$/.test(s)) return false;
    const digits = s.split('').map(Number);
    const num = Number(s);
    const w1 = num < 30000000 || num > 60000000 ? [1, 2, 3, 4, 5, 6, 7] : [7, 1, 2, 3, 4, 5, 6];
    let sum = w1.reduce((acc, w, i) => acc + w * digits[i], 0);
    let rem = sum % 11;
    if (rem === 10) {
        const w2 = w1.map(w => w + 2);
        sum = w2.reduce((acc, w, i) => acc + w * digits[i], 0);
        rem = sum % 11;
        if (rem === 10) rem = 0;
    }
    return rem === digits[7];
}

function normalizeTenantSlug(raw) {
    const lower = String(raw || '').trim().toLowerCase();
    let out = '';
    for (const ch of lower) {
        out += CYR_MAP[ch] !== undefined ? CYR_MAP[ch] : ch;
    }
    return out
        .replace(/[^a-z0-9-_]+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 40);
}

function validateTenantInput(input = {}) {
    const name = String(input.name || '').replace(/\s+/g, ' ').trim();
    if (name.length < 3 || name.length > 160) {
        return { ok: false, error: 'Вкажіть повну назву ОСББ (від 3 до 160 символів)' };
    }
    const id = normalizeTenantSlug(input.id || input.slug || name);
    if (!id || id.length < 3 || !/^[a-z0-9][a-z0-9-_]{1,38}[a-z0-9]$/.test(id)) {
        return { ok: false, error: 'Код (slug) ОСББ має містити від 3 до 40 латинських літер, цифр або дефісів (напр. uspih-25, osbb-morskoy-12)' };
    }
    const edrpou = String(input.edrpou || '').trim();
    if (!/^\d{8}$/.test(edrpou) || !validEdrpouChecksum(edrpou)) {
        return { ok: false, error: 'Код ЄДРПОУ має містити 8 цифр і проходити перевірку контрольного розряду' };
    }
    const iban = String(input.iban || '').replace(/\s+/g, '').toUpperCase();
    if (iban && !/^UA\d{27}$/.test(iban)) {
        return { ok: false, error: 'IBAN має починатися з UA та містити 29 символів' };
    }
    const address = String(input.address || '').replace(/\s+/g, ' ').trim().slice(0, 220);
    const apartmentsCount = Math.max(0, Math.min(5000, Math.round(Number(input.apartmentsCount || 0))));
    const startDate = /^\d{4}-\d{2}-\d{2}$/.test(String(input.startDate || '')) ? String(input.startDate) : '2026-10-01';
    const status = TENANT_STATUSES[input.status] ? input.status : 'onboarding';
    const isolationMode = ISOLATION_MODES[input.isolationMode] ? input.isolationMode : (id === 'uspih-25' ? 'root_default' : 'namespace_prefix');

    return {
        ok: true,
        tenant: {
            id,
            name,
            edrpou,
            edrpouValid: true,
            iban,
            address,
            city: String(input.city || 'м. Одеса').trim().slice(0, 80),
            apartmentsCount,
            startDate,
            status,
            isolationMode,
            dbPrefix: isolationMode === 'root_default' ? '' : `tenant~${id}~`,
            chairName: String(input.chairName || '').trim().slice(0, 120),
            contactPhone: String(input.contactPhone || '').trim().slice(0, 40),
            notes: String(input.notes || '').trim().slice(0, 400)
        }
    };
}

function computePatchDiff(beforeDoc = {}, patchObj = {}) {
    const changes = [];
    for (const [key, nextVal] of Object.entries(patchObj || {})) {
        if (IMMUTABLE_FIELDS.has(key)) continue;
        const prevVal = beforeDoc ? beforeDoc[key] : undefined;
        if (JSON.stringify(prevVal) !== JSON.stringify(nextVal)) {
            changes.push({
                field: key,
                before: prevVal === undefined ? null : prevVal,
                after: nextVal === undefined ? null : nextVal
            });
        }
    }
    return changes;
}

function validateManualPatch({ collection, docId, patch, reason }) {
    if (!INSPECTABLE_COLLECTIONS[collection]) {
        return { ok: false, error: `Колекція «${collection}» не підтримується в інспекторі ручних коригувань` };
    }
    const cleanId = String(docId || '').trim();
    if (!cleanId || cleanId.includes('/') || cleanId === '.' || cleanId === '..') {
        return { ok: false, error: 'Вкажіть коректний ID документа' };
    }
    const cleanReason = String(reason || '').replace(/\s+/g, ' ').trim();
    if (cleanReason.length < 5) {
        return { ok: false, error: 'Обовʼязково вкажіть підставу / причину ручного коригування (щонайменше 5 символів) для журналу аудиту' };
    }
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
        return { ok: false, error: 'Дані коригування мають бути обʼєктом JSON' };
    }
    const sanitized = {};
    for (const [k, v] of Object.entries(patch)) {
        if (IMMUTABLE_FIELDS.has(k)) continue;
        sanitized[k] = v;
    }
    if (!Object.keys(sanitized).length) {
        return { ok: false, error: 'Немає полів для оновлення' };
    }
    return {
        ok: true,
        collection,
        docId: cleanId,
        reason: cleanReason.slice(0, 400),
        patch: sanitized,
        cleanPatch: sanitized
    };
}

function evaluateAccountingInvariants({
    apartments = [],
    ledgersByApt = null,
    bankTx = [],
    payments = [],
    closedPeriods = [],
    tb = null,
    openingStatus = 'none',
    bankSettingsAccounts = {},
    computedBankBalances = {},
    subledger377NetKop = null
} = {}) {
    const checks = [];
    const nonAdminApts = (apartments || []).filter(a => a && a.isAdmin !== true);
    const totalAptBalanceKop = nonAdminApts.reduce((sum, a) => sum + Math.round(Number(a.balance || 0) * 100), 0);
    const totalDebtKop = nonAdminApts.reduce((sum, a) => sum + Math.max(0, -Math.round(Number(a.balance || 0) * 100)), 0);
    const totalOverpaidKop = nonAdminApts.reduce((sum, a) => sum + Math.max(0, Math.round(Number(a.balance || 0) * 100)), 0);

    // 1. Тотожність балансів квартир та записів ledger (якщо передано ledgersByApt)
    if (ledgersByApt && typeof ledgersByApt.get === 'function') {
        const mismatches = [];
        for (const aptObj of nonAdminApts) {
            const aptKey = String(aptObj.id || aptObj.apt || '');
            const entries = ledgersByApt.get(aptKey) || [];
            if (!entries.length && aptObj.balanceSource !== 'ledger') continue;
            let expectedKop = 0;
            for (const e of entries) {
                const k = e.amountKop !== undefined ? Math.round(Number(e.amountKop)) : Math.round(Number(e.amount || 0) * 100);
                if (e.kind === 'opening') expectedKop += k;
                else if (e.kind === 'charge' || e.kind === 'refund') expectedKop -= Math.abs(k);
                else if (e.kind === 'payment') expectedKop += Math.abs(k);
            }
            const actualKop = Math.round(Number(aptObj.balance || 0) * 100);
            if (Math.abs(actualKop - expectedKop) > 1) {
                mismatches.push({ apt: aptKey, actualGrn: actualKop / 100, expectedGrn: expectedKop / 100 });
            }
        }
        checks.push({
            id: 'ledger_balance_match',
            code: 'LEDGER_BALANCE_MATCH',
            label: 'Тотожність балансів квартир та суми записів їхньої історії (apartments.balance == ∑ ledger)',
            ok: mismatches.length === 0,
            expected: '0 розбіжностей',
            actual: mismatches.length === 0 ? `Узгоджено (${nonAdminApts.length} прим.)` : `Розбіжностей: ${mismatches.length}`,
            details: mismatches.slice(0, 10),
            severity: 'critical'
        });
    }

    // 2. Узгодженість проведених платежів (payments) із банківською випискою (bank_tx)
    if (Array.isArray(payments) && Array.isArray(bankTx)) {
        const txIds = new Set(bankTx.map(t => String(t.id || '')));
        const brokenPayments = payments.filter(p => p.txId && !txIds.has(String(p.txId)));
        checks.push({
            id: 'payments_tx_integrity',
            code: 'PAYMENTS_TX_INTEGRITY',
            label: 'Цілісність звʼязків вихідних платежів Приват24 із банківською випискою (payments.txId → bank_tx)',
            ok: brokenPayments.length === 0,
            expected: 'Усі посилання дійсні',
            actual: brokenPayments.length === 0 ? `Перевірено (${payments.length} пл.)` : `Помилкових посилань: ${brokenPayments.length}`,
            details: brokenPayments.slice(0, 5).map(p => p.id),
            severity: 'warning'
        });
    }

    // 3. Рівність Дебету і Кредиту в закритих періодах (journal_periods)
    if (Array.isArray(closedPeriods) && closedPeriods.length > 0) {
        const unbalanced = closedPeriods.filter(p => {
            if (p.status !== 'closed') return false;
            const dr = Number(p.totalDrKop ?? p.tb?.totals?.dr ?? 0);
            const cr = Number(p.totalCrKop ?? p.tb?.totals?.cr ?? 0);
            return Math.abs(dr - cr) > 0;
        });
        checks.push({
            id: 'closed_periods_balanced',
            code: 'CLOSED_PERIODS_BALANCED',
            label: 'Балансова рівність Дебет = Кредит у закритих місяцях (journal_periods)',
            ok: unbalanced.length === 0,
            expected: 'Дт = Кт у всіх закритих місяцях',
            actual: unbalanced.length === 0 ? `Закрито періодів: ${closedPeriods.filter(p => p.status === 'closed').length}` : `Розбалансовано: ${unbalanced.length}`,
            details: unbalanced.map(p => p.id),
            severity: 'critical'
        });
    }

    if (tb && tb.totals) {
        const drEqCr = tb.totals.dr === tb.totals.cr && tb.totals.closeDr === tb.totals.closeCr;
        checks.push({
            id: 'osv_balanced',
            code: 'OSV_BALANCED',
            label: 'Подвійний запис ОСВ: обороти Дт = Кт та кінцеве сальдо Дт = Кт',
            ok: Boolean(drEqCr),
            actual: `Дт ${fmtKop(tb.totals.closeDr)} / Кт ${fmtKop(tb.totals.closeCr)} грн`,
            expected: 'Рівність Дебету і Кредиту',
            severity: 'critical'
        });
    } else if (subledger377NetKop !== null) {
        const diffKop = Math.abs(Number(subledger377NetKop) - totalAptBalanceKop);
        checks.push({
            id: 'subledger_377_match',
            code: 'SUBLEDGER_377_MATCH',
            label: 'Історія квартир (ledger) збігається з поточними балансами у картках',
            ok: diffKop <= 5,
            actual: `Ledger: ${fmtKop(subledger377NetKop)} грн · Картки: ${fmtKop(totalAptBalanceKop)} грн`,
            expected: 'Розбіжність 0,00 грн',
            severity: 'critical'
        });
    }

    const passedCount = checks.filter(c => c.ok).length;
    const failedCount = checks.length - passedCount;
    const scorePct = checks.length ? Math.round((passedCount / checks.length) * 100) : 100;

    return {
        allOk: failedCount === 0,
        healthy: checks.every(c => c.ok || c.severity !== 'critical'),
        passedCount,
        failedCount,
        scorePct,
        totalApartments: nonAdminApts.length,
        totalDebtKop,
        totalOverpaidKop,
        checks
    };
}

function summarizeUserActivity({
    apartments = [],
    staff = [],
    auditLogs = [],
    requestsCount = 0,
    pollsCount = 0,
    meetingsCount = 0,
    nowMs = Date.now()
} = {}) {
    const nonAdminApts = (apartments || []).filter(a => a && a.isAdmin !== true);
    const serviceAccounts = (apartments || []).filter(a => a && a.isAdmin === true);
    const activatedApartments = nonAdminApts.filter(a => a.passwordChanged === true).length;
    const verifiedOwners = nonAdminApts.filter(a => a.ownersStatus === 'verified').length;
    const withPersonalAccount = nonAdminApts.filter(a => Boolean(String(a.personalAccount || '').trim())).length;

    let debtorsCount = 0;
    let overpaidCount = 0;
    let zeroBalanceCount = 0;
    for (const a of nonAdminApts) {
        const kop = Math.round(Number(a.balance || 0) * 100);
        if (kop < 0) debtorsCount++;
        else if (kop > 0) overpaidCount++;
        else zeroBalanceCount++;
    }

    const activeStaff = (staff || []).filter(s => s && s.active !== false);
    const staffByRole = { chair: 0, accountant: 0, board: 0 };
    for (const s of activeStaff) {
        if (staffByRole[s.role] !== undefined) staffByRole[s.role] += 1;
    }

    const dayMs = 24 * 60 * 60 * 1000;
    let events24h = 0;
    let events7d = 0;
    const actionBreakdown = {};
    const actors = new Map();

    for (const log of auditLogs || []) {
        const act = String(log.action || 'other');
        const prefix = act.split('.')[0] || 'other';
        actionBreakdown[prefix] = (actionBreakdown[prefix] || 0) + 1;
        if (log.actor) {
            actors.set(log.actor, (actors.get(log.actor) || 0) + 1);
        }
        const ts = typeof log.at === 'number' ? log.at : (log.at ? Date.parse(String(log.at)) : NaN);
        if (Number.isFinite(ts)) {
            if (nowMs - ts <= dayMs) events24h++;
            if (nowMs - ts <= 7 * dayMs) events7d++;
        }
    }

    const topActors = [...actors.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([actor, count]) => ({ actor, count }));

    const activationRatePct = nonAdminApts.length ? Math.round((activatedApartments / nonAdminApts.length) * 100) : 0;

    return {
        totalApartments: nonAdminApts.length,
        activatedApartments,
        activatedCabinets: activatedApartments,
        activationRatePct,
        activationPct: activationRatePct,
        verifiedOwners,
        verificationPct: nonAdminApts.length ? Math.round((verifiedOwners / nonAdminApts.length) * 100) : 0,
        withPersonalAccount,
        debtorsCount,
        overpaidCount,
        zeroBalanceCount,
        serviceAccountsCount: serviceAccounts.length,
        activeStaffCount: activeStaff.length,
        staffByRole,
        byRole: staffByRole,
        events24h,
        events7d,
        requestsCount: Number(requestsCount || 0),
        pollsCount: Number(pollsCount || 0),
        meetingsCount: Number(meetingsCount || 0),
        auditCount: (auditLogs || []).length,
        actionBreakdown,
        actionGroups: actionBreakdown,
        topActors
    };
}

export {
    TENANT_STATUSES,
    ISOLATION_MODES,
    INSPECTABLE_COLLECTIONS,
    SIMULATION_SCENARIOS,
    IMMUTABLE_FIELDS,
    fmtKop,
    validEdrpouChecksum,
    normalizeTenantSlug,
    validateTenantInput,
    computePatchDiff,
    validateManualPatch,
    evaluateAccountingInvariants,
    summarizeUserActivity
};
