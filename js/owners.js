// ============================================================
// Співвласники квартири: показ, редагування, документи.
// ============================================================
import { db, storage, session, currentApt } from './firebase.js';
import {
    collection, getDocs, doc, addDoc, updateDoc, serverTimestamp, writeBatch
} from "https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js";
import {
    ref as sRef, uploadBytes, getDownloadURL
} from "https://www.gstatic.com/firebasejs/10.8.1/firebase-storage.js";
import { escapeHtml, getInitials, avatarGradient, avatarColors, toast, confirmDialog,
         promptDialog, setBusy, normName } from './ui.js';
import { renderAttachments, renderFileManager, fileNameFromUrl } from './attachments.js';

const PRESETS = ['1/1', '1/2', '1/3', '1/4', '2/3', '1/5'];

// Кожне кільце має власний <linearGradient>, тож id мусять бути унікальні
// в межах сторінки — інакше всі картки візьмуть барву першої.
let ringSeq = 0;

function gcd(a, b) { return b ? gcd(b, a % b) : a; }

/** Приймає дріб (1/6) або відсоток (15) і повертає обидва подання. */
export function calculateShares(input) {
    const raw = String(input || '').trim().replace(',', '.');
    if (!raw) return { frac: '', perc: '' };

    if (raw.includes('/')) {
        const [n, d] = raw.split('/').map(v => parseFloat(v));
        if (!n || !d) return { frac: '', perc: '' };
        const divisor = gcd(n, d);
        return { frac: `${n / divisor}/${d / divisor}`, perc: ((n / d) * 100).toFixed(2).replace(/\.00$/, '') };
    }

    const perc = parseFloat(raw);
    if (isNaN(perc) || perc <= 0) return { frac: '', perc: '' };
    const denominator = 10000;
    const numerator = Math.round(perc * 100);
    const divisor = gcd(numerator, denominator);
    return { frac: `${numerator / divisor}/${denominator / divisor}`, perc: String(perc) };
}

// Модуль обслуговує два екрани: кабінет мешканця і редактор правління.
// Різняться вони лише тим, ДЕ малювати і ЧИЮ квартиру правити.
let hostId = 'ownersContainer';
let targetApt = null;                  // null — квартира самого мешканця

const container = () => document.getElementById(hostId);
const workingApt = () => targetApt || currentApt();

/** Перемикає модуль на інший екран і квартиру. Без аргументів — назад до мешканця. */
export function useOwnersTarget({ host = 'ownersContainer', apt = null } = {}) {
    hostId = host;
    targetApt = apt;
}

export const isBoardEditing = () => targetApt !== null;

// ------------------------------------------------------------
// ЗАВАНТАЖЕННЯ
// ------------------------------------------------------------
/**
 * Малює список із заявки, що на розгляді: додані й прибрані — з мітками.
 * Повертає false, якщо заявки немає (тоді показуємо звичайний список).
 */
async function renderProposed(apt) {
    try {
        const snap = await getDocs(collection(db, 'apartments', apt, 'owner_changes'));
        const req = snap.docs
            .map(d => d.data())
            .filter(c => c.status === 'pending')
            .sort((a, b) => (b.createdAt?.toMillis?.() || 0) - (a.createdAt?.toMillis?.() || 0))[0];
        if (!req) return false;

        const key = (o) => normName(o.name);
        const wasNames = new Set((req.before || []).map(key));
        const nowNames = new Set((req.after || []).map(key));

        // Для порівняння «чи змінилися дані» шукаємо ту саму людину в «було»
        const beforeBy = new Map((req.before || []).map(o => [key(o), o]));
        const same = (a, b) => a.shareFrac === b.shareFrac && a.docInfo === b.docInfo
            && String(a.fileUrls || '') === String(b.fileUrls || '');

        let i = 1;
        (req.after || []).forEach(o => {
            const card = renderOwnerCard(o, i++, false);
            if (!wasNames.has(key(o))) markCard(card, 'add');
            else if (!same(beforeBy.get(key(o)) || {}, o)) markCard(card, 'edit');
        });
        // Ті, кого прибирають, показуємо в кінці — з міткою
        (req.before || []).filter(o => !nowNames.has(key(o))).forEach(o => {
            const card = renderOwnerCard(o, 0, false);
            markCard(card, 'remove');
        });
        renumberOwners();
        return true;
    } catch (e) {
        console.warn('Заявка на зміну власників:', e);
        return false;
    }
}

