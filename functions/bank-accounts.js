'use strict';

// available відсутній у старих налаштуваннях. Перша перевірка токена
// або залишків явно позначить недоступні історичні рахунки.
// Рахунок іншого банку (source: 'file') живе з виписок файлом: платежі з нього
// через Приват24 не створюються, а доступ за токеном його не стосується.
const payable = account => Boolean(account) && account.source !== 'file' && account.available !== false && (!account.currency || account.currency === 'UAH');

function refreshAccounts(current, balances, timestamp) {
    const available = new Set(balances.map(b => b.iban));
    const accounts = Object.fromEntries(Object.entries(current || {}).map(([iban, a]) => [iban, a.source === 'file' && !available.has(iban) ? a : { ...a, available: available.has(iban) }]));
    for (const b of balances) {
        const old = accounts[b.iban] || { purpose: 'current', syncedTo: null };
        // Рахунок, який раніше вели виписками, тепер видно через API: далі — банк.
        accounts[b.iban] = { ...old, available: true, source: 'privat', ...(old.source === 'file' ? { fileUntil: old.syncedTo || null } : {}),
            currency: b.currency, balanceKop: b.balanceKop, balanceAt: timestamp(b.at || new Date()), name: b.name || old.name || '' };
    }
    return accounts;
}

module.exports = { payable, refreshAccounts };
