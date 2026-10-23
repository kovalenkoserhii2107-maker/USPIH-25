'use strict';
// Автоклієнт v3, розділ 7 «Зарплатний проєкт». maspay та reqpay мають різні API —
// тут лише maspay (групи SALARY / STUDENT). Підписати й надіслати відомість у банк
// можна тільки в Приват24 для бізнесу; цей модуль створює, наповнює й перевіряє.
// Банк приймає не більше одного запиту на секунду — запити йдуть по черзі.
const BASE = 'https://acp.privatbank.ua/api/pay';
const { toKop } = require('./bank-core');
const privat = require('./privat');

const ref = value => {
    const s = String(value || '');
    if (!/^[\w.-]{1,120}$/.test(s)) throw new Error('Некоректний референс зарплатної відомості');
    return encodeURIComponent(s);
};

/** Статуси відомості (заголовок пакета): людською мовою для екрана. */
const PACKET_STATUS = {
    N: 'Створена в банку', W: 'Перевірена банком', S: 'Затверджена, чекає підпису', X: 'Надіслана в банк',
    P: 'Банк перевіряє', F: 'Проведена', R: 'Забракована банком', D: 'Видалена'
};
const PACKET_SUBSTATUS = { SB: 'Підписав бухгалтер — чекає підпису директора', SD: 'Підписав директор — чекає підпису бухгалтера', S$: 'Підписана, можна надсилати в банк', R: 'Проведена з помилками', I: 'Банк імпортує файл' };
/** Статуси записів відомості. */
const RECORD_STATUS = { N: 'Ще не перевірено', N$: 'Помилка — виправте в Приват24', R: 'Перевірено', M: 'Виплачено', E: 'Забраковано' };

// ---------- Черга: не частіше одного запиту на секунду ----------
let lastAt = 0;
let chain = Promise.resolve();
const settings = { minIntervalMs: 1050 };
function throttled(fn) {
    const run = chain.then(async () => {
        const wait = lastAt + settings.minIntervalMs - Date.now();
        if (wait > 0) await new Promise(r => setTimeout(r, wait));
        lastAt = Date.now();
        return fn();
    });
    chain = run.catch(() => {});
    return run;
}

// ---------- Тестовий банк: та сама форма відповідей, що й у документації ----------
const sandboxFail = code => { throw Object.assign(new Error(`Зарплатний проект: ${code}`), { bankRejected: true }); };
const SANDBOX_GROUP = { type: 'SALARY', name: 'Зарплатний проєкт ОСББ (тестовий банк)', rko: 0 };
const maskPan = pan => { const d = String(pan || '').replace(/\D/g, ''); return d.length >= 8 ? `${d.slice(0, 4)} **** **** ${d.slice(-4)}` : ''; };

