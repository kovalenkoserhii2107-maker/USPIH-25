// ============================================================
// Виписка іншого банку файлом: рахунок → файл → перевірка → імпорт.
// Розбір — у браузері (statement-import-core.js), перевірка й
// рознесення — на сервері тим самим шляхом, що й виписка ПриватБанку.
// ============================================================
import { escapeHtml, toast, setBusy } from './ui.js';
import { act, loadSettings, money, maskIban, ACCOUNT_PURPOSES } from './buh-data.js';
import { parse1C, parseCamt, parseTable, detectColumns, detectFormat, checkStatement, bankOf, validIban, normIban, COLUMNS } from './statement-import-core.js';

const FORMAT = { '1c': 'Файл обміну 1С', camt053: 'ISO 20022 camt.053', table: 'Таблиця' };
const human = d => (d ? d.split('-').reverse().join('.') : '—');

let state = null; // { accounts, iban, file, sheets, statement, check, adding, onDone }

/** Рахунки, які ведуться виписками файлом. */
const fileAccounts = settings => Object.entries(settings?.accounts || {}).filter(([, a]) => a.source === 'file')
    .map(([iban, a]) => ({ iban, ...a }));

export async function openStatementImport({ iban = '', onDone } = {}) {
    const settings = await loadSettings();
    const accounts = fileAccounts(settings);
    state = { accounts, iban: iban || accounts[0]?.iban || '', adding: !accounts.length, onDone, statement: null, file: null, sheets: null, map: null };
    render();
}

function host() {
    let el = document.getElementById('stmtSheet');
    if (!el) {
        el = document.createElement('div');
        el.id = 'stmtSheet';
        el.className = 'chs-wrap st-sheet';
        el.hidden = true;
        document.body.appendChild(el);
        el.addEventListener('click', onClick);
        el.addEventListener('change', onChange);
        el.addEventListener('submit', onSubmit);
        document.addEventListener('keydown', e => { if (e.key === 'Escape' && !el.hidden && !document.querySelector('.confirm-overlay')) close(); });
    }
    return el;
}

function close() {
    const el = host();
    el.hidden = true;
    el.innerHTML = '';
    state = null;
    document.body.classList.remove('chs-open');
}

function accountHtml() {
    const options = state.accounts.map(a => `<option value="${escapeHtml(a.iban)}"${a.iban === state.iban ? ' selected' : ''}>${escapeHtml(a.bank || bankOf(a.iban))} · ${escapeHtml(maskIban(a.iban))}${a.name ? ` · ${escapeHtml(a.name)}` : ''}</option>`).join('');
    const add = state.adding ? `<form class="st-add" data-form="add">
            <p class="st-note">${state.accounts.length ? 'Новий рахунок в іншому банку.' : 'Спершу додайте рахунок, з якого виписка.'} Банк визначається за IBAN.</p>
            <label class="py-field"><span>IBAN рахунку ОСББ</span><input name="iban" maxlength="40" autocomplete="off" spellcheck="false" placeholder="UA…" required></label>
            <label class="py-field"><span>Назва (необовʼязково)</span><input name="name" maxlength="80" placeholder="Напр.: Ощадбанк, ремонтний фонд"></label>
            <label class="py-field"><span>Призначення</span><select name="purpose" class="field-select">${Object.entries(ACCOUNT_PURPOSES).map(([k, t]) => `<option value="${k}">${t}</option>`).join('')}</select></label>
            <p class="st-bank" data-bank-hint></p>
            <div class="st-row"><button type="submit" class="sv-btn">Додати рахунок</button>${state.accounts.length ? '<button type="button" class="sv-btn is-soft" data-act="add-cancel">Скасувати</button>' : ''}</div>
        </form>` : '';
    return `<section class="chs-head st-step">
        <h3><span class="st-num">1</span>Рахунок</h3>
        ${state.accounts.length ? `<select class="field-select" data-pick="account" aria-label="Рахунок">${options}</select>` : ''}
        ${!state.adding ? '<button type="button" class="se-a" data-act="add">+ рахунок в іншому банку</button>' : ''}
        ${add}
    </section>`;
}

function fileHtml() {
    if (!state.iban || state.adding) return '';
    return `<section class="chs-head st-step">
        <h3><span class="st-num">2</span>Файл виписки</h3>
        <p class="st-note">Вивантажте виписку за місяць в інтернет-банку: <b>1С (TXT)</b>, <b>XML camt.053</b>, <b>Excel (XLSX)</b> або <b>CSV</b>. Повторне завантаження тієї ж виписки операцій не задвоює.</p>
        <label class="sv-btn is-soft st-file"><input type="file" data-pick="file" accept=".txt,.xml,.csv,.tsv,.xlsx" hidden>${state.file ? 'Інший файл' : 'Обрати файл'}</label>
        ${state.file ? `<small class="st-note">${escapeHtml(state.file.name)}</small>` : ''}
    </section>`;
}

