// ============================================================
// «Квартири»: пошук квартири, борги й переплати, картка квартири з
// історією (сальдо після кожного запису), довідкою про стан
// розрахунків (PDF) і актом звірки (CSV).
//
// Баланси — з контексту нарахувань (сервер рахує їх з історії),
// власники — з довідника, історія — apartments/{кв}/ledger.
// Розрахунки й відбори — flats-core.js.
// ============================================================
import { db } from './firebase.js';
import { collection, doc, getDoc, getDocs, query, orderBy } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js';
import { escapeHtml, toast, setBusy } from './ui.js';
import { audit } from './audit.js';
import { loadCharges, loadDirectory } from './buh-data.js';
import { fmtKop } from './charges-core.js';
import { openCharges } from './buh-charges.js';
import { FILTERS, flatRows, flatCounts, filterFlats, ledgerRows, lastPayment, reconciliationCsv } from './flats-core.js';

const SHOWN = 60;
let rows = [];
let filter = 'debt';
let search = '';
let selected = null;
let wantedApt = null;
let limit = SHOWN;
const ledgers = new Map();   // кв → записи історії

const grn = k => `${fmtKop(k)} грн`;
const day = d => d.toLocaleDateString('uk-UA', { day: '2-digit', month: '2-digit', year: 'numeric' });

async function fetchLedger(apt) {
    if (ledgers.has(apt)) return ledgers.get(apt);
    const snap = await getDocs(query(collection(db, 'apartments', apt, 'ledger'), orderBy('at', 'desc')));
    const list = snap.docs.map(d => ({ ...d.data(), at: d.data().at?.toDate?.() || null })).filter(e => e.at);
    ledgers.set(apt, list);
    return list;
}

function listHtml() {
    const list = filterFlats(rows, filter, search);
    if (!list.length) return `<p class="list-empty">${search ? 'Такої квартири не знайдено' : 'У цьому відборі квартир немає'}</p>`;
    return `<ul class="fl-items">${list.slice(0, limit).map(r => `<li>
        <button type="button" class="fl-item${r.apt === selected ? ' is-current' : ''}" data-act="pick" data-apt="${escapeHtml(r.apt)}" aria-current="${r.apt === selected}">
            <span class="fl-no">${escapeHtml(r.apt)}</span>
            <span class="fl-copy"><b>Квартира ${escapeHtml(r.apt)}</b><small>${escapeHtml(r.debtKop ? (r.months ? `борг ≈ ${r.months} міс.` : 'борг') : r.balanceKop > 0 ? 'переплата' : 'сплачено')}${r.owner ? ` · ${escapeHtml(r.owner)}` : ''}</small></span>
            <b class="fl-sum ${r.debtKop ? (r.months > 3 ? 'is-bad' : '') : r.balanceKop > 0 ? 'is-good' : 'is-muted'}">${r.balanceKop ? `${r.balanceKop < 0 ? '−' : '+'}${escapeHtml(grn(Math.abs(r.balanceKop)))}` : '0,00 грн'}</b>
        </button></li>`).join('')}</ul>
        ${list.length > limit ? `<button type="button" class="sv-btn is-soft is-wide" data-act="more">Показати ще ${Math.min(SHOWN, list.length - limit)} з ${list.length - limit}</button>` : ''}`;
}

