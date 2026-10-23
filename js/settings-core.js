// ============================================================
// «Налаштування»: розділи й готовність кабінету до роботи.
//
// Чиста логіка без DOM і Firebase: що налаштовано, чого бракує і
// куди перейти, щоб це виправити. Розмітка — buh-settings.js.
// ============================================================

export const SECTIONS = {
    overview: ['Огляд', 'Що налаштовано і що лишилось'],
    org: ['Організація', 'Реквізити, звітність ДПС, реєстри'],
    bank: ['Банк і сервіси', 'ПриватБанк, рахунки, YouScore, AI'],
    policy: ['Облік і податки', 'Облікова політика, ставки, бюджетні рахунки'],
    rules: ['Правила', 'Хто що погоджує, публічність, пеня'],
    startup: ['Перехід на облік', 'Вхідні залишки, ОСВ, історія року'],
    service: ['Обслуговування', 'Тестовий полігон, очищення бази']
};

/** Старі назви вкладок (посилання з інших розділів) → нові розділи. */
const LEGACY = { directories: 'overview' };

export function sectionKey(key) {
    return SECTIONS[key] ? key : LEGACY[key] || 'overview';
}

const validIban = v => /^UA\d{27}$/.test(String(v || '').replace(/\s+/g, '').toUpperCase());
const addMonths = (period, n) => {
    const [y, m] = period.split('-').map(Number);
    const d = new Date(Date.UTC(y, m - 1 + n, 1));
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
};
const MONTHS = ['січня', 'лютого', 'березня', 'квітня', 'травня', 'червня', 'липня', 'серпня', 'вересня', 'жовтня', 'листопада', 'грудня'];
const monthEnd = p => `кінця ${MONTHS[Number(p.slice(5, 7)) - 1]} ${p.slice(0, 4)}`;

/** Ставка зарплатних податків, чинна в period (як rateFor на сервері). */
export function rateFor(period, rates = []) {
    return [...rates].filter(r => r.from <= period && (!r.to || r.to >= period)).sort((a, b) => (a.from < b.from ? 1 : -1))[0] || null;
}

/**
 * Пункти готовності. state: ok — готово; todo — треба зробити; wait — чекає
 * іншої людини (голови); warn — працює, але скоро знадобиться дія.
 * need: true — без цього кабінет працює неповно; false — додаткові можливості.
 */
