// Публічна сторінка: лише локальні ефекти, без сесії й без звернень до бекенду.
// Без JavaScript сторінка читається повністю: видно панель правління, усі можливості
// розгорнуті, а форма заявки відкриває лист напряму.
document.documentElement.classList.add('js');

const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const finePointer = window.matchMedia('(pointer: fine)').matches;
const phoneLayout = window.matchMedia('(max-width: 680px)');

// ---------- Шапка: тінь після початку прокрутки й меню на вузькому екрані ----------
const header = document.querySelector('.site-header');
const onScroll = () => header?.classList.toggle('is-scrolled', window.scrollY > 8);
window.addEventListener('scroll', onScroll, { passive: true });
onScroll();

const menuBtn = document.querySelector('.menu-btn');
const nav = document.getElementById('siteNav');
const setMenu = open => {
    nav?.classList.toggle('is-open', open);
    menuBtn?.setAttribute('aria-expanded', String(open));
    menuBtn?.querySelector('use')?.setAttribute('href', open ? '#i-close' : '#i-menu');
};
menuBtn?.addEventListener('click', () => setMenu(!nav.classList.contains('is-open')));
nav?.addEventListener('click', e => { if (e.target.closest('a')) setMenu(false); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') setMenu(false); });
document.addEventListener('click', e => { if (!e.target.closest('.site-header')) setMenu(false); });

// ---------- Перший екран: легкий нахил сцени за курсором ----------
const heroScene = document.querySelector('.hero-scene');
if (heroScene && finePointer && !reduced) {
    let frame = 0;
    document.querySelector('.hero')?.addEventListener('pointermove', e => {
        cancelAnimationFrame(frame);
        frame = requestAnimationFrame(() => {
            const r = heroScene.getBoundingClientRect();
            heroScene.style.setProperty('--sx', ((e.clientX - r.left) / r.width - .5).toFixed(3));
            heroScene.style.setProperty('--sy', ((e.clientY - r.top) / r.height - .5).toFixed(3));
        });
    });
}
document.querySelectorAll('.v-bars').forEach(bars => [...bars.children].forEach((bar, i) => bar.style.setProperty('--i', i)));

// ---------- Поява блоків під час прокрутки ----------
if ('IntersectionObserver' in window && !reduced) {
    const groups = ['.proof li', '.track', '.feature', '.trust-grid article', '.steps li', '.faq-list details', '.contact-card', '.receipt'];
    const io = new IntersectionObserver(entries => entries.forEach(entry => {
        if (!entry.isIntersecting) return;
        entry.target.classList.add('is-in');
        io.unobserve(entry.target);
    }), { rootMargin: '0px 0px -6% 0px' });
    groups.forEach(selector => document.querySelectorAll(selector).forEach((el, i) => {
        el.classList.add('reveal');
        el.style.transitionDelay = `${(i % 4) * 60}ms`;
        io.observe(el);
    }));
}

// ---------- «Для кого»: вкладки ролей ----------
const tabs = [...document.querySelectorAll('.role-tab')];
function selectRole(tab, { focus = false, scroll = false } = {}) {
    tabs.forEach(t => {
        const on = t === tab;
        t.setAttribute('aria-selected', String(on));
        t.tabIndex = on ? 0 : -1;
        document.getElementById(t.getAttribute('aria-controls')).hidden = !on;
    });
    if (focus) tab.focus();
    // На телефоні вкладки прилипають: після вибору повертаємо початок кабінету в поле зору.
    if (scroll && phoneLayout.matches) {
        const bar = document.querySelector('.role-tabs');
        const panel = document.getElementById(tab.getAttribute('aria-controls'));
        const top = panel.getBoundingClientRect().top + window.scrollY - header.offsetHeight - bar.offsetHeight - 16;
        if (window.scrollY > top) window.scrollTo({ top, behavior: reduced ? 'auto' : 'smooth' });
    }
}
tabs.forEach((tab, i) => {
    tab.addEventListener('click', () => selectRole(tab, { scroll: true }));
    tab.addEventListener('keydown', e => {
        const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
        if (!step) return;
        e.preventDefault();
        selectRole(tabs[(i + step + tabs.length) % tabs.length], { focus: true });
    });
});
// Посилання виду landing.html#roles-acc відкриває потрібний кабінет одразу.
const roleFromHash = () => {
    const match = location.hash.match(/^#roles-(board|acc|res)$/);
    const tab = match && tabs.find(t => t.dataset.role === match[1]);
    if (!tab) return;
    selectRole(tab);
    document.getElementById('roles')?.scrollIntoView();
};
window.addEventListener('hashchange', roleFromHash);
roleFromHash();

// ---------- Шлях грошей: крапка проходить рівно до останнього кроку ----------
const fitTravel = () => document.querySelectorAll('.track ol').forEach(ol => {
    const last = ol.lastElementChild;
    if (last) ol.style.setProperty('--travel', `${last.offsetLeft}px`);
});
fitTravel();
window.addEventListener('resize', fitTravel, { passive: true });

// ---------- Можливості: на телефоні — згорнутий список, на компʼютері — усе розгорнуто ----------
const features = [...document.querySelectorAll('.feature')];
const fitFeatures = () => features.forEach((card, i) => { card.open = phoneLayout.matches ? i === 0 : true; });
fitFeatures();
phoneLayout.addEventListener('change', fitFeatures);

// ---------- Збільшення справжніх знімків ----------
const dialog = document.getElementById('shotDialog');
const shotImage = document.getElementById('shotImage');
const shotTitle = document.getElementById('shotTitle');
if (dialog?.showModal) {
    document.querySelectorAll('.role-visual .device').forEach(device => {
        const img = device.querySelector('img');
        if (!img) return;
        device.dataset.zoom = '';
        device.tabIndex = 0;
        device.setAttribute('role', 'button');
        device.setAttribute('aria-label', `Збільшити: ${img.alt}`);
        const open = () => {
            shotImage.src = img.currentSrc || img.src;
            shotImage.alt = img.alt;
            shotTitle.textContent = img.alt;
            dialog.classList.toggle('is-phone', device.classList.contains('phone'));
            dialog.showModal();
        };
        device.addEventListener('click', open);
        device.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
    });
    dialog.addEventListener('click', e => { if (e.target === dialog || e.target.closest('[data-close-dialog]')) dialog.close(); });
}

// ---------- Заявка: збираємо лист у пошті відвідувача ----------
const form = document.getElementById('leadForm');
form?.addEventListener('submit', e => {
    e.preventDefault();
    const data = new FormData(form);
    const value = name => String(data.get(name) || '').trim();
    const lines = [
        'Добрий день! Хочу підключити будинок до «Кабінету ОСББ».',
        '',
        `Імʼя: ${value('name')}`,
        `Телефон: ${value('phone')}`,
        `Будинок: ${value('house')}`,
        value('flats') ? `Квартир: ${value('flats')}` : '',
        `Я: ${value('role')}`
    ].filter((line, i) => line || i === 1);
    const to = form.getAttribute('action').replace(/^mailto:/, '');
    const subject = `Підключення ОСББ — ${value('house')}`;
    location.href = `mailto:${to}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(lines.join('\n'))}`;
    const note = document.getElementById('leadNote');
    if (note) {
        note.classList.add('is-ok');
        note.textContent = 'Лист відкрито у вашій пошті — натисніть «Надіслати». Не відкрився? Подзвоніть: +380 97 310 69 96.';
    }
});

// ---------- Телефон: панель дій зʼявляється після першого екрана й ховається біля форми ----------
const mCta = document.getElementById('mCta');
if (mCta && 'IntersectionObserver' in window) {
    const state = { hero: true, contact: false };
    const sync = () => mCta.classList.toggle('is-on', !state.hero && !state.contact);
    const watch = (el, key) => el && new IntersectionObserver(([entry]) => { state[key] = entry.isIntersecting; sync(); }, { threshold: 0 }).observe(el);
    watch(document.querySelector('.hero-actions'), 'hero');
    watch(document.getElementById('contact'), 'contact');
}
