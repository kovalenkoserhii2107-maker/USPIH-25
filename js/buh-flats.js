// ============================================================
// «Квартири» — будинок цілком і кожна квартира окремо.
// Вгорі: скільки боргу в будинку, скільки квартир понад 3 внески,
// переплати, претензії в роботі; діаграма глибини боргу (клік — відбір).
// Далі — «шахматка» за підʼїздами або список з відборами й сортуванням.
// Квартира відкривається карткою збоку: баланс, графік сальдо, власники,
// борг за статтями, історія, претензія, довідка й акт звірки.
//
// Баланси — з контексту нарахувань (сервер рахує їх з історії),
// власники — з довідника, історія — apartments/{кв}/ledger,
// стан претензій — claimsAction. Розрахунки й відбори — flats-core.js.
// ============================================================
import { db } from './firebase.js';
import { collection, doc, getDoc, getDocs, query, orderBy } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js';
import { escapeHtml, toast, setBusy } from './ui.js';
import { audit } from './audit.js';
import { loadCharges, loadDirectory, loadClaims } from './buh-data.js';
import { fmtKop } from './charges-core.js';
import { openCharges } from './buh-charges.js';
import { openClaimCase } from './buh-claims.js';
import { CLAIM_STEPS, CLAIM_STATUSES, claimStep } from './claims-core.js';
import { FILTERS, KINDS, flatRows, ledgerRows, lastPayment, reconciliationCsv,
    DEPTHS, depthOf, depthBuckets, houseKpis, MORE_FILTERS, selectFlats, byEntrance, balanceSeries } from './flats-core.js';

const SHOWN = 60;
const VIEW_KEY = 'uspih25_flats_view';
let rows = [];
let filter = 'all';
let entrance = '';
let search = '';
let sort = 'apt';
let view = (() => { try { return localStorage.getItem(VIEW_KEY) === 'list' ? 'list' : 'map'; } catch { return 'map'; } })();
let limit = SHOWN;
let selected = null;          // квартира в бічній картці
let histKind = 'all';
let histLimit = 15;
let wantedApt = null;
const ledgers = new Map();    // кв → записи історії
const aptDocs = new Map();    // кв → документ квартири (борг за статтями)

const grn = k => `${fmtKop(k)} грн`;
const signedGrn = k => `${k < 0 ? '−' : k > 0 ? '+' : ''}${fmtKop(Math.abs(k))} грн`;
const day = d => d.toLocaleDateString('uk-UA', { day: '2-digit', month: '2-digit', year: 'numeric' });
const chip = ([t, c]) => `<span class="sv-chip ${c}">${escapeHtml(t)}</span>`;
const stateOf = r => r.debtKop > 0 ? (r.months > 3 ? [`борг ≈ ${r.months} міс.`, 'is-bad'] : [r.months ? `борг ≈ ${r.months} міс.` : 'борг', 'is-work']) : r.balanceKop > 0 ? ['переплата', 'is-done'] : ['без боргу', 'is-done'];

async function fetchLedger(apt) {
    if (ledgers.has(apt)) return ledgers.get(apt);
    const [snap, aptSnap] = await Promise.all([getDocs(query(collection(db, 'apartments', apt, 'ledger'), orderBy('at', 'desc'))), getDoc(doc(db, 'apartments', apt))]);
    const list = snap.docs.map(d => ({ ...d.data(), at: d.data().at?.toDate?.() || null })).filter(e => e.at);
    ledgers.set(apt, list);
    aptDocs.set(apt, aptSnap.exists() ? aptSnap.data() : {});
    return list;
}

