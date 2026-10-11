// ============================================================
// «Звіти»: шлях Податкового розрахунку від відомості до квитанції № 2
// і вибір головного строку для картки зверху. Тут немає ні мережі, ні
// DOM: тести — tests/unit/reports-view-core.test.mjs.
// ============================================================
import { deadlines } from './tax-calendar.js';

/** Виконане: прийнято, сплачено, подавати не потрібно. */
const DONE = new Set(['accepted', 'paid', 'not_required']);

/** Місяць звіту з ключа календаря: 'j0500111-2026-10' → '2026-10'. */
export function periodOfKey(key) {
    const m = /^(?:j0500111|esv)-(\d{4})-(\d{1,2})$/.exec(key || '');
    return m ? `${m[1]}-${m[2].padStart(2, '0')}` : null;
}

/**
 * Строки з позначками: від початку обліку до 4 місяців уперед. Щомісячне —
 * лише за місяці від початку обліку (раніші подає сервіс бухгалтера) і
 * лише коли є працівники чи відомості.
 *   done    — виконано (прийнято, сплачено, не потрібно);
 *   waiting — подано, чекаємо квитанцію № 2: дії людини вже не треба.
 * c — контекст reportsAction 'context': { today, start, statuses, hasPeople, hasFop, payrollMonths }.
 */
export function reportTasks(c) {
    if (!c) return [];
    const today = c.today;
    const from = new Date(`${c.start}-01T00:00:00Z`);
    const to = new Date(`${today}T00:00:00Z`); to.setUTCMonth(to.getUTCMonth() + 4);
    const payroll = c.hasPeople || c.hasFop || (c.payrollMonths || []).length > 0;
    return deadlines(from, to, { payroll, land: false })
        .filter(d => { const p = periodOfKey(d.key); return !p || p >= c.start; })
        .map(d => {
            const iso = d.date.toISOString().slice(0, 10);
            const mark = c.statuses?.[d.key] || null;
            const left = Math.round((Date.parse(`${iso}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86400000);
            return { ...d, iso, mark, left, done: Boolean(mark && DONE.has(mark.status)), waiting: mark?.status === 'submitted' };
        });
}

/**
 * Наступний строк, що чекає дії людини: прострочені — першими, далі
 * найближчий. Сплачене, прийняте й подане (чекає квитанцію) не нагадуємо.
 */
export function nextDeadline(tasks) {
    return tasks.filter(t => !t.done && !t.waiting).sort((a, b) => a.left - b.left)[0] || null;
}

/** Подано давно, а квитанції № 2 немає — нагадати її додати (раз на тиждень після подання). */
export function receiptOverdue(task, today) {
    if (!task.waiting || !task.mark?.date) return false;
    return (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${task.mark.date}T00:00:00Z`)) / 86400000 >= 5;
}

/**
 * Кроки розрахунку: [{ key, title, note, state: done|current|next|bad }].
 * approved — відомість місяця затверджено; mark — позначка строку
 * (submitted — квитанція № 1, accepted — № 2, rejected — відхилено);
 * pack — остання завантажена версія пакета XML (готова до підпису).
 */
export function reportSteps({ approved = false, hasIncome = true, mark = null, pack = null } = {}) {
    const status = mark?.status || null;
    const submitted = status === 'submitted' || status === 'accepted';
    const version = mark?.packageVersion || pack?.version || null;
    const steps = [
        { key: 'payroll', title: 'Відомість затверджено', note: approved ? 'Цифри — із затвердженої відомості зарплати' : 'Затвердіть відомість у «Зарплаті» — цифри зʼявляться самі', done: approved },
        { key: 'files', title: pack || submitted ? 'Файли готові до підпису' : 'Перевірте суми й завантажте файли',
            note: pack ? `Версія ${pack.version} · XML: розрахунок і додатки Д1, 4ДФ, Д5` : hasIncome ? 'XML для Електронного кабінету: розрахунок і додатки Д1, 4ДФ, Д5' : 'Виплат за місяць немає — можна позначити «Подавати не потрібно»',
            done: submitted || Boolean(pack) },
        { key: 'sign', title: 'Підпис голови й подання', note: submitted ? `Подано${version ? ` версію ${version}` : ''}${mark?.regNumber ? ` · № ${mark.regNumber}` : ''} · квитанція № 1` : 'Голова завантажує файли в кабінет ДПС і підписує КЕП', done: submitted },
        { key: 'accepted', title: 'Прийнято податковою', note: status === 'rejected' ? `Відхилено${mark?.note ? `: ${mark.note}` : ''} — виправте й подайте знову` : 'Квитанцію № 2 додайте в позначку — збережеться тут', done: status === 'accepted' }
    ];
    if (status === 'not_required') return steps.map(s => ({ ...s, state: 'done', note: s.key === 'accepted' ? 'Позначено: подавати не потрібно' : s.note }));
    let current = steps.findIndex(s => !s.done);
    if (status === 'rejected') current = 3;
    return steps.map((s, i) => ({ ...s, state: s.done ? 'done' : status === 'rejected' && i === 3 ? 'bad' : i === current ? 'current' : 'next' }));
}

/** Що робити далі: { act, label } для головної кнопки картки. */
export function nextAction(steps) {
    const cur = steps.find(s => s.state === 'current' || s.state === 'bad');
    if (!cur) return null;
    return {
        payroll: { act: 'go-payroll', label: 'Відкрити «Зарплату»' },
        files: { act: 'hero-xml', label: 'Завантажити файли для податкової' },
        sign: { act: 'hero-open', label: 'Голова подав — додати квитанцію № 1' },
        accepted: { act: 'hero-open', label: cur.state === 'bad' ? 'Подати знову' : 'Додати квитанцію № 2' }
    }[cur.key];
}

/**
 * Головний строк для картки зверху: найближчий невиконаний Податковий
 * розрахунок (зокрема поданий, що чекає квитанцію № 2), інакше найближчий
 * невиконаний будь-який. Решта невиконаних
 * у межах 60 днів — у бічні картки (до трьох).
 */
export function pickFocus(tasks) {
    // Подано, але квитанції № 2 ще немає — строк лишається в роботі.
    const open = tasks.filter(t => !t.done || t.mark?.status === 'submitted').sort((a, b) => a.left - b.left);
    const hero = open.find(t => t.key.startsWith('j0500111-') && t.left <= 60) || open[0] || null;
    return { hero, side: open.filter(t => t !== hero && t.left <= 60).slice(0, 3) };
}
