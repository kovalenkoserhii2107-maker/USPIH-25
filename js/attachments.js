// ============================================================
// Вкладення: визначення типу, показ, повноекранна галерея
// та переглядач документів. Використовується і в повідомленнях,
// і у зверненнях, і в картках співвласників.
// ============================================================
import { escapeHtml, formatFileSize } from './ui.js';

const IMAGE_EXT = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'heic', 'heif', 'bmp'];

export function getFileExt(name) {
    if (!name) return '';
    const clean = String(name).split('?')[0];
    const parts = clean.split('.');
    return parts.length > 1 ? parts.pop().toLowerCase() : '';
}

export function isImageFile(att) {
    if (!att) return false;
    if (att.type && att.type.startsWith('image/')) return true;
    return IMAGE_EXT.includes(getFileExt(att.name));
}

export function getDocKind(att) {
    const ext = getFileExt(att?.name);
    if (ext === 'pdf' || att?.type === 'application/pdf') return 'pdf';
    if (['doc', 'docx'].includes(ext)) return 'word';
    if (['xls', 'xlsx', 'csv'].includes(ext)) return 'excel';
    if (['ppt', 'pptx'].includes(ext)) return 'powerpoint';
    if (['zip', 'rar', '7z'].includes(ext)) return 'archive';
    return 'file';
}

/** Витягує людську назву файлу з URL у Firebase Storage. */
export function fileNameFromUrl(url, fallbackIndex = 0) {
    try {
        const decoded = decodeURIComponent(String(url).split('?')[0]);
        const raw = decoded.substring(decoded.lastIndexOf('/') + 1);
        const clean = raw.replace(/^\d+_/, '');
        if (clean) return clean;
    } catch (e) { /* ігноруємо */ }
    return `Документ ${fallbackIndex + 1}`;
}

export function docIconSvg(kind) {
    const page = '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline>';
    const icons = {
        pdf: `${page}<line x1="9" y1="15" x2="15" y2="15"></line><line x1="9" y1="11" x2="12" y2="11"></line>`,
        word: `${page}<line x1="8" y1="13" x2="10" y2="17"></line><line x1="10" y1="17" x2="12" y2="13"></line><line x1="12" y1="13" x2="14" y2="17"></line><line x1="14" y1="17" x2="16" y2="13"></line>`,
        excel: `${page}<line x1="9" y1="13" x2="15" y2="18"></line><line x1="15" y1="13" x2="9" y2="18"></line>`,
        powerpoint: `${page}<rect x="8" y="12" width="5" height="6" rx="1"></rect>`,
        archive: '<path d="M21 8v13H3V8"></path><path d="M1 3h22v5H1z"></path><line x1="10" y1="12" x2="14" y2="12"></line>',
        image: '<rect x="3" y="3" width="18" height="18" rx="2"></rect><circle cx="8.5" cy="8.5" r="1.5"></circle><polyline points="21 15 16 10 5 21"></polyline>',
        file: page
    };
    return `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${icons[kind] || icons.file}</svg>`;
}

/**
 * Малює вкладення: фото — сіткою мініатюр, документи — списком карток.
 * @param {HTMLElement} container
 * @param {Array} files [{name, url, type, size}]
 */
export function renderAttachments(container, files) {
    if (!container) return;
    container.innerHTML = '';
    if (!files || files.length === 0) {
        container.classList.remove('has-content');
        return;
    }
    container.classList.add('has-content');

    const images = files.filter(isImageFile);
    const docs = files.filter(f => !isImageFile(f));
    let html = '';

    if (images.length) {
        html += `<span class="attach-label">Фото · ${images.length}</span>`;
        html += '<div class="image-attach-grid">';
        images.forEach((img, idx) => {
            html += `<button type="button" class="image-attach-thumb" data-gallery-index="${idx}">
                        <img src="${escapeHtml(img.url)}" loading="lazy" alt="${escapeHtml(img.name)}">
                     </button>`;
        });
        html += '</div>';
    }

    if (docs.length) {
        html += `<span class="attach-label${images.length ? ' attach-label-gap' : ''}">Документи · ${docs.length}</span>`;
        html += '<div class="doc-attach-list">';
        docs.forEach((d, idx) => {
            const kind = getDocKind(d);
            html += `<button type="button" class="doc-attach-row" data-doc-index="${idx}">
                        <span class="file-icon icon-${kind}">${docIconSvg(kind)}</span>
                        <span class="doc-attach-info">
                            <span class="doc-attach-name">${escapeHtml(d.name || 'Документ')}</span>
                            <span class="doc-attach-meta">${formatFileSize(d.size)}</span>
                        </span>
                        <svg class="row-chevron" viewBox="0 0 24 24" width="18" height="18" stroke="currentColor" stroke-width="2" fill="none"><polyline points="9 18 15 12 9 6"></polyline></svg>
                     </button>`;
        });
        html += '</div>';
    }

    container.innerHTML = html;

    container.querySelectorAll('.image-attach-thumb').forEach(el => {
        el.addEventListener('click', () => openGallery(images, parseInt(el.dataset.galleryIndex, 10)));
    });
    container.querySelectorAll('.doc-attach-row').forEach(el => {
        el.addEventListener('click', () => openDocViewer(docs[parseInt(el.dataset.docIndex, 10)]));
    });
}

