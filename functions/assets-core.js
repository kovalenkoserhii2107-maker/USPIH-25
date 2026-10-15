'use strict';
// ============================================================
// Основні засоби (ОЗ, МНМА) та ТМЦ (Виробничі запаси, МШП) ОСББ:
// класифікація, інвентарна книга, методи амортизації, складський
// і позабалансовий кількісний облік МШП в експлуатації, списання
// та ліквідація.
//
// НОРМАТИВНА БАЗА УКРАЇНИ ДЛЯ ОСББ:
//   1. Закон України «Про ОСББ» № 417-VIII та ст. 382 ЦКУ:
//      Спільне майно багатоквартирного будинку (ліфти, дах, мережі,
//      підвали) належить співвласникам, тому витрати на його ремонт
//      і утримання списуються одразу на рахунок 92. На баланс ОСББ
//      (рахунки 10, 11, 20, 22) зараховується виключно майно, яке
//      перебуває у власності самого ОСББ як юридичної особи
//      (генератори, мотопомпи, газонокосарки, оргтехніка, інструмент,
//      паливо для генератора, реагенти, будматеріали на складі).
//   2. НП(С)БО 7 «Основні засоби» та пп. 14.1.138 ПКУ:
//      • Рахунок 10 «Основні засоби» — строк служби > 12 міс.,
//        первісна вартість за одиницю > вартісного порогу МНМА
//        (за замовчуванням 20 000 грн згідно з пп. 14.1.138 ПКУ;
//        налаштовується в Обліковій політиці ОСББ).
//        Знос нараховується на рахунок 131 прямолінійним методом
//        починаючи з місяця, наступного за місяцем введення в
//        експлуатацію (п. 26, 29 НП(С)БО 7).
//      • Рахунок 11 «Інші необоротні матеріальні активи» (субрахунок
//        112 МНМА) — строк служби > 12 міс., вартість <= порогу
//        (20 000 грн). Знос нараховується на рахунок 132 методом
//        «100 % у першому місяці використання» або «50 % у першому
//        місяці та 50 % при списанні» (п. 27 НП(С)БО 7) чи прямолінійно.
//   3. НП(С)БО 9 «Запаси»:
//      • Рахунок 20 «Виробничі запаси» — паливо для генератора (203),
//        будматеріали (205), запчастини (207), реагенти й госпматеріали
//        (209). Списуються на рахунок 92 за актом за фактичним
//        використанням.
//      • Рахунок 22 «Малоцінні та швидкозношувані предмети» (МШП) —
//        інструмент, інвентар, спецодяг зі строком служби <= 12 міс.
//        При передачі в експлуатацію списуються з балансу (Дт 92 Кт 22),
//        але за п. 23 НП(С)БО 9 залишаються в оперативному кількісному
//        обліку за місцями експлуатації та матеріально відповідальними
//        особами (МВО) до фізичного зносу (ліквідації за актом).
//   4. НП(С)БО 15 «Дохід» (п. 17–19) та п. 133.4 ПКУ (неприбутковість):
//      При нарахуванні амортизації (Дт 92 Кт 131/132) та списанні ТМЦ/МШП
//      (Дт 92 Кт 20/22) одночасно визнається дохід від використання
//      цільового фінансування (Дт 48 Кт 719) у сумі визнаних витрат,
//      завдяки чому у Формі № 2-м/2-мс та Звіті неприбуткової організації
//      доходи завжди дорівнюють витратам (фінансовий результат = 0 грн).
//   5. Єдина система інвентарних / номенклатурних номерів:
//      • Автоматична нумерація за синтетичним рахунком:
//        10 → ОЗ-001, 11 → МНМА-001, 20 → ТМЦ-001, 22 → МШП-001.
//      • При міграції з попередньої системи обліку (вхідні залишки ОСВ)
//        у картці зберігається також старий інвентарний / номенклатурний
//        номер (`legacyId`), щоб обʼєкт знаходився і за новим єдиним
//        номером, і за старим номером з попередньої бухгалтерії.
// ============================================================

const DEFAULT_MNHMA_LIMIT_KOP = 2_000_000; // 20 000,00 грн (пп. 14.1.138 ПКУ)
const MAX_KOP = 100_000_000_000;

const ASSET_ACCOUNTS = {
    10: 'Основні засоби (ОЗ)',
    11: 'Малоцінні необоротні матеріальні активи (МНМА)',
    20: 'Виробничі запаси (паливо, будматеріали, запчастини)',
    22: 'Малоцінні та швидкозношувані предмети (МШП)'
};

const ASSET_SUBACCOUNTS = {
    104: { acc: '10', title: '104 · Машини та обладнання (генератори, помпи, теплопункти)' },
    106: { acc: '10', title: '106 · Інструменти, прилади та інвентар (понад поріг МНМА)' },
    109: { acc: '10', title: '109 · Інші основні засоби (системи відеонагляду, огорожі)' },
    112: { acc: '11', title: '112 · Малоцінні необоротні матеріальні активи (МНМА)' },
    203: { acc: '20', title: '203 · Паливо та ПММ (бензин, дизель, мастило для генератора)' },
    205: { acc: '20', title: '205 · Будівельні матеріали (фарба, суміші, труби, кабелі)' },
    207: { acc: '20', title: '207 · Запасні частини та комплектуючі (лампи, автомати, замки)' },
    209: { acc: '20', title: '209 · Інші матеріали (сіль, пісок, реагенти, мийні засоби)' },
    22:  { acc: '22', title: '22 · Малоцінні та швидкозношувані предмети (інвентар, спецодяг)' }
};

