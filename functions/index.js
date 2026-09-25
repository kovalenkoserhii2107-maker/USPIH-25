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
const { initializeApp } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');

initializeApp();
const db = getFirestore();
const { computeQuorum, meetingSummary, QUORUM_PCT } = require('./meeting-core');

// Ключ лежить у Secret Manager, а не в коді: інакше він потрапив би
// в репозиторій разом із функцією.
const POWER_SECRET = defineSecret('POWER_SECRET');

async function requireAdmin(request) {
    const email = request.auth?.token?.email || '';
    const apt = email.split('@')[0];
    if (!apt) throw new HttpsError('unauthenticated', 'Потрібен вхід');
    const snap = await db.doc(`apartments/${apt}`).get();
    if (!snap.exists || snap.data().isAdmin !== true) {
        throw new HttpsError('permission-denied', 'Лише для правління');
    }
    return apt;
}

function validDocumentId(value) {
    return /^[A-Za-z0-9_-]{1,128}$/.test(value);
}

async function meetingContext(pollId) {
    const pollRef = db.doc(`polls/${pollId}`);
    const [pollSnap, aptSnap, ownerSnap, votesSnap] = await Promise.all([
        pollRef.get(),
        db.collection('apartments').get(),
        db.collectionGroup('owners').get(),
        pollRef.collection('votes').get()
    ]);
    if (!pollSnap.exists || pollSnap.data().isMeeting !== true) {
        throw new HttpsError('not-found', 'Збори не знайдено');
    }
    const ownersByApt = {};
    ownerSnap.forEach(owner => {
        const apt = owner.ref.parent.parent?.id;
        if (apt) (ownersByApt[apt] ||= []).push(owner.data());
    });
    const apartments = aptSnap.docs
        .filter(apartment => apartment.data().isAdmin !== true)
        .map(apartment => ({
            apt: apartment.id,
            area: apartment.data().area || '',
            owners: ownersByApt[apartment.id] || []
        }));
    const votes = votesSnap.docs.map(vote => ({ apt: vote.id, ...vote.data() }));
    return { pollRef, poll: { id: pollId, ...pollSnap.data() }, apartments, votes };
}

function ukDate(value) {
    if (!value) return 'без дати';
    const date = new Date(`${value}T00:00:00`);
    return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleDateString('uk-UA');
}

function resultsMessage(poll, votes, apartments, quorum) {
    const summary = meetingSummary(poll, votes, apartments);
    return {
        title: `Підсумки зборів: ${poll.title || 'Загальні збори'}`,
        body: `Голосування завершено.\n\nРІШЕННЯ\n${summary}\n\nЯВКА\n`
            + `${quorum.hasQuorum ? 'Кворум зібрано' : 'Кворуму немає'} `
            + `(потрібно ${QUORUM_PCT}% власників)\n`
            + `Власники: ${quorum.votedOwners} з ${quorum.totalOwners} — ${quorum.ownersPct}%\n`
            + `Площа: ${quorum.votedArea} з ${quorum.totalArea} м² — ${quorum.areaPct}%\n\n`
            + 'Протокол зборів буде опубліковано в Базі документів ОСББ.',
        targetType: 'all', targetValue: '', recipients: ['all'], attachments: [], linkedDoc: null,
        createdAt: FieldValue.serverTimestamp(), readBy: {}, systemKey: `meeting-results:${poll.id}`
    };
}

exports.finalizeMeeting = onCall(
    { region: 'europe-central2', maxInstances: 4 },
    async request => {
        await requireAdmin(request);
        const pollId = String(request.data?.pollId || '').trim();
        if (!validDocumentId(pollId)) throw new HttpsError('invalid-argument', 'Некоректний ID зборів');

        const pollRef = db.doc(`polls/${pollId}`);
        await db.runTransaction(async tx => {
            const snap = await tx.get(pollRef);
            if (!snap.exists || snap.data().isMeeting !== true) {
                throw new HttpsError('not-found', 'Збори не знайдено');
            }
            if (snap.data().status !== 'closed') {
                tx.update(pollRef, { status: 'closed', closedAt: FieldValue.serverTimestamp() });
            }
        });

        const { poll, apartments, votes } = await meetingContext(pollId);
        const quorum = computeQuorum(votes, apartments);
        const resultMessageRef = db.doc(`messages/meeting-results_${pollId}`);
        const resultMessageSnap = await resultMessageRef.get();
        const message = resultsMessage(poll, votes, apartments, quorum);
        if (resultMessageSnap.exists) {
            delete message.createdAt;
            delete message.readBy;
        }
        const batch = db.batch();
        batch.set(resultMessageRef, message, { merge: true });
        batch.set(pollRef, {
            status: 'closed', quorum, resultsSent: true,
            resultsSentAt: FieldValue.serverTimestamp()
        }, { merge: true });
        await batch.commit();
        logger.info('Збори завершено', { pollId, votes: votes.length, quorum: quorum.ownersPct });
        return { quorum, resultsSent: true };
    }
);

