'use strict';
// ============================================================
// Демо-прогін бухгалтерії на тестовому акаунті.
//
// Голова натискає «Прогнати демо» — сервер проводить через справжні
// функції системи (ті самі, що викликає кабінет) повний місяць обліку:
// складові внеску й тарифи → вхідні залишки → нарахування за жовтень
// 2026 → постачальники, договори, акти → виписка банку з оплатами
// мешканців, орендою, розміщенням обладнання й списаннями → кошторис
// 2026 → звіт для мешканців. Лишається звичайний слід: історія
// квартир, «Вхідні», журнал дій.
//
// Масштаб цифр — з реального звіту ОСББ за 2026 рік (надходження й
// витрати за статтями, загальний борг 309 815 грн). Прізвища, номери
// квартир боржників і назви справжніх контрагентів у код не потрапляють:
// контрагенти умовні з позначкою «(демо)», борги розподілені випадково.
//
// «Прибрати демо» повертає все як було: стан до прогону зберігається
// в demo/state (площі й баланси квартир, налаштування банку, звіт).
// Прогін можливий лише на «чистому» обліку: без справжньої виписки,
// нарахувань, документів і кошторису — щоб не зачепити реальні дані.
// ============================================================
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const logger = require('firebase-functions/logger');
const { cleanApt, fromKop } = require('./bank-core');

const REGION = 'europe-central2';
const PERIOD = '2026-10';
const DECISION = 'Протокол загальних зборів № 1 від 15.12.2025 (демо)';
const OWN = 'UA213052990000026001234567890';           // поточний рахунок ОСББ (демо)
const RESERVE = 'UA563052990000026005000012345';       // резервний фонд (демо)

// Річні суми з реального звіту ОСББ, копійки.
const YEAR_INCOME = { main: 73244123, light: 12102494, lift: 9856841, waste: 8773868, rent: 4778774, equipment: 17328672 };
const YEAR_SPENT = { upkeep: 53362118, reserve: 27825484, power: 12783088, lift: 9920928, waste: 7700274, salary: 5213151, esv: 1636227, bank: 287000 };
const TOTAL_DEBT_KOP = 30981500;

// ------------------------------------------------------------
// ДЕТЕРМІНОВАНІ ДАНІ
// ------------------------------------------------------------
/** Простий генератор: той самий прогін — ті самі цифри. */
function random(seed) {
    let s = seed >>> 0 || 1;
    return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}

/** ЄДРПОУ з правильною контрольною цифрою (умовний, для демо). */
function edrpou(seven) {
    const d = String(seven).padStart(7, '0').split('').map(Number);
    const n = Number(d.join('')) * 10;
    const base = n < 30000000 || n > 60000000 ? [1, 2, 3, 4, 5, 6, 7] : [7, 1, 2, 3, 4, 5, 6];
    let sum = base.reduce((s, w, i) => s + w * d[i], 0) % 11;
    if (sum === 10) sum = base.map(w => w + 2).reduce((s, w, i) => s + w * d[i], 0) % 11;
    return d.join('') + String(sum === 10 ? 0 : sum);
}

/** РНОКПП з правильною контрольною цифрою (умовний, для демо). */
function rnokpp(nine) {
    const d = String(nine).split('').map(Number);
    const sum = [-1, 5, 7, 9, 4, 6, 10, 5, 7].reduce((s, w, i) => s + w * d[i], 0);
    return d.join('') + String(((sum % 11) + 11) % 11 % 10);
}

/** IBAN України з правильною контрольною сумою (умовний, для демо). */
function iban(account19) {
    const body = `305299${String(account19).padStart(19, '0')}`;
    for (let k = 2; k < 100; k++) {
        const cand = `UA${String(k).padStart(2, '0')}${body}`;
        const digits = (cand.slice(4) + cand.slice(0, 4)).replace(/[A-Z]/g, c => String(c.charCodeAt(0) - 55));
        let rest = 0;
        for (const ch of digits) rest = (rest * 10 + Number(ch)) % 97;
        if (rest === 1) return cand;
    }
    return null;
}