function mappingHtml(st) {
    if (st.format !== 'table') return '';
    const heads = st.table.headers;
    const opt = (key) => `<option value="">— немає —</option>${heads.map((h, i) => `<option value="${i}"${String(st.table.map[key] ?? '') === String(i) ? ' selected' : ''}>${escapeHtml(h || `Колонка ${i + 1}`)}</option>`).join('')}`;
    return `<details class="st-map"${st.rows.length ? '' : ' open'}><summary>Колонки таблиці</summary>
        <div class="st-map-grid">${Object.entries(COLUMNS).map(([k, label]) => `<label class="py-field"><span>${label}</span><select class="field-select" data-col="${k}">${opt(k)}</select></label>`).join('')}</div></details>`;
}

function previewHtml() {
    const st = state.statement;
    if (!st) return state.error ? `<section class="chs-head st-step is-bad"><b>Не вдалося прочитати файл</b><p class="st-note">${escapeHtml(state.error)}</p>${state.sheets ? mappingStub() : ''}</section>` : '';
    const c = state.check;
    const balance = (label, kop) => `<div><dt>${label}</dt><dd>${kop === null ? '—' : money(kop)}</dd></div>`;
    return `<section class="chs-head st-step${c.problems.length ? ' is-bad' : ''}">
        <h3><span class="st-num">3</span>Перевірка</h3>
        <dl class="st-facts">
            <div><dt>Формат</dt><dd>${FORMAT[st.format]}</dd></div>
            <div><dt>Період</dt><dd>${human(st.from)} — ${human(st.to)}</dd></div>
            <div><dt>Операцій</dt><dd>${st.rows.length}</dd></div>
            <div><dt>Надійшло</dt><dd class="is-in">+${money(c.inKop)}</dd></div>
            <div><dt>Списано</dt><dd>−${money(c.outKop)}</dd></div>
            ${balance('Вхідний залишок', st.openingKop)}${balance('Вихідний залишок', st.closingKop)}
        </dl>
        ${c.problems.length ? `<ul class="st-problems">${c.problems.map(p => `<li>${escapeHtml(p)}</li>`).join('')}</ul>`
            : st.closingKop === null ? '<p class="st-note">У файлі немає вихідного залишку: місяць доведеться звірити, ввівши залишок вручну.</p>'
            : `<p class="st-ok">✓ Залишки сходяться: ${money(st.openingKop ?? 0)} ${c.inKop - c.outKop >= 0 ? '+' : '−'} ${money(Math.abs(c.inKop - c.outKop))} = ${money(st.closingKop)}</p>`}
        ${st.warnings.map(w => `<p class="st-note">${escapeHtml(w)}</p>`).join('')}
        ${mappingHtml(st)}
        ${st.rows.length ? `<div class="st-rows">${st.rows.slice(0, 8).map(r => `<div class="st-r"><span>${human(r.date)}</span><b class="${r.direction === 'in' ? 'is-in' : ''}">${r.direction === 'in' ? '+' : '−'}${money(r.amountKop)}</b>
            <small>${escapeHtml(r.name || '—')}${r.purpose ? ` · ${escapeHtml(r.purpose)}` : ''}</small></div>`).join('')}
            ${st.rows.length > 8 ? `<p class="st-note">…ще ${st.rows.length - 8}</p>` : ''}</div>` : ''}
    </section>
    <div class="chs-actions st-actions"><button type="button" class="sv-btn" data-act="import"${c.problems.length ? ' disabled' : ''}>Завантажити ${st.rows.length} ${st.rows.length === 1 ? 'операцію' : st.rows.length < 5 ? 'операції' : 'операцій'}</button></div>`;
}

// Таблицю не розпізнано автоматично — даємо обрати колонки на заголовках першого рядка.
function mappingStub() {
    const sheet = state.sheets[0];
    const heads = (sheet.rows[0] || []).map(String);
    return `<div class="st-map-grid">${Object.entries(COLUMNS).map(([k, label]) => `<label class="py-field"><span>${label}</span><select class="field-select" data-col="${k}">
        <option value="">— немає —</option>${heads.map((h, i) => `<option value="${i}">${escapeHtml(h || `Колонка ${i + 1}`)}</option>`).join('')}</select></label>`).join('')}</div>`;
}

function render() {
    const el = host();
    el.innerHTML = `<div class="chs-backdrop" data-act="close"></div>
        <aside class="chs-sheet" role="dialog" aria-modal="true" aria-label="Виписка іншого банку" tabindex="-1">
            <div class="chs-bar"><span></span><span class="chs-bar-title">Виписка іншого банку</span>
                <button type="button" class="chs-icon" data-act="close" aria-label="Закрити">×</button></div>
            <div class="chs-body">${accountHtml()}${fileHtml()}${previewHtml()}</div>
        </aside>`;
    el.hidden = false;
    document.body.classList.add('chs-open');
}

