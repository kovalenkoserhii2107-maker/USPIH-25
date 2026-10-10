'use strict';
// ============================================================
// Банк: розбір операцій і розпізнавання, за яку квартиру платіж.
//
// Тут немає ні мережі, ні бази — лише правила, які однаково
// застосовують синхронізація з ПриватБанком, імпорт файлу виписки
// й ручне рознесення. Тести — у functions/bank-core.test.js і
// tests/unit/bank-core.test.mjs.
//
// ЯК ПРАЦЮЄ РОЗПІЗНАВАННЯ
// Мешканці пишуть призначення «як прийдеться», тож довіряємо лише
// тому, що не може бути випадковим збігом:
//   1. особовий рахунок квартири — автоматично;
//   2. номер з явною позначкою («кв. 45», «квартира №45») — автоматично;
//   3. платник, якого бухгалтер уже раз привʼязав, — автоматично;
//   4. прізвище власника або «голе» число — лише підказка: такий
//      платіж іде в чергу «Розібрати», рішення за людиною.
// Кілька різних квартир в одному призначенні — теж у чергу: можливо,
// це оплата за дві квартири, і її треба розділити.
// ============================================================
const crypto = require('crypto');

/** Гривні → копійки цілим числом: суми не можна рахувати в float. */
function toKop(value) {
    if (typeof value === 'number') return Math.round(value * 100);
    const text = String(value ?? '').replace(/\s+/g, '').replace(/[^\d,.\-]/g, '').replace(',', '.');
    const number = Number.parseFloat(text);
    return Number.isFinite(number) ? Math.round(number * 100) : NaN;
}

const fromKop = kop => Math.round(kop) / 100;

