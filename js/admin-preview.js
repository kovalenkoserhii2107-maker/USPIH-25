// Локальний, безпечний перегляд інтерфейсу правління без входу у Firebase.
// Він показує лише демонстраційні дані й не виконує жодних записів.
const section = document.getElementById('adminDashboardSection');
document.body.classList.add('admin-mode');
document.getElementById('appLoader').style.display = 'none';
section.style.display = 'grid';

const today = document.getElementById('adminToday');
if (today) today.textContent = new Date().toLocaleDateString('uk-UA', {
    day: 'numeric', month: 'long', year: 'numeric', weekday: 'short'
});

const go = '<svg class="dash-go" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.4"><polyline points="9 18 15 12 9 6"></polyline></svg>';
const metric = (tone, label, value, hint, icon) => `
    <button class="admin-metric metric-${tone}" type="button" data-tab="meetings">
        <span class="admin-metric-icon">${icon}</span>
        <span class="admin-metric-copy"><small>${label}</small><b>${value}</b><span>${hint}</span></span>${go}
    </button>`;

document.getElementById('adminDashboard').innerHTML = `
    <div class="admin-metrics">
        ${metric('blue', 'Активні збори', '1', 'Триває голосування', '♙')}
        ${metric('green', 'Кворум', '186 з 312', '59,6% голосів', '✓')}
        ${metric('violet', 'Порядок денний', '5 з 5', 'Питань підготовлено', '▤')}
        ${metric('amber', 'Кінцевий термін', '15.09.2026', '1 день залишився', '◷')}
    </div>
    <div class="admin-focus-grid">
        <section class="admin-meeting-card">
            <div class="admin-meeting-head">
                <div><span class="admin-section-kicker">Поточні збори</span>
                    <h2>Позачергові загальні збори співвласників ОСББ «Успіх-25»</h2></div>
                <span class="admin-status status-live">Голосування триває</span>
            </div>
            <div class="admin-meeting-meta"><span>◷ 12 вересня 2026</span><span>⌖ Онлайн та письмово</span><span>♙ 312 співвласників</span><span>▤ 5 питань</span></div>
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

document.getElementById('adminPowerCard').hidden = true;

function selectTab(name) {
    document.querySelectorAll('.admin-tab').forEach(tab => tab.classList.toggle('active', tab.dataset.tab === name));
    document.querySelectorAll('.admin-panel').forEach(panel => panel.classList.toggle('active', panel.dataset.panel === name));
    window.scrollTo({ top: 0, behavior: 'smooth' });
}

document.addEventListener('click', event => {
    const tab = event.target.closest('[data-tab]');
    if (tab) selectTab(tab.dataset.tab);
    const fold = event.target.closest('.admin-card-toggle');
    if (fold) {
        const card = fold.closest('.admin-fold');
        card?.classList.toggle('open');
        fold.setAttribute('aria-expanded', card?.classList.contains('open') ? 'true' : 'false');
    }
});

document.getElementById('adminLogoutBtn').addEventListener('click', () => {
    selectTab('overview');
});
