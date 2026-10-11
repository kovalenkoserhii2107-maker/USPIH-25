// ============================================================
// «Звітність»: строки ДПС за календарем, готові цифри Податкового
// розрахунку (J0500111) з затвердженої відомості зарплати, позначки
// «подано / прийнято» й архів квитанцій.
//
// XML (розрахунок + Д1, 4ДФ, Д5) формує сервер із затвердженої
// відомості; голова завантажує його в Електронний кабінет ДПС, бачить
// заповнену форму, підписує КЕП і подає. Квитанції № 1 і № 2
// зберігаються тут (Storage reports/{ключ}/), позначки пише сервер
// (reportsAction, functions/reports.js).
// ============================================================
import { escapeHtml, toast, setBusy } from './ui.js';
import { loadReports, loadPayrollReport, reportsAct, reportsQuery, uploadReportFiles, reportFileUrl } from './buh-data.js';
import { zip, saveBlob } from './xlsx-write.js';
import { fmtKop } from './charges-core.js';
import { humanDate } from './tax-calendar.js';
import { reportSteps, nextAction, pickFocus, reportTasks, periodOfKey } from './reports-view-core.js';

export { reportTasks, periodOfKey };

const E_CABINET = 'https://cabinet.tax.gov.ua/';
const MONTHS = ['січень', 'лютий', 'березень', 'квітень', 'травень', 'червень', 'липень', 'серпень', 'вересень', 'жовтень', 'листопад', 'грудень'];
const monthName = p => `${MONTHS[Number(p.slice(5, 7)) - 1]} ${p.slice(0, 4)}`;
const dmy = iso => (iso ? iso.split('-').reverse().join('.') : '');

// Які позначки має кожен вид строку.
const MARKS = {
    report: [['submitted', 'Подано (квитанція № 1)'], ['accepted', 'Прийнято (квитанція № 2)'], ['rejected', 'Відхилено'], ['not_required', 'Подавати не потрібно']],
    payment: [['paid', 'Сплачено'], ['not_required', 'Сплачувати не потрібно']],
    decision: [['accepted', 'Затверджено зборами'], ['not_required', 'Не потрібно']]
};
const STATUS = {
    submitted: ['подано · чекає квитанцію № 2', 'is-review'], accepted: ['прийнято', 'is-payment'], rejected: ['відхилено', 'is-error'],
    not_required: ['не потрібно', 'is-muted'], paid: ['сплачено', 'is-payment']
};

let ctx = null;
let selected = null;        // ключ відкритого строку
let detail = null;          // дані розрахунку за місяць
let xmlState = null;        // { settings } — форма реквізитів, { problems } чи { files } — результат XML
let heroDetail = null;      // дані розрахунку для картки зверху

