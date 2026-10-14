// ============================================================
// Основні засоби (ОЗ, МНМА) та ТМЦ (Виробничі запаси, МШП) ОСББ:
// класифікація, інвентарна книга, методи амортизації, складський
// і позабалансовий кількісний облік МШП в експлуатації, списання
// та ліквідація (ES-модуль для клієнта, синхронний з functions/assets-core.js).
// ============================================================

export const DEFAULT_MNHMA_LIMIT_KOP = 2_000_000; // 20 000,00 грн (пп. 14.1.138 ПКУ)
const MAX_KOP = 100_000_000_000;

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
export const isNonCurrent = acc => acc === '10' || acc === '11';
export const isInventory = acc => acc === '20' || acc === '22';
export const wearAccountFor = acc => (acc === '10' ? '131' : acc === '11' ? '132' : null);
export const defaultSubacc = acc => (acc === '10' ? '104' : acc === '11' ? '112' : acc === '20' ? '209' : '22');
export const defaultDeprMethod = acc => (acc === '10' ? 'straight' : acc === '11' ? 'mnhma_100' : null);

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
    const prefix = acc === '10' ? 'ОЗ-' : acc === '11' ? 'МНМА-' : acc === '22' ? 'МШП-' : 'ТМЦ-';
    const used = new Set((existingIds || []).map(x => String(x || '').trim().toUpperCase()));
    let maxNum = 0;
    for (const id of used) {
        if (id.startsWith(prefix)) {
            const n = Number(id.slice(prefix.length).replace(/\D+/g, ''));
            if (Number.isInteger(n) && n > maxNum) maxNum = n;
        }
    }
    for (let next = maxNum + 1; next < 10000; next++) {
        const candidate = `${prefix}${String(next).padStart(3, '0')}`;
        if (!used.has(candidate)) return candidate;
    }
    return `${prefix}${Date.now().toString().slice(-4)}`;
}

export function checkAssetCard(card) {
    const id = String(card?.id || '').trim();
    if (id.length < 2 || id.length > 80) return 'Вкажіть інвентарний або номенклатурний код (від 2 до 80 символів, напр. ОЗ-001)';
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

export function monthlyDepreciationFor(asset, period) {
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

export function planMonthlyDepreciation(reconciledItems, period) {
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
