// Демо-будинок: назва, адреса й коди справжнього ОСББ зашиті в розмітку
// застосунку — у демо показуємо вигаданий будинок «Злагода-17»
// (ті самі, що в scripts/demo/data.mjs). Перемикання ролі — через «Вийти».
const SWAP = [
    [/ОСББ «Успіх-25»/g, 'ОСББ «Злагода-17»'], [/Успіх-25/g, 'Злагода-17'], [/УСПІХ-25/g, 'ЗЛАГОДА-17'],
    [/вулиця Інглезі, будинок 3\/3/g, 'вулиця Каштанова, будинок 7/2'], [/вул\. Інглезі, буд\. 3\/3/g, 'вул. Каштанова, буд. 7/2'],
    [/вул\. Інглезі,? 3\/3/g, 'вул. Каштанова, 7/2'], [/65101/g, '65012'], [/40562894/g, '43185922']
];
const NEEDLE = /Успіх-25|УСПІХ-25|Інглезі|65101|40562894/;
const swap = t => SWAP.reduce((v, [re, to]) => v.replace(re, to), t);
const fix = n => { if (NEEDLE.test(n.nodeValue)) n.nodeValue = swap(n.nodeValue); };

function rebrand(root) {
    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) fix(n);
    root.querySelectorAll?.('[placeholder]').forEach(el => { if (NEEDLE.test(el.placeholder)) el.placeholder = swap(el.placeholder); });
}
function start() {
    document.title = swap(document.title);
    rebrand(document.body);
    new MutationObserver(list => {
        for (const m of list) {
            if (m.type === 'characterData') fix(m.target);
            else for (const n of m.addedNodes) if (n.nodeType === 3) fix(n); else if (n.nodeType === 1) rebrand(n);
        }
    }).observe(document.body, { childList: true, subtree: true, characterData: true });
}
if (document.body) start(); else document.addEventListener('DOMContentLoaded', start);
