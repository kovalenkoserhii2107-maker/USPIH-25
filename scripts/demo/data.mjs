// Демо-будинок: вигадані, але правдоподібні дані — назва й адреса будинку,
// ПІБ співвласників, правління, служби, постачальники й документи витрат.
// Збіг із реальними людьми чи компаніями випадковий. Усе детерміновано:
// та сама збірка — ті самі імена й суми.

export const HOUSE = {
    name: 'ОСББ «Злагода-17»', short: 'Злагода-17', street: 'вул. Каштанова', number: '7/2', city: 'м. Одеса', postcode: '65012',
    get address() { return `${this.street}, ${this.number}, ${this.city}`; },
    get legalAddress() { return `${this.postcode}, ${this.city}, ${this.street}, буд. ${this.number}`; },
    edrpou: edrpou(4318592), domain: 'osbb-zlagoda17.com.ua'
};

// ---------- коди й рахунки з правильними контрольними сумами ----------
export function iban(mfo, account) {
    const bban = `${mfo}${String(account).padStart(19, '0')}`;
    let rest = 0;
    for (const d of `${bban}301000`) rest = (rest * 10 + Number(d)) % 97;
    return `UA${String(98 - rest).padStart(2, '0')}${bban}`;
}
export function edrpou(seven) {
    const d = String(seven).padStart(7, '0').split('').map(Number), num = Number(`${seven}0`);
    let w = num < 30000000 || num > 60000000 ? [1, 2, 3, 4, 5, 6, 7] : [7, 1, 2, 3, 4, 5, 6];
    let rem = w.reduce((s, x, i) => s + x * d[i], 0) % 11;
    if (rem === 10) { w = w.map(x => x + 2); rem = w.reduce((s, x, i) => s + x * d[i], 0) % 11; if (rem === 10) rem = 0; }
    return `${d.join('')}${rem}`;
}
export function rnokpp(nine) {
    const d = String(nine).split('').map(Number);
    const sum = [-1, 5, 7, 9, 4, 6, 10, 5, 7].reduce((s, w, i) => s + w * d[i], 0);
    return d.join('') + String(((sum % 11) + 11) % 11 % 10);
}

// ---------- детермінований «випадок» ----------
export function hash(text) {
    let h = 2166136261;
    for (const ch of String(text)) { h ^= ch.codePointAt(0); h = Math.imul(h, 16777619) >>> 0; }
    return h;
}
const pick = (list, key) => list[hash(key) % list.length];

// ---------- імена ----------
// Прізвища, однакові для чоловіків і жінок, та прикметникові (-ський/-ська).
const SURNAMES = ['Коваленко', 'Бондаренко', 'Ткаченко', 'Кравченко', 'Шевченко', 'Мельник', 'Бойко', 'Ковальчук', 'Савчук', 'Олійник', 'Шевчук', 'Поліщук',
    'Лисенко', 'Марченко', 'Руденко', 'Мороз', 'Клименко', 'Павленко', 'Гончаренко', 'Кузьменко', 'Петренко', 'Савченко', 'Пономаренко', 'Левченко', 'Харченко',
    'Карпенко', 'Іваненко', 'Юрченко', 'Гаврилюк', 'Мартинюк', 'Романенко', 'Тарасенко', 'Литвиненко', 'Сидоренко', 'Нестеренко', 'Мазур', 'Кравчук', 'Вакуленко',
    'Дорошенко', 'Захарченко', 'Ярошенко', 'Фесенко', 'Демченко', 'Костенко', 'Приходько', 'Онищенко', 'Грищенко', 'Кушнір', 'Коломієць', 'Головко', 'Кириленко',
    'Остапчук', 'Білоус', 'Чорновол', 'Козак', 'Гуменюк', 'Панченко', 'Вдовиченко', 'Тимошенко', 'Яковенко', 'Зінченко', 'Бабенко', 'Кучер', 'Семенюк',
    'Дмитрук', 'Соловйов', 'Гнатюк', 'Ничипорук', 'Стасюк', 'Пилипенко', 'Рибак', 'Гайдай', 'Чумак', 'Сорока', 'Прокопенко', 'Климчук', 'Андрієнко', 'Деркач',
    'Чайка', 'Науменко', 'Москаленко', 'Ковтун', 'Лук’яненко', 'Степаненко', 'Фоменко', 'Сергієнко', 'Мирошниченко', 'Гордієнко', 'Мацюк', 'Волошин'];
