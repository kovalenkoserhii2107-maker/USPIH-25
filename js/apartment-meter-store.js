import { db, currentApt } from './firebase.js';
import * as firestore from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js';
import { apartmentMeterId, synchronizedApartmentChanges } from './apartment-meter-core.js';

export function createApartmentMeterStore(database, apartmentOfCurrentUser, api = firestore) {
    const { doc, collection, query, where, getDocFromServer, getDocsFromServer, runTransaction, serverTimestamp } = api;
    const identity = () => {
        const apt = String(apartmentOfCurrentUser() || '');
        if (!apt || apt.includes('/')) throw new Error('Увійдіть у свою квартиру');
        return apt;
    };
    async function load() {
        const apt = identity();
        const state = await getDocFromServer(doc(database, 'apartments', apt, 'meter_state', 'current'));
        const snap = await getDocsFromServer(query(collection(database, 'apartment_meter_readings'), where('apt', '==', apt)));
        return { apt, revision: state.data()?.revision || 0, records: snap.docs.map(row => ({ ...row.data(), id: row.id })) };
    }
    async function save(context, changes) {
        const apt = identity();
        if (context.apt !== apt) throw new Error('Квартира змінилася. Оновіть форму показників');
        const clean = synchronizedApartmentChanges(context.records, changes);
        if (!clean.length) throw new Error('Введіть нові показники');
        const stateRef = doc(database, 'apartments', apt, 'meter_state', 'current');
        await runTransaction(database, async tx => {
            const state = await tx.get(stateRef);
            if ((state.data()?.revision || 0) !== context.revision) throw new Error('Показники вже оновилися. Натисніть «Оновити» і перевірте введене');
            const refs = clean.map(row => doc(database, 'apartment_meter_readings', apartmentMeterId(apt, row.resource, row.period)));
            const before = await Promise.all(refs.map(ref => tx.get(ref)));
            clean.forEach((row, index) => tx.set(refs[index], { ...row, apt, revision: context.revision + 1,
                createdAt: before[index].data()?.createdAt || serverTimestamp(), updatedAt: serverTimestamp(), updatedBy: apt }));
            tx.set(stateRef, { revision: context.revision + 1, updatedAt: serverTimestamp() });
        });
        return load();
    }
    async function submissions(period) {
        const snap = await getDocsFromServer(query(collection(database, 'apartment_meter_readings'), where('period', '==', period)));
        return snap.docs.map(row => ({ ...row.data(), id: row.id }));
    }
    return { load, save, submissions };
}
export const apartmentMeterStore = createApartmentMeterStore(db, currentApt);
