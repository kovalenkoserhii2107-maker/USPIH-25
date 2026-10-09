// ============================================================
// Журнал дій правління: хто, коли й що змінив. Правила дозволяють
// лише додавати записи, автор і роль — завжди той, хто увійшов.
// ============================================================
import { db, currentApt, session } from './firebase.js';
import { doc, collection, setDoc, serverTimestamp } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js';

const clip = (value, max) => String(value ?? '').slice(0, max);

export function auditData(action, { target = '', summary = '', details = {} } = {}) {
    return {
        actor: currentApt(), role: session.role, action: clip(action, 60),
        target: clip(target, 200), summary: clip(summary, 500),
        // undefined Firestore не приймає, а журнал не має ламати саму дію
        details: JSON.parse(JSON.stringify(details ?? {})),
        at: serverTimestamp()
    };
}

/** Запис у ту саму пачку чи транзакцію: зміна й рядок журналу зберігаються разом. */
export function auditIn(writer, action, info) {
    writer.set(doc(collection(db, 'audit_log')), auditData(action, info));
}

/** Окремий запис після дії. Збій журналу не скасовує зроблене — лише попереджаємо в консолі. */
export async function audit(action, info) {
    if (!session.role) return;
    try { await setDoc(doc(collection(db, 'audit_log')), auditData(action, info)); }
    catch (error) { console.warn('Журнал дій:', error); }
}
