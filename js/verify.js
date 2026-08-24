// ============================================================
// Звірка списків співвласників — бік правління.
//
// Мешканець може лише запропонувати зміну; застосувати її до бази
// може тільки правління. Ця черга і є тим місцем, де вирішується,
// чи можна вірити реєстру власників — а отже й результатам
// голосування. Тому вона стоїть першою у вкладці «Квартири», а не
// схована десь нижче.
// ============================================================
import { db } from './firebase.js';
import {
    collection, collectionGroup, doc, getDocs,
    updateDoc, writeBatch, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js";
import { escapeHtml, toast, setBusy, promptDialog, normName } from './ui.js';
import { fetchDirectory, invalidateDirectory } from './directory.js';
import { prefillAnnouncement } from './messages.js';

const aptOf = (ref) => ref.path.split('/')[1];

const ms = (ts) => (ts?.toMillis ? ts.toMillis() : 0);

/** Скільки чекає заявка — правління має бачити, що завислo. */
function waited(msVal) {
    if (!msVal) return '';
    const d = Math.floor((Date.now() - msVal) / 86400000);
    if (d < 1) return 'сьогодні';
    if (d === 1) return 'учора';
    return `${d} дн. тому`;
}

function ownerLine(o) {
    const share = o.shareFrac || o.sharePerc ? ` — ${escapeHtml(o.shareFrac || o.sharePerc + '%')}` : '';
    return `<li>${escapeHtml(o.name || '—')}${share}</li>`;
}

/** Що саме змінилося: підсвічуємо появу й зникнення імен. */
function diffHtml(before, after) {
    // Та сама нормалізація, що й у кворумі — інакше зміна пробілу
    // читалася б як заміна людини.
    const names = (arr) => new Set((arr || []).map(o => normName(o.name)));
    const wasNames = names(before), nowNames = names(after);
    const added = (after || []).filter(o => !wasNames.has(normName(o.name)));
    const gone = (before || []).filter(o => !nowNames.has(normName(o.name)));

    return `<div class="vf-diff">
        <div class="vf-col">
            <span class="vf-col-label">Було</span>
            <ul class="vf-list">${(before || []).map(ownerLine).join('') || '<li class="vf-none">порожньо</li>'}</ul>
        </div>
        <div class="vf-col">
            <span class="vf-col-label">Стане</span>
            <ul class="vf-list">${(after || []).map(ownerLine).join('') || '<li class="vf-none">порожньо</li>'}</ul>
        </div>
    </div>
    ${added.length ? `<p class="vf-added">Додається: ${added.map(o => escapeHtml(o.name)).join(', ')}</p>` : ''}
    ${gone.length ? `<p class="vf-gone">Прибирається: ${gone.map(o => escapeHtml(o.name)).join(', ')}</p>` : ''}`;
}

let pending = [];
let notResponded = [];

/** Скільки заявок чекає рішення — потрібно дашборду. */
export const pendingChangesCount = () => pending.length;

export async function loadVerifyQueue() {
    const host = document.getElementById('verifyQueue');
    const stats = document.getElementById('verifyStats');
    if (!host) return;
    host.innerHTML = '<p class="list-empty">Завантаження…</p>';

    try {
        // Ні where, ні orderBy: запит із фільтром по collectionGroup
        // вимагає окремого індексу з ГРУПОВОЮ областю, а такий
        // автоматично не створюється — саме через це черга падала з
        // помилкою. Заявок тут одиниці, тож фільтруємо в памʼяті.
        const snap = await getDocs(collectionGroup(db, 'owner_changes'));
        pending = snap.docs
            .map(d => ({ id: d.id, apt: aptOf(d.ref), ...d.data(), at: ms(d.data().createdAt) }))
            .filter(c => c.status === 'pending')
            .sort((a, b) => a.at - b.at);

        host.innerHTML = pending.length
            ? pending.map(c => `<div class="vf-card" data-apt="${escapeHtml(c.apt)}" data-id="${escapeHtml(c.id)}">
                <div class="vf-head">
                    <b>Квартира ${escapeHtml(c.apt)}</b>
                    <span class="vf-when">${escapeHtml(waited(c.at))}</span>
                </div>
                <p class="vf-reason">${escapeHtml(c.reason || 'Причину не вказано')}</p>
                ${diffHtml(c.before, c.after)}
                <div class="vf-actions">
                    <button type="button" class="btn-primary btn-compact" data-approve>Прийняти</button>
                    <button type="button" class="vf-reject" data-reject>Відхилити</button>
                </div>
            </div>`).join('')
            : '<p class="list-empty">Заявок на зміну немає</p>';

        const count = document.getElementById('verifyQueueCount');
        if (count) count.textContent = pending.length ? ` · ${pending.length}` : '';

        // Значок на вкладці: заявка, яку ніхто не помітив, лежатиме
        // тижнями — а це саме те, від чого залежить реєстр власників.
        const badge = document.getElementById('adminOwnersBadge');
        if (badge) {
            badge.textContent = pending.length > 9 ? '9+' : pending.length;
            badge.style.display = pending.length ? 'flex' : 'none';
        }

        await renderCoverage(stats);
    } catch (e) {
        console.error('Черга звірки:', e);
        host.innerHTML = '<p class="list-empty">Не вдалося завантажити заявки</p>';
    }
}

async function renderCoverage(stats) {
    if (!stats) return;
    try {
        const dir = await fetchDirectory();
        const n = { confirmed: 0, review: 0, pending: 0 };
        dir.forEach(a => { n[a.ownersStatus] = (n[a.ownersStatus] || 0) + 1; });
        const total = dir.length || 1;
        const pct = Math.round((n.confirmed / total) * 100);

        // Список тих, кому є сенс нагадати
        notResponded = dir.filter(a => a.ownersStatus === 'pending').map(a => a.apt);

        stats.innerHTML = `<div class="vf-bar"><i style="width:${pct}%"></i></div>
        <p class="vf-bar-note">Звірено <b>${n.confirmed}</b> із <b>${dir.length}</b> квартир — ${pct}%</p>
        ${n.pending ? `<button type="button" class="vf-remind" id="verifyRemindBtn">
            Підготувати нагадування для ${n.pending} ${n.pending === 1 ? 'квартири' : 'квартир'}
        </button>` : ''}`;

        document.getElementById('verifyRemindBtn')?.addEventListener('click', remind);
    } catch (e) {
        console.warn('Покриття звірки:', e);
        stats.innerHTML = '';
    }
}

/** Готує адресну розсилку тим, хто не відповів. Надсилає правління сама. */
function remind() {
    if (!notResponded.length) return;
    prefillAnnouncement({
        title: 'Перевірте список співвласників вашої квартири',
        body: 'Шановні мешканці!\n\nГолосування ОСББ рахується за співвласниками. '
            + 'Щоб ваш голос рахувався правильно, зайдіть у застосунок і підтвердіть, '
            + 'що список власників вашої квартири вірний — це один дотик. '
            + 'Якщо дані змінилися, надішліть виправлення, і ми їх звіримо.\n\n'
            + 'З повагою, Правління ОСББ «Успіх-25»',
        apartments: notResponded
    });
    document.querySelector('.admin-tab[data-tab="send"]')?.click();
    toast('Текст і список квартир підготовлено — перевірте й надішліть', 'success');
}

/** Застосовує запропонований список до бази. */
async function approve(apt, id, btn) {
    const change = pending.find(c => c.apt === apt && c.id === id);
    if (!change) return;

    setBusy(btn, true, 'Застосовуємо…');
    try {
        const ownersRef = collection(db, 'apartments', apt, 'owners');
        const existing = await getDocs(ownersRef);

        const batch = writeBatch(db);
        existing.forEach(d => batch.delete(d.ref));
        (change.after || []).forEach(o => batch.set(doc(ownersRef), o));
        batch.set(doc(db, 'apartments', apt), {
            ownersStatus: 'confirmed',
            ownersConfirmedAt: serverTimestamp(),
            ownersConfirmedBy: 'board',
            // Рішення кладемо в документ квартири, а не лише в заявку:
            // мешканець дивиться саме сюди, і без цього він не дізнався б,
            // що сталося з його правками.
            ownersDecision: { status: 'approved', at: Date.now() }
        }, { merge: true });
        batch.set(doc(db, 'apartments', apt, 'owner_changes', id), {
            status: 'approved', decidedAt: serverTimestamp()
        }, { merge: true });
        await batch.commit();

        invalidateDirectory();
        toast(`Кв. ${apt}: зміни застосовано`, 'success');
        await loadVerifyQueue();
    } catch (e) {
        console.error('Прийняття заявки:', e);
        toast('Не вдалося застосувати', 'error');
        setBusy(btn, false);
    }
}

async function reject(apt, id) {
    const note = await promptDialog('Відхилити заявку?',
        `Кв. ${apt}. Напишіть, чому — мешканець побачить цю причину.`,
        { placeholder: 'Напр.: потрібен витяг із реєстру', confirmLabel: 'Відхилити' });
    if (!note) return;

    try {
        await updateDoc(doc(db, 'apartments', apt, 'owner_changes', id), {
            status: 'rejected', decision: note, decidedAt: serverTimestamp()
        });
        // Повертаємо квартиру в «не підтверджено»: список лишився старий.
        // Причину кладемо поруч — інакше мешканець бачив би лише те, що
        // його заявка кудись зникла.
        await updateDoc(doc(db, 'apartments', apt), {
            ownersStatus: 'pending',
            ownersDecision: { status: 'rejected', note, at: Date.now() }
        });
        toast(`Кв. ${apt}: заявку відхилено`, 'success');
        await loadVerifyQueue();
    } catch (e) {
        console.error('Відхилення заявки:', e);
        toast('Не вдалося відхилити', 'error');
    }
}

/**
 * Підтвердження від імені правління.
 *
 * Частина мешканців ніколи не зайде в застосунок — принесе папери
 * особисто або скаже на зборах. Без цього їхні квартири назавжди
 * лишилися б «не звіреними». У базі лишається слід, що підтвердило
 * саме правління, і на якій підставі.
 */
export async function confirmByBoard(apt) {
    const note = await promptDialog('Підтвердити від імені правління?',
        `Кв. ${apt}. Напишіть підставу — вона лишиться в записі.`,
        { placeholder: 'Напр.: принесла витяг особисто 12.09', confirmLabel: 'Підтвердити' });
    if (!note) return false;

    try {
        await updateDoc(doc(db, 'apartments', apt), {
            ownersStatus: 'confirmed',
            ownersConfirmedAt: serverTimestamp(),
            ownersConfirmedBy: 'board',
            ownersConfirmNote: note
        });
        invalidateDirectory();
        toast(`Кв. ${apt}: список підтверджено`, 'success');
        return true;
    } catch (e) {
        console.error('Підтвердження правлінням:', e);
        toast('Не вдалося підтвердити', 'error');
        return false;
    }
}

export function initVerify() {
    document.getElementById('verifyQueue')?.addEventListener('click', (e) => {
        const card = e.target.closest('.vf-card');
        if (!card) return;
        const { apt, id } = card.dataset;
        if (e.target.closest('[data-approve]')) approve(apt, id, e.target.closest('[data-approve]'));
        else if (e.target.closest('[data-reject]')) reject(apt, id);
    });
    document.getElementById('verifyRefreshBtn')?.addEventListener('click', () => {
        invalidateDirectory();
        loadVerifyQueue();
    });
}