// ------------------------------------------------------------
// ВЕРХ: підсумки й глибина боргу
// ------------------------------------------------------------
function kpisHtml(k) {
    const card = (attrs, label, sum, sub, cls = '') => `<button type="button" class="ft-kpi${cls}" ${attrs}><span>${label}</span><b>${sum}</b><small>${escapeHtml(sub)}</small></button>`;
    return `<div class="ft-kpis">
        ${card('data-filter="debt"', 'Борг співвласників', `${fmtKop(k.debtKop)} <small>грн</small>`, `${k.debtors} з ${k.total} кв.${k.debtMonths ? ` · ≈ ${String(k.debtMonths).replace('.', ',')} внеску будинку` : ''}`, k.debtors ? ' is-bad' : '')}
        ${card('data-filter="long"', 'Понад 3 внески', `${k.long} <small>кв.</small>`, `${grn(k.longKop)} — підстава для претензії`, k.long ? ' is-warn' : '')}
        ${card('data-filter="claims"', 'Претензії в роботі', `${k.claims} <small>кв.</small>`, k.claims ? 'попередження, претензія, суд чи виконання' : 'справ ще немає')}
        ${card('data-filter="over"', 'Переплати', `${fmtKop(k.overKop)} <small>грн</small>`, `${k.over} кв. — зарахуються в наступні місяці`)}
    </div>`;
}

function depthHtml(rowsAll) {
    const b = depthBuckets(rowsAll);
    const total = rowsAll.length || 1;
    const order = ['over', 'ok', 'm1', 'm3', 'm6', 'm12', 'm12p'];
    return `<section class="py-card ft-depth" aria-label="Глибина боргу">
        <div class="ft-depth-head"><h2>Глибина боргу</h2><span class="py-muted">у місячних внесках · клік — показати квартири</span></div>
        <div class="ft-depth-bar" role="group">${order.filter(k => b[k].n).map(k => `<button type="button" class="ft-seg ${DEPTHS[k][1]}${filter === k ? ' is-active' : ''}" data-filter="${k}" style="flex-grow:${b[k].n}"
            title="${escapeHtml(`${DEPTHS[k][0]}: ${b[k].n} кв.${b[k].kop ? `, ${grn(b[k].kop)}` : ''}`)}" aria-label="${escapeHtml(`${DEPTHS[k][0]}: ${b[k].n} квартир`)}"><span>${b[k].n}</span></button>`).join('')}</div>
        <div class="ft-legend">${order.map(k => `<button type="button" class="ft-leg${filter === k ? ' is-active' : ''}" data-filter="${k}"${b[k].n ? '' : ' disabled'}>
            <i class="${DEPTHS[k][1]}" aria-hidden="true"></i><span>${escapeHtml(DEPTHS[k][0])}</span><b>${b[k].n} кв. <em>· ${Math.round(b[k].n / total * 100)}%</em></b>${b[k].kop && k !== 'ok' ? `<small>${fmtKop(b[k].kop)}</small>` : ''}</button>`).join('')}</div>
    </section>`;
}

