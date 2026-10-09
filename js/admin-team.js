// ============================================================
// Команда правління й журнал дій.
//
// Ролі призначає голова: члену правління — номер його квартири,
// бухгалтеру без квартири — службовий номер. Журнал читає вся команда:
// хто, коли й що змінив. Обидва набори даних захищають правила.
// ============================================================
import { db, currentApt, session } from './firebase.js';
import {
    doc, collection, getDoc, getDocs, query, where, orderBy, limit, startAfter, writeBatch, serverTimestamp
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js';
import { escapeHtml, toast, setBusy, confirmDialog, formatDateTime } from './ui.js';
import { ROLES, ROLE_LABELS, hasRight } from './staff-core.js';
import { auditIn } from './audit.js';

const el = id => document.getElementById(id);
const LEGACY_NAME = 'Спільний вхід правління';
let team = [], journal = [], journalCursor = null, journalDone = false, journalRequest = 0;

// ------------------------------------------------------------
// КОМАНДА
// ------------------------------------------------------------
async function fetchTeam() {
    const [staffSnap, serviceSnap] = await Promise.all([
        getDocs(collection(db, 'staff')),
        getDocs(query(collection(db, 'apartments'), where('isAdmin', '==', true)))
    ]);
    const members = staffSnap.docs.map(row => ({ id: row.id, ...row.data() }));
    const known = new Set(members.map(member => member.id));
    const service = new Set(serviceSnap.docs.map(row => row.id));
    // Старий спільний вхід без документа ролі діє як голова — показуємо
    // його окремо, щоб голова бачив і міг вимкнути.
    const legacy = [...service].filter(id => !known.has(id))
        .map(id => ({ id, role: 'chair', name: LEGACY_NAME, active: true, legacy: true }));
    return [...members, ...legacy].map(member => ({ ...member, service: service.has(member.id) }))
        .sort((a, b) => Number(b.active) - Number(a.active) || ROLES.indexOf(a.role) - ROLES.indexOf(b.role)
            || String(a.name).localeCompare(String(b.name), 'uk'));
}

function teamRowHtml(member) {
    const me = member.id === currentApt(), chair = hasRight(session.role, 'chair');
    const login = member.service ? `службовий № ${member.id}` : `кв. ${member.id}`;
    const controls = chair && !me ? `<div class="team-actions">
        ${member.legacy ? '' : `<select class="field-input field-select team-role" data-team-role="${escapeHtml(member.id)}" aria-label="Роль ${escapeHtml(member.name)}">
            ${ROLES.map(role => `<option value="${role}"${role === member.role ? ' selected' : ''}>${ROLE_LABELS[role]}</option>`).join('')}</select>`}
        <button type="button" class="btn-soft btn-compact${member.active ? ' btn-soft-danger' : ''}" data-team-toggle="${escapeHtml(member.id)}">${member.active ? 'Вимкнути' : 'Увімкнути'}</button>
    </div>` : '';
    return `<li class="team-row${member.active ? '' : ' is-off'}">
        <span class="team-avatar" aria-hidden="true">${escapeHtml(String(member.name || '?').trim().charAt(0).toUpperCase())}</span>
        <span class="team-main"><b>${escapeHtml(member.name || login)}${me ? ' <small class="team-me">це ви</small>' : ''}</b>
            <small>${escapeHtml(ROLE_LABELS[member.role] || member.role)} · ${escapeHtml(login)}${member.active ? '' : ' · вимкнено'}</small>
            ${member.legacy ? '<small class="team-warn">Один пароль на кількох людей: у журналі не видно, хто саме діяв. Коли всі увійдуть під своїми номерами — вимкніть.</small>' : ''}</span>
        ${controls}</li>`;
}

function renderTeam() {
    el('teamList').innerHTML = team.length
        ? `<ul class="team-list">${team.map(teamRowHtml).join('')}</ul>`
        : '<p class="list-empty">У команді ще нікого немає.</p>';
    el('teamAddCard').hidden = !hasRight(session.role, 'chair');
}

export async function loadTeam() {
    el('teamList').innerHTML = '<p class="list-empty">Завантаження…</p>';
    try { team = await fetchTeam(); renderTeam(); }
    catch (error) {
        console.error('Команда:', error);
        el('teamList').innerHTML = '<p class="list-empty">Не вдалося завантажити команду.</p>';
    }
}

/** Один запис ролі разом із рядком журналу: зміна без сліду неможлива. */
async function saveMember(member, { action, summary, createService = false }) {
    const batch = writeBatch(db);
    batch.set(doc(db, 'staff', member.id), {
        role: member.role, name: member.name, active: member.active,
        updatedBy: currentApt(), updatedAt: serverTimestamp()
    });
    if (createService) batch.set(doc(db, 'apartments', member.id), { isAdmin: true, passwordChanged: false }, { merge: true });
    auditIn(batch, action, { target: `staff/${member.id}`, summary,
        details: { role: member.role, active: member.active } });
    await batch.commit();
}

async function addMember(btn) {
    const id = el('teamLogin').value.trim(), name = el('teamName').value.trim(), role = el('teamRole').value;
    const service = el('teamService').checked;
    if (!/^\d{1,6}$/.test(id)) return toast('Номер для входу — лише цифри', 'error');
    if (name.length < 2) return toast('Вкажіть ім’я — так дії буде підписано в журналі', 'error');
    if (id === currentApt()) return toast('Свою роль змінює інший голова', 'error');
    const existing = team.find(member => member.id === id);
    if (existing && !existing.legacy && !await confirmDialog('Людина вже в команді',
        `${existing.name} (${ROLE_LABELS[existing.role]}). Замінити роль на «${ROLE_LABELS[role]}»?`, 'Замінити')) return;
    setBusy(btn, true, 'Збереження…');
    try {
        const apartment = await getDoc(doc(db, 'apartments', id));
        if (service && apartment.exists() && apartment.data().isAdmin !== true) {
            return toast(`Квартира ${id} є в довіднику — зніміть позначку «Без квартири»`, 'error');
        }
        if (!service && !apartment.exists()) {
            return toast(`Квартири ${id} немає в довіднику. Для людини без квартири позначте «Без квартири»`, 'error');
        }
        await saveMember({ id, name, role, active: true }, {
            action: 'staff.add', summary: `${name}: ${ROLE_LABELS[role]} (${service ? 'службовий № ' : 'кв. '}${id})`,
            createService: service && !existing?.service
        });
        el('teamLogin').value = ''; el('teamName').value = ''; el('teamService').checked = false;
        toast(`${name} — ${ROLE_LABELS[role].toLowerCase()}`, 'success');
        await loadTeam();
    } catch (error) {
        console.error('Команда:', error);
        toast(error.code === 'permission-denied' ? 'Призначати ролі може лише голова правління' : 'Не вдалося зберегти', 'error');
    } finally { setBusy(btn, false); }
}

async function changeRole(id, role) {
    const member = team.find(item => item.id === id);
    if (!member || member.role === role) return;
    try {
        await saveMember({ ...member, role }, { action: 'staff.role', summary: `${member.name}: ${ROLE_LABELS[member.role]} → ${ROLE_LABELS[role]}` });
        toast('Роль змінено', 'success');
    } catch (error) { console.error('Роль:', error); toast('Не вдалося змінити роль', 'error'); }
    await loadTeam();
}

async function toggleMember(id) {
    const member = team.find(item => item.id === id);
    if (!member) return;
    const active = !member.active;
    if (!active && !await confirmDialog(`Вимкнути доступ?`, `${member.name} більше не зможе відкрити панель правління. Увімкнути знову можна тут же.`, 'Вимкнути')) return;
    try {
        await saveMember({ ...member, active }, { action: active ? 'staff.enable' : 'staff.disable',
            summary: `${member.name}: доступ ${active ? 'увімкнено' : 'вимкнено'}` });
        toast(active ? 'Доступ увімкнено' : 'Доступ вимкнено', 'success');
    } catch (error) { console.error('Доступ:', error); toast('Не вдалося змінити доступ', 'error'); }
    await loadTeam();
}

// ------------------------------------------------------------
// ЖУРНАЛ ДІЙ
// ------------------------------------------------------------
const AREAS = {
    balances: 'Баланси', accounts: 'Особові рахунки', receipts: 'Квитанції', ledger: 'Нарахування й оплати',
    finance: 'Звіт і реквізити', meters: 'Лічильники будинку', meeting: 'Збори', poll: 'Опитування',
    votes: 'Паперові голоси', protocol: 'Протоколи', message: 'Оголошення', request: 'Звернення',
    document: 'Документи', owners: 'Співвласники', certificate: 'Довідки', contacts: 'Контакти',
    dtek: 'ДТЕК', power: 'Світло', chat: 'Модерація чату', staff: 'Команда', bank: 'Банк'
};
const areaOf = action => String(action || '').split('.')[0];
const PAGE = 100;

function who(entry) {
    const member = team.find(item => item.id === entry.actor);
    return `${member?.name || (member?.service ? `службовий № ${entry.actor}` : `кв. ${entry.actor}`)} · ${ROLE_LABELS[entry.role] || entry.role}`;
}

function detailsHtml(details) {
    const entries = Object.entries(details || {});
    if (!entries.length) return '';
    const value = item => item && typeof item === 'object'
        ? Object.entries(item).slice(0, 30).map(([key, v]) => `${escapeHtml(key)}: ${escapeHtml(String(v))}`).join(' · ')
            + (Object.keys(item).length > 30 ? ` · ще ${Object.keys(item).length - 30}` : '')
        : escapeHtml(String(item));
    return `<details class="journal-details"><summary>Подробиці</summary><dl>${entries.map(([key, item]) =>
        `<div><dt>${escapeHtml(key)}</dt><dd>${value(item)}</dd></div>`).join('')}</dl></details>`;
}

function renderJournal() {
    const actor = el('journalActor').value, area = el('journalArea').value;
    const actors = [...new Set(journal.map(entry => entry.actor))];
    el('journalActor').innerHTML = '<option value="">Усі</option>' + actors.map(id =>
        `<option value="${escapeHtml(id)}"${id === actor ? ' selected' : ''}>${escapeHtml(who({ actor: id, role: journal.find(e => e.actor === id)?.role }).split(' · ')[0])}</option>`).join('');
    const areas = [...new Set(journal.map(entry => areaOf(entry.action)))];
    el('journalArea').innerHTML = '<option value="">Усі дії</option>' + areas.map(key =>
        `<option value="${escapeHtml(key)}"${key === area ? ' selected' : ''}>${escapeHtml(AREAS[key] || key)}</option>`).join('');
    const rows = journal.filter(entry => (!actor || entry.actor === actor) && (!area || areaOf(entry.action) === area));
    el('journalList').innerHTML = (rows.length ? `<ul class="journal-list">${rows.map(entry => `<li class="journal-row">
            <span class="journal-time">${escapeHtml(entry.at ? formatDateTime(entry.at) : 'щойно')}</span>
            <span class="journal-main"><b>${escapeHtml(entry.summary || entry.action)}</b>
                <small>${escapeHtml(who(entry))} · ${escapeHtml(AREAS[areaOf(entry.action)] || entry.action)}</small>
                ${detailsHtml(entry.details)}</span></li>`).join('')}</ul>`
        : '<p class="list-empty">Записів немає.</p>')
        + (journalDone ? '' : '<button type="button" class="btn-ghost am-more-btn" data-journal-more>Показати давніші</button>');
}

export async function loadJournal({ more = false } = {}) {
    const request = ++journalRequest;
    if (!more) { journal = []; journalCursor = null; journalDone = false; el('journalList').innerHTML = '<p class="list-empty">Завантаження…</p>'; }
    try {
        if (!team.length) team = await fetchTeam().catch(() => []);
        const parts = [collection(db, 'audit_log'), orderBy('at', 'desc'), limit(PAGE)];
        if (journalCursor) parts.push(startAfter(journalCursor));
        const snap = await getDocs(query(...parts));
        if (request !== journalRequest) return;
        journal.push(...snap.docs.map(row => ({ id: row.id, ...row.data() })));
        journalCursor = snap.docs.at(-1) || journalCursor;
        journalDone = snap.size < PAGE;
        renderJournal();
    } catch (error) {
        if (request !== journalRequest) return;
        console.error('Журнал дій:', error);
        el('journalList').innerHTML = '<p class="list-empty">Не вдалося завантажити журнал.</p>';
    }
}

export function initTeam() {
    const list = el('teamList');
    if (!list || list.dataset.initialized) return;
    list.dataset.initialized = '1';
    el('teamAddBtn').addEventListener('click', event => addMember(event.currentTarget));
    list.addEventListener('change', event => {
        const select = event.target.closest('[data-team-role]');
        if (select) changeRole(select.dataset.teamRole, select.value);
    });
    list.addEventListener('click', event => {
        const toggle = event.target.closest('[data-team-toggle]');
        if (toggle) toggleMember(toggle.dataset.teamToggle);
    });
    el('journalActor').addEventListener('change', renderJournal);
    el('journalArea').addEventListener('change', renderJournal);
    el('journalRefreshBtn').addEventListener('click', () => loadJournal());
    el('journalList').addEventListener('click', event => {
        if (event.target.closest('[data-journal-more]')) loadJournal({ more: true });
    });
}