const ADJ = ['Ковальськ', 'Вишневськ', 'Дубровськ', 'Островськ', 'Яворськ', 'Сокольськ', 'Заславськ', 'Березовськ', 'Липинськ', 'Чорноморськ', 'Галицьк', 'Покровськ'];
const MALE = [['Олександр', 'Олександрович', 'Олександрівна'], ['Андрій', 'Андрійович', 'Андріївна'], ['Сергій', 'Сергійович', 'Сергіївна'], ['Володимир', 'Володимирович', 'Володимирівна'],
    ['Дмитро', 'Дмитрович', 'Дмитрівна'], ['Олег', 'Олегович', 'Олегівна'], ['Віктор', 'Вікторович', 'Вікторівна'], ['Михайло', 'Михайлович', 'Михайлівна'], ['Іван', 'Іванович', 'Іванівна'],
    ['Юрій', 'Юрійович', 'Юріївна'], ['Василь', 'Васильович', 'Василівна'], ['Петро', 'Петрович', 'Петрівна'], ['Микола', 'Миколайович', 'Миколаївна'], ['Ігор', 'Ігорович', 'Ігорівна'],
    ['Тарас', 'Тарасович', 'Тарасівна'], ['Богдан', 'Богданович', 'Богданівна'], ['Анатолій', 'Анатолійович', 'Анатоліївна'], ['Валерій', 'Валерійович', 'Валеріївна'],
    ['Євген', 'Євгенович', 'Євгенівна'], ['Роман', 'Романович', 'Романівна'], ['Максим', 'Максимович', 'Максимівна'], ['Артем', 'Артемович', 'Артемівна'],
    ['Віталій', 'Віталійович', 'Віталіївна'], ['Григорій', 'Григорович', 'Григорівна'], ['Леонід', 'Леонідович', 'Леонідівна'], ['Станіслав', 'Станіславович', 'Станіславівна'],
    ['Павло', 'Павлович', 'Павлівна'], ['Костянтин', 'Костянтинович', 'Костянтинівна'], ['Денис', 'Денисович', 'Денисівна'], ['Ярослав', 'Ярославович', 'Ярославівна']];
const FEMALE = ['Олена', 'Наталія', 'Ірина', 'Тетяна', 'Світлана', 'Оксана', 'Людмила', 'Галина', 'Ольга', 'Юлія', 'Марія', 'Ганна', 'Валентина', 'Катерина', 'Лариса',
    'Надія', 'Вікторія', 'Алла', 'Інна', 'Зоя', 'Тамара', 'Лідія', 'Анастасія', 'Дарина', 'Софія', 'Христина', 'Віра', 'Любов', 'Мирослава', 'Яна'];

/** ПІБ за ключем: стать, прізвище (родина може мати спільне), ім’я, по батькові. */
export function personName(key, { surname, female } = {}) {
    const f = female ?? hash(`${key}:g`) % 2 === 0;
    const base = surname ?? (hash(`${key}:a`) % 7 === 0 ? `${pick(ADJ, `${key}:j`)}*` : pick(SURNAMES, `${key}:s`));
    const last = base.endsWith('*') ? base.slice(0, -1) + (f ? 'а' : 'ий') : base;
    const father = pick(MALE, `${key}:p`);
    const first = f ? pick(FEMALE, `${key}:f`) : pick(MALE, `${key}:m`)[0];
    return { full: `${last} ${first} ${f ? father[2] : father[1]}`, surname: base, female: f };
}

