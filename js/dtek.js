// ============================================================
// Черга відключень ДТЕК — бік правління.
//
// Сам графік забирає Cloud Function: у відповіді ДТЕК немає
// Access-Control-Allow-Origin, тож із браузера його не взяти.
// Тут лише те, що правління справді має вирішити, — на якій черзі
// стоїть будинок. Визначати чергу за адресою автоматично ми не
// беремося: ДТЕК іноді ділить один будинок між чергами, і мовчазна
// помилка тут гірша за один вибір руками.
// ============================================================
import { db } from './firebase.js';
import { doc, getDoc, setDoc } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js";
import { escapeHtml, toast, setBusy, formatDateTime } from './ui.js';

// Дванадцять черг, як їх називає сам ДТЕК. Список стабільний і
// короткий, тож тримаємо його тут, а не тягнемо запитом.
const GROUPS = ['1.1', '1.2', '2.1', '2.2', '3.1', '3.2',
                '4.1', '4.2', '5.1', '5.2', '6.1', '6.2'];

const SETTINGS = 'osbb_settings/power';

function renderState(data) {
    const host = document.getElementById('dtekState');
    if (!host) return;
    if (!data) {
        host.innerHTML = `<p class="dtek-empty">Графік ще не завантажувався.
            Оберіть чергу — далі він оновлюватиметься сам.</p>`;
        return;
    }
    const days = { 1: 'Пн', 2: 'Вт', 3: 'Ср', 4: 'Чт', 5: 'Пт', 6: 'Сб', 7: 'Нд' };
    const week = data.week || {};
    const rows = Object.keys(days).map(d => {
        const slots = week[d] || [];
        return `<div class="dtek-row">
            <b>${days[d]}</b>
            <span>${slots.length
                ? slots.map(s => `${escapeHtml(s.from)}–${escapeHtml(s.to)}`).join(', ')
                : '<i>без відключень</i>'}</span>
        </div>`;
    }).join('');

    host.innerHTML = `
        <div class="dtek-head">
            <b>${escapeHtml(data.groupName || data.group || '')}</b>
            <span>${data.sourceUpdated ? `дані ДТЕК від ${escapeHtml(data.sourceUpdated)}` : ''}</span>
        </div>
        <div class="dtek-rows">${rows}</div>
        <p class="dtek-note">Оновлено ${data.fetchedAt ? escapeHtml(formatDateTime(data.fetchedAt)) : '—'}</p>`;
}

async function save(btn) {
    const value = document.getElementById('dtekGroup')?.value || '';
    setBusy(btn, true, 'Збереження…');
    try {
        await setDoc(doc(db, ...SETTINGS.split('/')),
            { dtekGroup: value ? `GPV${value}` : '' }, { merge: true });
        toast(value ? `Чергу ${value} збережено` : 'Чергу прибрано', 'success');
    } catch (e) {
        console.error('Черга ДТЕК:', e);
        toast('Не вдалося зберегти', 'error');
    } finally {
        setBusy(btn, false);
    }
}

export async function loadDtekSettings() {
    const select = document.getElementById('dtekGroup');
    if (!select) return;
    select.innerHTML = '<option value="">Не налаштовано</option>'
        + GROUPS.map(g => `<option value="${g}">Черга ${g}</option>`).join('');

    try {
        const [cfg, sched] = await Promise.all([
            getDoc(doc(db, ...SETTINGS.split('/'))),
            getDoc(doc(db, 'status', 'schedule'))
        ]);
        const saved = cfg.exists() ? (cfg.data().dtekGroup || '') : '';
        select.value = saved.replace('GPV', '');
        renderState(sched.exists() ? sched.data() : null);
    } catch (e) {
        console.warn('Налаштування ДТЕК:', e);
    }
}

export function initDtek() {
    document.getElementById('saveDtekBtn')
        ?.addEventListener('click', function () { save(this); });
}