const DEPR_METHODS = {
    straight: 'Прямолінійний (рівномірно щомісяця — п. 26 НП(С)БО 7)',
    mnhma_100: '100 % у першому місяці використання (для МНМА — п. 27 НП(С)БО 7)',
    mnhma_50_50: '50 % у першому місяці та 50 % при списанні (для МНМА — п. 27 НП(С)БО 7)'
};

const UNITS = ['шт.', 'компл.', 'л', 'кг', 'м', 'м²', 'м³', 'упак.', 'рул.', 'п.м.'];

const ASSET_STATUS_LABELS = {
    uncommissioned: ['Очікує введення (ОЗ-1)', 'is-review'],
    active: ['В експлуатації', 'is-payment'],
    fully_depreciated: ['Замортизовано (в експл.)', 'is-done'],
    in_stock: ['На складі', 'is-payment'],
    in_use_offbalance: ['В експлуатації (позабаланс МВО)', 'is-done'],
    disposed: ['Списано / ліквідовано', '']
};

const validDate = d => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(d || ''))) return false;
    const dt = new Date(`${d}T00:00:00Z`);
    return !Number.isNaN(dt.getTime()) && dt.toISOString().slice(0, 10) === d;
};
const validPeriod = p => /^\d{4}-(0[1-9]|1[0-2])$/.test(String(p || ''));
const lastDayOfPeriod = p => {
    const [y, m] = String(p).split('-').map(Number);
    return `${p}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`;
};
const isNonCurrent = acc => acc === '10' || acc === '11';
const isInventory = acc => acc === '20' || acc === '22';
const wearAccountFor = acc => (acc === '10' ? '131' : acc === '11' ? '132' : null);
const defaultSubacc = acc => (acc === '10' ? '104' : acc === '11' ? '112' : acc === '20' ? '209' : '22');
const defaultDeprMethod = acc => (acc === '10' ? 'straight' : acc === '11' ? 'mnhma_100' : null);

const UNIFIED_ID_RE = /^(ОЗ|МНМА|ТМЦ|МШП)-\d{1,6}$/i;
const isUnifiedAssetId = id => UNIFIED_ID_RE.test(String(id || '').trim());

function recommendClassification({ unitCostKop = 0, usefulLifeMonths = 12, consumable = false, mnhmaLimitKop = DEFAULT_MNHMA_LIMIT_KOP } = {}) {
    if (consumable) {
        return {
            acc: '20',
            subacc: '209',
            deprMethod: null,
            reason: 'Витратні матеріали (паливо, запчастини, реагенти, будматеріали) обліковуються на рахунку 20 «Виробничі запаси» (НП(С)БО 9).'
        };
    }
    if (Number(usefulLifeMonths) <= 12) {
        return {
            acc: '22',
            subacc: '22',
            deprMethod: null,
            reason: 'Предмети зі строком служби до 1 року включно обліковуються як МШП на рахунку 22 і списуються при видачі в роботу зі збереженням кількісного обліку за МВО (п. 23 НП(С)БО 9).'
        };
    }
    if (Number(unitCostKop) > Number(mnhmaLimitKop || DEFAULT_MNHMA_LIMIT_KOP)) {
        return {
            acc: '10',
            subacc: '104',
            deprMethod: 'straight',
            reason: `Строк служби понад 1 рік і вартість понад ${(mnhmaLimitKop / 100).toLocaleString('uk-UA')} грн — це Основний засіб (рахунок 10, прямолінійна амортизація на 131 з наступного місяця після введення в експлуатацію, п. 26, 29 НП(С)БО 7).`
        };
    }
    return {
        acc: '11',
        subacc: '112',
        deprMethod: 'mnhma_100',
        reason: `Строк служби понад 1 рік і вартість до ${(mnhmaLimitKop / 100).toLocaleString('uk-UA')} грн включно — це МНМА (рахунок 11, субрахунок 112; знос на рахунок 132 методом 100 % або 50 %/50 %, п. 27 НП(С)БО 7).`
    };
}

function suggestAssetId(acc, existingIds = []) {
    const prefix = String(acc) === '10' ? 'ОЗ-' : String(acc) === '11' ? 'МНМА-' : String(acc) === '22' ? 'МШП-' : 'ТМЦ-';
    const used = new Set();
    for (const item of existingIds || []) {
        if (!item) continue;
        if (typeof item === 'object') {
            if (item.id) used.add(String(item.id).trim().toUpperCase());
            if (item.legacyId) used.add(String(item.legacyId).trim().toUpperCase());
            if (item.assetId) used.add(String(item.assetId).trim().toUpperCase());
        } else {
            used.add(String(item).trim().toUpperCase());
        }
    }
    let maxNum = 0;
    for (const id of used) {
        if (id.startsWith(prefix)) {
            const tail = id.slice(prefix.length);
            if (/^\d+$/.test(tail)) {
                const n = Number(tail);
                if (Number.isInteger(n) && n > maxNum) maxNum = n;
            }
        }
    }
    for (let next = maxNum + 1; next < 100000; next++) {
        const candidate = `${prefix}${String(next).padStart(3, '0')}`;
        if (!used.has(candidate)) return candidate;
    }
    return `${prefix}${Date.now().toString().slice(-4)}`;
}

