'use strict';
// ============================================================
// Кошторис ОСББ і фінанси для співвласників.
//
// budgets/{рік}: { year, status: draft|approved, lines: [{ item, title, planKop }],
//   income: [{ source, planKop }], note, decision, files, revisions, … }
//   Чернетку веде бухгалтер; затверджують загальні збори — у системі
//   це запис рішення (протокол). Зміни до затвердженого — лише з новим
//   рішенням, попередня редакція лишається в revisions.
//
// finance/current — те, що бачать мешканці («Фінанси будинку»):
//   виконання кошторису, витрати з документами, загальний борг будинку
//   без прізвищ. Публікує людина (Enter у «Вхідних», коли є зміни).
//   Формат сумісний зі старим ручним звітом: period, items, funds, income.
// ============================================================
const crypto = require('crypto');
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const callGuard = require('./call-guard');
const core = require('./budget-core');
const { ITEMS, DOC_TYPES } = require('./expenses-core');
const charges = require('./charges-core');
const { fromKop, cleanApt } = require('./bank-core');

const REGION = 'europe-central2';
const FILE_URL = /^https:\/\/firebasestorage\.googleapis\.com\/v0\/b\/uspih-25\.(firebasestorage\.app|appspot\.com)\/o\/expenses%2F/;
const PUBLIC_EXPENSES = 80;

