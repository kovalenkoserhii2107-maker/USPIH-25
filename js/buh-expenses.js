// ============================================================
// «Документи»: рахунки, акти й накладні постачальників, договори,
// постачальники. Документи — списком і карткою зі сканом; файл можна
// перетягнути на сторінку — відкриється форма з ним.
//
// Бухгалтер вносить документ з файлом → система визначає, хто
// затверджує (за договором — бухгалтер, без договору чи понад нього —
// голова) → затверджений документ одним «Сплатити» йде в Приват24 на
// підпис голови → виписка сама позначає його оплаченим.
// Усі записи — через сервер (expenseAction).
// ============================================================
import { session } from './firebase.js';
import { escapeHtml, toast, setBusy, confirmDialog, promptDialog } from './ui.js';
import {
    loadExpenses, expAct, uploadExpenseFiles, loadPaymentContext, loadPayments, CONTRACT_STATUS, maskIban, when, dateOnly, loadTx, PAYMENT_STATUS
} from './buh-data.js';
import { defaultAccount } from './buh-payments.js';
import { periodName, fmtKop, toKop } from './charges-core.js';
import { TABS, remaining, bucketOf, chipOf, filterDocs, docCounts, mainsFor as mainsOf, twinOf, scanKind } from './docs-core.js';
import { docPayments } from './chain-core.js';
import { sameEntity } from './bank-view-core.js';
import { openPaymentSheet, openTxSheet, openContractSheet } from './buh-chain.js';
import { ASSET_SUBACCOUNTS, DEPR_METHODS, UNITS, defaultSubacc, defaultDeprMethod, suggestAssetId } from './assets-core.js';
import { openAssets } from './buh-assets.js';
import { openAdvance } from './buh-advance.js';


const LEGACY = { docs: 'work' };
let segment = 'work';
let selected = null;      // id документа в картці
let query = '';
let paying = new Set();   // документи, платіж за якими вже в Приват24 на підписі
let allPayments = [];     // платежі — для блоку «Оплата» в картці документа
let wanted = null;        // документ, який треба показати (з «Рішень» чи картки ланцюжка) — вкладку визначаємо за ним
let activeFocus = null;   // { kind: "supplier"|"contract", id, name, code, iban, number, date, subject, amountKop } — фокус при переході з «Банку»
let shouldScrollFocus = false;
let ctx = null;
let form = null;          // { kind: 'doc'|'contract'|'supplier', data }
let files = [];           // нові файли форми, ще не завантажені

const isChair = () => session.role === 'chair';
const human = d => (d ? String(d).split('-').reverse().join('.') : '');
/** Для <input type="date">: дата з призначення платежу («12.03.2026») → 2026-03-12; інше — порожньо. */
const isoDate = d => {
    const v = String(d || '').trim();
    const m = v.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
    if (m) return `${m[3]}-${m[2]}-${m[1]}`;
    return /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : '';
};
const tag = (map, s) => { const [t, c] = map[s] || [s, '']; return `<span class="buh-tag ${c}">${escapeHtml(t)}</span>`; };
const contractOf = id => ctx.contracts.find(c => c.id === id);
let attaching = null;     // документ, який привʼязують до основного
let stornoing = null;     // документ, який сторнують
/** Основні документи постачальника, до яких можна привʼязати doc. */
const mainsFor = doc => mainsOf(doc, ctx.expenses);
const docName = x => `${ctx.docTypes[x.docType] || 'Документ'} № ${x.number} від ${human(x.date)}`;
const docsWord = n => (n % 10 === 1 && n % 100 !== 11 ? 'документ' : [2, 3, 4].includes(n % 10) && ![12, 13, 14].includes(n % 100) ? 'документи' : 'документів');
const val = id => document.getElementById(id)?.value?.trim() ?? '';
const filesHtml = list => (list || []).map(f => `<a class="buh-file" href="${escapeHtml(f.url)}" target="_blank" rel="noopener">${escapeHtml(f.name)}</a>`).join(' ');
const allExistingAssetIds = () => ctx?.existingAssetIds || (ctx?.expenses || []).map(x => x.assetId).filter(Boolean);

/** Відкрити розділ на потрібній вкладці, за потреби — з готовою формою чи документом. */
export function openExpenses(seg = 'docs', prefill = null, docId = null, focusOpts = null) {
    segment = TABS[LEGACY[seg] || seg] ? LEGACY[seg] || seg : 'work';
    if (docId) { selected = docId; wanted = docId; }
    activeFocus = focusOpts || null;
    shouldScrollFocus = Boolean(focusOpts || docId);
    form = prefill;
    files = [];
    if (location.hash !== '#expenses') location.hash = 'expenses';
    else loadExpensesView();
}

/** Чернетка акта за щомісячним договором — для нагадування «бракує акта». */
export function draftFromContract(c, period) {
    return { kind: 'doc', data: { supplierId: c.supplierId, contractId: c.id, docType: 'act', amountKop: c.monthlyKop, period,
        item: c.item, description: `${c.subject} за ${periodName(period)}` } };
}

// ------------------------------------------------------------
// ФОРМИ
// ------------------------------------------------------------
const options = (map, selected) => Object.entries(map).map(([k, v]) => `<option value="${escapeHtml(k)}"${k === selected ? ' selected' : ''}>${escapeHtml(v)}</option>`).join('');
const money2 = k => (k ? (k / 100).toFixed(2).replace('.', ',') : '');


function dataUrlToFile(dataUrl, filename) {
    const arr = dataUrl.split(",");
    const mime = arr[0].match(/:(.*?);/)?.[1] || "application/octet-stream";
    const bstr = atob(arr[1]);
    let n = bstr.length;
    const u8arr = new Uint8Array(n);
    while (n--) u8arr[n] = bstr.charCodeAt(n);
    return new File([u8arr], filename, { type: mime });
}

const RECOG_ACCEPT = ".pdf,image/*,.xml,.zip,.p7s,.p7m,.json,.txt";
const RECOG_MAX = 7 * 1024 * 1024;

function docRecogHtml(kind = "doc") {
    const isDoc = kind === "doc";
    const title = isDoc ? "Розумне розпізнавання: скан, PDF або M.E.Doc / Вчасно (XML, ZIP)" : "Розпізнавання договору підряду / послуг";
    const sub = isDoc ? "Оберіть скан, PDF або електронний документ M.E.Doc/Вчасно (XML чи ZIP) — система автоматично витягне реквізити та прикріпить підписаний PDF"
                      : "Оберіть скан договору або файл M.E.Doc/Вчасно — система заповнить реквізити, предмет, суму та строки дії";
    const btnAct = isDoc ? "trigger-recog" : "trigger-contract-recog";
    const inputId = isDoc ? "exRecogInput" : "cfRecogInput";
    const barId = isDoc ? "exRecogBar" : "cfRecogBar";
    const statusId = isDoc ? "exRecogStatus" : "cfRecogStatus";
    const hasKey = Boolean(ctx?.settings?.aiKey?.set);
    const keyTail = ctx?.settings?.aiKey?.tail || "";

    return `<div class="doc-recog-bar pay-wide" id="${barId}">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap">
            <div style="display:flex;align-items:center;gap:10px">
                <span style="font-size:22px">${isDoc ? "📄" : "📑"}</span>
                <div>
                    <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
                        <b style="font-size:14px">${title}</b>
                        <span class="buh-tag is-payment" style="font-size:11px;padding:2px 7px">⚡ M.E.Doc & Вчасно (XML/ZIP)</span>
                        ${hasKey
                            ? `<span class="buh-tag is-payment" style="font-size:11px;padding:2px 7px">⚡ AI Vision (…${escapeHtml(keyTail)})</span>`
                            : `<button type="button" class="btn-ghost-small" data-act="prompt-ai-key" style="color:var(--sv-amber);background:var(--sv-yellow-soft);border:1px solid transparent;border-radius:6px;padding:2px 8px;font-size:11.5px;font-weight:700;cursor:pointer">⚙️ Вказати ключ Gemini AI</button>`}
                    </div>
                    <p class="buh-note" style="margin:2px 0 0">${sub}</p>
                </div>
            </div>
            <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
                <button type="button" class="sv-btn is-soft btn-compact" data-act="${btnAct}" style="white-space:nowrap">📎 Обрати файл для розпізнавання</button>
                <button type="button" class="btn-ghost-small" data-act="prompt-ai-key" title="Перевірити або змінити AI-ключ" style="color:var(--sv-muted);font-size:12px;padding:4px 8px">⚙️ AI-ключ</button>
                <input type="file" id="${inputId}" accept="${RECOG_ACCEPT}" style="display:none">
            </div>
        </div>
        <div id="${statusId}" class="buh-note" style="margin-top:8px" hidden></div>
    </div>`;
}

async function fileToDataUrl(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(file);
    });
}

/** Оптимізація та масштабування фото документів для швидкого передавання в Gemini API без помилок памʼяті */
async function prepareDocumentImageForAi(file) {
    if (file.type === "application/pdf") {
        const base64 = await fileToDataUrl(file);
        return { base64Data: base64, mimeType: "application/pdf" };
    }
    return new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = () => {
            const img = new Image();
            img.onload = () => {
                let { width, height } = img;
                const maxDim = 1600;
                if (width > maxDim || height > maxDim) {
                    if (width > height) {
                        height = Math.round((height * maxDim) / width);
                        width = maxDim;
                    } else {
                        width = Math.round((width * maxDim) / height);
                        height = maxDim;
                    }
                }
                const canvas = document.createElement("canvas");
                canvas.width = width;
                canvas.height = height;
                const ctx2d = canvas.getContext("2d");
                ctx2d.drawImage(img, 0, 0, width, height);
                const dataUrl = canvas.toDataURL("image/jpeg", 0.85);
                resolve({ base64Data: dataUrl, mimeType: "image/jpeg" });
            };
            img.onerror = () => {
                resolve({ base64Data: reader.result, mimeType: file.type || "image/jpeg" });
            };
            img.src = reader.result;
        };
        reader.onerror = () => {
            resolve({ base64Data: "", mimeType: "image/jpeg" });
        };
        reader.readAsDataURL(file);
    });
}

function flashField(id) {
    const el = document.getElementById(id);
    if (!el) return;
    el.classList.remove("doc-field-highlight");
    void el.offsetWidth;
    el.classList.add("doc-field-highlight");
}

function renderSuggestedSupplierCard(s, contractName = "") {
    let container = document.getElementById("dfSuggestedSupplier");
    if (!container) {
        container = document.createElement("div");
        container.id = "dfSuggestedSupplier";
        const formEl = document.getElementById("exForm");
        const gridEl = formEl?.querySelector(".pay-grid");
        if (gridEl) gridEl.insertAdjacentElement("beforebegin", container);
    }
    const supName = s?.name || "Новий контрагент";
    const code = s?.code || "—";
    const iban = s?.iban || "—";
    container.innerHTML = `
        <div class="doc-supplier-prompt">
            <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap">
                <div style="flex:1 1 260px">
                    <span class="buh-tag is-review" style="font-size:11.5px;padding:2px 8px;margin-bottom:4px;display:inline-block">⚡ Контрагент з документа відсутній у довіднику</span>
                    <div style="font-size:15.5px;font-weight:700;color:#000;margin:2px 0">${escapeHtml(supName)}</div>
                    <div style="font-size:13px;color:var(--sv-muted)">
                        ЄДРПОУ / РНОКПП: <b>${escapeHtml(code)}</b> · IBAN: <b>${escapeHtml(iban)}</b>
                        ${contractName ? ` · Договір: <i>«${escapeHtml(contractName)}»</i>` : ""}
                    </div>
                </div>
                <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
                    <button type="button" class="btn-primary btn-compact" data-act="quick-add-supplier" style="white-space:nowrap;font-weight:600">
                        ⚡ Додати в довідник в 1 клік
                    </button>
                    <button type="button" class="btn-soft btn-compact" data-act="open-edit-supplier" style="white-space:nowrap">
                        Перевірити в ЄДР і додати…
                    </button>
                    <button type="button" class="btn-ghost-small" data-act="dismiss-suggested-supplier" style="color:var(--sv-muted)">
                        ✕ Разово без внесення
                    </button>
                </div>
            </div>
        </div>`;
}

function suggestedSupplierHtml(s, contractName = "") {
    if (!s || (!s.name && !s.code && !s.iban)) return "";
    return `
        <div class="doc-supplier-prompt" id="dfSuggestedSupplier">
            <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap">
                <div style="flex:1 1 260px">
                    <span class="buh-tag is-review" style="font-size:11.5px;padding:2px 8px;margin-bottom:4px;display:inline-block">⚡ Контрагент з документа відсутній у довіднику</span>
                    <div style="font-size:15.5px;font-weight:700;color:#000;margin:2px 0">${escapeHtml(s.name || "Новий контрагент")}</div>
                    <div style="font-size:13px;color:var(--sv-muted)">
                        ЄДРПОУ / РНОКПП: <b>${escapeHtml(s.code || "—")}</b> · IBAN: <b>${escapeHtml(s.iban || "—")}</b>
                        ${contractName ? ` · Договір: <i>«${escapeHtml(contractName)}»</i>` : ""}
                    </div>
                </div>
                <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
                    <button type="button" class="btn-primary btn-compact" data-act="quick-add-supplier" style="white-space:nowrap;font-weight:600">
                        ⚡ Додати в довідник в 1 клік
                    </button>
                    <button type="button" class="btn-soft btn-compact" data-act="open-edit-supplier" style="white-space:nowrap">
                        Перевірити в ЄДР і додати…
                    </button>
                    <button type="button" class="btn-ghost-small" data-act="dismiss-suggested-supplier" style="color:var(--sv-muted)">
                        ✕ Разово без внесення
                    </button>
                </div>
            </div>
        </div>`;
}

