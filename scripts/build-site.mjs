import { build } from 'esbuild';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';

// The entry keeps its versioned name; shared and admin-only code goes to
// content-hashed chunks, so residents do not download the board's features.
await rm('_site', { recursive: true, force: true });
await mkdir('_site', { recursive: true });
for (const path of ['index.html', 'style.css', 'style-chat.css', 'manifest.json', 'sw.js', 'js', 'assets']) {
    await cp(path, `_site/${path}`, { recursive: true });
}
const result = await build({ entryPoints: ['js/app.js'], outdir: '_site/js', entryNames: '[name]',
    chunkNames: 'chunks/[name]-[hash]', bundle: true, splitting: true, format: 'esm', target: ['es2020'],
    minify: true, external: ['https://*'], metafile: true });
const outputs = result.metafile.outputs;

// Chunks the entry imports statically are needed before the cabinet can open:
// preload them in parallel and keep them in the offline shell.
const startup = new Set();
const visit = path => {
    for (const { path: next, kind, external } of outputs[path].imports) {
        if (external || kind !== 'import-statement' || startup.has(next)) continue;
        startup.add(next);
        visit(next);
    }
};
visit('_site/js/app.js');
const chunkUrls = [...startup].map(path => `./${path.slice('_site/'.length)}`).sort();

// Source modules remain available for admin preview; production does not fetch them.
const shell = ['\'./\'', '\'./index.html\'', '\'./manifest.json\'',
    '`./style.css?v=${VERSION}`', '`./style-chat.css?v=${VERSION}`', '`./js/app.js?v=${VERSION}`',
    ...chunkUrls.map(url => `'${url}'`)];
const sw = (await readFile('sw.js', 'utf8')).replace(/const SHELL = \[[\s\S]*?\];/, `const SHELL = [\n    ${shell.join(',\n    ')}\n];`);
await writeFile('_site/sw.js', sw);

const preloads = chunkUrls.map(url => `    <link rel="modulepreload" href="${url.slice(2)}">`).join('\n');
const html = (await readFile('index.html', 'utf8')).replace('</head>', `${preloads}\n</head>`);
await writeFile('_site/index.html', html);

const kib = paths => Math.round(paths.reduce((sum, path) => sum + outputs[path].bytes, 0) / 1024);
const all = Object.keys(outputs).filter(path => path.endsWith('.js'));
console.log(`Built app entry with ${startup.size} startup chunks (${kib(['_site/js/app.js', ...startup])} KiB at startup, `
    + `${kib(all)} KiB total), with ${shell.length} shell URLs.`);
