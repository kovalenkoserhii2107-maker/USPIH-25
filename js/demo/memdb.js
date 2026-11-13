// ============================================================
// Демо-будинок: база в памʼяті з API Firestore.
//
// Один склад даних, два обличчя:
//   • admin — як firebase-admin/firestore (для серверних модулів, які в
//     демо виконуються прямо в браузері, і для збірки демо-бази);
//   • client — як модульний SDK firebase-firestore (для кабінетів).
// Зміни живуть лише до перезавантаження сторінки: демо показує, як
// працює дія, але нічого не зберігає.
// ============================================================

// ---------- Значення ----------
export class Timestamp {
    constructor(seconds, nanoseconds = 0) { this.seconds = seconds; this.nanoseconds = nanoseconds; }
    static now() { return Timestamp.fromMillis(Date.now()); }
    static fromDate(d) { return Timestamp.fromMillis(d.getTime()); }
    static fromMillis(ms) { return new Timestamp(Math.floor(ms / 1000), Math.round((ms % 1000 + 1000) % 1000 * 1e6)); }
    toMillis() { return this.seconds * 1000 + Math.floor(this.nanoseconds / 1e6); }
    toDate() { return new Date(this.toMillis()); }
    isEqual(o) { return o instanceof Timestamp && o.seconds === this.seconds && o.nanoseconds === this.nanoseconds; }
    valueOf() { return String(this.toMillis()).padStart(16, '0'); }
    // Як у firebase-admin: так Timestamp приходить у відповіді callable-функції.
    toJSON() { return { _seconds: this.seconds, _nanoseconds: this.nanoseconds }; }
    get _seconds() { return this.seconds; }
}

class Sentinel { constructor(kind, value) { this.kind = kind; this.value = value; } }
export const FieldValue = {
    serverTimestamp: () => new Sentinel('ts'),
    delete: () => new Sentinel('delete'),
    increment: n => new Sentinel('inc', n),
    arrayUnion: (...v) => new Sentinel('union', v),
    arrayRemove: (...v) => new Sentinel('remove', v)
};
const DOC_ID = '__name__';
export const FieldPath = { documentId: () => DOC_ID };

const isPlain = v => v && typeof v === 'object' && !(v instanceof Timestamp) && !(v instanceof Sentinel) && !(v instanceof Date) && !Array.isArray(v) && !(v instanceof Uint8Array) && !(v?._isRef);
function clone(v) {
    if (v instanceof Timestamp) return new Timestamp(v.seconds, v.nanoseconds);
    if (v instanceof Date) return Timestamp.fromDate(v);
    if (Array.isArray(v)) return v.map(clone);
    if (v instanceof Uint8Array) return v.slice();
    if (v?._isRef) return v;
    if (v && typeof v === 'object' && !(v instanceof Sentinel)) {
        const out = {};
        for (const [k, x] of Object.entries(v)) if (x !== undefined) out[k] = clone(x);
        return out;
    }
    return v;
}
const same = (a, b) => (a instanceof Timestamp ? a.isEqual(b) : JSON.stringify(a) === JSON.stringify(b));

// ---------- Серіалізація демо-бази ----------
function encode(v) {
    if (v instanceof Timestamp) return { $t: v.toMillis() };
    if (v instanceof Date) return { $t: v.getTime() };
    if (Array.isArray(v)) return v.map(encode);
    if (v instanceof Uint8Array) return { $b: Array.from(v) };
    if (v?._isRef) return { $r: v.path };
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).filter(([, x]) => x !== undefined).map(([k, x]) => [k, encode(x)]));
    return v;
}
function decode(v, db) {
    if (Array.isArray(v)) return v.map(x => decode(x, db));
    if (v && typeof v === 'object') {
        if ('$t' in v && Object.keys(v).length === 1) return Timestamp.fromMillis(v.$t);
        if ('$b' in v && Object.keys(v).length === 1) return new Uint8Array(v.$b);
        if ('$r' in v && Object.keys(v).length === 1) return db.admin.doc(v.$r);
        return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, decode(x, db)]));
    }
    return v;
}

