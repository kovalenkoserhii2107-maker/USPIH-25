// ============================================================
// Претензійно-позовна робота з боржниками.
//
// Екран будується навколо одного питання: «що робити з цим боргом далі?».
//   1. Підсумки: борг будинку, скільки справ потребують дії зараз, суд,
//      реструктуризація.
//   2. Кроки (воронка): Без дій → Претензія → Суд → Виконання,
//      окремо — Реструктуризація. Натиск на крок відбирає боржників.
//   3. Список: квартира, борг і скільки місяців, крок справи й наступна
//      дія з кнопкою.
//   4. Справа — бокова панель: наступний крок, документи, хід справи
//      (стан, дати, номер, хронологія), боржник (власники, ДРРП),
//      реєстри (суди й АСВП через YouScore), реструктуризація з графіком.
//
// Наступну дію, етап зі статусу й графік рахує claims-core.js — те саме
// ядро, що й на сервері (functions/claims-core.js).
//
// Норми: ЗУ «Про ОСББ» (ст. 15–17), ЦПК (ст. 161–171 — наказне
// провадження, ст. 274 — спрощене позовне), ЦК (ст. 625), постанова
// КМУ № 206 у ред. № 1405 (воєнний стан: без пені й штрафів населенню).
// ============================================================
import { db } from './firebase.js';
import { collection, getDocs, query, orderBy } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js';
import { escapeHtml, toast, setBusy } from './ui.js';
import { loadClaims, claimsAct, loadDirectory, loadCharges, loadRequisites } from './buh-data.js';
import { openFlat } from './buh-flats.js';
import {
    COURT_DEFAULT_NAME,
    COURT_DEFAULT_ADDRESS,
    DEFAULT_HOUSE_ADDRESS,
    CLAIM_STATUSES,
    CLAIM_STEPS,
    claimStep,
    nextClaimAction,
    restructureSchedule,
    grnToKop,
    calculateClaimTotals,
    generatePreTrialClaim,
    generateCourtOrderApp,
    generateLawsuitApp,
    generateRestructureAgreement,
    generateDebtCalculation,
    fmtKop
} from './claims-core.js';

const SHOWN = 15;
const BIG_DEBT_KOP = 300000; // 3 000 грн
const MONTHS = ['січня', 'лютого', 'березня', 'квітня', 'травня', 'червня', 'липня', 'серпня', 'вересня', 'жовтня', 'листопада', 'грудня'];
const MONTHS_NOM = ['Січень', 'Лютий', 'Березень', 'Квітень', 'Травень', 'Червень', 'Липень', 'Серпень', 'Вересень', 'Жовтень', 'Листопад', 'Грудень'];
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Kyiv' }).format(new Date());
const human = iso => (/^\d{4}-\d{2}-\d{2}/.test(iso || '') ? `${+iso.slice(8, 10)} ${MONTHS[+iso.slice(5, 7) - 1]} ${iso.slice(0, 4)}` : '');
const periodName = p => (/^\d{4}-\d{2}$/.test(p || '') ? `${MONTHS_NOM[+p.slice(5, 7) - 1]} ${p.slice(0, 4)}` : p || '');
const grn = kop => `${fmtKop(kop)} грн`;
const monthsWord = n => (n % 10 === 1 && n % 100 !== 11 ? 'місяць' : [2, 3, 4].includes(n % 10) && ![12, 13, 14].includes(n % 100) ? 'місяці' : 'місяців');
const aptsWord = n => (n % 10 === 1 && n % 100 !== 11 ? 'квартира' : [2, 3, 4].includes(n % 10) && ![12, 13, 14].includes(n % 100) ? 'квартири' : 'квартир');
const fmtArea = v => {
    const n = typeof v === 'number' ? v : parseFloat(String(v ?? '').replace(',', '.'));
    return Number.isFinite(n) && n > 0 ? n.toFixed(1).replace('.', ',') : '';
};

/** Кроки у воронці — у порядку, в якому йде справа. */
const PIPELINE = ['start', 'pretrial', 'court', 'enforce', 'agreement'];
const STEP_HINT = {
    start: 'борг є, справу не розпочато',
    pretrial: 'нагадування й претензії',
    court: 'накази й позови',
    enforce: 'у виконавчій службі',
    agreement: 'платять за графіком'
};
/** Статуси в списку «Стан справи», згруповані за кроками. */
const STATUS_GROUPS = [
    ['Досудово', ['none', 'warning', 'claim']],
    ['Суд', ['court_order_filed', 'court_order_issued', 'court_order_canceled', 'lawsuit_filed', 'lawsuit_satisfied']],
    ['Після суду', ['enforcement']],
    ['Інше', ['restructured', 'settled']]
];
const DOCS = {
    claim: { title: 'Досудова претензія', when: 'Перший офіційний крок: вимога сплатити за 10 днів.', mark: { status: 'claim', dateField: 'claimDate', label: 'Претензію надіслано' } },
    calculation: { title: 'Довідка-розрахунок боргу', when: 'Додаток до заяви чи позову: нарахування й оплати за місяцями.' },
    court_order: { title: 'Заява про судовий наказ', when: 'Якщо претензію проігноровано. Безспірна вимога, ст. 161 ЦПК.', mark: { status: 'court_order_filed', dateField: 'courtOrderDate', label: 'Заяву подано до суду' } },
    lawsuit: { title: 'Позовна заява', when: 'Якщо наказ скасовано або борг спірний, ст. 274 ЦПК.', mark: { status: 'lawsuit_filed', dateField: 'lawsuitDate', label: 'Позов подано до суду' } },
    restructure: { title: 'Договір реструктуризації', when: 'Коли боржник готовий платити частинами за графіком.', mark: { status: 'restructured', dateField: null, label: 'Договір підписано' } }
};
const TABS = { docs: 'Документи', case: 'Хід справи', debtor: 'Боржник', registers: 'Суди й ДВС', plan: 'Графік' };

let ctx = null;
let step = 'all';          // all | todo | start | pretrial | court | enforce | agreement
let quick = '';            // '' | over3m | big
let sort = 'debt';         // debt | months | apt
let searchQuery = '';
let limit = SHOWN;
let isMartialLaw = true;
let openApt = null;
let tab = 'docs';
let docType = null;
let drawerCleanup = null;
const ledgerCache = new Map();

// ------------------------------------------------------------
// ДАНІ
// ------------------------------------------------------------
async function fetchAptLedger(apt) {
    if (ledgerCache.has(apt)) return ledgerCache.get(apt);
    try {
        const snap = await getDocs(query(collection(db, 'apartments', String(apt), 'ledger'), orderBy('at', 'asc')));
        const list = snap.docs.map(d => ({ id: d.id, ...d.data(), at: d.data().at?.toDate?.() || (d.data().at ? new Date(d.data().at) : null) }));
        ledgerCache.set(apt, list);
        return list;
    } catch (e) {
        console.warn(`Історія квартири ${apt}:`, e);
        return [];
    }
}

