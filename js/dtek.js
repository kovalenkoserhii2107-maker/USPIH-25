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
import { db, app } from './firebase.js';
import { doc, getDoc, setDoc } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js";
import {
    getFunctions, httpsCallable
} from "https://www.gstatic.com/firebasejs/10.8.1/firebase-functions.js";
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

        if (!value) {
            toast('Чергу прибрано', 'success');
            renderState(null);
            return;
        }

        // Тягнемо графік одразу: чекати три години до наступного
        // запуску за розкладом — і не перевірити, чи вибрано правильно.
        setBusy(btn, true, 'Тягнемо графік…');
        const call = httpsCallable(getFunctions(app, 'europe-central2'), 'refreshDtekSchedule');
        await call();
        const sched = await getDoc(doc(db, 'status', 'schedule'));
        renderState(sched.exists() ? sched.data() : null);
        toast(`Чергу ${value} збережено, графік оновлено`, 'success');
    } catch (e) {
        console.error('Черга ДТЕК:', e);
        // Чергу вже записано — про це кажемо окремо, щоб правління не
        // тиснуло кнопку вдруге, гадаючи, що нічого не збереглося.
        toast(e?.code
            ? 'Чергу збережено, але графік не завантажився. Спробуйте ще раз.'
            : 'Не вдалося зберегти', 'error');
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

// ------------------------------------------------------------
// БІК МЕШКАНЦЯ
// ------------------------------------------------------------
const hhmmToMin = (v) => {
    const [h, m] = String(v).split(':').map(Number);
    return h * 60 + (m || 0);
};

/** Понеділок = 1 … неділя = 7, як у ДТЕК (у JS неділя — 0). */
const dtekDay = (d) => d.getDay() === 0 ? 7 : d.getDay();

/**
 * Що сказати мешканцю про графік просто зараз.
 *
 * Тиждень таблицею — це довідка, а на головному екрані потрібна
 * відповідь на одне питання: коли вимкнуть і чи вимкнено вже.
 */
export function scheduleNow(week, now = new Date()) {
    if (!week) return null;
    const today = week[String(dtekDay(now))] || [];
    const mins = now.getHours() * 60 + now.getMinutes();

    const current = today.find(s => hhmmToMin(s.from) <= mins && mins < hhmmToMin(s.to));
    if (current) return { state: 'off', to: current.to };

    const next = today.find(s => hhmmToMin(s.from) > mins);
    if (next) return { state: 'soon', from: next.from, to: next.to };

    // Сьогодні більше нічого — дивимось на завтра, інакше ввечері
    // блок мовчав би, хоч уранці відключення вже заплановане.
    const tomorrow = week[String(dtekDay(new Date(now.getTime() + 86400000)))] || [];
    if (tomorrow.length) return { state: 'tomorrow', from: tomorrow[0].from, to: tomorrow[0].to };
    return { state: 'clear' };
}

/** Смужка на головному екрані під карткою світла. */
export async function loadPowerSchedule() {
    const host = document.getElementById('powerScheduleHost');
    if (!host) return;
    try {
        const snap = await getDoc(doc(db, 'status', 'schedule'));
        if (!snap.exists()) { host.innerHTML = ''; return; }
        const data = snap.data();
        const s = scheduleNow(data.week);
        if (!s) { host.innerHTML = ''; return; }

        const TEXT = {
            off:      () => `<b>Зараз за графіком — без світла</b><span>до ${escapeHtml(s.to)}</span>`,
            soon:     () => `<b>Сьогодні о ${escapeHtml(s.from)}</b><span>за графіком до ${escapeHtml(s.to)}</span>`,
            tomorrow: () => `<b>Завтра о ${escapeHtml(s.from)}</b><span>за графіком до ${escapeHtml(s.to)}</span>`,
            clear:    () => `<b>Сьогодні відключень немає</b><span>за графіком ДТЕК</span>`
        };

        host.innerHTML = `<button type="button" class="pw-sched pw-sched-${s.state}" id="openScheduleBtn">
            <span class="pw-sched-icon">
                <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="17" rx="2"></rect><line x1="3" y1="9" x2="21" y2="9"></line><line x1="8" y1="2" x2="8" y2="6"></line><line x1="16" y1="2" x2="16" y2="6"></line></svg>
            </span>
            <span class="pw-sched-text">${TEXT[s.state]()}</span>
            <svg class="row-chevron" viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"></polyline></svg>
        </button>`;

        document.getElementById('openScheduleBtn')?.addEventListener('click', async () => {
            const { openSheet } = await import('./ui.js');
            renderScheduleSheet(data);
            openSheet('schedulePopup');
        });
    } catch (e) {
        console.warn('Графік відключень:', e);
        host.innerHTML = '';
    }
}

const DAYS_FULL = { 1: 'Понеділок', 2: 'Вівторок', 3: 'Середа', 4: 'Четвер',
                    5: 'Пʼятниця', 6: 'Субота', 7: 'Неділя' };

function renderScheduleSheet(data) {
    const host = document.getElementById('scheduleBody');
    if (!host) return;
    const week = data.week || {};
    const todayKey = String(dtekDay(new Date()));

    host.innerHTML = `
        <p class="sched-src">${escapeHtml(data.groupName || '')} · графік ДТЕК${
            data.sourceUpdated ? ` від ${escapeHtml(data.sourceUpdated)}` : ''}</p>
        <div class="sched-days">
            ${Object.keys(DAYS_FULL).map(d => {
                const slots = week[d] || [];
                return `<div class="sched-day${d === todayKey ? ' is-today' : ''}">
                    <span class="sched-day-name">${DAYS_FULL[d]}${d === todayKey ? ' · сьогодні' : ''}</span>
                    <div class="sched-slots">${slots.length
                        ? slots.map(s => `<span class="sched-slot">${escapeHtml(s.from)}–${escapeHtml(s.to)}</span>`).join('')
                        : '<span class="sched-none">без відключень</span>'}</div>
                </div>`;
            }).join('')}
        </div>
        <p class="sched-note">Це графік можливих відключень. Фактичне відключення
            може не збігтися з ним — застосунок показує реальний стан світла вгорі екрана.</p>`;
}
