// ============================================================
// Чисті функції обліку ОЗ, МНМА (НП(С)БО 7) та ТМЦ, МШП (НП(С)БО 9)
// для кабінету бухгалтера та тестів.
// ============================================================

export const DEFAULT_MNHMA_LIMIT_KOP = 2_000_000; // 20 000,00 грн (пп. 14.1.138 ПКУ)
export const MAX_KOP = 100_000_000_000;

export const ASSET_ACCOUNTS = {
    10: 'Основні засоби (ОЗ)',
    11: 'Малоцінні необоротні матеріальні активи (МНМА)',
    20: 'Виробничі запаси (паливо, будматеріали, запчастини)',
    22: 'Малоцінні та швидкозношувані предмети (МШП)'
};

export const ASSET_SUBACCOUNTS = {
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

export const DEPR_METHODS = {
    straight: 'Прямолінійний (рівномірно щомісяця — п. 26 НП(С)БО 7)',
    mnhma_100: '100 % у першому місяці використання (для МНМА — п. 27 НП(С)БО 7)',
    mnhma_50_50: '50 % у першому місяці та 50 % при списанні (для МНМА — п. 27 НП(С)БО 7)'
};

export const UNITS = ['шт.', 'компл.', 'л', 'кг', 'м', 'м²', 'м³', 'упак.', 'рул.', 'п.м.'];

export const ASSET_STATUS_LABELS = {
    uncommissioned: ['Очікує введення (ОЗ-1)', 'is-review'],
    active: ['В експлуатації', 'is-payment'],
    fully_depreciated: ['Замортизовано (в експл.)', 'is-done'],
    in_stock: ['На складі', 'is-payment'],
    in_use_offbalance: ['В експлуатації (позабаланс МВО)', 'is-done'],
    disposed: ['Списано / ліквідовано', '']
};

export const isNonCurrent = acc => acc === '10' || acc === '11';
export const isInventory = acc => acc === '20' || acc === '22';
export const wearAccountFor = acc => (acc === '10' ? '131' : acc === '11' ? '132' : null);
export const defaultSubacc = acc => (acc === '10' ? '104' : acc === '11' ? '112' : acc === '20' ? '209' : '22');
export const defaultDeprMethod = acc => (acc === '10' ? 'straight' : acc === '11' ? 'mnhma_100' : null);

const UNIFIED_ID_RE = /^(ОЗ|МНМА|ТМЦ|МШП)-\d{1,6}$/i;
export const isUnifiedAssetId = id => UNIFIED_ID_RE.test(String(id || '').trim());

export function recommendClassification({ unitCostKop = 0, usefulLifeMonths = 12, consumable = false, mnhmaLimitKop = DEFAULT_MNHMA_LIMIT_KOP } = {}) {
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

export function suggestAssetId(acc, existingIds = []) {
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