// ---------- Поля ----------
function getField(data, path) {
    if (path === DOC_ID) return undefined;
    return String(path).split('.').reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), data);
}
function setField(data, path, value) {
    const keys = String(path).split('.');
    let o = data;
    for (const k of keys.slice(0, -1)) { if (!isPlain(o[k])) o[k] = {}; o = o[k]; }
    const last = keys.at(-1);
    applyValue(o, last, value);
}
function applyValue(o, key, value) {
    if (value instanceof Sentinel) {
        if (value.kind === 'delete') delete o[key];
        else if (value.kind === 'ts') o[key] = Timestamp.now();
        else if (value.kind === 'inc') o[key] = (typeof o[key] === 'number' ? o[key] : 0) + value.value;
        else if (value.kind === 'union') { const arr = Array.isArray(o[key]) ? o[key] : []; o[key] = [...arr, ...value.value.filter(x => !arr.some(y => same(x, y))).map(clone)]; }
        else if (value.kind === 'remove') o[key] = (Array.isArray(o[key]) ? o[key] : []).filter(x => !value.value.some(y => same(x, y)));
    } else o[key] = clone(value);
}
function resolve(data) {
    // Sentinel-и у вкладених обʼєктах (set без merge).
    const out = {};
    for (const [k, v] of Object.entries(data || {})) {
        if (v === undefined) continue;
        if (isPlain(v)) out[k] = resolve(v);
        else applyValue(out, k, v);
    }
    return out;
}
function merge(target, data) {
    for (const [k, v] of Object.entries(data || {})) {
        if (v === undefined) continue;
        if (isPlain(v)) { if (!isPlain(target[k])) target[k] = {}; merge(target[k], v); }
        else applyValue(target, k, v);
    }
    return target;
}

// ---------- Порівняння для запитів ----------
const rank = v => v === null || v === undefined ? 0 : typeof v === 'boolean' ? 1 : typeof v === 'number' ? 2 : v instanceof Timestamp ? 3 : typeof v === 'string' ? 4 : Array.isArray(v) ? 6 : 7;
function cmp(a, b) {
    const ra = rank(a), rb = rank(b);
    if (ra !== rb) return ra - rb;
    if (a instanceof Timestamp) return a.toMillis() - b.toMillis();
    if (typeof a === 'number' || typeof a === 'string' || typeof a === 'boolean') return a < b ? -1 : a > b ? 1 : 0;
    return JSON.stringify(a) < JSON.stringify(b) ? -1 : JSON.stringify(a) > JSON.stringify(b) ? 1 : 0;
}
const norm = v => (v instanceof Date ? Timestamp.fromDate(v) : v?._isRef ? v.id : v);
function test(op, actual, expected) {
    expected = Array.isArray(expected) ? expected.map(norm) : norm(expected);
    switch (op) {
        case '==': return actual !== undefined && cmp(actual, expected) === 0;
        case '!=': return actual !== undefined && cmp(actual, expected) !== 0;
        case '<': return actual !== undefined && rank(actual) === rank(expected) && cmp(actual, expected) < 0;
        case '<=': return actual !== undefined && rank(actual) === rank(expected) && cmp(actual, expected) <= 0;
        case '>': return actual !== undefined && rank(actual) === rank(expected) && cmp(actual, expected) > 0;
        case '>=': return actual !== undefined && rank(actual) === rank(expected) && cmp(actual, expected) >= 0;
        case 'in': return actual !== undefined && expected.some(e => cmp(actual, e) === 0);
        case 'not-in': return actual !== undefined && !expected.some(e => cmp(actual, e) === 0);
        case 'array-contains': return Array.isArray(actual) && actual.some(x => cmp(x, expected) === 0);
        case 'array-contains-any': return Array.isArray(actual) && actual.some(x => expected.some(e => cmp(x, e) === 0));
        default: throw new Error(`Демо: оператор ${op} не підтримується`);
    }
}

let autoCounter = 0;
export const autoId = () => {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let s = '';
    for (let i = 0; i < 20; i++) s += chars[Math.floor(Math.random() * chars.length)];
    return s + (autoCounter++ % 10);
};