async function recognizeUploadedDocument(file, kind = "doc") {
    if (!file) return;
    const isDoc = kind === "doc";
    const bar = document.getElementById(isDoc ? "exRecogBar" : "cfRecogBar");
    const status = document.getElementById(isDoc ? "exRecogStatus" : "cfRecogStatus");
    const say = html => { if (status) { status.hidden = false; status.innerHTML = html; } };
    const name = file.name.toLowerCase();
    const isImage = file.type.startsWith("image/") || /\.(jpe?g|png|webp|heic|heif)$/.test(name);
    // Word/Excel не розпізнаються — файл просто лишається прикріпленим.
    if (!isImage && !/\.(pdf|xml|zip|p7s|p7m|json|txt)$/.test(name) && !/pdf|xml|zip|json|pkcs7/.test(file.type)) {
        say(`<span class="buh-note">Файл прикріплено. Реквізити з ${escapeHtml(file.name.split(".").pop().toUpperCase())} не читаються — заповніть поля або додайте PDF, фото чи файл M.E.Doc / Вчасно.</span>`);
        return;
    }
    if (!isImage && file.size > RECOG_MAX) {
        say(`<span class="buh-note">Файл понад 7 МБ — прикріплено без розпізнавання. Заповніть поля вручну.</span>`);
        return;
    }
    if (bar) bar.classList.add("is-scanning");
    say("<span>⏳ Аналізую документ (M.E.Doc / Вчасно / AI)…</span>");

    try {
        // Усе розпізнається на сервері: там ключ AI, свої реквізити ОСББ
        // і правильне кодування XML (windows-1251 у M.E.Doc).
        let payload;
        if (/\.txt$/.test(name)) payload = { textContent: await file.text() };
        else if (isImage) payload = await prepareDocumentImageForAi(file);
        else payload = { base64Data: await fileToDataUrl(file), mimeType: file.type || "" };
        if (!payload.textContent && !payload.base64Data) throw new Error("файл не прочитався");
        if ((payload.base64Data || "").length > RECOG_MAX * 4 / 3 + 100) {
            say(`<span class="buh-note">Файл понад 7 МБ — прикріплено без розпізнавання. Заповніть поля вручну.</span>`);
            if (!files.some(f => f.name === file.name && f.size === file.size)) files = [...files, file];
            return;
        }
        const res = await expAct({ action: "recognizeDocument", fileName: file.name, ...payload }, 120000);
        const notes = res?.notes || [];
        const r0 = res?.recognized;

        if (!r0 || (!r0.amountKop && !r0.number && !r0.supplier?.name && !r0.supplier?.code)) {
            const needKey = notes.some(n => n.includes("ключ Gemini"));
            say(`<span class="buh-note is-bad">${escapeHtml(notes[0] || "Не вдалося знайти реквізити в цьому документі.")} Заповніть поля вручну.${needKey
                ? ` <button type="button" class="btn-ghost-small" data-act="prompt-ai-key" style="text-decoration:underline;color:#000;font-weight:700;display:inline;padding:0;background:none;border:none;cursor:pointer">Вказати ключ ›</button>` : ""}</span>`);
            if (!files.some(f => f.name === file.name && f.size === file.size)) files = [...files, file];
            toast(needKey ? "Для сканів потрібен ключ Gemini AI" : "Реквізити не знайдено", needKey ? "info" : "error");
            return;
        }

        const r = res.recognized;
        if (isDoc) {
            if (r.docType && document.getElementById("dfType")) { document.getElementById("dfType").value = r.docType; flashField("dfType"); }
            if (r.number && document.getElementById("dfNumber")) { document.getElementById("dfNumber").value = r.number; flashField("dfNumber"); }
            if (r.date && document.getElementById("dfDate")) { document.getElementById("dfDate").value = r.date; flashField("dfDate"); }
            if (r.period && document.getElementById("dfPeriod")) { document.getElementById("dfPeriod").value = r.period; flashField("dfPeriod"); }
            if (r.amountKop && document.getElementById("dfAmount")) { document.getElementById("dfAmount").value = money2(r.amountKop); flashField("dfAmount"); }
            if (r.vatKop !== undefined && document.getElementById("dfVat")) { document.getElementById("dfVat").value = r.vatKop ? money2(r.vatKop) : ""; flashField("dfVat"); }
            if (r.item && document.getElementById("dfItem")) { document.getElementById("dfItem").value = r.item; flashField("dfItem"); }
            if ((r.description || r.contractName) && document.getElementById("dfDesc")) { document.getElementById("dfDesc").value = r.description || r.contractName; flashField("dfDesc"); }

            if (res.matchedSupplier && document.getElementById("dfSupplier")) {
                document.getElementById("dfSupplier").value = res.matchedSupplier.id;
                flashField("dfSupplier");
                if (res.matchedContract && document.getElementById("dfContract")) {
                    document.getElementById("dfContract").value = res.matchedContract.id;
                    flashField("dfContract");
                }
                document.getElementById("dfSuggestedSupplier")?.remove();
            } else if (r.supplier && (r.supplier.name || r.supplier.code || r.supplier.iban)) {
                if (!form) form = { kind: "doc", data: {} };
                form.data.suggestedSupplier = r.supplier;
                form.data.contractName = r.contractName || "";
                renderSuggestedSupplierCard(r.supplier, r.contractName);
            }

            if (r.postingAcc && r.postingAcc !== "92" && document.getElementById("dfPosting")) {
                document.getElementById("dfPosting").value = r.postingAcc;
                const details = document.getElementById("exForm")?.querySelector("details");
                if (details) details.open = true;
                const assetInput = document.getElementById("dfAsset");
                if (assetInput && !assetInput.value) {
                    assetInput.value = suggestAssetId(r.postingAcc, allExistingAssetIds());
                }
            }
        } else {
            if (r.number && document.getElementById("cfNumber")) { document.getElementById("cfNumber").value = r.number; flashField("cfNumber"); }
            if (r.date && document.getElementById("cfDate")) { document.getElementById("cfDate").value = r.date; flashField("cfDate"); }
            if (r.date && document.getElementById("cfFrom")) { document.getElementById("cfFrom").value = r.date; flashField("cfFrom"); }
            if (r.contractEnd && document.getElementById("cfTo")) { document.getElementById("cfTo").value = r.contractEnd; flashField("cfTo"); }
            if (r.amountKop && document.getElementById("cfAmount")) { document.getElementById("cfAmount").value = money2(r.amountKop); flashField("cfAmount"); }
            if (r.item && document.getElementById("cfItem")) { document.getElementById("cfItem").value = r.item; flashField("cfItem"); }
            if ((r.description || r.contractName) && document.getElementById("cfSubject")) { document.getElementById("cfSubject").value = r.description || r.contractName; flashField("cfSubject"); }
            if (res.matchedSupplier && document.getElementById("cfSupplier")) {
                document.getElementById("cfSupplier").value = res.matchedSupplier.id;
                flashField("cfSupplier");
            }
        }

        // Обробка файлів: якщо з ZIP витягнуто реальний PDF чи підпис P7S, додаємо їх замість чистого ZIP
        if (res.extractedFiles?.length) {
            files = files.filter(f => f.name !== file.name);
            for (const ef of res.extractedFiles) {
                try {
                    const extractedFile = dataUrlToFile(ef.base64Data, ef.name);
                    if (!files.some(f => f.name === extractedFile.name && f.size === extractedFile.size)) {
                        files.push(extractedFile);
                    }
                } catch (_) {}
            }
        } else {
            if (!files.some(f => f.name === file.name && f.size === file.size)) {
                files = [...files, file];
            }
        }

        form = snapshotForm();

        if (bar) {
            bar.classList.remove("is-scanning");
            bar.classList.add("is-recognized");
        }
        if (status) {
            status.hidden = false;
            let srcBadge = "✓ Успішно розпізнано";
            if (res.source === "medoc") srcBadge = "✓ Імпортовано з M.E.Doc (XML)";
            else if (res.source === "vchasno_ubl" || res.source === "vchasno_json") srcBadge = "✓ Імпортовано з Вчасно (ЕДО)";
            else if (res.source === "commerceml") srcBadge = "✓ Імпортовано з 1С / CommerceML";
            else if (res.source === "ai") srcBadge = "✓ Розпізнано AI — звірте з документом";
            if (res.extractedFiles?.some(f => f.mimeType === "application/pdf")) srcBadge += " (витягнуто PDF)";

            const supTitle = res.matchedSupplier ? `Постачальник: ${res.matchedSupplier.name}` : (r.supplier?.name ? `⚡ Новий контрагент: ${r.supplier.name} (${r.supplier.code || "код —"})` : "");
            const numDate = [r.number ? `№ ${r.number}` : "", r.date ? `від ${human(r.date)}` : ""].filter(Boolean).join(" ");
            const sumStr = r.amountKop ? `Сума: ${fmtKop(r.amountKop)} грн` : "";
            const checks = [...(res.warnings || []), ...(res.notes || [])];
            status.innerHTML = `<span class="doc-recog-badge">${srcBadge}</span> <span style="font-size:13px;color:#000;">${escapeHtml([supTitle, numDate, sumStr].filter(Boolean).join(" · "))}</span>${checks.length
                ? `<span class="buh-note is-bad" style="display:block;margin-top:4px">⚠️ Перевірте: ${escapeHtml(checks.join("; "))}</span>` : ""}`;
        }
        toast(res.source === "medoc" ? "Документ M.E.Doc успішно завантажено" : res.source?.includes("vchasno") ? "Документ Вчасно успішно завантажено" : "Реквізити документа заповнено автоматично", "success");
    } catch (err) {
        console.warn("Помилка розпізнавання:", err);
        if (status) {
            status.hidden = false;
            status.innerHTML = `<span class="buh-note is-bad">Помилка аналізу файлу: ${escapeHtml(err.message || "невідома помилка")}.</span>`;
        }
    } finally {
        if (bar) bar.classList.remove("is-scanning");
    }
}
function docFormHtml(d = {}) {
    const supplierId = d.supplierId || "";
    const contracts = ctx.contracts.filter(c => c.supplierId === supplierId && c.status !== "rejected");
    const postingAcc = d.postingAcc || "92";
    const prefilledAssetId = postingAcc !== "92" ? (d.assetId || suggestAssetId(postingAcc, allExistingAssetIds())) : (d.assetId || "");
    const catalog = ctx.assetCatalog || [];
    return `<section class="buh-card ex-form" id="exForm">
        <div class="buh-card-head"><h2>${d.id ? "Змінити документ" : "Новий документ"}</h2><button type="button" class="btn-ghost-small" data-act="close">Закрити</button></div>
        ${docRecogHtml("doc")}
        ${suggestedSupplierHtml(d.suggestedSupplier, d.contractName)}
        <div class="pay-grid">
            <label class="field pay-wide"><span class="field-label">Постачальник</span>
                <select id="dfSupplier" class="field-input field-select"><option value="">Оберіть…</option>${ctx.suppliers.map(s =>
                    `<option value="${escapeHtml(s.id)}"${s.id === supplierId ? " selected" : ""}>${escapeHtml(s.name)} · ${escapeHtml(s.code)}</option>`).join("")}<option value="__new">+ Новий постачальник…</option></select></label>
            <label class="field pay-wide"><span class="field-label">Договір</span>
                <select id="dfContract" class="field-input field-select"><option value="">Без договору</option>${contracts.map(c =>
                    `<option value="${escapeHtml(c.id)}"${c.id === d.contractId ? " selected" : ""}>№ ${escapeHtml(c.number)} від ${human(c.date)} — ${escapeHtml(c.subject)}${c.status === "pending" ? " (не затверджено)" : ""}</option>`).join("")}</select>
                ${supplierId && !contracts.length ? `<p class="buh-note" id="dfContractHelp" style="margin:4px 0 0">У постачальника ще немає договорів. Можна провести <b>разово без договору</b> (затверджує голова) або <button type="button" class="btn-ghost-small" data-act="quick-add-contract" style="display:inline;padding:0;text-decoration:underline;color:#000;background:none;border:none;cursor:pointer">+ додати договір</button>.</p>` : ""}
            </label>
            <label class="field"><span class="field-label">Вид документа</span><select id="dfType" class="field-input field-select">${options(ctx.docTypes, d.docType || 'invoice')}</select></label>
            <label class="field"><span class="field-label">Номер</span><input id="dfNumber" class="field-input" maxlength="60" value="${escapeHtml(d.number || '')}"></label>
            <label class="field"><span class="field-label">Дата</span><input id="dfDate" class="field-input" type="date" value="${escapeHtml(isoDate(d.date) || ctx.today)}"></label>
            <label class="field"><span class="field-label">За місяць</span><input id="dfPeriod" class="field-input" type="month" value="${escapeHtml(d.period || ctx.today.slice(0, 7))}"></label>
            <label class="field"><span class="field-label">Сума, грн</span><input id="dfAmount" class="field-input" inputmode="decimal" placeholder="0,00" value="${money2(d.amountKop)}"></label>
            <label class="field"><span class="field-label">У т.ч. ПДВ, грн</span><input id="dfVat" class="field-input" inputmode="decimal" placeholder="без ПДВ" value="${money2(d.vatKop)}"></label>
            <label class="field pay-wide"><span class="field-label">Стаття витрат</span><select id="dfItem" class="field-input field-select">${options(ctx.items, d.item || 'other')}</select></label>
            <label class="field pay-wide"><span class="field-label">Джерело фінансування</span><select id="dfFund" class="field-input field-select">${options({...Object.fromEntries((ctx.funds || [{id:'main',name:'Основний фонд'}]).map(f=>[f.id,f.name])),...(ctx.ownIncome?{own:'Власний дохід (без використання 48)'}:{})},d.fundId || ctx.defaultFund || 'main')}</select></label>
            <details class="pay-wide"${postingAcc !== '92' ? ' open' : ''}><summary>Придбання активу ОСББ (ОЗ, МНМА) або ТМЦ (Запаси, МШП)</summary>
                <p class="buh-note">Послуги й ремонт спільного майна будинку — це поточні витрати (рахунок 92). Тут виділяють майно, яке переходить у власність ОСББ як юрособи: понад ${((ctx.mnhmaLimitKop || 2000000) / 100).toLocaleString('uk-UA')} грн і > 1 року — Основні засоби (10); до ${((ctx.mnhmaLimitKop || 2000000) / 100).toLocaleString('uk-UA')} грн і > 1 року — МНМА (11); паливо, будматеріали, запчастини — Запаси (20); інвентар та інструмент до 1 року — МШП (22). Інвентарний / номенклатурний номер підставляється автоматично.</p>
                <div class="pay-grid" style="margin-top:8px">
                    <label class="field"><span class="field-label">Рахунок обліку</span><select id="dfPosting" class="field-input field-select">${options({'92':'92 · Поточні витрати / послуги','10':'10 · Основний засіб ОСББ (ОЗ)','11':'11 · Малоцінний необоротний актив (МНМА)','20':'20 · Виробничі запаси (паливо, матеріали)','22':'22 · Малоцінні та швидкозношувані предмети (МШП)'},postingAcc)}</select></label>
                    <label class="field"><span class="field-label">Інвентарний / номенкл. код (авто)</span><input id="dfAsset" list="dfAssetList" class="field-input" maxlength="80" placeholder="Підставляється автоматично (ОЗ-001, ТМЦ-001…)" value="${escapeHtml(prefilledAssetId)}"></label>
                    <label class="field"><span class="field-label">Кількість (для ТМЦ / МШП)</span><input id="dfAssetQty" class="field-input" type="number" step="0.001" min="0.001" value="${escapeHtml(String(d.assetQty || 1))}"></label>
                    <label class="field"><span class="field-label">Одиниця виміру</span><select id="dfAssetUnit" class="field-input field-select">${UNITS.map(u => `<option value="${escapeHtml(u)}"${u === (d.assetUnit || 'шт.') ? ' selected' : ''}>${escapeHtml(u)}</option>`).join('')}</select></label>
                    <label class="field"><span class="field-label">МВО (хто прийняв майно)</span><input id="dfCustodian" class="field-input" maxlength="160" placeholder="Голова правління / комендант / електрик" value="${escapeHtml(d.custodian || '')}"></label>
                    <label class="field"><span class="field-label">Місце зберігання / встановлення</span><input id="dfLocation" class="field-input" maxlength="200" placeholder="Техприміщення / комора / електрощитова" value="${escapeHtml(d.location || '')}"></label>
                    <label class="am-check pay-wide"><input id="dfOwned" type="checkbox"${d.ownedByOsbb || postingAcc !== '92' ? ' checked' : ''}><span>Підтверджую: майно належить саме ОСББ як юридичній особі (не є невідʼємною частиною спільного майна будинку)</span></label>
                    <label class="am-check pay-wide"><input id="dfCommissionNow" type="checkbox"${d.commissionedDate ? ' checked' : ''}><span>Для ОЗ (10) та МНМА (11): одразу ввести в експлуатацію датою документа (Акт ОЗ-1)</span></label>
                </div>
                <datalist id="dfAssetList">${catalog.map(a => `<option value="${escapeHtml(a.id)}">${escapeHtml(a.name)}${a.legacyId ? ` (стар. № ${escapeHtml(a.legacyId)})` : ''}</option>`).join('')}</datalist>
            </details>
            <label class="field pay-wide"><span class="field-label">За що</span><input id="dfDesc" class="field-input" maxlength="300" placeholder="Послуга чи товар, період" value="${escapeHtml(d.description || '')}"></label>
            ${!d.id && supplierId ? `<label class="field pay-wide"><span class="field-label">Підтверджує документ тієї самої послуги</span>
                <select id="dfLinked" class="field-input field-select"><option value="">Ні — це окрема витрата</option>${mainsFor({ supplierId, amountKop: 0 }).map(x =>
                    `<option value="${escapeHtml(x.id)}"${x.id === d.linkedTo ? ' selected' : ''}>${escapeHtml(docName(x))} · ${fmtKop(x.amountKop)} грн</option>`).join('')}</select></label>` : ''}
            <label class="field pay-wide"><span class="field-label">Скан або PDF документа</span><input id="dfFiles" class="field-input" type="file" multiple accept=".pdf,image/*,.doc,.docx,.xls,.xlsx,.xml,.zip,.p7s"></label>
        </div>
        ${d.files?.length ? `<p class="buh-note">Уже додано: ${filesHtml(d.files)}</p>` : ''}
        ${files.length ? `<p class="buh-note">Буде додано: ${files.map(f => escapeHtml(f.name)).join(', ')}</p>` : ''}
        <p class="buh-note" id="dfHint">Документ за затвердженим договором у межах його суми затверджуєте ви. Без договору чи понад нього — голова: йому прийде сповіщення.</p>
        <div class="pay-form-actions"><button type="button" class="btn-primary" data-act="save-doc">${d.id ? 'Зберегти' : 'Внести документ'}</button></div>
    </section>`;
}