// ------------------------------------------------------------
// ВІДБОРИ Й ВИГЛЯД
// ------------------------------------------------------------
function toolsHtml(entrances) {
    const all = { ...FILTERS, ...MORE_FILTERS };
    const order = ['all', 'debt', 'long', 'over', 'claims', 'unverified'];
    const count = f => selectFlats(rows, { filter: f, entrance }).length;
    return `<div class="ft-tools">
        <label class="fl-search ft-search"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.2" aria-hidden="true"><circle cx="11" cy="11" r="7"></circle><path d="M20 20l-3.5-3.5"></path></svg>
            <input id="flSearch" type="search" inputmode="search" placeholder="Номер квартири, о/р або прізвище" value="${escapeHtml(search)}" aria-label="Пошук квартири"></label>
        <div class="ft-view" role="radiogroup" aria-label="Вигляд">
            <button type="button" role="radio" aria-checked="${view === 'map'}" class="${view === 'map' ? 'is-active' : ''}" data-view="map">Шахматка</button>
            <button type="button" role="radio" aria-checked="${view === 'list'}" class="${view === 'list' ? 'is-active' : ''}" data-view="list">Список</button>
        </div>
    </div>
    <div class="ft-chips" role="group" aria-label="Відбір">${order.map(k => `<button type="button" class="ft-chip${filter === k ? ' is-active' : ''}" data-filter="${k}">${escapeHtml(all[k])} <small>${count(k)}</small></button>`).join('')}
        ${DEPTHS[filter] ? `<button type="button" class="ft-chip is-active" data-filter="all">${escapeHtml(DEPTHS[filter][0])} ×</button>` : ''}</div>
    ${entrances.length > 1 ? `<div class="ft-chips is-soft" role="group" aria-label="Підʼїзд"><span class="ft-chips-label">Підʼїзд</span>
        <button type="button" class="ft-chip${!entrance ? ' is-active' : ''}" data-entrance="">Усі</button>
        ${entrances.map(e => `<button type="button" class="ft-chip${entrance === e ? ' is-active' : ''}" data-entrance="${escapeHtml(e)}">${escapeHtml(e)}</button>`).join('')}
        ${view === 'list' ? `<label class="ft-sort"><span>Сортувати</span><select id="flSort" class="field-input field-select">${[['apt', 'за номером'], ['debt', 'за боргом'], ['months', 'за місяцями боргу'], ['balance', 'за переплатою']].map(([k, v]) => `<option value="${k}"${sort === k ? ' selected' : ''}>${v}</option>`).join('')}</select></label>` : ''}</div>`
        : view === 'list' ? `<div class="ft-chips is-soft"><label class="ft-sort"><span>Сортувати</span><select id="flSort" class="field-input field-select">${[['apt', 'за номером'], ['debt', 'за боргом'], ['months', 'за місяцями боргу'], ['balance', 'за переплатою']].map(([k, v]) => `<option value="${k}"${sort === k ? ' selected' : ''}>${v}</option>`).join('')}</select></label></div>` : ''}`;
}

/** «Шахматка»: квартири за підʼїздами, колір — глибина боргу; відбір притлумлює решту. */
function mapHtml() {
    const shown = new Set(selectFlats(rows, { filter, entrance, query: search }).map(r => r.apt));
    const groups = byEntrance(rows).filter(([e]) => !entrance || e === entrance);
    return `<section class="py-card ft-map">
        ${groups.map(([e, list]) => `<div class="ft-ent"><h3>${e === '—' ? 'Без підʼїзду' : `Підʼїзд ${escapeHtml(e)}`} <small>${list.length} кв. · борг ${fmtKop(list.reduce((s, r) => s + r.debtKop, 0))} грн</small></h3>
            <div class="ft-tiles">${list.map(r => `<button type="button" class="ft-tile ${DEPTHS[depthOf(r)][1]}${shown.has(r.apt) ? '' : ' is-dim'}${r.apt === selected ? ' is-current' : ''}" data-apt="${escapeHtml(r.apt)}"
                title="${escapeHtml(`Кв. ${r.apt}${r.owner ? ` · ${r.owner}` : ''} · ${r.balanceKop ? signedGrn(r.balanceKop) : 'без боргу'}`)}"><b>${escapeHtml(r.apt)}</b><small>${r.debtKop ? `−${Math.round(r.debtKop / 100).toLocaleString('uk-UA')}` : r.balanceKop > 0 ? `+${Math.round(r.balanceKop / 100).toLocaleString('uk-UA')}` : '✓'}</small>${r.claimStep && !['start', 'closed'].includes(r.claimStep) ? '<i class="ft-flag" aria-label="претензія"></i>' : ''}</button>`).join('')}</div></div>`).join('')}
        <p class="py-note">Число на плитці — баланс у гривнях. Жовті — борг до 1 внеску, помаранчеві — 1–3, червоні — понад 3 (темні — понад рік), зелені — без боргу, сині — переплата. Крапка в куті — претензія в роботі.</p>
    </section>`;
}