// ------------------------------------------------------------
// ЧИТАННЯ ФАЙЛУ
// ------------------------------------------------------------
function decode(buffer) {
    const head = new TextDecoder('latin1').decode(buffer.slice(0, 200));
    if (/encoding=["']?(windows-1251|cp1251)/i.test(head) || /Кодировка=Windows/.test(new TextDecoder('windows-1251').decode(buffer.slice(0, 400)))) return new TextDecoder('windows-1251').decode(buffer);
    try { return new TextDecoder('utf-8', { fatal: true }).decode(buffer); } catch { return new TextDecoder('windows-1251').decode(buffer); }
}

async function readFile(file) {
    if (file.size > 6 * 1024 * 1024) throw new Error('Файл більший за 6 МБ — вивантажте виписку за коротший період');
    if (/\.xlsx$/i.test(file.name)) {
        const { readImportFile } = await import('./migration-workbook.js');
        return { sheets: await readImportFile(file, 'stmt') };
    }
    const text = decode(await file.arrayBuffer());
    const format = detectFormat(file.name, text);
    if (format === '1c') return { statement: parse1C(text, state.iban) };
    if (format === 'camt053') return { statement: parseCamt(text) };
    const { parseDelimited } = await import('./migration-import-core.js');
    return { sheets: [{ rows: parseDelimited(text).rows }] };
}

function parseSheets(map) {
    const sheets = state.sheets || [];
    if (map) return parseTable(sheets[0].rows, { header: state.map?.header ?? 0, map, ownIban: state.iban });
    const found = sheets.find(sh => detectColumns(sh.rows));
    if (!found) throw new Error('Не знайдено колонок «Дата» і «Сума» (або «Дебет»/«Кредит»). Оберіть колонки нижче');
    if (found !== sheets[0]) state.sheets = [found, ...sheets.filter(s => s !== found)];
    return parseTable(found.rows, { ownIban: state.iban });
}

function setStatement(st) {
    state.statement = st;
    state.error = '';
    state.map = st.table ? { header: st.table.header } : null;
    state.check = checkStatement(st, { iban: state.iban });
}

async function onChange(e) {
    const t = e.target;
    if (t.dataset.pick === 'account') { state.iban = t.value; state.statement = null; state.file = null; state.error = ''; render(); return; }
    if (t.dataset.pick === 'file' && t.files?.[0]) {
        state.file = t.files[0];
        state.statement = null; state.sheets = null; state.error = '';
        try {
            const r = await readFile(state.file);
            state.sheets = r.sheets || null;
            setStatement(r.statement || parseSheets());
        } catch (err) { state.error = err.message; }
        render();
        return;
    }
    if (t.dataset.col) {
        const map = {};
        host().querySelectorAll('[data-col]').forEach(s => { if (s.value !== '') map[s.dataset.col] = Number(s.value); });
        try { setStatement(parseSheets(map)); } catch (err) { state.statement = null; state.error = err.message; }
        render();
    }
}

async function onSubmit(e) {
    const form = e.target.closest('[data-form="add"]');
    if (!form) return;
    e.preventDefault();
    const iban = normIban(form.iban.value);
    if (!validIban(iban)) { toast('Перевірте IBAN: UA і 27 цифр, контрольна сума не сходиться', 'error'); return; }
    const btn = form.querySelector('[type="submit"]');
    setBusy(btn, true, 'Додаю…');
    try {
        const r = await act({ action: 'addAccount', iban, name: form.name.value, purpose: form.purpose.value });
        toast(`Додано рахунок: ${r.bank}`, 'success');
        const settings = await loadSettings();
        state.accounts = fileAccounts(settings);
        state.iban = iban;
        state.adding = false;
        render();
    } catch (err) { toast(err.message, 'error'); setBusy(btn, false); }
}

async function onClick(e) {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const a = btn.dataset.act;
    if (a === 'close') close();
    else if (a === 'add') { state.adding = true; render(); }
    else if (a === 'add-cancel') { state.adding = false; render(); }
    else if (a === 'import') {
        const st = state.statement;
        setBusy(btn, true, 'Завантажую й розношу…');
        try {
            const r = await act({ action: 'importStatement', iban: state.iban, fileName: state.file?.name || '', format: st.format,
                statement: { iban: st.iban, from: st.from, to: st.to, openingKop: st.openingKop, closingKop: st.closingKop, rows: st.rows } }, 300000);
            toast(`Нових операцій: ${r.added}${r.matched ? `, рознесено по квартирах: ${r.matched}` : ''}${r.duplicates ? `, уже були: ${r.duplicates}` : ''}${r.skipped ? `, до початку обліку: ${r.skipped}` : ''}`, 'success');
            const done = state.onDone;
            close();
            done?.();
        } catch (err) { toast(err.message, 'error'); setBusy(btn, false); }
    }
}

// Підказка банку під полем IBAN — одразу під час введення.
document.addEventListener('input', e => {
    if (e.target.name !== 'iban' || !e.target.closest('#stmtSheet')) return;
    const hint = document.querySelector('#stmtSheet [data-bank-hint]');
    const v = normIban(e.target.value);
    if (hint) hint.textContent = v.length >= 10 ? `${bankOf(v)}${v.length === 29 ? (validIban(v) ? ' · IBAN правильний' : ' · контрольна сума не сходиться') : ''}` : '';
});