/**
 * Збирає всі вже зайняті інвентарні та номенклатурні коди з карток,
 * вхідних залишків ОСВ, документів постачальників, бухгалтерських довідок
 * та авансових звітів для єдиної наскрізної нумерації без дублів.
 */
function collectExistingAssetIds({
    assets = [],
    expenses = [],
    opening = null,
    adjustments = [],
    advanceReports = []
} = {}) {
    const out = new Set();
    const add = v => {
        const s = String(v || '').trim();
        if (s) out.add(s);
    };
    for (const a of assets || []) {
        add(a?.id);
        add(a?.legacyId);
    }
    for (const e of expenses || []) {
        if (e?.status !== 'canceled') add(e?.assetId);
    }
    for (const l of opening?.lines || []) {
        if (['10', '11', '20', '22', '131', '132'].includes(String(l?.acc || ''))) add(l?.a);
    }
    for (const n of adjustments || []) {
        if (['10', '11', '20', '22'].includes(String(n?.assetAcc || ''))) add(n?.analytic);
        for (const l of n?.lines || []) {
            if (['10', '11', '20', '22', '131', '132'].includes(String(l?.dr || ''))) add(l?.dA);
            if (['10', '11', '20', '22', '131', '132'].includes(String(l?.cr || ''))) add(l?.cA);
        }
    }
    for (const r of advanceReports || []) {
        if (r?.status === 'rejected') continue;
        for (const l of r?.lines || []) {
            if (l?.postingAcc && l.postingAcc !== '92') add(l?.assetId);
        }
    }
    return [...out];
}

function checkAssetCard(card) {
    const id = String(card?.id || '').trim();
    if (id.length < 2 || id.length > 80) return 'Вкажіть інвентарний або номенклатурний код (від 2 до 80 символів, напр. ОЗ-001)';
    const legacyId = String(card?.legacyId || '').trim();
    if (legacyId.length > 80) return 'Старий інвентарний номер не може перевищувати 80 символів';
    const acc = String(card?.acc || '');
    if (!ASSET_ACCOUNTS[acc]) return 'Оберіть рахунок обліку: 10 (ОЗ), 11 (МНМА), 20 (Запаси) або 22 (МШП)';
    const name = String(card?.name || '').trim();
    if (name.length < 2 || name.length > 200) return 'Вкажіть назву обʼєкта або ТМЦ (від 2 до 200 символів)';
    if (card?.subacc && (!ASSET_SUBACCOUNTS[card.subacc] || ASSET_SUBACCOUNTS[card.subacc].acc !== acc)) {
        return 'Субрахунок не відповідає обраному синтетичному рахунку';
    }
    if (isNonCurrent(acc)) {
        const method = card?.deprMethod || defaultDeprMethod(acc);
        if (!DEPR_METHODS[method]) return 'Оберіть метод нарахування амортизації';
        if (acc === '10' && method !== 'straight') return 'Для основних засобів (рахунок 10) застосовується прямолінійний метод амортизації (п. 26 НП(С)БО 7)';
        if (method === 'straight') {
            const months = Number(card?.usefulLifeMonths);
            if (!Number.isInteger(months) || months < 1 || months > 600) {
                return 'Для прямолінійного методу вкажіть строк корисного використання в місяцях (напр. 36 або 60 міс.)';
            }
        }
        const salvage = Number(card?.salvageKop || 0);
        if (!Number.isInteger(salvage) || salvage < 0 || salvage > MAX_KOP) return 'Ліквідаційна вартість має бути цілим невідʼємним числом';
        if (card?.commissionedDate && !validDate(card.commissionedDate)) return 'Некоректна дата введення в експлуатацію';
    } else {
        const qty = Number(card?.initialQty ?? 1);
        if (!Number.isFinite(qty) || qty <= 0 || qty > 1_000_000) return 'Кількість ТМЦ має бути додатною';
    }
    return null;
}

function monthlyDepreciationFor(asset, period) {
    if (!validPeriod(period) || !isNonCurrent(asset?.acc)) return 0;
    const costKop = Number(asset?.costKop || 0);
    const salvageKop = Math.max(0, Math.min(costKop, Number(asset?.salvageKop || 0)));
    const depreciableKop = Math.max(0, costKop - salvageKop);
    const wearBeforeKop = Number(asset?.wearBeforePeriodKop ?? asset?.wearKop ?? 0);
    const alreadyInPeriodKop = Number(asset?.deprThisPeriodKop || 0);
    if (costKop <= 0 || depreciableKop <= 0) return 0;
    if (alreadyInPeriodKop > 0) return 0;
    if (asset?.disposedDate && asset.disposedDate.slice(0, 7) <= period) return 0;

    const commDate = String(asset?.commissionedDate || '').trim();
    if (!validDate(commDate)) return 0;
    const commPeriod = commDate.slice(0, 7);

    const remainingDepreciable = Math.max(0, depreciableKop - wearBeforeKop);
    if (remainingDepreciable <= 0) return 0;

    const method = asset?.deprMethod || defaultDeprMethod(asset.acc);
    if (method === 'mnhma_100') {
        if (period < commPeriod) return 0;
        return remainingDepreciable;
    }
    if (method === 'mnhma_50_50') {
        if (period < commPeriod) return 0;
        const firstHalf = Math.round(depreciableKop / 2);
        if (wearBeforeKop < firstHalf) return Math.min(remainingDepreciable, firstHalf - wearBeforeKop);
        return 0;
    }
    if (period <= commPeriod) return 0;
    const months = Math.max(1, Number(asset?.usefulLifeMonths || 36));
    const monthly = Math.max(1, Math.round(depreciableKop / months));
    return Math.min(remainingDepreciable, monthly);
}