/** Ключ для порівняння імен: регістр, апострофи й зайві пробіли не важать. */
function normText(value) {
    return String(value ?? '')
        .toLowerCase()
        .replace(/[ʼ’`'"«»]/g, '')
        .replace(/ё/g, 'е')
        .replace(/[^a-zа-яіїєґ0-9]+/gi, ' ')
        .trim();
}

const normIban = value => String(value ?? '').replace(/\s+/g, '').toUpperCase();

/** ЄДРПОУ — 8 цифр: так платить юрособа (орендар, банк, донор), а не мешканець. */
const isLegalEntityCode = code => /^\d{8}$/.test(String(code ?? '').trim());

// ------------------------------------------------------------
// ПРИЗНАЧЕННЯ ПЛАТЕЖУ
// ------------------------------------------------------------
// Номер квартири може мати літеру впритул («12а», «12б»). Через пробіл
// літеру не беремо: у «кв 45 і кв 46» «і» — це сполучник.
const APT = '(\\d{1,4}(?:[абвгдa-d](?![а-яіїєґa-z]))?)';
// Перелік після позначки: «кв 45, 46», «кв. 45 та 46», «кв 45 і 46».
const LIST_TAIL = /^\s*(?:,|;|\+|&|та|і|й|и|and)\s*(?:кв\.?\s*)?(\d{1,4}(?:[абвгдa-d](?![а-яіїєґa-z]))?)/i;
// Явні позначки: «кв.45», «кв 45», «кв№45», «кв-ра 45», «квартира №45»,
// «квартиры 45», «apt 45». Перед позначкою — не літера, щоб «нкв» не спрацювало.
const MARKED = new RegExp(`(?:^|[^а-яіїєґa-z])(?:кв(?:артир[аиіыу]?|-?ра|\\.)?|apt|flat)\\s*[.:№#\\-]?\\s*${APT}`, 'gi');
// Нежитлові: «нп 1», «н/п 1», «приміщення 1», «прим. 1», «нежитлове 1».
// Літера слова: \w у JS — лише латиниця, тому кирилицю перелічуємо явно.
const L = "[а-яіїєґʼ'a-z]";
const NONRES = new RegExp(`(?:^|[^а-яіїєґa-z])(?:н\\/?п|прим(?:іщення|\\.)?|нежитл${L}*(?:\\s+прим${L}*)?)\\s*[.:№#\\-]?\\s*${APT}`, 'gi');
// Особовий рахунок: «о/р 1045», «ос. рах. 1045», «особовий рахунок 1045», «л/с 1045».
const ACCOUNT = new RegExp(`(?:о\\/р|ос\\.?\\s*р(?:ах)?\\.?|особов${L}*\\s+рахун${L}*|л\\/с|лс|о\\.р\\.)\\s*[.:№#\\-]?\\s*(\\d{2,12})`, 'gi');

/** Особовий рахунок без провідних нулів — ключ для порівняння. */
const accountKey = value => String(value ?? '').trim().replace(/^0+(?=\d)/, '');

const cleanApt = value => String(value ?? '').toLowerCase().replace(/\s+/g, '');

/**
 * Усі квартири, згадані в призначенні.
 * known: { apts: Set<string> (нижній регістр), accounts: Map<особовий, квартира> }
 * Повертає [{ apt, method: 'account'|'marked'|'bare', strong }].
 */
function aptCandidates(purpose, known) {
    const text = String(purpose ?? '');
    const found = [];
    const add = (apt, method, strong) => {
        if (apt && !found.some(f => f.apt === apt && f.method === method)) found.push({ apt, method, strong });
    };
    const knownApt = raw => {
        const key = cleanApt(raw);
        if (known.apts.has(key)) return key;
        // «045» → «45»
        const trimmed = key.replace(/^0+(?=\d)/, '');
        return known.apts.has(trimmed) ? trimmed : null;
    };

    // Особовий рахунок банк і сервіси пишуть то з нулями попереду («00401230045»),
    // то без них — порівнюємо без провідних нулів.
    const byAccount = raw => known.accounts.get(raw) || known.accounts.get(accountKey(raw));
    for (const m of text.matchAll(ACCOUNT)) {
        const apt = byAccount(m[1]);
        if (apt) add(apt, 'account', true);
    }
    // Особовий рахунок без позначки: довгий номер, що збігся з довідником.
    for (const m of text.matchAll(/\d{4,12}/g)) {
        const apt = byAccount(m[0]);
        if (apt) add(apt, 'account', true);
    }
    for (const re of [MARKED, NONRES]) {
        for (const m of text.matchAll(re)) {
            const apt = knownApt(m[1]);
            if (apt) add(apt, 'marked', true);
            let tail = text.slice(m.index + m[0].length);
            for (let next = tail.match(LIST_TAIL); next; next = tail.match(LIST_TAIL)) {
                const listed = knownApt(next[1]);
                if (listed) add(listed, 'marked', true);
                tail = tail.slice(next[0].length);
            }
        }
    }
    // «Голе» число без позначки — лише підказка, і лише коли воно одне:
    // у призначенні бувають дати, суми й номер будинку «3/3».
    if (!found.length) {
        const stripped = text
            .replace(/\d{1,2}[./-]\d{1,2}[./-]\d{2,4}/g, ' ')    // дати
            .replace(/\d{1,2}[./-](?:19|20)\d{2}/g, ' ')            // місяць «10.2026»
            .replace(/\d+\s*\/\s*\d+/g, ' ')                        // «3/3»
            .replace(/\d+[.,]\d{2}(?!\d)/g, ' ')                    // суми «1250,40»
            .replace(/(?:19|20)\d{2}\s*р/gi, ' ');                  // «2026 р»
        const numbers = [...new Set([...stripped.matchAll(/(?:^|[^\d])(\d{1,4})(?![\d])/g)].map(m => m[1]))];
        const hits = numbers.map(knownApt).filter(Boolean);
        if (hits.length === 1) add(hits[0], 'bare', false);
    }
    return found;
}

// ------------------------------------------------------------
// ПЛАТНИК
// ------------------------------------------------------------
/**
 * Ключ платника для запамʼятовування: імʼя + рахунок. Самого рахунку
 * замало: оплати з Приват24 й терміналів приходять через транзитний
 * рахунок банку, однаковий для сотень людей.
 */
function payerKey(name, account) {
    const base = `${normText(name)}|${normIban(account)}`;
    return crypto.createHash('sha1').update(base).digest('hex').slice(0, 24);
}

const words = name => normText(name).split(' ').filter(w => w.length > 1);

/**
 * Наскільки імʼя платника схоже на власника: 2 — прізвище й імʼя
 * (або ініціал), 1 — лише прізвище, 0 — не схоже.
 */
function nameScore(payer, owner) {
    const p = words(payer), o = words(owner);
    if (!p.length || !o.length) return 0;
    const surname = o[0];
    if (!p.includes(surname)) return 0;
    const rest = p.filter(w => w !== surname);
    const first = o[1];
    if (first && rest.some(w => w === first || (w.length === 1 && w === first[0]) || first.startsWith(w))) return 2;
    return 1;
}

// ------------------------------------------------------------
// ІНШІ НАДХОДЖЕННЯ ТА СПИСАННЯ
// ------------------------------------------------------------
const INCOME_HINTS = [
    ['interest', /відсот|процент|нарахування %|interest/i],
    // Провайдери й реклама платять за розміщення обладнання — окреме джерело доходу.
    ['equipment', /розміщ[а-яіїєґ]* обладн|обладнан[а-яіїєґ]* зв[ʼ'’]?язку|реклам|антен|провайдер|телекомунікац/i],
    ['rent', /оренд|аренд|найм[а-яіїєґ]* приміщ/i],
    ['grant', /грант|субвенц|співфінанс|енергодім|дотац|бюджет|благодійн/i]
];
// ЄСВ — окрема стаття (як у звіті сервісу), раніше за зарплату: «ЄСВ із заробітної плати».
const ESV = /єсв|єдин[а-яіїєґ]* (соціальн[а-яіїєґ]* )?внес/i;
const EXPENSE_HINTS = [
    ['bank_fee', /коміс|обслуговування рахунку|за ведення рахунку|рко\b/i],
    ['esv', ESV],
    ['taxes', /пдфо|військов[а-яіїєґ]* збір|податок|\*;101;/i],
    ['salary', /заробітн|зарплат|аванс|з\/п|винагород/i]
];
/** Платіж ЄСВ (для платежів через API з видом «податок»). */
const isEsv = text => ESV.test(String(text || ''));
const guess = (hints, text) => (hints.find(([, re]) => re.test(text)) || [null])[0];

/**
 * Рішення щодо операції.
 * tx:  { direction: 'in'|'out', amountKop, purpose, counterparty: { name, account, code } }
 * ctx: { known, ownAccounts: Set<IBAN>, links: Map<payerKey, apt>, owners: [{ apt, name }] }
 * Повертає { status, apt?, method?, category?, suggestions: [{ apt, reason }] }:
 *   matched   — рознесено автоматично (apt, method);
 *   review    — надходження від мешканця, але квартиру треба підтвердити;
 *   other     — інше надходження (оренда, відсотки, грант) — категорію підтверджує бухгалтер;
 *   internal  — переказ між власними рахунками ОСББ;
 *   expense   — списання (витрата, комісія, зарплата).
 */
function classify(tx, ctx) {
    const cp = tx.counterparty || {};
    if (cp.account && ctx.ownAccounts.has(normIban(cp.account))) return { status: 'internal', suggestions: [] };
    if (tx.direction === 'out') {
        return { status: 'expense', category: guess(EXPENSE_HINTS, `${tx.purpose} ${cp.name}`), suggestions: [] };
    }

    const candidates = aptCandidates(tx.purpose, ctx.known);
    const strong = [...new Set(candidates.filter(c => c.strong).map(c => c.apt))];

    // «Оренда комори за договору, кв. 289»: платить мешканець, але це дохід
    // ОСББ за договором оренди, а не внесок квартири — у баланс не йде.
    const contractIncome = guess(INCOME_HINTS, tx.purpose);
    if (['rent', 'equipment'].includes(contractIncome)) {
        return { status: 'other', category: contractIncome, relatedApt: strong[0] || null, suggestions: [] };
    }
    const linked = ctx.links.get(payerKey(cp.name, cp.account)) || null;

    if (strong.length === 1) {
        const method = candidates.find(c => c.strong && c.apt === strong[0]).method;
        return { status: 'matched', apt: strong[0], method, suggestions: [] };
    }
    if (strong.length > 1) {
        return { status: 'review', reason: 'several', suggestions: strong.map(apt => ({ apt, reason: 'призначення' })) };
    }
    if (linked && ctx.known.apts.has(linked)) return { status: 'matched', apt: linked, method: 'link', suggestions: [] };

    const suggestions = [];
    const push = (apt, reason) => { if (!suggestions.some(s => s.apt === apt)) suggestions.push({ apt, reason }); };
    candidates.filter(c => !c.strong).forEach(c => push(c.apt, 'число в призначенні'));
    const byName = (ctx.owners || [])
        .map(o => ({ apt: o.apt, score: nameScore(cp.name, o.name) || nameScore(tx.purpose, o.name) }))
        .filter(o => o.score > 0)
        .sort((a, b) => b.score - a.score);
    const best = byName.length ? byName[0].score : 0;
    byName.filter(o => o.score === best).slice(0, 4).forEach(o => push(o.apt, best === 2 ? 'імʼя власника' : 'прізвище власника'));

    // Юрособа без згадки квартири — це не внесок мешканця.
    if (!suggestions.length && isLegalEntityCode(cp.code)) {
        return { status: 'other', category: guess(INCOME_HINTS, `${tx.purpose} ${cp.name}`), suggestions };
    }
    const category = guess(INCOME_HINTS, tx.purpose);
    if (!suggestions.length && category) return { status: 'other', category, suggestions };
    return { status: 'review', reason: suggestions.length ? 'suggested' : 'unknown', suggestions };
}

/** Період нарахування «2026-10» за київською датою операції. */
function periodOf(date) {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Kyiv', year: 'numeric', month: '2-digit' })
        .formatToParts(date instanceof Date ? date : new Date(date));
    const get = type => parts.find(p => p.type === type).value;
    return `${get('year')}-${get('month')}`;
}

/** Ідентифікатор документа Firestore з ідентифікатора банку. */
const safeId = value => String(value ?? '').replace(/[^\w.-]+/g, '_').slice(0, 120);

/**
 * Перевіряє розбиття платежу на квартири: суми додатні, у копійках,
 * разом — рівно сума платежу, квартири існують і не повторюються.
 */
function checkAllocations(allocations, amountKop, knownApts) {
    if (!Array.isArray(allocations) || !allocations.length) return 'Вкажіть квартиру';
    if (allocations.length > 20) return 'Забагато квартир в одному платежі';
    const seen = new Set();
    let sum = 0;
    for (const a of allocations) {
        const apt = cleanApt(a?.apt);
        const kop = Number(a?.amountKop);
        if (!knownApts.has(apt)) return `Квартири ${a?.apt ?? ''} немає в довіднику`;
        if (seen.has(apt)) return `Квартира ${apt} вказана двічі`;
        if (!Number.isInteger(kop) || kop <= 0) return 'Сума кожної частини має бути більшою за нуль';
        seen.add(apt);
        sum += kop;
    }
    if (sum !== amountKop) return `Частини разом ${fromKop(sum)} грн, а платіж ${fromKop(amountKop)} грн`;
    return null;
}

module.exports = {
    toKop, fromKop, normText, normIban, isLegalEntityCode, aptCandidates, payerKey, nameScore,
    classify, periodOf, safeId, checkAllocations, cleanApt, accountKey, isEsv
};
