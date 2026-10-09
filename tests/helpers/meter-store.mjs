import { readFile } from 'node:fs/promises';
const source = (await readFile(new URL('../../js/meter-store.js', import.meta.url), 'utf8'))
    .replace("import { db, currentApt } from './firebase.js';", '')
    .replace('./staff-core.js', new URL('../../js/staff-core.js', import.meta.url).href)
    .replace('https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js', import.meta.resolve('firebase/firestore'))
    .replace('./meter-core.js', new URL('../../js/meter-core.js', import.meta.url).href)
    .replace('export const meterStore = createMeterStore(db, currentApt);', '');
export const { createMeterStore } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
