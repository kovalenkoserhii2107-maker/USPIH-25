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
// ============================================================
import { escapeHtml, toast, setBusy } from './ui.js';
import { loadClaims, claimsAct } from './buh-data.js';
const fmtArea = v => {
    if (v == null || v === '') return '—';
    const n = typeof v === 'number' ? v : parseFloat(String(v).replace(',', '.'));
    return Number.isFinite(n) && n > 0 ? n.toFixed(1) : '—';
};
const fmtAreaCsv = v => {
    if (v == null || v === '') return '';
    const n = typeof v === 'number' ? v : parseFloat(String(v).replace(',', '.'));
    return Number.isFinite(n) && n > 0 ? n.toFixed(2) : '';
};
import {
    COURT_DEFAULT_NAME,
    COURT_DEFAULT_ADDRESS,
    COURT_FEE_ORDER_KOP,
    CLAIM_STAGES,
    CLAIM_STATUSES,
    calculateClaimTotals,
    generatePreTrialClaim,
    generateCourtOrderApp,
    generateLawsuitApp,
    generateRestructureAgreement,
    fmtKop
} from './claims-core.js';

let ctx = null;
let activeFilter = 'all';
let isMartialLaw = true;
let selectedApt = null;
let searchQuery = '';

export async function loadClaimsView() {
    const host = document.getElementById('viewClaims');
    if (!host) return;
    host.innerHTML = '<p class="list-empty">Завантаження претензійно-позовної роботи…</p>';
    try {
        ctx = await loadClaims();
        render();
    } catch (err) {
        host.innerHTML = `<p class="list-empty is-bad">Помилка завантаження: ${escapeHtml(err.message)}</p>`;
    }
}

function filterDebtors(list) {
    let out = list || [];
    if (activeFilter === 'critical') {
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
        out = out.filter(d => d.apt.includes(q) || (d.ownerName && d.ownerName.toLowerCase().includes(q)));
    }
    return out;
}

