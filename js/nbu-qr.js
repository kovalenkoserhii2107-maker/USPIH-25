// ============================================================
// Платіжне посилання й QR-код НБУ (формат 003).
//
// Постанова Правління НБУ № 97 від 19.08.2025, додаток 4: 17 полів,
// розділених переводом рядка, кодування UTF-8, Base64URL після
// https://qr.bank.gov.ua/. Банківський застосунок відкриває переказ
// з уже заповненими одержувачем, IBAN, кодом, сумою й призначенням —
// мешканцю лишається підтвердити.
//
// Тут немає DOM: модуль однаково використовують кабінет мешканця й
// тести (tests/unit/nbu-qr.test.mjs).
// ============================================================

const QR_BASE = 'https://qr.bank.gov.ua/';

// «Коди старту» застосунків: те саме посилання, але відкривається
// одразу в банку. Перевірені оплатою: Приват24 і monobank.
export const BANK_APPS = [
    { id: 'privat', label: 'Приват24', base: 'https://www.privat24.ua/rd/send_qr/nbu/' },
    { id: 'mono', label: 'monobank', base: 'https://mbnk.app/qr/' }
];

/** IBAN України з перевіркою контрольної суми (MOD 97). */
export function validIban(value) {
    const iban = String(value || '').replace(/\s+/g, '').toUpperCase();
    if (!/^UA\d{27}$/.test(iban)) return false;
    const digits = (iban.slice(4) + iban.slice(0, 4)).replace(/[A-Z]/g, c => String(c.charCodeAt(0) - 55));
    let rest = 0;
    for (const ch of digits) rest = (rest * 10 + Number(ch)) % 97;
    return rest === 1;
}

/** «1250.40» або «1250» — копійки або рівно дві цифри, або жодної. */
export function formatAmount(amount) {
    const kop = Math.round(Number(amount) * 100);
    if (!Number.isFinite(kop) || kop <= 0 || kop > 99999999999) return '';
    return kop % 100 ? `UAH${Math.floor(kop / 100)}.${String(kop % 100).padStart(2, '0')}` : `UAH${kop / 100}`;
}

// У полі не може бути переводу рядка (він зсуне всю структуру), емодзі
// й керівних символів; довжини — за таблицею формату 003.
const clean = (value, max) => String(value ?? '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[^ -~ -ӿ‐-‧№₴]/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .slice(0, max);
const ascii = (value, max) => String(value ?? '').replace(/[^\x20-\x7e]/g, '').slice(0, max);

/**
 * Рядок даних формату 003.
 * f: { name, iban, code, amount?, purpose, reference? }
 */
export function buildPayload(f) {
    const iban = String(f.iban || '').replace(/\s+/g, '').toUpperCase();
    if (!validIban(iban)) throw new Error('Некоректний IBAN');
    const name = clean(f.name, 140);
    const code = clean(f.code, 10);
    const purpose = clean(f.purpose, 420);
    if (!name || !code || !purpose) throw new Error('Бракує одержувача, коду чи призначення');
    return [
        'BCD', '003', '1', 'UCT',
        '',                              // 5: ідентифікатор отримувача — резерв
        name,                            // 6
        iban,                            // 7
        f.amount ? formatAmount(f.amount) : '',  // 8
        code,                            // 9: ЄДРПОУ
        'OTHR/OTHR',                     // 10: Приват24 не приймає порожнє поле
        ascii(f.reference, 35),          // 11
        purpose,                         // 12
        '', '', '', '', ''               // 13–17
    ].join('\n');
}

function base64url(text) {
    const bytes = new TextEncoder().encode(text);
    let binary = '';
    bytes.forEach(b => { binary += String.fromCharCode(b); });
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** { link — для QR-коду, apps — посилання «відкрити в банку» }. */
export function paymentLinks(fields) {
    const encoded = base64url(buildPayload(fields));
    return {
        link: QR_BASE + encoded,
        apps: BANK_APPS.map(app => ({ ...app, href: app.base + encoded }))
    };
}
