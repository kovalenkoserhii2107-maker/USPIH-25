// ============================================================
// «Банк»: операції за днями, розширені фільтри, категорії,
// спосіб розподілу (автоматично / вручну), визначення бухгалтерської
// проводки (Дт/Кт) та інтерактивних звʼязків (контрагент, договір,
// первинний документ, квартира).
// Тут немає ні мережі, ні DOM: тести — tests/unit/bank-view-core.test.mjs.
// ============================================================

export const TABS = { all: 'Усі', review: 'Потрібне рішення', done: 'Розподілені' };

export const DIRECTION_FILTERS = {
    all: 'Усі операції',
    in: '↓ Вхідні (+)',
    out: '↑ Вихідні (−)'
};

export const DATE_PRESETS = {
    all: 'Усі дати',
    today: 'Сьогодні',
    yesterday: 'Учора',
    week: '7 днів',
    month: 'Цей місяць'
};

export const BANK_CATEGORY_OPTIONS = {
    all: 'Усі категорії платежів',
    apt_payment: 'Платіж від квартири (внески)',
    rent: 'Оренда приміщень',
    equipment: 'Розміщення обладнання й реклами',
    interest: 'Відсотки банку',
    grant: 'Грант, співфінансування',
    sick_fund: 'Кошти ПФУ на лікарняні',
    income_other: 'Інше надходження',
    bank_fee: 'Комісія банку',
    supplier: 'Оплата постачальнику',
    salary: 'Зарплата працівникам',
    taxes: 'Податки (ПДФО, військовий збір)',
    esv: 'ЄСВ',
    advance: 'Авансовий звіт (рах. 372)',
    resident_refund: 'Повернення переплати співвласнику',
    supplier_refund: 'Повернення коштів від постачальника',
    internal: 'Переказ між власними рахунками',
    review: 'Нерозібрані (чекають рішення)',
    expense_other: 'Інша витрата'
};

const INCOME_LABELS = {
    rent: 'Оренда приміщень',
    equipment: 'Розміщення обладнання й реклами',
    interest: 'Відсотки банку',
    grant: 'Грант, співфінансування',
    refund: 'Повернення без привʼязки до списання',
    sick_fund: 'Кошти ПФУ на лікарняні',
    advance_return: 'Повернення залишку підзвітних коштів',
    other: 'Інше надходження'
};

const EXPENSE_LABELS = {
    bank_fee: 'Комісія банку',
    supplier: 'Оплата постачальнику',
    salary: 'Зарплата працівникам',
    taxes: 'Податки (ПДФО, військовий збір)',
    esv: 'Єдиний соціальний внесок (ЄСВ)',
    advance: 'Відшкодування за авансовим звітом',
    resident_refund: 'Повернення переплати співвласнику',
    other: 'Інша витрата'
};

const ACCOUNT_NAMES = {
    311: 'Поточні рахунки в національній валюті',
    313: 'Депозитні рахунки в банку',
    372: 'Розрахунки з підзвітними особами',
    377: 'Розрахунки зі співвласниками (внески)',
    378: 'Розрахунки з ПФУ (лікарняні)',
    48: 'Цільове фінансування і цільові надходження',
    631: 'Розрахунки з вітчизняними постачальниками',
    641: 'Розрахунки за податками (ПДФО, ВЗ)',
    651: 'Розрахунки за ЄСВ',
    661: 'Розрахунки за виплатами працівникам',
    685: 'Нерозібрані операції банку (до зʼясування)',
    719: 'Інші доходи від операційної діяльності',
    92: 'Адміністративні витрати (утримання будинку)'
};

/** Впевненість підказки «чия це оплата» — та сама шкала, що в «Рішеннях». */
const SURE = { 'імʼя власника': true, 'прізвище власника': true };

