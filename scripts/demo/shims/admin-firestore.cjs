// firebase-admin/firestore → база демо-будинку в памʼяті (js/demo/memdb.js).
// Склад створюють до завантаження серверних модулів (globalThis.__demoStore),
// тож класи Timestamp і FieldValue — ті самі, що й у кабінетах.
const store = () => { const s = globalThis.__demoStore; if (!s) throw new Error('Демо-базу ще не завантажено'); return s; };
const Filter = {
    where: (field, operator, value) => ({ field, operator, value }),
    and: (...filters) => ({ operator: 'and', filters }),
    or: (...filters) => ({ operator: 'or', filters })
};
const lazy = new Proxy({}, { get: (_, key) => store().admin[key] });
module.exports = {
    getFirestore: () => lazy, Filter,
    get Timestamp() { return store().lib.Timestamp; },
    get FieldValue() { return store().lib.FieldValue; },
    get FieldPath() { return store().lib.FieldPath; }
};
