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
import { escapeHtml, formatDateTime } from './ui.js';

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
            getCountFromServer(collection(db, 'apartments')),
            getCountFromServer(query(collection(db, 'requests'), where('status', '==', 'new'))),
            getCountFromServer(query(collection(db, 'polls'), where('status', '==', 'active'))),
            getDocs(query(collection(db, 'messages'), orderBy('createdAt', 'desc'), limit(1)))
        ]);

        const aptCount = apts.data().count;
        const reqCount = openReqs.data().count;
        const pollCount = activePolls.data().count;
        const lastMsg = lastMsgSnap.empty ? null : lastMsgSnap.docs[0].data();

        host.innerHTML = `
            <div class="dash-grid">
                ${tile({ id: 'dashApts', label: 'Квартир у системі', value: aptCount,
                         tone: 'neutral', tab: 'board' })}
                ${tile({ id: 'dashReqs', label: 'Звернень у роботі', value: reqCount,
                         hint: reqCount ? 'Потребують відповіді' : 'Усе опрацьовано',
                         tone: reqCount ? 'warn' : 'ok', tab: 'requests',
                         target: '.req-card.req-pending' })}
                ${tile({ id: 'dashPolls', label: 'Активних голосувань', value: pollCount,
                         hint: pollCount ? 'Триває' : 'Немає активних',
                         tone: pollCount ? 'info' : 'neutral', tab: 'polls',
                         target: '.poll-card-admin' })}
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