const asDate = at => (at?.toDate ? at.toDate() : at instanceof Date ? at : new Date(at));
const dayKey = d => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
const isoDay = d => {
    const dt = asDate(d);
    if (Number.isNaN(dt.getTime())) return '';
    const y = dt.getFullYear();
    const m = String(dt.getMonth() + 1).padStart(2, '0');
    const day = String(dt.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
};
const normIban = v => String(v || '').replace(/\s+/g, '').toUpperCase();
// Організаційна форма — лише окремим словом: «ат» у «Атлант» чи «тов» у «Товарна» не чіпаємо.
const LEGAL_FORMS = /(?<![\p{L}\d])(?:тов|пп|фоп|прат|пат|ат|кб|кп|тзов|осбб)(?![\p{L}\d])/gu;
export const normName = v => String(v || '').toLowerCase().replace(/\(демо\)/g, ' ').replace(/[«»"'`.,\-]/g, ' ')
    .replace(LEGAL_FORMS, ' ').replace(/\s+/g, ' ').trim();
/** Та сама організація: однакова назва або одна містить іншу цілими словами (від 4 літер). */
export function sameEntity(a, b) {
    const x = normName(a), y = normName(b);
    if (!x || !y) return false;
    if (x === y) return true;
    const [short, long] = x.length <= y.length ? [x, y] : [y, x];
    return short.length >= 4 && ` ${long} `.includes(` ${short} `);
}

/** «Сьогодні», «Учора» або «10 листопада» (рік — лише якщо не поточний). */
export function dayLabel(at, now = new Date()) {
    const d = asDate(at);
    const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
    if (dayKey(d) === dayKey(now)) return 'Сьогодні';
    if (dayKey(d) === dayKey(yesterday)) return 'Учора';
    return d.toLocaleDateString('uk-UA', { day: 'numeric', month: 'long', ...(d.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}) });
}

/** Операції, згруповані за днями (порядок — як у списку, від новіших). */
export function byDay(list, now = new Date()) {
    const out = [];
    for (const tx of list) {
        const label = dayLabel(tx.at, now);
        const last = out[out.length - 1];
        if (last?.label === label) last.rows.push(tx);
        else out.push({ label, rows: [tx] });
    }
    return out;
}

/**
 * Рішення в один дотик: надходження, для якого система знайшла рівно одну
 * квартиру. sure — підказка за іменем чи прізвищем власника («Так, кв. 7»),
 * інакше — питання («Це кв. 7?», з підтвердженням). Решта — у «Рішеннях».
 */
export function quickAssign(tx) {
    if (tx.status !== 'review' || tx.direction !== 'in' || tx.kind === 'income' || ['several', 'possible-refund'].includes(tx.reason) || tx.bankConflict || tx.bankVoided) return null;
    const s = tx.suggestions || [];
    if (s.length !== 1 || !s[0].apt) return null;
    return { apt: String(s[0].apt), sure: SURE[s[0].reason] === true };
}

/**
 * Визначає спосіб розподілу операції: автоматично системою чи вручну бухгалтером/головою.
 */
export function txDistributionInfo(tx) {
    if (!tx || tx.status === 'review' || tx.bankConflict) {
        return {
            mode: 'review',
            isAuto: null,
            label: 'Очікує рішення (не розподілено)',
            shortLabel: 'Очікує рішення',
            reason: 'потребує підтвердження бухгалтера',
            badgeCls: 'is-wait'
        };
    }
    if (tx.bankVoided) {
        return {
            mode: 'auto',
            isAuto: true,
            label: 'Сторновано банком автоматично',
            shortLabel: 'Автоматично',
            reason: 'за банківською випискою',
            badgeCls: 'is-auto'
        };
    }
    const isManual = tx.auto === false || tx.method === 'manual' || Boolean(tx.resolvedBy);
    if (isManual) {
        const who = tx.resolvedBy ? `підтверджено: ${tx.resolvedBy}` : 'рішенням бухгалтера';
        return {
            mode: 'manual',
            isAuto: false,
            label: 'Розподілено вручну',
            shortLabel: 'Вручну',
            reason: who,
            badgeCls: 'is-manual'
        };
    }
    const reason = tx.method === 'account'
        ? 'за особовим рахунком'
        : tx.method === 'marked'
            ? 'за номером квартири в призначенні'
            : tx.method === 'link'
                ? 'за запамʼятованим платником'
                : tx.method === 'document'
                    ? 'за документом постачальника'
                    : tx.paymentId
                        ? 'за платіжним дорученням ОСББ'
                        : tx.kind === 'internal'
                            ? 'переказ між власними рахунками'
                            : 'за правилами розпізнавання виписки';
    return {
        mode: 'auto',
        isAuto: true,
        label: 'Розподілено автоматично',
        shortLabel: 'Автоматично',
        reason,
        badgeCls: 'is-auto'
    };
}

/** Визначає ключ категорії операції для фільтрації та відображення. */
export function txCategoryKey(tx) {
    if (!tx) return 'review';
    if (tx.status === 'review' || tx.bankConflict) return 'review';
    if (tx.kind === 'internal') return 'internal';
    if (tx.kind === 'payment') return 'apt_payment';
    if (tx.kind === 'refund') return 'supplier_refund';
    if (tx.kind === 'income') {
        if (tx.category === 'advance_return' || tx.advanceReportId) return 'advance';
        if (['rent', 'equipment', 'interest', 'grant', 'sick_fund'].includes(tx.category)) return tx.category;
        if (tx.category === 'refund') return 'supplier_refund';
        return 'income_other';
    }
    if (tx.direction === 'out' || tx.kind === 'expense') {
        if (tx.category === 'resident_refund') return 'resident_refund';
        if (tx.category === 'advance' || tx.advanceReportId) return 'advance';
        if (tx.category === 'bank_fee') return 'bank_fee';
        if (tx.category === 'salary') return 'salary';
        if (tx.category === 'taxes') return 'taxes';
        if (tx.category === 'esv') return 'esv';
        if (tx.category === 'supplier' || tx.expenseId) return 'supplier';
        return 'expense_other';
    }
    return 'review';
}

/** Повертає розгорнутий опис категорії операції для таблиці та модального вікна. */
export function txCategoryInfo(tx) {
    const key = txCategoryKey(tx);
    const apts = (tx?.allocations || []).map(a => a.apt).filter(Boolean);
    if (tx?.bankConflict) {
        return { key: 'review', label: 'Сторно банку — потрібна звірка', shortLabel: 'Сторно · звірка', badgeCls: 'is-review' };
    }
    if (tx?.bankVoided) {
        return { key, label: 'Сторновано банком (PR_PR="t")', shortLabel: 'Сторновано банком', badgeCls: 'is-internal' };
    }
    if (tx?.status === 'review') {
        const sApts = (tx.suggestions || []).map(s => s.apt).filter(Boolean);
        const hint = sApts.length ? ` (підказка: кв. № ${sApts.join(', ')})` : '';
        return { key: 'review', label: `Потрібне рішення бухгалтера${hint}`, shortLabel: 'Чекає рішення', badgeCls: 'is-review' };
    }
    if (key === 'apt_payment') {
        const label = apts.length === 1
            ? `Платіж від квартири № ${apts[0]}`
            : apts.length > 1
                ? `Платіж від квартир № ${apts.join(', ')}`
                : 'Платіж від співвласника (внесок)';
        const shortLabel = apts.length ? `Платіж від кв. № ${apts.join(', ')}` : 'Внесок';
        return { key, label, shortLabel, badgeCls: 'is-payment' };
    }
    if (key === 'resident_refund') {
        const apt = apts[0] || '';
        return {
            key,
            label: apt ? `Повернення переплати співвласнику (кв. № ${apt})` : 'Повернення переплати співвласнику',
            shortLabel: apt ? `Повернення переплати, кв. ${apt}` : 'Повернення переплати',
            badgeCls: 'is-expense'
        };
    }
    if (key === 'internal') {
        return { key, label: 'Переказ між власними рахунками ОСББ', shortLabel: 'Між власними рахунками', badgeCls: 'is-internal' };
    }
    if (key === 'supplier_refund') {
        return { key, label: 'Повернення списаних коштів від постачальника', shortLabel: 'Повернення списаного', badgeCls: 'is-income' };
    }
    if (tx?.direction === 'in' || tx?.kind === 'income') {
        const label = INCOME_LABELS[tx?.category] || 'Інше надходження';
        return { key, label, shortLabel: label, badgeCls: 'is-income' };
    }
    const baseLabel = EXPENSE_LABELS[tx?.category] || (tx?.expenseId ? 'Оплата постачальнику за документом' : 'Витрата');
    const refundSuffix = (tx?.refundedKop || 0) > 0
        ? (tx.refundedKop >= tx.amountKop ? ' (повернено)' : ' (частково повернено)')
        : '';
    return {
        key,
        label: `${baseLabel}${refundSuffix}`,
        shortLabel: `${baseLabel}${refundSuffix}`,
        badgeCls: 'is-expense'
    };
}

/**
 * Відбір і пошук операцій:
 * підтримує як стандартний виклик filterTx(list, tab, query),
 * так і розширений обʼєкт filters:
 *   { direction, category, counterparty, account, datePreset, dateFrom, dateTo, amountMinKop, amountMaxKop }
 */
export function filterTx(list, tab = 'all', query = '', filters = {}, now = new Date()) {
    const q = String(query || '').trim().toLowerCase();
    const apt = q.replace(/^кв\.?\s*/, '');
    // «1 250,50» → «1250.50»: суму шукаємо так, як її пишуть у застосунку.
    const amountQ = /^[\d\s\u00a0]+(?:[.,]\d{0,2})?$/.test(q) ? q.replace(/[\s\u00a0]/g, '').replace(',', '.') : '';
    const dirFilter = filters?.direction && filters.direction !== 'all' ? filters.direction : '';
    const catFilter = filters?.category && filters.category !== 'all' ? filters.category : '';
    const cpFilter = String(filters?.counterparty || '').trim().toLowerCase();
    const accFilter = normIban(filters?.account || '');
    const preset = filters?.datePreset && filters.datePreset !== 'all' ? filters.datePreset : '';
    const dateFrom = String(filters?.dateFrom || '').trim();
    const dateTo = String(filters?.dateTo || '').trim();
    const minKop = Number.isFinite(filters?.amountMinKop) && filters.amountMinKop > 0 ? filters.amountMinKop : null;
    const maxKop = Number.isFinite(filters?.amountMaxKop) && filters.amountMaxKop > 0 ? filters.amountMaxKop : null;

    const todayIso = isoDay(now);
    const yesterdayIso = isoDay(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1));
    const weekAgoIso = isoDay(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6));
    const monthPrefix = todayIso.slice(0, 7);

    return (list || []).filter(tx => {
        // 1. Вкладка статусу
        const matchTab = tab === 'review'
            ? tx.status === 'review' || Boolean(tx.bankConflict)
            : tab === 'done'
                ? tx.status !== 'review' && !tx.bankConflict
                : true;
        if (!matchTab) return false;

        // 2. Текстовий пошук
        if (q) {
            const catInfo = txCategoryInfo(tx);
            const distInfo = txDistributionInfo(tx);
            const matchQuery = (tx.allocations || []).some(a => String(a.apt) === apt)
                || String(tx.counterparty?.name || '').toLowerCase().includes(q)
                || String(tx.counterparty?.code || '').toLowerCase().includes(q)
                || String(tx.counterparty?.account || '').toLowerCase().includes(q)
                || String(tx.purpose || '').toLowerCase().includes(q)
                || String(catInfo.label || '').toLowerCase().includes(q)
                || String(distInfo.label || '').toLowerCase().includes(q)
                || (amountQ && [((tx.amountKop || 0) / 100).toFixed(2), String((tx.amountKop || 0) / 100)].some(v => v.includes(amountQ)));
            if (!matchQuery) return false;
        }

        // 3. Напрямок (вхідний / вихідний)
        if (dirFilter && tx.direction !== dirFilter) return false;

        // 4. Категорія платежу
        if (catFilter && txCategoryKey(tx) !== catFilter) return false;

        // 5. Контрагент / платник
        if (cpFilter) {
            const cpApt = cpFilter.replace(/^кв\.?\s*/, '');
            const cpMatch = String(tx.counterparty?.name || '').toLowerCase().includes(cpFilter)
                || String(tx.counterparty?.code || '').toLowerCase().includes(cpFilter)
                || String(tx.counterparty?.account || '').toLowerCase().includes(cpFilter)
                || (tx.allocations || []).some(a => String(a.apt).toLowerCase() === cpApt);
            if (!cpMatch) return false;
        }

        // 6. Рахунок ОСББ
        if (accFilter && normIban(tx.account) !== accFilter) return false;

        // 6а. Конкретний контрагент (з картки контрагента)
        if (filters?.cpKey && counterpartyKey(tx.counterparty) !== filters.cpKey) return false;

        // 7. Сума (від — до)
        if (minKop !== null && (tx.amountKop || 0) < minKop) return false;
        if (maxKop !== null && (tx.amountKop || 0) > maxKop) return false;

        // 8. Дата (пресет або діапазон З — По)
        if (preset || dateFrom || dateTo) {
            const txDay = isoDay(tx.at);
            if (!txDay) return false;
            if (preset === 'today' && txDay !== todayIso) return false;
            if (preset === 'yesterday' && txDay !== yesterdayIso) return false;
            if (preset === 'week' && (txDay < weekAgoIso || txDay > todayIso)) return false;
            if (preset === 'month' && !txDay.startsWith(monthPrefix)) return false;
            if (dateFrom && txDay < dateFrom) return false;
            if (dateTo && txDay > dateTo) return false;
        }

        return true;
    });
}

