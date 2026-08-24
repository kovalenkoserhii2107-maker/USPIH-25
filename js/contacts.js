// ============================================================
// Контакти: правління та служби ОСББ.
//
// Посада — це документ, а не рядок у коді. Тому правління може
// додати чи прибрати позицію саме, не чекаючи змін у застосунку.
// Назва посади лежить у полі label того ж документа.
//
// Обидві групи влаштовані однаково — фото, телефон, месенджери, —
// тому модуль один, а групи описані таблицею GROUPS.
// ============================================================
import { db, storage } from './firebase.js';
import {
    doc, getDoc, getDocs, setDoc, deleteDoc, collection, writeBatch
} from "https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js";
import {
    ref as sRef, uploadBytes, getDownloadURL
} from "https://www.gstatic.com/firebasejs/10.8.1/firebase-storage.js";
import { escapeHtml, getInitials, avatarGradient, toast, setBusy, confirmDialog } from './ui.js';

export const GROUPS = {
    board: {
        collection: 'board_members',
        prefix: 'board',
        host: 'boardContactsContainer',
        adminHost: 'boardAdminList',
        addBtn: 'addBoardPositionBtn',
        fields: ['Name', 'Phone', 'Email', 'Viber', 'Telegram'],
        newLabel: 'Нова посада'
    },
    services: {
        collection: 'services',
        prefix: 'service',
        host: 'servicesContainer',
        adminHost: 'servicesAdminList',
        addBtn: 'addServicePositionBtn',
        // Email тут теж потрібен: бухгалтер переїхав у цю групу.
        fields: ['Name', 'Phone', 'Email', 'Viber', 'Telegram', 'Hours'],
        newLabel: 'Нова служба'
    }
};

// Записи, створені до того, як посади стали даними, не мають ні
// назви, ні порядку. Підставляємо їх за відомими ідентифікаторами,
// щоб нічого не зникло й не переставилося.
const LEGACY = {
    chairman:    { label: 'Голова правління', order: 0 },
    accountant:  { label: 'Бухгалтер',        order: 1 },
    electrician: { label: 'Електрик',         order: 0 },
    plumber:     { label: 'Сантехнік',        order: 1 },
    elevator:    { label: 'Ліфтер',           order: 2 },
    intercom:    { label: 'Домофон',          order: 3 }
};

const newPositionId = () =>
    'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

/** Усі посади групи, впорядковані. */
async function fetchPositions(key) {
    const group = GROUPS[key];
    const snap = await getDocs(collection(db, group.collection));
    return snap.docs
        .map(d => {
            const m = d.data();
            const legacy = LEGACY[d.id] || {};
            return {
                id: d.id, ...m,
                label: m.label || legacy.label || group.newLabel,
                order: typeof m.order === 'number' ? m.order
                     : (typeof legacy.order === 'number' ? legacy.order : 100)
            };
        })
        .sort((a, b) => a.order - b.order || a.label.localeCompare(b.label, 'uk'));
}

const pendingPhoto = {};

function phoneDigits(v) {
    return String(v || '').replace(/[^\d+]/g, '');
}

