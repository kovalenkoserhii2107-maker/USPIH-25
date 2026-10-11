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
//
// report_packages/{ключ}--{версія}: кожне завантаження XML — окрема версія
// пакета, точно ті файли, що отримав бухгалтер: { key, period, version,
// stan, num, hash, totals, files: [{ name, size, sha256, data(base64)}],
// by, at }. Позначка «подано / прийнято» посилається на версію
// (packageId, packageVersion), квитанції — теж. Пише й читає лише сервер.
// ============================================================
const { createHash } = require('node:crypto');
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const callGuard = require('./call-guard');
const core = require('./reports-core');
const { START_PERIOD } = require('./journal-core');
const { validDate } = require('./expenses-core');
const dps = require('./dps-xml');
const STI = require('./dps/sti.json');
const { fopReport } = require('./fop-report-core');
const { kyivDate } = require('./journal-core');

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
            packageId: r.packageId || null, packageVersion: r.packageVersion || null,
            by: r.by || null, at: r.at?.toDate?.()?.toISOString() || null };
    };
    /** Версія пакета без самих файлів — для переліку в кабінеті. */
    const packageInfo = d => {
        const r = d.data();
        return { id: d.id, key: r.key, version: r.version, stan: r.stan, num: r.num, hash: r.hash, by: r.by || null,
            at: r.at?.toDate?.()?.toISOString() || null, files: (r.files || []).map(f => ({ name: f.name, size: f.size, sha256: f.sha256 })) };
    };

    /** Стан усіх звітів, місяці зарплати й чи є кому платити (тоді щомісячний розрахунок обовʼязковий). */
    async function context() {
        const [reports, runs, people, esvPaid, fops, packs] = await Promise.all([
            db.collection('reports').get(),
            db.collection('payroll_runs').select('status', 'run.totals').get(),
            db.collection('payroll_people').select('active', 'from', 'to').get(),
            db.collection('payments').where('payroll.key', '==', 'esv').get(),
            db.collection('suppliers').where('kind', '==', 'fop').limit(1).get(),
            db.collection('report_packages').select('key', 'version', 'stan', 'num', 'hash', 'by', 'at', 'files').get()
        ]);
        // Версії пакетів за звітами, новіші вгорі.
        const packages = {};
        for (const d of packs.docs) (packages[d.data().key] ||= []).push(packageInfo(d));
        for (const list of Object.values(packages)) list.sort((a, b) => b.version - a.version);
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
            today: today(), start: START_PERIOD, statuses, packages, fileKinds: FILE_KINDS,
            payrollMonths: runs.docs.map(d => ({ period: d.id, status: d.data().status, grossKop: d.data().run?.totals?.grossKop || 0 }))
                .sort((a, b) => b.period.localeCompare(a.period)),
            hasPeople: people.docs.some(d => d.data().active !== false), hasFop: !fops.empty
        };
    }

    /** Спільний знімок джерел для таблиць, CSV і XML. */
    async function reportSource(period) {
        const [runs, people, pays, expenses, suppliers, bank] = await Promise.all([
            db.collection('payroll_runs').get(),
            db.collection('payroll_people').get(),
            db.collection('payments').get(),
            db.collection('expenses').get(),
            db.collection('suppliers').get(),
            db.collection('bank_tx').where('period', '>=', START_PERIOD).get()
        ]);
        const stored = runs.docs.find(d => d.id === period)?.data() || null;
        const cards = new Map(people.docs.map(d => [d.id, { id: d.id, ...d.data() }]));
        const runMap = new Map(runs.docs.map(d => [d.id, d.data()]));
        const txs = bank.docs.map(d => ({ id: d.id, ...d.data() })), byTx = new Map(txs.map(t => [t.id, t]));
        const fop = fopReport({ period, expenses: expenses.docs.map(d => ({ id: d.id, ...d.data() })),
            suppliers: new Map(suppliers.docs.map(d => [d.id, { id: d.id, ...d.data() }])), bankTx: txs });
        const checks = [...fop.checks], payments = [];
        // Для виплати старої відомості потрібні також її аванс і податки:
        // інакше остаточний платіж у наступному місяці порівнюється з усією зарплатою.
        const sourcePeriods = new Set([period]);
        for (const d of pays.docs) {
            const p = d.data();
            if (p.payroll?.period && (byTx.get(p.txId)?.period === period || kyivDate(p.paidAt).slice(0, 7) === period
                || (p.returnTxIds || []).some(id => byTx.get(id)?.period === period))) sourcePeriods.add(p.payroll.period);
        }
        for (const d of pays.docs) {
            const p = d.data(), pr = p.payroll;
            if (!pr?.period) continue;
            const tx = byTx.get(p.txId);
            if (!sourcePeriods.has(pr.period)) continue;
            if (p.status === 'paid') {
                if (!tx || tx.direction !== 'out' || tx.status !== 'done' || tx.paymentId !== d.id || tx.amountKop !== p.amountKop) {
                    checks.push({ level: 'block', text: 'Виплата за відомістю не має узгодженого підтвердження випискою — звірте платіж перед 4ДФ' });
                }
                if (!Number.isSafeInteger(p.returnedKop || 0) || (p.returnedKop || 0) < 0 || (p.returnedKop || 0) > p.amountKop) {
                    checks.push({ level: 'block', text: 'Некоректна сума повернення зарплатного/податкового платежу — звірте виписку' });
                }
                if (tx && kyivDate(tx.at).slice(0, 7) !== tx.period) checks.push({ level: 'block', text: 'Місяць банківського платежу не відповідає його даті — звірте виписку' });
                for (const id of p.returnTxIds || []) {
                    const refund = byTx.get(id);
                    if (refund && refund.period !== pr.period && (refund.period === period || pr.period === period)) checks.push({ level: 'block', text: `Повернення виплати за ${pr.period} у ${refund.period}: звірте період коригування 4ДФ в Електронному кабінеті` });
                }
            }
            payments.push({ period: pr.period, stage: pr.stage, key: pr.key, paidOn: kyivDate(tx?.at),
                status: p.status === 'paid' && p.amountKop > 0 && p.returnedKop === p.amountKop ? 'returned' : p.status,
                amountKop: p.amountKop - (p.returnedKop || 0) });
        }
        const report = core.payrollReport({
            period, stored, people: cards, payments, runs: runMap, otherIncome: fop.income
        });
        report.checks.push(...[...new Map(checks.map(c => [c.text, c])).values()]);
        return { stored, cards, report };
    }

    /** Податковий розрахунок за місяць: ті самі суми, що й в XML. */
    async function payrollData({ period }) {
        if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(String(period || ''))) fail('invalid-argument', 'Невідомий місяць');
        const [{ report }, saved] = await Promise.all([reportSource(period), db.doc(`reports/${core.keyFor('j0500111', period)}`).get()]);
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
        const kind = stan === undefined ? 1 : Number(stan);
        const number = num === undefined ? 1 : Number(num);
        const [{ stored, cards, report }, cfg] = await Promise.all([reportSource(period), xmlSettings()]);
        const s = cfg.settings;
        const office = STI.find(x => x.sti === Number(s.sti));
        const org = { ...cfg.org, ...s, sti: office ? { reg: office.reg, raj: office.raj, code: office.sti, name: office.name } : null };
        const out = dps.buildPackage({ period, org, report, run: stored?.run, people: cards, fillDate: today(), num: number, stan: kind });
        if (out.problems.length) return { files: [], problems: out.problems };
        // Кожне завантаження — нова версія пакета: саме ці файли голова підпише й подасть.
        const key = core.keyFor('j0500111', period);
        const files = out.files.map(f => {
            const bytes = dps.encode1251(f.xml);
            return { name: f.name, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), data: bytes.toString('base64') };
        });
        const hash = createHash('sha256').update(files.map(f => `${f.name}:${f.sha256}`).join('\n')).digest('hex');
        const version = (await db.collection('report_packages').where('key', '==', key).count().get()).data().count + 1;
        const ref = db.doc(`report_packages/${key}--${version}`);
        await ref.create({ key, period, version, stan: kind, num: number, hash, totals: out.totals, files, by: actor, at: FieldValue.serverTimestamp() })
            .catch(e => { if (e.code === 6 || /already exists/i.test(e.message)) fail('aborted', 'Пакет щойно сформовано в іншій вкладці — оновіть сторінку'); throw e; });
        await audit(actor, role, 'reports.xml', `reports/${key}`, `XML розрахунку за ${period}: версія ${version}, ${files.length} файл.`, { stan: kind, num: number, version, hash });
        return { problems: [], totals: out.totals, packageId: ref.id, version, hash, files: files.map(f => ({ name: f.name, data: f.data })) };
    }

    /** Повторне завантаження збереженої версії — байт у байт ті самі файли. */
    async function packageFiles({ id }) {
        const snap = await db.doc(`report_packages/${String(id || '').replace(/[^\w-]/g, '')}`).get();
        if (!snap.exists) fail('not-found', 'Версію пакета не знайдено');
        const r = snap.data();
        return { ...packageInfo(snap), files: (r.files || []).map(f => ({ name: f.name, data: f.data })) };
    }

    /** Позначка звіту: подано, прийнято (квитанція № 2), відхилено, не потрібно; «open» — зняти позначку. */
    async function mark(actor, role, { key, status, regNumber, date, note, files, addFiles, seenAt, packageId }) {
        if (!core.validKey(key)) fail('invalid-argument', 'Невідомий звіт');
        const period = core.periodOf(key);
        if (period && period < START_PERIOD) fail('failed-precondition', 'Звіти до початку обліку в застосунку подає сервіс бухгалтера');
        const ref = db.doc(`reports/${key}`);
        if (status === 'open') {
            const before = await db.runTransaction(async t => {
                const snap = await t.get(ref);
                if (!snap.exists) return null;
                if (role !== 'chair' && snap.data().status === 'accepted') fail('permission-denied', 'Позначку прийнятого звіту знімає лише голова');
                if (seenAt !== undefined && seenAt !== (snap.data().at?.toDate?.()?.toISOString() || null)) fail('aborted', 'Позначку змінено в іншій вкладці — оновіть сторінку перед зняттям');
                t.set(db.collection('audit_log').doc(), { actor, role, action: 'reports.reopen', target: `reports/${key}`,
                    summary: `Знято позначку «${core.STATUSES[snap.data().status] || snap.data().status}»`, details: { before: snap.data() }, at: FieldValue.serverTimestamp() });
                t.delete(ref);
                return snap;
            });
            if (!before) return { ok: true };
            return { ok: true };
        }
        if (!core.STATUSES[status]) fail('invalid-argument', 'Невідомий стан');
        if (status === 'paid' && !key.startsWith('esv-')) fail('invalid-argument', '«Сплачено» — лише для платежів');
        if (!core.allowedStatus(key, status)) fail('invalid-argument', 'Цей стан не відповідає виду звіту або платежу');
        const day = String(date || '') || today();
        if (!validDate(day) || day > today()) fail('invalid-argument', 'Вкажіть правильну дату подання — не пізніше сьогодні');
        const incoming = addFiles === undefined ? files : addFiles;
        if (incoming !== undefined && (!Array.isArray(incoming) || incoming.length > 12)) fail('invalid-argument', 'Додайте не більше 12 файлів');
        const list = (Array.isArray(incoming) ? incoming : []).map(f => ({
            name: text(f?.name, 120), path: String(f?.path || ''), kind: FILE_KINDS[f?.kind] ? f.kind : 'other'
        }));
        for (const f of list) {
            if (!f.path.startsWith(`reports/${key}/`) || f.path.includes('..')) fail('invalid-argument', 'Файл має бути в теці цього звіту');
        }
        // Подано / прийнято / відхилено — яку саме версію пакета (типово — останню завантажену).
        let pack = null;
        if (['submitted', 'accepted', 'rejected'].includes(status) && key.startsWith('j0500111-')) {
            const wanted = packageId ? await db.doc(`report_packages/${String(packageId).replace(/[^\w-]/g, '')}`).get() : null;
            if (wanted && (!wanted.exists || wanted.data().key !== key)) fail('invalid-argument', 'Ця версія пакета не належить до цього звіту');
            const latest = wanted ? null : (await db.collection('report_packages').where('key', '==', key).select('version').get()).docs
                .sort((a, b) => b.data().version - a.data().version)[0];
            const d = wanted || latest;
            if (d) pack = { id: d.id, version: d.data().version };
        }
        await db.runTransaction(async t => {
            const before = (await t.get(ref)).data();
            if (before?.status === 'accepted' && status !== 'accepted' && role !== 'chair') fail('permission-denied', 'Стан прийнятого звіту змінює лише голова');
            // Паралельні вкладки доповнюють архів; старий список з клієнта
            // не може затерти квитанцію, яку щойно додали в іншій вкладці.
            const keptFiles = [...new Map([...(before?.files || []), ...list].map(f => [f.path, f])).values()];
            if (keptFiles.length > 12) fail('invalid-argument', 'В архіві вже 12 файлів — нове подання збережіть після зняття позначки головою');
            const number = regNumber === undefined ? before?.regNumber || '' : text(regNumber, 40);
            if (status === 'accepted' && !keptFiles.some(f => f.kind === 'receipt2') && !number) fail('invalid-argument', 'Для «прийнято» додайте квитанцію № 2 або реєстраційний номер документа');
            // Версія лишається тією, яку подали: «прийнято» не перескакує на новішу без явного вибору.
            const linked = packageId ? pack : before?.packageId ? { id: before.packageId, version: before.packageVersion } : pack;
            const tagged = keptFiles.map(f => (list.includes(f) && linked ? { ...f, packageId: linked.id } : f));
            const value = { key, status, regNumber: number, date: day, note: note === undefined ? before?.note || '' : text(note, 300), files: tagged,
                packageId: linked?.id || null, packageVersion: linked?.version || null, by: actor, at: FieldValue.serverTimestamp() };
            t.set(ref, value);
            t.set(db.collection('audit_log').doc(), { actor, role, action: 'reports.mark', target: `reports/${key}`,
                summary: `Звіт ${key}: ${core.STATUSES[status]}${number ? `, № ${number}` : ''}`,
                details: { before: before || null, after: { key, status, regNumber: number, date: day, note: value.note, files: tagged, packageVersion: value.packageVersion } }, at: FieldValue.serverTimestamp() });
            return value;
        });
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
            case 'package': return packageFiles(data);
            default: fail('invalid-argument', 'Невідома дія');
        }
    }));

    return { reportsAction, actions: { context, payrollData, mark, xmlSettings, saveXmlSettings, xml, packageFiles } };
};