function render() {
    const host = document.getElementById('viewClaims');
    if (!host || !ctx) return;

    const debtors = filterDebtors(ctx.debtors);
    const s = ctx.stats || {};

    const martialLawNotice = isMartialLaw
        ? `<div class="buh-card is-note" style="border-left: 4px solid #2B5C8F; margin-bottom: 14px;">
            <div style="display:flex; justify-content:space-between; align-items:center;">
                <b>Режим воєнного стану (Постанова КМУ № 206 / № 1405 від 29.12.2023)</b>
                <label style="display:flex; align-items:center; gap:6px; cursor:pointer;">
                    <input type="checkbox" id="toggleMartialLaw" ${isMartialLaw ? 'checked' : ''}>
                    <span>Діє воєнний стан</span>
                </label>
            </div>
            <p class="buh-note" style="margin-top:6px;">
                Мораторій на судове стягнення боргів за ЖКП у м. Одеса скасовано з 29.12.2023 — ОСББ має повне право звертатися до суду за судовими наказами та позовами.
                Нарахування пені та штрафів населенню заборонено до завершення воєнного стану.
            </p>
        </div>`
        : `<div class="buh-card is-note" style="border-left: 4px solid #2B8F5C; margin-bottom: 14px;">
            <div style="display:flex; justify-content:space-between; align-items:center;">
                <b>Мирний час (загальний порядок законодавства України)</b>
                <label style="display:flex; align-items:center; gap:6px; cursor:pointer;">
                    <input type="checkbox" id="toggleMartialLaw" ${isMartialLaw ? 'checked' : ''}>
                    <span>Діє воєнний стан</span>
                </label>
            </div>
            <p class="buh-note" style="margin-top:6px;">
                Воєнний стан не застосовується: дозволено повне нарахування пені за статутом (до 100% боргу), а також 3% річних та інфляційних втрат за ст. 625 ЦК України.
            </p>
        </div>`;

    host.innerHTML = `
        ${martialLawNotice}
        <div class="kpi-grid" style="margin-bottom: 14px;">
            <div class="kpi"><span>Загальний борг будинку</span><b class="is-out">${fmtKop(s.totalDebtKop)} грн</b><small>${s.debtorsCount} квартир</small></div>
            <div class="kpi"><span>Досудові претензії</span><b>${s.claimsCount}</b><small>надіслано вимог</small></div>
            <div class="kpi"><span>У суді (накази / позови)</span><b>${s.courtCount}</b><small>справ</small></div>
            <div class="kpi"><span>На примусовому виконанні</span><b>${s.enforcementCount}</b><small>у ДВС</small></div>
        </div>

        <div class="buh-card">
            <div class="buh-toolbar">
                <div class="buh-seg">
                    ${[
                        ['all', `Усі (${ctx.debtors.length})`],
                        ['critical', 'Борг > 3 тис. грн'],
                        ['claims', `Претензії (${s.claimsCount})`],
                        ['court', `У суді (${s.courtCount})`],
                        ['enforcement', `У ДВС (${s.enforcementCount})`],
                        ['restructured', `Реструктуризація (${s.restructuredCount})`]
                    ].map(([k, label]) => `<button type="button" class="buh-seg-item${k === activeFilter ? ' active' : ''}" data-filter="${k}">${label}</button>`).join('')}
                </div>
                <input type="search" id="claimsSearch" class="field-input buh-search" placeholder="Пошук за квартирою чи ПІБ…" value="${escapeHtml(searchQuery)}">
                <button type="button" class="btn-ghost-small" id="exportClaimsCsv">Експорт CSV</button>
            </div>

            <div class="jr-scroll" tabindex="0">
                <table class="buh-table is-compact">
                    <thead>
                        <tr>
                            <th>Кв.</th>
                            <th>Співвласник</th>
                            <th>Площа, м²</th>
                            <th class="t-sum">Борг, грн</th>
                            <th>Статус справи</th>
                            <th>Судова справа</th>
                            <th>Дії</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${debtors.length ? debtors.map(d => `
                            <tr>
                                <td><b>кв. ${escapeHtml(d.apt)}</b></td>
                                <td>${escapeHtml(d.ownerName || '—')}${d.ownerCode ? `<br><small class="t-muted">РНОКПП ${escapeHtml(d.ownerCode)}</small>` : ''}</td>
                                <td>${fmtArea(d.area)}</td>
                                <td class="t-sum is-out"><b>${fmtKop(d.debtKop)}</b></td>
                                <td>
                                    <span class="buh-tag ${['court_order_filed', 'lawsuit_filed'].includes(d.claim.status) ? 'is-review' : ['court_order_issued', 'lawsuit_satisfied'].includes(d.claim.status) ? 'is-payment' : d.claim.status === 'enforcement' ? 'is-bad' : 'is-soft'}">
                                        ${escapeHtml(CLAIM_STATUSES[d.claim.status] || d.claim.status)}
                                    </span>
                                </td>
                                <td>
                                    ${d.claim.caseNumber ? `<b>№ ${escapeHtml(d.claim.caseNumber)}</b>` : '<span class="t-muted">—</span>'}
                                    ${d.claim.courtOrderDate ? `<br><small>${escapeHtml(d.claim.courtOrderDate)}</small>` : ''}
                                </td>
                                <td>
                                    <button type="button" class="sv-btn is-soft btn-compact" data-act="open-case" data-apt="${escapeHtml(d.apt)}">Справа</button>
                                </td>
                            </tr>
                        `).join('') : '<tr><td colspan="7" class="list-empty">Боржників за цим фільтром не знайдено</td></tr>'}
                    </tbody>
                </table>
            </div>
        </div>

        <div id="claimModalHost"></div>
    `;

    bindEvents(host);
}

