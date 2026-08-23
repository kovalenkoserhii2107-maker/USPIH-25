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
const { onRequest } = require('firebase-functions/v2/https');
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
