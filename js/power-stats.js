// ============================================================
// Статистика відключень.
//
// Журнал зберігає МОМЕНТИ перемикань, а не відрізки. Відрізки
// будуємо тут: кожен запис триває до наступного, останній — до
// поточної миті. Так само рахуються й доби: відключення, що
// почалося ввечері й скінчилося вранці, ділиться між двома днями,
// інакше стовпчики брехали б.
//
// Період обирає мешканець. Типово тиждень: дві доби тому — це ще
// «нещодавно», а два тижні одним полотном ніхто не читає. Заразом
// це тримає малим і число прочитаних із бази записів.
// ============================================================
import { db } from './firebase.js';
import {
    collection, doc, query, where, orderBy, getDocs, getDoc
} from "https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js";
import { formatElapsed, escapeHtml } from './ui.js';

const DAY_MS = 86400000;

const PERIODS = {
    week:  { days: 7,   label: 'Тиждень', word: 'за тиждень' },
    month: { days: 30,  label: 'Місяць',  word: 'за місяць' },
    year:  { days: 365, label: 'Рік',     word: 'за рік' }
};

let period = 'week';

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

export function summarize(entries, days, now = Date.now()) {
    const since = startOfDay(now - (days - 1) * DAY_MS).getTime();
    const intervals = buildIntervals(entries, now).filter(i => i.to > since);
    const offs = intervals.filter(i => !i.isOn);

    // Відключення, що почалося раніше вікна, враховуємо лише його
    // частиною всередині вікна — інакше «загалом без світла» роздувалось би.
    const clipped = offs.map(i => ({ ...i, from: Math.max(i.from, since) }));
    const totalOff = clipped.reduce((s, i) => s + (i.to - i.from), 0);

    // Найдовше запамʼятовуємо разом із датою: «6 год 52 хв» без відповіді
    // «коли» не каже нічого — ні планувати, ні перевірити.
    let longest = 0, longestAt = null;
    offs.forEach(i => {
        const d = i.to - i.from;
        if (d > longest) { longest = d; longestAt = i.from; }
    });

    // Коли саме вимикають: хвилини темряви розкладаємо по годинах доби.
    // Це єдине, що дозволяє мешканцю щось спланувати наперед.
    const byHour = new Array(24).fill(0);
    clipped.forEach(i => {
        for (let t = i.from; t < i.to; ) {
            const d = new Date(t);
            const hourEnd = new Date(d).setMinutes(60, 0, 0);
            const till = Math.min(hourEnd, i.to);
            byHour[d.getHours()] += till - t;
            t = till;
        }
    });

    const todayStart = startOfDay(now).getTime();
    const dayList = [];
    for (let d = 0; d < days; d++) {
        const dayStart = startOfDay(now - (days - 1 - d) * DAY_MS).getTime();
        const dayEnd = dayStart + DAY_MS;
        // Крім суми зберігаємо самі відрізки: для віялових відключень
        // важливо не скільки, а КОЛИ. Відключення через північ саме тут
        // і ділиться між двома добами.
        const segments = offs
            .filter(i => i.to > dayStart && i.from < dayEnd)
            .map(i => {
                const from = Math.max(i.from, dayStart);
                const to = Math.min(i.to, dayEnd);
                return {
                    left: ((from - dayStart) / DAY_MS) * 100,
                    width: ((to - from) / DAY_MS) * 100,
                    ms: to - from
                };
            });
        dayList.push({
            date: new Date(dayStart),
            offMs: offs.reduce((s, i) => s + overlap(i, dayStart), 0),
            segments,
            isToday: dayStart === todayStart,
            // Скільки доби вже минуло — решту сьогоднішньої смуги гасимо,
            // інакше порожній залишок читається як «світло було».
            elapsedPct: dayStart === todayStart ? ((now - dayStart) / DAY_MS) * 100 : 100
        });
    }

    // Скільки часу вікна вже минуло — від нього рахуємо частку темряви
    const elapsed = Math.max(now - since, 1);

    return {
        count: offs.length,
        totalOff,
        longest,
        longestAt,
        byHour,
        offShare: (totalOff / elapsed) * 100,
        avg: offs.length ? Math.round(totalOff / offs.length) : 0,
        days: dayList,
        hasData: entries.length > 0
    };
}