/** Співвласники з CSV переносу: родина в одній квартирі здебільшого має спільне прізвище. */
export function ownerNames(ownersCsv) {
    const lines = ownersCsv.replace(/^﻿/, '').split(/\r?\n/).filter(Boolean);
    const byAlias = new Map(), family = new Map(), firstOwner = new Map();
    for (const line of lines.slice(1)) {
        const [premise, raw] = line.split(';');
        const alias = raw.replace('Тестовий співвласник ', '');
        if (!byAlias.has(alias)) {
            const shared = family.get(premise);
            const sameFamily = shared && hash(`${alias}:fam`) % 5 !== 0;
            const female = shared && sameFamily ? !shared.female : undefined;
            const p = personName(alias, sameFamily ? { surname: shared.surname, female } : {});
            byAlias.set(alias, p.full);
            if (!shared) family.set(premise, p);
        }
        if (!firstOwner.has(premise)) firstOwner.set(premise, byAlias.get(alias));
    }
    return { byAlias, firstOwner };
}

/** Документ про право власності: витяг з ДРРП або старе свідоцтво. */
export function ownershipDoc(premise, n) {
    const k = hash(`${premise}-${n}:doc`);
    if (k % 6 === 0) {
        const year = 1996 + (k % 17), day = 1 + (k % 27), month = 1 + ((k >>> 3) % 12);
        return `Свідоцтво про право власності від ${String(day).padStart(2, '0')}.${String(month).padStart(2, '0')}.${year}`;
    }
    return `Витяг з Державного реєстру речових прав № ${String(100000000 + (k % 899999999))}`;
}

// ---------- люди будинку ----------
const phone = n => `+380 67 ${String(n).slice(0, 3)} ${String(n).slice(3, 5)} ${String(n).slice(5, 7)}`;
export const PEOPLE = {
    chair: { name: 'Вишневська Олена Михайлівна', phone: phone('0001472'), email: `golova@${HOUSE.domain}`, telegram: '@zlagoda17_golova', apt: '118' },
    accountant: { name: 'Гончаренко Тетяна Василівна', phone: phone('0002583'), email: `buh@${HOUSE.domain}`, telegram: '' },
    board: { name: 'Ковальчук Андрій Петрович', phone: phone('0003694'), email: `pravlinnia@${HOUSE.domain}`, telegram: '@a_kovalchuk', apt: '205' },
    deputy: { name: 'Марченко Ігор Володимирович', phone: phone('0004715'), email: '', telegram: '@igor_marchenko', apt: '43' },
    member2: { name: 'Савчук Наталія Олегівна', phone: phone('0005826'), email: '', telegram: '', apt: '264' },
    auditor: { name: 'Левченко Валентина Іванівна', phone: phone('0006937'), email: '', telegram: '', apt: '87' }
};
export const BOARD_MEMBERS = [
    { id: 'chairman', label: 'Голова правління', order: 0, ...PEOPLE.chair },
    { id: 'deputy', label: 'Заступник голови правління', order: 1, ...PEOPLE.deputy },
    { id: 'member-1', label: 'Член правління', order: 2, ...PEOPLE.board },
    { id: 'member-2', label: 'Член правління', order: 3, ...PEOPLE.member2 },
    { id: 'auditor', label: 'Ревізор', order: 4, ...PEOPLE.auditor }
].map(({ apt, ...m }) => ({ ...m, viber: '' }));
export const SERVICES = [
    { id: 'accountant', label: 'Бухгалтер', order: 0, name: PEOPLE.accountant.name, phone: PEOPLE.accountant.phone, email: PEOPLE.accountant.email, hours: 'Пн–Пт 10:00–17:00, прийом у вівторок 17:00–19:00' },
    { id: 'emergency', label: 'Аварійна служба', order: 1, name: 'Аварійно-диспетчерська служба', phone: phone('0007048'), hours: 'Цілодобово' },
    { id: 'electrician', label: 'Електрик', order: 2, name: 'Руденко Віктор Анатолійович', phone: phone('0008159'), hours: 'Пн–Сб 08:00–18:00' },
    { id: 'plumber', label: 'Сантехнік', order: 3, name: 'Кравець Олег Миколайович', phone: phone('0009260'), hours: 'Пн–Сб 08:00–18:00' },
    { id: 'elevator', label: 'Ліфтова служба', order: 4, name: 'Диспетчерська ліфтів «Ліфтсервіс-Одеса»', phone: phone('0010371'), hours: 'Цілодобово' },
    { id: 'intercom', label: 'Домофон', order: 5, name: 'ФОП Чумак Денис Ігорович', phone: phone('0011482'), telegram: '@domofon_chumak', hours: 'Пн–Пт 09:00–18:00' },
    { id: 'janitor', label: 'Двірник', order: 6, name: 'Мельник Галина Петрівна', phone: phone('0012593'), hours: 'Щодня 06:00–14:00' }
].map(s => ({ email: '', telegram: '', viber: '', ...s }));

