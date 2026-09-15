// Локальний, безпечний перегляд інтерфейсу правління без входу у Firebase.
// Він показує лише демонстраційні дані й не виконує жодних записів.
const section = document.getElementById('adminDashboardSection');
document.body.classList.add('admin-mode');
document.getElementById('appLoader').style.display = 'none';
// The live app shows this section as a regular block on mobile. Desktop CSS
// promotes it to the two-column workspace grid at the 960px breakpoint.
section.style.display = 'block';

const today = document.getElementById('adminToday');
if (today) today.textContent = new Date().toLocaleDateString('uk-UA', {
    day: 'numeric', month: 'long', year: 'numeric', weekday: 'short'
});

const go = '<svg class="dash-go" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.4"><polyline points="9 18 15 12 9 6"></polyline></svg>';
const icons = {
    meetings: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path><circle cx="9" cy="7" r="4"></circle><path d="M23 21v-2a4 4 0 0 0-3-3.87"></path></svg>',
    quorum: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>',
    agenda: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="8" y1="6" x2="21" y2="6"></line><line x1="8" y1="12" x2="21" y2="12"></line><line x1="8" y1="18" x2="21" y2="18"></line><line x1="3" y1="6" x2="3.01" y2="6"></line><line x1="3" y1="12" x2="3.01" y2="12"></line><line x1="3" y1="18" x2="3.01" y2="18"></line></svg>',
    calendar: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="17" rx="2"></rect><line x1="8" y1="2" x2="8" y2="6"></line><line x1="16" y1="2" x2="16" y2="6"></line><line x1="3" y1="9" x2="21" y2="9"></line></svg>',
    place: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 10c0 5-8 12-8 12S4 15 4 10a8 8 0 1 1 16 0z"></path><circle cx="12" cy="10" r="2.5"></circle></svg>'
};
const metric = (tone, label, value, hint, icon) => `
    <button class="admin-metric metric-${tone}" type="button" data-tab="meetings">
        <span class="admin-metric-icon">${icon}</span>
        <span class="admin-metric-copy"><small>${label}</small><b>${value}</b><span>${hint}</span></span>${go}
    </button>`;

document.getElementById('adminDashboard').innerHTML = `
    <div class="admin-metrics">
        ${metric('blue', 'Активні збори', '1', 'Триває голосування', icons.meetings)}
        ${metric('green', 'Кворум', '186 з 312', '59,6% голосів', icons.quorum)}
        ${metric('violet', 'Порядок денний', '5 з 5', 'Питань підготовлено', icons.agenda)}
        ${metric('amber', 'Кінцевий термін', '15.09.2026', '1 день залишився', icons.calendar)}
    </div>
    <div class="admin-focus-grid">
        <section class="admin-meeting-card">
            <div class="admin-meeting-head">
                <div><span class="admin-section-kicker">Поточні збори</span>
                    <h2>Позачергові загальні збори співвласників ОСББ «Успіх-25»</h2></div>
                <span class="admin-status status-live">Голосування триває</span>
            </div>
            <div class="admin-meeting-meta"><span>${icons.calendar}12 вересня 2026</span><span>${icons.place}Онлайн та письмово</span><span>${icons.meetings}312 співвласників</span><span>${icons.agenda}5 питань</span></div>
            <div class="admin-meeting-rule"></div>
            <div class="admin-meeting-row quorum-row">
                <span class="meeting-row-label">Кворум</span><span class="admin-progress"><i style="width:59.6%"></i></span>
                <b>186 з 312</b><strong>59,6%</strong><small class="meeting-row-note note-ok">Кворум досягнуто. Голосування є правомочним.</small>
            </div>
            <div class="admin-meeting-row"><span class="meeting-row-label">Кінцевий термін</span><span class="meeting-row-value"><b>15 вересня 2026, 23:59</b><small>1 день залишився</small></span></div>
            <div class="admin-meeting-row"><span class="meeting-row-label">Порядок денний</span><span class="meeting-row-value"><b>5 з 5 питань підготовлено</b><button data-tab="meetings">Переглянути порядок денний →</button></span></div>
            <div class="admin-meeting-row"><span class="meeting-row-label">Статус протоколу</span><span class="meeting-row-value"><span class="admin-status status-review">Потребує перевірки</span><small>Перевірте результати голосування перед затвердженням.</small></span></div>
            <div class="admin-meeting-actions"><button type="button" class="btn-primary" data-tab="meetings">Продовжити роботу з протоколом →</button><button type="button" class="btn-secondary" data-tab="meetings">Переглянути результати</button></div>
        </section>
        <aside class="admin-tasks-card">
            <div class="admin-tasks-head"><h2>Термінові завдання</h2><span>2</span></div>
            <button class="admin-task" data-tab="meetings"><span class="admin-task-mark task-danger">!</span><span><b>Перевірити чернетку протоколу</b><small>Потрібна перевірка перед публікацією</small></span>${go}</button>
            <button class="admin-task" data-tab="send"><span class="admin-task-mark">!</span><span><b>Підготувати повідомлення про результати</b><small>Надіслати після затвердження протоколу</small></span>${go}</button>
            <button class="admin-all-tasks" data-tab="requests">Усі завдання →</button>
        </aside>
    </div>
    <div class="admin-house-strip"><span><b>198</b> квартир</span><span><b>312</b> співвласників</span><span><b>94%</b> списків звірено</span><button data-tab="finance"><b>128 тис грн</b> заборгованості →</button></div>`;

