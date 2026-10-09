'use strict';
// ============================================================
// Вихідні платежі: перевірка, звірка з випискою, регулярні платежі.
//
// Життєвий цикл платежу (payments/{id}.status):
//   proposed — система підготувала (регулярний платіж), чекає «Так»;
//   sent     — бухгалтер підтвердив, платіж створено в Приват24 через
//              API; гроші не рухаються, доки голова не підпише КЕП;
//   paid     — списання знайдено у виписці;
//   failed   — банк відхилив створення (помилка в полі, токен тощо);
//   canceled — скасовано до підпису.
// Тут немає ні мережі, ні бази. Тести — functions/payments-core.test.js.
// ============================================================
const { normIban, normText, fromKop } = require('./bank-core');

const MAX_PURPOSE = 420;      // довжина призначення в СЕП НБУ (з 2023 р.)
const MAX_AMOUNT_KOP = 100000000000; // 1 млрд грн — запобіжник від зайвих нулів

/** IBAN України з перевіркою контрольної суми. */
function validIban(value) {
    const iban = normIban(value);
    if (!/^UA\d{27}$/.test(iban)) return false;
    const digits = (iban.slice(4) + iban.slice(0, 4)).replace(/[A-Z]/g, c => String(c.charCodeAt(0) - 55));
    let rest = 0;
    for (const ch of digits) rest = (rest * 10 + Number(ch)) % 97;
    return rest === 1;
}

/**
 * Перевіряє платіж перед відправкою в банк. Повертає текст першої
 * помилки (людською мовою) або null.
 */
function checkPayment(p, ownAccounts) {
    const r = p?.recipient || {};
    if (!String(r.name || '').trim()) return 'Вкажіть отримувача';
    if (!validIban(r.iban)) return 'IBAN отримувача некоректний — перевірте цифри';
    if (!/^\d{8}$|^\d{10}$/.test(String(r.code || '').trim())) return 'Код отримувача — 8 цифр ЄДРПОУ або 10 цифр РНОКПП';
    if (!Number.isInteger(p.amountKop) || p.amountKop <= 0) return 'Сума має бути більшою за нуль';
    if (p.amountKop > MAX_AMOUNT_KOP) return 'Сума завелика — перевірте нулі';
    const purpose = String(p.purpose || '').trim();
    if (purpose.length < 5) return 'Вкажіть призначення платежу';
    if (purpose.length > MAX_PURPOSE) return `Призначення довше за ${MAX_PURPOSE} символів`;
    if (!ownAccounts.has(normIban(p.account))) return 'Оберіть рахунок ОСББ, з якого платити';
    if (ownAccounts.has(normIban(r.iban))) return 'Це рахунок самого ОСББ — для переказу між своїми рахунками платіж не потрібен';
    return null;
}

/**
 * Чи це списання — наш відправлений платіж. Найнадійніше — референс
 * пачки (DLR у виписці = payment_pack_ref від API). Без нього: та сама
 * сума, той самий IBAN отримувача, не раніше за відправку й не пізніше
 * 45 днів.
 */
function matchesPayment(tx, payment) {
    if (tx.direction !== 'out' || payment.status !== 'sent') return false;
    if (payment.bankRef && tx.dlr && String(tx.dlr) === String(payment.bankRef)) return true;
    if (tx.amountKop !== payment.amountKop) return false;
    if (normIban(tx.counterparty?.account) !== normIban(payment.recipient?.iban)) return false;
    const sent = payment.sentAt instanceof Date ? payment.sentAt : new Date(payment.sentAt);
    const at = tx.at instanceof Date ? tx.at : new Date(tx.at);
    const days = (at - sent) / 86400000;
    return days > -1 && days <= 45;
}

// ------------------------------------------------------------
// РЕГУЛЯРНІ ПЛАТЕЖІ
// ------------------------------------------------------------
/**
 * Отримувачі, яким ОСББ платить щомісяця (ліфти, прибирання, вивіз
 * сміття…), — за історією списань. Для кожного: середня сума, типовий
 * день місяця й останнє призначення, щоб запропонувати платіж за
 * поточний місяць. Податки й зарплату сюди не беремо: їх рахують
 * окремо (суми щоразу інші).
 *
 * history: списання [{ at: Date, amountKop, purpose, counterparty: { name, account, code } }]
 * Повертає [{ key, recipient, amountKop, day, purpose, months, lastAt }].
 */
