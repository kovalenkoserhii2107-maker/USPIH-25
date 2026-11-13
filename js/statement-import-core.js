// ============================================================
// Виписки банків файлом: розбір у браузері, перевірка — на сервері
// (functions/statement-core.js). Формати:
//   • 1C — «1CClientBankExchange» (TXT, Windows-1251 або UTF-8): вивантажують
//     Ощадбанк, ПУМБ, Райффайзен, УкрСиб, ПриватБанк та інші клієнт-банки;
//   • ISO 20022 camt.053 (XML) — міжнародний формат виписки;
//   • таблиця CSV/XLSX — колонки визначаються за назвами, їх можна поправити.
// Результат: { format, iban, from, to, openingKop, closingKop, rows, warnings }
// де rows — [{ date: 'YYYY-MM-DD', direction: 'in'|'out', amountKop, purpose, name, code, account, ref }].
// ============================================================

export const BANKS = {
    305299: 'ПриватБанк', 322001: 'Універсал Банк (monobank)', 300465: 'Ощадбанк', 334851: 'ПУМБ',
    380805: 'Райффайзен Банк', 351005: 'УкрСиббанк', 300528: 'ОТП Банк', 320478: 'Укргазбанк',
    300614: 'Креді Агріколь Банк', 307770: 'А-Банк', 325365: 'Кредобанк', 300346: 'Сенс Банк',
    328209: 'Банк Південний', 339500: 'Таскомбанк', 336310: 'Ідея Банк', 320984: 'ПроКредит Банк',
    322313: 'Укрексімбанк', 380838: 'Правекс Банк'
};

export const normIban = v => String(v || '').replace(/\s+/g, '').toUpperCase();
const mfoOf = iban => (/^UA\d{8}/.test(normIban(iban)) ? normIban(iban).slice(4, 10) : '');
export const bankOf = iban => BANKS[mfoOf(iban)] || (mfoOf(iban) ? `Банк (МФО ${mfoOf(iban)})` : 'Банк');
export const isPrivat = iban => mfoOf(iban) === '305299';

export function validIban(value) {
    const iban = normIban(value);
    if (!/^UA\d{27}$/.test(iban)) return false;
    const digits = (iban.slice(4) + iban.slice(0, 4)).replace(/[A-Z]/g, c => String(c.charCodeAt(0) - 55));
    let rest = 0;
    for (const d of digits) rest = (rest * 10 + Number(d)) % 97;
    return rest === 1;
}

const IBAN_RE = /UA\d{27}/;
const clean = v => String(v ?? '').replace(/ /g, ' ').replace(/\s+/g, ' ').trim();

