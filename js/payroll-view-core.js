// ============================================================
// «Зарплата»: підсумки місяця для карток зверху й стан виплати кожної
// людини. Тут немає ні мережі, ні DOM: тести —
// tests/unit/payroll-view-core.test.mjs.
//
// Платежі відомості мають ключ «етап:хто»: для людей — «advance:p1»,
// «final:p1», для податків — «final:pdfo», «final:vz», «final:esv».
// ============================================================

const TAXES = new Set(['pdfo', 'vz', 'esv']);
// Сервер повертає stage і key окремо; старі знімки містять «stage:key».
export const paymentWho = p => String(p.key || '').split(':').at(-1);
const whoOf = paymentWho;
const isTax = p => p.recipientType ? p.recipientType === 'tax' : p.kind ? p.kind === 'tax' : TAXES.has(whoOf(p));
const live = p => !['failed', 'canceled'].includes(p.status) && !(p.returnedKop >= p.amountKop && p.status === 'paid');

/** Ініціали для кружечка: «Іваненко Петро» → «ІП». */
export const initials = name => String(name || '').trim().split(/\s+/).slice(0, 2).map(w => w[0] || '').join('').toUpperCase() || '·';

/** Платежі однієї людини за відомістю. */
export const personPayments = (payments, personId) => payments.filter(p => !isTax(p) && whoOf(p) === personId);

/**
 * Стан людини в місяці: [текст, клас позначки].
 * Банк не прийняв → «не прийнято»; усе проведено → «виплачено»; є на
 * підписі → «на підписі»; далі — за станом відомості.
 */
export function personState({ status, payments = [], closed = false }, personId, inRun = true) {
    if (!inRun) return ['не в цьому місяці', 'is-locked'];
    const mine = personPayments(payments, personId);
    if (mine.some(p => p.status === 'failed' || (p.returnedKop && !p.repaid))) return ['банк не прийняв', 'is-bad'];
    if (mine.some(p => ['sent', 'sending', 'unknown'].includes(p.status))) return ['на підписі', 'is-work'];
    if (mine.length && mine.every(p => p.status === 'paid' || p.status === 'canceled') && mine.some(p => p.status === 'paid')) {
        return [mine.some(p => p.status === 'paid' && (p.stage === 'final' || p.key?.startsWith('final:'))) ? 'виплачено' : 'аванс виплачено', 'is-done'];
    }
    if (closed) return ['місяць закрито', 'is-locked'];
    if (status === 'approved') return ['до виплати', 'is-work'];
    if (status === 'draft') return ['чекає голову', ''];
    return ['не складено', ''];
}

/** Підсумки для карток: людям і податки — скільки всього, скільки проведено, скільки на підписі. */
export function payrollTotals({ run, payments = [] }) {
    const t = run?.totals || {};
    const sum = list => list.reduce((s, p) => s + (p.amountKop || 0) - (p.status === 'paid' ? p.returnedKop || 0 : 0), 0);
    const toPeople = payments.filter(p => whoOf(p) && !isTax(p) && live(p));
    const toTax = payments.filter(p => isTax(p) && live(p));
    const rows = run?.rows || [];
    return {
        employees: rows.filter(r => r.kind !== 'gph').length,
        contractors: rows.filter(r => r.kind === 'gph').length,
        grossKop: t.grossKop || 0,
        netKop: t.netKop || 0,
        taxKop: (t.pdfoKop || 0) + (t.vzKop || 0) + (t.esvKop || 0),
        netPaidKop: sum(toPeople.filter(p => p.status === 'paid')),
        netSigningKop: sum(toPeople.filter(p => p.status !== 'paid')),
        taxPaidKop: sum(toTax.filter(p => p.status === 'paid')),
        taxSigningKop: sum(toTax.filter(p => p.status !== 'paid'))
    };
}

// ------------------------------------------------------------
// Хід місяця: табель → затвердження → аванс → зарплата
// ------------------------------------------------------------

/** Стан етапу виплати: 'none' | 'building' | 'signing' | 'paid' | 'partial'. */
export function stageState(ctx, stage) {
    const s = ctx.stages?.[stage];
    if (!s) return 'none';
    if (s.project && s.project.status !== 'prepared') return 'building';
    if (s.complete === false) return 'partial';
    const mine = (ctx.payments || []).filter(p => p.stage === stage && live(p));
    if (s.project?.bankStatus === 'F' && mine.every(p => p.status === 'paid' || p.status === 'sent')) return 'paid';
    if (mine.length && mine.every(p => p.status === 'paid')) return 'paid';
    return 'signing';
}