/** Telegram зберігають і як @nick, і як номер — приводимо до посилання. */
function telegramHref(v) {
    const raw = String(v || '').trim();
    if (!raw) return '';
    if (/^https?:\/\//i.test(raw)) return raw;
    const nick = raw.replace(/^@/, '');
    // Номер телефону теж працює як t.me/+380…
    return /^\+?\d[\d\s()-]*$/.test(nick)
        ? `https://t.me/${phoneDigits(nick)}`
        : `https://t.me/${encodeURIComponent(nick)}`;
}

const ICONS = {
    call: '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"></path></svg>',
    viber: '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2C6.5 2 2 5.6 2 10c0 2.5 1.4 4.7 3.6 6.2-.1.9-.5 2.4-1.6 3.8 1.7-.2 3.4-1 4.6-1.9.8.2 1.6.3 2.4.3 5.5 0 10-3.6 10-8S17.5 2 12 2z"></path></svg>',
    telegram: '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M22 3 2 10.5l6 2.2L20 6l-9 8.4V21l3.4-4.2L20 20z"></path></svg>',
    mail: '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 6c0-1.1-.9-2-2-2H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V6z"></path><polyline points="22 6 12 13 2 6"></polyline></svg>'
};

function contactButtons(m) {
    let html = '';
    if (m.phone) {
        html += `<a href="tel:${escapeHtml(phoneDigits(m.phone))}" class="contact-btn contact-btn-call">${ICONS.call}Дзвінок</a>`;
    }
    const viber = m.viber || m.phone;
    if (viber) {
        html += `<a href="viber://chat?number=${encodeURIComponent(phoneDigits(viber))}" class="contact-btn contact-btn-viber">${ICONS.viber}Viber</a>`;
    }
    const tg = telegramHref(m.telegram);
    if (tg) {
        html += `<a href="${escapeHtml(tg)}" target="_blank" rel="noopener" class="contact-btn contact-btn-telegram">${ICONS.telegram}Telegram</a>`;
    }
    if (m.email) {
        html += `<a href="mailto:${escapeHtml(m.email)}" class="contact-btn">${ICONS.mail}Пошта</a>`;
    }
    return html;
}

// ------------------------------------------------------------
// МЕШКАНЕЦЬ
// ------------------------------------------------------------
async function loadGroup(key) {
    const group = GROUPS[key];
    const host = document.getElementById(group.host);
    if (!host) return;
    host.innerHTML = '<p class="list-empty">Завантаження…</p>';

    try {
        const positions = await fetchPositions(key);
        if (!positions.length) {
            host.innerHTML = '<p class="list-empty">Контакти ще не додано</p>';
            return;
        }

        host.innerHTML = positions.map(m => {
            const name = m.name || m.label;
            const avatar = m.photoUrl
                ? `<img src="${escapeHtml(m.photoUrl)}" alt="${escapeHtml(name)}">`
                : escapeHtml(getInitials(name));
            const buttons = contactButtons(m);

            return `<div class="card">
                <div class="person-card">
                    <div class="person-avatar${m.photoUrl ? ' person-avatar-photo' : ''}"${m.photoUrl ? '' : ` style="background: ${avatarGradient(name)};"`}>${avatar}</div>
                    <div>
                        <span class="eyebrow">${escapeHtml(m.label)}</span>
                        <h3 class="person-name">${escapeHtml(name)}</h3>
                        ${m.hours ? `<span class="person-hours">${escapeHtml(m.hours)}</span>` : ''}
                    </div>
                </div>
                ${buttons
                    ? `<div class="contact-actions">${buttons}</div>`
                    : '<p class="muted-note">Контакти ще не додано</p>'}
            </div>`;
        }).join('');
    } catch (e) {
        console.error(`Контакти «${key}»:`, e);
        host.innerHTML = '<p class="list-empty">Не вдалося завантажити контакти</p>';
    }
}

export const loadBoardContacts = () => loadGroup('board');
export const loadServices = () => loadGroup('services');

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

function adminCardHtml(key, m, pos, total) {
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

    // Стрілки — у заголовку, а не у формі: порядок видно й міняється,
    // не розгортаючи картку. Кнопка в кнопці неприпустима, тому
    // перемикач і стрілки — сусіди в одному рядку.
    return `<div class="card admin-fold" data-pos="${escapeHtml(id)}">
        <div class="admin-card-head admin-card-head-row">
            <button class="admin-card-toggle" type="button" aria-expanded="false">
                <span class="admin-card-headings">
                    <h2 class="admin-card-title"><span class="pos-num">${pos + 1}</span>${escapeHtml(m.label)}</h2>
                    <span class="admin-card-sub">${escapeHtml(m.name || 'Контакти ще не заповнені')}</span>
                </span>
                ${CHEVRON}
            </button>
            <span class="pos-move">
                <button type="button" data-up="${escapeHtml(id)}" aria-label="Підняти вище"${pos === 0 ? ' disabled' : ''}>
                    <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="19" x2="12" y2="6"></line><polyline points="6 12 12 6 18 12"></polyline></svg>
                </button>
                <button type="button" data-down="${escapeHtml(id)}" aria-label="Опустити нижче"${pos === total - 1 ? ' disabled' : ''}>
                    <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="18"></line><polyline points="6 12 12 18 18 12"></polyline></svg>
                </button>
            </span>
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
            ? positions.map((m, i) => adminCardHtml(key, m, i, positions.length)).join('')
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
        toast('Посаду видалено', 'success');
        await loadAdminGroup(key);
    } catch (e) {
        console.error('Видалення посади:', e);
        toast('Не вдалося видалити', 'error');
    }
}

/**
 * Переставляє посаду на одну позицію.
 *
 * Після перестановки переписуємо порядок суцільною нумерацією всієї
 * групи. Простий обмін значеннями тут ненадійний: у записів, створених
 * до появи поля order, його або немає, або він однаковий — і обмін
 * нічого б не змінив.
 */
async function movePosition(key, id, dir) {
    const group = GROUPS[key];
    try {
        const positions = await fetchPositions(key);
        const i = positions.findIndex(p => p.id === id);
        const j = i + dir;
        if (i < 0 || j < 0 || j >= positions.length) return;

        const arr = [...positions];
        [arr[i], arr[j]] = [arr[j], arr[i]];

        const batch = writeBatch(db);
        arr.forEach((p, n) => batch.set(doc(db, group.collection, p.id), { order: n }, { merge: true }));
        await batch.commit();

        await loadAdminGroup(key);
    } catch (e) {
        console.error('Перестановка посади:', e);
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
async function moveAccountantToServices() {
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
export function initContacts() {
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
            if (up) { movePosition(key, up.dataset.up, -1); return; }
            const down = e.target.closest('[data-down]');
            if (down) movePosition(key, down.dataset.down, +1);
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

export { moveAccountantToServices };
