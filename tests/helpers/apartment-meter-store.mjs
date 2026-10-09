import { readFile } from 'node:fs/promises';
const source = (await readFile(new URL('../../js/apartment-meter-store.js', import.meta.url), 'utf8'))
    .replace("import { db, currentApt } from './firebase.js';", '')
    .replace('https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js', import.meta.resolve('firebase/firestore'))
    .replace('./apartment-meter-core.js', new URL('../../js/apartment-meter-core.js', import.meta.url).href)
    .replace('export const apartmentMeterStore = createApartmentMeterStore(db, currentApt);', '');
export const { createApartmentMeterStore } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
