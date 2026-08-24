// ============================================================
// Головний дашборд панелі правління.
//
// Показує стан будинку одним поглядом і працює як навігація:
// натиснув плитку — потрапив у потрібну вкладку, а не шукаєш її
// серед шести.
// ============================================================
import { db } from './firebase.js';
import {
    collection, query, where, orderBy, limit, getDocs, getCountFromServer
} from "https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js";
import { escapeHtml, formatDateTime, parseMoney } from './ui.js';
import { fetchDirectory } from './directory.js';
import { pendingChangesCount } from './verify.js';

/** Перемикає вкладку адмінки, повторно використовуючи звичайний клік. */
function openTab(name, scrollToSelector) {
    const tab = document.querySelector(`.admin-tab[data-tab="${name}"]`);
    if (!tab) return;
    tab.click();
    if (!scrollToSelector) return;
    // Даємо панелі проявитись, і аж тоді прокручуємо до потрібного місця
    setTimeout(() => {
        document.querySelector(scrollToSelector)
            ?.scrollIntoView({ behavior: 'smooth', block: 'center' });
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
        <div class="dash-cover">
            <div class="dash-cover-top">
                <span>Списки власників звірено</span>
                <b>${verified} із ${aptCount}</b>
            </div>
            <div class="vf-bar"><i style="width:${pct}%"></i></div>
        </div>
    </div>`;
}

const tile = ({ id, label, value, hint, tone, tab, target }) => `
    <button type="button" class="dash-tile dash-${tone}" id="${id}"
            data-tab="${tab}"${target ? ` data-target="${target}"` : ''}>
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
        const [apts, openReqs, activePolls, lastMsgSnap] = await Promise.all([
            // Беремо з довідника, а не окремим запитом.
            //
            // where('isAdmin','==',false) не повертає записи, де цього
            // поля взагалі немає, — а довідник їх показує (isAdmin !== true).
            // Через це дашборд писав «1 квартира», коли в довіднику їх дві.
            // Одне джерело — і розійтися вони більше не можуть.
            fetchDirectory(),
            getCountFromServer(query(collection(db, 'requests'), where('status', 'in', ['new', 'in_progress']))),
            getCountFromServer(query(collection(db, 'polls'), where('status', '==', 'active'))),
            getDocs(query(collection(db, 'messages'), orderBy('createdAt', 'desc'), limit(1)))
        ]);

        const aptCount = apts.length;
        const reqCount = openReqs.data().count;
        const pollCount = activePolls.data().count;
        const lastMsg = lastMsgSnap.empty ? null : lastMsgSnap.docs[0].data();
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
                ${tile({ id: 'dashOwners', label: 'Заявок на звірку', value: changes,
                         hint: changes ? 'Чекають рішення' : (verified < aptCount ? 'Нагадайте решті' : 'Усе звірено'),
                         tone: changes ? 'warn' : (verified < aptCount ? 'info' : 'ok'),
                         tab: 'directory', target: '.vf-card' })}
                ${tile({ id: 'dashReqs', label: 'Звернень у роботі', value: reqCount,
                         hint: reqCount ? 'Потребують відповіді' : 'Усе опрацьовано',
                         tone: reqCount ? 'warn' : 'ok', tab: 'requests',
                         target: '.req-item' })}
                ${tile({ id: 'dashPolls', label: 'Активних голосувань', value: pollCount,
                         hint: pollCount ? 'Триває' : 'Немає активних',
                         tone: pollCount ? 'info' : 'neutral', tab: 'polls',
                         target: '.poll-card-admin' })}
                ${tile({ id: 'dashDebt', label: 'Заборгованість', value: `${compactMoney(debtSum)}<small>грн</small>`,
                         hint: debtors.length
                             ? `${debtors.length} ${plural(debtors.length, 'квартира', 'квартири', 'квартир')} у мінусі`
                             : 'Боргів немає',
                         tone: debtors.length ? 'warn' : 'ok', tab: 'finance' })}
            </div>
            <button type="button" class="dash-last" id="dashLastMsg" data-tab="history">
                <span class="dash-last-label">Остання розсилка</span>
                ${lastMsg
                    ? `<span class="dash-last-title">${escapeHtml(lastMsg.title)}</span>
                       <span class="dash-last-date">${formatDateTime(lastMsg.createdAt)}</span>`
                    : '<span class="dash-last-title dash-last-empty">Ще нічого не надсилали</span>'}
                <svg class="row-chevron" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"></polyline></svg>
            </button>`;

        host.querySelectorAll('[data-tab]').forEach(el => {
            el.addEventListener('click', () => openTab(el.dataset.tab, el.dataset.target));
        });
    } catch (e) {
        console.error('Дашборд:', e);
        host.innerHTML = '<p class="list-empty">Не вдалося завантажити зведення</p>';
    }
}