function inferPeriods(entries = []) {
    const periods = entries.map(e => String(e.period || '').trim()).filter(p => /^\d{4}-\d{2}$/.test(p)).sort();
    return { periodFrom: periods[0] || '', periodTo: periods.at(-1) || today().slice(0, 7) };
}

/**
 * Сервер (claimsAction) дає справи й реквізити; довідник квартир і нарахування —
 * ті самі баланси, ПІБ і внески, що в «Квартирах». Обʼєднуємо, щоб цифри збігалися.
 */
async function loadSynchronizedClaims() {
    const [rawClaims, dir, charges, req] = await Promise.all([
        loadClaims().catch(err => { console.warn('claimsAction:', err); return null; }),
        loadDirectory().catch(() => []),
        loadCharges().catch(() => null),
        loadRequisites().catch(() => ({}))
    ]);
    isMartialLaw = typeof req?.martialLaw === 'boolean' ? req.martialLaw : rawClaims?.martialLaw !== false;

    const dirByApt = new Map((dir || []).map(a => [String(a.apt), a]));
    const chgByApt = new Map((charges?.apartments || []).map(a => [String(a.apt), a]));
    const monthlyByApt = new Map((charges?.preview?.rows || []).map(r => [String(r.apt), r.amountKop || 0]));
    const srvByApt = new Map((rawClaims?.debtors || []).map(d => [String(d.apt), d]));
    const now = today();

    const debtors = [];
    for (const apt of new Set([...dirByApt.keys(), ...chgByApt.keys(), ...srvByApt.keys()])) {
        const dirApt = dirByApt.get(apt), chgApt = chgByApt.get(apt), srv = srvByApt.get(apt);
        const raw = chgApt?.balance ?? dirApt?.balance;
        const balanceKop = raw !== undefined && raw !== null && raw !== '' ? grnToKop(raw)
            : srv ? (srv.balance !== undefined ? grnToKop(srv.balance) : -Math.abs(Math.round(Number(srv.debtKop || 0)))) : 0;
        if (balanceKop >= 0) continue;
        const debtKop = -balanceKop;
        const owners = (dirApt?.owners?.length ? dirApt.owners : srv?.owners || []).map(o => {
            const docInfo = String(o.docInfo || '').trim();
            return { name: String(o.name || '').trim(), docInfo, shareFrac: String(o.shareFrac || '').trim(), rnokpp: String(o.rnokpp || o.tin || (docInfo.match(/\b(\d{10})\b/) || [])[1] || '').trim() };
        });
        const c = srv?.claim || {};
        const monthlyKop = monthlyByApt.get(apt) || srv?.monthlyKop || 0;
        const months = monthlyKop ? Math.max(1, Math.round(debtKop / monthlyKop)) : (srv?.months || 0);
        const claim = {
            status: CLAIM_STATUSES[c.status] ? c.status : 'none',
            caseNumber: c.caseNumber || '', claimDate: c.claimDate || '', courtOrderDate: c.courtOrderDate || '',
            lawsuitDate: c.lawsuitDate || '', enforcementDate: c.enforcementDate || '',
            periodFrom: c.periodFrom || '', periodTo: c.periodTo || '',
            ownerNameOverride: c.ownerNameOverride || '', ownerCodeOverride: c.ownerCodeOverride || '',
            note: c.note || '', restructureMonths: c.restructureMonths || 6, restructureStart: c.restructureStart || '',
            events: c.events || [], lastCourtCheck: c.lastCourtCheck || null, updatedAt: c.updatedAt || null
        };
        const next = nextClaimAction({ ...claim, months, today: now });
        debtors.push({
            apt,
            entrance: String(dirApt?.entrance || srv?.entrance || '').trim(),
            personalAccount: String(chgApt?.personalAccount || dirApt?.personalAccount || srv?.personalAccount || '').trim(),
            owners,
            ownerName: claim.ownerNameOverride || owners.map(o => o.name).filter(Boolean).join(', ') || String(srv?.ownerName || '').trim(),
            ownerCode: claim.ownerCodeOverride || owners.map(o => o.rnokpp).filter(Boolean).join(', ') || String(srv?.ownerCode || '').trim(),
            docInfo: owners.map(o => [o.name, o.shareFrac ? `частка ${o.shareFrac}` : '', o.docInfo].filter(Boolean).join(' — ')).filter(Boolean).join('; ') || String(srv?.docInfo || '').trim(),
            area: chgApt?.area ?? dirApt?.area ?? srv?.area ?? null,
            debtKop, monthlyKop, months, claim,
            step: claimStep(claim.status),
            next
        });
    }

    const srvOrg = rawClaims?.org || {};
    const reg = req?.registry || {};
    const srvAddr = srvOrg.address && !srvOrg.address.includes('Корольова') ? srvOrg.address : '';
    const org = {
        name: req?.payeeName || reg.legalName || srvOrg.name || 'ОСББ «Успіх-25»',
        edrpou: req?.edrpou || reg.code || srvOrg.edrpou || '',
        address: req?.houseAddress || srvAddr || DEFAULT_HOUSE_ADDRESS,
        legalAddress: srvOrg.legalAddress || reg.legalAddress || req?.houseAddress || srvAddr || DEFAULT_HOUSE_ADDRESS,
        phone: srvOrg.phone || req?.phone || '',
        email: srvOrg.email || req?.email || '',
        headName: srvOrg.headName || reg.headName || '',
        iban: String(req?.iban || srvOrg.iban || '').replace(/\s+/g, '')
    };
    return { debtors, org };
}

// ------------------------------------------------------------
// СПИСОК
// ------------------------------------------------------------
function sumKop(list) { return list.reduce((s, d) => s + d.debtKop, 0); }

function filtered() {
    let out = ctx.debtors;
    if (step === 'todo') out = out.filter(d => d.next.urgent);
    else if (step !== 'all') out = out.filter(d => d.step === step);
    if (quick === 'over3m') out = out.filter(d => d.months > 3);
    if (quick === 'big') out = out.filter(d => d.debtKop >= BIG_DEBT_KOP);
    const q = searchQuery.trim().toLowerCase();
    if (q) {
        out = out.filter(d => [d.apt, `кв ${d.apt}`, d.personalAccount, d.ownerName, d.claim.caseNumber].some(v => String(v || '').toLowerCase().includes(q)));
    }
    const by = {
        debt: (a, b) => b.debtKop - a.debtKop,
        months: (a, b) => b.months - a.months || b.debtKop - a.debtKop,
        apt: (a, b) => String(a.apt).localeCompare(String(b.apt), 'uk', { numeric: true })
    }[sort];
    return out.slice().sort(by);
}

