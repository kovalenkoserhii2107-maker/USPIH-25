// Файли в демо: лише в памʼяті сторінки.
const files = new Map();
const file = name => ({
    name,
    save: async data => { files.set(name, data); },
    download: async () => [files.get(name) || new Uint8Array()],
    exists: async () => [files.has(name)],
    delete: async () => { files.delete(name); },
    getMetadata: async () => [{ name, size: String(files.get(name)?.length || 0), generation: '1', contentType: 'application/octet-stream' }],
    getSignedUrl: async () => ['#demo-file']
});
const bucket = () => ({ name: 'demo', file, getFiles: async () => [[...files.keys()].map(file), null] });
module.exports = { getStorage: () => ({ bucket }) };