// ------------------------------------------------------------
// ФОРМАТИ
// ------------------------------------------------------------
const dec = (n) => n.toFixed(1).replace('.', ',');

/** Для плиток: «16,7 год» замість «16 год. 40 хв.», що не влазило в рядок. */
function compactDur(ms) {
    const h = ms / 3600000;
    if (h >= 24) return `${dec(h / 24)} дн`;
    if (h >= 1) return `${dec(h)} год`;
    return `${Math.round(ms / 60000)} хв`;
}

/** «6:52» для підпису просто на смузі. */
function shortDur(ms) {
    const m = Math.round(ms / 60000);
    return m >= 60 ? `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}` : `${m} хв`;
}

const WEEKDAYS = ['нд', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];
const MONTHS = ['січ', 'лют', 'бер', 'квіт', 'трав', 'черв',
                'лип', 'серп', 'вер', 'жовт', 'лист', 'груд'];

const fmtDay = (d) => `${WEEKDAYS[d.getDay()]}, ${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}`;

/**
 * Найтемніший проміжок доби — суцільне вікно з найбільшою сумою.
 * Шукаємо серед вікон у 4 години: коротші дають випадкові піки,
 * довші розмазують відповідь до «десь удень».
 */
function peakWindow(byHour) {
    const total = byHour.reduce((s, v) => s + v, 0);
    if (!total) return null;
    let best = -1, bestStart = 0;
    for (let h = 0; h < 24; h++) {
        let sum = 0;
        for (let k = 0; k < 4; k++) sum += byHour[(h + k) % 24];
        if (sum > best) { best = sum; bestStart = h; }
    }
    // Пік, що майже не виділяється, — не пік, а шум
    if (best / total < 0.28) return null;
    const p = (h) => `${String(h).padStart(2, '0')}:00`;
    return { text: `${p(bestStart)}—${p((bestStart + 4) % 24)}`, share: Math.round(best / total * 100) };
}

// ------------------------------------------------------------
// МАЛЮВАННЯ
// ------------------------------------------------------------
function renderTabs() {
    return `<div class="pw-tabs" role="tablist">
        ${Object.entries(PERIODS).map(([key, p]) => `
            <button type="button" class="pw-tab${key === period ? ' is-on' : ''}"
                    role="tab" aria-selected="${key === period}" data-period="${key}">${p.label}</button>`).join('')}
    </div>`;
}

/**
 * Доба — смуга на 24 години, відрізки без світла стоять на своїх
 * місцях. На широких відрізках пишемо тривалість просто на них:
 * інакше «скільки саме» доводилося вгадувати за довжиною.
 */
/** 54.17% доби → «13:00». Потрібно, щоб підписати смугу її ж часом. */
const hhmmOfPct = (p) => {
    const total = Math.round(p / 100 * 1440);
    return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
};

const hhmmPct = (v) => {
    const [h, m] = String(v).split(':').map(Number);
    return ((h * 60 + (m || 0)) / 1440) * 100;
};

/** Понеділок = 1 … неділя = 7, як у ДТЕК (у JS неділя — 0). */
const dtekDay = (d) => d.getDay() === 0 ? 7 : d.getDay();

/**
 * @param {Object} schedWeek тижневий графік ДТЕК або null
 */
/** Смуги графіка на добу у відсотках доби. */
const planBands = (date, schedWeek) => (schedWeek?.[String(dtekDay(date))] || [])
    .map(p => [hhmmPct(p.from), p.to === '24:00' ? 100 : hhmmPct(p.to)]);

