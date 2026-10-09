import { build } from 'esbuild';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';

// Two entries keep their versioned names: the resident cabinet (index.html)
// and the board panel (admin.html). Shared and lazily loaded code goes to
// content-hashed chunks, so residents never download the board's features.
await rm('_site', { recursive: true, force: true });
await mkdir('_site', { recursive: true });
for (const path of ['index.html', 'admin.html', 'buh.html', 'style.css', 'style-admin.css', 'style-buh.css', 'style-chat.css', 'manifest.json', 'sw.js', 'js', 'assets']) {
    await cp(path, `_site/${path}`, { recursive: true });
}
const result = await build({ entryPoints: ['js/app.js', 'js/admin-main.js', 'js/buh-main.js'], outdir: '_site/js', entryNames: '[name]',
    chunkNames: 'chunks/[name]-[hash]', bundle: true, splitting: true, format: 'esm', target: ['es2020'],
    minify: true, external: ['https://*'], metafile: true });
const outputs = result.metafile.outputs;

// Chunks an entry imports statically are needed before its first screen:
// preload them in parallel.
function startupChunks(entry) {
    const found = new Set();
    const visit = path => {
        for (const { path: next, kind, external } of outputs[path].imports) {
            if (external || kind !== 'import-statement' || found.has(next)) continue;
            found.add(next);
            visit(next);
        }
    };
    visit(entry);
    return [...found].map(path => `./${path.slice('_site/'.length)}`).sort();
}
const residentChunks = startupChunks('_site/js/app.js');
const adminChunks = startupChunks('_site/js/admin-main.js');
const buhChunks = startupChunks('_site/js/buh-main.js');

// The offline shell is the resident cabinet only; the panel's files are
// cached the first time a board member opens it.
const shell = ['\'./\'', '\'./index.html\'', '\'./manifest.json\'',
    '`./style.css?v=${VERSION}`', '`./style-chat.css?v=${VERSION}`', '`./js/app.js?v=${VERSION}`',
    ...residentChunks.map(url => `'${url}'`)];
const sw = (await readFile('sw.js', 'utf8')).replace(/const SHELL = \[[\s\S]*?\];/, `const SHELL = [\n    ${shell.join(',\n    ')}\n];`);
await writeFile('_site/sw.js', sw);

async function injectPreloads(page, chunks) {
    const preloads = chunks.map(url => `    <link rel="modulepreload" href="${url.slice(2)}">`).join('\n');
    const html = (await readFile(page, 'utf8')).replace('</head>', `${preloads}\n</head>`);
    await writeFile(`_site/${page}`, html);
}
await injectPreloads('index.html', residentChunks);
await injectPreloads('admin.html', adminChunks);
await injectPreloads('buh.html', buhChunks);

const kib = paths => Math.round(paths.reduce((sum, path) => sum + outputs[path.replace('./', '_site/')].bytes, 0) / 1024);
const all = Object.keys(outputs).filter(path => path.endsWith('.js'));
console.log(`Built cabinet (${kib(['./js/app.js', ...residentChunks])} KiB at startup) and panel `
    + `(${kib(['./js/admin-main.js', ...adminChunks])} KiB at startup), accounting (${kib(['./js/buh-main.js', ...buhChunks])} KiB), ${Math.round(all.reduce((s, p) => s + outputs[p].bytes, 0) / 1024)} KiB total, `
    + `with ${shell.length} shell URLs.`);
