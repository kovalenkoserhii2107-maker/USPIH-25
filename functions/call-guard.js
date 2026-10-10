'use strict';
// ============================================================
// Непередбачена помилка в дії кабінету: Firebase віддає клієнту лише
// «internal», і причину видно тільки в логах. Пишемо її в лог з назвою
// дії й повертаємо коротким текстом — бухгалтер бачить, що саме сталося.
// ============================================================
const { HttpsError } = require('firebase-functions/v2/https');
const logger = require('firebase-functions/logger');

module.exports = function guard(name, handler) {
    return async request => {
        try {
            return await handler(request);
        } catch (error) {
            if (error instanceof HttpsError) throw error;
            const action = String(request?.data?.action || '').slice(0, 40);
            logger.error(`${name}${action ? `.${action}` : ''}`, error);
            const text = String(error?.message || error).replace(/\s+/g, ' ').slice(0, 200);
            throw new HttpsError('internal', `Збій сервера (${name}${action ? ` · ${action}` : ''}): ${text}`);
        }
    };
};