function reconcileAssets({
    assets = [],
    expenses = [],
    opening = null,
    adjustments = [],
    policy = null,
    period = '9999-12'
} = {}) {
    const mnhmaLimitKop = Number(policy?.mnhmaLimitKop || DEFAULT_MNHMA_LIMIT_KOP);
    const defaultFund = policy?.defaultFund || 'main';
    const byId = new Map();
    const byLegacyId = new Map();
    const usedIds = new Set(collectExistingAssetIds({ assets, expenses, opening, adjustments }).map(x => String(x).toUpperCase()));

    const createBlank = (id, fallbackAcc = '10', legacyId = '') => {
        const acc = ASSET_ACCOUNTS[fallbackAcc] ? fallbackAcc : '10';
        return {
            id,
            legacyId: String(legacyId || '').trim(),
            acc,
            subacc: defaultSubacc(acc),
            name: id,
            item: 'systems',
            fundId: defaultFund,
            supplierName: '',
            acquiredDate: '',
            commissionedDate: '',
            commissionActNo: '',
            disposedDate: '',
            disposalActNo: '',
            disposalReason: '',
            usefulLifeMonths: acc === '10' ? 60 : acc === '11' ? 36 : 12,
            deprMethod: defaultDeprMethod(acc),
            salvageKop: 0,
            unit: 'шт.',
            initialQty: 0,
            addedQtyFromMeta: false,
            writtenOffQty: 0,
            retiredQty: 0,
            custodian: '',
            location: '',
            serialNumber: '',
            passportNote: '',
            acquiredCostKop: 0,
            disposedCostKop: 0,
            wearBeforePeriodKop: 0,
            deprThisPeriodKop: 0,
            disposedWearKop: 0,
            inventoryWriteOffKop: 0,
            history: [],
            sourceDocs: []
        };
    };

    const ensure = (rawCode, fallbackAcc = '10', { fromOpening = false, memo = '' } = {}) => {
        const code = String(rawCode || '').trim();
        if (!code) return null;
        if (byId.has(code)) return byId.get(code);
        if (byLegacyId.has(code)) return byLegacyId.get(code);

        const acc = ASSET_ACCOUNTS[fallbackAcc] ? fallbackAcc : '10';
        // Якщо обʼєкт прийшов із вхідних залишків (міграції з попередньої системи обліку)
        // зі старим неєдиним кодом (напр. «Інв-15», «00042», «Генератор»),
        // автоматично присвоюємо йому єдиний інвентарний номер (ОЗ-001 / МНМА-001 / ТМЦ-001 / МШП-001),
        // а старий номер зберігаємо в legacyId, щоб знаходити і так, і так.
        if (fromOpening && !isUnifiedAssetId(code)) {
            const unifiedId = suggestAssetId(acc, [...usedIds]);
            usedIds.add(unifiedId.toUpperCase());
            usedIds.add(code.toUpperCase());
            const card = createBlank(unifiedId, acc, code);
            card.name = memo ? String(memo).trim() : code;
            byId.set(unifiedId, card);
            byLegacyId.set(code, card);
            return card;
        }

        usedIds.add(code.toUpperCase());
        const card = createBlank(code, acc, '');
        byId.set(code, card);
        return card;
    };

    for (const meta of assets || []) {
        if (!meta?.id) continue;
        const rawId = String(meta.id).trim();
        const rawLegacy = String(meta.legacyId || '').trim();
        const acc = meta.acc && ASSET_ACCOUNTS[meta.acc] ? meta.acc : '10';
        let card = byId.get(rawId) || (rawLegacy ? byLegacyId.get(rawLegacy) : null);
        if (!card) {
            card = createBlank(rawId, acc, rawLegacy);
            byId.set(rawId, card);
        }
        card.acc = acc;
        if (rawLegacy) {
            card.legacyId = rawLegacy;
            byLegacyId.set(rawLegacy, card);
        } else if (!isUnifiedAssetId(rawId)) {
            // Якщо картку імпортовано зі старим кодом як id — фіксуємо його і в legacyId для подвійного пошуку
            card.legacyId = rawId;
            byLegacyId.set(rawId, card);
        }
        card.subacc = meta.subacc && ASSET_SUBACCOUNTS[meta.subacc]?.acc === card.acc ? meta.subacc : defaultSubacc(card.acc);
        if (meta.name) card.name = String(meta.name).trim();
        if (meta.item) card.item = String(meta.item).trim();
        if (meta.fundId) card.fundId = String(meta.fundId).trim();
        if (meta.supplierName) card.supplierName = String(meta.supplierName).trim();
        if (meta.acquiredDate) card.acquiredDate = String(meta.acquiredDate).trim();
        if (meta.commissionedDate) card.commissionedDate = String(meta.commissionedDate).trim();
        if (meta.commissionActNo) card.commissionActNo = String(meta.commissionActNo).trim();
        if (meta.disposedDate) card.disposedDate = String(meta.disposedDate).trim();
        if (meta.disposalActNo) card.disposalActNo = String(meta.disposalActNo).trim();
        if (meta.disposalReason) card.disposalReason = String(meta.disposalReason).trim();
        if (Number.isInteger(Number(meta.usefulLifeMonths)) && Number(meta.usefulLifeMonths) > 0) {
            card.usefulLifeMonths = Number(meta.usefulLifeMonths);
        }
        if (meta.deprMethod && DEPR_METHODS[meta.deprMethod]) card.deprMethod = meta.deprMethod;
        if (Number.isInteger(Number(meta.salvageKop)) && Number(meta.salvageKop) >= 0) card.salvageKop = Number(meta.salvageKop);
        if (meta.unit) card.unit = String(meta.unit).trim();
        if (Number(meta.initialQty) > 0) {
            card.initialQty = Number(meta.initialQty);
            card.addedQtyFromMeta = true;
        }
        if (Number(meta.retiredQty) > 0) card.retiredQty = Number(meta.retiredQty);
        if (meta.custodian) card.custodian = String(meta.custodian).trim();
        if (meta.location) card.location = String(meta.location).trim();
        if (meta.serialNumber) card.serialNumber = String(meta.serialNumber).trim();
        if (meta.passportNote) card.passportNote = String(meta.passportNote).trim();
        if (Array.isArray(meta.retirementActs)) card.retirementActs = meta.retirementActs;
    }

    if (opening?.status === 'approved' && Array.isArray(opening.lines)) {
        // Спершу обробляємо основні рахунки 10, 11, 20, 22, а потім знос 131, 132,
        // щоб знос гарантовано привʼязався до створеної картки за старим чи новим номером.
        const sortedOpening = [...opening.lines].sort((x, y) => {
            const xWear = x?.acc === '131' || x?.acc === '132' ? 1 : 0;
            const yWear = y?.acc === '131' || y?.acc === '132' ? 1 : 0;
            return xWear - yWear;
        });
        for (const l of sortedOpening) {
            const acc = String(l.acc || '');
            const a = String(l.a || '').trim();
            const kop = Number(l.kop || 0);
            if (!a || kop <= 0) continue;
            if (['10', '11', '20', '22'].includes(acc)) {
                const card = ensure(a, acc, { fromOpening: true, memo: l.memo });
                card.acc = acc;
                if (!isUnifiedAssetId(a) && !card.legacyId) {
                    card.legacyId = a;
                    byLegacyId.set(a, card);
                }
                card.subacc = ASSET_SUBACCOUNTS[card.subacc]?.acc === acc ? card.subacc : defaultSubacc(acc);
                const sign = l.side === 'cr' ? -1 : 1;
                card.acquiredCostKop += sign * kop;
                if (l.memo && (card.name === card.id || card.name === card.legacyId)) card.name = String(l.memo).trim();
                if (!card.acquiredDate && policy?.startDate) card.acquiredDate = policy.startDate;
                if (isNonCurrent(acc) && !card.commissionedDate && policy?.startDate) {
                    card.commissionedDate = policy.startDate;
                }
                if (isInventory(acc) && !card.addedQtyFromMeta) card.initialQty += 1;
                card.history.push({
                    date: policy?.startDate || '2026-09-30',
                    kind: 'opening',
                    title: `Вхідний залишок (${acc})${card.legacyId && card.legacyId !== card.id ? ` [стар. № ${card.legacyId}]` : ''}`,
                    amountKop: sign * kop
                });
            } else if (acc === '131' || acc === '132') {
                const targetAcc = acc === '131' ? '10' : '11';
                const card = ensure(a, targetAcc, { fromOpening: true, memo: l.memo });
                if (!isUnifiedAssetId(a) && !card.legacyId) {
                    card.legacyId = a;
                    byLegacyId.set(a, card);
                }
                const sign = l.side === 'dr' ? -1 : 1;
                card.wearBeforePeriodKop += sign * kop;
                card.history.push({
                    date: policy?.startDate || '2026-09-30',
                    kind: 'opening_wear',
                    title: `Вхідний накопичений знос (${acc})`,
                    amountKop: sign * kop
                });
            }
        }
    }

    for (const e of expenses || []) {
        if (!['approved', 'paid', 'storno'].includes(e.status)) continue;
        const acc = String(e.postingAcc || '92');
        if (!['10', '11', '20', '22'].includes(acc)) continue;
        if (e.period && e.period > period) continue;
        const assetId = String(e.assetId || '').trim();
        if (!assetId) continue;
        const card = ensure(assetId, acc);
        card.acc = acc;
        card.subacc = ASSET_SUBACCOUNTS[card.subacc]?.acc === acc ? card.subacc : defaultSubacc(acc);
        const kop = Number(e.amountKop || 0);
        card.acquiredCostKop += kop;
        if (e.description && (card.name === card.id || card.name === card.legacyId)) card.name = String(e.description).trim();
        if (e.item) card.item = e.item;
        if (e.fundId) card.fundId = e.fundId;
        if (e.supplierName && !card.supplierName) card.supplierName = e.supplierName;
        if (e.date && (!card.acquiredDate || e.date < card.acquiredDate)) card.acquiredDate = e.date;
        if (isInventory(acc) && !card.addedQtyFromMeta && kop > 0) {
            card.initialQty += Number(e.assetQty || 1);
        }
        card.sourceDocs.push({
            id: e.id,
            number: e.number,
            date: e.date,
            supplierName: e.supplierName || '',
            amountKop: kop
        });
        card.history.push({
            date: e.date || `${e.period}-01`,
            kind: kop >= 0 ? 'acquire' : 'storno',
            title: `${kop >= 0 ? 'Придбання' : 'Сторно'} за док. № ${e.number || '—'} (${e.supplierName || ''})`,
            amountKop: kop,
            ref: e.id
        });
    }

    for (const note of adjustments || []) {
        if (note.status !== 'approved') continue;
        if (note.period && note.period > period) continue;
        for (const line of note.lines || []) {
            const kop = Number(line.kop || 0);
            if (!kop) continue;
            if ((line.cr === '131' || line.cr === '132') && line.cA) {
                const targetAcc = line.cr === '131' ? '10' : '11';
                const card = ensure(line.cA, targetAcc);
                if (note.period === period) card.deprThisPeriodKop += kop;
                else card.wearBeforePeriodKop += kop;
                card.history.push({
                    date: note.date,
                    kind: 'depreciation',
                    title: note.note || `Нараховано амортизацію (${line.cr})`,
                    amountKop: kop,
                    ref: note.id
                });
            }
            if ((line.dr === '131' || line.dr === '132') && line.dA) {
                const targetAcc = line.dr === '131' ? '10' : '11';
                const card = ensure(line.dA, targetAcc);
                if (line.cr === '10' || line.cr === '11') {
                    card.disposedWearKop += kop;
                } else if (note.period === period) {
                    card.deprThisPeriodKop -= kop;
                } else {
                    card.wearBeforePeriodKop -= kop;
                }
            }
            if ((line.cr === '10' || line.cr === '11') && line.cA) {
                const card = ensure(line.cA, line.cr);
                card.disposedCostKop += kop;
                if (!card.disposedDate && note.date) card.disposedDate = note.date;
                if (!card.disposalActNo && note.source) card.disposalActNo = note.source;
                if (!card.disposalReason && note.note) card.disposalReason = note.note;
                card.history.push({
                    date: note.date,
                    kind: 'dispose',
                    title: note.note || `Списання з балансу (${line.cr})`,
                    amountKop: kop,
                    ref: note.id
                });
            }
            if (['10', '11', '20', '22'].includes(line.dr) && line.dA) {
                const card = ensure(line.dA, line.dr);
                card.acquiredCostKop += kop;
                card.history.push({
                    date: note.date,
                    kind: 'debit_note',
                    title: note.note || `Оприбуткування (${line.dr})`,
                    amountKop: kop,
                    ref: note.id
                });
            }
            if ((line.cr === '20' || line.cr === '22') && line.cA) {
                const card = ensure(line.cA, line.cr);
                card.inventoryWriteOffKop += kop;
                const qty = Number(note.qty || line.qty || 0);
                if (qty > 0) card.writtenOffQty += qty;
                card.history.push({
                    date: note.date,
                    kind: line.cr === '22' ? 'mshp_use' : 'inventory_writeoff',
                    title: note.note || (line.cr === '22' ? 'Передача МШП в експлуатацію' : 'Списання використаних запасів'),
                    amountKop: kop,
                    qty: qty || null,
                    ref: note.id
                });
            }
        }
    }

    const list = [];
    for (const card of byId.values()) {
        if (isNonCurrent(card.acc)) {
            const costKop = Math.max(0, card.acquiredCostKop - card.disposedCostKop);
            const wearKop = Math.max(0, card.wearBeforePeriodKop + card.deprThisPeriodKop - card.disposedWearKop);
            const netKop = Math.max(0, costKop - wearKop);
            card.costKop = costKop;
            card.wearKop = wearKop;
            card.netKop = netKop;
            card.deprMethod = card.deprMethod || defaultDeprMethod(card.acc);
            card.dueDeprKop = costKop > 0 ? monthlyDepreciationFor(card, period) : 0;
            card.monthlyDeprKop = card.deprMethod === 'straight'
                ? Math.min(Math.max(0, costKop - card.salvageKop), Math.max(1, Math.round(Math.max(0, costKop - card.salvageKop) / Math.max(1, card.usefulLifeMonths || 60))))
                : card.deprMethod === 'mnhma_50_50'
                    ? Math.round(Math.max(0, costKop - card.salvageKop) / 2)
                    : Math.max(0, costKop - card.salvageKop);
            card.wearPct = costKop > 0 ? Math.min(100, Math.round((wearKop / costKop) * 100)) : (card.disposedCostKop > 0 ? 100 : 0);

            if (costKop === 0 && (card.disposedCostKop > 0 || card.disposedDate)) {
                card.status = 'disposed';
            } else if (!card.commissionedDate) {
                card.status = 'uncommissioned';
            } else if (netKop <= card.salvageKop && costKop > 0) {
                card.status = 'fully_depreciated';
            } else {
                card.status = 'active';
            }
        } else {
            const costKop = Math.max(0, card.acquiredCostKop - card.inventoryWriteOffKop);
            const initialQty = card.initialQty > 0 ? card.initialQty : (card.acquiredCostKop > 0 ? 1 : 0);
            let writtenOffQty = card.writtenOffQty;
            if (writtenOffQty === 0 && card.inventoryWriteOffKop > 0 && card.acquiredCostKop > 0) {
                writtenOffQty = Number(((card.inventoryWriteOffKop / card.acquiredCostKop) * initialQty).toFixed(3));
            }
            const remainingQty = costKop === 0 ? 0 : Math.max(0, Number((initialQty - writtenOffQty).toFixed(3)));
            const inUseQty = card.acc === '22'
                ? Math.max(0, Number((writtenOffQty - (card.retiredQty || 0)).toFixed(3)))
                : 0;

            card.initialQty = initialQty;
            card.remainingQty = remainingQty;
            card.inUseQty = inUseQty;
            card.costKop = costKop;
            card.wearKop = 0;
            card.netKop = costKop;
            card.unitPriceKop = initialQty > 0 ? Math.round(card.acquiredCostKop / initialQty) : card.acquiredCostKop;
            card.dueDeprKop = 0;

            if (costKop > 0) {
                card.status = 'in_stock';
            } else if (card.acc === '22' && inUseQty > 0) {
                card.status = 'in_use_offbalance';
            } else {
                card.status = 'disposed';
            }
        }
        card.statusLabel = ASSET_STATUS_LABELS[card.status]?.[0] || card.status;
        card.statusClass = ASSET_STATUS_LABELS[card.status]?.[1] || '';
        card.history.sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
        card.thresholdWarning = null;
        if (card.acc === '10' && card.acquiredCostKop > 0 && card.acquiredCostKop <= mnhmaLimitKop) {
            card.thresholdWarning = `Первісна вартість (${(card.acquiredCostKop / 100).toFixed(2)} грн) не перевищує поріг МНМА (${(mnhmaLimitKop / 100).toFixed(0)} грн) — зазвичай такі обʼєкти обліковують на рахунку 11 (МНМА).`;
        } else if (card.acc === '11' && card.acquiredCostKop > mnhmaLimitKop) {
            card.thresholdWarning = `Первісна вартість (${(card.acquiredCostKop / 100).toFixed(2)} грн) перевищує поріг МНМА (${(mnhmaLimitKop / 100).toFixed(0)} грн) — рекомендується обліковувати на рахунку 10 (Основні засоби).`;
        }
        list.push(card);
    }

    list.sort((a, b) => a.acc.localeCompare(b.acc) || a.id.localeCompare(b.id, 'uk', { numeric: true }));

    const summary = {
        ozCount: list.filter(x => x.acc === '10' && x.status !== 'disposed').length,
        mnhmaCount: list.filter(x => x.acc === '11' && x.status !== 'disposed').length,
        uncommissionedCount: list.filter(x => isNonCurrent(x.acc) && x.status === 'uncommissioned' && x.costKop > 0).length,
        fixedCostKop: list.filter(x => isNonCurrent(x.acc)).reduce((s, x) => s + x.costKop, 0),
        fixedWearKop: list.filter(x => isNonCurrent(x.acc)).reduce((s, x) => s + x.wearKop, 0),
        fixedNetKop: list.filter(x => isNonCurrent(x.acc)).reduce((s, x) => s + x.netKop, 0),
        dueDeprKop: list.filter(x => isNonCurrent(x.acc)).reduce((s, x) => s + x.dueDeprKop, 0),
        dueDeprCount: list.filter(x => isNonCurrent(x.acc) && x.dueDeprKop > 0).length,
        deprThisPeriodKop: list.filter(x => isNonCurrent(x.acc)).reduce((s, x) => s + x.deprThisPeriodKop, 0),
        stock20Kop: list.filter(x => x.acc === '20').reduce((s, x) => s + x.costKop, 0),
        stock22Kop: list.filter(x => x.acc === '22').reduce((s, x) => s + x.costKop, 0),
        stockTotalKop: list.filter(x => isInventory(x.acc)).reduce((s, x) => s + x.costKop, 0),
        mshpInUseCards: list.filter(x => x.acc === '22' && x.inUseQty > 0).length,
        mshpInUseQty: Number(list.filter(x => x.acc === '22').reduce((s, x) => s + (x.inUseQty || 0), 0).toFixed(3))
    };

    return { items: list, summary, mnhmaLimitKop };
}

