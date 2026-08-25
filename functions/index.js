// ============================================================
// Датчик електропостачання ОСББ «Успіх-25».
//
// Фізичний датчик — старий Android у розетці. MacroDroid смикає цей
// вебхук, коли зарядний пристрій підключається (світло є) або
// відключається (світла немає).
//
// Функція пише рівно ті самі поля, що й тумблер правління в застосунку:
//   status/power  → { isOn, changedAt }
//   power_log/*   → { isOn, at }
// тож статистика відключень працює без жодних змін у клієнті.
// ============================================================
const { onRequest, onCall, HttpsError } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const logger = require('firebase-functions/logger');
const admin = require('firebase-admin');

admin.initializeApp();
const db = admin.firestore();
const { FieldValue } = admin.firestore;

// Ключ лежить у Secret Manager, а не в коді: інакше він потрапив би
// в репозиторій разом із функцією.
const POWER_SECRET = defineSecret('POWER_SECRET');

exports.updatePowerStatus = onRequest(
    {
        region: 'europe-central2',   // Варшава — найближчий регіон до Одеси
        secrets: [POWER_SECRET],
        maxInstances: 3              // датчик один; обмеження від несподіваних рахунків
    },
    async (req, res) => {
        if (req.method !== 'GET' && req.method !== 'POST') {
            return res.status(405).send('method not allowed');
        }

        // Ключ приймаємо і в параметрі, і в заголовку. Заголовок кращий:
        // URL цілком потрапляє в журнали Cloud Logging разом із ключем.
        const secret = req.query.secret || (req.body && req.body.secret) || req.get('x-power-secret');
        if (!secret || secret !== POWER_SECRET.value()) {
            logger.warn('Відмовлено: невірний ключ', { ip: req.ip });
            return res.status(403).send('forbidden');
        }

        const raw = String(req.query.state || (req.body && req.body.state) || '').trim().toLowerCase();
        if (raw !== 'on' && raw !== 'off') {
            return res.status(400).send('state must be "on" or "off"');
        }
        const isOn = raw === 'on';

        try {
            const statusRef = db.doc('status/power');

            // Транзакція, а не просто запис.
            //
            // Статистика рахує відключення за ПАРАМИ записів у журналі:
            // кожен запис триває до наступного. Два поспіль «off»
            // (мигнув контакт, MacroDroid повторив запит) дали б два
            // відключення замість одного. Тому пишемо, лише коли стан
            // справді змінився — і заразом робимо вебхук ідемпотентним:
            // повтор того самого запиту нічого не псує.
            const changed = await db.runTransaction(async (tx) => {
                const snap = await tx.get(statusRef);
                const current = snap.exists ? snap.data().isOn !== false : null;
                if (current === isOn) return false;

                tx.set(statusRef, {
                    isOn,
                    changedAt: FieldValue.serverTimestamp(),
                    source: 'sensor'
                }, { merge: true });

                tx.set(db.collection('power_log').doc(), {
                    isOn,
                    at: FieldValue.serverTimestamp(),
                    source: 'sensor'
                });

                return true;
            });

            logger.info(changed ? 'Статус змінено' : 'Стан той самий — запис пропущено',
                        { state: raw, changed });
            return res.status(200).send(changed ? `ok: ${raw}` : `ok: already ${raw}`);
        } catch (e) {
            logger.error('Не вдалося оновити статус світла', e);
            return res.status(500).send('write failed');
        }
    }
);

// ============================================================
// Графік можливих відключень ДТЕК
//
// Забирає сторінку графіків, дістає з неї JSON і кладе у Firestore
// чергу нашого будинку. Застосунок сам цього зробити не може: у
// відповіді ДТЕК немає Access-Control-Allow-Origin.
//
// Номер черги веде правління в налаштуваннях; без нього функція
// нічого не пише — вгадувати чергу за адресою ми не беремося.
// ============================================================
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { URL_SHUTDOWNS, parseSchedule } = require('./dtek');

const SCHEDULE_REGION = 'europe-central2';

async function refreshSchedule() {
    const cfg = await db.doc('osbb_settings/power').get();
    const group = cfg.exists ? cfg.data().dtekGroup : '';
    if (!group) {
        logger.info('Чергу ДТЕК не налаштовано — пропускаємо');
        return { skipped: true };
    }

    const res = await fetch(URL_SHUTDOWNS, {
        headers: {
            // Представляємось чесно: анонімний скребок легко прийняти
            // за атаку й заблокувати, а нам тут жити.
            'User-Agent': 'OSBB-Uspih-25/1.0 (+https://kovalenkoserhii2107-maker.github.io/USPIH-25)',
            'Accept': 'text/html'
        }
    });
    if (!res.ok) throw new Error(`ДТЕК відповів ${res.status}`);

    const parsed = parseSchedule(await res.text());
    if (!parsed) throw new Error('Не вдалося знайти графік у сторінці');

    const week = parsed.week[group];
    if (!week) throw new Error(`Черги ${group} немає у графіку`);

    await db.doc('status/schedule').set({
        group,
        groupName: parsed.names[group] || group,
        week,
        hoursPerWeek: parsed.totals[group] ?? null,
        // Дата з самого ДТЕК: наш час оновлення нічого не каже про те,
        // наскільки свіжий графік — сторінку могли не міняти тижнями.
        sourceUpdated: parsed.updatedText || '',
        fetchedAt: FieldValue.serverTimestamp(),
        source: URL_SHUTDOWNS
    }, { merge: true });

    logger.info('Графік оновлено', { group, hours: parsed.totals[group] });
    return { group, hours: parsed.totals[group] };
}

// Кожні три години: ДТЕК і сам не міняє графік частіше, а зайві
// звернення до чужого сайту — погані манери.
exports.pullDtekSchedule = onSchedule(
    { schedule: 'every 3 hours', timeZone: 'Europe/Kyiv', region: SCHEDULE_REGION, maxInstances: 1 },
    async () => { await refreshSchedule(); }
);

// Ручне оновлення — щоб не чекати три години після зміни черги.
exports.pullDtekScheduleNow = onRequest(
    { region: SCHEDULE_REGION, secrets: [POWER_SECRET], maxInstances: 1 },
    async (req, res) => {
        const key = req.get('X-Api-Key') || req.query.key;
        if (key !== POWER_SECRET.value()) {
            res.status(403).json({ error: 'forbidden' });
            return;
        }
        try {
            res.json({ ok: true, ...(await refreshSchedule()) });
        } catch (e) {
            logger.error('Оновлення графіка:', e);
            res.status(502).json({ error: String(e.message || e) });
        }
    }
);

/**
 * Оновлення на вимогу з панелі правління.
 *
 * Саме onCall, а не вебхук із ключем: інакше ключ довелося б покласти
 * в браузер, звідки його дістає будь-хто. Тут особу підтверджує сам
 * Firebase Auth, а право — прапорець isAdmin у документі квартири.
 */
exports.refreshDtekSchedule = onCall(
    { region: SCHEDULE_REGION, maxInstances: 2 },
    async (request) => {
        const email = request.auth?.token?.email || '';
        const apt = email.split('@')[0];
        if (!apt) throw new HttpsError('unauthenticated', 'Потрібен вхід');

        const snap = await db.doc(`apartments/${apt}`).get();
        if (!snap.exists || snap.data().isAdmin !== true) {
            throw new HttpsError('permission-denied', 'Лише для правління');
        }
        try {
            return await refreshSchedule();
        } catch (e) {
            logger.error('Оновлення графіка на вимогу:', e);
            throw new HttpsError('unavailable', String(e.message || e));
        }
    }
);
