import { db, currentApt } from './firebase.js';
import * as firestore from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js';
import { METER_KIND, meterRecordId, validateMeterChanges } from './meter-core.js';

// status уже доступний мешканцям для читання і лише правлінню для запису.
// Окремий документ на ресурс і місяць не обмежує розмір усієї історії.
export function createMeterStore(database, apartmentOfCurrentUser, api = firestore) {
    const { doc, collection, query, where, getDocFromServer, getDocsFromServer,
        runTransaction, serverTimestamp } = api;
    const stateRef = doc(database, 'status', 'house_meter_state');

    async function load() {
        // Версію читаємо до історії: якщо під час читання хтось збереже
        // дані, транзакція відхилить застарілу форму.
        const state = await getDocFromServer(stateRef);
        const snap = await getDocsFromServer(query(collection(database, 'status'), where('kind', '==', METER_KIND)));
        return { revision: state.data()?.revision || 0,
            records: snap.docs.map(row => ({ ...row.data(), id: row.id })) };
    }

    async function save(context, changes) {
        const apt = apartmentOfCurrentUser();
        if (!apt) throw new Error('Увійдіть у застосунок');
        const admin = await getDocFromServer(doc(database, 'apartments', apt));
        if (!admin.exists() || admin.data().isAdmin !== true) throw new Error('Вносити показники може лише правління');
        const clean = validateMeterChanges(context.records, changes);
        if (!clean.length) throw new Error('Введіть показники хоча б одного ресурсу');
        await runTransaction(database, async tx => {
            const state = await tx.get(stateRef);
            if ((state.data()?.revision || 0) !== context.revision) {
                throw new Error('Показники оновилися в іншій вкладці. Натисніть «Оновити» і перевірте введене.');
            }
            const refs = clean.map(row => doc(database, 'status', meterRecordId(row.resource, row.period)));
            const snapshots = await Promise.all(refs.map(ref => tx.get(ref)));
            clean.forEach((row, index) => tx.set(refs[index], { ...row,
                createdAt: snapshots[index].data()?.createdAt || serverTimestamp(),
                updatedAt: serverTimestamp(), updatedBy: apt }));
            tx.set(stateRef, { kind: 'houseMeterState', revision: context.revision + 1,
                updatedAt: serverTimestamp() });
        });
        return load();
    }
    return { load, save };
}

export const meterStore = createMeterStore(db, currentApt);
