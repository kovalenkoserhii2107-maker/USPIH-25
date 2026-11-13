// node:crypto для демо: SHA-256/SHA-1 синхронно (сервер рахує ними ідентифікатори й підписи вмісту).
const K = new Uint32Array([0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2]);
function pad(bytes) {
    const len = bytes.length, total = Math.ceil((len + 9) / 64) * 64, out = new Uint8Array(total);
    out.set(bytes); out[len] = 0x80;
    const bits = len * 8, view = new DataView(out.buffer);
    view.setUint32(total - 4, bits >>> 0); view.setUint32(total - 8, Math.floor(bits / 2 ** 32));
    return { out, view };
}
const rotr = (x, n) => (x >>> n) | (x << (32 - n));
function sha256(bytes) {
    const { out, view } = pad(bytes);
    const H = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
    const W = new Uint32Array(64);
    for (let i = 0; i < out.length; i += 64) {
        for (let t = 0; t < 16; t++) W[t] = view.getUint32(i + t * 4);
        for (let t = 16; t < 64; t++) {
            const s0 = rotr(W[t - 15], 7) ^ rotr(W[t - 15], 18) ^ (W[t - 15] >>> 3), s1 = rotr(W[t - 2], 17) ^ rotr(W[t - 2], 19) ^ (W[t - 2] >>> 10);
            W[t] = (W[t - 16] + s0 + W[t - 7] + s1) >>> 0;
        }
        let [a, b, c, d, e, f, g, h] = H;
        for (let t = 0; t < 64; t++) {
            const t1 = (h + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[t] + W[t]) >>> 0;
            const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
            h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
        }
        H[0] += a; H[1] += b; H[2] += c; H[3] += d; H[4] += e; H[5] += f; H[6] += g; H[7] += h;
    }
    const res = new Uint8Array(32), rv = new DataView(res.buffer);
    H.forEach((x, i) => rv.setUint32(i * 4, x));
    return res;
}
function sha1(bytes) {
    const { out, view } = pad(bytes);
    let h0 = 0x67452301, h1 = 0xefcdab89, h2 = 0x98badcfe, h3 = 0x10325476, h4 = 0xc3d2e1f0;
    const W = new Uint32Array(80);
    for (let i = 0; i < out.length; i += 64) {
        for (let t = 0; t < 16; t++) W[t] = view.getUint32(i + t * 4);
        for (let t = 16; t < 80; t++) { const x = W[t - 3] ^ W[t - 8] ^ W[t - 14] ^ W[t - 16]; W[t] = (x << 1) | (x >>> 31); }
        let a = h0, b = h1, c = h2, d = h3, e = h4;
        for (let t = 0; t < 80; t++) {
            const f = t < 20 ? (b & c) | (~b & d) : t < 40 ? b ^ c ^ d : t < 60 ? (b & c) | (b & d) | (c & d) : b ^ c ^ d;
            const k = t < 20 ? 0x5a827999 : t < 40 ? 0x6ed9eba1 : t < 60 ? 0x8f1bbcdc : 0xca62c1d6;
            const tmp = (((a << 5) | (a >>> 27)) + f + e + k + W[t]) >>> 0;
            e = d; d = c; c = (b << 30) | (b >>> 2); b = a; a = tmp;
        }
        h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0; h4 = (h4 + e) >>> 0;
    }
    const res = new Uint8Array(20), rv = new DataView(res.buffer);
    [h0, h1, h2, h3, h4].forEach((x, i) => rv.setUint32(i * 4, x));
    return res;
}
const toBytes = (data, enc) => (typeof data === 'string' ? (enc === 'base64' ? Buffer.from(data, 'base64') : new TextEncoder().encode(data)) : new Uint8Array(data.buffer ? data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) : data));
function createHash(alg) {
    const fn = { sha256, sha1 }[String(alg).toLowerCase()];
    if (!fn) throw new Error(`Демо: алгоритм ${alg} не підтримується`);
    const parts = [];
    const h = {
        update(data, enc) { parts.push(toBytes(data, enc)); return h; },
        digest(enc) {
            const all = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
            let o = 0; for (const p of parts) { all.set(p, o); o += p.length; }
            const buf = Buffer.from(fn(all));
            return enc ? buf.toString(enc) : buf;
        },
        copy() { const c = createHash(alg); parts.forEach(p => c.update(p)); return c; }
    };
    return h;
}
const randomUUID = () => (globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID() : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => { const r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 3) | 8).toString(16); }));
const randomBytes = n => { const b = new Uint8Array(n); if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(b); else for (let i = 0; i < n; i++) b[i] = Math.random() * 256 | 0; return Buffer.from(b); };
const timingSafeEqual = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
module.exports = { createHash, randomUUID, randomBytes, timingSafeEqual, webcrypto: globalThis.crypto };
