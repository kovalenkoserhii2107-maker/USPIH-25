// Демо-будинок «Злагода-17»: перенос бази й три закриті місяці обліку
// (жовтень–грудень 2025) справжніми серверними модулями — з постачальниками,
// договорами, документами, оплатами за ними, орендою й комісіями банку; потім
// поточний місяць (січень 2026) з усім, що чекає дій: оплати на розбір,
// документи на погодження, платіж на підписі, збори, опитування, звернення,
// чат, заявки на зміну власників. Результат — js/demo/seed.json.
// Люди, компанії, адреса й коди вигадані (scripts/demo/data.mjs).
import { createDb } from '../../js/demo/memdb.js';
import { installClock } from '../../js/demo/clock.js';
import { HOUSE, PEOPLE, BOARD_MEMBERS, SERVICES, SUPPLIERS, ONE_OFF, PERIODS, monthDocs, docNumber, supplierOf, TENANT, PROVIDER, BANK, iban, MONTH_NAMES, hash } from './data.mjs';
import { DEBTORS } from './fixture.mjs';

export const STAFF = { chair: '1001', accountant: '1002', board: '1003' };
export const RESIDENT = '7';
export const SANDBOX_TOKEN = 'PRIVAT24_TEST_KEY_USPIH25_SANDBOX_V3';
const user = apt => ({ uid: `demo-${apt}`, email: `${apt}@uspih-25.com` });
const MEETING_2 = 'Протокол загальних зборів № 2 від 15.09.2025';
const BOARD_7 = 'Протокол засідання правління № 7 від 20.09.2025';
const DOCS = 'assets/demo-docs';

/** Тексти тестової бухгалтерії, які в демо мають звучати як у живому ОСББ. */
const WORDING = [
    ['ОСББ «Тестовий будинок»', HOUSE.name], ['Тестовий рахунок', 'Рахунок у ПриватБанку'], ['Умовне казначейство (тест)', 'ГУ ДПС в Одеській області'],
    ['Умовна послуга тестового місяця', 'Бухгалтерський і юридичний супровід'], ['Ізольований навчальний перенос', 'Перенос даних з попередньої програми обліку'],
    ['Навчальні ставки контрольного сценарію', MEETING_2], ['Умовне рішення зборів тестового будинку', MEETING_2], ['Умовне рішення тестового будинку', MEETING_2],
    ['Умовний прийнятий звіт попереднього року', 'Фінансовий звіт за 2024 рік (прийнято ДПС)'], ['Параметри лише для навчального прикладу 2025', 'Ставки податків і внесків 2025 року'],
    ['Контрольна імітована виписка тестового банку', 'Виписка банку на кінець місяця'], ['Умовний кошторис', 'Кошторис на 2025 рік'],
    ['2025 рік: з 01.10.2026 по 20.01.2026', '2025 рік: з 01.10.2025 по 31.12.2025'],
    // Посилання імітованого банку тестової бухгалтерії — як номери Приват24.
    ['TEST-', 'P24-']
];