// ---------- постачальники й щомісячні документи ----------
const M = ['2025-10', '2025-11', '2025-12'];
export const PERIODS = M;
export const SUPPLIERS = [
    { key: 'lift', name: 'ТОВ «Ліфтсервіс-Одеса»', kind: 'company', code: edrpou(3851274), iban: iban('305299', 26004052171001), item: 'lift', subject: 'Технічне обслуговування ліфтів (6 ліфтів)',
        monthly: { '2025-10': 1082237, '2025-11': 1082237, '2025-12': 1082237, '2026-01': 1082237 }, doc: 'act', prefix: 'ЛС' },
    { key: 'waste', name: 'ТОВ «Чисте місто Південь»', kind: 'company', code: edrpou(4207719), iban: iban('300465', 26003018840027), item: 'waste', subject: 'Вивезення побутових відходів',
        monthly: { '2025-10': 855586, '2025-11': 855586, '2025-12': 855586, '2026-01': 855586 }, doc: 'invoice', prefix: 'ЧМ' },
    { key: 'power', name: 'ТОВ «Енергозбут Причорномор’я»', kind: 'company', code: edrpou(4119053), iban: iban('320478', 26035000127784), item: 'power', subject: 'Електроенергія місць загального користування',
        monthly: { '2025-10': 987420, '2025-11': 1120355, '2025-12': 1241890 }, doc: 'invoice', prefix: 'ЕП' },
    { key: 'clean', name: 'ФОП Савчук Ірина Олегівна', kind: 'fop', code: rnokpp('328401597'), iban: iban('305299', 26003990417256), item: 'cleaning', subject: 'Прибирання під’їздів і прибудинкової території',
        monthly: { '2025-10': 1500000, '2025-11': 1500000, '2025-12': 1500000, '2026-01': 1500000 }, doc: 'act', prefix: 'ПР' },
    { key: 'water', name: 'ТОВ «Водосервіс-Південь»', kind: 'company', code: edrpou(3976602), iban: iban('328209', 26008051033342), item: 'water', subject: 'Вода й водовідведення місць загального користування',
        monthly: { '2025-10': 184050, '2025-11': 191230, '2025-12': 200510 }, doc: 'invoice', prefix: 'ВС' },
    { key: 'systems', name: 'ТОВ «Теплотехсервіс»', kind: 'company', code: edrpou(4034418), iban: iban('351005', 26001000308812), item: 'systems', subject: 'Обслуговування ІТП і внутрішньобудинкових інженерних систем',
        monthly: { '2025-10': 650000, '2025-11': 650000, '2025-12': 650000 }, doc: 'act', prefix: 'ТТ' }
];
// Разові роботи: окремий договір, документ і оплата.
export const ONE_OFF = [
    { key: 'roof', name: 'ТОВ «Дах-Майстер»', kind: 'company', code: edrpou(4286130), iban: iban('305299', 26000052064419), item: 'repair', period: '2025-10',
        subject: 'Ремонт покрівлі над під’їздом № 3 (локальний, 86 м²)', amountKop: 4860000, number: 'ДМ-0291', date: '2025-10-24', doc: 'act' },
    { key: 'plumb', name: 'ФОП Кравець Олег Миколайович', kind: 'fop', code: rnokpp('302817654'), iban: iban('322001', 26201000477120), item: 'repair', period: '2025-11',
        subject: 'Заміна стояка холодного водопостачання, під’їзд № 2', amountKop: 1235000, number: '47', date: '2025-11-19', doc: 'act' },
    { key: 'light', name: 'ТОВ «Електромонтаж Південь»', kind: 'company', code: edrpou(4371845), iban: iban('300465', 26002061905563), item: 'repair', period: '2025-12',
        subject: 'Заміна світильників на LED у під’їздах № 1–3 (42 шт.)', amountKop: 987000, number: 'ЕМ-1207', date: '2025-12-12', doc: 'waybill' },
    { key: 'office', name: 'ТОВ «Офіс-Центр Одеса»', kind: 'company', code: edrpou(3725519), iban: iban('305299', 26005052219874), item: 'office', period: '2025-11',
        subject: 'Канцтовари й папір для квитанцій', amountKop: 124560, number: 'ОЦ-8812', date: '2025-11-06', doc: 'waybill' }
];

