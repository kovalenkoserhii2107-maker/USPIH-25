// Демо-будинок: справжній перенос бази й три закриті місяці обліку через
// серверні модулі, потім поточний місяць (січень 2026) з усім, що чекає
// дій: оплати на розбір, документи на погодження, платіж на підписі,
// збори, опитування, звернення, чат. Результат — js/demo/seed.json.
// Імена людей і назви контрагентів умовні, з позначкою «(демо)».
import { createDb } from '../../js/demo/memdb.js';
import { installClock } from '../../js/demo/clock.js';

export const STAFF = { chair: '1001', accountant: '1002', board: '1003' };
export const RESIDENT = '7';
export const SANDBOX_TOKEN = 'PRIVAT24_TEST_KEY_USPIH25_SANDBOX_V3';
const user = apt => ({ uid: `demo-${apt}`, email: `${apt}@uspih-25.com` });

// IBAN з правильною контрольною сумою (ISO 13616).
function iban(mfo, account) {
    const bban = `${mfo}${String(account).padStart(19, '0')}`;
    const digits = `${bban}3010` + '00';
    let rest = 0;
    for (const d of digits) rest = (rest * 10 + Number(d)) % 97;
    return `UA${String(98 - rest).padStart(2, '0')}${bban}`;
}
// ЄДРПОУ з контрольним розрядом.
function edrpou(seven) {
    const d = String(seven).padStart(7, '0').split('').map(Number), num = Number(`${seven}0`);
    let w = num < 30000000 || num > 60000000 ? [1, 2, 3, 4, 5, 6, 7] : [7, 1, 2, 3, 4, 5, 6];
    let rem = w.reduce((s, x, i) => s + x * d[i], 0) % 11;
    if (rem === 10) { w = w.map(x => x + 2); rem = w.reduce((s, x, i) => s + x * d[i], 0) % 11; if (rem === 10) rem = 0; }
    return `${d.join('')}${rem}`;
}

