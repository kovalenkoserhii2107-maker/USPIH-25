import { db, currentApt } from './firebase.js';
import * as firestore from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js';
import { METER_KIND, HEAT_TARIFF_KIND, normalizeHeatTariff, meterRecordId, validateMeterChanges, buildingTotalArea, integerReading } from './meter-core.js';

// status уже доступний мешканцям для читання і лише правлінню для запису.
// Окремий документ на ресурс і місяць не обмежує розмір усієї історії.
export function createMeterStore(database, apartmentOfCurrentUser, api = firestore) {
    const { doc, collection, query, where, getDocFromServer, getDocsFromServer,
        runTransaction, serverTimestamp, setDoc } = api;
    const stateRef = doc(database, 'status', 'house_meter_state');

    async function load() {
        // Версію читаємо до історії: якщо під час читання хтось збереже
        // дані, транзакція відхилить застарілу форму.
        const state = await getDocFromServer(stateRef);
        const snap = await getDocsFromServer(query(collection(database, 'status'), where('kind', 'in', [METER_KIND, HEAT_TARIFF_KIND])));
        const rows = snap.docs.map(row => ({ ...row.data(), id: row.id }));
        return { revision: state.data()?.revision || 0, totalArea: state.data()?.totalArea ?? null,
            records: rows.filter(row => row.kind === METER_KIND),
            heatTariffs: rows.filter(row => row.kind === HEAT_TARIFF_KIND) };
    }

    async function save(context, changes) {
        const apt = apartmentOfCurrentUser();
        if (!apt) throw new Error('Увійдіть у застосунок');
        const admin = await getDocFromServer(doc(database, 'apartments', apt));
        if (!admin.exists() || admin.data().isAdmin !== true) throw new Error('Вносити показники може лише правління');
        const clean = validateMeterChanges(context.records, changes);
        if (!clean.length) throw new Error('Введіть показники хоча б одного ресурсу');
        if (clean.some(row => integerReading(row.reading) === null)) throw new Error('Новий показник вводиться лише цілим числом');
        const apartments = await getDocsFromServer(collection(database, 'apartments'));
        const totalArea = buildingTotalArea(apartments.docs.map(row => ({ ...row.data(), apt: row.id })));
        clean.forEach(row => {
            if (row.resource !== 'heat') return;
            delete row.totalArea;
            if (totalArea) row.totalArea = totalArea;
        });
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
            tx.set(stateRef, { ...state.data(), kind: 'houseMeterState', totalArea,
                areaUpdatedAt: serverTimestamp(), revision: context.revision + 1,
                updatedAt: serverTimestamp() });
        });
        return load();
    }
    async function syncTotalArea(apartments) {
        const apt = apartmentOfCurrentUser();
        if (!apt) throw new Error('Увійдіть у застосунок');
        const admin = await getDocFromServer(doc(database, 'apartments', apt));
        if (!admin.exists() || admin.data().isAdmin !== true) throw new Error('Оновити загальну площу може лише правління');
        if (!apartments) {
            const snap = await getDocsFromServer(collection(database, 'apartments'));
            apartments = snap.docs.map(row => ({ ...row.data(), apt: row.id }));
        }
        const totalArea = buildingTotalArea(apartments);
        const state = await getDocFromServer(stateRef);
        if (state.data()?.totalArea !== totalArea) await setDoc(stateRef, {
            kind: 'houseMeterState', totalArea, areaUpdatedAt: serverTimestamp()
        }, { merge: true });
        return totalArea;
    }
    async function saveHeatTariff(context, input) {
        const apt = apartmentOfCurrentUser();
        if (!apt) throw new Error('Увійдіть у застосунок');
        const admin = await getDocFromServer(doc(database, 'apartments', apt));
        if (!admin.exists() || admin.data().isAdmin !== true) throw new Error('Змінювати тариф може лише правління');
        const row = normalizeHeatTariff(input);
        const ref = doc(database, 'status', `heat_tariff_${row.effectiveFrom}`);
        await runTransaction(database, async tx => {
            const state = await tx.get(stateRef);
            if ((state.data()?.revision || 0) !== context.revision) throw new Error('Дані оновилися в іншій вкладці. Натисніть «Оновити».');
            const previous = await tx.get(ref);
            tx.set(ref, { ...row, createdAt: previous.data()?.createdAt || serverTimestamp(),
                updatedAt: serverTimestamp(), updatedBy: apt });
            tx.set(stateRef, { ...state.data(), kind: 'houseMeterState', revision: context.revision + 1,
                updatedAt: serverTimestamp() });
        });
        return load();
    }
    return { load, save, syncTotalArea, saveHeatTariff };
}

export const meterStore = createMeterStore(db, currentApt);
