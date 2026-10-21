// ============================================================
// Претензійно-позовна робота з боржниками для ОСББ «Успіх-25».
//
// Норми законодавства України:
// 1. ЗУ «Про ОСББ» (ст. 15, 16, 17) — обовʼязок сплати внесків.
// 2. ЦПК України (ст. 161–163) — судовий наказ (судовий збір 302,80 грн).
// 3. ЦПК України (ст. 175, 274) — спрощене позовне провадження.
// 4. Постанова КМУ № 206 (зі змінами № 1405 від 29.12.2023):
//    мораторій на стягнення боргу скасовано (м. Одеса поза зоною бойових дій),
//    проте діє заборона нарахування пені та штрафів населенню під час ВС.
//    Передбачено перемикач режиму воєнного стану / мирного часу (на майбутнє).
//
// Дані про квартири, баланси (в грн -> переводимо в копійки) та співвласників
// синхронізуються одночасно з серверного контексту claimsAction та клієнтського
// довідника (loadDirectory + loadCharges + loadRequisites), щоб залишки боргу
// та ПІБ співвласників на 100% збігалися з розділом «Квартири».
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
    COURT_FEE_ORDER_KOP,
    CLAIM_STAGES,
    CLAIM_STATUSES,
    grnToKop,
    calculateClaimTotals,
    generatePreTrialClaim,
    generateCourtOrderApp,
    generateLawsuitApp,
    generateRestructureAgreement,
    generateDebtCalculation,
    fmtKop
} from './claims-core.js';

const fmtArea = v => {
    if (v == null || v === '') return '—';
    const n = typeof v === 'number' ? v : parseFloat(String(v).replace(',', '.'));
    return Number.isFinite(n) && n > 0 ? n.toFixed(1).replace('.', ',') : '—';
};
const fmtAreaCsv = v => {
    if (v == null || v === '') return '';
    const n = typeof v === 'number' ? v : parseFloat(String(v).replace(',', '.'));
    return Number.isFinite(n) && n > 0 ? n.toFixed(2).replace('.', ',') : '';
};

const INITIAL_VISIBLE_COUNT = 10;

let ctx = null;
let activeFilter = 'all';
let isMartialLaw = true;
let selectedApt = null;
let searchQuery = '';
let showAllDebtors = false;
const ledgerCache = new Map();

function getModalHost() {
    let host = document.getElementById('claimModalHost');
    if (!host || host.parentElement !== document.body) {
        if (host) host.remove();
        host = document.createElement('div');
        host.id = 'claimModalHost';
        document.body.appendChild(host);
    }
    return host;
}

async function fetchAptLedger(apt) {
    if (ledgerCache.has(apt)) return ledgerCache.get(apt);
    try {
        const snap = await getDocs(query(collection(db, 'apartments', String(apt), 'ledger'), orderBy('at', 'asc')));
        const list = snap.docs.map(d => ({
            id: d.id,
            ...d.data(),
            at: d.data().at?.toDate?.() || (d.data().at ? new Date(d.data().at) : null)
        }));
        ledgerCache.set(apt, list);
        return list;
    } catch (e) {
        console.warn(`Історія квартири ${apt}:`, e);
        return [];
    }
}

function inferPeriodsFromLedger(entries = []) {
    const periods = entries
        .map(e => String(e.period || '').trim())
        .filter(p => /^\d{4}-\d{2}$/.test(p))
        .sort();
    const opening = entries.find(e => e.kind === 'opening');
    const periodFrom = periods[0] || (opening?.period ? String(opening.period) : '2026-09');
    const periodTo = periods[periods.length - 1] || new Date().toISOString().slice(0, 7);
    return { periodFrom, periodTo };
}

/**
 * Обʼєднує серверні дані claimsAction з клієнтським довідником квартир і нарахувань.
 * Це гарантує:
 * 1) Точний залишок боргу в копійках (множення грн на 100, навіть якщо на сервері ще стара функція).
 * 2) Повні ПІБ усіх співвласників, їхні частки та документи з collectionGroup('owners').
 * 3) Особовий рахунок, площу, місячний внесок та кількість місяців прострочення.
 */