// ============================================================
// СКЛАД
// ============================================================
export function createDb() {
    const docs = new Map();      // path → data
    const byParent = new Map();  // collection path → Set(doc path)
    const meta = new Map();      // path → { create, update } — час зміни (сервер звіряє ним одночасні зміни)
    let tick = 0;
    const stamp = () => { const ms = Date.now(); tick = Math.max(tick + 1, ms * 1000); return new Timestamp(Math.floor(tick / 1e6), (tick % 1e6) * 1000); };
    const listeners = new Set();
    let version = 0;

    const parentOf = path => path.split('/').slice(0, -1).join('/');
    function put(path, data) {
        const now = stamp();
        if (!docs.has(path)) {
            const parent = parentOf(path);
            if (!byParent.has(parent)) byParent.set(parent, new Set());
            byParent.get(parent).add(path);
            meta.set(path, { create: now, update: now });
        } else meta.get(path).update = now;
        docs.set(path, data);
    }
    function drop(path) {
        if (!docs.has(path)) return;
        docs.delete(path);
        meta.delete(path);
        byParent.get(parentOf(path))?.delete(path);
    }
    let pending = null;
    function changed() {
        version++;
        if (pending) return;
        pending = Promise.resolve().then(() => { pending = null; for (const fn of [...listeners]) fn(); });
    }

    // ---------- Запити ----------
    function run(q) {
        let paths;
        if (q.group) {
            paths = [];
            for (const [parent, set] of byParent) if (parent === q.group || parent.endsWith(`/${q.group}`)) paths.push(...set);
        } else paths = [...(byParent.get(q.path) || [])];
        let rows = paths.map(p => ({ path: p, id: p.split('/').at(-1), data: docs.get(p) }));
        for (const f of q.filters) rows = rows.filter(r => test(f.op, f.field === DOC_ID ? r.id : getField(r.data, f.field), f.value));
        const orders = q.orders.length ? q.orders : [];
        // Firestore не повертає документи без поля сортування.
        for (const o of orders) if (o.field !== DOC_ID) rows = rows.filter(r => getField(r.data, o.field) !== undefined);
        rows.sort((a, b) => {
            for (const o of orders) {
                const c = cmp(o.field === DOC_ID ? a.id : getField(a.data, o.field), o.field === DOC_ID ? b.id : getField(b.data, o.field));
                if (c) return o.dir === 'desc' ? -c : c;
            }
            return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
        });
        if (q.after) {
            const key = q.after;
            const index = rows.findIndex(r => r.path === key.path);
            if (index >= 0) rows = rows.slice(index + 1);
            else if (key.values) rows = rows.filter(r => orders.some((o, i) => cmp(getField(r.data, o.field), key.values[i]) * (o.dir === 'desc' ? -1 : 1) > 0));
        }
        if (q.offset) rows = rows.slice(q.offset);
        if (q.limitToLast) rows = rows.slice(-q.limitToLast);
        if (q.limit !== null && q.limit !== undefined) rows = rows.slice(0, q.limit);
        return rows;
    }

    function setDoc(path, data, opts = {}) {
        if (opts.merge || opts.mergeFields) put(path, merge(clone(docs.get(path) || {}), data));
        else put(path, resolve(data));
    }
    function updateDoc(path, data) {
        if (!docs.has(path)) { const e = new Error(`Документ не знайдено: ${path}`); e.code = 'not-found'; throw e; }
        const next = clone(docs.get(path));
        for (const [k, v] of Object.entries(data)) if (v !== undefined) setField(next, k, v);
        put(path, next);
    }
    function createDoc(path, data) {
        if (docs.has(path)) { const e = new Error(`Документ уже існує: ${path}`); e.code = 'already-exists'; throw e; }
        put(path, resolve(data));
    }
    const updateArgs = args => (typeof args[0] === 'string' || args[0] === DOC_ID
        ? Object.fromEntries(args.reduce((acc, x, i) => (i % 2 ? acc : [...acc, [x, args[i + 1]]]), [])) : args[0]);

    const store = {
        docs, byParent, meta, run, setDoc, updateDoc, createDoc, drop, changed,
        get version() { return version; },
        subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
        read: path => (docs.has(path) ? clone(docs.get(path)) : undefined),
        exists: path => docs.has(path),
        children: parent => [...(byParent.get(parent) || [])],
        dump() { return Object.fromEntries([...docs].map(([p, d]) => [p, encode(d)])); },
        load(obj) { docs.clear(); byParent.clear(); meta.clear(); for (const [p, d] of Object.entries(obj)) put(p, decode(d, store)); changed(); },
        updateArgs
    };
    store.lib = { Timestamp, FieldValue, FieldPath };
    store.admin = adminApi(store);
    store.client = clientApi(store);
    return store;
}

