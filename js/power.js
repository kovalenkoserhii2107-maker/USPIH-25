// ============================================================
// Статус електропостачання: тумблер адміна + живе оновлення
// в усіх користувачів через onSnapshot.
// ============================================================
import { db } from './firebase.js';
import {
    doc, setDoc, onSnapshot, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js";
import { formatElapsed, toast } from './ui.js';

let unsubscribe = null;
let durationTimer = null;
let changedAtMs = null;
let isOn = true;

function bulbSvg(on) {
    const base = '<path d="M9 18h6"></path><path d="M10 22h4"></path>';
    const bulb = '<path d="M12 2a6 6 0 0 0-4 10.5c.6.6 1 1.4 1 2.5h6c0-1.1.4-1.9 1-2.5A6 6 0 0 0 12 2z"'
        + (on ? ' fill="currentColor" fill-opacity="0.2"' : '') + '></path>';
    const rays = on
        ? '<line x1="12" y1="0.5" x2="12" y2="2"></line><line x1="20.5" y1="4" x2="19" y2="5.5"></line><line x1="3.5" y1="4" x2="5" y2="5.5"></line>'
        : '';
    return `<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${base}${bulb}${rays}</svg>`;
}

function formatSince(date) {
    return date ? date.toLocaleString('uk-UA', {
        day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit'
    }) : '';
}

function updateDuration() {
    if (changedAtMs == null) return;
    const label = `Вже ${formatElapsed(Date.now() - changedAtMs)}${isOn ? '' : ' без світла'}`;
    ['powerDurationText', 'adminPowerDurationText'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.textContent = label;
    });
}

function render(on, changedAt) {
    isOn = on;
    changedAtMs = changedAt ? changedAt.getTime() : null;
    const since = changedAt ? `з ${formatSince(changedAt)}` : '';

    [['powerCard', 'powerStatusText', 'powerSinceText', 'powerIconCircle'],
     ['adminPowerCard', 'adminPowerStatusText', 'adminPowerSinceText', 'adminPowerIconWrap']]
    .forEach(([cardId, textId, sinceId, iconId]) => {
        const card = document.getElementById(cardId);
        if (card) {
            card.classList.toggle('power-on', on);
            card.classList.toggle('power-off', !on);
        }
        const text = document.getElementById(textId);
        if (text) text.textContent = on ? 'Світло є' : 'Світла немає';
        const sinceEl = document.getElementById(sinceId);
        if (sinceEl) sinceEl.textContent = since;
        const icon = document.getElementById(iconId);
        if (icon) icon.innerHTML = bulbSvg(on);
    });

    const toggle = document.getElementById('powerToggleInput');
    if (toggle) toggle.checked = on;

    updateDuration();
}

export function startPowerListener() {
    if (unsubscribe) return;
    unsubscribe = onSnapshot(doc(db, 'status', 'power'), (snap) => {
        if (snap.exists()) {
            const data = snap.data();
            render(data.isOn !== false, data.changedAt ? data.changedAt.toDate() : null);
        } else {
            render(true, null);
        }
    }, (error) => console.error('Статус світла:', error));

    if (!durationTimer) durationTimer = setInterval(updateDuration, 30000);
}

export function stopPowerListener() {
    if (unsubscribe) { unsubscribe(); unsubscribe = null; }
    if (durationTimer) { clearInterval(durationTimer); durationTimer = null; }
}

export function initPowerToggle() {
    document.getElementById('powerToggleInput')?.addEventListener('change', async function () {
        const newState = this.checked;
        this.disabled = true;
        try {
            await setDoc(doc(db, 'status', 'power'), { isOn: newState, changedAt: serverTimestamp() });
            toast(newState ? 'Позначено: світло є' : 'Позначено: світла немає', 'success');
        } catch (error) {
            console.error(error);
            toast('Не вдалося оновити статус', 'error');
            this.checked = !newState;
        } finally {
            this.disabled = false;
        }
    });
}
