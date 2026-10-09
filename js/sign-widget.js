// ============================================================
// Панель правління → Головна: «На підпис у Приват24».
//
// Бухгалтер відправив платежі в банк — голова бачить їх тут (і отримує
// push), відкриває Приват24 для бізнесу й підписує пачку КЕП. Коли
// списання зʼявиться у виписці, платіж зникне звідси сам.
// ============================================================
import { db, session } from './firebase.js';
import { collection, getDocs, query, where, limit } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { escapeHtml, formatMoney, toast, setBusy } from './ui.js';
import { hasRight } from './staff-core.js';
import { enablePush, pushState, pushEnabledHere } from './push.js';

const money = kop => `${formatMoney(kop / 100)} грн`;

function pushHtml() {
    if (pushEnabledHere()) return '<span class="sign-push is-on">Сповіщення на цьому пристрої увімкнено</span>';
    const state = pushState();
    if (state === 'unsupported') return '<span class="sign-push">На iPhone сповіщення працюють у встановленому застосунку (Поділитися → «На екран Додому»)</span>';
    if (state === 'denied') return '<span class="sign-push">Сповіщення заборонено в налаштуваннях браузера</span>';
    return '<button type="button" class="btn-soft btn-compact" id="signPushBtn">Сповіщати мене на цьому пристрої</button>';
}

export async function loadSignWidget() {
    const host = document.getElementById('signWidget');
    if (!host) return;
    // Підписує голова; бухгалтер бачить те саме у своєму кабінеті.
    if (session.role !== 'chair' || !hasRight(session.role, 'account')) { host.hidden = true; return; }
    const snap = await getDocs(query(collection(db, 'payments'), where('status', '==', 'sent'), limit(50)));
    const list = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    const total = list.reduce((s, p) => s + p.amountKop, 0);
    host.hidden = false;
    host.innerHTML = list.length ? `
        <section class="sign-card is-waiting">
            <div class="sign-head">
                <div><span class="overview-kicker">На підпис у Приват24</span>
                    <h2>${list.length} ${list.length === 1 ? 'платіж' : list.length < 5 ? 'платежі' : 'платежів'} · ${money(total)}</h2></div>
            </div>
            <ul class="sign-list">${list.slice(0, 6).map(p => `<li><span><b>${escapeHtml(p.recipient?.name || '')}</b><small>${escapeHtml(p.purpose || '')}</small></span><b>${money(p.amountKop)}</b></li>`).join('')}</ul>
            <p class="sign-how">Бухгалтер підготував і перевірив платежі. Відкрийте <b>Приват24 для бізнесу</b> → «Платежі» → підпишіть пачку КЕП. Гроші підуть лише після вашого підпису.</p>
            <div class="sign-foot">${pushHtml()}</div>
        </section>` : `
        <section class="sign-card">
            <div class="sign-head"><div><span class="overview-kicker">На підпис у Приват24</span><h2>Нічого не чекає вашого підпису</h2></div></div>
            <div class="sign-foot">${pushHtml()}</div>
        </section>`;
    document.getElementById('signPushBtn')?.addEventListener('click', async e => {
        setBusy(e.currentTarget, true, 'Вмикаю…');
        try { await enablePush(); toast('Сповіщення увімкнено', 'success'); loadSignWidget(); }
        catch (err) { toast(err.message, 'error'); setBusy(e.currentTarget, false); }
    });
}
