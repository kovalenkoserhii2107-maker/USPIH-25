// firebase-storage для демо-будинку: файли — лише в памʼяті вкладки.
const files = new Map();
export const getStorage = () => ({ name: 'demo' });
export const ref = (_, path = '') => ({ fullPath: String(path), name: String(path).split('/').at(-1), bucket: 'demo' });
export async function uploadBytes(r, data, metadata = {}) {
    files.set(r.fullPath, new Blob([data], { type: metadata.contentType || data?.type || 'application/octet-stream' }));
    return { ref: r, metadata: { fullPath: r.fullPath, size: data?.size || data?.byteLength || 0, contentType: metadata.contentType || data?.type || '' } };
}
export const uploadBytesResumable = (r, data, metadata) => {
    const task = uploadBytes(r, data, metadata);
    return Object.assign(task.then(x => x), { on: (_, __, ___, done) => task.then(() => done?.()), snapshot: { ref: r } });
};
export async function getDownloadURL(r) {
    const blob = files.get(r.fullPath);
    if (blob) return URL.createObjectURL(blob);
    const e = new Error('У демо-будинку цього файлу немає'); e.code = 'storage/object-not-found'; throw e;
}
export async function getBlob(r) { const b = files.get(r.fullPath); if (!b) throw Object.assign(new Error('Файлу немає'), { code: 'storage/object-not-found' }); return b; }
export async function getBytes(r) { return new Uint8Array(await (await getBlob(r)).arrayBuffer()); }
export async function deleteObject(r) { files.delete(r.fullPath); }
export async function listAll() { return { items: [], prefixes: [] }; }
export async function getMetadata(r) { return { fullPath: r.fullPath, size: files.get(r.fullPath)?.size || 0 }; }