function renderDays(days, schedWeek) {
    const compact = days.length > 10;
    return `<div class="pw-days${compact ? ' is-compact' : ''}">
        <div class="pw-hours">
            <span>00</span><span>06</span><span>12</span><span>18</span><span>24</span>
        </div>
        ${days.map(d => {
            // Години:хвилини, а не десяткові: «4:25» читається одразу,
            // а «4,4 год» доводиться перекладати в голові.
            const total = d.offMs >= 60000 ? shortDur(d.offMs) : '';
            const bands = planBands(d.date, schedWeek);
            const label = compact
                ? `${String(d.date.getDate()).padStart(2, '0')}.${String(d.date.getMonth() + 1).padStart(2, '0')}`
                : `<b>${WEEKDAYS[d.date.getDay()]}</b> ${String(d.date.getDate()).padStart(2, '0')}.${String(d.date.getMonth() + 1).padStart(2, '0')}`;
            return `<div class="pw-row${d.offMs ? ' has-off' : ''}${d.isToday ? ' is-today' : ''}">
                <span class="pw-row-day">${label}</span>
                <span class="pw-track">
                    ${bands.map(([a, b]) =>
                        `<i class="pw-plan" style="left:${a.toFixed(2)}%;width:${(b - a).toFixed(2)}%"></i>`).join('')}
                    <i class="pw-grid"></i>
                    ${d.elapsedPct < 100
                        ? `<i class="pw-future" style="left:${d.elapsedPct.toFixed(2)}%"></i>` : ''}
                    ${d.segments.map((g, gi) => {
                        // Куди подіти підпис.
                        //
                        // Усередину влазить лише від 14% ширини доріжки —
                        // стільки займає «12:05» при цьому кеглі. Але
                        // типове відключення на дві-три години це 10%, і
                        // так підпису не було б майже ніколи. Тому коротшу
                        // смугу підписуємо ПОРУЧ: доріжка все одно порожня.
                        // Дивимося на сусідів, щоб підписи не наїхали.
                        const right = (d.segments[gi + 1]?.left ?? 100) - (g.left + g.width);
                        const left = g.left - (gi ? d.segments[gi - 1].left + d.segments[gi - 1].width : 0);
                        const place = compact ? '' :
                            g.width >= 14 ? ' pw-seg-in' :
                            right >= 16 ? ' pw-seg-right' :
                            left >= 16 ? ' pw-seg-left' : '';
                        return `<i class="pw-seg${place}" style="left:${g.left.toFixed(2)}%;width:${Math.max(g.width, 0.6).toFixed(2)}%"
                                   title="${escapeHtml(shortDur(g.ms))}">${place ? `<b>${escapeHtml(shortDur(g.ms))}</b>` : ''}</i>`;
                    }).join('')}
                    ${d.isToday ? `<i class="pw-now" style="left:${d.elapsedPct.toFixed(2)}%"></i>` : ''}
                </span>
                <span class="pw-row-total">${total}</span>
            </div>`;
        }).join('')}
        <div class="pw-legend">
            ${schedWeek ? '<span class="pw-key-item"><i class="pw-key pw-key-plan"></i>за графіком ДТЕК</span>' : ''}
            <span class="pw-key-item"><i class="pw-key pw-key-fact"></i>фактично без світла</span>
        </div>
        ${schedWeek ? `<p class="pw-plan-note">Графік показано поточний — у минулому він міг бути іншим.</p>` : ''}
    </div>`;
}

/**
 * Тиждень стовпцями: день — колонка, час іде згори вниз.
 *
 * По горизонталі «з котрої години» доводилося міряти на око проти
 * підписів угорі. Вертикально час читається як на годиннику, а на
 * самій смузі стоїть час початку — не треба зіставляти нічого.
 *
 * Місяць і рік лишаються рядками: тридцять колонок не влізуть, та
 * там і питання інше — не «коли», а «скільки».
 */
