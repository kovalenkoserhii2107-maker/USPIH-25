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
     */
    async function recompute(apts) {
        const settings = await loadSettings();
        if (!settings.opening?.set) return { skipped: true, updated: 0 };
        const targets = apts ? [...new Set(apts.map(String))] : (await loadApartments()).map(a => a.id);
        let updated = 0;
        const same = (a, b) => JSON.stringify(a || []) === JSON.stringify(b || []);
        // Each balance uses a transactional ledger snapshot: concurrent payments
        // cannot overwrite a newer balance with an older calculation.
        for (const apt of targets) {
            const changed = await db.runTransaction(async t => {
                const ref = db.doc(`apartments/${apt}`);
                const [snap, ledger, freshSettings] = await Promise.all([t.get(ref), t.get(db.collection(`apartments/${apt}/ledger`)), t.get(settingsRef)]);
                if (!freshSettings.data()?.opening?.set || !snap.exists || snap.data().isAdmin === true) return false;
                const current = freshSettings.data();
                const currentComponents = current.components?.length ? current.components : core.DEFAULT_COMPONENTS;
                const currentNames = new Map(currentComponents.map(c => [c.id, c.name]));
                const currentNamed = parts => Object.entries(parts).filter(([, v]) => v).map(([component, amountKop]) => ({ component, name: currentNames.get(component) || 'Інше', amountKop }));
                const entries = ledger.docs.map(d => ({ _id: d.id, ...d.data() }));
                const { balances, steps } = core.replay(entries, { startPeriod: current.startPeriod || core.START_PERIOD, order: currentComponents.map(c => c.id) });
                for (const { entry, parts } of steps) {
                    if (entry.kind !== 'payment' || !entry._id || same(entry.alloc, currentNamed(parts))) continue;
                    t.update(db.doc(`apartments/${apt}/ledger/${entry._id}`), { alloc: currentNamed(parts) });
                }
                const balance = fromKop(core.balanceFromLedger(entries, current.startPeriod || core.START_PERIOD));
                if (snap.data().balance === balance && snap.data().balanceSource === 'ledger' && same(snap.data().balanceParts, currentNamed(balances))) return false;
                t.set(ref, { balance, balanceParts: currentNamed(balances), balanceSource: 'ledger', balanceUpdatedBy: 'system', balanceUpdatedAt: FieldValue.serverTimestamp() }, { merge: true });
                return true;
            });
            if (changed) updated++;
        }
        return { updated };
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
            const r = d.data();
            return { period: r.period, count: r.count, totalKop: r.totalKop, complete: r.complete !== false && !r.problems?.length, problems: r.problems || [], by: r.by,
                at: r.at?.toDate?.()?.toISOString() || null, recalculated: r.recalculated || 0 };
        });
    }

    async function context() {
        const [settings, apartments, runs] = await Promise.all([loadSettings(), loadApartments(), loadRuns()]);
        const done = new Set((await db.collection('charges_runs').select('complete', 'problems').get()).docs
            .filter(d => d.data().complete !== false && !d.data().problems?.length).map(d => d.id));
        const current = core.currentPeriod();
        const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Kyiv' }).format(new Date());
        const due = core.duePeriods({ startPeriod: settings.startPeriod, current, done, today });
        const period = due[0] || current;
        const preview = core.computeCharges({ apartments, premises: settings.premises, tariffs: settings.tariffs, groups: settings.groups, components: settings.components, period });
        return {
            groups: settings.groups, components: settings.components, tariffs: settings.tariffs, premises: settings.premises,
            startPeriod: settings.startPeriod, opening: settings.opening ? { ...settings.opening, at: settings.opening.at?.toDate?.()?.toISOString() || null } : null,
            apartments: apartments.map(a => ({ apt: a.apt, area: a.area, residents: a.residents, balance: a.balance, personalAccount: a.personalAccount })),
            runs, due, current,
            preview: { period, done: done.has(period), ...preview }
        };
    }

    async function preview({ period }) {
        if (!core.validPeriod(period)) fail('invalid-argument', 'Невідомий місяць');
        const [settings, apartments] = await Promise.all([loadSettings(), loadApartments()]);
        return { period, ...core.computeCharges({ apartments, premises: settings.premises, tariffs: settings.tariffs, groups: settings.groups, components: settings.components, period }) };
    }

    // --------------------------------------------------------
    // НАРАХУВАННЯ
    // --------------------------------------------------------
    /**
     * Нарахувати внески за місяць. expectTotalKop — сума, яку людина
     * бачила, коли підтверджувала: якщо дані відтоді змінилися (площа,
     * тариф), нічого не пишемо й просимо подивитися ще раз.
     * Повторний запуск за той самий місяць — перерахунок коректних
     * рядків. Проблемні рядки зберігають попереднє нарахування.
     */
    async function run(actor, role, { period, expectTotalKop, allowPartial }) {
        const settings = await loadSettings();
        if (!core.validPeriod(period)) fail('invalid-argument', 'Невідомий місяць');
        if (period < settings.startPeriod) fail('failed-precondition', `Облік у застосунку починається з ${core.periodName(settings.startPeriod)}`);
        if (period > core.currentPeriod()) fail('failed-precondition', 'Нараховувати наперед не можна');
        await lock?.assertOpen(period, 'Нарахування');
        const apartments = await loadApartments();
        const result = core.computeCharges({ apartments, premises: settings.premises, tariffs: settings.tariffs, groups: settings.groups, components: settings.components, period });
        if (!result.rows.length) fail('failed-precondition', 'Нема кому нараховувати: внесіть тарифи й площі приміщень');
        if (Number.isInteger(expectTotalKop) && expectTotalKop !== result.totalKop) {
            fail('aborted', `Дані змінилися: тепер ${fromKop(result.totalKop)} грн замість ${fromKop(expectTotalKop)}. Перегляньте ще раз.`);
        }
        const runRef = db.doc(`charges_runs/${period}`);
        const previous = await runRef.get();
        const before = previous.exists ? previous.data().amounts || {} : {};
        const ids = new Map(apartments.map(a => [a.apt, a.id]));
        for (const apt of Object.keys(before)) if (!ids.has(apt)) result.problems.push({ apt, reason: 'приміщення з попереднім нарахуванням відсутнє в довіднику' });
        if (result.problems.length && allowPartial !== true) fail('failed-precondition', `Нарахування неповне: ${result.problems.length} прим. мають помилки. Виправте дані або явно підтвердьте часткове нарахування.`);
        const amounts = {};
        const byComponent = {};
        const addParts = parts => { for (const p of parts || []) byComponent[p.component] = (byComponent[p.component] || 0) + p.amountKop; };
        const at = Timestamp.fromDate(core.chargeDate(period));
        let batch = db.batch(), ops = 0;
        const flush = async () => { if (ops) await batch.commit(); batch = db.batch(); ops = 0; };
        for (const r of result.rows) {
            amounts[r.apt] = r.amountKop;
            addParts(r.parts);
            batch.set(db.doc(`apartments/${ids.get(r.apt)}/ledger/charge-${period}`), {
                at, period, kind: 'charge', amount: fromKop(r.amountKop), amountKop: r.amountKop,
                note: core.chargeNote(r, period), source: 'charges', group: r.group, areaCenti: r.areaCenti, rate4: r.rate4,
                parts: r.parts.map(p => ({ component: p.component, name: p.name, base: p.base, rate4: p.rate4, amountKop: p.amountKop,
                    ...(p.residents !== undefined ? { residents: p.residents } : {}) })),
                createdAt: FieldValue.serverTimestamp(), createdBy: actor
            });
            if (++ops >= 400) await flush();
        }
        // Помилка площі/тарифу не скасовує вже нарахований внесок.
        const preserved = Object.keys(before).filter(apt => !(apt in amounts));
        for (const apt of preserved) {
            amounts[apt] = before[apt];
            const old = (await db.doc(`apartments/${ids.get(apt) || apt}/ledger/charge-${period}`).get()).data();
            addParts(old?.parts?.length ? old.parts : [{ component: 'main', amountKop: before[apt] }]);
        }
        const totalKop = Object.values(amounts).reduce((sum, amount) => sum + amount, 0);
        const count = Object.keys(amounts).length;
        batch.set(runRef, {
            period, count, totalKop, amounts, complete: result.problems.length === 0, expectedApts: apartments.map(a => a.apt),
            tariffs: [...new Set([...(preserved.length ? previous.data()?.tariffs || [] : []), ...result.rows.flatMap(r => r.parts.map(p => p.tariffId)).filter(Boolean)])],
            // Скільки нараховано за кожною складовою — для кошторису й звірки.
            byComponent, problems: result.problems, by: actor, at: FieldValue.serverTimestamp(),
            recalculated: previous.exists ? (previous.data().recalculated || 0) + 1 : 0
        });
        ops += 1;
        await flush();
        const changed = previous.exists ? Object.keys(amounts).filter(a => before[a] !== amounts[a]).length : result.rows.length;
        await audit(actor, role, previous.exists ? 'charges.recalc' : 'charges.run', `charges_runs/${period}`,
            `${previous.exists ? 'Перераховано' : 'Нараховано'} внески за ${core.periodName(period)}: ${count} прим., ${fromKop(totalKop)} грн`,
            { period, count, totalKop, problems: result.problems.length, changed, preserved });
        const balances = await recompute();
        return { ok: true, count, totalKop, complete: !result.problems.length, problems: result.problems, preserved, changed, balances: balances.updated || 0 };
    }

    /** Скасувати нарахування — лише за останній нарахований місяць. */
    async function revert(actor, role, { period }) {
        if (!core.validPeriod(period)) fail('invalid-argument', 'Невідомий місяць');
        const last = await db.collection('charges_runs').orderBy('period', 'desc').limit(1).get();
        if (last.empty || last.docs[0].id !== period) fail('failed-precondition', 'Скасувати можна лише нарахування за останній місяць');
        await lock?.assertOpen(period, 'Скасування нарахування');
        const runDoc = last.docs[0];
        const ids = new Map((await loadApartments()).map(a => [a.apt, a.id]));
        const amounts = runDoc.data().amounts || {};
        let batch = db.batch(), ops = 0;
        for (const apt of Object.keys(amounts)) {
            batch.delete(db.doc(`apartments/${ids.get(apt) || apt}/ledger/charge-${period}`));
            if (++ops >= 400) { await batch.commit(); batch = db.batch(); ops = 0; }
        }
        batch.delete(runDoc.ref);
        await batch.commit();
        await audit(actor, role, 'charges.revert', `charges_runs/${period}`,
            `Скасовано нарахування за ${core.periodName(period)}: ${Object.keys(amounts).length} прим., ${fromKop(runDoc.data().totalKop || 0)} грн`,
            { period, count: Object.keys(amounts).length, totalKop: runDoc.data().totalKop || 0 });
        await recompute();
        return { ok: true };
    }

    // --------------------------------------------------------
    // ТАРИФИ Й ГРУПИ
    // --------------------------------------------------------
    async function addTariff(actor, role, { group, component, rate, from, decision }) {
        const settings = await loadSettings();
        const comp = settings.components.find(c => c.id === (component || 'main'));
        if (!comp) fail('invalid-argument', 'Невідома складова внеску');
        const tariff = { group: String(group || ''), component: comp.id, base: comp.base, rate4: core.parseRate(rate), from: String(from || ''), decision: String(decision || '').replace(/\s+/g, ' ').trim() };
        const error = core.checkTariff(tariff, settings.groups, settings.tariffs);
        if (error) fail('invalid-argument', error);
        tariff.id = db.collection('_').doc().id.slice(0, 12);
        tariff.by = actor;
        tariff.at = new Date().toISOString();
        await settingsRef.set({ tariffs: [...settings.tariffs, tariff], groups: settings.groups, components: settings.components }, { merge: true });
        const name = settings.groups.find(g => g.id === tariff.group)?.name;
        await audit(actor, role, 'charges.tariff', 'charges/settings',
            `Тариф «${comp.name}», ${name}: ${core.formatRate(tariff.rate4)} грн ${core.BASES[comp.base]} з ${core.periodName(tariff.from)}`, tariff);
        return { ok: true, id: tariff.id };
    }

    /** Нова складова внеску (освітлення МЗК, ліфти, вивезення ТПВ…). */
    async function addComponent(actor, role, { name, base, item }) {
        const settings = await loadSettings();
        const c = { name: String(name || '').trim(), base: String(base || ''), item: String(item || 'other') };
        const error = core.checkComponent(c, settings.components);
        if (error) fail('invalid-argument', error);
        c.id = `c${db.collection('_').doc().id}`;
        await settingsRef.set({ components: [...settings.components, c], groups: settings.groups }, { merge: true });
        await audit(actor, role, 'charges.component', 'charges/settings', `Складова внеску «${c.name}» (${core.BASES[c.base]})`, c);
        return { ok: true, id: c.id };
    }

    /** Прибрати можна лише тариф, за яким ще нічого не нараховано. */
    async function removeTariff(actor, role, { id }) {
        const settings = await loadSettings();
        const tariff = settings.tariffs.find(t => t.id === id);
        if (!tariff) fail('not-found', 'Тариф не знайдено');
        const used = await db.collection('charges_runs').where('tariffs', 'array-contains', id).limit(1).get();
        if (!used.empty) fail('failed-precondition', `За цим тарифом уже нараховано (${core.periodName(used.docs[0].id)}). Щоб змінити ставку, додайте новий тариф з наступного місяця.`);
        await settingsRef.set({ tariffs: settings.tariffs.filter(t => t.id !== id) }, { merge: true });
        await audit(actor, role, 'charges.tariff.remove', 'charges/settings', `Тариф ${core.formatRate(tariff.rate4)} грн/м² з ${core.periodName(tariff.from)} прибрано`, tariff);
        return { ok: true };
    }

    async function addGroup(actor, role, { name }) {
        const settings = await loadSettings();
        const error = core.checkGroupName(name, settings.groups);
        if (error) fail('invalid-argument', error);
        const group = { id: `g${db.collection('_').doc().id}`, name: String(name).trim() };
        await settingsRef.set({ groups: [...settings.groups, group] }, { merge: true });
        await audit(actor, role, 'charges.group', 'charges/settings', `Група приміщень «${group.name}»`, group);
        return { ok: true, id: group.id };
    }

    /** Перейменувати складову (напр. «Утримання будинку» → як у квитанції сервісу). */
    async function renameComponent(actor, role, { id, name }) {
        const settings = await loadSettings();
        const c = settings.components.find(x => x.id === id);
        if (!c) fail('not-found', 'Складову не знайдено');
        const n = String(name || '').trim();
        if (n.length < 2 || n.length > 60) fail('invalid-argument', 'Назва складової — від 2 до 60 символів');
        if (settings.components.some(x => x.id !== id && x.name.toLowerCase() === n.toLowerCase())) fail('invalid-argument', 'Така складова вже є');
        await settingsRef.set({ components: settings.components.map(x => (x.id === id ? { ...x, name: n } : x)), groups: settings.groups }, { merge: true });
        await audit(actor, role, 'charges.component', 'charges/settings', `Складова «${c.name}» → «${n}»`, { id, name: n });
        return { ok: true };
    }

    /**
     * Кількість проживаючих — для складових «з проживаючого» (вивезення
     * побутових відходів). rows: [{ apt, residents }]; порожнє — прибрати.
     */
    async function setResidents(actor, role, { rows }) {
        const ids = new Map((await loadApartments()).map(a => [a.apt, a.id]));
        const list = (Array.isArray(rows) ? rows : []).slice(0, 2000).map(r => ({ apt: cleanApt(r?.apt), residents: r?.residents === '' || r?.residents === null ? null : core.parseResidents(r?.residents) }));
        if (!list.length) fail('invalid-argument', 'Немає жодного рядка');
        const bad = list.find(r => !ids.has(r.apt));
        if (bad) fail('invalid-argument', `Квартири ${bad.apt} немає в довіднику`);
        if (list.some((r, i) => rows[i]?.residents !== '' && rows[i]?.residents !== null && r.residents === null)) fail('invalid-argument', 'Кількість проживаючих — ціле число від 0 до 30');
        let batch = db.batch(), ops = 0;
        for (const r of list) {
            batch.set(db.doc(`apartments/${ids.get(r.apt)}`), { residents: r.residents === null ? FieldValue.delete() : r.residents }, { merge: true });
            if (++ops >= 400) { await batch.commit(); batch = db.batch(); ops = 0; }
        }
        if (ops) await batch.commit();
        await audit(actor, role, 'charges.residents', 'apartments', `Кількість проживаючих: ${list.length} кв.`, { count: list.length });
        return { ok: true, count: list.length };
    }

    async function setPremises(actor, role, { apts, group }) {
        const settings = await loadSettings();
        if (!settings.groups.some(g => g.id === group)) fail('invalid-argument', 'Невідома група приміщень');
        const known = new Set((await loadApartments()).map(a => a.apt));
        const list = (Array.isArray(apts) ? apts : [apts]).map(cleanApt).filter(Boolean);
        if (!list.length || list.length > 500) fail('invalid-argument', 'Вкажіть приміщення');
        const unknown = list.filter(a => !known.has(a));
        if (unknown.length) fail('invalid-argument', `Немає в довіднику: ${unknown.slice(0, 5).join(', ')}`);
        const premises = { ...settings.premises };
        list.forEach(a => { if (group === 'res') delete premises[a]; else premises[a] = group; });
        await settingsRef.set({ premises, groups: settings.groups }, { mergeFields: ['premises', 'groups'] });
        const name = settings.groups.find(g => g.id === group).name;
        await audit(actor, role, 'charges.premises', 'charges/settings', `${list.length === 1 ? `Прим. ${list[0]}` : `${list.length} прим.`} → «${name}»`, { apts: list, group });
        return { ok: true };
    }

    // --------------------------------------------------------
    // ВХІДНІ ЗАЛИШКИ НА 30.09.2026
    // --------------------------------------------------------
    /**
     * Повний список залишків замінює попередній: квартира, якої в
     * списку немає, вважається розрахованою (0). Після цього баланс
     * рахує сервер.
     */
    async function setOpening(actor, role, { rows }) {
        if (await lock?.anyClosed()) fail('failed-precondition', 'Вхідні залишки змінювати не можна: уже є закритий місяць');
        const apartments = await loadApartments();
        const ids = new Map(apartments.map(a => [a.apt, a.id]));
        const settings = await loadSettings();
        const known = new Set(settings.components.map(c => c.id));
        const list = (rows || []).map(r => {
            const row = { apt: cleanApt(r?.apt), amountKop: Number(r?.amountKop) };
            // Залишок за складовими (необовʼязково): { складова: коп }, разом — рівно залишок.
            if (r?.parts && typeof r.parts === 'object') row.parts = Object.fromEntries(Object.entries(r.parts).filter(([c]) => known.has(c)).map(([c, v]) => [c, Number(v)]));
            return row;
        });
        const error = core.checkOpening(list, new Set(ids.keys()));
        if (error) fail('invalid-argument', error);
        const amounts = new Map(list.map(r => [r.apt, r.amountKop]));
        const partsOf = new Map(list.filter(r => r.parts).map(r => [r.apt, r.parts]));
        const at = Timestamp.fromDate(core.openingDate());
        let batch = db.batch(), ops = 0;
        for (const [apt, id] of ids) {
            const kop = amounts.get(apt) || 0;
            batch.set(db.doc(`apartments/${id}/ledger/${core.OPENING_ID}`), {
                at, period: core.OPENING_PERIOD, kind: 'opening', amount: fromKop(kop), amountKop: kop,
                ...(partsOf.has(apt) ? { parts: partsOf.get(apt) } : {}),
                note: core.openingNote(kop), source: 'opening', createdAt: FieldValue.serverTimestamp(), createdBy: actor
            });
            if (++ops >= 400) { await batch.commit(); batch = db.batch(); ops = 0; }
        }
        const debt = list.reduce((s, r) => s + Math.min(0, r.amountKop), 0);
        const overpaid = list.reduce((s, r) => s + Math.max(0, r.amountKop), 0);
        batch.set(settingsRef, { opening: { set: true, count: list.length, debtKop: debt, overpaidKop: overpaid, by: actor, at: FieldValue.serverTimestamp() } }, { merge: true });
        await batch.commit();
        await audit(actor, role, 'charges.opening', 'charges/settings',
            `Вхідні залишки на 30.09.2026: ${list.length} кв., борг ${fromKop(-debt)} грн, переплата ${fromKop(overpaid)} грн`,
            { count: list.length, debtKop: debt, overpaidKop: overpaid });
        const balances = await recompute();
        return { ok: true, balances: balances.updated || 0 };
    }

    async function getStatement({ period }) {
        if (!core.validPeriod(period)) fail('invalid-argument', 'Невідомий місяць');
        const settings = await loadSettings();
        const [apartments, ledgers] = await Promise.all([loadApartments(), allLedgers()]);
        const byApt = new Map(apartments.map(a => [a.apt, ledgers.get(a.id) || []]));
        return { period, opening: Boolean(settings.opening?.set), components: settings.components.map(c => ({ id: c.id, name: c.name })),
            ...core.statement(byApt, period, settings.startPeriod, settings.components.map(c => c.id)) };
    }

    const changes = { run, revert, addTariff, removeTariff, addGroup, addComponent, renameComponent, setResidents, setPremises, setOpening, recompute };
    const actions = { context, preview, getStatement, ...Object.fromEntries(Object.entries(changes).map(([name, fn]) =>
        [name, (...args) => withOperation(name, () => fn(...args), args[2]?.period)])) };

    const chargesAction = onCall({ region: REGION, maxInstances: 4, timeoutSeconds: 120 }, callGuard('chargesAction', async request => {
        const actor = await requireAdmin(request, ['chair', 'accountant']);
        const role = await staffRole(actor);
        const data = request.data || {};
        switch (data.action) {
            case 'context': return context();
            case 'preview': return preview(data);
            case 'statement': return getStatement(data);
            case 'run': case 'revert': case 'addTariff': case 'removeTariff': case 'addGroup': case 'addComponent':
            case 'setResidents': case 'renameComponent': case 'setPremises': case 'setOpening': return actions[data.action](actor, role, data);
            case 'recompute': {
                const r = await actions.recompute();
                if (r.skipped) fail('failed-precondition', 'Спершу внесіть вхідні залишки на 30.09.2026');
                await audit(actor, role, 'charges.recompute', 'apartments', `Баланси перераховано з історії: ${r.updated} змін`, r);
                return r;
            }
            default: fail('invalid-argument', 'Невідома дія');
        }
    }));

    return { chargesAction, recompute: recomputeSafe, actions };
};
