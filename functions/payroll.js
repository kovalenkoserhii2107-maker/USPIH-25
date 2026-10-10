'use strict';
// ============================================================
// Зарплата й виплати фізособам (частина 7).
//
// payroll_people/{id}: { name, kind: employee|gph, position, rnokpp, iban,
//   salaryKop, fte, mainJob, from, to, taxNotified, contract, active }
//   Персональні дані: читають голова й бухгалтер, пише лише сервер.
// payroll_runs/{місяць}: { status: draft|approved, inputs: { [id]: { workedDays,
//   bonusKop, actKop } }, run (розрахунок), paidAdvance: { [id]: аванс },
//   stages: { advance|final: { at, by, payments: [id] } }, approvedBy, … }
// payroll_settings/main: { advancePct, taxes: { pdfo|vz|esv: { name, iban, code } } }
//
// Бухгалтер готує відомість → голова затверджує → бухгалтер створює
// платежі (аванс, потім остаточний розрахунок з ЄСВ) → голова підписує
// пачку в Приват24. Змінена після затвердження відомість знову чекає голову.
// ============================================================
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const callGuard = require('./call-guard');
const core = require('./payroll-core');
const { randomUUID } = require('crypto');
const { fromKop } = require('./bank-core');

const REGION = 'europe-central2';