function planMonthlyDepreciation(reconciledItems, period) {
    if (!validPeriod(period)) return { date: '', period, lines: [], items: [], totalKop: 0 };
    const date = lastDayOfPeriod(period);
    const lines = [];
    const items = [];
    let totalKop = 0;

    for (const a of reconciledItems || []) {
        if (!isNonCurrent(a.acc)) continue;
        const kop = monthlyDepreciationFor(a, period);
        if (kop <= 0) continue;
        const cr = wearAccountFor(a.acc);
        const dA = a.item || 'systems';
        lines.push({
            dr: '92',
            cr,
            dA,
            cA: a.id,
            kop,
            fund: a.fundId || 'main'
        });
        items.push({
            id: a.id,
            legacyId: a.legacyId || '',
            name: a.name,
            acc: a.acc,
            wearAcc: cr,
            deprMethod: a.deprMethod,
            kop,
            fundId: a.fundId || 'main',
            item: dA
        });
        totalKop += kop;
    }
    return { date, period, lines, items, totalKop };
}

function planInventoryWriteOff(asset, { date, qty, item, actNo, reason, custodian, location } = {}) {
    if (!asset || !isInventory(asset.acc)) return { error: 'Оберіть картку запасів (20) або МШП (22)' };
    if (!validDate(date)) return { error: 'Вкажіть коректну дату акта списання' };
    if (asset.costKop <= 0 || asset.remainingQty <= 0) return { error: 'На складі немає залишку цього ТМЦ для списання' };
    const writeQty = Number(qty);
    if (!Number.isFinite(writeQty) || writeQty <= 0) return { error: 'Вкажіть кількість для списання / передачі в експлуатацію' };
    if (writeQty > asset.remainingQty + 1e-6) {
        return { error: `Не можна списати ${writeQty} ${asset.unit || 'шт.'}: на залишку лише ${asset.remainingQty} ${asset.unit || 'шт.'}` };
    }
    const cleanReason = String(reason || '').trim();
    if (cleanReason.length < 4) return { error: 'Опишіть напрям використання або причину списання (не менше 4 символів)' };
    const isFull = Math.abs(writeQty - asset.remainingQty) <= 1e-6;
    const kop = isFull
        ? asset.costKop
        : Math.max(1, Math.min(asset.costKop, Math.round((asset.costKop * writeQty) / asset.remainingQty)));
    const targetItem = String(item || asset.item || 'repair').trim();
    const period = date.slice(0, 7);
    const source = String(actNo || '').trim() || `Акт списання ТМЦ від ${date.split('-').reverse().join('.')}`;
    const note = asset.acc === '22'
        ? `Передача МШП в експлуатацію (${asset.name}, ${writeQty} ${asset.unit || 'шт.'}${custodian || asset.custodian ? `, МВО: ${custodian || asset.custodian}` : ''}): ${cleanReason}`
        : `Списання використаних запасів (${asset.name}, ${writeQty} ${asset.unit || 'шт.'}): ${cleanReason}`;

    return {
        error: null,
        date,
        period,
        amountKop: kop,
        qty: Number(writeQty.toFixed(3)),
        source,
        note,
        custodian: String(custodian || asset.custodian || '').trim(),
        location: String(location || asset.location || '').trim(),
        line: {
            dr: '92',
            cr: asset.acc,
            dA: targetItem,
            cA: asset.id,
            kop,
            qty: Number(writeQty.toFixed(3)),
            fund: asset.fundId || 'main'
        }
    };
}