function listHtml() {
    const list = selectFlats(rows, { filter, entrance, query: search, sort });
    if (!list.length) return `<section class="py-card"><p class="py-empty">${search ? 'Такої квартири не знайдено' : 'У цьому відборі квартир немає'}</p></section>`;
    return `<section class="py-card ft-list">
        <div class="ft-row ft-row-head" aria-hidden="true"><span>Квартира</span><span>Власник</span><span>Внесок/міс.</span><span>Баланс</span><span>Стан</span></div>
        ${list.slice(0, limit).map(r => `<button type="button" class="ft-row${r.apt === selected ? ' is-current' : ''}" data-apt="${escapeHtml(r.apt)}">
            <span class="ft-apt"><i class="ft-dot ${DEPTHS[depthOf(r)][1]}" aria-hidden="true"></i><b>${escapeHtml(r.apt)}</b><small>${escapeHtml([r.entrance ? `під. ${r.entrance}` : '', r.area ? `${String(r.area).replace('.', ',')} м²` : '', r.personalAccount ? `о/р ${r.personalAccount}` : ''].filter(Boolean).join(' · '))}</small></span>
            <span class="ft-owner" data-l="Власник">${escapeHtml(r.owner || '—')}${r.ownersStatus && r.ownersStatus !== 'confirmed' ? ' <small class="is-warn">не звірено</small>' : ''}</span>
            <span class="ft-num is-muted" data-l="Внесок">${r.monthlyKop ? fmtKop(r.monthlyKop) : '—'}</span>
            <span class="ft-num${r.balanceKop < 0 ? ' is-out' : r.balanceKop > 0 ? ' is-in' : ''}" data-l="Баланс">${r.balanceKop ? signedGrn(r.balanceKop) : '0,00 грн'}</span>
            <span class="ft-state">${chip(stateOf(r))}${r.claimStep && !['start', 'closed'].includes(r.claimStep) ? chip([CLAIM_STEPS[r.claimStep], '']) : ''}</span>
        </button>`).join('')}
        ${list.length > limit ? `<button type="button" class="sv-btn is-soft ft-more" data-act="more">Показати ще ${Math.min(SHOWN, list.length - limit)} з ${list.length - limit}</button>` : ''}
    </section>`;
}

// ------------------------------------------------------------
// КАРТКА КВАРТИРИ (збоку)
// ------------------------------------------------------------
function sparkHtml(history) {
    const s = balanceSeries(history, 520, 120, 10);
    if (!s.points.length) return '';
    const path = s.points.map((p, i) => `${i ? 'L' : 'M'}${p.x} ${p.y}`).join(' ');
    const last = s.points.at(-1);
    const area = `${path} L${last.x} ${s.zeroY} L${s.points[0].x} ${s.zeroY} Z`;
    return `<section class="py-card ft-spark">
        <div class="ft-spark-head"><b>Сальдо</b><span class="py-muted">${escapeHtml(day(s.points[0].at))} — ${escapeHtml(day(last.at))}</span></div>
        <svg viewBox="0 0 520 120" role="img" aria-label="Графік сальдо квартири: від ${escapeHtml(signedGrn(s.points[0].balanceKop))} до ${escapeHtml(signedGrn(last.balanceKop))}">
            <line x1="0" x2="520" y1="${s.zeroY}" y2="${s.zeroY}" class="ft-zero"/>
            <path d="${area}" class="ft-area${last.balanceKop < 0 ? ' is-debt' : ''}"/>
            <path d="${path}" class="ft-line${last.balanceKop < 0 ? ' is-debt' : ''}"/>
            ${s.points.map(p => `<circle cx="${p.x}" cy="${p.y}" r="3.5" class="ft-pt${p.balanceKop < 0 ? ' is-debt' : ''}"><title>${escapeHtml(`${day(p.at)}: ${signedGrn(p.balanceKop)}`)}</title></circle>`).join('')}
        </svg>
        <div class="ft-spark-foot"><span>мінімум ${escapeHtml(signedGrn(s.min))}</span><span>зараз ${escapeHtml(signedGrn(last.balanceKop))}</span></div>
    </section>`;
}

