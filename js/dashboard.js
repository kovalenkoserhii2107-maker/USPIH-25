// ============================================================
// Головний дашборд панелі правління.
//
// Показує стан будинку одним поглядом і працює як навігація:
// натиснув плитку — потрапив у потрібну вкладку, а не шукаєш її
// серед шести.
// ============================================================
import { db } from './firebase.js';
import {
    collection, query, where, getCountFromServer
} from "https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js";
import { escapeHtml, parseMoney } from './ui.js';
import { fetchDirectory } from './directory.js';
import { pendingChangesCount } from './verify.js';
import { loadExpenses } from './finance.js';

/** Перемикає вкладку адмінки, повторно використовуючи звичайний клік. */
function openTab(name, scrollToSelector) {
    const tab = document.querySelector(`.admin-tab[data-tab="${name}"]`);
    if (!tab) return;
    tab.click();

    // Даємо панелі проявитись, і аж тоді шукаємо, куди везти
    setTimeout(() => {
        const target = scrollToSelector ? document.querySelector(scrollToSelector) : null;

        // Ціль може лежати у згорнутому блоці — тоді вона має нульову
        // висоту, і прокрутка до неї нічого не показує. Розгортаємо й
        // чекаємо на анімацію, інакше рахуватимемо позицію по старій.
        const fold = target?.closest('.admin-fold');
        const opened = fold && !fold.classList.contains('open');
        if (opened) {
            fold.classList.add('open');
            fold.querySelector('.admin-card-toggle')?.setAttribute('aria-expanded', 'true');
        }

        // Немає конкретної цілі (нічого не чекає рішення, розділ порожній) —
        // везе принаймні до самої вкладки. Інакше після натискання екран
        // лишався на місці, і здавалося, що кнопка не спрацювала.
        const where = target || document.getElementById('adminTabs');
        const go = () => where?.scrollIntoView({
            behavior: 'smooth', block: target ? 'center' : 'start'
        });
        if (opened) setTimeout(go, 360); else go();
    }, 220);
}

/** Українська множина: 1 квартира, 2 квартири, 5 квартир. */
function plural(n, one, few, many) {
    const m10 = n % 10, m100 = n % 100;
    if (m10 === 1 && m100 !== 11) return one;
    if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
    return many;
}

const ADDRESS = 'вул. Інглезі, 3/3 · м. Одеса';

const num = (v) => new Intl.NumberFormat('uk-UA').format(v);

const CHEVRON = '<svg class="dash-go" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"></polyline></svg>';

// Значок читається швидше за підпис і робить плитки різними на вигляд —
// без нього чотири однакові прямокутники доводиться перечитувати щоразу.
const ICONS = {
    owners: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"></path><circle cx="9" cy="7" r="4"></circle><polyline points="16 11 18 13 22 9"></polyline>',
    requests: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>',
    polls: '<line x1="18" y1="20" x2="18" y2="10"></line><line x1="12" y1="20" x2="12" y2="4"></line><line x1="6" y1="20" x2="6" y2="14"></line>',
    debt: '<rect x="2" y="5" width="20" height="14" rx="2"></rect><line x1="2" y1="10" x2="22" y2="10"></line>'
};

/** Мільйонні суми в плитку не влазять — там точність до гривні й не потрібна. */
function compactMoney(v) {
    const n = Math.round(v);
    if (n >= 1000000) return `${(n / 1000000).toFixed(2).replace('.', ',')} млн`;
    return num(n);
}

/**
 * Картка будинку — те, чим правління розпоряджається.
 *
 * Раніше дашборд складався лише з плиток «що зробити». Але перше,
 * що має бачити правління, — сам будинок: скільки квартир, скільки
 * співвласників, скільки площі. Це не заклик до дії, а опора, з
 * якою решта цифр набуває сенсу.
 */
function houseCard({ aptCount, ownerCount, area, verified }) {
    const pct = aptCount ? Math.round(verified / aptCount * 100) : 0;
    const left = aptCount - verified;
    const done = aptCount > 0 && left === 0;
    const fact = (value, label) => `<span class="dash-fact">
        <b>${value}</b><small>${escapeHtml(label)}</small>
    </span>`;

    return `<div class="dash-house">
        <div class="dash-house-head">
            <span class="dash-house-name">ОСББ «Успіх-25»</span>
            <span class="dash-house-addr">${escapeHtml(ADDRESS)}</span>
        </div>

        <button type="button" class="dash-facts" data-tab="directory">
            ${fact(num(aptCount), plural(aptCount, 'квартира', 'квартири', 'квартир'))}
            ${fact(num(ownerCount), plural(ownerCount, 'співвласник', 'співвласники', 'співвласників'))}
            ${fact(area ? num(Math.round(area)) : '—', 'м² житла')}
        </button>

        <button type="button" class="dash-cover${done ? ' is-done' : ''}"
                data-tab="directory" data-target=".vf-cover">
            <span class="dash-cover-top">
                <span class="dash-cover-title">Списки власників звірено</span>
                <b class="dash-cover-pct">${pct}%</b>
            </span>
            <span class="dash-bar"><i style="width:${pct}%"></i></span>
            <span class="dash-cover-note">
                <span>${verified} із ${aptCount} ${plural(aptCount, 'квартири', 'квартир', 'квартир')}${
                    done ? '' : ` · ${left} ще не ${plural(left, 'підтвердила', 'підтвердили', 'підтвердили')}`}</span>
                ${CHEVRON}
            </span>
        </button>
    </div>`;
}

