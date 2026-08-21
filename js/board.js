// ============================================================
// Контакти правління: голова та бухгалтер.
// Мешканець бачить фото, телефон, email і Viber.
// Адмін редагує ці дані та завантажує фото.
// ============================================================
import { db, storage } from './firebase.js';
import {
    doc, getDoc, setDoc
} from "https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js";
import {
    ref as sRef, uploadBytes, getDownloadURL
} from "https://www.gstatic.com/firebasejs/10.8.1/firebase-storage.js";
import { escapeHtml, getInitials, avatarGradient, toast, setBusy } from './ui.js';

const ROLES = [
    { id: 'chairman', label: 'Голова правління' },
    { id: 'accountant', label: 'Бухгалтер' }
];

const pendingPhoto = {};

function phoneDigits(v) {
    return String(v || '').replace(/[^\d+]/g, '');
}

function contactButtonsHtml(member) {
    let html = '';
    if (member.phone) {
        html += `<a href="tel:${escapeHtml(phoneDigits(member.phone))}" class="contact-btn contact-btn-call">
            <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"></path></svg>
            Дзвінок
        </a>`;
    }
    const viberNumber = member.viber || member.phone;
    if (viberNumber) {
        html += `<a href="viber://chat?number=${encodeURIComponent(phoneDigits(viberNumber))}" class="contact-btn contact-btn-viber">
            <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2C6.5 2 2 5.6 2 10c0 2.5 1.4 4.7 3.6 6.2-.1.9-.5 2.4-1.6 3.8 1.7-.2 3.4-1 4.6-1.9.8.2 1.6.3 2.4.3 5.5 0 10-3.6 10-8S17.5 2 12 2z"></path></svg>
            Viber
        </a>`;
    }
    if (member.email) {
        html += `<a href="mailto:${escapeHtml(member.email)}" class="contact-btn">
            <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 6c0-1.1-.9-2-2-2H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V6z"></path><polyline points="22 6 12 13 2 6"></polyline></svg>
            Пошта
        </a>`;
    }
    return html;
}

// ------------------------------------------------------------
// МЕШКАНЕЦЬ: перегляд контактів
// ------------------------------------------------------------
export async function loadBoardContacts() {
    const host = document.getElementById('boardContactsContainer');
    if (!host) return;
    host.innerHTML = '<p class="list-empty">Завантаження…</p>';

    try {
        const snaps = await Promise.all(ROLES.map(r => getDoc(doc(db, 'board_members', r.id))));
        let html = '';
        snaps.forEach((snap, i) => {
            const role = ROLES[i];
            const m = snap.exists() ? snap.data() : {};
            const name = m.name || role.label;
            const avatarInner = m.photoUrl
                ? `<img src="${escapeHtml(m.photoUrl)}" alt="${escapeHtml(name)}">`
                : escapeHtml(getInitials(name));

            html += `<div class="card">
                <div class="person-card">
                    <div class="person-avatar${m.photoUrl ? ' person-avatar-photo' : ''}"${m.photoUrl ? '' : ` style="background: ${avatarGradient(name)};"`}>${avatarInner}</div>
                    <div>
                        <span class="eyebrow">${escapeHtml(role.label)}</span>
                        <h3 class="person-name">${escapeHtml(name)}</h3>
                    </div>
                </div>
                ${(m.phone || m.viber || m.email)
                    ? `<div class="contact-actions">${contactButtonsHtml(m)}</div>`
                    : '<p class="muted-note">Контакти ще не додано</p>'}
            </div>`;
        });
        host.innerHTML = html;
    } catch (e) {
        console.error('Завантаження контактів правління:', e);
        host.innerHTML = '<p class="list-empty">Не вдалося завантажити контакти правління</p>';
    }
}

// ------------------------------------------------------------
// АДМІН: редагування контактів
// ------------------------------------------------------------
function renderPhotoPreview(role, url, name) {
    const el = document.getElementById(`boardPhotoPreview-${role}`);
    if (!el) return;
    el.innerHTML = url ? `<img src="${escapeHtml(url)}" alt="">` : escapeHtml(getInitials(name));
    el.style.background = url ? '' : avatarGradient(name || role);
}

export async function loadAdminBoard() {
    for (const role of ROLES) {
        try {
            const snap = await getDoc(doc(db, 'board_members', role.id));
            const m = snap.exists() ? snap.data() : {};
            document.getElementById(`boardName-${role.id}`).value = m.name || '';
            document.getElementById(`boardPhone-${role.id}`).value = m.phone || '';
            document.getElementById(`boardEmail-${role.id}`).value = m.email || '';
            document.getElementById(`boardViber-${role.id}`).value = m.viber || '';
            renderPhotoPreview(role.id, m.photoUrl || '', m.name || role.label);
        } catch (e) {
            console.error(`Завантаження контакту "${role.id}":`, e);
        }
    }
}

async function saveBoardMember(role, btn) {
    const name = document.getElementById(`boardName-${role}`).value.trim();
    const phone = document.getElementById(`boardPhone-${role}`).value.trim();
    const email = document.getElementById(`boardEmail-${role}`).value.trim();
    const viber = document.getElementById(`boardViber-${role}`).value.trim();
    if (!name) return toast('Вкажіть ПІБ', 'error');

    setBusy(btn, true, 'Збереження…');
    try {
        const data = { name, phone, email, viber };
        const file = pendingPhoto[role];
        if (file) {
            const fileRef = sRef(storage, `board/${role}_${Date.now()}_${file.name}`);
            await uploadBytes(fileRef, file);
            data.photoUrl = await getDownloadURL(fileRef);
            renderPhotoPreview(role, data.photoUrl, name);
        }
        await setDoc(doc(db, 'board_members', role), data, { merge: true });
        pendingPhoto[role] = null;
        toast('Контакти збережено', 'success');
    } catch (e) {
        console.error('Збереження контакту правління:', e);
        toast('Помилка збереження. Перевірте інтернет.', 'error');
    } finally {
        setBusy(btn, false);
    }
}

export function initBoard() {
    ROLES.forEach(role => {
        const photoInput = document.getElementById(`boardPhotoInput-${role.id}`);
        photoInput?.addEventListener('change', function () {
            const file = this.files[0];
            this.value = '';
            if (!file) return;
            pendingPhoto[role.id] = file;
            const reader = new FileReader();
            reader.onload = () => {
                const el = document.getElementById(`boardPhotoPreview-${role.id}`);
                if (el) {
                    el.innerHTML = `<img src="${reader.result}" alt="">`;
                    el.style.background = '';
                }
            };
            reader.readAsDataURL(file);
        });

        document.getElementById(`boardSaveBtn-${role.id}`)?.addEventListener('click', function () {
            saveBoardMember(role.id, this);
        });
    });
}
