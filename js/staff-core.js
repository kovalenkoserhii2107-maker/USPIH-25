// ============================================================
// Ролі правління: хто що може. Без DOM і Firebase — спільне для
// браузера й тестів. Остаточно права перевіряють firestore.rules
// і storage.rules; тут — щоб не показувати недоступне й пояснити
// відмову людською мовою.
// ============================================================
export const ROLES = ['chair', 'board', 'accountant'];
export const ROLE_LABELS = { chair: 'Голова правління', board: 'Член правління', accountant: 'Бухгалтер' };

const RIGHTS = {
    staff: ROLES,                      // будь-хто з команди
    manage: ['chair', 'board'],        // люди й рішення: збори, опитування, довідник
    account: ['chair', 'accountant'],  // гроші й облік: баланси, звіт, лічильники
    chair: ['chair']                   // команда й ролі
};

export const hasRight = (role, right = 'staff') => Boolean(role) && (RIGHTS[right] || []).includes(role);

/** Вкладки панелі правління й право, без якого вкладку не показуємо. */
export const TAB_RIGHTS = {
    overview: 'staff', meetings: 'manage', directory: 'staff', send: 'staff', requests: 'staff',
    docs: 'staff', chat: 'staff', polls: 'manage', finance: 'account', meters: 'account',
    board: 'manage', team: 'staff', journal: 'staff'
};

/**
 * Роль людини з staff/{номер входу}. Старий спільний запис правління
 * (apartments/{номер}.isAdmin) без документа в staff діє як голова —
 * так само, як у правилах.
 */
export async function fetchStaffRole({ doc, getDocFromServer }, database, login) {
    if (!login) return null;
    const staff = await getDocFromServer(doc(database, 'staff', login));
    if (staff.exists()) return staff.data().active === true && ROLES.includes(staff.data().role) ? staff.data().role : null;
    const apartment = await getDocFromServer(doc(database, 'apartments', login));
    return apartment.exists() && apartment.data().isAdmin === true ? 'chair' : null;
}

/** Кидає зрозумілу помилку, якщо в ролі немає потрібного права. */
export function requireRight(role, right, message) {
    if (hasRight(role, right)) return;
    const error = new Error(message || 'Ця дія недоступна для вашої ролі');
    error.code = 'permission-denied';
    throw error;
}
