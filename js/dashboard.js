// ============================================================
// «Сьогодні» панелі правління — як у бухгалтерії: що зробити
// (заявки, звернення, протокол, звірка), поруч — збори й гроші на
// рахунку, нижче — надходження, витрати й борги. Кожна картка веде
// у свій розділ.
// ============================================================
import { db } from './firebase.js';
import {
    collection, collectionGroup, doc, query, where, getCountFromServer, getDoc, getDocs
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { escapeHtml, parseMoney } from './ui.js';
import { fetchDirectory } from './directory.js';
import { isMeeting, agendaOf, computeQuorum } from './meeting.js';
import { meterStore } from './meter-store.js';
import { revealSection } from './admin-shell.js';

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
        revealSection(target);
        const fold = target?.closest('.admin-fold');
        const opened = fold && !fold.classList.contains('open');
        if (opened) {
            fold.classList.add('open');
            fold.querySelector('.admin-card-toggle')?.setAttribute('aria-expanded', 'true');
        }

        // Немає конкретної цілі (нічого не чекає рішення, розділ порожній) —
        // везе принаймні до самої вкладки. Інакше після натискання екран
        // лишався на місці, і здавалося, що кнопка не спрацювала.
        const go = () => target
            ? target.scrollIntoView({ behavior: 'smooth', block: 'center' })
            : window.scrollTo({ top: 0, behavior: 'smooth' });
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

export async function loadDashboard() {
    const host = document.getElementById('adminDashboard');
    if (!host) return;

    try {
        // Кожен блок завантажується незалежно. Раніше відмова одного
        // необов'язкового запиту (наприклад, ще не готовий індекс заявок
        // співвласників) ховала весь дашборд разом із уже отриманими даними.
        const labels = ['квартири', 'нові звернення', 'звернення в роботі', 'збори', 'фінанси', 'зміни співвласників'];
        const results = await Promise.allSettled([
            fetchDirectory(),
            getCountFromServer(query(collection(db, 'requests'), where('status', '==', 'new')))
                .then(s => s.data().count),
            getCountFromServer(query(collection(db, 'requests'), where('status', '==', 'in_progress')))
                .then(s => s.data().count),
            getDocs(query(collection(db, 'polls'), where('status', '==', 'active')))
                .then(s => s.docs.map(d => ({ id: d.id, ...d.data() }))),
            getDoc(doc(db, 'finance', 'current'))
                .then(s => s.exists() ? s.data() : {}),
            getCountFromServer(query(collectionGroup(db, 'owner_changes'), where('status', '==', 'pending')))
                .then(s => s.data().count)
        ]);

        const unavailable = [];
        results.forEach((result, index) => {
            if (result.status === 'rejected') {
                unavailable.push(labels[index]);
                console.warn(`Дашборд: не завантажено ${labels[index]}`, result.reason);
            }
        });
        const value = (index, fallback) => results[index].status === 'fulfilled'
            ? results[index].value : fallback;

        const apts = value(0, []);
        const newReqCount = value(1, null);
        const workReqCount = value(2, null);
        const activePolls = value(3, []);
        const finance = value(4, {});
        const changes = value(5, null);
        const directoryReady = results[0].status === 'fulfilled';
        // Довідник уже прочитаний: оновлюємо публічну суму площ у фоні,
        // без повторного завантаження квартир і без затримки дашборду.
        if (directoryReady) meterStore.syncTotalArea(apts)
            .catch(error => console.warn('Загальна площа будинку:', error));
        const requestsReady = results[1].status === 'fulfilled' && results[2].status === 'fulfilled';
        const pollsReady = results[3].status === 'fulfilled';
        const financeReady = results[4].status === 'fulfilled';

        const aptCount = apts.length;
        const reqCount = (newReqCount || 0) + (workReqCount || 0);
        const activeMeetings = activePolls.filter(isMeeting);
        const verified = apts.filter(a => a.ownersStatus === 'confirmed').length;
        const verificationLeft = Math.max(0, aptCount - verified);
        const debtors = apts.filter(a => parseMoney(a.balance) < -0.005);
        const debtSum = debtors.reduce((sum, a) => sum - parseMoney(a.balance), 0);

        const money = (value) => (value === undefined || value === null || value === '')
            ? null : parseMoney(value);
        const income = money(finance.income);
        const spent = (finance.items || []).reduce((sum, item) => sum + parseMoney(item.amount), 0);
        const funds = money(finance.funds);
        const spentShare = income > 0 && spent >= 0 ? Math.round(spent / income * 100) : null;
        const moneyText = (value) => value === null ? '—' : `${num(Math.round(value))} грн`;

        const current = activeMeetings[0] || null;
        let votes = [];
        let votesReady = true;
        if (current) {
            try {
                const voteSnap = await getDocs(collection(db, 'polls', current.id, 'votes'));
                votes = voteSnap.docs.map(d => ({ apt: d.id, ...d.data() }));
            } catch (error) {
                votesReady = false;
                unavailable.push('голоси зборів');
                console.warn('Дашборд: не завантажено голоси зборів', error);
            }
        }
        const quorum = current && votesReady && directoryReady ? computeQuorum(votes, apts) : null;
        const agendaCount = current ? agendaOf(current).length : 0;
        const deadline = current?.deadline?.toDate ? current.deadline.toDate()
            : (current?.deadline ? new Date(current.deadline) : null);
        const daysLeft = deadline && !isNaN(deadline)
            ? Math.max(0, Math.ceil((deadline - new Date()) / 86400000)) : null;

        // Справи — як «Що зробити» в бухгалтерії: число, що зробити, звідки, куди перейти.
        const tasks = [];
        if (changes) tasks.push({ count: changes, hot: true, tab: 'directory', target: '.vf-card',
            title: 'Зміни співвласників', note: `${plural(changes, 'заявка чекає', 'заявки чекають', 'заявок чекають')} вашого рішення` });
        if (requestsReady && newReqCount) tasks.push({ count: newReqCount, hot: true, tab: 'requests', target: '.req-item',
            title: 'Нові звернення', note: 'Мешканці чекають відповіді правління' });
        if (requestsReady && workReqCount) tasks.push({ count: workReqCount, tab: 'requests', target: '.req-item',
            title: 'Звернення в роботі', note: 'Повідомте мешканцям, коли буде виконано' });
        if (current && !current.protocolUrl) tasks.push({ count: 1, hot: true, tab: 'meetings', target: '#meetingsActive',
            title: 'Протокол зборів', note: 'Підсумки голосування ще не опубліковані' });
        if (directoryReady && verificationLeft) tasks.push({ count: verificationLeft, tab: 'directory', target: '.vf-cover',
            title: 'Звірити квартири', note: `${verified} з ${aptCount} уже звірено — решта чекає перевірки` });
        const total = tasks.reduce((sum, t) => sum + t.count, 0);
        const go = (tab, target) => `data-tab="${tab}"${target ? ` data-target="${target}"` : ''}`;

        const meetingCard = current ? `
            <button type="button" class="sv-card td-deadline" ${go('meetings', '#meetingsActive')}>
                <span class="td-label">Загальні збори тривають</span>
                <b class="td-big">${quorum ? `${String(quorum.ownersPct).replace('.', ',')}%` : '—'}</b>
                <span class="td-small">кворум · ${agendaCount} ${plural(agendaCount, 'питання', 'питання', 'питань')}${daysLeft === null ? '' : ` · ${daysLeft === 0 ? 'останній день' : `ще ${daysLeft} дн.`}`} ›</span>
            </button>` : `
            <button type="button" class="sv-card" ${go('meetings', pollsReady ? '#meetingTitle' : '')}>
                <span class="td-label">Загальні збори</span>
                <b class="td-mid">${pollsReady ? 'Немає активних' : 'Оновлюються'}</b>
                <span class="td-small">${pollsReady ? 'Порядок денний, голосування й протокол — в одному процесі ›' : 'Спробуйте оновити екран ›'}</span>
            </button>`;

        host.innerHTML = `
            ${unavailable.length ? `<div class="overview-partial" role="status">Частина даних тимчасово недоступна. Показуємо все, що вдалося завантажити.</div>` : ''}
            <div class="td-grid">
                <section class="sv-card td-tasks" aria-label="Що зробити">
                    <div class="sv-card-head"><h2>Що зробити</h2><span>${total ? `${total} ${plural(total, 'справа', 'справи', 'справ')}` : ''}</span></div>
                    ${tasks.length ? `<ul class="td-list">${tasks.map(t => `<li>
                        <button type="button" class="td-task" ${go(t.tab, t.target)}>
                            <span class="td-count${t.hot ? ' is-hot' : ''}">${t.count}</span>
                            <span class="td-copy"><b>${escapeHtml(t.title)}</b><small>${escapeHtml(t.note)}</small></span>
                            <span class="td-sum"></span>
                            <span class="td-chev" aria-hidden="true">›</span>
                        </button></li>`).join('')}</ul>`
                    : '<div class="td-clear"><b>Усе вирішено</b><span>Нових звернень і заявок немає. Щойно мешканці напишуть чи збори потребуватимуть рішення — справа зʼявиться тут.</span></div>'}
                </section>
                <div class="td-side">
                    ${meetingCard}
                    <button type="button" class="sv-card td-balance" ${go('finance')}>
                        <span class="td-label">На рахунку ОСББ</span>
                        <b class="td-big">${moneyText(funds)}</b>
                        <span class="td-small">${finance.fundsDate ? `станом на ${escapeHtml(finance.fundsDate)}` : 'за останньою випискою'} ›</span>
                    </button>
                </div>
            </div>
            <div class="td-row">
                <button type="button" class="sv-card" ${go('finance')}><span class="td-label">Надходження</span><b class="td-mid">${moneyText(income)}</b>
                    <span class="td-small is-muted">${finance.period ? escapeHtml(String(finance.period).replace(/^\d{4} рік:\s*/, '')) : 'внески й інші доходи'}</span></button>
                <button type="button" class="sv-card" ${go('finance')}><span class="td-label">Витрати</span><b class="td-mid">${moneyText(financeReady ? spent : null)}</b>
                    ${spentShare !== null ? `<span class="sv-meter" aria-hidden="true"><i style="width:${Math.min(100, spentShare)}%"></i></span><span class="td-small">витрачено ${spentShare}% надходжень</span>` : '<span class="td-small">за звітом</span>'}</button>
                <button type="button" class="sv-card" ${go('directory')}><span class="td-label">Борг мешканців</span><b class="td-mid">${moneyText(directoryReady ? debtSum : null)}</b>
                    <span class="td-small${debtors.length ? ' is-bad' : ''}">${directoryReady ? `${debtors.length} ${plural(debtors.length, 'квартира', 'квартири', 'квартир')} ›` : 'дані оновлюються'}</span></button>
            </div>`;

        host.querySelectorAll('[data-tab]').forEach(el => {
            el.addEventListener('click', () => openTab(el.dataset.tab, el.dataset.target));
        });
    } catch (e) {
        console.error('Дашборд:', e);
        host.innerHTML = '<p class="list-empty">Не вдалося завантажити зведення</p>';
    }
}