export async function loadOwners(apt) {
    const host = container();
    host.innerHTML = '';
    dirty = false;

    // Поки заявку розглядають, показуємо ЗАПРОПОНОВАНИЙ список, а не той,
    // що в базі. Інакше після перезавантаження мешканець не бачить ні
    // доданого співвласника, ні позначки на прибраному — і вирішує, що
    // заявка пропала.
    if (!isBoardEditing() && session.ownersStatus === 'review' && await renderProposed(apt)) {
        updateOwnersCount();
        setOwnersBaseline();
        renderOwnersStatus();
        return;
    }

    const snap = await getDocs(collection(db, 'apartments', apt, 'owners'));

    if (snap.empty) {
        host.innerHTML = `<div class="empty-state">
            <span class="empty-icon"><svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path><circle cx="12" cy="7" r="4"></circle></svg></span>
            <p>Співвласників ще не додано</p>
            <span class="empty-hint">Натисніть «+», щоб внести дані про власність</span>
        </div>`;
    } else {
        let i = 1;
        snap.forEach(d => renderOwnerCard({ id: d.id, ...d.data() }, i++, false));
    }
    updateOwnersCount();
    setOwnersBaseline();
    renderOwnersStatus();
}

export function updateOwnersCount() {
    const el = document.getElementById('displayOwnersCount');
    if (!el) return;
    // Рахуємо тих, хто є власником ЗАРАЗ, а не тих, хто буде після
    // заявки. Прибраний лишається власником, доки правління не
    // вирішило, а доданий ще ним не став — інакше кількість у картці
    // квартири міняється раніше за саме рішення.
    const count = container().querySelectorAll(
        '.owner-card:not([data-new="1"]):not(.owner-pending-add)').length;
    el.textContent = count > 0 ? count : '—';
}