/**
 * Формує опис бухгалтерської проводки (Дт / Кт), до якої пішов платіж в обліку,
 * та параметри для прямого переходу в розділ «ОСВ / Проводки» (#journal).
 */
export function describeTxAccountingEntry(tx, { expenses = [], accounts = {} } = {}) {
    // Сторновану банком операцію журнал не проводить (journal-core) — і тут проводки не показуємо.
    if (!tx || tx.bankVoided) return null;
    const accObj = accounts?.[tx.account] || {};
    const cashAcc = accObj.purpose === 'deposit' ? '313' : '311';
    const period = tx.period || (tx.at ? isoDay(tx.at).slice(0, 7) : '');
    const cpName = tx.counterparty?.name || '';
    const apts = (tx.allocations || []).map(a => a.apt).filter(Boolean);

    let dr = '311';
    let cr = '685';
    let drAnalytics = '';
    let crAnalytics = '';
    let focusAcc = '311';
    let memo = tx.purpose || '';

    if (tx.direction === 'in') {
        dr = cashAcc;
        drAnalytics = tx.account || 'Поточний рахунок ОСББ';
        if (tx.kind === 'payment' && tx.status === 'done' && apts.length) {
            cr = '377';
            crAnalytics = `кв. № ${apts.join(', ')}`;
            focusAcc = '377';
            memo = `Оплата внесків співвласників (${crAnalytics})`;
        } else if (tx.kind === 'income' && tx.status === 'done' && (tx.category === 'advance_return' || tx.advanceReportId)) {
            cr = '372';
            crAnalytics = tx.personName || cpName || 'Підзвітна особа';
            focusAcc = '372';
            memo = 'Повернення залишку підзвітних коштів';
        } else if (tx.kind === 'income' && tx.status === 'done' && tx.category === 'sick_fund') {
            cr = '378';
            crAnalytics = 'ПФУ (лікарняні)';
            focusAcc = '378';
            memo = 'Фінансування лікарняних від ПФУ';
        } else if (tx.kind === 'income' && tx.status === 'done') {
            cr = '48';
            crAnalytics = INCOME_LABELS[tx.category] || 'Цільові надходження';
            focusAcc = '48';
            memo = `${INCOME_LABELS[tx.category] || 'Надходження'}: ${cpName}`;
        } else if (tx.kind === 'refund' && tx.status === 'done') {
            // Журнал кредитує рахунок початкового списання; тут — найчастіший випадок (постачальник).
            cr = '631';
            crAnalytics = cpName || 'Постачальник';
            focusAcc = '631';
            memo = `Повернення списаних коштів: ${cpName}`;
        } else if (tx.kind === 'internal') {
            cr = '311';
            crAnalytics = tx.counterparty?.account || 'Інший рахунок ОСББ';
            focusAcc = '311';
            memo = 'Переказ між власними рахунками ОСББ';
        } else {
            cr = '685';
            crAnalytics = 'Нерозібране надходження (очікує рішення)';
            focusAcc = '685';
        }
    } else {
        cr = cashAcc;
        crAnalytics = tx.account || 'Поточний рахунок ОСББ';
        if (tx.kind === 'internal') {
            dr = '311';
            drAnalytics = tx.counterparty?.account || 'Інший рахунок ОСББ';
            focusAcc = '311';
            memo = 'Переказ між власними рахунками ОСББ';
        } else if (tx.status === 'done' && tx.category === 'resident_refund') {
            dr = '377';
            drAnalytics = apts[0] ? `кв. № ${apts[0]}` : 'Співвласник';
            focusAcc = '377';
            memo = `Повернення переплати співвласнику (${drAnalytics})`;
        } else if (tx.status === 'done' && tx.category === 'salary') {
            dr = '661';
            drAnalytics = cpName || 'Працівники за відомістю';
            focusAcc = '661';
            memo = `Виплата заробітної плати: ${cpName}`;
        } else if (tx.status === 'done' && tx.category === 'taxes') {
            dr = '641';
            drAnalytics = 'ПДФО / Військовий збір';
            focusAcc = '641';
            memo = 'Сплата податків із зарплати (ПДФО / ВЗ)';
        } else if (tx.status === 'done' && tx.category === 'esv') {
            dr = '651';
            drAnalytics = 'ЄСВ (22%)';
            focusAcc = '651';
            memo = 'Сплата єдиного соціального внеску (ЄСВ)';
        } else if (tx.status === 'done' && (tx.category === 'advance' || tx.advanceReportId)) {
            dr = '372';
            drAnalytics = tx.personName || cpName || 'Підзвітна особа';
            focusAcc = '372';
            memo = 'Відшкодування витрат за авансовим звітом';
        } else if (tx.status === 'done' && (tx.expenseId || tx.category === 'supplier')) {
            const exp = tx.expenseId ? (expenses || []).find(e => e.id === tx.expenseId) : null;
            dr = '631';
            drAnalytics = exp?.supplierName || cpName || 'Постачальник';
            focusAcc = '631';
            memo = exp ? `Оплата за документом № ${exp.number || '—'} (${drAnalytics})` : `Оплата постачальнику: ${drAnalytics}`;
        } else if (tx.status === 'done') {
            dr = '92';
            drAnalytics = EXPENSE_LABELS[tx.category] || 'Утримання будинку';
            focusAcc = '92';
            memo = `${EXPENSE_LABELS[tx.category] || 'Витрата'}: ${cpName}`;
        } else {
            dr = '685';
            drAnalytics = 'Нерозібране списання (очікує рішення)';
            focusAcc = '685';
        }
    }

    return {
        dr,
        cr,
        drTitle: ACCOUNT_NAMES[dr] || `Рахунок ${dr}`,
        crTitle: ACCOUNT_NAMES[cr] || `Рахунок ${cr}`,
        drAnalytics,
        crAnalytics,
        codeText: `Дт ${dr} — Кт ${cr}`,
        humanText: `Дт ${dr} (${drAnalytics || ACCOUNT_NAMES[dr]}) → Кт ${cr} (${crAnalytics || ACCOUNT_NAMES[cr]})`,
        memo,
        period,
        focusAcc,
        cashAcc,
        ref: tx.id
    };
}

