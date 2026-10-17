// Публічна сторінка: лише локальні ефекти, без сесії й без звернень до бекенду.
// Без JavaScript сторінка повністю читається: кроки, знімки, квитанція й відповіді на місці.
document.documentElement.classList.add('js');

const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const finePointer = window.matchMedia('(pointer: fine)').matches;
const header = document.querySelector('.site-header');
const progress = document.querySelector('.scroll-progress');
const heroScene = document.querySelector('.hero-scene');
const hero = document.querySelector('.hero');

// ---------- Заголовки: кожне слово окремо, щоб підніматися з-під маски ----------
document.querySelectorAll('.split').forEach(title => {
    let index = 0;
    const walk = node => {
        [...node.childNodes].forEach(child => {
            if (child.nodeType === Node.TEXT_NODE) {
                const parts = child.textContent.split(/(\s+)/);
                const frag = document.createDocumentFragment();
                parts.forEach(part => {
                    if (!part) return;
                    if (/^\s+$/.test(part)) { frag.append(part); return; }
                    const word = document.createElement('span');
                    word.className = 'w';
                    const inner = document.createElement('i');
                    inner.textContent = part;
                    inner.style.setProperty('--i', index++);
                    word.append(inner);
                    frag.append(word);
                });
                child.replaceWith(frag);
            } else if (child.nodeType === Node.ELEMENT_NODE && child.tagName !== 'BR') {
                walk(child);
            }
        });
    };
    walk(title);
    title.setAttribute('aria-label', title.textContent.replace(/\s+/g, ' ').trim());
});

// Градієнт у словах — один на весь рядок: кожне слово бере свій шматок спільного тла.
function alignGradients() {
    document.querySelectorAll('.split .grad').forEach(grad => {
        const box = grad.getBoundingClientRect();
        grad.querySelectorAll('.w > i').forEach(word => {
            const left = word.parentElement.getBoundingClientRect().left - box.left;
            word.style.setProperty('--gw', `${box.width}px`);
            word.style.setProperty('--gx0', `${-left}px`);
        });
    });
}
alignGradients();
addEventListener('resize', alignGradients);
document.fonts?.ready.then(alignGradients);

// ---------- Прогрес прокрутки, тінь шапки, рух першого екрана й лінії кроків ----------
const stories = [...document.querySelectorAll('.story')];
let ticking = false;
function onScroll() {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => {
        const max = document.documentElement.scrollHeight - innerHeight;
        progress?.style.setProperty('--p', max > 0 ? String(scrollY / max) : '0');
        header?.classList.toggle('is-scrolled', scrollY > 8);
        if (hero && heroScene && !reduced) {
            const hp = Math.min(1, Math.max(0, scrollY / hero.offsetHeight));
            heroScene.style.setProperty('--hp', hp.toFixed(3));
        }
        stories.forEach(story => {
            const steps = story.querySelector('.steps');
            if (!steps) return;
            const box = steps.getBoundingClientRect();
            const sp = Math.min(1, Math.max(0, (innerHeight / 2 - box.top) / box.height));
            steps.style.setProperty('--sp', sp.toFixed(3));
        });
        toggleSwitch();
        ticking = false;
    });
}
addEventListener('scroll', onScroll, { passive: true });

// ---------- Поява блоків: черговість у межах спільного батька ----------
const revealer = new IntersectionObserver(entries => {
    entries.forEach(entry => {
        if (!entry.isIntersecting) return;
        entry.target.classList.add('is-in');
        revealer.unobserve(entry.target);
        // Після появи затримка більше не потрібна — інакше нахил за курсором «запізнюється».
        setTimeout(() => entry.target.style.setProperty('--stagger', '0'), 1800);
    });
}, { rootMargin: '0px 0px -10% 0px', threshold: 0.12 });
document.querySelectorAll('.reveal, .split').forEach(el => {
    if (el.classList.contains('reveal')) {
        const siblings = [...el.parentElement.children].filter(c => c.classList.contains('reveal'));
        el.style.setProperty('--stagger', String(Math.max(0, siblings.indexOf(el))));
    }
    revealer.observe(el);
});

// ---------- 3D: перший екран нахиляється за курсором ----------
if (heroScene && !reduced && finePointer) {
    hero.addEventListener('pointermove', event => {
        const box = heroScene.getBoundingClientRect();
        heroScene.style.setProperty('--sx', ((event.clientX - box.left) / box.width - 0.5).toFixed(3));
        heroScene.style.setProperty('--sy', ((event.clientY - box.top) / box.height - 0.5).toFixed(3));
    });
    hero.addEventListener('pointerleave', () => { heroScene.style.setProperty('--sx', '0'); heroScene.style.setProperty('--sy', '0'); });
}

// ---------- 3D-нахил карток і квитанції з відблиском ----------
if (!reduced && finePointer) {
    document.querySelectorAll('[data-tilt]').forEach(card => {
        const strength = card.classList.contains('receipt') ? 6 : 8;
        card.addEventListener('pointermove', event => {
            const box = card.getBoundingClientRect();
            const x = (event.clientX - box.left) / box.width, y = (event.clientY - box.top) / box.height;
            card.style.setProperty('--ry', `${((x - 0.5) * strength).toFixed(2)}deg`);
            card.style.setProperty('--rx', `${((0.5 - y) * strength).toFixed(2)}deg`);
            card.style.setProperty('--gx', `${(x * 100).toFixed(1)}%`);
            card.style.setProperty('--gy', `${(y * 100).toFixed(1)}%`);
        });
        card.addEventListener('pointerleave', () => { card.style.setProperty('--rx', '0deg'); card.style.setProperty('--ry', '0deg'); });
    });
}