document.getElementById('meetingsActive').innerHTML = `
    <div class="poll-card poll-card-admin meeting-card">
        <div class="poll-head"><span class="poll-badge poll-badge-active">Триває</span><span class="poll-date">12.09, 18:00</span></div>
        <h3 class="poll-title">Позачергові загальні збори співвласників</h3>
        <div class="meeting-meta"><span class="meeting-chip">12 вересня 2026 р.</span><span class="meeting-chip">Онлайн та письмово</span></div>
        <div class="meeting-lines">
            <div class="meeting-line"><span class="meeting-line-q"><b>Кворум досягнуто — 59,6%</b></span><span class="meeting-line-counts">186 із 312 співвласників уже взяли участь</span></div>
            <div class="meeting-line"><span class="meeting-line-q"><b>5 питань порядку денного</b></span><span class="meeting-line-counts">Голоси приймаються до 15 вересня, 23:59</span></div>
        </div>
        <span class="meeting-split">Особисто: <b>124</b> · письмово: <b>62</b> · кворум: <b>59,6%</b></span>
        <div class="poll-actions"><button type="button" class="btn-primary btn-compact">Продовжити роботу</button><button type="button" class="btn-soft btn-compact">Внести паперові голоси</button><button type="button" class="btn-soft btn-compact">Переглянути результати</button></div>
    </div>`;

document.getElementById('meetingsProtocols').innerHTML = `
    <a class="proto-row" href="#"><span class="proto-row-text"><span class="proto-row-title">Чернетка протоколу позачергових зборів</span><span class="proto-row-meta">Потребує перевірки · оновлено сьогодні</span></span></a>
    <a class="proto-row" href="#"><span class="proto-row-text"><span class="proto-row-title">Протокол загальних зборів №4</span><span class="proto-row-meta">Опубліковано · 20 серпня 2026</span></span></a>`;

document.getElementById('meetingsArchive').innerHTML = `
    <div class="poll-card poll-card-admin meeting-card"><div class="poll-head"><span class="poll-badge poll-badge-closed">Завершено</span><span class="poll-date">20.08.2026</span></div><h3 class="poll-title">Загальні збори співвласників №4</h3><p class="poll-desc">Рішення затверджено, протокол опубліковано.</p></div>`;

const agenda = document.getElementById('meetingAgendaList');
if (agenda) agenda.innerHTML = `<div class="poll-option-row poll-option-row-meeting agenda-row"><div class="poll-option-main"><span class="agenda-no">2.</span><input class="field-input poll-option-input" value="Затвердження кошторису на 2027 рік"></div><textarea class="field-input poll-decision-input" rows="2">Затвердити запропонований кошторис.</textarea></div>`;

document.getElementById('adminPowerCard').hidden = true;

function selectTab(name) {
    document.querySelectorAll('.admin-tab').forEach(tab => tab.classList.toggle('active', tab.dataset.tab === name));
    document.querySelectorAll('.admin-panel').forEach(panel => panel.classList.toggle('active', panel.dataset.panel === name));
    window.scrollTo({ top: 0, behavior: 'smooth' });
}

function selectMeetingView(name) {
    const panel = document.querySelector('.admin-panel[data-panel="meetings"]');
    if (!panel) return;
    panel.querySelectorAll('[data-meeting-panel]').forEach(view => {
        view.hidden = view.dataset.meetingPanel !== name;
    });
    panel.querySelectorAll('[data-meeting-view]').forEach(tab => {
        const active = tab.dataset.meetingView === name;
        tab.classList.toggle('active', active);
        if (tab.getAttribute('role') === 'tab') {
            tab.setAttribute('aria-selected', active ? 'true' : 'false');
            tab.tabIndex = active ? 0 : -1;
        }
    });
}

document.querySelector('[role="tablist"]')?.addEventListener('keydown', event => {
    const keys = ['ArrowLeft', 'ArrowRight', 'Home', 'End'];
    if (!keys.includes(event.key)) return;
    const tabs = [...event.currentTarget.querySelectorAll('[role="tab"]')];
    const current = tabs.indexOf(document.activeElement);
    if (current < 0) return;
    event.preventDefault();
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1
        : (current + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
    tabs[next].click();
    tabs[next].focus();
});

document.addEventListener('click', event => {
    const tab = event.target.closest('[data-tab]');
    if (tab) selectTab(tab.dataset.tab);
    const meetingView = event.target.closest('[data-meeting-view]');
    if (meetingView) selectMeetingView(meetingView.dataset.meetingView);
    const fold = event.target.closest('.admin-card-toggle');
    if (fold) {
        const card = fold.closest('.admin-fold');
        card?.classList.toggle('open');
        fold.setAttribute('aria-expanded', card?.classList.contains('open') ? 'true' : 'false');
    }
});

selectMeetingView('active');

document.getElementById('adminLogoutBtn').addEventListener('click', () => {
    selectTab('overview');
});
