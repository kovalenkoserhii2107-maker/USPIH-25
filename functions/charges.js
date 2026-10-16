'use strict';
// ============================================================
// Нарахування внесків і баланс мешканця з історії.
//
// Система готує нарахування за місяць (площа × тариф) → бухгалтер
// підтверджує (Enter у «Вхідних») → сервер пише записи «Нарахування»
// в історію квартир і перераховує баланси.
//
// З моменту, коли внесено вхідні залишки на 30.09.2026, баланс
// квартири (apartments/{кв}.balance) рахує тільки сервер:
//   вхідний залишок + оплати − нарахування від жовтня 2026.
// Оплати з виписки (bank.js) і нарахування викликають перерахунок.
//
// Колекції (запис — лише сервер, читання — голова й бухгалтер):
//   charges/settings     — групи приміщень, тарифи, приміщення→група,
//                          стан вхідних залишків
//   charges_runs/{місяць} — що й кому нараховано: { amounts: {кв: коп}, … }
// Історія квартири: apartments/{кв}/ledger/charge-{місяць} і /opening.
// ============================================================
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const callGuard = require('./call-guard');
const logger = require('firebase-functions/logger');
const core = require('./charges-core');
const { cleanApt, fromKop } = require('./bank-core');

const REGION = 'europe-central2';

