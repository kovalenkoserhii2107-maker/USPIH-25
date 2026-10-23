'use strict';
// ============================================================
// Зарплатний проект ПриватБанку (Автоклієнт, розділ 7, maspay).
//
// Працівник ↔ отримувач проекту: payroll_people/{id}.salaryProject =
//   { group, receiverId, tabn, pan (маска) }. Повний номер картки не зберігаємо:
//   він іде лише в банк під час додавання працівника в проект.
// Відомість етапу (аванс / зарплата) — payroll_runs/{місяць}.stages.{етап}.project:
//   { packetName, group, reference, added: { ключ: референс запису }, status, bankStatus, … }.
// Застосунок створює відомість, додає людей і запускає перевірку банком.
// Підписує й надсилає в банк голова — у Приват24 для бізнесу.
// ============================================================
const { HttpsError } = require('firebase-functions/v2/https');
const { randomUUID, createHash } = require('node:crypto');
const api = require('./privat-payroll-api');
const core = require('./payroll-core');
const { payable } = require('./bank-accounts');
const identity = require('./payroll-payment-core');
const fail = (code, message) => { throw new HttpsError(code, message); };
const safe = value => String(value || '').replace(/[^\w-]/g, '').slice(0, 120);
const GROUPS = ['SALARY', 'STUDENT'];
const validPeriod = p => /^\d{4}-(0[1-9]|1[0-2])$/.test(String(p || ''));

/** Отримувач банку в однаковій формі (банк віддає ПІБ масивом, картку — маскою). */
const cleanReceiver = r => ({ id: String(r.id), group: String(r.group || ''), inn: String(r.inn || ''), fio: api.fioText(r.fio), tabn: String(r.tabn || ''),
    pan: maskPan(r.pan) });
/** Банк віддає маску «DDDD **** **** DDDD»; якщо раптом прийшов повний номер — ховаємо середину. */
function maskPan(pan) {
    const s = String(pan || '').trim(), d = s.replace(/\D/g, '');
    return d.length > 8 ? `${d.slice(0, 4)} **** **** ${d.slice(-4)}` : s;
}

