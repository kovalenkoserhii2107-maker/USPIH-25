// Public page: local interactions only, no session or backend dependencies.
const dialog = document.getElementById('screenshotDialog');
const image = document.getElementById('screenshotImage');
const title = document.getElementById('screenshotTitle');
const original = document.getElementById('screenshotOriginal');
let imageOpener = null;

document.querySelectorAll('[data-screenshot]').forEach(link => {
    link.addEventListener('click', event => {
        if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey
            || typeof dialog?.showModal !== 'function') return;
        event.preventDefault();
        imageOpener = link;
        title.textContent = link.dataset.caption;
        image.alt = link.dataset.caption + ' — демонстраційні дані';
        image.src = link.href;
        original.href = link.href;
        dialog.showModal();
        dialog.querySelector('[data-close-dialog]').focus();
    });
});
dialog?.querySelector('[data-close-dialog]').addEventListener('click', () => dialog.close());
dialog?.addEventListener('click', event => {
    if (event.target !== dialog) return;
    const bounds = dialog.getBoundingClientRect();
    if (event.clientX < bounds.left || event.clientX > bounds.right
        || event.clientY < bounds.top || event.clientY > bounds.bottom) dialog.close();
});
dialog?.addEventListener('close', () => {
    image.removeAttribute('src');
    imageOpener?.focus({ preventScroll: true });
});

const screens = [...document.querySelectorAll('[data-gallery-role]')];
const filters = [...document.querySelectorAll('[data-filter]')];
document.querySelector('.gallery-filters').hidden = false;
filters.forEach(button => {
    button.addEventListener('click', () => {
        const filter = button.dataset.filter;
        filters.forEach(other => other.setAttribute('aria-pressed', String(other === button)));
        screens.forEach(screen => { screen.hidden = filter !== 'all' && screen.dataset.galleryRole !== filter; });
        document.getElementById('galleryStatus').textContent =
            'Показано екранів: ' + screens.filter(screen => !screen.hidden).length;
    });
});

document.querySelectorAll('[data-expand]').forEach(button => {
    button.hidden = false;
    const section = document.getElementById(button.dataset.expand);
    const features = [...section.querySelectorAll('.feature')];
    const update = () => {
        const expanded = features.every(feature => feature.open);
        button.setAttribute('aria-expanded', String(expanded));
        button.textContent = expanded ? 'Згорнути всі' : 'Розгорнути всі';
    };
    features.forEach(feature => feature.addEventListener('toggle', update));
    button.addEventListener('click', () => {
        const expand = !features.every(feature => feature.open);
        features.forEach(feature => { feature.open = expand; });
        update();
    });
    update();
});
