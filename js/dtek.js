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
import { audit } from './audit.js';
import { doc, getDoc, setDoc } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import {
    getFunctions, httpsCallable
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-functions.js";
import { escapeHtml, toast, setBusy, formatDateTime } from './ui.js';

// Дванадцять черг, як їх називає сам ДТЕК. Список стабільний і
// короткий, тож тримаємо його тут, а не тягнемо запитом.
const GROUPS = ['1.1', '1.2', '2.1', '2.2', '3.1', '3.2',
                '4.1', '4.2', '5.1', '5.2', '6.1', '6.2'];

const SETTINGS = 'osbb_settings/power';

// Дата за Києвом — ключ фактичного графіка ДТЕК («2026-10-17»).
const kyivDate = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Kyiv' }).format(d);
const dayLabel = (d) => new Intl.DateTimeFormat('uk-UA', { timeZone: 'Europe/Kyiv', weekday: 'long', day: 'numeric', month: 'long' }).format(d);

/**
 * Відключення на добу: фактичний графік ДТЕК на цю дату (те, що сайт
 * ДТЕК показує в таблиці «на сьогодні / на завтра»), а якщо його немає —
 * тижневий шаблон «можливих» відключень.
 */
export function slotsFor(data, date) {
    const key = kyivDate(date);
    if (data?.days && Object.prototype.hasOwnProperty.call(data.days, key)) return { slots: data.days[key] || [], fact: true };
    const dow = date.getDay() === 0 ? 7 : date.getDay();
    return { slots: data?.week?.[String(dow)] || [], fact: false };
}

const slotsText = (slots) => slots.length
    ? slots.map(s => `${escapeHtml(s.from)}–${escapeHtml(s.to)}${s.maybe ? ' (можливо)' : ''}`).join(', ')
    : '';

/** Сьогодні й завтра за фактичним графіком — так само, як на сайті ДТЕК. */
function factDaysHtml(data, cls) {
    const now = new Date();
    const days = [now, new Date(now.getTime() + 86400000)]
        .map(d => ({ d, ...slotsFor(data, d) }))
        .filter(x => x.fact);
    if (!days.length) return '';
    return `<div class="${cls}-fact">${days.map(({ d, slots }, i) => `<div class="${cls}-fact-day${i === 0 ? ' is-today' : ''}">
        <span>${i === 0 ? 'Сьогодні' : 'Завтра'} · ${escapeHtml(dayLabel(d))}</span>
        <b>${slots.length ? slotsText(slots) : 'без відключень'}</b></div>`).join('')}</div>`;
}

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
            <span>${slots.length ? slotsText(slots) : '<i>без відключень</i>'}</span>
        </div>`;
    }).join('');
    const fact = factDaysHtml(data, 'dtek');

    host.innerHTML = `
        <div class="dtek-head">
            <b>${escapeHtml(data.groupName || data.group || '')}</b>
            <span>${data.sourceUpdated ? `дані ДТЕК від ${escapeHtml(data.sourceUpdated)}` : ''}</span>
        </div>
        ${fact || '<p class="dtek-note">Фактичного графіка на сьогодні ДТЕК не публікує — нижче тижневий графік можливих відключень.</p>'}
        ${Object.keys(week).length ? `<details class="dtek-week"${fact ? '' : ' open'}><summary>Тижневий графік можливих відключень</summary><div class="dtek-rows">${rows}</div></details>` : ''}
        ${data.lastError ? `<p class="dtek-note dtek-error">Останнє оновлення не вдалося: ${escapeHtml(data.lastError)}</p>` : ''}
        <p class="dtek-note">Оновлено ${data.fetchedAt ? escapeHtml(formatDateTime(data.fetchedAt)) : '—'}</p>`;
}

async function save(btn) {
    const value = document.getElementById('dtekGroup')?.value || '';
    setBusy(btn, true, 'Збереження…');
    try {
        await setDoc(doc(db, ...SETTINGS.split('/')),
            { dtekGroup: value ? `GPV${value}` : '' }, { merge: true });
        await audit('dtek.group', { target: SETTINGS, summary: value ? `Черга ДТЕК: ${value}` : 'Чергу ДТЕК прибрано' });

        if (!value) {
            toast('Чергу прибрано', 'success');
            renderState(null);
            renderAdminRow('', null);
            return;
        }

        // Тягнемо графік одразу: чекати годину до наступного
        // запуску за розкладом — і не перевірити, чи вибрано правильно.
        setBusy(btn, true, 'Тягнемо графік…');
        const call = httpsCallable(getFunctions(app, 'europe-central2'), 'refreshDtekSchedule');
        await call();
        const sched = await getDoc(doc(db, 'status', 'schedule'));
        const data = sched.exists() ? sched.data() : null;
        renderState(data);
        renderAdminRow(`GPV${value}`, data);
        toast(`Чергу ${value} збережено, графік оновлено`, 'success');
    } catch (e) {
        console.error('Черга ДТЕК:', e);
        // Чергу вже записано — про це кажемо окремо, щоб правління не
        // тиснуло кнопку вдруге, гадаючи, що нічого не збереглося.
        toast(e?.code
            ? `Чергу збережено, але графік не завантажився${e.message && e.code === 'functions/unavailable' ? `: ${e.message}` : ''}. Спробуйте ще раз.`
            : 'Не вдалося зберегти', 'error');
        getDoc(doc(db, 'status', 'schedule')).then(snap => renderState(snap.exists() ? snap.data() : null)).catch(() => {});
    } finally {
        setBusy(btn, false);
    }
}

/**
 * Рядок у картці світла правління — там само, де тумблер і статистика.
 *
 * Раніше налаштування черги жило в окремій картці вкладки «База»,
 * тобто за три дотики від того місця, де правління про світло й
 * думає. Тепер усе про світло в одному блоці.
 */
function renderAdminRow(cfgGroup, sched) {
    const host = document.getElementById('adminScheduleHost');
    if (!host) return;
    const failure = sched?.lastError
        ? `<em class="pw-sched-error">Автооновлення не вдалося${sched.lastErrorAt
            ? ` · ${escapeHtml(formatDateTime(sched.lastErrorAt))}` : ''}</em>` : '';
    const label = cfgGroup
        ? `<b>Черга ${escapeHtml(cfgGroup.replace('GPV', ''))}</b><span>${
            sched?.fetchedAt ? `графік оновлено ${escapeHtml(formatDateTime(sched.fetchedAt))}`
                             : 'графік ще не завантажено'}</span>${failure}`
        : `<b>Чергу не налаштовано</b><span>оберіть — і графік підтягнеться сам</span>`;

    host.innerHTML = `<button type="button" class="pw-sched${cfgGroup ? '' : ' pw-sched-soon'}" id="openDtekBtn">
        <span class="pw-sched-icon">
            <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"></circle><polyline points="12 7 12 12 15 14"></polyline></svg>
        </span>
        <span class="pw-sched-text">${label}</span>
        <svg class="row-chevron" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"></polyline></svg>
    </button>`;

    document.getElementById('openDtekBtn').addEventListener('click', async () => {
        const { openSheet } = await import('./ui.js');
        openSheet('dtekPopup');
    });
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
        const data = sched.exists() ? sched.data() : null;
        select.value = saved.replace('GPV', '');
        renderState(data);
        renderAdminRow(saved, data);
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
export function scheduleNow(data, now = new Date()) {
    if (!data || (!data.week && !data.days)) return null;
    const today = slotsFor(data, now).slots;
    const mins = now.getHours() * 60 + now.getMinutes();

    const current = today.find(s => hhmmToMin(s.from) <= mins && mins < hhmmToMin(s.to));
    if (current) return { state: 'off', to: current.to };

    const next = today.find(s => hhmmToMin(s.from) > mins);
    if (next) return { state: 'soon', from: next.from, to: next.to };

    // Сьогодні більше нічого — дивимось на завтра, інакше ввечері
    // блок мовчав би, хоч уранці відключення вже заплановане.
    const tomorrow = slotsFor(data, new Date(now.getTime() + 86400000)).slots;
    if (tomorrow.length) return { state: 'tomorrow', from: tomorrow[0].from, to: tomorrow[0].to };
    return { state: 'clear' };
}

/** «через 1 год 40 хв» — скільки лишилося до часу HH:MM (сьогодні чи завтра). */
export function untilText(hhmm, now = new Date(), nextDay = false) {
    let left = hhmmToMin(hhmm) + (nextDay ? 1440 : 0) - (now.getHours() * 60 + now.getMinutes());
    if (left <= 0) return 'зараз';
    const h = Math.floor(left / 60), m = left % 60;
    return `через ${h ? `${h} год` : ''}${h && m ? ' ' : ''}${m ? `${m} хв` : ''}`;
}

const CLOCK = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"></circle><polyline points="12 7 12 12 15 14"></polyline></svg>';
const BOLT = '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M13 2 4 14h7l-1 8 9-12h-7z"></path></svg>';
const CHEVRON = '<svg class="row-chevron" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"></polyline></svg>';

/**
 * Наступне відключення — помітною плашкою з часом і зворотним
 * відліком: це те, заради чого картку світла й відкривають. Спокійний
 * стан «сьогодні без відключень» лишається тихим рядком.
 */
function scheduleHtml(s, now = new Date()) {
    if (s.state === 'clear') {
        return `<button type="button" class="pw-sched pw-sched-clear" id="openScheduleBtn">
            <span class="pw-sched-icon">${CLOCK}</span>
            <span class="pw-sched-text"><b>Сьогодні відключень немає</b><span>за графіком ДТЕК</span></span>
            ${CHEVRON}
        </button>`;
    }
    const v = {
        off: { label: 'Зараз за графіком без світла', time: `до ${escapeHtml(s.to)}`, when: untilText(s.to, now).replace('через', 'ще') },
        soon: { label: 'Наступне відключення', time: `${escapeHtml(s.from)} – ${escapeHtml(s.to)}`, when: untilText(s.from, now) },
        tomorrow: { label: 'Наступне відключення', time: `${escapeHtml(s.from)} – ${escapeHtml(s.to)}`, when: 'завтра' }
    }[s.state];
    return `<button type="button" class="pw-next pw-next-${s.state}" id="openScheduleBtn" aria-label="${v.label}: ${v.time}, ${v.when}. Відкрити графік">
        <span class="pw-next-icon">${BOLT}</span>
        <span class="pw-next-text">
            <span class="pw-next-label">${v.label}</span>
            <b class="pw-next-time">${v.time}</b>
            <span class="pw-next-when">${escapeHtml(v.when)}</span>
        </span>
        ${CHEVRON}
    </button>`;
}

let scheduleTimer = null;

/** Плашка графіка в картці світла; відлік оновлюється щохвилини. */
export async function loadPowerSchedule() {
    const host = document.getElementById('powerScheduleHost');
    if (!host) return;
    clearInterval(scheduleTimer);
    try {
        const snap = await getDoc(doc(db, 'status', 'schedule'));
        if (!snap.exists()) { host.innerHTML = ''; return; }
        const data = snap.data();
        const render = () => {
            const s = scheduleNow(data);
            host.innerHTML = s ? scheduleHtml(s) : '';
            document.getElementById('openScheduleBtn')?.addEventListener('click', async () => {
                const { openSheet } = await import('./ui.js');
                renderScheduleSheet(data);
                openSheet('schedulePopup');
            });
        };
        render();
        scheduleTimer = setInterval(() => { if (document.body.contains(host)) render(); else clearInterval(scheduleTimer); }, 60000);
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

    const fact = factDaysHtml(data, 'sched');
    host.innerHTML = `
        <p class="sched-src">${escapeHtml(data.groupName || '')} · графік ДТЕК${
            data.sourceUpdated ? ` від ${escapeHtml(data.sourceUpdated)}` : ''}</p>
        ${fact}
        <details class="sched-week"${fact ? '' : ' open'}><summary>Тижневий графік можливих відключень</summary>
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
        </div></details>
        <p class="sched-note">${fact ? 'Сьогодні й завтра — фактичний графік ДТЕК для черги будинку.' : 'Це графік можливих відключень.'} Реальне відключення
            може не збігтися з графіком — застосунок показує справжній стан світла вгорі екрана.</p>`;
}