const SUPPLIERS = [
    { key: 'lift', name: 'ТОВ «Ліфт-Сервіс» (демо)', kind: 'company', code: edrpou('3911101'), iban: iban('2600100000000001'), item: 'lift', monthlyKop: Math.round(YEAR_SPENT.lift / 12), subject: 'Технічне обслуговування ліфтів' },
    { key: 'waste', name: 'ТОВ «Еко-Вивіз» (демо)', kind: 'company', code: edrpou('4022202'), iban: iban('2600100000000002'), item: 'waste', monthlyKop: Math.round(YEAR_SPENT.waste / 12), subject: 'Вивезення побутових відходів' },
    { key: 'power', name: 'ТОВ «Енергозбут» (демо)', kind: 'company', code: edrpou('4133303'), iban: iban('2600100000000003'), item: 'power', monthlyKop: Math.round(YEAR_SPENT.power / 12), subject: 'Електроенергія місць загального користування' },
    { key: 'clean', name: 'ФОП Прибиральник І. І. (демо)', kind: 'fop', code: rnokpp('312456780'), iban: iban('2600100000000004'), item: 'cleaning', monthlyKop: 1500000, subject: 'Прибирання підʼїздів і прибудинкової території', fopChecked: true },
    { key: 'water', name: 'Водоканал (демо)', kind: 'company', code: edrpou('0300404'), iban: iban('2600100000000005'), item: 'water' },
    { key: 'roof', name: 'ТОВ «Дах-Сервіс» (демо)', kind: 'company', code: edrpou('4244405'), iban: iban('2600100000000006'), item: 'repair' }
];