async function sandboxRequest(token, path, body) {
    const sDb = privat.getSandboxDb(token);
    const u = new URL(`https://sandbox.local${path}`);
    const page = Number(u.searchParams.get('page') || 0);
    const size = Math.min(100, Number(u.searchParams.get('page-size') || 100));
    const slice = list => list.slice(page * size, page * size + size);
    const receiversCol = sDb.collection('_privat24_sandbox_mp_receivers');
    const packetsCol = sDb.collection('_privat24_sandbox_maspay');
    const headerOf = d => { const { rows = [], ...h } = d; return { ...h, system: 'maspay', recordCount: rows.length, recordAmount: Math.round(rows.reduce((s, r) => s + r.amount * 100, 0)) / 100 }; };

    if (u.pathname === '/mp/list-groups') return [SANDBOX_GROUP];
    if (u.pathname === '/mp/list-receivers') {
        const group = u.searchParams.get('group');
        const all = (await receiversCol.get()).docs.map(d => d.data()).filter(r => group === 'ALL' || r.group === group)
            .sort((a, b) => String(a.tabn).localeCompare(String(b.tabn), 'uk', { numeric: true }));
        return slice(all);
    }
    if (u.pathname === '/mp/update-receiver') {
        const pan = String(body?.pan || '').replace(/\D/g, '');
        if (body?.group !== 'SALARY' && body?.group !== 'STUDENT') sandboxFail('mp:V_BAD_PARAM');
        if (!/^\d{16}$/.test(pan) || !String(body?.tabn || '').trim()) sandboxFail('mp:V_BAD_PARAM');
        if (!/^\d{10}$/.test(String(body?.inn || '')) || !Array.isArray(body?.fio) || body.fio.filter(Boolean).length < 2) sandboxFail('mp:V_BAD_PARAM');
        const id = `R${body.group}-${String(body.tabn).replace(/[^\w-]/g, '')}`;
        await receiversCol.doc(id).set({ id, pan: maskPan(pan), fio: body.fio.slice(0, 3).map(String), inn: String(body.inn), group: body.group, tabn: String(body.tabn) });
        return { status: 'OK', id };
    }
    if (u.pathname === '/maspay/create') {
        if (!['SALARY', 'STUDENT'].includes(body?.group)) sandboxFail('maspay:V_BAD_PARAM');
        const reference = `TESTMP${Date.now().toString(36).toUpperCase()}`;
        const doc = { reference, group: body.group, packetName: String(body?.packetName || 'Зарплатна відомість'), status: 'N', substatus: '',
            createdAt: new Date().toISOString(), finishedAt: null, errText: '', revision: 1, rows: [] };
        await packetsCol.doc(reference).set(doc);
        return headerOf(doc);
    }
    const m = u.pathname.match(/^\/maspay\/([^/]+)\/(header|content|add|remove|validate|sandbox-step)$/);
    if (m) {
        const docRef = packetsCol.doc(decodeURIComponent(m[1]));
        const snap = await docRef.get();
        if (!snap.exists) sandboxFail('maspay:L_ENTITY_NOT_EXISTS');
        const doc = snap.data();
        const save = async patch => { Object.assign(doc, patch, { revision: (doc.revision || 0) + 1 }); await docRef.set(doc); };
        if (m[2] === 'header') return headerOf(doc);
        if (m[2] === 'content') return slice(doc.rows || []);
        if (m[2] === 'add') {
            if (!['N', 'W'].includes(doc.status)) sandboxFail('maspay:L_UNABLE_TO_COMPLETE_OPERATION');
            if (!(Number(body?.amount) > 0)) sandboxFail('maspay:V_BAD_PARAM');
            if (doc.rows.length >= 500) sandboxFail('maspay:L_PACKET_OVERFLOW');
            const r = (await receiversCol.doc(String(body?.receiver || '_')).get()).data();
            if (!r || r.group !== doc.group) sandboxFail('mp:L_ENTITY_NOT_EXISTS');
            const rowRef = `${doc.reference}-${doc.rows.length + 1}-${Date.now().toString(36)}`;
            await save({ status: 'N', rows: [...doc.rows, { ref: rowRef, fio: r.fio.join(' '), inn: r.inn, cardNumber: r.pan, comment: String(body.comment || ''),
                amount: Math.round(Number(body.amount) * 100) / 100, status: 'N', errorCode: '', tabNo: r.tabn }] });
            return { ref: rowRef };
        }
        if (m[2] === 'remove') {
            if (!['N', 'W'].includes(doc.status)) sandboxFail('maspay:L_UNABLE_TO_COMPLETE_OPERATION');
            await save({ status: 'N', rows: doc.rows.filter(r => r.ref !== body?.ref) });
            return {};
        }
        if (m[2] === 'validate') {
            if (doc.status === 'W') return headerOf(doc);
            if (doc.status !== 'N') sandboxFail('maspay:L_UNABLE_TO_START_VALIDATION');
            await save({ status: 'W', rows: doc.rows.map(r => ({ ...r, status: 'R' })) });
            return { ...headerOf(doc), status: 'P', substatus: 'V' };
        }
        // Лише тестовий банк: імітація дій у Приват24 — підпис бухгалтера, директора, відправка, проведення.
        const next = { W: ['S', 'SB'], 'S:SB': ['S', 'S$'], 'S:S$': ['X', ''], X: ['F', 'F'] }[doc.status === 'S' ? `S:${doc.substatus}` : doc.status];
        if (!next) sandboxFail('maspay:L_UNABLE_TO_COMPLETE_OPERATION');
        await save({ status: next[0], substatus: next[1], ...(next[0] === 'F' ? { finishedAt: new Date().toISOString(), rows: doc.rows.map(r => ({ ...r, status: 'M' })) } : {}) });
        return headerOf(doc);
    }
    if (u.pathname === '/apay24/packets/list') {
        const status = u.searchParams.get('status');
        const match = { V: ['N', 'W', 'P'], A: ['S'], F: ['F'], R: ['R'] }[status] || ['N', 'W', 'P', 'S', 'X', 'F', 'R'];
        const all = (await packetsCol.get()).docs.map(d => headerOf(d.data())).filter(h => match.includes(h.status))
            .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
        return slice(all);
    }
    sandboxFail('V_BAD_PARAM');
}