function cardHtml(r, entries) {
    if (!r) return '<div class="fl-empty"><b>Оберіть квартиру</b><span>Баланс, історія, довідка й акт звірки — тут.</span></div>';
    const debt = r.debtKop > 0;
    const [chip, chipCls] = debt ? (r.months > 3 ? ['Понад 3 місяці', 'is-bad'] : ['Є борг', 'is-work']) : r.balanceKop > 0 ? ['Переплата', 'is-done'] : ['Без боргу', 'is-done'];
    const history = entries ? ledgerRows(entries) : null;
    const paid = entries ? lastPayment(entries) : null;
    const facts = [r.area ? `${String(r.area).replace('.', ',')} м²` : '', r.personalAccount ? `о/р ${r.personalAccount}` : '', r.monthlyKop ? `внесок ${grn(r.monthlyKop)} на місяць` : ''].filter(Boolean);
    return `<div class="fl-card-head">
            <div><span class="fl-facts">${escapeHtml(facts.join(' · '))}</span><h2>Квартира ${escapeHtml(r.apt)}</h2>${r.owner ? `<span class="fl-owner">${escapeHtml(r.owner)}</span>` : ''}</div>
            <span class="sv-chip ${chipCls}">${chip}</span>
        </div>
        <div class="fl-balance${debt ? ' is-debt' : ''}">
            <span>${debt ? 'Борг' : r.balanceKop > 0 ? 'Переплата' : 'Баланс'}</span>
            <b>${escapeHtml(grn(Math.abs(r.balanceKop)))}</b>
            <small>${!entries ? 'Читаю історію…' : paid ? `Остання оплата ${escapeHtml(day(paid.at))} · ${escapeHtml(grn(paid.amountKop))}` : 'Оплат в історії немає'}${debt && r.months ? ` · ≈ ${r.months} міс. внесків` : ''}</small>
        </div>
        <div class="fl-history">
            <h3>Історія</h3>
            ${!history ? '<p class="list-empty">Читаю…</p>' : history.length ? `<ul>${history.slice(0, 12).map(h => `<li>
                <span class="fl-date">${escapeHtml(day(h.at))}</span>
                <span class="fl-what"><b>${escapeHtml(h.label)}</b>${h.note ? `<small>${escapeHtml(h.note)}</small>` : ''}</span>
                <span class="fl-amt"><b class="${h.signedKop > 0 ? 'is-good' : ''}">${h.signedKop > 0 ? '+' : h.signedKop < 0 ? '−' : ''}${escapeHtml(fmtKop(Math.abs(h.signedKop)))}</b><small>сальдо ${h.balanceKop < 0 ? '−' : ''}${escapeHtml(fmtKop(Math.abs(h.balanceKop)))}</small></span>
            </li>`).join('')}</ul>${history.length > 12 ? `<p class="buh-note">Ще ${history.length - 12} записів — в акті звірки.</p>` : ''}` : '<p class="list-empty">Записів ще немає</p>'}
        </div>
        <div class="fl-actions">
            <button type="button" class="sv-btn" data-act="certificate" data-apt="${escapeHtml(r.apt)}">Довідка про стан розрахунків</button>
            <button type="button" class="sv-btn is-soft" data-act="csv" data-apt="${escapeHtml(r.apt)}"${entries ? '' : ' disabled'}>Акт звірки (CSV)</button>
            <button type="button" class="sv-btn is-soft" data-act="charges">Нарахування за місяць</button>
        </div>`;
}

async function showCard({ scroll = false } = {}) {
    const host = document.getElementById('flCard');
    if (!host) return;
    const r = rows.find(x => x.apt === selected);
    host.innerHTML = cardHtml(r, r ? ledgers.get(r.apt) : null);
    if (scroll && window.matchMedia('(max-width: 900px)').matches) host.scrollIntoView({ behavior: 'smooth', block: 'start' });
    if (!r || ledgers.has(r.apt)) return;
    try {
        await fetchLedger(r.apt);
        if (selected === r.apt) host.innerHTML = cardHtml(r, ledgers.get(r.apt));
    } catch (e) {
        console.error('Історія квартири:', e);
        if (selected === r.apt) host.querySelector('.fl-history').innerHTML = '<p class="list-empty">Не вдалося прочитати історію</p>';
    }
}

function renderList() {
    const host = document.getElementById('flList');
    if (host) host.innerHTML = listHtml();
    document.querySelectorAll('#viewFlats [data-act="filter"]').forEach(b => {
        const on = b.dataset.filter === filter && !search;
        b.classList.toggle('active', on);
        b.setAttribute('aria-pressed', String(on));
    });
}

export function openFlat(apt) {
    if (apt) {
        selected = String(apt);
        wantedApt = String(apt);
        search = '';
    }
    if (location.hash !== '#flats') location.hash = 'flats';
    else loadFlatsView();
}

