// ============================================================
// Каркас панелі правління — як у бухгалтерії: розділи-«пігулки» вгорі,
// меню профілю під аватаром, на телефоні — плаваюча нижня панель і
// «Ще»; підрозділи всередині розділів.
// Перелік розділів (.admin-tab, на екрані прихований) — єдине джерело
// правди: решту навігації збираємо з його кнопок, а перехід завжди йде
// його кліком, тож завантаження вкладок і права ролі живуть в одному місці.
// ============================================================
import { openSheet, closeAllSheets } from './ui.js';

/** Заголовок і пояснення в шапці для кожного розділу. */
export const TAB_META = {
    overview: ['Сьогодні', 'Що чекає вашого рішення'],
    directory: ['Власники', 'Квартири, власники та заявки на зміну даних'],
    requests: ['Звернення', 'Питання й заявки мешканців'],
    chat: ['Чат', 'Спільний чат будинку'],
    meetings: ['Збори й протоколи', 'Підготовка, голосування та протоколи'],
    polls: ['Опитування', 'Швидкі опитування мешканців'],
    send: ['Оголошення', 'Повідомлення мешканцям у застосунку'],
    docs: ['Документи', 'База документів для мешканців'],
    board: ['Контакти', 'Правління й служби — їх бачать усі мешканці'],
    finance: ['Фінанси: попередні розділи', 'Баланси, квитанції й звіт — старий вигляд'],
    buh: ['Бухгалтерія', 'Гроші ОСББ: банк, платежі на підпис, документи, звіти'],
    meters: ['Лічильники', 'Загальнобудинковий облік ресурсів'],
    team: ['Команда', 'Хто працює в панелі й з якими правами'],
    journal: ['Журнал дій', 'Хто, коли й що змінив']
};

// Як у бухгалтерії: щоденні розділи — «пігулками» вгорі (на телефоні —
// чотири з них на нижній панелі), решта — у меню профілю під аватаром.
// Гроші — один вхід: «Бухгалтерія»; старі «Фінанси» — у меню як попередні розділи.
const TOP = {
    accountant: ['overview', 'buh', 'meters', 'requests', 'directory', 'docs'],
    default: ['overview', 'directory', 'requests', 'chat', 'meetings', 'polls', 'send', 'buh']
};
const PRIMARY = {
    accountant: ['overview', 'buh', 'meters', 'requests'],
    default: ['overview', 'requests', 'directory', 'meetings']
};
const SHORT = { meetings: 'Збори' };
const MORE_ICON = '<svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="2"></circle><circle cx="12" cy="12" r="2"></circle><circle cx="19" cy="12" r="2"></circle></svg>';

const sideTab = name => document.querySelector(`.admin-tab[data-tab="${name}"]`);
const tabLabel = tab => tab.querySelector('span:not(.admin-tab-badge)')?.firstChild?.textContent.trim() || '';
const badgeOf = tab => tab.querySelector('.admin-tab-badge');
const badgeCount = badge => (badge && badge.style.display !== 'none' && parseInt(badge.textContent, 10)) || 0;
const el = (tag, className, html = '') => Object.assign(document.createElement(tag), { className, innerHTML: html });

let top = [];
let primary = [];
let mirrors = [];          // [{ source, copy }] — значки, які повторюють перелік розділів

/** Значок кількості, що повторює значок розділу в переліку. */
function mirror(tab, className) {
    const badge = el('span', className);
    badge.hidden = true;
    const source = badgeOf(tab);
    if (source) mirrors.push({ source, copy: badge });
    return badge;
}
const iconOf = tab => {
    const svg = tab.querySelector('svg').cloneNode(true);
    svg.setAttribute('width', '22');
    svg.setAttribute('height', '22');
    svg.setAttribute('aria-hidden', 'true');
    return svg;
};