function aptSheet(apt) {
    const r = rows.find(x => x.apt === apt);
    if (!r) return [`Квартира ${apt}`, '<p class="py-note">Квартиру не знайдено.</p>'];
    const entries = ledgers.get(apt);
    const history = entries ? ledgerRows(entries) : null;
    const paid = entries ? lastPayment(entries) : null;
    const parts = (aptDocs.get(apt)?.balanceParts || []).filter(p => p.amountKop);
    const debt = r.debtKop > 0;
    const shown = history ? history.filter(h => histKind === 'all' || h.kind === histKind) : [];
    const yearAgo = new Date(Date.now() - 365 * 864e5);
    const yearPaid = entries ? entries.filter(e => e.kind === 'payment' && e.at >= yearAgo).reduce((s, e) => s + Math.round(Number(e.amount) * 100), 0) : 0;
    const status = r.claimStatus || 'none';
    return [`Квартира ${apt}`, `<div class="chs-head">
            <span class="py-muted">${escapeHtml([r.entrance ? `підʼїзд ${r.entrance}` : '', r.area ? `${String(r.area).replace('.', ',')} м²` : '', r.residents ? `проживає ${r.residents}` : '', r.personalAccount ? `о/р ${r.personalAccount}` : ''].filter(Boolean).join(' · '))}</span>
            <span class="chs-title">Квартира ${escapeHtml(apt)}</span>
            <span class="ft-badges">${chip(stateOf(r))}${status !== 'none' ? chip([CLAIM_STEPS[claimStep(status)], 'is-work']) : ''}</span>
        </div>
        <div class="chs-tiles">
            <div class="${debt ? 'is-debt' : ''}"><span>${debt ? 'Борг' : r.balanceKop > 0 ? 'Переплата' : 'Баланс'}</span><b>${grn(Math.abs(r.balanceKop))}</b></div>
            <div><span>Внесок на місяць</span><b>${r.monthlyKop ? grn(r.monthlyKop) : '—'}</b></div>
            <div><span>Остання оплата</span><b>${!entries ? '…' : paid ? `${escapeHtml(day(paid.at))}` : 'немає'}</b>${paid ? `<small>${grn(paid.amountKop)}</small>` : ''}</div>
            <div><span>Сплачено за рік</span><b>${entries ? grn(yearPaid) : '…'}</b>${r.monthlyKop && entries ? `<small>${Math.round(yearPaid / (r.monthlyKop * 12) * 100)}% річних внесків</small>` : ''}</div>
        </div>
        ${history ? sparkHtml(history) : '<section class="py-card"><p class="py-note">Читаю історію…</p></section>'}
        ${parts.length > 1 ? `<h3 class="chs-h">Баланс за статтями</h3><section class="py-card ft-parts">${parts.map(p => `<div><span>${escapeHtml(p.name)}</span><b class="${p.amountKop < 0 ? 'is-out' : 'is-in'}">${escapeHtml(signedGrn(p.amountKop))}</b></div>`).join('')}</section>` : ''}
        <h3 class="chs-h">Власники${r.ownersStatus && r.ownersStatus !== 'confirmed' ? ' <small class="is-warn">не звірено</small>' : ''}</h3>
        <section class="py-card ft-owners">${r.owners?.length ? r.owners.map(o => `<div class="ft-own"><span class="ft-ava" aria-hidden="true">${escapeHtml(String(o.name || '·').trim().split(/\s+/).slice(0, 2).map(w => w[0] || '').join('').toUpperCase())}</span>
            <span><b>${escapeHtml(o.name || 'Без імені')}</b><small>${escapeHtml([o.shareFrac || o.share ? `частка ${o.shareFrac || o.share}` : '', o.docInfo || ''].filter(Boolean).join(' · '))}</small></span></div>`).join('')
            : '<p class="py-empty">Власників у довіднику немає — їх вносить правління</p>'}</section>
        ${debt || status !== 'none' ? `<h3 class="chs-h">Претензійна робота</h3><section class="py-card ft-claim">
            <div><b>${escapeHtml(CLAIM_STATUSES[status] || 'Не розпочато')}</b><small>${r.months > 3 ? 'Борг понад 3 внески — можна надсилати претензію.' : debt ? 'Борг до 3 внесків — достатньо нагадування.' : ''}</small></div>
            <button type="button" class="sv-btn${r.months > 3 ? '' : ' is-soft'}" data-act="claim" data-apt="${escapeHtml(apt)}">${status === 'none' ? 'Відкрити справу ›' : 'До справи ›'}</button></section>` : ''}
        <h3 class="chs-h">Історія <small>${history ? history.length : ''}</small></h3>
        <div class="ft-hist-filter" role="group">${[['all', 'Усе'], ['charge', 'Нарахування'], ['payment', 'Оплати'], ['opening', 'Вхідний залишок'], ['refund', 'Повернення']].filter(([k]) => k === 'all' || history?.some(h => h.kind === k)).map(([k, v]) =>
            `<button type="button" class="ft-chip${histKind === k ? ' is-active' : ''}" data-hist="${k}">${v}</button>`).join('')}</div>
        <section class="py-card ft-hist">${!history ? '<p class="py-note">Читаю…</p>' : shown.length ? shown.slice(0, histLimit).map(h => `<div class="ft-h">
                <span class="ft-h-date">${escapeHtml(day(h.at))}</span>
                <span class="ft-h-what"><b>${escapeHtml(KINDS[h.kind] || h.label)}</b>${h.note ? `<small>${escapeHtml(h.note)}</small>` : ''}</span>
                <span class="ft-h-amt"><b class="${h.signedKop > 0 ? 'is-in' : ''}">${h.signedKop > 0 ? '+' : h.signedKop < 0 ? '−' : ''}${escapeHtml(fmtKop(Math.abs(h.signedKop)))}</b><small>сальдо ${escapeHtml(signedGrn(h.balanceKop))}</small></span></div>`).join('')
            + (shown.length > histLimit ? `<button type="button" class="btn-ghost-small" data-act="hist-more">Ще ${Math.min(30, shown.length - histLimit)} з ${shown.length - histLimit}</button>` : '')
            : '<p class="py-empty">Записів немає</p>'}</section>
        <div class="chs-actions ft-sticky">
            <button type="button" class="sv-btn" data-act="certificate" data-apt="${escapeHtml(apt)}">Довідка (PDF)</button>
            <button type="button" class="sv-btn is-soft" data-act="csv" data-apt="${escapeHtml(apt)}"${entries ? '' : ' disabled'}>Акт звірки (CSV)</button>
            <button type="button" class="sv-btn is-soft" data-act="charges">Нарахування ›</button>
        </div>`];
}