/** «1 234,56», «-850.00», «1'234.56 UAH», «(120,00)» → копійки цілим числом, без похибок плаваючої коми. */
export function toKop(value) {
    if (typeof value === 'number') return Number.isFinite(value) ? Math.round(value * 100) : null;
    let s = clean(value).replace(/\s|'|’|грн\.?|uah/gi, '');
    if (!s) return null;
    let negative = false;
    if (/^\(.*\)$/.test(s)) { negative = true; s = s.slice(1, -1); }
    if (/^[-−–]/.test(s)) { negative = true; s = s.slice(1); }
    if (s.startsWith('+')) s = s.slice(1);
    // Остання кома чи крапка з 1–2 цифрами після неї — десятковий роздільник; решта — розряди.
    const m = /^(\d[\d.,]*?)(?:[.,](\d{1,2}))?$/.exec(s);
    if (!m) return null;
    const whole = m[1].replace(/[.,]/g, '');
    if (!/^\d+$/.test(whole)) return null;
    const kop = Number(whole) * 100 + Number((m[2] || '0').padEnd(2, '0'));
    return Number.isSafeInteger(kop) ? (negative ? -kop : kop) : null;
}

/** «05.10.2026», «05.10.2026 14:31», «2026-10-05», «05/10/2026», серійне число Excel → 'YYYY-MM-DD'. */
export function toDate(value) {
    if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString().slice(0, 10);
    const s = clean(value);
    let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
    if (m) return valid(m[1], m[2], m[3]);
    m = /^(\d{1,2})[./](\d{1,2})[./](\d{4}|\d{2})\b/.exec(s);
    if (m) return valid(m[3].length === 2 ? `20${m[3]}` : m[3], m[2].padStart(2, '0'), m[1].padStart(2, '0'));
    if (/^\d{5}(\.\d+)?$/.test(s)) {
        const serial = Math.floor(Number(s));
        if (serial > 36000 && serial < 60000) return new Date(Date.UTC(1899, 11, 30) + serial * 864e5).toISOString().slice(0, 10);
    }
    return null;
}
function valid(y, mo, d) {
    const iso = `${y}-${mo}-${d}`;
    const t = Date.parse(`${iso}T00:00:00Z`);
    return Number.isNaN(t) || new Date(t).toISOString().slice(0, 10) !== iso ? null : iso;
}

const summary = (format, rows, extra = {}) => {
    const dates = rows.map(r => r.date).sort();
    return { format, iban: extra.iban || null, from: extra.from || dates[0] || null, to: extra.to || dates.at(-1) || null,
        openingKop: extra.openingKop ?? null, closingKop: extra.closingKop ?? null, rows, warnings: extra.warnings || [], ...(extra.table ? { table: extra.table } : {}) };
};

// ------------------------------------------------------------
// 1CClientBankExchange
// ------------------------------------------------------------
const PICK = (o, ...keys) => { for (const k of keys) if (o[k] !== undefined && o[k] !== '') return o[k]; return ''; };

export function parse1C(text, ownIban = '') {
    const lines = String(text).replace(/^﻿/, '').split(/\r?\n/);
    if (!/^1CClientBankExchange/.test(lines[0]?.trim())) throw new Error('Це не файл обміну 1С (1CClientBankExchange)');
    const sections = [], docs = [];
    let cur = null;
    for (const raw of lines) {
        const line = raw.trim();
        if (!line) continue;
        if (line === 'СекцияРасчСчет' || line === 'СекціяРозрахРахунок') { cur = {}; sections.push(cur); continue; }
        if (/^(СекцияДокумент|СекціяДокумент)=/.test(line)) { cur = { _type: line.split('=')[1] }; docs.push(cur); continue; }
        if (/^(КонецРасчСчет|КонецДокумента|КінецьРозрахРахунок|КінецьДокумента|КонецФайла|КінецьФайлу)$/.test(line)) { cur = null; continue; }
        const eq = line.indexOf('=');
        if (cur && eq > 0) cur[line.slice(0, eq)] = line.slice(eq + 1).trim();
    }
    const sec = sections[0] || {};
    const iban = normIban(PICK(sec, 'РасчСчет', 'РозрахРахунок') || ownIban);
    const rows = [];
    for (const d of docs) {
        const payerAcc = normIban(PICK(d, 'ПлательщикСчет', 'ПлательщикРасчСчет', 'ПлатникРахунок'));
        const payeeAcc = normIban(PICK(d, 'ПолучательСчет', 'ПолучательРасчСчет', 'ОтримувачРахунок'));
        const out = iban ? payerAcc === iban : Boolean(PICK(d, 'ДатаСписано'));
        if (iban && payerAcc !== iban && payeeAcc !== iban) continue; // документ не цього рахунку
        const amountKop = toKop(PICK(d, 'Сумма', 'Сума'));
        const date = toDate(PICK(d, out ? 'ДатаСписано' : 'ДатаПоступило', 'ДатаСписано', 'ДатаПоступило', 'Дата'));
        if (!amountKop || !date) continue;
        rows.push({
            date, direction: out ? 'out' : 'in', amountKop: Math.abs(amountKop),
            purpose: clean(PICK(d, 'НазначениеПлатежа', 'ПризначенняПлатежу')),
            name: clean(out ? PICK(d, 'Получатель1', 'Получатель', 'Отримувач') : PICK(d, 'Плательщик1', 'Плательщик', 'Платник')),
            code: clean(out ? PICK(d, 'ПолучательИНН', 'ПолучательОКПО', 'ОтримувачКод') : PICK(d, 'ПлательщикИНН', 'ПлательщикОКПО', 'ПлатникКод')).replace(/\D/g, ''),
            account: out ? payeeAcc : payerAcc,
            ref: clean(PICK(d, 'Номер'))
        });
    }
    return summary('1c', rows, {
        iban: iban || null, from: toDate(PICK(sec, 'ДатаНачала', 'ДатаПочатку')), to: toDate(PICK(sec, 'ДатаКонца', 'ДатаКінця')),
        openingKop: toKop(PICK(sec, 'НачальныйОстаток', 'ПочатковийЗалишок')), closingKop: toKop(PICK(sec, 'КонечныйОстаток', 'КінцевийЗалишок'))
    });
}

// ------------------------------------------------------------
// ISO 20022 camt.053 — маленький розбір XML (працює і в браузері, і в тестах)
// ------------------------------------------------------------
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const unescape = s => s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : ENT[e] ?? m);