function bindEvents(host) {
    host.querySelectorAll('[data-filter]').forEach(btn => {
        btn.onclick = () => {
            activeFilter = btn.dataset.filter;
            render();
        };
    });

    const searchInput = host.querySelector('#claimsSearch');
    if (searchInput) {
        searchInput.oninput = () => {
            searchQuery = searchInput.value.trim();
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

    const exportBtn = host.querySelector('#exportClaimsCsv');
    if (exportBtn) {
        exportBtn.onclick = () => exportCsv();
    }
}

function openCaseModal(apt) {
    const d = ctx.debtors.find(x => x.apt === apt);
    if (!d) return;
    selectedApt = apt;

    const modalHost = document.getElementById('claimModalHost');
    if (!modalHost) return;

    const totals = calculateClaimTotals({
        debtKop: d.debtKop,
        isMartialLaw,
        daysOverdue: 120
    });

    modalHost.innerHTML = `
        <div class="modal-backdrop" id="caseModalBackdrop"></div>
        <div class="modal-dialog buh-card" style="max-width:760px; max-height:90vh; overflow-y:auto; z-index:1000; position:fixed; top:50%; left:50%; transform:translate(-50%, -50%); width:95%; box-shadow:0 10px 30px rgba(0,0,0,0.2);">
            <div class="buh-card-head">
                <div>
                    <span class="buh-tag">Претензійна справа · кв. ${escapeHtml(d.apt)}</span>
                    <h2>${escapeHtml(d.ownerName || 'Співвласник')} — борг ${fmtKop(d.debtKop)} грн</h2>
                </div>
                <button type="button" class="sheet-close" id="closeCaseModal">✕</button>
            </div>

            <div class="kpi-grid" style="margin: 12px 0;">
                <div class="kpi"><span>Основний борг</span><b class="is-out">${fmtKop(totals.principalKop)} грн</b></div>
                <div class="kpi"><span>Судовий збір (наказ)</span><b>${fmtKop(totals.courtFeeOrderKop)} грн</b></div>
                <div class="kpi"><span>Судовий збір (позов)</span><b>${fmtKop(totals.courtFeeLawsuitKop)} грн</b></div>
            </div>

            <form id="claimStatusForm" style="margin-top:12px;">
                <h3 class="rp-h">Статус розгляду та судова справа</h3>
                <div class="py-pair">
                    <label class="py-field">
                        <span>Стадія</span>
                        <select class="field-input field-select" name="stage">
                            ${Object.entries(CLAIM_STAGES).map(([k, label]) => `<option value="${k}"${d.claim.stage === k ? ' selected' : ''}>${escapeHtml(label)}</option>`).join('')}
                        </select>
                    </label>
                    <label class="py-field">
                        <span>Статус</span>
                        <select class="field-input field-select" name="status">
                            ${Object.entries(CLAIM_STATUSES).map(([k, label]) => `<option value="${k}"${d.claim.status === k ? ' selected' : ''}>${escapeHtml(label)}</option>`).join('')}
                        </select>
                    </label>
                </div>
                <div class="py-pair">
                    <label class="py-field">
                        <span>Номер судової справи</span>
                        <input class="field-input" name="caseNumber" value="${escapeHtml(d.claim.caseNumber || '')}" placeholder="520/1234/26">
                    </label>
                    <label class="py-field">
                        <span>Дата судового наказу / позову</span>
                        <input class="field-input" type="date" name="courtOrderDate" value="${escapeHtml(d.claim.courtOrderDate || '')}">
                    </label>
                </div>
                <label class="py-field">
                    <span>Коментар та хід справи</span>
                    <textarea class="field-input" name="note" rows="2" placeholder="Надіслано рекомендованим листом, вручено особисто, тощо…">${escapeHtml(d.claim.note || '')}</textarea>
                </label>
                <div style="display:flex; justify-content:space-between; margin-top:8px;">
                    <button type="button" class="sv-btn" id="saveClaimStatusBtn">Зберегти стан справи</button>
                </div>
            </form>

            <hr style="margin: 18px 0; border:0; border-top:1px solid #E0E5EC;">

            <h3 class="rp-h">Генератор офіційних процесуальних документів</h3>
            <p class="buh-note">Документи генеруються з дотриманням ЦПК України та норм воєнного стану.</p>
            <div style="display:flex; flex-wrap:wrap; gap:8px; margin-top:8px;">
                <button type="button" class="sv-btn is-soft" data-doc-type="claim">1. Досудова вимога (претензія)</button>
                <button type="button" class="sv-btn is-soft" data-doc-type="court_order">2. Заява про судовий наказ (ст. 161 ЦПК)</button>
                <button type="button" class="sv-btn is-soft" data-doc-type="lawsuit">3. Позовна заява (ст. 274 ЦПК)</button>
                <button type="button" class="sv-btn is-soft" data-doc-type="restructure">4. Договір реструктуризації</button>
            </div>

            <div id="docPreviewArea" style="margin-top:14px; display:none;">
                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:6px;">
                    <b id="docPreviewTitle">Текст документа</b>
                    <div>
                        <button type="button" class="btn-ghost-small" id="copyDocTextBtn">Копіювати текст</button>
                        <button type="button" class="sv-btn btn-compact" id="printDocBtn">Друк документа</button>
                    </div>
                </div>
                <pre id="docPreviewContent" style="background:#F8FAFC; border:1px solid #D6DCE5; border-radius:8px; padding:14px; font-size:13px; line-height:1.5; white-space:pre-wrap; max-height:350px; overflow-y:auto; font-family:monospace;"></pre>
            </div>
        </div>
    `;

    const closeBtn = document.getElementById('closeCaseModal');
    const backdrop = document.getElementById('caseModalBackdrop');
    const closeModal = () => { modalHost.innerHTML = ''; };
    if (closeBtn) closeBtn.onclick = closeModal;
    if (backdrop) backdrop.onclick = closeModal;

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
                ctx = await loadClaims();
                render();
            } catch (err) {
                toast(err.message, 'error');
            } finally {
                setBusy(saveBtn, false);
            }
        };
    }

    modalHost.querySelectorAll('[data-doc-type]').forEach(btn => {
        btn.onclick = () => showDocPreview(d, btn.dataset.docType);
    });
}

