// ============================================================
// «Venom»: чорна підсвітка активного розділу перетікає, як рідина.
//
// Під пунктами меню (.buh-nav, .buh-tabbar — бухгалтерія й панель
// правління) лежить шар із краплею. Коли інший пункт стає .active,
// крапля тече до нього, як вода чи ртуть: передній край набухає,
// крапля витягується сльозою, хвіст стікає в шийку, шийка тоншає й
// відривається (як струмінь із крана) — дрібні намистини наздоганяють
// краплю й вливаються в неї. На місці — згасаюче погойдування й легкі
// брижі. SVG-фільтр «goo» зливає все в одну рідку масу. Розмітку й
// логіку переходів не чіпаємо: шар стежить за класом .active сам.
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
        <feGaussianBlur in="SourceGraphic" stdDeviation="7" result="b"/>
        <feColorMatrix in="b" mode="matrix" values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 20 -8"/></filter></defs>`;
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
const EASE = { io: bezier(0.45, 0, 0.55, 1), flow: bezier(0.4, 0.1, 0.25, 1) };
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
        // Брижі — окремо, поза фільтром: тонке кільце, що розходиться.
        this.fx = document.createElement('span');
        this.fx.className = 'vn-fx';
        this.fx.setAttribute('aria-hidden', 'true');
        this.layer.after(this.fx);
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
        if (this.layer.parentNode !== this.host) { this.host.prepend(this.layer); this.layer.after(this.fx); }
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

    /** Брижі навколо краплі, коли вона заспокоюється. */
    ripple(B, delay) {
        for (let i = 0; i < 2; i++) {
            const ring = document.createElement('i');
            ring.className = 'vn-ripple';
            Object.assign(ring.style, box(B));
            this.fx.appendChild(ring);
            const a = ring.animate([
                { transform: 'scale(1, 1)', opacity: 0.32 },
                { transform: `scale(${1 + 18 / B.w}, ${1 + 18 / B.h})`, opacity: 0 }
            ], { duration: 900, delay: delay + i * 170, easing: 'cubic-bezier(.2,.6,.3,1)' });
            a.finished.then(() => ring.remove(), () => ring.remove());
        }
    }

    /** Перетікання від A до B: крапля тече, шийка рветься на намистини, на місці — погойдування. */
    move(prevEl, el) {
        // Новий клік, поки крапля тече, — тече далі з того місця, де вона зараз.
        const live = this.head?.getAnimations().length ? rectOf(this.head, this.host) : null;
        const A = live || rectOf(prevEl, this.host), B = rectOf(el, this.host);
        const cA = { x: A.x + A.w / 2, y: A.y + A.h / 2 };
        const cB = { x: B.x + B.w / 2, y: B.y + B.h / 2 };
        const dist = Math.abs(cB.x - cA.x);
        const dur = Math.round(620 + Math.min(260, dist * 0.34));
        const d = cB.x >= cA.x ? 1 : -1;
        const H = Math.max(A.h, B.h);
        if (this.head) this.head.getAnimations().forEach(a => a.cancel());
        this.layer.querySelectorAll('.vn-blob:not(.is-head)').forEach(b => b.remove());
        const head = this.head || blob(this.layer, A, 'is-head');
        this.head = head;
        Object.assign(head.style, box(B));

        // Голова: передній край набухає, крапля тече сльозою, м'яко входить у місце й погойдується.
        const at = (t, w, h, shift = 0) => {
            const cx = lerp(cA.x, cB.x, t) + shift, cy = lerp(cA.y, cB.y, t);
            return { x: cx - w / 2, y: cy - h / 2, w, h };
        };
        const flow = Math.max(A.w, B.w) * 0.9 + Math.min(40, dist * 0.08);
        const path = [
            [0, A],
            [0.2, at(0.06, A.w * 1.12, A.h * 0.96, d * A.w * 0.1)],
            [0.62, at(0.92, flow, H * 0.84)],
            [0.76, { x: B.x + d * 3 - B.w * 0.03, y: B.y + B.h * 0.04, w: B.w * 1.06, h: B.h * 0.92 }],
            [0.86, { x: B.x - d * 1.5 + B.w * 0.02, y: B.y - B.h * 0.025, w: B.w * 0.96, h: B.h * 1.05 }],
            [0.94, { x: B.x - B.w * 0.008, y: B.y + B.h * 0.01, w: B.w * 1.016, h: B.h * 0.98 }],
            [1, B]
        ];
        // Траєкторію рахуємо самі (з тими ж кривими), щоб шийка трималася голови без розриву.
        const ease = [EASE.io, EASE.flow, EASE.io, EASE.io, EASE.io, EASE.io];
        const headRect = o => {
            const i = Math.max(1, path.findIndex(([k]) => k >= o));
            const [o1, r1] = path[i - 1], [o2, r2] = path[i];
            return mix(r1, r2, ease[i - 1](Math.min(1, Math.max(0, (o - o1) / (o2 - o1)))));
        };
        const STEPS = 36;
        head.animate(Array.from({ length: STEPS + 1 }, (_, i) => ({ ...box(headRect(i / STEPS)), offset: i / STEPS })), { duration: dur, easing: 'linear' });
        const headAt = o => { const r = headRect(o); return r.x + r.w / 2; };

        // Хвіст: лишається, поки крапля відтікає, і стягується в шийку.
        const tail = blob(this.layer, A);
        tail.animate([
            box(A),
            { ...box(at(0, A.w * 0.8, A.h * 0.9, d * A.w * 0.08)), offset: 0.3 },
            { ...box(at(0.08, A.h * 0.56, A.h * 0.56, d * 4)), offset: 0.62 },
            box(at(0.16, 0, 0))
        ], { duration: Math.round(dur * 0.72), easing: 'cubic-bezier(.45,0,.35,1)', fill: 'forwards' });

        // Шийка: одна рідка перемичка — тоншає, як струмінь, і відривається.
        const pinch = 0.5;
        const n = 20, th = H * 0.46;
        const neckFrames = Array.from({ length: n + 1 }, (_, i) => {
            const o = (i / n) * pinch;
            const hx = headAt(o);
            const tx = lerp(cA.x, cA.x + d * A.w * 0.3, Math.min(1, o / pinch));
            const k = i === n ? 0 : Math.min(1, 0.35 + o * 5) * (1 - (o / pinch) ** 1.4) * 0.92 + 0.04;
            return { ...box({ x: Math.min(tx, hx), y: cA.y - (th * k) / 2, w: Math.abs(hx - tx), h: th * k }), offset: i / n };
        });
        blob(this.layer, A, 'is-bridge').animate(neckFrames, { duration: Math.round(dur * pinch), easing: 'linear', fill: 'forwards' });

        // Намистини з розірваної шийки: пливуть до краплі й вливаються в неї.
        const beads = dist > 240 ? 4 : 3;
        for (let i = 0; i < beads; i++) {
            const t = (i + 1) / (beads + 1);
            const size = H * (0.2 + 0.05 * ((i + 1) % 3));
            const from = lerp(cA.x + d * A.w * 0.3, headAt(pinch), t);
            const bead = blob(this.layer, { x: from - size / 2, y: cA.y - size / 2, w: size, h: size }, 'is-drop');
            const wobble = (i % 2 ? 1 : -1) * H * 0.05;
            const to = cB.x - from;
            bead.animate([
                { transform: 'translate(0,0) scale(.6)' },
                { transform: `translate(${to * 0.35}px, ${wobble}px) scale(1)`, offset: 0.35 },
                { transform: `translate(${to * 0.85}px, ${-wobble * 0.5}px) scale(.8)`, offset: 0.75 },
                { transform: `translate(${to}px, 0) scale(.15)` }
            ], { duration: Math.round(dur * (0.42 + 0.06 * i)), delay: Math.round(dur * pinch - 30 + i * 22), easing: 'cubic-bezier(.45,0,.4,1)', fill: 'both' });
        }

        this.ripple(B, Math.round(dur * 0.72));
        // Текст: новий пункт біліє, коли крапля вже під ним; старий лишається білим, доки на ньому хвіст.
        el.animate([{ color: '#000' }, { color: '#000', offset: 0.78 }, { color: '#fff' }], { duration: Math.round(dur * 0.82), easing: 'ease-out' });
        prevEl.animate([{ color: '#fff' }, { color: '#fff', offset: 0.45 }, { color: '#000' }], { duration: Math.round(dur * 0.55), easing: 'ease-in' });
        this.settle();
    }

    /** Розділ без пункту в стрічці (лише в меню): крапля стікає донизу й зникає. */
    vanish() {
        if (!this.head) return;
        const head = this.head;
        this.head = null;
        const r = { x: head.offsetLeft, y: head.offsetTop, w: head.offsetWidth, h: head.offsetHeight };
        head.classList.remove('is-head');
        head.animate([
            box(r),
            { ...box({ x: r.x + r.w * 0.12, y: r.y + r.h * 0.08, w: r.w * 0.76, h: r.h * 0.95 }), offset: 0.35 },
            { ...box({ x: r.x + r.w * 0.34, y: r.y + r.h * 0.35, w: r.w * 0.32, h: r.h * 0.6 }), offset: 0.7 },
            box({ x: r.x + r.w / 2, y: r.y + r.h, w: 0, h: 0 })
        ], { duration: 560, easing: 'cubic-bezier(.45,0,.55,1)', fill: 'forwards' });
        this.settle();
    }

    /** Поява з нічого: крапля падає, розтікається й погойдується. */
    drop(el) {
        const B = rectOf(el, this.host);
        if (this.head) this.head.remove();
        this.head = blob(this.layer, B, 'is-head');
        const s = Math.min(B.w, B.h) * 0.46;
        this.head.animate([
            box({ x: B.x + B.w / 2 - s / 2, y: B.y - s * 0.4, w: s, h: s * 1.1 }),
            { ...box({ x: B.x + B.w * 0.05, y: B.y + B.h * 0.08, w: B.w * 0.9, h: B.h * 0.86 }), offset: 0.45, easing: 'cubic-bezier(.3,.6,.3,1)' },
            { ...box({ x: B.x - B.w * 0.02, y: B.y + B.h * 0.03, w: B.w * 1.04, h: B.h * 0.94 }), offset: 0.7 },
            { ...box({ x: B.x + B.w * 0.01, y: B.y - B.h * 0.01, w: B.w * 0.98, h: B.h * 1.02 }), offset: 0.86 },
            box(B)
        ], { duration: 640, easing: 'cubic-bezier(.4,0,.3,1)' });
        this.ripple(B, 300);
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
