// Демо: Cloud Functions виконуються в браузері. onCall повертає обробник як є.
class HttpsError extends Error {
    constructor(code, message, details) { super(message); this.code = code; this.details = details; this.httpErrorCode = { status: 400 }; }
}
const wrap = (a, b) => {
    const handler = typeof a === 'function' ? a : b;
    return Object.assign(req => handler(req), { run: req => handler(req), __demoCallable: true });
};
module.exports = { onCall: wrap, onRequest: wrap, HttpsError };
