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
const logger = require('firebase-functions/logger');
const core = require('./charges-core');
const { cleanApt, fromKop } = require('./bank-core');

const REGION = 'europe-central2';

module.exports = function chargeFunctions({ db, FieldValue, Timestamp, requireAdmin, staffRole }) {
    const settingsRef = db.doc('charges/settings');
    const fail = (code, message) => { throw new HttpsError(code, message); };

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
            tariffs: data.tariffs || [],
            premises: data.premises || {},
            startPeriod: data.startPeriod || core.START_PERIOD,
            opening: data.opening || null
        };
    }

    /** Приміщення будинку — без службових записів (правління, бухгалтер). */
    async function loadApartments() {
        const snap = await db.collection('apartments').get();
        return snap.docs.filter(d => d.data().isAdmin !== true)
            .map(d => ({ apt: cleanApt(d.id), id: d.id, area: d.data().area ?? null, balance: d.data().balance ?? null, personalAccount: d.data().personalAccount || '' }));
    }

    // --------------------------------------------------------
    // БАЛАНСИ
    // --------------------------------------------------------
    async function ledgerOf(aptId) {
        const snap = await db.collection(`apartments/${aptId}/ledger`).get();
        return snap.docs.map(d => d.data());
    }

    async function allLedgers() {
        const snap = await db.collectionGroup('ledger').get();
        const map = new Map();
        snap.forEach(d => {
            const apt = d.ref.parent.parent?.id;
            if (!apt || d.ref.parent.parent.parent.id !== 'apartments') return;
            if (!map.has(apt)) map.set(apt, []);
            map.get(apt).push(d.data());
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
        let targets, ledgers;
        if (apts) {
            targets = [...new Set(apts.map(String))];
            ledgers = new Map(await Promise.all(targets.map(async a => [a, await ledgerOf(a)])));
        } else {
            targets = (await loadApartments()).map(a => a.id);
            ledgers = await allLedgers();
        }
        const refs = targets.map(a => db.doc(`apartments/${a}`));
        const snaps = refs.length ? await db.getAll(...refs) : [];
        let batch = db.batch(), ops = 0, updated = 0;
        for (const snap of snaps) {
            if (!snap.exists || snap.data().isAdmin === true) continue;
            const kop = core.balanceFromLedger(ledgers.get(snap.id) || [], settings.startPeriod);
            const balance = fromKop(kop);
            if (snap.data().balance === balance && snap.data().balanceSource === 'ledger') continue;
            batch.set(snap.ref, { balance, balanceSource: 'ledger', balanceUpdatedBy: 'system', balanceUpdatedAt: FieldValue.serverTimestamp() }, { merge: true });
            ops += 1;
            updated += 1;
            if (ops >= 400) { await batch.commit(); batch = db.batch(); ops = 0; }
        }
        if (ops) await batch.commit();
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
            return { period: r.period, count: r.count, totalKop: r.totalKop, problems: r.problems || [], by: r.by,
                at: r.at?.toDate?.()?.toISOString() || null, recalculated: r.recalculated || 0 };
        });
    }

    async function context() {
        const [settings, apartments, runs] = await Promise.all([loadSettings(), loadApartments(), loadRuns()]);
        const done = new Set((await db.collection('charges_runs').select().get()).docs.map(d => d.id));
        const current = core.currentPeriod();
        const due = core.duePeriods({ startPeriod: settings.startPeriod, current, done });
        const period = due[0] || current;
        const preview = core.computeCharges({ apartments, premises: settings.premises, tariffs: settings.tariffs, groups: settings.groups, period });
        return {
            groups: settings.groups, tariffs: settings.tariffs, premises: settings.premises,
            startPeriod: settings.startPeriod, opening: settings.opening ? { ...settings.opening, at: settings.opening.at?.toDate?.()?.toISOString() || null } : null,
            apartments: apartments.map(a => ({ apt: a.apt, area: a.area, balance: a.balance, personalAccount: a.personalAccount })),
            runs, due, current,
            preview: { period, done: done.has(period), ...preview }
        };
    }

    async function preview({ period }) {
        if (!core.validPeriod(period)) fail('invalid-argument', 'Невідомий місяць');
        const [settings, apartments] = await Promise.all([loadSettings(), loadApartments()]);
        return { period, ...core.computeCharges({ apartments, premises: settings.premises, tariffs: settings.tariffs, groups: settings.groups, period }) };
    }

    // --------------------------------------------------------
    // НАРАХУВАННЯ
    // --------------------------------------------------------
    /**
     * Нарахувати внески за місяць. expectTotalKop — сума, яку людина
     * бачила, коли підтверджувала: якщо дані відтоді змінилися (площа,
     * тариф), нічого не пишемо й просимо подивитися ще раз.
     * Повторний запуск за той самий місяць — перерахунок: записи
     * оновлюються, зайві прибираються.
     */
    async function run(actor, role, { period, expectTotalKop }) {
        const settings = await loadSettings();
        if (!core.validPeriod(period)) fail('invalid-argument', 'Невідомий місяць');
        if (period < settings.startPeriod) fail('failed-precondition', `Облік у застосунку починається з ${core.periodName(settings.startPeriod)}`);
        if (period > core.currentPeriod()) fail('failed-precondition', 'Нараховувати наперед не можна');
        const apartments = await loadApartments();
        const result = core.computeCharges({ apartments, premises: settings.premises, tariffs: settings.tariffs, groups: settings.groups, period });
        if (!result.rows.length) fail('failed-precondition', 'Нема кому нараховувати: внесіть тарифи й площі приміщень');
        if (Number.isInteger(expectTotalKop) && expectTotalKop !== result.totalKop) {
            fail('aborted', `Дані змінилися: тепер ${fromKop(result.totalKop)} грн замість ${fromKop(expectTotalKop)}. Перегляньте ще раз.`);
        }
        const runRef = db.doc(`charges_runs/${period}`);
        const previous = await runRef.get();
        const before = previous.exists ? previous.data().amounts || {} : {};
        const ids = new Map(apartments.map(a => [a.apt, a.id]));
        const amounts = {};
        const at = Timestamp.fromDate(core.chargeDate(period));
        let batch = db.batch(), ops = 0;
        const flush = async () => { if (ops) await batch.commit(); batch = db.batch(); ops = 0; };
        for (const r of result.rows) {
            amounts[r.apt] = r.amountKop;
            batch.set(db.doc(`apartments/${ids.get(r.apt)}/ledger/charge-${period}`), {
                at, period, kind: 'charge', amount: fromKop(r.amountKop), amountKop: r.amountKop,
                note: core.chargeNote(r, period), source: 'charges', group: r.group, areaCenti: r.areaCenti, rate4: r.rate4,
                createdAt: FieldValue.serverTimestamp(), createdBy: actor
            });
            if (++ops >= 400) await flush();
        }
        // Приміщення, якому нараховано раніше, а тепер ні (прибрали площу) — запис прибираємо.
        const removed = Object.keys(before).filter(apt => !(apt in amounts));
        for (const apt of removed) {
            batch.delete(db.doc(`apartments/${ids.get(apt) || apt}/ledger/charge-${period}`));
            if (++ops >= 400) await flush();
        }
        batch.set(runRef, {
            period, count: result.rows.length, totalKop: result.totalKop, amounts,
            tariffs: [...new Set(result.rows.map(r => r.tariffId).filter(Boolean))],
            problems: result.problems.slice(0, 200), by: actor, at: FieldValue.serverTimestamp(),
            recalculated: previous.exists ? (previous.data().recalculated || 0) + 1 : 0
        });
        ops += 1;
        await flush();
        const changed = previous.exists ? Object.keys(amounts).filter(a => before[a] !== amounts[a]).length + removed.length : result.rows.length;
        await audit(actor, role, previous.exists ? 'charges.recalc' : 'charges.run', `charges_runs/${period}`,
            `${previous.exists ? 'Перераховано' : 'Нараховано'} внески за ${core.periodName(period)}: ${result.rows.length} прим., ${fromKop(result.totalKop)} грн`,
            { period, count: result.rows.length, totalKop: result.totalKop, problems: result.problems.length, changed });
        const balances = await recompute();
        return { ok: true, count: result.rows.length, totalKop: result.totalKop, problems: result.problems, changed, balances: balances.updated || 0 };
    }

    /** Скасувати нарахування — лише за останній нарахований місяць. */
    async function revert(actor, role, { period }) {
        if (!core.validPeriod(period)) fail('invalid-argument', 'Невідомий місяць');
        const last = await db.collection('charges_runs').orderBy('period', 'desc').limit(1).get();
        if (last.empty || last.docs[0].id !== period) fail('failed-precondition', 'Скасувати можна лише нарахування за останній місяць');
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
    async function addTariff(actor, role, { group, rate, from, decision }) {
        const settings = await loadSettings();
        const tariff = { group: String(group || ''), rate4: core.parseRate(rate), from: String(from || ''), decision: String(decision || '').replace(/\s+/g, ' ').trim() };
        const error = core.checkTariff(tariff, settings.groups, settings.tariffs);
        if (error) fail('invalid-argument', error);
        tariff.id = db.collection('_').doc().id.slice(0, 12);
        tariff.by = actor;
        tariff.at = new Date().toISOString();
        await settingsRef.set({ tariffs: [...settings.tariffs, tariff], groups: settings.groups }, { merge: true });
        const name = settings.groups.find(g => g.id === tariff.group)?.name;
        await audit(actor, role, 'charges.tariff', 'charges/settings',
            `Тариф «${name}»: ${core.formatRate(tariff.rate4)} грн/м² з ${core.periodName(tariff.from)}`, tariff);
        return { ok: true, id: tariff.id };
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
        const group = { id: `g${Date.now().toString(36)}`, name: String(name).trim() };
        await settingsRef.set({ groups: [...settings.groups, group] }, { merge: true });
        await audit(actor, role, 'charges.group', 'charges/settings', `Група приміщень «${group.name}»`, group);
        return { ok: true, id: group.id };
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
        const apartments = await loadApartments();
        const ids = new Map(apartments.map(a => [a.apt, a.id]));
        const list = (rows || []).map(r => ({ apt: cleanApt(r?.apt), amountKop: Number(r?.amountKop) }));
        const error = core.checkOpening(list, new Set(ids.keys()));
        if (error) fail('invalid-argument', error);
        const amounts = new Map(list.map(r => [r.apt, r.amountKop]));
        const at = Timestamp.fromDate(core.openingDate());
        let batch = db.batch(), ops = 0;
        for (const [apt, id] of ids) {
            const kop = amounts.get(apt) || 0;
            batch.set(db.doc(`apartments/${id}/ledger/${core.OPENING_ID}`), {
                at, period: core.OPENING_PERIOD, kind: 'opening', amount: fromKop(kop), amountKop: kop,
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
        return { period, opening: Boolean(settings.opening?.set), ...core.statement(byApt, period, settings.startPeriod) };
    }

    const chargesAction = onCall({ region: REGION, maxInstances: 4, timeoutSeconds: 120 }, async request => {
        const actor = await requireAdmin(request, ['chair', 'accountant']);
        const role = await staffRole(actor);
        const data = request.data || {};
        switch (data.action) {
            case 'context': return context();
            case 'preview': return preview(data);
            case 'statement': return getStatement(data);
            case 'run': return run(actor, role, data);
            case 'revert': return revert(actor, role, data);
            case 'addTariff': return addTariff(actor, role, data);
            case 'removeTariff': return removeTariff(actor, role, data);
            case 'addGroup': return addGroup(actor, role, data);
            case 'setPremises': return setPremises(actor, role, data);
            case 'setOpening': return setOpening(actor, role, data);
            case 'recompute': {
                const r = await recompute();
                if (r.skipped) fail('failed-precondition', 'Спершу внесіть вхідні залишки на 30.09.2026');
                await audit(actor, role, 'charges.recompute', 'apartments', `Баланси перераховано з історії: ${r.updated} змін`, r);
                return r;
            }
            default: fail('invalid-argument', 'Невідома дія');
        }
    });

    return { chargesAction, recompute: recomputeSafe, actions: { run, revert, addTariff, removeTariff, addGroup, setPremises, setOpening, context, getStatement, recompute } };
};