/**
 * Знаходить повʼязаного контрагента, договір, первинний документ та платіж у системі
 * для побудови інтерактивних посилань у модальному вікні операції.
 */
export function resolveTxLinks(tx, { expenses = [], contracts = [], suppliers = [], payments = [] } = {}) {
    if (!tx) return {};
    const cpName = String(tx.counterparty?.name || '').trim();
    const cpCode = String(tx.counterparty?.code || '').trim();
    const cpIban = normIban(tx.counterparty?.account || '');
    const apts = (tx.allocations || []).map(a => String(a.apt)).filter(Boolean);
    const suggestedApts = (tx.suggestions || []).map(s => String(s.apt)).filter(Boolean);

    // 1. Повʼязаний платіж та первинний документ витрат
    const paymentDoc = tx.paymentId
        ? (payments || []).find(p => p.id === tx.paymentId) || { id: tx.paymentId }
        : null;
    const expenseId = tx.expenseId || paymentDoc?.expenseId || null;
    const expenseDoc = expenseId
        ? (expenses || []).find(e => e.id === expenseId) || { id: expenseId }
        : null;

    // 2. Пошук контрагента в довіднику постачальників (suppliers)
    let matchedSupplier = null;
    if (expenseDoc?.supplierId) {
        matchedSupplier = (suppliers || []).find(s => s.id === expenseDoc.supplierId) || null;
    }
    if (!matchedSupplier && cpCode) {
        matchedSupplier = (suppliers || []).find(s => String(s.code || '').trim() === cpCode) || null;
    }
    if (!matchedSupplier && cpIban) {
        matchedSupplier = (suppliers || []).find(s => normIban(s.iban) === cpIban) || null;
    }
    if (!matchedSupplier && cpName.length > 2) {
        matchedSupplier = (suppliers || []).find(s => sameEntity(s.name, cpName)) || null;
    }

    // 3. Формуємо інтерактивне посилання для контрагента
    let counterpartyLink = null;
    if (tx.kind === 'payment' || tx.category === 'resident_refund' || apts.length > 0) {
        const targetApt = apts[0] || suggestedApts[0] || '';
        counterpartyLink = {
            kind: 'flat',
            apt: targetApt,
            allApts: apts.length ? apts : suggestedApts,
            name: cpName || (targetApt ? `Квартира № ${targetApt}` : 'Співвласник'),
            badge: targetApt ? `Квартира № ${targetApt}` : 'Квартири',
            hint: targetApt ? `Перейти до картки квартири № ${targetApt}` : 'Перейти до розділу «Квартири»'
        };
    } else if (tx.category === 'advance' || tx.category === 'advance_return' || tx.advanceReportId) {
        counterpartyLink = {
            kind: 'advance',
            id: tx.advanceReportId || '',
            name: cpName || tx.personName || 'Підзвітна особа',
            badge: 'Підзвітна особа (рах. 372)',
            hint: 'Перейти до авансового звіту підзвітної особи'
        };
    } else if (tx.category === 'salary' || paymentDoc?.payroll) {
        counterpartyLink = {
            kind: 'payroll',
            period: paymentDoc?.payroll?.period || tx.period || '',
            name: cpName || 'Штатний працівник',
            badge: 'Зарплатна відомість (рах. 661)',
            hint: 'Перейти до розрахунку зарплати працівника'
        };
    } else if (matchedSupplier) {
        counterpartyLink = {
            kind: 'supplier',
            id: matchedSupplier.id,
            name: matchedSupplier.name || cpName,
            code: matchedSupplier.code || cpCode,
            iban: matchedSupplier.iban || cpIban,
            badge: 'Контрагент у реєстрі',
            hint: `Перейти на сторінку контрагента «${matchedSupplier.name || cpName}» у довіднику`
        };
    } else {
        counterpartyLink = {
            kind: 'supplier',
            id: '',
            name: cpName || 'Контрагент',
            code: cpCode,
            iban: cpIban,
            badge: 'Картка контрагента',
            hint: `Відкрити сторінку контрагента «${cpName || 'Контрагент'}» у розділі «Постачальники»`
        };
    }

    // 4. Пошук договору (за документом, за постачальником або за номером/предметом у призначенні платежу)
    let matchedContract = null;
    if (expenseDoc?.contractId) {
        matchedContract = (contracts || []).find(c => c.id === expenseDoc.contractId) || null;
    }
    const purposeText = String(tx.purpose || '');
    const purposeNumberMatch = purposeText.match(/догов[оі]р\w*(?:\s+[а-яіїєґ«»"'-]+){0,3}\s*№\s*([A-Za-zА-Яа-яІіЇїЄєҐґ0-9\-_/]+)/i)
        || purposeText.match(/№\s*([A-Za-zА-Яа-яІіЇїЄєҐґ0-9\-_/]+)\s+від\s+(\d{2}\.\d{2}\.\d{4})/);
    const extractedNum = purposeNumberMatch ? purposeNumberMatch[1].trim() : '';
    const purposeDateMatch = purposeText.match(/від\s+(\d{2}\.\d{2}\.\d{4}|\d{4}-\d{2}-\d{2})/);
    const extractedDate = purposeDateMatch ? purposeDateMatch[1] : '';

    if (!matchedContract && matchedSupplier) {
        const supContracts = (contracts || []).filter(c => c.supplierId === matchedSupplier.id && c.status !== 'rejected');
        if (extractedNum) {
            matchedContract = supContracts.find(c => String(c.number || '').toLowerCase() === extractedNum.toLowerCase()) || null;
        }
        if (!matchedContract && supContracts.length) {
            matchedContract = supContracts.find(c => c.status === 'approved') || supContracts[0];
        }
    }
    // Без картки постачальника договір беремо лише того ж контрагента: «№ 1» є майже в кожного.
    if (!matchedContract && !matchedSupplier && cpName.length > 2) {
        const sameCp = (contracts || []).filter(c => c.status !== 'rejected' && sameEntity(c.supplierName, cpName));
        matchedContract = (extractedNum && sameCp.find(c => String(c.number || '').toLowerCase() === extractedNum.toLowerCase()))
            || sameCp.find(c => c.status === 'approved') || sameCp[0] || null;
    }

    let contractLink = null;
    if (matchedContract) {
        contractLink = {
            id: matchedContract.id,
            number: matchedContract.number || 'б/н',
            date: matchedContract.date || '',
            subject: matchedContract.subject || 'Договір з контрагентом',
            supplierId: matchedContract.supplierId || matchedSupplier?.id || '',
            supplierName: matchedContract.supplierName || cpName,
            inDatabase: true
        };
    } else if (/догов[оі]р|контракт|сервітут|оренд|акт\w*\s+№/i.test(purposeText) || tx.category === 'supplier' || tx.category === 'rent' || tx.category === 'equipment') {
        const subjMatch = purposeText.match(/за\s+(договором\s+[^,;]+?)(?:\s+за\s+[А-Яа-яІіЇїЄєҐґ]+\s+\d{4}\s*(?:р\.?|року)?|\s*,\s*без\s+пдв|\s*,\s*у\s+т\.?\s*ч\.?|$)/i);
        let subjectText = subjMatch ? subjMatch[1].trim() : (INCOME_LABELS[tx.category] || 'Договір з контрагентом');
        subjectText = subjectText
            .replace(/^договором(?=\s|$)/i, 'Договір')
            .replace(/\s+за\s+[А-Яа-яІіЇїЄєҐґ]+\s+\d{4}\s*(?:р\.?|року)?$/i, '')
            .trim();
        contractLink = {
            id: '',
            number: extractedNum || 'б/н',
            date: extractedDate || '',
            subject: subjectText,
            supplierId: matchedSupplier?.id || '',
            supplierName: matchedSupplier?.name || cpName,
            inDatabase: false
        };
    }

    return {
        counterpartyLink,
        contractLink,
        expenseDoc,
        paymentDoc,
        matchedSupplier
    };
}


// ------------------------------------------------------------
// ПІДСУМКИ РУХУ КОШТІВ
// ------------------------------------------------------------
const SUMMARY_SKIP = tx => tx.kind === 'internal' || tx.bankVoided;

/**
 * Надійшло / списано за відібрані операції з розбивкою за категоріями
 * (найбільші — першими). Перекази між власними рахунками й сторно банку
 * не рахуються: це не дохід і не витрата.
 */
export function bankSummary(list = []) {
    const out = { inKop: 0, outKop: 0, count: 0, internal: 0, inCats: [], outCats: [] };
    const cats = { in: new Map(), out: new Map() };
    for (const tx of list) {
        if (SUMMARY_SKIP(tx)) { out.internal++; continue; }
        const dir = tx.direction === 'out' ? 'out' : 'in';
        const kop = tx.amountKop || 0;
        out[`${dir}Kop`] += kop;
        out.count++;
        const key = txCategoryKey(tx);
        const c = cats[dir].get(key) || { key, label: BANK_CATEGORY_OPTIONS[key] || 'Інше', kop: 0, n: 0 };
        c.kop += kop; c.n++;
        cats[dir].set(key, c);
    }
    for (const dir of ['in', 'out']) {
        const total = out[`${dir}Kop`] || 1;
        out[`${dir}Cats`] = [...cats[dir].values()].sort((a, b) => b.kop - a.kop).map(c => ({ ...c, share: c.kop / total }));
    }
    out.netKop = out.inKop - out.outKop;
    return out;
}

// ------------------------------------------------------------
// КОНТРАГЕНТИ З ВИПИСКИ
// ------------------------------------------------------------
/** Ключ контрагента: код, інакше IBAN, інакше назва без організаційної форми. */
export function counterpartyKey(cp = {}) {
    const code = String(cp?.code || '').trim();
    if (/^\d{8,10}$/.test(code)) return `c:${code}`;
    const iban = normIban(cp?.account);
    if (iban) return `i:${iban}`;
    const name = normName(cp?.name);
    return name ? `n:${name}` : '';
}

/** Співвласники, працівники й власні перекази — не контрагенти: їх ведуть «Квартири» й «Зарплата». */
const PRIVATE = tx => tx.kind === 'payment' || tx.kind === 'internal' || ['resident_refund', 'salary'].includes(tx.category)
    || (tx.status === 'review' && tx.direction === 'in' && !/^\d{8,10}$/.test(String(tx.counterparty?.code || '')));

const ROLE = tx => {
    const key = ['taxes', 'esv', 'bank_fee', 'interest'].includes(tx.category) ? tx.category : txCategoryKey(tx);
    if (['taxes', 'esv'].includes(key)) return 'budget';
    if (['bank_fee', 'interest'].includes(key)) return 'bank';
    if (tx.direction === 'in') return 'income';
    return 'supplier';
};
export const CP_ROLES = { supplier: 'Постачальник', income: 'Платить ОСББ', budget: 'Бюджет', bank: 'Банк' };

/**
 * Контрагенти з операцій: обороти, остання операція, картка в довіднику.
 * Повертає від найбільшого обороту.
 */
export function counterparties(rows = [], suppliers = []) {
    const map = new Map();
    for (const tx of rows) {
        if (PRIVATE(tx) || tx.bankVoided) continue;
        const key = counterpartyKey(tx.counterparty);
        if (!key) continue;
        const g = map.get(key) || { key, name: '', code: '', iban: '', n: 0, inKop: 0, outKop: 0, lastAt: null, txIds: [], roles: new Map(), review: 0 };
        g.name ||= String(tx.counterparty?.name || '').trim();
        g.code ||= /^\d{8,10}$/.test(String(tx.counterparty?.code || '')) ? String(tx.counterparty.code) : '';
        g.iban ||= normIban(tx.counterparty?.account);
        g.n++;
        g[tx.direction === 'out' ? 'outKop' : 'inKop'] += tx.amountKop || 0;
        if (tx.status === 'review' || tx.bankConflict) g.review++;
        const at = asDate(tx.at);
        if (!g.lastAt || at > g.lastAt) g.lastAt = at;
        g.txIds.push(tx.id);
        const r = ROLE(tx);
        g.roles.set(r, (g.roles.get(r) || 0) + (tx.amountKop || 0));
        map.set(key, g);
    }
    return [...map.values()].map(g => {
        const supplier = (g.code && suppliers.find(s => String(s.code || '') === g.code))
            || (g.iban && suppliers.find(s => normIban(s.iban) === g.iban))
            || suppliers.find(s => sameEntity(s.name, g.name)) || null;
        const role = [...g.roles.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || 'supplier';
        const { roles, ...rest } = g;
        return { ...rest, role, supplier, checkable: /^\d{8}$|^\d{10}$/.test(g.code) };
    }).sort((a, b) => (b.inKop + b.outKop) - (a.inKop + a.outKop));
}

export const CP_FILTERS = { all: 'Усі', unknown: 'Без картки', risk: 'Є ризики', supplier: 'Постачальники', income: 'Платять ОСББ' };

/** Відбір контрагентів; risk — рівень, який розмітка вже обчислила ('bad' | 'warn' | ''). */
export function filterCounterparties(list = [], filter = 'all', query = '') {
    const q = String(query || '').trim().toLowerCase();
    return list.filter(c => {
        if (filter === 'unknown' && (c.supplier || c.role !== 'supplier')) return false;
        if (filter === 'risk' && !c.risk) return false;
        if (filter === 'supplier' && c.role !== 'supplier') return false;
        if (filter === 'income' && c.role !== 'income') return false;
        return !q || c.name.toLowerCase().includes(q) || c.code.includes(q) || c.iban.toLowerCase().includes(q);
    });
}

// ------------------------------------------------------------
// YOUCONTROL (YouScore): ДОСЬЄ КОНТРАГЕНТА
// ------------------------------------------------------------
const grnText = kop => `${Number(kop || 0).toLocaleString('uk-UA', { maximumFractionDigits: 2 })} грн`;
const kvedText = k => (typeof k === 'string' ? k.trim() : k && (k.code || k.name) ? `${k.code || ''} ${k.name || ''}`.trim() : '');
const isoToUa = v => (/^\d{4}-\d{2}-\d{2}/.test(String(v || '')) ? String(v).slice(0, 10).split('-').reverse().join('.') : String(v || ''));

/**
 * Досьє з відповіді checkSupplier (YouScore) у вигляді для картки:
 * { level: 'ok'|'warn'|'bad'|'wait', title, facts: [[назва, значення]], flags: [{ level, text }], sandbox }.
 */
const LEGAL_PHRASES = /товариство з обмеженою відповідальністю|фізична особа[\s—-]*підприємець|приватне акціонерне товариство|акціонерне товариство|приватне підприємство|комунальне підприємство/giu;
const sameName = (a, b) => sameEntity(String(a || '').replace(LEGAL_PHRASES, ' '), String(b || '').replace(LEGAL_PHRASES, ' '));

/** expectedName — назва платника з виписки: якщо в ЄДР інша, код, ймовірно, чужий. */
export function dossierView(d, expectedName = '') {
    if (!d) return null;
    if (!d.found) {
        return d.needRetry
            ? { level: 'wait', title: 'Реєстр ще готує відповідь — перевірте ще раз за хвилину', facts: [], flags: [], sandbox: Boolean(d.sandbox) }
            : { level: 'bad', title: 'У ЄДР за цим кодом нічого не знайдено', facts: [], flags: [], sandbox: Boolean(d.sandbox) };
    }
    const enf = Number(d.totalEnforcements ?? d.enforcementTotal ?? 0);
    const open = Number(d.openPenalties || 0);
    const facts = [
        ['Стан у ЄДР', d.stateText || (d.isRegistered ? 'Зареєстровано' : '')],
        ['Керівник', d.director],
        ['Оподаткування', d.taxSystem || d.taxSummary],
        ['Код платника ПДВ', d.vatCode],
        ['Дата реєстрації', isoToUa(d.registrationDate)],
        ['Основний КВЕД', kvedText(d.mainKved) || kvedText((d.kveds || [])[0])],
        ['Податковий борг', Number(d.taxDebtTotal || 0) > 0 ? grnText(d.taxDebtTotal) : 'немає'],
        ['Виконавчі провадження', enf || open ? `${open} відкритих з ${Math.max(enf, open)}` : 'немає'],
        ['Судові документи', d.courtTotal ? String(d.courtTotal) : 'немає'],
        ['Експрес-оцінка', d.expressIndex ? String(d.expressIndex) : '']
    ].filter(([, v]) => String(v || '').trim());
    const flags = (d.riskFlags || []).map(text => ({ level: /борг|банкрут|припин|скасов|ліквід|1-ї групи|2-ї групи/i.test(text) ? 'bad' : 'warn', text }));
    if (expectedName && ![d.name, d.shortName, d.fullName].some(n => sameName(n, expectedName))) {
        flags.unshift({ level: 'warn', text: `Назва в ЄДР не збігається з платником у виписці — перевірте код` });
    }
    if (d.hasSanctions) flags.unshift({ level: 'bad', text: 'Під санкціями' });
    if (d.isAggressor) flags.unshift({ level: 'bad', text: 'Повʼязаний з державою-агресором' });
    const level = !d.isRegistered || flags.some(f => f.level === 'bad') ? 'bad' : flags.length ? 'warn' : 'ok';
    return {
        level,
        title: level === 'ok' ? 'Ризиків не виявлено' : level === 'warn' ? 'Є на що звернути увагу' : 'Високий ризик — перевірте перед оплатою',
        name: d.fullName || d.name || '',
        facts,
        flags,
        sandbox: Boolean(d.sandbox)
    };
}

/** Дані для форми постачальника з досьє YouScore (поверх наявної картки, якщо вона є). */
export function supplierDraft(d, cp = {}, existing = null) {
    const code = String(d?.edrpou || cp.code || '');
    return {
        ...(existing || {}),
        name: d?.shortName || d?.name || existing?.name || cp.name || '',
        fullName: d?.fullName || d?.name || existing?.fullName || '',
        legalForm: d?.legalForm || existing?.legalForm || (code.length === 10 ? 'ФІЗИЧНА ОСОБА — ПІДПРИЄМЕЦЬ' : ''),
        kind: code.length === 10 ? 'fop' : 'company',
        code,
        iban: existing?.iban || cp.iban || '',
        director: d?.director || existing?.director || '',
        address: d?.address || existing?.address || '',
        phone: d?.phone || d?.contacts?.phone || existing?.phone || '',
        email: d?.email || d?.contacts?.email || existing?.email || '',
        mainKved: kvedText(d?.mainKved) || kvedText((d?.kveds || [])[0]) || existing?.mainKved || '',
        taxSystem: d?.taxSystem || d?.taxSummary || existing?.taxSystem || '',
        vatCode: d?.vatCode || existing?.vatCode || '',
        registrationStatus: d?.stateText || existing?.registrationStatus || '',
        taxDebtTotal: Number(d?.taxDebtTotal || 0),
        openPenalties: Number(d?.openPenalties || 0),
        expressIndex: String(d?.expressIndex || existing?.expressIndex || '')
    };
}