module.exports = function demoFunctions({ db, FieldValue, Timestamp, requireAdmin, staffRole, charges, bank, expenses, budget }) {
    const stateRef = db.doc('demo/state');
    const fail = (code, message) => { throw new HttpsError(code, message); };

    async function audit(actor, role, action, summary, details = {}) {
        await db.collection('audit_log').add({ actor, role, action, target: 'demo/state', summary, details, at: FieldValue.serverTimestamp() });
    }

    /** Що заважає прогону: лише «чистий» облік, щоб не зачепити реальні дані. */
    async function blockers() {
        const [state, tx, runs, ex, bud, chargeSettings] = await Promise.all([
            stateRef.get(), db.collection('bank_tx').limit(1).get(), db.collection('charges_runs').limit(1).get(),
            db.collection('expenses').limit(1).get(), db.collection('budgets').limit(1).get(), db.doc('charges/settings').get()
        ]);
        const out = [];
        if (state.exists && state.data().status === 'done') out.push('демо вже прогнано — спершу приберіть його');
        if (!tx.empty) out.push('у банку вже є операції');
        if (!runs.empty || chargeSettings.data()?.opening?.set) out.push('вже є нарахування або вхідні залишки');
        if (!ex.empty) out.push('вже є документи витрат');
        if (!bud.empty) out.push('вже є кошторис');
        return out;
    }

    async function status() {
        const snap = await stateRef.get();
        const s = snap.exists ? snap.data() : null;
        return { status: s?.status || 'none', steps: s?.steps || [], summary: s?.summary || null,
            at: s?.at?.toDate?.()?.toISOString() || null, blockers: s?.status === 'done' ? [] : await blockers() };
    }

    // --------------------------------------------------------
    // ПРОГІН
    // --------------------------------------------------------
    async function run(actor) {
        const blocked = await blockers();
        if (blocked.length) fail('failed-precondition', `Демо лише для чистого тестового обліку: ${blocked.join('; ')}`);
        const steps = [];
        const step = text => { steps.push(text); logger.info('Демо:', text); };
        const created = { suppliers: [], contracts: [], expenses: [] };

        // Бухгалтер для дій бухгалтера — справжній, якщо є в команді.
        const acc = await db.collection('staff').where('role', '==', 'accountant').where('active', '==', true).limit(1).get();
        const A = acc.empty ? [actor, 'chair'] : [acc.docs[0].id, 'accountant'];
        const C = [actor, 'chair'];

        // 0. Стан до прогону — для «Прибрати демо».
        const aptSnap = await db.collection('apartments').get();
        const apts = aptSnap.docs.filter(d => d.data().isAdmin !== true);
        if (apts.length < 10) fail('failed-precondition', 'У довіднику менше 10 квартир — спершу імпортуйте квартири');
        const [bankSettings, financeCurrent, chargeSettings] = await Promise.all([db.doc('bank/settings').get(), db.doc('finance/current').get(), db.doc('charges/settings').get()]);
        const backup = {};
        apts.forEach(d => { const a = d.data(); backup[d.id] = { balance: a.balance ?? null, area: a.area ?? null, balanceSource: a.balanceSource ?? null }; });
        await stateRef.set({ status: 'running', by: actor, at: FieldValue.serverTimestamp(), backup,
            bankSettings: bankSettings.exists ? bankSettings.data() : null, financeCurrent: financeCurrent.exists ? financeCurrent.data() : null,
            chargeSettings: chargeSettings.exists ? chargeSettings.data() : null, created, steps: [] });

        const rnd = random(apts.length * 7919);
        // 1. Площі: де немає — умовні 38–95 м² (у тестовому довіднику їх часто нема).
        let batch = db.batch(), ops = 0, filled = 0;
        const areaCenti = new Map();
        for (const d of apts) {
            const a = String(d.data().area ?? '').replace(',', '.');
            let centi = Math.round(Number(a) * 100);
            if (!(centi > 0)) {
                centi = Math.round((38 + rnd() * 57) * 10) * 10;
                batch.update(d.ref, { area: centi / 100 });
                filled += 1;
                if (++ops >= 400) { await batch.commit(); batch = db.batch(); ops = 0; }
            }
            areaCenti.set(d.id, centi);
        }
        if (ops) await batch.commit();
        const totalArea = [...areaCenti.values()].reduce((s, v) => s + v, 0) / 100;
        step(`Квартир: ${apts.length}, загальна площа ${totalArea.toFixed(1)} м²${filled ? ` (умовну площу внесено ${filled} квартирам без площі)` : ''}`);

        // 2. Рахунки ОСББ (демо): поточний і резервний фонд.
        await db.doc('bank/settings').set({ demo: true, startDate: '2026-10-01', tokenSet: false,
            accounts: { [OWN]: { purpose: 'current', currency: 'UAH', balanceKop: 12845000, balanceAt: Timestamp.now(), name: 'ОСББ (демо)' },
                [RESERVE]: { purpose: 'reserve', currency: 'UAH', balanceKop: 31520000, balanceAt: Timestamp.now(), name: 'ОСББ резервний фонд (демо)' } } }, { merge: true });
        step('Рахунки ОСББ (демо): поточний 128 450,00 грн, резервний фонд 315 200,00 грн');

        // 3. Складові внеску й тарифи: річні надходження зі звіту / 12 / площа.
        const ids = {};
        for (const [key, name, base, item] of [['light', 'Освітлення МЗК', 'area', 'power'], ['lift', 'Ліфти', 'area', 'lift'], ['waste', 'Вивезення ТПВ', 'fixed', 'waste']]) {
            ids[key] = (await charges.actions.addComponent(...A, { name, base, item })).id;
        }
        const perM2 = kop => (Math.round(kop / 12 / totalArea) / 100).toFixed(2);
        const rates = { main: perM2(YEAR_INCOME.main), light: perM2(YEAR_INCOME.light), lift: perM2(YEAR_INCOME.lift),
            waste: (Math.round(YEAR_INCOME.waste / 12 / apts.length) / 100).toFixed(2) };
        await charges.actions.addTariff(...A, { component: 'main', group: 'res', rate: rates.main, from: PERIOD, decision: DECISION });
        for (const key of ['light', 'lift', 'waste']) await charges.actions.addTariff(...A, { component: ids[key], group: 'res', rate: rates[key], from: PERIOD, decision: DECISION });
        step(`Тарифи з жовтня 2026: утримання ${rates.main} грн/м², освітлення МЗК ${rates.light} грн/м², ліфти ${rates.lift} грн/м², вивезення ТПВ ${rates.waste} грн з квартири`);

        // 4. Вхідні залишки на 30.09.2026. Де баланс уже внесено (напр. з акта
        //    звірки сервісу бухгалтера) — беремо його; решті — борги ~45 %
        //    квартир і переплати ~8 % у масштабі реального звіту.
        const opening = [];
        const known = apts.filter(d => Number(d.data().balance));
        known.forEach(d => opening.push({ apt: cleanApt(d.id), amountKop: Math.round(Number(d.data().balance) * 100) }));
        const rest = apts.filter(d => !known.includes(d));
        const debtors = rest.filter(() => rnd() < 0.45);
        const weights = debtors.map(() => 0.2 + rnd() ** 3 * 6);
        const wsum = weights.reduce((s, w) => s + w, 0) || 1;
        const knownDebt = -opening.reduce((s, r) => s + Math.min(0, r.amountKop), 0);
        const openingDebt = Math.max(0, TOTAL_DEBT_KOP - 1000000 - knownDebt);   // після жовтня борг вийде близько 309 815 грн
        debtors.forEach((d, i) => opening.push({ apt: cleanApt(d.id), amountKop: -Math.round(openingDebt * weights[i] / wsum) }));
        rest.filter(d => !debtors.includes(d) && rnd() < 0.15).forEach(d => opening.push({ apt: cleanApt(d.id), amountKop: Math.round((50 + rnd() * 550) * 100) }));
        await charges.actions.setOpening(...A, { rows: opening });
        step(`Вхідні залишки на 30.09.2026: борг ${fromKop(-opening.filter(r => r.amountKop < 0).reduce((s, r) => s + r.amountKop, 0)).toLocaleString('uk-UA')} грн у ${opening.filter(r => r.amountKop < 0).length} кв., переплата в ${opening.filter(r => r.amountKop > 0).length} кв.${known.length ? ` (з уже внесених балансів: ${known.length} кв.)` : ''}`);

        // 5. Нарахування за жовтень.
        const preview = (await charges.actions.context()).preview;
        const charged = await charges.actions.run(...A, { period: PERIOD, expectTotalKop: preview.totalKop });
        step(`Нараховано за жовтень 2026: ${charged.count} кв., ${fromKop(charged.totalKop).toLocaleString('uk-UA')} грн`);

        // 6. Постачальники, договори, акти за вересень, поріг дрібних витрат.
        const sid = {};
        for (const s of SUPPLIERS) {
            sid[s.key] = (await expenses.actions.saveSupplier(...A, { name: s.name, kind: s.kind, code: s.code, iban: s.iban, fopChecked: Boolean(s.fopChecked) })).id;
            created.suppliers.push(sid[s.key]);
        }
        const cid = {};
        for (const s of SUPPLIERS.filter(x => x.monthlyKop)) {
            const r = await expenses.actions.saveContract(...C, { supplierId: sid[s.key], number: `${s.key.toUpperCase()}-2026`, date: '2025-12-20', subject: s.subject,
                type: 'monthly', monthlyKop: s.monthlyKop, validFrom: '2026-01-01', validTo: '2026-12-31', item: s.item, meetingDecision: DECISION, files: [] });
            cid[s.key] = r.id;
            created.contracts.push(r.id);
        }
        // Акти за вересень — за договорами, у межах суми: затверджує бухгалтер. За вивезення — акта ще немає (нагадування).
        const docs = {};
        for (const s of SUPPLIERS.filter(x => x.monthlyKop && x.key !== 'waste')) {
            const r = await expenses.actions.saveExpense(...A, { supplierId: sid[s.key], contractId: cid[s.key], docType: 'act', number: `${s.key.toUpperCase()}-09`,
                date: '2026-09-30', amountKop: s.monthlyKop, period: '2026-09', item: s.item, description: `${s.subject} за вересень 2026`, files: [] });
            docs[s.key] = r.id;
            created.expenses.push(r.id);
        }
        // Без договору: рахунок водоканалу затверджує голова одразу; ремонт даху — чекає голову.
        const water = await expenses.actions.saveExpense(...A, { supplierId: sid.water, docType: 'invoice', number: 'В-1002', date: '2026-09-29', amountKop: 114452,
            period: '2026-09', item: 'water', description: 'Водопостачання МЗК за вересень 2026', files: [] });
        created.expenses.push(water.id);
        if (water.status === 'pending') await expenses.actions.decideExpense(...C, { id: water.id, approve: true });
        const roof = await expenses.actions.saveExpense(...A, { supplierId: sid.roof, docType: 'act', number: 'Д-17', date: '2026-09-30', amountKop: 279400,
            period: '2026-09', item: 'repair', description: 'Ремонт покрівлі над підʼїздом 2', files: [] });
        created.expenses.push(roof.id);
        await stateRef.set({ created }, { merge: true });
        step(`Постачальники: ${SUPPLIERS.length}; договори: ${created.contracts.length} (понад 50 000 грн — з протоколом зборів); акти й рахунки: ${created.expenses.length}, один чекає голову`);

        // 7. Виписка банку за жовтень: оплати мешканців, оренда, обладнання, списання.
        const list = [];
        let n = 0;
        const at = (day, hh = 10) => new Date(Date.UTC(2026, 9, day, hh - 3, Math.floor(rnd() * 59)));
        const push = (day, direction, amountKop, purpose, counterparty, account = OWN) => list.push({ bankId: `DEMO-${++n}`, account, at: at(day, 9 + Math.floor(rnd() * 9)), direction, amountKop, purpose, counterparty, currency: 'UAH' });
        const owners = new Map();
        (await db.collectionGroup('owners').get()).forEach(o => { if (o.ref.parent.parent.parent.id === 'apartments' && !owners.has(o.ref.parent.parent.id)) owners.set(o.ref.parent.parent.id, o.data().name || ''); });
        const house = String((await db.doc('osbb_settings/finance').get()).data()?.houseAddress || 'вул. Інглезі, буд. 3, корп. 3').replace(/,?\s*м\.\s*Одеса,?/i, '').trim();
        const runRows = new Map(Object.entries((await db.doc(`charges_runs/${PERIOD}`).get()).data().amounts || {}));
        const payers = apts.filter(() => rnd() < 0.3).slice(0, 90);
        payers.forEach((d, i) => {
            const apt = cleanApt(d.id);
            const pa = String(d.data().personalAccount || '').trim();
            const base = runRows.get(apt) || 30000;
            const amount = rnd() < 0.15 ? base * 3 : rnd() < 0.2 ? Math.round(base * (0.5 + rnd() * 0.4)) : base;
            const name = owners.get(d.id) || 'ПЛАТНИК';
            const day = 1 + Math.floor(rnd() * 9);
            const kind = i % 10;
            // Як пишуть мешканці «як прийдеться»: більшість система розносить сама, решта — у «Вхідні».
            const purpose = kind < 3 && pa ? `О/р ${pa.padStart(11, '0')}, м. Одеса, ${house}, кв. ${d.id}, від ${name}, за комунальні послуги`
                : kind < 6 ? `Внески ОСББ кв. ${d.id}, жовтень 2026`
                : kind === 6 ? (pa ? `о/р ${pa} утримання будинку` : `кв.${d.id} утримання`)
                : kind === 7 ? 'Оплата за жовтень'
                : kind === 8 ? `${d.id}`
                : 'Поповнення';
            push(day, 'in', amount, purpose, { name: name.toUpperCase(), account: '', code: '' });
        });
        const two = apts.slice(3, 5);
        if (two.length === 2) push(6, 'in', (runRows.get(cleanApt(two[0].id)) || 30000) + (runRows.get(cleanApt(two[1].id)) || 30000),
            `оплата кв ${two[0].id} та кв ${two[1].id} за жовтень`, { name: (owners.get(two[0].id) || 'ПЛАТНИК').toUpperCase(), account: '', code: '' });
        // Оренда комор мешканцями — дохід за договором, не внесок квартири.
        [7000, 80000, 50000, 36000, 120000].forEach((kop, i) => {
            const d = apts[(i * 37 + 11) % apts.length];
            push(2 + i, 'in', kop, `Оренда нежитлового приміщення по договору, кв. ${d.id}`, { name: (owners.get(d.id) || 'ПЛАТНИК').toUpperCase(), account: '', code: '' });
        });
        push(5, 'in', Math.round(YEAR_INCOME.equipment / 12), 'Плата за розміщення обладнання звʼязку за жовтень 2026 згідно з договором',
            { name: 'ТОВ «ТЕЛЕКОМ-СЕРВІС» (ДЕМО)', account: iban('2600100000000099'), code: edrpou('3655507') });
        // Списання: оплата актів за вересень (система сама закриє документи), водоканал, дах, банк, зарплата, ЄСВ, резервний фонд.
        for (const s of SUPPLIERS.filter(x => docs[x.key])) {
            push(3, 'out', s.monthlyKop, `Оплата за актом № ${s.key.toUpperCase()}-09 від 30.09.2026, ${s.subject} за вересень 2026, без ПДВ`, { name: s.name.toUpperCase(), account: s.iban, code: s.code });
        }
        push(2, 'out', 114452, 'Оплата за рахунком № В-1002 від 29.09.2026, водопостачання МЗК', { name: 'ВОДОКАНАЛ (ДЕМО)', account: SUPPLIERS[4].iban, code: SUPPLIERS[4].code });
        push(1, 'out', 279400, 'Оплата за ремонт покрівлі', { name: 'ТОВ «ДАХ-СЕРВІС» (ДЕМО)', account: SUPPLIERS[5].iban, code: SUPPLIERS[5].code });
        push(6, 'out', Math.round(YEAR_SPENT.bank / 9), 'Комісія за обслуговування рахунку за вересень 2026', { name: 'АТ КБ «ПРИВАТБАНК»', account: '', code: '14360570' });
        push(7, 'out', Math.round(YEAR_SPENT.salary / 12), 'Заробітна плата за вересень 2026', { name: 'ПРАЦІВНИК ОСББ (ДЕМО)', account: iban('2600100000000077'), code: '' });
        push(7, 'out', Math.round(YEAR_SPENT.esv / 12), '*;101;ЄСВ за вересень 2026', { name: 'ГУ ДПС (ДЕМО)', account: iban('2600100000000078'), code: '' });
        push(8, 'out', Math.round(YEAR_SPENT.reserve / 12), 'Переказ до резервного фонду за жовтень 2026', { name: 'ОСББ', account: RESERVE, code: '' });
        const stored = await bank.storeTransactions(list, 'demo', await bank.loadContext());
        const queue = (await db.collection('bank_tx').where('source', '==', 'demo').where('status', '==', 'review').get()).size;
        step(`Виписка за жовтень: ${stored.added} операцій, оплат мешканців рознесено автоматично: ${stored.matched}; чекають рішення у «Вхідних»: ${queue}`);

        // 8. Кошторис 2026 за річним звітом і затвердження зборами.
        const k = (v, round = 100000) => Math.ceil(v / round) * round;
        const lines = [
            { item: 'cleaning', title: 'Прибирання', planKop: k(YEAR_SPENT.upkeep * 0.35) },
            { item: 'systems', title: 'Обслуговування інженерних систем', planKop: k(YEAR_SPENT.upkeep * 0.25) },
            { item: 'repair', title: 'Поточний ремонт', planKop: k(YEAR_SPENT.upkeep * 0.25) },
            { item: 'services', title: 'Бухгалтерські й юридичні послуги', planKop: k(YEAR_SPENT.upkeep * 0.15) },
            { item: 'power', title: 'Освітлення МЗК', planKop: k(YEAR_SPENT.power) },
            { item: 'water', title: 'Вода МЗК', planKop: 1500000 },
            { item: 'lift', title: 'Ліфти', planKop: k(YEAR_SPENT.lift) },
            { item: 'waste', title: 'Вивезення побутових відходів', planKop: k(YEAR_SPENT.waste) },
            { item: 'salary', title: 'Зарплата, податки й ЄСВ', planKop: k(YEAR_SPENT.salary + YEAR_SPENT.esv) },
            { item: 'bank', title: 'Комісія банку', planKop: k(YEAR_SPENT.bank) },
            { item: 'reserve', title: 'Резервний фонд', planKop: k(YEAR_SPENT.reserve) }
        ];
        const income = [
            { source: 'contributions', planKop: k(YEAR_INCOME.main + YEAR_INCOME.light + YEAR_INCOME.lift + YEAR_INCOME.waste) },
            { source: 'rent', planKop: k(YEAR_INCOME.rent) }, { source: 'equipment', planKop: k(YEAR_INCOME.equipment) }
        ];
        await budget.actions.save(...A, { year: '2026', lines, income, note: 'Демо: за річним звітом ОСББ' });
        await budget.actions.approve(...C, { year: '2026', decision: DECISION, files: [] });
        step(`Кошторис 2026 затверджено (демо): витрати ${fromKop(lines.reduce((s, l) => s + l.planKop, 0)).toLocaleString('uk-UA')} грн, надходження ${fromKop(income.reduce((s, l) => s + l.planKop, 0)).toLocaleString('uk-UA')} грн`);

        // 9. Звіт для мешканців.
        await budget.actions.publish(...A, { year: '2026' });
        const pub = (await db.doc('finance/current').get()).data();
        step(`«Фінанси будинку» для мешканців опубліковано: борг будинку ${fromKop(pub.debt.totalKop).toLocaleString('uk-UA')} грн (${pub.debt.count} кв.) — без прізвищ і номерів`);

        const summary = { apartments: apts.length, chargedKop: charged.totalKop, transactions: stored.added, matched: stored.matched, queue, debtKop: pub.debt.totalKop };
        await stateRef.set({ status: 'done', steps, summary, created, components: Object.values(ids), at: FieldValue.serverTimestamp() }, { merge: true });
        await audit(actor, 'chair', 'demo.run', `Демо-прогін бухгалтерії: ${steps.length} кроків`, summary);
        return { ok: true, steps, summary };
    }

    // --------------------------------------------------------
    // ПРИБРАТИ
    // --------------------------------------------------------
    async function deleteAll(query) {
        let removed = 0;
        for (;;) {
            const snap = await query.limit(300).get();
            if (snap.empty) return removed;
            const batch = db.batch();
            snap.docs.forEach(d => batch.delete(d.ref));
            await batch.commit();
            removed += snap.size;
        }
    }

    async function remove(actor) {
        const snap = await stateRef.get();
        if (!snap.exists || !['done', 'running', 'failed'].includes(snap.data().status)) fail('failed-precondition', 'Демо не прогнано');
        const s = snap.data();
        // Історія квартир: оплати з демо-виписки, нарахування, вхідні залишки.
        const demoTx = await db.collection('bank_tx').where('source', '==', 'demo').get();
        let batch = db.batch(), ops = 0;
        const flush = async () => { if (ops) await batch.commit(); batch = db.batch(); ops = 0; };
        for (const d of demoTx.docs) {
            for (const a of d.data().allocations || []) if (a.ledgerId) { batch.delete(db.doc(`apartments/${a.apt}/ledger/${a.ledgerId}`)); if (++ops >= 400) await flush(); }
            batch.delete(d.ref);
            if (++ops >= 400) await flush();
        }
        for (const id of Object.keys(s.backup || {})) {
            batch.delete(db.doc(`apartments/${id}/ledger/charge-${PERIOD}`));
            batch.delete(db.doc(`apartments/${id}/ledger/opening`));
            const b = s.backup[id];
            batch.set(db.doc(`apartments/${id}`), { balance: b.balance, area: b.area, balanceSource: b.balanceSource ?? FieldValue.delete() }, { merge: true });
            if ((ops += 3) >= 390) await flush();
        }
        await flush();
        for (const col of ['suppliers', 'contracts', 'expenses']) for (const id of s.created?.[col] || []) await db.doc(`${col}/${id}`).delete();
        await deleteAll(db.collection('charges_runs'));
        if (s.chargeSettings) await db.doc('charges/settings').set(s.chargeSettings); else await db.doc('charges/settings').delete();
        await db.doc('budgets/2026').delete();
        await db.doc('finance/2026').delete();
        if (s.financeCurrent) await db.doc('finance/current').set(s.financeCurrent); else await db.doc('finance/current').delete();
        if (s.bankSettings) await db.doc('bank/settings').set(s.bankSettings); else await db.doc('bank/settings').delete();
        await stateRef.set({ status: 'removed', removedBy: actor, removedAt: FieldValue.serverTimestamp(), backup: FieldValue.delete(), financeCurrent: FieldValue.delete(),
            bankSettings: FieldValue.delete(), chargeSettings: FieldValue.delete() }, { merge: true });
        await audit(actor, 'chair', 'demo.remove', 'Демо-дані бухгалтерії прибрано, квартири повернуто до попереднього стану', { transactions: demoTx.size });
        return { ok: true };
    }

    const demoAction = onCall({ region: REGION, maxInstances: 1, timeoutSeconds: 540, memory: '512MiB' }, async request => {
        const actor = await requireAdmin(request, ['chair', 'accountant']);
        const role = await staffRole(actor);
        const data = request.data || {};
        if (data.action === 'status') return status();
        // Прогін і прибирання змінюють облік усього будинку — лише голова.
        if (role !== 'chair') fail('permission-denied', 'Демо прогонить і прибирає голова');
        if (data.action === 'run') {
            try { return await run(actor); }
            catch (e) {
                await stateRef.set({ status: 'failed', error: String(e.message || e).slice(0, 300) }, { merge: true }).catch(() => {});
                throw e;
            }
        }
        if (data.action === 'remove') return remove(actor);
        fail('invalid-argument', 'Невідома дія');
    });

    return { demoAction, actions: { run, remove, status } };
};