async function loadSynchronizedClaims() {
    const [rawClaims, dir, charges, req] = await Promise.all([
        loadClaims().catch(err => {
            console.warn('claimsAction fallback:', err);
            return null;
        }),
        loadDirectory().catch(() => []),
        loadCharges().catch(() => null),
        loadRequisites().catch(() => ({}))
    ]);

    if (req && typeof req.martialLaw === 'boolean') {
        isMartialLaw = req.martialLaw;
    } else if (rawClaims && typeof rawClaims.martialLaw === 'boolean') {
        isMartialLaw = rawClaims.martialLaw;
    } else {
        isMartialLaw = true;
    }

    const dirByApt = new Map((dir || []).map(a => [String(a.apt), a]));
    const chgAptByApt = new Map((charges?.apartments || []).map(a => [String(a.apt), a]));
    const monthlyByApt = new Map((charges?.preview?.rows || []).map(r => [String(r.apt), r.amountKop || 0]));
    const serverDebtorsByApt = new Map((rawClaims?.debtors || []).map(d => [String(d.apt), d]));

    // Збираємо всі квартири з довідника, нарахувань і серверної відповіді
    const allAptKeys = new Set([
        ...dirByApt.keys(),
        ...chgAptByApt.keys(),
        ...serverDebtorsByApt.keys()
    ]);

    const debtors = [];
    let totalDebtKop = 0;

    for (const apt of allAptKeys) {
        const dirApt = dirByApt.get(apt);
        const chgApt = chgAptByApt.get(apt);
        const srv = serverDebtorsByApt.get(apt);

        // Визначаємо точний баланс у копійках з першоджерела (charges.apartments або directory.balance)
        let balanceKop = 0;
        if (chgApt && chgApt.balance !== undefined && chgApt.balance !== null && chgApt.balance !== '') {
            balanceKop = grnToKop(chgApt.balance);
        } else if (dirApt && dirApt.balance !== undefined && dirApt.balance !== null && dirApt.balance !== '') {
            balanceKop = grnToKop(dirApt.balance);
        } else if (srv) {
            // Якщо в srv.balance лежить число в гривнях (напр. -8277.4), переводимо в копійки:
            balanceKop = srv.balance !== undefined ? grnToKop(srv.balance) : -Math.abs(Math.round(Number(srv.debtKop || 0)));
        }

        if (balanceKop >= 0) continue; // Не боржник
        const debtKop = Math.abs(balanceKop);
        totalDebtKop += debtKop;

        // Співвласники з collectionGroup('owners') (через loadDirectory) або з сервера
        const ownersRaw = (dirApt?.owners?.length ? dirApt.owners : (srv?.owners || [])).map(o => {
            const name = String(o.name || '').trim();
            const docInfo = String(o.docInfo || '').trim();
            const shareFrac = String(o.shareFrac || '').trim();
            const rnokpp = String(o.rnokpp || o.tin || (docInfo.match(/\b(\d{10})\b/) || [])[1] || '').trim();
            return { id: o.id || '', name, docInfo, shareFrac, rnokpp };
        });

        const claim = srv?.claim || { stage: 'pre_trial', status: 'none' };
        const ownerNames = ownersRaw.map(o => o.name).filter(Boolean).join(', ')
            || String(srv?.ownerName || '').trim();
        const ownerCodes = ownersRaw.map(o => o.rnokpp).filter(Boolean).join(', ')
            || String(srv?.ownerCode || '').trim();
        const docInfo = ownersRaw
            .map(o => [o.name, o.shareFrac ? `частка ${o.shareFrac}` : '', o.docInfo].filter(Boolean).join(' — '))
            .filter(Boolean)
            .join('; ') || String(srv?.docInfo || '').trim();

        const area = chgApt?.area ?? dirApt?.area ?? srv?.area ?? null;
        const personalAccount = String(chgApt?.personalAccount || dirApt?.personalAccount || srv?.personalAccount || '').trim();
        const monthlyKop = monthlyByApt.get(apt) || srv?.monthlyKop || 0;
        const months = debtKop && monthlyKop ? Math.max(1, Math.round(debtKop / monthlyKop)) : (srv?.months || 0);

        debtors.push({
            apt,
            entrance: String(dirApt?.entrance || srv?.entrance || '').trim(),
            personalAccount,
            ownersStatus: String(dirApt?.ownersStatus || srv?.ownersStatus || 'pending'),
            owners: ownersRaw,
            ownerName: claim.ownerNameOverride || ownerNames,
            ownerCode: claim.ownerCodeOverride || ownerCodes,
            docInfo,
            area,
            balanceKop,
            debtKop,
            monthlyKop,
            months,
            claim: {
                stage: claim.stage || 'pre_trial',
                status: claim.status || 'none',
                caseNumber: claim.caseNumber || '',
                claimDate: claim.claimDate || '',
                courtOrderDate: claim.courtOrderDate || '',
                lawsuitDate: claim.lawsuitDate || '',
                enforcementDate: claim.enforcementDate || '',
                periodFrom: claim.periodFrom || '',
                periodTo: claim.periodTo || '',
                ownerNameOverride: claim.ownerNameOverride || '',
                ownerCodeOverride: claim.ownerCodeOverride || '',
                note: claim.note || '',
                restructureMonths: claim.restructureMonths || 6,
                updatedAt: claim.updatedAt || null
            }
        });
    }

    debtors.sort((a, b) => b.debtKop - a.debtKop);

    const srvOrg = rawClaims?.org || {};
    const reg = req?.registry || {};
    // Якщо на сервері був старий дефолт адреси «Корольова, 25», замінюємо на реальну адресу будинку з osbb_settings/finance
    const rawSrvAddr = srvOrg.address && !srvOrg.address.includes('Корольова') ? srvOrg.address : '';
    const rawSrvIban = srvOrg.iban && srvOrg.iban !== 'UA213052990000026001234567890' ? srvOrg.iban : '';

    const org = {
        name: req?.payeeName || reg.legalName || srvOrg.name || 'ОСББ «Успіх-25»',
        edrpou: req?.edrpou || reg.code || srvOrg.edrpou || '40562894',
        address: req?.houseAddress || rawSrvAddr || DEFAULT_HOUSE_ADDRESS,
        legalAddress: srvOrg.legalAddress || reg.legalAddress || req?.houseAddress || rawSrvAddr || DEFAULT_HOUSE_ADDRESS,
        phone: srvOrg.phone || req?.phone || '',
        email: srvOrg.email || req?.email || '',
        headName: srvOrg.headName || reg.headName || '',
        iban: String(req?.iban || rawSrvIban || '').replace(/\s+/g, '')
    };

    const stats = {
        debtorsCount: debtors.length,
        totalDebtKop,
        over3MonthsCount: debtors.filter(d => d.months > 3).length,
        criticalCount: debtors.filter(d => d.debtKop >= 300000).length,
        claimsCount: debtors.filter(d => ['warning', 'claim'].includes(d.claim.status)).length,
        courtCount: debtors.filter(d => ['court_order_filed', 'court_order_issued', 'court_order_canceled', 'lawsuit_filed', 'lawsuit_satisfied'].includes(d.claim.status)).length,
        enforcementCount: debtors.filter(d => d.claim.status === 'enforcement').length,
        restructuredCount: debtors.filter(d => d.claim.status === 'restructured').length
    };

    return { debtors, stats, org };
}

