// Сповіщення в демо-будинку вимкнені.
export const isSupported = async () => false;
export const getMessaging = () => ({});
export async function getToken() { throw Object.assign(new Error('У демо сповіщення вимкнено'), { code: 'messaging/unsupported-browser' }); }
export const onMessage = () => () => {};
export const deleteToken = async () => true;