function syncBadges() {
    for (const { source, copy } of mirrors) {
        const count = badgeCount(source);
        copy.textContent = source.textContent;
        copy.hidden = !count;
    }
    // «Ще» показує крапку, коли щось нове лежить у розділі поза нижньою панеллю.
    const hidden = [...document.querySelectorAll('.admin-tab')]
        .filter(tab => !tab.hidden && !primary.includes(tab.dataset.tab))
        .reduce((sum, tab) => sum + badgeCount(badgeOf(tab)), 0);
    const dot = document.getElementById('adminMoreDot');
    if (dot) dot.hidden = !hidden;
}

/**
 * Будує навігацію під роль: «пігулки» вгорі, нижню панель на телефоні й
 * меню профілю. Викликати після того, як вкладкам без прав поставлено hidden.
 */
export function buildShell(role) {
    mirrors = [];
    const allowed = name => sideTab(name) && !sideTab(name).hidden;
    top = (TOP[role] || TOP.default).filter(allowed);
    primary = (PRIMARY[role] || PRIMARY.default).filter(allowed);

    const nav = document.getElementById('adminTopNav');
    if (nav) {
        nav.replaceChildren(...top.map(name => {
            const tab = sideTab(name);
            const item = el('button', 'buh-nav-item');
            item.type = 'button';
            item.dataset.nav = name;
            item.append(el('span', '', SHORT[name] || tabLabel(tab)), mirror(tab, 'buh-badge'));
            return item;
        }));
    }

    const bar = document.getElementById('adminTabbar');
    if (bar) {
        bar.replaceChildren(...primary.map(name => {
            const tab = sideTab(name);
            const item = el('button', 'buh-tab');
            item.type = 'button';
            item.dataset.nav = name;
            const art = el('span', 'buh-tab-icon');
            art.append(iconOf(tab), mirror(tab, 'buh-badge'));
            item.append(art, el('span', '', SHORT[name] || tabLabel(tab)));
            return item;
        }));
        const more = el('button', 'buh-tab', `<span class="buh-tab-icon">${MORE_ICON}<span class="admin-tabbar-dot" id="adminMoreDot" hidden></span></span><span>Ще</span>`);
        more.type = 'button';
        more.dataset.nav = 'more';
        bar.append(more);
    }

    const host = document.getElementById('adminMoreGroups');
    if (host) {
        const parts = [];
        // Плитки — лише на телефоні: розділи з «пігулок», яких немає на нижній панелі.
        const tiles = el('nav', 'mn-tiles');
        tiles.setAttribute('aria-label', 'Розділи');
        for (const name of top.filter(n => !primary.includes(n))) {
            const tab = sideTab(name);
            const tile = el('button', 'mn-tile');
            tile.type = 'button';
            tile.dataset.nav = name;
            const ico = el('span', 'mn-ico');
            ico.append(iconOf(tab));
            tile.append(ico, el('b', '', tabLabel(tab)), el('small', '', TAB_META[name]?.[1] || ''));
            tiles.append(tile);
        }
        if (tiles.children.length) parts.push(tiles);
        // Решта — рядками за групами переліку (Мешканці, Рішення, Облік…).
        document.querySelectorAll('.admin-nav-group').forEach(group => {
            const rows = [...group.querySelectorAll('.admin-tab')].filter(tab => !tab.hidden && !top.includes(tab.dataset.tab));
            if (!rows.length) return;
            const title = group.querySelector('.admin-nav-label')?.textContent.trim() || 'Розділи';
            const list = el('nav', 'mn-group');
            list.setAttribute('aria-label', title);
            for (const tab of rows) {
                const name = tab.dataset.tab;
                const row = el('button', 'mn-row');
                row.type = 'button';
                row.dataset.nav = name;
                const ico = el('span', 'mn-ico');
                ico.append(iconOf(tab));
                const copy = el('span', 'mn-copy');
                copy.append(el('b', '', tabLabel(tab)), el('small', '', TAB_META[name]?.[1] || ''));
                row.append(ico, copy, mirror(tab, 'mn-badge'), el('span', 'mn-chev', '›'));
                list.append(row);
            }
            parts.push(el('h5', 'mn-h', title), list);
        });
        host.replaceChildren(...parts);
    }
    syncBadges();
}

