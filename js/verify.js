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
import { fileNameFromUrl } from './attachments.js';
import { fetchDirectory, invalidateDirectory } from './directory.js';
import { prefillAnnouncement, notifyApartment } from './messages.js';

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

const urls = (o) => String(o.fileUrls || '').split(',').map(u => u.trim()).filter(Boolean);
const shareOf = (o) => o.shareFrac || (o.sharePerc ? `${o.sharePerc}%` : '');

// Поля, які правління звіряє з документами. Порядок — за важливістю:
// частка вирішує вагу голосу, документ — чи є на неї підстава.
const FIELDS = [
    { label: 'Частка', get: shareOf },
    { label: 'Документ', get: (o) => o.docInfo || '' }
];

const val = (v) => v ? escapeHtml(v) : '<i class="vf-empty">не вказано</i>';

/** Посилання на скан: правління має мати змогу відкрити й перевірити. */
function fileLinks(list, cls) {
    if (!list.length) return '';
    return list.map((u, i) => `<a class="vf-file ${cls}" href="${escapeHtml(u)}"
        target="_blank" rel="noopener">${escapeHtml(fileNameFromUrl(u, i))}</a>`).join('');
}

/** Рядок «було → стане» для одного поля. */
function fieldRow(label, was, now) {
    if (was === now) return '';
    return `<div class="vf-f">
        <span class="vf-f-label">${label}</span>
        <span class="vf-f-val">
            <s class="vf-f-old">${val(was)}</s>
            <b class="vf-f-new">${val(now)}</b>
        </span>
    </div>`;
}

/** Усі поля людини — для доданих і прибраних, де порівнювати нема з чим. */
function fullRows(o) {
    const f = urls(o);
    return FIELDS.map(({ label, get }) => `<div class="vf-f">
        <span class="vf-f-label">${label}</span>
        <span class="vf-f-val"><b class="vf-f-new">${val(get(o))}</b></span>
    </div>`).join('')
    + (f.length ? `<div class="vf-f">
        <span class="vf-f-label">Файли</span>
        <span class="vf-f-val vf-files">${fileLinks(f, 'vf-file-new')}</span>
    </div>` : '');
}

/**
 * Що саме змінилося — по кожній людині окремо.
 *
 * Дві колонки імен показували лише імена, тож зміна документа чи
 * доданий скан виглядали як «нічого не змінилося»: обидва списки
 * однакові, а заявка є. Тепер видно кожне поле, що поїхало, і
 * файли, які додали, — з посиланням, щоб їх можна було відкрити.
 */