export async function loadClaimsView() {
    const host = document.getElementById('viewClaims');
    if (!host) return;
    showAllDebtors = false;
    host.innerHTML = '<p class="list-empty">Завантаження претензійно-позовної роботи…</p>';
    try {
        ctx = await loadSynchronizedClaims();
        render();
    } catch (err) {
        host.innerHTML = `<p class="list-empty is-bad">Помилка завантаження: ${escapeHtml(err.message)}</p>`;
    }
}

function filterDebtors(list) {
    let out = list || [];
    if (activeFilter === 'over3m') {
        out = out.filter(d => d.months > 3);
    } else if (activeFilter === 'critical') {
        out = out.filter(d => d.debtKop >= 300000); // від 3 000 грн
    } else if (activeFilter === 'claims') {
        out = out.filter(d => ['warning', 'claim'].includes(d.claim.status));
    } else if (activeFilter === 'court') {
        out = out.filter(d => ['court_order_filed', 'court_order_issued', 'court_order_canceled', 'lawsuit_filed', 'lawsuit_satisfied'].includes(d.claim.status));
    } else if (activeFilter === 'enforcement') {
        out = out.filter(d => d.claim.status === 'enforcement');
    } else if (activeFilter === 'restructured') {
        out = out.filter(d => d.claim.status === 'restructured');
    }

    if (searchQuery) {
        const q = searchQuery.toLowerCase();
        out = out.filter(d =>
            d.apt.toLowerCase().includes(q) ||
            (d.personalAccount && d.personalAccount.toLowerCase().includes(q)) ||
            (d.ownerName && d.ownerName.toLowerCase().includes(q)) ||
            (d.docInfo && d.docInfo.toLowerCase().includes(q))
        );
    }
    return out;
}

function renderOwnerCell(d) {
    if (!d.ownerName) {
        return `<span class="t-muted">Власника не внесено в довідник</span>`;
    }
    const shareInfo = d.owners?.length > 1
        ? `<small class="t-muted">Співвласників: ${d.owners.length}${d.owners.some(o => o.shareFrac) ? ` (${d.owners.map(o => o.shareFrac || '—').join(', ')})` : ''}</small>`
        : (d.owners?.[0]?.shareFrac ? `<small class="t-muted">Частка: ${escapeHtml(d.owners[0].shareFrac)}</small>` : '');
    const codeInfo = d.ownerCode ? `<small class="t-muted">РНОКПП: ${escapeHtml(d.ownerCode)}</small>` : '';
    const extra = [shareInfo, codeInfo].filter(Boolean).join(' · ');
    return `<div><b>${escapeHtml(d.ownerName)}</b>${extra ? `<br>${extra}` : ''}</div>`;
}