/** Чотири кроки місяця для смуги вгорі: [{ key, title, state: done|current|todo|skip, note }]. */
export function flowSteps(ctx) {
    const approved = ctx.status === 'approved';
    const t = ctx.run?.totals || {};
    const adv = stageState(ctx, 'advance'), fin = stageState(ctx, 'final');
    const noAdvance = !ctx.stages?.advance && (!t.advance?.netKop || ctx.stages?.final);
    const stageNote = (st, kop) => ({ none: kop ? `${fmt(kop)} грн` : '', building: 'готується в банку', partial: 'не всі платежі', signing: 'на підписі', paid: 'виплачено' }[st]);
    const steps = [
        { key: 'sheet', title: 'Табель', done: ctx.status !== 'none', note: ctx.status === 'none' ? 'чернетка розрахунку' : 'збережено' },
        { key: 'approve', title: 'Затвердження', done: approved, note: approved ? 'голова затвердив' : ctx.status === 'draft' ? 'чекає голову' : '' },
        { key: 'advance', title: 'Аванс', done: ['signing', 'paid'].includes(adv), skip: noAdvance, note: noAdvance ? 'без авансу' : stageNote(adv, t.advance?.netKop) },
        { key: 'final', title: 'Зарплата', done: ['signing', 'paid'].includes(fin), note: stageNote(fin, ctx.stages?.advance ? t.final?.netKop : t.netKop) }
    ];
    const current = steps.findIndex(s => !s.done && !s.skip);
    return steps.map((s, i) => ({ key: s.key, title: s.title, note: s.note || '', state: s.skip ? 'skip' : s.done ? 'done' : i === current ? 'current' : 'todo' }));
}
const fmt = kop => (Math.round(kop) / 100).toFixed(2).replace('.', ',').replace(/\B(?=(\d{3})+(?!\d))/g, ' ');

/**
 * Головна підказка місяця: що зробити зараз.
 * { tone: 'todo'|'wait'|'done'|'bad', title, hint, act?, btn?, tab? }
 */
