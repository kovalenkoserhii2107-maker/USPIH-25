// ============================================================
// Графік можливих відключень ДТЕК «Одеські електромережі».
//
// Таблицю на сайті парсити не треба: сторінка несе готовий JSON у
// вигляді присвоєнь `DisconSchedule.preset = {...}`. Це і надійніше
// (перемалюють таблицю — нам байдуже), і точніше: у таблиці півгодини
// показані піктограмою, а в JSON вони окремими станами.
//
// Чому не з браузера: у відповіді ДТЕК немає заголовка
// Access-Control-Allow-Origin, тож застосунок дані взяти не може.
// Забирає їх ця функція, кладе у Firestore, а застосунок читає звідти.
// ============================================================

const URL_SHUTDOWNS = 'https://www.dtek-oem.com.ua/ua/shutdowns';

// Словник самого ДТЕК (preset.time_type). Тут він потрібен цілим, бо
// назва стану оманлива: `yes` означає «світло Є», а не «відключення».
const STATES = {
    yes:     { off: 0,    text: 'Світло є' },
    no:      { off: 1,    text: 'Світла немає' },
    maybe:   { off: 1,    text: 'Можливе відключення', maybe: true },
    first:   { off: 0.5,  text: 'Не буде перші 30 хв', half: 'first' },
    second:  { off: 0.5,  text: 'Не буде другі 30 хв', half: 'second' },
    mfirst:  { off: 0.5,  text: 'Можливо не буде перші 30 хв', half: 'first', maybe: true },
    msecond: { off: 0.5,  text: 'Можливо не буде другі 30 хв', half: 'second', maybe: true }
};

/**
 * Дістає значення присвоєння `DisconSchedule.<name> = {...}` з HTML.
 *
 * Рахуємо дужки, а не шукаємо кінець регуляркою: усередині є рядки з
 * дужками (назви вулиць, лапки), і жадібний вираз обрізав би JSON
 * посеред даних.
 */
function extractAssignment(html, name) {
    const marker = `DisconSchedule.${name} = `;
    const start = html.indexOf(marker);
    if (start < 0) return null;
    const from = start + marker.length;

    let depth = 0, inStr = false, esc = false;
    for (let i = from; i < html.length; i++) {
        const c = html[i];
        if (inStr) {
            if (esc) esc = false;
            else if (c === '\\') esc = true;
            else if (c === '"') inStr = false;
            continue;
        }
        if (c === '"') { inStr = true; continue; }
        if (c === '{' || c === '[') depth++;
        else if (c === '}' || c === ']') {
            depth--;
            if (depth === 0) {
                try { return JSON.parse(html.slice(from, i + 1)); }
                catch { return null; }
            }
        }
    }
    return null;
}

/**
 * Розкладає добу однієї черги на відрізки без світла.
 *
 * Година з половинкою — це не «пів години десь усередині»: ДТЕК каже
 * саме яка половина. Тому 17:30–18:00 і 18:00–19:00 злипаються в один
 * відрізок 17:30–19:00, а не показуються двома.
 */
function daySlots(hours) {
    const raw = [];
    for (let h = 1; h <= 24; h++) {
        const st = STATES[hours[String(h)]];
        if (!st || !st.off) continue;
        const base = h - 1;
        const from = st.half === 'second' ? base + 0.5 : base;
        const to = st.half === 'first' ? base + 0.5 : base + 1;
        raw.push({ from, to, maybe: Boolean(st.maybe) });
    }

    const slots = [];
    for (const s of raw) {
        const last = slots[slots.length - 1];
        if (last && last.to === s.from && last.maybe === s.maybe) last.to = s.to;
        else slots.push({ ...s });
    }
    const hhmm = (v) => `${String(Math.floor(v)).padStart(2, '0')}:${v % 1 ? '30' : '00'}`;
    return slots.map(s => ({
        from: hhmm(s.from),
        to: hhmm(s.to === 24 ? 24 : s.to),
        hours: +(s.to - s.from).toFixed(2),
        maybe: s.maybe
    }));
}

/**
 * @param {string} html сторінка графіків ДТЕК
 * @returns {{groups: string[], names: Object, week: Object, updatedText: string}|null}
 *   week: { 'GPV3.1': { '1': [ {from,to,hours,maybe} ], ... '7': [...] }, ... }
 *   Ключ дня — 1 (понеділок) … 7 (неділя), як у самого ДТЕК.
 */
function parseSchedule(html) {
    const preset = extractAssignment(html, 'preset');
    if (!preset || !preset.data) return null;

    const week = {};
    const totals = {};
    for (const [group, days] of Object.entries(preset.data)) {
        week[group] = {};
        let sum = 0;
        for (let d = 1; d <= 7; d++) {
            const slots = daySlots(days[String(d)] || {});
            week[group][String(d)] = slots;
            sum += slots.reduce((s, x) => s + x.hours, 0);
        }
        totals[group] = +sum.toFixed(2);
    }

    return {
        groups: Object.keys(preset.data).sort(),
        names: preset.sch_names || {},
        week,
        totals,
        updatedText: preset.updateFact || ''
    };
}

module.exports = { URL_SHUTDOWNS, STATES, parseSchedule, daySlots, extractAssignment };
