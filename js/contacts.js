// ============================================================
// Контакти: правління (голова, бухгалтер) і технічні служби
// (електрик, сантехнік, ліфтер, домофон).
//
// Обидві групи влаштовані однаково — фото, телефон, месенджери, —
// тому модуль один, а групи описані таблицею GROUPS. Дублювати
// цей код заради другої групи не було б за що.
// ============================================================
import { db, storage } from './firebase.js';
import {
    doc, getDoc, setDoc
} from "https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js";
import {
    ref as sRef, uploadBytes, getDownloadURL
} from "https://www.gstatic.com/firebasejs/10.8.1/firebase-storage.js";
import { escapeHtml, getInitials, avatarGradient, toast, setBusy } from './ui.js';

export const GROUPS = {
    board: {
        collection: 'board_members',
        prefix: 'board',
        host: 'boardContactsContainer',
        fields: ['Name', 'Phone', 'Email', 'Viber', 'Telegram'],
        roles: [
            { id: 'chairman', label: 'Голова правління' },
            { id: 'accountant', label: 'Бухгалтер' }
        ]
    },
    services: {
        collection: 'services',
        prefix: 'service',
        host: 'servicesContainer',
        fields: ['Name', 'Phone', 'Viber', 'Telegram', 'Hours'],
        roles: [
            { id: 'electrician', label: 'Електрик' },
            { id: 'plumber', label: 'Сантехнік' },
            { id: 'elevator', label: 'Ліфтер' },
            { id: 'intercom', label: 'Домофон' }
        ]
    }
};

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
        const snaps = await Promise.all(
            group.roles.map(r => getDoc(doc(db, group.collection, r.id)))
        );

        host.innerHTML = snaps.map((snap, i) => {
            const role = group.roles[i];
            const m = snap.exists() ? snap.data() : {};
            const name = m.name || role.label;
            const avatar = m.photoUrl
                ? `<img src="${escapeHtml(m.photoUrl)}" alt="${escapeHtml(name)}">`
                : escapeHtml(getInitials(name));
            const buttons = contactButtons(m);

            return `<div class="card">
                <div class="person-card">
                    <div class="person-avatar${m.photoUrl ? ' person-avatar-photo' : ''}"${m.photoUrl ? '' : ` style="background: ${avatarGradient(name)};"`}>${avatar}</div>
                    <div>
                        <span class="eyebrow">${escapeHtml(role.label)}</span>
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

async function loadAdminGroup(key) {
    const group = GROUPS[key];
    for (const role of group.roles) {
        try {
            const snap = await getDoc(doc(db, group.collection, role.id));
            const m = snap.exists() ? snap.data() : {};
            group.fields.forEach(f => {
                const el = document.getElementById(fieldId(group.prefix, f, role.id));
                if (el) el.value = m[f.toLowerCase()] || '';
            });
            renderPhotoPreview(group.prefix, role.id, m.photoUrl || '', m.name || role.label);
        } catch (e) {
            console.error(`Завантаження «${role.id}»:`, e);
        }
    }
}

export const loadAdminBoard = () => loadAdminGroup('board');
export const loadAdminServices = () => loadAdminGroup('services');

async function saveMember(key, roleId, btn) {
    const group = GROUPS[key];
    const val = f => (document.getElementById(fieldId(group.prefix, f, roleId))?.value || '').trim();
    const name = val('Name');
    if (!name) return toast('Вкажіть імʼя або назву', 'error');

    setBusy(btn, true, 'Збереження…');
    try {
        // Пишемо рівно ті поля, які має ця група
        const data = {};
        group.fields.forEach(f => { data[f.toLowerCase()] = val(f); });
        const file = pendingPhoto[`${key}:${roleId}`];
        if (file) {
            const fileRef = sRef(storage, `${group.collection}/${roleId}_${Date.now()}_${file.name}`);
            await uploadBytes(fileRef, file);
            data.photoUrl = await getDownloadURL(fileRef);
            renderPhotoPreview(group.prefix, roleId, data.photoUrl, name);
        }
        await setDoc(doc(db, group.collection, roleId), data, { merge: true });
        pendingPhoto[`${key}:${roleId}`] = null;
        toast('Контакти збережено', 'success');
    } catch (e) {
        console.error('Збереження контакту:', e);
        toast('Помилка збереження. Перевірте інтернет.', 'error');
    } finally {
        setBusy(btn, false);
    }
}

// ------------------------------------------------------------
// ІНІЦІАЛІЗАЦІЯ
// ------------------------------------------------------------
export function initContacts() {
    Object.entries(GROUPS).forEach(([key, group]) => {
        group.roles.forEach(role => {
            const input = document.getElementById(fieldId(group.prefix, 'PhotoInput', role.id));
            input?.addEventListener('change', function () {
                const file = this.files[0];
                this.value = '';
                if (!file) return;
                pendingPhoto[`${key}:${role.id}`] = file;
                const reader = new FileReader();
                reader.onload = () => {
                    const el = document.getElementById(fieldId(group.prefix, 'PhotoPreview', role.id));
                    if (el) { el.innerHTML = `<img src="${reader.result}" alt="">`; el.style.background = ''; }
                };
                reader.readAsDataURL(file);
            });

            document.getElementById(fieldId(group.prefix, 'SaveBtn', role.id))
                ?.addEventListener('click', function () { saveMember(key, role.id, this); });
        });
    });
}