// ---------- Розповіді ролей: знімок змінюється разом із кроком ----------
stories.forEach(story => {
    const steps = [...story.querySelectorAll('.step')];
    const stage = story.querySelector('.stage');
    const dots = [...story.querySelectorAll('.stage-dots i')];
    const devices = { laptop: stage?.querySelector('.stage-laptop'), phone: stage?.querySelector('.stage-phone') };
    const order = steps.map(step => step.dataset.shot);

    function activate(step) {
        const index = steps.indexOf(step);
        steps.forEach(s => s.classList.toggle('is-active', s === step));
        dots.forEach((d, i) => d.classList.toggle('is-active', i === index));
        if (!stage) return;
        stage.querySelectorAll('img[data-shot]').forEach(img => {
            const at = order.indexOf(img.dataset.shot);
            img.classList.toggle('is-active', at === index);
            img.classList.toggle('is-past', at < index);
        });
        Object.entries(devices).forEach(([kind, el]) => {
            if (!el) return;
            el.classList.toggle('is-hidden', kind !== step.dataset.device);
            // Пристрій трохи повертається від кроку до кроку — сцена «дихає»
            el.style.setProperty('--try', `${(index % 2 ? 4 : -4)}deg`);
            el.style.setProperty('--trx', `${(index % 3) - 1}deg`);
        });
    }
    activate(steps[0]);

    const watcher = new IntersectionObserver(entries => {
        entries.forEach(entry => { if (entry.isIntersecting) activate(entry.target); });
    }, { rootMargin: '-45% 0px -45% 0px' });
    steps.forEach(step => watcher.observe(step));
});

// ---------- Перемикач ролей: «пігулка» їде за роллю ----------
const roleSwitch = document.querySelector('.role-switch');
const roleLinks = [...document.querySelectorAll('[data-role-link]')];
const thumb = document.querySelector('.role-switch-thumb');
function moveThumb(link) {
    if (!thumb || !link) return;
    thumb.style.setProperty('--x', `${link.offsetLeft}px`);
    thumb.style.setProperty('--w', `${link.offsetWidth}px`);
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
addEventListener('resize', () => moveThumb(document.querySelector('[data-role-link].is-active')));
onScroll();

// ---------- Квитанція «друкується», коли зʼявляється в полі зору ----------
const receipt = document.querySelector('.receipt');
const formatMoney = value => value.toLocaleString('uk-UA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
function countUp(el, end, money) {
    if (reduced) return;
    const start = performance.now(), duration = 1400;
    const tick = now => {
        const t = Math.min(1, (now - start) / duration);
        const value = end * (1 - Math.pow(1 - t, 3));
        el.textContent = money ? formatMoney(value) : String(Math.round(value));
        if (t < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
}
if (receipt) {
    const printer = new IntersectionObserver(entries => {
        if (!entries[0].isIntersecting) return;
        printer.disconnect();
        receipt.classList.add('is-printed');
        setTimeout(() => receipt.classList.add('is-settled'), 2300);
        const total = receipt.querySelector('[data-count-money]');
        if (total) setTimeout(() => countUp(total, Number(total.dataset.countMoney), true), 900);
    }, { threshold: 0.25 });
    printer.observe(receipt.closest('.receipt-stage'));
}

// ---------- Ланцюжок оплати: лінія, вузли й імпульс; цифри ----------
const flow = document.querySelector('.flow-line');
if (flow) {
    const pulse = document.createElement('i');
    pulse.className = 'flow-pulse';
    pulse.setAttribute('aria-hidden', 'true');
    flow.append(pulse);
}
const once = new IntersectionObserver(entries => {
    entries.forEach(entry => {
        if (!entry.isIntersecting) return;
        once.unobserve(entry.target);
        if (entry.target === flow) { flow.classList.add('is-run'); return; }
        const end = Number(entry.target.dataset.count);
        if (end > 1) countUp(entry.target, end, false);
    });
}, { threshold: 0.4 });
if (flow) once.observe(flow);
document.querySelectorAll('[data-count]').forEach(el => once.observe(el));

// Світло в темній сцені йде за курсором
const flowSection = document.querySelector('.flow-section');
if (flowSection && !reduced && finePointer) {
    flowSection.addEventListener('pointermove', event => {
        const box = flowSection.getBoundingClientRect();
        flowSection.style.setProperty('--mx', `${event.clientX - box.left}px`);
        flowSection.style.setProperty('--my', `${event.clientY - box.top}px`);
    });
}

// Стрічки можливостей: дублюємо вміст, щоб рух був безшовним
document.querySelectorAll('.ticker-track').forEach(track => {
    [...track.children].forEach(item => { const copy = item.cloneNode(true); copy.setAttribute('aria-hidden', 'true'); track.append(copy); });
});

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