export function parseXml(text) {
    const root = { name: '#root', children: [], text: '', attrs: {} };
    const stack = [root];
    const re = /<!\[CDATA\[([\s\S]*?)\]\]>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<\/([^\s>]+)\s*>|<([^\s/>]+)((?:\s+[^\s=>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
    let m;
    while ((m = re.exec(text))) {
        const top = stack.at(-1);
        if (m[1] !== undefined) top.text += m[1];
        else if (m[2]) {
            if (stack.length < 2 || local(top.name) !== local(m[2])) throw new Error('Пошкоджений XML');
            stack.pop();
        } else if (m[3]) {
            const attrs = {};
            for (const a of m[4].matchAll(/([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) attrs[local(a[1])] = unescape(a[2] ?? a[3]);
            const node = { name: m[3], children: [], text: '', attrs };
            top.children.push(node);
            if (!m[5]) stack.push(node);
        } else if (m[6] !== undefined) top.text += unescape(m[6]);
    }
    if (stack.length !== 1) throw new Error('Пошкоджений XML');
    return root;
}
const local = name => String(name).replace(/^.*:/, '');
const kids = (node, name) => (node?.children || []).filter(c => local(c.name) === name);
const one = (node, ...path) => path.reduce((n, p) => kids(n, p)[0], node);
const txt = (node, ...path) => clean(one(node, ...path)?.text);
const deep = (node, name) => {
    const out = [];
    const walk = n => { for (const c of n.children || []) { if (local(c.name) === name) out.push(c); walk(c); } };
    walk(node);
    return out;
};

export function parseCamt(text) {
    const doc = parseXml(String(text).replace(/^﻿/, ''));
    const stmt = deep(doc, 'Stmt')[0] || deep(doc, 'Rpt')[0];
    if (!stmt) throw new Error('У файлі немає виписки camt.053 (Stmt)');
    const iban = normIban(txt(stmt, 'Acct', 'Id', 'IBAN'));
    const amount = node => {
        const kop = toKop(txt(node, 'Amt'));
        return kop === null ? null : (txt(node, 'CdtDbtInd') === 'DBIT' ? -kop : kop);
    };
    let openingKop = null, closingKop = null, from = null, to = null;
    for (const bal of kids(stmt, 'Bal')) {
        const code = txt(bal, 'Tp', 'CdOrPrtry', 'Cd');
        const date = toDate(txt(bal, 'Dt', 'Dt') || txt(bal, 'Dt', 'DtTm'));
        if (['OPBD', 'PRCD'].includes(code) && openingKop === null) { openingKop = amount(bal); from = date; }
        if (code === 'CLBD') { closingKop = amount(bal); to = date; }
    }
    from = toDate(txt(stmt, 'FrToDt', 'FrDtTm')) || from;
    to = toDate(txt(stmt, 'FrToDt', 'ToDtTm')) || to;
    const rows = [];
    const warnings = [];
    for (const e of kids(stmt, 'Ntry')) {
        const status = txt(e, 'Sts', 'Cd') || txt(e, 'Sts');
        if (status && status !== 'BOOK') { warnings.push('Пропущено непроведені банком операції'); continue; }
        const kop = amount(e);
        const date = toDate(txt(e, 'BookgDt', 'Dt') || txt(e, 'BookgDt', 'DtTm') || txt(e, 'ValDt', 'Dt'));
        if (!kop || !date) continue;
        const out = kop < 0;
        const tx = one(e, 'NtryDtls', 'TxDtls') || {};
        const party = one(tx, 'RltdPties') || {};
        const who = out ? 'Cdtr' : 'Dbtr';
        const person = one(party, who, 'Pty') || one(party, who) || {};
        rows.push({
            date, direction: out ? 'out' : 'in', amountKop: Math.abs(kop),
            purpose: clean([...kids(one(tx, 'RmtInf') || {}, 'Ustrd').map(n => n.text), txt(e, 'AddtlNtryInf')].filter(Boolean).join(' ')),
            name: txt(person, 'Nm'),
            code: (txt(person, 'Id', 'OrgId', 'Othr', 'Id') || txt(person, 'Id', 'PrvtId', 'Othr', 'Id')).replace(/\D/g, ''),
            account: normIban(txt(party, `${who}Acct`, 'Id', 'IBAN')),
            ref: txt(e, 'AcctSvcrRef') || txt(tx, 'Refs', 'AcctSvcrRef') || txt(tx, 'Refs', 'EndToEndId')
        });
    }
    return summary('camt053', rows, { iban: iban || null, from, to, openingKop, closingKop, warnings: [...new Set(warnings)] });
}

// ------------------------------------------------------------
// Таблиця CSV/XLSX
// ------------------------------------------------------------
export const COLUMNS = {
    date: 'Дата', amount: 'Сума (з мінусом для списань)', debit: 'Списання (дебет)', credit: 'Надходження (кредит)', kind: 'Тип Д/К',
    purpose: 'Призначення', name: 'Контрагент', code: 'ЄДРПОУ / ІПН', account: 'Рахунок контрагента', ref: 'Номер документа'
};
const HEAD = {
    date: [/дата\s*(операц|провед|провод|платеж|валют)/, /^дата/, /^date/, /booking date/],
    debit: [/дебет/, /списан/, /видат/, /витрат/, /^debit/, /withdraw/, /сума\s*д\b/],
    credit: [/кредит(?!ор)/, /надход/, /зарахув/, /прихід/, /^credit/, /deposit/, /сума\s*к\b/],
    amount: [/^сума/, /^сумма/, /^amount/, /сума\s*операц/, /сума,?\s*грн/],
    kind: [/^тип$/, /д\/к/, /^напрям/, /^dr\/cr/],
    purpose: [/призначен/, /назначен/, /^purpose/, /деталі/, /^опис/, /коментар/, /description/],
    code: [/єдрпоу/, /едрпоу/, /іпн/, /рнокпп/, /окпо/, /^код/, /tax id/],
    account: [/рахунок\s*(контраг|кореспонд|платн|отрим)/, /iban\s*(контраг|кореспонд)/, /счет\s*(контраг|корресп)/, /^рахунок$/, /^iban$/, /account/],
    name: [/контрагент/, /кореспондент/, /платник\s*\/\s*отримувач/, /отримувач/, /платник/, /найменуван/, /^назва/, /^name/, /counterparty/],
    ref: [/номер\s*док/, /^№/, /^номер/, /референс/, /reference/, /^ref/]
};
const ORDER = ['date', 'debit', 'credit', 'kind', 'code', 'account', 'purpose', 'name', 'ref', 'amount'];
const norm = v => clean(v).toLowerCase().replace(/[ʼ’']/g, '');

/** Рядок заголовків і відповідність колонок за назвами. */
export function detectColumns(rows) {
    let best = null;
    for (let i = 0; i < Math.min(rows.length, 40); i++) {
        const cells = rows[i].map(norm);
        const map = {}, used = new Set();
        for (const key of ORDER) {
            for (const re of HEAD[key]) {
                const col = cells.findIndex((c, j) => c && !used.has(j) && re.test(c));
                if (col >= 0) { map[key] = col; used.add(col); break; }
            }
        }
        const money = map.amount !== undefined || (map.debit !== undefined && map.credit !== undefined);
        const score = Object.keys(map).length + (map.date !== undefined && money ? 10 : 0);
        if (map.date !== undefined && money && (!best || score > best.score)) best = { header: i, map, score };
    }
    return best ? { header: best.header, map: best.map } : null;
}

export function parseTable(rows, { map: override, header: headerRow, ownIban = '' } = {}) {
    const found = override ? { header: headerRow ?? 0, map: override } : detectColumns(rows);
    if (!found) throw new Error('Не знайдено колонок «Дата» і «Сума» (або «Дебет»/«Кредит»). Вкажіть колонки вручну');
    const { header, map } = found;
    const at = (r, key) => (map[key] === undefined || map[key] === null || map[key] === '' ? '' : r[Number(map[key])]);
    const out = [];
    let blankRun = 0, last = header;
    for (let i = header + 1; i < rows.length; i++) {
        const r = rows[i];
        const date = toDate(at(r, 'date'));
        if (!date) { if (r.some(c => clean(c))) blankRun++; if (out.length && blankRun > 3) break; continue; }
        blankRun = 0;
        let kop = null;
        if (map.debit !== undefined || map.credit !== undefined) {
            const d = toKop(at(r, 'debit')) || 0, c = toKop(at(r, 'credit')) || 0;
            kop = c && !d ? Math.abs(c) : d && !c ? -Math.abs(d) : null;
        }
        if (kop === null && map.amount !== undefined) {
            kop = toKop(at(r, 'amount'));
            const kind = norm(at(r, 'kind'));
            if (kop !== null && kind) kop = /^(д|d|дебет|debit|списан|-)/.test(kind) ? -Math.abs(kop) : Math.abs(kop);
        }
        if (!kop) continue;
        last = i;
        const rawAccount = clean(at(r, 'account'));
        out.push({ date, direction: kop < 0 ? 'out' : 'in', amountKop: Math.abs(kop), purpose: clean(at(r, 'purpose')), name: clean(at(r, 'name')),
            code: clean(at(r, 'code')).replace(/\D/g, '').slice(0, 10), account: normIban((IBAN_RE.exec(rawAccount.replace(/\s/g, '')) || [''])[0]), ref: clean(at(r, 'ref')) });
    }
    // Рахунок, період і залишки — з рядків над таблицею та під нею.
    const around = rows.filter((_, i) => i < header || i > last);
    const flat = around.flat().map(clean);
    const iban = normIban((flat.join(' ').match(/UA\d{2}(?:\s?\d){25}/) || [''])[0]) || ownIban || null;
    const near = (re) => {
        for (const r of around) {
            const j = r.findIndex(c => re.test(norm(c)));
            if (j < 0) continue;
            const inline = toKop((clean(r[j]).match(/[-−]?\d[\d\s.,']*$/) || [''])[0]);
            if (inline !== null && /\d/.test(clean(r[j]).replace(/\d{2}\.\d{2}\.\d{4}/g, ''))) return inline;
            for (const c of r.slice(j + 1)) { const v = toKop(c); if (v !== null && clean(c)) return v; }
        }
        return null;
    };
    const period = flat.join(' ').match(/(\d{2}\.\d{2}\.\d{4})\s*(?:-|—|–|по|до)\s*(\d{2}\.\d{2}\.\d{4})/);
    return summary('table', out, {
        iban, from: period ? toDate(period[1]) : null, to: period ? toDate(period[2]) : null,
        openingKop: near(/(вхідн|початков|на початок|входящ|opening)/), closingKop: near(/(вихідн|кінцев|на кінець|исходящ|closing)/),
        table: { header, map, headers: rows[header].map(clean) }
    });
}

/** Формат за вмістом файлу. text — розкодований текст (для XLSX — null). */
export function detectFormat(name, text) {
    if (/\.xlsx$/i.test(name)) return 'table';
    const head = String(text || '').replace(/^﻿/, '').trimStart().slice(0, 400);
    if (/^1CClientBankExchange/.test(head)) return '1c';
    if (/^<\?xml|^<Document|camt\.05[23]/i.test(head)) return 'camt053';
    return 'table';
}

/** Підсумок для перевірки перед імпортом: суми, рівняння залишків, межі періоду. */
export function checkStatement(st, { iban } = {}) {
    const problems = [];
    const inKop = st.rows.filter(r => r.direction === 'in').reduce((s, r) => s + r.amountKop, 0);
    const outKop = st.rows.filter(r => r.direction === 'out').reduce((s, r) => s + r.amountKop, 0);
    if (!st.rows.length) problems.push('У файлі не знайдено жодної операції');
    if (st.iban && iban && normIban(st.iban) !== normIban(iban)) problems.push(`Виписка належить рахунку …${normIban(st.iban).slice(-4)}, а обрано …${normIban(iban).slice(-4)}`);
    const diff = st.openingKop !== null && st.closingKop !== null ? st.closingKop - st.openingKop - (inKop - outKop) : 0;
    if (diff) problems.push(`Вхідний залишок і операції не дають вихідного: різниця ${(diff / 100).toFixed(2)} грн. Перевірте колонки`);
    if (st.from && st.to && st.rows.some(r => r.date < st.from || r.date > st.to)) problems.push('Деякі операції виходять за межі періоду виписки');
    return { inKop, outKop, diffKop: diff, problems };
}
