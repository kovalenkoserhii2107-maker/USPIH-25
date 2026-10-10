'use strict';
// ============================================================
// Податковий розрахунок J0500111 (наказ Мінфіну № 4 у редакції № 243
// від 07.05.2026) з додатками Д1 (J0510111), 4ДФ (J0510411) і Д5
// (J0510511) у форматі XML ДПС — для завантаження в Електронний кабінет.
//
// Рядки — за бланками форм (functions/dps/*.xsd, коди полів R…/T1R…):
//   розділ I розрахунку: 1.1 зарплата (з відпускними, премією й
//   перерахунком), 1.2 ЦПД, 1.3 перші 5 днів лікарняних (ОСББ), 1.4
//   лікарняні ПФУ; 2.1 база ЄСВ 22 % у межах максимальної, 2.5 додаткова
//   база (доплата до мінімальної); 3.1 і 3.5 — ЄСВ з них; 7 — до сплати.
//   Д1 — рядок на особу (категорія 1), лікарняні — окремим рядком
//   (категорія 29); 4ДФ — доходи, ПДФО й ВЗ за ознаками 101/102 з ПСП;
//   Д5 — прийом і звільнення (категорія 1/2/3, код КП, документ).
// Файли — у windows-1251, імʼя — за правилами ДПС (filename()).
// Остаточно файл перевіряє Електронний кабінет під час завантаження:
// голова бачить заповнену форму перед підписом.
//
// Тут немає ні мережі, ні бази: тести — dps-xml.test.js.
// ============================================================

const SOFTWARE = 'OSBB Uspikh-25 accounting';
const DOCS = { main: { sub: '001', name: 'J0500111' }, d1: { sub: '101', name: 'J0510111' }, df4: { sub: '104', name: 'J0510411' }, d5: { sub: '105', name: 'J0510511' } };

// ------------------------------------------------------------
// windows-1251
// ------------------------------------------------------------
const EXTRA = { 0x401: 0xA8, 0x451: 0xB8, 0x404: 0xAA, 0x454: 0xBA, 0x406: 0xB2, 0x456: 0xB3, 0x407: 0xAF, 0x457: 0xBF, 0x490: 0xA5, 0x491: 0xB4,
    0x2116: 0xB9, 0xAB: 0xAB, 0xBB: 0xBB, 0x2014: 0x97, 0x2013: 0x96, 0x2019: 0x92, 0x2018: 0x91, 0x201C: 0x93, 0x201D: 0x94, 0x2BC: 0x92, 0xA0: 0xA0 };
/** Рядок → байти windows-1251 (невідомі символи — «?»). */
function encode1251(text) {
    const out = Buffer.alloc(text.length);
    let n = 0;
    for (const ch of text) {
        const c = ch.codePointAt(0);
        out[n++] = c < 0x80 ? c : c >= 0x410 && c <= 0x44F ? c - 0x350 : EXTRA[c] ?? 0x3F;
    }
    return out.subarray(0, n);
}

// ------------------------------------------------------------
// ДОПОМІЖНЕ
// ------------------------------------------------------------
const esc = v => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const money = kop => (Math.round(kop) / 100).toFixed(2);
const dmy = iso => (iso ? `${iso.slice(8, 10)}${iso.slice(5, 7)}${iso.slice(0, 4)}` : '');
const pad = (v, n) => String(v).padStart(n, '0');
const el = (name, value) => (value === null || value === undefined || value === '' ? '' : `<${name}>${esc(value)}</${name}>`);
/** Стовпець таблиці: <NAME ROWNUM="1">…</NAME> для кожного рядка зі значенням. */
const col = (name, rows, pick) => rows.map((r, i) => {
    const v = pick(r);
    return v === null || v === undefined || v === '' ? '' : `<${name} ROWNUM="${i + 1}">${esc(v)}</${name}>`;
}).join('');
const sum = (list, f) => list.reduce((s, x) => s + (f(x) || 0), 0);
const pct = (kop, bp) => Math.round(kop * bp / 10000);

/** «Прізвище Ім'я По батькові» → [прізвище, імʼя, по батькові]. */
function splitName(full) {
    const parts = String(full || '').trim().split(/\s+/);
    return [parts[0] || '', parts[1] || '', parts.slice(2).join(' ')];
}

/**
 * Імʼя файлу: C_REG(2) C_RAJ(2) TIN(10) C_DOC(3) C_DOC_SUB(3) C_DOC_VER(2)
 * C_DOC_STAN(1) C_DOC_TYPE(2) C_DOC_CNT(7) PERIOD_TYPE(1) PERIOD_MONTH(2)
 * PERIOD_YEAR(4) C_STI_ORIG(4).xml
 */