// ------------------------------------------------------------
// ДОДАВАННЯ
// Захист від багу «кілька форм одночасно»: якщо незбережена
// картка вже відкрита — просто прокручуємо до неї.
// ------------------------------------------------------------
export function addOwner() {
    const existingNew = container().querySelector('.owner-card[data-new="1"]');
    if (existingNew) {
        existingNew.scrollIntoView({ behavior: 'smooth', block: 'center' });
        existingNew.classList.remove('shake');
        void existingNew.offsetWidth; // перезапуск анімації
        existingNew.classList.add('shake');
        existingNew.querySelector('.i-name')?.focus();
        toast('Спочатку збережіть або скасуйте поточну картку', 'info');
        return;
    }
    container().querySelector('.empty-state')?.remove();
    const card = renderOwnerCard(null, container().children.length + 1, true, true);
    card.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

// ------------------------------------------------------------
// КАРТКА
// ------------------------------------------------------------
export function renderOwnerCard(ownerData, number, isEditMode, prepend = false) {
    const card = document.createElement('div');
    card.className = 'owner-card';
    const isNew = !ownerData;
    if (isNew) card.dataset.new = '1';
    if (ownerData?.id) card.dataset.id = ownerData.id;

    const name = ownerData?.name || '';
    const docInfo = ownerData?.docInfo || '';
    const shareFrac = ownerData?.shareFrac || '';
    const sharePerc = ownerData?.sharePerc || '';

    // Стан файлів живе на самому елементі, а не в прихованому input —
    // так їх можна додавати й видаляти до збереження.
    const existingUrls = String(ownerData?.fileUrls || '').split(',').map(u => u.trim()).filter(Boolean);
    card._existingFiles = existingUrls.map((url, i) => ({ name: fileNameFromUrl(url, i), url, type: '', size: 0 }));
    card._pendingFiles = [];
    // Вихідні дані — щоб потім побачити, чи щось насправді змінилося.
    card._original = { name, docInfo, shareFrac, sharePerc, fileUrls: String(ownerData?.fileUrls || '') };

    const percNum = parseFloat(sharePerc);
    const hasShare = sharePerc !== '' && !isNaN(percNum);
    const pct = hasShare ? Math.min(Math.max(percNum, 0), 100) : 0;
    // Усередині кільця місця мало, тому округлюємо: «33%», а не «33,33%».
    // Точне значення й так видно з дробу поруч.
    const percLabel = hasShare ? Math.round(percNum) : null;
    const accent = avatarGradient(name);
    const [ringFrom, ringTo] = avatarColors(name);
    const ringId = `ownerRing${++ringSeq}`;
    const CIRC = 2 * Math.PI * 44;          // r=44 у системі координат 0 0 100 100
    const dashOffset = CIRC * (1 - pct / 100);
    const isCustom = shareFrac && !PRESETS.includes(shareFrac);

    card.innerHTML = `
        <div class="view-mode"${isEditMode ? ' hidden' : ''}>
            <div class="owner-head">
                <div class="owner-avatar" style="background: ${accent};">${escapeHtml(getInitials(name))}</div>
                <div class="owner-head-text">
                    <span class="owner-index">Співвласник ${number}</span>
                    <h3 class="owner-name">${escapeHtml(name) || 'Без імені'}</h3>
                </div>
                <button type="button" class="icon-btn edit-btn" aria-label="Редагувати">
                    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"></path><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"></path></svg>
                </button>
            </div>

            <div class="share-panel">
                <div class="share-ring" role="img"
                     aria-label="${hasShare ? percLabel + '% від квартири' : 'Частку не вказано'}">
                    <svg viewBox="0 0 100 100" aria-hidden="true">
                        <defs>
                            <linearGradient id="${ringId}" x1="0" y1="0" x2="1" y2="1">
                                <stop offset="0" stop-color="${ringFrom}"></stop>
                                <stop offset="1" stop-color="${ringTo}"></stop>
                            </linearGradient>
                        </defs>
                        <circle class="share-ring-track" cx="50" cy="50" r="44"></circle>
                        <circle class="share-ring-fill" cx="50" cy="50" r="44"
                                stroke="url(#${ringId})"
                                stroke-dasharray="${CIRC.toFixed(2)}"
                                stroke-dashoffset="${dashOffset.toFixed(2)}"
                                transform="rotate(-90 50 50)"></circle>
                    </svg>
                    <span class="share-ring-text">${hasShare ? percLabel + '<small>%</small>' : '—'}</span>
                </div>
                <div class="share-panel-text">
                    <span class="share-caption">Частка власності</span>
                    <span class="share-frac-top${shareFrac ? '' : ' share-frac-empty'}">${escapeHtml(shareFrac) || 'Не вказано'}</span>
                </div>
            </div>

            <div class="owner-info">
                <span class="owner-info-label">Правовстановлюючий документ</span>
                <span class="owner-info-value">${escapeHtml(docInfo) || '—'}</span>
            </div>

            <div class="owner-attachments attach-block"></div>

            <button type="button" class="delete-btn owner-delete">Видалити співвласника</button>
        </div>

        <div class="edit-mode"${isEditMode ? '' : ' hidden'}>
            <h3 class="owner-edit-title">${isNew ? 'Новий співвласник' : 'Редагування даних'}</h3>

            <div class="field">
                <label class="field-label">ПІБ співвласника</label>
                <input type="text" class="i-name field-input" value="${escapeHtml(name)}" placeholder="Іванов Іван Іванович">
            </div>

            <div class="field">
                <label class="field-label">Частка власності</label>
                <select class="i-share-preset field-input field-select">
                    <option value="">Оберіть зі списку…</option>
                    <option value="1/1|100"${shareFrac === '1/1' ? ' selected' : ''}>1/1 (100%) — одноосібна</option>
                    <option value="1/2|50"${shareFrac === '1/2' ? ' selected' : ''}>1/2 (50%)</option>
                    <option value="1/3|33.33"${shareFrac === '1/3' ? ' selected' : ''}>1/3 (33.33%)</option>
                    <option value="1/4|25"${shareFrac === '1/4' ? ' selected' : ''}>1/4 (25%)</option>
                    <option value="2/3|66.67"${shareFrac === '2/3' ? ' selected' : ''}>2/3 (66.67%)</option>
                    <option value="1/5|20"${shareFrac === '1/5' ? ' selected' : ''}>1/5 (20%)</option>
                    <option value="custom"${isCustom ? ' selected' : ''}>Інше (ввести вручну)…</option>
                </select>
                <input type="text" class="i-share-custom field-input field-input-lg"${isCustom ? '' : ' hidden'}
                       placeholder="Дріб (1/6) або відсоток (15)" value="${escapeHtml(isCustom ? shareFrac : '')}">
            </div>

            <div class="field">
                <label class="field-label">Дані документа</label>
                <input type="text" class="i-doc field-input" value="${escapeHtml(docInfo)}" placeholder="Договір купівлі-продажу №123">
            </div>

            <div class="field">
                <span class="field-label">Скани та фото документів</span>
                <label class="dropzone">
                    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="17 8 12 3 7 8"></polyline><line x1="12" y1="3" x2="12" y2="15"></line></svg>
                    <span class="dropzone-text">Додати файли</span>
                    <span class="dropzone-hint">Фото або PDF</span>
                    <input type="file" class="i-files hidden-file-input" multiple accept="image/*,application/pdf">
                </label>
                <div class="file-chips owner-file-chips"></div>
            </div>

            <div class="btn-row">
                <button type="button" class="btn-soft cancel-btn">Скасувати</button>
                <button type="button" class="btn-primary save-ok-btn">Зберегти</button>
            </div>
        </div>`;

    if (prepend) container().prepend(card); else container().appendChild(card);

    wireOwnerCard(card, isNew);
    return card;
}

/**
 * Приймає правку локально й перемальовує картку з фактичних значень.
 *
 * Просто перемкнути видимість недостатньо: розмітка перегляду
 * намальована зі старих даних, і після редагування показувала б
 * «Без імені» та порожній документ. Раніше її оновлювало
 * перезавантаження з бази — тепер, коли правки йдуть заявкою,
 * перемальовуємо самі.
 */
function acceptCardEdit(card) {
    const val = (sel) => (card.querySelector(sel)?.value || '').trim();
    const preset = val('.i-share-preset');
    let shareFrac = '', sharePerc = '';
    if (preset === 'custom') {
        const calc = calculateShares(val('.i-share-custom'));
        shareFrac = calc.frac; sharePerc = calc.perc;
    } else if (preset) {
        [shareFrac, sharePerc] = preset.split('|');
    }

    const pendingFiles = card._pendingFiles || [];
    const existingFiles = card._existingFiles || [];

    const fresh = renderOwnerCard({
        id: card.dataset.id || undefined,
        name: val('.i-name'),
        docInfo: val('.i-doc'),
        shareFrac, sharePerc,
        fileUrls: existingFiles.map(f => f.url).join(',')
    }, 1, false);

    // renderOwnerCard дописує картку в кінець — ставимо її на місце старої
    card.replaceWith(fresh);
    fresh._pendingFiles = pendingFiles;
    fresh._existingFiles = existingFiles;
    refreshFileChips(fresh);

    // Вихідні дані беремо зі СТАРОЇ картки: у нової вони вже нові.
    fresh._original = card._original;

    if (!card.dataset.id) {
        // Немає id — отже в базі такого співвласника ще немає
        markCard(fresh, 'add');
    } else {
        const o = card._original || {};
        const changed = o.name !== val('.i-name')
            || o.docInfo !== val('.i-doc')
            || o.shareFrac !== shareFrac
            || pendingFiles.length > 0
            || o.fileUrls !== existingFiles.map(f => f.url).join(',');
        if (changed) markCard(fresh, 'edit');
    }

    // Файли ще не вивантажені, тож у перегляді їх немає. Кажемо про це
    // прямо, інакше здається, що вкладення зникло.
    if (pendingFiles.length) {
        const note = document.createElement('p');
        note.className = 'owner-pending-files';
        note.textContent = `${pendingFiles.length} файл(ів) буде додано після надсилання`;
        fresh.querySelector('.view-mode')?.appendChild(note);
    }
    renumberOwners();
    return fresh;
}

/**
 * Позначає картку як запропоновану зміну.
 *
 * Доданий і прибраний співвласники лишаються на екрані, але іншим
 * накресленням і з підписом: заявку ще розглядають, і поки правління
 * не вирішило — це пропозиція, а не факт.
 */
export function markCard(card, kind) {
    card.classList.remove('owner-pending-add', 'owner-pending-remove', 'owner-pending-edit');
    card.querySelector('.owner-pending-note')?.remove();
    if (!kind) { delete card.dataset.removed; return; }

    card.classList.add(`owner-pending-${kind}`);
    if (kind === 'remove') card.dataset.removed = '1';

    const note = document.createElement('p');
    note.className = 'owner-pending-note';
    // Угорі картки вже стоїть «Прибирається», тож тут не повторюємось,
    // а кажемо головне: рішення ще не ухвалене.
    note.textContent = {
        add: 'Додається — чекає підтвердження правління',
        edit: 'Дані змінено — чекає підтвердження правління',
        remove: 'У заявці на видалення — чекає рішення правління'
    }[kind];
    card.querySelector('.view-mode')?.appendChild(note);

    // Прибраного можна повернути, поки заявку не надіслано
    const del = card.querySelector('.delete-btn');
    if (del && kind === 'remove') {
        del.textContent = 'Повернути співвласника';
        del.classList.add('owner-undo');
    }
}

/** Нумерація «Співвласник N» після перестановки чи видалення. */
function renumberOwners() {
    let i = 1;
    container().querySelectorAll('.owner-card').forEach(card => {
        const el = card.querySelector('.owner-index');
        if (!el) return;
        el.textContent = card.dataset.removed ? 'Прибирається' : `Співвласник ${i++}`;
    });
}

function wireOwnerCard(card, isNew) {
    const view = card.querySelector('.view-mode');
    const edit = card.querySelector('.edit-mode');

    // Єдина кнопка редагування — олівець у шапці (дублювання прибрано)
    card.querySelector('.edit-btn').addEventListener('click', () => {
        view.hidden = true;
        edit.hidden = false;
        refreshFileChips(card);
    });

    card.querySelector('.cancel-btn').addEventListener('click', async () => {
        if (isNew) {
            card.remove();
            if (!container().children.length) await loadOwners(session.apt);
            updateOwnersCount();
            recomputeDirty();
        } else {
            // Повертаємо вихідні значення, а не просто ховаємо форму:
            // інакше скасована правка лишалася б у полях і рахувалася
            // як зміна.
            const o = card._original || {};
            card.querySelector('.i-name').value = o.name || '';
            card.querySelector('.i-doc').value = o.docInfo || '';
            const preset = card.querySelector('.i-share-preset');
            const custom = card.querySelector('.i-share-custom');
            const isCustom = o.shareFrac && !PRESETS.includes(o.shareFrac);
            preset.value = isCustom ? 'custom' : (o.shareFrac ? `${o.shareFrac}|${o.sharePerc}` : '');
            custom.hidden = !isCustom;
            custom.value = isCustom ? o.shareFrac : '';

            card.querySelectorAll('.field-error').forEach(e => e.remove());
            card.querySelectorAll('.field-invalid').forEach(e => e.classList.remove('field-invalid'));
            card._pendingFiles = [];
            refreshFileChips(card);

            edit.hidden = true;
            view.hidden = false;
            recomputeDirty();
        }
    });

    card.querySelector('.delete-btn').addEventListener('click', async () => {
        if (card.dataset.removed) {                 // передумали — повертаємо
            markCard(card, null);
            card.querySelector('.delete-btn').textContent = 'Видалити співвласника';
            card.querySelector('.delete-btn').classList.remove('owner-undo');
            renumberOwners();
            updateOwnersCount();
            markDirty();
            return;
        }
        const ok = await confirmDialog('Видалити співвласника?',
            'Дані та прикріплені документи цього співвласника буде видалено.');
        if (!ok) return;
        // Картку не прибираємо, а позначаємо. Інакше після надсилання
        // мешканець не бачить, що саме він запропонував прибрати, —
        // а заявку ще можуть відхилити.
        markCard(card, 'remove');
        renumberOwners();
        updateOwnersCount();
        markDirty();
    });

    const preset = card.querySelector('.i-share-preset');
    const custom = card.querySelector('.i-share-custom');
    preset.addEventListener('change', () => {
        const isCustom = preset.value === 'custom';
        custom.hidden = !isCustom;
        if (isCustom) { custom.value = ''; custom.focus(); }
    });

    // Керування файлами: додавання й видалення до збереження
    const fileInput = card.querySelector('.i-files');
    fileInput.addEventListener('change', () => {
        card._pendingFiles.push(...Array.from(fileInput.files));
        fileInput.value = '';
        refreshFileChips(card);
    });

    card.querySelector('.save-ok-btn').addEventListener('click', async function () {
        // Перевіряємо все одразу, а не лише ПІБ. Раніше картка
        // «зберігалася» без документа, і людина дізнавалася про це аж при
        // надсиланні — курсором на імені, яке було заповнене.
        const gaps = cardGaps(card);
        if (gaps.length) {
            showCardGaps(card, gaps);
            toast(`Не заповнено: ${gaps.map(g => g.label).join(', ')}`, 'error');
            return;
        }
        card.querySelectorAll('.field-error').forEach(e => e.remove());
        // Правку приймаємо локально: у базу все піде однією заявкою.
        acceptCardEdit(card);
        markDirty();
    });

    refreshFileChips(card);
}

function refreshFileChips(card) {
    renderFileManager(
        card.querySelector('.owner-file-chips'),
        card._existingFiles,
        card._pendingFiles,
        (idx) => { card._existingFiles.splice(idx, 1); refreshFileChips(card); },
        (idx) => { card._pendingFiles.splice(idx, 1); refreshFileChips(card); }
    );
    const attachHost = card.querySelector('.owner-attachments');
    if (attachHost) renderAttachments(attachHost, card._existingFiles);
}

// ------------------------------------------------------------
// ЗБЕРЕЖЕННЯ
// Раніше тут спершу видалялися ВСІ співвласники, і лише потім
// записувалися нові — обрив мережі між цими кроками знищував
// дані назавжди. Тепер це один атомарний batch: або все, або нічого.
// ------------------------------------------------------------
/** Збирає те, що зараз у картках. Нічого не пише. */
async function collectOwners() {
    const apt = workingApt();
    if (!apt) throw new Error('Користувач не автентифікований');

    const cards = Array.from(container().querySelectorAll('.owner-card'));

    // 1. Спершу вивантажуємо файли (найдовша операція) — до будь-яких змін у базі
    const payloads = [];
    for (const card of cards) {
        if (card.dataset.removed) continue;         // запропоновано прибрати
        const name = card.querySelector('.i-name').value.trim();
        if (!name) continue;

        const presetValue = card.querySelector('.i-share-preset').value;
        const customValue = card.querySelector('.i-share-custom').value;
        let shareFrac = '', sharePerc = '';
        if (presetValue === 'custom') {
            const calc = calculateShares(customValue);
            shareFrac = calc.frac; sharePerc = calc.perc;
        } else if (presetValue) {
            [shareFrac, sharePerc] = presetValue.split('|');
        }

        const urls = (card._existingFiles || []).map(f => f.url);
        const uploads = (card._pendingFiles || []).map(async (file) => {
            const fileRef = sRef(storage, `apartments/${apt}/${Date.now()}_${file.name}`);
            await uploadBytes(fileRef, file);
            return getDownloadURL(fileRef);
        });
        urls.push(...await Promise.all(uploads)); // паралельно, а не по черзі

        payloads.push({
            id: card.dataset.id || null,
            data: { name, docInfo: card.querySelector('.i-doc').value.trim(), shareFrac, sharePerc, fileUrls: urls.join(',') }
        });
    }

    return payloads;
}

/**
 * Запис напряму — тільки для правління.
 *
 * Мешканець пропонує, правління вирішує; коли правління саме вносить
 * дані за літню людину, погоджувати нема з ким — воно і є тим, хто
 * погоджує.
 */
export async function saveOwnersDirect() {
    const apt = workingApt();
    const payloads = await collectOwners();
    const ownersRef = collection(db, 'apartments', apt, 'owners');
    const existing = await getDocs(ownersRef);

    const batch = writeBatch(db);
    const keep = new Set(payloads.map(p => p.id).filter(Boolean));
    existing.forEach(d => { if (!keep.has(d.id)) batch.delete(d.ref); });
    payloads.forEach(p => batch.set(p.id ? doc(ownersRef, p.id) : doc(ownersRef), p.data));
    batch.set(doc(db, 'apartments', apt), {
        ownersStatus: 'confirmed',
        ownersConfirmedAt: serverTimestamp(),
        ownersConfirmedBy: 'board'
    }, { merge: true });
    await batch.commit();
}

/**
 * Надсилає правки як ЗАЯВКУ, а не запис.
 *
 * Кворум рахує унікальних власників, тож дописаний співвласник — це
 * дописаний голос. Досі мешканець міг зробити це сам: правила
 * дозволяли йому писати у власний список. Тепер він пропонує, а
 * рішення ухвалює правління.
 */
export async function submitOwnerChanges(reason) {
    const apt = workingApt();
    if (!apt) throw new Error('Користувач не автентифікований');

    const after = await collectOwners();
    const snap = await getDocs(collection(db, 'apartments', apt, 'owners'));
    const before = snap.docs.map(d => {
        const o = d.data();
        return { name: o.name || '', shareFrac: o.shareFrac || '', sharePerc: o.sharePerc || '',
                 docInfo: o.docInfo || '', fileUrls: o.fileUrls || '' };
    });

    await addDoc(collection(db, 'apartments', apt, 'owner_changes'), {
        before,
        after: after.map(p => p.data),
        reason,
        status: 'pending',
        createdAt: serverTimestamp()
    });
    await updateDoc(doc(db, 'apartments', apt), {
        ownersStatus: 'review',
        ownersConfirmedBy: 'apt'
    });
}

// ------------------------------------------------------------
// ПІДТВЕРДЖЕННЯ СПИСКУ
//
// Головна дія мешканця — не «заповнити», а «підтвердити»: для
// більшості квартир дані вже правильні. Тому підтвердження коштує
// один дотик, а редагування — це виняток, у який заходить меншість.
// ------------------------------------------------------------
let dirty = false;
let baseline = [];      // стан списку, з яким порівнюємо

/**
 * Знімок того, що зараз у картках.
 *
 * Сортуємо за іменем: власники не мають порядку, тож переставлення
 * карток не є зміною даних. Картки, ще не прийняті («нові» в режимі
 * редагування), у знімок не входять — вони ще не частина пропозиції.
 */
function snapshotOwners() {
    return [...container().querySelectorAll('.owner-card')]
        .filter(c => !c.dataset.removed && c.dataset.new !== '1')
        .map(c => {
            const val = (sel) => (c.querySelector(sel)?.value || '').trim();
            const preset = val('.i-share-preset');
            let shareFrac = '';
            if (preset === 'custom') shareFrac = calculateShares(val('.i-share-custom')).frac;
            else if (preset) shareFrac = preset.split('|')[0];
            return {
                name: val('.i-name'),
                docInfo: val('.i-doc'),
                shareFrac,
                files: (c._existingFiles || []).map(f => f.url).join(','),
                pending: (c._pendingFiles || []).length
            };
        })
        .sort((a, b) => normName(a.name).localeCompare(normName(b.name), 'uk'));
}

const withoutPending = (list) => list.map(o => ({ ...o, pending: 0 }));

/** Запамʼятати поточний стан як «незмінений». */
export function setOwnersBaseline() {
    baseline = snapshotOwners();
    dirty = false;
}

/**
 * Чи справді щось змінилося.
 *
 * Раніше тут стояв прапорець «щось чіпали», і кнопка «Надіслати»
 * зʼявлялася навіть після скасування власної ж дії — прибрав
 * співвласника й повернув назад. Тепер порівнюємо з початковим станом.
 */
function recomputeDirty() {
    const now = snapshotOwners();
    dirty = now.some(o => o.pending > 0)
        || JSON.stringify(withoutPending(now)) !== JSON.stringify(withoutPending(baseline));
    renderOwnersStatus();
}

// Поля, без яких картку не можна вважати заповненою, і те, як про це
// сказати. Підпис стоїть біля самого поля: «заповніть документ» під
// іменем нічого не пояснює.
const REQUIRED = [
    { sel: '.i-name', label: 'ПІБ', msg: 'Вкажіть прізвище, імʼя та по батькові' },
    { sel: '.i-share-preset', label: 'частку', msg: 'Оберіть частку власності' },
    { sel: '.i-doc', label: 'документ', msg: 'Вкажіть документ про право власності' }
];

/** Чого бракує саме в цій картці. */
function cardGaps(card) {
    const val = (sel) => (card.querySelector(sel)?.value || '').trim();
    return REQUIRED.filter(f => {
        if (f.sel !== '.i-share-preset') return !val(f.sel);
        const preset = val('.i-share-preset');
        return preset === 'custom' ? !val('.i-share-custom') : !preset;
    });
}

/** Малює підписи біля незаповнених полів і веде до першого з них. */
function showCardGaps(card, gaps) {
    card.querySelectorAll('.field-error').forEach(e => e.remove());
    card.querySelectorAll('.field-invalid').forEach(e => e.classList.remove('field-invalid'));

    gaps.forEach(f => {
        const input = card.querySelector(f.sel === '.i-share-preset' && card.querySelector('.i-share-preset')?.value === 'custom'
            ? '.i-share-custom' : f.sel);
        if (!input) return;
        input.classList.add('field-invalid');
        const msg = document.createElement('span');
        msg.className = 'field-error';
        msg.textContent = f.msg;
        input.insertAdjacentElement('afterend', msg);
    });

    const first = card.querySelector('.field-invalid');
    first?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setTimeout(() => first?.focus(), 250);
}

/**
 * Чого бракує в картках.
 *
 * Підтвердити неповний список не можна: саме за цими даними рахується
 * кворум, а частка й документ — підстава права власності. Порожнє поле
 * означає, що дані просто перенесли з паперу й ніхто їх не звіряв.
 */
function ownerProblems() {
    const out = [];
    container().querySelectorAll('.owner-card').forEach(card => {
        if (card.dataset.removed) return;           // його все одно прибирають
        const gaps = cardGaps(card);
        if (gaps.length) out.push({ card, missing: gaps.map(g => g.label) });
    });
    return out;
}

/** Показує, де саме бракує даних, і веде до першої такої картки. */
function showProblems(problems) {
    container().querySelectorAll('.owner-card').forEach(c => c.classList.remove('owner-incomplete'));
    problems.forEach(p => p.card.classList.add('owner-incomplete'));

    const first = problems[0];
    // Розгортаємо картку й ведемо до конкретного порожнього поля,
    // а не просто до імені.
    first.card.querySelector('.view-mode').hidden = true;
    first.card.querySelector('.edit-mode').hidden = false;
    showCardGaps(first.card, cardGaps(first.card));

    const what = [...new Set(problems.flatMap(p => p.missing))].join(', ');
    toast(`Заповніть ${what} — без цього підтвердити не можна`, 'error');
}


function markDirty() {
    recomputeDirty();
}

async function confirmOwners(btn) {
    if (!container().querySelectorAll('.owner-card:not([data-removed])').length) {
        return toast('Спочатку додайте хоча б одного співвласника', 'error');
    }
    const problems = ownerProblems();
    if (problems.length) return showProblems(problems);

    setBusy(btn, true, 'Зберігаємо…');
    try {
        await updateDoc(doc(db, 'apartments', workingApt()), {
            ownersStatus: 'confirmed',
            ownersConfirmedAt: serverTimestamp(),
            ownersConfirmedBy: 'apt'
        });
        session.ownersStatus = 'confirmed';
        dirty = false;
        toast('Дякуємо! Список підтверджено', 'success');
        renderOwnersStatus();
    } catch (e) {
        console.error('Підтвердження списку:', e);
        toast('Не вдалося зберегти. Перевірте інтернет.', 'error');
        setBusy(btn, false);
    }
}

async function sendChanges(btn) {
    // Рахуємо тих, хто лишається: прибрані картки нікуди не зникають з
    // екрана, тож звичайна перевірка на порожній список їх не бачила —
    // і можна було надіслати квартиру взагалі без власників.
    const remaining = container().querySelectorAll('.owner-card:not([data-removed])').length;
    if (!remaining) {
        return toast('У квартири має лишитися хоча б один власник', 'error');
    }
    const problems = ownerProblems();
    if (problems.length) return showProblems(problems);

    const reason = await promptDialog(
        'Що змінилося?',
        'Правління звірить зміни з документами. Напишіть коротко підставу — так перевірка пройде швидше.',
        { placeholder: 'Напр.: успадкував частку у 2024 році', confirmLabel: 'Надіслати' });
    if (!reason) return;

    setBusy(btn, true, 'Надсилаємо…');
    try {
        await submitOwnerChanges(reason);
        session.ownersStatus = 'review';
        dirty = false;
        toast('Заявку надіслано правлінню', 'success');
        renderOwnersStatus();
    } catch (e) {
        // Помилку показуємо як є: «не вдалося» без причини змушує
        // тицяти кнопку наосліп. Стан повертаємо, щоб можна було
        // спробувати ще раз.
        console.error('Заявка на зміну власників:', e);
        toast(e?.code === 'permission-denied'
            ? 'Немає доступу. Скажіть правлінню — потрібно оновити правила бази.'
            : 'Не вдалося надіслати. Перевірте інтернет і спробуйте ще раз.', 'error');
        setBusy(btn, false);
        renderOwnersStatus();
    }
}

export function renderOwnersStatus() {
    // Правління редагує напряму — прохання підтвердити тут ні до чого.
    if (isBoardEditing()) return;
    const host = document.getElementById('ownersStatusHost');
    if (!host) return;

    // Смужка вгорі: секція співвласників — унизу довгого екрана, і без
    // неї прохання побачили б лише ті, хто гортає до кінця.
    const banner = document.getElementById('ownersBanner');
    if (banner) banner.hidden = dirty || session.ownersStatus !== 'pending';

    if (dirty) {
        const gaps = ownerProblems();
        host.innerHTML = `<div class="own-status own-status-edit">
            <p class="own-status-text">Зміни ще не надіслано. Правління звірить їх із документами.</p>
            ${gaps.length ? `<p class="own-status-text own-status-gap">Бракує: ${escapeHtml(
                [...new Set(gaps.flatMap(g => g.missing))].join(', '))}. Без цього надіслати не можна.</p>` : ''}
            <button type="button" class="btn-primary" id="sendOwnerChangesBtn">Надіслати на перевірку</button>
        </div>`;
        document.getElementById('sendOwnerChangesBtn')
            .addEventListener('click', function () { sendChanges(this); });
        return;
    }

    const st = session.ownersStatus;
    const d = session.ownersDecision;

    // Рішення правління показуємо першим: це відповідь на дію мешканця,
    // і без неї незрозуміло, що сталося з надісланими правками.
    const decision = (st === 'pending' && d?.status === 'rejected')
        ? `<div class="own-status own-status-reject">
               <p class="own-status-title">Правління не прийняло зміни</p>
               <p class="own-status-text">${escapeHtml(d.note || 'Причину не вказано')}</p>
               <p class="own-status-text own-status-next">Виправте дані й надішліть ще раз —
                   або підтвердіть список, якщо він усе-таки вірний.</p>
           </div>`
        : (st === 'confirmed' && d?.status === 'approved')
        ? `<div class="own-status own-status-ok">
               <p class="own-status-text">Правління прийняло ваші зміни. Список оновлено й звірено.</p>
           </div>`
        : '';

    if (decision && st === 'confirmed') { host.innerHTML = decision; return; }

    if (st === 'review') {
        host.innerHTML = `<div class="own-status own-status-wait">
            <p class="own-status-text">Заявку надіслано. Правління перевірить її найближчим часом.</p>
        </div>`;
        return;
    }
    if (st === 'confirmed') {
        host.innerHTML = `<div class="own-status own-status-ok">
            <p class="own-status-text">Список підтверджено. Дякуємо — ваш голос рахуватиметься правильно.</p>
        </div>`;
        return;
    }

    // Одразу кажемо, чого бракує, — щоб людина не тицяла кнопку
    // й не отримувала відмову.
    const gaps = ownerProblems();
    const gapNote = gaps.length
        ? `<p class="own-status-text own-status-gap">Бракує: ${escapeHtml(
              [...new Set(gaps.flatMap(g => g.missing))].join(', '))}.
           Заповніть, і кнопка спрацює.</p>`
        : '';

    host.innerHTML = decision + `<div class="own-status own-status-ask">
        <p class="own-status-title">Перевірте, будь ласка, список</p>
        <p class="own-status-text">Голосування ОСББ рахується за співвласниками. Щоб ваш голос
            рахувався правильно, підтвердіть, що дані вірні — або виправте їх.</p>
        ${gapNote}
        <button type="button" class="btn-primary" id="confirmOwnersBtn">Так, усе правильно</button>
    </div>`;
    document.getElementById('confirmOwnersBtn')
        .addEventListener('click', function () { confirmOwners(this); });
}

export function initOwners() {
    document.getElementById('addOwnerBtn')?.addEventListener('click', addOwner);
    document.getElementById('ownersBanner')?.addEventListener('click', () => {
        document.getElementById('ownersStatusHost')
            ?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
}
