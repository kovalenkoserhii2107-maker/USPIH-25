export const process = { env: { DEMO: '1' }, nextTick: (fn, ...a) => queueMicrotask(() => fn(...a)), version: 'v22.0.0', versions: {}, platform: 'browser', cwd: () => '/', emitWarning: () => {} };
export { Buffer } from 'buffer';