function sheetHost() {
    let el = document.getElementById('ftSheet');
    if (!el) {
        el = document.createElement('div');
        el.id = 'ftSheet';
        el.className = 'chs-wrap ft-sheet';
        el.hidden = true;
        document.body.appendChild(el);
        el.addEventListener('click', onClick);
        document.addEventListener('keydown', e => { if (e.key === 'Escape' && !el.hidden && !document.querySelector('.confirm-overlay')) closeSheet(); });
        window.addEventListener('hashchange', () => { if (location.hash !== '#flats') closeSheet(); });
    }
    return el;
}

function renderSheet() {
    const el = sheetHost();
    if (!selected || !rows.length) { el.hidden = true; el.innerHTML = ''; document.body.classList.remove('chs-open'); return; }
    const keep = el.dataset.apt === selected ? el.querySelector('.chs-body')?.scrollTop || 0 : 0;
    const [title, body] = aptSheet(selected);
    el.dataset.apt = selected;
    el.innerHTML = `<div class="chs-backdrop" data-act="sheet-close"></div>
        <aside class="chs-sheet" role="dialog" aria-modal="true" aria-label="${escapeHtml(title)}" tabindex="-1">
            <div class="chs-bar"><button type="button" class="chs-icon" data-act="sheet-prev" aria-label="Попередня квартира">‹</button>
                <span class="chs-bar-title">${escapeHtml(title)}</span>
                <span class="ft-bar-right"><button type="button" class="chs-icon" data-act="sheet-next" aria-label="Наступна квартира">›</button>
                <button type="button" class="chs-icon" data-act="sheet-close" aria-label="Закрити">×</button></span></div>
            <div class="chs-body">${body}</div>
        </aside>`;
    el.hidden = false;
    document.body.classList.add('chs-open');
    if (keep) el.querySelector('.chs-body').scrollTop = keep;
    else el.querySelector('.chs-sheet')?.focus({ preventScroll: true });
}