function renderDaysColumns(days, schedWeek) {
    const pct = (v) => `${v.toFixed(2)}%`;

    // Кожна година своїм рядком: питання «з котрої не буде світла»
    // не має розвʼязуватися прикиданням між позначками через три.
    // Кратні шести підписуємо темніше — щоб було за що зачепитися оком.
    const marks = Array.from({ length: 25 }, (_, h) => h);
    const axis = marks.map(h => `<span class="pc-mark${h % 6 ? '' : ' is-major'}"
        style="top:${pct(h / 24 * 100)}">${String(h).padStart(2, '0')}</span>`).join('');
    const grid = marks.slice(1, -1).map(h =>
        `<i class="pc-line${h % 6 ? '' : ' is-major'}" style="top:${pct(h / 24 * 100)}"></i>`).join('');

    const cols = days.map(d => {
        const bands = planBands(d.date, schedWeek);
        const plan = bands.map(([a, b]) =>
            `<i class="pc-plan" style="top:${pct(a)};height:${pct(b - a)}"></i>`).join('');

        const facts = d.segments.map(g =>
            `<i class="pc-fact" style="top:${pct(g.left)};height:${pct(Math.max(g.width, 0.5))}"
                title="${escapeHtml(hhmmOfPct(g.left))} — ${escapeHtml(shortDur(g.ms))}"></i>`).join('');

        // Підписи — окремим шаром поверх смуг, щоб їх нічим не накрило.
        // Влазить приблизно від півтори години смуги.
        const labels = d.segments.filter(g => g.width >= 6).map(g =>
            `<span class="pc-time" style="top:${pct(g.left)}">${escapeHtml(hhmmOfPct(g.left))}</span>`).join('');

        return `<div class="pc-col${d.isToday ? ' is-today' : ''}">
            <span class="pc-name"><b>${WEEKDAYS[d.date.getDay()]}</b>${
                String(d.date.getDate()).padStart(2, '0')}.${String(d.date.getMonth() + 1).padStart(2, '0')}</span>
            <span class="pc-track">
                ${grid}${plan}${facts}${labels}
                ${d.elapsedPct < 100 ? `<i class="pc-future" style="top:${pct(d.elapsedPct)}"></i>
                    <i class="pc-now" style="top:${pct(d.elapsedPct)}"></i>` : ''}
            </span>
            <span class="pc-total">${d.offMs >= 60000 ? escapeHtml(shortDur(d.offMs)) : ''}</span>
        </div>`;
    }).join('');

    return `<div class="pc">
        <div class="pc-grid">
            <div class="pc-axis">${axis}</div>
            ${cols}
        </div>
        <div class="pw-legend">
            ${schedWeek ? '<span class="pw-key-item"><i class="pw-key pw-key-plan"></i>за графіком ДТЕК</span>' : ''}
            <span class="pw-key-item"><i class="pw-key pw-key-fact"></i>фактично без світла</span>
        </div>
        ${schedWeek ? '<p class="pw-plan-note">Графік показано поточний — у минулому він міг бути іншим.</p>' : ''}
    </div>`;
}

/** Рік — по місяцях: 365 смуг ніхто не читає, а сезонність видно. */
function renderMonths(entries, now) {
    const start = new Date(now);
    start.setDate(1); start.setHours(0, 0, 0, 0);
    const months = [];
    for (let i = 11; i >= 0; i--) {
        const from = new Date(start.getFullYear(), start.getMonth() - i, 1).getTime();
        const to = new Date(start.getFullYear(), start.getMonth() - i + 1, 1).getTime();
        months.push({ from, to: Math.min(to, now), date: new Date(from), offMs: 0 });
    }
    buildIntervals(entries, now).filter(i => !i.isOn).forEach(iv => {
        months.forEach(m => {
            m.offMs += Math.max(0, Math.min(iv.to, m.to) - Math.max(iv.from, m.from));
        });
    });

    const worst = Math.max(...months.map(m => m.offMs), 1);
    return `<div class="pw-months">
        ${months.map(m => `
            <div class="pw-month">
                <span class="pw-month-name">${MONTHS[m.date.getMonth()]}</span>
                <span class="pw-month-bar"><i style="width:${(m.offMs / worst * 100).toFixed(1)}%"></i></span>
                <span class="pw-month-val">${m.offMs ? dec(m.offMs / 3600000) : ''}</span>
            </div>`).join('')}
        <div class="pw-legend"><span class="pw-key-item"><i class="pw-key pw-key-fact"></i>фактично без світла · цифра праворуч — годин за місяць</span></div>
    </div>`;
}

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

