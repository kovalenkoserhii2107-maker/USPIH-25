'use strict';
// ============================================================
// Чисте ядро Центру керування платформою ОСББ (Super-Admin Control Plane).
//
// Закладає фундамент для масштабування системи на множину ОСББ
// (Multi-Tenant SaaS Architecture):
//   1. Реєстр ОСББ (Tenants) та ізоляція баз даних (Scoped Prefix /
//      Named Firestore DB / Dedicated Project).
//   2. Симулятор Приват24 Бізнес API «Автоклієнт» v3.0.0:
//      - черга вихідних платежів ОСББ на підпис КЕП та генерація
//        проведених банківських транзакцій (TRANTYPE: 'D', FL_REAL: 'r', PR_PR: 'r', DLR);
//      - генератор вхідних платежів (TRANTYPE: 'C') за шаблонами та довільними
//        реквізитами у точному форматі /api/statements/transactions.
//   3. Тестовий полігон і симуляція банківських операцій, нарахувань
//      та податкових звітів (J0500111, Д1, 4ДФ, Д5, Звіт НПО).
//   4. Статистика користувачів, ролей та активності (Audit & Telemetry).
//   5. Інспектор колекцій бази даних та безпечні ручні коригування
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
        editableFields: ['personalAccount', 'area', 'residents', 'entrance', 'floor', 'ownersStatus', 'notes']
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

// ============================================================
// ШАБЛОНИ ОПЕРАЦІЙ ПРИВАТ24 БІЗНЕС API v3.0.0
// ============================================================
const BANK_SIM_TEMPLATES = [
    {
        id: 'resident_exact',
        group: 'in_resident',
        direction: 'in',
        trantype: 'C',
        title: 'Внесок мешканця (точний збіг за квартирою та о/р)',
        subtitle: 'Автоматично розноситься в історію квартири (Дт 311 Кт 377) та перераховує баланс',
        badge: 'Авто-рознесення',
        badgeCls: 'is-done',
        defaultAmountGrn: '850,00',
        needsApartment: true,
        counterpartyName: 'Мешканець будинку',
        counterpartyCode: '3124567890',
        counterpartyIban: 'UA213052990000026201234567891',
        purposeTemplate: 'Внески на утримання будинку, кв. {apt}, особовий рахунок {account}, {owner}'
    },
    {
        id: 'resident_unrecognized',
        group: 'in_resident',
        direction: 'in',
        trantype: 'C',
        title: 'Невизначений платіж без номера квартири (у «Рішення»)',
        subtitle: 'Потрапляє в чергу «Розібрати» (status: review) — для перевірки ручного привʼязування та запамʼятовування платника',
        badge: 'У «Рішення»',
        badgeCls: 'is-work',
        defaultAmountGrn: '640,00',
        needsApartment: false,
        counterpartyName: 'Бондаренко Марія Степанівна',
        counterpartyCode: '2984512369',
        counterpartyIban: 'UA213052990000026209876543210',
        purposeTemplate: 'Сплата за комунальні послуги та утримання будинку від родичів'
    },
    {
        id: 'resident_split',
        group: 'in_resident',
        direction: 'in',
        trantype: 'C',
        title: 'Спільний платіж за дві квартири одним переказом',
        subtitle: 'Потрапляє в «Рішення» з підказками обох квартир — для тестування поділу суми між кількома приміщеннями',
        badge: 'Поділ суми',
        badgeCls: 'is-work',
        defaultAmountGrn: '1700,00',
        needsApartment: true,
        counterpartyName: 'Шевченко Олександр Іванович',
        counterpartyCode: '3011223344',
        counterpartyIban: 'UA213052990000026205554443332',
        purposeTemplate: 'Сплата внесків на утримання будинку за кв. {apt} та кв. {apt2}'
    },
    {
        id: 'income_equipment',
        group: 'in_other',
        direction: 'in',
        trantype: 'C',
        title: 'Сервітут / розміщення обладнання інтернет-провайдера',
        subtitle: 'Автоматично класифікується як дохід від розміщення обладнання (equipment, Дт 311 Кт 48/719)',
        badge: 'Дохід ОСББ',
        badgeCls: 'is-done',
        defaultAmountGrn: '2500,00',
        needsApartment: false,
        counterpartyName: 'ТОВ «Одеса-Телеком Мережа»',
        counterpartyCode: '38451920',
        counterpartyIban: 'UA443052990000026005556667771',
        purposeTemplate: 'Оплата за договором сервітуту (доступ та розміщення телекомунікаційного обладнання) за жовтень 2026 р., без ПДВ'
    },
    {
        id: 'income_interest',
        group: 'in_other',
        direction: 'in',
        trantype: 'C',
        title: 'Відсотки банку на залишок коштів / депозит',
        subtitle: 'Автоматично класифікується як процентний дохід (interest, Дт 311 Кт 73/48)',
        badge: 'Відсотки банку',
        badgeCls: 'is-done',
        defaultAmountGrn: '1240,50',
        needsApartment: false,
        counterpartyName: 'АТ КБ «ПРИВАТБАНК»',
        counterpartyCode: '14360570',
        counterpartyIban: 'UA173052990000026000000000001',
        purposeTemplate: 'Нарахування процентів за залишком коштів на рахунку згідно з умовами договору банківського обслуговування'
    },
    {
        id: 'income_grant',
        group: 'in_other',
        direction: 'in',
        trantype: 'C',
        title: 'Міська програма співфінансування / цільовий грант',
        subtitle: 'Надходження цільового фінансування з бюджету або фонду (grant, Дт 311 Кт 48)',
        badge: 'Цільовий грант',
        badgeCls: 'is-done',
        defaultAmountGrn: '45000,00',
        needsApartment: false,
        counterpartyName: 'Департамент міського господарства ОМР',
        counterpartyCode: '03351542',
        counterpartyIban: 'UA778201720344200002000012345',
        purposeTemplate: 'Цільове співфінансування капітального ремонту інженерних мереж за програмою підтримки ОСББ, без ПДВ'
    },
    {
        id: 'supplier_refund',
        group: 'in_other',
        direction: 'in',
        trantype: 'C',
        title: 'Повернення коштів від постачальника (переплата / сторно)',
        subtitle: 'Визначається як можливе повернення списаного (possible-refund) для привʼязки до вихідного платежу',
        badge: 'Повернення',
        badgeCls: 'is-work',
        defaultAmountGrn: '1500,00',
        needsApartment: false,
        counterpartyName: 'ТОВ «Одесаліфт-Сервіс»',
        counterpartyCode: '34512890',
        counterpartyIban: 'UA553052990000026007778889991',
        purposeTemplate: 'Повернення надміру перерахованих коштів згідно з актом звірки взаєморозрахунків, без ПДВ'
    },
    {
        id: 'expense_bank_fee',
        group: 'out_other',
        direction: 'out',
        trantype: 'D',
        title: 'Комісія ПриватБанку за розрахунково-касове обслуговування (РКО)',
        subtitle: 'Автоматично проводиться як банківська комісія (bank_fee, Дт 92 Кт 311)',
        badge: 'Витрата (РКО)',
        badgeCls: 'is-soft',
        defaultAmountGrn: '150,00',
        needsApartment: false,
        counterpartyName: 'АТ КБ «ПРИВАТБАНК»',
        counterpartyCode: '14360570',
        counterpartyIban: 'UA173052990000026000000000001',
        purposeTemplate: 'Комісія за розрахунково-касове обслуговування рахунку згідно з тарифами банку'
    }
];

