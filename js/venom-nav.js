// ============================================================
// «Venom»: чорна підсвітка активного розділу перетікає, як симбіот.
//
// Під пунктами меню (.buh-nav, .buh-tabbar — бухгалтерія й панель
// правління) лежить шар із краплею. Коли інший пункт стає .active,
// крапля витягується до нього: голова летить уперед із пружним
// доскоком, хвіст тягнеться й рветься, між ними — тонке сухожилля й
// бризки, а на місці — короткі шипи. SVG-фільтр «goo» зливає це в
// одну рідку масу. Розмітку й логіку переходів не чіпаємо: шар
// стежить за класом .active сам.
//
// prefers-reduced-motion — без анімації, звичайна чорна пігулка.
// ============================================================
const SVG_NS = 'http://www.w3.org/2000/svg';
const ITEMS = ':scope > .buh-nav-item, :scope > .buh-tab';
const SKIN = 'radial-gradient(120% 160% at 28% 18%, #3a3a3f 0%, #111114 42%, #000 78%)';

let filterReady = false;
function ensureFilter() {
    if (filterReady) return;
    filterReady = true;
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('width', '0');
    svg.setAttribute('height', '0');
    svg.setAttribute('aria-hidden', 'true');
    svg.style.position = 'absolute';
    // Розмиття + поріг прозорості: окремі краплі зливаються в одну рідку масу.
    svg.innerHTML = `<defs><filter id="vn-goo" x="-20%" y="-60%" width="140%" height="220%" color-interpolation-filters="sRGB">
        <feGaussianBlur in="SourceGraphic" stdDeviation="5" result="b"/>
        <feColorMatrix in="b" mode="matrix" values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 24 -10"/></filter></defs>`;
    document.body.appendChild(svg);
}

const rectOf = (el, host) => {
    // Відносно контейнера, з урахуванням прокручування стрічки.
    const h = host.getBoundingClientRect(), r = el.getBoundingClientRect();
    return { x: r.left - h.left + host.scrollLeft, y: r.top - h.top + host.scrollTop, w: r.width, h: r.height };
};
const box = r => ({ left: `${r.x}px`, top: `${r.y}px`, width: `${r.w}px`, height: `${r.h}px` });
const lerp = (a, b, t) => a + (b - a) * t;
/** cubic-bezier як у CSS: прогрес часу → прогрес руху. */
function bezier(x1, y1, x2, y2) {
    const at = (t, a, b) => 3 * a * t * (1 - t) ** 2 + 3 * b * t * t * (1 - t) + t ** 3;
    return x => {
        let lo = 0, hi = 1, t = x;
        for (let i = 0; i < 18; i++) { t = (lo + hi) / 2; if (at(t, x1, x2) < x) lo = t; else hi = t; }
        return at(t, y1, y2);
    };
}
const EASE = { in: bezier(0.6, 0, 0.2, 1), fly: bezier(0.3, 0.9, 0.4, 1.2), io: bezier(0.42, 0, 0.58, 1) };
const mix = (r1, r2, k) => ({ x: lerp(r1.x, r2.x, k), y: lerp(r1.y, r2.y, k), w: lerp(r1.w, r2.w, k), h: lerp(r1.h, r2.h, k) });

function blob(layer, r, cls = '') {
    const el = document.createElement('i');
    el.className = `vn-blob ${cls}`;
    Object.assign(el.style, box(r), { background: SKIN });
    layer.appendChild(el);
    return el;
}

class Venom {
    constructor(host) {
        this.host = host;
        this.current = null;
        this.layer = document.createElement('span');
        this.layer.className = 'vn-layer';
        this.layer.setAttribute('aria-hidden', 'true');
        host.prepend(this.layer);
        host.classList.add('vn-on');
        this.head = null;
        this.gen = 0;
        new MutationObserver(() => this.sync()).observe(host, { subtree: true, childList: true, attributes: true, attributeFilter: ['class'] });
        const ro = new ResizeObserver(() => this.place());
        ro.observe(host);
        this.ro = ro;
        this.sync(true);
    }

