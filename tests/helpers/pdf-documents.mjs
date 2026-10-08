import { readFile } from 'node:fs/promises';

// Завантажуємо справжні PDF builders без браузерних Firebase-адаптерів.
const moduleUrl = new URL('../../js/protocol_pdf.js', import.meta.url);
const meetingUrl = new URL('../../js/meeting.js', import.meta.url).href;
const source = (await readFile(moduleUrl, 'utf8')).replace(
    /^import[\s\S]*?from ['"]([^'"]+)['"];?\n/gm,
    (statement, specifier) => specifier === './meeting.js'
        ? statement.replace(specifier, meetingUrl) : ''
);
export const documents = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