const DEFAULT_SIM_ACCOUNTS = [
    {
        iban: 'UA213052990000026007054321001',
        purpose: 'current',
        name: 'Поточний рахунок ОСББ (311 · ПриватБанк)',
        currency: 'UAH',
        defaultBalanceKop: 28540000 // 285 400,00 грн
    },
    {
        iban: 'UA663052990000026007054321002',
        purpose: 'reserve',
        name: 'Резервний та ремонтний фонд (311 · ПриватБанк)',
        currency: 'UAH',
        defaultBalanceKop: 15000000 // 150 000,00 грн
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

/**
 * Форматує дату та час у точний формат Приват24 Автоклієнт v3.0.0:
 * DAT_OD: «20.10.2026», TIM_P: «14:35», DATE_TIME_DAT_OD_TIM_P: «20.10.2026 14:35:00».
 */
function formatPrivatDateTime(dateInput, timeInput) {
    let yyyy = '2026', mm = '10', dd = '20', hh = '14', mi = '30', ss = '00';
    if (typeof dateInput === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(dateInput.trim())) {
        [yyyy, mm, dd] = dateInput.trim().split('-');
    } else if (typeof dateInput === 'string' && /^\d{2}\.\d{2}\.\d{4}$/.test(dateInput.trim())) {
        [dd, mm, yyyy] = dateInput.trim().split('.');
    } else {
        const d = dateInput instanceof Date && !Number.isNaN(dateInput.getTime()) ? dateInput : new Date();
        const parts = new Intl.DateTimeFormat('uk-UA', {
            timeZone: 'Europe/Kyiv',
            year: 'numeric', month: '2-digit', day: '2-digit',
            hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
        }).formatToParts(d);
        const get = t => parts.find(p => p.type === t)?.value || '00';
        yyyy = get('year');
        mm = get('month');
        dd = get('day');
        hh = get('hour');
        mi = get('minute');
        ss = get('second');
    }

    if (typeof timeInput === 'string' && /^\d{1,2}:\d{2}(?::\d{2})?$/.test(timeInput.trim())) {
        const tParts = timeInput.trim().split(':');
        hh = String(tParts[0]).padStart(2, '0');
        mi = String(tParts[1]).padStart(2, '0');
        ss = String(tParts[2] || '00').padStart(2, '0');
    }

    const datOd = `${dd}.${mm}.${yyyy}`;
    const timP = `${hh}:${mi}`;
    return {
        DAT_OD: datOd,
        DAT_KL: datOd,
        TIM_P: timP,
        DATE_TIME_DAT_OD_TIM_P: `${datOd} ${timP}:${ss}`,
        isoDate: `${yyyy}-${mm}-${dd}`
    };
}

/**
 * Будує точний JSON-обʼєкт операції виписки у форматі
 * GET https://acp.privatbank.ua/api/statements/transactions (API Автоклієнт v3.0.0).
 */
function buildPrivatRawTransaction(input = {}) {
    const direction = input.trantype === 'D' || input.direction === 'out' ? 'out' : 'in';
    const trantype = direction === 'out' ? 'D' : 'C';
    const amountKop = Math.abs(Math.round(Number(input.amountKop || 0)));
    const sumStr = (amountKop / 100).toFixed(2);
    const myAcc = String(input.account || DEFAULT_SIM_ACCOUNTS[0].iban).replace(/\s+/g, '').toUpperCase();
    const cntrAcc = String(input.counterpartyIban || input.counterpartyAccount || 'UA213052990000026201234567891').replace(/\s+/g, '').toUpperCase();
    const cntrCrf = String(input.counterpartyCode || '00000000').trim();
    const cntrNam = String(input.counterpartyName || 'Контрагент').trim();
    const purpose = String(input.purpose || '').replace(/\s+/g, ' ').trim();
    const dt = formatPrivatDateTime(input.date, input.time);
    const suffix = String(input.ref || `P24SIM${Date.now().toString(36).toUpperCase()}`);
    const refn = String(input.refn || '1');
    const flReal = input.flReal || 'r';
    const prPr = input.prPr || 'r';
    const cntrMfo = /^UA\d{8}/.test(cntrAcc) ? cntrAcc.slice(4, 10) : '305299';
    const myMfo = /^UA\d{8}/.test(myAcc) ? myAcc.slice(4, 10) : '305299';

    const raw = {
        REF: suffix,
        REFN: refn,
        ID: `${suffix}_${refn}`,
        TRANTYPE: trantype,
        FL_REAL: flReal,
        PR_PR: prPr,
        AUT_MY_MFO: myMfo,
        AUT_MY_ACC: myAcc,
        AUT_MY_NAM: String(input.myName || 'ОСББ «Успіх-25»'),
        AUT_MY_CRF: String(input.myEdrpou || '40562894'),
        AUT_CNTR_MFO: cntrMfo,
        AUT_CNTR_ACC: cntrAcc,
        AUT_CNTR_CRF: cntrCrf,
        AUT_CNTR_NAM: cntrNam,
        SUM: sumStr,
        SUM_E: sumStr,
        CCY: 'UAH',
        OSND: purpose,
        DAT_OD: dt.DAT_OD,
        DAT_KL: dt.DAT_KL,
        TIM_P: dt.TIM_P,
        DATE_TIME_DAT_OD_TIM_P: dt.DATE_TIME_DAT_OD_TIM_P,
        NUM_DOC: String(input.docNumber || suffix.slice(-8)),
        DLR: input.dlr ? String(input.dlr) : ''
    };

    if (input.ultmtName) {
        if (direction === 'in') raw.PAYER_ULTMT_NAME = String(input.ultmtName);
        else raw.RECIPIENT_ULTMT_NAME = String(input.ultmtName);
    }
    if (input.ultmtCode) {
        if (direction === 'in') raw.PAYER_ULTMT_NCEO = String(input.ultmtCode);
        else raw.RECIPIENT_ULTMT_NCEO = String(input.ultmtCode);
    }

    return raw;
}

/**
 * Формує повний опис життєвого циклу вихідного платежу ОСББ за протоколом
 * Приват24 Автоклієнт v3.0.0:
 *   1. Запит створення чернетки: POST /api/proxy/payment/create
 *   2. КЕП-підпис голови: POST /api/proxy/payment/add-sign + GET /api/proxy/payment/get
 *   3. Проведення у виписці: GET /api/statements/transactions (TRANTYPE: 'D', DLR = bankRef)
 */
function buildPrivatPaymentApiLifecycle(payment = {}, options = {}) {
    const recipient = payment.recipient || {};
    const recipientIban = String(recipient.iban || '').replace(/\s+/g, '').toUpperCase();
    const recipientMfo = /^UA\d{8}/.test(recipientIban) ? recipientIban.slice(4, 10) : '305299';
    const isTreasury = recipientMfo === '899998' || payment.kind === 'tax';
    const docNumber = String(payment.docNumber || String(payment.id || '001').slice(-8)).toUpperCase();
    const packRef = String(payment.bankRef || `P24PACK-${docNumber}`);
    const paymentRef = String(payment.paymentRef || `P24DOC-${docNumber}`);
    const amountStr = ((Number(payment.amountKop || 0)) / 100).toFixed(2);
    const purpose = String(payment.purpose || '').trim();

    const createPayload = {
        document_number: docNumber.slice(0, 10),
        payer_account: String(payment.account || DEFAULT_SIM_ACCOUNTS[0].iban),
        recipient_name: String(recipient.name || '').slice(0, 38),
        recipient_nceo: String(recipient.code || ''),
        recipient_ifi: recipientMfo,
        recipient_account: recipientIban,
        payment_amount: amountStr,
        payment_Currency: 'UAH',
        payment_destination: isTreasury ? purpose.slice(0, 140) : purpose.slice(0, 160),
        payment_naming: String(payment.id || docNumber).slice(0, 30),
        ...(isTreasury ? {
            struct_code: '101',
            payer_ultmt_nceo: String(options.myEdrpou || '40562894'),
            payer_ultmt_name: String(options.myName || 'ОСББ «Успіх-25»').slice(0, 140)
        } : {})
    };

    const isPaid = payment.status === 'paid';
    const isFailed = payment.status === 'failed';
    const signStatusPayload = {
        payment_pack_ref: packRef,
        payment_ref: paymentRef,
        payment_data: {
            payment_status: isPaid ? 'проведений' : isFailed ? 'відхилений банком' : 'очікує підпису КЕП',
            signers: isPaid
                ? [{
                    level: '1',
                    fio: String(options.signerName || 'Голова правління ОСББ (КЕП)'),
                    state: 'підписано КЕП (Перший підпис)',
                    date: options.signedAt || new Date().toISOString()
                }]
                : []
        }
    };

    const statementTx = buildPrivatRawTransaction({
        account: payment.account || DEFAULT_SIM_ACCOUNTS[0].iban,
        direction: 'out',
        trantype: 'D',
        amountKop: payment.amountKop || 0,
        counterpartyName: recipient.name || '',
        counterpartyCode: recipient.code || '',
        counterpartyIban: recipientIban,
        purpose,
        date: options.date,
        time: options.time,
        ref: `P24OUT${docNumber}`,
        refn: '1',
        dlr: packRef,
        docNumber
    });

    return {
        endpoints: {
            create: 'POST https://acp.privatbank.ua/api/proxy/payment/create',
            addSign: 'POST https://acp.privatbank.ua/api/proxy/payment/add-sign',
            getStatus: 'GET https://acp.privatbank.ua/api/proxy/payment/get',
            statement: 'GET https://acp.privatbank.ua/api/statements/transactions'
        },
        createPayload,
        signStatusPayload,
        statementTx
    };
}

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

module.exports = {
    TENANT_STATUSES,
    ISOLATION_MODES,
    INSPECTABLE_COLLECTIONS,
    SIMULATION_SCENARIOS,
    BANK_SIM_TEMPLATES,
    DEFAULT_SIM_ACCOUNTS,
    IMMUTABLE_FIELDS,
    fmtKop,
    formatPrivatDateTime,
    buildPrivatRawTransaction,
    buildPrivatPaymentApiLifecycle,
    validEdrpouChecksum,
    normalizeTenantSlug,
    validateTenantInput,
    computePatchDiff,
    validateManualPatch,
    evaluateAccountingInvariants,
    summarizeUserActivity
};