export async function loadFlatsView() {
    const [charges, dir] = await Promise.all([loadCharges(), loadDirectory()]);
    const monthly = new Map((charges.preview?.rows || []).map(x => [String(x.apt), x.amountKop]));
    const owners = new Map(dir.map(a => [String(a.apt), a.owners?.[0]?.name || '']));
    rows = flatRows({ apartments: charges.apartments || [], monthly, owners });
    ledgers.clear();
    const counts = flatCounts(rows);
    if (wantedApt) {
        selected = wantedApt;
        const inCurrent = filterFlats(rows, filter, search).some(r => r.apt === wantedApt);
        if (!inCurrent) filter = 'all';
        const idx = filterFlats(rows, filter, search).findIndex(r => r.apt === wantedApt);
        if (idx >= limit) limit = Math.ceil((idx + 1) / SHOWN) * SHOWN;
    }
    if (!selected) selected = filterFlats(rows, filter)[0]?.apt || null;
    document.getElementById('viewFlats').innerHTML = `
        <div class="fl-tools">
            <label class="fl-search"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.2" aria-hidden="true"><circle cx="11" cy="11" r="7"></circle><path d="M20 20l-3.5-3.5"></path></svg>
                <input id="flSearch" type="search" inputmode="search" placeholder="Номер квартири або прізвище власника" value="${escapeHtml(search)}" aria-label="Пошук квартири"></label>
            <div class="fl-filters" role="group" aria-label="Відбір">${Object.entries(FILTERS).map(([k, v]) =>
                `<button type="button" class="fl-filter" data-act="filter" data-filter="${k}" aria-pressed="false">${v} <span>${counts[k]}</span></button>`).join('')}</div>
        </div>
        <div class="fl-grid">
            <section class="fl-list" aria-label="Квартири" id="flList"></section>
            <section class="fl-card" aria-label="Картка квартири" id="flCard"></section>
        </div>`;
    renderList();
    await showCard();
    if (wantedApt) {
        const targetApt = wantedApt;
        wantedApt = null;
        setTimeout(() => {
            const itemEl = document.querySelector(`#viewFlats .fl-item[data-apt="${CSS.escape(targetApt)}"]`);
            const cardEl = document.getElementById('flCard');
            itemEl?.scrollIntoView({ behavior: 'smooth', block: 'center' });
            cardEl?.classList.add('buh-nav-target-highlight');
            itemEl?.classList.add('buh-nav-target-highlight');
            setTimeout(() => {
                cardEl?.classList.remove('buh-nav-target-highlight');
                itemEl?.classList.remove('buh-nav-target-highlight');
            }, 2600);
        }, 60);
    }
    return counts.long;
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

export function initFlatsView() {
    const host = document.getElementById('viewFlats');
    host.addEventListener('click', e => {
        const btn = e.target.closest('[data-act]');
        if (!btn || btn.disabled) return;
        const a = btn.dataset.act;
        if (a === 'pick') { selected = btn.dataset.apt; renderList(); showCard({ scroll: true }); }
        else if (a === 'filter') { filter = btn.dataset.filter; search = ''; limit = SHOWN; const input = document.getElementById('flSearch'); if (input) input.value = ''; renderList(); }
        else if (a === 'more') { limit += SHOWN; renderList(); }
        else if (a === 'certificate') certificate(btn, btn.dataset.apt);
        else if (a === 'csv') csv(btn.dataset.apt);
        else if (a === 'charges') openCharges('statement');
    });
    host.addEventListener('input', e => {
        if (e.target.id !== 'flSearch') return;
        search = e.target.value;
        limit = SHOWN;
        renderList();
    });
    host.addEventListener('keydown', e => {
        // Enter у пошуку — відкрити першу знайдену квартиру.
        if (e.target.id !== 'flSearch' || e.key !== 'Enter') return;
        const first = filterFlats(rows, filter, search)[0];
        if (first) { selected = first.apt; renderList(); showCard({ scroll: true }); }
    });
}