function getSupplierContracts(sup, fallbackName = '', extraContract = null) {
    const out = [];
    const seenIds = new Set();
    const supId = sup?.id || '';
    const targetName = sup?.name || fallbackName;

    for (const c of ctx?.contracts || []) {
        const matchById = supId && c.supplierId === supId;
        // За назвою — лише договори без картки постачальника: договір іншої картки не «приклеюється» за схожою назвою.
        const matchByName = !matchById && (!c.supplierId || !supId) && sameEntity(c.supplierName, targetName);
        if (matchById || matchByName) {
            seenIds.add(c.id);
            out.push({ ...c, inDatabase: true });
        }
    }

    if (extraContract && (extraContract.id || extraContract.subject || extraContract.number)) {
        if (!extraContract.id || !seenIds.has(extraContract.id)) {
            out.push({
                id: extraContract.id || '',
                number: extraContract.number || 'б/н',
                date: extraContract.date || '',
                subject: extraContract.subject || 'Договір з контрагентом',
                supplierId: supId || extraContract.supplierId || '',
                supplierName: sup?.name || fallbackName || extraContract.supplierName || '',
                amountKop: extraContract.amountKop || 0,
                monthlyKop: extraContract.monthlyKop || extraContract.amountKop || 0,
                type: extraContract.type || 'monthly',
                inDatabase: Boolean(extraContract.id && seenIds.has(extraContract.id))
            });
        }
    }
    return out;
}

function renderClickableContractsBlock(contractsList, { supplierId = '', supplierName = '', code = '' } = {}) {
    if (!contractsList || !contractsList.length) {
        return `<div class="sup-contracts-block">
            <div class="sup-contracts-head">
                <span class="sup-contracts-title">Договори з цим постачальником</span>
                <button type="button" class="btn-ghost-small" data-act="new-contract-for-supplier" data-supplier-id="${escapeHtml(supplierId)}" data-supplier-name="${escapeHtml(supplierName)}">+ Додати договір</button>
            </div>
            <div class="sup-contracts-empty">Окремих договорів у реєстрі ще не зареєстровано.</div>
        </div>`;
    }
    return `<div class="sup-contracts-block">
        <div class="sup-contracts-head">
            <span class="sup-contracts-title">Договори з цим постачальником (натисніть для переходу в картку договору)</span>
            <button type="button" class="btn-ghost-small" data-act="new-contract-for-supplier" data-supplier-id="${escapeHtml(supplierId)}" data-supplier-name="${escapeHtml(supplierName)}">+ Новий договір</button>
        </div>
        <div class="sup-contracts-list">
            ${contractsList.map(c => `<button type="button" class="sup-contract-card" data-act="jump-to-contract"
                data-id="${escapeHtml(c.id || '')}"
                data-number="${escapeHtml(c.number || 'б/н')}"
                data-date="${escapeHtml(c.date || '')}"
                data-subject="${escapeHtml(c.subject || '')}"
                data-supplier-id="${escapeHtml(supplierId || c.supplierId || '')}"
                data-supplier-name="${escapeHtml(supplierName || c.supplierName || '')}"
                data-code="${escapeHtml(code || '')}"
                data-amount-kop="${escapeHtml(String(c.monthlyKop || c.amountKop || 0))}">
                <div class="sup-cc-main">
                    <div class="sup-cc-top">
                        <b>Договір № ${escapeHtml(c.number || 'б/н')}${c.date ? ` від ${escapeHtml(human(c.date))}` : ''}</b>
                        ${c.status ? tag(CONTRACT_STATUS, c.status) : '<span class="buh-tag is-review">За випискою банку</span>'}
                    </div>
                    <span class="sup-cc-subj">${escapeHtml(c.subject || 'Договір з контрагентом')}</span>
                    ${c.validFrom ? `<small class="sup-cc-dates">Строк дії: ${escapeHtml(human(c.validFrom))} — ${c.validTo ? escapeHtml(human(c.validTo)) : 'безстроково'}</small>` : ''}
                </div>
                <div class="sup-cc-right">
                    ${(c.monthlyKop || c.amountKop) ? `<b class="sup-cc-sum">${fmtKop(c.monthlyKop || c.amountKop)} грн${c.type === 'monthly' ? '/міс.' : ''}</b>` : ''}
                    <span class="sup-cc-go">Картка договору ›</span>
                </div>
            </button>`).join('')}
        </div>
    </div>`;
}

function contractFormHtml(c = {}) {
    const monthly = (c.type || 'monthly') === 'monthly';
    return `<section class="buh-card ex-form" id="exForm">
        <div class="buh-card-head"><h2>${c.id ? 'Змінити договір' : 'Новий договір'}</h2><button type="button" class="btn-ghost-small" data-act="close">Закрити</button></div>
        ${docRecogHtml('contract')}
        <div class="ex-form-grid">
            <label class="field ex-full"><span class="field-label">Постачальник</span>
                <select id="cfSupplier" class="field-input field-select"><option value="">Оберіть…</option>${ctx.suppliers.map(s =>
                    `<option value="${escapeHtml(s.id)}"${s.id === c.supplierId ? ' selected' : ''}>${escapeHtml(s.name)} · ${escapeHtml(s.code)}</option>`).join('')}<option value="__new">+ Новий постачальник…</option></select></label>
            <label class="field"><span class="field-label">Номер договору</span><input id="cfNumber" class="field-input" maxlength="60" value="${escapeHtml(c.number || '')}"></label>
            <label class="field"><span class="field-label">Дата укладення</span><input id="cfDate" class="field-input" type="date" value="${escapeHtml(isoDate(c.date) || ctx.today)}"></label>
            <label class="field ex-full"><span class="field-label">Предмет договору</span><input id="cfSubject" class="field-input" maxlength="300" value="${escapeHtml(c.subject || '')}" placeholder="Технічне обслуговування ліфтів"></label>
            <label class="field"><span class="field-label">Вид договору</span><select id="cfType" class="field-input field-select">${options({ monthly: 'Щомісячний', fixed: 'Разовий' }, c.type || 'monthly')}</select></label>
            <label class="field"><span class="field-label" id="cfAmountLabel">${monthly ? 'Сума на місяць, грн' : 'Сума договору, грн'}</span><input id="cfAmount" class="field-input" inputmode="decimal" value="${money2(monthly ? c.monthlyKop : c.amountKop)}"></label>
            <label class="field"><span class="field-label">Діє з</span><input id="cfFrom" class="field-input" type="date" value="${escapeHtml(isoDate(c.validFrom) || isoDate(c.date) || ctx.today)}"></label>
            <label class="field"><span class="field-label">Діє по (порожньо — безстроковий)</span><input id="cfTo" class="field-input" type="date" value="${escapeHtml(isoDate(c.validTo))}"></label>
            <label class="field ex-full"><span class="field-label">Стаття витрат</span><select id="cfItem" class="field-input field-select">${options(ctx.items, c.item || 'other')}</select></label>
            <label class="field"><span class="field-label">Погодження правління (протокол, дата)</span><input id="cfBoard" class="field-input" maxlength="200" value="${escapeHtml(c.boardDecision || '')}"></label>
            <label class="field"><span class="field-label">Рішення загальних зборів (понад 50 000 грн)</span><input id="cfMeeting" class="field-input" maxlength="200" value="${escapeHtml(c.meetingDecision || '')}"></label>
            <label class="field ex-full"><span class="field-label">Скан договору</span><input id="cfFiles" class="field-input" type="file" multiple accept=".pdf,image/*,.doc,.docx,.xml,.zip,.p7s"></label>
        </div>
        <p class="buh-note" id="cfHint"></p>
        <div class="pay-form-actions"><button type="button" class="btn-primary" data-act="save-contract">${isChair() ? 'Зберегти й затвердити' : 'Подати голові на затвердження'}</button></div>
    </section>`;
}

