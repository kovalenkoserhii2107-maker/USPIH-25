// ============================================================
// Потягнути вниз, щоб оновити.
//
// Потрібно лише у встановленому застосунку: там немає ні
// адресного рядка, ні браузерного жесту оновлення, і мешканцю
// нічим перезавантажити сторінку. У звичайному Safari свій
// жест уже є — не заважаємо йому.
// ============================================================

// Пороги міряємо в пікселях ЗМІЩЕННЯ ЕКРАНА, а не пальця: палець
// проходить удвічі більше через опір, і мішати дві системи
// відліку — певний шлях до плутанини.
const READY = 56;          // екран проїхав стільки — відпускай, спрацює
const MAX_PULL = 96;       // далі екран не їде
const HOLD = 56;           // на цій висоті екран тримається під час оновлення
const RESISTANCE = 0.5;
// Скільки щонайменше видно спінер. Перезавантаження даних часто триває
// 100–200 мс: без цієї затримки індикатор блимав і зникав раніше, ніж
// його встигали побачити, і оновлення виглядало так, ніби нічого не сталося.
const MIN_SPIN = 550;

let startY = 0;
let pulling = false;
let armed = false;
let busy = false;
let indicator = null;
let onRefresh = null;
let scroller = null;        // прокручуваний список, у якому почався дотик

function isStandalone() {
    return ['standalone', 'fullscreen', 'minimal-ui']
            .some(m => window.matchMedia(`(display-mode: ${m})`).matches)
        || window.navigator.standalone === true;
}

/**
 * Жест доречний, лише коли сторінка справді вгорі й нічого
 * не відкрито поверх неї: у галереї та панелях свої свайпи,
 * і перехоплення ламало б їх.
 */
function canPull() {
    if (window.scrollY > 0) return false;
    if (document.body.classList.contains('no-scroll')) return false;
    return !document.querySelector(
        '.sheet.is-open, .modal.is-open, .gallery-modal.is-open, .doc-viewer-modal.is-open'
    );
}

/**
 * Найближчий прокручуваний предок дотику.
 *
 * Жест слухає весь документ і гасить прокручування через
 * preventDefault. Без цієї перевірки він перехоплював би рух і
 * всередині стрічки чату чи довідника квартир — і прокрутити їх
 * угору стало б неможливо.
 */
function scrollableAncestor(node) {
    while (node && node !== document.body && node.nodeType === 1) {
        if (node.scrollHeight > node.clientHeight + 1) {
            const oy = getComputedStyle(node).overflowY;
            if (oy === 'auto' || oy === 'scroll') return node;
        }
        node = node.parentElement;
    }
    return null;
}

function buildIndicator() {
    const el = document.createElement('div');
    el.className = 'ptr-indicator';
    el.innerHTML = '<span class="ptr-spinner"></span>';
    document.body.appendChild(el);
    return el;
}

/**
 * Зсуваємо весь вміст, а не самий лише кружечок.
 *
 * Рухався тільки індикатор — і в застосунку жест ніяк не відчувався:
 * екран стояв нерухомо, наче нічого не відбувається. Тепер сторінка
 * йде за пальцем, а індикатор виїжджає в щілину, що при цьому
 * відкривається зверху.
 *
 * Індикатор — position: fixed усередині body: коли body має transform,
 * він стає для fixed-нащадків системою відліку, тож кружечок їде
 * разом із вмістом і сам собою з'являється у щілині.
 */
function shift(px, animate) {
    const b = document.body;
    b.style.transition = animate ? 'transform 0.3s cubic-bezier(0.32, 0.72, 0, 1)' : '';
    b.style.transform = px ? `translateY(${px}px)` : '';
    if (!px && animate) setTimeout(() => { b.style.transition = ''; }, 320);
}

function move(distance) {
    if (!indicator) indicator = buildIndicator();
    const eased = Math.min(distance * RESISTANCE, MAX_PULL);
    shift(eased, false);
    indicator.style.opacity = String(Math.min(eased / READY, 1));
    indicator.classList.toggle('ptr-ready', eased >= READY);
    return eased;
}

function reset() {
    shift(0, true);
    if (!indicator) return;
    indicator.style.transition = 'opacity 0.25s ease';
    indicator.style.opacity = '0';
    setTimeout(() => {
        if (indicator) {
            indicator.style.transition = '';
            indicator.classList.remove('ptr-ready', 'ptr-loading');
        }
    }, 300);
}

/**
 * @param {Function} [refresh] що робити на оновлення. Без нього —
 *   перезавантаження сторінки, але тоді мешканця викидає на
 *   головний екран, тож застосунок передає сюди перезавантаження
 *   даних поточного екрана.
 */
export function initPullToRefresh(refresh) {
    onRefresh = typeof refresh === 'function' ? refresh : null;
    if (!isStandalone()) return;

    document.addEventListener('touchstart', (e) => {
        if (busy || e.touches.length !== 1 || !canPull()) { pulling = false; return; }
        scroller = scrollableAncestor(e.target);
        // Список прокручено — це його жест, не наш
        if (scroller && scroller.scrollTop > 0) { pulling = false; return; }
        startY = e.touches[0].clientY;
        pulling = true;
        armed = false;
        if (indicator) indicator.style.transition = '';
    }, { passive: true });

    // passive: false — інакше не можна погасити власне прокручування сторінки
    document.addEventListener('touchmove', (e) => {
        if (!pulling) return;
        const delta = e.touches[0].clientY - startY;
        if (delta <= 0 || !canPull() || (scroller && scroller.scrollTop > 0)) {
            pulling = false; reset(); return;
        }
        e.preventDefault();
        armed = move(delta) >= READY;
    }, { passive: false });

    document.addEventListener('touchend', async () => {
        if (!pulling) return;
        pulling = false;
        if (!armed) { reset(); return; }

        indicator?.classList.add('ptr-loading');
        if (!onRefresh) { location.reload(); return; }

        // Тримаємо екран трохи опущеним, поки оновлюємо — так само,
        // як це роблять рідні застосунки.
        shift(HOLD, true);
        if (indicator) indicator.style.opacity = '1';

        busy = true;
        const started = Date.now();
        try {
            await onRefresh();
        } catch (e) {
            console.error('Оновлення:', e);
        } finally {
            const left = MIN_SPIN - (Date.now() - started);
            if (left > 0) await new Promise(r => setTimeout(r, left));
            busy = false;
            reset();
        }
    }, { passive: true });
}