export async function makeSeed(serverUrl) {
    installClock();
    // Серверні модулі беруть посилання на базу під час завантаження — база має існувати до імпорту.
    const store = createDb();
    globalThis.__demoStore = store;
    const server = await import(serverUrl);
    const db = store.admin;
    const { Timestamp } = store.lib;
    const log = [];
    const step = async (label, fn) => { try { const r = await fn(); log.push(`✓ ${label}`); return r; } catch (e) { log.push(`✗ ${label}: ${e.message}`); e.message = `${label}: ${e.message}`; throw e; } };
    const call = (name, data, as) => server.call(name, data, user(as));
    const at = (date, time = '10:00') => Timestamp.fromDate(new Date(`${date}T${time}:00+02:00`));
    const ACC = STAFF.accountant, CHAIR = STAFF.chair;

    // ---------- 1. Перенос бази ----------
    await server.boot();
    const engine = await server.engine(CHAIR);
    await step('перенос бази', () => engine.execute({ action: 'prepare' }));
    await db.doc('osbb_settings/finance').set({ edrpou: HOUSE.edrpou, payeeName: HOUSE.name, houseAddress: HOUSE.address,
        registry: { legalName: HOUSE.name, code: HOUSE.edrpou, legalAddress: HOUSE.legalAddress } }, { merge: true });
    for (const [role, apt] of Object.entries(STAFF)) {
        const p = PEOPLE[role];
        await db.doc(`staff/${apt}`).set({ active: true, role, name: p.name, phone: p.phone, email: p.email });
    }

    // ---------- 2. Кошторис 2025, постачальники й договори ----------
    const lines = (k = 1) => [
        ['lift', 'Обслуговування ліфтів', 13000000], ['waste', 'Вивезення відходів', 10300000], ['power', 'Електроенергія МЗК', 13500000],
        ['cleaning', 'Прибирання', 18000000], ['water', 'Вода МЗК', 2400000], ['systems', 'Обслуговування інженерних систем', 7800000],
        ['repair', 'Поточний ремонт', 12000000], ['services', 'Бухгалтерські й юридичні послуги', 1200000], ['office', 'Канцтовари й зв’язок', 300000],
        ['bank', 'Банк і РКО', 300000], ['salary', 'Зарплата та податки', 15500000], ['esv', 'ЄСВ', 2700000]
    ].map(([item, title, planKop]) => ({ item, title, planKop: Math.round(planKop * k / 1000) * 1000 }));
    const income = (k = 1) => [['contributions', 138000000], ['rent', 5400000], ['equipment', 2160000], ['interest', 6000]].map(([source, planKop]) => ({ source, planKop: Math.round(planKop * k) }));
    await step('кошторис 2025', async () => {
        await call('budgetAction', { action: 'save', year: '2025', lines: lines(), income: income(), note: 'Кошторис утримання будинку на 2025 рік' }, ACC);
        await call('budgetAction', { action: 'approve', year: '2025', decision: MEETING_2, files: [] }, CHAIR);
    });

    const ids = {};
    await step('постачальники й договори', async () => {
        for (const s of [...SUPPLIERS, ...ONE_OFF]) {
            const saved = await call('expenseAction', { action: 'saveSupplier', name: s.name, kind: s.kind, code: s.code, iban: s.iban, address: HOUSE.city, fopChecked: s.kind === 'fop' }, ACC);
            const monthly = Boolean(s.monthly);
            const maxKop = monthly ? Math.ceil(Math.max(...Object.values(s.monthly)) / 10000) * 10000 : s.amountKop;
            const contractDate = monthly ? '2025-09-25' : (() => { const d = new Date(`${s.date}T12:00:00Z`); d.setUTCDate(d.getUTCDate() - 12); return d.toISOString().slice(0, 10); })();
            const c = await call('expenseAction', { action: 'saveContract', supplierId: saved.id, number: monthly ? `${s.prefix}-25/${String(1 + hash(s.key) % 40)}` : `${s.number}/Д`, date: contractDate,
                subject: s.subject, type: monthly ? 'monthly' : 'fixed', ...(monthly ? { monthlyKop: maxKop } : { amountKop: maxKop }),
                validFrom: monthly ? '2025-10-01' : contractDate, validTo: monthly ? '2026-12-31' : '2026-03-31', item: s.item,
                boardDecision: BOARD_7, meetingDecision: monthly ? MEETING_2 : '' }, ACC);
            await call('expenseAction', { action: 'decideContract', id: c.id, approve: true }, CHAIR);
            ids[s.key] = { supplierId: saved.id, contractId: c.id };
        }
    });
    const expense = async d => {
        const saved = await call('expenseAction', { action: 'saveExpense', supplierId: ids[d.supplier].supplierId, contractId: ids[d.supplier].contractId,
            docType: d.docType, number: d.number, date: d.date, period: d.period, amountKop: d.amountKop, item: d.item, description: d.description, files: [] }, ACC);
        return saved.id;
    };
    const approve = async id => {
        const e = (await db.doc(`expenses/${id}`).get()).data();
        if (e.status === 'pending') await call('expenseAction', { action: 'decideExpense', id, approve: true }, CHAIR);
    };

    // ---------- 3. Жовтень–грудень 2025: повний цикл і закриття ----------
    for (const period of PERIODS) {
        for (const action of ['charge', 'services']) await step(`${period} ${action}`, () => engine.execute({ action, period }));
        // Разові роботи оплачують одразу, щомісячні документи — наступного місяця (після виписки цього).
        const docs = monthDocs(period), oneOff = d => ONE_OFF.some(o => o.key === d.supplier);
        await step(`${period} разові документи`, async () => { for (const d of docs.filter(oneOff)) await approve(await expense(d)); });
        await step(`${period} bank`, () => engine.execute({ action: 'bank', period }));
        await step(`${period} щомісячні документи`, async () => { for (const d of docs.filter(d => !oneOff(d))) await approve(await expense(d)); });
        for (const action of ['payroll', 'settle']) await step(`${period} ${action}`, () => engine.execute({ action, period }));
        const left = (await db.collection('bank_tx').where('period', '==', period).where('status', '==', 'review').get()).docs;
        if (left.length) throw new Error(`${period}: на розбір лишилося ${left.length} операцій банку — ${left.slice(0, 3).map(d => `${d.data().purpose} (${d.data().reason || d.data().kind})`).join(' | ')}`);
        await step(`${period} close`, () => engine.execute({ action: 'close', period }));
    }
    await step('звіт мешканцям', () => engine.execute({ action: 'publish' }));
    for (const id of ['control/state', 'control/bank']) await db.doc(id).delete();

    // ---------- 4. Команда, мешканець, банк ----------
    await db.doc(`apartments/${RESIDENT}`).set({ passwordChanged: true, registered: true, lastLogin: at('2026-01-19'), tutorialAt: at('2025-10-02') }, { merge: true });
    // Банк — тестове середовище Приват24: «Отримати виписку» і платежі працюють без справжнього банку.
    await db.doc('bank_secrets/privat').set({ token: SANDBOX_TOKEN, connectionId: 'demo' });
    await db.doc('bank/settings').set({ tokenSet: true, simulator: true, tokenHint: 'V3', connectionId: 'demo', lastSync: { ok: true, at: at('2026-01-20', '09:00'), added: 0, trigger: 'schedule' } }, { merge: true });
    const m = await server.modules(ACC);
    const ownAccount = async () => { const a = (await db.doc('bank/settings').get()).data()?.accounts || {}; return Object.entries(a).find(([, x]) => (x.purpose || 'current') === 'current')?.[0] || Object.keys(a)[0]; };
    const own = await ownAccount();

    // ---------- 5. Січень 2026: нарахування, кошторис, документи ----------
    await step('нарахування за січень', async () => {
        const preview = await call('chargesAction', { action: 'preview', period: '2026-01' }, ACC);
        await call('chargesAction', { action: 'run', period: '2026-01', expectTotalKop: preview.totalKop }, ACC);
    });
    await step('кошторис 2026', async () => {
        await call('budgetAction', { action: 'save', year: '2026', lines: lines(1.08), income: income(1.06), note: 'Кошторис на 2026 рік з урахуванням індексації договорів' }, ACC);
        await call('budgetAction', { action: 'approve', year: '2026', decision: 'Протокол загальних зборів № 3 від 14.12.2025', files: [] }, CHAIR);
    });
    // ---------- 6. Виписка січня ----------
    await step('виписка січня', async () => {
        const apts = (await db.collection('apartments').get()).docs.filter(d => !d.data().isAdmin && d.data().personalAccount);
        const owners = new Map((await db.collectionGroup('owners').get()).docs.map(d => [d.ref.parent.parent.id, d.data().name]));
        const list = [];
        let n = 0;
        for (const a of apts) {
            n++;
            if (n % 3 === 0 || DEBTORS.includes(a.id)) continue; // кожна третя квартира ще не сплатила
            const charge = (await db.collection(`apartments/${a.id}/ledger`).where('period', '==', '2025-12').get()).docs.find(d => d.data().kind === 'charge');
            const kop = charge?.data().amountKop || Math.round((charge?.data().amount || 0) * 100);
            if (!kop) continue;
            const day = String(5 + (n % 14)).padStart(2, '0');
            list.push({ bankId: `PB-2026-01-${a.id}`, account: own, at: new Date(`2026-01-${day}T11:${String(n % 60).padStart(2, '0')}:00+02:00`), direction: 'in', amountKop: kop, currency: 'UAH',
                purpose: `Внесок на утримання будинку, о/р ${a.data().personalAccount}, січень 2026`, counterparty: { name: owners.get(a.id) || `Платник кв. ${a.id}`, account: iban('305299', 26250000000000 + n), code: '' } });
        }
        // Оплати за грудневими документами — система сама звʼяже їх із документами.
        for (const d of monthDocs('2025-12').filter(d => d.payDate.startsWith('2026-01'))) {
            const s = supplierOf(d.supplier);
            list.push({ bankId: `PB-PAY-${d.supplier}-${d.period}`, account: own, at: new Date(`${d.payDate}T10:30:00+02:00`), direction: 'out', amountKop: d.amountKop, currency: 'UAH',
                purpose: `Оплата за документом № ${d.number}, ${d.description}, без ПДВ`, counterparty: { name: s.name, account: s.iban, code: s.code } });
        }
        // Те, що система не розпізнає сама, — бухгалтерові в «Рішення».
        list.push({ bankId: 'PB-2026-01-X1', account: own, at: new Date('2026-01-16T10:12:00+02:00'), direction: 'in', amountKop: 120000, currency: 'UAH', purpose: 'Оплата за квартиру', counterparty: { name: 'Іваненко Олена Петрівна', account: iban('322001', 26201111111111), code: '' } });
        list.push({ bankId: 'PB-2026-01-X2', account: own, at: new Date('2026-01-17T14:40:00+02:00'), direction: 'in', amountKop: 85000, currency: 'UAH', purpose: 'комуналка грудень-січень', counterparty: { name: 'Петренко Микола Сергійович', account: iban('300465', 26202222222222), code: '' } });
        list.push({ bankId: 'PB-RENT-2026-01', account: own, at: new Date('2026-01-12T09:05:00+02:00'), direction: 'in', amountKop: 450000, currency: 'UAH', purpose: 'Оренда нежитлового приміщення згідно з договором № 12/24 за січень 2026', counterparty: { name: TENANT.name, account: TENANT.iban, code: TENANT.code } });
        list.push({ bankId: 'PB-EQ-2026-01', account: own, at: new Date('2026-01-15T12:20:00+02:00'), direction: 'in', amountKop: 180000, currency: 'UAH', purpose: 'Плата за розміщення обладнання зв’язку на даху будинку за січень 2026', counterparty: { name: PROVIDER.name, account: PROVIDER.iban, code: PROVIDER.code } });
        list.push({ bankId: 'PB-FEE-2026-01-1', account: own, at: new Date('2026-01-19T23:50:00+02:00'), direction: 'out', amountKop: 2500, currency: 'UAH', purpose: 'Комісія за платіж в системі Приват24', counterparty: { name: BANK.name, account: '', code: BANK.code } });
        await m.bank.storeTransactions(list, 'privat', await m.bank.loadContext());
    });
    await step('документи січня', async () => {
        const jan = s => ({ supplier: s.key, item: s.item, docType: s.doc, number: docNumber(s, '2026-01'), period: '2026-01', amountKop: s.monthly['2026-01'],
            description: `${s.subject} за січень 2026` });
        const [lift, clean, waste] = ['lift', 'clean', 'waste'].map(k => jan(supplierOf(k)));
        ids.liftDoc = await expense({ ...lift, date: '2026-01-15' });
        await approve(ids.liftDoc);
        await approve(await expense({ ...clean, date: '2026-01-16' }));
        // Рахунок понад суму договору — чекає погодження голови.
        await expense({ ...waste, date: '2026-01-17', amountKop: 912340, description: 'Вивезення побутових і великогабаритних відходів за січень 2026 (додатковий вивіз після свят)' });
    });

    await step('платіж на підписі голови', () => call('expenseAction', { action: 'pay', id: ids.liftDoc, account: own }, ACC));

    // ---------- 7. Зарплата січня — чернетка відомості ----------
    await step('ставки 2026', () => call('payrollAction', { action: 'rates', rates: [
        { from: '2025-01', to: '2025-12', pdfo: 1800, vz: 500, esv: 2200, minWageKop: 800000, maxBaseMult: 20, subsistenceKop: 302800 },
        { from: '2026-01', to: '2026-12', pdfo: 1800, vz: 500, esv: 2200, minWageKop: 864700, maxBaseMult: 20, subsistenceKop: 332800 }
    ], basis: 'Закон про Держбюджет-2026: мінімальна зарплата 8 647 грн' }, CHAIR));
    await db.collection('payroll_people').get().then(s => Promise.all(s.docs.map(d => d.ref.update({ position: 'Бухгалтер', gender: 'female' }))));
    await step('відомість січня', () => call('payrollAction', { action: 'save', period: '2026-01', inputs: {} }, ACC));

    // ---------- 8. Подані звіти, звірені власники, заявки на зміну ----------
    await step('подані звіти', async () => {
        for (const [key, status, date] of [['j0500111-2025-10', 'accepted', '2025-11-18'], ['j0500111-2025-11', 'accepted', '2025-12-19'], ['esv-2025-10', 'paid', '2025-11-19'],
            ['esv-2025-11', 'paid', '2025-12-18'], ['esv-2025-12', 'paid', '2026-01-16'], ['budget-2026', 'accepted', '2025-12-28']]) {
            await call('reportsAction', { action: 'mark', key, status, date, regNumber: status === 'accepted' ? `9${String(hash(key) % 1000000).padStart(6, '0')}` : '', note: '' }, ACC);
        }
    });
    const apartments = (await db.collection('apartments').get()).docs.filter(d => !d.data().isAdmin);
    await step('звірені власники', async () => {
        const batch = db.batch();
        apartments.forEach((d, i) => batch.update(d.ref, { ownersStatus: i % 9 === 4 ? 'pending' : 'confirmed' }));
        await batch.commit();
        const ownerDocs = (await db.collectionGroup('owners').get()).docs;
        const ob = db.batch();
        ownerDocs.forEach(d => ob.update(d.ref, { status: 'confirmed', source: 'migration' }));
        await ob.commit();
    });
    await step('заявки на зміну власників', async () => {
        const ownersOf = async apt => (await db.collection(`apartments/${apt}/owners`).get()).docs.map(d => d.data());
        const plain = o => ({ name: o.name || '', shareFrac: o.shareFrac || '', sharePerc: o.sharePerc || '', docInfo: o.docInfo || '', fileUrls: '' });
        const sale = (await ownersOf('64')).map(plain);
        await db.collection('apartments/64/owner_changes').add({ before: sale, after: [{ name: 'Ярошенко Дмитро Олегович', shareFrac: '1/1', sharePerc: 100,
            docInfo: 'Витяг з Державного реєстру речових прав № 404518276 від 09.01.2026', fileUrls: '' }], reason: 'Квартиру продано, новий власник з 09.01.2026. Витяг додаю.', status: 'pending', createdAt: at('2026-01-13', '18:22') });
        await db.doc('apartments/64').update({ ownersStatus: 'review', ownersConfirmedBy: 'apt' });
        const heir = (await ownersOf('152')).map(plain);
        await db.collection('apartments/152/owner_changes').add({ before: heir, after: [...heir, { name: `${heir[0]?.name.split(' ')[0] || 'Дорошенко'} Марина Вікторівна`, shareFrac: '1/2', sharePerc: 50,
            docInfo: 'Свідоцтво про право на спадщину від 22.12.2025', fileUrls: '' }].map((o, i, all) => ({ ...o, shareFrac: all.length === 2 ? '1/2' : o.shareFrac, sharePerc: all.length === 2 ? 50 : o.sharePerc })),
            reason: 'Додати співвласницю після оформлення спадщини.', status: 'pending', createdAt: at('2026-01-18', '11:05') });
        await db.doc('apartments/152').update({ ownersStatus: 'review', ownersConfirmedBy: 'apt' });
    });

    // ---------- 8а. Претензійна робота, авансові звіти, майно ----------
    await step('претензійна робота', async () => {
        const claims = [
            ['13', 'claim', { claimDate: '2026-01-12', periodFrom: '2025-10', periodTo: '2026-01', note: 'Претензію вручено особисто, строк добровільної сплати — 30 днів.' }],
            ['58', 'warning', { note: 'Нагадування надіслано в застосунку й Viber 05.01.2026.' }],
            ['141', 'court_order_filed', { claimDate: '2025-11-20', courtOrderDate: '2026-01-09', caseNumber: '947/1532/26', periodFrom: '2025-10', periodTo: '2025-12', note: 'Заява про видачу судового наказу — Приморський районний суд м. Одеси.' }],
            ['199', 'restructured', { claimDate: '2025-12-02', restructureMonths: 6, restructureStart: '2026-02', note: 'Договір реструктуризації № 3/25: рівними частинами до липня 2026.' }],
            ['287', 'warning', { note: 'Телефонна розмова 14.01.2026, обіцяли сплатити до кінця місяця.' }]
        ];
        for (const [apt, status, extra] of claims) await call('claimsAction', { action: 'saveClaim', apt, status, ...extra }, ACC);
    });
    await step('авансові звіти', async () => {
        const person = { personName: PEOPLE.board.name, personCode: '3012456789', personIban: iban('305299', 26209000050221) };
        await call('journalAction', { action: 'saveAdvanceReport', ...person, number: '1', date: '2026-01-14', period: '2026-01', fundId: 'main', advanceKop: 0, approve: false,
            purpose: 'Матеріали для дрібного ремонту й посипання доріжок', lines: [
                { docType: 'fiscal_receipt', number: 'ФН 4000318724', date: '2026-01-12', amountKop: 124850, supplier: 'ТОВ «Будмаркет Південь»', postingAcc: '92', item: 'repair', desc: 'Лампи LED, вимикачі й кабель для під’їзду № 2', files: [] },
                { docType: 'fiscal_receipt', number: 'ФН 4000318901', date: '2026-01-13', amountKop: 68000, supplier: 'ФОП Чорновол Ігор Петрович', postingAcc: '92', item: 'cleaning', desc: 'Пісок і технічна сіль для доріжок, 10 мішків', files: [] }] }, ACC);
    });
    await step('майно й ТМЦ', async () => {
        // safeId замінює кирилицю на «_»: ОЗ-001 і МНМА-001 були б одним документом — номери різні.
        const cards = [
            { id: 'ОЗ-001', acc: '10', name: 'Генератор бензиновий 6,5 кВт', initialCostKop: 3850000, usefulLifeMonths: 60, location: 'ІТП, підвал під’їзду № 1', serialNumber: 'GX-65-0192', sourceDoc: 'Акт приймання-передачі благодійної допомоги від 05.01.2026' },
            { id: 'МНМА-002', acc: '11', name: 'Снігоприбирач бензиновий', initialCostKop: 1890000, usefulLifeMonths: 36, location: 'Господарське приміщення', serialNumber: 'SN-2210-447', sourceDoc: 'Акт приймання-передачі благодійної допомоги від 05.01.2026' }
        ];
        for (const c of cards) {
            const r = await call('journalAction', { action: 'saveAsset', ...c, item: 'systems', fundId: 'main', unit: 'шт.', initialQty: 1, custodian: PEOPLE.deputy.name,
                sourceMode: 'donated_or_surplus', acquiredDate: '2026-01-05' }, ACC);
            // Генератор лишаємо «очікує введення в експлуатацію» — це дія для бухгалтера в «Рішеннях».
            if (c.acc !== '10') await call('journalAction', { action: 'commissionAsset', id: r.id, commissionedDate: '2026-01-06', commissionActNo: 'ОЗ-1/1', usefulLifeMonths: c.usefulLifeMonths, item: 'systems' }, ACC);
        }
    });

    // ---------- 9. Контакти правління й служб ----------
    await step('правління й служби', async () => {
        for (const { id, ...b } of BOARD_MEMBERS) await db.doc(`board_members/${id}`).set(b);
        for (const { id, ...s } of SERVICES) await db.doc(`services/${id}`).set(s);
    });

    // ---------- 10. Документи будинку ----------
    const files = [
        ['Статут ОСББ «Злагода-17» (нова редакція)', 'Установчі документи', 'statut.pdf', '2024-03-12'],
        ['Виписка з ЄДР', 'Установчі документи', 'edr.pdf', '2024-03-20'],
        [MEETING_2, 'Протоколи зборів', 'protocol-meeting-2.pdf', '2025-09-16'],
        ['Протокол загальних зборів № 3 від 14.12.2025', 'Протоколи зборів', 'protocol-meeting-3.pdf', '2025-12-15'],
        [BOARD_7, 'Протоколи правління', 'protocol-board-7.pdf', '2025-09-20'],
        ['Протокол засідання правління № 9 від 08.01.2026', 'Протоколи правління', 'protocol-board-9.pdf', '2026-01-08'],
        ['Кошторис на 2026 рік', 'Звіти та кошториси', 'budget-2026.pdf', '2025-12-15'],
        ['Звіт правління за 2025 рік', 'Звіти та кошториси', 'report-2025.pdf', '2026-01-10'],
        ['Правила користування прибудинковою територією', 'Інше', 'rules.pdf', '2025-06-01']
    ];
    await step('база документів', async () => {
        for (const [title, category, file, date] of files) {
            await db.collection('osbb_documents').add({ title, category, fileName: file, url: `${DOCS}/${file}`, type: 'application/pdf', size: 60000 + hash(file) % 90000, createdAt: at(date, '12:00') });
        }
    });

    // ---------- 11. Світло, оголошення, звернення, чат ----------
    await db.doc('status/power').set({ isOn: true, changedAt: at('2026-01-20', '07:42') });
    for (const [d, t, isOn] of [['2026-01-18', '08:00', false], ['2026-01-18', '12:00', true], ['2026-01-19', '18:00', false], ['2026-01-19', '22:00', true], ['2026-01-20', '04:00', false], ['2026-01-20', '07:42', true]]) await db.collection('power_log').add({ isOn, at: at(d, t) });
    const announce = [
        ['Квитанції за січень', 'Нарахування за січень сформовано — сума до сплати вже у вашому кабінеті. Оплатити можна карткою в застосунку або за реквізитами з квитанції.', '2026-01-02'],
        ['Загальні збори співвласників', 'Правління скликає загальні збори щодо ремонту покрівли над під’їздом № 2 і встановлення відеоспостереження. Голосувати можна в застосунку до 1 лютого.', '2026-01-08'],
        ['Графік прибирання снігу', 'Прибудинкову територію прибирають щодня до 08:00. Якщо доріжка не розчищена — напишіть у «Звернення», додавши фото.', '2026-01-12'],
        ['Профілактика ліфтів', '22 січня з 10:00 до 13:00 ліфти під’їзду № 1 не працюватимуть: планове технічне обслуговування.', '2026-01-19'],
        ['Звіт правління за 2025 рік', 'Звіт про виконання кошторису й роботу правління за 2025 рік — у розділі «Документи». Деталізація витрат — у «Фінансах будинку».', '2026-01-10'],
        ['Повірка лічильників тепла', 'Теплопостачальна організація проводить повірку будинкових лічильників тепла. Доступ до ІТП забезпечує правління.', '2025-12-04']
    ];
    for (const [title, body, d] of announce) await db.collection('messages').add({ title, body, targetType: 'all', targetValue: '', recipients: ['all'], attachments: [], linkedDoc: null, createdAt: at(d, '12:00'), readBy: {} });
    const requests = [
        ['12', 'Не працює освітлення на 3 поверсі в другому під’їзді.', 'new', '2026-01-19'],
        ['27', 'Протікає дах над квартирою після відлиги, на стелі пляма. Прошу оглянути.', 'in_progress', '2026-01-17', 'Покрівельник оглянув дах 18.01, ремонт ділянки — до кінця тижня, якщо дозволить погода.'],
        [RESIDENT, 'Прошу перевірити показники лічильника води — схоже, помилка в нарахуванні.', 'new', '2026-01-18'],
        ['45', 'Коли буде прибирання прибудинкової території від снігу?', 'done', '2026-01-10', 'Прибирання щодня до 08:00, графік — в оголошеннях. Дякуємо за звернення!'],
        ['88', 'Не зачиняються вхідні двері в під’їзд № 1, доводчик зламаний.', 'done', '2026-01-06', 'Доводчик замінено 08.01. Дякуємо!'],
        ['131', 'Сусіди зверху палять на сходах, дим іде в квартиру.', 'in_progress', '2026-01-15', 'Розмістили оголошення в під’їзді, поговоримо з мешканцями на зборах.'],
        ['176', 'Прошу встановити велопарковку біля під’їзду № 3.', 'new', '2026-01-20'],
        [RESIDENT, 'Не працює домофон у квартирі — не чути відвідувача.', 'done', '2025-12-11', 'Майстер домофону замінив трубку 13.12. Перевірте, будь ласка, чи все працює.']
    ];
    for (const [apt, text, status, d, reply] of requests) await db.collection('requests').add({ apt, text, attachments: [], status, createdAt: at(d, '09:30'), ...(reply ? { replyText: reply, repliedAt: at(d, '15:00') } : {}) });
    const chat = [['2026-01-19', '19:05', '64', false, 'Сусіди, хтось знає, коли привезуть пісок для доріжок?'], ['2026-01-19', '19:20', '1001', true, 'Добрий вечір! Пісок привезуть завтра зранку, двірник посипле доріжки.'],
        ['2026-01-20', '08:17', '3', false, 'Доброго ранку! Ліфт у першому під’їзді знову стоїть.'], ['2026-01-20', '08:24', '1001', true, 'Доброго ранку! Викликали ліфтову службу, обіцяють до обіду.'],
        ['2026-01-20', '08:31', '18', false, 'Дякуємо! І ще — коли збори?'], ['2026-01-20', '08:38', '1001', true, 'Збори вже тривають онлайн — голосуйте в розділі «Голосування» до 1 лютого.'],
        ['2026-01-20', '08:45', RESIDENT, false, 'Проголосував, усе зручно 👍'], ['2026-01-20', '08:52', '205', false, 'Нагадую: у суботу толока у дворі о 10:00, рукавички видамо.'],
        ['2026-01-20', '09:03', '27', false, 'Дякую правлінню за швидку реакцію по даху!'], ['2026-01-20', '09:15', '1003', true, 'Будь ласка! Пишіть у «Звернення», якщо знову протікатиме.']];
    for (const [d, t, apt, isBoard, text] of chat) await db.collection('chat').add({ apt, isBoard, text, replyTo: null, attachments: [], createdAt: at(d, t) });

    // ---------- 12. Збори й опитування: поточні та завершені з підсумками ----------
    const all = apartments.map(d => d.id);
    // forPct — частка «за» серед тих, хто голосував, по кожному питанню.
    const vote = async (pollId, forPct, share, when, skipResident = true) => {
        for (const apt of all) {
            if (skipResident && apt === RESIDENT) continue;
            if (hash(`${pollId}:${apt}`) % 100 >= share) continue;
            const answer = i => { const h = hash(`${pollId}:${apt}:${i}`) % 100; return h < forPct[i] ? 'За' : h % 2 ? 'Проти' : 'Утримався'; };
            await db.doc(`polls/${pollId}/votes/${apt}`).set({ answers: Object.fromEntries(forPct.map((_, i) => [String(i), answer(i)])), votedAt: when });
        }
    };
    const chairName = PEOPLE.chair.name, secretaryName = PEOPLE.board.name;
    await step('збори й опитування', async () => {
        const agenda = ['Обрання головуючого та секретаря зборів', 'Ремонт покрівли над під’їздом № 2 за рахунок ремонтного фонду (до 180 000 грн)', 'Встановлення відеоспостереження у дворі (6 камер)', 'Затвердження правил паркування у дворі'];
        const meeting = await db.collection('polls').add({
            title: 'Загальні збори співвласників', description: 'Ремонт покрівли, відеоспостереження й правила паркування. Кошторис робіт — у протоколі правління № 9 (розділ «Документи»).', attachments: [],
            options: agenda, agendaDecisions: [`Обрати головуючою ${chairName}, секретарем — ${secretaryName}`, 'Провести ремонт покрівли до 01.06.2026, вартість — до 180 000 грн з ремонтного фонду', 'Встановити 6 камер у дворі, доступ до записів — правлінню', 'Затвердити правила паркування у дворі'],
            agendaHeard: agenda.map(() => chairName), isMeeting: true, meetingDate: '2026-01-15', timeStart: '18:00', timeEnd: '19:30', location: 'Двір будинку, біля під’їзду № 2',
            votingOpensAt: at('2026-01-15', '18:00'), surveyors: [], chairName, secretaryName, protocolNumber: '', sheetsByEntrance: false,
            deadline: at('2026-02-01', '23:59'), status: 'active', resultsSent: false, createdAt: at('2026-01-08', '12:00') });
        // Відеоспостереження поки не набирає більшості — видно й прийняті, й неприйняті рішення.
        await vote(meeting.id, [94, 86, 58, 82], 68, at('2026-01-16', '19:00'));
        const poll = await db.collection('polls').add({ title: 'Який день прибирання під’їздів зручніший?', description: 'Опитування для графіка на лютий.', options: ['Понеділок', 'Середа', 'Субота'],
            attachments: [], deadline: at('2026-01-31', '23:59'), isMeeting: false, status: 'active', resultsSent: false, createdAt: at('2026-01-14', '10:00') });
        for (const apt of all) if (apt !== RESIDENT && hash(`p1:${apt}`) % 4 === 0) await db.doc(`polls/${poll.id}/votes/${apt}`).set({ option: ['Понеділок', 'Середа', 'Субота'][hash(apt) % 3], votedAt: at('2026-01-15', '20:00') });

        // Завершені: грудневі збори з протоколом і листопадове опитування.
        const past = ['Обрання головуючого та секретаря зборів', 'Затвердження кошторису на 2026 рік', 'Затвердження розміру внеску на 2026 рік', 'Звіт ревізора за 2025 рік'];
        const closed = await db.collection('polls').add({
            title: 'Загальні збори: кошторис на 2026 рік', description: 'Кошторис, розмір внеску й звіт ревізора.', attachments: [], options: past,
            agendaDecisions: [`Обрати головуючою ${chairName}, секретарем — ${secretaryName}`, 'Затвердити кошторис на 2026 рік', 'Залишити внесок без змін', 'Затвердити звіт ревізора'],
            agendaHeard: past.map((_, i) => (i === 3 ? PEOPLE.auditor.name : chairName)), isMeeting: true, meetingDate: '2025-12-01', timeStart: '18:00', timeEnd: '19:30', location: 'Двір будинку',
            votingOpensAt: at('2025-12-01', '18:00'), surveyors: [], chairName, secretaryName, protocolNumber: '3', sheetsByEntrance: false,
            deadline: at('2025-12-14', '23:59'), status: 'closed', resultsSent: true, protocolUrl: `${DOCS}/protocol-meeting-3.pdf`, createdAt: at('2025-11-20', '12:00') });
        await vote(closed.id, [95, 84, 90, 88], 72, at('2025-12-05', '20:00'), false);
        const done = await db.collection('polls').add({ title: 'Чи потрібна велопарковка у дворі?', description: 'Опитування перед плануванням кошторису на 2026 рік.', options: ['Так', 'Ні', 'Байдуже'],
            attachments: [], deadline: at('2025-11-30', '23:59'), isMeeting: false, status: 'closed', resultsSent: true, createdAt: at('2025-11-10', '10:00') });
        for (const apt of all) if (hash(`p2:${apt}`) % 3 === 0) await db.doc(`polls/${done.id}/votes/${apt}`).set({ option: ['Так', 'Так', 'Ні', 'Байдуже'][hash(`v${apt}`) % 4], votedAt: at('2025-11-15', '20:00') });
    });

    // ---------- 13. Тексти тестової бухгалтерії → як у живому ОСББ ----------
    const dump = JSON.stringify(store.dump());
    const clean = WORDING.reduce((s, [from, to]) => s.split(JSON.stringify(from).slice(1, -1)).join(JSON.stringify(to).slice(1, -1)), dump);
    const fresh = createDb();
    fresh.load(JSON.parse(clean));
    return { store: fresh, log };
}

export { MONTH_NAMES };
