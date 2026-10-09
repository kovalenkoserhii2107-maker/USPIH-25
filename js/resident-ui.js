// Спільні дрібниці екранів мешканця «Мої лічильники» та «Фінанси будинку»:
// назви місяців, іконки й компактний графік за місяцями.
import { escapeHtml } from './ui.js';

export const MONTHS_SHORT = ['січ', 'лют', 'бер', 'кві', 'тра', 'чер', 'лип', 'сер', 'вер', 'жов', 'лис', 'гру'];

export const ICONS = {
    check: '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>',
    trash: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"></path><path d="M10 11v6M14 11v6"></path><path d="M9 6V4h6v2"></path></svg>',
    plus: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>',
    chevron: '<svg class="am-chevron" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"></polyline></svg>',
    down: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"></line><polyline points="19 12 12 19 5 12"></polyline></svg>',
    up: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="19" x2="12" y2="5"></line><polyline points="5 12 12 5 19 12"></polyline></svg>'
};

const capitalize = text => text.charAt(0).toUpperCase() + text.slice(1);
const monthDate = value => new Date(`${value}-01T12:00:00`);
/** «Жовтень 2026» — заголовок і рядки історії. */
export const monthTitle = value => capitalize(`${monthDate(value).toLocaleDateString('uk-UA', { month: 'long' })} ${value.slice(0, 4)}`);
/** «у вересні»: місцевий відмінок збігається з родовим лише в закінченні, тож тримаємо таблицю. */
const MONTHS_LOCATIVE = ['січні', 'лютому', 'березні', 'квітні', 'травні', 'червні', 'липні', 'серпні', 'вересні', 'жовтні', 'листопаді', 'грудні'];
export const monthLocative = value => MONTHS_LOCATIVE[Number(value.slice(5, 7)) - 1];
/** «до вересня» */
const MONTHS_GENITIVE = ['січня', 'лютого', 'березня', 'квітня', 'травня', 'червня', 'липня', 'серпня', 'вересня', 'жовтня', 'листопада', 'грудня'];
export const monthGenitive = value => MONTHS_GENITIVE[Number(value.slice(5, 7)) - 1];
export function shiftMonth(value, delta) {
    const date = monthDate(value); date.setMonth(date.getMonth() + delta);
    return date.toLocaleDateString('sv-SE').slice(0, 7);
}

/** Один ряд — один колір ресурсу; виділено обраний місяць, підписано лише його. */
export function chartHtml(items, color, describe, selected) {
    if (items.length < 2) return '';
    const max = Math.max(...items.map(item => item.value), 0) || 1;
    return `<div class="am-chart" style="--am-color:${color}" role="group" aria-label="Графік за місяцями. Торкніться стовпчика, щоб відкрити місяць">${items.map(item => {
        const height = item.value > 0 ? Math.max(4, item.value / max * 100) : 0;
        return `<button type="button" class="am-bar${item.period === selected ? ' is-current' : ''}" data-am-period="${item.period}" aria-label="${escapeHtml(monthTitle(item.period))}: ${escapeHtml(describe(item.value))}">
            <span class="am-bar-track"><span class="am-bar-value">${escapeHtml(describe(item.value, true))}</span><i style="height:calc((100% - 18px) * ${height / 100})"></i></span>
            <span class="am-bar-month">${MONTHS_SHORT[Number(item.period.slice(5, 7)) - 1]}</span></button>`;
    }).join('')}</div>`;
}
