'use strict';

const TAX_KEYS = new Set(['pdfo', 'vz', 'esv']);

// Старі платежі не містять recipientType: вид платежу має пріоритет
// над ключем, бо ідентифікатор людини може бути «esv» або «pdfo».
function recipientType(payment) {
    const explicit = payment.payroll?.recipientType || payment.recipientType;
    if (explicit === 'person' || explicit === 'tax') return explicit;
    if (payment.kind === 'salary') return 'person';
    if (payment.kind === 'tax') return 'tax';
    return TAX_KEYS.has(payment.payroll?.key || payment.key) ? 'tax' : 'person';
}

function planRecipient(row) {
    return { recipientType: row.kind === 'salary' ? 'person' : 'tax',
        key: row.personId || row.taxKey || String(row.key).split(':').at(-1), planKey: row.key };
}

function findPlan(stage, meta) {
    return stage?.plan?.find(row => {
        const who = planRecipient(row);
        return who.key === meta.key && who.recipientType === meta.recipientType
            && (!meta.planKey || row.key === meta.planKey);
    });
}

// Працює також зі старими ключами «final:e1»; не видаляє запис іншого
// отримувача, коли його ключ збігається з назвою податку.
function withoutCompleted(completed, paymentId) {
    return Object.fromEntries(Object.entries(completed || {}).filter(([, id]) => id !== paymentId));
}

module.exports = { TAX_KEYS, recipientType, planRecipient, findPlan, withoutCompleted };