/** Версії пакета XML звіту, новіші вгорі. */
const packsOf = key => ctx?.packages?.[key] || [];
const stamp = iso => (iso ? new Date(iso).toLocaleString('uk-UA', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '');
const versionOf = id => Number(String(id || '').split('--')[1]) || null;

/** Відкрити розділ на строку (із «Вхідних» чи «Огляду»). */
export function openReports(key) {
    if (key) { selected = key; detail = null; }
    if (location.hash !== '#reports') location.hash = 'reports';
    else loadReportsView();
}

function leftText(t) {
    if (t.done) return '';
    if (t.left < 0) return `<span class="is-out">прострочено ${-t.left} дн.</span>`;
    return t.left === 0 ? 'сьогодні' : t.left === 1 ? 'завтра' : `${t.left} дн.`;
}

function rowHtml(t) {
    const [label, cls] = t.mark ? STATUS[t.mark.status] || [t.mark.status, ''] : t.left < 0 ? ['не позначено', 'is-error'] : ['чекає', 'is-review'];
    return `<li class="deadline rp-item${t.key === selected ? ' is-open' : ''}${!t.done && t.left <= 3 ? ' is-near' : ''}">
        <button type="button" class="rp-row" data-act="open" data-key="${escapeHtml(t.key)}" aria-expanded="${t.key === selected}">
            <span class="deadline-date"><b>${t.date.getUTCDate()}</b>${escapeHtml(humanDate(t.date).split(' ')[1])}</span>
            <span class="deadline-text"><b>${escapeHtml(t.title)}</b><small>${escapeHtml(t.detail)}${t.mark?.regNumber ? ` · № ${escapeHtml(t.mark.regNumber)}` : ''}</small></span>
            <span class="rp-state"><span class="buh-tag ${cls}">${escapeHtml(label)}</span><small>${leftText(t)}</small></span>
        </button>
        ${t.key === selected ? `<div class="rp-detail" id="rpDetail">${detailHtml(t)}</div>` : ''}
    </li>`;
}

// ------------------------------------------------------------
// ПОДАТКОВИЙ РОЗРАХУНОК ЗА МІСЯЦЬ
// ------------------------------------------------------------
function payrollHtml(d) {
    if (!d) return '<p class="list-empty">Рахую…</p>';
    const s = d.summary;
    const checks = d.checks.length ? `<ul class="rp-checks">${d.checks.map(c => `<li class="is-${c.level}">${escapeHtml(c.text)}</li>`).join('')}</ul>` : '';
    if (!d.income.length) return `${checks}<p class="buh-note">${d.status === 'approved' ? 'Виплат фізособам за місяць немає. Якщо працівників не було весь місяць, розрахунок можна не подавати — позначте «Подавати не потрібно».' : 'Цифри з’являться після затвердження відомості в розділі «Зарплата».'}</p>
        ${d.status !== 'approved' ? `<button type="button" class="btn-soft btn-compact" data-go="payroll">Відкрити «Зарплату»</button>` : ''}`;
    const sum = (a, b) => `${fmtKop(a)}${b !== undefined && b !== a ? `<small>сплачено ${fmtKop(b)}</small>` : ''}`;
    return `<section class="rp-stepbox"><h3 class="rp-h"><span class="rp-num">1</span>Перевірте суми</h3>${checks}
        <div class="kpi-grid rp-kpi">
            <div class="kpi"><span>Нараховано доходу</span><b>${fmtKop(s.grossKop)}</b><small>${s.employees} працівн. · ${s.gph} ЦПД${s.fop ? ` · ${s.fop} ФОП` : ''}</small></div>
            <div class="kpi"><span>ПДФО 18 %</span><b>${fmtKop(s.pdfoKop)}</b><small>сплачено ${fmtKop(s.pdfoPaidKop)}</small></div>
            <div class="kpi"><span>Військовий збір 5 %</span><b>${fmtKop(s.vzKop)}</b><small>сплачено ${fmtKop(s.vzPaidKop)}</small></div>
            <div class="kpi"><span>ЄСВ 22 %</span><b>${fmtKop(s.esvKop)}</b><small>база ${fmtKop(s.esvBaseKop)} · сплачено ${fmtKop(s.esvPaidKop)}</small></div>
        </div>
        <details class="rp-fold"><summary>Додаток 4ДФ — доходи, ПДФО й військовий збір<small>${d.income.length}</small></summary>
        <div class="jr-scroll"><table class="buh-table is-compact rp-table"><thead><tr><th>РНОКПП</th><th>ПІБ</th><th>Ознака</th><th class="t-sum">Нараховано</th><th class="t-sum">Виплачено</th><th class="t-sum">ПДФО</th><th class="t-sum">ВЗ</th></tr></thead>
            <tbody>${d.income.map(r => `<tr><td>${escapeHtml(r.rnokpp || '—')}</td><td class="t-main">${escapeHtml(r.name)}</td><td>${r.sign}<small>${r.kind === 'gph' ? 'ЦПД' : r.kind === 'fop' ? 'ФОП' : 'зарплата'}${r.earlierKop ? `, виплачено за попередній місяць ${fmtKop(r.earlierKop)}` : ''}${r.vacationKop ? `, з них відпускні ${fmtKop(r.vacationKop)}` : ''}${r.sickKop ? `, лікарняні ${fmtKop(r.sickKop)}` : ''}${r.pspKop ? ` · ПСП ${r.pspCode}: ${fmtKop(r.pspKop)}` : ''}</small></td>
                <td class="t-sum">${fmtKop(r.grossKop)}</td><td class="t-sum">${fmtKop(r.paidKop)}</td><td class="t-sum">${sum(r.pdfoKop, r.pdfoPaidKop)}</td><td class="t-sum">${sum(r.vzKop, r.vzPaidKop)}</td></tr>`).join('')}</tbody></table></div></details>
        <details class="rp-fold"><summary>Додаток Д1 — єдиний внесок<small>${d.esv.length}</small></summary>
        <div class="jr-scroll"><table class="buh-table is-compact rp-table"><thead><tr><th>РНОКПП</th><th>ПІБ</th><th>Відносини</th><th class="t-sum">Нараховано</th><th class="t-sum">Доплата до мін.</th><th class="t-sum">База</th><th class="t-sum">ЄСВ</th></tr></thead>
            <tbody>${d.esv.map(r => `<tr><td>${escapeHtml(r.rnokpp || '—')}</td><td class="t-main">${escapeHtml(r.name)}</td><td>${r.kind === 'gph' ? 'договір ЦПД' : 'трудові'} · ${r.days ?? '—'} з ${r.normDays} кал. дн.</td>
                <td class="t-sum">${fmtKop(r.grossKop)}</td><td class="t-sum">${r.topUpKop ? fmtKop(r.topUpKop) : '—'}</td><td class="t-sum">${fmtKop(r.baseKop)}</td><td class="t-sum">${fmtKop(r.esvKop)}</td></tr>`).join('')}</tbody></table></div></details>
        ${d.relations.length ? `<details class="rp-fold"><summary>Додаток Д5 — трудові відносини й договори ЦПД<small>${d.relations.length}</small></summary>
        <table class="buh-table is-compact"><tbody>${d.relations.map(r => `<tr><td>${escapeHtml(r.rnokpp || '—')}</td><td class="t-main">${escapeHtml(r.name)}<small>${escapeHtml(r.position || (r.kind === 'gph' ? 'договір ЦПД' : 'працівник'))}</small></td>
            <td>${r.kind === 'gph' ? (r.event === 'start' ? 'початок договору' : 'кінець договору') : (r.event === 'start' ? 'прийнято' : 'звільнено')}</td><td>${dmy(r.date)}</td></tr>`).join('')}</tbody></table></details>` : ''}</section>
        <section class="rp-stepbox"><h3 class="rp-h"><span class="rp-num">2</span>Файли для підпису голови</h3>
        <details class="rp-fold"><summary>Як подати в Електронному кабінеті</summary><p class="buh-note">Звіт подає голова в Електронному кабінеті ДПС: «Завантажити XML» нижче → у кабінеті «Звітність → Завантаження» обрати файли з архіву (розрахунок і додатки разом) → перевірити заповнену форму → підписати КЕП і надіслати. Ознака доходу 101 — зарплата, 102 — договір ЦПД. Д1: категорії 1 — працівник, 26 — ЦПД, 29 — лікарняні; відпускні — тип 10, різниця до мінімальної бази — тип 13. Сплата ЄСВ — до ${dmy(s.due)}.</p></details>
        ${d.status === 'approved' ? `<div class="rp-form rp-xml-opts">
            <label class="field"><span>Вид розрахунку</span><select class="field-input field-select" id="rpStan"><option value="1">звітний</option></select><small>Коригування попереднього подання — в Електронному кабінеті за даними CSV.</small></label>
            <label class="field"><span>Номер розрахунку</span><input class="field-input" id="rpNum" inputmode="numeric" maxlength="4" value="1"></label>
        </div>` : ''}
        <div class="rp-actions">${d.status === 'approved' ? '<button type="button" class="btn-primary btn-compact" data-act="xml">Завантажити XML</button>' : ''}
            <button type="button" class="btn-soft btn-compact" data-act="xml-settings">Реквізити для XML</button>
            <button type="button" class="btn-soft btn-compact" data-act="csv">CSV для перенесення</button>
            <a class="btn-soft btn-compact" href="${E_CABINET}" target="_blank" rel="noopener">Електронний кабінет ↗</a></div>
        <div id="rpXml">${xmlHtml()}</div></section>`;
}

// ------------------------------------------------------------
// XML ДЛЯ ЕЛЕКТРОННОГО КАБІНЕТУ
// ------------------------------------------------------------
const XML_INPUTS = [
    ['katottg', 'Код КАТОТТГ (UA і 17 цифр, з витягу ЄДР)', 'maxlength="19" spellcheck="false"'], ['zip', 'Поштовий індекс', 'inputmode="numeric" maxlength="5"'],
    ['address', 'Податкова адреса'], ['phone', 'Телефон', 'inputmode="tel"'], ['email', 'Ел. пошта', 'type="email"'],
    ['headName', 'Керівник: власне імʼя та прізвище'], ['headTin', 'РНОКПП керівника', 'inputmode="numeric" maxlength="10"'],
    ['accName', 'Бухгалтер: власне імʼя та прізвище (якщо є)'], ['accTin', 'РНОКПП бухгалтера', 'inputmode="numeric" maxlength="10"']
];

function xmlHtml() {
    if (!xmlState) return '';
    if (xmlState.settings) {
        const { settings: v, offices, org } = xmlState.settings;
        return `<form class="rp-mark rp-xml" onsubmit="return false">
            <h3 class="rp-h">Реквізити для XML</h3>
            <p class="buh-note">${escapeHtml(org.name || 'Назва ОСББ')} · ЄДРПОУ ${escapeHtml(org.edrpou || '—')} · КВЕД ${escapeHtml(org.kved || '—')} — з «Налаштування → ОСББ у реєстрах». РНОКПП тут бачать лише голова й бухгалтер.</p>
            <div class="rp-form">
                <label class="field rp-wide"><span>Податкова (куди подається)</span><select class="field-input field-select" name="sti">${offices.map(o => `<option value="${o.code}"${o.code === Number(v.sti) ? ' selected' : ''}>${escapeHtml(`${o.code} — ${o.name}`)}</option>`).join('')}</select></label>
                ${XML_INPUTS.map(([k, label, extra = '']) => `<label class="field${k === 'address' ? ' rp-wide' : ''}"><span>${label}</span><input class="field-input" name="${k}" value="${escapeHtml(v[k] || '')}" ${extra}></label>`).join('')}
            </div>
            <div class="rp-actions"><button type="button" class="btn-primary btn-compact" data-act="xml-save">Зберегти реквізити</button><button type="button" class="btn-ghost-small" data-act="xml-close">Закрити</button></div>
        </form>`;
    }
    if (xmlState.problems) {
        return `<div class="rp-xml"><h3 class="rp-h">Щоб сформувати XML, заповніть</h3>
            <ul class="rp-checks">${xmlState.problems.map(p => `<li class="is-warn">${escapeHtml(p)}</li>`).join('')}</ul>
            <p class="buh-note">Стать, код професії й накази — у картці людини («Зарплата → Люди»).</p></div>`;
    }
    return `<div class="rp-xml"><h3 class="rp-h">Файли для Електронного кабінету${xmlState.version ? ` · версія ${xmlState.version}` : ''}</h3>
        <ul class="rp-files">${xmlState.files.map((f, i) => `<li><button type="button" class="btn-ghost-small" data-act="xml-file" data-i="${i}">${escapeHtml(f.name)}</button><small>${['розрахунок', 'Д1', '4ДФ', 'Д5'][i] || ''}</small></li>`).join('')}</ul>
        <p class="buh-note">Архів уже завантажено й збережено як версію ${xmlState.version || ''} — готово до підпису; файли можна взяти й поодинці. Перед підписом звірте в кабінеті суми з таблицями вище. Після подання позначте, яку версію подано, і додайте квитанції нижче.</p></div>`;
}

const fileBytes = f => Uint8Array.from(atob(f.data), c => c.charCodeAt(0));

function showXml() {
    const host = document.getElementById('rpXml');
    if (host) host.innerHTML = xmlHtml();
}

async function buildXml(btn) {
    setBusy(btn, true, 'Формую…');
    try {
        const stan = Number(document.getElementById('rpStan')?.value) || 1;
        const num = Number(document.getElementById('rpNum')?.value) || 1;
        const out = await reportsQuery({ action: 'xml', period: detail.period, stan, num });
        if (out.problems.length) { xmlState = { problems: out.problems }; showXml(); return; }
        // Сервер зберіг цю версію пакета: саме її голова підпише, до неї привʼяжуться квитанції.
        xmlState = { files: out.files, version: out.version };
        const key = detail.key;
        ctx.packages = { ...(ctx.packages || {}), [key]: [{ id: out.packageId, key, version: out.version, hash: out.hash, stan, num, at: new Date().toISOString(),
            files: out.files.map(f => ({ name: f.name })) }, ...packsOf(key)] };
        showXml();
        saveBlob(zip(out.files.map(f => ({ name: f.name, data: fileBytes(f) })), 'application/zip'), `J0500111-${detail.period}-v${out.version}.zip`);
        toast(`Версія ${out.version} готова до підпису`, 'success');
    } finally { if (btn.isConnected) setBusy(btn, false); }
}

async function saveXmlSettings(btn) {
    const form = btn.closest('.rp-xml');
    const data = Object.fromEntries([...form.querySelectorAll('[name]')].map(i => [i.name, i.value.trim()]));
    setBusy(btn, true, 'Зберігаю…');
    try {
        await reportsAct({ action: 'saveXmlSettings', ...data, sti: Number(data.sti) });
        xmlState = null;
        toast('Реквізити збережено', 'success');
    } finally { if (btn.isConnected) setBusy(btn, false); }
}

function otherHtml(t) {
    if (t.key.startsWith('esv-')) {
        const p = periodOfKey(t.key);
        return `<p class="buh-note">ЄСВ за ${escapeHtml(monthName(p))} — 22 % нарахованих виплат, платіж за реквізитами з «Зарплата → Податки й аванс». Позначка «сплачено» ставиться сама, коли сума проведених платежів покриває все місячне нарахування.</p>
            <button type="button" class="btn-soft btn-compact" data-go="payroll">Відкрити «Зарплату»</button>`;
    }
    if (t.key.startsWith('budget-')) {
        return `<p class="buh-note">Кошторис на рік затверджують загальні збори (п. 4.12.2 статуту). Номер протоколу — у позначці нижче.</p><button type="button" class="btn-soft btn-compact" data-go="budget">Відкрити «Кошторис»</button>`;
    }
    if (t.key.startsWith('npo-') || t.key.startsWith('fs-stat-')) {
        return `<p class="buh-note">Річні звіти складаються з оборотно-сальдової відомості за рік («Проводки»). Облік у застосунку почався з жовтня 2026 р.: січень–вересень — дані сервісу бухгалтера, їх буде імпортовано (частина 10). Форму заповнює й перевіряє бухгалтер, подає голова в Електронному кабінеті.</p>
            <div class="rp-actions"><button type="button" class="btn-soft btn-compact" data-go="journal">Відкрити «Проводки»</button><a class="btn-soft btn-compact" href="${E_CABINET}" target="_blank" rel="noopener">Електронний кабінет ↗</a></div>`;
    }
    return '';
}

function markHtml(t) {
    const mark = t.mark && !t.mark.auto ? t.mark : null;
    const options = MARKS[t.kind] || MARKS.report;
    const files = mark?.files || [];
    const regLabel = t.kind === 'decision' ? '№ протоколу' : 'Реєстраційний № у ДПС';
    const packs = packsOf(t.key);
    const chosen = mark?.packageId || packs[0]?.id || '';
    return `<form class="rp-mark" data-key="${escapeHtml(t.key)}" onsubmit="return false">
        <h3 class="rp-h">${t.key.startsWith('j0500111-') ? '<span class="rp-num">3</span>Подано й прийнято' : 'Позначка'}</h3>
        ${packs.length ? `<div class="rp-versions"><span class="bk-label">Версії пакета XML</span><ul class="rp-files">${packs.map(p => `<li>
            <button type="button" class="btn-ghost-small" data-act="pkg" data-id="${escapeHtml(p.id)}">Версія ${p.version}</button>
            <small>${escapeHtml(stamp(p.at))}${mark?.packageId === p.id ? ` · ${escapeHtml(STATUS[mark.status]?.[0] || mark.status)}` : p === packs[0] && !mark ? ' · готова до підпису' : ''}</small></li>`).join('')}</ul></div>` : ''}
        ${files.length ? `<ul class="rp-files">${files.map(f => `<li><button type="button" class="btn-ghost-small" data-act="file" data-path="${escapeHtml(f.path)}">${escapeHtml(f.name)}</button><small>${escapeHtml(ctx.fileKinds[f.kind] || '')}${f.packageId ? ` · версія ${versionOf(f.packageId)}` : ''}</small></li>`).join('')}</ul>` : ''}
        <div class="rp-form">
            ${packs.length ? `<label class="field"><span>Яку версію подано</span><select class="field-input field-select" name="packageId">${packs.map(p => `<option value="${escapeHtml(p.id)}"${p.id === chosen ? ' selected' : ''}>Версія ${p.version} · ${escapeHtml(stamp(p.at))}</option>`).join('')}</select></label>` : ''}
            <label class="field"><span>Стан</span><select class="field-input field-select" name="status">${options.map(([v, l]) => `<option value="${v}"${(mark?.status || options[0][0]) === v ? ' selected' : ''}>${l}</option>`).join('')}</select></label>
            <label class="field"><span>Дата</span><input class="field-input" type="date" name="date" value="${escapeHtml(mark?.date || ctx.today)}" max="${ctx.today}"></label>
            ${t.kind === 'payment' ? '' : `<label class="field"><span>${regLabel}</span><input class="field-input" name="regNumber" maxlength="40" value="${escapeHtml(mark?.regNumber || '')}"></label>`}
            <label class="field rp-wide"><span>Примітка</span><input class="field-input" name="note" maxlength="300" value="${escapeHtml(mark?.note || '')}" placeholder="${t.kind === 'report' ? 'напр. причина відмови' : ''}"></label>
            ${t.kind === 'report' ? `<label class="field"><span>Звіт (XML / PDF)</span><input class="field-input" type="file" data-kind="report" accept=".xml,.pdf,.p7s,application/pdf,text/xml"></label>
            <label class="field"><span>Квитанція № 1</span><input class="field-input" type="file" data-kind="receipt1"></label>
            <label class="field"><span>Квитанція № 2</span><input class="field-input" type="file" data-kind="receipt2"></label>` : `<label class="field"><span>Документ</span><input class="field-input" type="file" data-kind="other"></label>`}
        </div>
        <div class="rp-actions"><button type="button" class="btn-primary btn-compact" data-act="mark">Зберегти позначку</button>
            ${mark ? '<button type="button" class="btn-ghost-small" data-act="unmark">Зняти позначку</button>' : ''}</div>
    </form>`;
}

function detailHtml(t) {
    const body = t.key.startsWith('j0500111-') ? payrollHtml(detail) : otherHtml(t);
    return `${body}${markHtml(t)}`;
}

// ------------------------------------------------------------
// ГОЛОВНИЙ СТРОК І НАЙБЛИЖЧІ
// ------------------------------------------------------------
const CHECK = '<svg width="28" height="28" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="11" fill="currentColor"/><path d="M7.5 12.5l3 3 6-6" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const dueText = t => `до ${humanDate(t.date)}`;
const KICKER = { report: 'До податкової', payment: 'Сплата', decision: 'Рішення зборів' };

function heroHtml(t) {
    if (!t) return `<section class="py-card rp-hero"><span class="bk-label">Звіти</span><h2 class="rp-hero-title">Найближчим часом нічого подавати не треба</h2>
        <p class="py-note">Строки нижче — за календарем ДПС; позначки й квитанції зберігаються тут.</p></section>`;
    const left = leftText(t);
    const head = `<div class="rp-hero-head"><div><span class="bk-label">${escapeHtml(KICKER[t.kind] || 'Строк')}${periodOfKey(t.key) ? ` · за ${escapeHtml(monthName(periodOfKey(t.key)))}` : ''}</span>
            <h2 class="rp-hero-title">${escapeHtml(t.title)}</h2></div>
        <span class="rp-due${!t.done && t.left <= 3 ? ' is-near' : ''}">${escapeHtml(dueText(t))}${left ? `<small>${left}</small>` : ''}</span></div>`;
    if (!t.key.startsWith('j0500111-')) {
        return `<section class="py-card rp-hero">${head}<p class="py-note">${escapeHtml(t.detail)}</p>
            <div class="rp-hero-actions"><button type="button" class="sv-btn" data-act="hero-open">Відкрити й позначити</button></div></section>`;
    }
    const d = heroDetail?.key === t.key ? heroDetail : null;
    const steps = reportSteps({ approved: d?.status === 'approved', hasIncome: !d || d.income.length > 0, mark: t.mark, pack: packsOf(t.key)[0] || null });
    const next = nextAction(steps);
    const s = d?.summary;
    return `<section class="py-card rp-hero" id="rpHero">${head}
        <ol class="rp-steps">${steps.map(st => `<li class="is-${st.state}"><span class="rp-dot" aria-hidden="true">${st.state === 'done' ? CHECK : ''}</span>
            <span class="rp-step"><b>${escapeHtml(st.title)}</b><small>${escapeHtml(st.note)}</small></span></li>`).join('')}</ol>
        ${s && d.income.length ? `<div class="rp-sums">
            <div><span>Дохід</span><b>${fmtKop(s.grossKop)}</b></div><div><span>ПДФО</span><b>${fmtKop(s.pdfoKop)}</b></div>
            <div><span>Військовий збір</span><b>${fmtKop(s.vzKop)}</b></div><div><span>ЄСВ</span><b>${fmtKop(s.esvKop)}</b></div></div>` : d ? '' : '<p class="py-note">Рахую суми…</p>'}
        <div class="rp-hero-actions">
            ${next ? (next.act === 'go-payroll' ? `<button type="button" class="sv-btn" data-go="payroll">${next.label}</button>`
                : `<button type="button" class="sv-btn" data-act="${next.act}"${next.act === 'hero-xml' && d?.status !== 'approved' ? ' disabled' : ''}>${next.label}</button>`) : ''}
            <button type="button" class="sv-btn is-soft" data-act="hero-open">Розрахунок і позначка</button>
            <a class="sv-btn is-soft" href="${E_CABINET}" target="_blank" rel="noopener">Електронний кабінет ↗</a>
        </div>
    </section>`;
}

function sideHtml(t) {
    const [label, cls] = t.mark ? STATUS[t.mark.status] || [t.mark.status, ''] : t.left < 0 ? ['прострочено', 'is-bad'] : ['', ''];
    return `<button type="button" class="py-card rp-side${!t.done && t.left <= 3 ? ' is-near' : ''}" data-act="open" data-key="${escapeHtml(t.key)}">
        <span class="bk-label">${escapeHtml(t.title)}</span>
        <b class="rp-side-due">${escapeHtml(dueText(t))}</b>
        <span class="py-muted">${escapeHtml(t.detail)}</span>
        ${label ? `<span class="sv-chip ${cls === 'is-payment' ? 'is-done' : cls === 'is-error' ? 'is-bad' : cls}">${escapeHtml(label)}</span>` : `<span class="rp-side-left">${leftText(t)}</span>`}
    </button>`;
}

export async function loadReportsView() {
    ctx = await loadReports();
    const tasks = reportTasks(ctx);
    if (selected && !tasks.some(t => t.key === selected)) selected = null;
    const open = tasks.find(t => t.key === selected);
    if (open?.key.startsWith('j0500111-') && (!detail || detail.key !== open.key)) {
        detail = null;
        loadPayrollReport(periodOfKey(open.key)).then(d => {
            if (selected !== open.key) return;
            detail = d;
            const host = document.getElementById('rpDetail');
            if (host) host.innerHTML = detailHtml(open);
        }).catch(e => toast(e.message, 'error'));
    }
    const focus = pickFocus(tasks);
    if (focus.hero?.key.startsWith('j0500111-') && heroDetail?.key !== focus.hero.key) {
        const key = focus.hero.key;
        loadPayrollReport(periodOfKey(key)).then(d => {
            heroDetail = d;
            const host = document.getElementById('rpHero');
            if (host && focus.hero.key === key) host.outerHTML = heroHtml(focus.hero);
        }).catch(() => {});
    }
    // Подано й чекаємо квитанцію № 2 — окремо: дії вже не треба, лише додати квитанцію, коли прийде.
    const attention = tasks.filter(t => !t.done && !t.waiting && t.left <= 30);
    const waiting = tasks.filter(t => t.waiting);
    const later = tasks.filter(t => !t.done && !t.waiting && t.left > 30);
    const done = tasks.filter(t => t.done).reverse();
    const group = (title, list, empty) => `<section class="py-card rp-group"><div class="py-card-head"><h2>${title}</h2><span>${list.length || ''}</span></div>
        ${list.length ? `<ul class="deadline-list rp-list">${list.map(rowHtml).join('')}</ul>` : `<p class="py-empty">${empty}</p>`}</section>`;
    document.getElementById('viewReports').innerHTML = `
        <div class="rp-top">${heroHtml(focus.hero)}${focus.side.length ? `<div class="rp-sides">${focus.side.map(sideHtml).join('')}</div>` : ''}</div>
        ${group('Найближчі строки', attention, 'Найближчим місяцем нічого подавати не треба')}
        ${waiting.length ? group('Подано — чекаємо квитанцію № 2', waiting, '') : ''}
        ${later.length ? group('Далі', later, '') : ''}
        ${group('Виконано', done, 'Позначок ще немає')}
        <p class="buh-note">Строки — за правилами ПКУ (docs/accounting/LEGAL.md, розділ 11); з вихідного строк подання переноситься на понеділок. Звіти до ${escapeHtml(monthName(ctx.start))} подає сервіс бухгалтера. Пряме подання з підписом КЕП у браузері — наступний етап.</p>`;
    return attention.filter(t => t.left <= 10).length;
}

// ------------------------------------------------------------
// ДІЇ
// ------------------------------------------------------------
function csv() {
    const m = (kop) => (kop / 100).toFixed(2).replace('.', ',');
    const cell = v => (/[;"\r\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
    const rows = [['Додаток', 'РНОКПП', 'ПІБ', 'Ознака / відносини', 'Нараховано', 'Виплачено', 'ПДФО', 'ПДФО сплачено', 'ВЗ', 'ВЗ сплачено', 'База ЄСВ', 'ЄСВ']];
    for (const r of detail.income) rows.push(['4ДФ', r.rnokpp, r.name, `${r.sign}${r.pspCode ? ` ПСП ${r.pspCode}` : ''}`, m(r.grossKop), m(r.paidKop), m(r.pdfoKop), m(r.pdfoPaidKop), m(r.vzKop), m(r.vzPaidKop), '', '']);
    for (const r of detail.esv) rows.push(['Д1', r.rnokpp, r.name, r.kind === 'gph' ? 'ЦПД' : `трудові ${r.days ?? '—'}/${r.normDays}`, m(r.grossKop), '', '', '', '', '', m(r.baseKop), m(r.esvKop)]);
    for (const r of detail.relations) rows.push(['Д5', r.rnokpp, r.name, `${r.event === 'start' ? 'початок' : 'кінець'} ${dmy(r.date)}`, '', '', '', '', '', '', '', '']);
    const blob = new Blob(['﻿' + rows.map(r => r.map(cell).join(';')).join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `J0500111-${detail.period}${detail.edrpou ? `-${detail.edrpou}` : ''}.csv`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

async function onAction(btn) {
    const a = btn.dataset.act;
    try {
        if (a === 'open' || a === 'hero-open' || a === 'hero-xml') {
            const key = a === 'open' ? btn.dataset.key : pickFocus(reportTasks(ctx)).hero?.key;
            const fromList = a === 'open' && btn.classList.contains('rp-row');
            selected = fromList && selected === key ? null : key;
            detail = selected && heroDetail?.key === selected ? heroDetail : null;
            xmlState = null;
            await loadReportsView();
            if (!fromList) document.getElementById('rpDetail')?.closest('.rp-item')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
            if (a === 'hero-xml' && detail) { await buildXml(btn); document.getElementById('rpXml')?.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
            return;
        }
        if (a === 'csv' && detail) { csv(); return; }
        if (a === 'xml' && detail) { await buildXml(btn); return; }
        if (a === 'xml-settings') { xmlState = { settings: await reportsQuery({ action: 'xmlSettings' }) }; showXml(); return; }
        if (a === 'xml-close') { xmlState = null; showXml(); return; }
        if (a === 'xml-save') { await saveXmlSettings(btn); showXml(); return; }
        if (a === 'xml-file') {
            const f = xmlState?.files?.[Number(btn.dataset.i)];
            if (f) saveBlob(new Blob([fileBytes(f)], { type: 'application/xml' }), f.name);
            return;
        }
        if (a === 'pkg') {
            setBusy(btn, true, 'Завантажую…');
            const p = await reportsQuery({ action: 'package', id: btn.dataset.id });
            saveBlob(zip(p.files.map(f => ({ name: f.name, data: fileBytes(f) })), 'application/zip'), `J0500111-${periodOfKey(p.key)}-v${p.version}.zip`);
            return;
        }
        if (a === 'file') { window.open(await reportFileUrl(btn.dataset.path), '_blank', 'noopener'); return; }
        const form = btn.closest('.rp-mark');
        const key = form?.dataset.key;
        if (!key) return;
        if (a === 'unmark') {
            await reportsAct({ action: 'mark', key, status: 'open', seenAt: ctx.statuses[key]?.at || null });
            toast('Позначку знято', 'success');
        } else if (a === 'mark') {
            setBusy(btn, true, 'Зберігаю…');
            const picked = [...form.querySelectorAll('input[type=file]')].flatMap(i => [...i.files].map(file => ({ file, kind: i.dataset.kind })));
            const uploaded = picked.length ? await uploadReportFiles(key, picked) : [];
            const v = name => form.elements[name]?.value?.trim() || '';
            // Лише нові файли: сервер додає їх до збережених (квитанції з іншої вкладки не зникнуть).
            await reportsAct({ action: 'mark', key, status: v('status'), date: v('date'), regNumber: v('regNumber'), note: v('note'), addFiles: uploaded, ...(v('packageId') ? { packageId: v('packageId') } : {}) });
            toast('Позначку збережено', 'success');
        }
        await loadReportsView();
    } catch (e) { toast(e.message, 'error'); }
    finally { if (btn.isConnected) setBusy(btn, false); }
}

export function initReportsView() {
    document.getElementById('viewReports').addEventListener('click', e => {
        const btn = e.target.closest('[data-act]');
        if (btn && !btn.disabled) onAction(btn);
    });
}
