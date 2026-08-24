// ============================================================
// Історія нарахувань і оплат по квартирі.
//
// Баланс у картці мешканця — це одне число «скільки винен зараз».
// Воно не пояснює, звідки взялося. Ця історія і є поясненням:
// що нарахували, що сплатили, коли.
//
// Записи лежать у apartments/{apt}/ledger — так само, як квитанції.
// Правління вивантажує їх файлом, мешканець лише читає.
// ============================================================
import { db, session } from './firebase.js';
import {
    collection, doc, getDocs, query, orderBy, writeBatch, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js";
import { escapeHtml, toast, setBusy, parseMoney, formatMoney } from './ui.js';
import { loadKnownApts } from './finance.js';

const MONTHS = ['січня', 'лютого', 'березня', 'квітня', 'травня', 'червня',
                'липня', 'серпня', 'вересня', 'жовтня', 'листопада', 'грудня'];
const MONTHS_NOM = ['Січень', 'Лютий', 'Березень', 'Квітень', 'Травень', 'Червень',
                    'Липень', 'Серпень', 'Вересень', 'Жовтень', 'Листопад', 'Грудень'];

const KIND = {
    charge:  { label: 'Нарахування', cls: 'lg-charge' },
    payment: { label: 'Оплата',      cls: 'lg-payment' }
};

// Слова, якими бухгалтерія називає ті самі дві речі.
const WORDS = {
    charge:  ['нарахування', 'нараховано', 'нарах', 'дебет', 'charge', '+'],
    payment: ['оплата', 'оплачено', 'сплачено', 'платіж', 'плата', 'кредит', 'payment', '-']
};

// ------------------------------------------------------------
// РОЗБІР ВИВАНТАЖЕННЯ
// ------------------------------------------------------------

/**
 * «01.08.2026», «1.8.26», «2026-08-01», з часом або без:
 * «18.08.2026 23:09». Час не обовʼязковий, але якщо він є —
 * бережемо: дві операції за одну добу інакше стали б у довільному
 * порядку. Повертає Date або null.
 */
export function parseLedgerDate(input) {
    let t = String(input || '').trim();
    let hh = 0, mi = 0;

    // Час відділяють по-різному: пробілом, комою, крапкою з комою, «·»
    const withTime = t.match(/^(.*?)[\s,·•]+(\d{1,2}):(\d{2})(?::\d{2})?$/);
    if (withTime) {
        t = withTime[1].trim();
        hh = +withTime[2]; mi = +withTime[3];
        if (hh > 23 || mi > 59) return null;
    }

    let y, mo, d;
    let m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    if (m) { [y, mo, d] = [+m[1], +m[2], +m[3]]; }
    else {
        m = t.match(/^(\d{1,2})[.\/-](\d{1,2})[.\/-](\d{2,4})$/);
        if (!m) return null;
        [d, mo, y] = [+m[1], +m[2], +m[3]];
        if (y < 100) y += 2000;
    }

    const date = new Date(y, mo - 1, d, hh, mi);
    // 32.13.2026 інакше «перекотилося б» у наступний місяць і тихо
    // потрапило б у базу неправильною датою.
    if (date.getFullYear() !== y || date.getMonth() !== mo - 1 || date.getDate() !== d) return null;
    return date;
}

export function detectKind(input) {
    const t = String(input || '').trim().toLowerCase();
    if (!t) return null;
    for (const [kind, words] of Object.entries(WORDS)) {
        if (words.some(w => t === w || (w.length > 2 && t.startsWith(w)))) return kind;
    }
    return null;
}

export const periodOf = (date) =>
    `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;

export const periodLabel = (p) => {
    const [y, m] = String(p).split('-').map(Number);
    return MONTHS_NOM[m - 1] ? `${MONTHS_NOM[m - 1]} ${y}` : String(p);
};

/**
 * Рядок: квартира ; дата ; тип ; сума ; примітка
 *
 * Роздільник — тільки крапка з комою або табуляція. Кома тут зайнята:
 * вона відділяє копійки. Спроба вгадати, чим саме розділені колонки,
 * вже одного разу дала «298;-1250,40» → квартиру 2981250 — більше
 * такого не робимо.
 */
export function parseLedgerLines(text) {
    const rows = [], errors = [];
    String(text || '').replace(/^﻿/, '').split(/\r?\n/).forEach((line, i) => {
        const raw = line.trim();
        if (!raw) return;
        const err = (why) => errors.push({ line: i + 1, raw, why });

        const cells = raw.split(/[;\t]/).map(c => c.trim().replace(/^"|"$/g, ''));
        if (cells.length < 4) return err('менше чотирьох колонок');

        const apt = cells[0].replace(/\D/g, '');
        if (!apt) return err('немає номера квартири');

        const date = parseLedgerDate(cells[1]);
        if (!date) return err('незрозуміла дата');

        const kind = detectKind(cells[2]);
        if (!kind) return err('незрозумілий тип операції');

        const amountRaw = cells[3];
        if (!/\d/.test(amountRaw)) return err('немає суми');
        const amount = Math.abs(parseMoney(amountRaw));
        if (!amount) return err('сума нульова');

        rows.push({
            apt, kind, amount,
            at: date,
            period: periodOf(date),
            note: (cells[4] || '').slice(0, 200)
        });
    });

    // Заголовок таблиці — не помилка бухгалтера, просто перший рядок.
    if (errors.length && /кварт|дата|тип|сума|apt|date/i.test(errors[0].raw)) errors.shift();
    return { rows, errors };
}

// ------------------------------------------------------------
// ЗВЕДЕННЯ
// ------------------------------------------------------------
export function summarizeLedger(entries) {
    const charged = entries.filter(e => e.kind === 'charge')
                           .reduce((s, e) => s + e.amount, 0);
    const paid = entries.filter(e => e.kind === 'payment')
                        .reduce((s, e) => s + e.amount, 0);
    return { charged, paid, diff: paid - charged, count: entries.length };
}

/** Періоди, що є в історії, від найновішого. */
export function periodsOf(entries) {
    return [...new Set(entries.map(e => e.period))].sort().reverse();
}

// ------------------------------------------------------------
// ЗАПИС (правління)
// ------------------------------------------------------------

/**
 * Ключ документа з самого змісту операції.
 *
 * Так повторне завантаження того самого файлу нічого не дублює:
 * записи просто перезаписують самі себе. Дві однакові операції в один
 * день — рідкість, але буває (двічі внесли по 500 грн), тому однакові
 * ключі в межах вивантаження розводимо суфіксом, а не склеюємо.
 */
function ledgerId(row, seen) {
    const d = row.at;
    const base = [
        `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`,
        row.kind,
        Math.round(row.amount * 100)
    ].join('-');
    const n = (seen.get(base) || 0) + 1;
    seen.set(base, n);
    return n === 1 ? base : `${base}-${n}`;
}

export async function saveLedger(rows) {
    const known = await loadKnownApts();

    const skipped = new Set();
    const usable = rows.filter(r => {
        if (known.size && !known.has(r.apt)) { skipped.add(r.apt); return false; }
        return true;
    });

    // Ключі рахуємо в межах кожної квартири окремо
    const seen = new Map();
    const perApt = new Map();
    usable.forEach(r => {
        if (!perApt.has(r.apt)) perApt.set(r.apt, new Map());
        const id = ledgerId(r, perApt.get(r.apt));
        seen.set(`${r.apt}/${id}`, r);
    });

    // Firestore не приймає більше 500 дій в одній пачці
    const items = [...seen.entries()];
    for (let i = 0; i < items.length; i += 400) {
        const batch = writeBatch(db);
        items.slice(i, i + 400).forEach(([key, r]) => {
            const [apt, id] = key.split('/');
            batch.set(doc(db, 'apartments', apt, 'ledger', id), {
                at: r.at, period: r.period, kind: r.kind,
                amount: r.amount, note: r.note, updatedAt: serverTimestamp()
            });
        });
        await batch.commit();
    }
    return { written: items.length, skipped: [...skipped] };
}

// ------------------------------------------------------------
// ЧИТАННЯ (мешканець)
// ------------------------------------------------------------
export async function fetchLedger(apt) {
    const snap = await getDocs(query(
        collection(db, 'apartments', String(apt), 'ledger'), orderBy('at', 'desc')
    ));
    return snap.docs.map(d => {
        const e = d.data();
        return {
            id: d.id, kind: e.kind, amount: Number(e.amount) || 0,
            note: e.note || '', period: e.period || '',
            at: e.at?.toDate ? e.at.toDate() : null
        };
    }).filter(e => e.at);
}

// ------------------------------------------------------------
// ЕКРАН МЕШКАНЦЯ
// ------------------------------------------------------------
let cache = null;          // усі записи квартири
let activePeriod = 'all';

const dayLabel = (d) => `${d.getDate()} ${MONTHS[d.getMonth()]}`;

function rowHtml(e) {
    const k = KIND[e.kind] || KIND.charge;
    return `<div class="lg-row">
        <span class="lg-dot ${k.cls}"></span>
        <span class="lg-main">
            <span class="lg-top">
                <b>${k.label}</b>
                <b class="lg-amount ${k.cls}">${formatMoney(e.amount)}<small> грн</small></b>
            </span>
            <span class="lg-meta">${escapeHtml(dayLabel(e.at))}${e.note ? ' · ' + escapeHtml(e.note) : ''}</span>
        </span>
    </div>`;
}

function summaryHtml(list) {
    const s = summarizeLedger(list);
    const sign = s.diff > 0.005 ? 'lg-plus' : s.diff < -0.005 ? 'lg-minus' : '';
    const word = s.diff > 0.005 ? 'Сплачено більше на'
               : s.diff < -0.005 ? 'Не вистачає' : 'Розраховано повністю';
    return `<div class="lg-summary">
        <div class="lg-stat">
            <span>Нараховано</span>
            <b>${formatMoney(s.charged)}</b>
        </div>
        <div class="lg-stat">
            <span>Сплачено</span>
            <b class="lg-payment">${formatMoney(s.paid)}</b>
        </div>
    </div>
    <div class="lg-diff ${sign}">
        ${word}${Math.abs(s.diff) > 0.005 ? ` <b>${formatMoney(Math.abs(s.diff))} грн</b>` : ''}
    </div>`;
}

function listHtml(list) {
    if (!list.length) return '<p class="list-empty">За цей період операцій не було</p>';
    // За «усі періоди» розбиваємо на місяці — суцільна стрічка на рік
    // не читається, а межа місяця тут головний орієнтир.
    if (activePeriod !== 'all') return `<div class="lg-list">${list.map(rowHtml).join('')}</div>`;

    let html = '', last = null;
    list.forEach(e => {
        if (e.period !== last) {
            last = e.period;
            html += `<div class="lg-month">${escapeHtml(periodLabel(e.period))}</div>`;
        }
        html += rowHtml(e);
    });
    return `<div class="lg-list">${html}</div>`;
}

function render() {
    const host = document.getElementById('ledgerContainer');
    if (!host) return;

    if (!cache.length) {
        host.innerHTML = `<div class="lg-empty">
            <svg viewBox="0 0 24 24" width="34" height="34" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="8" y1="13" x2="16" y2="13"></line><line x1="8" y1="17" x2="13" y2="17"></line></svg>
            <p class="lg-empty-title">Історія ще не завантажена</p>
            <p class="lg-empty-hint">Правління вносить нарахування та оплати вивантаженням з бухгалтерії. Щойно це станеться, вони зʼявляться тут.</p>
        </div>`;
        return;
    }

    const periods = periodsOf(cache);
    const list = activePeriod === 'all' ? cache : cache.filter(e => e.period === activePeriod);

    host.innerHTML = `
        <div class="lg-periods" id="lgPeriods">
            <button type="button" class="lg-period${activePeriod === 'all' ? ' active' : ''}" data-p="all">Усі</button>
            ${periods.map(p => `<button type="button" class="lg-period${activePeriod === p ? ' active' : ''}" data-p="${escapeHtml(p)}">${escapeHtml(periodLabel(p))}</button>`).join('')}
        </div>
        ${summaryHtml(list)}
        ${listHtml(list)}`;

    host.querySelector('#lgPeriods')?.addEventListener('click', (e) => {
        const b = e.target.closest('.lg-period');
        if (!b || b.dataset.p === activePeriod) return;
        activePeriod = b.dataset.p;
        render();
    });
}

export async function loadLedger() {
    const host = document.getElementById('ledgerContainer');
    if (!host) return;
    host.innerHTML = '<p class="list-empty">Завантаження…</p>';
    try {
        cache = await fetchLedger(session.apt);
        // Найновіший період відкриваємо одразу: він цікавить найчастіше.
        const periods = periodsOf(cache);
        if (activePeriod !== 'all' && !periods.includes(activePeriod)) activePeriod = 'all';
        render();
    } catch (e) {
        console.error('Історія нарахувань:', e);
        host.innerHTML = '<p class="list-empty">Не вдалося завантажити історію</p>';
    }
}

// ------------------------------------------------------------
// ЗАВАНТАЖУВАЧ (правління)
// ------------------------------------------------------------
let pending = { rows: [], errors: [] };

async function previewLedger(text) {
    const host = document.getElementById('ledgerPreview');
    pending = parseLedgerLines(text);
    if (!host) return;

    const { rows, errors } = pending;
    if (!rows.length && !errors.length) { host.innerHTML = ''; return; }

    const apts = new Set(rows.map(r => r.apt));
    // Звіряємо з базою одразу, а не після збереження: інакше правління
    // побачить «записів 5», натисне «Внести» — і лише тоді дізнається,
    // що одна квартира з файлу не існує.
    let unknown = [];
    try {
        const known = await loadKnownApts();
        if (known.size) unknown = [...apts].filter(a => !known.has(a));
    } catch (e) { /* немає звʼязку — просто без звірки */ }
    const periods = periodsOf(rows);
    const s = summarizeLedger(rows);
    const span = periods.length
        ? (periods.length === 1 ? periodLabel(periods[0])
           : `${periodLabel(periods[periods.length - 1])} — ${periodLabel(periods[0])}`)
        : '—';

    host.innerHTML = `<div class="lg-preview">
        <div class="lg-preview-grid">
            <div><span>Записів</span><b>${rows.length}</b></div>
            <div><span>Квартир</span><b>${apts.size}</b></div>
            <div><span>Нараховано</span><b>${formatMoney(s.charged)}</b></div>
            <div><span>Сплачено</span><b>${formatMoney(s.paid)}</b></div>
        </div>
        <p class="lg-preview-span">Період: ${escapeHtml(span)}</p>
        ${unknown.length ? `<p class="lg-preview-warn">Немає в базі: кв. ${escapeHtml(unknown.slice(0, 8).join(', '))}${unknown.length > 8 ? ` та ще ${unknown.length - 8}` : ''} — ці рядки не внесуться</p>` : ''}
        ${errors.length ? `<details class="lg-errors">
            <summary>Пропущено рядків: ${errors.length}</summary>
            ${errors.slice(0, 12).map(e =>
                `<div class="lg-error"><b>${e.line}</b> ${escapeHtml(e.why)} — <span>${escapeHtml(e.raw.slice(0, 60))}</span></div>`
            ).join('')}
            ${errors.length > 12 ? `<div class="lg-error">…та ще ${errors.length - 12}</div>` : ''}
        </details>` : ''}
    </div>`;
}

export async function applyLedger(btn) {
    if (!pending.rows.length) return toast('Немає жодного коректного рядка', 'error');

    setBusy(btn, true, 'Збереження…');
    try {
        const { written, skipped } = await saveLedger(pending.rows);
        if (!written) {
            toast('Жодна квартира з файлу не знайдена в базі', 'error');
        } else {
            toast(`Внесено записів: ${written}`, 'success');
            if (skipped.length) {
                toast(`Пропущено неіснуючі квартири: ${skipped.slice(0, 5).join(', ')}`, 'error');
            }
        }
    } catch (e) {
        console.error('Історія нарахувань:', e);
        toast('Не вдалося зберегти історію', 'error');
    } finally {
        setBusy(btn, false);
    }
}

export function initLedger() {
    const area = document.getElementById('ledgerBulk');
    area?.addEventListener('input', () => previewLedger(area.value));

    const file = document.getElementById('ledgerCsvFile');
    file?.addEventListener('change', async () => {
        const f = file.files?.[0];
        file.value = '';
        if (!f) return;
        try {
            const text = await f.text();
            if (area) area.value = text;
            previewLedger(text);
            toast('Файл прочитано — перевірте зведення нижче', 'success');
        } catch (e) {
            console.error('Читання файлу:', e);
            toast('Не вдалося прочитати файл', 'error');
        }
    });

    document.getElementById('applyLedgerBtn')?.addEventListener('click', function () { applyLedger(this); });
    // Делеговано: кнопку малює renderBalance уже після ініціалізації,
    // тож прямого елемента тут ще не існує.
    document.addEventListener('click', async (e) => {
        if (!e.target.closest('#openLedgerBtn')) return;
        const { showScreen } = await import('./ui.js');
        showScreen('ledgerSection');
        loadLedger();
    });
}
