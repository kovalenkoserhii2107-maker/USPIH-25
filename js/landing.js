// Публічна сторінка: лише локальні ефекти, без сесії й без звернень до бекенду.
// Без JavaScript сторінка читається повністю (видно кабінет бухгалтера й усі тексти).
document.documentElement.classList.add('js');

const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const finePointer = window.matchMedia('(pointer: fine)').matches;

// ---------- Шапка: тінь після початку прокрутки ----------
const header = document.querySelector('.site-header');
const onScroll = () => header?.classList.toggle('is-scrolled', window.scrollY > 8);
window.addEventListener('scroll', onScroll, { passive: true });
onScroll();

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

// ---------- Поява карток під час прокрутки ----------
if ('IntersectionObserver' in window && !reduced) {
    const cards = document.querySelectorAll('.proof-grid > div, .pain-grid article, .feature, .trust-grid article');
    const io = new IntersectionObserver(entries => entries.forEach(entry => {
        if (!entry.isIntersecting) return;
        entry.target.classList.add('is-in');
        io.unobserve(entry.target);
    }), { rootMargin: '0px 0px -8% 0px' });
    cards.forEach((card, i) => {
        card.classList.add('reveal');
        card.style.transitionDelay = `${(i % 4) * 60}ms`;
        io.observe(card);
    });
}

// ---------- Екскурсія: вкладки кабінетів ----------
const tabs = [...document.querySelectorAll('.tour-tabs [role="tab"]')];
function selectTab(tab, focus = false) {
    tabs.forEach(t => {
        const on = t === tab;
        t.setAttribute('aria-selected', String(on));
        t.tabIndex = on ? 0 : -1;
        document.getElementById(t.getAttribute('aria-controls')).hidden = !on;
    });
    if (focus) tab.focus();
}
tabs.forEach((tab, i) => {
    tab.addEventListener('click', () => selectTab(tab));
    tab.addEventListener('keydown', e => {
        const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
        if (!step) return;
        e.preventDefault();
        selectTab(tabs[(i + step + tabs.length) % tabs.length], true);
    });
});

// ---------- Екскурсія: пункт списку міняє екран ----------
// Знімок вантажиться лише тоді, коли його відкрили: сторінка не тягне два десятки картинок одразу.
document.querySelectorAll('.tour-panel').forEach(panel => {
    const items = [...panel.querySelectorAll('.tour-item')];
    const stage = panel.querySelector('.tour-stage');
    const laptop = stage.querySelector('.laptop');
    const phone = stage.querySelector('.phone');
    const show = item => {
        items.forEach(it => {
            const on = it === item;
            it.classList.toggle('is-active', on);
            it.setAttribute('aria-pressed', String(on));
        });
        // На телефоні список — горизонтальна стрічка: тримаємо обраний пункт у полі зору.
        if (item.parentElement.parentElement.scrollWidth > item.parentElement.parentElement.clientWidth) {
            item.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: reduced ? 'auto' : 'smooth' });
        }
        const isPhone = item.dataset.device === 'phone';
        const img = (isPhone ? phone : laptop)?.querySelector('img');
        if (!img) return;
        if (laptop) laptop.hidden = isPhone;
        if (phone) phone.hidden = !isPhone;
        stage.classList.toggle('is-phone', isPhone);
        const src = `assets/landing/${item.dataset.shot}.webp`;
        img.alt = `${panel.getAttribute('aria-labelledby') === 'tab-resident' ? 'Кабінет мешканця' : panel.getAttribute('aria-labelledby') === 'tab-board' ? 'Панель правління' : 'Кабінет бухгалтера'}: ${item.querySelector('b').textContent}`;
        if (img.getAttribute('src') === src) return;
        img.classList.add('is-loading');
        img.onload = img.onerror = () => img.classList.remove('is-loading');
        img.loading = 'eager';
        img.src = src;
    };
    items.forEach(item => item.addEventListener('click', () => show(item)));
    // Наступний знімок підвантажуємо, коли курсор лише підійшов до пункту.
    items.forEach(item => item.addEventListener('pointerenter', () => {
        const pre = new Image();
        pre.src = `assets/landing/${item.dataset.shot}.webp`;
    }, { once: true }));
});

// ---------- Збільшення знімка ----------
const dialog = document.getElementById('shotDialog');
const shotImage = document.getElementById('shotImage');
const shotTitle = document.getElementById('shotTitle');
const openShot = stage => {
    const img = [...stage.querySelectorAll('img')].find(i => !i.closest('[hidden]'));
    if (!img || !dialog?.showModal) return;
    shotImage.src = img.currentSrc || img.src;
    shotImage.alt = img.alt;
    shotTitle.textContent = img.alt || 'Екран застосунку';
    dialog.classList.toggle('is-phone', !!img.closest('.phone'));
    dialog.showModal();
};
document.querySelectorAll('.tour-stage').forEach(stage => {
    stage.tabIndex = 0;
    stage.setAttribute('role', 'button');
    stage.setAttribute('aria-label', 'Збільшити екран');
    stage.addEventListener('click', () => openShot(stage));
    stage.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openShot(stage); } });
});
dialog?.addEventListener('click', e => { if (e.target === dialog || e.target.closest('[data-close-dialog]')) dialog.close(); });
