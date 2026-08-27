// ============================================================
// Вивантаження бази у файл Excel.
//
// Правління саме обирає, які поля потрібні й у якому порядку: звіт
// для нагадувань, звіт для бухгалтерії та реєстр для голосування —
// це різні набори колонок, і жоден зашитий набір не влаштує всіх.
//
// Порядок задається порядком у самому списку: галочка вмикає поле,
// стрілка піднімає його вище. Одна кнопка замість пари «вгору/вниз»
// — переставити можна все одно як завгодно, а кнопок удвічі менше.
// ============================================================
import { escapeHtml, toast, setBusy, parseMoney } from './ui.js';
import { fetchDirectory } from './directory.js';
import { buildXlsx, saveBlob } from './xlsx-write.js';

const ts = (v) => (v?.toDate ? v.toDate() : (v instanceof Date ? v : null));

const dmy = (v) => {
    const d = ts(v);
    if (!d) return '';
    const p = (n) => String(n).padStart(2, '0');
    return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()}`;
};

const STATUS = { confirmed: 'звірено', review: 'на розгляді', pending: 'не звірено' };
const BY = { apt: 'мешканцем', board: 'правлінням' };

// level: 'apt' — дані квартири, 'owner' — дані власника.
// num: true — записуємо числом, щоб в Excel працювали суми й сортування.
const FIELDS = [
    { key: 'apt',        label: 'Квартира',            level: 'apt',   num: true,  get: a => a.apt },
    { key: 'entrance',   label: 'Парадна',             level: 'apt',   num: true,  get: a => a.entrance },
    { key: 'area',       label: 'Площа, м²',           level: 'apt',   num: true,  get: a => a.area },
    { key: 'name',       label: 'Власник',             level: 'owner',             get: (a, o) => o?.name },
    { key: 'shareFrac',  label: 'Частка',              level: 'owner',             get: (a, o) => o?.shareFrac },
    { key: 'sharePerc',  label: 'Частка, %',           level: 'owner', num: true,  get: (a, o) => o?.sharePerc },
    { key: 'docInfo',    label: 'Документ',            level: 'owner',             get: (a, o) => o?.docInfo },
    { key: 'fileUrls',   label: 'Файли документа',     level: 'owner',             get: (a, o) => o?.fileUrls },
    { key: 'ownersCount',label: 'Кількість власників', level: 'apt',   num: true,  get: a => a.owners.length },
    { key: 'account',    label: 'Особовий рахунок',    level: 'apt',               get: a => a.personalAccount },
    { key: 'balance',    label: 'Борг / переплата',    level: 'apt',   num: true,  get: a => a.balance },
    { key: 'balanceAt',  label: 'Дата балансу',        level: 'apt',               get: a => dmy(a.balanceUpdatedAt) },
    { key: 'status',     label: 'Статус звірки',       level: 'apt',               get: a => STATUS[a.ownersStatus] || a.ownersStatus },
    { key: 'confirmedBy',label: 'Ким підтверджено',    level: 'apt',               get: a => BY[a.ownersConfirmedBy] || '' },
    { key: 'confirmedAt',label: 'Дата підтвердження',  level: 'apt',               get: a => dmy(a.ownersConfirmedAt) }
];

const DEFAULT = ['apt', 'entrance', 'area', 'name', 'shareFrac', 'docInfo'];

const FILTERS = {
    all:       { label: 'Усі квартири',        test: () => true },
    pending:   { label: 'Не звірені',          test: a => (a.ownersStatus || 'pending') === 'pending' },
    review:    { label: 'На розгляді',         test: a => a.ownersStatus === 'review' },
    confirmed: { label: 'Звірені',             test: a => a.ownersStatus === 'confirmed' },
    debt:      { label: 'З заборгованістю',    test: a => parseMoney(a.balance) < -0.005 }
};

// Порядок і вибір живуть тут: обидва задаються одним списком.
let order = FIELDS.map(f => f.key);
let chosen = new Set(DEFAULT);

// ------------------------------------------------------------
// ЗБІРКА РЯДКІВ
// ------------------------------------------------------------
const cellValue = (f, a, o) => {
    const v = f.get(a, o);
    if (v === undefined || v === null || v === '') return null;
    if (!f.num) return String(v);
    const n = parseMoney(v);
    return isFinite(n) ? n : String(v);
};

/**
 * @param {'owner'|'apt'} granularity рядок на власника чи на квартиру.
 *   У режимі «на квартиру» дані власників зводимо в один рядок через
 *   перенос: інакше квартира з трьома власниками зникла б із двома
 *   третинами своїх даних.
 */
export function buildRows(apts, keys, granularity) {
    const cols = keys.map(k => FIELDS.find(f => f.key === k)).filter(Boolean);
    const rows = [cols.map(f => f.label)];

    for (const a of apts) {
        if (granularity === 'owner' && a.owners.length) {
            a.owners.forEach(o => rows.push(cols.map(f =>
                cellValue(f, a, f.level === 'owner' ? o : null))));
        } else if (granularity === 'owner') {
            // Квартира без власників теж має потрапити у звіт — саме
            // такі й цікавлять того, хто складає нагадування.
            rows.push(cols.map(f => (f.level === 'owner' ? null : cellValue(f, a, null))));
        } else {
            rows.push(cols.map(f => {
                if (f.level !== 'owner') return cellValue(f, a, null);
                const parts = a.owners.map(o => f.get(a, o)).filter(v => v !== undefined && v !== null && v !== '');
                return parts.length ? parts.join('\n') : null;
            }));
        }
    }
    return rows;
}

// ------------------------------------------------------------
// ІНТЕРФЕЙС
// ------------------------------------------------------------
function render() {
    const host = document.getElementById('expFields');
    if (!host) return;
    host.innerHTML = order.map((key, i) => {
        const f = FIELDS.find(x => x.key === key);
        return `<div class="exp-field${chosen.has(key) ? ' is-on' : ''}" data-key="${key}">
            <label class="exp-pick">
                <input type="checkbox" ${chosen.has(key) ? 'checked' : ''} data-toggle="${key}">
                <span>${escapeHtml(f.label)}</span>
            </label>
            <span class="exp-level">${f.level === 'owner' ? 'власник' : 'квартира'}</span>
            <button type="button" class="exp-up" data-up="${key}" ${i === 0 ? 'disabled' : ''}
                    aria-label="Підняти вище">
                <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="18 15 12 9 6 15"></polyline></svg>
            </button>
        </div>`;
    }).join('');

    const n = chosen.size;
    const note = document.getElementById('expCount');
    if (note) note.textContent = n ? `Обрано полів: ${n}` : 'Не обрано жодного поля';
    const btn = document.getElementById('expRunBtn');
    if (btn) btn.disabled = !n;
}

async function run(btn) {
    const keys = order.filter(k => chosen.has(k));
    if (!keys.length) return;

    const granularity = document.querySelector('input[name="expGrain"]:checked')?.value || 'owner';
    const filterKey = document.getElementById('expFilter')?.value || 'all';

    setBusy(btn, true, 'Готуємо файл…');
    try {
        const all = await fetchDirectory();
        const apts = all.filter(FILTERS[filterKey]?.test || (() => true));
        if (!apts.length) {
            toast('За цим відбором немає жодної квартири', 'error');
            return;
        }

        const rows = buildRows(apts, keys, granularity);
        const today = dmy(new Date()).replace(/\./g, '-');
        const suffix = filterKey === 'all' ? '' : `_${filterKey}`;
        saveBlob(buildXlsx('База власників', rows), `uspih25_baza${suffix}_${today}.xlsx`);
        toast(`Готово: ${apts.length} квартир, ${rows.length - 1} рядків`, 'success');
    } catch (e) {
        console.error('Вивантаження бази:', e);
        toast('Не вдалося зібрати файл', 'error');
    } finally {
        setBusy(btn, false);
    }
}

export function initExportBase() {
    const host = document.getElementById('expFields');
    if (!host) return;

    const filter = document.getElementById('expFilter');
    if (filter) {
        filter.innerHTML = Object.entries(FILTERS)
            .map(([k, f]) => `<option value="${k}">${escapeHtml(f.label)}</option>`).join('');
    }

    // Делеговано: список перемальовується після кожної зміни порядку,
    // і слухачі на самих кнопках накопичувалися б.
    host.addEventListener('change', (e) => {
        const key = e.target.dataset?.toggle;
        if (!key) return;
        if (e.target.checked) chosen.add(key); else chosen.delete(key);
        render();
    });
    host.addEventListener('click', (e) => {
        const key = e.target.closest('[data-up]')?.dataset.up;
        if (!key) return;
        const i = order.indexOf(key);
        if (i > 0) {
            [order[i - 1], order[i]] = [order[i], order[i - 1]];
            render();
        }
    });

    document.getElementById('expRunBtn')?.addEventListener('click', function () { run(this); });
    render();
}
