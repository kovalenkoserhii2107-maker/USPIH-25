// ============================================================
// «Звіти»: шлях Податкового розрахунку від відомості до квитанції № 2
// і вибір головного строку для картки зверху. Тут немає ні мережі, ні
// DOM: тести — tests/unit/reports-view-core.test.mjs.
// ============================================================

/**
 * Кроки розрахунку: [{ key, title, note, state: done|current|next|bad }].
 * approved — відомість місяця затверджено; mark — позначка строку
 * (submitted — квитанція № 1, accepted — № 2, rejected — відхилено).
 */
export function reportSteps({ approved = false, hasIncome = true, mark = null } = {}) {
    const status = mark?.status || null;
    const submitted = status === 'submitted' || status === 'accepted';
    const steps = [
        { key: 'payroll', title: 'Відомість затверджено', note: approved ? 'Цифри — із затвердженої відомості зарплати' : 'Затвердіть відомість у «Зарплаті» — цифри зʼявляться самі', done: approved },
        { key: 'files', title: 'Перевірте суми й завантажте файли', note: hasIncome ? 'XML для Електронного кабінету: розрахунок і додатки Д1, 4ДФ, Д5' : 'Виплат за місяць немає — можна позначити «Подавати не потрібно»', done: submitted },
        { key: 'sign', title: 'Підпис голови й подання', note: submitted ? `Подано${mark?.regNumber ? ` · № ${mark.regNumber}` : ''} · квитанція № 1` : 'Голова завантажує файли в кабінет ДПС і підписує КЕП', done: submitted },
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