function supplierFormHtml(s = {}) {
    const ycSet = Boolean(ctx?.settings?.youscoreKeySet);
    const ycSandbox = Boolean(ctx?.settings?.youscoreSandbox);
    return `<section class="buh-card ex-form" id="exForm">
        <div class="buh-card-head">
            <div>
                <h2>${s.id ? "Змінити постачальника" : "Новий постачальник"}</h2>
                <small class="t-muted">Автоматичне заповнення картки з ЄДРПОУ, реєстрів ДПС, судового реєстру та АСВП через YouScore (YouControl)</small>
            </div>
            <button type="button" class="btn-ghost-small" data-act="close">Закрити</button>
        </div>
        <div class="pay-grid">
            <label class="field"><span class="field-label">ЄДРПОУ (8 цифр) або РНОКПП (10 цифр)</span>
                <div style="display:flex;gap:8px;align-items:center">
                    <input id="sfCode" class="field-input" inputmode="numeric" maxlength="10" value="${escapeHtml(s.code || "")}" placeholder="8 або 10 цифр">
                    <button type="button" class="sv-btn is-soft btn-compact" data-act="check-supplier" style="white-space:nowrap" title="Підтягнути повні дані з ЄДРПОУ, ПДВ, Єдиного податку, судів та виконавчих проваджень через YouScore API">🔍 Заповнити з ЄДР (YouControl)</button>
                </div>
            </label>
            <label class="field"><span class="field-label">Тип контрагента</span><select id="sfKind" class="field-input field-select">${options(ctx.kinds, s.kind || "company")}</select></label>
            <div id="sfEdrStatus" class="buh-note pay-wide"${s.edrStatusHtml ? "" : " hidden"}>${s.edrStatusHtml || ""}</div>
            <label class="field"><span class="field-label">Скорочена робоча назва</span><input id="sfName" class="field-input" maxlength="200" value="${escapeHtml(s.name || "")}" placeholder="ТОВ «Ліфт-Сервіс» або ФОП Іваненко І. І."></label>
            <label class="field"><span class="field-label">Організаційно-правова форма</span><input id="sfLegalForm" class="field-input" maxlength="160" value="${escapeHtml(s.legalForm || "")}" placeholder="ТОВАРИСТВО З ОБМЕЖЕНОЮ ВІДПОВІДАЛЬНІСТЮ"></label>
            <label class="field pay-wide"><span class="field-label">Повне офіційне найменування (з ЄДР)</span><input id="sfFullName" class="field-input" maxlength="300" value="${escapeHtml(s.fullName || "")}" placeholder="Підтягується автоматично з ЄДРПОУ"></label>
            <label class="field"><span class="field-label">Керівник / підписант</span><input id="sfDirector" class="field-input" maxlength="200" value="${escapeHtml(s.director || "")}" placeholder="ПІБ керівника з ЄДР"></label>
            <label class="field"><span class="field-label">Статус державної реєстрації</span><input id="sfRegStatus" class="field-input" maxlength="160" value="${escapeHtml(s.registrationStatus || "")}" placeholder="Не перебуває в процесі припинення"></label>
            <label class="field pay-wide"><span class="field-label">Юридична адреса (місцезнаходження)</span><input id="sfAddress" class="field-input" maxlength="300" value="${escapeHtml(s.address || "")}" placeholder="Україна, індекс, місто, вулиця, будинок"></label>
            <label class="field"><span class="field-label">Телефон (з ЄДР / контактний)</span><input id="sfPhone" class="field-input" maxlength="80" value="${escapeHtml(s.phone || "")}" placeholder="+380…"></label>
            <label class="field"><span class="field-label">Електронна пошта (Email)</span><input id="sfEmail" class="field-input" maxlength="120" value="${escapeHtml(s.email || "")}" placeholder="mail@company.ua"></label>
            <label class="field"><span class="field-label">Система оподаткування (ДПС)</span><input id="sfTaxSystem" class="field-input" maxlength="160" value="${escapeHtml(s.taxSystem || "")}" placeholder="Платник ПДВ / Єдиний податок 3 група (5%)"></label>
            <label class="field"><span class="field-label">ІПН платника ПДВ (якщо є)</span><input id="sfVatCode" class="field-input" maxlength="20" value="${escapeHtml(s.vatCode || "")}" placeholder="12-значний ІПН ПДВ"></label>
            <label class="field pay-wide"><span class="field-label">Основний вид діяльності (КВЕД)</span><input id="sfMainKved" class="field-input" maxlength="240" value="${escapeHtml(s.mainKved || "")}" placeholder="43.21 Електромонтажні роботи"></label>
            <label class="field pay-wide"><span class="field-label">IBAN для безготівкової оплати</span><input id="sfIban" class="field-input" maxlength="34" value="${escapeHtml(s.iban || "")}" placeholder="UA…"></label>
            <label class="am-check pay-wide" id="sfFopRow"${(s.kind || "company") === "fop" ? "" : " hidden"}><input type="checkbox" id="sfFop"${s.fopChecked ? " checked" : ""}><span>Витяг з ЄДР і КВЕД перевірено: послуга відповідає видам діяльності ФОП (п. 177.8 ПКУ)</span></label>
            <label class="field pay-wide"><span class="field-label">Примітка (перелік КВЕД, контакти, комплаєнс)</span><input id="sfNote" class="field-input" maxlength="300" value="${escapeHtml(s.note || "")}"></label>
            <input type="hidden" id="sfTaxDebt" value="${escapeHtml(String(s.taxDebtTotal || 0))}">
            <input type="hidden" id="sfOpenPenalties" value="${escapeHtml(String(s.openPenalties || 0))}">
            <input type="hidden" id="sfExpressIndex" value="${escapeHtml(s.expressIndex || "")}">
        </div>
        <details class="pay-wide" style="margin-top:8px">
            <summary class="buh-note" style="cursor:pointer">⚙️ Налаштування API ключа YouScore (YouControl): ${ycSet ? (ycSandbox ? "тестовий Sandbox-режим (до отримання бойового ключа)" : "бойовий ключ підключено (" + escapeHtml(ctx?.settings?.youscoreKeyMasked || "") + ")") : "працює вбудований Sandbox-режим"}</summary>
            <div class="pay-grid" style="margin-top:8px">
                <label class="field pay-wide"><span class="field-label">API ключ YouScore (залиште порожнім або введіть YOUSCORE_TEST_KEY_USPIH25_SANDBOX для тестового режиму)</span>
                    <div style="display:flex;gap:8px;align-items:center">
                        <input id="ycApiKeyInput" class="field-input" maxlength="200" placeholder="Вставте ключ YouScore API, коли отримаєте від менеджера YouControl">
                        <button type="button" class="sv-btn is-soft btn-compact" data-act="save-youscore-key" style="white-space:nowrap">Зберегти ключ</button>
                    </div>
                </label>
            </div>
        </details>
        <div class="pay-form-actions"><button type="button" class="btn-primary" data-act="save-supplier">Зберегти картку постачальника</button></div>
    </section>`;
}

function formHtml() {
    if (!form) return '';
    return form.kind === 'doc' ? docFormHtml(form.data) : form.kind === 'contract' ? contractFormHtml(form.data) : supplierFormHtml(form.data);
}

// ------------------------------------------------------------
// СПИСКИ
// ------------------------------------------------------------
/** Дії з документом: головна — перша (чорна), решта — світлі. */
function docActions(e) {
    const out = [];
    const btn = (act, label, extra = '') => `<button type="button" class="sv-btn${out.length ? ' is-soft' : ''}" data-act="${act}"${extra}>${label}</button>`;
    if (e.status === 'pending' && isChair()) out.push(btn('approve-doc', 'Затвердити'), btn('reject-doc', 'Відхилити'));
    if (e.status === 'approved' && remaining(e) > 0 && !paying.has(e.id)) out.push(btn('pay-doc', e.paidKop > 0 ? 'Доплатити' : 'Створити платіж'));
    if (paying.has(e.id)) out.push('<button type="button" class="sv-btn" data-go="payments">Платіж на підписі голови</button>');
    if (e.postingAcc && e.postingAcc !== '92' && e.assetId) out.push(btn('open-asset', 'Картка в «Майно та ТМЦ» ›'));
    if (['pending', 'rejected'].includes(e.status)) out.push(btn('edit-doc', 'Змінити'));
    if (['pending', 'approved', 'rejected'].includes(e.status) && !(e.paidKop > 0) && !e.linkedIds?.length && !e.stornoIds?.length && mainsFor(e).length && !twinOf(e, ctx.expenses)) {
        out.push(btn('attach-doc', 'Це та сама послуга…', ' title="Рахунок і акт однієї послуги — одна витрата"'));
    }
    if (['approved', 'paid'].includes(e.status) && e.amountKop > 0 && e.amountKop > (e.stornoKop || 0)) out.push(btn('storno-doc', 'Сторно'));
    if (['pending', 'approved', 'rejected', 'linked'].includes(e.status) && !(e.paidKop > 0) && !e.stornoIds?.length && !paying.has(e.id)) out.push(btn('cancel-doc', 'Скасувати'));
    return out.join('');
}

/** Звʼязки документа: підтвердні документи, основний, сторно. */
function relationsHtml(e) {
    const byId = id => ctx.expenses.find(x => x.id === id);
    const parts = [];
    if (e.linkedTo) { const m = byId(e.linkedTo); parts.push(`Підтверджує ${m ? escapeHtml(docName(m)) : 'основний документ'} — окремої витрати й боргу немає`); }
    const linked = (e.linkedIds || []).map(byId).filter(x => x && x.status === 'linked');
    if (linked.length) parts.push(`Підтвердні документи: ${linked.map(x => escapeHtml(docName(x))).join(', ')}`);
    if (e.stornoOf) { const o = byId(e.stornoOf); parts.push(`Коригує ${o ? escapeHtml(docName(o)) : 'документ'}`); }
    if (e.stornoKop) parts.push(`Сторно −${fmtKop(e.stornoKop)} грн: до сплати ${fmtKop(e.amountKop - e.stornoKop)} грн`);
    if (e.refundTxIds?.length) parts.push('Банк повернув оплату — документ знову до сплати');
    return parts.map(p => `<p class="dc-hint">${LINK_ICON}<span>${p}</span></p>`).join('');
}

const LINK_ICON = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" aria-hidden="true"><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/></svg>';
const UP_ICON = '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" aria-hidden="true"><path d="M12 16V4M7 9l5-5 5 5M5 20h14"/></svg>';

function attachHtml(e) {
    const list = mainsFor(e);
    return `<div class="ex-inline" id="exAttach">
        <label class="field"><span class="field-label">Основний документ тієї самої послуги</span><select id="atMain" class="field-input field-select">${list.map(x =>
            `<option value="${escapeHtml(x.id)}">${escapeHtml(docName(x))} · ${fmtKop(x.amountKop)} грн · ${escapeHtml(chipOf(x)[0])}</option>`).join('')}</select></label>
        <p class="buh-note">${escapeHtml(docName(e))} стане підтвердним: витрата й борг лишаться лише за основним документом.</p>
        <div class="pay-form-actions"><button type="button" class="sv-btn" data-act="attach-save">Привʼязати</button><button type="button" class="sv-btn is-soft" data-act="inline-close">Скасувати</button></div>
    </div>`;
}

function stornoHtml(e) {
    const left = e.amountKop - (e.stornoKop || 0);
    return `<div class="ex-inline" id="exStorno">
        <div class="pay-grid">
            <label class="field"><span class="field-label">Сума сторно, грн (до ${fmtKop(left)})</span><input id="stAmount" class="field-input" inputmode="decimal" value="${money2(left)}"></label>
            <label class="field"><span class="field-label">Дата коригування</span><input id="stDate" class="field-input" type="date" value="${escapeHtml(ctx.today)}" max="${escapeHtml(ctx.today)}"></label>
            <label class="field"><span class="field-label">№ акта коригування / накладної на повернення</span><input id="stNumber" class="field-input" maxlength="60"></label>
            <label class="field pay-wide"><span class="field-label">Причина</span><input id="stReason" class="field-input" maxlength="300" placeholder="Напр.: перерахунок за неякісну послугу, повернення товару"></label>
            <label class="field pay-wide"><span class="field-label">Документ коригування (скан)</span><input id="stFiles" class="field-input" type="file" accept=".pdf,image/*"></label>
        </div>
        <p class="buh-note">Сторно зменшує витрату й борг постачальнику датою коригування — закриті місяці не змінюються. Якщо документ уже оплачено, постачальник винен ОСББ різницю: її повернення на рахунок рознесіть як «Повернення» до цієї оплати.</p>
        <div class="pay-form-actions"><button type="button" class="sv-btn" data-act="storno-save">Провести сторно</button><button type="button" class="sv-btn is-soft" data-act="inline-close">Скасувати</button></div>
    </div>`;
}

const docTitle = e => e.description || e.supplierName || 'Документ';

/**
 * «Оплата»: договір, платежі за документом і списання у виписці — кожне
 * відкривається карткою ланцюжка (buh-chain.js).
 */
function chainHtml(e) {
    const c = e.contractId ? contractOf(e.contractId) : null;
    const pays = docPayments(e, allPayments);
    const payTxs = new Set(pays.map(p => p.txId).filter(Boolean));
    const txs = (e.txIds || []).filter(id => !payTxs.has(id));
    if (!c && !pays.length && !txs.length) return '';
    const row = (attrs, label, title, right = '') => `<button type="button" class="chs-link" ${attrs}><span class="chs-link-label">${label}</span>
        <span class="chs-link-main"><b>${title}</b></span><span class="chs-link-right">${right}<span aria-hidden="true">›</span></span></button>`;
    const statusChip = p => { const [t, cl] = PAYMENT_STATUS[p.status] || [p.status, '']; return `<span class="sv-chip ${cl === 'is-payment' ? 'is-done' : cl === 'is-error' ? 'is-bad' : cl === 'is-review' ? 'is-work' : ''}">${escapeHtml(t)}</span>`; };
    return `<div class="dc-chain"><h3 class="chs-h">Договір і оплата</h3><div class="chs-links">
        ${c ? row(`data-open="contract" data-id="${escapeHtml(c.id)}"`, 'Договір', `№ ${escapeHtml(c.number)} від ${human(c.date)} · ${escapeHtml(c.subject || '')}`) : ''}
        ${pays.map(p => row(`data-open="payment" data-id="${escapeHtml(p.id)}"`, 'Платіж', `${p.createdAt ? escapeHtml(when(p.createdAt)) : ''} · ${escapeHtml(p.recipient?.name || '')}`, `<b>${fmtKop(p.amountKop)} грн</b>${statusChip(p)}`)).join('')}
        ${txs.map(id => row(`data-open="tx" data-id="${escapeHtml(id)}" data-fill-tx="${escapeHtml(id)}"`, 'Списання', 'у виписці банку')).join('')}
    </div></div>`;
}

/** Підставити дату й суму списань у блоці «Оплата» (операції банку читаємо окремо). */
function fillTxRows() {
    document.querySelectorAll('#dcCard [data-fill-tx]').forEach(async b => {
        const tx = await loadTx(b.dataset.fillTx).catch(() => null);
        if (!tx || !b.isConnected) return;
        b.querySelector('.chs-link-main b').textContent = `${dateOnly(tx.at)} · ${tx.counterparty?.name || ''}`;
        b.querySelector('.chs-link-right').insertAdjacentHTML('afterbegin', `<b>${fmtKop(tx.amountKop)} грн</b>`);
    });
}

function scanHtml(e) {
    const [first, ...rest] = e.files || [];
    if (!first) return `<div class="dc-scan is-empty"><b>Скану немає</b><span>${['pending', 'rejected'].includes(e.status) ? 'Додайте файл через «Змінити» — без нього документ важче перевірити' : 'Документ внесено без файлу'}</span></div>`;
    const kind = scanKind(first);
    const url = escapeHtml(first.url);
    const view = kind === 'image' ? `<a href="${url}" target="_blank" rel="noopener"><img src="${url}" alt="Скан: ${escapeHtml(first.name)}" loading="lazy"></a>`
        : kind === 'pdf' ? `<iframe src="${url}#toolbar=0&amp;view=FitH" title="Скан: ${escapeHtml(first.name)}" loading="lazy"></iframe>`
            : '';
    return `<div class="dc-scan is-${kind}">${view}
        <span class="dc-files">${[first, ...rest].map(f => `<a href="${escapeHtml(f.url)}" target="_blank" rel="noopener">${escapeHtml(f.name)}</a>`).join('')}</span></div>`;
}