function severity(d) {
    if (d.months >= 12 || d.debtKop >= 1000000) return 'is-high';
    if (d.months > 3 || d.debtKop >= BIG_DEBT_KOP) return 'is-mid';
    return 'is-low';
}

function stepChip(d) {
    const cls = { start: 'is-start', pretrial: 'is-pretrial', court: 'is-court', enforce: 'is-enforce', agreement: 'is-agreement', closed: 'is-closed' }[d.step];
    const status = d.claim.status === 'none' ? CLAIM_STEPS.start : CLAIM_STATUSES[d.claim.status];
    return `<span class="cl-step-chip ${cls}">${escapeHtml(status)}</span>`;
}

function rowHtml(d) {
    const n = d.next;
    const actionBtn = n.doc
        ? `<button type="button" class="cl-row-act" data-act="open" data-apt="${escapeHtml(d.apt)}" data-doc="${n.doc}">${escapeHtml(DOCS[n.doc].title)}</button>`
        : n.mark ? `<button type="button" class="cl-row-act is-soft" data-act="open" data-apt="${escapeHtml(d.apt)}" data-tab="case">Позначити</button>`
            : n.check ? `<button type="button" class="cl-row-act is-soft" data-act="open" data-apt="${escapeHtml(d.apt)}" data-tab="registers">Перевірити</button>` : '';
    return `<li class="cl-row ${severity(d)}${n.urgent ? ' is-urgent' : ''}">
        <button type="button" class="cl-row-main" data-act="open" data-apt="${escapeHtml(d.apt)}" aria-label="Справа кв. ${escapeHtml(d.apt)}">
            <span class="cl-apt"><b>кв. ${escapeHtml(d.apt)}</b><small>${escapeHtml(d.ownerName || 'власника не внесено')}</small></span>
            <span class="cl-debt"><b>${escapeHtml(fmtKop(d.debtKop))}</b><small>${d.months ? `≈ ${d.months} ${monthsWord(d.months)}` : 'грн'}</small><i class="cl-meter" style="--w:${Math.min(100, Math.round((d.months || 1) / 12 * 100))}%" aria-hidden="true"></i></span>
            <span class="cl-state">${stepChip(d)}${d.claim.caseNumber ? `<small>справа № ${escapeHtml(d.claim.caseNumber)}</small>` : ''}</span>
            <span class="cl-next"><b>${n.urgent ? '● ' : ''}${escapeHtml(n.title)}</b><small>${escapeHtml(n.hint)}</small></span>
        </button>
        <span class="cl-row-tools">${actionBtn}</span>
    </li>`;
}

function listHtml() {
    const list = filtered();
    const shown = list.slice(0, limit);
    if (!list.length) {
        return `<p class="list-empty">${ctx.debtors.length ? 'За цим відбором боржників немає' : 'Боржників немає — усі квартири сплатили'}</p>`;
    }
    const label = step === 'all' ? 'Усі боржники' : step === 'todo' ? 'Потребують дії зараз' : CLAIM_STEPS[step];
    return `<p class="cl-list-sum"><b>${escapeHtml(label)}</b> · ${list.length} ${aptsWord(list.length)} · ${escapeHtml(grn(sumKop(list)))}${step !== 'all' ? ' <button type="button" class="jr-link" data-act="step" data-step="all">Показати всіх</button>' : ''}</p>
        <ul class="cl-list">${shown.map(rowHtml).join('')}</ul>
        ${list.length > shown.length ? `<button type="button" class="sv-btn is-soft is-wide" data-act="more">Показати ще ${Math.min(SHOWN, list.length - shown.length)} з ${list.length - shown.length}</button>` : ''}`;
}

function render() {
    const host = document.getElementById('viewClaims');
    if (!host || !ctx) return;
    const all = ctx.debtors;
    const todo = all.filter(d => d.next.urgent);
    const by = s => all.filter(d => d.step === s);
    const inCourt = [...by('court'), ...by('enforce')];
    host.innerHTML = `
        <div class="cl-regime ${isMartialLaw ? 'is-war' : 'is-peace'}">
            <span class="cl-regime-dot" aria-hidden="true"></span>
            <p><b>${isMartialLaw ? 'Воєнний стан' : 'Мирний час'}.</b> ${isMartialLaw
                ? 'Стягувати борг через суд можна; пеню й штрафи населенню не нараховуємо (постанова КМУ № 206 у ред. № 1405).'
                : 'Можна вимагати пеню за статутом, 3 % річних та інфляційні втрати (ст. 625 ЦК).'}</p>
            <button type="button" class="btn-ghost-small" data-go="settings" data-settings-tab="rules">Змінити ›</button>
        </div>

        <div class="cl-summary">
            <button type="button" class="cl-kpi${step === 'all' ? ' active' : ''}" data-act="step" data-step="all" aria-pressed="${step === 'all'}"><span>Борг будинку · усі боржники</span><b class="is-out">${escapeHtml(fmtKop(sumKop(all)))} <small>грн</small></b><small>${all.length} ${aptsWord(all.length)} · понад 3 міс.: ${all.filter(d => d.months > 3).length}</small></button>
            <button type="button" class="cl-kpi ${todo.length ? 'is-todo' : 'is-ok'}${step === 'todo' ? ' active' : ''}" data-act="step" data-step="todo" aria-pressed="${step === 'todo'}"><span>Потребують дії зараз</span><b>${todo.length}</b><small>${todo.length ? `${escapeHtml(grn(sumKop(todo)))} · наступний крок на часі` : 'усі справи в роботі'}</small></button>
            <button type="button" class="cl-kpi${step === 'court' ? ' active' : ''}" data-act="step" data-step="court"><span>У суді та ДВС</span><b>${inCourt.length}</b><small>${escapeHtml(grn(sumKop(inCourt)))}</small></button>
            <button type="button" class="cl-kpi${step === 'agreement' ? ' active' : ''}" data-act="step" data-step="agreement"><span>Реструктуризація</span><b>${by('agreement').length}</b><small>${escapeHtml(grn(sumKop(by('agreement'))))}</small></button>
        </div>

        <nav class="cl-pipeline" aria-label="Кроки претензійної роботи">
            ${PIPELINE.map((s, i) => {
                const list = by(s);
                return `<button type="button" class="cl-pipe${step === s ? ' active' : ''}${s === 'agreement' ? ' is-side' : ''}" data-act="step" data-step="${s}" aria-pressed="${step === s}" title="${escapeHtml(STEP_HINT[s])}">
                    ${s !== 'agreement' ? `<i>${i + 1}</i>` : ''}<b>${escapeHtml(CLAIM_STEPS[s])}</b><span>${list.length}</span><small>${escapeHtml(fmtKop(sumKop(list)))}</small></button>`;
            }).join('')}
        </nav>

        <section class="buh-card cl-card">
            <div class="cl-tools">
                <input type="search" id="claimsSearch" class="field-input" placeholder="Квартира, о/р, ПІБ або № справи" value="${escapeHtml(searchQuery)}" aria-label="Пошук боржника">
                <div class="cl-quick">
                    <button type="button" class="cl-chip${quick === 'over3m' ? ' active' : ''}" data-act="quick" data-quick="over3m" aria-pressed="${quick === 'over3m'}">Понад 3 міс.</button>
                    <button type="button" class="cl-chip${quick === 'big' ? ' active' : ''}" data-act="quick" data-quick="big" aria-pressed="${quick === 'big'}">Від 3 000 грн</button>
                </div>
                <select id="claimsSort" class="field-input field-select" aria-label="Сортування">
                    <option value="debt"${sort === 'debt' ? ' selected' : ''}>Спершу найбільший борг</option>
                    <option value="months"${sort === 'months' ? ' selected' : ''}>Спершу найдовший борг</option>
                    <option value="apt"${sort === 'apt' ? ' selected' : ''}>За номером квартири</option>
                </select>
                <button type="button" class="btn-ghost-small" data-act="csv">Реєстр у CSV</button>
            </div>
            <div id="claimsList">${listHtml()}</div>
        </section>`;
}

