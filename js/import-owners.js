// ============================================================
// Завантаження бази власників із файлу.
//
// Excel зберігає CSV двома кліками, тож формат саме такий — без
// бібліотек і розпакування архівів. Але «просто CSV» тут пастка:
// Excel з українською локаллю пише через КРАПКУ З КОМОЮ (бо кома —
// десятковий роздільник) і в WINDOWS-1251, а не UTF-8. Не врахувати
// це — отримати кракозябри замість прізвищ. Тому і роздільник, і
// кодування визначаємо самі.
//
// Одна квартира — кілька рядків, по рядку на власника. Дані самої
// квартири (парадна, площа, о/р, борг) беремо з першого рядка групи:
// повторювати їх у кожному не потрібно, але й не завадить.
// ============================================================
import { db } from './firebase.js';
import {
    collection, doc, getDocs, writeBatch
} from "https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js";
import { escapeHtml, toast, setBusy, parseMoney, normName } from './ui.js';
import { calculateShares } from './owners.js';
import { invalidateDirectory } from './directory.js';

// ------------------------------------------------------------
// ЧИТАННЯ ФАЙЛУ
// ------------------------------------------------------------
/**
 * Кодування визначаємо спробою: коректний UTF-8 майже ніколи не
 * буває випадковим, тож якщо сувора перевірка пройшла — це UTF-8,
 * а ні — значить однобайтова кирилиця з Excel.
 */
export function decodeBytes(buf) {
    const bytes = new Uint8Array(buf);
    if (bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) {
        return new TextDecoder('utf-8').decode(bytes.subarray(3));
    }
    try {
        return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
        return new TextDecoder('windows-1251').decode(bytes);
    }
}

/** Роздільник — той, якого більше в заголовку. */
export function detectDelimiter(firstLine) {
    const counts = [';', ',', '\t'].map(d => [d, firstLine.split(d).length - 1]);
    counts.sort((a, b) => b[1] - a[1]);
    return counts[0][1] > 0 ? counts[0][0] : ';';
}

/** Розбір CSV із лапками: усередині поля можуть бути і роздільник, і перенос. */
export function splitCsv(text, delim) {
    const rows = [];
    let row = [], field = '', quoted = false;
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (quoted) {
            if (c === '"') {
                if (text[i + 1] === '"') { field += '"'; i++; }
                else quoted = false;
            } else field += c;
            continue;
        }
        if (c === '"') { quoted = true; continue; }
        if (c === delim) { row.push(field); field = ''; continue; }
        if (c === '\r') continue;
        if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
        field += c;
    }
    row.push(field);
    if (row.some(v => v.trim())) rows.push(row);
    return rows.map(r => r.map(v => v.trim()));
}

// ------------------------------------------------------------
// РОЗПІЗНАВАННЯ СТОВПЦІВ
// ------------------------------------------------------------
// Назви колонок пишуть по-різному, і змушувати бухгалтера підганяти
// заголовок під наш зразок — зайва робота. Приймаємо синоніми.
const COLUMNS = {
    apt:     ['квартира', 'кв', 'номер квартири', 'номер кв', 'apt', 'номер'],
    entrance:['парадна', 'парадне', 'підїзд', 'підʼїзд', 'подъезд', 'entrance'],
    area:    ['площа', 'загальна площа', 'площадь', 'кв м', 'м2', 'area'],
    name:    ['власник', 'співвласник', 'піб', 'пiб', 'фіо', 'прізвище імя по батькові', 'name'],
    share:   ['частка', 'частка власності', 'доля', 'share'],
    doc:     ['документ', 'правовстановлюючий документ', 'підстава', 'док', 'doc'],
    account: ['особовий рахунок', 'ор', 'о р', 'лицевой счет', 'account'],
    debt:    ['борг', 'заборгованість', 'сальдо', 'баланс', 'debt'],
    debtDate:['дата', 'дата боргу', 'станом на', 'date']
};

