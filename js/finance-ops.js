// ============================================================
// Розшифровка статті витрат: хто й коли отримав гроші ОСББ (як у
// сервісі бухгалтера: «Внесок на обслуговування ліфтів → платежі»).
// Спільне для «Фінансів будинку» мешканця й кошторису в кабінеті;
// так само — надходження (хто заплатив: приміщення чи компанія).
// ============================================================
import { escapeHtml, formatMoney } from './ui.js';

const svg = body => `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
const KIND = {
    company: { icon: svg('<rect x="3" y="7" width="18" height="13" rx="2"/><path d="M9 7V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2M3 13h18"/>'), label: 'Юрособа' },
    fop: { icon: svg('<rect x="3" y="7" width="18" height="13" rx="2"/><path d="M9 7V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2M3 13h18"/>'), label: 'ФОП' },
    person: { icon: svg('<circle cx="12" cy="8" r="4"/><path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6"/>'), label: 'Фізособа' },
    fee: { icon: svg('<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h4"/>'), label: 'Банк' },
    apt: { icon: svg('<path d="M3 11l9-7 9 7"/><path d="M5 10v10h14V10"/><path d="M10 20v-6h4v6"/>'), label: 'Приміщення' }
};
const MONTHS = ['Січень', 'Лютий', 'Березень', 'Квітень', 'Травень', 'Червень', 'Липень', 'Серпень', 'Вересень', 'Жовтень', 'Листопад', 'Грудень'];

const human = date => String(date || '').split('-').reverse().join('.');
export const opsMonthTitle = period => `${MONTHS[Number(period.slice(5, 7)) - 1]} ${period.slice(0, 4)}`;

/** Місяці, за які є операції, новіші першими: ['2026-10', '2026-09', …]. */
export const opsMonths = list => [...new Set((list || []).map(o => String(o.date).slice(0, 7)).filter(Boolean))].sort().reverse();

export const opsTotalKop = list => (list || []).reduce((s, o) => s + (o.amountKop || 0), 0);

/**
 * Список операцій карткою на кожну: дата, отримувач, сума; документ і
 * файли — якщо є. withPurpose — призначення платежу (лише кабінет),
 * income — надходження (зелені значки, як у сервісі).
 */
export function opsListHtml(list, { withPurpose = false, income = false } = {}) {
    if (!list?.length) return '<p class="am-empty">За цей період операцій немає.</p>';
    return `<ul class="fo-list${income ? ' is-income' : ''}">${list.map(o => {
        const k = KIND[o.kind] || KIND.company;
        const note = [o.doc, o.what && (withPurpose || o.doc) ? o.what : '', o.doc && o.paid === false ? 'до оплати' : ''].filter(Boolean).join(' · ');
        return `<li class="fo-op is-${escapeHtml(o.kind || 'company')}">
            <span class="fo-icon" title="${k.label}">${k.icon}</span>
            <span class="fo-main">
                <time datetime="${escapeHtml(o.date)}">${escapeHtml(human(o.date))}</time>
                ${o.who ? `<b class="fo-who">${escapeHtml(o.who)}</b>` : ''}
                <span class="fo-amount">${formatMoney(o.amountKop / 100)}<small> грн</small></span>
                ${note ? `<small class="fo-note">${escapeHtml(note)}</small>` : ''}
                ${(o.files || []).length ? `<span class="hf-files">${o.files.map(f => `<a href="${escapeHtml(f.url)}" target="_blank" rel="noopener">${escapeHtml(f.name)}</a>`).join('')}</span>` : ''}
            </span>
        </li>`;
    }).join('')}</ul>`;
}

/** Фільтр місяців: «Увесь рік» і місяці з операціями. */
export function opsFilterHtml(list, month, attr = 'data-fo-month') {
    const months = opsMonths(list);
    if (months.length < 2) return '';
    const chip = (value, label) => `<button type="button" class="fo-chip${value === month ? ' is-active' : ''}" ${attr}="${value}" aria-pressed="${value === month}">${escapeHtml(label)}</button>`;
    return `<div class="fo-chips" role="group" aria-label="Період">${chip('', 'Увесь рік')}${months.map(m => chip(m, opsMonthTitle(m))).join('')}</div>`;
}

export const opsInMonth = (list, month) => (month ? (list || []).filter(o => String(o.date).startsWith(month)) : list || []);