function redrawList() {
    const host = document.getElementById('claimsList');
    if (host) host.innerHTML = listHtml();
}

export async function loadClaimsView() {
    const host = document.getElementById('viewClaims');
    if (!host) return;
    if (!ctx) host.innerHTML = '<p class="list-empty">Завантаження претензійної роботи…</p>';
    try {
        ctx = await loadSynchronizedClaims();
        render();
        if (openApt) renderDrawer();
    } catch (err) {
        host.innerHTML = `<p class="list-empty is-bad">Помилка завантаження: ${escapeHtml(err.message)}</p>`;
    }
}

/** Відкрити справу квартири з іншого розділу (наприклад, з картки квартири). */
export function openClaimCase(apt) {
    openApt = String(apt);
    tab = 'docs';
    docType = null;
    if (location.hash !== '#claims') location.hash = 'claims';
    else loadClaimsView();
}

// ------------------------------------------------------------
// СПРАВА (бокова панель)
// ------------------------------------------------------------
function drawerHost() {
    let host = document.getElementById('claimModalHost');
    if (!host || host.parentElement !== document.body) {
        host?.remove();
        host = document.createElement('div');
        host.id = 'claimModalHost';
        document.body.appendChild(host);
    }
    return host;
}

function closeDrawer() {
    openApt = null;
    docType = null;
    drawerCleanup?.();
    drawerCleanup = null;
    const host = document.getElementById('claimModalHost');
    if (host) host.innerHTML = '';
}

function stepperHtml(d) {
    const order = ['pretrial', 'court', 'enforce', 'closed'];
    const cur = d.step === 'agreement' ? 'pretrial' : d.step;
    const idx = order.indexOf(cur);
    const dates = {
        pretrial: d.claim.claimDate,
        court: d.claim.lawsuitDate || d.claim.courtOrderDate,
        enforce: d.claim.enforcementDate,
        closed: ''
    };
    return `<ol class="cl-stepper">${order.map((s, i) => `<li class="${i < idx ? 'is-done' : i === idx ? 'is-current' : ''}">
        <i>${i < idx ? '✓' : i + 1}</i><b>${escapeHtml(s === 'closed' ? 'Погашено' : CLAIM_STEPS[s])}</b><small>${dates[s] ? escapeHtml(human(dates[s])) : i === idx && d.step === 'agreement' ? 'реструктуризація' : ''}</small></li>`).join('')}</ol>`;
}

function nextCardHtml(d) {
    const n = d.next;
    const doc = n.doc ? DOCS[n.doc] : null;
    return `<div class="cl-next-card${n.urgent ? ' is-urgent' : ''}">
        <span class="cl-next-label">${n.urgent ? 'Наступний крок — на часі' : 'Наступний крок'}</span>
        <b>${escapeHtml(n.title)}</b>
        ${n.hint ? `<p>${escapeHtml(n.hint)}</p>` : ''}
        <div class="cl-next-actions">
            ${doc ? `<button type="button" class="btn-primary btn-compact" data-act="doc" data-doc="${n.doc}">Сформувати: ${escapeHtml(doc.title.toLowerCase())}</button>` : ''}
            ${n.mark && !doc ? `<button type="button" class="btn-primary btn-compact" data-act="mark" data-status="${n.mark.status}" data-date-field="${n.mark.dateField || ''}">Позначити: ${escapeHtml(CLAIM_STATUSES[n.mark.status].toLowerCase())}</button>` : ''}
            ${n.check ? '<button type="button" class="btn-soft btn-compact" data-act="tab" data-tab="registers">Перевірити в судовому реєстрі</button>' : ''}
        </div>
    </div>`;
}

function docsTabHtml(d, totals) {
    return `<div class="cl-pane" data-pane="docs"${tab === 'docs' ? '' : ' hidden'}>
        <div class="cl-docs">${Object.entries(DOCS).map(([k, x]) => `<button type="button" class="cl-doc${docType === k ? ' active' : ''}${d.next.doc === k ? ' is-next' : ''}" data-act="doc" data-doc="${k}">
            <b>${escapeHtml(x.title)}${d.next.doc === k ? ' <em>зараз</em>' : ''}</b><small>${escapeHtml(x.when)}</small></button>`).join('')}</div>
        <div class="cl-pair">
            <label class="py-field"><span>Борг за період з</span><input class="field-input" type="month" name="periodFrom" value="${escapeHtml(d.claim.periodFrom || d.inferred.periodFrom)}"></label>
            <label class="py-field"><span>по</span><input class="field-input" type="month" name="periodTo" value="${escapeHtml(d.claim.periodTo || d.inferred.periodTo)}"></label>
        </div>
        <p class="cl-fees">Судовий збір: наказ <b>${escapeHtml(grn(totals.courtFeeOrderKop))}</b> · позов <b>${escapeHtml(grn(totals.courtFeeLawsuitKop))}</b>. Пеня, 3 % річних та інфляційні: <b>${isMartialLaw ? '0 грн (воєнний стан)' : escapeHtml(grn(totals.penaltyKop + totals.threePercentKop + totals.inflationKop))}</b>.</p>
        <div id="clDocPreview"></div>
    </div>`;
}

