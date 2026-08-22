// ============================================================
// Довідник квартир для правління: список, пошук і картка
// з даними співвласників.
//
// Співвласники всіх квартир читаються ОДНИМ collectionGroup-
// запитом. Інакше на кожну квартиру довелося б робити окремий
// запит, і відкриття довідника коштувало б сотні читань.
// ============================================================
import { db } from './firebase.js';
import {
    collection, collectionGroup, getDocs
} from "https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js";
import { escapeHtml, getInitials, avatarGradient, toast } from './ui.js';

let cache = null;          // [{ apt, entrance, area, owners: [...] }]

function ownerApt(docRef) {
    // Шлях виду apartments/{apt}/owners/{id} — номер квартири
    // це передостанній сегмент.
    const parts = docRef.path.split('/');
    return parts[parts.length - 3];
}

/** Квартири з їхніми співвласниками. Кеш живе до «Оновити». */
export async function fetchDirectory() {
    if (cache) return cache;

    const [aptSnap, ownerSnap] = await Promise.all([
        getDocs(collection(db, 'apartments')),
        getDocs(collectionGroup(db, 'owners'))
    ]);

    const byApt = {};
    ownerSnap.forEach(d => {
        const apt = ownerApt(d.ref);
        (byApt[apt] ||= []).push(d.data());
    });

    // Обліковий запис правління — службовий, а не квартира. Він не має
    // потрапляти ні в довідник, ні в кворум, ні в лічильники: інакше
    // будинок «набував» зайвого співвласника й зайвої площі.
    cache = aptSnap.docs
        .filter(d => d.data().isAdmin !== true)
        .map(d => {
            const data = d.data();
            return {
                apt: d.id,
                entrance: data.entrance || '',
                area: data.area || '',
                owners: byApt[d.id] || []
            };
        })
        .sort((a, b) => (parseInt(a.apt, 10) || 0) - (parseInt(b.apt, 10) || 0));

    return cache;
}

/** Шукає і за номером квартири, і за прізвищем чи документом. */
function matches(entry, q) {
    if (!q) return true;
    if (entry.apt.toLowerCase().includes(q)) return true;
    return entry.owners.some(o =>
        (o.name || '').toLowerCase().includes(q) ||
        (o.docInfo || '').toLowerCase().includes(q));
}

function ownerLine(o) {
    const share = o.shareFrac ? `<span class="dir-share">${escapeHtml(o.shareFrac)}</span>` : '';
    return `<div class="dir-owner">
        <span class="dir-avatar" style="background: ${avatarGradient(o.name || '')};">${escapeHtml(getInitials(o.name || ''))}</span>
        <span class="dir-owner-text">
            <span class="dir-owner-name">${escapeHtml(o.name || 'Без імені')}</span>
            ${o.docInfo ? `<span class="dir-owner-doc">${escapeHtml(o.docInfo)}</span>` : ''}
        </span>
        ${share}
    </div>`;
}

function render(list) {
    const host = document.getElementById('directoryList');
    if (!host) return;

    if (!list.length) {
        host.innerHTML = '<p class="list-empty">Нічого не знайдено</p>';
        return;
    }

    host.innerHTML = list.map(e => `
        <div class="dir-card" data-apt="${escapeHtml(e.apt)}">
            <button type="button" class="dir-head">
                <span class="dir-apt">${escapeHtml(e.apt)}</span>
                <span class="dir-head-text">
                    <span class="dir-title">Квартира ${escapeHtml(e.apt)}</span>
                    <span class="dir-meta">${e.entrance && e.entrance !== '--' ? `Парадна ${escapeHtml(String(e.entrance))}` : 'Парадна —'}
                        · ${e.area ? escapeHtml(String(e.area)) + ' м²' : 'площа —'}
                        · ${e.owners.length ? `співвласників: ${e.owners.length}` : 'без співвласників'}</span>
                </span>
                <svg class="row-chevron dir-chevron" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"></polyline></svg>
            </button>
            <div class="dir-body" hidden>
                ${e.owners.length
                    ? e.owners.map(ownerLine).join('')
                    : '<p class="muted-note">Дані про співвласників не внесено</p>'}
            </div>
        </div>`).join('');

    host.querySelectorAll('.dir-head').forEach(btn => {
        btn.addEventListener('click', () => {
            const card = btn.closest('.dir-card');
            const body = card.querySelector('.dir-body');
            body.hidden = !body.hidden;
            card.classList.toggle('dir-open', !body.hidden);
        });
    });
}

export async function loadDirectory() {
    const host = document.getElementById('directoryList');
    if (!host) return;
    host.innerHTML = '<p class="list-empty">Завантаження…</p>';
    try {
        const all = await fetchDirectory();
        document.getElementById('directoryCount').textContent =
            `Квартир: ${all.length}`;
        render(all);
    } catch (e) {
        console.error('Довідник квартир:', e);
        host.innerHTML = '<p class="list-empty">Не вдалося завантажити довідник</p>';
    }
}

export function initDirectory() {
    const input = document.getElementById('directorySearch');
    input?.addEventListener('input', async () => {
        const q = input.value.trim().toLowerCase();
        try {
            const all = await fetchDirectory();
            render(all.filter(e => matches(e, q)));
        } catch (e) {
            console.error(e);
        }
    });

    document.getElementById('directoryRefreshBtn')?.addEventListener('click', async () => {
        cache = null;
        if (input) input.value = '';
        await loadDirectory();
        toast('Довідник оновлено', 'success');
    });
}

/** Скидає кеш — щоб підрахунок кворуму брав свіжі дані. */
export function invalidateDirectory() { cache = null; }
