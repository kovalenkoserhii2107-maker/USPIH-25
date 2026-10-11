'use strict';

// available відсутній у старих налаштуваннях. Перша перевірка токена
// або залишків явно позначить недоступні історичні рахунки.
const payable = account => Boolean(account) && account.available !== false && (!account.currency || account.currency === 'UAH');

function refreshAccounts(current, balances, timestamp) {
    const available = new Set(balances.map(b => b.iban));
    const accounts = Object.fromEntries(Object.entries(current || {}).map(([iban, a]) => [iban, { ...a, available: available.has(iban) }]));
    for (const b of balances) accounts[b.iban] = { ...(accounts[b.iban] || { purpose: 'current', syncedTo: null }), available: true,
        currency: b.currency, balanceKop: b.balanceKop, balanceAt: timestamp(b.at || new Date()), name: b.name || accounts[b.iban]?.name || '' };
    return accounts;
}

module.exports = { payable, refreshAccounts };