module.exports = function projectFunctions({ db, FieldValue, lock }) {
    async function token() {
        const value = (await db.doc('bank_secrets/privat').get()).data()?.token;
        if (!value) fail('failed-precondition', 'Підключіть Автоклієнт ПриватБанку («Налаштування → Банк»)');
        return value;
    }
    const projectGroup = async () => (await db.doc('payroll_settings/main').get()).data()?.projectGroup || null;

    async function loadReceivers(secret, group) {
        const receivers = (await api.receivers(secret, group)).map(cleanReceiver);
        await db.doc(`payroll_project_receivers/${group}`).set({ rows: receivers, at: FieldValue.serverTimestamp() });
        return receivers;
    }

    /** Проекти, отримувачі обраного проекту й підказка наступного табельного номера. */
    async function context({ group } = {}) {
        const secret = await token();
        const groups = await api.groups(secret);
        if (!Array.isArray(groups)) fail('unavailable', 'Банк повернув некоректний список проектів');
        const available = groups.filter(g => GROUPS.includes(g.type)).map(g => ({ type: g.type, name: String(g.name || ''), rko: g.rko ?? null }));
        const chosen = GROUPS.includes(group) ? group : await projectGroup();
        const current = available.find(g => g.type === chosen) || available[0] || null;
        if (!current) return { sandbox: api.isSandbox(secret), groups: [], group: null, receivers: [], nextTabn: '1' };
        const receivers = await loadReceivers(secret, current.type);
        const numbers = receivers.map(r => Number(r.tabn)).filter(Number.isSafeInteger);
        return { sandbox: api.isSandbox(secret), groups: available, group: current.type, receivers, nextTabn: String((numbers.length ? Math.max(...numbers) : 0) + 1) };
    }

    async function link(t, actor, role, ref, person, receiver, group, how) {
        if (person?.kind !== 'employee') fail('failed-precondition', 'Зарплатний проект — лише для працівників за трудовим договором. ЦПД виплачується по IBAN');
        if (!receiver?.tabn) fail('failed-precondition', 'В отримувача банку немає табельного номера');
        if (receiver.inn !== person.rnokpp) fail('failed-precondition', `РНОКПП у картці (${person.rnokpp || 'не внесено'}) і в банку (${receiver.inn || '—'}) не збігаються`);
        t.update(ref, { salaryProject: { group, receiverId: receiver.id, tabn: receiver.tabn, pan: receiver.pan }, updatedAt: FieldValue.serverTimestamp() });
        t.create(db.collection('audit_log').doc(), { actor, role, action: 'payroll.project.receiver', target: ref.path,
            summary: how === 'enroll' ? 'Працівника додано в зарплатний проект' : 'Працівника звʼязано з отримувачем зарплатного проекту', details: { group }, at: FieldValue.serverTimestamp() });
    }

    /** Звʼязати працівника з наявним отримувачем (receiverId '' — відвʼязати). */
    async function linkReceiver(actor, role, { personId, group, receiverId }) {
        const ref = db.doc(`payroll_people/${safe(personId)}`);
        if (!receiverId) {
            await ref.update({ salaryProject: FieldValue.delete(), updatedAt: FieldValue.serverTimestamp() });
            await db.collection('audit_log').add({ actor, role, action: 'payroll.project.receiver', target: ref.path, summary: 'Звʼязок із зарплатним проектом знято', details: {}, at: FieldValue.serverTimestamp() });
            return { ok: true };
        }
        if (!GROUPS.includes(group)) fail('invalid-argument', 'Невідомий проект');
        await db.runTransaction(async t => {
            const [person, list] = await Promise.all([t.get(ref), t.get(db.doc(`payroll_project_receivers/${group}`))]);
            const receiver = list.data()?.rows?.find(r => r.id === String(receiverId) && r.group === group);
            if (!receiver) fail('failed-precondition', 'Отримувача не знайдено. Оновіть список з банку');
            await link(t, actor, role, ref, person.data(), receiver, group, 'link');
        });
        return { ok: true };
    }

    /** Звʼязати всіх працівників без звʼязку з отримувачами, у яких той самий РНОКПП. */
    async function autoLink(actor, role, { group }) {
        if (!GROUPS.includes(group)) fail('invalid-argument', 'Невідомий проект');
        return db.runTransaction(async t => {
            const [people, list] = await Promise.all([t.get(db.collection('payroll_people')), t.get(db.doc(`payroll_project_receivers/${group}`))]);
            const rows = list.data()?.rows || [];
            let linked = 0;
            for (const d of people.docs) {
                const p = d.data();
                if (p.kind !== 'employee' || p.active === false || p.salaryProject?.receiverId || !p.rnokpp) continue;
                const found = rows.filter(r => r.inn === p.rnokpp && r.tabn);
                if (found.length !== 1) continue;
                await link(t, actor, role, d.ref, p, found[0], group, 'link');
                linked++;
            }
            return { linked };
        });
    }

    /**
     * Додати працівника в зарплатний проект (update-receiver): номер картки,
     * табельний номер, РНОКПП і ПІБ з картки. Банк додає нового або оновлює
     * наявного за табельним номером. Повний номер картки не зберігаємо.
     */
    async function enroll(actor, role, { personId, group, pan, tabn }) {
        if (!GROUPS.includes(group)) fail('invalid-argument', 'Оберіть зарплатний проект');
        const card = String(pan || '').replace(/\D/g, '');
        if (!/^\d{16}$/.test(card)) fail('invalid-argument', 'Номер картки — 16 цифр');
        const tab = String(tabn || '').trim();
        if (!/^[\w-]{1,20}$/.test(tab)) fail('invalid-argument', 'Табельний номер — до 20 цифр чи літер');
        const ref = db.doc(`payroll_people/${safe(personId)}`);
        const person = (await ref.get()).data();
        if (person?.kind !== 'employee') fail('failed-precondition', 'Зарплатний проект — лише для працівників за трудовим договором');
        if (!core.validRnokpp(person.rnokpp)) fail('failed-precondition', 'Спершу внесіть правильний РНОКПП у картку працівника');
        const secret = await token();
        const existing = await loadReceivers(secret, group);
        const busy = existing.find(r => r.tabn === tab && r.inn !== person.rnokpp);
        if (busy) fail('failed-precondition', `Табельний номер ${tab} уже має інший отримувач (${busy.fio}). Оберіть інший номер`);
        const result = await api.updateReceiver(secret, { pan: card, group, tabn: tab, inn: person.rnokpp, fio: api.fioParts(person.name) });
        const receivers = await loadReceivers(secret, group);
        const receiver = receivers.find(r => result?.id && r.id === String(result.id)) || receivers.find(r => r.tabn === tab && r.inn === person.rnokpp);
        if (!receiver) fail('unavailable', `Банк прийняв запит (${result?.status || 'без статусу'}), але отримувача ще немає у списку. Оновіть список за кілька хвилин`);
        await db.runTransaction(async t => link(t, actor, role, ref, (await t.get(ref)).data(), receiver, group, 'enroll'));
        return { ok: true, receiver };
    }

    /** Відомості maspay у банку: чернетки, на підписі, проведені й забраковані за 3 місяці. */
    async function packets() {
        const secret = await token();
        const to = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
        const from = new Date(Date.now() - 92 * 86400000).toISOString().slice(0, 10);
        const lists = [];
        for (const [status, range] of [['V'], ['A'], ['F', { from, to }], ['R', { from, to }]]) lists.push(...await api.packets(secret, status, range));
        const runs = await db.collection('payroll_runs').select('stages').get();
        const ours = new Map();
        for (const d of runs.docs) for (const [stage, s] of Object.entries(d.data().stages || {})) if (s.project?.reference) ours.set(s.project.reference, { period: d.id, stage });
        return { sandbox: api.isSandbox(secret), list: [...new Map(lists.filter(p => (p.system || 'maspay') === 'maspay').map(p => [String(p.reference), p])).values()]
            .map(p => ({ reference: String(p.reference), packetName: String(p.packetName || ''), status: String(p.status || ''), substatus: String(p.substatus || ''),
                createdAt: p.createdAt || null, finishedAt: p.finishedAt || null, recordCount: p.recordCount || 0, recordAmountKop: api.amountKop({ amount: p.recordAmount || 0 }),
                error: p.errText || '', ...(ours.get(String(p.reference)) || {}) }))
            .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))) };
    }

    async function find({ period, stage }) {
        if (!validPeriod(period) || !['advance', 'final'].includes(stage)) fail('invalid-argument', 'Оберіть відомість та етап');
        const stored = (await db.doc(`payroll_runs/${period}`).get()).data(), project = stored?.stages?.[stage]?.project;
        if (!project) fail('failed-precondition', 'Відомість проекту не підготовлена');
        const secret = await token();
        const list = [...await api.packets(secret, 'V'), ...await api.packets(secret, 'A')];
        return [...new Map(list.filter(p => p.system === 'maspay' && p.packetName === project.packetName).map(p => [p.reference, p])).values()]
            .map(p => ({ reference: String(p.reference), status: p.status, recordCount: p.recordCount || 0, revision: p.revision || 0 }));
    }

    /** Стан відомості в банку: заголовок і записи. Запамʼятовуємо стан у відомості місяця. */
    async function status({ period, stage }) {
        if (!validPeriod(period) || !['advance', 'final'].includes(stage)) fail('invalid-argument', 'Оберіть відомість та етап');
        const ref = db.doc(`payroll_runs/${period}`), stored = (await ref.get()).data(), project = stored?.stages?.[stage]?.project;
        if (!project?.reference) fail('failed-precondition', 'Банк ще не підтвердив референс; спочатку звірте невідомий результат');
        const secret = await token();
        const header = await api.header(secret, project.reference);
        const rows = await api.content(secret, project.reference);
        if (header.group && header.group !== project.group || header.system && header.system !== 'maspay' || header.packetName !== project.packetName) fail('failed-precondition', 'Це інша відомість банку');
        const bank = { bankStatus: String(header.status || ''), bankSubstatus: String(header.substatus || ''), bankError: String(header.errText || ''), checkedAt: new Date().toISOString() };
        await ref.update(Object.fromEntries(Object.entries(bank).map(([k, v]) => [`stages.${stage}.project.${k}`, v])));
        return { reference: project.reference, status: bank.bankStatus, substatus: bank.bankSubstatus, revision: header.revision || 0, error: bank.bankError, sandbox: api.isSandbox(secret),
            amountKop: api.amountKop({ amount: header.recordAmount || 0 }), count: header.recordCount ?? rows.length,
            rows: rows.map(r => ({ ref: String(r.ref || ''), name: api.fioText(r.fio), tabn: String(r.tabNo || ''), card: String(r.cardNumber || ''), amountKop: api.amountKop(r),
                status: String(r.status || ''), error: String(r.errorCode || '') })) };
    }

    /** Лише тестовий банк: крок, який голова робить у Приват24 (підпис, відправка), і проведення банком. */
    async function sandboxStep(actor, role, { period, stage }) {
        const project = (await db.doc(`payroll_runs/${period}`).get()).data()?.stages?.[stage]?.project;
        if (!project?.reference) fail('failed-precondition', 'Відомість ще не створена в банку');
        await api.sandboxStep(await token(), project.reference);
        return status({ period, stage });
    }

    async function prepare(actor, role, { period, stage, group, reference }) {
        if (!validPeriod(period) || !['advance', 'final'].includes(stage) || !GROUPS.includes(group)) fail('invalid-argument', 'Оберіть місяць, етап та проект');
        if (reference && role !== 'chair') fail('permission-denied', 'Невідомий результат звіряє голова');
        const secret = await token(), runRef = db.doc(`payroll_runs/${period}`), attempt = randomUUID();
        const work = await db.runTransaction(async t => {
            const [snap, settings, finance, bank, people, payments, bankSecret] = await Promise.all([t.get(runRef), t.get(db.doc('payroll_settings/main')), t.get(db.doc('osbb_settings/finance')),
                t.get(db.doc('bank/settings')), t.get(db.collection('payroll_people')), t.get(db.collection('payments').where('payroll.period', '==', period)), t.get(db.doc('bank_secrets/privat'))]);
            if (bankSecret.data()?.token !== secret) fail('aborted', 'Підключення банку змінилося; оновіть отримувачів перед підготовкою');
            const stored = snap.data(), old = stored?.stages?.[stage];
            await lock?.assertOpen(period, 'Зарплатний проект', t);
            // Код ОСББ потрібен і в назві відомості, і в податкових платежах, що йдуть слідом.
            if (!/^\d{8}$/.test(String(finance.data()?.edrpou || ''))) fail('failed-precondition', 'Внесіть код ЄДРПОУ ОСББ («Налаштування → ОСББ у реєстрах»): він потрібен у відомості банку й податкових платежах');
            if (stored?.status !== 'approved' || stored.canceling || old?.external || (stored.sending && Date.now() - Date.parse(stored.sending.at) < 600000)) fail('failed-precondition', 'Потрібна затверджена відомість без іншої відправки');
            const bad = stored.run.rows.filter(r => r.netKop > 0 && r.problems?.length);
            if (bad.length) fail('failed-precondition', bad.map(r => `${r.name}: ${r.problems.join('; ')}`).join('; '));
            if (stage === 'advance' && stored.stages?.final || stage === 'final' && stored.stages?.advance?.complete === false) fail('failed-precondition', 'Завершіть попередній етап');
            if (old?.plan && !old.project) fail('failed-precondition', 'Цей етап уже готується переказами по IBAN');
            if (old?.project?.group && old.project.group !== group) fail('failed-precondition', 'Не можна змінити проект підготовленого етапу');
            const account = old?.account || Object.entries(bank.data()?.accounts || {}).find(([, a]) => payable(a) && (a.purpose || 'current') === 'current')?.[0];
            if (!account || !payable(bank.data()?.accounts?.[account])) fail('failed-precondition', 'Потрібен доступний гривневий поточний рахунок');
            const plan = old?.plan || core.stagePayments(core.paymentRun(stored), stage, { code: finance.data()?.edrpou, taxes: settings.data()?.taxes });
            const map = new Map(people.docs.map(d => [d.id, d.data()]));
            // Через проект — лише працівники; виконавці ЦПД і податки йдуть окремими платежами по IBAN.
            const kindOf = id => stored.run.rows.find(r => r.personId === id)?.kind;
            const wages = plan.filter(p => p.kind === 'salary' && kindOf(p.personId) === 'employee').map(row => {
                const link = map.get(row.personId)?.salaryProject;
                if (link?.group !== group || !link.receiverId || !link.tabn) fail('failed-precondition', `${row.recipient.name}: додайте працівника в зарплатний проект («Зарплата → Приват24»)`);
                return { ...row, receiverId: link.receiverId, tabn: link.tabn };
            });
            if (!wages.length) fail('failed-precondition', 'Немає працівників для зарплатного проекту');
            const errors = core.paymentProblems(plan.filter(p => !wages.some(w => w.key === p.key)), account);
            if (errors.length) fail('failed-precondition', errors.join('; '));
            if (payments.docs.some(d => d.data().payroll.stage === stage && d.data().source !== 'salaryProject' && d.data().kind === 'salary'
                && wages.some(w => w.personId === d.data().payroll.key) && ['sending', 'unknown', 'sent', 'paid'].includes(d.data().status))) fail('failed-precondition', 'Етап уже має платежі іншого способу');
            const project = { packetName: `ОСББ ${finance.data()?.edrpou} ${period} ${stage} ${createHash('sha256').update(runRef.path + stage).digest('hex').slice(0, 8)}`,
                group, system: 'maspay', added: {}, ...old?.project };
            if (project.status === 'unknown' && !reference) fail('failed-precondition', 'Результат запиту невідомий. Голова має звірити відомість у Приват24 та ввести її референс');
            if (reference) project.reference = String(reference).trim();
            t.update(runRef, { sending: { attempt, at: new Date().toISOString() }, [`stages.${stage}`]: { ...old, plan, account, complete: false, project },
                ...(stage === 'advance' ? { paidAdvance: Object.fromEntries(stored.run.rows.map(r => [r.personId, r.advance])) } : {}) });
            return { project, wages, plan, account, old };
        });
        let changed = false;
        try {
            const currentReceivers = await api.receivers(secret, group);
            if (work.wages.some(w => !currentReceivers.some(r => String(r.id) === w.receiverId && String(r.inn) === w.recipient.code && String(r.tabn) === w.tabn))) fail('failed-precondition', 'Дані отримувачів змінилися в банку. Оновіть список і звʼязки працівників');
            if (!work.project.reference) {
                changed = true;
                const created = await api.create(secret, group, work.project.packetName);
                if (!created.reference || created.system && created.system !== 'maspay') throw new Error('Банк не підтвердив референс maspay');
                work.project.reference = String(created.reference);
                await runRef.update({ [`stages.${stage}.project`]: work.project });
                changed = false;
            }
            const header = await api.header(secret, work.project.reference);
            if (header.system && header.system !== 'maspay' || header.group && header.group !== group || header.packetName !== work.project.packetName) fail('failed-precondition', 'Це інша відомість або інша підсистема банку');
            const rows = await api.content(secret, work.project.reference);
            const added = {};
            for (const r of rows) {
                const matches = work.wages.filter(w => w.tabn === String(r.tabNo) && w.recipient.code === String(r.inn) && w.amountKop === api.amountKop(r) && w.purpose === r.comment);
                if (matches.length !== 1 || added[matches[0].key]) fail('failed-precondition', 'Відомість банку містить зайві, змінені або дубльовані виплати. Звірте її вручну в Приват24');
                added[matches[0].key] = String(r.ref);
            }
            work.project.added = added;
            const remaining = work.wages.filter(w => !added[w.key]);
            if (remaining.length && !['N', 'W'].includes(header.status)) fail('failed-precondition', 'Відомість банку вже на підписі чи в обробці; склад змінювати не можна');
            let addedNow = 0;
            for (const wage of remaining.slice(0, 25)) {
                changed = true;
                const result = await api.add(secret, work.project.reference, wage.receiverId, wage.purpose, wage.amountKop);
                if (!result.ref) throw new Error('Банк не підтвердив додавання отримувача');
                work.project.added[wage.key] = String(result.ref);
                await runRef.update({ [`stages.${stage}.project`]: work.project });
                changed = false;
                addedNow++;
            }
            const prepared = work.wages.every(w => work.project.added[w.key]);
            let bankStatus = header.status;
            // Додавання повертає перевірену відомість у «створена» — тоді перевірку запускаємо знову.
            if (prepared && (header.status === 'N' || addedNow)) {
                changed = true;
                bankStatus = String((await api.validate(secret, work.project.reference))?.status || 'P');
                changed = false;
            }
            work.project.status = prepared ? 'prepared' : 'building';
            work.project.bankStatus = bankStatus;
            work.project.bankSubstatus = '';
            work.project.revision = header.revision || null;
            delete work.project.error;
            // Чернетка є в банку: запис у платежах лише очікує фактичного списання з виписки.
            const batch = db.batch();
            const completed = { ...(work.old?.completed || {}) }, paymentIds = [...(work.old?.payments || [])];
            for (const w of work.wages.filter(w => work.project.added[w.key])) {
                const proposalKey = `payroll:${period}:${w.key}`, id = `project-${createHash('sha256').update(proposalKey).digest('hex').slice(0, 32)}`;
                const ref = db.doc(`payments/${id}`), old = (await ref.get()).data();
                if (!old) batch.create(ref, { kind: 'salary', recipient: w.recipient, account: work.account, amountKop: w.amountKop, purpose: w.purpose, proposalKey,
                    payroll: { period, stage, ...identity.planRecipient(w) }, status: 'sent', source: 'salaryProject', projectRef: work.project.reference, projectRowRef: work.project.added[w.key],
                    bankRef: null, sentAt: FieldValue.serverTimestamp(), createdAt: FieldValue.serverTimestamp(), createdBy: actor });
                completed[w.key] = id; if (!paymentIds.includes(id)) paymentIds.push(id);
            }
            batch.update(runRef, { [`stages.${stage}.project`]: work.project, [`stages.${stage}.completed`]: completed, [`stages.${stage}.payments`]: paymentIds, sending: FieldValue.delete() });
            await batch.commit();
            await db.collection('audit_log').add({ actor, role, action: 'payroll.project.prepare', target: runRef.path,
                summary: 'Відомість зарплатного проекту підготовлена; підпис у Приват24', details: { stage, group, reference: work.project.reference, prepared }, at: FieldValue.serverTimestamp() });
            return { ok: true, prepared, reference: work.project.reference, added: Object.keys(work.project.added).length, total: work.wages.length, bankStatus };
        } catch (e) {
            await runRef.update({ [`stages.${stage}.project`]: { ...work.project, status: changed && e.bankRejected !== true ? 'unknown' : 'building', error: String(e.message).slice(0, 300) }, sending: FieldValue.delete() });
            throw e;
        }
    }
    return { context, linkReceiver, autoLink, enroll, packets, prepare, find, status, sandboxStep };
};