module.exports = function chargeFunctions({ db, FieldValue, Timestamp, requireAdmin, staffRole, lock }) {
    const settingsRef = db.doc('charges/settings');
    const fail = (code, message) => { throw new HttpsError(code, message); };
    const operationRef = db.doc('charges/operation');
    // Пакетні зміни всього будинку не можуть перетинатися між собою
    // або із закриттям місяця. Токен дозволяє відновитись після тайм-ауту.
    async function withOperation(name, fn, period) {
        const token = db.collection('_').doc().id;
        await db.runTransaction(async t => {
            const current = (await t.get(operationRef)).data();
            if (current?.active && current.until > Date.now()) fail('aborted', 'Інша операція нарахувань ще виконується. Спробуйте після її завершення.');
            if (period) await lock?.assertOpen(period, 'Нарахування', t);
            t.set(operationRef, { token, name, active: true, until: Date.now() + 10 * 60 * 1000 });
        });
        try { return await fn(); }
        finally {
            await db.runTransaction(async t => {
                const current = (await t.get(operationRef)).data();
                if (current?.token === token) t.update(operationRef, { active: false });
            });
        }
    }

    // --------------------------------------------------------
    // НЕЗАВЕРШЕНІ МАСОВІ ОПЕРАЦІЇ
    // --------------------------------------------------------
    // Нарахування, скасування й вхідні залишки пишуться пакетами по 400.
    // Перед першим пакетом сервер зберігає повний план (що й куди писати)
    // і позначає операцію «записується»; після останнього — «завершено».
    // Обрив між пакетами лишає план: «Завершити операцію» дописує решту
    // тим самим планом (записи з тими самими ID — повтор нічого не дублює),
    // а доти закрити місяць не можна (reconciliation-core).
    const planRef = period => db.doc(`charges_runs/${period}/plan/main`);
    const openingPlanRef = db.doc('charges/opening_plan');

    async function unfinished() {
        const [runs, opening] = await Promise.all([
            db.collection('charges_runs').where('status', 'in', ['writing', 'reverting']).get(),
            openingPlanRef.get()
        ]);
        return [...runs.docs.map(d => ({ kind: d.data().status === 'writing' ? 'run' : 'revert', period: d.id })),
            ...(opening.exists ? [{ kind: 'opening', period: core.OPENING_PERIOD }] : [])];
    }
    async function assertNoUnfinished(except) {
        const list = (await unfinished()).filter(u => !(except && u.kind === except.kind && u.period === except.period));
        if (list.length) fail('failed-precondition', `Спершу завершіть перервану операцію: ${list.map(u => u.kind === 'opening' ? 'вхідні залишки' : `${u.kind === 'run' ? 'нарахування' : 'скасування'} за ${core.periodName(u.period)}`).join(', ')} («Нарахування» → «Завершити операцію»)`);
    }

    /** Запис пакетами по 400: [{ ref, data } | { ref, delete: true }]. */
    async function writeAll(items, actor) {
        let batch = db.batch(), ops = 0;
        for (const it of items) {
            if (it.delete) batch.delete(it.ref);
            else batch.set(it.ref, { ...it.data, createdAt: FieldValue.serverTimestamp(), createdBy: actor });
            if (++ops >= 400) { await batch.commit(); batch = db.batch(); ops = 0; }
        }
        if (ops) await batch.commit();
    }

    async function audit(actor, role, action, target, summary, details = {}) {
        await db.collection('audit_log').add({
            actor, role, action, target, summary: String(summary).slice(0, 300),
            details: JSON.parse(JSON.stringify(details)), at: FieldValue.serverTimestamp()
        });
    }

    async function loadSettings() {
        const snap = await settingsRef.get();
        const data = snap.exists ? snap.data() : {};
        return {
            groups: data.groups?.length ? data.groups : core.DEFAULT_GROUPS,
            components: data.components?.length ? data.components : core.DEFAULT_COMPONENTS,
            tariffs: data.tariffs || [],
            premises: data.premises || {},
            startPeriod: data.startPeriod || core.START_PERIOD,
            startDate: data.startDate || `${data.startPeriod || core.START_PERIOD}-01`,
            opening: data.opening || null
        };
    }

    /** Приміщення будинку — без службових записів (правління, бухгалтер). */
    async function loadApartments() {
        const snap = await db.collection('apartments').get();
        const rows = snap.docs.filter(d => d.data().isAdmin !== true)
            .map(d => ({ apt: cleanApt(d.id), id: d.id, area: d.data().area ?? null, residents: d.data().residents ?? null, balance: d.data().balance ?? null, personalAccount: d.data().personalAccount || '' }));
        if (new Set(rows.map(a => a.apt)).size !== rows.length) fail('failed-precondition', 'У довіднику є приміщення з однаковими номерами після нормалізації. Усуньте дублікати перед нарахуванням.');
        return rows;
    }

    // --------------------------------------------------------
    // БАЛАНСИ
    // --------------------------------------------------------
    async function ledgerOf(aptId) {
        const snap = await db.collection(`apartments/${aptId}/ledger`).get();
        return snap.docs.map(d => ({ _id: d.id, ...d.data() }));
    }

    async function allLedgers() {
        const snap = await db.collectionGroup('ledger').get();
        const map = new Map();
        snap.forEach(d => {
            const apt = d.ref.parent.parent?.id;
            if (!apt || d.ref.parent.parent.parent.id !== 'apartments') return;
            if (!map.has(apt)) map.set(apt, []);
            map.get(apt).push({ _id: d.id, ...d.data() });
        });
        return map;
    }

    /**
     * Перерахувати баланси з історії. apts — лише ці квартири (після
     * оплати), без apts — усі. Поки вхідні залишки не внесено, баланс
     * веде бухгалтер вручну, і сервер його не чіпає.
     *
     * Спільний документ charges/settings читається один раз до циклу
     * і звіряється після нього, а транзакції квартир виконуються послідовно,
     * щоб уникнути блокувань транзакцій (Transaction lock timeout) в емуляторі
     * та при масових імпортах.
     */
    async function recompute(apts) {
        const settings = await loadSettings();
        if (!settings.opening?.set) return { skipped: true, updated: 0 };
        const targets = apts ? [...new Set(apts.map(String))] : (await loadApartments()).map(a => a.id);
        const same = (a, b) => JSON.stringify(a || []) === JSON.stringify(b || []);

        for (let attempt = 0; attempt < 3; attempt++) {
            const settingsSnap = await settingsRef.get();
            const current = settingsSnap.data() || {};
            if (!current.opening?.set) return { skipped: true, updated: 0 };
            const updated = await recomputeWith(targets, current, same);
            const after = await settingsRef.get();
            const unchanged = settingsSnap.updateTime && after.updateTime && typeof settingsSnap.updateTime.isEqual === 'function'
                ? settingsSnap.updateTime.isEqual(after.updateTime)
                : JSON.stringify(after.data() || {}) === JSON.stringify(current);
            if (unchanged) return { updated };
        }
        throw new Error('Налаштування нарахувань змінювалися під час перерахунку балансів');
    }

    async function recomputeWith(targets, current, same) {
        let updated = 0;
        const currentComponents = current.components?.length ? current.components : core.DEFAULT_COMPONENTS;
        const currentNames = new Map(currentComponents.map(c => [c.id, c.name]));
        const currentNamed = parts => Object.entries(parts).filter(([, v]) => v).map(([component, amountKop]) => ({ component, name: currentNames.get(component) || 'Інше', amountKop }));

        const recomputeOne = apt => db.runTransaction(async t => {
            const ref = db.doc(`apartments/${apt}`);
            const [snap, ledger] = await Promise.all([t.get(ref), t.get(db.collection(`apartments/${apt}/ledger`))]);
            if (!snap.exists || snap.data().isAdmin === true) return false;
            const entries = ledger.docs.map(d => ({ _id: d.id, ...d.data() }));
            const { balances, steps } = core.replay(entries, { startPeriod: current.startPeriod || core.START_PERIOD, startDate: current.startDate, order: currentComponents.map(c => c.id) });
            for (const { entry, parts } of steps) {
                if (!['payment', 'refund'].includes(entry.kind) || !entry._id || same(entry.alloc, currentNamed(parts))) continue;
                t.update(db.doc(`apartments/${apt}/ledger/${entry._id}`), { alloc: currentNamed(parts) });
            }
            const balance = fromKop(core.balanceFromLedger(entries, current.startPeriod || core.START_PERIOD, current.startDate));
            if (snap.data().balance === balance && snap.data().balanceSource === 'ledger' && same(snap.data().balanceParts, currentNamed(balances))) return false;
            t.set(ref, { balance, balanceParts: currentNamed(balances), balanceSource: 'ledger', balanceUpdatedBy: 'system', balanceUpdatedAt: FieldValue.serverTimestamp() }, { merge: true });
            return true;
        });

        for (const apt of targets) {
            for (let retry = 0; retry < 4; retry++) {
                try {
                    if (await recomputeOne(apt)) updated++;
                    break;
                } catch (e) {
                    const isTransient = e?.code === 10 || /ABORTED|lock timeout/i.test(String(e?.message || ''));
                    if (!isTransient || retry === 3) throw e;
                    await new Promise(r => setTimeout(r, 40 * (retry + 1)));
                }
            }
        }
        return updated;
    }

    /** Для bank.js: помилка перерахунку не має зривати рознесення оплати. */
    async function recomputeSafe(apts) {
        try { return await recompute(apts); }
        catch (e) { logger.error('Перерахунок балансів', e); return { error: true }; }
    }

    // --------------------------------------------------------
    // СТАН ДЛЯ КАБІНЕТУ
    // --------------------------------------------------------
    async function loadRuns(limit = 24) {
        const snap = await db.collection('charges_runs').orderBy('period', 'desc').limit(limit).get();
        return snap.docs.map(d => {
            const x = d.data();
            return {
                period: d.id, totalKop: x.totalKop || 0, count: x.count || 0,
                byGroup: x.byGroup || {}, byComponent: x.byComponent || {}, problems: x.problems || [],
                status: x.status || 'complete', complete: x.complete !== false,
                expectedCount: (x.expectedApts || []).length || x.count || 0,
                createdBy: x.createdBy || '', createdAt: x.createdAt?.toDate ? x.createdAt.toDate().toISOString() : null
            };
        });
    }

    async function context(reqPeriod) {
        const [settings, apartments, runs, pending] = await Promise.all([loadSettings(), loadApartments(), loadRuns(), unfinished()]);
        const now = core.currentPeriod();
        const period = core.validPeriod(reqPeriod) && reqPeriod >= settings.startPeriod && reqPeriod <= now ? reqPeriod : now;
        const preview = core.computeCharges({ ...settings, apartments, period });
        const done = new Set(runs.map(r => r.period));
        const due = core.periodsBetween(settings.startPeriod, now).filter(p => !done.has(p));
        const forecast = core.yearForecast({ ...settings, apartments, year: Number(period.slice(0, 4)) });
        return {
            ...settings, period, current: now, due, runs, unfinished: pending,
            apartments: apartments.sort((a, b) => a.apt.localeCompare(b.apt, 'uk', { numeric: true })),
            preview: { period, totalKop: preview.totalKop, count: preview.rows.length, byGroup: preview.byGroup, byComponent: preview.byComponent, problems: preview.problems, rows: preview.rows.slice(0, 500) },
            forecast, items: require('./expenses-core').ITEMS
        };
    }

    // --------------------------------------------------------
    // НАЛАШТУВАННЯ ТАРИФІВ І ГРУП
    // --------------------------------------------------------
    async function addGroup(actor, role, { name }) {
        const settings = await loadSettings();
        const checked = core.checkGroup(name, settings.groups);
        if (checked.error) fail('invalid-argument', checked.error);
        const groups = [...settings.groups, checked.group];
        await settingsRef.set({ groups, updatedBy: actor, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
        await audit(actor, role, 'charges.group', 'charges/settings', `Додано групу «${checked.group.name}»`, checked.group);
        return { ok: true, id: checked.group.id };
    }

    async function addComponent(actor, role, data) {
        const settings = await loadSettings();
        const checked = core.checkComponent(data, settings.components);
        if (checked.error) fail('invalid-argument', checked.error);
        const components = [...settings.components, checked.component];
        await settingsRef.set({ components, updatedBy: actor, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
        await audit(actor, role, 'charges.component', 'charges/settings', `Додано складову внеску «${checked.component.name}»`, checked.component);
        return { ok: true, id: checked.component.id };
    }

    async function renameComponent(actor, role, { id, name, item }) {
        const clean = String(name || '').replace(/\s+/g, ' ').trim().slice(0, 80);
        if (clean.length < 2) fail('invalid-argument', 'Вкажіть назву складової');
        const settings = await loadSettings();
        const idx = settings.components.findIndex(c => c.id === id);
        if (idx < 0) fail('not-found', 'Складову не знайдено');
        const components = settings.components.map((c, i) => i === idx ? { ...c, name: clean, ...(item ? { item } : {}) } : c);
        await settingsRef.set({ components, updatedBy: actor, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
        await audit(actor, role, 'charges.component.rename', 'charges/settings', `Складову «${id}» перейменовано на «${clean}»`, { id, name: clean, item });
        return { ok: true };
    }

    async function setResidents(actor, role, { rows }) {
        if (!Array.isArray(rows) || !rows.length || rows.length > 600) fail('invalid-argument', 'Передайте список приміщень');
        const apartments = await loadApartments();
        const byApt = new Map(apartments.map(a => [a.apt, a.id]));
        let batch = db.batch(), ops = 0;
        for (const r of rows) {
            const apt = cleanApt(r?.apt);
            const id = byApt.get(apt);
            if (!id) fail('not-found', `Приміщення ${apt || '?'} немає в довіднику`);
            const n = Number(r.residents);
            if (!Number.isInteger(n) || n < 0 || n > 50) fail('invalid-argument', `Кв. ${apt}: кількість мешканців — ціле число від 0 до 50`);
            batch.update(db.doc(`apartments/${id}`), { residents: n });
            if (++ops >= 400) { await batch.commit(); batch = db.batch(); ops = 0; }
        }
        if (ops) await batch.commit();
        await audit(actor, role, 'charges.residents', 'apartments', `Оновлено кількість мешканців: ${rows.length} приміщень`, { count: rows.length });
        return { ok: true, count: rows.length };
    }

    async function addTariff(actor, role, data) {
        const settings = await loadSettings();
        const checked = core.checkTariff(data, settings.groups, settings.tariffs, settings.components);
        if (checked.error) fail('invalid-argument', checked.error);
        const tariffs = [...settings.tariffs, { ...checked.tariff, createdBy: actor, createdAt: new Date().toISOString() }];
        await settingsRef.set({ tariffs, updatedBy: actor, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
        const groupName = settings.groups.find(g => g.id === checked.tariff.group)?.name || checked.tariff.group;
        const comp = settings.components.find(c => c.id === checked.tariff.component);
        const unit = comp?.base === 'residents' ? 'грн/особу' : comp?.base === 'fixed' ? 'грн/прим.' : 'грн/м²';
        await audit(actor, role, 'charges.tariff', 'charges/settings',
            `Тариф для «${groupName}» (${comp?.name || 'внесок'}) з ${core.periodName(checked.tariff.from)}: ${fromKop(checked.tariff.rateKop)} ${unit} (${checked.tariff.decision})`, checked.tariff);
        return { ok: true };
    }

    async function removeTariff(actor, role, { id }) {
        const settings = await loadSettings();
        const t = settings.tariffs.find(x => x.id === id);
        if (!t) fail('not-found', 'Тариф не знайдено');
        const used = await db.collection('charges_runs').where('period', '>=', t.from).limit(1).get();
        if (!used.empty) fail('failed-precondition', `За цим тарифом уже нараховано внески (${core.periodName(used.docs[0].id)}). Додайте новий тариф з потрібного місяця — історія залишиться точною.`);
        const tariffs = settings.tariffs.filter(x => x.id !== id);
        await settingsRef.set({ tariffs, updatedBy: actor, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
        await audit(actor, role, 'charges.tariff.remove', 'charges/settings', `Прибрано тариф ${fromKop(t.rateKop)} грн з ${t.from}`, t);
        return { ok: true };
    }

    async function setPremises(actor, role, { apts, group }) {
        const list = (Array.isArray(apts) ? apts : String(apts || '').split(/[,;\s]+/)).map(cleanApt).filter(Boolean);
        if (!list.length) fail('invalid-argument', 'Вкажіть номери приміщень');
        const [settings, apartments] = await Promise.all([loadSettings(), loadApartments()]);
        if (group !== 'res' && !settings.groups.some(g => g.id === group)) fail('invalid-argument', 'Оберіть групу зі списку');
        const known = new Set(apartments.map(a => a.apt));
        const unknown = list.filter(a => !known.has(a));
        if (unknown.length) fail('not-found', `У довіднику немає приміщень: ${unknown.slice(0, 10).join(', ')}`);
        const premises = { ...settings.premises };
        for (const a of list) { if (group === 'res') delete premises[a]; else premises[a] = group; }
        await settingsRef.set({ premises, updatedBy: actor, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
        const groupName = settings.groups.find(g => g.id === group)?.name || 'Квартири';
        await audit(actor, role, 'charges.premises', 'charges/settings', `${list.join(', ')} → група «${groupName}»`, { apts: list, group });
        return { ok: true };
    }

    // --------------------------------------------------------
    // ВХІДНІ ЗАЛИШКИ НА 30.09.2026
    // --------------------------------------------------------
    async function setOpening(actor, role, { rows, date }) {
        return withOperation('opening', () => setOpeningInner(actor, role, { rows, date }));
    }
    async function setOpeningInner(actor, role, { rows, date }) {
        await assertNoUnfinished({ kind: 'opening', period: core.OPENING_PERIOD });
        if (!Array.isArray(rows) || !rows.length || rows.length > 600) fail('invalid-argument', 'Передайте список приміщень із залишками');
        const [apartments, settings] = await Promise.all([loadApartments(), loadSettings()]);
        const startDate = date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : settings.startDate || `${core.START_PERIOD}-01`;
        const startPeriod = startDate.slice(0, 7);
        await lock?.assertOpen(startPeriod, 'Вхідні залишки');
        const cutDate = new Date(`${startDate}T00:00:00Z`); cutDate.setUTCDate(cutDate.getUTCDate() - 1);
        const cutIso = cutDate.toISOString().slice(0, 10);
        const cutHuman = cutIso.split('-').reverse().join('.');
        const cutPeriod = cutIso.slice(0, 7);
        const validIds = new Set(settings.components.map(c => c.id));
        const byApt = new Map(apartments.map(a => [a.apt, a.id]));
        const values = new Map();
        const rowParts = new Map();
        for (const r of rows) {
            const apt = cleanApt(r?.apt);
            if (!byApt.has(apt)) fail('not-found', `Приміщення ${apt || '?'} немає в довіднику`);
            const kop = Number(r.amountKop);
            if (!Number.isInteger(kop) || Math.abs(kop) > 100_000_000) fail('invalid-argument', `Кв. ${apt}: некоректна сума залишку`);
            if (r.parts && typeof r.parts === 'object') {
                const clean = {};
                let sum = 0;
                for (const [k, v] of Object.entries(r.parts)) {
                    if (!validIds.has(k)) fail('invalid-argument', `Кв. ${apt}: невідома складова «${k}»`);
                    const pk = Number(v);
                    if (!Number.isInteger(pk)) fail('invalid-argument', `Кв. ${apt}: некоректна сума за складовою`);
                    if (pk) { clean[k] = pk; sum += pk; }
                }
                if (sum !== kop) fail('invalid-argument', `Кв. ${apt}: сума за складовими (${fromKop(sum)} грн) не дорівнює загальному залишку (${fromKop(kop)} грн)`);
                rowParts.set(apt, clean);
            }
            values.set(apt, kop);
        }
        const at = Timestamp.fromDate(new Date(`${cutIso}T21:00:00Z`));
        let debtKop = 0, overpaidKop = 0;
        const planRows = [];
        for (const [apt, id] of byApt) {
            const kop = values.get(apt) ?? 0;
            if (kop < 0) debtKop += -kop; else overpaidKop += kop;
            const parts = rowParts.get(apt) || null;
            planRows.push({ id, kop, ...(parts ? { parts } : {}) });
        }
        const summary = { set: true, count: byApt.size, debtKop, overpaidKop, cutDate: cutIso, by: actor, at: new Date().toISOString() };
        await openingPlanRef.set({ rows: planRows, summary, startDate, startPeriod, cutIso, cutHuman, cutPeriod, actor, createdAt: FieldValue.serverTimestamp() });
        await writeAll(planRows.map(r => ({
            ref: db.doc(`apartments/${r.id}/ledger/opening`),
            data: { at, period: cutPeriod, kind: 'opening', amount: fromKop(r.kop), amountKop: r.kop, ...(r.parts ? { parts: r.parts } : {}),
                note: `Вхідний залишок на ${cutHuman}: ${r.kop < 0 ? `борг ${fromKop(-r.kop)}` : r.kop > 0 ? `переплата ${fromKop(r.kop)}` : '0'} грн`, source: 'opening' }
        })), actor);
        await settingsRef.set({ opening: summary, startDate, startPeriod, updatedBy: actor, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
        await openingPlanRef.delete();
        const balances = await recompute();
        await audit(actor, role, 'charges.opening', 'charges/settings',
            `Вхідні залишки на ${cutHuman}: борг ${fromKop(debtKop)} грн, переплата ${fromKop(overpaidKop)} грн (${byApt.size} прим.)`, summary);
        return { ok: true, ...summary, updated: balances.updated };
    }

    // --------------------------------------------------------
    // НАРАХУВАННЯ ЗА МІСЯЦЬ І СКАСУВАННЯ
    // --------------------------------------------------------
    async function run(actor, role, { period, expectTotalKop, allowPartial }) {
        return withOperation('run', () => runInner(actor, role, { period, expectTotalKop, allowPartial }), period);
    }
    async function runInner(actor, role, { period, expectTotalKop, allowPartial }) {
        if (!core.validPeriod(period)) fail('invalid-argument', 'Вкажіть місяць у форматі РРРР-ММ');
        await assertNoUnfinished({ kind: 'run', period });
        const [settings, apartments, ledgers] = await Promise.all([loadSettings(), loadApartments(), allLedgers()]);
        if (period < settings.startPeriod) fail('invalid-argument', `Облік у застосунку починається з ${core.periodName(settings.startPeriod)}`);
        if (period > core.currentPeriod()) fail('invalid-argument', 'Наперед нарахування не проводиться');
        const importedMonth = [...ledgers.values()].some(list => list.some(e => e.period === period && e.kind === 'charge' && e.source === 'import'));
        if (importedMonth) fail('failed-precondition', `За ${core.periodName(period)} внески вже перенесено зі старої бази при переході. Повторне нарахування подвоїло б борги.`);
        const calc = core.computeCharges({ ...settings, apartments, period });
        if (!calc.rows.length) fail('failed-precondition', calc.problems[0]?.reason || 'Немає приміщень з площею й тарифом для нарахування');
        if (calc.problems.length && allowPartial !== true) {
            fail('failed-precondition', `Не всі приміщення готові до нарахування (${calc.problems.length}: ${calc.problems.slice(0, 5).map(p => `кв. ${p.apt} — ${p.reason}`).join('; ')}). Виправте довідник/тарифи або явно підтвердьте часткове нарахування.`);
        }
        if (expectTotalKop !== undefined && Number(expectTotalKop) !== calc.totalKop) {
            fail('aborted', 'Дані змінилися під час перегляду. Оновіть сторінку й перевірте суму ще раз.');
        }

        const runRef = db.doc(`charges_runs/${period}`);
        const prev = await runRef.get();
        const prevAmounts = prev.exists ? prev.data().amounts || {} : {};
        const prevByComp = prev.exists ? prev.data().byComponentIds || {} : {};
        const at = Timestamp.fromDate(core.periodEndDate(period));
        const amounts = {}, byComponentIds = {};
        let changed = 0;
        const planRows = [];
        for (const r of calc.rows) {
            amounts[r.apt] = r.amountKop;
            byComponentIds[r.apt] = Object.fromEntries(r.parts.map(p => [p.component, p.amountKop]));
            const sameParts = JSON.stringify(prevByComp[r.apt] || null) === JSON.stringify(byComponentIds[r.apt]);
            if (prevAmounts[r.apt] !== r.amountKop || !sameParts) changed++;
            planRows.push({ id: r.id, apt: r.apt, amountKop: r.amountKop, parts: r.parts, note: r.note });
        }
        const removed = apartments.filter(a => prevAmounts[a.apt] !== undefined && amounts[a.apt] === undefined).map(a => ({ id: a.id, apt: a.apt }));
        changed += removed.length;

        const runData = {
            period, totalKop: calc.totalKop, count: calc.rows.length,
            expectedApts: calc.rows.map(r => r.apt), complete: calc.problems.length === 0,
            byGroup: calc.byGroup, byComponent: calc.byComponent, byComponentIds, problems: calc.problems, amounts
        };
        await planRef(period).set({ rows: planRows, removed, runData, at, actor, createdAt: FieldValue.serverTimestamp() });
        await runRef.set({ ...runData, status: 'writing', createdBy: actor, createdAt: FieldValue.serverTimestamp() });
        await writeAll([
            ...planRows.map(r => ({
                ref: db.doc(`apartments/${r.id}/ledger/charge-${period}`),
                data: { at, period, kind: 'charge', amount: fromKop(r.amountKop), amountKop: r.amountKop, parts: r.parts, note: r.note, source: 'charges' }
            })),
            ...removed.map(a => ({ ref: db.doc(`apartments/${a.id}/ledger/charge-${period}`), delete: true }))
        ], actor);
        await runRef.update({ status: 'complete' });
        await planRef(period).delete();

        const balances = await recompute();
        await audit(actor, role, prev.exists ? 'charges.recalc' : 'charges.run', `charges_runs/${period}`,
            `${prev.exists ? 'Перераховано' : 'Нараховано'} внески за ${core.periodName(period)}: ${fromKop(calc.totalKop)} грн (${calc.rows.length} прим.)`,
            { period, totalKop: calc.totalKop, count: calc.rows.length, changed, problems: calc.problems.length });
        return { ok: true, period, totalKop: calc.totalKop, count: calc.rows.length, changed, problems: calc.problems, balancesUpdated: balances.updated };
    }

    async function revert(actor, role, { period }) {
        return withOperation('revert', () => revertInner(actor, role, { period }), period);
    }
    async function revertInner(actor, role, { period }) {
        if (!core.validPeriod(period)) fail('invalid-argument', 'Вкажіть місяць');
        await assertNoUnfinished({ kind: 'revert', period });
        const runRef = db.doc(`charges_runs/${period}`);
        const snap = await runRef.get();
        if (!snap.exists) fail('not-found', `За ${core.periodName(period)} нарахування немає`);
        const apartments = await loadApartments();
        await runRef.update({ status: 'reverting', revertBy: actor, revertAt: FieldValue.serverTimestamp() });
        await writeAll(apartments.map(a => ({ ref: db.doc(`apartments/${a.id}/ledger/charge-${period}`), delete: true })), actor);
        await runRef.delete();
        await planRef(period).delete();
        await recompute();
        await audit(actor, role, 'charges.revert', `charges_runs/${period}`,
            `Скасовано нарахування за ${core.periodName(period)} (${fromKop(snap.data().totalKop || 0)} грн)`, { period });
        return { ok: true };
    }

    /** Дописати перерване нарахування, скасування або вхідні залишки тим самим планом. */
    async function resume(actor, role) {
        return withOperation('resume', () => resumeInner(actor, role));
    }
    async function resumeInner(actor, role) {
        const list = await unfinished();
        if (!list.length) return { ok: true, resumed: 0 };
        for (const u of list) {
            if (u.kind !== 'opening') await lock?.assertOpen(u.period, 'Нарахування');
            if (u.kind === 'opening') {
                const p = (await openingPlanRef.get()).data();
                if (!p) continue;
                const at = Timestamp.fromDate(new Date(`${p.cutIso}T21:00:00Z`));
                await writeAll(p.rows.map(r => ({
                    ref: db.doc(`apartments/${r.id}/ledger/opening`),
                    data: { at, period: p.cutPeriod, kind: 'opening', amount: fromKop(r.kop), amountKop: r.kop, ...(r.parts ? { parts: r.parts } : {}),
                        note: `Вхідний залишок на ${p.cutHuman}: ${r.kop < 0 ? `борг ${fromKop(-r.kop)}` : r.kop > 0 ? `переплата ${fromKop(r.kop)}` : '0'} грн`, source: 'opening' }
                })), actor);
                await settingsRef.set({ opening: p.summary, startDate: p.startDate, startPeriod: p.startPeriod, updatedBy: actor, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
                await openingPlanRef.delete();
            } else if (u.kind === 'run') {
                const p = (await planRef(u.period).get()).data();
                if (!p) fail('failed-precondition', `Немає плану нарахування за ${core.periodName(u.period)}. Скасуйте або проведіть місяць заново.`);
                await writeAll([
                    ...p.rows.map(r => ({
                        ref: db.doc(`apartments/${r.id}/ledger/charge-${u.period}`),
                        data: { at: p.at, period: u.period, kind: 'charge', amount: fromKop(r.amountKop), amountKop: r.amountKop, parts: r.parts, note: r.note, source: 'charges' }
                    })),
                    ...(p.removed || []).map(a => ({ ref: db.doc(`apartments/${a.id}/ledger/charge-${u.period}`), delete: true }))
                ], actor);
                await db.doc(`charges_runs/${u.period}`).set({ ...p.runData, status: 'complete', createdBy: p.actor || actor, createdAt: FieldValue.serverTimestamp() });
                await planRef(u.period).delete();
            } else if (u.kind === 'revert') {
                const apartments = await loadApartments();
                await writeAll(apartments.map(a => ({ ref: db.doc(`apartments/${a.id}/ledger/charge-${u.period}`), delete: true })), actor);
                await db.doc(`charges_runs/${u.period}`).delete();
                await planRef(u.period).delete();
            }
        }
        const balances = await recompute();
        await audit(actor, role, 'charges.resume', 'charges/settings', `Завершено перервані операції: ${list.length}`, { list });
        return { ok: true, resumed: list.length, balancesUpdated: balances.updated };
    }

    // --------------------------------------------------------
    // ВІДОМІСТЬ ЗА МІСЯЦЬ
    // --------------------------------------------------------
    async function getStatement({ period }) {
        if (!core.validPeriod(period)) fail('invalid-argument', 'Вкажіть місяць');
        const [settings, apartments, ledgers] = await Promise.all([loadSettings(), loadApartments(), allLedgers()]);
        const rows = core.statementRows({ apartments, ledgers, period, startPeriod: settings.startPeriod, startDate: settings.startDate, premises: settings.premises, groups: settings.groups });
        const totals = rows.reduce((t, r) => ({
            opening: t.opening + r.opening, charged: t.charged + r.charged, paid: t.paid + r.paid, closing: t.closing + r.closing,
            debtors: t.debtors + (r.closing < 0 ? 1 : 0), debtKop: t.debtKop + (r.closing < 0 ? -r.closing : 0)
        }), { opening: 0, charged: 0, paid: 0, closing: 0, debtors: 0, debtKop: 0 });
        return { period, rows, totals };
    }

    /**
     * Історія особових рахунків із попередньої програми: старі нарахування й
     * оплати для картки квартири, акта звірки та річного звіту за рік переходу.
     * Якщо вхідні залишки вже внесено, поточний баланс не змінюється, бо всі
     * операції до startPeriod уже враховані у вхідному залишку.
     */
    async function importHistory(actor, role, { rows }) {
        return withOperation('importHistory', () => importHistoryInner(actor, role, { rows }));
    }
    async function importHistoryInner(actor, role, { rows }) {
        const [apartments, settings] = await Promise.all([loadApartments(), loadSettings()]);
        const byApt = new Map(apartments.map(a => [a.apt, a.id]));
        const checked = core.checkHistoryImport(rows, byApt, settings.startPeriod, settings.components, settings.startDate);
        if (checked.error) fail('invalid-argument', checked.error);
        const startMonthCharges = checked.entries.filter(e => e.period === settings.startPeriod && e.kind === 'charge');
        if (startMonthCharges.length) {
            const existingRun = await db.doc(`charges_runs/${settings.startPeriod}`).get();
            if (existingRun.exists) fail('failed-precondition', `За ${core.periodName(settings.startPeriod)} вже проведено нарахування в застосунку. Не імпортуйте старі нарахування за цей самий місяць.`);
        }
        await writeAll(checked.entries.map(e => ({
            ref: db.doc(`apartments/${e.aptId}/ledger/import-${e.key}`),
            data: {
                at: Timestamp.fromDate(new Date(`${e.date}T12:00:00Z`)),
                period: e.period, kind: e.kind, amount: fromKop(e.amountKop), amountKop: e.amountKop,
                ...(e.parts ? { parts: e.parts } : {}), note: e.note, source: 'import'
            }
        })), actor);
        const touchedStart = checked.entries.some(e => e.period >= settings.startPeriod);
        const balances = touchedStart ? await recompute() : { updated: 0 };
        await audit(actor, role, 'charges.history.import', 'apartments',
            `Імпортовано історію особових рахунків: ${checked.entries.length} записів`, { count: checked.entries.length });
        return { ok: true, count: checked.entries.length, balancesUpdated: balances.updated };
    }

    async function confirmImportedStartMonth(actor, role, { period, note }) {
        if (role !== 'chair') fail('permission-denied', 'Підтвердити перенесені нарахування може лише голова');
        const [settings, apartments, ledgers] = await Promise.all([loadSettings(), loadApartments(), allLedgers()]);
        const target = period || settings.startPeriod;
        if (target !== settings.startPeriod) fail('invalid-argument', 'Підтвердження стосується лише місяця переходу');
        await lock?.assertOpen(target, 'Підтвердження перенесених нарахувань');
        if (String(note || '').trim().length < 5) fail('invalid-argument', 'Вкажіть підставу: у якій системі нараховано місяць переходу до дати зрізу');
        const amounts = {}, byComponent = {};
        let totalKop = 0;
        for (const a of apartments) {
            const entries = (ledgers.get(a.id) || []).filter(e => e.period === target && e.kind === 'charge' && e.source === 'import'
                && (!settings.startDate || !e.at?.toDate || new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Kyiv' }).format(e.at.toDate()) >= settings.startDate));
            if (!entries.length) continue;
            const kop = entries.reduce((s, e) => s + Number(e.amountKop || 0), 0);
            amounts[a.apt] = kop; totalKop += kop;
            for (const e of entries) for (const p of e.parts || [{ component: 'main', amountKop: e.amountKop }]) byComponent[p.component] = (byComponent[p.component] || 0) + p.amountKop;
        }
        if (!Object.keys(amounts).length) fail('failed-precondition', `У місяці ${core.periodName(target)} немає імпортованих нарахувань після дати переходу`);
        await db.runTransaction(async t=>{
            await lock?.assertOpen(target, 'Підтвердження перенесених нарахувань', t);
            t.set(db.doc(`charges_runs/${target}`), {
                period: target, status: 'complete', complete: true, source: 'import-confirmed',
                totalKop, count: Object.keys(amounts).length, expectedApts: Object.keys(amounts),
                amounts, byComponent, problems: [], note: String(note).trim().slice(0, 300),
                confirmedBy: actor, confirmedAt: FieldValue.serverTimestamp(), createdBy: actor, createdAt: FieldValue.serverTimestamp()
            });
        });
        await audit(actor, role, 'charges.import.confirm', `charges_runs/${target}`, `Підтверджено перенесені нарахування за ${core.periodName(target)}: ${fromKop(totalKop)} грн`, { period: target, totalKop, count: Object.keys(amounts).length, note: String(note).trim().slice(0, 300) });
        return { ok: true, period: target, totalKop, count: Object.keys(amounts).length };
    }

    const changes = { run, revert, addTariff, removeTariff, addGroup, addComponent, renameComponent, setResidents, setPremises, setOpening, recompute, resume, importHistory, confirmImportedStartMonth };
    const actions = {
        context, preview: async ({ period }) => core.computeCharges({ ...(await loadSettings()), apartments: await loadApartments(), period }),
        getStatement, ...changes
    };

    const chargesAction = onCall({ region: REGION, maxInstances: 5, timeoutSeconds: 120 }, callGuard('chargesAction', async request => {
        const actor = await requireAdmin(request, ['chair', 'accountant']);
        const role = await staffRole(actor);
        const data = request.data || {};
        switch (data.action) {
            case 'context': return context(data.period);
            case 'statement': return getStatement(data);
            case 'addGroup': case 'addComponent': case 'renameComponent': case 'setResidents':
            case 'addTariff': case 'removeTariff': case 'setPremises':
            case 'setOpening': case 'run': case 'revert': case 'resume': case 'importHistory': case 'confirmImportedStartMonth':
                return changes[data.action](actor, role, data);
            case 'recompute': {
                const r = await actions.recompute();
                await audit(actor, role, 'charges.recompute', 'apartments', `Баланси перераховано з історії: ${r.updated} змін`, r);
                return r;
            }
            default: fail('invalid-argument', 'Невідома дія');
        }
    }));

    return { chargesAction, recompute: recomputeSafe, actions };
};