    active() {
        return [...this.host.querySelectorAll(ITEMS)].find(el => el.classList.contains('active')) || null;
    }

    visible() {
        // offsetParent у position: fixed (нижня панель) завжди null — дивимось на розмір.
        const r = this.host.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
    }

    fit() {
        this.layer.style.width = `${this.host.scrollWidth}px`;
        this.layer.style.height = `${this.host.scrollHeight}px`;
    }

    /** Без анімації — після зміни розміру, шрифту чи лічильника на пункті. */
    place() {
        this.host.querySelectorAll(ITEMS).forEach(el => this.ro.observe(el));
        const el = this.active();
        if (!el || !this.visible() || this.layer.classList.contains('is-moving')) return;
        this.fit();
        if (!this.head) this.head = blob(this.layer, rectOf(el, this.host), 'is-head');
        else Object.assign(this.head.style, box(rectOf(el, this.host)));
    }

    sync(initial = false) {
        // Панель правління перебудовує пункти (replaceChildren) — шар повертаємо на місце.
        if (this.layer.parentNode !== this.host) this.host.prepend(this.layer);
        const el = this.active();
        if (el === this.current) return;
        const prev = this.current;
        this.current = el;
        if (initial || !this.visible()) { this.place(); return; }
        this.fit();
        if (!el) { this.vanish(); return; }
        if (!prev || !this.head || !prev.isConnected) { this.drop(el); return; }
        this.move(prev, el);
    }

    /** Шар у режимі «рідини», доки йдуть анімації; потім лишається одна голова. */
    settle() {
        const gen = ++this.gen;
        this.layer.classList.add('is-moving');
        const done = () => {
            if (gen !== this.gen) return;
            this.layer.querySelectorAll('.vn-blob:not(.is-head)').forEach(b => b.remove());
            this.layer.classList.remove('is-moving');
            this.place();
        };
        const anims = this.layer.getAnimations?.({ subtree: true });
        if (anims) Promise.allSettled(anims.map(a => a.finished)).then(done);
        else setTimeout(done, 1000);
    }

