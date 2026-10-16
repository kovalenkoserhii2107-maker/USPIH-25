// Публічна сторінка: лише локальні ефекти, без сесії й без звернень до бекенду.
// Без JavaScript сторінка повністю читається: кроки, знімки й відповіді на місці.
document.documentElement.classList.add('js');

const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const header = document.querySelector('.site-header');
const progress = document.querySelector('.scroll-progress');

// ---------- Прогрес прокрутки й тінь шапки ----------
let ticking = false;
function onScroll() {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => {
        const max = document.documentElement.scrollHeight - innerHeight;
        progress?.style.setProperty('--p', max > 0 ? String(scrollY / max) : '0');
        header?.classList.toggle('is-scrolled', scrollY > 8);
        ticking = false;
    });
}
addEventListener('scroll', onScroll, { passive: true });
onScroll();

// ---------- Поява блоків ----------
const revealer = new IntersectionObserver(entries => {
    entries.forEach(entry => {
        if (!entry.isIntersecting) return;
        entry.target.classList.add('is-in');
        revealer.unobserve(entry.target);
    });
}, { rootMargin: '0px 0px -8% 0px', threshold: 0.08 });
document.querySelectorAll('.reveal').forEach(el => revealer.observe(el));

// ---------- Перший екран: легкий паралакс за курсором ----------
const heroStage = document.querySelector('.hero-stage');
if (heroStage && !reduced && matchMedia('(pointer: fine)').matches) {
    const layers = [...heroStage.querySelectorAll('[data-depth]')];
    heroStage.closest('.hero').addEventListener('pointermove', event => {
        const box = heroStage.getBoundingClientRect();
        const x = (event.clientX - box.left) / box.width - 0.5;
        const y = (event.clientY - box.top) / box.height - 0.5;
        layers.forEach(layer => {
            const depth = Number(layer.dataset.depth) || 1;
            layer.style.setProperty('--tx', `${(-x * 14 * depth).toFixed(1)}px`);
            layer.style.setProperty('--ty', `${(-y * 10 * depth).toFixed(1)}px`);
        });
    });
}

// ---------- Розповіді ролей: знімок праворуч змінюється разом із кроком ----------
document.querySelectorAll('.story').forEach(story => {
    const steps = [...story.querySelectorAll('.step')];
    const stage = story.querySelector('.stage');
    const dots = [...story.querySelectorAll('.stage-dots i')];
    const devices = { laptop: stage?.querySelector('.stage-laptop'), phone: stage?.querySelector('.stage-phone') };

    function activate(step) {
        const index = steps.indexOf(step);
        steps.forEach(s => s.classList.toggle('is-active', s === step));
        dots.forEach((d, i) => d.classList.toggle('is-active', i === index));
        if (!stage) return;
        const shot = step.dataset.shot;
        stage.querySelectorAll('img[data-shot]').forEach(img => img.classList.toggle('is-active', img.dataset.shot === shot));
        Object.entries(devices).forEach(([kind, el]) => el?.classList.toggle('is-hidden', kind !== step.dataset.device));
    }
    activate(steps[0]);

    const watcher = new IntersectionObserver(entries => {
        entries.forEach(entry => { if (entry.isIntersecting) activate(entry.target); });
    }, { rootMargin: '-45% 0px -45% 0px' });
    steps.forEach(step => watcher.observe(step));
});

// ---------- Перемикач ролей: зʼявляється біля розповідей, «пігулка» їде за роллю ----------
const roleSwitch = document.querySelector('.role-switch');
const roleLinks = [...document.querySelectorAll('[data-role-link]')];
const thumb = document.querySelector('.role-switch-thumb');
const stories = [...document.querySelectorAll('.story')];
function moveThumb(link) {
    if (!thumb || !link) return;
    thumb.style.setProperty('--x', `${link.offsetLeft - 5}px`);
    thumb.style.setProperty('--w', `${link.offsetWidth}px`);
    thumb.style.left = '5px';
}
const roleWatcher = new IntersectionObserver(entries => {
    entries.forEach(entry => {
        if (!entry.isIntersecting) return;
        const role = entry.target.dataset.role;
        roleLinks.forEach(link => {
            const on = link.dataset.roleLink === role;
            link.classList.toggle('is-active', on);
            if (on) { link.setAttribute('aria-current', 'true'); moveThumb(link); } else link.removeAttribute('aria-current');
        });
    });
}, { rootMargin: '-50% 0px -50% 0px' });
stories.forEach(story => roleWatcher.observe(story));
function toggleSwitch() {
    if (!roleSwitch || !stories.length) return;
    const first = stories[0].getBoundingClientRect();
    const last = stories[stories.length - 1].getBoundingClientRect();
    roleSwitch.classList.toggle('is-on', first.top < innerHeight * 0.4 && last.bottom > innerHeight * 0.4);
}
addEventListener('scroll', toggleSwitch, { passive: true });
addEventListener('resize', () => moveThumb(document.querySelector('[data-role-link].is-active')));
toggleSwitch();

// ---------- Ланцюжок оплати й цифри ----------
const flow = document.querySelector('.flow-line');
const counters = [...document.querySelectorAll('[data-count]')];
const once = new IntersectionObserver(entries => {
    entries.forEach(entry => {
        if (!entry.isIntersecting) return;
        once.unobserve(entry.target);
        if (entry.target === flow) { flow.classList.add('is-run'); return; }
        const el = entry.target, end = Number(el.dataset.count);
        if (reduced || end < 2) return;
        const start = performance.now(), duration = 1100;
        const tick = now => {
            const t = Math.min(1, (now - start) / duration);
            el.textContent = String(Math.round(end * (1 - Math.pow(1 - t, 3))));
            if (t < 1) requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
    });
}, { threshold: 0.4 });
if (flow) once.observe(flow);
counters.forEach(el => once.observe(el));

// ---------- Збільшення знімка ----------
const dialog = document.getElementById('shotDialog');
const big = document.getElementById('shotImage');
const title = document.getElementById('shotTitle');
let opener = null;
function openShot(img, caption) {
    if (typeof dialog?.showModal !== 'function') return;
    opener = img;
    big.src = img.currentSrc || img.src;
    big.alt = caption;
    title.textContent = caption;
    dialog.showModal();
}
document.querySelectorAll('.stage').forEach(stage => {
    stage.addEventListener('click', event => {
        const img = event.target.closest('img.is-active');
        if (!img) return;
        const step = img.closest('.story').querySelector(`.step[data-shot="${img.dataset.shot}"]`);
        openShot(img, step?.querySelector('h3')?.textContent || 'Екран застосунку');
    });
});
document.querySelectorAll('.step-shot img').forEach(img => {
    img.style.cursor = 'zoom-in';
    img.addEventListener('click', () => openShot(img, img.closest('.step')?.querySelector('h3')?.textContent || img.alt));
});
dialog?.querySelector('[data-close-dialog]').addEventListener('click', () => dialog.close());
dialog?.addEventListener('click', event => { if (event.target === dialog) dialog.close(); });
dialog?.addEventListener('close', () => { big.removeAttribute('src'); opener?.focus?.({ preventScroll: true }); });