export function renderStats(s, patched = false, entries = [], now = Date.now(), schedWeek = null) {
    const word = PERIODS[period].word;
    if (!s.hasData) {
        return renderTabs() + `<p class="list-empty">Записів ${escapeHtml(word)} немає.<br>
            Журнал поповнюється з кожним перемиканням світла.</p>`;
    }

    // Кожне число називає свій період і те, від чого воно рахується:
    // «17 відключень» без цього не каже нічого.
    const tiles = `<div class="pw-tiles">
        <div class="pw-tile">
            <span class="pw-value pw-value-off">${escapeHtml(compactDur(s.totalOff))}</span>
            <span class="pw-label">Без світла ${escapeHtml(word)}</span>
            <span class="pw-sub">${dec(s.offShare)}% часу</span>
        </div>
        <div class="pw-tile">
            <span class="pw-value">${s.count}</span>
            <span class="pw-label">${s.count === 1 ? 'Відключення' : 'Відключень'} ${escapeHtml(word)}</span>
            <span class="pw-sub">${s.count ? `у середньому по ${escapeHtml(compactDur(s.avg))}` : 'жодного'}</span>
        </div>
    </div>`;

    const longest = s.longest ? `<div class="pw-longest">
        <span class="pw-longest-cap">Найдовше відключення</span>
        <b>${escapeHtml(formatElapsed(s.longest))}</b>
        <span class="pw-longest-when">${escapeHtml(fmtDay(new Date(s.longestAt)))}, о ${
            new Date(s.longestAt).toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit' })}</span>
    </div>` : '';

    // Скільки годин графік обіцяв і скільки їх було насправді. Без цієї
    // пари графік виглядає як вирок, хоча це лише вікно можливих.
    const planned = schedWeek && period !== 'year'
        ? s.days.reduce((sum, d) => sum + (schedWeek[String(dtekDay(d.date))] || [])
            .reduce((x, p) => x + (p.hours || 0), 0), 0)
        : 0;
    const compare = planned ? `<div class="pw-compare">
        <span class="pw-compare-cap">За графіком ${escapeHtml(word)}</span>
        <b>${escapeHtml(planned % 1 ? dec(planned) : String(planned))} год</b>
        <span class="pw-compare-sub">фактично без світла —
            ${escapeHtml(compactDur(s.totalOff))} (${Math.round(s.totalOff / 36000 / planned)}% від обіцяного)</span>
    </div>` : '';

    const peak = peakWindow(s.byHour);
    const peakNote = peak ? `<div class="pw-peak">
        <span class="pw-peak-cap">Найчастіше вимикають</span>
        <b>${escapeHtml(peak.text)}</b>
        <span class="pw-peak-sub">${peak.share}% усього часу без світла</span>
    </div>` : '';

    return renderTabs() + tiles + longest + compare + peakNote
        + `<span class="pw-chart-title">Коли не було світла</span>`
        + (period === 'year' ? renderMonths(entries, now)
           : period === 'week' ? renderDaysColumns(s.days, schedWeek)
           : renderDays(s.days, schedWeek))
        + (patched ? `<p class="pw-warn">У журналі бракувало запису — його відновлено за поточним статусом.
            Якщо таке повторюється, перевірте звʼязок під час перемикання.</p>` : '')
        + renderLog(entries);
}

// ------------------------------------------------------------
// ЗАВАНТАЖЕННЯ
// ------------------------------------------------------------
export async function loadPowerStats() {
    const host = document.getElementById('powerStatsBody');
    if (!host) return;
    host.innerHTML = renderTabs() + '<p class="list-empty">Завантаження…</p>';

    const days = PERIODS[period].days;
    try {
        // Беремо на добу ширше вікно: відключення могло початися до нього,
        // і без цього запису відрізок обірвався б посередині.
        const since = new Date(startOfDay(Date.now() - days * DAY_MS));
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
        // Графік ДТЕК — окремий документ; якщо його немає або він
        // недоступний, статистика показується без нього.
        let schedWeek = null;
        try {
            const sc = await getDoc(doc(db, 'status', 'schedule'));
            if (sc.exists()) schedWeek = sc.data().week || null;
        } catch (e) {
            console.warn('Графік ДТЕК для статистики:', e);
        }

        const now = Date.now();
        host.innerHTML = renderStats(summarize(entries, days, now), patched, entries, now, schedWeek);
    } catch (e) {
        console.error('Статистика світла:', e);
        host.innerHTML = renderTabs() + '<p class="list-empty">Не вдалося завантажити статистику</p>';
    }
}

export function initPowerStats() {
    ['powerStatsBtn', 'adminPowerStatsBtn'].forEach(id => {
        document.getElementById(id)?.addEventListener('click', async () => {
            const { openSheet } = await import('./ui.js');
            period = 'week';          // щоразу починаємо з найближчого тижня
            openSheet('powerStatsPopup');
            loadPowerStats();
        });
    });

    // Делеговано: перемикачі перемальовуються разом із вмістом,
    // і слухачі на самих кнопках накопичувалися б.
    document.getElementById('powerStatsBody')?.addEventListener('click', (e) => {
        const key = e.target.closest('[data-period]')?.dataset.period;
        if (!key || key === period || !PERIODS[key]) return;
        period = key;
        loadPowerStats();
    });
}