function fieldsHtml(e) {
    const c = e.contractId ? contractOf(e.contractId) : null;
    const rows = [
        ['Постачальник', e.supplierName],
        ['Документ', docName(e)],
        ['За місяць', e.period ? periodName(e.period) : ''],
        ['Стаття', ctx.items[e.item] || ''],
        ['Облік майна / ТМЦ', e.postingAcc && e.postingAcc !== '92' ? `Рахунок ${e.postingAcc} · Інв. код: ${e.assetId || '—'}` : ''],
        ['Договір', c ? '' : e.contractNumber ? `№ ${e.contractNumber}` : 'без договору'],
        ['ПДВ', e.vatKop ? `${fmtKop(e.vatKop)} грн` : ''],
        ['Затвердження', [e.approval?.reason, e.approval?.by ? `затвердив ${e.approval.by}` : ''].filter(Boolean).join(' · ')],
        ['Оплата', e.status === 'paid' ? 'оплачено за випискою' : e.paidKop > 0 ? `сплачено ${fmtKop(e.paidKop)} грн, лишилось ${fmtKop(remaining(e))} грн`
            : paying.has(e.id) ? 'у Приват24, чекає підпису голови' : e.status === 'approved' ? 'ще не створено' : ''],
        ['Коментар', e.comment ? `«${e.comment}»` : '']
    ].filter(([, v]) => v);
    return `<dl class="dc-fields">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${escapeHtml(v)}</dd>`).join('')}</dl>`;
}

function cardHtml(e, empty) {
    if (!e) return empty && segment === 'work' ? '<div class="fl-empty"><b>Усе опрацьовано</b><span>Нових документів немає. Додайте рахунок чи акт — перетягніть файл угору сторінки.</span></div>'
        : '<div class="fl-empty"><b>Оберіть документ</b><span>Скан, реквізити й звʼязки документа — тут.</span></div>';
    const [chip, cls] = chipOf(e, { chair: isChair(), paying: paying.has(e.id) });
    const twin = twinOf(e, ctx.expenses);
    return `<div class="fl-card-head">
            <div><span class="fl-facts">${escapeHtml(ctx.docTypes[e.docType] || 'Документ')}${e.linkedIds?.length ? ' + підтвердні' : ''} · ${human(e.date)}</span>
                <h2>${escapeHtml(docTitle(e))}</h2><span class="dc-amount">${fmtKop(e.amountKop)} грн</span></div>
            <span class="sv-chip ${cls}">${escapeHtml(chip)}</span>
        </div>
        <div class="dc-body">${scanHtml(e)}${fieldsHtml(e)}</div>
        ${twin ? `<div class="dc-hint is-ask">${LINK_ICON}<span>${escapeHtml(ctx.docTypes[twin.docType] || 'Документ')} № ${escapeHtml(twin.number)} того самого постачальника на ту саму суму — схоже, це одна послуга. Обʼєднаємо в одну витрату, щоб вона не порахувалась двічі.</span>
            <button type="button" class="sv-btn" data-act="merge-doc" data-to="${escapeHtml(twin.id)}">Обʼєднати</button></div>` : ''}
        ${relationsHtml(e)}
        ${chainHtml(e)}
        ${attaching === e.id ? attachHtml(e) : ''}${stornoing === e.id ? stornoHtml(e) : ''}
        <div class="fl-actions">${docActions(e)}</div>`;
}

function itemHtml(e) {
    const [chip, cls] = chipOf(e, { chair: isChair(), paying: paying.has(e.id) });
    return `<li><button type="button" class="fl-item dc-item${e.id === selected ? ' is-current' : ''}" data-act="pick" data-id="${escapeHtml(e.id)}" aria-current="${e.id === selected}">
        <span class="fl-copy"><b>${escapeHtml(docTitle(e))}</b><small>${escapeHtml(e.supplierName)} · ${escapeHtml(ctx.docTypes[e.docType] || '')} № ${escapeHtml(e.number)}</small></span>
        <span class="dc-right"><b class="fl-sum">${fmtKop(e.amountKop)} грн</b><span class="sv-chip ${cls}">${escapeHtml(chip)}</span></span>
    </button></li>`;
}

function docsHtml() {
    const list = filterDocs(ctx.expenses, segment, query);
    if (!list.some(e => e.id === selected)) selected = window.matchMedia('(max-width: 900px)').matches ? null : list[0]?.id || null;
    const cur = ctx.expenses.find(e => e.id === selected);
    const toPay = ctx.expenses.filter(e => e.status === 'approved' && !paying.has(e.id)).reduce((s, e) => s + Math.max(0, remaining(e)), 0);
    return `<div class="fl-grid dc-grid">
            <section class="fl-list" aria-label="Документи">
                <label class="fl-search dc-search"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>
                    <input type="search" id="exQuery" placeholder="Постачальник, номер, опис" value="${escapeHtml(query)}" aria-label="Пошук документа"></label>
                ${segment === 'work' && toPay ? `<p class="dc-sum">До оплати <b>${fmtKop(toPay)} грн</b></p>` : ''}
                ${list.length ? `<ul class="fl-items">${list.map(itemHtml).join('')}</ul>` : `<p class="list-empty">${query ? 'Нічого не знайдено' : segment === 'work' ? 'Документів, що чекають дії, немає' : 'Архів порожній'}</p>`}
            </section>
            <section class="fl-card dc-card${cur || !list.length ? '' : ' is-idle'}" id="dcCard"${cur ? ` data-id="${escapeHtml(cur.id)}"` : ''} aria-live="polite">${cardHtml(cur, !list.length)}</section>
        </div>`;
}

function findFocusedSupplier() {
    if (!activeFocus || activeFocus.kind !== "supplier") return null;
    if (activeFocus.id) {
        const byId = ctx.suppliers.find(s => s.id === activeFocus.id);
        if (byId) return byId;
    }
    if (activeFocus.code) {
        const byCode = ctx.suppliers.find(s => String(s.code || "").trim() === String(activeFocus.code).trim());
        if (byCode) return byCode;
    }
    if (activeFocus.iban) {
        const cleanIban = String(activeFocus.iban).replace(/\s+/g, "").toUpperCase();
        const byIban = ctx.suppliers.find(s => String(s.iban || "").replace(/\s+/g, "").toUpperCase() === cleanIban);
        if (byIban) return byIban;
    }
    if (activeFocus.name) {
        const byName = ctx.suppliers.find(s => sameEntity(s.name, activeFocus.name));
        if (byName) return byName;
    }
    return null;
}

function findFocusedContract() {
    if (!activeFocus || activeFocus.kind !== "contract") return null;
    if (activeFocus.id) {
        const byId = ctx.contracts.find(c => c.id === activeFocus.id);
        if (byId) return byId;
    }
    // Номер договору шукаємо серед договорів того ж постачальника: «№ 1» є майже в кожного.
    const ofSupplier = ctx.contracts.filter(c => (activeFocus.supplierId && c.supplierId === activeFocus.supplierId)
        || (activeFocus.supplierName && sameEntity(c.supplierName, activeFocus.supplierName)));
    if (activeFocus.number && activeFocus.number !== "б/н") {
        const byNum = ofSupplier.find(c => String(c.number || "").toLowerCase() === String(activeFocus.number).toLowerCase());
        if (byNum) return byNum;
    }
    if (ofSupplier.length) return ofSupplier.find(c => c.status === 'approved') || ofSupplier[0];
    return null;
}

function contractsHtml() {
    const ending = c => c.validTo && c.validTo >= ctx.today && c.validTo <= new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10);
    const matchedCon = findFocusedContract();
    const focusBanner = activeFocus?.kind === "contract" ? (matchedCon
        ? `<div class="buh-card buh-focus-card" id="exFocusedTarget">
            <div class="buh-card-head">
                <div>
                    <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
                        <span class="buh-tag is-payment">Картка договору в реєстрі</span>
                        ${tag(CONTRACT_STATUS, matchedCon.status)}
                    </div>
                    <h2 style="margin-top:6px">Договір № ${escapeHtml(matchedCon.number)} від ${escapeHtml(human(matchedCon.date))}</h2>
                </div>
                <button type="button" class="btn-ghost-small" data-act="clear-focus">Сховати ✕</button>
            </div>
            <div class="sup-info-grid">
                <div class="sup-info-cell">
                    <span>Постачальник (контрагент)</span>
                    <button type="button" class="sup-inline-link" data-act="jump-to-supplier" data-supplier-id="${escapeHtml(matchedCon.supplierId || '')}" data-supplier-name="${escapeHtml(matchedCon.supplierName || '')}">
                        <b>${escapeHtml(matchedCon.supplierName || "—")}</b> ›
                    </button>
                </div>
                <div class="sup-info-cell">
                    <span>Строк дії договору</span>
                    <b>${escapeHtml(human(matchedCon.validFrom))} — ${matchedCon.validTo ? escapeHtml(human(matchedCon.validTo)) : "безстроково"}</b>
                </div>
                <div class="sup-info-cell">
                    <span>Сума за договором</span>
                    <b>${matchedCon.type === "monthly" ? `${fmtKop(matchedCon.monthlyKop)} грн / міс.` : `${fmtKop(matchedCon.amountKop)} грн`}</b>
                </div>
                <div class="sup-info-cell">
                    <span>Стаття кошторису</span>
                    <b>${escapeHtml(ctx.items[matchedCon.item] || matchedCon.item || "—")}</b>
                </div>
                <div class="sup-info-cell is-full">
                    <span>Предмет договору та підстава затвердження</span>
                    <b>${escapeHtml(matchedCon.subject || "—")}</b>
                    ${matchedCon.meetingDecision || matchedCon.boardDecision ? `<small>${escapeHtml([matchedCon.boardDecision ? `Правління: ${matchedCon.boardDecision}` : '', matchedCon.meetingDecision ? `Загальні збори: ${matchedCon.meetingDecision}` : ''].filter(Boolean).join(' · '))}</small>` : ''}
                </div>
            </div>
            <div class="buh-focus-actions">
                <button type="button" class="sv-btn btn-compact" data-open="contract" data-id="${escapeHtml(matchedCon.id)}">Деталі й оплати за договором ›</button>
                <button type="button" class="sv-btn is-soft btn-compact" data-act="focus-edit-contract" data-id="${escapeHtml(matchedCon.id)}">Редагувати договір</button>
                <button type="button" class="sv-btn is-soft btn-compact" data-act="jump-to-supplier" data-supplier-id="${escapeHtml(matchedCon.supplierId || '')}" data-supplier-name="${escapeHtml(matchedCon.supplierName || '')}">Картка постачальника ›</button>
            </div>
        </div>`
        : `<div class="buh-card buh-focus-card" id="exFocusedTarget">
            <div class="buh-card-head">
                <div>
                    <span class="buh-tag is-review">Договір із призначення банківського платежу</span>
                    <h2 style="margin-top:6px">${escapeHtml(activeFocus.subject || "Договір")} · № ${escapeHtml(activeFocus.number || "б/н")}${activeFocus.date ? ` від ${escapeHtml(human(activeFocus.date))}` : ""}</h2>
                </div>
                <button type="button" class="btn-ghost-small" data-act="clear-focus">Сховати ✕</button>
            </div>
            <div class="sup-info-grid">
                <div class="sup-info-cell">
                    <span>Контрагент</span>
                    <button type="button" class="sup-inline-link" data-act="jump-to-supplier" data-supplier-id="${escapeHtml(activeFocus.supplierId || '')}" data-supplier-name="${escapeHtml(activeFocus.supplierName || '')}" data-code="${escapeHtml(activeFocus.code || '')}" data-iban="${escapeHtml(activeFocus.iban || '')}">
                        <b>${escapeHtml(activeFocus.supplierName || "—")}</b> ›
                    </button>
                </div>
                <div class="sup-info-cell">
                    <span>Реквізити договору</span>
                    <b>№ ${escapeHtml(activeFocus.number || "б/н")}${activeFocus.date ? ` від ${escapeHtml(human(activeFocus.date))}` : ""}</b>
                </div>
                <div class="sup-info-cell">
                    <span>Сума платежу за випискою</span>
                    <b>${activeFocus.amountKop ? `${fmtKop(activeFocus.amountKop)} грн` : "—"}</b>
                </div>
                <div class="sup-info-cell">
                    <span>Статус у системі</span>
                    <b>Ще не внесено в реєстр</b>
                </div>
            </div>
            <div class="buh-focus-actions">
                <button type="button" class="sv-btn btn-compact" data-act="register-focused-contract">+ Внести цей договір у реєстр ОСББ</button>
                <button type="button" class="sv-btn is-soft btn-compact" data-act="jump-to-supplier" data-supplier-id="${escapeHtml(activeFocus.supplierId || '')}" data-supplier-name="${escapeHtml(activeFocus.supplierName || '')}" data-code="${escapeHtml(activeFocus.code || '')}" data-iban="${escapeHtml(activeFocus.iban || '')}">Картка контрагента ›</button>
            </div>
        </div>`) : "";

    return `${focusBanner}<section class="buh-card ex-contracts-card">
            <div class="buh-toolbar"><span class="buh-note">Договори понад 50 000 грн — лише за рішенням загальних зборів (п. 3.4.15 статуту). Підписує й затверджує голова.</span>
                <button type="button" class="btn-primary btn-compact" data-act="new-contract">+ Договір</button></div>
            ${ctx.contracts.length ? `<div class="ex-table-wrap"><table class="buh-table ex-table ex-contracts-table"><thead><tr><th>Договір</th><th>Постачальник і предмет</th><th>Діє</th><th>Стан</th><th class="t-sum">Сума, ₴</th><th class="t-act">Дії</th></tr></thead>
                <tbody>${ctx.contracts.map(c => `<tr data-id="${escapeHtml(c.id)}"${matchedCon?.id === c.id ? ' class="buh-nav-target-highlight"' : ''}>
                    <td class="ex-doc">
                        <button type="button" class="ex-row-link" data-act="focus-contract" data-id="${escapeHtml(c.id)}">
                            <b>№ ${escapeHtml(c.number)}</b>
                            <small class="t-muted">від ${human(c.date)}</small>
                        </button>
                    </td>
                    <td class="t-main ex-con-main">
                        <button type="button" class="ex-sup-link" data-act="jump-to-supplier" data-supplier-id="${escapeHtml(c.supplierId || '')}" data-supplier-name="${escapeHtml(c.supplierName || '')}">
                            <b>${escapeHtml(c.supplierName || '')}</b>
                        </button>
                        <small class="ex-subj-text">${escapeHtml(c.subject)} · ${escapeHtml(ctx.items[c.item] || '')}${c.meetingDecision ? ` · збори: ${escapeHtml(c.meetingDecision)}` : ''}</small>
                    </td>
                    <td class="t-muted ex-dates">
                        <span>${human(c.validFrom)}</span>
                        <span>— ${c.validTo ? human(c.validTo) : 'безстрок.'}</span>
                        ${ending(c) ? '<span class="buh-tag is-review">закінчується</span>' : ''}
                    </td>
                    <td class="ex-status-cell">${tag(CONTRACT_STATUS, c.status)}</td>
                    <td class="t-sum">${c.type === 'monthly' ? `${fmtKop(c.monthlyKop)}<small>на місяць</small>` : fmtKop(c.amountKop)}</td>
                    <td class="t-act">
                        <div class="ex-act-group">
                            ${c.status === 'pending' && isChair() ? '<button type="button" class="btn-soft btn-compact" data-act="approve-contract">Затвердити</button><button type="button" class="btn-ghost-small" data-act="reject-contract">Відхилити</button>' : ''}
                            ${c.status !== 'approved' || isChair() ? '<button type="button" class="btn-ghost-small" data-act="edit-contract">Змінити</button>' : ''}
                            <button type="button" class="btn-ghost-small" data-open="contract" data-id="${escapeHtml(c.id)}">Деталі й оплати</button>
                            ${c.status === 'approved' ? '<button type="button" class="btn-ghost-small" data-act="end-contract">Завершити</button>' : ''}
                            ${filesHtml(c.files)}
                        </div>
                    </td></tr>`).join('')}</tbody></table></div>` : '<p class="list-empty">Договорів ще немає</p>'}
        </section>`;
}

function suppliersHtml() {
    const totals = new Map();
    ctx.expenses.filter(e => ["approved", "paid"].includes(e.status)).forEach(e => totals.set(e.supplierId, (totals.get(e.supplierId) || 0) + e.amountKop));
    return `<section class="buh-card">
            <div class="buh-toolbar"><span class="buh-note">Картка контрагента автоматично заповнюється з ЄДРПОУ, реєстрів платників ПДВ / Єдиного податку, судового реєстру та АСВП через YouControl (YouScore API).</span>
                <button type="button" class="btn-primary btn-compact" data-act="new-supplier">+ Постачальник</button></div>
            ${ctx.suppliers.length ? `<table class="buh-table ex-table"><thead><tr><th>Назва та керівник</th><th>Код / ОПФ</th><th>Податковий статус і КВЕД</th><th>IBAN та контакти</th><th>Комплаєнс ЄДР / YouScore</th><th class="t-sum">Витрати, ₴</th><th></th></tr></thead>
                <tbody>${ctx.suppliers.map(s => `<tr data-id="${escapeHtml(s.id)}">
                    <td class="t-main"><b>${escapeHtml(s.name)}</b>${s.director ? `<small>Керівник: ${escapeHtml(s.director)}</small>` : `<small>${escapeHtml(ctx.kinds[s.kind] || "")}</small>`}${s.address ? `<small class="t-muted">${escapeHtml(s.address)}</small>` : ""}</td>
                    <td><b>${escapeHtml(s.code)}</b><br><small class="t-muted">${escapeHtml(s.legalForm || ctx.kinds[s.kind] || "")}</small></td>
                    <td>${s.taxSystem ? `<span class="buh-tag is-soft">${escapeHtml(s.taxSystem)}</span><br>` : ""}${s.mainKved ? `<small class="t-muted">${escapeHtml(s.mainKved)}</small>` : "—"}</td>
                    <td class="t-muted">${escapeHtml(maskIban(s.iban || "")) || "—"}${s.phone ? `<br><small>${escapeHtml(s.phone)}</small>` : ""}${s.email ? `<br><small>${escapeHtml(s.email)}</small>` : ""}</td>
                    <td>${s.kind === "fop" ? (s.fopChecked ? "<span class=\"buh-tag is-payment\">КВЕД ФОП перевірено</span> " : "<span class=\"buh-tag is-review\">перевірте витяг ЄДР</span> ") : s.kind === "person" ? "<span class=\"buh-tag is-error\">лише через ЦПД</span> " : ""}${s.taxDebtTotal > 0 ? `<span class="buh-tag is-error">Податковий борг ${escapeHtml(String(s.taxDebtTotal))} ₴</span> ` : ""}${s.openPenalties > 0 ? `<span class="buh-tag is-review">ВП: ${escapeHtml(String(s.openPenalties))}</span> ` : ""}${s.expressIndex ? `<span class="buh-tag is-soft">YouScore: ${escapeHtml(s.expressIndex)}</span>` : ""}</td>
                    <td class="t-sum">${fmtKop(totals.get(s.id) || 0)}</td>
                    <td class="t-act"><button type="button" class="btn-ghost-small" data-act="edit-supplier">Змінити</button></td></tr>`).join("")}</tbody></table>`
                : "<p class=\"list-empty\">Постачальників ще немає. Їх можна додати й прямо з форми документа.</p>"}
        </section>`;
}

// ------------------------------------------------------------
// РОЗДІЛ
// ------------------------------------------------------------
export async function loadExpensesView() {
    const [data, outgoing] = await Promise.all([loadExpenses(), loadPayments().catch(() => [])]);
    ctx = data;
    allPayments = outgoing;
    const target = wanted && ctx.expenses.find(x => x.id === wanted);
    if (target) { segment = bucketOf(target); selected = target.id; form = null; }
    wanted = null;
    paying = new Set(outgoing.filter(p => p.expenseId && ['sending', 'unknown', 'sent'].includes(p.status)).map(p => p.expenseId));
    const host = document.getElementById('viewExpenses');
    const docs = segment === 'work' || segment === 'archive';
    const counts = { ...docCounts(ctx.expenses), contracts: ctx.contracts.length, suppliers: ctx.suppliers.length };
    const body = docs ? docsHtml() : segment === 'contracts' ? contractsHtml() : suppliersHtml();
    host.innerHTML = `${docs ? `<label class="dc-drop" id="dcDrop">
            <input type="file" id="dcPick" multiple accept=".pdf,image/*,.doc,.docx,.xls,.xlsx,.xml,.zip,.p7s" class="dc-pick">
            <span class="dc-drop-icon">${UP_ICON}</span>
            <span class="dc-drop-copy"><b>Додати рахунок, акт чи накладну (M.E.Doc, Вчасно, скан)</b><small>Перетягніть XML, ZIP із ЕДО, PDF чи фото — реквізити заповняться автоматично</small></span>
        </label>` : ''}
        <div class="fl-filters dc-tabs" role="tablist">${Object.entries(TABS).map(([k, v]) =>
            `<button type="button" class="fl-filter${k === segment ? ' active' : ''}" role="tab" aria-selected="${k === segment}" data-seg="${k}">${v} <span>${counts[k]}</span></button>`).join('')}
            <span class="dc-links"><button type="button" class="dc-link" data-go="assets" title="Інвентарна книга ОЗ, МНМА, склад Запасів та МШП">Майно та ТМЦ ›</button>
            <button type="button" class="dc-link" data-go="advance" title="Авансові звіти та підзвітні особи (рах. 372)">Авансові звіти ›</button></span></div>
        ${formHtml()}${body}`;
    if (form) document.getElementById('exForm')?.querySelector('select, input')?.focus({ preventScroll: true });
    fillTxRows();
    if (shouldScrollFocus) {
        shouldScrollFocus = false;
        setTimeout(() => {
            const hlRow = host.querySelector('tr.buh-nav-target-highlight');
            const focusCard = document.getElementById('exFocusedTarget') || document.getElementById('dcCard');
            if (hlRow) hlRow.scrollIntoView({ behavior: 'smooth', block: 'center' });
            else if (focusCard) focusCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }, 60);
    }
    return ctx.expenses.filter(e => e.status === 'pending').length;
}

/** Файли, перетягнуті чи обрані у верхній зоні, — у форму нового документа. */
async function startWithFiles(list) {
    if (!list.length) return;
    files = list;
    form = { kind: 'doc', data: form?.kind === 'doc' ? form.data : {} };
    await loadExpensesView();
    document.getElementById('exForm')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    if (list[0]) {
        await recognizeUploadedDocument(list[0], 'doc');
    }
}

/** Затверджений документ → платіж у Приват24 на підпис голови. */
export async function payExpense(e) {
    const pc = await loadPaymentContext();
    const account = defaultAccount(pc.accounts || []);
    if (!account) throw new Error('Банк не підключено — немає рахунку, з якого платити');
    await expAct({ action: 'pay', id: e.id, account });
    toast(`${e.supplierName}: ${fmtKop(remaining(e))} грн — у Приват24 на підпис голови`, 'success');
}

export async function decideExpense(e, approve) {
    const comment = approve ? '' : await promptDialog('Відхилити документ?', `${e.supplierName}, № ${e.number}: ${fmtKop(e.amountKop)} грн. Бухгалтер побачить причину.`, { confirmLabel: 'Відхилити', placeholder: 'Причина' });
    if (!approve && !comment) return false;
    await expAct({ action: 'decideExpense', id: e.id, approve, comment });
    toast(approve ? 'Затверджено' : 'Відхилено', 'success');
    return true;
}

export async function decideContract(c, approve) {
    const comment = approve ? '' : await promptDialog('Відхилити договір?', `№ ${c.number} з ${c.supplierName}.`, { confirmLabel: 'Відхилити', placeholder: 'Причина' });
    if (!approve && !comment) return false;
    await expAct({ action: 'decideContract', id: c.id, approve, comment });
    toast(approve ? 'Договір затверджено' : 'Договір відхилено', 'success');
    return true;
}

async function saveDoc(btn) {
    const amountKop = toKop(val('dfAmount'));
    if (!amountKop || amountKop <= 0) { toast('Вкажіть суму документа', 'error'); return; }
    const vat = val('dfVat') ? toKop(val('dfVat')) : 0;
    if (vat === null) { toast('ПДВ — сума в гривнях', 'error'); return; }
    // Після будь-якої дії розділ перемальовується — введене не має зникнути, якщо сервер відмовить.
    form = snapshotForm();
    if (form.data.postingAcc && form.data.postingAcc !== '92' && !form.data.assetId) {
        form.data.assetId = suggestAssetId(form.data.postingAcc, allExistingAssetIds());
    }
    setBusy(btn, true, files.length ? 'Завантажую файли…' : 'Зберігаю…');
    try {
        const uploaded = await uploadExpenseFiles(files);
        form.data.files = [...(form.data.files || []), ...uploaded];
        files = [];
        const payload = { action: 'saveExpense', id: form.data.id || null, supplierId: form.data.supplierId, contractId: form.data.contractId || null,
            docType: form.data.docType, number: form.data.number, date: form.data.date, period: form.data.period, amountKop, vatKop: vat,
            item: form.data.item, description: form.data.description, files: form.data.files, linkedTo: form.data.linkedTo || null,
            postingAcc:form.data.postingAcc || '92',assetId:form.data.assetId || '',ownedByOsbb:form.data.ownedByOsbb===true,fundId:form.data.fundId || ctx.defaultFund || 'main',
            assetQty:form.data.assetQty || 1,assetUnit:form.data.assetUnit || 'шт.',custodian:form.data.custodian || '',location:form.data.location || '',
            commissionedDate:form.data.commissionedDate || '' };
        let r;
        try {
            r = await expAct(payload);
        } catch (err) {
            // Схожий документ тієї самої послуги: привʼязати до нього або підтвердити окрему витрату.
            const similar = err.cause?.details?.similar;
            if (!similar) throw err;
            if (await confirmDialog('Та сама послуга?', `${err.message}`, `Привʼязати до № ${similar.number}`)) r = await expAct({ ...payload, linkedTo: similar.id });
            else if (await confirmDialog('Це окрема послуга?', 'Документ стане окремою витратою й окремим боргом постачальнику.', 'Так, окрема')) r = await expAct({ ...payload, distinct: true });
            else return;
        }
        const wasApproved = r.status === 'approved';
        const savedNumber = form?.data?.number || '';
        const savedSupId = form?.data?.supplierId;
        form = null;
        toast(r.status === 'linked' ? 'Привʼязано як підтвердний документ — окремої витрати немає' : wasApproved ? `Затверджено (${r.approval.reason}) — готово до оплати` : `Надіслано голові: ${r.approval.reason}`, 'success');
        (r.warnings || []).forEach(w => toast(w, 'info'));
        if (wasApproved) {
            const supObj = ctx.suppliers.find(s => s.id === savedSupId);
            const supName = supObj?.name || 'постачальнику';
            if (await confirmDialog('Створити платіж у Приват24?', `${supName}: сума ${fmtKop(amountKop)} грн. Створити платіж на підпис голови у Приват24?`, 'Створити платіж')) {
                try {
                    await payExpense({ id: r.id, supplierName: supName, amountKop, paidKop: 0, stornoKop: 0 });
                } catch (pErr) { toast(pErr.message, 'error'); }
            }
        }
    } catch (e) { toast(e.message, 'error'); }
    finally { setBusy(btn, false); }
}

async function saveContract(btn) {
    const amount = toKop(val('cfAmount'));
    if (!amount || amount <= 0) { toast('Вкажіть суму', 'error'); return; }
    const monthly = val('cfType') === 'monthly';
    const back = form?.back;
    form = snapshotForm();
    setBusy(btn, true, 'Зберігаю…');
    try {
        const uploaded = await uploadExpenseFiles(files);
        const r = await expAct({ action: 'saveContract', id: form.data.id || null, supplierId: val('cfSupplier'), number: val('cfNumber'), date: val('cfDate'),
            subject: val('cfSubject'), type: monthly ? 'monthly' : 'fixed', monthlyKop: monthly ? amount : null, amountKop: monthly ? null : amount,
            validFrom: val('cfFrom'), validTo: val('cfTo'), item: val('cfItem'), boardDecision: val('cfBoard'), meetingDecision: val('cfMeeting'),
            files: [...(form.data.files || []), ...uploaded] });
        form = back ? { ...back, data: { ...back.data, contractId: r.id } } : null;
        files = [];
        if (back) segment = 'work';
        toast(r.status === 'approved' ? 'Договір затверджено' : 'Договір надіслано голові на затвердження', 'success');
        if (back) loadExpensesView();
    } catch (e) { toast(e.message, 'error'); }
    finally { setBusy(btn, false); }
}

async function checkSupplierEdr(btn) {
    const code = val("sfCode");
    if (!/^\d{8,10}$/.test(code)) { toast("Введіть 8 цифр ЄДРПОУ або 10 цифр РНОКПП", "error"); return; }
    setBusy(btn, true, "Запитую реєстри YouScore…");
    try {
        const d = await expAct({ action: "checkSupplier", code });
        const box = document.getElementById("sfEdrStatus");
        if (!d.found) {
            if (box) { box.hidden = false; box.textContent = d.needRetry ? "Запит в ЄДР ще обробляється (202 Update in progress) — натисніть кнопку ще раз за кілька секунд." : "У ЄДР запис за цим кодом не знайдено."; }
            form = snapshotForm();
            toast("У ЄДР ще немає відповіді або код не знайдено", "info");
            return;
        }
        const setField = (id, v) => {
            const el = document.getElementById(id);
            if (el && v) { el.value = v; flashField(id); }
        };
        const phoneVal = d.phone || d.contacts?.phone || d.contacts?.additionalPhone || "";
        const emailVal = d.email || d.contacts?.email || "";
        const taxSystemVal = d.taxSystem || d.taxSummary || "";
        const vatCodeVal = d.vatCode || d.taxInfo?.vatCode || d.vat?.code || "";
        const fmtKved = k => typeof k === "string" ? k.trim() : (k && (k.code || k.name) ? `${k.code || ""} ${k.name || ""}`.trim() : "");
        const mainKv = fmtKved(d.mainKved) || fmtKved((d.kveds || [])[0]);
        const capitalVal = Number(d.capital || d.foundingCapital || d.authorizedCapital || 0);
        const enfTotal = d.enforcementTotal ?? d.totalEnforcements ?? d.totalPenalties;
        const expressVal = d.expressIndex || d.expressScore || "";

        setField("sfName", d.shortName || d.name);
        setField("sfFullName", d.fullName || d.name);
        setField("sfLegalForm", d.legalForm || (code.length === 10 ? "ФІЗИЧНА ОСОБА — ПІДПРИЄМЕЦЬ" : ""));
        setField("sfDirector", d.director || "");
        setField("sfRegStatus", d.stateText || "");
        setField("sfAddress", d.address || "");
        setField("sfPhone", phoneVal);
        setField("sfEmail", emailVal);
        setField("sfTaxSystem", taxSystemVal);
        setField("sfVatCode", vatCodeVal);
        setField("sfMainKved", mainKv);
        if (document.getElementById("sfTaxDebt")) document.getElementById("sfTaxDebt").value = String(d.taxDebtTotal || 0);
        if (document.getElementById("sfOpenPenalties")) document.getElementById("sfOpenPenalties").value = String(d.openPenalties || 0);
        if (document.getElementById("sfExpressIndex")) document.getElementById("sfExpressIndex").value = expressVal;

        const kindEl = document.getElementById("sfKind");
        if (kindEl) {
            kindEl.value = code.length === 10 ? "fop" : "company";
            const fopRow = document.getElementById("sfFopRow");
            if (fopRow) fopRow.hidden = kindEl.value !== "fop";
        }
        const kvedStr = (d.kveds || []).slice(0, 4).map(fmtKved).filter(Boolean).join("; ");
        const noteParts = [
            kvedStr ? `КВЕД: ${kvedStr}` : "",
            taxSystemVal ? `Оподаткування: ${taxSystemVal}` : "",
            capitalVal > 0 ? `Статутний капітал: ${capitalVal.toLocaleString("uk-UA")} грн` : ""
        ].filter(Boolean).join(" · ");
        if ((noteParts || d.formattedNote) && !val("sfNote")) {
            setField("sfNote", (noteParts || d.formattedNote).slice(0, 300));
        }
        if (code.length === 10 && d.isRegistered && (d.kveds || []).length && document.getElementById("sfFop")) {
            document.getElementById("sfFop").checked = true;
        }
        if (box) {
            box.hidden = false;
            const isSandbox = d.sandbox || d.source === "youscore_sandbox" || d.provider === "youscore-sandbox";
            const isYouscore = isSandbox || d.source === "youscore" || d.provider === "youscore";
            const srcBadge = isSandbox
                ? "<span class=\"doc-recog-badge\">YouScore Sandbox (тестові дані)</span>"
                : isYouscore
                    ? "<span class=\"doc-recog-badge\">✓ YouScore API (YouControl)</span>"
                    : "<span class=\"doc-recog-badge\">✓ Приват24 ЄДР</span>";
            const risks = (d.riskFlags || []).length
                ? `<br><b style="color:#b42318">⚠️ Фактори ризику: ${escapeHtml(d.riskFlags.join("; "))}</b>`
                : ` · <span style="color:#15803d">Ризиків ДПС, банкрутства чи ВП не виявлено</span>`;
            const extraStats = [
                expressVal ? `Індекс Експрес-аналізу: <b>${escapeHtml(String(expressVal))}</b>` : "",
                d.courtTotal !== undefined ? `Судових документів: <b>${d.courtTotal}</b>` : "",
                enfTotal !== undefined ? `Виконавчих проваджень: <b>${enfTotal}</b> (відкритих: ${d.openPenalties || 0})` : ""
            ].filter(Boolean).join(" · ");
            box.innerHTML = `${srcBadge} <b>${escapeHtml(d.fullName || d.name || d.edrpou)}</b> (${escapeHtml(d.stateText || "зареєстровано")})${extraStats ? `<br><span>${extraStats}</span>` : ""}${risks}`;
        }
        // Зберігаємо заповнені реквізити у стан форми, щоб вони не стиралися при оновленні подання
        form = snapshotForm();
        toast(d.isSafe ? "Картку контрагента заповнено з реєстрів YouControl" : "Дані підтягнуто — зверніть увагу на фактори ризику!", d.isSafe ? "success" : "info");
    } catch (e) { toast(e.message, "error"); }
    finally { setBusy(btn, false); }
}

async function saveYouscoreKey(btn) {
    const key = val("ycApiKeyInput") || "YOUSCORE_TEST_KEY_USPIH25_SANDBOX";
    form = snapshotForm();
    setBusy(btn, true, "Перевіряю ключ…");
    try {
        const isSandbox = key === "YOUSCORE_TEST_KEY_USPIH25_SANDBOX";
        const r = await expAct({ action: "youscoreKey", apiKey: isSandbox ? "" : key, sandbox: isSandbox });
        toast(r.sandbox ? "Увімкнено тестовий Sandbox-режим YouScore" : `Ключ YouScore збережено (${r.masked || "підключено"})`, "success");
        await loadExpensesView();
    } catch (e) { toast(e.message, "error"); }
    finally { if (btn.isConnected) setBusy(btn, false); }
}

async function saveSupplier(btn) {
    setBusy(btn, true, "Зберігаю…");
    try {
        const back = form.back;
        form = snapshotForm();
        const r = await expAct({
            action: "saveSupplier",
            id: form.data.id || null,
            name: val("sfName"),
            fullName: val("sfFullName"),
            legalForm: val("sfLegalForm"),
            director: val("sfDirector"),
            address: val("sfAddress"),
            phone: val("sfPhone"),
            email: val("sfEmail"),
            mainKved: val("sfMainKved"),
            taxSystem: val("sfTaxSystem"),
            vatCode: val("sfVatCode"),
            registrationStatus: val("sfRegStatus"),
            taxDebtTotal: Number(val("sfTaxDebt") || 0),
            openPenalties: Number(val("sfOpenPenalties") || 0),
            expressIndex: val("sfExpressIndex"),
            kind: val("sfKind"),
            code: val("sfCode"),
            iban: val("sfIban"),
            fopChecked: document.getElementById("sfFop")?.checked === true,
            note: val("sfNote")
        });
        (r.warnings || []).forEach(w => toast(w, "info"));
        toast("Картку постачальника збережено", "success");
        form = back ? { ...back, data: { ...back.data, supplierId: r.id } } : null;
        if (back) segment = back.kind === "doc" ? "work" : "contracts";
    } catch (e) { toast(e.message, "error"); }
    finally { setBusy(btn, false); }
}

/** Поточні значення форми — щоб не загубити їх при переході до нового постачальника. */
function snapshotForm() {
    if (form?.kind === "supplier") return { ...form, data: {
        ...form.data,
        name: val("sfName"),
        fullName: val("sfFullName"),
        legalForm: val("sfLegalForm"),
        director: val("sfDirector"),
        address: val("sfAddress"),
        phone: val("sfPhone"),
        email: val("sfEmail"),
        mainKved: val("sfMainKved"),
        taxSystem: val("sfTaxSystem"),
        vatCode: val("sfVatCode"),
        registrationStatus: val("sfRegStatus"),
        taxDebtTotal: Number(val("sfTaxDebt") || 0),
        openPenalties: Number(val("sfOpenPenalties") || 0),
        expressIndex: val("sfExpressIndex"),
        kind: val("sfKind"),
        code: val("sfCode"),
        iban: val("sfIban"),
        fopChecked: document.getElementById("sfFop")?.checked === true,
        note: val("sfNote"),
        edrStatusHtml: document.getElementById("sfEdrStatus") && !document.getElementById("sfEdrStatus").hidden
            ? document.getElementById("sfEdrStatus").innerHTML
            : (form.data?.edrStatusHtml || "")
    } };
    if (form?.kind === "doc") return { ...form, data: { ...form.data, supplierId: val("dfSupplier"), contractId: val("dfContract"), docType: val("dfType"), number: val("dfNumber"), date: val("dfDate"),
        period: val("dfPeriod"), amountKop: toKop(val("dfAmount")) || null, vatKop: toKop(val("dfVat")) || 0, item: val("dfItem"), description: val("dfDesc"), linkedTo: val("dfLinked") || form.data.linkedTo || "",
        postingAcc:val("dfPosting") || "92",assetId:val("dfAsset"),ownedByOsbb:document.getElementById("dfOwned")?.checked===true,fundId:val("dfFund") || ctx.defaultFund || "main",
        assetQty:Number(val("dfAssetQty") || 1),assetUnit:val("dfAssetUnit") || "шт.",custodian:val("dfCustodian"),location:val("dfLocation"),
        commissionedDate:document.getElementById("dfCommissionNow")?.checked ? (val("dfDate") || ctx.today) : "" } };
    if (form?.kind === "contract") return { ...form, data: { ...form.data, supplierId: val("cfSupplier"), number: val("cfNumber"), date: val("cfDate"), subject: val("cfSubject"), type: val("cfType"),
        monthlyKop: toKop(val("cfAmount")), amountKop: toKop(val("cfAmount")), validFrom: val("cfFrom"), validTo: val("cfTo"), item: val("cfItem"),
        boardDecision: val("cfBoard"), meetingDecision: val("cfMeeting") } };
    return null;
}

function contractHint() {
    const hint = document.getElementById('cfHint');
    if (!hint) return;
    const amount = toKop(val('cfAmount')) || 0;
    const monthly = val('cfType') === 'monthly';
    const from = val('cfFrom'), to = val('cfTo');
    const months = monthly ? (to && from ? Math.max(1, (Number(to.slice(0, 4)) - Number(from.slice(0, 4))) * 12 + Number(to.slice(5, 7)) - Number(from.slice(5, 7)) + 1) : 12) : 1;
    const total = amount * months;
    document.getElementById('cfAmountLabel').textContent = monthly ? 'Сума на місяць, грн' : 'Сума договору, грн';
    hint.innerHTML = total ? `Сума договору: <b>${fmtKop(total)} грн</b>${monthly ? ` (${months} міс.${to ? '' : ', безстроковий — рахуємо рік'})` : ''}. ${total > ctx.limitKop
        ? '<b class="ch-warn">Понад 50 000 грн: потрібне рішення загальних зборів.</b>' : 'До 50 000 грн — за погодженням правління.'}` : '';
}

export function initExpensesView() {
    const host = document.getElementById('viewExpenses');
    host.addEventListener('click', async e => {
        const link = e.target.closest('[data-open]');
        if (link) {
            const open = { payment: openPaymentSheet, tx: openTxSheet, contract: openContractSheet }[link.dataset.open];
            open?.(link.dataset.id);
            return;
        }
        const seg = e.target.closest('[data-seg]');
        if (seg) { segment = seg.dataset.seg; form = null; attaching = null; stornoing = null; activeFocus = null; loadExpensesView(); return; }
        const btn = e.target.closest('[data-act]');
        if (!btn || btn.disabled) return;
        if (btn.dataset.act === 'pick') {
            selected = btn.dataset.id; attaching = null; stornoing = null;
            loadExpensesView().then(() => {
                if (window.matchMedia('(max-width: 900px)').matches) document.getElementById('dcCard')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
            });
            return;
        }
        const rowId = btn.closest('[data-id]')?.dataset.id;
        const doc = ctx.expenses.find(x => x.id === rowId);
        const con = ctx.contracts.find(x => x.id === rowId);
        const sup = ctx.suppliers.find(x => x.id === rowId);
        const a = btn.dataset.act;
        try {
            if (a === 'trigger-recog') { document.getElementById('exRecogInput')?.click(); return; }
            else if (a === 'trigger-contract-recog') { document.getElementById('cfRecogInput')?.click(); return; }
            else if (a === 'close') { form = null; files = []; loadExpensesView(); }
            else if (a === 'prompt-ai-key') {
                const cur = ctx?.settings?.aiKey;
                const key = await promptDialog(
                    "Ключ Gemini AI (Google AI Studio)",
                    `${cur?.set ? `Зараз підключено ключ …${cur.tail}. Щоб замінити — вставте новий.` : "Вставте безкоштовний ключ API (AIzaSy…) — скани, фото й PDF розпізнаватимуться автоматично."} Ключ зберігається лише на сервері.`,
                    { confirmLabel: "Перевірити й зберегти", placeholder: "AIzaSy..." }
                );
                const clean = String(key || "").trim();
                if (!clean) return;
                const r = await expAct({ action: "aiKey", key: clean });
                if (ctx?.settings) ctx.settings.aiKey = r.aiKey;
                await loadExpensesView();
                toast(`AI-ключ збережено (…${r.aiKey.tail}) — розпізнавання сканів увімкнено`, "success");
                return;
            }
            else if (a === 'quick-add-supplier') {
                const s = form?.data?.suggestedSupplier;
                if (!s || (!s.name && !s.code)) return;
                setBusy(btn, true, 'Додаю…');
                try {
                    const kind = (s.code || '').length === 10 ? 'fop' : 'company';
                    const r = await expAct({
                        action: 'saveSupplier',
                        name: s.name || `Контрагент ${s.code}`,
                        code: s.code || '',
                        iban: s.iban || '',
                        kind,
                        fopChecked: kind === 'fop',
                        note: `Створено автоматично при розпізнаванні документа ${val('dfNumber') ? `№ ${val('dfNumber')}` : ''}`
                    });
                    ctx = await loadExpenses();
                    form = snapshotForm();
                    form.data.supplierId = r.id;
                    delete form.data.suggestedSupplier;
                    const supSelect = document.getElementById('dfSupplier');
                    if (supSelect) {
                        supSelect.innerHTML = `<option value="">Оберіть…</option>${ctx.suppliers.map(sup =>
                            `<option value="${escapeHtml(sup.id)}"${sup.id === r.id ? ' selected' : ''}>${escapeHtml(sup.name)} · ${escapeHtml(sup.code)}</option>`).join('')}<option value="__new">+ Новий постачальник…</option>`;
                        supSelect.value = r.id;
                        flashField('dfSupplier');
                    }
                    const promptEl = document.getElementById('dfSuggestedSupplier');
                    if (promptEl) {
                        promptEl.innerHTML = `<div class="doc-supplier-confirmed">✓ Постачальника «${escapeHtml(s.name)}» (код ${escapeHtml(s.code || '—')}) додано в довідник та обрано в документі</div>`;
                    }
                    toast(`Постачальника «${s.name}» додано в довідник і підтягнуто в документ`, 'success');
                } catch (err) { toast(err.message, 'error'); }
                finally { if (btn.isConnected) setBusy(btn, false); }
                return;
            }
            else if (a === 'open-edit-supplier') {
                const s = form?.data?.suggestedSupplier || {};
                const back = snapshotForm();
                form = {
                    kind: 'supplier',
                    data: {
                        name: s.name || '',
                        code: s.code || '',
                        iban: s.iban || '',
                        kind: (s.code || '').length === 10 ? 'fop' : 'company',
                        note: `З документа ${val('dfNumber') ? `№ ${val('dfNumber')}` : ''}`
                    },
                    back
                };
                loadExpensesView();
                return;
            }
            else if (a === 'dismiss-suggested-supplier') {
                const promptEl = document.getElementById('dfSuggestedSupplier');
                if (promptEl) promptEl.remove();
                if (form?.data) delete form.data.suggestedSupplier;
                return;
            }
            else if (a === 'quick-add-contract') {
                const back = snapshotForm();
                form = {
                    kind: 'contract',
                    data: {
                        supplierId: back.data.supplierId,
                        subject: back.data.description || 'Обслуговування будинку',
                        item: back.data.item || 'systems',
                        number: back.data.contractName || ''
                    },
                    back
                };
                loadExpensesView();
                return;
            }
            else if (a === 'clear-focus') { activeFocus = null; loadExpensesView(); }
            else if (a === 'focus-supplier') {
                const targetSup = ctx.suppliers.find(s => s.id === (btn.dataset.id || rowId));
                if (targetSup) {
                    activeFocus = { kind: 'supplier', id: targetSup.id, name: targetSup.name, code: targetSup.code, iban: targetSup.iban };
                    shouldScrollFocus = true;
                    loadExpensesView();
                }
            }
            else if (a === 'focus-contract') {
                const targetCon = ctx.contracts.find(c => c.id === (btn.dataset.id || rowId));
                if (targetCon) {
                    activeFocus = { kind: 'contract', id: targetCon.id, number: targetCon.number, date: targetCon.date, subject: targetCon.subject, supplierId: targetCon.supplierId, supplierName: targetCon.supplierName };
                    shouldScrollFocus = true;
                    loadExpensesView();
                }
            }
            else if (a === 'jump-to-contract') {
                const cid = btn.dataset.id || '';
                const targetCon = cid ? ctx.contracts.find(c => c.id === cid) : null;
                if (targetCon) {
                    openExpenses('contracts', null, null, {
                        kind: 'contract',
                        id: targetCon.id,
                        number: targetCon.number,
                        date: targetCon.date,
                        subject: targetCon.subject,
                        supplierId: targetCon.supplierId,
                        supplierName: targetCon.supplierName
                    });
                } else {
                    openExpenses('contracts', null, null, {
                        kind: 'contract',
                        id: '',
                        number: btn.dataset.number || 'б/н',
                        date: btn.dataset.date || '',
                        subject: btn.dataset.subject || 'Договір з контрагентом',
                        supplierId: btn.dataset.supplierId || '',
                        supplierName: btn.dataset.supplierName || '',
                        code: btn.dataset.code || '',
                        amountKop: Number(btn.dataset.amountKop || 0)
                    });
                }
            }
            else if (a === 'jump-to-supplier') {
                const sid = btn.dataset.supplierId || '';
                const targetSup = sid ? ctx.suppliers.find(s => s.id === sid) : null;
                openExpenses('suppliers', null, null, {
                    kind: 'supplier',
                    id: targetSup?.id || sid || '',
                    name: targetSup?.name || btn.dataset.supplierName || '',
                    code: targetSup?.code || btn.dataset.code || '',
                    iban: targetSup?.iban || btn.dataset.iban || ''
                });
            }
            else if (a === 'new-contract-for-supplier') {
                const sid = btn.dataset.supplierId || findFocusedSupplier()?.id || '';
                openExpenses('contracts', {
                    kind: 'contract',
                    data: {
                        supplierId: sid,
                        date: ctx.today,
                        validFrom: ctx.today,
                        type: 'monthly'
                    }
                });
            }
            else if (a === 'focus-edit-supplier') {
                const targetSup = ctx.suppliers.find(s => s.id === btn.dataset.id);
                if (targetSup) openExpenses('suppliers', { kind: 'supplier', data: targetSup });
            }
            else if (a === 'focus-edit-contract') {
                const targetCon = ctx.contracts.find(c => c.id === btn.dataset.id);
                if (targetCon) openExpenses('contracts', { kind: 'contract', data: targetCon });
            }
            else if (a === 'register-focused-supplier') {
                const f = activeFocus || {};
                openExpenses('suppliers', {
                    kind: 'supplier',
                    data: {
                        name: f.name || '',
                        code: f.code || '',
                        iban: f.iban || '',
                        kind: String(f.code || '').length === 10 ? 'fop' : 'company'
                    }
                });
            }
            else if (a === 'register-focused-contract') {
                const f = activeFocus || {};
                const matchedS = findFocusedSupplier() || ctx.suppliers.find(s => s.id === f.supplierId);
                openExpenses('contracts', {
                    kind: 'contract',
                    data: {
                        supplierId: matchedS?.id || f.supplierId || '',
                        number: f.number && f.number !== 'б/н' ? f.number : '',
                        date: f.date || ctx.today,
                        validFrom: f.date || ctx.today,
                        subject: f.subject || '',
                        type: 'monthly',
                        monthlyKop: f.amountKop || null
                    }
                });
            }
            else if (a === 'new-doc') openExpenses('docs', { kind: 'doc', data: {} });
            else if (a === 'new-contract') openExpenses('contracts', { kind: 'contract', data: {} });
            else if (a === 'new-supplier') openExpenses('suppliers', { kind: 'supplier', data: {} });
            else if (a === 'open-asset' && doc?.assetId) openAssets('all', doc.assetId);
            else if (a === 'edit-doc') openExpenses('docs', { kind: 'doc', data: doc });
            else if (a === 'edit-contract') openExpenses('contracts', { kind: 'contract', data: con });
            else if (a === 'edit-supplier') openExpenses('suppliers', { kind: 'supplier', data: sup });
            else if (a === 'save-doc') await saveDoc(btn);
            else if (a === 'save-contract') await saveContract(btn);
            else if (a === 'check-supplier') await checkSupplierEdr(btn);
            else if (a === 'save-youscore-key') await saveYouscoreKey(btn);
            else if (a === 'save-supplier') await saveSupplier(btn);
            else if (a === 'approve-doc') await decideExpense(doc, true);
            else if (a === 'reject-doc') await decideExpense(doc, false);
            else if (a === 'approve-contract') await decideContract(con, true);
            else if (a === 'reject-contract') await decideContract(con, false);
            else if (a === 'pay-doc') {
                if (!await confirmDialog('Сплатити документ?', `${doc.supplierName}: ${fmtKop(remaining(doc))} грн. Платіж зʼявиться в Приват24 й чекатиме підпису КЕП голови.`, 'Сплатити')) return;
                setBusy(btn, true, 'Відправляю…');
                await payExpense(doc);
            } else if (a === 'merge-doc') {
                const to = ctx.expenses.find(x => x.id === btn.dataset.to);
                if (!await confirmDialog('Обʼєднати документи?', `${docName(doc)} стане підтвердним до ${docName(to)}: витрата й борг постачальнику — один раз, ${fmtKop(to.amountKop)} грн.`, 'Обʼєднати')) return;
                setBusy(btn, true, 'Обʼєдную…');
                await expAct({ action: 'linkExisting', id: doc.id, to: to.id });
                selected = to.id;
                toast('Обʼєднано: одна послуга — одна витрата', 'success');
            } else if (a === 'attach-doc') { attaching = doc.id; stornoing = null; loadExpensesView(); }
            else if (a === 'storno-doc') { stornoing = doc.id; attaching = null; loadExpensesView(); }
            else if (a === 'inline-close') { attaching = null; stornoing = null; loadExpensesView(); }
            else if (a === 'attach-save') {
                setBusy(btn, true, 'Привʼязую…');
                await expAct({ action: 'linkExisting', id: doc.id, to: val('atMain') });
                attaching = null;
                toast('Документ став підтвердним: витрата не дублюється', 'success');
            } else if (a === 'storno-save') {
                const amount = toKop(val('stAmount'));
                if (!amount || amount <= 0) { toast('Вкажіть суму сторно', 'error'); return; }
                setBusy(btn, true, 'Проводжу…');
                const picked = [...(document.getElementById('stFiles')?.files || [])];
                const up = picked.length ? await uploadExpenseFiles(picked) : [];
                const r = await expAct({ action: 'storno', id: doc.id, amountKop: amount, date: val('stDate'), number: val('stNumber'), reason: val('stReason'), files: up });
                stornoing = null;
                toast(r.overpaidKop ? `Сторно проведено. Постачальник винен ОСББ ${fmtKop(r.overpaidKop)} грн — чекайте повернення на рахунок` : 'Сторно проведено', 'success');
            } else if (a === 'cancel-doc') {
                if (!await confirmDialog('Скасувати документ?', `${doc.supplierName}, № ${doc.number}. Його не буде оплачено; запис лишиться в журналі.`, 'Скасувати документ')) return;
                await expAct({ action: 'cancelExpense', id: doc.id });
                toast('Документ скасовано', 'success');
            } else if (a === 'end-contract') {
                const date = await promptDialog('Завершити договір', `№ ${con.number} з ${con.supplierName}. Вкажіть останній день дії (РРРР-ММ-ДД).`, { confirmLabel: 'Завершити', placeholder: ctx.today, maxLength: 10 });
                if (!date) return;
                await expAct({ action: 'endContract', id: con.id, date });
                toast('Договір завершено', 'success');
            }
        } catch (err) { toast(err.message, 'error'); }
        finally { if (btn.isConnected) setBusy(btn, false); }
    });
    host.addEventListener('change', e => {
        const t = e.target;
        if (t.id === 'exRecogInput' && t.files?.length) { startWithFiles([...t.files]); return; }
        if (t.id === 'cfRecogInput' && t.files?.length) { files = [...t.files]; recognizeUploadedDocument(t.files[0], 'contract'); return; }
        if (t.id === 'dcPick') { startWithFiles([...t.files]); return; }
        if (t.id === 'dfFiles' || t.id === 'cfFiles') {
            files = [...t.files];
            if (t.files?.[0] && !val('dfNumber') && !val('dfAmount')) {
                recognizeUploadedDocument(t.files[0], t.id === 'cfFiles' ? 'contract' : 'doc');
            }
            return;
        }
        if ((t.id === 'dfSupplier' || t.id === 'cfSupplier') && t.value === '__new') {
            const back = snapshotForm();
            const s = form?.data?.suggestedSupplier || {};
            form = {
                kind: 'supplier',
                data: {
                    name: s.name || '',
                    code: s.code || '',
                    iban: s.iban || '',
                    kind: (s.code || '').length === 10 ? 'fop' : 'company'
                },
                back
            };
            loadExpensesView();
            return;
        }
        if (t.id === 'dfSupplier') {
            const supplierId = t.value;
            form = snapshotForm();
            form.data.supplierId = supplierId;
            form.data.contractId = '';
            const contracts = ctx.contracts.filter(c => c.supplierId === supplierId && c.status !== 'rejected');
            const contractSelect = document.getElementById('dfContract');
            if (contractSelect) {
                contractSelect.innerHTML = `<option value="">Без договору</option>${contracts.map(c =>
                    `<option value="${escapeHtml(c.id)}">№ ${escapeHtml(c.number)} від ${human(c.date)} — ${escapeHtml(c.subject)}${c.status === 'pending' ? ' (не затверджено)' : ''}</option>`).join('')}`;
                contractSelect.value = '';
            }
            return;
        }
        if (t.id === 'dfContract' && t.value) {
            // Договір підставляє статтю, суму на місяць і опис.
            const c = contractOf(t.value);
            if (c) {
                if (!val('dfAmount') && c.monthlyKop) document.getElementById('dfAmount').value = money2(c.monthlyKop);
                document.getElementById('dfItem').value = c.item;
                if (c.type === 'monthly') document.getElementById('dfType').value = 'act';
                if (!val('dfDesc')) document.getElementById('dfDesc').value = `${c.subject} за ${periodName(val('dfPeriod'))}`;
            }
        }
        if (t.id === 'dfPosting') {
            const assetInput = document.getElementById('dfAsset');
            const ownedBox = document.getElementById('dfOwned');
            if (t.value === '92') {
                if (assetInput) assetInput.value = '';
                if (ownedBox) ownedBox.checked = false;
            } else {
                if (ownedBox) ownedBox.checked = true;
                if (assetInput && (!assetInput.value || /^(ОЗ|МНМА|ТМЦ|МШП)-\d+$/i.test(assetInput.value))) {
                    assetInput.value = suggestAssetId(t.value, allExistingAssetIds());
                }
            }
        }
        if (t.id === 'sfKind') document.getElementById('sfFopRow').hidden = t.value !== 'fop';
        if (t.id?.startsWith('cf')) contractHint();
    });
    host.addEventListener('input', e => {
        if (e.target.id === 'exQuery') { query = e.target.value; const pos = e.target.selectionStart; loadExpensesView().then(() => { const q = document.getElementById('exQuery'); q?.focus(); q?.setSelectionRange(pos, pos); }); }
        if (e.target.id?.startsWith('cf')) contractHint();
    });
    // Перетягнути файл можна на будь-яке місце розділу документів.
    const docsTab = () => segment === 'work' || segment === 'archive';
    host.addEventListener('dragover', e => {
        if (!docsTab() || !e.dataTransfer?.types?.includes('Files')) return;
        e.preventDefault();
        document.getElementById('dcDrop')?.classList.add('is-over');
    });
    host.addEventListener('dragleave', e => { if (!host.contains(e.relatedTarget)) document.getElementById('dcDrop')?.classList.remove('is-over'); });
    host.addEventListener('drop', e => {
        if (!docsTab() || !e.dataTransfer?.files?.length) return;
        e.preventDefault();
        startWithFiles([...e.dataTransfer.files]);
    });
    host.addEventListener('keydown', e => {
        if (e.key !== 'Enter' || !e.target.closest('#exForm') || e.target.matches('textarea, select, [type="file"]')) return;
        e.preventDefault();
        document.querySelector('#exForm [data-act^="save-"]')?.click();
    });
}