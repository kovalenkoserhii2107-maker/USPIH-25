'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { HttpsError } = require('firebase-functions/v2/https');
const callGuard = require('./call-guard');

test('непередбачена помилка — текстом з назвою дії, HttpsError — як є', async () => {
    const broken = callGuard('bankAction', async () => { throw new TypeError("Cannot read properties of undefined (reading 'id')"); });
    await assert.rejects(broken({ data: { action: 'assign' } }), e => e instanceof HttpsError && e.code === 'internal'
        && e.message === "Збій сервера (bankAction · assign): Cannot read properties of undefined (reading 'id')");
    const known = callGuard('bankAction', async () => { throw new HttpsError('failed-precondition', 'Операцію вже розібрано'); });
    await assert.rejects(known({ data: {} }), e => e.code === 'failed-precondition' && e.message === 'Операцію вже розібрано');
    assert.deepEqual(await callGuard('x', async r => ({ ok: r.data.n }))({ data: { n: 1 } }), { ok: 1 });
});