function caseTabHtml(d) {
    const ev = (d.claim.events || []).slice().reverse();
    const dateField = (name, label) => `<label class="py-field"><span>${label}</span><input class="field-input" type="date" name="${name}" value="${escapeHtml(d.claim[name] || '')}"></label>`;
    return `<div class="cl-pane" data-pane="case"${tab === 'case' ? '' : ' hidden'}>
        <label class="py-field"><span>Стан справи</span>
            <select class="field-input field-select" name="status">${STATUS_GROUPS.map(([g, list]) => `<optgroup label="${g}">${list.map(k => `<option value="${k}"${d.claim.status === k ? ' selected' : ''}>${escapeHtml(CLAIM_STATUSES[k])}</option>`).join('')}</optgroup>`).join('')}</select></label>
        <div class="cl-pair">
            ${dateField('claimDate', 'Претензію надіслано')}
            ${dateField('courtOrderDate', 'Заяву про наказ подано')}
            ${dateField('lawsuitDate', 'Позов подано')}
            ${dateField('enforcementDate', 'Передано до ДВС')}
        </div>
        <label class="py-field"><span>Номер судової справи</span><input class="field-input" name="caseNumber" value="${escapeHtml(d.claim.caseNumber)}" placeholder="947/12345/26"></label>
        <label class="py-field"><span>Нотатка (трек-номер листа, виконавець, домовленості)</span><textarea class="field-input" name="note" rows="2" maxlength="500">${escapeHtml(d.claim.note)}</textarea></label>
        <h3 class="cl-h">Хронологія</h3>
        ${ev.length ? `<ul class="cl-timeline">${ev.map(e => `<li><b>${escapeHtml(CLAIM_STATUSES[e.status] || e.status)}</b><small>${escapeHtml(human(String(e.at || '').slice(0, 10)))}${e.by ? ` · ${escapeHtml(e.by)}` : ''}${e.note ? ` · ${escapeHtml(e.note)}` : ''}</small></li>`).join('')}</ul>`
            : '<p class="buh-note">Зміни стану зʼявляться тут після першого збереження.</p>'}
    </div>`;
}

function debtorTabHtml(d) {
    return `<div class="cl-pane" data-pane="debtor"${tab === 'debtor' ? '' : ' hidden'}>
        ${d.owners.length ? `<ul class="cl-owners">${d.owners.map(o => `<li><b>${escapeHtml(o.name || 'Без імені')}</b><small>${[o.shareFrac ? `частка ${o.shareFrac}` : '', o.rnokpp ? `РНОКПП ${o.rnokpp}` : '', o.docInfo].filter(Boolean).map(escapeHtml).join(' · ') || 'документ не внесено'}</small></li>`).join('')}</ul>`
            : '<p class="cl-warn">У картці квартири ще немає власника. Впишіть ПІБ нижче для документів або знайдіть власника в реєстрі нерухомості.</p>'}
        <div class="cl-pair">
            <label class="py-field"><span>ПІБ боржника в документах</span><input class="field-input" name="ownerNameOverride" value="${escapeHtml(d.claim.ownerNameOverride || d.ownerName)}" placeholder="Прізвище, імʼя, по батькові"></label>
            <label class="py-field"><span>РНОКПП (для суду й реєстрів)</span><input class="field-input" name="ownerCodeOverride" inputmode="numeric" value="${escapeHtml(d.claim.ownerCodeOverride || d.ownerCode)}" placeholder="10 цифр"></label>
        </div>
        <div class="cl-inline-actions">
            <button type="button" class="btn-soft btn-compact" data-act="drrp">Знайти власника в реєстрі нерухомості (ДРРП)</button>
            <button type="button" class="btn-ghost-small" data-act="flat">Картка квартири ›</button>
        </div>
        <div id="clDrrp"></div>
    </div>`;
}

function courtResultHtml(res, saved = false) {
    const cases = res.courtCases || res.cases || [];
    const hearings = res.scheduledHearings || res.hearings || [];
    const enf = res.enforcements || [];
    return `<div class="cl-reg-result">
        <p class="cl-reg-head"><b>${saved ? 'Остання перевірка' : 'Результат перевірки'}</b>${res.isSandbox ? ' <span class="buh-tag is-review">тестові дані</span>' : ''}
            <span>справ ${cases.length} · засідань ${hearings.length} · проваджень ${enf.length}</span></p>
        ${cases.map(c => `<div class="cl-reg-item"><div><b>Справа № ${escapeHtml(c.caseNumber || '')}</b><small>${escapeHtml([c.courtName, c.form, c.subject || c.category, c.role].filter(Boolean).join(' · '))}</small></div>
            <button type="button" class="btn-ghost-small" data-act="apply-case" data-case="${escapeHtml(c.caseNumber || '')}" data-date="${escapeHtml(String(c.date || '').slice(0, 10))}">Записати в справу</button></div>`).join('')}
        ${hearings.map(h => `<div class="cl-reg-item is-hearing"><div><b>Засідання ${escapeHtml(String(h.hearingDate || '').slice(0, 16).replace('T', ' '))}</b><small>справа № ${escapeHtml(h.caseNumber || '')} · ${escapeHtml(h.courtName || '')}</small></div></div>`).join('')}
        ${enf.map(e => `<div class="cl-reg-item is-enf"><div><b>ВП № ${escapeHtml(String(e.orderNumber || ''))} · ${escapeHtml(e.state || '')}</b><small>відкрито ${escapeHtml(String(e.dateBegin || '').slice(0, 10))} · ${escapeHtml(e.executor || e.department || '')}</small></div></div>`).join('')}
        ${!cases.length && !hearings.length && !enf.length ? '<p class="buh-note">Нічого не знайдено.</p>' : ''}
    </div>`;
}

function registersTabHtml(d) {
    const last = d.claim.lastCourtCheck;
    return `<div class="cl-pane" data-pane="registers"${tab === 'registers' ? '' : ' hidden'}>
        <p class="buh-note">Пошук за ПІБ і РНОКПП боржника (вкладка «Боржник») у судовому реєстрі, розкладі засідань і АСВП — через YouControl (YouScore). Ключ — у «Налаштуваннях → Банк і сервіси».</p>
        <div class="cl-inline-actions">
            <button type="button" class="btn-soft btn-compact" data-act="court">Перевірити суди й виконавчі провадження</button>
            <button type="button" class="btn-ghost-small" data-go="settings" data-settings-tab="bank">Ключ YouScore ›</button>
        </div>
        <div id="clCourt">${last ? `${courtResultHtml(last, true)}<p class="buh-note">Перевірено ${escapeHtml(human(String(last.at || '').slice(0, 10)))}${last.by ? ` · ${escapeHtml(last.by)}` : ''}</p>` : ''}</div>
    </div>`;
}