function render() {
    const host = document.getElementById('viewClaims');
    if (!host || !ctx) return;

    const debtors = filterDebtors(ctx.debtors);
    const visibleDebtors = showAllDebtors ? debtors : debtors.slice(0, INITIAL_VISIBLE_COUNT);
    const s = ctx.stats || {};

    const martialLawNotice = isMartialLaw
        ? `<div class="buh-card is-note" style="margin-bottom: 14px;">
            <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:8px;">
                <b>Режим воєнного стану (Постанова КМУ № 206 / № 1405 від 29.12.2023)</b>
                <button type="button" class="btn-soft btn-compact" data-go="settings" data-settings-tab="policy">Налаштування правового режиму ›</button>
            </div>
            <p class="buh-note" style="margin-top:6px;">
                Мораторій на судове стягнення боргів за ЖКП та внески ОСББ у м. Одеса скасовано з 29.12.2023 — ОСББ має повне право звертатися до суду за судовими наказами (ст. 161 ЦПК) та позовами (ст. 274 ЦПК).
                Нарахування пені та штрафів населенню заборонено до завершення воєнного стану.
            </p>
        </div>`
        : `<div class="buh-card is-note" style="border-left: 4px solid #2B8F5C; margin-bottom: 14px;">
            <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:8px;">
                <b>Мирний час (загальний порядок законодавства України)</b>
                <button type="button" class="btn-soft btn-compact" data-go="settings" data-settings-tab="policy">Налаштування правового режиму ›</button>
            </div>
            <p class="buh-note" style="margin-top:6px;">
                Воєнний стан не застосовується: дозволено повне нарахування пені за статутом (до 100% боргу), а також 3% річних та інфляційних втрат за ст. 625 ЦК України.
            </p>
        </div>`;

    host.innerHTML = `
        ${martialLawNotice}
        <div class="kpi-grid" style="margin-bottom: 14px;">
            <div class="kpi"><span>Загальний борг будинку</span><b class="is-out">${fmtKop(s.totalDebtKop)} грн</b><small>${s.debtorsCount} квартир · понад 3 міс.: ${s.over3MonthsCount || 0}</small></div>
            <div class="kpi"><span>Досудові претензії</span><b>${s.claimsCount}</b><small>надіслано вимог</small></div>
            <div class="kpi"><span>У суді (накази / позови)</span><b>${s.courtCount}</b><small>справ</small></div>
            <div class="kpi"><span>На примусовому виконанні</span><b>${s.enforcementCount}</b><small>у ДВС</small></div>
        </div>

        <div class="buh-card">
            <div class="buh-toolbar">
                <div class="buh-seg">
                    ${[
                        ['all', `Усі (${ctx.debtors.length})`],
                        ['over3m', `Понад 3 міс. (${s.over3MonthsCount || 0})`],
                        ['critical', `Борг > 3 тис. грн (${s.criticalCount || 0})`],
                        ['claims', `Претензії (${s.claimsCount})`],
                        ['court', `У суді (${s.courtCount})`],
                        ['enforcement', `У ДВС (${s.enforcementCount})`],
                        ['restructured', `Реструктуризація (${s.restructuredCount})`]
                    ].map(([k, label]) => `<button type="button" class="buh-seg-item${k === activeFilter ? ' active' : ''}" data-filter="${k}">${label}</button>`).join('')}
                </div>
                <input type="search" id="claimsSearch" class="field-input buh-search" placeholder="Пошук за квартирою, о/р чи ПІБ…" value="${escapeHtml(searchQuery)}">
                <button type="button" class="btn-ghost-small" id="exportClaimsCsv">Експорт CSV</button>
            </div>

            <div class="jr-scroll" tabindex="0">
                <table class="buh-table is-compact">
                    <thead>
                        <tr>
                            <th>Кв. / о/р</th>
                            <th>Співвласник</th>
                            <th>Площа, м²</th>
                            <th class="t-sum">Внесок/міс.</th>
                            <th class="t-sum">Борг, грн</th>
                            <th>Статус справи</th>
                            <th>Судова справа</th>
                            <th>Дії</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${visibleDebtors.length ? visibleDebtors.map(d => `
                            <tr>
                                <td>
                                    <b>кв. ${escapeHtml(d.apt)}</b>
                                    ${d.personalAccount ? `<br><small class="t-muted">о/р ${escapeHtml(d.personalAccount)}</small>` : ''}
                                </td>
                                <td>${renderOwnerCell(d)}</td>
                                <td>${fmtArea(d.area)}</td>
                                <td class="t-sum">${d.monthlyKop ? `${fmtKop(d.monthlyKop)}` : '—'}</td>
                                <td class="t-sum is-out">
                                    <b>−${fmtKop(d.debtKop)}</b>
                                    ${d.months ? `<br><small class="t-muted">≈ ${d.months} міс.</small>` : ''}
                                </td>
                                <td>
                                    <span class="buh-tag ${['court_order_filed', 'lawsuit_filed'].includes(d.claim.status) ? 'is-review' : ['court_order_issued', 'lawsuit_satisfied'].includes(d.claim.status) ? 'is-payment' : d.claim.status === 'enforcement' ? 'is-bad' : 'is-soft'}">
                                        ${escapeHtml(CLAIM_STATUSES[d.claim.status] || d.claim.status)}
                                    </span>
                                </td>
                                <td>
                                    ${d.claim.caseNumber ? `<b>№ ${escapeHtml(d.claim.caseNumber)}</b>` : '<span class="t-muted">—</span>'}
                                    ${d.claim.courtOrderDate ? `<br><small>${escapeHtml(d.claim.courtOrderDate)}</small>` : ''}
                                </td>
                                <td style="white-space:nowrap;">
                                    <button type="button" class="sv-btn is-soft btn-compact" data-act="open-case" data-apt="${escapeHtml(d.apt)}">Справа</button>
                                    <button type="button" class="btn-ghost-small" data-act="open-flat" data-apt="${escapeHtml(d.apt)}" title="Відкрити картку квартири">Історія →</button>
                                </td>
                            </tr>
                        `).join('') : '<tr><td colspan="8" class="list-empty">Боржників за цим фільтром не знайдено</td></tr>'}
                    </tbody>
                </table>
            </div>
            ${debtors.length > INITIAL_VISIBLE_COUNT ? `
                <div class="claims-more-wrap" style="display:flex; justify-content:center; padding: 14px 0 4px;">
                    <button type="button" class="${showAllDebtors ? 'btn-ghost-small' : 'sv-btn is-soft'}" id="toggleShowAllDebtors" style="width:auto; min-height:40px; padding:0 24px;">
                        ${showAllDebtors ? `Згорнути до ${INITIAL_VISIBLE_COUNT}` : `Показати всі (${debtors.length})`}
                    </button>
                </div>
            ` : ''}
        </div>
    `;

    bindEvents(host);
}

