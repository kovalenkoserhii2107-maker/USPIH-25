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
const core = require('./payroll-core');
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
        for (const r of run.rows) {
            const a = paid[r.personId];
            if (!a) continue;
            r.advance = a;
            r.final = { grossKop: r.grossKop - a.grossKop, pdfoKop: r.pdfoKop - a.pdfoKop, vzKop: r.vzKop - a.vzKop };
            r.final.netKop = r.final.grossKop - r.final.pdfoKop - r.final.vzKop;
        }
        const sumIn = (stage, key) => run.rows.reduce((s, r) => s + r[stage][key], 0);
        for (const stage of ['advance', 'final']) run.totals[stage] = Object.fromEntries(['grossKop', 'pdfoKop', 'vzKop', 'netKop'].map(k => [k, sumIn(stage, k)]));
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
        const run = compute(people, stored, p, settings);
        const paymentsList = sent.docs.map(d => ({ id: d.id, stage: d.data().payroll?.stage, key: d.data().payroll?.key, status: d.data().status,
            amountKop: d.data().amountKop, recipient: d.data().recipient?.name || '', error: d.data().error || null }));
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
            salaryKop: data.kind === 'gph' ? 0 : Math.round(Number(data.salaryKop) || 0), fte: data.kind === 'gph' ? null : Number(data.fte) || 1,
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
        const out = { advancePct: Math.min(80, Math.max(0, Math.round(Number(advancePct) || 0))), taxes: { pdfo: clean(taxes?.pdfo), vz: clean(taxes?.vz), esv: clean(taxes?.esv) } };
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
        const prev = (await ref.get()).data() || null;
        if (prev?.stages?.final) fail('failed-precondition', 'Остаточний розрахунок уже відправлено в банк — відомість не змінюється');
        const clean = {};
        for (const [id, v] of Object.entries(inputs || {})) {
            clean[String(id).replace(/[^\w-]/g, '')] = {
                ...(v?.workedDays !== undefined && v.workedDays !== '' ? { workedDays: Math.max(0, Math.min(31, Math.round(Number(v.workedDays) || 0))) } : {}),
                ...(v?.bonusKop ? { bonusKop: Math.max(0, Math.round(Number(v.bonusKop))) } : {}),
                ...(v?.actKop ? { actKop: Math.max(0, Math.round(Number(v.actKop))) } : {})
            };
        }
        const people = await loadPeople();
        const run = compute(people, { ...prev, inputs: clean }, period, await loadSettings());
        await ref.set({ period, status: 'draft', inputs: clean, run: JSON.parse(JSON.stringify(run)), savedBy: actor, savedAt: FieldValue.serverTimestamp(),
            approvedBy: null, approvedAt: null }, { merge: true });
        await audit(actor, role, 'payroll.save', `payroll_runs/${period}`, `Відомість зарплати за ${core.monthName(period)}: нараховано ${fromKop(run.totals.grossKop)} грн, ${run.rows.length} особ.`,
            { totals: run.totals });
        return { ok: true, totals: run.totals };
    }

    async function approve(actor, role, { period }) {
        if (role !== 'chair') fail('permission-denied', 'Відомість зарплати затверджує голова');
        await lock?.assertOpen(period, 'Відомість зарплати');
        const ref = db.doc(`payroll_runs/${period}`);
        const snap = await ref.get();
        if (!snap.exists) fail('not-found', 'Спершу збережіть відомість');
        if (snap.data().status === 'approved') fail('failed-precondition', 'Відомість уже затверджено');
        // Затверджуємо саме те, що зараз у довіднику й табелі: перераховуємо.
        const run = compute(await loadPeople(), snap.data(), period, await loadSettings());
        await ref.update({ status: 'approved', run: JSON.parse(JSON.stringify(run)), approvedBy: actor, approvedAt: FieldValue.serverTimestamp() });
        await audit(actor, role, 'payroll.approve', `payroll_runs/${period}`, `Відомість зарплати за ${core.monthName(period)} затверджено: ${fromKop(run.totals.grossKop)} грн`, { totals: run.totals });
        return { ok: true };
    }

    /**
     * Платежі етапу: аванс або остаточний розрахунок (з ЄСВ). Кожен платіж
     * іде в Приват24 на підпис голови; повторне натискання не дублює
     * (ключ пропозиції).
     */
    async function pay(actor, role, { period, stage }) {
        if (!['advance', 'final'].includes(stage)) fail('invalid-argument', 'Невідомий етап');
        await lock?.assertOpen(period, 'Виплата зарплати');
        const ref = db.doc(`payroll_runs/${period}`);
        const snap = await ref.get();
        if (!snap.exists || snap.data().status !== 'approved') fail('failed-precondition', 'Спершу голова має затвердити відомість');
        const stored = snap.data();
        if (stored.stages?.[stage]) fail('failed-precondition', stage === 'advance' ? 'Аванс уже відправлено' : 'Зарплату вже відправлено');
        if (stage === 'advance' && stored.stages?.final) fail('failed-precondition', 'Зарплату за місяць уже виплачено повністю');
        const people = await loadPeople();
        const settings = await loadSettings();
        const run = compute(people, stored, period, settings);
        // Аванс не платили — остаточний розрахунок платить усе (інакше половина «зависла б»).
        if (stage === 'final' && !stored.stages?.advance) {
            for (const r of run.rows) {
                r.final = { grossKop: r.grossKop, pdfoKop: r.pdfoKop, vzKop: r.vzKop, netKop: r.netKop };
                r.advance = { grossKop: 0, pdfoKop: 0, vzKop: 0, netKop: 0 };
            }
        }
        const code = String((await db.doc('osbb_settings/finance').get()).data()?.edrpou || '');
        if (!/^\d{8}$/.test(code)) fail('failed-precondition', 'Внесіть код ЄДРПОУ ОСББ («Налаштування → ОСББ у реєстрах»): він потрібен у призначенні податкових платежів');
        // З поточного рахунку ОСББ (не з резервного фонду).
        const accounts = Object.entries((await db.doc('bank/settings').get()).data()?.accounts || {});
        const account = (accounts.find(([, a]) => (a.purpose || 'current') === 'current') || [])[0] || '';
        if (!account) fail('failed-precondition', 'Підключіть банк: немає поточного рахунку ОСББ, з якого платити');
        const list = core.stagePayments(run, stage, { code, taxes: settings.taxes, people: new Map(people.map(p => [p.id, p])) });
        if (!list.length) fail('failed-precondition', 'Немає що виплачувати');
        const problems = core.paymentProblems(list);
        if (problems.length) fail('failed-precondition', problems.join('; '));
        const created = [];
        const errors = [];
        for (const p of list) {
            try {
                const r = await payments.actions.create(actor, role, { kind: p.kind, recipient: p.recipient, amountKop: p.amountKop, purpose: p.purpose,
                    account, proposalKey: `payroll:${period}:${p.key}`, payroll: { period, stage, key: p.key.split(':')[1] } });
                created.push(r.id);
            } catch (e) {
                errors.push(`${p.recipient.name || p.key}: ${e.message}`);
                if (!created.length) throw e;          // перший же відмовив (банк не підключено) — нічого не створено
            }
        }
        const update = { [`stages.${stage}`]: { at: new Date().toISOString(), by: actor, payments: created, errors } };
        if (stage === 'advance') update.paidAdvance = Object.fromEntries(run.rows.map(r => [r.personId, r.advance]));
        await ref.update(update);
        await audit(actor, role, 'payroll.pay', `payroll_runs/${period}`, `${stage === 'advance' ? 'Аванс' : 'Зарплата'} за ${core.monthName(period)}: ${created.length} платеж(ів) у Приват24 на підпис`,
            { created: created.length, errors });
        return { ok: true, created: created.length, errors };
    }

    const payrollAction = onCall({ region: REGION, maxInstances: 4, timeoutSeconds: 120 }, async request => {
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
            default: fail('invalid-argument', 'Невідома дія');
        }
    });

    return { payrollAction, actions: { context, savePerson, saveSettings, saveRun, approve, pay } };
};