function recurringRecipients(history, { minMonths = 2 } = {}) {
    const byIban = new Map();
    for (const tx of history) {
        const iban = normIban(tx.counterparty?.account);
        if (!validIban(iban)) continue;
        if (/податок|єсв|пдфо|військов|зарплат|заробітн/i.test(`${tx.purpose} ${tx.counterparty?.name}`)) continue;
        const at = tx.at instanceof Date ? tx.at : new Date(tx.at);
        const month = `${at.getFullYear()}-${at.getMonth()}`;
        const entry = byIban.get(iban) || { iban, list: [], months: new Set() };
        entry.list.push({ ...tx, at });
        entry.months.add(month);
        byIban.set(iban, entry);
    }
    const out = [];
    for (const { iban, list, months } of byIban.values()) {
        if (months.size < minMonths) continue;
        list.sort((a, b) => b.at - a.at);
        const last = list[0];
        const recent = list.slice(0, 3).map(t => t.amountKop).sort((a, b) => a - b);
        out.push({
            key: iban,
            recipient: { name: last.counterparty?.name || '', iban, code: String(last.counterparty?.code || '') },
            amountKop: recent[Math.floor(recent.length / 2)],     // медіана останніх трьох
            day: last.at.getDate(),
            purpose: last.purpose || '',
            months: months.size,
            lastAt: last.at
        });
    }
    return out.sort((a, b) => a.day - b.day);
}

const MONTHS = ['січень', 'лютий', 'березень', 'квітень', 'травень', 'червень', 'липень', 'серпень', 'вересень', 'жовтень', 'листопад', 'грудень'];
const MONTHS_GEN = ['січня', 'лютого', 'березня', 'квітня', 'травня', 'червня', 'липня', 'серпня', 'вересня', 'жовтня', 'листопада', 'грудня'];

/**
 * Призначення на новий місяць: «…за жовтень 2026» → «…за листопад 2026».
 * Якщо місяця в тексті немає — лишаємо як було.
 */
function purposeForMonth(purpose, date) {
    const month = date.getMonth(), year = date.getFullYear();
    let text = String(purpose || '');
    // Родовий відмінок першим і межа слова: «листопад» — початок «листопада».
    const any = new RegExp(`(${[...MONTHS_GEN, ...MONTHS].join('|')})(?![а-яіїєґ])(\\s*)(\\d{4})?`, 'i');
    if (any.test(text)) {
        text = text.replace(any, (m, word, space, y) => {
            const gen = MONTHS_GEN.some(g => g.toLowerCase() === word.toLowerCase());
            return `${gen ? MONTHS_GEN[month] : MONTHS[month]}${space}${y ? year : ''}`.trimEnd();
        });
    }
    // «10.2026» / «10/2026»
    text = text.replace(/\b(0?[1-9]|1[0-2])([./])(20\d{2})\b/, (_, m, sep) => `${String(month + 1).padStart(2, '0')}${sep}${year}`);
    return text;
}

/** Чи вже є платіж цьому отримувачу в цьому місяці (відправлений чи проведений). */
function alreadyPaidThisMonth(rec, payments, history, date) {
    const same = d => { const x = d instanceof Date ? d : new Date(d); return x.getFullYear() === date.getFullYear() && x.getMonth() === date.getMonth(); };
    return payments.some(p => normIban(p.recipient?.iban) === rec.key && ['proposed', 'sent', 'paid'].includes(p.status) && same(p.createdAt || p.sentAt))
        || history.some(t => normIban(t.counterparty?.account) === rec.key && same(t.at));
}

module.exports = {
    MAX_PURPOSE, validIban, checkPayment, matchesPayment, recurringRecipients, purposeForMonth, alreadyPaidThisMonth,
    normText, fromKop
};
