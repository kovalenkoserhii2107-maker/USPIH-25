import { build } from 'esbuild';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';

// One self-contained entry keeps first launch and delayed admin features on the same version.
await mkdir('_site', { recursive: true });
for (const path of ['index.html', 'style.css', 'style-chat.css', 'manifest.json', 'sw.js', 'js', 'assets']) {
    await cp(path, `_site/${path}`, { recursive: true });
}
const result = await build({ entryPoints: ['js/app.js'], outfile: '_site/js/app.js', bundle: true,
    format: 'esm', target: ['es2020'], minify: true, external: ['https://*'], metafile: true });
// Source modules remain available for admin preview; production does not fetch them.
const shell = ['\'./\'', '\'./index.html\'', '\'./manifest.json\'',
    '`./style.css?v=${VERSION}`', '`./style-chat.css?v=${VERSION}`', '`./js/app.js?v=${VERSION}`'];
const sw = (await readFile('sw.js', 'utf8')).replace(/const SHELL = \[[\s\S]*?\];/, `const SHELL = [\n    ${shell.join(',\n    ')}\n];`);
await writeFile('_site/sw.js', sw);
const bytes = result.metafile.outputs['_site/js/app.js'].bytes;
console.log(`Built one app entry (${Math.round(bytes / 1024)} KiB), with 6 shell URLs.`);
