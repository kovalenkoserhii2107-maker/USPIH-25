// Панель демо-будинку: хто ви зараз, інша роль, почати заново, вийти.
import { ROLES, role, setRole, exitDemo } from './runtime.js';

const CSS = `
.demo-bar{position:fixed;left:50%;bottom:calc(14px + env(safe-area-inset-bottom));z-index:2147483000;transform:translateX(-50%);display:flex;align-items:center;gap:6px;
 padding:6px 6px 6px 14px;border-radius:999px;background:rgba(17,17,20,.92);color:#fff;font:600 13px/1.2 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,system-ui,sans-serif;
 box-shadow:0 18px 40px -16px rgba(0,0,0,.55);backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);max-width:calc(100vw - 20px)}
.demo-bar b{font-weight:800;white-space:nowrap}
.demo-bar .demo-tag{padding:3px 8px;border-radius:999px;background:#FFE15A;color:#000;font-size:11px;font-weight:800;letter-spacing:.04em;text-transform:uppercase}
.demo-bar button{display:inline-flex;align-items:center;gap:6px;min-height:34px;padding:0 12px;border:0;border-radius:999px;background:rgba(255,255,255,.14);color:#fff;font:inherit;cursor:pointer;white-space:nowrap}
.demo-bar button:hover{background:rgba(255,255,255,.24)}
.demo-menu{position:fixed;left:50%;bottom:calc(64px + env(safe-area-inset-bottom));z-index:2147483001;transform:translateX(-50%);width:min(360px,calc(100vw - 20px));padding:8px;border-radius:22px;
 background:#fff;color:#000;box-shadow:0 30px 70px -20px rgba(0,0,0,.5);font:500 14px/1.35 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,system-ui,sans-serif}
.demo-menu[hidden]{display:none}
.demo-menu p{margin:6px 10px 8px;color:#555;font-size:12.5px}
.demo-menu a,.demo-menu button{display:flex;flex-direction:column;align-items:flex-start;width:100%;padding:10px 12px;border:0;border-radius:14px;background:none;color:#000;font:inherit;text-align:left;text-decoration:none;cursor:pointer}
.demo-menu a:hover,.demo-menu button:hover{background:#F2F4F7}
.demo-menu a.is-on{background:#000;color:#fff}
.demo-menu a b{font-weight:800}
.demo-menu small{color:inherit;opacity:.65;font-size:12px}
.demo-menu hr{margin:6px 4px;border:0;border-top:1px solid #EEF0F3}
@media (max-width:900px){.demo-bar{bottom:calc(92px + env(safe-area-inset-bottom));padding:4px 4px 4px 10px;font-size:12px}.demo-bar .demo-hide{display:none}
 .demo-bar button{min-height:30px;padding:0 10px}.demo-menu{bottom:calc(136px + env(safe-area-inset-bottom))}}
`;

function mount() {
    if (document.getElementById('demoBar')) return;
    const style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);
    const bar = document.createElement('div');
    bar.id = 'demoBar';
    bar.className = 'demo-bar';
    bar.setAttribute('role', 'region');
    bar.setAttribute('aria-label', 'Демо-будинок');
    bar.innerHTML = `<span class="demo-tag">Демо</span><b class="demo-hide">Ви:</b><b>${ROLES[role].label}</b>
        <button type="button" data-demo="menu" aria-expanded="false">Змінити роль ▾</button>`;
    const menu = document.createElement('div');
    menu.className = 'demo-menu';
    menu.hidden = true;
    menu.innerHTML = `<p>Демо-будинок з умовними даними. Дії працюють, але нічого не зберігають: після перезавантаження все як на початку.</p>
        ${Object.entries(ROLES).map(([k, r]) => `<a href="${r.page}" data-role="${k}" class="${k === role ? 'is-on' : ''}"><b>${r.label}</b><small>${r.hint}</small></a>`).join('')}
        <hr><button type="button" data-demo="reset"><b>Почати заново</b><small>повернути демо-будинок до початкового стану</small></button>
        <button type="button" data-demo="exit"><b>Вийти з демо</b><small>на сторінку застосунку</small></button>`;
    document.body.append(bar, menu);
    const toggle = open => { menu.hidden = !open; bar.querySelector('[data-demo="menu"]').setAttribute('aria-expanded', String(open)); };
    bar.addEventListener('click', e => { if (e.target.closest('[data-demo="menu"]')) toggle(menu.hidden); });
    menu.addEventListener('click', e => {
        const link = e.target.closest('[data-role]');
        if (link) { e.preventDefault(); setRole(link.dataset.role); location.href = link.getAttribute('href'); return; }
        const act = e.target.closest('[data-demo]')?.dataset.demo;
        if (act === 'reset') location.reload();
        if (act === 'exit') { exitDemo(); location.href = 'landing.html'; }
    });
    document.addEventListener('click', e => { if (!menu.hidden && !e.target.closest('.demo-menu, .demo-bar')) toggle(false); });
    document.addEventListener('keydown', e => { if (e.key === 'Escape') toggle(false); });
}
// Назва й адреса справжнього будинку зашиті в розмітку — у демо показуємо умовні.
const SWAP = [
    [/ОСББ «Успіх-25»/g, 'ОСББ «Демо»'], [/Успіх-25/g, 'Демо'],
    [/вулиця Інглезі, будинок 3\/3/g, 'вулиця Демонстраційна, будинок 1'], [/вул\. Інглезі,? (буд\. )?3\/3/g, 'вул. Демонстраційна, $11'],
    [/65101, м\. Одеса/g, '00000, м. Демо'], [/м\. Одеса/g, 'м. Демо'], [/ЄДРПОУ: 40562894/g, 'ЄДРПОУ: 00000000'],
];
const swapText = t => SWAP.reduce((v, [re, to]) => v.replace(re, to), t);
const NEEDLE = /Успіх-25|Інглезі|Одеса|40562894/;
function rebrand(root) {
    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) if (NEEDLE.test(n.nodeValue)) n.nodeValue = swapText(n.nodeValue);
}
function startRebrand() {
    document.title = swapText(document.title);
    rebrand(document.body);
    new MutationObserver(list => {
        for (const m of list) {
            if (m.type === 'characterData') { if (NEEDLE.test(m.target.nodeValue)) m.target.nodeValue = swapText(m.target.nodeValue); }
            else for (const n of m.addedNodes) if (n.nodeType === 3) { if (NEEDLE.test(n.nodeValue)) n.nodeValue = swapText(n.nodeValue); } else if (n.nodeType === 1) rebrand(n);
        }
    }).observe(document.body, { childList: true, subtree: true, characterData: true });
}
function init() { mount(); startRebrand(); }
if (document.body) init(); else document.addEventListener('DOMContentLoaded', init);
