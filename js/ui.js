// ============================================================
// Спільні утиліти інтерфейсу: екранування, формати, панелі,
// сповіщення, індикатори завантаження.
// ============================================================

/** Екранує будь-який текст перед вставкою в innerHTML. */
export function escapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str).replace(/[&<>"']/g, (c) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
}

export function formatDateTime(ts) {
    if (!ts) return 'Нещодавно';
    const date = ts.toMillis ? new Date(ts.toMillis()) : new Date(ts);
    return date.toLocaleString('uk-UA', {
        day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit'
    });
}

export function formatFileSize(bytes) {
    if (bytes === null || bytes === undefined) return '';
    if (bytes < 1024) return bytes + ' Б';
    if (bytes < 1024 * 1024) return Math.round(bytes / 1024) + ' КБ';
    return (bytes / 1024 / 1024).toFixed(1) + ' МБ';
}

export function formatElapsed(ms) {
    if (ms < 0) ms = 0;
    const totalMin = Math.floor(ms / 60000);
    const days = Math.floor(totalMin / 1440);
    const hours = Math.floor((totalMin % 1440) / 60);
    const mins = totalMin % 60;
    if (days > 0) return `${days} дн. ${hours} год.`;
    if (hours > 0) return `${hours} год. ${mins} хв.`;
    return `${mins} хв.`;
}

export function getInitials(fullName) {
    if (!fullName) return '?';
    const parts = String(fullName).trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return '?';
    if (parts.length === 1) return parts[0].charAt(0).toUpperCase();
    return (parts[0].charAt(0) + parts[1].charAt(0)).toUpperCase();
}

const AVATAR_GRADIENTS = [
    'linear-gradient(135deg, #4FA3FF, #007AFF)',
    'linear-gradient(135deg, #4CD97B, #34C759)',
    'linear-gradient(135deg, #FFB157, #FF9500)',
    'linear-gradient(135deg, #C77DFF, #AF52DE)',
    'linear-gradient(135deg, #FF7A73, #FF3B30)',
    'linear-gradient(135deg, #5AC8FA, #0091C2)'
];

export function avatarGradient(name) {
    let sum = 0;
    for (let i = 0; i < (name || '').length; i++) sum += name.charCodeAt(i);
    return AVATAR_GRADIENTS[sum % AVATAR_GRADIENTS.length];
}

// ------------------------------------------------------------
// СПОВІЩЕННЯ (замість alert)
// ------------------------------------------------------------
export function toast(message, type = 'info') {
    let host = document.getElementById('toastHost');
    if (!host) {
        host = document.createElement('div');
        host.id = 'toastHost';
        host.className = 'toast-host';
        document.body.appendChild(host);
    }
    const el = document.createElement('div');
    el.className = `toast toast-${type}`;
    const icons = {
        success: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>',
        error: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>',
        info: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="12" y1="8" x2="12" y2="8"></line><line x1="12" y1="12" x2="12" y2="16"></line></svg>'
    };
    el.innerHTML = `<span class="toast-icon">${icons[type] || icons.info}</span><span>${escapeHtml(message)}</span>`;
    host.appendChild(el);
    setTimeout(() => {
        el.classList.add('toast-out');
        setTimeout(() => el.remove(), 300);
    }, 3200);
}

/** Підтвердження в стилі застосунку (замість системного confirm). */
export function confirmDialog(title, message, confirmLabel = 'Видалити') {
    return new Promise((resolve) => {
        const overlay = document.createElement('div');
        overlay.className = 'confirm-overlay';
        overlay.innerHTML = `
            <div class="confirm-box">
                <h3 class="confirm-title">${escapeHtml(title)}</h3>
                <p class="confirm-text">${escapeHtml(message)}</p>
                <div class="confirm-actions">
                    <button class="btn-soft confirm-cancel">Скасувати</button>
                    <button class="btn-soft btn-soft-danger confirm-ok">${escapeHtml(confirmLabel)}</button>
                </div>
            </div>`;
        document.body.appendChild(overlay);
        const done = (value) => { overlay.remove(); resolve(value); };
        overlay.querySelector('.confirm-ok').addEventListener('click', () => done(true));
        overlay.querySelector('.confirm-cancel').addEventListener('click', () => done(false));
        overlay.addEventListener('click', (e) => { if (e.target === overlay) done(false); });
    });
}

// ------------------------------------------------------------
// ВИСУВНІ ПАНЕЛІ (bottom sheets)
// Стан тримаємо в класі .is-open, а не в inline-стилях —
// саме змішування цих двох підходів і породило попередній баг.
// ------------------------------------------------------------
const SHEET_IDS = ['notifPopup', 'menuPopup'];

export function closeAllSheets() {
    SHEET_IDS.forEach(id => document.getElementById(id)?.classList.remove('is-open'));
    document.getElementById('navBackdrop')?.classList.remove('is-open');
    document.body.classList.remove('no-scroll');
}

export function isSheetOpen(id) {
    return document.getElementById(id)?.classList.contains('is-open') === true;
}

export function openSheet(id) {
    closeAllSheets();
    document.getElementById(id)?.classList.add('is-open');
    document.getElementById('navBackdrop')?.classList.add('is-open');
    document.body.classList.add('no-scroll');
}

export function toggleSheet(id) {
    if (isSheetOpen(id)) closeAllSheets();
    else openSheet(id);
}

export function initSheets() {
    document.getElementById('navBackdrop')?.addEventListener('click', closeAllSheets);
    document.querySelectorAll('[data-close-sheet]').forEach(btn => {
        btn.addEventListener('click', closeAllSheets);
    });
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') closeAllSheets();
    });
}

// ------------------------------------------------------------
// ЕКРАНИ
// ------------------------------------------------------------
const SCREENS = ['loginSection', 'passwordSection', 'dataSection',
                 'adminDashboardSection', 'docsSection', 'boardSection', 'requestsSection'];

export function showScreen(id) {
    SCREENS.forEach(s => {
        const el = document.getElementById(s);
        if (el) el.style.display = (s === id) ? 'block' : 'none';
    });
    const loader = document.getElementById('appLoader');
    if (loader) loader.style.display = 'none';
    window.scrollTo({ top: 0 });
}

// ------------------------------------------------------------
// КНОПКИ З ІНДИКАТОРОМ ЗАВАНТАЖЕННЯ
// ------------------------------------------------------------
export function setBusy(btn, busy, busyLabel = 'Зачекайте…') {
    if (!btn) return;
    if (busy) {
        btn.dataset.originalHtml = btn.innerHTML;
        btn.disabled = true;
        btn.innerHTML = `<span class="spinner"></span>${escapeHtml(busyLabel)}`;
    } else {
        btn.disabled = false;
        if (btn.dataset.originalHtml) btn.innerHTML = btn.dataset.originalHtml;
    }
}
