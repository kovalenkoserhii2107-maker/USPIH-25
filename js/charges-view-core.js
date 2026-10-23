// ============================================================
// «Нарахування»: що зробити зараз, підсумки збору внесків, історія
// тарифу й глибина боргу квартири. Без мережі й DOM — тести в
// tests/unit/charges-view-core.test.mjs.
// ============================================================
import { periodName, fmtKop } from './charges-core.js';

/**
 * Головна підказка місяця.
 * { tone: 'todo'|'wait'|'done'|'bad', title, hint, act?, btn?, tab?, go? }
 */
export function nextChargesAction({ period, run, preview, due = [], current, tariffs = [], opening, unfinished = [], stats }) {
    const name = periodName(period);
    if (unfinished.length) return { tone: 'bad', title: 'Операцію перервано посередині', hint: 'Частину записів зроблено, частину ні. Система допише решту за тим самим планом — повтор нічого не подвоїть. Доти місяць не закривається.', act: 'resume', btn: 'Завершити операцію' };
    if (!tariffs.length) return { tone: 'todo', title: 'Внесіть тарифи', hint: 'Без тарифу внесок не порахувати. Вкажіть тариф на м² для квартир за рішенням загальних зборів.', tab: 'tariffs', btn: 'До тарифів' };
    if (!run) {
        if (period > current) return { tone: 'wait', title: `${cap(name)} ще не настав`, hint: 'Нарахування за майбутній місяць не роблять. Оберіть поточний або минулий місяць.' };
        if (!preview?.rows?.length) return { tone: 'bad', title: 'Немає кому нараховувати', hint: `${preview?.problems?.length || 0} прим. мають помилки: немає площі, групи чи тарифу. Виправте їх на вкладці «Приміщення».`, tab: 'premises', btn: 'До приміщень' };
        const early = !due.includes(period);
        const problems = preview.problems?.length ? ` ${preview.problems.length} прим. буде пропущено — спершу виправте їх.` : '';
        return { tone: early ? 'wait' : 'todo', title: `Нарахуйте внески за ${name} — ${fmtKop(preview.totalKop)} грн`,
            hint: `${preview.rows.length} прим. за чинними тарифами й площами.${early ? ' Зазвичай нараховують в останній день місяця — запис матиме дату кінця місяця.' : ''}${problems}`,
            act: 'run', btn: early ? 'Нарахувати зараз' : 'Нарахувати', key: !early };
    }
    if (run.problems?.length) return { tone: 'bad', title: `Нараховано частково: ${run.problems.length} прим. пропущено`, hint: run.problems.slice(0, 4).map(p => `${p.apt}: ${p.reason}`).join(' · '), tab: 'premises', btn: 'Виправити приміщення' };
    if (preview && preview.totalKop !== run.totalKop && preview.rows?.length === run.count) {
        const diff = preview.totalKop - run.totalKop;
        return { tone: 'todo', title: 'Тарифи чи площі змінились після нарахування', hint: `Якщо перерахувати ${name}, сума зміниться на ${diff > 0 ? '+' : '−'}${fmtKop(Math.abs(diff))} грн. Перерахунок оновить історію й баланси квартир.`, act: 'recalc', btn: 'Перерахувати' };
    }
    if (!opening) return { tone: 'wait', title: `Нараховано ${fmtKop(run.totalKop)} грн`, hint: 'Поки немає вхідних залишків, баланс у кабінеті мешканця не змінюється — нарахування лише записуються в історію.', go: 'settings', btn: 'Внести вхідні залишки' };
    const pct = stats?.pct ?? 0;
    return { tone: 'done', title: `${cap(name)} нараховано — сплачено ${pct}%`,
        hint: `Нараховано ${fmtKop(run.totalKop)} грн на ${run.count} прим. Борг на кінець місяця — ${fmtKop(stats?.debtKop || 0)} грн у ${stats?.debtors || 0} кв. Квитанції з QR — у «Відомості».`,
        tab: 'statement', btn: 'Відомість і квитанції' };
}
const cap = s => s.charAt(0).toUpperCase() + s.slice(1);

/** Збір внесків за місяць: нараховано, сплачено (% від нарахованого), борг і переплати на кінець. */
export function collectionStats(st) {
    const t = st?.totals || {};
    const rows = st?.rows || [];
    const over = rows.filter(r => r.closing > 0);
    return {
        chargedKop: t.charged || 0, paidKop: t.paid || 0,
        pct: t.charged ? Math.round((t.paid || 0) / t.charged * 100) : 0,
        debtKop: -(t.debt || 0), debtors: t.debtors || 0,
        overKop: over.reduce((s, r) => s + r.closing, 0), overCount: over.length,
        paidCount: rows.filter(r => r.paid > 0).length, total: rows.length
    };
}

/**
 * Стан квартири у відомості: [текст, клас]. Глибина боргу — у місячних
 * внесках (борг / нараховане за місяць), щоб одразу видно було, кому писати претензію.
 */
export function rowState(r) {
    if (r.closing > 0) return ['переплата', 'is-done'];
    if (r.closing === 0) return [r.charged || r.paid ? 'розраховано' : '—', r.charged || r.paid ? 'is-done' : 'is-locked'];
    const months = r.charged > 0 ? -r.closing / r.charged : 0;
    if (months >= 3) return [`борг ≈ ${Math.round(months)} міс.`, 'is-bad'];
    if (r.paid > 0) return ['сплачено частково', 'is-work'];
    return ['до сплати', 'is-work'];
}

/** Фільтр відомості: усі / борг / переплата / не платили цього місяця; пошук за номером. */
export function filterStatement(rows, filter = 'all', query = '') {
    const q = String(query).trim().toLowerCase().replace(/^кв\.?\s*/, '');
    const keep = { all: () => true, debt: r => r.closing < 0, over: r => r.closing > 0, unpaid: r => r.charged > 0 && r.paid <= 0, deep: r => r.charged > 0 && -r.closing >= r.charged * 3 }[filter] || (() => true);
    return rows.filter(r => keep(r) && (!q || String(r.apt).toLowerCase() === q || String(r.apt).toLowerCase().startsWith(q)));
}

/**
 * Тарифи клітинки «складова × група»: чинний на місяць, наступний (якщо вже
 * затверджено з майбутнього місяця) і попередні — найновіші першими.
 */
export function tariffCell(tariffs, group, component, period) {
    const list = (tariffs || []).filter(t => t.group === group && (t.component || 'main') === component)
        .sort((a, b) => (a.from < b.from ? 1 : a.from > b.from ? -1 : 0));
    const current = list.find(t => t.from <= period) || null;
    const next = list.filter(t => t.from > period).at(-1) || null;
    return { current, next, history: list };
}