function bindEvents(host) {
    host.querySelectorAll('[data-filter]').forEach(btn => {
        btn.onclick = () => {
            activeFilter = btn.dataset.filter;
            showAllDebtors = false;
            render();
        };
    });

    const searchInput = host.querySelector('#claimsSearch');
    if (searchInput) {
        searchInput.oninput = () => {
            searchQuery = searchInput.value.trim();
            showAllDebtors = false;
            render();
            const nextInput = host.querySelector('#claimsSearch');
            if (nextInput) {
                nextInput.focus();
                nextInput.setSelectionRange(nextInput.value.length, nextInput.value.length);
            }
        };
    }

    const showAllBtn = host.querySelector('#toggleShowAllDebtors');
    if (showAllBtn) {
        showAllBtn.onclick = () => {
            showAllDebtors = !showAllDebtors;
            render();
        };
    }

    const martialCheck = host.querySelector('#toggleMartialLaw');
    if (martialCheck) {
        martialCheck.onchange = () => {
            isMartialLaw = martialCheck.checked;
            render();
            toast(isMartialLaw ? 'Увімкнено режим воєнного стану' : 'Увімкнено режим мирного часу', 'info');
        };
    }

    host.querySelectorAll('[data-act="open-case"]').forEach(btn => {
        btn.onclick = () => openCaseModal(btn.dataset.apt);
    });

    host.querySelectorAll('[data-act="open-flat"]').forEach(btn => {
        btn.onclick = () => openFlat(btn.dataset.apt);
    });

    const exportBtn = host.querySelector('#exportClaimsCsv');
    if (exportBtn) {
        exportBtn.onclick = () => exportCsv();
    }
}