// ------------------------------------------------------------
// ПОВНОЕКРАННА ГАЛЕРЕЯ
// ------------------------------------------------------------
const gallery = { images: [], index: 0, startX: 0, currentX: 0, dragging: false };

export function openGallery(images, startIndex = 0) {
    if (!images || !images.length) return;
    gallery.images = images;
    gallery.index = startIndex || 0;

    const track = document.getElementById('galleryTrack');
    track.innerHTML = gallery.images
        .map(img => `<div class="gallery-slide"><img src="${escapeHtml(img.url)}" alt="${escapeHtml(img.name)}"></div>`)
        .join('');
    track.style.transition = 'none';
    track.style.transform = `translateX(-${gallery.index * 100}%)`;
    requestAnimationFrame(() => { track.style.transition = 'transform 0.3s ease'; });

    updateCounter();
    const multi = gallery.images.length > 1;
    document.getElementById('galleryPrevBtn').style.display = multi ? 'flex' : 'none';
    document.getElementById('galleryNextBtn').style.display = multi ? 'flex' : 'none';

    document.getElementById('imageGalleryModal').classList.add('is-open');
    document.body.classList.add('no-scroll');
}

function updateCounter() {
    const el = document.getElementById('galleryCounter');
    el.textContent = gallery.images.length > 1 ? `${gallery.index + 1} / ${gallery.images.length}` : '';
}

function applyTransform() {
    document.getElementById('galleryTrack').style.transform = `translateX(-${gallery.index * 100}%)`;
    updateCounter();
}

function goToSlide(newIndex) {
    const clamped = Math.max(0, Math.min(newIndex, gallery.images.length - 1));
    if (clamped !== gallery.index) {
        document.querySelectorAll('#galleryTrack img.zoomed').forEach(i => i.classList.remove('zoomed'));
    }
    gallery.index = clamped;
    document.getElementById('galleryTrack').style.transition = 'transform 0.3s ease';
    applyTransform();
}

function closeGallery() {
    document.getElementById('imageGalleryModal').classList.remove('is-open');
    document.getElementById('galleryTrack').innerHTML = '';
    document.body.classList.remove('no-scroll');
}

// ------------------------------------------------------------
// ПЕРЕГЛЯДАЧ ДОКУМЕНТІВ
// ------------------------------------------------------------
export function openDocViewer(docFile) {
    if (!docFile) return;
    const kind = getDocKind(docFile);
    document.getElementById('docViewerTitle').textContent = docFile.name || 'Документ';
    document.getElementById('docViewerOpenExternal').href = docFile.url;
    const body = document.getElementById('docViewerBody');

    if (['pdf', 'word', 'excel', 'powerpoint'].includes(kind)) {
        // Google Docs Viewer гортає всі сторінки як звичайну веб-сторінку.
        // Прямий iframe на PDF у багатьох мобільних webview показує лише першу.
        const viewerUrl = `https://docs.google.com/gview?url=${encodeURIComponent(docFile.url)}&embedded=true`;
        body.innerHTML = `<iframe src="${escapeHtml(viewerUrl)}" class="doc-viewer-iframe"></iframe>
            <p class="doc-viewer-note">Якщо файл не відкрився — натисніть стрілку вгорі, щоб відкрити його у відповідному застосунку.</p>`;
    } else {
        body.innerHTML = `<div class="doc-viewer-generic">
                <span class="file-icon icon-${kind} file-icon-lg">${docIconSvg(kind)}</span>
                <p>Перегляд цього типу файлів у застосунку недоступний.</p>
                <a href="${escapeHtml(docFile.url)}" target="_blank" class="btn-primary-inline">Відкрити файл</a>
            </div>`;
    }

    document.getElementById('docViewerModal').classList.add('is-open');
    document.body.classList.add('no-scroll');
}

function closeDocViewer() {
    document.getElementById('docViewerModal').classList.remove('is-open');
    document.getElementById('docViewerBody').innerHTML = '';
    document.body.classList.remove('no-scroll');
}

