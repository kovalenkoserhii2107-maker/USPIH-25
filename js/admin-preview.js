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

document.getElementById('adminDashboard').innerHTML = `
    <div class="admin-overview-head">
        <div><span class="overview-kicker">Огляд будинку</span><h2>Що потребує уваги сьогодні</h2></div>
        <span class="overview-updated">Оновлено щойно</span>
    </div>
    <div class="overview-status-grid">
        <section class="overview-card overview-data-card">
            <div class="overview-card-head"><div><span class="overview-kicker">Оновлення даних</span><h2>186 з 198 квартир</h2></div><span class="overview-percent">94%</span></div>
            <div class="overview-progress" role="progressbar" aria-label="Звірено квартир" aria-valuemin="0" aria-valuemax="100" aria-valuenow="94"><i style="width:94%"></i></div>
            <p>12 квартир потребують перевірки · 6 змін очікують рішення</p>
            <button type="button" class="overview-link" data-tab="directory">Продовжити звірку ${go}</button>
        </section>
        <section class="overview-card overview-requests-card">
            <div class="overview-card-head"><div><span class="overview-kicker">Звернення мешканців</span><h2>10 відкритих</h2></div></div>
            <div class="overview-request-values"><span class="is-new"><b>3</b><small>нові</small></span><span><b>7</b><small>у роботі</small></span></div>
            <button type="button" class="overview-link" data-tab="requests">Опрацювати звернення ${go}</button>
        </section>
    </div>
    <section class="overview-finance-card">
        <div class="overview-finance-head"><div><span class="overview-kicker">Фінанси ОСББ</span><h2>Вересень 2026</h2></div><button type="button" class="overview-link" data-tab="finance">Відкрити фінанси ${go}</button></div>
        <div class="overview-finance-body">
            <div class="overview-balance"><small>Залишок на рахунку</small><strong>128 450 грн</strong><span>Станом на 15 вересня 2026</span></div>
            <div class="overview-finance-metrics">
                <div class="finance-stat is-income"><small>Надходження</small><b>286 300 грн</b></div>
                <div class="finance-stat is-expense"><small>Витрати</small><b>157 850 грн</b></div>
                <div class="finance-stat is-debt"><small>Заборгованість</small><b>96 400 грн</b><span>23 квартири</span></div>
            </div>
        </div>
        <div class="overview-finance-ratio"><span>Витрачено 55% надходжень</span><div class="overview-progress"><i style="width:55%"></i></div></div>
    </section>
    <div class="overview-lower-grid">
        <section class="overview-card overview-meeting-card">
            <div class="overview-card-head"><div><span class="overview-kicker">Активні збори</span><h2>Позачергові загальні збори співвласників</h2></div><span class="admin-status status-live">Тривають</span></div>
            <div class="overview-meeting-stats"><span><b>59,6%</b><small>кворум</small></span><span><b>5</b><small>питань</small></span><span><b>1</b><small>день лишився</small></span></div>
            <button type="button" class="overview-link" data-tab="meetings">Продовжити роботу ${go}</button>
        </section>
        <aside class="overview-card overview-tasks-card">
            <div class="admin-tasks-head"><h2>Термінові завдання</h2><span>2</span></div>
            <button class="admin-task" data-tab="meetings"><span class="admin-task-mark task-danger">!</span><span><b>Перевірити чернетку протоколу</b><small>Потрібна перевірка перед публікацією</small></span>${go}</button>
            <button class="admin-task" data-tab="requests"><span class="admin-task-mark">!</span><span><b>Відповісти на 3 нові звернення</b><small>Найстаріше очікує 2 дні</small></span>${go}</button>
            <button class="admin-all-tasks" data-tab="requests">Усі завдання →</button>
        </aside>
    </div>`;

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