function filename(h) {
    return `${pad(h.reg, 2)}${pad(h.raj, 2)}${pad(h.tin, 10)}J05${h.sub}11${h.stan}${pad(h.type, 2)}${pad(h.cnt, 7)}1${pad(h.month, 2)}${h.year}${pad(h.sti, 4)}.xml`;
}

function head(h, linked) {
    const docs = linked.map((d, i) => `<DOC NUM="${i + 1}" TYPE="${d.linkType}"><C_DOC>J05</C_DOC><C_DOC_SUB>${d.sub}</C_DOC_SUB><C_DOC_VER>11</C_DOC_VER>`
        + `<C_DOC_TYPE>${d.type}</C_DOC_TYPE><C_DOC_CNT>${d.cnt}</C_DOC_CNT><C_DOC_STAN>${h.stan}</C_DOC_STAN><FILENAME>${esc(d.file)}</FILENAME></DOC>`).join('');
    return `<DECLARHEAD><TIN>${esc(h.tin)}</TIN><C_DOC>J05</C_DOC><C_DOC_SUB>${h.sub}</C_DOC_SUB><C_DOC_VER>11</C_DOC_VER><C_DOC_TYPE>${h.type}</C_DOC_TYPE>`
        + `<C_DOC_CNT>${h.cnt}</C_DOC_CNT><C_REG>${h.reg}</C_REG><C_RAJ>${h.raj}</C_RAJ><PERIOD_MONTH>${h.month}</PERIOD_MONTH><PERIOD_TYPE>1</PERIOD_TYPE>`
        + `<PERIOD_YEAR>${h.year}</PERIOD_YEAR><C_STI_ORIG>${h.sti}</C_STI_ORIG><C_DOC_STAN>${h.stan}</C_DOC_STAN>${docs ? `<LINKED_DOCS>${docs}</LINKED_DOCS>` : ''}`
        + `<D_FILL>${h.fill}</D_FILL><SOFTWARE>${SOFTWARE}</SOFTWARE></DECLARHEAD>`;
}
const wrap = (xsd, headXml, body) => `<?xml version="1.0" encoding="windows-1251"?>\n<DECLAR xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="${xsd}.xsd">${headXml}<DECLARBODY>${body}</DECLARBODY></DECLAR>\n`;
const STAN_TAG = { 1: 'HZ', 2: 'HZN', 3: 'HZU' };

/** Перевірка реквізитів ОСББ для звіту: [] — гаразд. */
function orgProblems(org) {
    const out = [];
    if (!/^\d{8}$/.test(org.edrpou || '')) out.push('Код ЄДРПОУ ОСББ — 8 цифр («Налаштування → ОСББ у реєстрах»)');
    if (!String(org.name || '').trim()) out.push('Повна назва ОСББ');
    if (!/^UA\d{17}$/.test(org.katottg || '')) out.push('Код КАТОТТГ (UA і 17 цифр) — з витягу ЄДР чи Електронного кабінету');
    if (!org.sti?.code) out.push('Податкова, до якої подається звіт');
    if (!/^\d{5}$/.test(org.zip || '')) out.push('Поштовий індекс');
    if (!String(org.address || '').trim()) out.push('Податкова адреса');
    if (!/^\d{10}$/.test(org.headTin || '') || !String(org.headName || '').trim()) out.push('Керівник: власне імʼя й прізвище та РНОКПП');
    if (org.accTin && !/^\d{10}$/.test(org.accTin)) out.push('РНОКПП бухгалтера — 10 цифр');
    return out;
}

/**
 * Пакет файлів розрахунку за місяць.
 *   org    — { edrpou, name, katottg, address, zip, phone, email, kved, sti: { reg, raj, code, name },
 *              headName, headTin, accName, accTin }
 *   report — reports-core.payrollReport(…) (затверджена відомість);
 *   run    — run затвердженої відомості (рядки з сумами відпусток, лікарняних, бази ЄСВ);
 *   people — Map(id → картка): стать, код КП, документи про прийом і звільнення.
 *   stan   — 1 звітний, 2 звітний новий, 3 уточнюючий; num — номер розрахунку.
 * Повертає { files: [{ name, xml }], problems }.
 */