/** Номер документа за місяць: ЛС-1025 (жовтень 2025). */
export const docNumber = (s, period) => `${s.prefix}-${period.slice(5, 7)}${period.slice(2, 4)}`;
/** Дата документа: останній робочий тиждень місяця. */
export const docDate = period => `${period}-${period.endsWith('-02') ? '27' : '28'}`;
/** Оплата документа — на початку наступного місяця. */
export function nextPeriod(period) {
    const [y, m] = period.split('-').map(Number);
    return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
}

/** Усі документи витрат за місяць (щомісячні + разові) зі сплатою. */
export function monthDocs(period) {
    const list = [];
    for (const s of SUPPLIERS) {
        const amountKop = s.monthly[period];
        if (!amountKop) continue;
        list.push({ supplier: s.key, item: s.item, docType: s.doc, number: docNumber(s, period), date: docDate(period), period, amountKop,
            description: `${s.subject} за ${MONTH_NAMES[Number(period.slice(5, 7)) - 1]} ${period.slice(0, 4)}`, payDate: `${nextPeriod(period)}-${String(3 + (hash(s.key) % 7)).padStart(2, '0')}` });
    }
    for (const o of ONE_OFF.filter(o => o.period === period)) {
        const [y, m, d] = o.date.split('-').map(Number);
        const pay = new Date(Date.UTC(y, m - 1, d + 4)).toISOString().slice(0, 10);
        list.push({ supplier: o.key, item: o.item, docType: o.doc, number: o.number, date: o.date, period, amountKop: o.amountKop, description: o.subject, payDate: pay });
    }
    return list;
}
export const MONTH_NAMES = ['січень', 'лютий', 'березень', 'квітень', 'травень', 'червень', 'липень', 'серпень', 'вересень', 'жовтень', 'листопад', 'грудень'];
export const supplierOf = key => SUPPLIERS.find(s => s.key === key) || ONE_OFF.find(s => s.key === key);

// Надходження, крім внесків.
export const TENANT = { name: 'ТОВ «Кав’ярня на Каштановій»', code: edrpou(4410227), iban: iban('305299', 26007052440118) };
export const PROVIDER = { name: 'ТОВ «Телемережа Південь»', code: edrpou(3690015), iban: iban('300528', 26001001100093) };
export const BANK = { name: 'АТ КБ «ПриватБанк»', code: '14360570' };
