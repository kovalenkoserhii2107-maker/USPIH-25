// Збірка сервера демо-будинку (functions/* → один ESM-файл без залежностей від Node).
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { demoFixture } from './fixture.mjs';
const here = p => fileURLToPath(new URL(p, import.meta.url));
const shim = name => here(`./shims/${name}`);
export const alias = {
    'firebase-functions/v2/https': shim('functions-https.cjs'),
    'firebase-functions/v2/scheduler': shim('functions-scheduler.cjs'),
    'firebase-functions/logger': shim('functions-logger.cjs'),
    'firebase-functions/params': shim('functions-params.cjs'),
    'firebase-admin/app': shim('admin-app.cjs'),
    'firebase-admin/firestore': shim('admin-firestore.cjs'),
    'firebase-admin/storage': shim('admin-storage.cjs'),
    'firebase-admin/auth': shim('admin-auth.cjs'),
    'firebase-admin/messaging': shim('admin-messaging.cjs'),
    crypto: shim('crypto.cjs'), 'node:crypto': shim('crypto.cjs'),
    zlib: shim('zlib.cjs'), 'node:zlib': shim('zlib.cjs')
};
export async function bundleServer(outfile, { minify = true } = {}) {
    await build({
        entryPoints: [here('./server-entry.js')], outfile, bundle: true, format: 'esm', platform: 'browser', target: ['es2020'], minify,
        alias, inject: [shim('process.js')], define: { 'process.env.STORAGE_BUCKET': '"demo"', global: 'globalThis' },
        plugins: [{ name: 'demo-db', setup(b) {
            b.onResolve({ filter: /\.\/accounting-test-db$/ }, () => ({ path: shim('accounting-test-db.cjs') }));
            // Контрольний сценарій тестової бухгалтерії — у демо «живий»: імена, боржники, постачальники.
            b.onResolve({ filter: /\.\/accounting-test-fixture\.json$/ }, () => ({ path: 'demo-fixture', namespace: 'demo' }));
            b.onLoad({ filter: /^demo-fixture$/, namespace: 'demo' }, async () => ({ contents: JSON.stringify(await demoFixture()), loader: 'json' }));
        } }],
        logLevel: 'warning', legalComments: 'none'
    });
}