function buildPackage({ period, org, report, run, people = new Map(), fillDate, num = 1, stan = 1 }) {
    const problems = orgProblems(org);
    if (report.status !== 'approved') problems.push('Відомість зарплати за місяць не затверджено');
    const rows = run?.rows || [];
    const rate = run?.rate || {};
    const year = Number(period.slice(0, 4)), month = Number(period.slice(5, 7));
    const card = r => people.get(r.personId) || {};
    const tinOf = r => r.payee?.rnokpp || card(r).rnokpp || '';
    for (const r of rows) {
        if (!/^\d{10}$/.test(tinOf(r))) problems.push(`${r.name}: немає РНОКПП`);
        if (!['Ж', 'Ч'].includes(card(r).gender)) problems.push(`${r.name}: стать (Ж/Ч) у картці — для Д1`);
    }
    const relations = report.relations || [];
    for (const rel of relations) {
        const c = people.get(rel.personId) || {};
        if (rel.kind === 'employee' && !c.kpCode) problems.push(`${rel.name}: код класифікатора професій у картці — для Д5`);
        if (!c.gender) problems.push(`${rel.name}: стать (Ж/Ч) у картці — для Д5`);
    }
    if (problems.length) return { files: [], problems: [...new Set(problems)] };

    const base = { tin: org.edrpou, reg: org.sti.reg, raj: org.sti.raj, sti: org.sti.code, month, year, stan, cnt: num, type: 0, fill: dmy(fillDate) };
    const hasD5 = relations.length > 0;
    const names = {
        main: filename({ ...base, sub: DOCS.main.sub }), d1: filename({ ...base, sub: DOCS.d1.sub }),
        df4: filename({ ...base, sub: DOCS.df4.sub }), d5: hasD5 ? filename({ ...base, sub: DOCS.d5.sub }) : null
    };
    const mainLink = [{ linkType: 2, sub: DOCS.main.sub, type: 0, cnt: num, file: names.main }];
    const footer = `${el('HFILL', base.fill)}${el('HKBOS', org.headTin)}${el('HBOS', org.headName)}${el('HKBUH', org.accTin)}${el('HBUH', org.accName)}`;
    const top = `<${STAN_TAG[stan]}>1</${STAN_TAG[stan]}>${el('HZY', year)}${el('HZM', month)}`;

    // ---------------- Д1: рядок на особу, лікарняні — окремим рядком (категорія 29) ----------------
    const maxBase = (rate.minWageKop || 0) * (rate.maxBaseMult || 20);
    const d1 = [];
    for (const r of rows) {
        const sick = (r.sickKop || 0) + (r.fundSickKop || 0);
        const gross = r.grossKop - sick;
        const within = Math.min(gross, maxBase || gross);
        const sickEsv = pct(sick, rate.esv || 2200);
        const esvMain = r.esvKop - sickEsv;
        // База ЄСВ без лікарняних мінус фактична зарплата в межах максимальної — доплата до мінімальної (рядок 2.5, графа 18 Д1).
        const topUp = Math.max(0, (r.esvBaseKop - sick) - within);
        const days = (report.esv || []).find(e => e.personId === r.personId)?.days;
        const [s1, s2, s3] = splitName(r.name);
        const ident = { tin: tinOf(r), gender: card(r).gender, s1, s2, s3 };
        d1.push({ ...ident, cat: '1', days, gross, within, topUp, esv: esvMain,
            main: r.kind === 'employee' ? (r.relationship?.mainJob === false ? '0' : '1') : '0', partTime: r.kind === 'employee' && (r.fte || 1) < 1 ? '1' : '0' });
        if (sick) d1.push({ ...ident, cat: '29', sickDays: r.sickDays || null, gross: sick, within: Math.min(sick, maxBase || sick), topUp: 0, esv: sickEsv, main: null, partTime: null });
    }
    const d1Body = `${top}${el('HNAME', org.name)}${el('HTIN', org.edrpou)}`
        + col('T1RXXXXG5', d1, () => '1') + col('T1RXXXXG6', d1, x => x.gender) + col('T1RXXXXG7S', d1, x => x.tin) + col('T1RXXXXG8', d1, x => x.cat)
        + col('T1RXXXXG101', d1, () => month) + col('T1RXXXXG102', d1, () => year)
        + col('T1RXXXXG111S', d1, x => x.s1) + col('T1RXXXXG112S', d1, x => x.s2) + col('T1RXXXXG113S', d1, x => x.s3)
        + col('T1RXXXXG12', d1, x => x.sickDays) + col('T1RXXXXG13', d1, x => (x.cat === '1' ? 0 : null)) + col('T1RXXXXG14', d1, x => (x.cat === '1' ? x.days : null))
        + col('T1RXXXXG15', d1, x => (x.cat === '1' ? 0 : null))
        + col('T1RXXXXG16', d1, x => money(x.gross)) + col('T1RXXXXG17', d1, x => money(x.within)) + col('T1RXXXXG18', d1, x => money(x.topUp))
        + col('T1RXXXXG19', d1, () => money(0)) + col('T1RXXXXG20', d1, x => money(x.esv))
        + col('T1RXXXXG21', d1, x => x.main) + col('T1RXXXXG22', d1, x => x.partTime) + col('T1RXXXXG23', d1, x => (x.cat === '1' ? '0' : null))
        + col('T1RXXXXG24', d1, x => (x.cat === '1' ? '0' : null)) + col('T1RXXXXG26', d1, x => (x.cat === '1' ? '0' : null))
        + el('R01G16', money(sum(d1, x => x.gross))) + el('R01G17', money(sum(d1, x => x.within))) + el('R01G18', money(sum(d1, x => x.topUp)))
        + el('R01G19', money(0)) + el('R01G20', money(sum(d1, x => x.esv))) + footer;

    // ---------------- 4ДФ: доходи, ПДФО й військовий збір ----------------
    const income = report.income || [];
    const relOf = id => relations.filter(x => x.personId === id);
    const df4Body = `${top}${el('HNUM', num)}${el('HNAME', org.name)}${el('HTIN', org.edrpou)}${el('HKATOTTG', org.katottg)}`
        + el('R00G01I', income.filter(x => x.sign === '101').length) + el('R00G02I', income.filter(x => x.sign === '102').length)
        + col('T1RXXXXG02', income, x => x.rnokpp) + col('T1RXXXXG03A', income, x => money(x.grossKop)) + col('T1RXXXXG03', income, x => money(x.paidKop))
        + col('T1RXXXXG04A', income, x => money(x.pdfoKop)) + col('T1RXXXXG04', income, x => money(x.pdfoPaidKop))
        + col('T1RXXXXG5A', income, x => money(x.vzKop)) + col('T1RXXXXG5', income, x => money(x.vzPaidKop)) + col('T1RXXXXG05', income, x => x.sign)
        + col('T1RXXXXG06D', income, x => dmy(relOf(x.personId).find(e => e.event === 'start')?.date))
        + col('T1RXXXXG07D', income, x => dmy(relOf(x.personId).find(e => e.event === 'end')?.date))
        + col('T1RXXXXG08', income, x => x.pspCode || null) + col('T1RXXXXG09', income, () => '0')
        + el('R01G03A', money(sum(income, x => x.grossKop))) + el('R01G03', money(sum(income, x => x.paidKop)))
        + el('R01G04A', money(sum(income, x => x.pdfoKop))) + el('R01G04', money(sum(income, x => x.pdfoPaidKop)))
        + el('R01G5A', money(sum(income, x => x.vzKop))) + el('R01G5', money(sum(income, x => x.vzPaidKop))) + footer;

    // ---------------- Д5: трудові й цивільно-правові відносини ----------------
    const byPerson = new Map();
    for (const rel of relations) {
        const x = byPerson.get(rel.personId) || { ...rel, start: '', end: '' };
        x[rel.event] = rel.date;
        byPerson.set(rel.personId, x);
    }
    const d5 = [...byPerson.values()].map(x => {
        const c = people.get(x.personId) || {};
        const [s1, s2, s3] = splitName(x.name);
        const gph = x.kind === 'gph';
        return { tin: x.rnokpp || c.rnokpp || '', s1, s2, s3, gph, cat: gph ? '3' : c.mainJob === false ? '2' : '1', start: x.start, end: x.end,
            profession: x.position || c.position || '', kp: gph ? '' : c.kpCode || '', position: gph ? '' : x.position || c.position || '',
            doc: x.end && !x.start ? c.fireDoc || '' : c.hireDoc || c.contract || '', basis: x.end ? c.fireBasis || '' : '' };
    });
    const d5Body = `${top}${el('HNAME', org.name)}${el('HTIN', org.edrpou)}`
        + col('T1RXXXXG5', d5, () => '1') + col('T1RXXXXG6', d5, x => (x.gph ? '1' : '0')) + col('T1RXXXXG7', d5, x => x.cat) + col('T1RXXXXG8S', d5, x => x.tin)
        + col('T1RXXXXG91S', d5, x => x.s1) + col('T1RXXXXG92S', d5, x => x.s2) + col('T1RXXXXG93S', d5, x => x.s3)
        + col('T1RXXXXG101D', d5, x => dmy(x.start)) + col('T1RXXXXG102D', d5, x => dmy(x.end)) + col('T1RXXXXG11', d5, () => '0') + col('T1RXXXXG12', d5, () => '0')
        + col('T1RXXXXG13S', d5, x => x.profession) + col('T1RXXXXG14S', d5, x => x.kp) + col('T1RXXXXG15S', d5, x => x.position)
        + col('T1RXXXXG16S', d5, x => x.doc) + col('T1RXXXXG17S', d5, x => x.basis) + footer;

    // ---------------- Розрахунок (основний документ) ----------------
    const emp = rows.filter(r => r.kind === 'employee');
    const salary = sum(emp, r => r.grossKop - (r.sickKop || 0) - (r.fundSickKop || 0));
    const gphKop = sum(rows.filter(r => r.kind === 'gph'), r => r.grossKop);
    const sickOwn = sum(rows, r => r.sickKop), sickFund = sum(rows, r => r.fundSickKop);
    const within = sum(d1, x => x.within), topUp = sum(d1, x => x.topUp);
    const esv31 = sum(d1, x => pct(x.within, rate.esv || 2200));
    const esvAll = sum(d1, x => x.esv);
    const dim = new Date(Date.UTC(year, month, 0)).getUTCDate();
    const avg = Math.round(sum(emp, r => (r.fte || 1) * ((report.esv || []).find(e => e.personId === r.personId)?.days ?? dim) / dim));
    const linked = [
        { linkType: 1, sub: DOCS.d1.sub, type: 0, cnt: num, file: names.d1 },
        { linkType: 1, sub: DOCS.df4.sub, type: 0, cnt: num, file: names.df4 },
        ...(hasD5 ? [{ linkType: 1, sub: DOCS.d5.sub, type: 0, cnt: num, file: names.d5 }] : [])
    ];
    const kved = (String(org.kved || '').match(/\d{2}\.\d{2}/) || [''])[0];
    const mainBody = `${top}${el('HNUM', num)}${el('HNAME', org.name)}${el('HTIN', org.edrpou)}${el('HKATOTTG', org.katottg)}`
        + `${el('HLOC', org.address)}${el('HZIP', org.zip)}${el('HTEL', org.phone)}${el('HEMAIL', org.email)}${el('HSTI', org.sti.name)}`
        + `<R061G3>1</R061G3><R061G4>1</R061G4><R064G3>1</R064G3><R064G4>1</R064G4>${hasD5 ? '<R065G3>1</R065G3><R065G4>1</R065G4>' : ''}`
        + `${el('HKVED', kved)}${emp.length ? '<R081G3>1</R081G3>' : ''}${el('R091G3', emp.length ? avg : null)}${el('R092G3', emp.filter(r => r.grossKop > 0).length || null)}`
        + el('R0101G3', money(salary + gphKop + sickOwn + sickFund)) + el('R01011G3', money(salary)) + el('R01012G3', money(gphKop))
        + el('R01013G3', money(sickOwn)) + el('R01014G3', money(sickFund)) + el('R01015G3', money(0))
        + el('R0102G3', money(within + topUp)) + el('R01021G3', money(within)) + el('R01025G3', money(topUp))
        + el('R0103G3', money(esvAll)) + el('R01031G3', money(esv31)) + el('R01035G3', money(esvAll - esv31))
        + el('R0107G3', money(esvAll)) + footer;

    const files = [
        { name: names.main, xml: wrap(DOCS.main.name, head({ ...base, sub: DOCS.main.sub }, linked), mainBody) },
        { name: names.d1, xml: wrap(DOCS.d1.name, head({ ...base, sub: DOCS.d1.sub }, mainLink), d1Body) },
        { name: names.df4, xml: wrap(DOCS.df4.name, head({ ...base, sub: DOCS.df4.sub }, mainLink), df4Body) },
        ...(hasD5 ? [{ name: names.d5, xml: wrap(DOCS.d5.name, head({ ...base, sub: DOCS.d5.sub }, mainLink), d5Body) }] : [])
    ];
    return { files, problems: [], totals: { income: salary + gphKop + sickOwn + sickFund, esv: esvAll, pdfo: sum(income, x => x.pdfoKop), vz: sum(income, x => x.vzKop) } };
}

module.exports = { DOCS, encode1251, filename, splitName, orgProblems, buildPackage };
