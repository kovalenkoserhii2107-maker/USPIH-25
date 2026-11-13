// firebase-auth для демо-будинку: вхід — обрана роль, вихід — назад до вибору ролі.
import { user, exitDemo } from './runtime.js';
import './brand.js';
const auth = { currentUser: user, name: 'demo', languageCode: 'uk' };
export const indexedDBLocalPersistence = { type: 'LOCAL' }, browserLocalPersistence = { type: 'LOCAL' }, browserSessionPersistence = { type: 'SESSION' }, inMemoryPersistence = { type: 'NONE' };
export const initializeAuth = () => auth;
export const getAuth = () => auth;
export const setPersistence = async () => {};
export function onAuthStateChanged(_, next) {
    const cb = typeof next === 'function' ? next : next?.next;
    setTimeout(() => cb?.(auth.currentUser), 0);
    return () => {};
}
export const onIdTokenChanged = onAuthStateChanged;
export async function signInWithEmailAndPassword() { return { user }; }
export async function signOut() { exitDemo(); location.href = 'demo.html'; }
export async function updatePassword() { const e = new Error('У демо пароль не змінюється'); e.code = 'auth/operation-not-allowed'; throw e; }
export async function reauthenticateWithCredential() { return { user }; }
export const EmailAuthProvider = { credential: () => ({}) };
export async function sendPasswordResetEmail() {}