function planRowsHtml(debtKop, months, start) {
    const rows = restructureSchedule({ debtKop, months, start: start || today().slice(0, 7) });
    return `<table class="buh-table is-compact cl-plan"><thead><tr><th>№</th><th>Місяць</th><th class="t-sum">Платіж, грн</th></tr></thead>
        <tbody>${rows.map(r => `<tr><td>${r.n}</td><td>${escapeHtml(periodName(r.period))}</td><td class="t-sum">${escapeHtml(fmtKop(r.amountKop))}</td></tr>`).join('')}</tbody></table>`;
}

function planTabHtml(d) {
    const months = d.claim.restructureMonths || 6;
    const start = d.claim.restructureStart || today().slice(0, 7);
    return `<div class="cl-pane" data-pane="plan"${tab === 'plan' ? '' : ' hidden'}>
        <p class="buh-note">Рівні щомісячні платежі на додачу до поточних внесків. Після підписання договору переведіть справу в стан «Договір реструктуризації».</p>
        <div class="cl-pair">
            <label class="py-field"><span>Строк, місяців</span><input class="field-input" type="number" min="1" max="36" name="restructureMonths" value="${escapeHtml(String(months))}"></label>
            <label class="py-field"><span>Перший платіж</span><input class="field-input" type="month" name="restructureStart" value="${escapeHtml(start)}"></label>
        </div>
        <div id="clPlan">${planRowsHtml(d.debtKop, months, start)}</div>
        <button type="button" class="btn-soft btn-compact" data-act="doc" data-doc="restructure">Сформувати договір реструктуризації</button>
    </div>`;
}

async function renderDrawer() {
    const d = ctx?.debtors.find(x => x.apt === openApt);
    const host = drawerHost();
    if (!d) {
        host.innerHTML = '';
        if (openApt) toast(`У кв. ${openApt} немає боргу — справи немає`, 'info');
        openApt = null;
        return;
    }
    if (!d.inferred) d.inferred = inferPeriods(await fetchAptLedger(d.apt));
    const totals = calculateClaimTotals({ debtKop: d.debtKop, isMartialLaw, daysOverdue: Math.max(30, (d.months || 1) * 30), penaltyPerDayKop: Math.round(d.debtKop * 0.0001), inflationRate: 0.05 });
    const first = !host.querySelector('.cl-drawer');
    host.innerHTML = `
        <div class="cl-backdrop" data-act="close"></div>
        <aside class="cl-drawer${first ? ' is-entering' : ''}" role="dialog" aria-modal="true" aria-labelledby="clDrawerTitle">
            <header class="cl-drawer-head">
                <div>
                    <span class="cl-drawer-meta">кв. ${escapeHtml(d.apt)}${d.personalAccount ? ` · о/р ${escapeHtml(d.personalAccount)}` : ''}${fmtArea(d.area) ? ` · ${fmtArea(d.area)} м²` : ''}${d.entrance ? ` · парадна ${escapeHtml(d.entrance)}` : ''}</span>
                    <h2 id="clDrawerTitle">${escapeHtml(d.ownerName || `Квартира ${d.apt}`)}</h2>
                </div>
                <button type="button" class="cl-close" data-act="close" aria-label="Закрити справу">✕</button>
            </header>
            <div class="cl-drawer-body">
                <div class="cl-debt-hero">
                    <div><span>Борг</span><b>${escapeHtml(grn(d.debtKop))}</b><small>${d.months ? `≈ ${d.months} ${monthsWord(d.months)} внесків` : ''}${d.monthlyKop ? ` · внесок ${escapeHtml(grn(d.monthlyKop))}/міс.` : ''}</small></div>
                    <div class="cl-hero-links">
                        <button type="button" class="btn-ghost-small" data-act="flat">Історія оплат ›</button>
                    </div>
                </div>
                ${stepperHtml(d)}
                ${nextCardHtml(d)}
                <form id="clForm" class="cl-form" onsubmit="return false">
                    <div class="cl-tabs" role="tablist">${Object.entries(TABS).map(([k, v]) => `<button type="button" role="tab" class="cl-tab${tab === k ? ' active' : ''}" aria-selected="${tab === k}" data-act="tab" data-tab="${k}">${v}</button>`).join('')}</div>
                    ${docsTabHtml(d, totals)}${caseTabHtml(d)}${debtorTabHtml(d)}${registersTabHtml(d)}${planTabHtml(d)}
                </form>
            </div>
            <footer class="cl-drawer-foot">
                <span class="buh-note">${d.claim.updatedAt ? `Збережено ${escapeHtml(human(String(d.claim.updatedAt).slice(0, 10)))}` : 'Справу ще не збережено'}</span>
                <button type="button" class="btn-primary btn-compact" data-act="save">Зберегти справу</button>
            </footer>
        </aside>`;
    if (first) requestAnimationFrame(() => host.querySelector('.cl-drawer')?.classList.remove('is-entering'));
    if (docType) showDoc(d, docType);

    if (!drawerCleanup) {
        const prevOverflow = document.body.style.overflow;
        document.body.style.overflow = 'hidden';
        const onKey = e => { if (e.key === 'Escape' && openApt) closeDrawer(); };
        // Панель висить на <body>: без цього «Назад» у браузері лишав би її поверх іншого розділу.
        const onPop = () => { if (location.hash !== '#claims') closeDrawer(); };
        document.addEventListener('keydown', onKey);
        window.addEventListener('popstate', onPop);
        host.addEventListener('click', onDrawerClick);
        host.addEventListener('input', onDrawerInput);
        drawerCleanup = () => {
            document.body.style.overflow = prevOverflow;
            document.removeEventListener('keydown', onKey);
            window.removeEventListener('popstate', onPop);
            host.removeEventListener('click', onDrawerClick);
            host.removeEventListener('input', onDrawerInput);
        };
        if (first) host.querySelector('.cl-close')?.focus();
    }
}

function formValues() {
    const form = document.getElementById('clForm');
    return form ? Object.fromEntries(new FormData(form).entries()) : {};
}

