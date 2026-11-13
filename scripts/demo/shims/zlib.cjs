const { inflateSync, deflateSync, gzipSync, gunzipSync, inflateSync: inflateRaw, deflateSync: deflateRaw } = require('fflate');
const B = v => Buffer.from(v);
module.exports = {
    inflateRawSync: d => B(inflateRaw(new Uint8Array(d))), deflateRawSync: d => B(deflateRaw(new Uint8Array(d))),
    inflateSync: d => B(require('fflate').unzlibSync(new Uint8Array(d))), deflateSync: d => B(require('fflate').zlibSync(new Uint8Array(d))),
    gzipSync: d => B(gzipSync(new Uint8Array(d))), gunzipSync: d => B(gunzipSync(new Uint8Array(d)))
};
void inflateSync; void deflateSync;
