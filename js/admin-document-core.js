import { decimalValue } from './meter-core.js';
import { formatMeetingDate, OSBB_DEFAULTS } from './meeting.js';

const clean = value => String(value ?? '').trim();
const money = number => number.toLocaleString('uk-UA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const paragraphs = value => clean(value).split(/\n+/).filter(Boolean).map(text => ({ text, margin: [0, 0, 0, 7] }));

function documentBase(osbb, content) {
    const info = { ...OSBB_DEFAULTS, ...osbb };
    return { pageSize: 'A4', pageMargins: [48, 42, 48, 44],
        defaultStyle: { font: 'Roboto', fontSize: 11, lineHeight: 1.2, color: '#000' },
        content: [
            { text: info.name, alignment: 'center', bold: true, fontSize: 14, margin: [0, 0, 0, 5] },
            { text: `${info.address}\nКод ЄДРПОУ ${info.edrpou}`, alignment: 'center', fontSize: 9, margin: [0, 0, 0, 20] },
            ...content
        ],
        footer: (page, count) => ({ text: `${page} / ${count}`, alignment: 'right', margin: [0, 0, 48, 0], fontSize: 8 })
    };
}

/** Баланс із бази: від’ємний — борг, додатний — переплата. */
export function certificateAccount(apartment, mode = 'auto') {
    const balance = decimalValue(apartment.balance);
    if (balance === null) throw new Error('Баланс квартири ще не внесено або має некоректне значення');
    const account = clean(apartment.personalAccount);
    if (!account) throw new Error('Для квартири ще не внесено особовий рахунок');
    const roundedBalance = Math.sign(balance) * Math.round((Math.abs(balance) + Number.EPSILON) * 100) / 100;
    const debt = Math.max(0, -roundedBalance);
    if (mode === 'clear' && debt > 0) throw new Error('Є заборгованість. Довідку про її відсутність сформувати не можна');
    if (mode === 'debt' && !debt) throw new Error('Заборгованості немає. Оберіть довідку про її відсутність');
    return { balance: roundedBalance, account, debt, type: debt ? 'debt' : 'clear' };
}

export function buildDebtCertificateDoc({ apt, apartment, owners = [], date, number = '', signer = '', position = 'Голова правління', purpose = '' }, osbb) {
    const account = certificateAccount(apartment);
    if (!clean(apt) || !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('Вкажіть квартиру та дату довідки');
    const title = account.type === 'debt' ? 'ДОВІДКА ПРО ЗАБОРГОВАНІСТЬ' : 'ДОВІДКА ПРО ВІДСУТНІСТЬ ЗАБОРГОВАНОСТІ';
    const updated = apartment.balanceUpdatedAt?.toDate?.() || (apartment.balanceUpdatedAt ? new Date(apartment.balanceUpdatedAt) : null);
    const ownerNames = owners.map(owner => clean(owner.name)).filter(Boolean).join('; ');
    return documentBase(osbb, [
        { text: title, alignment: 'center', bold: true, fontSize: 14, margin: [0, 0, 0, 16] },
        { columns: [{ text: `№ ${clean(number) || '________'}` }, { text: formatMeetingDate(date), alignment: 'right' }], margin: [0, 0, 0, 20] },
        { text: `Квартира / приміщення: ${clean(apt)}`, bold: true, margin: [0, 0, 0, 7] },
        ...(ownerNames ? [{ text: `Співвласники: ${ownerNames}`, margin: [0, 0, 0, 7] }] : []),
        { text: `Особовий рахунок: ${account.account}`, margin: [0, 0, 0, 14] },
        { text: account.debt
            ? `За даними обліку ОСББ станом на ${formatMeetingDate(date)} за особовим рахунком квартири / приміщення ${clean(apt)} наявна заборгованість у розмірі ${money(account.debt)} грн.`
            : `За даними обліку ОСББ станом на ${formatMeetingDate(date)} за особовим рахунком квартири / приміщення ${clean(apt)} заборгованість відсутня.`, margin: [0, 0, 0, 14] },
        { table: { widths: ['*', 'auto'], body: [
            ['Особовий рахунок', account.account], ['Баланс особового рахунку, грн', money(account.balance)],
            ['Заборгованість, грн', money(account.debt)],
            ['Переплата, грн', money(Math.max(0, account.balance))]
        ] }, margin: [0, 0, 0, 14] },
        { text: updated && !Number.isNaN(updated.getTime())
            ? `Дата останнього оновлення балансу: ${updated.toLocaleDateString('uk-UA')}.`
            : 'Дата останнього оновлення балансу в обліку не зазначена.', fontSize: 9, margin: [0, 0, 0, 14] },
        { text: clean(purpose) || 'Довідку видано для подання за місцем вимоги.', margin: [0, 0, 0, 28] },
        { text: `${clean(position) || 'Голова правління'}    __________________    ${clean(signer) || '________________________'}` },
        { text: 'М. П. (за наявності)', margin: [0, 12, 0, 0], fontSize: 9 }
    ]);
}

export function buildBoardProtocolDoc(data, osbb) {
    for (const [key, label] of [['number', 'номер'], ['date', 'дату'], ['chair', 'голову засідання'],
        ['secretary', 'секретаря'], ['present', 'присутніх'], ['heard', '«Слухали»'], ['decisions', '«Вирішили»']]) {
        if (!clean(data[key])) throw new Error(`Заповніть ${label} протоколу правління`);
    }
    return documentBase(osbb, [
        { text: `ПРОТОКОЛ № ${clean(data.number)}`, alignment: 'center', fontSize: 15, bold: true },
        { text: 'засідання правління', alignment: 'center', margin: [0, 4, 0, 16], bold: true },
        { text: `${formatMeetingDate(data.date)}${clean(data.location) ? ` · ${clean(data.location)}` : ''}`, margin: [0, 0, 0, 12] },
        { text: `Голова засідання: ${clean(data.chair)}\nСекретар: ${clean(data.secretary)}`, margin: [0, 0, 0, 12] },
        { text: 'Присутні:', bold: true, margin: [0, 0, 0, 6] }, ...paragraphs(data.present),
        { text: 'Слухали:', bold: true, fontSize: 12, margin: [0, 12, 0, 7] }, ...paragraphs(data.heard),
        { text: 'Вирішили:', bold: true, fontSize: 12, margin: [0, 12, 0, 7] }, ...paragraphs(data.decisions),
        { text: `Голова засідання    __________________    ${clean(data.chair)}`, margin: [0, 26, 0, 12] },
        { text: `Секретар    __________________    ${clean(data.secretary)}` }
    ]);
}
