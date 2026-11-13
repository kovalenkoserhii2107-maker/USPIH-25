'use strict';
// ============================================================
// Рахунки в різних банках і виписки файлом (без інтеграції з банком).
//
//   • bankOf(iban)        — назва банку за кодом МФО в IBAN;
//   • validIban(iban)     — український IBAN з контрольною сумою;
//   • cleanStatement(...) — перевірка виписки, розібраної в браузері
//                           (1C, camt.053, CSV/XLSX): дати, суми, залишки;
//   • toTransactions(...) — операції у форматі bank_tx (той самий шлях,
//                           що й виписка ПриватБанку: рознесення, правила);
//   • balanceAt(...)      — залишок банку на кінець дня з «якоря» (залишок
//                           з банку на певну дату) і операцій після цієї дати.
// Модуль чистий: без Firestore, щоб його перевіряли тести.
// ============================================================
const { createHash } = require('crypto');

// Код МФО — шість цифр IBAN після «UA» і двох контрольних.
// Перелік не вичерпний: невідомий банк показуємо за кодом.
const BANKS = {
    305299: 'ПриватБанк', 322001: 'Універсал Банк (monobank)', 300465: 'Ощадбанк', 334851: 'ПУМБ',
    380805: 'Райффайзен Банк', 351005: 'УкрСиббанк', 300528: 'ОТП Банк', 320478: 'Укргазбанк',
    300614: 'Креді Агріколь Банк', 307770: 'А-Банк', 325365: 'Кредобанк', 300346: 'Сенс Банк',
    328209: 'Банк Південний', 339500: 'Таскомбанк', 336310: 'Ідея Банк', 320984: 'ПроКредит Банк',
    322313: 'Укрексімбанк', 380838: 'Правекс Банк'
};
const PRIVAT_MFO = '305299';
const MAX_ROWS = 3000;
const MAX_KOP = 100000000000; // 1 млрд грн — більше в ОСББ не буває, це помилка розбору

const normIban = v => String(v || '').replace(/\s+/g, '').toUpperCase();
const mfoOf = iban => (/^UA\d{8}/.test(normIban(iban)) ? normIban(iban).slice(4, 10) : '');
const bankOf = iban => {
    const mfo = mfoOf(iban);
    return BANKS[mfo] || (mfo ? `Банк (МФО ${mfo})` : 'Банк');
};
const isPrivat = iban => mfoOf(iban) === PRIVAT_MFO;

/** IBAN України: UA + 27 цифр, контрольна сума ISO 13616 (mod 97). */
function validIban(value) {
    const iban = normIban(value);
    if (!/^UA\d{27}$/.test(iban)) return false;
    const digits = (iban.slice(4) + iban.slice(0, 4)).replace(/[A-Z]/g, c => String(c.charCodeAt(0) - 55));
    let rest = 0;
    for (const d of digits) rest = (rest * 10 + Number(d)) % 97;
    return rest === 1;
}