// ============================================================
// ADMIN (firebase-admin/firestore)
// ============================================================
function adminApi(store) {
    const db = {};
    class DocSnap {
        constructor(ref, data) {
            this.ref = ref; this.id = ref.id; this._d = data; this.exists = data !== undefined; this.readTime = Timestamp.now();
            const m = store.meta.get(ref.path);
            this.createTime = data !== undefined ? m?.create : undefined;
            this.updateTime = data !== undefined ? m?.update : undefined;
        }
        data() { return this._d === undefined ? undefined : clone(this._d); }
        get(field) { return this._d === undefined ? undefined : clone(getField(this._d, field)); }
    }
    class QuerySnap {
        constructor(docs) { this.docs = docs; this.size = docs.length; this.empty = !docs.length; this.readTime = Timestamp.now(); }
        forEach(fn) { this.docs.forEach(fn); }
        docChanges() { return this.docs.map((doc, i) => ({ type: 'added', doc, oldIndex: -1, newIndex: i })); }
    }
    class Query {
        constructor(q) { this._q = { filters: [], orders: [], limit: null, offset: 0, after: null, limitToLast: null, ...q }; this.firestore = db; }
        _with(patch) { const n = Object.create(Object.getPrototypeOf(this)); Object.assign(n, this); n._q = { ...this._q, ...patch }; return n; }
        where(field, op, value) {
            if (field && typeof field === 'object' && field.operator) return this._with({ filters: [...this._q.filters, ...flatten(field)] });
            return this._with({ filters: [...this._q.filters, { field: String(field), op, value }] });
        }
        orderBy(field, dir = 'asc') { return this._with({ orders: [...this._q.orders, { field: String(field), dir }] }); }
        limit(n) { return this._with({ limit: n }); }
        limitToLast(n) { return this._with({ limitToLast: n }); }
        offset(n) { return this._with({ offset: n }); }
        startAfter(...v) { return this._with({ after: v[0] instanceof DocSnap ? { path: v[0].ref.path } : { values: v.map(norm) } }); }
        select() { return this; }
        count() { return { get: async () => ({ data: () => ({ count: store.run(this._q).length }) }) }; }
        async get() { return new QuerySnap(store.run(this._q).map(r => new DocSnap(docRef(r.path), r.data))); }
        stream() { const self = this; return (async function* () { for (const d of (await self.get()).docs) yield d; })(); }
        onSnapshot(next) { const fire = async () => next(await this.get()); fire(); return store.subscribe(fire); }
    }
    const flatten = f => (f.filters ? f.filters.flatMap(flatten) : [{ field: String(f.field), op: f.operator, value: f.value }]);
    class CollectionRef extends Query {
        constructor(path) { super({ path }); this.path = path; this.id = path.split('/').at(-1); }
        get parent() { const p = this.path.split('/'); return p.length > 1 ? docRef(p.slice(0, -1).join('/')) : null; }
        doc(id) { return docRef(`${this.path}/${id === undefined ? autoId() : id}`); }
        async add(data) { const ref = this.doc(); store.createDoc(ref.path, data); store.changed(); return ref; }
        async listDocuments() { return store.children(this.path).map(docRef); }
    }
    const refs = new Map();
    function docRef(path) {
        path = String(path).replace(/^\/+|\/+$/g, '');
        if (refs.has(path)) return refs.get(path);
        const ref = {
            _isRef: true, path, id: path.split('/').at(-1), firestore: db,
            get parent() { return new CollectionRef(path.split('/').slice(0, -1).join('/')); },
            collection: name => new CollectionRef(`${path}/${name}`),
            get: async () => new DocSnap(ref, store.docs.get(path)),
            set: async (data, opts) => { store.setDoc(path, data, opts); store.changed(); },
            update: async (...args) => { store.updateDoc(path, store.updateArgs(args)); store.changed(); },
            create: async data => { store.createDoc(path, data); store.changed(); },
            delete: async () => { store.drop(path); store.changed(); },
            listCollections: async () => [...new Set([...store.byParent.keys()].filter(k => k.startsWith(`${path}/`) && k.split('/').length === path.split('/').length + 1))].map(k => new CollectionRef(k)),
            isEqual: other => other?.path === path,
            onSnapshot: next => { const fire = async () => next(await ref.get()); fire(); return store.subscribe(fire); }
        };
        refs.set(path, ref);
        return ref;
    }
    async function readAny(target) { return target instanceof Query ? target.get() : target.get(); }
    Object.assign(db, {
        collection: path => new CollectionRef(String(path)),
        doc: path => docRef(path),
        collectionGroup: id => new Query({ group: id }),
        getAll: async (...refsList) => Promise.all(refsList.filter(r => r && r._isRef).map(r => r.get())),
        batch() {
            const ops = [];
            const b = {
                set: (ref, data, opts) => { ops.push(() => store.setDoc(ref.path, data, opts)); return b; },
                update: (ref, ...args) => { ops.push(() => store.updateDoc(ref.path, store.updateArgs(args))); return b; },
                create: (ref, data) => { ops.push(() => store.createDoc(ref.path, data)); return b; },
                delete: ref => { ops.push(() => store.drop(ref.path)); return b; },
                commit: async () => { ops.forEach(op => op()); store.changed(); return []; }
            };
            return b;
        },
        async runTransaction(fn) {
            const ops = [];
            const t = {
                get: readAny,
                getAll: (...r) => db.getAll(...r),
                set: (ref, data, opts) => { ops.push(() => store.setDoc(ref.path, data, opts)); return t; },
                update: (ref, ...args) => { ops.push(() => store.updateDoc(ref.path, store.updateArgs(args))); return t; },
                create: (ref, data) => { ops.push(() => store.createDoc(ref.path, data)); return t; },
                delete: ref => { ops.push(() => store.drop(ref.path)); return t; }
            };
            const result = await fn(t);
            ops.forEach(op => op());
            store.changed();
            return result;
        },
        async recursiveDelete(ref) {
            const prefix = ref.path ? `${ref.path}/` : '';
            for (const p of [...store.docs.keys()]) if (p === ref.path || p.startsWith(prefix)) store.drop(p);
            store.changed();
        },
        listCollections: async () => [...new Set([...store.byParent.keys()].map(k => k.split('/')[0]))].map(k => new CollectionRef(k)),
        settings() {},
        terminate: async () => {}
    });
    return db;
}

