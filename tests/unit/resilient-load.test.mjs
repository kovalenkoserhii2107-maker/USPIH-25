import test from 'node:test';
import assert from 'node:assert/strict';
import { createResilientLoader } from '../../js/resilient-load.js';

const hung = () => new Promise(() => {});

test('швидке завантаження не перезапускає з’єднання', async () => {
    let reconnects = 0;
    const { load } = createResilientLoader({ reconnect: async () => { reconnects += 1; }, currentScreen: () => 'a', slowMs: 20 });
    assert.equal(await load(async () => 'дані'), 'дані');
    assert.equal(reconnects, 0);
});

test('завислий запит повторюється після перезапуску з’єднання й показує дані', async () => {
    let reconnects = 0, calls = 0;
    const { load } = createResilientLoader({ reconnect: async () => { reconnects += 1; }, currentScreen: () => 'a', slowMs: 20 });
    const result = await load(() => (++calls === 1 ? hung() : Promise.resolve('дані')));
    assert.equal(result, 'дані');
    assert.equal(calls, 2);
    assert.equal(reconnects, 1);
});

test('повтор лише один: другий повільний запит не зациклюється', async () => {
    let calls = 0;
    const { load } = createResilientLoader({ reconnect: async () => {}, currentScreen: () => 'a', slowMs: 10 });
    const done = load(() => { calls += 1; return calls === 1 ? hung() : new Promise(resolve => setTimeout(() => resolve('пізно'), 40)); });
    assert.equal(await done, 'пізно');
    assert.equal(calls, 2);
});

test('якщо мешканець пішов з екрана, дані не довантажуються', async () => {
    let screen = 'a', calls = 0;
    const { load } = createResilientLoader({ reconnect: async () => { screen = 'b'; }, currentScreen: () => screen, slowMs: 10 });
    await load(() => { calls += 1; return hung(); });
    assert.equal(calls, 1);
});

test('повернення з фону одразу повторює завислий екран, а завершений — ні', async () => {
    let calls = 0;
    const { load, resume } = createResilientLoader({ reconnect: async () => {}, currentScreen: () => 'a', slowMs: 60000 });
    load(() => (++calls === 1 ? hung() : Promise.resolve('дані')));
    await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(resume(), true);
    await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(calls, 2);
    assert.equal(resume(), false);
    await load(async () => 'готово');
    assert.equal(resume(), false);
});

test('помилка повтору доходить до екрана, щоб він показав свій стан', async () => {
    let calls = 0;
    const { load } = createResilientLoader({ reconnect: async () => {}, currentScreen: () => 'a', slowMs: 10 });
    await assert.rejects(load(() => (++calls === 1 ? hung() : Promise.reject(new Error('немає мережі')))), /немає мережі/);
});
