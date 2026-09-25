// ============================================================
// Головний дашборд панелі правління.
//
// Показує стан будинку одним поглядом і працює як навігація:
// натиснув плитку — потрапив у потрібну вкладку, а не шукаєш її
// серед шести.
// ============================================================
import { db } from './firebase.js';
import {
    collection, collectionGroup, doc, query, where, getCountFromServer, getDoc, getDocs
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { escapeHtml, parseMoney } from './ui.js';
import { fetchDirectory } from './directory.js';
import { isMeeting, agendaOf, computeQuorum } from './meeting.js';

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

const num = (v) => new Intl.NumberFormat('uk-UA').format(v);

const CHEVRON = '<svg class="dash-go" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"></polyline></svg>';

export async function loadDashboard() {
    const host = document.getElementById('adminDashboard');
    if (!host) return;

    try {
        const [apts, newReqsSnap, workReqsSnap, activePollsSnap, financeSnap, changesSnap] = await Promise.all([
            fetchDirectory(),
            getCountFromServer(query(collection(db, 'requests'), where('status', '==', 'new'))),
            getCountFromServer(query(collection(db, 'requests'), where('status', '==', 'in_progress'))),
            getDocs(query(collection(db, 'polls'), where('status', '==', 'active'))),
            getDoc(doc(db, 'finance', 'current')),
            getCountFromServer(query(collectionGroup(db, 'owner_changes'), where('status', '==', 'pending')))
        ]);

        const aptCount = apts.length;
        const newReqCount = newReqsSnap.data().count;
        const workReqCount = workReqsSnap.data().count;
        const reqCount = newReqCount + workReqCount;
        const activePolls = activePollsSnap.docs.map(d => ({ id: d.id, ...d.data() }));
        const activeMeetings = activePolls.filter(isMeeting);
        const verified = apts.filter(a => a.ownersStatus === 'confirmed').length;
        const verifiedPct = aptCount ? Math.round(verified / aptCount * 100) : 0;
        const verificationLeft = Math.max(0, aptCount - verified);
        const changes = changesSnap.data().count;
        const debtors = apts.filter(a => parseMoney(a.balance) < -0.005);
        const debtSum = debtors.reduce((sum, a) => sum - parseMoney(a.balance), 0);

        const finance = financeSnap.exists() ? financeSnap.data() : {};
        const money = (value) => (value === undefined || value === null || value === '')
            ? null : parseMoney(value);
        const income = money(finance.income);
        const spent = (finance.items || []).reduce((sum, item) => sum + parseMoney(item.amount), 0);
        const funds = money(finance.funds);
        const spentShare = income && income > 0 ? Math.min(100, Math.round(spent / income * 100)) : 0;
        const moneyText = (value) => value === null ? '—' : `${num(Math.round(value))} грн`;

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

        const taskRows = urgent.length ? urgent.slice(0, 3).map(item => `
            <button type="button" class="admin-task" data-tab="${item.tab}" data-target="${item.target}">
                <span class="admin-task-mark task-${item.tone}">!</span>
                <span><b>${escapeHtml(item.title)}</b><small>${escapeHtml(item.note)}</small></span>
                ${CHEVRON}
            </button>`).join('') : `<div class="admin-all-clear"><b>Усе під контролем</b><span>Термінових завдань немає</span></div>`;

        const meetingContent = current ? `
            <div class="overview-card-head">
                <div><span class="overview-kicker">Активні збори</span><h2>${escapeHtml(current.title || 'Загальні збори співвласників')}</h2></div>
                <span class="admin-status status-live">Тривають</span>
            </div>
            <div class="overview-meeting-stats">
                <span><b>${String(quorum.ownersPct).replace('.', ',')}%</b><small>кворум</small></span>
                <span><b>${agendaCount}</b><small>${plural(agendaCount, 'питання', 'питання', 'питань')}</small></span>
                <span><b>${daysLeft === null ? '—' : daysLeft}</b><small>${daysLeft === 1 ? 'день лишився' : 'днів лишилось'}</small></span>
            </div>
            <button type="button" class="overview-link" data-tab="meetings" data-target="#meetingsActive">Продовжити роботу ${CHEVRON}</button>` : `
            <div class="overview-card-head"><div><span class="overview-kicker">Загальні збори</span><h2>Активних зборів немає</h2></div></div>
            <p class="overview-empty-copy">Підготуйте порядок денний, голосування та протокол в одному процесі.</p>
            <button type="button" class="overview-link" data-tab="meetings" data-target="#meetingTitle">Створити збори ${CHEVRON}</button>`;

        host.innerHTML = `
            <div class="admin-overview-head">
                <div><span class="overview-kicker">Огляд будинку</span><h2>Що потребує уваги сьогодні</h2></div>
                <span class="overview-updated">Оновлено щойно</span>
            </div>
            <div class="overview-status-grid">
                <section class="overview-card overview-data-card">
                    <div class="overview-card-head"><div><span class="overview-kicker">Оновлення даних</span><h2>${verified} з ${aptCount} квартир</h2></div><span class="overview-percent">${verifiedPct}%</span></div>
                    <div class="overview-progress" role="progressbar" aria-label="Звірено квартир" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${verifiedPct}"><i style="width:${verifiedPct}%"></i></div>
                    <p>${verificationLeft ? `${verificationLeft} ${plural(verificationLeft, 'квартира потребує', 'квартири потребують', 'квартир потребують')} перевірки` : 'Усі квартири перевірено'}${changes ? ` · ${changes} змін очікують рішення` : ''}</p>
                    <button type="button" class="overview-link" data-tab="directory" data-target=".vf-cover">Продовжити звірку ${CHEVRON}</button>
                </section>
                <section class="overview-card overview-requests-card">
                    <div class="overview-card-head"><div><span class="overview-kicker">Звернення мешканців</span><h2>${reqCount} відкритих</h2></div></div>
                    <div class="overview-request-values"><span class="is-new"><b>${newReqCount}</b><small>нові</small></span><span><b>${workReqCount}</b><small>у роботі</small></span></div>
                    <button type="button" class="overview-link" data-tab="requests" data-target=".req-item">Опрацювати звернення ${CHEVRON}</button>
                </section>
            </div>
            <section class="overview-finance-card">
                <div class="overview-finance-head"><div><span class="overview-kicker">Фінанси ОСББ</span><h2>${escapeHtml(finance.period || 'Поточний період')}</h2></div><button type="button" class="overview-link" data-tab="finance">Відкрити фінанси ${CHEVRON}</button></div>
                <div class="overview-finance-body">
                    <div class="overview-balance"><small>Залишок на рахунку</small><strong>${moneyText(funds)}</strong><span>${finance.fundsDate ? `Станом на ${escapeHtml(finance.fundsDate)}` : 'За останньою внесеною випискою'}</span></div>
                    <div class="overview-finance-metrics">
                        <div class="finance-stat is-income"><small>Надходження</small><b>${moneyText(income)}</b></div>
                        <div class="finance-stat is-expense"><small>Витрати</small><b>${moneyText(spent)}</b></div>
                        <div class="finance-stat is-debt"><small>Заборгованість</small><b>${moneyText(debtSum)}</b><span>${debtors.length} ${plural(debtors.length, 'квартира', 'квартири', 'квартир')}</span></div>
                    </div>
                </div>
                ${income !== null ? `<div class="overview-finance-ratio"><span>Витрачено ${spentShare}% надходжень</span><div class="overview-progress"><i style="width:${spentShare}%"></i></div></div>` : ''}
            </section>
            <div class="overview-lower-grid">
                <section class="overview-card overview-meeting-card">${meetingContent}</section>
                <aside class="overview-card overview-tasks-card">
                    <div class="admin-tasks-head"><h2>Термінові завдання</h2><span>${urgent.length}</span></div>
                    ${taskRows}
                    <button type="button" class="admin-all-tasks" data-tab="requests">Усі завдання →</button>
                </aside>
            </div>`;

        host.querySelectorAll('[data-tab]').forEach(el => {
            el.addEventListener('click', () => openTab(el.dataset.tab, el.dataset.target));
        });
    } catch (e) {
        console.error('Дашборд:', e);
        host.innerHTML = '<p class="list-empty">Не вдалося завантажити зведення</p>';
    }
}