const tile = ({ id, label, value, hint, tone, tab, target, icon }) => `
    <button type="button" class="dash-tile dash-${tone}" id="${id}"
            data-tab="${tab}"${target ? ` data-target="${target}"` : ''}>
        <span class="dash-tile-top">
            <span class="dash-icon">
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONS[icon] || ''}</svg>
            </span>
            ${CHEVRON}
        </span>
        <span class="dash-value">${value}</span>
        <span class="dash-label">${escapeHtml(label)}</span>
        ${hint ? `<span class="dash-hint">${escapeHtml(hint)}</span>` : ''}
    </button>`;

export async function loadDashboard() {
    const host = document.getElementById('adminDashboard');
    if (!host) return;

    try {
        // getCountFromServer рахує на сервері й коштує один читок,
        // а не стільки, скільки документів у колекції.
        const [apts, openReqs, activePolls] = await Promise.all([
            // Беремо з довідника, а не окремим запитом.
            //
            // where('isAdmin','==',false) не повертає записи, де цього
            // поля взагалі немає, — а довідник їх показує (isAdmin !== true).
            // Через це дашборд писав «1 квартира», коли в довіднику їх дві.
            // Одне джерело — і розійтися вони більше не можуть.
            fetchDirectory(),
            getCountFromServer(query(collection(db, 'requests'), where('status', 'in', ['new', 'in_progress']))),
            getCountFromServer(query(collection(db, 'polls'), where('status', '==', 'active')))
        ]);

        const aptCount = apts.length;
        const reqCount = openReqs.data().count;
        const pollCount = activePolls.data().count;
        const verified = apts.filter(a => a.ownersStatus === 'confirmed').length;
        const changes = pendingChangesCount();
        const ownerCount = apts.reduce((sum, a) => sum + (a.owners?.length || 0), 0);
        const area = apts.reduce((sum, a) => sum + parseMoney(a.area), 0);

        // Заборгованість — теж стан будинку, і правління має бачити її
        // без походу у фінанси. Рахуємо лише мінусові баланси: переплати
        // не гасять чужий борг, і складати їх в одну цифру означало б
        // применшувати проблему.
        const debtors = apts.filter(a => parseMoney(a.balance) < -0.005);
        const debtSum = debtors.reduce((sum, a) => sum - parseMoney(a.balance), 0);

        host.innerHTML = houseCard({ aptCount, ownerCount, area, verified }) + `
            <div class="dash-grid">
                ${tile({ icon: 'owners', id: 'dashOwners', label: 'Заявок на звірку', value: changes,
                         hint: changes ? 'Чекають рішення' : (verified < aptCount ? 'Нагадайте решті' : 'Усе звірено'),
                         tone: changes ? 'warn' : (verified < aptCount ? 'info' : 'ok'),
                         tab: 'directory', target: changes ? '.vf-card' : '.vf-cover' })}
                ${tile({ icon: 'requests', id: 'dashReqs', label: 'Звернень у роботі', value: reqCount,
                         hint: reqCount ? 'Потребують відповіді' : 'Усе опрацьовано',
                         tone: reqCount ? 'warn' : 'ok', tab: 'requests',
                         target: '.req-item' })}
                ${tile({ icon: 'polls', id: 'dashPolls', label: 'Активних голосувань', value: pollCount,
                         hint: pollCount ? 'Триває' : 'Немає активних',
                         tone: pollCount ? 'info' : 'neutral', tab: 'polls',
                         target: '.poll-card-admin' })}
                ${tile({ icon: 'debt', id: 'dashDebt', label: 'Заборгованість', value: `${compactMoney(debtSum)}<small>грн</small>`,
                         hint: debtors.length
                             ? `${debtors.length} ${plural(debtors.length, 'квартира', 'квартири', 'квартир')} у мінусі`
                             : 'Боргів немає',
                         tone: debtors.length ? 'warn' : 'ok', tab: 'finance',
                         target: '#balanceBulk' })}
            </div>
            <div id="adminBudgetHost"></div>`;

        // Той самий звіт, що бачить мешканець. Правління має дивитися на
        // те саме, що й будинок, — інакше воно не помітить, що звіт
        // застарів або показує не те.
        loadExpenses('adminBudgetHost');

        host.querySelectorAll('[data-tab]').forEach(el => {
            el.addEventListener('click', () => openTab(el.dataset.tab, el.dataset.target));
        });
    } catch (e) {
        console.error('Дашборд:', e);
        host.innerHTML = '<p class="list-empty">Не вдалося завантажити зведення</p>';
    }
}
