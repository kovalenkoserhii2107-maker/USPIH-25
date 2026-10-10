import { functions } from './firebase.js';
import { httpsCallable } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-functions.js";

const calls = new Map();

/** Єдина обгортка для захищених серверних операцій правління. */
export async function callBackend(name, payload, timeoutMs = 45000) {
    if (!calls.has(name)) calls.set(name, httpsCallable(functions, name, { timeout: timeoutMs }));
    try {
        const result = await calls.get(name)(payload);
        return result.data;
    } catch (error) {
        const code = String(error?.code || '').replace('functions/', '');
        const friendly = {
            unauthenticated: 'Сеанс завершився. Увійдіть повторно.',
            'permission-denied': 'Ця дія доступна лише правлінню.',
            'failed-precondition': error?.message || 'Спочатку завершіть попередній крок.',
            unavailable: 'Сервер тимчасово недоступний. Спробуйте ще раз.',
            deadline: 'Сервер не встиг відповісти. Безпечно повторіть дію.',
            'deadline-exceeded': 'Сервер не встиг відповісти. Безпечно повторіть дію.'
        };
        // Голе «internal» — відповіді від функції не було (зв'язок, перевантаження):
        // текст помилки самої функції сервер передає повністю.
        if (code === 'internal' && /^internal$/i.test(String(error?.message || '').trim())) {
            friendly.internal = 'Сервер не відповів (зв\'язок або перевантаження). Повторіть дію за хвилину.';
        }
        const wrapped = new Error(friendly[code] || error?.message || 'Помилка сервера');
        wrapped.code = code;
        wrapped.cause = error;
        throw wrapped;
    }
}
