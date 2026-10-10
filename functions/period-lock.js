'use strict';
// ============================================================
// Закритий місяць: операції за ним змінювати не можна (нарахування,
// документи витрат, рознесення й категорії виписки). Відкрити місяць
// знову може лише голова — з причиною в журналі дій (journal.js).
// ============================================================
const { HttpsError } = require('firebase-functions/v2/https');

const MONTHS = ['січень', 'лютий', 'березень', 'квітень', 'травень', 'червень', 'липень', 'серпень', 'вересень', 'жовтень', 'листопад', 'грудень'];
const monthName = p => `${MONTHS[Number(String(p).slice(5, 7)) - 1] || p} ${String(p).slice(0, 4)}`;

module.exports = function periodLock(db) {
    /** Закриті місяці: ['2026-10', …]. */
    async function closed() {
        const snap = await db.collection('journal_periods').where('status', '==', 'closed').get();
        return snap.docs.map(d => d.id).sort();
    }

    async function assertOpen(period, what = 'Зміни') {
        const p = String(period || '');
        if (!p) return;
        if ((await closed()).includes(p)) {
            throw new HttpsError('failed-precondition', `${what}: ${monthName(p)} закрито. Змінити можна, лише якщо голова відкриє місяць знову (розділ «Проводки»).`);
        }
    }

    /** Чи закрито хоч один місяць (вхідні залишки тоді змінювати не можна). */
    async function anyClosed() {
        return (await closed()).length > 0;
    }

    return { closed, assertOpen, anyClosed, monthName };
};
