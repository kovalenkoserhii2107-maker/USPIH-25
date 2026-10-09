// ============================================================
// Контакти правління й служб у панелі правління: редагування посад,
// фото й порядку. Кабінет мешканця цього коду не вантажить.
// ============================================================
import { db, storage } from './firebase.js';
import { audit } from './audit.js';
import {
    doc, getDoc, setDoc, deleteDoc, writeBatch
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import {
    ref as sRef, uploadBytes, getDownloadURL
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-storage.js";
import { escapeHtml, getInitials, avatarGradient, toast, setBusy, confirmDialog } from './ui.js';
import { GROUPS, fetchPositions } from './contacts.js';

const newPositionId = () =>
    'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

const pendingPhoto = {};

// ------------------------------------------------------------
// АДМІН
// ------------------------------------------------------------
function fieldId(prefix, field, roleId) {
    return `${prefix}${field}-${roleId}`;
}

function renderPhotoPreview(prefix, roleId, url, name) {
    const el = document.getElementById(fieldId(prefix, 'PhotoPreview', roleId));
    if (!el) return;
    el.innerHTML = url ? `<img src="${escapeHtml(url)}" alt="">` : escapeHtml(getInitials(name));
    el.style.background = url ? '' : avatarGradient(name || roleId);
}

const FIELD_META = {
    Name:     { label: 'ПІБ або назва', type: 'text',  ph: 'Прізвище Ім\'я По батькові' },
    Phone:    { label: 'Телефон',       type: 'tel',   ph: '+380XXXXXXXXX' },
    Email:    { label: 'Email',         type: 'email', ph: 'name@example.com' },
    Viber:    { label: 'Viber',         type: 'tel',   ph: 'номер, якщо інший' },
    Telegram: { label: 'Telegram',      type: 'text',  ph: '@nick або номер' },
    Hours:    { label: 'Години роботи', type: 'text',  ph: 'Пн–Пт, 9:00–18:00' }
};

const CHEVRON = '<svg class="admin-card-chevron" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>';

function adminCardHtml(key, m, pos) {
    const g = GROUPS[key];
    const id = m.id;
    const fields = g.fields.map(f => {
        const meta = FIELD_META[f];
        return `<div class="field">
            <label class="field-label" for="${fieldId(g.prefix, f, id)}">${escapeHtml(meta.label)}</label>
            <input type="${meta.type}" id="${fieldId(g.prefix, f, id)}" class="field-input"
                   placeholder="${escapeHtml(meta.ph)}" value="${escapeHtml(m[f.toLowerCase()] || '')}">
        </div>`;
    }).join('');

    // Стрілка — у заголовку, а не у формі: порядок видно й міняється,
    // не розгортаючи картку. Кнопка в кнопці неприпустима, тому
    // перемикач і стрілка — сусіди в одному рядку.
    //
    // Кнопка одна, «вгору»: нею збирається будь-який порядок, а кнопок
    // на екрані вдвічі менше.
    return `<div class="card admin-fold" data-pos="${escapeHtml(id)}">
        <div class="admin-card-head admin-card-head-row">
            <button class="admin-card-toggle" type="button" aria-expanded="false">
                <span class="admin-card-headings">
                    <h2 class="admin-card-title"><span class="pos-num">${pos + 1}</span>${escapeHtml(m.label)}</h2>
                    <span class="admin-card-sub">${escapeHtml(m.name || 'Контакти ще не заповнені')}</span>
                </span>
                ${CHEVRON}
            </button>
            <button type="button" class="pos-up" data-up="${escapeHtml(id)}"
                    aria-label="Підняти вище"${pos === 0 ? ' disabled' : ''}>
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="19" x2="12" y2="6"></line><polyline points="6 12 12 6 18 12"></polyline></svg>
            </button>
        </div>
        <div class="admin-card-body"><div class="admin-card-body-inner">

        <div class="field">
            <label class="field-label" for="${fieldId(g.prefix, 'Label', id)}">Назва посади</label>
            <input type="text" id="${fieldId(g.prefix, 'Label', id)}" class="field-input"
                   placeholder="Наприклад: Електрик" value="${escapeHtml(m.label)}">
        </div>

        <div class="board-photo-row">
            <div class="board-photo-preview" id="${fieldId(g.prefix, 'PhotoPreview', id)}"></div>
            <label class="dropzone board-photo-drop" for="${fieldId(g.prefix, 'PhotoInput', id)}">
                <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="17 8 12 3 7 8"></polyline><line x1="12" y1="3" x2="12" y2="15"></line></svg>
                <span class="dropzone-text">Змінити фото</span>
            </label>
            <input type="file" id="${fieldId(g.prefix, 'PhotoInput', id)}" accept="image/*" class="hidden-file-input" data-photo="${escapeHtml(id)}">
        </div>

        ${fields}

        <div class="pos-actions">
            <button type="button" class="btn-primary" data-save="${escapeHtml(id)}">Зберегти</button>
            <button type="button" class="pos-delete" data-del="${escapeHtml(id)}">Видалити посаду</button>
        </div>
        </div></div>
    </div>`;
}

async function loadAdminGroup(key) {
    const group = GROUPS[key];
    const host = document.getElementById(group.adminHost);
    if (!host) return;
    // Які картки були розгорнуті — після перестановки вони мають
    // лишитися розгорнутими, інакше список «схлопується» під рукою.
    const opened = new Set([...host.querySelectorAll('.admin-fold.open')].map(c => c.dataset.pos));
    host.innerHTML = '<p class="list-empty">Завантаження…</p>';
    try {
        const positions = await fetchPositions(key);
        host.innerHTML = positions.length
            ? positions.map((m, i) => adminCardHtml(key, m, i)).join('')
            : '<p class="list-empty">Посад ще немає — додайте першу кнопкою нижче</p>';
        positions.forEach(m => renderPhotoPreview(group.prefix, m.id, m.photoUrl || '', m.name || m.label));
        opened.forEach(id => {
            const card = host.querySelector(`[data-pos="${id}"]`);
            if (!card) return;
            card.classList.add('open');
            card.querySelector('.admin-card-toggle')?.setAttribute('aria-expanded', 'true');
        });
    } catch (e) {
        console.error(`Адмін-контакти «${key}»:`, e);
        host.innerHTML = '<p class="list-empty">Не вдалося завантажити</p>';
    }
}

export const loadAdminBoard = () => loadAdminGroup('board');

export const loadAdminServices = () => loadAdminGroup('services');

async function saveMember(key, roleId, btn) {
    const group = GROUPS[key];
    const val = f => (document.getElementById(fieldId(group.prefix, f, roleId))?.value || '').trim();
    const label = val('Label');
    if (!label) return toast('Вкажіть назву посади', 'error');

    setBusy(btn, true, 'Збереження…');
    try {
        // Пишемо рівно ті поля, які має ця група
        const data = { label };
        group.fields.forEach(f => { data[f.toLowerCase()] = val(f); });

        const file = pendingPhoto[`${key}:${roleId}`];
        if (file) {
            const fileRef = sRef(storage, `${group.collection}/${roleId}_${Date.now()}_${file.name}`);
            await uploadBytes(fileRef, file);
            data.photoUrl = await getDownloadURL(fileRef);
            renderPhotoPreview(group.prefix, roleId, data.photoUrl, data.name);
        }
        await setDoc(doc(db, group.collection, roleId), data, { merge: true });
        pendingPhoto[`${key}:${roleId}`] = null;

        // Заголовок картки має збігатися з тим, що щойно збережено
        const card = document.querySelector(`[data-pos="${roleId}"]`);
        if (card) {
            card.querySelector('.admin-card-title').textContent = label;
            card.querySelector('.admin-card-sub').textContent = data.name || 'Контакти ще не заповнені';
        }
        await audit('contacts.save', { target: `${group.collection}/${roleId}`, summary: `Контакти «${label}» збережено` });
        toast('Контакти збережено', 'success');
    } catch (e) {
        console.error('Збереження контакту:', e);
        toast('Помилка збереження. Перевірте інтернет.', 'error');
    } finally {
        setBusy(btn, false);
    }
}

async function deletePosition(key, roleId) {
    const group = GROUPS[key];
    const card = document.querySelector(`[data-pos="${roleId}"]`);
    const label = card?.querySelector('.admin-card-title')?.textContent || 'цю посаду';

    const ok = await confirmDialog('Видалити посаду?',
        `«${label}» зникне зі списку контактів у всіх мешканців. Дію не можна скасувати.`);
    if (!ok) return;

    try {
        await deleteDoc(doc(db, group.collection, roleId));
        await audit('contacts.delete', { target: `${group.collection}/${roleId}`, summary: `Посаду «${label}» видалено` });
        toast('Посаду видалено', 'success');
        await loadAdminGroup(key);
    } catch (e) {
        console.error('Видалення посади:', e);
        toast('Не вдалося видалити', 'error');
    }
}

/**
 * Піднімає посаду на одну позицію вгору.
 *
 * Після перестановки переписуємо порядок суцільною нумерацією всієї
 * групи. Простий обмін значеннями тут ненадійний: у записів, створених
 * до появи поля order, його або немає, або він однаковий — і обмін
 * нічого б не змінив.
 */
async function movePositionUp(key, id) {
    const group = GROUPS[key];
    try {
        const positions = await fetchPositions(key);
        const i = positions.findIndex(p => p.id === id);
        if (i < 1) return;                     // першу нікуди піднімати
        const j = i - 1;

        const arr = [...positions];
        [arr[i], arr[j]] = [arr[j], arr[i]];

        const batch = writeBatch(db);
        arr.forEach((p, n) => batch.set(doc(db, group.collection, p.id), { order: n }, { merge: true }));
        await batch.commit();

        await loadAdminGroup(key);
    } catch (e) {
        console.error('Підняття посади:', e);
        toast('Не вдалося змінити порядок', 'error');
    }
}

async function addPosition(key, btn) {
    const group = GROUPS[key];
    setBusy(btn, true, 'Додаємо…');
    try {
        const positions = await fetchPositions(key);
        const order = positions.length ? Math.max(...positions.map(p => p.order)) + 1 : 0;
        const id = newPositionId();
        await setDoc(doc(db, group.collection, id), { label: group.newLabel, order, name: '' });
        await loadAdminGroup(key);
        // Одразу розгортаємо нову картку: інакше незрозуміло, що сталося
        const card = document.querySelector(`[data-pos="${id}"]`);
        if (card) {
            card.classList.add('open');
            card.querySelector('.admin-card-toggle')?.setAttribute('aria-expanded', 'true');
            card.scrollIntoView({ block: 'center', behavior: 'smooth' });
            document.getElementById(fieldId(group.prefix, 'Label', id))?.focus();
        }
    } catch (e) {
        console.error('Додавання посади:', e);
        toast('Не вдалося додати посаду', 'error');
    } finally {
        setBusy(btn, false);
    }
}

/**
 * Разове перенесення бухгалтера у групу служб.
 *
 * Виконується мовчки й лише один раз: якщо запису в board_members
 * уже немає, нічого не відбувається. Копіюємо, і тільки після
 * вдалого запису прибираємо старий — інакше можна втратити дані.
 */
export async function moveAccountantToServices() {
    try {
        const from = await getDoc(doc(db, 'board_members', 'accountant'));
        if (!from.exists()) return;
        const to = await getDoc(doc(db, 'services', 'accountant'));
        if (!to.exists()) {
            const m = from.data();
            await setDoc(doc(db, 'services', 'accountant'),
                { ...m, label: m.label || 'Бухгалтер', order: -1 });
        }
        await deleteDoc(doc(db, 'board_members', 'accountant'));
    } catch (e) {
        console.warn('Перенесення бухгалтера:', e);
    }
}

// ------------------------------------------------------------
// ІНІЦІАЛІЗАЦІЯ
// ------------------------------------------------------------
export function initContactsAdmin() {
    Object.entries(GROUPS).forEach(([key, group]) => {
        const host = document.getElementById(group.adminHost);

        // Слухачі делеговані: картки перемальовуються при кожній зміні
        // складу посад, і чіпляти їх заново було б зайвою роботою.
        host?.addEventListener('click', (e) => {
            const save = e.target.closest('[data-save]');
            if (save) { saveMember(key, save.dataset.save, save); return; }
            const del = e.target.closest('[data-del]');
            if (del) { deletePosition(key, del.dataset.del); return; }
            const up = e.target.closest('[data-up]');
            if (up) movePositionUp(key, up.dataset.up);
        });

        host?.addEventListener('change', (e) => {
            const input = e.target.closest('input[data-photo]');
            if (!input) return;
            const file = input.files[0];
            const id = input.dataset.photo;
            input.value = '';
            if (!file) return;
            pendingPhoto[`${key}:${id}`] = file;
            const reader = new FileReader();
            reader.onload = () => {
                const el = document.getElementById(fieldId(group.prefix, 'PhotoPreview', id));
                if (el) { el.innerHTML = `<img src="${reader.result}" alt="">`; el.style.background = ''; }
            };
            reader.readAsDataURL(file);
        });

        document.getElementById(group.addBtn)
            ?.addEventListener('click', function () { addPosition(key, this); });
    });
}
