import { readFile } from 'node:fs/promises';

// У сервісу ті самі операції Firestore, що в браузері. Для перевірки
// правил підставляємо SDK із npm і окрему авторизовану базу емулятора.
const source = (await readFile(new URL('../../js/meeting_actions.js', import.meta.url), 'utf8'))
    .replace("import { db, currentApt } from './firebase.js';", 'const db = null, currentApt = () => null;')
    .replace('./staff-core.js', new URL('../../js/staff-core.js', import.meta.url).href)
    .replace('https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js', import.meta.resolve('firebase/firestore'))
    .replace('./meeting.js', new URL('../../js/meeting.js', import.meta.url).href);
export const { createMeetingActions } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
