// ============================================================
// «ОСББ у реєстрах»: дані з ЄДР і реєстру неприбуткових, податкова,
// показники річної фінзвітності попередніх років. Потрібні для звітів
// (частина 9) і перевірок; зберігаються в osbb_settings/finance.registry.
//
// Типові значення — з витягу ЄДР станом на 10.10.2026 (публічні дані
// юрособи, без персональних даних): бухгалтер перевіряє й зберігає.
// ============================================================
import { db } from './firebase.js';
import { doc, setDoc, serverTimestamp } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js';
import { escapeHtml, toast, setBusy } from './ui.js';
import { audit } from './audit.js';
import { invalidate } from './buh-data.js';

export const REGISTRY_DEFAULTS = {
    legalName: `ОБ'ЄДНАННЯ СПІВВЛАСНИКІВ БАГАТОКВАРТИРНОГО БУДИНКУ "УСПІХ-25"`,
    code: '40562894',
    regNumber: '15561020000058614',
    regDate: '2016-06-13',
    legalAddress: 'Україна, 65101, Одеська обл., місто Одеса, вулиця 25-ї Чапаєвської дивізії, будинок 3/3',
    kved: '81.10 Комплексне обслуговування обʼєктів',
    nonprofitDecision: '2415514600022',
    nonprofitDate: '2024-05-14',
    nonprofitSign: '',
    taxOffice: 'Головне управління ДПС в Одеській області',
    taxOfficeCode: '44069166',
    // Річна фінзвітність (ф. 1-мс/2-мс), тис. грн: дохід, активи, зобовʼязання, чистий прибуток.
    years: [
        { year: '2025', income: 1408.2, assets: 736.8, liabilities: 8.9, profit: 0 },
        { year: '2024', income: 1495.5, assets: 601.9, liabilities: 9.5, profit: 0 },
        { year: '2023', income: 1249.1, assets: 601.2, liabilities: 9.3, profit: null },
        { year: '2022', income: 1139.2, assets: 391.1, liabilities: null, profit: null },
        { year: '2020', income: 42.6, assets: 141.4, liabilities: 141.4, profit: 0 }
    ]
};

const FIELDS = [
    ['legalName', 'Повна назва (як у ЄДР)'], ['code', 'Код ЄДРПОУ'], ['regNumber', 'Номер запису в ЄДР'], ['regDate', 'Дата реєстрації', 'date'],
    ['legalAddress', 'Адреса в ЄДР'], ['kved', 'Основний КВЕД'],
    ['nonprofitDecision', 'Рішення про включення до Реєстру неприбуткових, №'], ['nonprofitDate', 'Дата рішення', 'date'],
    ['nonprofitSign', 'Ознака неприбутковості (для ОСББ — 0043)'],
    ['taxOffice', 'Податкова (ДПС)'], ['taxOfficeCode', 'Код податкової']
];

const num = v => (v === null || v === undefined || v === '' ? '—' : Number(v).toLocaleString('uk-UA', { minimumFractionDigits: 1 }));

/** Попередження: що в реєстрах варто перевірити чи виправити. */
export function registryWarnings(r, houseAddress = '') {
    const out = [];
    if (!/^\d{8}$/.test(String(r.code || ''))) out.push('Код ЄДРПОУ — 8 цифр');
    if (!r.nonprofitSign) out.push('Ознаку неприбутковості не внесено: перевірте в Електронному кабінеті ДПС чи на cabinet.tax.gov.ua (для ОСББ — 0043; якщо 0048 — подати ф. 1-РН)');
    else if (r.nonprofitSign !== '0043') out.push(`Ознака ${r.nonprofitSign}: для ОСББ має бути 0043 — подайте реєстраційну заяву ф. 1-РН`);
    if (/чапаєвськ/i.test(r.legalAddress || '') && /інглезі/i.test(houseAddress)) {
        out.push('В ЄДР — стара назва вулиці (25-ї Чапаєвської дивізії), у застосунку — Інглезі. У звітах до ДПС і в договорах адреса має збігатися з ЄДР; оновити запис можна через державного реєстратора');
    }
    return out;
}

export function registryHtml(saved, houseAddress) {
    const r = { ...REGISTRY_DEFAULTS, ...(saved || {}) };
    const warnings = registryWarnings(r, houseAddress);
    return `<section class="buh-card rg-card">
        <div class="buh-card-head"><h2>ОСББ у реєстрах</h2><span class="buh-tag ${saved ? 'is-payment' : 'is-review'}">${saved ? 'перевірено' : 'з витягу ЄДР — перевірте й збережіть'}</span></div>
        ${warnings.length ? `<ul class="jr-checks rg-warn">${warnings.map(w => `<li class="is-warn"><span aria-hidden="true">!</span>${escapeHtml(w)}</li>`).join('')}</ul>` : ''}
        <div class="rg-grid">${FIELDS.map(([key, label, type]) => `<label class="field"><span class="field-label">${escapeHtml(label)}</span>
            <input class="field-input" data-rg="${key}" type="${type || 'text'}" value="${escapeHtml(r[key] || '')}"${key === 'code' ? ' inputmode="numeric" maxlength="8"' : ''}></label>`).join('')}</div>
        <h3 class="rg-sub">Річна фінзвітність, тис. грн</h3>
        <table class="buh-table is-compact"><thead><tr><th>Рік</th><th class="t-sum">Дохід</th><th class="t-sum">Активи</th><th class="t-sum">Зобовʼязання</th><th class="t-sum">Чистий прибуток</th></tr></thead>
            <tbody>${r.years.map(y => `<tr><td>${escapeHtml(y.year)}</td><td class="t-sum">${num(y.income)}</td><td class="t-sum">${num(y.assets)}</td><td class="t-sum">${num(y.liabilities)}</td><td class="t-sum">${num(y.profit)}</td></tr>`).join('')}</tbody></table>
        <p class="buh-note">Чистий прибуток 0 щороку: усі надходження — цільове фінансування. Так само будуються проводки в застосунку (рахунок 48). Активи на 31.12.2025 — орієнтир для вхідної оборотно-сальдової.</p>
        <div class="pay-form-actions"><button type="button" class="btn-primary btn-compact" data-act="registry-save">Зберегти</button></div>
    </section>`;
}

export async function saveRegistry(btn, saved) {
    const host = btn.closest('.rg-card');
    const data = { ...REGISTRY_DEFAULTS, ...(saved || {}) };
    host.querySelectorAll('[data-rg]').forEach(i => { data[i.dataset.rg] = i.value.trim().slice(0, 300); });
    if (!/^\d{8}$/.test(data.code)) { toast('Код ЄДРПОУ — 8 цифр', 'error'); return; }
    if (data.nonprofitSign && !/^\d{4}$/.test(data.nonprofitSign)) { toast('Ознака неприбутковості — 4 цифри, напр. 0043', 'error'); return; }
    setBusy(btn, true, 'Зберігаю…');
    try {
        await setDoc(doc(db, 'osbb_settings', 'finance'), { edrpou: data.code, registry: data, updatedAt: serverTimestamp() }, { merge: true });
        await audit('finance.registry', { target: 'osbb_settings/finance', summary: 'Дані ОСББ у реєстрах збережено', details: { code: data.code, nonprofitSign: data.nonprofitSign } });
        invalidate();
        toast('Збережено', 'success');
    } catch (e) {
        console.error('Реєстри ОСББ:', e);
        toast('Не вдалося зберегти', 'error');
    } finally { setBusy(btn, false); }
}
