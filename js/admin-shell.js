// ============================================================
// Каркас панели правління: заголовок розділу, нижня панель вкладок
// і аркуш «Ще» на телефоні, підрозділи всередині розділів.
// Бічне меню (.admin-tab) — єдине джерело правди: решту навігації
// збираємо з його кнопок, а перехід завжди йде його кліком, тож
// завантаження вкладок і права ролі живуть в одному місці.
// ============================================================
import { openSheet, closeAllSheets } from './ui.js';

/** Заголовок і пояснення в шапці для кожного розділу. */
export const TAB_META = {
    overview: ['Головна', 'Стан будинку й справи на сьогодні'],
    directory: ['Власники', 'Квартири, власники та заявки на зміну даних'],
    requests: ['Звернення', 'Питання й заявки мешканців'],
    chat: ['Чат', 'Спільний чат будинку'],
    meetings: ['Збори й протоколи', 'Підготовка, голосування та протоколи'],
    polls: ['Опитування', 'Швидкі опитування мешканців'],
    send: ['Оголошення', 'Повідомлення мешканцям у застосунку'],
    docs: ['Документи', 'База документів для мешканців'],
    board: ['Контакти', 'Правління й служби — їх бачать усі мешканці'],
    finance: ['Фінанси', 'Баланси, нарахування, квитанції та звіт'],
    buh: ['Бухгалтерія', 'Банк, вхідні рішення й звітність'],
    meters: ['Лічильники', 'Загальнобудинковий облік ресурсів'],
    team: ['Команда', 'Хто працює в панелі й з якими правами'],
    journal: ['Журнал дій', 'Хто, коли й що змінив']
};

// Чотири вкладки внизу — те, з чим роль працює щодня. Решта в «Ще».
const PRIMARY = {
    accountant: ['overview', 'finance', 'meters', 'requests'],
    default: ['overview', 'requests', 'directory', 'meetings']
};
const SHORT = { meetings: 'Збори' };
// Колір плитки в «Ще» — за групою, як у меню мешканця.
const GROUP_COLORS = ['mi-blue', 'mi-green', 'mi-indigo', 'mi-orange', 'mi-teal', 'mi-grey'];
const MORE_ICON = '<svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor"><circle cx="5" cy="12" r="2"></circle><circle cx="12" cy="12" r="2"></circle><circle cx="19" cy="12" r="2"></circle></svg>';

const sideTab = name => document.querySelector(`.admin-tab[data-tab="${name}"]`);
const tabLabel = tab => tab.querySelector('span:not(.admin-tab-badge)')?.firstChild?.textContent.trim() || '';
const badgeOf = tab => tab.querySelector('.admin-tab-badge');
const badgeCount = badge => (badge && badge.style.display !== 'none' && parseInt(badge.textContent, 10)) || 0;

let primary = [];
let mirrors = [];          // [{ source, copy }] — значки, які повторюють бічне меню

/** Пункт нижньої панелі або плитка «Ще» з тим самим значком, що в меню. */
function navItem(tab, className, labelClass) {
    const name = tab.dataset.tab;
    const item = document.createElement('button');
    item.type = 'button';
    item.className = className;
    item.dataset.nav = name;
    const icon = tab.querySelector('svg').cloneNode(true);
    const label = document.createElement('span');
    label.className = labelClass;
    label.textContent = className === 'admin-tabbar-item' ? (SHORT[name] || tabLabel(tab)) : tabLabel(tab);
    const source = badgeOf(tab);
    const badge = document.createElement('span');
    badge.className = 'menu-badge';
    badge.style.display = 'none';
    if (source) mirrors.push({ source, copy: badge });
    return { item, icon, label, badge };
}

function syncBadges() {
    for (const { source, copy } of mirrors) {
        const count = badgeCount(source);
        copy.textContent = source.textContent;
        copy.style.display = count ? 'flex' : 'none';
    }
    // «Ще» показує крапку, коли щось нове лежить у розділі поза панеллю.
    const hidden = [...document.querySelectorAll('.admin-tab')]
        .filter(tab => !tab.hidden && !primary.includes(tab.dataset.tab))
        .reduce((sum, tab) => sum + badgeCount(badgeOf(tab)), 0);
    const dot = document.getElementById('adminMoreDot');
    if (dot) dot.hidden = !hidden;
}

/**
 * Будує навігацію під роль: ховає порожні групи меню, складає нижню
 * панель і плитки «Ще». Викликати після того, як вкладкам без прав
 * поставлено hidden.
 */