export async function makeSeed(serverUrl) {
    installClock();
    // Серверні модулі беруть посилання на базу під час завантаження — база має існувати до імпорту.
    const store = createDb();
    globalThis.__demoStore = store;
    const server = await import(serverUrl);
    const db = store.admin;
    const { Timestamp, FieldValue } = store.lib;
    const log = [];
    const step = async (label, fn) => { try { await fn(); log.push(`✓ ${label}`); } catch (e) { log.push(`✗ ${label}: ${e.message}`); throw e; } };
    const call = (name, data, as) => server.call(name, data, user(as));
    const at = (date, time = '10:00') => Timestamp.fromDate(new Date(`${date}T${time}:00+02:00`));

    // ---------- 1. Перенос бази й три закриті місяці (тестова бухгалтерія) ----------
    await server.boot();
    const engine = await server.engine(STAFF.chair);
    await step('перенос бази', () => engine.execute({ action: 'prepare' }));
    for (const period of ['2025-10', '2025-11', '2025-12']) {
        for (const action of ['charge', 'services', 'bank', 'payroll', 'settle', 'close']) await step(`${period} ${action}`, () => engine.execute({ action, period }));
    }
    await step('звіт мешканцям', () => engine.execute({ action: 'publish' }));
    for (const id of ['control/state', 'control/bank']) await db.doc(id).delete();

    // ---------- 2. Команда, мешканець, реквізити, банк ----------
    await db.doc(`staff/${STAFF.chair}`).set({ active: true, role: 'chair', name: 'Голова правління (демо)', phone: '' });
    await db.doc(`staff/${STAFF.accountant}`).set({ active: true, role: 'accountant', name: 'Бухгалтер (демо)', phone: '' });
    await db.doc(`staff/${STAFF.board}`).set({ active: true, role: 'board', name: 'Член правління (демо)', phone: '' });
    await db.doc(`apartments/${RESIDENT}`).set({ passwordChanged: true, registered: true, lastLogin: at('2026-01-19') }, { merge: true });
    await db.doc('osbb_settings/finance').set({ edrpou: '30000005', payeeName: 'ОСББ «Демо-будинок»', houseAddress: 'вул. Демонстраційна, 1, м. Одеса',
        registry: { legalName: 'ОСББ «Демо-будинок»', code: '30000005', legalAddress: 'вул. Демонстраційна, 1, м. Одеса' } }, { merge: true });
    // Банк — тестове середовище Приват24: «Отримати виписку» і платежі працюють без справжнього банку.
    await db.doc('bank_secrets/privat').set({ token: SANDBOX_TOKEN, connectionId: 'demo' });
    await db.doc('bank/settings').set({ tokenSet: true, simulator: true, tokenHint: 'V3', connectionId: 'demo', lastSync: { ok: true, at: at('2026-01-20', '09:00'), added: 0, trigger: 'schedule' } }, { merge: true });

    const m = await server.modules(STAFF.accountant);

    // ---------- 3. Січень 2026: нарахування ----------
    await step('нарахування за січень', async () => {
        const preview = await call('chargesAction', { action: 'preview', period: '2026-01' }, STAFF.accountant);
        await call('chargesAction', { action: 'run', period: '2026-01', expectTotalKop: preview.totalKop }, STAFF.accountant);
    });

    // ---------- 4. Постачальники, договори, документи, платіж на підписі ----------
    const ids = {};
    await step('постачальники й договори', async () => {
        const list = [
            ['lift', 'ТОВ «Ліфт-Сервіс» (демо)', edrpou(3451289), iban('305299', 26007778889991), 'Обслуговування ліфтів', 1260000],
            ['waste', 'ТОВ «Еко-Вивіз» (демо)', edrpou(4123456), iban('300465', 26001234567001), 'Вивезення побутових відходів', 855586],
            ['cleaning', 'ФОП Прибиральник (демо)', edrpou(3987654), iban('322001', 26002000000123), 'Прибирання під’їздів і прибудинкової території', 640000]
        ];
        for (const [item, name, code, ibanNo, subject, monthlyKop] of list) {
            const kind = item === 'cleaning' ? 'company' : 'company';
            const s = await call('expenseAction', { action: 'saveSupplier', name, kind, code, iban: ibanNo, address: 'м. Одеса (демо)' }, STAFF.accountant);
            ids[item] = { supplierId: s.id, monthlyKop, subject };
            const c = await call('expenseAction', { action: 'saveContract', supplierId: s.id, number: `${item.toUpperCase()}-2025`, date: '2025-09-25', subject, type: 'monthly', monthlyKop,
                validFrom: '2025-10-01', validTo: '2026-12-31', item, boardDecision: 'Рішення правління № 7 від 20.09.2025 (демо)', meetingDecision: 'Протокол загальних зборів № 2 від 15.09.2025 (демо)' }, STAFF.accountant);
            ids[item].contractId = c.id;
            await call('expenseAction', { action: 'decideContract', id: c.id, approve: true }, STAFF.chair).catch(() => {});
        }
    });
    const doc = (item, docType, number, date, extra = {}) => call('expenseAction', { action: 'saveExpense', supplierId: ids[item].supplierId, contractId: ids[item].contractId,
        docType, number, date, period: '2026-01', amountKop: ids[item].monthlyKop, item, description: `${ids[item].subject} за січень 2026`, ...extra }, STAFF.accountant);
    await step('документи січня', async () => {
        const lift = await doc('lift', 'act', 'ЛС-01/26', '2026-01-15');
        await call('expenseAction', { action: 'decideExpense', id: lift.id, approve: true }, STAFF.chair).catch(() => {});
        ids.liftDoc = lift.id;
        const cleaning = await doc('cleaning', 'act', 'ПР-01/26', '2026-01-16');
        await call('expenseAction', { action: 'decideExpense', id: cleaning.id, approve: true }, STAFF.chair).catch(() => {});
        await doc('waste', 'invoice', 'ЕВ-0126', '2026-01-17');   // чекає погодження голови
    });
    const ownAccount = async () => { const a = (await db.doc('bank/settings').get()).data()?.accounts || {}; return Object.entries(a).find(([, x]) => (x.purpose || 'current') === 'current')?.[0] || Object.keys(a)[0]; };
    await step('платіж на підписі голови', async () => call('expenseAction', { action: 'pay', id: ids.liftDoc, account: await ownAccount() }, STAFF.accountant));

    // ---------- 5. Виписка січня: оплати мешканців, незрозумілі надходження, комісія ----------
    await step('виписка січня', async () => {
        const settings = (await db.doc('bank/settings').get()).data();
        const own = Object.entries(settings.accounts || {}).find(([, a]) => (a.purpose || 'current') === 'current')?.[0] || Object.keys(settings.accounts || {})[0];
        const apts = (await db.collection('apartments').get()).docs.filter(d => !d.data().isAdmin && d.data().personalAccount);
        const owners = new Map((await db.collectionGroup('owners').get()).docs.map(d => [d.ref.parent.parent.id, d.data().name]));
        const list = [];
        let n = 0;
        for (const a of apts) {
            n++;
            if (n % 3 === 0) continue; // кожна третя квартира ще не сплатила
            const charge = (await db.collection(`apartments/${a.id}/ledger`).where('period', '==', '2025-12').get()).docs.find(d => d.data().kind === 'charge');
            const kop = charge?.data().amountKop || Math.round((charge?.data().amount || 0) * 100);
            if (!kop) continue;
            const day = String(5 + (n % 14)).padStart(2, '0');
            list.push({ bankId: `DEMO-2026-01-${a.id}`, account: own, at: new Date(`2026-01-${day}T11:${String(n % 60).padStart(2, '0')}:00+02:00`), direction: 'in', amountKop: kop, currency: 'UAH',
                purpose: `Внесок на утримання будинку, о/р ${a.data().personalAccount}, січень 2026`, counterparty: { name: owners.get(a.id) || `Платник кв. ${a.id}`, account: iban('305299', 26250000000000 + n), code: '' } });
        }
        // Те, що система не розпізнає сама, — бухгалтерові в «Рішення».
        list.push({ bankId: 'DEMO-2026-01-X1', account: own, at: new Date('2026-01-16T10:12:00+02:00'), direction: 'in', amountKop: 120000, currency: 'UAH', purpose: 'Оплата за квартиру', counterparty: { name: 'Іваненко О. (демо)', account: iban('322001', 26201111111111), code: '' } });
        list.push({ bankId: 'DEMO-2026-01-X2', account: own, at: new Date('2026-01-17T14:40:00+02:00'), direction: 'in', amountKop: 85000, currency: 'UAH', purpose: 'комуналка грудень-січень', counterparty: { name: 'Петренко М. (демо)', account: iban('300465', 26202222222222), code: '' } });
        list.push({ bankId: 'DEMO-2026-01-X3', account: own, at: new Date('2026-01-18T09:05:00+02:00'), direction: 'in', amountKop: 450000, currency: 'UAH', purpose: 'Оренда нежитлового приміщення за січень 2026 р.', counterparty: { name: 'ТОВ «Кавʼярня на розі» (демо)', account: iban('305299', 26003333333333), code: edrpou(4455667) } });
        list.push({ bankId: 'DEMO-2026-01-F1', account: own, at: new Date('2026-01-19T23:50:00+02:00'), direction: 'out', amountKop: 22500, currency: 'UAH', purpose: 'Комісія за розрахунково-касове обслуговування за січень 2026', counterparty: { name: 'АТ КБ «ПриватБанк»', account: '', code: '14360570' } });
        await m.bank.storeTransactions(list, 'privat', await m.bank.loadContext());
    });

    // ---------- 6. Зарплата січня — чернетка відомості ----------
    await step('ставки 2026', () => call('payrollAction', { action: 'rates', rates: [
        { from: '2025-01', to: '2025-12', pdfo: 1800, vz: 500, esv: 2200, minWageKop: 800000, maxBaseMult: 20, subsistenceKop: 302800 },
        { from: '2026-01', to: '2026-12', pdfo: 1800, vz: 500, esv: 2200, minWageKop: 864700, maxBaseMult: 20, subsistenceKop: 332800 }
    ], basis: 'Ставки 2026 року для демо-будинку' }, STAFF.chair));
    await step('відомість січня', () => call('payrollAction', { action: 'save', period: '2026-01', inputs: {} }, STAFF.accountant).catch(e => { throw e; }));

    // ---------- 6а. Подані звіти, кошторис 2026, звірені власники ----------
    await step('подані звіти', async () => {
        for (const [key, status, date] of [['j0500111-2025-10', 'accepted', '2025-11-18'], ['j0500111-2025-11', 'accepted', '2025-12-19'], ['esv-2025-10', 'paid', '2025-11-19'],
            ['esv-2025-11', 'paid', '2025-12-18'], ['esv-2025-12', 'paid', '2026-01-16'], ['budget-2026', 'accepted', '2025-12-28']]) {
            await call('reportsAction', { action: 'mark', key, status, date, regNumber: status === 'accepted' ? `9${key.replace(/\D/g, '').slice(-6)}` : '', note: 'Демо-будинок' }, STAFF.accountant);
        }
    });
    await step('звірені власники', async () => {
        const apts = (await db.collection('apartments').get()).docs.filter(d => !d.data().isAdmin);
        const batch = db.batch();
        apts.forEach((d, i) => batch.update(d.ref, { ownersStatus: i % 9 === 4 ? 'pending' : 'confirmed' }));
        await batch.commit();
    });
    await db.doc(`apartments/${RESIDENT}`).set({ tutorialAt: at('2025-10-02') }, { merge: true });

    // ---------- 7. Світло, оголошення, звернення, чат ----------
    await db.doc('status/power').set({ isOn: true, changedAt: at('2026-01-20', '07:42') });
    for (const [d, t, isOn] of [['2026-01-19', '18:00', false], ['2026-01-19', '22:00', true], ['2026-01-20', '04:00', false], ['2026-01-20', '07:42', true]]) await db.collection('power_log').add({ isOn, at: at(d, t) });
    const announce = [
        ['Графік прибирання снігу', 'Прибудинкову територію прибирають щодня до 08:00. Якщо доріжка не розчищена — напишіть у «Звернення».', '2026-01-12'],
        ['Квитанції за січень', 'Нарахування за січень сформовано — сума до сплати вже у вашому кабінеті. Оплатити можна за реквізитами або QR з квитанції.', '2026-01-02'],
        ['Загальні збори співвласників', 'Правління скликає загальні збори щодо кошторису на 2026 рік і ремонту покрівли. Голосувати можна в застосунку.', '2026-01-08']
    ];
    for (const [title, body, d] of announce) await db.collection('messages').add({ title, body, targetType: 'all', targetValue: '', recipients: ['all'], attachments: [], linkedDoc: null, createdAt: at(d, '12:00'), readBy: {} });
    const requests = [
        ['12', 'Не працює освітлення на 3 поверсі в другому під’їзді.', 'new', '2026-01-19'],
        ['27', 'Протікає дах над квартирою після відлиги, фото додаю.', 'in_progress', '2026-01-17'],
        [RESIDENT, 'Прошу перевірити показники лічильника води — схоже, помилка.', 'new', '2026-01-18'],
        ['45', 'Коли буде прибирання прибудинкової території від снігу?', 'done', '2026-01-10', 'Прибирання щодня до 08:00, графік — в оголошеннях. Дякуємо за звернення!']
    ];
    for (const [apt, text, status, d, reply] of requests) await db.collection('requests').add({ apt, text, attachments: [], status, createdAt: at(d, '09:30'), ...(reply ? { replyText: reply, repliedAt: at(d, '15:00') } : {}) });
    const chat = [['3', false, 'Доброго ранку! Хтось знає, коли увімкнуть ліфт у першому під’їзді?'], ['1001', true, 'Доброго ранку! Ліфт обслуговують, до обіду запрацює.'],
        ['18', false, 'Дякуємо! І ще — коли збори?'], ['1001', true, 'Збори вже тривають онлайн — голосуйте в розділі «Голосування» до 1 лютого.'], [RESIDENT, false, 'Проголосував, усе зручно 👍']];
    let minute = 0;
    for (const [apt, isBoard, text] of chat) await db.collection('chat').add({ apt, isBoard, text, replyTo: null, attachments: [], createdAt: at('2026-01-20', `08:${String(10 + (minute += 7)).padStart(2, '0')}`) });

    // ---------- 8. Збори й опитування з голосами ----------
    const agenda = ['Обрання головуючого та секретаря зборів', 'Затвердження кошторису на 2026 рік', 'Ремонт покрівли над під’їздом № 2 за рахунок ремонтного фонду', 'Встановлення відеоспостереження у дворі'];
    const meeting = await db.collection('polls').add({
        title: 'Загальні збори співвласників (демо)', description: 'Кошторис на 2026 рік, ремонт покрівли й відеоспостереження.', attachments: [],
        options: agenda, agendaDecisions: ['Обрати головуючим Голову правління (демо), секретарем — Члена правління (демо)', 'Затвердити кошторис на 2026 рік', 'Провести ремонт покрівли до 01.06.2026', 'Встановити 6 камер у дворі'],
        agendaHeard: agenda.map(() => 'Голову правління (демо)'), isMeeting: true, meetingDate: '2026-01-15', timeStart: '18:00', timeEnd: '19:30', location: 'Двір будинку',
        votingOpensAt: at('2026-01-15', '18:00'), surveyors: [], chairName: 'Голова правління (демо)', secretaryName: 'Член правління (демо)', protocolNumber: '',
        sheetsByEntrance: false, deadline: at('2026-02-01', '23:59'), status: 'active', resultsSent: false, createdAt: at('2026-01-08', '12:00')
    });
    const poll = await db.collection('polls').add({ title: 'Який день прибирання під’їздів зручніший?', description: 'Опитування для графіка на лютий.', options: ['Понеділок', 'Середа', 'Субота'],
        attachments: [], deadline: at('2026-01-31', '23:59'), isMeeting: false, status: 'active', resultsSent: false, createdAt: at('2026-01-14', '10:00') });
    const answers = ['За', 'За', 'За', 'Проти', 'Утримався'];
    const all = (await db.collection('apartments').get()).docs.filter(d => !d.data().isAdmin).map(d => d.id);
    let k = 0;
    for (const apt of all) {
        if (apt === RESIDENT) continue;
        k++;
        if (k % 5 < 3) await db.doc(`polls/${meeting.id}/votes/${apt}`).set({ answers: Object.fromEntries(agenda.map((_, i) => [String(i), answers[(k + i) % answers.length]])), votedAt: at('2026-01-16', '19:00') });
        if (k % 4 === 0) await db.doc(`polls/${poll.id}/votes/${apt}`).set({ option: ['Понеділок', 'Середа', 'Субота'][k % 3], votedAt: at('2026-01-15', '20:00') });
    }

    return { store, log };
}