async function openSheet(apt) {
    selected = apt;
    histKind = 'all';
    histLimit = 15;
    renderSheet();
    markCurrent();
    if (ledgers.has(apt)) return;
    try {
        await fetchLedger(apt);
        if (selected === apt) renderSheet();
    } catch (e) {
        console.error('Історія квартири:', e);
        toast('Не вдалося прочитати історію квартири', 'error');
    }
}

function closeSheet() {
    selected = null;
    renderSheet();
    markCurrent();
}

/** Сусідня квартира в поточному відборі — гортати картки стрілками. */
function step(dir) {
    const list = selectFlats(rows, { filter, entrance, query: search, sort: view === 'list' ? sort : 'apt' });
    const i = list.findIndex(r => r.apt === selected);
    const next = list[(i + dir + list.length) % list.length];
    if (next) openSheet(next.apt);
}

function markCurrent() {
    document.querySelectorAll('#viewFlats [data-apt]').forEach(b => b.classList.toggle('is-current', b.dataset.apt === selected));
}

// ------------------------------------------------------------
// РОЗДІЛ
// ------------------------------------------------------------
export function openFlat(apt) {
    if (apt) { wantedApt = String(apt); search = ''; }
    if (location.hash !== '#flats') location.hash = 'flats';
    else loadFlatsView();
}

function renderBody() {
    const host = document.getElementById('ftBody');
    if (host) host.innerHTML = view === 'map' ? mapHtml() : listHtml();
}

function render() {
    const entrances = [...new Set(rows.map(r => String(r.entrance || '')).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'uk', { numeric: true }));
    document.getElementById('viewFlats').innerHTML = `${kpisHtml(houseKpis(rows))}
        ${depthHtml(rows)}
        ${toolsHtml(entrances)}
        <div id="ftBody"></div>`;
    renderBody();
}

export async function loadFlatsView() {
    const [charges, dir, claims] = await Promise.all([loadCharges(), loadDirectory(), loadClaims().catch(() => null)]);
    const monthly = new Map((charges.preview?.rows || []).map(x => [String(x.apt), x.amountKop]));
    const owners = new Map(dir.map(a => [String(a.apt), a.owners?.[0]?.name || '']));
    const dirBy = new Map(dir.map(a => [String(a.apt), a]));
    const aptBy = new Map((charges.apartments || []).map(a => [String(a.apt), a]));
    const claimBy = new Map((claims?.debtors || []).map(d => [String(d.apt), d.claim?.status || 'none']));
    rows = flatRows({ apartments: charges.apartments || [], monthly, owners }).map(r => {
        const d = dirBy.get(r.apt) || {};
        const status = claimBy.get(r.apt) || 'none';
        return { ...r, entrance: String(d.entrance || ''), ownersStatus: d.ownersStatus || '', owners: d.owners || [], residents: aptBy.get(r.apt)?.residents ?? null,
            claimStatus: status, claimStep: claimStep(status) };
    });
    ledgers.clear();
    aptDocs.clear();
    render();
    if (wantedApt) {
        const apt = wantedApt;
        wantedApt = null;
        openSheet(apt);
    } else if (selected && rows.some(r => r.apt === selected)) {
        fetchLedger(selected).then(() => renderSheet()).catch(() => {});
        renderSheet();
    }
    return houseKpis(rows).long;
}

