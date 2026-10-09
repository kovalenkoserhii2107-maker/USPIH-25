// ============================================================
// Завантаження, що не зависає.
//
// Запит до Firestore через «мертвий» канал не падає й не відповідає:
// раніше екран висів на «Завантаженні…», доки мешканець не відкривав
// інший екран і не повертався. Тепер повільне завантаження само
// повторюється після перезапуску з'єднання, а завислий екран
// догружається, щойно застосунок повертається з фону чи в мережу.
// ============================================================
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * @param reconnect     перезапускає з'єднання (повертає Promise)
 * @param currentScreen який екран зараз відкрито
 * @param slowMs        скільки чекати, перш ніж вважати запит завислим
 */
export function createResilientLoader({ reconnect, currentScreen, slowMs = 9000 }) {
    let pending = null;

    async function retry(entry) {
        if (entry.retried || entry.done) return;
        entry.retried = true;
        await reconnect();
        // Мешканець уже пішов з екрана — не тягнемо його дані назад.
        if (entry.screen && currentScreen() !== entry.screen) return;
        return entry.run();
    }

    /** Виконує run(); якщо за slowMs відповіді немає — перезапускає з'єднання й повторює раз. */
    async function load(run, screen = currentScreen()) {
        const entry = { run, screen, done: false, retried: false };
        const first = Promise.resolve().then(run);
        pending = entry;
        first.catch(() => {}).finally(() => {
            if (entry.retried) return;
            entry.done = true;
            if (pending === entry) pending = null;
        });
        const slow = await Promise.race([first.then(() => false, () => false), wait(slowMs).then(() => true)]);
        if (!slow) return first;
        try { return await retry(entry); }
        finally { if (pending === entry) pending = null; }
    }

    /** Застосунок повернувся з фону чи в мережу: завислий екран повторюємо одразу. */
    function resume() {
        const entry = pending;
        if (!entry || entry.done || entry.retried) return false;
        retry(entry).catch(error => console.error('Повторне завантаження:', error))
            .finally(() => { if (pending === entry) pending = null; });
        return true;
    }

    return { load, resume };
}