function showDoc(d, type) {
    docType = type;
    const host = document.getElementById('clDocPreview');
    if (!host) return;
    document.querySelectorAll('#claimModalHost .cl-doc').forEach(b => b.classList.toggle('active', b.dataset.doc === type));
    const v = formValues();
    const totals = calculateClaimTotals({ debtKop: d.debtKop, isMartialLaw, daysOverdue: Math.max(30, (d.months || 1) * 30), penaltyPerDayKop: Math.round(d.debtKop * 0.0001), inflationRate: 0.05 });
    const common = {
        org: ctx.org, apt: d.apt,
        ownerName: (v.ownerNameOverride || '').trim() || d.ownerName,
        ownerCode: (v.ownerCodeOverride || '').trim() || d.ownerCode,
        personalAccount: d.personalAccount, area: d.area, docInfo: d.docInfo,
        debtKop: d.debtKop, monthlyKop: d.monthlyKop,
        periodFrom: v.periodFrom || 'початку обліку', periodTo: v.periodTo || today().slice(0, 7),
        isMartialLaw
    };
    const court = { courtName: COURT_DEFAULT_NAME, courtAddress: COURT_DEFAULT_ADDRESS };
    const text = {
        claim: () => generatePreTrialClaim({ ...common, iban: ctx.org.iban, claimDate: today() }),
        court_order: () => generateCourtOrderApp({ ...common, ...court }),
        lawsuit: () => generateLawsuitApp({ ...common, ...court, courtFeeKop: totals.courtFeeLawsuitKop, penaltyKop: totals.penaltyKop, threePercentKop: totals.threePercentKop, inflationKop: totals.inflationKop }),
        calculation: () => generateDebtCalculation({ ...common, ledgerEntries: ledgerCache.get(d.apt) || [] }),
        restructure: () => generateRestructureAgreement({ ...common, monthsCount: Number(v.restructureMonths || d.claim.restructureMonths || 6) })
    }[type]();
    const doc = DOCS[type];
    host.innerHTML = `<div class="cl-preview">
        <div class="cl-preview-head"><b>${escapeHtml(doc.title)}</b>
            <span><button type="button" class="btn-ghost-small" data-act="copy">Копіювати</button><button type="button" class="btn-soft btn-compact" data-act="print">Друк / PDF</button></span></div>
        <pre id="clDocText">${escapeHtml(text)}</pre>
        ${doc.mark ? `<div class="cl-preview-foot"><span>Надіслали чи подали документ?</span><button type="button" class="btn-primary btn-compact" data-act="mark" data-status="${doc.mark.status}" data-date-field="${doc.mark.dateField || ''}">${escapeHtml(doc.mark.label)}</button></div>` : ''}
    </div>`;
}

async function save(btn, extra = {}) {
    const d = ctx.debtors.find(x => x.apt === openApt);
    if (!d) return;
    const v = { ...formValues(), ...extra };
    setBusy(btn, true, 'Зберігаю…');
    try {
        await claimsAct({ action: 'saveClaim', apt: d.apt, ...v });
        toast(extra.status ? `Кв. ${d.apt}: ${CLAIM_STATUSES[extra.status].toLowerCase()}` : 'Справу збережено', 'success');
        ctx = await loadSynchronizedClaims();
        render();
        await renderDrawer();
    } catch (err) {
        toast(err.message, 'error');
    } finally {
        if (btn.isConnected) setBusy(btn, false);
    }
}

async function checkCourt(btn) {
    const d = ctx.debtors.find(x => x.apt === openApt);
    const v = formValues();
    const fullName = (v.ownerNameOverride || d.ownerName || '').trim();
    const code = (v.ownerCodeOverride || d.ownerCode || '').trim();
    if (!fullName && !code) { toast('Вкажіть ПІБ або РНОКПП боржника на вкладці «Боржник»', 'error'); return; }
    setBusy(btn, true, 'Шукаю в судах і АСВП…');
    try {
        const res = await claimsAct({ action: 'checkDebtorCourt', apt: d.apt, fullName, code });
        document.getElementById('clCourt').innerHTML = courtResultHtml(res);
    } catch (err) { toast(err.message, 'error'); }
    finally { if (btn.isConnected) setBusy(btn, false); }
}

async function checkDrrp(btn, { apply = false, code: forced = '' } = {}) {
    const d = ctx.debtors.find(x => x.apt === openApt);
    const host = document.getElementById('clDrrp');
    const code = forced || (formValues().ownerCodeOverride || d.ownerCode || '').trim();
    setBusy(btn, true, apply ? 'Записую в картку квартири…' : 'Шукаю в ДРРП…');
    try {
        const res = await claimsAct({ action: 'checkPropertyOwner', apt: d.apt, code, fetchDetails: true, updateDirectory: apply });
        if (!res.ok && res.needsCode) {
            host.innerHTML = `<div class="cl-reg-result"><p class="buh-note">${escapeHtml(res.message)}</p>
                ${(res.discoveredPayers || []).length ? `<p class="cl-reg-head"><b>Платники за випискою банку</b></p>${res.discoveredPayers.map(p => `<div class="cl-reg-item"><div><b>${escapeHtml(p.name)}</b><small>${escapeHtml(p.code || 'без РНОКПП')}</small></div>${p.code ? `<button type="button" class="btn-ghost-small" data-act="use-payer" data-code="${escapeHtml(p.code)}" data-name="${escapeHtml(p.name)}">Підставити</button>` : ''}</div>`).join('')}` : ''}</div>`;
            return;
        }
        if (apply) {
            toast('Власника й площу записано в картку квартири', 'success');
            ctx = await loadSynchronizedClaims();
            render();
            await renderDrawer();
            return;
        }
        host.innerHTML = `<div class="cl-reg-result">
            <p class="cl-reg-head"><b>Реєстр нерухомості за кодом ${escapeHtml(res.searchedCode || code)}</b>${res.isSandbox ? ' <span class="buh-tag is-review">тестові дані</span>' : ''}</p>
            ${(res.objects || []).map(o => {
                const det = o.details || {};
                const owners = (det.owners || []).map(ow => `${ow.name || ''}${ow.code ? ` (${ow.code})` : ''} — ${ow.share || '1/1'}`).join('; ');
                return `<div class="cl-reg-item"><div><b>${escapeHtml(o.address || 'Обʼєкт нерухомості')}${o.matchesHouse ? ' · наш будинок' : ''}</b>
                    <small>${escapeHtml([det.totalArea ? `${det.totalArea} м²` : '', owners, det.basisDocument].filter(Boolean).join(' · '))}</small></div></div>`;
            }).join('') || '<p class="buh-note">Обʼєктів не знайдено.</p>'}
            ${(res.objects || []).length ? `<button type="button" class="btn-soft btn-compact" data-act="drrp-apply" data-code="${escapeHtml(res.searchedCode || code)}">Записати власника в картку квартири</button>` : ''}
        </div>`;
    } catch (err) { toast(err.message, 'error'); }
    finally { if (btn.isConnected) setBusy(btn, false); }
}