const norm = (s) => String(s || '').toLowerCase()
    .replace(/[.’'"()]/g, '').replace(/[\s_/-]+/g, ' ').trim();

export function mapHeader(header) {
    const map = {};
    header.forEach((cell, i) => {
        const n = norm(cell);
        if (!n) return;
        for (const [key, aliases] of Object.entries(COLUMNS)) {
            if (map[key] !== undefined) continue;
            if (aliases.includes(n)) { map[key] = i; return; }
        }
    });
    return map;
}

// ------------------------------------------------------------
// РОЗБІР І ПЕРЕВІРКА
// ------------------------------------------------------------
const cell = (row, idx) => (idx === undefined ? '' : String(row[idx] || '').trim());

/**
 * Перетворює рядки на квартири з власниками й одразу збирає зауваження.
 *
 * Перевіряти після запису пізно: це база голосування, і кожна помилка
 * в частках змінює вагу голосу. Тому все, що викликає сумнів,
 * показуємо ДО того, як щось потрапить у базу.
 */
export function buildImport(rows) {
    if (!rows.length) return { apts: [], problems: [{ kind: 'error', text: 'Файл порожній' }], map: {} };

    const map = mapHeader(rows[0]);
    const problems = [];
    const missing = ['apt', 'name', 'share'].filter(k => map[k] === undefined);
    if (missing.length) {
        const titles = { apt: 'Квартира', name: 'Власник', share: 'Частка' };
        problems.push({ kind: 'error',
            text: `У заголовку не знайдено: ${missing.map(k => titles[k]).join(', ')}` });
        return { apts: [], problems, map };
    }

    const byApt = new Map();
    rows.slice(1).forEach((row, i) => {
        const line = i + 2;                       // рядок у файлі, як його бачить бухгалтер
        if (!row.some(v => v)) return;            // порожній рядок — не помилка

        const aptRaw = cell(row, map.apt);
        const apt = aptRaw.replace(/\D/g, '');
        if (!apt) {
            problems.push({ kind: 'error', line, text: `не вказано номер квартири` });
            return;
        }

        let a = byApt.get(apt);
        if (!a) {
            a = { apt, entrance: '', area: '', personalAccount: '', balance: null,
                  balanceDate: '', owners: [], lines: [] };
            byApt.set(apt, a);
        }
        a.lines.push(line);

        // Дані квартири — з першого рядка, де вони є
        const put = (key, val) => { if (val && !a[key]) a[key] = val; };
        put('entrance', cell(row, map.entrance));
        put('area', cell(row, map.area).replace(',', '.'));
        put('personalAccount', cell(row, map.account));
        put('balanceDate', cell(row, map.debtDate));
        const debtRaw = cell(row, map.debt);
        if (debtRaw && a.balance === null) a.balance = parseMoney(debtRaw);

        const name = cell(row, map.name);
        if (!name) {
            problems.push({ kind: 'error', line, text: `кв. ${apt}: не вказано власника` });
            return;
        }
        const shareRaw = cell(row, map.share);
        const share = calculateShares(shareRaw.replace('%', ''));
        if (!share.frac) {
            problems.push({ kind: 'error', line,
                text: `кв. ${apt}, ${name}: не вдалося прочитати частку «${shareRaw}»` });
            return;
        }
        if (a.owners.some(o => normName(o.name) === normName(name))) {
            problems.push({ kind: 'warn', line, text: `кв. ${apt}: ${name} у списку двічі` });
        }
        a.owners.push({
            name,
            shareFrac: share.frac,
            sharePerc: share.perc,
            docInfo: cell(row, map.doc),
            fileUrls: ''
        });
    });

    const apts = [...byApt.values()].sort((x, y) => (+x.apt) - (+y.apt));

    apts.forEach(a => {
        // Сума часток — найважливіша перевірка: саме вона визначає
        // вагу голосу квартири. Допуск 0,5% — на округлення в «33,33».
        const sum = a.owners.reduce((s, o) => s + parseFloat(o.sharePerc || 0), 0);
        if (a.owners.length && Math.abs(sum - 100) > 0.5) {
            a.shareWarn = true;
            problems.push({ kind: 'warn', line: a.lines[0],
                text: `кв. ${a.apt}: сума часток ${sum.toFixed(2).replace(/\.?0+$/, '')}% замість 100%` });
        }
        if (a.area && isNaN(parseFloat(a.area))) {
            problems.push({ kind: 'warn', line: a.lines[0], text: `кв. ${a.apt}: площа «${a.area}» не число` });
            a.area = '';
        }
        if (!a.owners.length) {
            problems.push({ kind: 'warn', line: a.lines[0], text: `кв. ${a.apt}: жодного власника` });
        }
    });

    return { apts, problems, map };
}

// ------------------------------------------------------------
// ЗАПИС
// ------------------------------------------------------------
/**
 * @param {boolean} overwriteConfirmed чи чіпати квартири, які мешканці
 *   вже звірили. За замовчуванням ні: повторний імпорт стер би роботу,
 *   яку люди зробили руками, і мовчки повернув старі дані.
 */
export async function writeImport(apts, overwriteConfirmed, onProgress) {
    const existing = await getDocs(collection(db, 'apartments'));
    const status = new Map();
    existing.forEach(d => status.set(d.id, d.data().ownersStatus || 'pending'));

    const skipped = [];
    const target = apts.filter(a => {
        if (!overwriteConfirmed && status.get(a.apt) === 'confirmed') { skipped.push(a.apt); return false; }
        return true;
    });

    let done = 0;
    for (const a of target) {
        const aptRef = doc(db, 'apartments', a.apt);
        const ownersRef = collection(db, 'apartments', a.apt, 'owners');

        // Старі записи прибираємо: імпорт замінює список, а не доповнює.
        // Інакше повторне завантаження подвоїло б власників — і голоси.
        const old = await getDocs(ownersRef);

        const batch = writeBatch(db);
        const aptData = { isAdmin: false };
        if (a.entrance) aptData.entrance = a.entrance;
        if (a.area) aptData.area = a.area;
        if (a.personalAccount) aptData.personalAccount = a.personalAccount;
        if (a.balance !== null) {
            aptData.balance = a.balance;
            const d = parseDate(a.balanceDate);
            aptData.balanceUpdatedAt = d || new Date();
        }
        // Список змінився — попередню звірку він скасовує: мешканець
        // підтверджував інші дані.
        if (status.get(a.apt) === 'confirmed') aptData.ownersStatus = 'pending';

        batch.set(aptRef, aptData, { merge: true });
        old.forEach(d => batch.delete(d.ref));
        a.owners.forEach(o => batch.set(doc(ownersRef), o));
        await batch.commit();

        done++;
        onProgress?.(done, target.length);
    }

    invalidateDirectory();
    return { written: target.length, skipped };
}

/** «24.08.2026» або «2026-08-24». Порожнє чи незрозуміле — null. */
export function parseDate(v) {
    const s = String(v || '').trim();
    if (!s) return null;
    let m = s.match(/^(\d{1,2})[.\/-](\d{1,2})[.\/-](\d{4})$/);
    if (m) return new Date(+m[3], +m[2] - 1, +m[1]);
    m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    if (m) return new Date(+m[1], +m[2] - 1, +m[3]);
    return null;
}

// ------------------------------------------------------------
// ІНТЕРФЕЙС
// ------------------------------------------------------------
let parsed = null;

const plural = (n, one, few, many) => {
    const m10 = n % 10, m100 = n % 100;
    if (m10 === 1 && m100 !== 11) return one;
    if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
    return many;
};

function renderPreview() {
    const host = document.getElementById('impPreview');
    if (!host) return;
    if (!parsed) { host.innerHTML = ''; return; }

    const { apts, problems, map } = parsed;
    const errors = problems.filter(p => p.kind === 'error');
    const warns = problems.filter(p => p.kind === 'warn');
    const owners = apts.reduce((s, a) => s + a.owners.length, 0);

    const found = Object.keys(map);
    const titles = { apt: 'Квартира', entrance: 'Парадна', area: 'Площа', name: 'Власник',
                     share: 'Частка', doc: 'Документ', account: 'О/р', debt: 'Борг', debtDate: 'Дата' };

    // Показуємо, ЩО саме розпізнано в заголовку: якщо колонка не
    // підхопилась, це видно одразу, а не після імпорту без площ.
    const cols = `<div class="imp-cols">${Object.keys(titles).map(k => `
        <span class="imp-col ${found.includes(k) ? 'is-on' : ''}">${titles[k]}</span>`).join('')}</div>`;

    const list = problems.slice(0, 60).map(p => `
        <div class="imp-issue imp-${p.kind}">
            ${p.line ? `<b>рядок ${p.line}</b>` : ''}${escapeHtml(p.text)}
        </div>`).join('');

    host.innerHTML = `
        <div class="imp-sum">
            <div class="imp-stat"><b>${apts.length}</b><span>${plural(apts.length, 'квартира', 'квартири', 'квартир')}</span></div>
            <div class="imp-stat"><b>${owners}</b><span>${plural(owners, 'власник', 'власники', 'власників')}</span></div>
            <div class="imp-stat ${errors.length ? 'is-bad' : ''}"><b>${errors.length}</b><span>помилок</span></div>
            <div class="imp-stat ${warns.length ? 'is-warn' : ''}"><b>${warns.length}</b><span>зауважень</span></div>
        </div>
        ${cols}
        ${problems.length ? `<div class="imp-issues">${list}
            ${problems.length > 60 ? `<div class="imp-issue">…і ще ${problems.length - 60}</div>` : ''}
        </div>` : '<p class="imp-ok">Помилок не знайдено</p>'}
        ${apts.length ? `<details class="imp-details">
            <summary>Показати перші 20 квартир</summary>
            <div class="imp-rows">${apts.slice(0, 20).map(a => `
                <div class="imp-row${a.shareWarn ? ' is-warn' : ''}">
                    <b>${escapeHtml(a.apt)}</b>
                    <span>${a.owners.map(o => `${escapeHtml(o.name)} — ${escapeHtml(o.shareFrac)}`).join('<br>') || '—'}</span>
                    <i>${a.area ? escapeHtml(a.area) + ' м²' : ''}</i>
                </div>`).join('')}</div>
        </details>` : ''}`;

    const btn = document.getElementById('impRunBtn');
    if (btn) btn.disabled = !apts.length;
}

async function readFile(file) {
    const text = decodeBytes(await file.arrayBuffer());
    const firstLine = text.split('\n', 1)[0] || '';
    const rows = splitCsv(text, detectDelimiter(firstLine));
    parsed = buildImport(rows);
    renderPreview();
    const errs = parsed.problems.filter(p => p.kind === 'error').length;
    toast(errs ? `Прочитано, але є ${errs} ${plural(errs, 'помилка', 'помилки', 'помилок')}`
               : `Прочитано ${parsed.apts.length} ${plural(parsed.apts.length, 'квартира', 'квартири', 'квартир')}`,
          errs ? 'error' : 'success');
}

async function run(btn) {
    if (!parsed?.apts.length) return;
    const overwrite = document.getElementById('impOverwrite')?.checked;
    const { confirmDialog } = await import('./ui.js');
    // Про пропущені рядки кажемо саме тут: далі шляху назад немає,
    // а мовчазна втрата власника — це втрачений голос.
    const errs = parsed.problems.filter(p => p.kind === 'error').length;
    const ok = await confirmDialog('Записати в базу?',
        `${parsed.apts.length} ${plural(parsed.apts.length, 'квартира', 'квартири', 'квартир')}. `
        + 'Наявні списки власників у цих квартирах буде замінено.'
        + (overwrite ? ' Разом зі звіреними.' : ' Звірені мешканцями — пропущено.')
        + (errs ? ` ${errs} ${plural(errs, 'рядок', 'рядки', 'рядків')} з помилками не буде записано.` : ''),
        'Записати');
    if (!ok) return;

    setBusy(btn, true, 'Запис…');
    try {
        const res = await writeImport(parsed.apts, overwrite,
            (done, total) => setBusy(btn, true, `Запис ${done} із ${total}…`));
        toast(`Записано ${res.written}`
            + (res.skipped.length ? `, пропущено звірених: ${res.skipped.length}` : ''), 'success');
        const { loadDirectory } = await import('./directory.js');
        loadDirectory();
    } catch (e) {
        console.error('Імпорт власників:', e);
        toast('Не вдалося записати. Перевірте інтернет і спробуйте ще раз.', 'error');
    } finally {
        setBusy(btn, false);
    }
}

export function initImportOwners() {
    const input = document.getElementById('impFile');
    input?.addEventListener('change', () => {
        const f = input.files?.[0];
        if (f) readFile(f).catch(e => {
            console.error('Читання файлу:', e);
            toast('Не вдалося прочитати файл', 'error');
        });
    });
    document.getElementById('impRunBtn')?.addEventListener('click', function () { run(this); });
}