// ------------------------------------------------------------
// ІНІЦІАЛІЗАЦІЯ (викликається один раз при старті)
// ------------------------------------------------------------
export function initAttachmentViewers() {
    document.getElementById('galleryCloseBtn').addEventListener('click', closeGallery);
    document.getElementById('galleryPrevBtn').addEventListener('click', () => goToSlide(gallery.index - 1));
    document.getElementById('galleryNextBtn').addEventListener('click', () => goToSlide(gallery.index + 1));
    document.getElementById('imageGalleryModal').addEventListener('click', (e) => {
        if (e.target.id === 'imageGalleryModal') closeGallery();
    });
    document.getElementById('docViewerCloseBtn').addEventListener('click', closeDocViewer);

    const track = document.getElementById('galleryTrack');
    track.addEventListener('touchstart', (e) => {
        gallery.startX = e.touches[0].clientX;
        gallery.currentX = gallery.startX;
        gallery.dragging = true;
        track.style.transition = 'none';
    }, { passive: true });

    track.addEventListener('touchmove', (e) => {
        if (!gallery.dragging) return;
        gallery.currentX = e.touches[0].clientX;
        const delta = gallery.currentX - gallery.startX;
        track.style.transform = `translateX(calc(-${gallery.index * 100}% + ${delta}px))`;
    }, { passive: true });

    track.addEventListener('touchend', () => {
        gallery.dragging = false;
        const delta = gallery.currentX - gallery.startX;
        track.style.transition = 'transform 0.3s ease';
        if (Math.abs(delta) > 60) {
            goToSlide(delta < 0 ? gallery.index + 1 : gallery.index - 1);
        } else if (Math.abs(delta) < 10) {
            // Це був тап, а не свайп — перемикаємо зум
            const img = track.children[gallery.index]?.querySelector('img');
            if (img) img.classList.toggle('zoomed');
            applyTransform();
        } else {
            applyTransform();
        }
    });

    document.addEventListener('keydown', (e) => {
        if (!document.getElementById('imageGalleryModal').classList.contains('is-open')) return;
        if (e.key === 'ArrowLeft') goToSlide(gallery.index - 1);
        if (e.key === 'ArrowRight') goToSlide(gallery.index + 1);
        if (e.key === 'Escape') closeGallery();
    });
}

// ------------------------------------------------------------
// КЕРУВАННЯ СПИСКОМ ФАЙЛІВ У ФОРМАХ
// Показує і вже завантажені файли, і щойно обрані — обидва
// типи можна видалити до збереження.
// ------------------------------------------------------------

/**
 * @param {HTMLElement} holder контейнер для чіпів
 * @param {Array} existing вже завантажені [{name,url}]
 * @param {File[]} pending щойно обрані
 * @param {Function} onRemoveExisting (index) => void
 * @param {Function} onRemovePending (index) => void
 */
export function renderFileManager(holder, existing, pending, onRemoveExisting, onRemovePending) {
    if (!holder) return;
    holder.innerHTML = '';
    const total = (existing?.length || 0) + (pending?.length || 0);
    if (!total) { holder.classList.remove('has-content'); return; }
    holder.classList.add('has-content');

    (existing || []).forEach((f, idx) => {
        holder.appendChild(buildChip(f.name, '', isImageFile(f) ? 'image' : getDocKind(f),
            'Завантажено', () => onRemoveExisting(idx), f.url));
    });

    (pending || []).forEach((file, idx) => {
        const isImg = file.type && file.type.startsWith('image/');
        holder.appendChild(buildChip(file.name, formatFileSize(file.size),
            isImg ? 'image' : getDocKind({ name: file.name, type: file.type }),
            'Новий', () => onRemovePending(idx), null));
    });
}

function buildChip(name, size, kind, badge, onRemove, url) {
    const chip = document.createElement('div');
    chip.className = 'file-chip';
    chip.innerHTML = `
        <span class="file-icon icon-${kind} file-icon-sm">${docIconSvg(kind)}</span>
        <span class="file-chip-info">
            <span class="file-chip-name">${escapeHtml(name)}</span>
            <span class="file-chip-meta">${badge}${size ? ' · ' + size : ''}</span>
        </span>
        ${url ? '<button type="button" class="file-chip-btn file-chip-view" aria-label="Переглянути"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle></svg></button>' : ''}
        <button type="button" class="file-chip-btn file-chip-remove" aria-label="Видалити">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
        </button>`;
    chip.querySelector('.file-chip-remove').addEventListener('click', (e) => {
        e.preventDefault(); e.stopPropagation(); onRemove();
    });
    chip.querySelector('.file-chip-view')?.addEventListener('click', (e) => {
        e.preventDefault(); e.stopPropagation();
        const file = { name, url, type: '', size: 0 };
        if (isImageFile(file)) openGallery([file], 0); else openDocViewer(file);
    });
    return chip;
}
