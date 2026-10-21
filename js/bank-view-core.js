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
const normName = v => String(v || '').toLowerCase().replace(/(?:тов|пп|фоп|прат|пат|ат|кб|кп|тзов|осбб|«|»|"|'|`|\.|,|-)/gi, ' ').replace(/\s+/g, ' ').trim();

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
                || String((tx.amountKop || 0) / 100).includes(q.replace(',', '.'));
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
    if (!tx) return null;
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
        const cleanCp = normName(cpName);
        if (cleanCp.length > 2) {
            matchedSupplier = (suppliers || []).find(s => {
                const cleanS = normName(s.name);
                return cleanS && (cleanS === cleanCp || cleanS.includes(cleanCp) || cleanCp.includes(cleanS));
            }) || null;
        }
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
    if (!matchedContract && extractedNum) {
        matchedContract = (contracts || []).find(c => String(c.number || '').toLowerCase() === extractedNum.toLowerCase()) || null;
    }
    if (!matchedContract && cpName.length > 2) {
        const cleanCp = normName(cpName);
        if (cleanCp.length > 2) {
            matchedContract = (contracts || []).find(c => {
                const cleanSup = normName(c.supplierName);
                return cleanSup && (cleanSup === cleanCp || cleanSup.includes(cleanCp) || cleanCp.includes(cleanSup));
            }) || null;
        }
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