/** Привітання за часом доби — як «Сьогодні» в бухгалтерії. */
function greeting(now = new Date()) {
    const h = now.getHours();
    return h < 5 ? 'Доброї ночі' : h < 12 ? 'Доброго ранку' : h < 18 ? 'Доброго дня' : 'Доброго вечора';
}

/** Позначає активний розділ у всій навігації й міняє заголовок. */
export function markActive(name) {
    document.querySelectorAll('.admin-tab').forEach(tab => tab.classList.toggle('active', tab.dataset.tab === name));
    document.querySelectorAll('.admin-panel').forEach(panel => panel.classList.toggle('active', panel.dataset.panel === name));
    const inBar = primary.includes(name);
    document.querySelectorAll('[data-nav]').forEach(item => {
        if (item.classList.contains('buh-brand')) return;
        const active = item.dataset.nav === name || (item.dataset.nav === 'more' && !inBar);
        item.classList.toggle('active', active);
        if (item.classList.contains('buh-tab') || item.classList.contains('buh-nav-item')) item.setAttribute('aria-current', active ? 'page' : 'false');
    });
    // Розділ із меню (не з «пігулок») — підсвічуємо кнопку «Меню», як у бухгалтерії.
    document.getElementById('adminAccountBtn')?.classList.toggle('active', Boolean(top.length) && !top.includes(name));
    const [title, subtitle] = TAB_META[name] || TAB_META.overview;
    const today = name === 'overview';
    document.getElementById('adminTitle').textContent = today ? greeting() : title;
    document.getElementById('adminSubtitle').textContent = today
        ? new Date().toLocaleDateString('uk-UA', { weekday: 'long', day: 'numeric', month: 'long' })
        : subtitle;
    document.title = `${title} — Панель правління`;
}

/** Ім'я, роль і дії облікового запису — на аватарі й у меню профілю. */
export function renderAccount({ name, role, home }) {
    const initial = name.trim().charAt(0).toUpperCase() || 'П';
    for (const [id, text] of [['adminMoreName', name], ['adminMoreRole', role], ['adminAvatar', initial], ['adminMoreAvatar', initial]]) {
        const node = document.getElementById(id);
        if (node) node.textContent = text;
    }
    const btn = document.getElementById('adminMoreHomeBtn');
    if (btn) btn.hidden = !home;
    const links = document.getElementById('adminMoreLinks');
    if (links) links.hidden = !home;
}

// ------------------------------------------------------------
// ПІДРОЗДІЛИ
// Розділ із кількох незалежних робіт (баланси, квитанції, звіт…)
// показує одну за раз, а перемикач угорі видно відразу — замість
// стопки згорнутих карток, де кожну треба відкрити, щоб зрозуміти,
// що в ній.
// ------------------------------------------------------------
const SECTION_KEY = 'admin_section_';
const remembered = panel => { try { return localStorage.getItem(SECTION_KEY + panel); } catch { return null; } };
const remember = (panel, label) => { try { localStorage.setItem(SECTION_KEY + panel, label); } catch { /* приватний режим */ } };

function showSection(panel, label) {
    panel.querySelectorAll(':scope > [data-section]').forEach(card => {
        card.classList.toggle('section-hidden', card.dataset.section !== label);
    });
    panel.querySelectorAll(':scope > .admin-subnav [data-section-tab]').forEach(tab => {
        const active = tab.dataset.sectionTab === label;
        tab.classList.toggle('active', active);
        tab.setAttribute('aria-selected', active ? 'true' : 'false');
        tab.tabIndex = active ? 0 : -1;
        if (active) tab.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
    });
}

function countOf(selector) {
    const el = document.querySelector(selector);
    return parseInt((el?.textContent || '').replace(/\D+/g, ''), 10) || 0;
}