async function openCaseModal(apt) {
    const d = ctx.debtors.find(x => x.apt === apt);
    if (!d) return;
    selectedApt = apt;

    const modalHost = getModalHost();

    const entries = await fetchAptLedger(apt);
    const inferred = inferPeriodsFromLedger(entries);
    const periodFrom = d.claim.periodFrom || inferred.periodFrom;
    const periodTo = d.claim.periodTo || inferred.periodTo;

    const totals = calculateClaimTotals({
        debtKop: d.debtKop,
        isMartialLaw,
        daysOverdue: Math.max(30, (d.months || 1) * 30),
        penaltyPerDayKop: Math.round(d.debtKop * 0.0001),
        inflationRate: 0.05
    });

    const ownersListHtml = d.owners?.length
        ? `<div class="buh-note" style="margin-top:6px;">
            <b>Співвласники за реєстром (${d.owners.length}):</b>
            ${d.owners.map(o => `${escapeHtml(o.name)}${o.shareFrac ? ` (частка ${escapeHtml(o.shareFrac)})` : ''}${o.docInfo ? ` — ${escapeHtml(o.docInfo)}` : ''}`).join('; ')}
           </div>`
        : `<div class="buh-note is-bad" style="margin-top:6px;">У довіднику квартир ще не вказано ПІБ власника для кв. ${escapeHtml(d.apt)}. Ви можете вписати ПІБ нижче для формування документів.</div>`;

    modalHost.innerHTML = `
        <div class="claim-modal-overlay" id="caseModalBackdrop" style="position:fixed; inset:0; z-index:1000; background:rgba(15, 23, 42, 0.48); backdrop-filter:blur(2px); display:flex; align-items:center; justify-content:center; padding:16px; overflow-y:auto;">
        <div class="modal-dialog buh-card claim-modal-dialog" role="dialog" aria-modal="true" style="position:relative; width:min(820px, 100%); max-height:calc(100dvh - 32px); overflow-y:auto; margin:auto; box-shadow:0 20px 50px rgba(15, 23, 42, 0.28);">
            <div class="buh-card-head">
                <div>
                    <span class="buh-tag">Претензійна справа · кв. ${escapeHtml(d.apt)}${d.personalAccount ? ` · о/р ${escapeHtml(d.personalAccount)}` : ''}${d.area ? ` · ${fmtArea(d.area)} м²` : ''}</span>
                    <h2>${escapeHtml(d.ownerName || `Квартира ${d.apt}`)} — борг ${fmtKop(d.debtKop)} грн</h2>
                    ${ownersListHtml}
                </div>
                <button type="button" class="sheet-close" id="closeCaseModal">✕</button>
            </div>

            <div class="kpi-grid" style="margin: 12px 0;">
                <div class="kpi"><span>Основний борг</span><b class="is-out">${fmtKop(totals.principalKop)} грн</b><small>${d.months ? `≈ ${d.months} міс. внесків` : 'за особовим рахунком'}</small></div>
                <div class="kpi"><span>Судовий збір (наказ)</span><b>${fmtKop(totals.courtFeeOrderKop)} грн</b><small>ст. 161 ЦПК (0,1 ПМ)</small></div>
                <div class="kpi"><span>Судовий збір (позов)</span><b>${fmtKop(totals.courtFeeLawsuitKop)} грн</b><small>ст. 274 ЦПК (1,5%, мін. 1 ПМ)</small></div>
                <div class="kpi"><span>Штрафи / ст. 625 ЦК</span><b>${fmtKop(totals.penaltyKop + totals.threePercentKop + totals.inflationKop)} грн</b><small>${isMartialLaw ? '0 грн (воєнний стан)' : 'мирний час'}</small></div>
            </div>

            <form id="claimStatusForm" style="margin-top:12px;">
                <h3 class="rp-h">Реквізити боржника, період та статус судової справи</h3>
                <div class="py-pair">
                    <label class="py-field">
                        <span>ПІБ боржника (співвласника) для документів</span>
                        <input class="field-input" name="ownerNameOverride" id="docOwnerName" value="${escapeHtml(d.ownerName || '')}" placeholder="Введіть ПІБ співвласника">
                    </label>
                    <label class="py-field">
                        <span>РНОКПП / серія та номер паспорта (за наявності)</span>
                        <input class="field-input" name="ownerCodeOverride" id="docOwnerCode" value="${escapeHtml(d.ownerCode || '')}" placeholder="10 цифр РНОКПП або паспорт">
                    </label>
                </div>
                <div class="py-pair">
                    <label class="py-field">
                        <span>Період заборгованості З</span>
                        <input class="field-input" name="periodFrom" id="docPeriodFrom" value="${escapeHtml(periodFrom)}" placeholder="2025-01">
                    </label>
                    <label class="py-field">
                        <span>Період заборгованості ПО</span>
                        <input class="field-input" name="periodTo" id="docPeriodTo" value="${escapeHtml(periodTo)}" placeholder="2026-10">
                    </label>
                </div>
                <div class="py-pair">
                    <label class="py-field">
                        <span>Стадія провадження</span>
                        <select class="field-input field-select" name="stage">
                            ${Object.entries(CLAIM_STAGES).map(([k, label]) => `<option value="${k}"${d.claim.stage === k ? ' selected' : ''}>${escapeHtml(label)}</option>`).join('')}
                        </select>
                    </label>
                    <label class="py-field">
                        <span>Статус справи</span>
                        <select class="field-input field-select" name="status">
                            ${Object.entries(CLAIM_STATUSES).map(([k, label]) => `<option value="${k}"${d.claim.status === k ? ' selected' : ''}>${escapeHtml(label)}</option>`).join('')}
                        </select>
                    </label>
                </div>
                <div class="py-pair">
                    <label class="py-field">
                        <span>Номер судової справи (ЄДРСР)</span>
                        <input class="field-input" name="caseNumber" value="${escapeHtml(d.claim.caseNumber || '')}" placeholder="947/12345/26">
                    </label>
                    <label class="py-field">
                        <span>Дата претензії / судового наказу / позову</span>
                        <input class="field-input" type="date" name="courtOrderDate" value="${escapeHtml(d.claim.courtOrderDate || '')}">
                    </label>
                </div>
                <div class="py-pair">
                    <label class="py-field">
                        <span>Строк реструктуризації (місяців)</span>
                        <input class="field-input" type="number" min="1" max="36" name="restructureMonths" id="docRestructureMonths" value="${escapeHtml(String(d.claim.restructureMonths || 6))}">
                    </label>
                    <label class="py-field">
                        <span>Коментар та хід справи (рекомендований лист, ДВС тощо)</span>
                        <input class="field-input" name="note" value="${escapeHtml(d.claim.note || '')}" placeholder="Надіслано Укрпоштою, трек-номер…">
                    </label>
                </div>
                <div style="display:flex; justify-content:space-between; align-items:center; margin-top:8px;">
                    <button type="button" class="sv-btn" id="saveClaimStatusBtn">Зберегти стан справи</button>
                    <span class="buh-note">Отримувач: ${escapeHtml(ctx.org.name)} · ЄДРПОУ ${escapeHtml(ctx.org.edrpou)}${ctx.org.iban ? ` · ${escapeHtml(ctx.org.iban)}` : ''}</span>
                </div>
            </form>

            <hr style="margin: 18px 0; border:0; border-top:1px solid #E0E5EC;">

            <h3 class="rp-h">Генератор офіційних процесуальних документів</h3>
            <p class="buh-note">Документи автоматично заповнюються реквізитами ОСББ (${escapeHtml(ctx.org.address)}), даними співвласника, особовим рахунком та історією нарахувань.</p>
            <div style="display:flex; flex-wrap:wrap; gap:8px; margin-top:8px;">
                <button type="button" class="sv-btn is-soft" data-doc-type="claim">1. Досудова вимога (претензія)</button>
                <button type="button" class="sv-btn is-soft" data-doc-type="court_order">2. Заява про судовий наказ (ст. 161 ЦПК)</button>
                <button type="button" class="sv-btn is-soft" data-doc-type="lawsuit">3. Позовна заява (ст. 274 ЦПК)</button>
                <button type="button" class="sv-btn is-soft" data-doc-type="calculation">4. Довідка-розрахунок боргу (до суду)</button>
                <button type="button" class="sv-btn is-soft" data-doc-type="restructure">5. Договір реструктуризації</button>
            </div>

            <div id="docPreviewArea" style="margin-top:14px; display:none;">
                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:6px;">
                    <b id="docPreviewTitle">Текст документа</b>
                    <div style="display:flex; gap:8px;">
                        <button type="button" class="btn-ghost-small" id="copyDocTextBtn">Копіювати текст</button>
                        <button type="button" class="sv-btn btn-compact" id="printDocBtn">Друк / PDF</button>
                    </div>
                </div>
                <pre id="docPreviewContent" style="background:var(--sv-soft-2); border:1px solid var(--sv-line); border-radius:8px; padding:14px; font-size:13px; line-height:1.5; white-space:pre-wrap; max-height:360px; overflow-y:auto; font-family:monospace;"></pre>
            </div>
        </div>
        </div>
    `;

    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    const closeBtn = document.getElementById('closeCaseModal');
    const backdrop = document.getElementById('caseModalBackdrop');
    const onKeyDown = e => {
        if (e.key === 'Escape') closeModal();
    };
    const closeModal = () => {
        document.removeEventListener('keydown', onKeyDown);
        window.removeEventListener('popstate', closeModal);
        document.body.style.overflow = prevOverflow;
        modalHost.innerHTML = '';
    };
    document.addEventListener('keydown', onKeyDown);
    // Вікно висить на <body>: без цього «Назад» у браузері лишав би його поверх іншого розділу.
    window.addEventListener('popstate', closeModal);
    if (closeBtn) closeBtn.onclick = closeModal;
    if (backdrop) {
        backdrop.onclick = e => {
            if (e.target === backdrop) closeModal();
        };
    }

    const saveBtn = document.getElementById('saveClaimStatusBtn');
    if (saveBtn) {
        saveBtn.onclick = async () => {
            const form = document.getElementById('claimStatusForm');
            const data = Object.fromEntries(new FormData(form).entries());
            setBusy(saveBtn, true, 'Зберігаю…');
            try {
                await claimsAct({ action: 'saveClaim', apt, ...data });
                toast('Стан справи збережено', 'success');
                closeModal();
                ctx = await loadSynchronizedClaims();
                render();
            } catch (err) {
                toast(err.message, 'error');
            } finally {
                setBusy(saveBtn, false);
            }
        };
    }

    let currentDocType = null;
    const refreshPreview = () => {
        if (currentDocType) showDocPreview(d, currentDocType, entries);
    };

    modalHost.querySelectorAll('[data-doc-type]').forEach(btn => {
        btn.onclick = () => {
            currentDocType = btn.dataset.docType;
            showDocPreview(d, currentDocType, entries);
        };
    });

    ['docOwnerName', 'docOwnerCode', 'docPeriodFrom', 'docPeriodTo', 'docRestructureMonths'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.addEventListener('input', refreshPreview);
    });
}

