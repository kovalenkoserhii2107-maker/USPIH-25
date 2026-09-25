import { readFile, readdir, access } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const errors = [];
const read = path => readFile(join(root, path), 'utf8');

const [html, sw, firebaseJson, firestoreIndexesJson] = await Promise.all([
    read('index.html'), read('sw.js'), read('firebase.json'), read('firestore.indexes.json')
]);

const htmlVersions = [...html.matchAll(/(?:style(?:-chat)?\.css|js\/(?:app|admin-preview)\.js)\?v=(\d+)/g)].map(m => m[1]);
const swVersion = sw.match(/const VERSION = '(\d+)'/)?.[1];
if (!swVersion || htmlVersions.some(version => version !== swVersion)) {
    errors.push(`Версії index.html (${htmlVersions.join(', ')}) і sw.js (${swVersion || 'немає'}) не збігаються`);
}

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