function diffHtml(before, after) {
    // Та сама нормалізація, що й у кворумі — інакше зміна пробілу
    // читалася б як заміна людини.
    const key = (o) => normName(o.name);
    const beforeBy = new Map((before || []).map(o => [key(o), o]));
    const afterKeys = new Set((after || []).map(key));

    const rows = [];

    (after || []).forEach(o => {
        const was = beforeBy.get(key(o));
        if (!was) {
            rows.push({ kind: 'add', tag: 'додається', name: o.name, body: fullRows(o) });
            return;
        }
        const wasFiles = urls(was), nowFiles = urls(o);
        const addedFiles = nowFiles.filter(u => !wasFiles.includes(u));
        const goneFiles = wasFiles.filter(u => !nowFiles.includes(u));

        let body = FIELDS.map(({ label, get }) => fieldRow(label, get(was), get(o))).join('');
        if (addedFiles.length || goneFiles.length) {
            body += `<div class="vf-f">
                <span class="vf-f-label">Файли</span>
                <span class="vf-f-val vf-files">
                    ${fileLinks(addedFiles, 'vf-file-new')}
                    ${fileLinks(goneFiles, 'vf-file-gone')}
                    <span class="vf-f-note">${[
                        addedFiles.length ? `додано ${addedFiles.length}` : '',
                        goneFiles.length ? `прибрано ${goneFiles.length}` : ''
                    ].filter(Boolean).join(', ')}</span>
                </span>
            </div>`;
        }
        rows.push(body
            ? { kind: 'edit', tag: 'змінено', name: o.name, body }
            : { kind: 'same', tag: 'без змін', name: o.name, body: '' });
    });

    (before || []).filter(o => !afterKeys.has(key(o))).forEach(o => {
        rows.push({ kind: 'gone', tag: 'прибирається', name: o.name, body: fullRows(o) });
    });

    // Незмінені йдуть у кінець: правління дивиться на те, що поїхало.
    const order = { add: 0, edit: 1, gone: 2, same: 3 };
    rows.sort((a, b) => order[a.kind] - order[b.kind]);

    const touched = rows.filter(r => r.kind !== 'same').length;
    const summary = touched
        ? `<p class="vf-sum">${[
              rows.filter(r => r.kind === 'add').length ? `додається ${rows.filter(r => r.kind === 'add').length}` : '',
              rows.filter(r => r.kind === 'edit').length ? `змінюється ${rows.filter(r => r.kind === 'edit').length}` : '',
              rows.filter(r => r.kind === 'gone').length ? `прибирається ${rows.filter(r => r.kind === 'gone').length}` : ''
          ].filter(Boolean).join(' · ')}</p>`
        // Заявка без відмінностей — теж інформація: значить мешканець
        // надіслав те саме, і правління має це бачити, а не гадати.
        : `<p class="vf-sum vf-sum-none">Відмінностей у даних немає</p>`;

    return summary + `<ul class="vf-changes">${rows.map(r => `
        <li class="vf-change vf-change-${r.kind}">
            <span class="vf-change-head">
                <b>${escapeHtml(r.name || '—')}</b>
                <span class="vf-tag vf-tag-${r.kind}">${r.tag}</span>
            </span>
            ${r.body ? `<div class="vf-fields">${r.body}</div>` : ''}
        </li>`).join('')}</ul>`;
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

        // Показник і дія — в одному рядку: окремою смугою на всю ширину
        // кнопка виглядала як частина списку, а не як дія над покриттям.
        stats.innerHTML = `<div class="vf-bar"><i style="width:${pct}%"></i></div>
        <div class="vf-cover">
            <p class="vf-bar-note">Звірено <b>${n.confirmed}</b> із <b>${dir.length}</b> — ${pct}%</p>
            ${n.pending ? `<button type="button" class="vf-remind" id="verifyRemindBtn">
                Нагадати ${n.pending}
            </button>` : ''}
        </div>`;

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

        await notifyApartment({
            apt,
            title: 'Зміни у списку співвласників прийнято',
            body: 'Правління звірило надіслані вами зміни з документами і прийняло їх.\n\n'
                + 'Список співвласників вашої квартири оновлено. Тепер він вважається '
                + 'звіреним — ваш голос на зборах ОСББ рахуватиметься за ним.'
        });

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
        await notifyApartment({
            apt,
            kind: 'ownersFix',
            title: 'Зміни у списку співвласників не прийнято',
            body: `Правління переглянуло надіслані вами зміни і не змогло їх прийняти.\n\n`
                + `Причина: ${note}\n\n`
                + 'Список залишився без змін. Відкрийте розділ «Співвласники», виправте дані '
                + 'й надішліть ще раз — або підтвердіть список, якщо він усе-таки вірний.'
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
        // Запис змінили без участі мешканця — він має про це дізнатися.
        await notifyApartment({
            apt,
            title: 'Список співвласників підтверджено правлінням',
            body: `Правління підтвердило список співвласників вашої квартири від вашого імені.\n\n`
                + `Підстава: ${note}\n\n`
                + 'Якщо в списку щось не так — відкрийте розділ «Співвласники», '
                + 'виправте дані й надішліть на перевірку.'
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

/**
 * Відкриває редактор списку від імені правління.
 *
 * Частина мешканців похилого віку не впорається з формою сама —
 * правління вносить дані замість них. Екран той самий, що й у
 * мешканця: інший інтерфейс довелося б підтримувати окремо, і вони
 * почали б розходитися.
 */
export async function openOwnersEditor(apt) {
    const own = await import('./owners.js');
    const { showScreen } = await import('./ui.js');

    own.useOwnersTarget({ host: 'ownersEditContainer', apt });
    document.getElementById('ownersEditTitle').textContent = `Квартира ${apt}`;
    showScreen('ownersEditSection');
    await own.loadOwners(apt);
}

/** Повертає модуль до кабінету мешканця. */
async function closeOwnersEditor() {
    const own = await import('./owners.js');
    own.useOwnersTarget();
}

async function saveOwnersAsBoard(btn) {
    const own = await import('./owners.js');
    setBusy(btn, true, 'Зберігаємо…');
    try {
        const apt = await own.saveOwnersDirect();
        if (apt) await notifyApartment({
            apt,
            title: 'Правління оновило список співвласників',
            body: 'Правління внесло зміни до списку співвласників вашої квартири '
                + 'і позначило його як звірений.\n\n'
                + 'Перегляньте розділ «Співвласники». Якщо щось не так — виправте дані '
                + 'й надішліть на перевірку.'
        });
        invalidateDirectory();
        toast('Список збережено й позначено як звірений', 'success');
        await closeOwnersEditor();
        const { showScreen } = await import('./ui.js');
        showScreen('adminDashboardSection');
        const { loadDirectory } = await import('./directory.js');
        loadDirectory();
        loadVerifyQueue();
    } catch (e) {
        console.error('Збереження списку правлінням:', e);
        toast('Не вдалося зберегти. Перевірте інтернет.', 'error');
        setBusy(btn, false);
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
    document.getElementById('saveOwnersAdminBtn')
        ?.addEventListener('click', function () { saveOwnersAsBoard(this); });
    document.getElementById('backFromOwnersEditBtn')?.addEventListener('click', async () => {
        await closeOwnersEditor();
        const { showScreen } = await import('./ui.js');
        showScreen('adminDashboardSection');
    });
    document.getElementById('addOwnerAdminBtn')?.addEventListener('click', async () => {
        const { addOwner } = await import('./owners.js');
        addOwner();
    });

    document.getElementById('verifyRefreshBtn')?.addEventListener('click', () => {
        invalidateDirectory();
        loadVerifyQueue();
    });
}