export function readiness(d = {}, period = new Date().toISOString().slice(0, 7)) {
    const items = [];
    const add = (key, section, title, state, note, need = true) => items.push({ key, section, title, state, note, need });

    const req = d.requisites || {};
    const missPay = [!String(req.payeeName || '').trim() && 'назва', !/^\d{8}$/.test(String(req.edrpou || '')) && 'ЄДРПОУ', !validIban(req.iban) && 'IBAN'].filter(Boolean);
    add('pay', 'org', 'Платіжні реквізити', missPay.length ? 'todo' : 'ok',
        missPay.length ? `Немає: ${missPay.join(', ')} — без них квитанції й QR не працюють` : `IBAN …${String(req.iban).slice(-4)} · ЄДРПОУ ${req.edrpou}`);

    const x = d.xml || {};
    const missXml = [!x.sti && 'податкова', !/^UA\d{17}$/.test(String(x.katottg || '')) && 'КАТОТТГ', !/^\d{10}$/.test(String(x.headTin || '')) && 'РНОКПП керівника'].filter(Boolean);
    add('xml', 'org', 'Реквізити для звітів ДПС', missXml.length ? 'todo' : 'ok',
        missXml.length ? `Немає: ${missXml.join(', ')} — без них XML для Е-кабінету не сформувати` : 'Підставляються в XML податкового розрахунку, 4ДФ, Д5');

    const bank = d.bank || {};
    const accounts = Object.keys(bank.accounts || {}).length;
    add('privat', 'bank', 'ПриватБанк', !bank.tokenSet ? 'todo' : bank.lastSync?.ok === false ? 'warn' : 'ok',
        !bank.tokenSet ? 'Не підключено — виписку й платежі доведеться вносити вручну'
            : bank.lastSync?.ok === false ? `Остання виписка з помилкою: ${bank.lastSync.error || 'невідомо'}`
            : `Підключено · рахунків: ${accounts}`);

    const policy = d.policy || {};
    add('policy', 'policy', 'Облікова політика', policy.status === 'approved' ? 'ok' : policy.status === 'draft' ? 'wait' : 'todo',
        policy.status === 'approved' ? `Погоджено · облік з ${String(policy.startDate || '').split('-').reverse().join('.')}`
            : policy.status === 'draft' ? 'Проєкт збережено — чекає погодження голови' : 'Параметри обліку ще не погоджено');

    const rates = d.rates || [];
    const now = rateFor(period, rates);
    const last = [...rates].sort((a, b) => String(a.to || '9999').localeCompare(String(b.to || '9999'))).at(-1);
    const soon = now && last?.to && last.to < addMonths(period, 3);
    add('rates', 'policy', 'Ставки зарплатних податків', !now ? 'todo' : soon ? 'warn' : 'ok',
        !now ? `На ${period.slice(5)}.${period.slice(0, 4)} немає чинних ставок — відомість зарплати не порахується`
            : soon ? `Діють до ${monthEnd(last.to)} — додайте ставки на наступний рік`
            : `ПДФО ${now.pdfo / 100} %, ВЗ ${now.vz / 100} %, ЄСВ ${now.esv / 100} %`);

    add('opening', 'startup', 'Вхідні залишки квартир', d.opening?.set ? 'ok' : 'todo',
        d.opening?.set ? `${d.opening.count} кв. · баланс мешканців рахує система` : 'Без них баланс мешканців неповний');

    const osv = d.osv || 'none';
    add('osv', 'startup', 'Вхідна оборотно-сальдова', osv === 'approved' ? 'ok' : osv === 'draft' ? 'wait' : 'todo',
        osv === 'approved' ? 'Затверджено головою' : osv === 'draft' ? 'Внесено — чекає затвердження голови' : 'Банк, каса, фонди й борги на дату початку обліку');

    add('ai', 'bank', 'Розпізнавання сканів (AI)', d.aiKey ? 'ok' : 'todo',
        d.aiKey ? 'Скани, фото й PDF читаються автоматично' : 'Без ключа читаються лише файли M.E.Doc і Вчасно', false);
    add('youscore', 'bank', 'YouScore: перевірка контрагентів', d.youscore ? 'ok' : 'todo',
        d.youscore ? 'Бойовий ключ: ЄДР, суди, виконавчі провадження' : 'Тестовий режим — дані не справжні', false);
    return items;
}

/** Підсумок: скільки обовʼязкового готово і що в кожному розділі потребує уваги. */
export function readinessSummary(items) {
    const need = items.filter(i => i.need);
    const bySection = {};
    for (const i of items) {
        if (i.state === 'ok' || !i.need) continue;
        bySection[i.section] = (bySection[i.section] || 0) + 1;
    }
    return { done: need.filter(i => i.state === 'ok').length, total: need.length, bySection, next: need.find(i => i.state === 'todo') || need.find(i => i.state !== 'ok') || null };
}

/** Рядки ставок із форми: відсотки → базисні пункти, гривні → копійки. */
export function parseRateRow(r) {
    const pct = v => Math.round(Number(String(v).replace(',', '.').replace(/\s/g, '')) * 100);
    const kop = v => Math.round(Number(String(v).replace(',', '.').replace(/\s/g, '')) * 100);
    return { from: String(r.from || ''), to: String(r.to || ''), pdfo: pct(r.pdfo), vz: pct(r.vz), esv: pct(r.esv), minWageKop: kop(r.minWage), maxBaseMult: Number(r.maxBaseMult), subsistenceKop: kop(r.subsistence) };
}

/** Наступний період ставок: копія останнього з наступного року. */
export function nextRateRow(rates = []) {
    const last = [...rates].sort((a, b) => String(a.from).localeCompare(String(b.from))).at(-1);
    if (!last) return { from: '2026-01', to: '2026-12', pdfo: 1800, vz: 500, esv: 2200, minWageKop: 864700, maxBaseMult: 20, subsistenceKop: 332800 };
    const year = Number(String(last.to || last.from).slice(0, 4)) + 1;
    return { ...last, from: `${year}-01`, to: `${year}-12` };
}
