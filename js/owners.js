// ============================================================
// Співвласники квартири: показ, редагування, документи.
// ============================================================
import { db, storage, session, currentApt } from './firebase.js';
import {
    collection, getDocs, doc, writeBatch
} from "https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js";
import {
    ref as sRef, uploadBytes, getDownloadURL
} from "https://www.gstatic.com/firebasejs/10.8.1/firebase-storage.js";
import { escapeHtml, getInitials, avatarGradient, toast, confirmDialog, setBusy } from './ui.js';
import { renderAttachments, renderFileManager, fileNameFromUrl } from './attachments.js';

const PRESETS = ['1/1', '1/2', '1/3', '1/4', '2/3', '1/5'];

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

const container = () => document.getElementById('ownersContainer');

// ------------------------------------------------------------
// ЗАВАНТАЖЕННЯ
// ------------------------------------------------------------
export async function loadOwners(apt) {
    const host = container();
    host.innerHTML = '';
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
}

export function updateOwnersCount() {
    const el = document.getElementById('displayOwnersCount');
    if (!el) return;
    const count = container().querySelectorAll('.owner-card:not([data-new="1"])').length;
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

    const percNum = parseFloat(sharePerc);
    const hasShare = sharePerc !== '' && !isNaN(percNum);
    const fillWidth = hasShare ? Math.min(Math.max(percNum, 0), 100) : 0;
    // Прибираємо хвостові нулі: 33.33 → «33,33», 50 → «50»
    const percLabel = hasShare
        ? String(Math.round(percNum * 100) / 100).replace('.', ',')
        : '';
    const accent = avatarGradient(name);
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
                <div class="share-panel-head">
                    <span class="share-caption">Частка власності</span>
                    ${hasShare ? `<span class="share-percent">${escapeHtml(percLabel)}<small>%</small></span>` : ''}
                </div>
                <span class="share-frac${shareFrac ? '' : ' share-frac-empty'}">${escapeHtml(shareFrac) || 'Не вказано'}</span>
                <div class="share-track" role="img"
                     aria-label="${hasShare ? escapeHtml(percLabel) + '% від квартири' : 'Частку не вказано'}">
                    <span class="share-fill" style="width: ${fillWidth}%; background: ${accent};"></span>
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
        } else {
            edit.hidden = true;
            view.hidden = false;
            card._pendingFiles = [];
        }
    });

    card.querySelector('.delete-btn').addEventListener('click', async () => {
        const ok = await confirmDialog('Видалити співвласника?',
            'Дані та прикріплені документи цього співвласника буде видалено.');
        if (!ok) return;
        card.remove();
        try {
            await saveOwners();
            toast('Співвласника видалено', 'success');
            updateOwnersCount();
            if (!container().children.length) await loadOwners(session.apt);
        } catch (e) {
            console.error(e);
            toast('Не вдалося видалити. Оновіть сторінку.', 'error');
        }
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
        const nameValue = card.querySelector('.i-name').value.trim();
        if (!nameValue) {
            toast('Вкажіть ПІБ співвласника', 'error');
            card.querySelector('.i-name').focus();
            return;
        }
        setBusy(this, true, 'Збереження…');
        try {
            await saveOwners();
            await loadOwners(session.apt);
            toast('Дані збережено', 'success');
        } catch (error) {
            console.error(error);
            toast('Помилка збереження. Перевірте інтернет.', 'error');
            setBusy(this, false);
        }
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
export async function saveOwners() {
    const apt = currentApt();
    if (!apt) throw new Error('Користувач не автентифікований');

    const cards = Array.from(container().querySelectorAll('.owner-card'));
    const ownersRef = collection(db, 'apartments', apt, 'owners');

    // 1. Спершу вивантажуємо файли (найдовша операція) — до будь-яких змін у базі
    const payloads = [];
    for (const card of cards) {
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

    // 2. Тепер один атомарний запис
    const batch = writeBatch(db);
    const existing = await getDocs(ownersRef);
    const keepIds = new Set(payloads.map(p => p.id).filter(Boolean));
    existing.forEach(d => { if (!keepIds.has(d.id)) batch.delete(d.ref); });
    payloads.forEach(p => {
        const ref = p.id ? doc(ownersRef, p.id) : doc(ownersRef);
        batch.set(ref, p.data);
    });
    await batch.commit();
}

export function initOwners() {
    document.getElementById('addOwnerBtn')?.addEventListener('click', addOwner);
}