exports.publishMeetingProtocol = onCall(
    { region: 'europe-central2', maxInstances: 4 },
    async request => {
        await requireAdmin(request);
        const pollId = String(request.data?.pollId || '').trim();
        const url = String(request.data?.url || '').trim();
        const fileName = String(request.data?.fileName || '').trim();
        const size = Number(request.data?.size || 0);
        let protocolHost = '';
        try { protocolHost = new URL(url).hostname; } catch { /* перевіряється нижче */ }
        const allowedHost = protocolHost === 'firebasestorage.googleapis.com'
            || protocolHost === 'storage.googleapis.com';
        if (!validDocumentId(pollId) || !allowedHost || fileName !== `Protocol_${pollId}.pdf`
            || size <= 0 || size > 30 * 1024 * 1024) {
            throw new HttpsError('invalid-argument', 'Некоректні дані протоколу');
        }
        const { pollRef, poll, apartments, votes } = await meetingContext(pollId);
        if (poll.status !== 'closed') {
            throw new HttpsError('failed-precondition', 'Спочатку завершіть збори');
        }
        const quorum = computeQuorum(votes, apartments);
        const dateLabel = ukDate(poll.meetingDate);
        const title = `Протокол № ${poll.protocolNumber || '___'} загальних зборів від ${dateLabel}`;
        const summary = meetingSummary(poll, votes, apartments);
        const docId = `protocol_${pollId}`;
        const protocolDocRef = db.doc(`osbb_documents/${docId}`);
        const protocolMessageRef = db.doc(`messages/protocol_${pollId}`);
        const [protocolDocSnap, protocolMessageSnap] = await Promise.all([
            protocolDocRef.get(), protocolMessageRef.get()
        ]);
        const protocolDoc = {
            title, category: 'Протоколи зборів', fileName, url, size,
            type: 'application/pdf', pollId, createdAt: FieldValue.serverTimestamp()
        };
        if (protocolDocSnap.exists) delete protocolDoc.createdAt;
        const protocolMessage = {
            title: `Протокол зборів від ${dateLabel}`,
            body: 'Протокол загальних зборів співвласників сформовано та додано до Бази документів ОСББ.\n\n'
                + `Участь узяли ${quorum.votedOwners} із ${quorum.totalOwners} співвласників `
                + `(${quorum.ownersPct}%), ${quorum.votedArea} із ${quorum.totalArea} м².\n`
                + `${quorum.hasQuorum ? 'Кворум зібрано, збори правомочні.' : 'Кворуму немає, збори неправомочні.'}\n\n`
                + `РІШЕННЯ (голосів співвласників)\n${summary}\n\n`
                + 'Повний текст протоколу — у прикріпленому документі.',
            targetType: 'all', targetValue: '', recipients: ['all'], attachments: [],
            linkedDoc: { name: title, url, type: 'application/pdf', size },
            createdAt: FieldValue.serverTimestamp(), readBy: {}, systemKey: `protocol:${pollId}`
        };
        if (protocolMessageSnap.exists) {
            delete protocolMessage.createdAt;
            delete protocolMessage.readBy;
        }

        const batch = db.batch();
        batch.set(protocolDocRef, protocolDoc, { merge: true });
        batch.set(protocolMessageRef, protocolMessage, { merge: true });
        batch.set(pollRef, {
            status: 'closed', quorum, protocolUrl: url, protocolDocId: docId,
            protocolAt: FieldValue.serverTimestamp(), protocolPublished: true
        }, { merge: true });
        await batch.commit();
        logger.info('Протокол опубліковано', { pollId, docId });
        return { url, title, quorum, docId };
    }
);

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

    let res;
    let lastError;
    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            res = await fetch(URL_SHUTDOWNS, {
                signal: AbortSignal.timeout(12000),
                headers: {
                    'User-Agent': 'OSBB-Uspih-25/1.0 (+https://kovalenkoserhii2107-maker.github.io/USPIH-25)',
                    'Accept': 'text/html'
                }
            });
            if (res.ok || res.status < 500) break;
            throw new Error(`ДТЕК відповів ${res.status}`);
        } catch (error) {
            lastError = error;
            logger.warn('Спроба отримати графік ДТЕК не вдалася', { attempt, error: error.message });
            if (attempt < 3) await new Promise(resolve => setTimeout(resolve, attempt * 500));
        }
    }
    if (!res) throw lastError || new Error('ДТЕК не відповів');
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
    { schedule: 'every 3 hours', timeZone: 'Europe/Kyiv', region: SCHEDULE_REGION, maxInstances: 1,
      timeoutSeconds: 60, retryCount: 2 },
    async () => {
        try {
            await refreshSchedule();
            await db.doc('status/schedule').set({
                lastError: FieldValue.delete(), lastErrorAt: FieldValue.delete()
            }, { merge: true });
        } catch (error) {
            await db.doc('status/schedule').set({
                lastError: String(error.message || error).slice(0, 500),
                lastErrorAt: FieldValue.serverTimestamp()
            }, { merge: true });
            logger.error('Планове оновлення графіка не вдалося', error);
            throw error;
        }
    }
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
        await requireAdmin(request);
        try {
            return await refreshSchedule();
        } catch (e) {
            logger.error('Оновлення графіка на вимогу:', e);
            throw new HttpsError('unavailable', String(e.message || e));
        }
    }
);
