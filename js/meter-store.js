import { db, currentApt } from './firebase.js';
import * as firestore from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js';
import { fetchStaffRole, requireRight } from './staff-core.js';
import { METER_KIND, HEAT_TARIFF_KIND, RESOURCE_TARIFF_KIND, normalizeResourceTariff, meterRecordId, validateMeterChanges, buildingTotalArea, integerReading, decimalValue } from './meter-core.js';

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
        const snap = await getDocsFromServer(query(collection(database, 'status'), where('kind', 'in', [METER_KIND, HEAT_TARIFF_KIND, RESOURCE_TARIFF_KIND])));
        const rows = snap.docs.map(row => ({ ...row.data(), id: row.id }));
        return { revision: state.data()?.revision || 0, totalArea: state.data()?.totalArea ?? null,
            areaSource: state.data()?.areaSource || 'directory',
            records: rows.filter(row => row.kind === METER_KIND),
            tariffs: rows.filter(row => row.kind === HEAT_TARIFF_KIND || row.kind === RESOURCE_TARIFF_KIND),
            heatTariffs: rows.filter(row => row.kind === HEAT_TARIFF_KIND) };
    }

    async function save(context, changes) {
        const apt = apartmentOfCurrentUser();
        if (!apt) throw new Error('Увійдіть у застосунок');
        requireRight(await fetchStaffRole(api, database, apt), 'account', 'Вносити показники може лише бухгалтер або голова правління');
        const clean = validateMeterChanges(context.records, changes);
        if (!clean.length) throw new Error('Введіть показники хоча б одного ресурсу');
        if (clean.some(row => integerReading(row.reading) === null)) throw new Error('Новий показник вводиться лише цілим числом');
        let directoryArea = null;
        if (context.areaSource !== 'manual') {
            const apartments = await getDocsFromServer(collection(database, 'apartments'));
            directoryArea = buildingTotalArea(apartments.docs.map(row => ({ ...row.data(), apt: row.id })));
        }
        await runTransaction(database, async tx => {
            const state = await tx.get(stateRef);
            if ((state.data()?.revision || 0) !== context.revision) {
                throw new Error('Показники оновилися в іншій вкладці. Натисніть «Оновити» і перевірте введене.');
            }
            const totalArea = state.data()?.areaSource === 'manual' ? state.data().totalArea : directoryArea;
            clean.forEach(row => {
                if (row.resource !== 'heat') return;
                delete row.totalArea;
                if (totalArea > 0) row.totalArea = totalArea;
            });
            const refs = clean.map(row => doc(database, 'status', meterRecordId(row.resource, row.period)));
            const snapshots = await Promise.all(refs.map(ref => tx.get(ref)));
            clean.forEach((row, index) => tx.set(refs[index], { ...row,
                createdAt: snapshots[index].data()?.createdAt || serverTimestamp(),
                updatedAt: serverTimestamp(), updatedBy: apt }));
            tx.set(stateRef, { ...state.data(), kind: 'houseMeterState', totalArea,
                areaSource: state.data()?.areaSource === 'manual' ? 'manual' : 'directory',
                areaUpdatedAt: serverTimestamp(), revision: context.revision + 1,
                updatedAt: serverTimestamp() });
        });
        return load();
    }
    async function syncTotalArea(apartments) {
        const apt = apartmentOfCurrentUser();
        if (!apt) throw new Error('Увійдіть у застосунок');
        requireRight(await fetchStaffRole(api, database, apt), 'account', 'Оновити загальну площу може лише бухгалтер або голова правління');
        const state = await getDocFromServer(stateRef);
        if (state.data()?.areaSource === 'manual') return state.data().totalArea;
        if (!apartments) {
            const snap = await getDocsFromServer(collection(database, 'apartments'));
            apartments = snap.docs.map(row => ({ ...row.data(), apt: row.id }));
        }
        const totalArea = buildingTotalArea(apartments);
        return runTransaction(database, async tx => {
            const current = await tx.get(stateRef), data = current.data() || {};
            if (data.areaSource === 'manual') return data.totalArea;
            if (data.totalArea !== totalArea) tx.set(stateRef, { ...data,
                kind: 'houseMeterState', totalArea, areaSource: 'directory', areaUpdatedAt: serverTimestamp(),
                revision: data.revision === undefined ? 0 : data.revision + 1 });
            return totalArea;
        });
    }
    async function saveTotalArea(context, input) {
        const apt = apartmentOfCurrentUser();
        if (!apt) throw new Error('Увійдіть у застосунок');
        requireRight(await fetchStaffRole(api, database, apt), 'account', 'Змінювати площу може лише бухгалтер або голова правління');
        const totalArea = decimalValue(input);
        if (!(totalArea > 0) || totalArea > 1e7) throw new Error('Вкажіть додатну загальну площу будинку, м²');
        await runTransaction(database, async tx => {
            const state = await tx.get(stateRef);
            if ((state.data()?.revision || 0) !== context.revision) throw new Error('Дані оновилися в іншій вкладці. Натисніть «Оновити».');
            tx.set(stateRef, { ...state.data(), kind: 'houseMeterState', totalArea, areaSource: 'manual',
                revision: context.revision + 1, areaUpdatedAt: serverTimestamp(), updatedAt: serverTimestamp(), updatedBy: apt });
        });
        return load();
    }
    async function saveTariff(context, input) {
        const apt = apartmentOfCurrentUser();
        if (!apt) throw new Error('Увійдіть у застосунок');
        requireRight(await fetchStaffRole(api, database, apt), 'account', 'Змінювати тариф може лише бухгалтер або голова правління');
        const row = normalizeResourceTariff(input);
        const ref = doc(database, 'status', row.resource === 'heat' ? `heat_tariff_${row.effectiveFrom}` : `tariff_${row.resource}_${row.effectiveFrom}`);
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
    const saveHeatTariff = (context, input) => saveTariff(context, { ...input, resource: 'heat' });
    return { load, save, syncTotalArea, saveTotalArea, saveTariff, saveHeatTariff };
}

export const meterStore = createMeterStore(db, currentApt);