export function nextPayrollAction(ctx, role) {
    const chair = role === 'chair';
    const t = ctx.run?.totals || {};
    const people = ctx.people || [];
    const rows = ctx.run?.rows || [];
    if (!people.length) return { tone: 'todo', title: 'Додайте першого працівника', hint: 'Двірник, прибиральниця, бухгалтер за трудовим договором чи виконавець за договором ЦПД — відомість місяця складеться сама.', act: 'person-new', btn: 'Додати працівника' };
    if (ctx.run?.rateError) return { tone: 'bad', title: 'Немає ставок податків на цей місяць', hint: ctx.run.rateError, go: 'settings', btn: 'Перевірити ставки' };
    if (ctx.closed) return { tone: 'done', title: 'Місяць закрито', hint: 'Відомість і виплати змінювати не можна. Перерахунок — у відомості наступного місяця.' };
    if (!rows.length) return { tone: 'todo', title: 'У цьому місяці відомість порожня', hint: 'Немає діючих працівників і договорів ЦПД — перевірте дати прийому й звільнення в картках.', tab: 'people', btn: 'До працівників' };
    const fin = stageState(ctx, 'final'), adv = stageState(ctx, 'advance');
    const locked = Boolean(ctx.stages?.final);
    if (!locked && ctx.pendingLeaves) return { tone: 'todo', title: 'У графіку є нові відпустки чи лікарняні', hint: 'Їх ще немає в розрахунку. Перерахуйте відомість — суми зміняться, і вона знову піде голові на затвердження.', act: 'save', btn: 'Перерахувати' };
    if (ctx.status === 'none') return { tone: 'todo', title: 'Перевірте табель і збережіть відомість', hint: 'Нижче — попередній розрахунок за повний місяць. Внесіть відпрацьовані дні, премії, відпустки чи суми актів ЦПД, потім збережіть — відомість піде голові.', act: 'save', btn: 'Зберегти відомість' };
    const broken = rows.filter(r => r.netKop > 0 && r.problems?.length);
    if (ctx.status === 'draft') {
        if (broken.length) return { tone: 'bad', title: `Виправте ${broken.length === 1 ? 'картку' : 'картки'}: ${broken.map(r => r.name).join(', ')}`, hint: broken.map(r => `${r.name}: ${r.problems.join('; ')}`).join(' · '), tab: 'people', btn: 'До працівників' };
        return chair
            ? { tone: 'todo', title: 'Затвердьте відомість', hint: `Нараховано ${fmt(t.grossKop || 0)} грн, людям ${fmt(t.netKop || 0)} грн, ЄСВ ${fmt(t.esvKop || 0)} грн. Після затвердження бухгалтер готує виплату, а ви підписуєте в Приват24.`, act: 'approve', btn: 'Затвердити' }
            : { tone: 'wait', title: 'Відомість чекає затвердження голови', hint: 'Голова бачить її у своєму кабінеті. Поки не затверджено, табель можна змінювати.' };
    }
    if (broken.length && fin === 'none') return { tone: 'bad', title: `Виправте ${broken.length === 1 ? 'картку' : 'картки'}: ${broken.map(r => r.name).join(', ')}`, hint: broken.map(r => `${r.name}: ${r.problems.join('; ')}`).join(' · '), tab: 'people', btn: 'До працівників' };
    const project = ctx.settings?.payMethod === 'project';
    const how = project ? 'Працівникам — однією відомістю зарплатного проекту, податки й ЦПД — платежами. Голова підписує в Приват24.' : 'Платежі людям і податків підуть у Приват24 на підпис голови.';
    if (adv === 'building' || fin === 'building') return { tone: 'todo', title: 'Завершіть підготовку відомості в Приват24', hint: 'Частину працівників ще не додано у відомість банку. Продовжіть — уже додані не дублюються.', act: adv === 'building' ? 'pay-advance' : 'pay-final', btn: 'Продовжити' };
    if (adv === 'partial' || fin === 'partial') return { tone: 'bad', title: 'Частину платежів не створено', hint: 'Виправте реквізити в картці працівника чи рахунки податків і продовжте виплату.', act: adv === 'partial' ? 'pay-advance' : 'pay-final', btn: 'Продовжити виплату' };
    if (adv === 'none' && fin === 'none' && t.advance?.netKop > 0) return { tone: 'todo', title: `Виплатіть аванс — ${fmt(t.advance.netKop)} грн`, hint: `За першу половину місяця, разом із відпускними. ${how}`, act: 'pay-advance', btn: 'Виплатити аванс', alt: { act: 'pay-final', btn: 'Одразу всю зарплату' } };
    if (fin === 'none') return { tone: 'todo', title: `Виплатіть зарплату — ${fmt(ctx.stages?.advance ? t.final?.netKop || 0 : t.netKop || 0)} грн`, hint: `Остаточний розрахунок — не пізніше 7 днів після кінця місяця. ${how}`, act: 'pay-final', btn: 'Виплатити зарплату' };
    if (fin === 'signing') return { tone: 'wait', title: 'Зарплата на підписі в Приват24', hint: chair ? 'Підпишіть платежі й відомість зарплатного проекту в Приват24 для бізнесу. Факт оплати підтвердить виписка.' : 'Голова підписує платежі в Приват24. Коли банк проведе, суми зʼявляться у виписці й закриють виплату.', tab: project ? 'bank' : null, btn: project ? 'Стан у банку' : null };
    return { tone: 'done', title: 'Зарплату за місяць виплачено', hint: 'Дані для звіту ДПС (додаток 4ДФ і Д1) вже у «Звітах».', go: 'reports', btn: 'До звітів' };
}

/** Стан відомості банку → крок смуги (1 створена … 5 проведена) і текст. */
export function bankStep(status, substatus) {
    if (status === 'R') return { step: 0, bad: true, text: 'Забракована банком' };
    if (status === 'D') return { step: 0, bad: true, text: 'Видалена в банку' };
    if (status === 'F') return { step: 5, bad: substatus === 'R', text: substatus === 'R' ? 'Проведена з помилками' : 'Проведена банком' };
    if (status === 'X') return { step: 4, text: 'Надіслана в банк' };
    if (status === 'S') return { step: 3, done: substatus === 'S$', text: { SB: 'Підписав бухгалтер — чекає директора', SD: 'Підписав директор — чекає бухгалтера', S$: 'Підписана — надішліть у банк' }[substatus] || 'Чекає підпису в Приват24' };
    if (status === 'W') return { step: 2, text: 'Перевірена банком — підпишіть у Приват24' };
    if (status === 'P') return { step: 1, text: 'Банк перевіряє' };
    if (status === 'N') return { step: 1, text: 'Створена, ще не перевірена' };
    return { step: 0, text: status ? `Стан банку: ${status}` : 'Ще не створена' };
}

export const RECORD_STATUS = { N: ['не перевірено', ''], N$: ['помилка — виправте в Приват24', 'is-bad'], R: ['перевірено', 'is-work'], M: ['виплачено', 'is-done'], E: ['забраковано', 'is-bad'] };