async function certificate(btn, apt) {
    setBusy(btn, true, 'Формую…');
    try {
        const [snap, ownerSnap] = await Promise.all([getDoc(doc(db, 'apartments', apt)), getDocs(collection(db, 'apartments', apt, 'owners'))]);
        if (!snap.exists()) throw new Error('Квартиру не знайдено');
        const [{ buildDebtCertificateDoc }, { loadPdfMake, osbbInfo }] = await Promise.all([import('./admin-document-core.js'), import('./protocol_pdf.js')]);
        const [pdfMake, osbb] = await Promise.all([loadPdfMake(), osbbInfo()]);
        const date = new Date().toLocaleDateString('sv-SE');
        const definition = buildDebtCertificateDoc({ apt, apartment: snap.data(), owners: ownerSnap.docs.map(d => d.data()), date }, osbb);
        const blob = await new Promise((resolve, reject) => { try { pdfMake.createPdf(definition).getBlob(resolve); } catch (e) { reject(e); } });
        const link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        link.download = `Dovidka_kv${apt.replace(/[^\p{L}\p{N}_-]/gu, '_')}_${date}.pdf`;
        link.click();
        setTimeout(() => URL.revokeObjectURL(link.href), 2000);
        await audit('certificate.debt', { target: `apartments/${apt}`, summary: `Довідка про стан розрахунків кв. ${apt}` });
        toast('Довідку сформовано', 'success');
    } catch (e) {
        console.error('Довідка:', e);
        toast(e.message || 'Не вдалося сформувати довідку', 'error');
    } finally { if (btn.isConnected) setBusy(btn, false); }
}

function csv(apt) {
    const entries = ledgers.get(apt);
    if (!entries) return;
    const blob = new Blob([reconciliationCsv(apt, ledgerRows(entries))], { type: 'text/csv;charset=utf-8' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `Akt_zvirky_kv${apt}.csv`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

function onClick(e) {
    const t = e.target;
    const f = t.closest('[data-filter]');
    if (f && !f.disabled) {
        filter = f.dataset.filter === filter && f.closest('.ft-depth') ? 'all' : f.dataset.filter;
        limit = SHOWN;
        render();
        if (f.closest('.ft-kpis, .ft-depth')) document.getElementById('ftBody')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        return;
    }
    const en = t.closest('[data-entrance]');
    if (en) { entrance = en.dataset.entrance; render(); return; }
    const v = t.closest('.ft-view [data-view]');
    if (v) { view = v.dataset.view; try { localStorage.setItem(VIEW_KEY, view); } catch { /* ignore */ } render(); return; }
    const h = t.closest('[data-hist]');
    if (h) { histKind = h.dataset.hist; histLimit = 15; renderSheet(); return; }
    const btn = t.closest('[data-act]');
    if (btn && !btn.disabled) {
        const a = btn.dataset.act;
        if (a === 'sheet-close') closeSheet();
        else if (a === 'sheet-prev') step(-1);
        else if (a === 'sheet-next') step(1);
        else if (a === 'more') { limit += SHOWN; renderBody(); }
        else if (a === 'hist-more') { histLimit += 30; renderSheet(); }
        else if (a === 'certificate') certificate(btn, btn.dataset.apt);
        else if (a === 'csv') csv(btn.dataset.apt);
        else if (a === 'charges') { closeSheet(); openCharges('statement'); }
        else if (a === 'claim') { const apt = btn.dataset.apt; closeSheet(); openClaimCase(apt); }
        return;
    }
    const tile = t.closest('#viewFlats [data-apt]');
    if (tile) openSheet(tile.dataset.apt);
}

export function initFlatsView() {
    const host = document.getElementById('viewFlats');
    host.addEventListener('click', onClick);
    host.addEventListener('change', e => { if (e.target.id === 'flSort') { sort = e.target.value; renderBody(); } });
    host.addEventListener('input', e => {
        if (e.target.id !== 'flSearch') return;
        search = e.target.value;
        limit = SHOWN;
        renderBody();
    });
    host.addEventListener('keydown', e => {
        // Enter у пошуку — відкрити першу знайдену квартиру.
        if (e.target.id !== 'flSearch' || e.key !== 'Enter') return;
        const first = selectFlats(rows, { filter, entrance, query: search, sort })[0];
        if (first) openSheet(first.apt);
    });
    // Стрілки ← → гортають картки квартир, коли картка відкрита.
    document.addEventListener('keydown', e => {
        if (!selected || document.getElementById('ftSheet')?.hidden || e.target.matches('input, textarea, select')) return;
        if (e.key === 'ArrowLeft') { e.preventDefault(); step(-1); }
        if (e.key === 'ArrowRight') { e.preventDefault(); step(1); }
    });
}