module.exports = function budgetFunctions({ db, FieldValue, requireAdmin, staffRole }) {
    const fail = (code, message) => { throw new HttpsError(code, message); };
    const publicityRef = db.doc('finance_settings/public');
    const text = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
    const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Kyiv' }).format(new Date());

    async function audit(actor, role, action, target, summary, details = {}) {
        await db.collection('audit_log').add({
            actor, role, action, target, summary: String(summary).slice(0, 300),
            details: JSON.parse(JSON.stringify(details)), at: FieldValue.serverTimestamp()
        });
    }

    const cleanLines = lines => (Array.isArray(lines) ? lines : []).map(l => ({ item: String(l?.item || ''), title: text(l?.title, 120), planKop: Number(l?.planKop) }));
    const cleanIncome = list => (Array.isArray(list) ? list : []).map(i => ({ source: String(i?.source || ''), planKop: Number(i?.planKop) }));
    function cleanFiles(files) {
        const list = (Array.isArray(files) ? files : []).slice(0, 10).map(f => ({ name: text(f?.name, 160), url: String(f?.url || ''), path: String(f?.path || '') }));
        if (list.some(f => !FILE_URL.test(f.url) || !f.path.startsWith('expenses/'))) fail('invalid-argument', 'Файл має бути завантажений у застосунок');
        return list;
    }

    async function allBudgets() {
        const snap = await db.collection('budgets').get();
        return snap.docs.map(d => ({ id: d.id, ...d.data() }));
    }

    // --------------------------------------------------------
    // КОНТРОЛЬ ДОКУМЕНТІВ ВИТРАТ (для expenses.js)
    // --------------------------------------------------------
    /** Причина, з якої документ має затвердити голова (вихід за кошторис), або null. */
    async function guard(e, exceptId, transaction = null) {
        const read = ref => transaction ? transaction.get(ref) : ref.get();
        const year = String(e.period).slice(0, 4);
        const [budgets, ex, bank, payroll, payments] = await Promise.all([
            read(db.collection('budgets')),
            read(db.collection('expenses').where('item', '==', e.item)),
            read(db.collection('bank_tx').where('period', '>=', `${year}-01`).where('period', '<=', `${year}-12`)),
            read(db.collection('payroll_runs')),
            read(db.collection('payments').where('kind', 'in', ['salary', 'tax']))
        ]);
        const budget = core.effectiveBudget(budgets.docs.map(d => ({ id: d.id, ...d.data() })), year);
        if (!budget) return null;
        const payrollRuns = payroll.docs.map(d => ({ period: d.id, ...d.data() }));
        const approved = new Set(payrollRuns.filter(p => p.status === 'approved').map(p => p.period));
        const payrollPayments = new Map(payments.docs.filter(d => approved.has(d.data().payroll?.period)).map(d => [d.id, d.data()]));
        const fact = core.factByItem({ year, expenses: ex.docs.filter(d => d.id !== exceptId).map(d => d.data()), bankOut: bank.docs.map(d => ({ id: d.id, ...d.data() })), payrollRuns, payrollPayments });
        return core.itemOverrun(budget, e.item, fact.get(e.item) || 0, e.amountKop);
    }

    // --------------------------------------------------------
    // ВИКОНАННЯ Й ДАНІ ДЛЯ МЕШКАНЦІВ
    // --------------------------------------------------------
    async function gather(year) {
        const [budgets, expenses, bank, settings, apartments, chargeSettings, ledgerSnap, supplierSnap, publicity, payrollSnap, payrollPaySnap] = await Promise.all([
            allBudgets(),
            db.collection('expenses').where('period', '>=', `${year}-01`).where('period', '<=', `${year}-12`).get(),
            db.collection('bank_tx').where('period', '>=', `${year}-01`).where('period', '<=', `${year}-12`).get(),
            db.doc('bank/settings').get(),
            db.collection('apartments').get(),
            db.doc('charges/settings').get(),
            db.collectionGroup('ledger').where('period', '>=', charges.START_PERIOD).where('period', '<=', `${year}-12`).get(),
            db.collection('suppliers').get(),
            publicityRef.get(),
            db.collection('payroll_runs').get(),
            db.collection('payments').where('kind', 'in', ['salary', 'tax']).get()
        ]);
        const ex = expenses.docs.map(d => ({ id: d.id, ...d.data() }));
        const tx = bank.docs.map(d => ({ id: d.id, ...d.data() }));
        const budget = core.effectiveBudget(budgets, year);
        const months = core.monthsElapsed(year, today());
        // Оплати мешканців за складовими: розподіл тим самим правилом, що й баланс квартири.
        const cs = chargeSettings.exists ? chargeSettings.data() : {};
        const components = cs.components?.length ? cs.components : charges.DEFAULT_COMPONENTS;
        const ledgers = new Map();
        ledgerSnap.forEach(d => {
            if (d.ref.parent.parent?.parent?.id !== 'apartments') return;
            const apt = d.ref.parent.parent.id;
            if (!ledgers.has(apt)) ledgers.set(apt, []);
            ledgers.get(apt).push(d.data());
        });
        // Вхідний залишок (вересень 2026) теж потрібен для розподілу першої оплати.
        if (cs.opening?.set) {
            (await db.collectionGroup('ledger').where('kind', '==', 'opening').get()).forEach(d => {
                if (d.ref.parent.parent?.parent?.id !== 'apartments') return;
                const apt = d.ref.parent.parent.id;
                if (!ledgers.has(apt)) ledgers.set(apt, []);
                ledgers.get(apt).push(d.data());
            });
        }
        const paid = charges.paidByComponent(ledgers, year, { order: components.map(c => c.id) });
        const incomeParts = components.filter(c => paid[c.id]).map(c => ({ component: c.id, title: c.name, factKop: paid[c.id] }));
        const payrollRuns = payrollSnap.docs.map(d => ({ period: d.id, ...d.data() }));
        const approvedPeriods = new Set(payrollRuns.filter(p => p.status === 'approved').map(p => p.period));
        const payrollPayments = new Map(payrollPaySnap.docs.filter(d => approvedPeriods.has(d.data().payroll?.period)).map(d => [d.id, d.data()]));
        const factInput = { expenses: ex, bankOut: tx, payrollRuns, payrollPayments, year };
        const result = core.execution({ budget, fact: core.factByItem(factInput), income: core.incomeFact({ bankIn: tx, year }), months, incomeParts });
        const accounts = Object.values(settings.exists ? settings.data().accounts || {} : {});
        const fundsKop = accounts.reduce((s, a) => s + (!a.currency || a.currency === 'UAH' ? a.balanceKop || 0 : 0), 0);
        const fundsAt = accounts.map(a => a.balanceAt?.toDate?.()).filter(Boolean).sort((a, b) => b - a)[0] || null;
        const apts = apartments.docs.map(d => ({ apt: cleanApt(d.id), ...d.data() }));
        // Скільки дадуть внески за рік за чинними тарифами — підказка для плану надходжень.
        // Розшифровка статей (як «Внесок на обслуговування ліфтів → платежі» в сервісі):
        // { 'exp-lift': [...], 'inc-rent': [...], 'inc-c-main': [...] }.
        // Номери квартир мешканцям — лише за рішенням правління (finance_settings/public).
        const showApartments = Boolean(publicity.exists && publicity.data().showApartments);
        const info = new Map(apts.map(a => [a.apt, { entrance: a.entrance, nonres: Boolean(cs.premises?.[a.apt] && cs.premises[a.apt] !== 'res') }]));
        const labeler = show => apt => core.aptLabel(cleanApt(apt), info.get(cleanApt(apt)), show);
        const suppliers = new Map(supplierSnap.docs.map(d => [d.id, d.data()]));
        const payOps = charges.paymentOps(ledgers, year, { order: components.map(c => c.id) });
        const ops = publicView => {
            const label = labeler(!publicView || showApartments);
            const out = {};
            for (const [item, list] of Object.entries(core.operationsByItem({ ...factInput, suppliers, docTypes: DOC_TYPES, publicView }))) out[`exp-${item}`] = list;
            for (const [source, list] of Object.entries(core.incomeOpsBySource({ bankIn: tx, year, label, publicView }))) out[`inc-${source}`] = list;
            for (const o of payOps) (out[`inc-c-${o.component}`] ||= []).push({ date: core.kyivDate(o.at), who: label(o.apt), kind: 'apt', amountKop: o.kop });
            for (const k of Object.keys(out).filter(k => k.startsWith('inc-c-'))) {
                out[k].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
            }
            return out;
        };
        const contributionsYearKop = Array.from({ length: 12 }, (_, i) => charges.computeCharges({ apartments: apts.filter(a => !a.isAdmin), premises: cs.premises || {}, tariffs: cs.tariffs || [],
            groups: cs.groups?.length ? cs.groups : charges.DEFAULT_GROUPS, components, period: `${year}-${String(i + 1).padStart(2, '0')}` }).totalKop).reduce((sum, kop) => sum + kop, 0);
        return { budgets, budget, expenses: ex, factInput, result, ops, showApartments, fundsKop, fundsAt, accounts: accounts.length, debt: core.houseDebt(apts, showApartments ? labeler(true) : null), contributionsYearKop };
    }

    const human = d => String(d || '').split('-').reverse().join('.');

    /**
     * Знімок для мешканців: лише цифри ОСББ, без прізвищ; номери квартир —
     * лише за рішенням правління. Операції розшифровки (_ops) публікуються
     * окремими документами finance_ops/{ключ}, у звіті — лише їхній зміст.
     */
    function snapshot(year, g) {
        const r = g.result;
        const ops = g.ops(true);
        const spentByItem = new Map();
        const itemOf = new Map();
        r.sections.forEach(s => s.lines.forEach(l => {
            const key = `${l.item}|${l.title}`;
            spentByItem.set(key, (spentByItem.get(key) || 0) + l.factKop);
            itemOf.set(key, l);
        }));
        const items = [...spentByItem.entries()].filter(([, kop]) => kop > 0).map(([key, kop]) => ({ label: itemOf.get(key).title, item: itemOf.get(key).item, amount: fromKop(kop) }));
        const start = `${year}-01` > '2026-10' ? `01.01.${year}` : '01.10.2026';
        const expenses = g.expenses.filter(e => ['approved', 'paid', 'storno'].includes(e.status) && String(e.period).startsWith(year))
            .sort((a, b) => (a.date < b.date ? 1 : -1)).slice(0, PUBLIC_EXPENSES)
            .map(e => ({ date: e.date, supplier: e.supplierName || '', description: e.description || '', doc: `${DOC_TYPES[e.docType] || 'Документ'} № ${e.number}`,
                item: ITEMS[e.item] || '', amountKop: e.amountKop, paid: e.status === 'paid', files: (e.files || []).map(f => ({ name: f.name, url: f.url })) }));
        return {
            source: 'ledger', year: String(year),
            period: `${year} рік: з ${start} по ${human(today())}`,
            items, total: fromKop(r.totals.factKop),
            income: fromKop(r.totals.incomeFactKop),
            funds: g.accounts ? fromKop(g.fundsKop) : null,
            fundsDate: g.fundsAt ? human(new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Kyiv' }).format(g.fundsAt)) : '',
            budget: g.budget ? {
                year: String(g.budget.year), carried: g.budget.carried, decision: g.budget.decision || '', months: r.months,
                sections: r.sections.map(s => ({ title: s.title, planKop: s.planKop, toDateKop: s.toDateKop, factKop: s.factKop,
                    lines: s.lines.map(l => ({ item: l.item, title: l.title, planKop: l.planKop, toDateKop: l.toDateKop, factKop: l.factKop, outside: Boolean(l.outside) })) })),
                income: r.income.map(i => ({ source: i.source, title: i.title, planKop: i.planKop, toDateKop: i.toDateKop, factKop: i.factKop, ...(i.parts ? { parts: i.parts } : {}) })),
                totals: r.totals
            } : null,
            // «Звідки гроші» — і без затвердженого кошторису.
            incomeItems: r.income.filter(i => i.factKop).map(i => ({ source: i.source, title: i.title, factKop: i.factKop, ...(i.parts ? { parts: i.parts } : {}) })),
            debt: g.debt,
            showApartments: g.showApartments,
            expenses,
            opsIndex: Object.fromEntries(Object.entries(ops).map(([k, list]) => [k, { count: list.length, totalKop: list.reduce((t, o) => t + o.amountKop, 0) }])),
            _ops: ops
        };
    }

    const sha = obj => crypto.createHash('sha1').update(JSON.stringify(obj)).digest('hex').slice(0, 16);
    /** Зміст звіту без дати й залишків на рахунках: вони змінюються щогодини й не є «новиною». */
    const hashOf = s => sha({ items: s.items, income: s.income, budget: s.budget, debt: s.debt, expenses: s.expenses, ops: s.opsIndex, show: s.showApartments });
    const budgetHash = s => sha(s.budget ? { year: s.budget.year, decision: s.budget.decision, plan: s.budget.totals.planKop, lines: s.budget.sections.map(x => x.lines.map(l => l.planKop)) } : null);

    /**
     * Чи варто оновити звіт для мешканців: кошторис змінився — одразу;
     * інші зміни (оплати, витрати) — не частіше ніж раз на тиждень.
     */
    function isStale(pub, snap, y) {
        if (!pub || pub.source !== 'ledger' || pub.year !== y || pub.budgetHash !== budgetHash(snap)) return true;
        if (pub.hash === hashOf(snap)) return false;
        const at = pub.updatedAt?.toDate?.();
        return !at || Date.now() - at.getTime() >= 7 * 864e5;
    }

    async function context({ year }) {
        const y = core.validYear(year) ? String(year) : today().slice(0, 4);
        const [g, published] = await Promise.all([gather(y), db.doc('finance/current').get()]);
        const own = g.budgets.find(b => String(b.year) === y) || null;
        const snap = snapshot(y, g);
        const pub = published.exists ? published.data() : null;
        const plain = b => b && ({ ...b, updatedAt: b.updatedAt?.toDate?.()?.toISOString() || null, approvedAt: b.approvedAt?.toDate?.()?.toISOString() || null,
            revisions: (b.revisions || []).map(r => ({ ...r, at: r.at?.toDate?.()?.toISOString?.() || r.at || null })) });
        return {
            year: y, today: today(), years: g.budgets.map(b => ({ year: String(b.year), status: b.status })).sort((a, b) => b.year.localeCompare(a.year)),
            budget: plain(own), effective: g.budget ? { year: String(g.budget.year), carried: g.budget.carried, decision: g.budget.decision || '' } : null,
            execution: g.result, ops: g.ops(false), showApartments: g.showApartments, debt: g.debt, fundsKop: g.accounts ? g.fundsKop : null, contributionsYearKop: g.contributionsYearKop,
            items: ITEMS, sections: core.SECTIONS, groups: core.GROUPS, incomeSources: core.INCOME_SOURCES,
            publish: { stale: isStale(pub, snap, y),
                at: pub?.updatedAt?.toDate?.()?.toISOString() || null, legacy: Boolean(pub && pub.source !== 'ledger') }
        };
    }

    // --------------------------------------------------------
    // ДІЇ
    // --------------------------------------------------------
    async function save(actor, role, { year, lines, income, note }) {
        const b = { year: String(year), lines: cleanLines(lines), income: cleanIncome(income) };
        const error = core.checkBudget(b);
        if (error) fail('invalid-argument', error);
        const ref = db.doc(`budgets/${b.year}`);
        const prev = await ref.get();
        if (prev.exists && prev.data().status === 'approved') fail('failed-precondition', 'Кошторис уже затверджено. Зміни — лише з новим рішенням зборів («Внести зміни»).');
        await ref.set({ ...b, note: text(note, 500), status: 'draft', updatedBy: actor, updatedAt: FieldValue.serverTimestamp(),
            ...(prev.exists ? {} : { createdBy: actor, createdAt: FieldValue.serverTimestamp() }) }, { merge: true });
        await audit(actor, role, 'budget.save', `budgets/${b.year}`, `Кошторис ${b.year} (чернетка): ${b.lines.length} статей, ${fromKop(b.lines.reduce((s, l) => s + l.planKop, 0))} грн`, { lines: b.lines.length });
        return { ok: true };
    }

    async function approve(actor, role, { year, decision, files }) {
        const ref = db.doc(`budgets/${String(year)}`);
        const snap = await ref.get();
        if (!snap.exists) fail('not-found', 'Спершу збережіть чернетку кошторису');
        const b = snap.data();
        if (b.status === 'approved') fail('failed-precondition', 'Кошторис уже затверджено');
        const err = core.checkDecision(decision) || (b.lines?.length ? null : 'У кошторисі немає жодної статті');
        if (err) fail('invalid-argument', err);
        await ref.update({ status: 'approved', decision: text(decision, 200), files: cleanFiles(files), approvedBy: actor, approvedAt: FieldValue.serverTimestamp(),
            revisions: [{ at: new Date().toISOString(), by: actor, decision: text(decision, 200), planKop: b.lines.reduce((s, l) => s + l.planKop, 0) }] });
        await audit(actor, role, 'budget.approve', `budgets/${year}`, `Кошторис ${year} затверджено: ${text(decision, 200)}`, { decision: text(decision, 200) });
        return { ok: true };
    }

    async function amend(actor, role, { year, lines, income, decision }) {
        const ref = db.doc(`budgets/${String(year)}`);
        const snap = await ref.get();
        if (!snap.exists || snap.data().status !== 'approved') fail('failed-precondition', 'Зміни вносяться до затвердженого кошторису');
        const err = core.checkDecision(decision);
        if (err) fail('invalid-argument', 'Зміни до кошторису теж затверджують загальні збори: вкажіть протокол');
        const b = { year: String(year), lines: cleanLines(lines), income: cleanIncome(income) };
        const error = core.checkBudget(b);
        if (error) fail('invalid-argument', error);
        const prev = snap.data();
        await ref.update({ lines: b.lines, income: b.income, decision: text(decision, 200), updatedBy: actor, updatedAt: FieldValue.serverTimestamp(),
            revisions: [...(prev.revisions || []), { at: new Date().toISOString(), by: actor, decision: text(decision, 200),
                planKop: b.lines.reduce((s, l) => s + l.planKop, 0), previous: { lines: prev.lines, income: prev.income, decision: prev.decision } }].slice(-20) });
        await audit(actor, role, 'budget.amend', `budgets/${year}`, `Зміни до кошторису ${year}: ${text(decision, 200)}`, { decision: text(decision, 200) });
        return { ok: true };
    }

    async function copy(actor, role, { year, fromYear }) {
        const to = db.doc(`budgets/${String(year)}`);
        if (!core.validYear(year)) fail('invalid-argument', 'Невідомий рік');
        if ((await to.get()).exists) fail('already-exists', `Кошторис на ${year} уже є`);
        const from = await db.doc(`budgets/${String(fromYear)}`).get();
        if (!from.exists) fail('not-found', `Кошторису на ${fromYear} немає`);
        await to.set({ year: String(year), lines: from.data().lines || [], income: from.data().income || [], note: `На основі кошторису ${fromYear}`,
            status: 'draft', createdBy: actor, createdAt: FieldValue.serverTimestamp(), updatedBy: actor, updatedAt: FieldValue.serverTimestamp() });
        await audit(actor, role, 'budget.copy', `budgets/${year}`, `Чернетка кошторису ${year} з кошторису ${fromYear}`);
        return { ok: true };
    }

    /**
     * Показувати мешканцям номери квартир у надходженнях і боргах (як у
     * сервісі). Рішення правління — змінює лише голова; звіт оновлюється.
     */
    async function visibility(actor, role, { showApartments }) {
        if (role !== 'chair') fail('permission-denied', 'Це рішення правління: змінює голова');
        const show = Boolean(showApartments);
        await publicityRef.set({ showApartments: show, by: actor, at: FieldValue.serverTimestamp() });
        await audit(actor, role, 'finance.visibility', 'finance_settings/public', show ? 'Мешканці бачать номери квартир у надходженнях і боргах' : 'Номери квартир мешканцям приховано', { showApartments: show });
        if ((await db.doc('finance/current').get()).data()?.source === 'ledger') await publish(actor, role, { year: today().slice(0, 4) });
        return { ok: true };
    }

    /** Опублікувати мешканцям («Фінанси будинку»). */
    async function publish(actor, role, { year }) {
        const y = core.validYear(year) ? String(year) : today().slice(0, 4);
        const { _ops: ops, ...snap } = snapshot(y, await gather(y));
        for (const [key, list] of Object.entries(ops)) {
            if (Buffer.byteLength(JSON.stringify(list), 'utf8') > 850000) fail('failed-precondition', `Розшифровка «${key}» завелика для одного документа. Звіт не опубліковано; потрібне розбиття на сторінки.`);
        }
        const doc = { ...snap, hash: hashOf(snap), budgetHash: budgetHash(snap), publishedBy: actor, updatedAt: FieldValue.serverTimestamp() };
        // Спершу розшифровка, потім звіт: мешканець не відкриє статтю без операцій.
        const stale = (await db.collection('finance_ops').get()).docs.filter(d => !ops[d.id]);
        // По одному: документ взносів великого будинку — сотні КБ, пакет обмежено 10 МБ.
        for (const [k, list] of Object.entries(ops)) await db.doc(`finance_ops/${k}`).set({ year: y, ops: list, updatedAt: FieldValue.serverTimestamp() });
        for (const d of stale) await d.ref.delete();
        await db.doc('finance/current').set(doc);
        // Архів за роками — для річного звіту зборам.
        await db.doc(`finance/${y}`).set(doc);
        await audit(actor, role, 'finance.publish', 'finance/current', `Фінанси для мешканців оновлено: ${y}, витрачено ${snap.total} грн`, { year: y });
        return { ok: true };
    }

    const budgetAction = onCall({ region: REGION, maxInstances: 4, timeoutSeconds: 60 }, callGuard('budgetAction', async request => {
        const actor = await requireAdmin(request, ['chair', 'accountant']);
        const role = await staffRole(actor);
        const data = request.data || {};
        switch (data.action) {
            case 'context': return context(data);
            case 'save': return save(actor, role, data);
            case 'approve': return approve(actor, role, data);
            case 'amend': return amend(actor, role, data);
            case 'copy': return copy(actor, role, data);
            case 'publish': return publish(actor, role, data);
            case 'visibility': return visibility(actor, role, data);
            default: fail('invalid-argument', 'Невідома дія');
        }
    }));

    return { budgetAction, guard, actions: { context, save, approve, amend, copy, publish, visibility } };
};