function planAssetDisposal(asset, { date, actNo, reason } = {}) {
    if (!asset || !isNonCurrent(asset.acc)) return { error: 'Оберіть обʼєкт основних засобів (10) або МНМА (11)' };
    if (!validDate(date)) return { error: 'Вкажіть дату Акта на списання (Форма ОЗ-3)' };
    if (asset.costKop <= 0) return { error: 'Цей обʼєкт уже списано або його балансова вартість дорівнює нулю' };
    const cleanAct = String(actNo || '').trim();
    if (cleanAct.length < 1) return { error: 'Вкажіть номер Акта на списання (Форма ОЗ-3)' };
    const cleanReason = String(reason || '').trim();
    if (cleanReason.length < 5) return { error: 'Вкажіть причину ліквідації / непридатності обʼєкта (не менше 5 символів)' };

    const wearAcc = wearAccountFor(asset.acc);
    const wearKop = Math.min(asset.costKop, Math.max(0, asset.wearKop));
    const netKop = Math.max(0, asset.costKop - wearKop);
    const lines = [];
    if (wearKop > 0) {
        lines.push({
            dr: wearAcc,
            cr: asset.acc,
            dA: asset.id,
            cA: asset.id,
            kop: wearKop,
            fund: asset.fundId || 'main'
        });
    }
    if (netKop > 0) {
        lines.push({
            dr: '92',
            cr: asset.acc,
            dA: asset.item || 'systems',
            cA: asset.id,
            kop: netKop,
            fund: asset.fundId || 'main'
        });
    }
    return {
        error: null,
        date,
        period: date.slice(0, 7),
        amountKop: asset.costKop,
        wearKop,
        netKop,
        source: `Акт ОЗ-3 № ${cleanAct} від ${date.split('-').reverse().join('.')}`,
        note: `Ліквідація (списання) ${asset.acc === '10' ? 'основного засобу' : 'МНМА'} «${asset.name}» (${asset.id}): ${cleanReason}`,
        lines
    };
}

module.exports = {
    DEFAULT_MNHMA_LIMIT_KOP,
    ASSET_ACCOUNTS,
    ASSET_SUBACCOUNTS,
    DEPR_METHODS,
    UNITS,
    ASSET_STATUS_LABELS,
    isNonCurrent,
    isInventory,
    wearAccountFor,
    defaultSubacc,
    defaultDeprMethod,
    isUnifiedAssetId,
    recommendClassification,
    suggestAssetId,
    collectExistingAssetIds,
    checkAssetCard,
    monthlyDepreciationFor,
    reconcileAssets,
    planMonthlyDepreciation,
    planInventoryWriteOff,
    planAssetDisposal
};
