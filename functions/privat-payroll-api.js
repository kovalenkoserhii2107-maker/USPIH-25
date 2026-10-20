'use strict';
// Автоклієнт v3, розділ 7. maspay та reqpay мають різні API.
// Тут тільки читання, створення чернетки й перевірка. Підпис — у Приват24.
const BASE = 'https://acp.privatbank.ua/api/pay';
const { toKop, normIban } = require('./bank-core');
const privat = require('./privat');

const ref = value => {
    const s = String(value || '');
    if (!/^[\w.-]{1,120}$/.test(s)) throw new Error('Некоректний референс зарплатної відомості');
    return encodeURIComponent(s);
};

async function sandboxRequest(token, path, body) {
    const sDb = privat.getSandboxDb(token);
    await privat.ensureSandboxState(sDb);
    const u = new URL(`https://sandbox.local${path}`);
    const page = Number(u.searchParams.get('page') || 0);

    if (u.pathname === '/mp/list-groups') {
        return [{ id: 'P24-GRP-OSBB25', name: 'Зарплатний проєкт ОСББ (Приват24 · Тестове середовище)' }];
    }
    if (u.pathname === '/mp/list-receivers') {
        if (page > 0) return [];
        const peopleSnap = await sDb.collection('payroll_people').get().catch(() => ({ docs: [] }));
        return peopleSnap.docs
            .map(d => ({ id: d.id, ...d.data() }))
            .filter(p => p.active !== false && p.kind === 'employee')
            .map(p => ({
                receiver: p.id,
                inn: String(p.tin || ''),
                fio: String(p.name || ''),
                iban: normIban(p.iban || ''),
                cardmask: `5168 **** **** ${String(p.iban || '0000').slice(-4)}`
            }));
    }
    if (u.pathname === '/maspay/create') {
        const reference = `P24MASPAY-${Date.now().toString(36).toUpperCase()}`;
        await sDb.doc(`_privat24_sandbox_maspay/${reference}`).set({
            reference,
            group: body?.group || 'P24-GRP-OSBB25',
            packetName: body?.packetName || 'Зарплатна відомість',
            status: 'N',
            rows: [],
            createdAt: new Date().toISOString()
        });
        return { reference, status: 'N' };
    }
    const mAdd = u.pathname.match(/^\/maspay\/([^/]+)\/add$/);
    if (mAdd) {
        const reference = decodeURIComponent(mAdd[1]);
        const docRef = sDb.doc(`_privat24_sandbox_maspay/${reference}`);
        const snap = await docRef.get();
        const rows = snap.exists && Array.isArray(snap.data().rows) ? snap.data().rows : [];
        rows.push({
            receiver: body?.receiver || '',
            comment: body?.comment || '',
            amount: Number(body?.amount || 0)
        });
        await docRef.set({ reference, rows, updatedAt: new Date().toISOString() }, { merge: true });
        return { status: 'OK' };
    }
    const mVal = u.pathname.match(/^\/maspay\/([^/]+)\/validate$/);
    if (mVal) {
        const reference = decodeURIComponent(mVal[1]);
        await sDb.doc(`_privat24_sandbox_maspay/${reference}`).set({
            status: 'V',
            validatedAt: new Date().toISOString()
        }, { merge: true });
        return { reference, status: 'V' };
    }
    const mHeader = u.pathname.match(/^\/maspay\/([^/]+)\/header$/);
    if (mHeader) {
        const reference = decodeURIComponent(mHeader[1]);
        const snap = await sDb.doc(`_privat24_sandbox_maspay/${reference}`).get();
        if (!snap.exists) {
            throw Object.assign(new Error('Зарплатний проект: L_ENTITY_NOT_EXISTS'), { bankRejected: true });
        }
        return { reference, status: snap.data().status || 'V', packetName: snap.data().packetName || '' };
    }
    const mContent = u.pathname.match(/^\/maspay\/([^/]+)\/content$/);
    if (mContent) {
        if (page > 0) return [];
        const reference = decodeURIComponent(mContent[1]);
        const snap = await sDb.doc(`_privat24_sandbox_maspay/${reference}`).get();
        return snap.exists && Array.isArray(snap.data().rows) ? snap.data().rows : [];
    }
    if (u.pathname === '/apa24/packetslist') {
        if (page > 0) return [];
        const status = u.searchParams.get('status') || 'V';
        const snap = await sDb.collection('_privat24_sandbox_maspay').where('status', '==', status).get().catch(() => ({ docs: [] }));
        return snap.docs.map(d => d.data());
    }
    return {};
}

async function request(token, path, body) {
    if (privat.isSandboxToken(token)) {
        return sandboxRequest(token, path, body);
    }
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
