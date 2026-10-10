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
const dps = require('./dps-xml');
const STI = require('./dps/sti.json');

const REGION = 'europe-central2';
const FILE_KINDS = { report: 'звіт', receipt1: 'квитанція № 1', receipt2: 'квитанція № 2', other: 'інше' };
// Одеська ДПІ ГУ ДПС в Одеській області — типова податкова ОСББ (код 1553).
const DEFAULT_STI = 1553;
const XML_FIELDS = { katottg: 19, zip: 5, address: 250, phone: 40, email: 80, headName: 120, headTin: 10, accName: 120, accTin: 10 };

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
            if (p.status === 'paid' && Number.isSafeInteger(p.amountKop) && p.amountKop > 0) esv.set(p.payroll.period, (esv.get(p.payroll.period) || 0) + p.amountKop - (p.returnedKop || 0));
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
            payments: pays.docs.map(d => ({ stage: d.data().payroll?.stage, key: d.data().payroll?.key, status: d.data().status, amountKop: d.data().amountKop - (d.data().returnedKop || 0) }))
        });
        const settings = (await db.doc('osbb_settings/finance').get()).data() || {};
        return { ...report, key: core.keyFor('j0500111', period), edrpou: settings.edrpou || '', saved: saved.exists ? plain(saved) : null };
    }

    // ------------------------------------------------------------
    // XML ДЛЯ ЕЛЕКТРОННОГО КАБІНЕТУ
    // report_settings/main — реквізити звіту, яких немає в публічних
    // osbb_settings: РНОКПП керівника й бухгалтера, КАТОТТГ, податкова.
    // Пише лише сервер; читає бухгалтер і голова (правило Firestore).
    // ------------------------------------------------------------
    async function xmlSettings() {
        const [own, fin] = await Promise.all([db.doc('report_settings/main').get(), db.doc('osbb_settings/finance').get()]);
        const reg = fin.data()?.registry || {};
        const saved = own.data() || {};
        // Підказки з витягу ЄДР: індекс і адреса без «Україна, 65101,».
        const legal = String(reg.legalAddress || '');
        const zip = (legal.match(/\b(\d{5})\b/) || [])[1] || '';
        const address = legal.replace(/^Україна,\s*/i, '').replace(/^\d{5},\s*/, '');
        const value = { sti: DEFAULT_STI, zip, address, ...Object.fromEntries(Object.keys(XML_FIELDS).map(k => [k, saved[k] ?? ''])) };
        if (!saved.zip) value.zip = zip;
        if (!saved.address) value.address = address;
        if (saved.sti) value.sti = saved.sti;
        return { settings: value, saved: own.exists, offices: STI.map(x => ({ code: x.sti, name: x.name })),
            org: { name: reg.legalName || '', edrpou: fin.data()?.edrpou || reg.code || '', kved: reg.kved || '' } };
    }

    async function saveXmlSettings(actor, role, data) {
        const v = Object.fromEntries(Object.entries(XML_FIELDS).map(([k, max]) => [k, text(data?.[k], max)]));
        v.katottg = v.katottg.toUpperCase();
        v.sti = Number(data?.sti);
        if (!STI.some(x => x.sti === v.sti)) fail('invalid-argument', 'Оберіть податкову зі списку');
        if (v.katottg && !/^UA\d{17}$/.test(v.katottg)) fail('invalid-argument', 'КАТОТТГ — UA і 17 цифр');
        if (v.zip && !/^\d{5}$/.test(v.zip)) fail('invalid-argument', 'Поштовий індекс — 5 цифр');
        for (const k of ['headTin', 'accTin']) if (v[k] && !/^\d{10}$/.test(v[k])) fail('invalid-argument', 'РНОКПП — 10 цифр');
        await db.doc('report_settings/main').set({ ...v, updatedBy: actor, updatedAt: FieldValue.serverTimestamp() });
        // РНОКПП і імена в журнал не пишемо — лише факт зміни.
        await audit(actor, role, 'reports.settings', 'report_settings/main', 'Реквізити звітів для ДПС збережено', { sti: v.sti, katottg: v.katottg });
        return { ok: true };
    }

    /** Пакет XML (розрахунок + Д1, 4ДФ, Д5) з затвердженої відомості; файли — base64 у windows-1251. */
    async function xml(actor, role, { period, stan, num }) {
        if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(String(period || ''))) fail('invalid-argument', 'Невідомий місяць');
        if (period < START_PERIOD) fail('failed-precondition', 'Звіти до початку обліку в застосунку подає сервіс бухгалтера');
        const kind = [1, 2, 3].includes(Number(stan)) ? Number(stan) : 1;
        const number = Math.max(1, Math.min(9999, Math.round(Number(num) || 1)));
        const [run, people, pays, cfg] = await Promise.all([
            db.doc(`payroll_runs/${period}`).get(),
            db.collection('payroll_people').get(),
            db.collection('payments').where('payroll.period', '==', period).get(),
            xmlSettings()
        ]);
        const stored = run.exists ? run.data() : null;
        const cards = new Map(people.docs.map(d => [d.id, { id: d.id, ...d.data() }]));
        const report = core.payrollReport({
            period, stored, people: cards,
            payments: pays.docs.map(d => ({ stage: d.data().payroll?.stage, key: d.data().payroll?.key, status: d.data().status, amountKop: d.data().amountKop - (d.data().returnedKop || 0) }))
        });
        const s = cfg.settings;
        const office = STI.find(x => x.sti === Number(s.sti));
        const org = { ...cfg.org, ...s, sti: office ? { reg: office.reg, raj: office.raj, code: office.sti, name: office.name } : null };
        const out = dps.buildPackage({ period, org, report, run: stored?.run, people: cards, fillDate: today(), num: number, stan: kind });
        if (out.problems.length) return { files: [], problems: out.problems };
        await audit(actor, role, 'reports.xml', `reports/${core.keyFor('j0500111', period)}`, `XML розрахунку за ${period}: ${out.files.length} файл.`, { stan: kind, num: number });
        return { problems: [], totals: out.totals, files: out.files.map(f => ({ name: f.name, data: dps.encode1251(f.xml).toString('base64') })) };
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
            case 'xmlSettings': return xmlSettings();
            case 'saveXmlSettings': return saveXmlSettings(actor, role, data);
            case 'xml': return xml(actor, role, data);
            default: fail('invalid-argument', 'Невідома дія');
        }
    }));

    return { reportsAction, actions: { context, payrollData, mark, xmlSettings, saveXmlSettings, xml } };
};
