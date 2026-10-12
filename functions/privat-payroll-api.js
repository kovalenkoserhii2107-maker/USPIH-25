'use strict';
// Автоклієнт v3, розділ 7. maspay та reqpay мають різні API.
// Тут тільки читання, створення чернетки й перевірка. Підпис — у Приват24.
const BASE = 'https://acp.privatbank.ua/api/pay';
const { toKop } = require('./bank-core');
const ref = value => {
    const s = String(value || '');
    if (!/^[\w.-]{1,120}$/.test(s)) throw new Error('Некоректний референс зарплатної відомості');
    return encodeURIComponent(s);
};
async function request(token, path, body) {
    const response = await fetch(`${BASE}${path}`, { method: body === undefined ? 'GET' : 'POST',
        headers: { token, 'User-Agent': 'OSBB-Uspih-25', 'Content-Type': 'application/json;charset=utf8', Accept: 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30000) });
    let data;
    try { data = await response.json(); } catch { throw new Error(`Банк повернув не JSON (HTTP ${response.status})`); }
    if (!response.ok || ['err', 'error'].includes(String(data?.status || '').toLowerCase()) || data?.error) {
        const code = data?.error?.code || data?.service || `HTTP ${response.status}`;
        const businessReject = ['V_BAD_PARAM','L_ENTITY_NOT_EXISTS','L_ACCESS_DENIED','L_UNABLE_TO_COMPLETE_OPERATION','L_PACKET_OVERFLOW'].some(c=>String(code).endsWith(c));
        throw Object.assign(new Error(`Зарплатний проект: ${code}`), { bankRejected: [400,401,403,404,422].includes(response.status) || response.ok && businessReject });
    }
    return data;
}
async function pages(token, path) {
    const out = [];
    for (let page = 0; page < 50; page++) {
        const list = await request(token, `${path}${path.includes('?') ? '&' : '?'}page=${page}&page-size=100`);
        if (!Array.isArray(list) || list.length > 100) throw new Error('Банк повернув некоректний список зарплатного проекту');
        if (!list.length) return out;
        out.push(...list);
    }
    throw new Error('Список зарплатного проекту не завершено: перевищено ліміт сторінок');
}
const groups = token => request(token, '/mp/list-groups');
const receivers = (token, group) => pages(token, `/mp/list-receivers?group=${encodeURIComponent(group)}`);
const header = (token, reference) => request(token, `/maspay/${ref(reference)}/header`);
const content = (token, reference) => pages(token, `/maspay/${ref(reference)}/content`);
const create = (token, group, packetName) => request(token, '/maspay/create', { group, salary: true, packetName });
const add = (token, reference, receiver, purpose, amountKop) => request(token, `/maspay/${ref(reference)}/add`, { receiver, comment: purpose, amount: amountKop / 100 });
const validate = (token, reference) => request(token, `/maspay/${ref(reference)}/validate`, {});
const packets = (token,status) => {
    if(!['V','A'].includes(status))throw new Error('Для пошуку чернеток потрібен статус V або A');
    return pages(token,`/apa24/packetslist?status=${status}`);
};
const amountKop = row => toKop(row.amount);
module.exports = { groups, receivers, header, content, create, add, validate, packets, amountKop };
