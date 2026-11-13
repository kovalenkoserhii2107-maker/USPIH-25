module.exports = { onSchedule: (a, b) => Object.assign(async () => (typeof a === 'function' ? a : b)(), { __demoSchedule: true }) };