function showDocPreview(d, type, ledgerEntries = []) {
    const previewArea = document.getElementById('docPreviewArea');
    const titleHost = document.getElementById('docPreviewTitle');
    const contentHost = document.getElementById('docPreviewContent');
    const copyBtn = document.getElementById('copyDocTextBtn');
    const printBtn = document.getElementById('printDocBtn');
    if (!previewArea || !titleHost || !contentHost) return;

    const ownerName = (document.getElementById('docOwnerName')?.value || '').trim() || d.ownerName;
    const ownerCode = (document.getElementById('docOwnerCode')?.value || '').trim() || d.ownerCode;
    const periodFrom = (document.getElementById('docPeriodFrom')?.value || '').trim() || 'початку обліку';
    const periodTo = (document.getElementById('docPeriodTo')?.value || '').trim() || new Date().toISOString().slice(0, 7);
    const restructureMonths = Number(document.getElementById('docRestructureMonths')?.value || d.claim.restructureMonths || 6);

    const totals = calculateClaimTotals({
        debtKop: d.debtKop,
        isMartialLaw,
        daysOverdue: Math.max(30, (d.months || 1) * 30),
        penaltyPerDayKop: Math.round(d.debtKop * 0.0001),
        inflationRate: 0.05
    });

    let title = '';
    let text = '';
    const org = ctx.org;
    const common = {
        org,
        apt: d.apt,
        ownerName,
        ownerCode,
        personalAccount: d.personalAccount,
        area: d.area,
        docInfo: d.docInfo,
        debtKop: d.debtKop,
        monthlyKop: d.monthlyKop,
        periodFrom,
        periodTo,
        isMartialLaw
    };

    if (type === 'claim') {
        title = 'Досудова претензія (вимога про сплату заборгованості)';
        text = generatePreTrialClaim({
            ...common,
            iban: org.iban
        });
    } else if (type === 'court_order') {
        title = 'Заява про видачу судового наказу (Київський районний суд м. Одеси)';
        text = generateCourtOrderApp({
            ...common,
            courtName: COURT_DEFAULT_NAME,
            courtAddress: COURT_DEFAULT_ADDRESS
        });
    } else if (type === 'lawsuit') {
        title = 'Позовна заява (спрощене позовне провадження)';
        text = generateLawsuitApp({
            ...common,
            courtName: COURT_DEFAULT_NAME,
            courtAddress: COURT_DEFAULT_ADDRESS,
            courtFeeKop: totals.courtFeeLawsuitKop,
            penaltyKop: totals.penaltyKop,
            threePercentKop: totals.threePercentKop,
            inflationKop: totals.inflationKop
        });
    } else if (type === 'calculation') {
        title = 'Довідка-розрахунок заборгованості за особовим рахунком (Додаток № 1 до суду)';
        text = generateDebtCalculation({
            ...common,
            ledgerEntries
        });
    } else if (type === 'restructure') {
        title = 'Договір про реструктуризацію заборгованості';
        text = generateRestructureAgreement({
            ...common,
            monthsCount: restructureMonths
        });
    }

    titleHost.textContent = title;
    contentHost.textContent = text;
    previewArea.style.display = 'block';

    if (copyBtn) {
        copyBtn.onclick = () => {
            navigator.clipboard.writeText(text);
            toast('Текст документа скопійовано', 'success');
        };
    }

    if (printBtn) {
        printBtn.onclick = () => {
            const w = window.open('', '_blank');
            if (w) {
                w.document.write(`<html><head><title>${escapeHtml(title)}</title><style>body { font-family: 'Times New Roman', serif; font-size: 13pt; line-height: 1.45; padding: 2cm; white-space: pre-wrap; }</style></head><body>${escapeHtml(text)}</body></html>`);
                w.document.close();
                w.print();
            }
        };
    }
}