function showDocPreview(d, type) {
    const previewArea = document.getElementById('docPreviewArea');
    const titleHost = document.getElementById('docPreviewTitle');
    const contentHost = document.getElementById('docPreviewContent');
    const copyBtn = document.getElementById('copyDocTextBtn');
    const printBtn = document.getElementById('printDocBtn');
    if (!previewArea || !titleHost || !contentHost) return;

    let title = '';
    let text = '';
    const org = ctx.org;

    if (type === 'claim') {
        title = 'Досудова претензія (вимога про сплату)';
        text = generatePreTrialClaim({
            org,
            apt: d.apt,
            ownerName: d.ownerName,
            debtKop: d.debtKop,
            isMartialLaw,
            iban: org.iban
        });
    } else if (type === 'court_order') {
        title = 'Заява про видачу судового наказу (Київський районний суд м. Одеси)';
        text = generateCourtOrderApp({
            org,
            apt: d.apt,
            ownerName: d.ownerName,
            ownerCode: d.ownerCode,
            debtKop: d.debtKop,
            isMartialLaw,
            courtName: COURT_DEFAULT_NAME,
            courtAddress: COURT_DEFAULT_ADDRESS
        });
    } else if (type === 'lawsuit') {
        title = 'Позовна заява (спрощене позовне провадження)';
        text = generateLawsuitApp({
            org,
            apt: d.apt,
            ownerName: d.ownerName,
            ownerCode: d.ownerCode,
            debtKop: d.debtKop,
            isMartialLaw,
            courtName: COURT_DEFAULT_NAME,
            courtAddress: COURT_DEFAULT_ADDRESS
        });
    } else if (type === 'restructure') {
        title = 'Договір реструктуризації заборгованості';
        text = generateRestructureAgreement({
            org,
            apt: d.apt,
            ownerName: d.ownerName,
            debtKop: d.debtKop,
            monthsCount: 6
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
                w.document.write(`<html><head><title>${escapeHtml(title)}</title><style>body { font-family: 'Times New Roman', serif; font-size: 14pt; line-height: 1.4; padding: 2cm; white-space: pre-wrap; }</style></head><body>${escapeHtml(text)}</body></html>`);
                w.document.close();
                w.print();
            }
        };
    }
}

function exportCsv() {
    if (!ctx?.debtors) return;
    const lines = [
        ['Квартира', 'Співвласник', 'РНОКПП', 'Площа_м2', 'Борг_грн', 'Стадія', 'Статус', 'Номер_справи', 'Дата_наказу'].join(';')
    ];
    for (const d of ctx.debtors) {
        lines.push([
            `кв. ${d.apt}`,
            `"${(d.ownerName || '').replace(/"/g, '""')}"`,
            d.ownerCode || '',
            fmtAreaCsv(d.area),
            (d.debtKop / 100).toFixed(2),
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
