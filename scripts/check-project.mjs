import { readFile, readdir, access } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const errors = [];
const read = path => readFile(join(root, path), 'utf8');

const [html, adminHtml, sw, firebaseJson, firestoreIndexesJson] = await Promise.all([
    read('index.html'), read('admin.html'), read('sw.js'), read('firebase.json'), read('firestore.indexes.json')
]);

const swVersion = sw.match(/const VERSION = '(\d+)'/)?.[1];
for (const [name, page] of [['index.html', html], ['admin.html', adminHtml]]) {
    const versions = [...page.matchAll(/(?:style(?:-chat|-admin)?\.css|js\/(?:app|admin-main|admin-preview)\.js)\?v=(\d+)/g)].map(m => m[1]);
    if (!swVersion || !versions.length || versions.some(version => version !== swVersion)) {
        errors.push(`Версії ${name} (${versions.join(', ')}) і sw.js (${swVersion || 'немає'}) не збігаються`);
    }
}

// Чат, редактор співвласників і вікна є на обох сторінках — копії мають збігатися.
function block(page, id) {
    const lines = page.split('\n');
    const start = lines.findIndex(line => new RegExp(`<(\\w+)\\b[^>]*\\bid="${id}"`).test(line));
    if (start < 0) return null;
    const tag = lines[start].match(new RegExp(`<(\\w+)\\b[^>]*\\bid="${id}"`))[1];
    let depth = 0;
    for (let i = start; i < lines.length; i++) {
        depth += (lines[i].match(new RegExp(`<${tag}\\b`, 'g')) || []).length - (lines[i].match(new RegExp(`</${tag}>`, 'g')) || []).length;
        if (depth <= 0) return lines.slice(start, i + 1).join('\n');
    }
    return null;
}
for (const id of ['navBackdrop', 'dtekPopup', 'schedulePopup', 'powerStatsPopup', 'chatSection', 'ownersEditSection',
    'msgModal', 'imageGalleryModal', 'docViewerModal']) {
    const resident = block(html, id), board = block(adminHtml, id);
    if (!resident || !board) errors.push(`Спільний блок #${id} відсутній у ${resident ? 'admin.html' : 'index.html'}`);
    else if (resident !== board) errors.push(`Спільний блок #${id} у index.html і admin.html розійшовся`);
}
if (/id="adminDashboardSection"/.test(html)) errors.push('Розмітка правління має бути лише в admin.html');

const config = JSON.parse(firebaseJson);
const firestoreIndexes = JSON.parse(firestoreIndexesJson);
for (const required of ['firestore.rules', 'firestore.indexes.json', 'storage.rules']) {
    try { await access(join(root, required)); }
    catch { errors.push(`Немає ${required}`); }
}
if (!config.firestore?.indexes || !config.storage?.rules) {
    errors.push('firebase.json не підключає індекси або Storage Rules');
}
const ownerChangesStatusIndex = firestoreIndexes.fieldOverrides?.some(field =>
    field.collectionGroup === 'owner_changes'
    && field.fieldPath === 'status'
    && field.indexes?.some(index => index.queryScope === 'COLLECTION_GROUP')
);
if (!ownerChangesStatusIndex) {
    errors.push('Немає collection-group індексу owner_changes.status для зведення правління');
}

const jsFiles = (await readdir(join(root, 'js'))).filter(name => name.endsWith('.js'));
for (const name of jsFiles) {
    const source = await read(`js/${name}`);
    for (const match of source.matchAll(/(?:import|from)\s*(?:\(|)\s*['"](\.\.?\/[^'"]+)['"]/g)) {
        const target = resolve(root, 'js', match[1]);
        try { await access(target); }
        catch { errors.push(`js/${name}: відсутній імпорт ${match[1]}`); }
    }
}

if (!sw.includes("'./js/backend.js'")) errors.push('backend.js не додано до оболонки Service Worker');

if (errors.length) {
    console.error(errors.map(error => `- ${error}`).join('\n'));
    process.exit(1);
}
console.log(`Перевірено ${jsFiles.length} JS-модулів, Firebase-конфіг і PWA-версію ${swVersion}.`);