    /** Перетікання від A до B: голова летить, хвіст лишається, між ними — сухожилля, що рвуться. */
    move(prevEl, el) {
        // Новий клік у польоті — летимо далі з того місця, де крапля зараз, без стрибка назад.
        const live = this.head?.getAnimations().length ? rectOf(this.head, this.host) : null;
        const A = live || rectOf(prevEl, this.host), B = rectOf(el, this.host);
        const cA = { x: A.x + A.w / 2, y: A.y + A.h / 2 };
        const cB = { x: B.x + B.w / 2, y: B.y + B.h / 2 };
        const dist = Math.abs(cB.x - cA.x);
        const dur = Math.round(330 + Math.min(200, dist * 0.26));
        const d = cB.x >= cA.x ? 1 : -1;
        const H = Math.max(A.h, B.h);
        if (this.head) this.head.getAnimations().forEach(a => a.cancel());
        this.layer.querySelectorAll('.vn-blob:not(.is-head)').forEach(b => b.remove());
        const head = this.head || blob(this.layer, A, 'is-head');
        this.head = head;
        Object.assign(head.style, box(B));

        // Голова: замах назад, ривок витягнутою краплею, удар-сплющення, пружне осідання.
        const at = (t, w, h, shift = 0) => {
            const cx = lerp(cA.x, cB.x, t) + shift, cy = lerp(cA.y, cB.y, t);
            return { x: cx - w / 2, y: cy - h / 2, w, h };
        };
        const flight = Math.max(A.w, B.w) * 0.72 + Math.min(70, dist * 0.12);
        const path = [
            [0, A],
            [0.12, at(0, A.w * 0.92, A.h * 1.04, -d * 6)],
            [0.46, at(0.78, flight, H * 0.74)],
            [0.62, { x: B.x + d * 6 - B.w * 0.05, y: B.y + B.h * 0.1, w: B.w * 1.1, h: B.h * 0.8 }],
            [0.78, { x: B.x - d * 2 + B.w * 0.03, y: B.y - B.h * 0.05, w: B.w * 0.94, h: B.h * 1.1 }],
            [0.9, { x: B.x + d, y: B.y + B.h * 0.02, w: B.w * 1.02, h: B.h * 0.97 }],
            [1, B]
        ];
        // Траєкторію рахуємо самі (з тими ж кривими), щоб сухожилля трималися голови без розриву.
        const ease = [EASE.in, EASE.in, EASE.fly, EASE.io, EASE.io, EASE.io];
        const headRect = o => {
            const i = Math.max(1, path.findIndex(([k]) => k >= o));
            const [o1, r1] = path[i - 1], [o2, r2] = path[i];
            return mix(r1, r2, ease[i - 1](Math.min(1, Math.max(0, (o - o1) / (o2 - o1)))));
        };
        const STEPS = 28;
        head.animate(Array.from({ length: STEPS + 1 }, (_, i) => ({ ...box(headRect(i / STEPS)), offset: i / STEPS })), { duration: dur, easing: 'linear' });
        const headAt = o => { const r = headRect(o); return r.x + r.w / 2; };

        // Хвіст: лишається на місці, тягнеться слідом і всихає в краплю.
        const tail = blob(this.layer, A);
        tail.animate([
            box(A),
            { ...box(at(0, A.w * 0.86, A.h * 0.92, d * 4)), offset: 0.3 },
            { ...box(at(0.06, A.h * 0.62, A.h * 0.62, d * 6)), offset: 0.6 },
            box(at(0.12, 0, 0, d * 8))
        ], { duration: Math.round(dur * 0.85), easing: 'cubic-bezier(.45,0,.3,1)', fill: 'forwards' });

        // Сухожилля: кілька пасом із різною товщиною й висотою — напинаються й рвуться по черзі.
        [[0, 0.5, 0.64], [H * 0.18, 0.2, 0.54], [-H * 0.2, 0.16, 0.58]].forEach(([dy, thick, snap]) => {
            const th = H * thick, n = 16;
            const frames = Array.from({ length: n + 1 }, (_, i) => {
                const o = (i / n) * snap;
                const hx = headAt(o);
                const tx = cA.x + d * Math.min(o * 30, 10);
                // Товщає на розгоні, тоншає в польоті, рветься в кінці.
                const k = i === n ? 0 : Math.min(1, 0.3 + o * 6) * Math.max(0.12, 1 - (o / snap) ** 1.6);
                return { ...box({ x: Math.min(tx, hx), y: cA.y + dy * Math.min(1, o * 3) - (th * k) / 2, w: Math.abs(hx - tx), h: th * k }), offset: i / n };
            });
            const strand = blob(this.layer, A, 'is-bridge');
            strand.animate(frames, { duration: Math.round(dur * snap), easing: 'linear', fill: 'forwards' });
        });

        // Бризки в мить розриву: більші летять за головою, дрібні падають назад у хвіст.
        const drops = dist > 260 ? 5 : 4;
        for (let i = 0; i < drops; i++) {
            const s = 6 + ((i * 7) % 9);
            const mid = lerp(cA.x, cB.x, 0.45 + 0.08 * i);
            const back = i % 3 === 2;
            const dy = (i % 2 ? 1 : -1) * H * (0.14 + 0.06 * (i % 3));
            const drop = blob(this.layer, { x: mid - s / 2, y: cA.y - s / 2, w: s, h: s }, 'is-drop');
            const toX = (back ? cA.x : cB.x) - mid;
            drop.animate([
                { transform: 'translate(0,0) scale(.2)' },
                { transform: `translate(${toX * 0.35}px, ${dy}px) scale(1)`, offset: 0.4 },
                { transform: `translate(${toX * 0.8}px, ${dy * 0.35}px) scale(.7)`, offset: 0.75 },
                { transform: `translate(${toX}px, 0) scale(0)` }
            ], { duration: Math.round(dur * 0.55), delay: Math.round(dur * 0.32 + i * 16), easing: 'cubic-bezier(.3,0,.4,1)', fill: 'both' });
        }

        // Шипи симбіота при ударі: вистрілюють угору й униз і втягуються.
        [[0.22, -1, 0.5], [0.5, 1, 0.42], [0.74, -1, 0.34], [0.86, 1, 0.26]].forEach(([fx, side, len], i) => {
            const w = 5, h = B.h * len;
            const spike = blob(this.layer, { x: B.x + B.w * fx - w / 2, y: side < 0 ? B.y - h * 0.45 : B.y + B.h - h * 0.55, w, h }, 'is-spike');
            spike.style.transformOrigin = side < 0 ? '50% 100%' : '50% 0%';
            spike.animate([
                { transform: 'scaleY(0)' }, { transform: 'scaleY(1)', offset: 0.4 }, { transform: 'scaleY(0)' }
            ], { duration: 300, delay: Math.round(dur * 0.6) + i * 28, easing: 'cubic-bezier(.3,1.5,.5,1)', fill: 'both' });
        });

        // Текст: новий пункт лишається чорним, доки голова не під ним; старий — білим, доки на ньому хвіст.
        el.animate([{ color: '#000' }, { color: '#000', offset: 0.82 }, { color: '#fff' }], { duration: Math.round(dur * 0.62), easing: 'ease-out' });
        prevEl.animate([{ color: '#fff' }, { color: '#fff', offset: 0.5 }, { color: '#000' }], { duration: Math.round(dur * 0.5), easing: 'ease-in' });
        this.settle();
    }