const isoDate = v => /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`))
    && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v;
const prevDay = date => new Date(Date.parse(`${date}T00:00:00Z`) - 864e5).toISOString().slice(0, 10);
const cut = (v, n) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const signed = r => (r.direction === 'in' ? r.amountKop : -r.amountKop);

/**
 * Виписка з браузера → перевірена виписка або помилка з поясненням.
 * input: { iban, from, to, openingKop?, closingKop?, rows: [{ date, direction, amountKop, purpose, name, code, account, ref }] }
 */
function cleanStatement(input, { iban, today, startDate } = {}) {
    const fail = message => { throw new Error(message); };
    const rowsIn = Array.isArray(input?.rows) ? input.rows : fail('У виписці немає операцій');
    if (rowsIn.length > MAX_ROWS) fail(`До ${MAX_ROWS} операцій в одному файлі. Розбийте виписку на коротші періоди`);
    const fileIban = normIban(input?.iban);
    if (fileIban && fileIban !== normIban(iban)) fail(`Виписка належить іншому рахунку: …${fileIban.slice(-4)}`);
    const rows = rowsIn.map((r, i) => {
        const n = i + 1;
        if (!isoDate(r?.date)) fail(`Рядок ${n}: некоректна дата`);
        if (today && r.date > today) fail(`Рядок ${n}: дата ${r.date} ще не настала`);
        if (!['in', 'out'].includes(r.direction)) fail(`Рядок ${n}: незрозуміло, надходження це чи списання`);
        if (!Number.isSafeInteger(r.amountKop) || r.amountKop <= 0 || r.amountKop > MAX_KOP) fail(`Рядок ${n}: некоректна сума`);
        return {
            date: r.date, direction: r.direction, amountKop: r.amountKop,
            purpose: cut(r.purpose, 500), name: cut(r.name, 200), code: cut(r.code, 20).replace(/\D/g, ''),
            account: normIban(r.account).slice(0, 34), ref: cut(r.ref, 60)
        };
    });
    const dates = rows.map(r => r.date).sort();
    const from = input.from ?? dates[0], to = input.to ?? dates.at(-1);
    if (!isoDate(from) || !isoDate(to) || from > to) fail('Некоректний період виписки');
    if (today && to > today) fail('Кінець періоду виписки ще не настав');
    if (rows.some(r => r.date < from || r.date > to)) fail('Операції виходять за межі періоду виписки');
    if (startDate && to < startDate) fail(`Виписка закінчується до початку обліку (${startDate})`);
    const money = v => (v === null || v === undefined || v === '' ? null : Number.isSafeInteger(v) && Math.abs(v) <= MAX_KOP ? v : fail('Некоректний залишок у виписці'));
    const openingKop = money(input.openingKop), closingKop = money(input.closingKop);
    const moved = rows.reduce((s, r) => s + signed(r), 0);
    if (openingKop !== null && closingKop !== null && openingKop + moved !== closingKop) {
        fail(`Вхідний залишок і операції не дають вихідного: різниця ${((closingKop - openingKop - moved) / 100).toFixed(2)} грн. Схоже, файл розібрано не повністю`);
    }
    return { from, to, openingKop, closingKop, rows,
        inKop: rows.filter(r => r.direction === 'in').reduce((s, r) => s + r.amountKop, 0),
        outKop: rows.filter(r => r.direction === 'out').reduce((s, r) => s + r.amountKop, 0) };
}

/**
 * Операції у форматі, який приймає bank.storeTransactions.
 * Ідентифікатор — з вмісту рядка: повторне завантаження тієї ж виписки
 * (або виписки, що перекриває попередню) не задвоює операції. Однакові
 * рядки в межах дня розрізняє порядковий номер.
 */
function toTransactions(statement, iban) {
    const account = normIban(iban);
    const seen = new Map();
    return statement.rows.map(r => {
        const key = JSON.stringify([account, r.date, r.direction, r.amountKop, r.ref, r.code, r.account, r.purpose]);
        const n = (seen.get(key) || 0) + 1;
        seen.set(key, n);
        const bankId = `st-${createHash('sha256').update(`${key}#${n}`).digest('hex').slice(0, 24)}`;
        return {
            bankId, account, direction: r.direction, amountKop: r.amountKop, currency: 'UAH',
            // Полудень за Києвом: дата не «зʼїжджає» на сусідню ні взимку, ні влітку.
            at: new Date(`${r.date}T12:00:00+02:00`),
            purpose: r.purpose, counterparty: { name: r.name, code: r.code, account: r.account },
            statementRef: r.ref || null
        };
    });
}

/** Якорі залишку з виписки: на кінець дня перед початком і на кінець останнього дня. */
function statementAnchors(statement) {
    const out = [];
    if (statement.openingKop !== null) out.push({ date: prevDay(statement.from), balanceKop: statement.openingKop });
    if (statement.closingKop !== null) out.push({ date: statement.to, balanceKop: statement.closingKop });
    return out;
}

/**
 * Залишок банку на кінець дня date.
 * anchors — відомі банківські залишки на кінець дня [{ date, balanceKop }];
 * txs — операції рахунку з виписки [{ date, direction, amountKop }] (без сторнованих).
 * Беремо найближчий якір не раніше date і віднімаємо рух після date.
 * Якоря немає — залишок невідомий (null): тоді його вводять з виписки вручну.
 */
function balanceAt(date, anchors, txs) {
    const after = (anchors || []).filter(a => a.date >= date && Number.isSafeInteger(a.balanceKop)).sort((a, b) => (a.date < b.date ? -1 : 1))[0];
    if (!after) return null;
    const moved = (txs || []).filter(t => t.date > date && t.date <= after.date).reduce((s, t) => s + signed(t), 0);
    return { balanceKop: after.balanceKop - moved, anchorDate: after.date, source: after.source || null };
}

const grn = kop => (kop / 100).toLocaleString('uk-UA', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).replace(/ /g, ' ');
const human = date => date.split('-').reverse().join('.');

/**
 * Звірка грошових рахунків з банком на кінець місяця.
 * rows     — залишки в обліку на кінець місяця [{ acc, iban, balanceKop }];
 * accounts — рахунки ОСББ [{ iban, source, balanceKop, balanceDate }] (balanceDate — київська дата поточного залишку з API);
 * anchors  — збережені залишки на кінець дня [{ iban, date, balanceKop, source }];
 * txs      — операції виписки [{ account, date, direction, amountKop }] без сторнованих;
 * cut      — ручна звірка { key, rows } (для рахунків, де залишку банку на дату немає).
 * Рядок звірено, якщо банк на кінець місяця відомий і дорівнює обліку, або його звірили вручну.
 */
function reconcileBank({ lastDay, today, rows, accounts = [], anchors = [], txs = [], cut = null, key = null }) {
    const ended = Boolean(today && today > lastDay);
    const out = rows.map(r => {
        const iban = normIban(r.iban);
        const account = accounts.find(a => normIban(a.iban) === iban) || null;
        const own = anchors.filter(a => normIban(a.iban) === iban);
        if (account && account.source !== 'file' && Number.isSafeInteger(account.balanceKop) && account.balanceDate) own.push({ date: account.balanceDate, balanceKop: account.balanceKop, source: 'privat' });
        const bank = ended ? balanceAt(lastDay, own, txs.filter(t => normIban(t.account) === iban)) : null;
        const manual = Boolean(cut && cut.key === key && (cut.rows || []).some(c => normIban(c.iban) === iban && c.acc === r.acc && c.balanceKop === r.balanceKop));
        const state = bank ? (bank.balanceKop === r.balanceKop ? 'match' : 'diff') : 'none';
        return { acc: r.acc, iban: r.iban, balanceKop: r.balanceKop, bank: bankOf(iban), source: account?.source === 'file' ? 'file' : account ? 'api' : 'none',
            bankKop: bank ? bank.balanceKop : null, bankDate: bank ? bank.anchorDate : null, bankSource: bank ? bank.source : null, state, manual, ok: state === 'match' || manual };
    });
    const label = r => `…${String(r.iban).slice(-4)} (${r.bank})`;
    const checks = [];
    if (!out.length) return { rows: out, done: true, checks };
    if (!ended) checks.push({ level: 'block', text: `Звірка залишків банку — після ${human(lastDay)}: залишок на кінець місяця ще невідомий` });
    const diff = out.filter(r => r.state === 'diff' && !r.manual);
    if (diff.length) checks.push({ level: 'block', text: `Банк і облік на ${human(lastDay)} розходяться: ${diff.map(r => `${label(r)} — облік ${grn(r.balanceKop)}, банк ${grn(r.bankKop)}, різниця ${grn(r.bankKop - r.balanceKop)} грн`).join('; ')}.`
        + (diff.some(r => r.balanceKop < 0) ? ' В обліку мінус — так буває, коли у «Вхідній ОСВ» немає залишку рахунку на початок обліку («Підставити» біля рахунку).' : ' Шукайте операцію, якої немає у виписці або в обліку.') });
    const missing = ended ? out.filter(r => r.state === 'none' && !r.manual) : [];
    if (missing.length) checks.push({ level: 'block', text: `Немає залишку банку на ${human(lastDay)}: ${missing.map(label).join(', ')}. Завантажте виписку за місяць або внесіть залишок вручну` });
    const done = ended && out.every(r => r.ok);
    if (done) {
        const auto = out.filter(r => r.state === 'match').length;
        checks.push({ level: 'ok', text: `Залишки банку на ${human(lastDay)} збігаються з обліком: ${out.length} рах.${auto < out.length ? ` (${out.length - auto} — звірено вручну)` : ''}` });
    }
    return { rows: out, done, checks };
}

module.exports = { BANKS, PRIVAT_MFO, MAX_ROWS, normIban, mfoOf, bankOf, isPrivat, validIban, isoDate, prevDay, cleanStatement, toTransactions, statementAnchors, balanceAt, reconcileBank };