export function initSections() {
    // Робочий блок розділу не згортається: він і так один на екрані.
    document.querySelectorAll('.admin-panel > .admin-fold').forEach(card => {
        card.classList.add('open', 'is-section');
        const toggle = card.querySelector(':scope > .admin-card-head .admin-card-toggle');
        toggle?.setAttribute('aria-expanded', 'true');
        toggle?.setAttribute('tabindex', '-1');
    });

    document.querySelectorAll('.admin-panel').forEach(panel => {
        const cards = [...panel.querySelectorAll(':scope > [data-section]')];
        const labels = [...new Set(cards.map(card => card.dataset.section))];
        if (labels.length < 2) return;
        const nav = document.createElement('div');
        nav.className = 'admin-subnav';
        nav.setAttribute('role', 'tablist');
        nav.setAttribute('aria-label', 'Підрозділи');
        for (const label of labels) {
            const tab = document.createElement('button');
            tab.type = 'button';
            tab.className = 'admin-subnav-item';
            tab.setAttribute('role', 'tab');
            tab.dataset.sectionTab = label;
            tab.textContent = label;
            const counter = cards.find(card => card.dataset.section === label && card.dataset.sectionCount)?.dataset.sectionCount;
            if (counter) {
                const badge = document.createElement('span');
                badge.className = 'admin-subnav-count';
                badge.hidden = true;
                tab.append(badge);
                const source = document.querySelector(counter);
                const sync = () => { const n = countOf(counter); badge.textContent = n; badge.hidden = !n; };
                if (source) new MutationObserver(sync).observe(source, { childList: true, characterData: true, subtree: true });
                sync();
            }
            nav.append(tab);
        }
        panel.insertBefore(nav, cards[0]);
        // Підрозділів більше, ніж влазить на телефоні, — край згасає,
        // щоб було видно: стрічку можна прогорнути.
        const fade = () => {
            nav.classList.toggle('fade-start', nav.scrollLeft > 2);
            nav.classList.toggle('fade-end', nav.scrollLeft + nav.clientWidth < nav.scrollWidth - 2);
        };
        nav.addEventListener('scroll', fade, { passive: true });
        if (typeof ResizeObserver === 'function') new ResizeObserver(fade).observe(nav);
        nav.addEventListener('click', event => {
            const tab = event.target.closest('[data-section-tab]');
            if (!tab) return;
            showSection(panel, tab.dataset.sectionTab);
            remember(panel.dataset.panel, tab.dataset.sectionTab);
        });
        nav.addEventListener('keydown', event => {
            const keys = { ArrowLeft: -1, ArrowRight: 1 };
            if (!(event.key in keys)) return;
            const tabs = [...nav.querySelectorAll('[data-section-tab]')];
            const next = tabs[(tabs.indexOf(document.activeElement) + keys[event.key] + tabs.length) % tabs.length];
            event.preventDefault();
            next.click();
            next.focus();
        });
        const saved = remembered(panel.dataset.panel);
        showSection(panel, labels.includes(saved) ? saved : (panel.dataset.sectionDefault || labels[0]));
    });
}

/** Відкриває підрозділ, у якому лежить елемент (для переходів з головної). */
export function revealSection(element) {
    const card = element?.closest('[data-section]');
    const panel = card?.parentElement;
    if (card && panel?.classList.contains('admin-panel')) showSection(panel, card.dataset.section);
}

// ------------------------------------------------------------
// ПОДІЇ
// ------------------------------------------------------------
export function initShell() {
    document.addEventListener('click', event => {
        const item = event.target.closest('[data-nav]');
        if (item) {
            if (item.dataset.nav === 'more') { openSheet('adminMoreSheet'); return; }
            closeAllSheets();
            sideTab(item.dataset.nav)?.click();
            return;
        }
        // Аватар відкриває меню профілю: обліковий запис, вихід, решта розділів.
        if (event.target.closest('#adminAccountBtn')) openSheet('adminMoreSheet');
    });
    document.querySelectorAll('.admin-tab-badge').forEach(badge => {
        new MutationObserver(syncBadges).observe(badge, { attributes: true, childList: true, characterData: true, subtree: true });
    });
}
