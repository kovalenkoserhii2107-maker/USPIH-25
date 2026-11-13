// ============================================================
// Демо-будинок у браузері: база з js/demo/seed.json у памʼяті сторінки,
// сервер (functions/*) — js/demo/server.js. Кожна вкладка має власну
// копію; зміни видно, доки сторінку не перезавантажено, і нікуди не
// надсилаються. Вмикається з demo.html (sessionStorage «uspih_demo»).
// ============================================================
import { createDb } from './memdb.js';

export const DEMO_KEY = 'uspih_demo';
export const ROLES = {
    chair: { apt: '1001', label: 'Голова правління', page: 'admin.html', hint: 'погоджує витрати, підписує платежі, збори' },
    accountant: { apt: '1002', label: 'Бухгалтер', page: 'buh.html', hint: 'банк, документи, зарплата, звіти, закриття місяця' },
    board: { apt: '1003', label: 'Член правління', page: 'admin.html', hint: 'звернення, власники, оголошення, збори' },
    resident: { apt: '7', label: 'Мешканець, кв. 7', page: 'index.html', hint: 'баланс, оплата, звернення, голосування' }
};

export function demoState() {
    try { return JSON.parse(sessionStorage.getItem(DEMO_KEY) || 'null'); } catch { return null; }
}
export function setRole(role) {
    try { sessionStorage.setItem(DEMO_KEY, JSON.stringify({ role })); } catch { /* приватний режим */ }
}
export function exitDemo() {
    try { sessionStorage.removeItem(DEMO_KEY); } catch { /* нічого */ }
}

const state = demoState() || { role: 'accountant' };
export const role = ROLES[state.role] ? state.role : 'accountant';
export const user = { uid: `demo-${ROLES[role].apt}`, email: `${ROLES[role].apt}@uspih-25.com`, emailVerified: true, isAnonymous: false,
    getIdToken: async () => 'demo', getIdTokenResult: async () => ({ claims: {}, token: 'demo' }), reload: async () => {} };

export const store = createDb();
globalThis.__demoStore = store;
const seedUrl = new URL('./seed.json', import.meta.url);
const response = await fetch(seedUrl, { cache: 'no-cache' });
if (!response.ok) throw new Error('Демо-будинок не завантажився. Оновіть сторінку');
store.load(await response.json());

let server = null;
/** Callable-функція виконується справжнім серверним кодом у цій вкладці. */
export async function call(name, data) {
    server ||= import(new URL('./server.js', import.meta.url).href).then(async m => { await m.boot(); return m; });
    const s = await server;
    return s.call(name, data, user);
}