function print(title, text) {
    const w = window.open('', '_blank');
    if (!w) { toast('Браузер заблокував нове вікно — дозвольте спливні вікна для друку', 'error'); return; }
    w.document.write(`<html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>body{font-family:'Times New Roman',serif;font-size:13pt;line-height:1.45;padding:2cm;white-space:pre-wrap}</style></head><body>${escapeHtml(text)}</body></html>`);
    w.document.close();
    w.print();
}

async function onDrawerClick(e) {
    const btn = e.target.closest('[data-act]');
    if (!btn || btn.disabled) return;
    const d = ctx.debtors.find(x => x.apt === openApt);
    if (!d) return;
    const a = btn.dataset.act;
    if (a === 'close') closeDrawer();
    else if (a === 'tab') {
        tab = btn.dataset.tab;
        document.querySelectorAll('#claimModalHost .cl-tab').forEach(t => { const on = t.dataset.tab === tab; t.classList.toggle('active', on); t.setAttribute('aria-selected', String(on)); });
        document.querySelectorAll('#claimModalHost .cl-pane').forEach(p => { p.hidden = p.dataset.pane !== tab; });
    }
    else if (a === 'doc') {
        tab = 'docs';
        document.querySelectorAll('#claimModalHost .cl-tab').forEach(t => { const on = t.dataset.tab === 'docs'; t.classList.toggle('active', on); t.setAttribute('aria-selected', String(on)); });
        document.querySelectorAll('#claimModalHost .cl-pane').forEach(p => { p.hidden = p.dataset.pane !== 'docs'; });
        showDoc(d, btn.dataset.doc);
        document.getElementById('clDocPreview')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
    else if (a === 'mark') {
        const extra = { status: btn.dataset.status };
        if (btn.dataset.dateField) extra[btn.dataset.dateField] = today();
        if (btn.dataset.status === 'restructured' && !formValues().restructureStart) extra.restructureStart = today().slice(0, 7);
        await save(btn, extra);
    }
    else if (a === 'save') await save(btn);
    else if (a === 'flat') { const apt = d.apt; closeDrawer(); openFlat(apt); }
    else if (a === 'copy') { navigator.clipboard?.writeText(document.getElementById('clDocText')?.textContent || ''); toast('Текст скопійовано', 'success'); }
    else if (a === 'print') print(DOCS[docType]?.title || 'Документ', document.getElementById('clDocText')?.textContent || '');
    else if (a === 'court') await checkCourt(btn);
    else if (a === 'drrp') await checkDrrp(btn);
    else if (a === 'drrp-apply') await checkDrrp(btn, { apply: true, code: btn.dataset.code });
    else if (a === 'use-payer') {
        const form = document.getElementById('clForm');
        form.elements.ownerCodeOverride.value = btn.dataset.code || '';
        if (btn.dataset.name) form.elements.ownerNameOverride.value = btn.dataset.name;
        toast('Дані платника підставлено — перевірте реєстр ще раз', 'info');
    }
    else if (a === 'apply-case') {
        const form = document.getElementById('clForm');
        form.elements.caseNumber.value = btn.dataset.case || '';
        if (btn.dataset.date && !form.elements.courtOrderDate.value) form.elements.courtOrderDate.value = btn.dataset.date;
        if (['none', 'warning', 'claim'].includes(form.elements.status.value)) form.elements.status.value = 'court_order_filed';
        toast('Номер справи записано — збережіть справу', 'info');
    }
}

function onDrawerInput(e) {
    const d = ctx.debtors.find(x => x.apt === openApt);
    if (!d) return;
    const name = e.target.name;
    if (['restructureMonths', 'restructureStart'].includes(name)) {
        const v = formValues();
        const plan = document.getElementById('clPlan');
        if (plan) plan.innerHTML = planRowsHtml(d.debtKop, Number(v.restructureMonths) || 1, v.restructureStart);
    }
    if (docType && ['periodFrom', 'periodTo', 'ownerNameOverride', 'ownerCodeOverride', 'restructureMonths'].includes(name)) showDoc(d, docType);
}

// ------------------------------------------------------------
// ЕКСПОРТ І ПОДІЇ ЕКРАНА
// ------------------------------------------------------------
function exportCsv() {
    const cell = v => (/[;"\r\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v ?? ''));
    const lines = [['Квартира', 'Особовий рахунок', 'Співвласники', 'РНОКПП', 'Площа, м²', 'Внесок/міс., грн', 'Борг, грн', 'Місяців', 'Крок', 'Стан', 'Наступна дія', '№ справи', 'Претензія', 'Наказ', 'Позов', 'ДВС']];
    for (const d of filtered()) {
        lines.push([`кв. ${d.apt}`, d.personalAccount, d.ownerName, d.ownerCode, fmtArea(d.area),
            d.monthlyKop ? (d.monthlyKop / 100).toFixed(2).replace('.', ',') : '', (d.debtKop / 100).toFixed(2).replace('.', ','), d.months || '',
            CLAIM_STEPS[d.step], CLAIM_STATUSES[d.claim.status], d.next.title, d.claim.caseNumber,
            d.claim.claimDate, d.claim.courtOrderDate, d.claim.lawsuitDate, d.claim.enforcementDate]);
    }
    const blob = new Blob(['﻿' + lines.map(r => r.map(cell).join(';')).join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `borzhnyky-${today()}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

export function initClaimsView() {
    const host = document.getElementById('viewClaims');
    if (!host || host.dataset.bound) return;
    host.dataset.bound = '1';
    host.addEventListener('click', e => {
        const btn = e.target.closest('[data-act]');
        if (!btn) return;
        const a = btn.dataset.act;
        if (a === 'step') { step = btn.dataset.step; limit = SHOWN; render(); document.querySelector('#viewClaims .cl-card')?.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
        else if (a === 'quick') { quick = quick === btn.dataset.quick ? '' : btn.dataset.quick; limit = SHOWN; render(); }
        else if (a === 'more') { limit += SHOWN; redrawList(); }
        else if (a === 'csv') { exportCsv(); toast('Реєстр боржників збережено в CSV', 'success'); }
        else if (a === 'open') {
            openApt = btn.dataset.apt;
            tab = btn.dataset.tab || 'docs';
            docType = btn.dataset.doc || null;
            renderDrawer();
        }
    });
    host.addEventListener('input', e => {
        if (e.target.id !== 'claimsSearch') return;
        searchQuery = e.target.value;
        limit = SHOWN;
        redrawList();
    });
    host.addEventListener('change', e => {
        if (e.target.id === 'claimsSort') { sort = e.target.value; redrawList(); }
    });
}
