'use strict';
// ============================================================
// Push-сповіщення команді й мешканцям (Firebase Cloud Messaging).
// Токени пристроїв — push_tokens/{токен} (записує сам пристрій, див.
// js/push.js). Недійсні токени (застосунок видалено, дозвіл знято)
// прибираємо одразу, щоб не слати в порожнечу.
// ============================================================
const { getMessaging } = require('firebase-admin/messaging');
const logger = require('firebase-functions/logger');

const DEAD = new Set(['messaging/registration-token-not-registered', 'messaging/invalid-registration-token', 'messaging/invalid-argument']);

module.exports = function makeNotify({ db }) {
    /** Надіслати сповіщення ролям ({ roles }) або квартирам ({ apts }). */
    return async function notify({ roles = [], apts = [], title, body, link = './', tag }) {
        const docs = [];
        if (roles.length) (await db.collection('push_tokens').where('role', 'in', roles.slice(0, 10)).get()).forEach(d => docs.push(d));
        for (let i = 0; i < apts.length; i += 10) {
            (await db.collection('push_tokens').where('apt', 'in', apts.slice(i, i + 10)).get()).forEach(d => docs.push(d));
        }
        const tokens = [...new Set(docs.map(d => d.id))];
        if (!tokens.length) return { sent: 0 };
        let sent = 0;
        for (let i = 0; i < tokens.length; i += 500) {
            const batch = tokens.slice(i, i + 500);
            const res = await getMessaging().sendEachForMulticast({
                tokens: batch,
                webpush: { notification: { title, body }, fcmOptions: { link }, headers: { Urgency: 'high' } },
                data: { link, ...(tag ? { tag } : {}) }
            });
            sent += res.successCount;
            await Promise.all(res.responses.map((r, k) => !r.success && DEAD.has(r.error?.code)
                ? db.doc(`push_tokens/${batch[k]}`).delete().catch(() => {}) : null));
        }
        logger.info(`Сповіщення «${title}»: ${sent} із ${tokens.length}`);
        return { sent };
    };
};
