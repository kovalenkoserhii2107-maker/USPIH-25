// ============================================================
// Статистика відключень.
//
// Журнал зберігає МОМЕНТИ перемикань, а не відрізки. Відрізки
// будуємо тут: кожен запис триває до наступного, останній — до
// поточної миті. Так само рахуються й доби: відключення, що
// почалося ввечері й скінчилося вранці, ділиться між двома днями,
// інакше стовпчики брехали б.
// ============================================================
import { db } from './firebase.js';
import {
    collection, doc, query, where, orderBy, getDocs, getDoc
} from "https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js";
import { formatElapsed, escapeHtml } from './ui.js';

const DAYS = 14;
const DAY_MS = 86400000;

const startOfDay = (d) => {
    const x = new Date(d);
    x.setHours(0, 0, 0, 0);
    return x;
};

/** Перетворює моменти перемикань на відрізки станів. */
export function buildIntervals(entries, now = Date.now()) {
    const sorted = [...entries].sort((a, b) => a.at - b.at);
    return sorted.map((e, i) => ({
        isOn: e.isOn,
        from: e.at,
        to: i + 1 < sorted.length ? sorted[i + 1].at : now
    })).filter(x => x.to > x.from);
}

/** Скільки мілісекунд відрізок припадає на добу [dayStart, dayStart+24год). */
function overlap(interval, dayStart) {
    const dayEnd = dayStart + DAY_MS;
    return Math.max(0, Math.min(interval.to, dayEnd) - Math.max(interval.from, dayStart));
}

export function summarize(entries, now = Date.now()) {
    const since = startOfDay(now - (DAYS - 1) * DAY_MS).getTime();
    const intervals = buildIntervals(entries, now).filter(i => i.to > since);
    const offs = intervals.filter(i => !i.isOn);

    // Відключення, що почалося раніше вікна, враховуємо лише його
    // частиною всередині вікна — інакше «загалом без світла» роздувалось би.
    const clipped = offs.map(i => ({ ...i, from: Math.max(i.from, since) }));
    const totalOff = clipped.reduce((s, i) => s + (i.to - i.from), 0);
    const longest = offs.reduce((m, i) => Math.max(m, i.to - i.from), 0);

    const days = [];
    for (let d = 0; d < DAYS; d++) {
        const dayStart = startOfDay(now - (DAYS - 1 - d) * DAY_MS).getTime();
        days.push({
            date: new Date(dayStart),
            offMs: offs.reduce((s, i) => s + overlap(i, dayStart), 0)
        });
    }

    return {
        count: offs.length,
        totalOff,
        longest,
        avg: offs.length ? Math.round(totalOff / offs.length) : 0,
        days,
        hasData: entries.length > 0
    };
}

const WEEKDAYS = ['нд', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];

/** Перелік останніх подій — щоб статистику можна було перевірити очима. */
function renderLog(entries) {
    const last = entries.slice(-12).reverse();
    if (!last.length) return '';
    const fmt = (ms) => new Date(ms).toLocaleString('uk-UA', {
        day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit'
    });
    return `<details class="pw-log">
        <summary>Журнал перемикань</summary>
        <div class="pw-log-list">
            ${last.map(e => `<div class="pw-log-row">
                <span class="pw-log-dot ${e.isOn ? 'pw-on' : 'pw-off'}"></span>
                <span class="pw-log-what">${e.isOn ? 'Світло увімкнено' : 'Світло вимкнено'}</span>
                <span class="pw-log-when">${escapeHtml(fmt(e.at))}</span>
            </div>`).join('')}
        </div>
    </details>`;
}

function renderBars(days) {
    const max = Math.max(...days.map(d => d.offMs), 1);
    return `<div class="pw-chart">
        ${days.map(d => {
            const hours = d.offMs / 3600000;
            const pct = (d.offMs / max) * 100;
            const label = `${String(d.date.getDate()).padStart(2, '0')}.${String(d.date.getMonth() + 1).padStart(2, '0')}`;
            const title = hours >= 0.05 ? `${hours.toFixed(1)} год без світла` : 'без відключень';
            return `<div class="pw-col" title="${label} — ${title}">
                <span class="pw-bar-wrap">
                    <span class="pw-bar${d.offMs ? '' : ' pw-bar-empty'}" style="height: ${Math.max(pct, d.offMs ? 4 : 2)}%;"></span>
                </span>
                <span class="pw-day">${WEEKDAYS[d.date.getDay()]}</span>
                <span class="pw-date">${label}</span>
            </div>`;
        }).join('')}
    </div>`;
}

