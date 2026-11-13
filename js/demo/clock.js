// Годинник демо-будинку: «сьогодні» зафіксовано, щоб дані завжди були свіжими
// відносно дати на екрані. Час іде далі від цієї точки, як звичайний.
export const DEMO_NOW = Date.parse('2026-01-20T09:30:00+02:00');

export function installClock(epoch = DEMO_NOW) {
    const Real = globalThis.Date;
    if (Real.__demo) return;
    const offset = epoch - Real.now();
    class DemoDate extends Real {
        constructor(...args) { if (args.length) super(...args); else super(Real.now() + offset); }
        static now() { return Real.now() + offset; }
        static [Symbol.hasInstance](x) { return x instanceof Real; }
    }
    DemoDate.__demo = true;
    globalThis.Date = DemoDate;
}
