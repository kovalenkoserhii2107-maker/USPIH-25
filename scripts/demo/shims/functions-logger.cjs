const quiet = () => {};
module.exports = { log: quiet, info: quiet, debug: quiet, warn: (...a) => console.warn('[демо]', ...a), error: (...a) => console.warn('[демо]', ...a), write: quiet };