async function realRequest(token, path, body) {
    const response = await fetch(`${BASE}${path}`, { method: body === undefined ? 'GET' : 'POST',
        headers: { token, 'User-Agent': 'OSBB-Uspih-25', 'Content-Type': 'application/json;charset=utf8', Accept: 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30000) });
    let data;
    try { data = await response.json(); } catch { throw new Error(`Банк повернув не JSON (HTTP ${response.status})`); }
    if (!response.ok || ['err', 'error'].includes(String(data?.status || '').toLowerCase()) || data?.error) {
        const e = data?.error || {};
        const code = e.code ? `${e.system ? `${e.system}:` : ''}${e.code}${e.args?.length ? ` (${e.args.join(', ')})` : ''}` : data?.service || `HTTP ${response.status}`;
        const businessReject = ['V_BAD_PARAM', 'L_ENTITY_NOT_EXISTS', 'L_ACCESS_DENIED', 'L_UNABLE_TO_COMPLETE_OPERATION', 'L_UNABLE_TO_START_VALIDATION', 'L_PACKET_OVERFLOW'].includes(String(e.code || ''))
            || ['V_BAD_PARAM', 'L_ENTITY_NOT_EXISTS', 'L_ACCESS_DENIED', 'L_UNABLE_TO_COMPLETE_OPERATION', 'L_PACKET_OVERFLOW'].some(c => String(code).endsWith(c));
        throw Object.assign(new Error(`Зарплатний проект: ${code}`), { bankRejected: [400, 401, 403, 404, 422].includes(response.status) || response.ok && businessReject, bankCode: String(e.code || '') });
    }
    return data;
}

function request(token, path, body) {
    if (privat.isSandboxToken(token)) return sandboxRequest(token, path, body);
    return throttled(() => realRequest(token, path, body));
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

/** ПІБ отримувача: банк повертає масив [прізвище, імʼя, по батькові]. */
const fioText = fio => (Array.isArray(fio) ? fio : [fio]).map(s => String(s || '').trim()).filter(Boolean).join(' ');
/** «Іваненко Петро Олегович» → ['Іваненко', 'Петро', 'Олегович'] для update-receiver. */
const fioParts = name => { const p = String(name || '').trim().split(/\s+/); return [p[0] || '', p[1] || '', p.slice(2).join(' ')]; };

const groups = token => request(token, '/mp/list-groups');
const receivers = (token, group) => pages(token, `/mp/list-receivers?group=${encodeURIComponent(group)}`);
const updateReceiver = (token, { pan, group, tabn, inn, fio }) => request(token, '/mp/update-receiver',
    { pan: String(pan).replace(/\D/g, ''), group, tabn: String(tabn), ...(inn ? { inn: String(inn) } : {}), ...(fio ? { fio } : {}) });
const header = (token, reference) => request(token, `/maspay/${ref(reference)}/header`);
const content = (token, reference) => pages(token, `/maspay/${ref(reference)}/content`);
const create = (token, group, packetName) => request(token, '/maspay/create', { group, salary: true, packetName });
const add = (token, reference, receiver, purpose, amountKop) => request(token, `/maspay/${ref(reference)}/add`, { receiver, comment: purpose, amount: amountKop / 100 });
const remove = (token, reference, rowRef) => request(token, `/maspay/${ref(reference)}/remove`, { ref: String(rowRef) });
const validate = (token, reference) => request(token, `/maspay/${ref(reference)}/validate`, {});
/** Лише тестовий банк: наступний крок підпису / проведення, як це зробив би голова в Приват24. */
const sandboxStep = (token, reference) => {
    if (!privat.isSandboxToken(token)) throw new Error('Підписати відомість можна лише в Приват24 для бізнесу');
    return request(token, `/maspay/${ref(reference)}/sandbox-step`, {});
};
/** Відомості: V — чернетки, A — на підпис, F — проведені, R — забраковані (для F і R потрібен період yyyy-MM-dd). */
const packets = (token, status, { from, to } = {}) => {
    if (!['V', 'A', 'F', 'R'].includes(status)) throw new Error('Невідомий фільтр відомостей');
    const day = /^\d{4}-\d{2}-\d{2}$/;
    if (['F', 'R'].includes(status) && !(day.test(from) && day.test(to))) throw new Error('Для проведених і забракованих відомостей потрібен період');
    return pages(token, `/apay24/packets/list?status=${status}${from ? `&from=${from}&to=${to}` : ''}`);
};
const amountKop = row => toKop(row.amount);
const isSandbox = token => privat.isSandboxToken(token);
module.exports = { groups, receivers, updateReceiver, header, content, create, add, remove, validate, packets, sandboxStep, amountKop, fioText, fioParts, isSandbox,
    PACKET_STATUS, PACKET_SUBSTATUS, RECORD_STATUS, settings };
