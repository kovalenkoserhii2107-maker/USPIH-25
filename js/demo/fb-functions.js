// firebase-functions для демо-будинку: справжній серверний код у цій вкладці.
import { call } from './runtime.js';
export const getFunctions = () => ({ region: 'demo' });
export const connectFunctionsEmulator = () => {};
export function httpsCallable(_, name) {
    return async data => {
        try {
            return { data: await call(name, data) };
        } catch (error) {
            const e = new Error(error?.message || 'Помилка демо-сервера');
            e.code = `functions/${error?.code || 'internal'}`;
            e.details = error?.details;
            throw e;
        }
    };
}