export function buildShell(role) {
    mirrors = [];
    document.querySelectorAll('.admin-nav-group').forEach(group => {
        group.hidden = ![...group.querySelectorAll('.admin-tab')].some(tab => !tab.hidden);
    });
    const allowed = name => sideTab(name) && !sideTab(name).hidden;
    primary = (PRIMARY[role] || PRIMARY.default).filter(allowed);

    const bar = document.getElementById('adminTabbar');
    if (bar) {
        bar.replaceChildren();
        for (const name of primary) {
            const { item, icon, label, badge } = navItem(sideTab(name), 'admin-tabbar-item', 'admin-tabbar-label');
            const art = document.createElement('span');
            art.className = 'admin-tabbar-icon';
            art.append(icon, badge);
            item.append(art, label);
            bar.append(item);
        }
        const more = document.createElement('button');
        more.type = 'button';
        more.className = 'admin-tabbar-item';
        more.dataset.nav = 'more';
        more.innerHTML = `<span class="admin-tabbar-icon">${MORE_ICON}<span class="admin-tabbar-dot" id="adminMoreDot" hidden></span></span><span class="admin-tabbar-label">Ще</span>`;
        bar.append(more);
    }

    const host = document.getElementById('adminMoreGroups');
    if (host) {
        // У «Ще» — лише те, чого немає на панелі внизу, як в iOS. Одна
        // сітка, як меню мешканця; колір плитки підказує групу.
        const grid = document.createElement('div');
        grid.className = 'menu-grid';
        document.querySelectorAll('.admin-nav-group').forEach((group, index) => {
            group.querySelectorAll('.admin-tab').forEach(tab => {
                if (tab.hidden || primary.includes(tab.dataset.tab)) return;
                const { item, icon, label, badge } = navItem(tab, 'menu-tile', 'menu-tile-label');
                const art = document.createElement('span');
                art.className = 'menu-tile-art';
                const tile = document.createElement('span');
                tile.className = `menu-tile-icon ${GROUP_COLORS[index % GROUP_COLORS.length]}`;
                tile.append(icon);
                art.append(tile, badge);
                item.append(art, label);
                grid.append(item);
            });
        });
        host.replaceChildren(grid);
    }
    syncBadges();
}

/** Позначає активний розділ у всій навігації й міняє заголовок шапки. */
export function markActive(name) {
    document.querySelectorAll('.admin-tab').forEach(tab => tab.classList.toggle('active', tab.dataset.tab === name));
    document.querySelectorAll('.admin-panel').forEach(panel => panel.classList.toggle('active', panel.dataset.panel === name));
    const inBar = primary.includes(name);
    document.querySelectorAll('[data-nav]').forEach(item => {
        const active = item.dataset.nav === name || (item.dataset.nav === 'more' && !inBar);
        item.classList.toggle('active', active);
        if (item.classList.contains('admin-tabbar-item')) item.setAttribute('aria-current', active ? 'page' : 'false');
    });
    const [title, subtitle] = TAB_META[name] || TAB_META.overview;
    document.getElementById('adminTitle').textContent = title;
    document.getElementById('adminSubtitle').textContent = subtitle;
    document.title = `${title} — Панель правління`;
}

/** Ім'я, роль і дії облікового запису — у шапці й у «Ще». */
export function renderAccount({ name, role, home }) {
    const initial = name.trim().charAt(0).toUpperCase() || 'П';
    for (const [id, text] of [['adminAccountName', name], ['adminMoreName', name], ['adminAccountRole', role],
        ['adminMoreRole', role], ['adminAvatar', initial], ['adminMoreAvatar', initial]]) {
        const el = document.getElementById(id);
        if (el) el.textContent = text;
    }
    for (const id of ['adminHomeBtn', 'adminMoreHomeBtn']) {
        const el = document.getElementById(id);
        if (el) el.hidden = !home;
    }
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
        // На телефоні аватар у шапці відкриває «Ще»: там і вихід,
        // і перехід до власного кабінету.
        if (event.target.closest('#adminAccountBtn') && window.matchMedia('(max-width: 959px)').matches) {
            openSheet('adminMoreSheet');
        }
    });
    document.querySelectorAll('.admin-tab-badge').forEach(badge => {
        new MutationObserver(syncBadges).observe(badge, { attributes: true, childList: true, characterData: true, subtree: true });
    });
}