module.exports = function payrollFunctions({ db, FieldValue, requireAdmin, staffRole, payments, lock }) {
    const fail = (code, message) => { throw new HttpsError(code, message); };
    const text = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
    const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Kyiv' }).format(new Date());
    const validPeriod = p => /^\d{4}-(0[1-9]|1[0-2])$/.test(String(p || ''));
    const settingsRef = db.doc('payroll_settings/main');

    async function audit(actor, role, action, target, summary, details = {}) {
        await db.collection('audit_log').add({ actor, role, action, target, summary: String(summary).slice(0, 300),
            details: JSON.parse(JSON.stringify(details)), at: FieldValue.serverTimestamp() });
    }

    async function loadPeople() {
        return (await db.collection('payroll_people').get()).docs.map(d => ({ id: d.id, ...d.data() }));
    }
    async function loadSettings() {
        const s = (await settingsRef.get()).data() || {};
        return { advancePct: Number.isFinite(s.advancePct) ? s.advancePct : 50, taxes: s.taxes || {} };
    }

    /** Розрахунок місяця з урахуванням уже виплаченого авансу (його суми не змінюються). */
    function compute(people, stored, period, settings) {
        const run = core.buildRun({ people, inputs: stored?.inputs || {}, period, advancePct: settings.advancePct });
        if (run.error) fail('failed-precondition', run.error);
        const paid = stored?.paidAdvance || {};
        if (Object.keys(paid).some(id => !run.rows.some(r => r.personId === id))) {
            fail('failed-precondition', 'У відомості зникла людина, якій відправлено аванс. Відновіть її картку для цього місяця.');
        }
        for (const r of run.rows) {
            const a = paid[r.personId];
            if (!a) continue;
            r.advance = a;
            r.final = { grossKop: r.grossKop - a.grossKop, pdfoKop: r.pdfoKop - a.pdfoKop, vzKop: r.vzKop - a.vzKop, esvKop: r.esvKop - (a.esvKop || 0) };
            r.final.netKop = r.final.grossKop - r.final.pdfoKop - r.final.vzKop;
            if (Object.values(r.final).some(kop => kop < 0)) fail('failed-precondition', 'Нарахування менше вже відправленого авансу. Потрібне окреме коригування, відʼємну виплату не створено.');
        }
        const sumIn = (stage, key) => run.rows.reduce((s, r) => s + (r[stage][key] || 0), 0);
        for (const stage of ['advance', 'final']) run.totals[stage] = Object.fromEntries(['grossKop', 'pdfoKop', 'vzKop', 'netKop', 'esvKop'].map(k => [k, sumIn(stage, k)]));
        return run;
    }

    async function context({ period } = {}) {
        const now = today();
        const p = validPeriod(period) ? period : now.slice(0, 7);
        const [people, settings, runSnap, runsSnap, sent] = await Promise.all([
            loadPeople(), loadSettings(), db.doc(`payroll_runs/${p}`).get(), db.collection('payroll_runs').select('status', 'stages').get(),
            db.collection('payments').where('payroll.period', '==', p).get()
        ]);
        const stored = runSnap.exists ? runSnap.data() : null;
        const run = stored?.run || compute(people, stored, p, settings);
        const paymentsList = sent.docs.map(d => ({ id: d.id, stage: d.data().payroll?.stage, key: d.data().payroll?.key, status: d.data().status,
            amountKop: d.data().amountKop, recipient: d.data().recipient?.name || '', error: d.data().error || null,
            returnedKop: d.data().returnedKop || 0, repaid: Boolean(d.data().repaidBy?.length), retry: d.data().payroll?.retry || 0 }));
        const closed = lock ? await lock.closed() : [];
        return {
            period: p, today: now, kinds: core.KINDS, people, settings, run,
            status: stored?.status || 'none', savedAt: stored?.savedAt?.toDate?.()?.toISOString() || null,
            approvedBy: stored?.approvedBy || null, approvedAt: stored?.approvedAt?.toDate?.()?.toISOString() || null,
            stages: stored?.stages || {}, paidAdvance: Boolean(stored?.paidAdvance), payments: paymentsList,
            runs: runsSnap.docs.map(d => ({ period: d.id, status: d.data().status, advance: Boolean(d.data().stages?.advance), final: Boolean(d.data().stages?.final) }))
                .sort((a, b) => b.period.localeCompare(a.period)),
            activePeople: people.filter(x => x.active !== false).length,
            closed: closed.includes(p)
        };
    }

    async function savePerson(actor, role, data) {
        const p = {
            name: text(data.name, 120), kind: data.kind === 'gph' ? 'gph' : 'employee', position: text(data.position, 80),
            rnokpp: String(data.rnokpp || '').replace(/\D/g, '').slice(0, 10), iban: String(data.iban || '').replace(/\s+/g, '').toUpperCase(),
            salaryKop: data.kind === 'gph' ? 0 : Number(data.salaryKop), fte: data.kind === 'gph' ? null : Number(data.fte ?? 1),
            mainJob: data.mainJob !== false, from: String(data.from || ''), to: String(data.to || ''), taxNotified: Boolean(data.taxNotified),
            contract: text(data.contract, 80), active: data.active !== false
        };
        const error = core.checkPerson(p);
        if (error) fail('invalid-argument', error);
        const ref = data.id ? db.doc(`payroll_people/${String(data.id).replace(/[^\w-]/g, '')}`) : db.collection('payroll_people').doc();
        await ref.set({ ...p, updatedBy: actor, updatedAt: FieldValue.serverTimestamp(), ...(data.id ? {} : { createdBy: actor, createdAt: FieldValue.serverTimestamp() }) }, { merge: true });
        // Не «Іван Петренко отримує …», а лише факт: персональні дані в журнал не пишемо.
        await audit(actor, role, 'payroll.person', `payroll_people/${ref.id}`, `${data.id ? 'Змінено' : 'Додано'}: ${core.KINDS[p.kind]}${p.position ? `, ${p.position}` : ''}`, { kind: p.kind });
        return { id: ref.id };
    }

    async function saveSettings(actor, role, { advancePct, taxes }) {
        const clean = t => ({ name: text(t?.name, 140), iban: String(t?.iban || '').replace(/\s+/g, '').toUpperCase(), code: String(t?.code || '').replace(/\D/g, '').slice(0, 10) });
        const percentage = Number(advancePct);
        if (!Number.isInteger(percentage) || percentage < 0 || percentage > 80) fail('invalid-argument', 'Відсоток авансу — ціле число від 0 до 80');
        const out = { advancePct: percentage, taxes: { pdfo: clean(taxes?.pdfo), vz: clean(taxes?.vz), esv: clean(taxes?.esv) } };
        for (const [k, t] of Object.entries(out.taxes)) if (t.iban && !core.validIban(t.iban)) fail('invalid-argument', `${k.toUpperCase()}: IBAN має вигляд UA та 27 цифр`);
        await settingsRef.set({ ...out, updatedBy: actor, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
        await audit(actor, role, 'payroll.settings', 'payroll_settings/main', `Зарплата: аванс ${out.advancePct} %, рахунки податків`, out);
        return { ok: true };
    }

    /** Табель і акти місяця. Змінена відомість знову чекає затвердження голови. */
    async function saveRun(actor, role, { period, inputs }) {
        if (!validPeriod(period)) fail('invalid-argument', 'Невідомий місяць');
        await lock?.assertOpen(period, 'Відомість зарплати');
        const ref = db.doc(`payroll_runs/${period}`);
        const prevSnap = await ref.get();
        const prev = prevSnap.data() || null;
        if (prev?.stages?.final) fail('failed-precondition', 'Остаточний розрахунок уже відправлено в банк — відомість не змінюється');
        if (prev?.stages?.advance?.complete === false) fail('failed-precondition', 'Спершу завершіть відправку авансу: частина платежів ще не створена');
        const people = await loadPeople();
        const clean = {};
        for (const [id, v] of Object.entries(inputs || {})) {
            const person = people.find(p => p.id === id);
            if (!person) fail('invalid-argument', 'У табелі невідома людина');
            for (const key of ['workedDays', 'bonusKop', 'actKop']) {
                if (v?.[key] === undefined || v[key] === '') continue;
                const value = Number(v[key]);
                const max = key === 'workedDays' ? core.employmentDays(person, period) : 100000000000;
                if (!Number.isSafeInteger(value) || value < 0 || value > max) fail('invalid-argument', key === 'workedDays' ? 'Табель: кількість днів більша за норму трудових відносин або некоректна' : 'У табелі некоректна сума');
            }
            // Перерахунок за минулий місяць: може бути й мінусом (надміру нараховане), з поясненням.
            const correction = v?.correctionKop === undefined || v.correctionKop === '' ? 0 : Number(v.correctionKop);
            if (!Number.isSafeInteger(correction) || Math.abs(correction) > 100000000000) fail('invalid-argument', 'Перерахунок — сума в копійках');
            if (correction && (!validPeriod(v.correctionFor) || v.correctionFor >= period)) fail('invalid-argument', 'Перерахунок: вкажіть минулий місяць, за який він');
            if (correction && text(v.correctionNote, 120).length < 3) fail('invalid-argument', 'Перерахунок: коротко поясніть причину');
            clean[String(id).replace(/[^\w-]/g, '')] = {
                ...(v?.workedDays !== undefined && v.workedDays !== '' ? { workedDays: Math.max(0, Math.min(31, Math.round(Number(v.workedDays) || 0))) } : {}),
                ...(v?.bonusKop ? { bonusKop: Math.max(0, Math.round(Number(v.bonusKop))) } : {}),
                ...(v?.actKop ? { actKop: Math.max(0, Math.round(Number(v.actKop))) } : {}),
                ...(correction ? { correctionKop: correction, correctionFor: v.correctionFor, correctionNote: text(v.correctionNote, 120) } : {})
            };
        }
        const run = compute(people, { ...prev, inputs: clean }, period, await loadSettings());
        const negative = run.rows.filter(r => r.grossKop < 0 || r.final.netKop < 0);
        if (negative.length) fail('failed-precondition', `${negative.map(r => r.name).join(', ')}: перерахунок у мінус більший за нарахування місяця. Надміру виплачене людина повертає на рахунок ОСББ — рознесіть це як повернення до виплати`);
        await db.runTransaction(async t => {
            const fresh = await t.get(ref);
            await lock?.assertOpen(period, 'Відомість зарплати', t);
            if (fresh.exists !== prevSnap.exists || (fresh.exists && !fresh.updateTime.isEqual(prevSnap.updateTime))) fail('aborted', 'Відомість змінилась. Оновіть сторінку.');
            if (fresh.data()?.stages?.final || fresh.data()?.stages?.advance?.complete === false || fresh.data()?.sending) fail('aborted', 'Почалась виплата відомості. Оновіть сторінку.');
            if (JSON.stringify(fresh.data()?.stages || {}) !== JSON.stringify(prev?.stages || {})) fail('aborted', 'Дані виплат змінилися. Оновіть сторінку.');
            t.set(ref, { period, status: 'draft', inputs: clean, run: JSON.parse(JSON.stringify(run)), savedBy: actor, savedAt: FieldValue.serverTimestamp(),
                approvedBy: null, approvedAt: null }, { merge: true });
        });
        await audit(actor, role, 'payroll.save', `payroll_runs/${period}`, `Відомість зарплати за ${core.monthName(period)}: нараховано ${fromKop(run.totals.grossKop)} грн, ${run.rows.length} особ.`,
            { totals: run.totals });
        return { ok: true, totals: run.totals };
    }

    async function approve(actor, role, { period }) {
        if (role !== 'chair') fail('permission-denied', 'Відомість зарплати затверджує голова');
        if (!validPeriod(period)) fail('invalid-argument', 'Невідомий місяць');
        await lock?.assertOpen(period, 'Відомість зарплати');
        const ref = db.doc(`payroll_runs/${period}`);
        const snap = await ref.get();
        if (!snap.exists) fail('not-found', 'Спершу збережіть відомість');
        if (snap.data().status === 'approved') fail('failed-precondition', 'Відомість уже затверджено');
        // Затверджується збережений розрахунок, який бачить голова.
        const run = snap.data().run || compute(await loadPeople(), snap.data(), period, await loadSettings());
        await db.runTransaction(async t => {
            const fresh = await t.get(ref);
            await lock?.assertOpen(period, 'Відомість зарплати', t);
            if (!fresh.updateTime.isEqual(snap.updateTime)) fail('aborted', 'Відомість змінилась. Перегляньте її знову.');
            t.update(ref, { status: 'approved', run: JSON.parse(JSON.stringify(run)), approvedBy: actor, approvedAt: FieldValue.serverTimestamp() });
        });
        await audit(actor, role, 'payroll.approve', `payroll_runs/${period}`, `Відомість зарплати за ${core.monthName(period)} затверджено: ${fromKop(run.totals.grossKop)} грн`, { totals: run.totals });
        return { ok: true };
    }

    /**
     * Платежі етапу: аванс або остаточний розрахунок (з ЄСВ). Кожен платіж
     * іде в Приват24 на підпис голови; повторне натискання не дублює
     * (ключ пропозиції).
     */
    async function pay(actor, role, { period, stage }) {
        if (!validPeriod(period)) fail('invalid-argument', 'Невідомий місяць');
        if (!['advance', 'final'].includes(stage)) fail('invalid-argument', 'Невідомий етап');
        await lock?.assertOpen(period, 'Виплата зарплати');
        const ref = db.doc(`payroll_runs/${period}`);
        const snap = await ref.get();
        if (!snap.exists || snap.data().status !== 'approved') fail('failed-precondition', 'Спершу голова має затвердити відомість');
        const stored = snap.data();
        if (stored.stages?.[stage] && stored.stages[stage].complete !== false) fail('failed-precondition', stage === 'advance' ? 'Аванс уже відправлено' : 'Зарплату вже відправлено');
        if (stage === 'final' && stored.stages?.advance?.complete === false) fail('failed-precondition', 'Спершу завершіть відправку авансу');
        if (stage === 'advance' && stored.stages?.final) fail('failed-precondition', 'Зарплату за місяць уже виплачено повністю');
        const people = await loadPeople();
        const settings = await loadSettings();
        const run = JSON.parse(JSON.stringify(stored.run || compute(people, stored, period, settings)));
        for (const r of run.rows) {
            r.advance.esvKop ||= 0;
            r.final.esvKop ??= r.esvKop - r.advance.esvKop;
        }
        const incomplete = run.rows.filter(r => r.netKop > 0 && r.problems?.length);
        if (incomplete.length) fail('failed-precondition', incomplete.map(r => `${r.name}: ${r.problems.join('; ')}`).join('; '));
        // Аванс не платили — остаточний розрахунок платить усе (інакше половина «зависла б»).
        if (stage === 'final' && !stored.stages?.advance) {
            for (const r of run.rows) {
                r.final = { grossKop: r.grossKop, pdfoKop: r.pdfoKop, vzKop: r.vzKop, netKop: r.netKop, esvKop: r.esvKop };
                r.advance = { grossKop: 0, pdfoKop: 0, vzKop: 0, netKop: 0, esvKop: 0 };
            }
        }
        const code = String((await db.doc('osbb_settings/finance').get()).data()?.edrpou || '');
        if (!/^\d{8}$/.test(code)) fail('failed-precondition', 'Внесіть код ЄДРПОУ ОСББ («Налаштування → ОСББ у реєстрах»): він потрібен у призначенні податкових платежів');
        // З поточного рахунку ОСББ (не з резервного фонду).
        const accounts = Object.entries((await db.doc('bank/settings').get()).data()?.accounts || {});
        const account = (accounts.find(([, a]) => (a.purpose || 'current') === 'current') || [])[0] || '';
        if (!account) fail('failed-precondition', 'Підключіть банк: немає поточного рахунку ОСББ, з якого платити');
        const list = stored.stages?.[stage]?.plan || core.stagePayments(run, stage, { code, taxes: settings.taxes, people: new Map(people.map(p => [p.id, p])) });
        if (!list.length) fail('failed-precondition', 'Немає що виплачувати');
        const problems = core.paymentProblems(list);
        if (problems.length) fail('failed-precondition', problems.join('; '));
        const attempt = randomUUID();
        await db.runTransaction(async t => {
            const fresh = await t.get(ref);
            await lock?.assertOpen(period, 'Виплата зарплати', t);
            if (!fresh.updateTime.isEqual(snap.updateTime)) fail('aborted', 'Відомість змінилась. Оновіть сторінку.');
            if (fresh.data().sending && Date.now() - Date.parse(fresh.data().sending.at) < 600000) fail('aborted', 'Платежі вже відправляються. Зачекайте завершення.');
            t.update(ref, { sending: { attempt, at: new Date().toISOString() },
                [`stages.${stage}`]: { ...(stored.stages?.[stage] || {}), complete: false, plan: list, account: stored.stages?.[stage]?.account || account },
                ...(stage === 'advance' ? { paidAdvance: Object.fromEntries(run.rows.map(r => [r.personId, r.advance])) } : {}) });
        });
        const created = [...(stored.stages?.[stage]?.payments || [])];
        const completed = { ...(stored.stages?.[stage]?.completed || {}) };
        const errors = [];
        for (const p of list) {
            if (completed[p.key]) continue;
            try {
                const r = await payments.actions.create(actor, role, { kind: p.kind, recipient: p.recipient, amountKop: p.amountKop, purpose: p.purpose,
                    account: stored.stages?.[stage]?.account || account, proposalKey: `payroll:${period}:${p.key}`, reuseExisting: true, payroll: { period, stage, key: p.key.split(':')[1] } });
                if (!created.includes(r.id)) created.push(r.id);
                completed[p.key] = r.id;
                await ref.update({ [`stages.${stage}.payments`]: created, [`stages.${stage}.completed`]: completed });
            } catch (e) {
                errors.push(`${p.recipient.name || p.key}: ${e.message}`);
                break;
            }
        }
        const complete = list.every(p => completed[p.key]);
        const update = { [`stages.${stage}`]: { at: new Date().toISOString(), by: actor, payments: created, errors, completed, complete, plan: list,
            account: stored.stages?.[stage]?.account || account }, sending: FieldValue.delete() };
        await ref.update(update);
        await audit(actor, role, 'payroll.pay', `payroll_runs/${period}`, `${stage === 'advance' ? 'Аванс' : 'Зарплата'} за ${core.monthName(period)}: ${created.length} платеж(ів) у Приват24 на підпис`,
            { created: created.length, errors });
        return { ok: complete, created: created.length, errors };
    }

    /**
     * Повторна виплата, яку банк повернув (неправильний IBAN, закритий
     * рахунок): новий платіж на ту саму суму за поточною карткою людини
     * чи рахунком податку. Голова підписує його в Приват24, як і перший.
     */
    async function repay(actor, role, { paymentId }) {
        const oldRef = db.doc(`payments/${String(paymentId || '').replace(/[^\w-]/g, '')}`);
        const snap = await oldRef.get();
        const old = snap.exists ? snap.data() : null;
        if (!old?.payroll) fail('not-found', 'Платіж за відомістю не знайдено');
        if (old.status !== 'paid' || (old.returnedKop || 0) < old.amountKop) fail('failed-precondition', 'Банк ще не повернув цей платіж повністю: рознесіть повернення у «Вхідних» до цього списання');
        if ((old.repaidBy || []).length) fail('failed-precondition', 'Цей платіж уже відправлено знову');
        const { period, stage, key } = old.payroll;
        const settings = await loadSettings();
        let recipient = old.recipient;
        if (['pdfo', 'vz', 'esv'].includes(key)) {
            const t = settings.taxes?.[key];
            if (!t?.iban) fail('failed-precondition', `Немає рахунку для «${key.toUpperCase()}» — внесіть у «Зарплата → Податки й аванс»`);
            recipient = { name: t.name, iban: t.iban, code: t.code };
        } else {
            const person = (await db.doc(`payroll_people/${key}`).get()).data();
            if (!person?.iban || !core.validIban(person.iban)) fail('failed-precondition', 'У картці людини немає правильного IBAN — виправте його й повторіть');
            recipient = { ...old.recipient, iban: person.iban, name: person.name };
        }
        if (recipient.iban === old.recipient?.iban) fail('failed-precondition', 'Рахунок отримувача той самий, що й у поверненому платежі. Спершу виправте IBAN');
        const tries = (old.payroll.retry || 0) + 1;
        const r = await payments.actions.create(actor, role, { kind: old.kind, recipient, amountKop: old.amountKop, purpose: old.purpose, account: old.account,
            proposalKey: `payroll:${period}:${stage}:${key}:r${tries}`, payroll: { period, stage, key, retry: tries, repayOf: oldRef.id } });
        await oldRef.update({ repaidBy: FieldValue.arrayUnion(r.id) });
        await audit(actor, role, 'payroll.repay', `payments/${oldRef.id}`, `Повторна виплата за ${core.monthName(period)} після повернення банком`, { key: ['pdfo', 'vz', 'esv'].includes(key) ? key : 'person', newPayment: r.id });
        return { id: r.id };
    }

    const payrollAction = onCall({ region: REGION, maxInstances: 4, timeoutSeconds: 120 }, callGuard('payrollAction', async request => {
        const actor = await requireAdmin(request, ['chair', 'accountant']);
        const role = await staffRole(actor);
        const data = request.data || {};
        switch (data.action) {
            case 'context': return context(data);
            case 'person': return savePerson(actor, role, data);
            case 'settings': return saveSettings(actor, role, data);
            case 'save': return saveRun(actor, role, data);
            case 'approve': return approve(actor, role, data);
            case 'pay': return pay(actor, role, data);
            case 'repay': return repay(actor, role, data);
            default: fail('invalid-argument', 'Невідома дія');
        }
    }));

    return { payrollAction, actions: { context, savePerson, saveSettings, saveRun, approve, pay, repay } };
};