export function renderStats(s, patched = false, entries = []) {
    if (!s.hasData) {
        return `<p class="list-empty">Журнал відключень порожній.<br>
            Записи з'являтимуться з кожним перемиканням світла правлінням.</p>`;
    }

    const worst = Math.max(...s.days.map(d => d.offMs));
    return `
        <div class="pw-tiles">
            <div class="pw-tile">
                <span class="pw-value">${s.count}</span>
                <span class="pw-label">Відключень</span>
            </div>
            <div class="pw-tile">
                <span class="pw-value pw-value-off">${escapeHtml(formatElapsed(s.totalOff))}</span>
                <span class="pw-label">Без світла</span>
            </div>
            <div class="pw-tile">
                <span class="pw-value">${escapeHtml(formatElapsed(s.avg))}</span>
                <span class="pw-label">У середньому</span>
            </div>
        </div>
        <div class="pw-longest">
            Найдовше відключення — <b>${escapeHtml(formatElapsed(s.longest))}</b>
        </div>
        <span class="pw-chart-title">Годин без світла за добу</span>
        ${renderBars(s.days)}
        ${patched ? `<p class="pw-warn">У журналі бракувало запису — його відновлено за поточним статусом. Якщо таке повторюється, перевірте звʼязок під час перемикання.</p>` : ''}
        <span class="pw-note">${worst
            ? `Найгірша доба — ${(worst / 3600000).toFixed(1)} год без світла`
            : 'За два тижні відключень не було'}</span>
        ${renderLog(entries)}`;
}

export async function loadPowerStats() {
    const host = document.getElementById('powerStatsBody');
    if (!host) return;
    host.innerHTML = '<p class="list-empty">Завантаження…</p>';

    try {
        // Беремо на добу ширше вікно: відключення могло початися до нього,
        // і без цього запису відрізок обірвався б посередині.
        const since = new Date(startOfDay(Date.now() - DAYS * DAY_MS));
        const snap = await getDocs(query(
            collection(db, 'power_log'),
            where('at', '>=', since),
            orderBy('at', 'asc')
        ));
        const entries = snap.docs
            .map(d => d.data())
            .filter(d => d.at)
            .map(d => ({ isOn: d.isOn !== false, at: d.at.toDate().getTime() }));

        // Звіряємо журнал із поточним статусом.
        //
        // Перемикання і запис у журнал — дві окремі операції. Якщо
        // друга не пройшла (немає звʼязку, не опубліковані правила),
        // світло перемкнулося, а подія в журнал не потрапила — і
        // статистика мовчки її втрачала. Тепер відновлюємо її зі
        // status/power, а мешканцю кажемо, що запис неповний.
        let patched = false;
        try {
            const st = await getDoc(doc(db, 'status', 'power'));
            if (st.exists() && st.data().changedAt) {
                const stAt = st.data().changedAt.toDate().getTime();
                const stOn = st.data().isOn !== false;
                const last = entries[entries.length - 1];

                // Статус новіший за журнал — журналу бракує запису
                if (!last || stAt > last.at + 1000) {
                    entries.push({ isOn: stOn, at: stAt });
                    patched = Boolean(last);
                } else if (last && last.isOn !== stOn) {
                    // Стан розійшовся — віримо статусу, він джерело істини
                    entries.push({ isOn: stOn, at: Math.max(stAt, last.at + 1000) });
                    patched = true;
                }
            }
        } catch (e) {
            console.warn('Звірка зі статусом світла:', e);
        }

        entries.sort((a, b) => a.at - b.at);
        host.innerHTML = renderStats(summarize(entries), patched, entries);
    } catch (e) {
        console.error('Статистика світла:', e);
        host.innerHTML = '<p class="list-empty">Не вдалося завантажити статистику</p>';
    }
}

export function initPowerStats() {
    ['powerStatsBtn', 'adminPowerStatsBtn'].forEach(id => {
        document.getElementById(id)?.addEventListener('click', async () => {
            const { openSheet } = await import('./ui.js');
            openSheet('powerStatsPopup');
            loadPowerStats();
        });
    });
}
