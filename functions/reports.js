'use strict';
// ============================================================
// Звітність (частина 9): строки, готові дані для форм ДПС, позначки
// «подано / прийнято» й архів квитанцій.
//
// reports/{ключ календаря}: { key, status: submitted|accepted|rejected|
//   not_required|paid, regNumber, date, note, files: [{ name, path, kind }],
//   by, at }. Ключі — як у js/tax-calendar.js (j0500111-2026-10, npo-2026…).
// Файли (квитанції, XML, PDF) — у Storage reports/{ключ}/…; у базу їх
// записує сервер. Нічого не видаляється: зміна статусу лишає слід у
// журналі дій.
// ============================================================
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const callGuard = require('./call-guard');
const core = require('./reports-core');
const { START_PERIOD } = require('./journal-core');
const { validDate } = require('./expenses-core');

const REGION = 'europe-central2';
const FILE_KINDS = { report: 'звіт', receipt1: 'квитанція № 1', receipt2: 'квитанція № 2', other: 'інше' };

module.exports = function reportFunctions({ db, FieldValue, requireAdmin, staffRole }) {
    const fail = (code, message) => { throw new HttpsError(code, message); };
    const text = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
    const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Kyiv' }).format(new Date());

    async function audit(actor, role, action, target, summary, details = {}) {
        await db.collection('audit_log').add({ actor, role, action, target, summary: String(summary).slice(0, 300),
            details: JSON.parse(JSON.stringify(details)), at: FieldValue.serverTimestamp() });
    }

    const plain = d => {
        const r = d.data();
        return { key: d.id, status: r.status, regNumber: r.regNumber || '', date: r.date || '', note: r.note || '', files: r.files || [],
            by: r.by || null, at: r.at?.toDate?.()?.toISOString() || null };
    };

    /** Стан усіх звітів, місяці зарплати й чи є кому платити (тоді щомісячний розрахунок обовʼязковий). */
    async function context() {
        const [reports, runs, people, esvPaid] = await Promise.all([
            db.collection('reports').get(),
            db.collection('payroll_runs').select('status', 'run.totals').get(),
            db.collection('payroll_people').select('active', 'from', 'to').get(),
            db.collection('payments').where('payroll.key', '==', 'esv').get()
        ]);
        const statuses = Object.fromEntries(reports.docs.map(d => [d.id, plain(d)]));
        // Порівнюємо фактичну суму з усім місячним нарахуванням, а не кількість платежів.
        const esv = new Map();
        for (const d of esvPaid.docs) {
            const p = d.data();
            if (p.status === 'paid' && Number.isSafeInteger(p.amountKop) && p.amountKop > 0) esv.set(p.payroll.period, (esv.get(p.payroll.period) || 0) + p.amountKop);
        }
        for (const run of runs.docs) {
            const period = run.id, expected = run.data().run?.totals?.esvKop || 0;
            const key = core.keyFor('esv', period);
            if (run.data().status === 'approved' && expected > 0 && (esv.get(period) || 0) >= expected && !statuses[key]) statuses[key] = { key, status: 'paid', auto: true, regNumber: '', date: '', note: 'сума проведених платежів покриває місячне нарахування', files: [] };
        }
        return {
            today: today(), start: START_PERIOD, statuses, fileKinds: FILE_KINDS,
            payrollMonths: runs.docs.map(d => ({ period: d.id, status: d.data().status, grossKop: d.data().run?.totals?.grossKop || 0 }))
                .sort((a, b) => b.period.localeCompare(a.period)),
            hasPeople: people.docs.some(d => d.data().active !== false)
        };
    }

    /** Податковий розрахунок за місяць: суми за людьми з затвердженої відомості. */
    async function payrollData({ period }) {
        if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(String(period || ''))) fail('invalid-argument', 'Невідомий місяць');
        const [run, people, pays, saved] = await Promise.all([
            db.doc(`payroll_runs/${period}`).get(),
            db.collection('payroll_people').get(),
            db.collection('payments').where('payroll.period', '==', period).get(),
            db.doc(`reports/${core.keyFor('j0500111', period)}`).get()
        ]);
        const report = core.payrollReport({
            period, stored: run.exists ? run.data() : null,
            people: new Map(people.docs.map(d => [d.id, { id: d.id, ...d.data() }])),
            payments: pays.docs.map(d => ({ stage: d.data().payroll?.stage, key: d.data().payroll?.key, status: d.data().status, amountKop: d.data().amountKop }))
        });
        const settings = (await db.doc('osbb_settings/finance').get()).data() || {};
        return { ...report, key: core.keyFor('j0500111', period), edrpou: settings.edrpou || '', saved: saved.exists ? plain(saved) : null };
    }

    /** Позначка звіту: подано, прийнято (квитанція № 2), відхилено, не потрібно; «open» — зняти позначку. */
    async function mark(actor, role, { key, status, regNumber, date, note, files }) {
        if (!core.validKey(key)) fail('invalid-argument', 'Невідомий звіт');
        const period = core.periodOf(key);
        if (period && period < START_PERIOD) fail('failed-precondition', 'Звіти до початку обліку в застосунку подає сервіс бухгалтера');
        const ref = db.doc(`reports/${key}`);
        if (status === 'open') {
            const before = await db.runTransaction(async t => {
                const snap = await t.get(ref);
                if (!snap.exists) return null;
                if (role !== 'chair' && snap.data().status === 'accepted') fail('permission-denied', 'Позначку прийнятого звіту знімає лише голова');
                t.delete(ref);
                return snap;
            });
            if (!before) return { ok: true };
            await audit(actor, role, 'reports.reopen', `reports/${key}`, `Знято позначку «${core.STATUSES[before.data().status] || before.data().status}»`, { before: before.data() });
            return { ok: true };
        }
        if (!core.STATUSES[status]) fail('invalid-argument', 'Невідомий стан');
        if (status === 'paid' && !key.startsWith('esv-')) fail('invalid-argument', '«Сплачено» — лише для платежів');
        const day = String(date || '') || today();
        if (!validDate(day) || day > today()) fail('invalid-argument', 'Вкажіть правильну дату подання — не пізніше сьогодні');
        if (files !== undefined && (!Array.isArray(files) || files.length > 12)) fail('invalid-argument', 'Додайте не більше 12 файлів');
        const list = (Array.isArray(files) ? files : []).map(f => ({
            name: text(f?.name, 120), path: String(f?.path || ''), kind: FILE_KINDS[f?.kind] ? f.kind : 'other'
        }));
        for (const f of list) {
            if (!f.path.startsWith(`reports/${key}/`) || f.path.includes('..')) fail('invalid-argument', 'Файл має бути в теці цього звіту');
        }
        const doc = await db.runTransaction(async t => {
            const before = (await t.get(ref)).data();
            if (before?.status === 'accepted' && status !== 'accepted' && role !== 'chair') fail('permission-denied', 'Стан прийнятого звіту змінює лише голова');
            const keptFiles = files === undefined ? before?.files || [] : list;
            const number = regNumber === undefined ? before?.regNumber || '' : text(regNumber, 40);
            if (status === 'accepted' && !keptFiles.some(f => f.kind === 'receipt2') && !number) fail('invalid-argument', 'Для «прийнято» додайте квитанцію № 2 або реєстраційний номер документа');
            const value = { key, status, regNumber: number, date: day, note: note === undefined ? before?.note || '' : text(note, 300), files: keptFiles, by: actor, at: FieldValue.serverTimestamp() };
            t.set(ref, value);
            return value;
        });
        await audit(actor, role, 'reports.mark', `reports/${key}`, `Звіт ${key}: ${core.STATUSES[status]}${doc.regNumber ? `, № ${doc.regNumber}` : ''}`,
            { status, regNumber: doc.regNumber, date: day, files: doc.files.map(f => f.kind) });
        return { ok: true };
    }

    const reportsAction = onCall({ region: REGION, maxInstances: 4, timeoutSeconds: 60 }, callGuard('reportsAction', async request => {
        const actor = await requireAdmin(request, ['chair', 'accountant']);
        const role = await staffRole(actor);
        const data = request.data || {};
        switch (data.action) {
            case 'context': return context();
            case 'payroll': return payrollData(data);
            case 'mark': return mark(actor, role, data);
            default: fail('invalid-argument', 'Невідома дія');
        }
    }));

    return { reportsAction, actions: { context, payrollData, mark } };
};