    /** Розділ без пункту в стрічці (лише в меню): крапля стікає й зникає. */
    vanish() {
        if (!this.head) return;
        const head = this.head;
        this.head = null;
        const r = { x: head.offsetLeft, y: head.offsetTop, w: head.offsetWidth, h: head.offsetHeight };
        head.classList.remove('is-head');
        head.animate([
            box(r),
            { ...box({ x: r.x + r.w * 0.2, y: r.y + r.h * 0.2, w: r.w * 0.6, h: r.h * 0.75 }), offset: 0.5 },
            box({ x: r.x + r.w / 2, y: r.y + r.h, w: 0, h: 0 })
        ], { duration: 320, easing: 'cubic-bezier(.5,0,.75,0)', fill: 'forwards' });
        this.settle();
    }

    /** Поява з нічого: крапля падає й розтікається. */
    drop(el) {
        const B = rectOf(el, this.host);
        if (this.head) this.head.remove();
        this.head = blob(this.layer, B, 'is-head');
        const s = Math.min(B.w, B.h) * 0.5;
        this.head.animate([
            box({ x: B.x + B.w / 2 - s / 2, y: B.y - s * 0.6, w: s, h: s }),
            { ...box({ x: B.x + B.w * 0.08, y: B.y + B.h * 0.1, w: B.w * 0.84, h: B.h * 0.9 }), offset: 0.6, easing: 'cubic-bezier(.2,.9,.3,1.3)' },
            box(B)
        ], { duration: 360, easing: 'cubic-bezier(.4,0,.2,1)' });
        this.settle();
    }
}

/** Підключити до всіх стрічок розділів на сторінці. */
export function initVenomNav(root = document) {
    if (typeof window === 'undefined' || !('animate' in Element.prototype) || typeof ResizeObserver === 'undefined') return;
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    ensureFilter();
    root.querySelectorAll('.buh-nav, .buh-tabbar').forEach(host => {
        if (!host.__venom) host.__venom = new Venom(host);
    });
}
