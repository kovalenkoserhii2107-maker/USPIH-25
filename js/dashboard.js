// ============================================================
// Головний дашборд панелі правління.
//
// Показує стан будинку одним поглядом і працює як навігація:
// натиснув плитку — потрапив у потрібну вкладку, а не шукаєш її
// серед шести.
// ============================================================
import { db } from './firebase.js';
import {
    collection, query, where, getCountFromServer, getDocs
} from "https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js";
import { escapeHtml, parseMoney } from './ui.js';
import { fetchDirectory } from './directory.js';
import { pendingChangesCount } from './verify.js';
import { isMeeting, agendaOf, computeQuorum, formatMeetingDate } from './meeting.js';

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

/**
 * Сума для плитки.
 *
 * У рядку зі значком і стрілкою на число лишається ~90px — туди не
 * влазить навіть «12 400 грн». Тому гривні переїхали в підпис плитки,
 * а великі суми стискаються: на дашборді потрібен порядок величини,
 * точна цифра — за один дотик у «Фінансах».
 */
function compactMoney(v) {
    const n = Math.round(v);
    if (n < 100000) return num(n);
    // Поріг перевіряємо ПІСЛЯ округлення до тисяч: 999 999 інакше давало
    // «1000 тис» — формально вірно, читається як помилка.
    const k = Math.round(n / 1000);
    if (k < 1000) return `${num(k)} тис`;
    const m = n / 1000000;
    // Від десяти мільйонів десята частка вже не влазить і нічого не додає
    return m >= 10 ? `${Math.round(m)} млн` : `${m.toFixed(1).replace('.', ',')} млн`;
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
                <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">${ICONS[icon] || ''}</svg>
            </span>
            <span class="dash-value">${value}</span>
            ${CHEVRON}
        </span>
        <span class="dash-label">${escapeHtml(label)}</span>
        ${hint ? `<span class="dash-hint">${escapeHtml(hint)}</span>` : ''}
    </button>`;

export async function loadDashboard() {
    const host = document.getElementById('adminDashboard');
    if (!host) return;

    try {
        // getCountFromServer рахує на сервері й коштує один читок,
        // а не стільки, скільки документів у колекції.
        const [apts, openReqs, activePollsSnap] = await Promise.all([
            // Беремо з довідника, а не окремим запитом.
            //
            // where('isAdmin','==',false) не повертає записи, де цього
            // поля взагалі немає, — а довідник їх показує (isAdmin !== true).
            // Через це дашборд писав «1 квартира», коли в довіднику їх дві.
            // Одне джерело — і розійтися вони більше не можуть.
            fetchDirectory(),
            getCountFromServer(query(collection(db, 'requests'), where('status', 'in', ['new', 'in_progress']))),
            getDocs(query(collection(db, 'polls'), where('status', '==', 'active')))
        ]);

        const aptCount = apts.length;
        const reqCount = openReqs.data().count;
        const activePolls = activePollsSnap.docs.map(d => ({ id: d.id, ...d.data() }));
        const activeMeetings = activePolls.filter(isMeeting);
        const pollCount = activePolls.filter(p => !isMeeting(p)).length;
        const verified = apts.filter(a => a.ownersStatus === 'confirmed').length;
        const verifiedPct = aptCount ? Math.round(verified / aptCount * 100) : 0;
        const changes = pendingChangesCount();
        const ownerCount = apts.reduce((sum, a) => sum + (a.owners?.length || 0), 0);
        const area = apts.reduce((sum, a) => sum + parseMoney(a.area), 0);

        // Заборгованість — теж стан будинку, і правління має бачити її
        // без походу у фінанси. Рахуємо лише мінусові баланси: переплати
        // не гасять чужий борг, і складати їх в одну цифру означало б
        // применшувати проблему.
        const debtors = apts.filter(a => parseMoney(a.balance) < -0.005);
        const debtSum = debtors.reduce((sum, a) => sum - parseMoney(a.balance), 0);

        const current = activeMeetings[0] || null;
        let votes = [];
        if (current) {
            const voteSnap = await getDocs(collection(db, 'polls', current.id, 'votes'));
            votes = voteSnap.docs.map(d => ({ apt: d.id, ...d.data() }));
        }
        const quorum = current ? computeQuorum(votes, apts) : null;
        const agendaCount = current ? agendaOf(current).length : 0;
        const deadline = current?.deadline?.toDate ? current.deadline.toDate()
            : (current?.deadline ? new Date(current.deadline) : null);
        const daysLeft = deadline && !isNaN(deadline)
            ? Math.max(0, Math.ceil((deadline - new Date()) / 86400000)) : null;
        const urgent = [];
        if (current && !current.protocolUrl) urgent.push({
            tone: 'danger', tab: 'meetings', target: '#meetingsActive',
            title: 'Перевірити дані для протоколу', note: 'Підсумки зборів і голосування ще не опубліковані'
        });
        if (changes) urgent.push({
            tone: 'neutral', tab: 'directory', target: '.vf-card',
            title: `Звірити ${changes} ${plural(changes, 'заявку', 'заявки', 'заявок')}`,
            note: 'Зміни у списку співвласників чекають рішення'
        });
        if (reqCount) urgent.push({
            tone: 'neutral', tab: 'requests', target: '.req-item',
            title: `Відповісти на ${reqCount} ${plural(reqCount, 'звернення', 'звернення', 'звернень')}`,
            note: 'Мешканці очікують відповідь правління'
        });

        const metric = (tone, label, value, hint, tab, icon) => `
            <button class="admin-metric metric-${tone}" type="button" data-tab="${tab}">
                <span class="admin-metric-icon">${icon}</span>
                <span class="admin-metric-copy"><small>${escapeHtml(label)}</small><b>${value}</b><span>${escapeHtml(hint)}</span></span>
                ${CHEVRON}
            </button>`;
        const taskRows = urgent.length ? urgent.slice(0, 3).map(item => `
            <button type="button" class="admin-task" data-tab="${item.tab}" data-target="${item.target}">
                <span class="admin-task-mark task-${item.tone}">!</span>
                <span><b>${escapeHtml(item.title)}</b><small>${escapeHtml(item.note)}</small></span>
                ${CHEVRON}
            </button>`).join('') : `<div class="admin-all-clear"><b>Усе під контролем</b><span>Термінових завдань немає</span></div>`;

        const meetingContent = current ? `
            <div class="admin-meeting-head">
                <div><span class="admin-section-kicker">Поточні збори</span>
                    <h2>${escapeHtml(current.title || 'Загальні збори співвласників')}</h2></div>
                <span class="admin-status status-live">Голосування триває</span>
            </div>
            <div class="admin-meeting-meta">
                <span>◷ ${escapeHtml(formatMeetingDate(current.meetingDate) || 'Дата уточнюється')}</span>
                <span>⌖ ${escapeHtml(current.location || 'Місце уточнюється')}</span>
                <span>♙ ${num(ownerCount)} співвласників</span>
                <span>▤ ${agendaCount} ${plural(agendaCount, 'питання', 'питання', 'питань')}</span>
            </div>
            <div class="admin-meeting-rule"></div>
            <div class="admin-meeting-row quorum-row">
                <span class="meeting-row-label">Кворум</span>
                <span class="admin-progress"><i style="width:${Math.min(100, quorum.ownersPct)}%"></i></span>
                <b>${quorum.votedOwners} з ${quorum.totalOwners}</b><strong>${String(quorum.ownersPct).replace('.', ',')}%</strong>
                <small class="meeting-row-note ${quorum.hasQuorum ? 'note-ok' : ''}">${quorum.hasQuorum ? 'Кворум досягнуто. Голосування є правомочним.' : 'Для кворуму потрібно щонайменше 50% голосів.'}</small>
            </div>
            <div class="admin-meeting-row"><span class="meeting-row-label">Кінцевий термін</span>
                <span class="meeting-row-value"><b>${deadline ? deadline.toLocaleString('uk-UA', {day:'numeric', month:'long', year:'numeric', hour:'2-digit', minute:'2-digit'}) : 'Не встановлено'}</b>${daysLeft !== null ? `<small>${daysLeft} ${plural(daysLeft, 'день', 'дні', 'днів')} залишилось</small>` : ''}</span></div>
            <div class="admin-meeting-row"><span class="meeting-row-label">Порядок денний</span>
                <span class="meeting-row-value"><b>${agendaCount} з ${agendaCount} питань підготовлено</b><button data-tab="meetings" data-target="#meetingAgendaList">Переглянути порядок денний →</button></span></div>
            <div class="admin-meeting-row"><span class="meeting-row-label">Статус протоколу</span>
                <span class="meeting-row-value"><span class="admin-status status-review">${current.protocolUrl ? 'Опубліковано' : 'Потребує перевірки'}</span><small>${current.protocolUrl ? 'Протокол доступний співвласникам.' : 'Перевірте результати голосування перед затвердженням.'}</small></span></div>
            <div class="admin-meeting-actions">
                <button type="button" class="btn-primary" data-tab="meetings" data-target="#meetingsActive">Продовжити роботу з протоколом →</button>
                <button type="button" class="btn-secondary" data-tab="meetings" data-target="#meetingsActive">Переглянути результати</button>
            </div>` : `
            <div class="admin-meeting-empty">
                <span class="admin-section-kicker">Загальні збори</span>
                <h2>Активних зборів немає</h2>
                <p>Створіть збори, підготуйте порядок денний і автоматично сформуйте листки голосування та протокол.</p>
                <button type="button" class="btn-primary" data-tab="meetings" data-target="#meetingTitle">Створити загальні збори →</button>
            </div>`;

        host.innerHTML = `
            <div class="admin-metrics">
                ${metric('blue', 'Активні збори', activeMeetings.length, activeMeetings.length ? 'Триває голосування' : 'Немає активних', 'meetings', '♙')}
                ${metric('green', 'Кворум', current ? `${quorum.votedOwners} з ${quorum.totalOwners}` : '—', current ? `${String(quorum.ownersPct).replace('.', ',')}% голосів` : 'Немає зборів', 'meetings', '✓')}
                ${metric('violet', 'Порядок денний', current ? `${agendaCount} з ${agendaCount}` : '—', current ? 'Питань підготовлено' : 'Немає зборів', 'meetings', '▤')}
                ${metric('amber', 'Кінцевий термін', deadline ? deadline.toLocaleDateString('uk-UA') : '—', daysLeft !== null ? `${daysLeft} ${plural(daysLeft, 'день', 'дні', 'днів')} залишилось` : 'Не встановлено', 'meetings', '◷')}
            </div>
            <div class="admin-focus-grid">
                <section class="admin-meeting-card">${meetingContent}</section>
                <aside class="admin-tasks-card">
                    <div class="admin-tasks-head"><h2>Термінові завдання</h2><span>${urgent.length}</span></div>
                    ${taskRows}
                    <button type="button" class="admin-all-tasks" data-tab="requests">Усі завдання →</button>
                </aside>
            </div>
            <div class="admin-house-strip"><span><b>${num(aptCount)}</b> квартир</span><span><b>${num(ownerCount)}</b> співвласників</span><span><b>${verifiedPct}%</b> списків звірено</span><button data-tab="finance"><b>${compactMoney(debtSum)} грн</b> заборгованості →</button></div>`;

        host.querySelectorAll('[data-tab]').forEach(el => {
            el.addEventListener('click', () => openTab(el.dataset.tab, el.dataset.target));
        });
    } catch (e) {
        console.error('Дашборд:', e);
        host.innerHTML = '<p class="list-empty">Не вдалося завантажити зведення</p>';
    }
}
