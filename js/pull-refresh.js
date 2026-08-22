// ============================================================
// Потягнути вниз, щоб оновити.
//
// Потрібно лише у встановленому застосунку: там немає ні
// адресного рядка, ні браузерного жесту оновлення, і мешканцю
// нічим перезавантажити сторінку. У звичайному Safari свій
// жест уже є — не заважаємо йому.
// ============================================================

// Пороги міряємо в пікселях ІНДИКАТОРА, а не пальця: палець
// проходить удвічі більше через опір, і мішати дві системи
// відліку — певний шлях до плутанини.
const READY = 42;          // індикатор проїхав стільки — відпускай, спрацює
const MAX_PULL = 90;       // далі індикатор не їде
const RESISTANCE = 0.5;

let startY = 0;
let pulling = false;
let armed = false;
let indicator = null;

function isStandalone() {
    return window.matchMedia('(display-mode: standalone)').matches
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

function buildIndicator() {
    const el = document.createElement('div');
    el.className = 'ptr-indicator';
    el.innerHTML = '<span class="ptr-spinner"></span>';
    document.body.appendChild(el);
    return el;
}

function move(distance) {
    if (!indicator) indicator = buildIndicator();
    const eased = Math.min(distance * RESISTANCE, MAX_PULL);
    indicator.style.transform = `translate(-50%, ${eased}px)`;
    indicator.style.opacity = String(Math.min(eased / READY, 1));
    indicator.classList.toggle('ptr-ready', eased >= READY);
    return eased;
}

function reset() {
    if (!indicator) return;
    indicator.style.transition = 'transform 0.25s ease, opacity 0.25s ease';
    indicator.style.transform = 'translate(-50%, 0)';
    indicator.style.opacity = '0';
    setTimeout(() => {
        if (indicator) { indicator.style.transition = ''; indicator.classList.remove('ptr-ready'); }
    }, 260);
}

export function initPullToRefresh() {
    if (!isStandalone()) return;

    document.addEventListener('touchstart', (e) => {
        if (e.touches.length !== 1 || !canPull()) { pulling = false; return; }
        startY = e.touches[0].clientY;
        pulling = true;
        armed = false;
        if (indicator) indicator.style.transition = '';
    }, { passive: true });

    // passive: false — інакше не можна погасити власне прокручування сторінки
    document.addEventListener('touchmove', (e) => {
        if (!pulling) return;
        const delta = e.touches[0].clientY - startY;
        if (delta <= 0 || !canPull()) { pulling = false; reset(); return; }
        e.preventDefault();
        armed = move(delta) >= READY;
    }, { passive: false });

    document.addEventListener('touchend', () => {
        if (!pulling) return;
        pulling = false;
        if (!armed) { reset(); return; }
        indicator?.classList.add('ptr-loading');
        // Повне перезавантаження, а не дозавантаження даних: мешканець
        // може бути на будь-якому екрані, і так поводиться браузер.
        location.reload();
    }, { passive: true });
}