// ============================================================
// CLIENT (модульний firebase-firestore)
// ============================================================
function clientApi(store) {
    const admin = store.admin;
    const fs = { type: 'firestore', _demo: true };
    const pathOf = (base, segments) => [base?.path, ...segments].filter(Boolean).join('/');
    const asRef = (path, kind) => (kind === 'doc'
        ? Object.assign(Object.create(clientDocProto), { type: 'document', path, id: path.split('/').at(-1), firestore: fs })
        : Object.assign(Object.create(clientColProto), { type: 'collection', path, id: path.split('/').at(-1), firestore: fs, _q: { path, filters: [], orders: [], limit: null } }));
    const clientDocProto = { get parent() { return asRef(this.path.split('/').slice(0, -1).join('/'), 'col'); }, withConverter() { return this; } };
    const clientColProto = { get parent() { const p = this.path.split('/'); return p.length > 1 ? asRef(p.slice(0, -1).join('/'), 'doc') : null; }, withConverter() { return this; } };

    class Snap {
        constructor(path, data) { this.ref = asRef(path, 'doc'); this.id = this.ref.id; this._d = data; this.metadata = { fromCache: false, hasPendingWrites: false }; }
        exists() { return this._d !== undefined; }
        data() { return this._d === undefined ? undefined : clone(this._d); }
        get(field) { return this._d === undefined ? undefined : clone(getField(this._d, field)); }
    }
    class QSnap {
        constructor(rows) { this.docs = rows.map(r => new Snap(r.path, r.data)); this.size = this.docs.length; this.empty = !this.size; this.metadata = { fromCache: false, hasPendingWrites: false }; }
        forEach(fn) { this.docs.forEach(fn); }
        docChanges() { return this.docs.map((doc, i) => ({ type: 'added', doc, oldIndex: -1, newIndex: i })); }
    }
    const constraint = (kind, a) => ({ _constraint: kind, ...a });
    const api = {
        getFirestore: () => fs,
        initializeFirestore: () => fs,
        doc(base, ...segments) {
            if (base?.type === 'collection' && !segments.length) return asRef(`${base.path}/${autoId()}`, 'doc');
            return asRef(pathOf(base?.type ? base : null, segments), 'doc');
        },
        collection: (base, ...segments) => asRef(pathOf(base?.type ? base : null, segments), 'col'),
        collectionGroup: (_, id) => Object.assign(Object.create(clientColProto), { type: 'query', path: id, id, firestore: fs, _q: { group: id, filters: [], orders: [], limit: null } }),
        query(base, ...constraints) {
            const q = { ...base._q, filters: [...base._q.filters], orders: [...base._q.orders] };
            for (const c of constraints.flat()) {
                if (!c) continue;
                if (c._constraint === 'where') q.filters.push({ field: c.field, op: c.op, value: c.value });
                else if (c._constraint === 'orderBy') q.orders.push({ field: c.field, dir: c.dir });
                else if (c._constraint === 'limit') q.limit = c.n;
                else if (c._constraint === 'limitToLast') q.limitToLast = c.n;
                else if (c._constraint === 'startAfter') q.after = c.v[0] instanceof Snap ? { path: c.v[0].ref.path } : { values: c.v.map(norm) };
                else if (c._constraint === 'and') c.list.forEach(x => q.filters.push({ field: x.field, op: x.op, value: x.value }));
            }
            return { ...base, type: 'query', _q: q };
        },
        where: (field, op, value) => constraint('where', { field: String(field), op, value }),
        orderBy: (field, dir = 'asc') => constraint('orderBy', { field: String(field), dir }),
        limit: n => constraint('limit', { n }),
        limitToLast: n => constraint('limitToLast', { n }),
        startAfter: (...v) => constraint('startAfter', { v }),
        and: (...list) => constraint('and', { list }),
        documentId: () => DOC_ID,
        serverTimestamp: FieldValue.serverTimestamp,
        deleteField: FieldValue.delete,
        increment: FieldValue.increment,
        arrayUnion: FieldValue.arrayUnion,
        arrayRemove: FieldValue.arrayRemove,
        Timestamp,
        async getDoc(ref) { return new Snap(ref.path, store.docs.get(ref.path)); },
        async getDocs(q) { return new QSnap(store.run(q._q)); },
        async getCountFromServer(q) { return { data: () => ({ count: store.run(q._q).length }) }; },
        async setDoc(ref, data, opts) { store.setDoc(ref.path, data, opts); store.changed(); },
        async updateDoc(ref, ...args) { store.updateDoc(ref.path, store.updateArgs(args)); store.changed(); },
        async addDoc(col, data) { const ref = api.doc(col); store.createDoc(ref.path, data); store.changed(); return ref; },
        async deleteDoc(ref) { store.drop(ref.path); store.changed(); },
        writeBatch() {
            const ops = [];
            const b = {
                set: (ref, data, opts) => { ops.push(() => store.setDoc(ref.path, data, opts)); return b; },
                update: (ref, ...args) => { ops.push(() => store.updateDoc(ref.path, store.updateArgs(args))); return b; },
                delete: ref => { ops.push(() => store.drop(ref.path)); return b; },
                commit: async () => { ops.forEach(op => op()); store.changed(); }
            };
            return b;
        },
        async runTransaction(_, fn) {
            const ops = [];
            const t = {
                get: ref => api.getDoc(ref),
                set: (ref, data, opts) => { ops.push(() => store.setDoc(ref.path, data, opts)); return t; },
                update: (ref, ...args) => { ops.push(() => store.updateDoc(ref.path, store.updateArgs(args))); return t; },
                delete: ref => { ops.push(() => store.drop(ref.path)); return t; }
            };
            const result = await fn(t);
            ops.forEach(op => op());
            store.changed();
            return result;
        },
        onSnapshot(target, ...args) {
            const opts = args[0] && typeof args[0] === 'object' && !args[0].next && typeof args[0] !== 'function' ? args.shift() : null;
            const observer = typeof args[0] === 'object' ? args[0] : { next: args[0], error: args[1] };
            let last = null, stopped = false;
            const fire = () => {
                if (stopped) return;
                try {
                    const snap = target.type === 'document' ? new Snap(target.path, store.docs.get(target.path)) : new QSnap(store.run(target._q));
                    const key = JSON.stringify(encode(target.type === 'document' ? snap._d ?? null : snap.docs.map(d => [d.ref.path, d._d])));
                    if (key === last) return;
                    last = key;
                    observer.next?.(snap);
                } catch (e) { observer.error?.(e); }
            };
            void opts;
            queueMicrotask(fire);
            const off = store.subscribe(fire);
            return () => { stopped = true; off(); };
        },
        enableNetwork: async () => {},
        disableNetwork: async () => {},
        enableIndexedDbPersistence: async () => {},
        persistentLocalCache: () => ({}),
        persistentMultipleTabManager: () => ({})
    };
    api.getDocFromServer = api.getDoc;
    api.getDocsFromServer = api.getDocs;
    api.getDocFromCache = api.getDoc;
    api.getDocsFromCache = api.getDocs;
    void admin;
    return api;
}