function exportCsv() {
    if (!ctx?.debtors) return;
    const lines = [
        ['Квартира', 'Особовий_рахунок', 'Співвласники', 'РНОКПП', 'Площа_м2', 'Внесок_міс_грн', 'Борг_грн', 'Місяців_боргу', 'Стадія', 'Статус', 'Номер_справи', 'Дата_наказу'].join(';')
    ];
    for (const d of ctx.debtors) {
        lines.push([
            `кв. ${d.apt}`,
            d.personalAccount || '',
            `"${(d.ownerName || '').replace(/"/g, '""')}"`,
            d.ownerCode || '',
            fmtAreaCsv(d.area),
            d.monthlyKop ? (d.monthlyKop / 100).toFixed(2).replace('.', ',') : '',
            (d.debtKop / 100).toFixed(2).replace('.', ','),
            d.months || '',
            `"${CLAIM_STAGES[d.claim.stage] || d.claim.stage}"`,
            `"${CLAIM_STATUSES[d.claim.status] || d.claim.status}"`,
            d.claim.caseNumber || '',
            d.claim.courtOrderDate || ''
        ].join(';'));
    }
    const blob = new Blob([new Uint8Array([0xEF, 0xBB, 0xBF]), lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `reestr-borzhnykiv-uspih25-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    toast('Реєстр боржників експортовано в CSV', 'success');
}
