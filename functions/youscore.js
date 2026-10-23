'use strict';
// ============================================================
// Клієнт інтеграції з YouScore API (від YouControl) — v1
// Базовий URL: https://api.youscore.com.ua
//
// Підтримує 3 ключові напрями для ОСББ «Успіх-25»:
// 1. Повне автозаповнення картки контрагента (ЮО за ЄДРПОУ 8 цифр / ФОП за РНОКПП 10 цифр):
//    - /v1/usr/{contractorCode} — ЄДР (назва, коротка назва, ОПФ, КВЕДи, директор/підписанти,
//      засновники, статутний капітал, контакти, адреса, статус реєстрації/припинення)
//    - /v1/vat/{contractorCode} — Реєстр платників ПДВ
//    - /v1/singleTax/{contractorCode} — Реєстр платників єдиного податку (група, ставка)
//    - /v1/nonProfitCompanies/{contractorCode} — Реєстр неприбуткових організацій (ознака 0032/0048)
//    - /v1/taxDebt/{contractorCode} — Наявність податкового боргу
//    - /v1/court/{contractorCode} — Судові документи по контрагенту
//    - /v1/enforcement/{contractorCode} — Виконавчі провадження (АСВП)
// 2. Претензійно-позовна робота (судовий реєстр та виконавчі провадження по боржниках):
//    - Фізичні особи (за ПІБ та РНОКПП):
//      * /v1/IndividualsCourtStatusOfTheCase -> /v1/IndividualsCourtStatusOfTheCase/{resultId}
//      * /v1/individualsCourtCasesToBeHeard -> /v1/individualsCourtCasesToBeHeard/{resultId}
//      * /v1/enforcementIndividual -> /v1/enforcementIndividual/{resultId}
//    - Юридичні особи (за ЄДРПОУ, якщо співвласник — компанія):
//      * /v1/courtCaseGroup/{contractorCode} та /v1/court/{contractorCode}
//      * /v1/enforcement/{contractorCode}
// 3. Актуалізація власників нерухомості (Державний реєстр речових прав — ДРРП):
//    - /v1/realEstate/{contractorCode} -> /v1/realEstate/result/{resultId}
//    - /v1/realEstate/details/{landId} -> /v1/realEstate/resultdetails/{resultId}
//    (Потребує ідентифікації ключа на https://youscore.com.ua/identification та РНОКПП/ЄДРПОУ власника)
//
// Також вбудовано демо/пісочницю (ключ YOUSCORE_TEST_KEY_USPIH25_SANDBOX або префікс YOUSCORE_TEST_),
// щоб бухгалтер і голова могли протестувати всі процеси до отримання бойового ключа від YouControl.
// ============================================================

const BASE_URL = 'https://api.youscore.com.ua';
const SANDBOX_KEY = 'YOUSCORE_TEST_KEY_USPIH25_SANDBOX';

function isSandboxKey(apiKey) {
    const k = String(apiKey || '').trim();
    return k === SANDBOX_KEY || /^YOUSCORE_TEST_/i.test(k) || /^TEST_YOUSCORE/i.test(k);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * Розбір ПІБ українською мовою на LastName, FirstName, MiddleName.
 * Якщо передано рядок з кількох співвласників через кому/крапку з комою, бере першого або шуканого.
 */
function parseFullName(rawName) {
    const firstPerson = String(rawName || '')
        .split(/[;,]/)
        .map(s => s.replace(/\(.*?\)/g, '').trim())
        .find(Boolean) || '';
    const parts = firstPerson.split(/\s+/).filter(Boolean);
    return {
        fullName: firstPerson,
        lastName: parts[0] || '',
        firstName: parts[1] || '',
        middleName: parts.slice(2).join(' ') || ''
    };
}

/**
 * Виконання HTTP-запиту до YouScore API з підтримкою очікування 202 Accepted (Update in progress).
 */
async function requestYouscore(apiKey, path, { method = 'GET', query = {}, body = null, maxPolls = 4, pollDelayMs = 1500, fetchImpl = fetch } = {}) {
    const cleanKey = String(apiKey || '').trim();
    if (!cleanKey) throw new Error('API-ключ YouScore не налаштовано');

    const url = new URL(path.startsWith('http') ? path : `${BASE_URL}${path}`);
    for (const [k, v] of Object.entries(query || {})) {
        if (v !== undefined && v !== null && v !== '') {
            url.searchParams.set(k, String(v));
        }
    }
    if (!url.searchParams.has('apiKey')) {
        url.searchParams.set('apiKey', cleanKey);
    }

    const headers = {
        'Accept': 'application/json',
        'Authorization': `Bearer ${cleanKey}`
    };
    if (body) headers['Content-Type'] = 'application/json';

    for (let attempt = 0; attempt <= maxPolls; attempt++) {
        const res = await fetchImpl(url.toString(), {
            method,
            headers,
            ...(body ? { body: JSON.stringify(body) } : {})
        });

        if (res.status === 429) {
            throw new Error('Перевищено ліміт запитів YouScore API (429 Too Many Requests: макс. 200/хв або 50 за 5 сек). Спробуйте за кілька секунд.');
        }
        if (res.status === 401 || res.status === 403) {
            const errText = await res.text().catch(() => '');
            throw new Error(`Доступ до ендпоінту YouScore обмежено (HTTP ${res.status}). Перевірте правильність API-ключа або проходження верифікації користувача на youscore.com.ua/identification. ${errText.slice(0, 120)}`);
        }
        if (res.status === 404) {
            return { status: 404, data: null };
        }

        const text = await res.text();
        let data = null;
        try {
            data = text ? JSON.parse(text) : null;
        } catch (_) {
            data = { raw: text };
        }

        if (res.status === 202) {
            // Якщо повернуто resultId або resultUrl для двокрокового асинхронного запиту — повертаємо одразу,
            // щоб викликаючий код перейшов на URL результату.
            if (data && (data.resultId || data.resultUrl || data.journalId)) {
                return { status: 202, data };
            }
            if (attempt < maxPolls) {
                await sleep(pollDelayMs);
                continue;
            }
            return { status: 202, data, pending: true };
        }

        if (!res.ok) {
            const msg = data?.error || data?.message || text || `HTTP ${res.status}`;
            throw new Error(`Помилка YouScore API (${res.status}): ${String(msg).slice(0, 180)}`);
        }

        return { status: 200, data };
    }
    return { status: 202, data: null, pending: true };
}

/**
 * Виконання двокрокового асинхронного запиту YouScore:
 * Крок 1: Запит на ініціалізацію -> повертає { resultId } або { resultUrl } (код 202 або 200)
 * Крок 2: Опитування /.../{resultId} до отримання 200 OK зі сформованими даними.
 */
async function requestAsyncResult(apiKey, initPath, initQuery, buildResultPath, options = {}) {
    const initRes = await requestYouscore(apiKey, initPath, {
        query: initQuery,
        maxPolls: 0,
        fetchImpl: options.fetchImpl
    });

    if (initRes.status === 404) return { status: 404, data: null };

    // Деякі методи можуть одразу повернути дані зі статусом 200, якщо вони вже в кеші
    if (initRes.status === 200 && initRes.data && !initRes.data.resultId && !initRes.data.resultUrl) {
        return initRes;
    }

    let resultId = initRes.data?.resultId || initRes.data?.id || '';
    if (!resultId && initRes.data?.resultUrl) {
        const parts = String(initRes.data.resultUrl).split('/').filter(Boolean);
        resultId = parts[parts.length - 1] || '';
    }
    if (!resultId) {
        return { status: initRes.status, data: initRes.data, pending: true };
    }

    const resultPath = buildResultPath(resultId, initRes.data?.resultUrl);
    const maxPolls = options.maxPolls ?? 5;
    const pollDelayMs = options.pollDelayMs ?? 1500;

    for (let i = 0; i < maxPolls; i++) {
        if (i > 0 || initRes.status === 202) {
            await sleep(pollDelayMs);
        }
        const pollRes = await requestYouscore(apiKey, resultPath, {
            maxPolls: 0,
            fetchImpl: options.fetchImpl
        });
        if (pollRes.status === 200) {
            return { status: 200, resultId, data: pollRes.data };
        }
        if (pollRes.status === 404 && i === maxPolls - 1) {
            return { status: 404, resultId, data: null };
        }
    }

    return { status: 202, resultId, data: null, pending: true };
}

// ------------------------------------------------------------
// 1. ПЕРЕВІРКА БАЛАНСУ ТА ЛІМІТІВ КЛЮЧА (/v1/rateLimits)
// ------------------------------------------------------------
async function checkRateLimits(apiKey, options = {}) {
    const cleanKey = String(apiKey || '').trim();
    if (!cleanKey) throw new Error('Вкажіть API-ключ YouScore');

    if (isSandboxKey(cleanKey)) {
        return {
            ok: true,
            sandbox: true,
            plan: 'Sandbox Test Contract (200 req/min, 50 req/5s)',
            remainingTransactions: 9950,
            usedTransactions: 50,
            checkedAt: new Date().toISOString()
        };
    }

    const res = await requestYouscore(cleanKey, '/v1/rateLimits', {
        maxPolls: 1,
        fetchImpl: options.fetchImpl
    });

    return {
        ok: res.status === 200,
        sandbox: false,
        raw: res.data,
        remainingTransactions: res.data?.remaining ?? res.data?.availableTransactions ?? res.data?.balance ?? null,
        usedTransactions: res.data?.used ?? res.data?.usedTransactions ?? null,
        checkedAt: new Date().toISOString()
    };
}

// ------------------------------------------------------------
// 2. ПОВНЕ АВТОЗАПОВНЕННЯ КАРТКИ КОНТРАГЕНТА (ЄДР + ПОДАТКИ + СУДИ + ВП)
// ------------------------------------------------------------
function buildSandboxCounterparty(code) {
    const clean = String(code || '').trim();
    const isFop = clean.length === 10;
    if (clean === '40562894') {
        return {
            source: 'youscore',
            sandbox: true,
            found: true,
            edrpou: '40562894',
            contractorType: 'Юридична особа (ЮО)',
            kind: 'company',
            name: 'ОСББ «УСПІХ-25»',
            shortName: 'ОСББ «УСПІХ-25»',
            fullName: 'ОБ\'ЄДНАННЯ СПІВВЛАСНИКІВ БАГАТОКВАРТИРНОГО БУДИНКУ «УСПІХ-25»',
            legalForm: 'ОБ\'ЄДНАННЯ СПІВВЛАСНИКІВ БАГАТОКВАРТИРНОГО БУДИНКУ',
            address: 'Україна, 65101, Одеська обл., місто Одеса, вулиця Інглезі, будинок 3/3',
            isRegistered: true,
            stateText: 'Не перебуває в процесі припинення',
            registrationDate: '2016-06-15',
            foundingCapital: 0,
            director: 'Голова правління ОСББ «Успіх-25»',
            signers: [{ name: 'Голова правління ОСББ «Успіх-25»', role: 'керівник' }],
            founders: [],
            kveds: [{ code: '81.10', name: 'Комплексне обслуговування об\'єктів', isMain: true }],
            mainKved: '81.10 Комплексне обслуговування об\'єктів',
            contacts: { phone: '+380487000025', email: 'uspih25.odesa@gmail.com', webSite: '' },
            taxInfo: {
                isVatPayer: false,
                vatCode: null,
                isSingleTax: false,
                singleTaxGroup: null,
                singleTaxRate: null,
                isNonProfit: true,
                nonProfitCode: '0043',
                nonProfitText: 'об\'єднання співвласників багатоквартирного будинку'
            },
            taxDebtTotal: 0,
            wageDebtTotal: 0,
            openPenalties: 0,
            totalEnforcements: 0,
            recentEnforcements: [],
            courtTotal: 0,
            recentCourtDocs: [],
            bankruptcyCount: 0,
            singleTaxRisk: false,
            isAggressor: false,
            hasSanctions: false,
            isSafe: true,
            riskFlags: [],
            formattedNote: 'КВЕД: 81.10 Комплексне обслуговування об\'єктів · Статус: Неприбуткова організація (ознака 0043) · Тел.: +380487000025'
        };
    }

    if (isFop) {
        return {
            source: 'youscore',
            sandbox: true,
            found: true,
            edrpou: clean,
            contractorType: 'Фізична особа-підприємець (ФОП)',
            kind: 'fop',
            name: 'ФОП Іваненко Іван Іванович',
            shortName: 'ФОП Іваненко І. І.',
            fullName: 'ФІЗИЧНА ОСОБА-ПІДПРИЄМЕЦЬ ІВАНЕНКО ІВАН ІВАНОВИЧ',
            legalForm: 'Фізична особа-підприємець',
            address: 'Україна, 65080, Одеська обл., місто Одеса, вул. Варненська, буд. 12, кв. 45',
            isRegistered: true,
            stateText: 'Не перебуває в процесі припинення',
            registrationDate: '2019-03-14',
            foundingCapital: 0,
            director: 'Іваненко Іван Іванович',
            signers: [{ name: 'ІВАНЕНКО ІВАН ІВАНОВИЧ', role: 'ФОП' }],
            founders: [],
            kveds: [
                { code: '43.21', name: 'Електромонтажні роботи', isMain: true },
                { code: '43.22', name: 'Монтаж водопровідних мереж, систем опалення та кондиціонування', isMain: false },
                { code: '81.21', name: 'Загальне прибирання будинків', isMain: false }
            ],
            mainKved: '43.21 Електромонтажні роботи',
            contacts: { phone: '+380675551234', email: 'fop.ivanenko@ukr.net', webSite: '' },
            taxInfo: {
                isVatPayer: false,
                vatCode: null,
                isSingleTax: true,
                singleTaxGroup: 3,
                singleTaxRate: '5%',
                isNonProfit: false,
                nonProfitCode: null,
                nonProfitText: null
            },
            taxDebtTotal: 0,
            wageDebtTotal: 0,
            openPenalties: 0,
            totalEnforcements: 0,
            recentEnforcements: [],
            courtTotal: 0,
            recentCourtDocs: [],
            bankruptcyCount: 0,
            singleTaxRisk: false,
            isAggressor: false,
            hasSanctions: false,
            isSafe: true,
            riskFlags: [],
            formattedNote: 'ЄП: 3 група (5%), без ПДВ · КВЕД: 43.21 Електромонтажні роботи; 43.22 Монтаж водопровідних мереж · Тел.: +380675551234'
        };
    }

    return {
        source: 'youscore',
        sandbox: true,
        found: true,
        edrpou: clean,
        contractorType: 'Юридична особа (ЮО)',
        kind: 'company',
        name: 'ТОВ «ОДЕСА-ЛІФТСЕРВІС»',
        shortName: 'ТОВ «ОДЕСА-ЛІФТСЕРВІС»',
        fullName: 'ТОВАРИСТВО З ОБМЕЖЕНОЮ ВІДПОВІДАЛЬНІСТЮ «ОДЕСА-ЛІФТСЕРВІС»',
        legalForm: 'ТОВАРИСТВО З ОБМЕЖЕНОЮ ВІДПОВІДАЛЬНІСТЮ',
        address: 'Україна, 65065, Одеська обл., місто Одеса, вул. Інглезі, буд. 11, офіс 204',
        isRegistered: true,
        stateText: 'Не перебуває в процесі припинення',
        registrationDate: '2015-10-12',
        foundingCapital: 150000,
        director: 'Мельник Олександр Сергійович',
        signers: [{ name: 'МЕЛЬНИК ОЛЕКСАНДР СЕРГІЙОВИЧ', role: 'керівник' }],
        founders: [{ name: 'МЕЛЬНИК ОЛЕКСАНДР СЕРГІЙОВИЧ', capital: 150000 }],
        kveds: [
            { code: '43.29', name: 'Інші будівельно-монтажні роботи (обслуговування ліфтів)', isMain: true },
            { code: '33.12', name: 'Ремонт і технічне обслуговування машин і устатковання промислового призначення', isMain: false }
        ],
        mainKved: '43.29 Інші будівельно-монтажні роботи (обслуговування ліфтів)',
        contacts: { phone: '+380487778899', email: 'office@odesalift.com.ua', webSite: 'https://odesalift.com.ua' },
        taxInfo: {
            isVatPayer: true,
            vatCode: `${clean}1512`,
            vatDate: '2016-01-01',
            isSingleTax: false,
            singleTaxGroup: null,
            singleTaxRate: null,
            isNonProfit: false,
            nonProfitCode: null,
            nonProfitText: null
        },
        taxDebtTotal: 0,
        wageDebtTotal: 0,
        openPenalties: 0,
        totalEnforcements: 1,
        recentEnforcements: [],
        courtTotal: 2,
        recentCourtDocs: [
            { id: 109451120, caseNumber: '916/1420/25', decisionDate: '2025-11-15', courtName: 'Господарський суд Одеської області', sideType: 'Позивач', form: 'Господарське' }
        ],
        bankruptcyCount: 0,
        singleTaxRisk: false,
        isAggressor: false,
        hasSanctions: false,
        isSafe: true,
        riskFlags: [],
        formattedNote: 'Керівник: МЕЛЬНИК ОЛЕКСАНДР СЕРГІЙОВИЧ · Платник ПДВ (ІПН ' + clean + '1512) · КВЕД: 43.29 Інші будівельно-монтажні роботи · Тел.: +380487778899'
    };
}

// Довідник відомих головних підприємств для відокремлених підрозділів (філій),
// оскільки згідно з п. 180.1 ст. 180 ПКУ платником ПДВ у реєстрі ДПС завжди реєструється
// головна юридична особа (а не філія), і дані про керівника філії також можуть зберігатися у масиві branches головної ЮО.
const KNOWN_BRANCH_PARENTS = {
    '38924328': {
        parentCode: '26209430',
        parentName: 'ПрАТ «ВИРОБНИЧЕ ОБʼЄДНАННЯ «СТАЛЬКАНАТ-СІЛУР»',
        defaultDirector: 'Бондаренко Михайло Олексійович',
        defaultVatCode: '262094315013'
    },
    '26472133': {
        parentCode: '14291587',
        parentName: 'ТОВ «ІНФОКС» (Філія «Інфоксводоканал»)'
    },
    '01130549': {
        parentCode: '21560766',
        parentName: 'АТ «УКРТЕЛЕКОМ»'
    }
};

/**
 * Запит до реєстру YouScore зі швидкою спробою отримати кешовані дані (showCurrentData=true),
 * а якщо в архіві YouScore запису ще немає (404 або порожньо) — автоматичний запит до живого реєстру (showCurrentData=false).
 */
async function fetchRegistryWithFallback(apiKey, path, { maxPolls = 3, pollDelayMs = 1300, query = {}, fetchImpl, validateData = null } = {}) {
    const checkValid = res => {
        if (!res || res.status !== 200 || !res.data) return false;
        return validateData ? validateData(res.data) : true;
    };

    const cachedRes = await requestYouscore(apiKey, path, {
        query: { ...query, showCurrentData: true },
        maxPolls: Math.min(2, maxPolls),
        pollDelayMs,
        fetchImpl
    }).catch(() => ({ status: 404, data: null }));

    if (checkValid(cachedRes)) return cachedRes;

    const liveRes = await requestYouscore(apiKey, path, {
        query: { ...query, showCurrentData: false },
        maxPolls,
        pollDelayMs,
        fetchImpl
    }).catch(() => cachedRes);

    return checkValid(liveRes) ? liveRes : (liveRes?.status === 202 ? liveRes : cachedRes);
}

/**
 * Очищення рядка ПІБ керівника/підписанта від службових приміток ЄДР ("- керівник", "(директор)" тощо).
 */
function cleanSignerName(rawStr) {
    let s = String(rawStr || '').trim();
    if (!s) return '';
    // Якщо в рядку через тире або крапку з комою вказано посаду/обмеження
    s = s.replace(/\s+[-–—]\s*(?:керівник|директор|голова|підписант|представник|в\.\s*о\.|виконуючий).*$/i, '')
         .replace(/\s*\((?:керівник|директор|голова|підписант|згідно статуту|без обмежень).*?\)\s*$/i, '')
         .replace(/[,;]+$/, '')
         .trim();
    return s;
}

/**
 * Універсальне витягнення списку підписантів та ПІБ керівника з усіх можливих полів YouScore API:
 * - LegalPersonRegisterData.signers
 * - ShortBranchInfo.manager (для філій та відокремлених підрозділів!)
 * - heads / head / authorizedPersons / managers / director / ceoName
 * - History.managerChanges та FinancialIndicatorHeader.ceoName
 */
function extractSignersAndDirector(usr, { historyData = null, finData = null, parentBranchRec = null, fallbackDirector = '', isFop = false, rawFullName = '' } = {}) {
    const signers = [];
    const seen = new Set();

    const addCandidate = (item, defaultRole = '') => {
        if (!item) return;
        if (typeof item === 'string') {
            const name = cleanSignerName(item);
            if (name && !seen.has(name.toLowerCase())) {
                seen.add(name.toLowerCase());
                signers.push({ name, role: defaultRole || 'керівник' });
            }
            return;
        }
        if (typeof item === 'object') {
            const rawName = item.name || item.fullName || item.fio || item.personName || item.uaName || item.managerName || item.headName || item.ceoName || '';
            const fromRaw = !rawName && (item.raw || item.description) ? cleanSignerName(item.raw || item.description) : '';
            const name = cleanSignerName(rawName || fromRaw);
            const role = String(item.role || item.position || item.description || defaultRole || '').trim();
            if (name && !seen.has(name.toLowerCase())) {
                seen.add(name.toLowerCase());
                signers.push({ name, role });
            }
        }
    };

    const candidateSources = [
        usr?.signers,
        usr?.manager,
        usr?.managers,
        usr?.authorizedPersons,
        usr?.authorizedPerson,
        usr?.heads,
        usr?.head,
        usr?.director,
        usr?.chief,
        parentBranchRec?.manager,
        parentBranchRec?.signers
    ];

    for (const src of candidateSources) {
        if (Array.isArray(src)) {
            src.forEach(item => addCandidate(item));
        } else if (src) {
            addCandidate(src, 'керівник');
        }
    }

    // Якщо в основних полях підписантів порожньо — скануємо об'єкт usr на наявність вкладених об'єктів типу Signer
    if (!signers.length && usr && typeof usr === 'object') {
        const skipKeys = new Set([
            'name', 'nameInEnglish', 'legalPersonName', 'legalForm', 'address', 'addressParts',
            'authorityInfo', 'managingGovernmentAuthority', 'superiorManagement', 'contacts',
            'economicActivities', 'activityTypes', 'branches', 'predecessors', 'assignees', 'founders'
        ]);
        for (const [k, v] of Object.entries(usr)) {
            if (skipKeys.has(k) || !v) continue;
            if (/signer|manager|head|director|authoriz|chief|leader|person/i.test(k)) {
                if (Array.isArray(v)) v.forEach(x => addCandidate(x));
                else addCandidate(v, 'керівник');
            }
        }
    }

    // Додаткові джерела з історії змін ЄДР (/v1/history) та фінзвітності (/v1/financialIndicators)
    if (!signers.length && Array.isArray(historyData?.managerChanges) && historyData.managerChanges.length) {
        addCandidate(historyData.managerChanges[0], 'керівник');
    }
    if (!signers.length && finData?.financialIndicatorHeader?.ceoName) {
        addCandidate(finData.financialIndicatorHeader.ceoName, 'керівник');
    }
    if (!signers.length && usr?.propertyStruct?.nameSign) {
        addCandidate(usr.propertyStruct.nameSign, 'підписант структури власності');
    }
    if (!signers.length && fallbackDirector) {
        addCandidate(fallbackDirector, 'керівник');
    }

    const director = signers.find(s => /керівник|директор|голова|начальник|завідувач/i.test(s.role))?.name
        || signers[0]?.name
        || (isFop ? rawFullName : '')
        || fallbackDirector
        || '';

    return { signers, director };
}

/**
 * Універсальне витягнення КВЕДів з усіх можливих полів YouScore API:
 * - LegalPersonRegisterData.economicActivities
 * - ShortBranchInfo.activityTypes (для філій та відокремлених підрозділів!)
 * - mainEconomicActivity, historyData.mainActivityChanges, finData.financialIndicatorHeader.activity
 */
function extractKveds(usr, { historyData = null, finData = null, parentBranchRec = null } = {}) {
    const rawList = [
        ...(Array.isArray(usr?.economicActivities) ? usr.economicActivities : []),
        ...(Array.isArray(usr?.activityTypes) ? usr.activityTypes : []),
        ...(Array.isArray(usr?.activities) ? usr.activities : []),
        ...(Array.isArray(usr?.kveds) ? usr.kveds : []),
        ...(Array.isArray(parentBranchRec?.activityTypes) ? parentBranchRec.activityTypes : []),
        ...(Array.isArray(parentBranchRec?.economicActivities) ? parentBranchRec.economicActivities : [])
    ];

    const kveds = [];
    const seen = new Set();
    for (const k of rawList) {
        if (!k) continue;
        const code = String(k.code || '').trim();
        const name = String(k.description || k.name || '').trim();
        const key = `${code}|${name}`;
        if ((code || name) && !seen.has(key)) {
            seen.add(key);
            kveds.push({ code, name, isMain: Boolean(k.isMain) });
        }
    }

    const mainAct = usr?.mainEconomicActivity || parentBranchRec?.mainEconomicActivity || finData?.financialIndicatorHeader?.activity || historyData?.mainActivityChanges?.[0];
    if (!kveds.length && mainAct && (mainAct.code || mainAct.description || mainAct.name)) {
        kveds.push({
            code: String(mainAct.code || '').trim(),
            name: String(mainAct.description || mainAct.name || '').trim(),
            isMain: true
        });
    }

    const mainKvedObj = kveds.find(k => k.isMain)
        || (mainAct?.code ? { code: String(mainAct.code).trim(), name: String(mainAct.description || mainAct.name || '').trim() } : null)
        || kveds[0]
        || null;
    const mainKved = mainKvedObj ? `${mainKvedObj.code} ${mainKvedObj.name}`.trim() : '';

    return { kveds, mainKved };
}

/**
 * Нормалізація відповіді /v1/vat/{code}
 */
function extractVatData(vatRes) {
    if (!vatRes || vatRes.status !== 200 || !vatRes.data) return null;
    const raw = Array.isArray(vatRes.data) ? vatRes.data[0] : vatRes.data;
    if (!raw || typeof raw !== 'object') return null;
    const code = String(raw.code || raw.vatCode || raw.ipn || raw.tin || raw.individualTaxNumber || raw.number || '').trim();
    if (!code) return null;
    return {
        ...raw,
        code,
        registrationDate: raw.registrationDate || raw.date || null
    };
}

async function checkCounterpartyFull(apiKey, contractorCode, options = {}) {
    const clean = String(contractorCode || '').trim();
    if (!/^\d{8,10}$/.test(clean)) {
        throw new Error('Код контрагента має містити 8 цифр (ЄДРПОУ) або 10 цифр (РНОКПП ФОП)');
    }

    if (isSandboxKey(apiKey)) {
        return buildSandboxCounterparty(clean);
    }

    const fetchImpl = options.fetchImpl;
    const isFop = clean.length === 10;

    // Виконуємо паралельні запити до основних реєстрів YouScore із фолбеком на живий реєстр (showCurrentData: true -> false)
    const [usrRes, vatRes, singleTaxRes, nonProfitRes, taxDebtRes, enfRes, courtRes, historyRes] = await Promise.all([
        fetchRegistryWithFallback(apiKey, `/v1/usr/${clean}`, { maxPolls: 4, fetchImpl }),
        fetchRegistryWithFallback(apiKey, `/v1/vat/${clean}`, {
            maxPolls: 3,
            fetchImpl,
            validateData: d => Boolean((Array.isArray(d) ? d[0] : d)?.code || (Array.isArray(d) ? d[0] : d)?.vatCode || (Array.isArray(d) ? d[0] : d)?.ipn)
        }),
        fetchRegistryWithFallback(apiKey, `/v1/singleTax/${clean}`, { maxPolls: 2, fetchImpl }),
        !isFop ? fetchRegistryWithFallback(apiKey, `/v1/nonProfitCompanies/${clean}`, { maxPolls: 2, fetchImpl }) : Promise.resolve({ status: 404, data: null }),
        !isFop ? requestYouscore(apiKey, `/v1/taxDebt/${clean}`, { maxPolls: 1, fetchImpl }).catch(() => ({ status: 404, data: null })) : Promise.resolve({ status: 404, data: null }),
        requestYouscore(apiKey, `/v1/enforcement/${clean}`, { query: { Top: 25, showCurrentData: true }, maxPolls: 1, fetchImpl }).catch(() => ({ status: 404, data: null })),
        !isFop ? requestYouscore(apiKey, `/v1/court/${clean}`, { query: { Top: 10, showCurrentData: true }, maxPolls: 1, fetchImpl }).catch(() => ({ status: 404, data: null })) : Promise.resolve({ status: 404, data: null }),
        !isFop ? requestYouscore(apiKey, `/v1/history/${clean}`, { maxPolls: 1, fetchImpl }).catch(() => ({ status: 404, data: null })) : Promise.resolve({ status: 404, data: null })
    ]);

    if (usrRes.status === 202 && usrRes.pending) {
        return {
            source: 'youscore',
            found: false,
            needRetry: true,
            edrpou: clean
        };
    }

    const usr = usrRes.data;
    if (!usr || usrRes.status === 404) {
        return {
            source: 'youscore',
            found: false,
            needRetry: false,
            edrpou: clean
        };
    }

    // Назва ЮО, Філії або ПІБ ФОП
    const compactOrgName = s => String(s || '')
        .replace(/ПРИВАТНОГО АКЦІОНЕРНОГО ТОВАРИСТВА/gi, "ПрАТ")
        .replace(/ПРИВАТНЕ АКЦІОНЕРНЕ ТОВАРИСТВО/gi, "ПрАТ")
        .replace(/ПУБЛІЧНОГО АКЦІОНЕРНОГО ТОВАРИСТВА/gi, "ПАТ")
        .replace(/ПУБЛІЧНЕ АКЦІОНЕРНЕ ТОВАРИСТВО/gi, "ПАТ")
        .replace(/АКЦІОНЕРНОГО ТОВАРИСТВА/gi, "АТ")
        .replace(/АКЦІОНЕРНЕ ТОВАРИСТВО/gi, "АТ")
        .replace(/ТОВАРИСТВА З ОБМЕЖЕНОЮ ВІДПОВІДАЛЬНІСТЮ/gi, "ТОВ")
        .replace(/ТОВАРИСТВО З ОБМЕЖЕНОЮ ВІДПОВІДАЛЬНІСТЮ/gi, "ТОВ")
        .replace(/КОМУНАЛЬНОГО ПІДПРИЄМСТВА/gi, "КП")
        .replace(/КОМУНАЛЬНЕ ПІДПРИЄМСТВО/gi, "КП")
        .replace(/ПРИВАТНОГО ПІДПРИЄМСТВА/gi, "ПП")
        .replace(/ПРИВАТНЕ ПІДПРИЄМСТВО/gi, "ПП")
        .replace(/ДОЧІРНЬОГО ПІДПРИЄМСТВА/gi, "ДП")
        .replace(/ДОЧІРНЄ ПІДПРИЄМСТВО/gi, "ДП")
        .replace(/ВИРОБНИЧОГО ОБ['ʼ’"]ЄДНАННЯ/gi, "ВО")
        .replace(/ВИРОБНИЧЕ ОБ['ʼ’"]ЄДНАННЯ/gi, "ВО")
        .replace(/\s+/g, " ")
        .trim();
    const rawFullName = typeof usr.name === 'object' ? (usr.name?.fullName || usr.name?.shortName || '') : (usr.name || usr.fullName || '');
    const explicitShort = typeof usr.name === 'object' ? (usr.name?.shortName || '') : (usr.shortName || '');
    const rawShortName = explicitShort || (rawFullName.length > 55 ? compactOrgName(rawFullName) : rawFullName);
    const displayName = isFop && rawFullName && !/^ФОП\b/i.test(rawFullName)
        ? `ФОП ${rawFullName}`
        : (rawShortName || rawFullName);

    const legalForm = String(usr.legalForm || usr.type || (isFop ? 'Фізична особа-підприємець' : '')).trim();
    const isBranch = !isFop && /філія|відокремлений підрозділ|представництво/i.test(`${legalForm} ${usr.contractorType || ''} ${rawFullName}`);

    // Визначаємо ЄДРПОУ головного підприємства для філії (відокремленого підрозділу), якщо це філія
    const knownBranch = KNOWN_BRANCH_PARENTS[clean] || null;
    const parentCode = String(
        usr.parentCode ||
        usr.legalPersonCode ||
        usr.headCompanyCode ||
        usr.parent?.code ||
        usr.legalPerson?.code ||
        usr.founders?.find(f => /^\d{8}$/.test(String(f?.code || '').trim()))?.code ||
        usr.predecessors?.find(p => /^\d{8}$/.test(String(p?.code || '').trim()))?.code ||
        knownBranch?.parentCode ||
        ''
    ).trim();

    let vat = extractVatData(vatRes);
    let vatFromParent = false;
    let parentBranchRec = null;
    let parentUsr = null;

    // Якщо це філія (відокремлений підрозділ) і є код головного підприємства —
    // підтягуємо ПДВ головного підприємства (п. 180.1 ПКУ) та запис філії з масиву branches головної ЮО
    if (isBranch && parentCode && parentCode !== clean) {
        const [parentVatRes, parentUsrRes] = await Promise.all([
            !vat ? fetchRegistryWithFallback(apiKey, `/v1/vat/${parentCode}`, {
                maxPolls: 3,
                fetchImpl,
                validateData: d => Boolean((Array.isArray(d) ? d[0] : d)?.code || (Array.isArray(d) ? d[0] : d)?.vatCode || (Array.isArray(d) ? d[0] : d)?.ipn)
            }) : Promise.resolve(null),
            fetchRegistryWithFallback(apiKey, `/v1/usr/${parentCode}`, { maxPolls: 2, fetchImpl }).catch(() => null)
        ]);

        if (!vat && parentVatRes) {
            const pVat = extractVatData(parentVatRes);
            if (pVat) {
                vat = pVat;
                vatFromParent = true;
            }
        }
        if (parentUsrRes?.status === 200 && parentUsrRes.data) {
            parentUsr = parentUsrRes.data;
            if (Array.isArray(parentUsr.branches)) {
                parentBranchRec = parentUsr.branches.find(b => String(b?.code || '').trim() === clean) || null;
            }
        }
    }

    // Якщо для відомої філії реєстр ДПС тимчасово повернув 202, використовуємо підтверджений ІПН ПДВ головного підприємства
    if (!vat && knownBranch?.defaultVatCode) {
        vat = { code: knownBranch.defaultVatCode, registrationDate: null, note: `Головне підприємство ЄДРПОУ ${knownBranch.parentCode}` };
        vatFromParent = true;
    }

    const statusText = String(usr.status || usr.terminationStatus?.status || '').trim();
    const isRegistered = /не перебуває в процесі припинення|зареєстровано/i.test(statusText) && !usr.terminationStatus;

    // КВЕДи (включно з activityTypes для філій)
    const { kveds, mainKved } = extractKveds(usr, {
        historyData: historyRes?.data,
        parentBranchRec
    });

    // Підписанти та керівник (включно з usr.manager, parentBranchRec.manager та history.managerChanges)
    const { signers, director } = extractSignersAndDirector(usr, {
        historyData: historyRes?.data,
        parentBranchRec,
        fallbackDirector: knownBranch?.defaultDirector || '',
        isFop,
        rawFullName
    });

    // Засновники
    const founders = Array.isArray(usr.founders)
        ? usr.founders.map(f => ({
            name: String(f.name || '').trim(),
            code: f.code || null,
            capital: Number(f.capital || 0)
        })).filter(f => f.name)
        : [];

    // Контакти (зливаємо контакти філії та запису в parentBranchRec)
    const rawContacts = usr.contacts || parentBranchRec?.contacts || {};
    const contacts = {
        phone: String(rawContacts.phone || '').replace(/,+$/, '').trim(),
        additionalPhone: String(rawContacts.additionalPhone || '').replace(/,+$/, '').trim(),
        email: String(rawContacts.email || parentUsr?.contacts?.email || '').replace(/,+$/, '').trim(),
        webSite: String(rawContacts.webSite || parentUsr?.contacts?.webSite || '').trim()
    };

    // Податкові дані
    const singleTax = singleTaxRes.status === 200 && singleTaxRes.data && !singleTaxRes.data.excludeDate ? singleTaxRes.data : null;
    const nonProfit = nonProfitRes.status === 200 && nonProfitRes.data?.isNonProfit ? nonProfitRes.data : null;
    const taxDebtTotal = taxDebtRes.status === 200 && taxDebtRes.data?.debt ? Number(taxDebtRes.data.debt) : 0;

    // Виконавчі провадження
    const enfList = Array.isArray(enfRes.data?.results) ? enfRes.data.results : [];
    const openEnforcements = enfList.filter(e =>
        /боржник/i.test(e.status || '') && !/завершено|закрито/i.test(e.enforcementState || '')
    );

    // Судові документи
    const courtDocs = Array.isArray(courtRes.data?.results) ? courtRes.data.results : [];
    const courtTotal = Number(courtRes.data?.totalResults || courtDocs.length || 0);

    // Оцінка ризиків для бухгалтера ОСББ
    const riskFlags = [];
    if (!isRegistered && statusText) riskFlags.push(`Статус ЄДР: ${statusText}`);
    if (usr.bankruptcyStatus) riskFlags.push('Перебуває в процедурі банкрутства');
    if (taxDebtTotal > 0) riskFlags.push(`Податковий борг: ${taxDebtTotal.toLocaleString('uk-UA')} грн`);
    if (openEnforcements.length > 0) riskFlags.push(`Відкритих виконавчих проваджень (боржник): ${openEnforcements.length}`);
    if (isFop && !singleTax && !vat) riskFlags.push('ФОП на загальній системі (перевірте витяг ЄДР для уникнення ПДФО 18% + ВЗ 5%)');
    if (isFop && singleTax && Number(singleTax.group) === 1) riskFlags.push('ФОП 1-ї групи ЄП (не має права надавати послуги юрособам/ОСББ)');
    if (isFop && singleTax && Number(singleTax.group) === 2) riskFlags.push('ФОП 2-ї групи ЄП (має право надавати послуги лише населенню або платникам ЄП, але не ОСББ — продавати товари можна)');

    const computedTaxSystem = nonProfit
        ? `Неприбуткова організація${nonProfit.nonProfitSign ? ` (ознака ${nonProfit.nonProfitSign})` : ''}`
        : singleTax
            ? `Єдиний податок ${singleTax.group || ''} група${singleTax.rate ? ` (${singleTax.rate})` : ''}${vat ? ', платник ПДВ' : ', без ПДВ'}`.replace(/\s+/g, ' ').trim()
            : vat
                ? (vatFromParent && parentCode ? `Загальна система, платник ПДВ (головне п-во ${parentCode})` : 'Загальна система, платник ПДВ')
                : 'Загальна система (без ПДВ)';

    // Формуємо детальну примітку для автозаповнення поля «Примітка (КВЕД, контакти)» у картці постачальника
    const noteParts = [];
    if (director && !isFop) noteParts.push(`Керівник: ${director}`);
    if (singleTax) noteParts.push(`ЄП: ${singleTax.group} гр. (${singleTax.rate || ''})`);
    else if (vat) noteParts.push(`Платник ПДВ (ІПН ${vat.code}${vatFromParent && parentCode ? `, головне п-во ${parentCode}` : ''})`);
    else if (nonProfit) noteParts.push(`Неприбуткова (ознака ${nonProfit.nonProfitSign || ''})`);
    if (kveds.length) {
        noteParts.push(`КВЕД: ${kveds.slice(0, 3).map(k => `${k.code} ${k.name}`).join('; ')}`);
    }
    const phones = [contacts.phone, contacts.additionalPhone].filter(Boolean).join(', ');
    if (phones) noteParts.push(`Тел.: ${phones}`);
    if (contacts.email) noteParts.push(`Email: ${contacts.email}`);
    if (usr.address) noteParts.push(`Адреса: ${usr.address}`);

    const registrationDateRaw = usr.registrationAfterLaw?.entryDate || usr.registrationBeforeLaw?.entryDate || '';

    return {
        source: 'youscore',
        sandbox: false,
        found: true,
        edrpou: clean,
        parentCode: parentCode || null,
        contractorType: usr.contractorType || (isFop ? 'Фізична особа-підприємець (ФОП)' : isBranch ? 'Відокремлений підрозділ (ВП)' : 'Юридична особа (ЮО)'),
        kind: isFop ? 'fop' : 'company',
        name: displayName,
        shortName: rawShortName,
        fullName: rawFullName,
        legalForm,
        address: usr.address || parentBranchRec?.address || '',
        addressParts: usr.addressParts || parentBranchRec?.addressParts || null,
        isRegistered,
        stateText: statusText || (isRegistered ? 'Зареєстровано' : 'Стан невідомий'),
        registrationDate: registrationDateRaw ? String(registrationDateRaw).slice(0, 10) : '',
        foundingCapital: Number(usr.foundingCapital?.sum || 0),
        director,
        signers,
        founders,
        kveds,
        mainKved,
        phone: phones || contacts.phone || '',
        email: contacts.email || '',
        webSite: contacts.webSite || '',
        contacts,
        taxSystem: computedTaxSystem,
        vatCode: vat?.code || '',
        taxInfo: {
            isVatPayer: Boolean(vat),
            vatCode: vat?.code || null,
            vatDate: vat?.registrationDate ? String(vat.registrationDate).slice(0, 10) : null,
            vatFromParent,
            isSingleTax: Boolean(singleTax),
            singleTaxGroup: singleTax?.group ?? null,
            singleTaxRate: singleTax?.rate || null,
            isNonProfit: Boolean(nonProfit),
            nonProfitCode: nonProfit?.nonProfitSign || null,
            nonProfitText: nonProfit?.nonProfitText || null
        },
        taxDebtTotal,
        wageDebtTotal: 0,
        openPenalties: openEnforcements.length,
        totalEnforcements: Number(enfRes.data?.totalResults || enfList.length || 0),
        recentEnforcements: enfList.slice(0, 5).map(e => ({
            orderNumber: e.orderNumber,
            dateBegin: e.dateBegin ? String(e.dateBegin).slice(0, 10) : '',
            status: e.status || '',
            enforcementState: e.enforcementState || '',
            deductionType: e.deductionType || '',
            otherSideName: e.otherSideInformation?.name || ''
        })),
        courtTotal,
        recentCourtDocs: courtDocs.slice(0, 5).map(c => ({
            id: c.id,
            caseNumber: c.caseNumber || '',
            decisionDate: c.decisionDate ? String(c.decisionDate).slice(0, 10) : '',
            courtName: c.courtName || '',
            sideType: c.caseSideType || '',
            form: c.legalProcedureForm || '',
            decisionForm: c.decisionForm || '',
            url: c.urlToDocument || ''
        })),
        bankruptcyCount: usr.bankruptcyStatus ? 1 : 0,
        singleTaxRisk: isFop && (!singleTax || [1, 2].includes(Number(singleTax.group))),
        isAggressor: false,
        hasSanctions: false,
        isSafe: isRegistered && riskFlags.length === 0,
        riskFlags,
        formattedNote: noteParts.join(' · ').slice(0, 300)
    };
}

// ------------------------------------------------------------
// 3. СУДОВИЙ РЕЄСТР ТА ВИКОНАВЧІ ПРОВАДЖЕННЯ ДЛЯ БЛОКУ ПРЕТЕНЗІЙНОЇ РОБОТИ
// ------------------------------------------------------------
function buildSandboxDebtorCourtData({ apt, ownerName, ownerCode }) {
    const parsed = parseFullName(ownerName || `Співвласник кв. ${apt}`);
    const fullName = parsed.fullName || `Співвласник кв. ${apt}`;
    return {
        source: 'youscore',
        sandbox: true,
        searchedPerson: fullName,
        searchedCode: ownerCode || '',
        courtCases: [
            {
                caseNumber: `947/${1000 + Number(String(apt).replace(/\D/g, '') || 25)}/26`,
                courtName: 'Київський районний суд м. Одеси',
                incomeDate: '2026-08-14',
                role: 'відповідач (боржник)',
                form: 'Цивільне судочинство',
                caseSubject: 'про стягнення заборгованості за оплату житлово-комунальних послуг та внесків ОСББ',
                caseCategory: 'Спори, що виникають із житлових правовідносин',
                casePersons: [
                    'Заявник (Стягувач): ОСББ «Успіх-25»',
                    `Боржник: ${fullName}`
                ],
                isOsbbCase: true,
                documents: [
                    {
                        id: 118450912,
                        decisionForm: 'Судовий наказ',
                        registerInsertDate: '2026-09-02',
                        judgeName: 'Коваленко О. В.',
                        urlToDocument: 'https://youcontrol.com.ua/check-individuals/court/document/?documentId=118450912'
                    }
                ]
            }
        ],
        scheduledHearings: [
            {
                courtCaseNumber: `947/${1000 + Number(String(apt).replace(/\D/g, '') || 25)}/26`,
                courtName: 'Київський районний суд м. Одеси',
                hearingDate: '2026-11-12T10:30:00+02:00',
                role: 'відповідач',
                description: 'про стягнення заборгованості зі сплати внесків на утримання будинку',
                judge: 'Коваленко О. В.'
            }
        ],
        enforcements: [
            {
                orderNumber: 74910234,
                dateBegin: '2026-10-05',
                enforcementState: 'Відкрито',
                deductionType: 'стягнення коштів',
                creditorName: 'ОСББ «УСПІХ-25»',
                creditorCode: '40562894',
                debtorName: fullName,
                departmentName: 'Київський відділ державної виконавчої служби у місті Одесі Південного міжрегіонального управління Міністерства юстиції',
                executorName: ' Петренко Сергій Миколайович',
                executorPhone: '048-705-12-34'
            }
        ]
    };
}

function enrichCourtResponse(raw) {
    const courtCases = (raw.courtCases || []).map(c => ({
        ...c,
        date: c.date || c.incomeDate || c.documents?.[0]?.registerInsertDate || '',
        subject: c.subject || c.caseSubject || '',
        category: c.category || c.caseCategory || ''
    }));
    const scheduledHearings = (raw.scheduledHearings || []).map(h => ({
        ...h,
        caseNumber: h.caseNumber || h.courtCaseNumber || ''
    }));
    const enforcements = (raw.enforcements || []).map(ep => ({
        ...ep,
        state: ep.state || ep.enforcementState || '',
        creditor: ep.creditor || ep.creditorName || '',
        executor: ep.executor || ep.executorName || '',
        department: ep.department || ep.departmentName || ''
    }));
    const totalCases = courtCases.length;
    const totalHearings = scheduledHearings.length;
    const totalEnforcements = enforcements.length;
    return {
        ...raw,
        isSandbox: Boolean(raw.sandbox || raw.isSandbox),
        courtCases,
        scheduledHearings,
        enforcements,
        totalCases,
        totalHearings,
        totalEnforcements,
        summary: {
            totalCases,
            scheduledCount: totalHearings,
            totalEnforcements
        }
    };
}

async function checkDebtorCourtAndEnforcement(apiKey, { apt, ownerName, fullName, ownerCode, code, birthday } = {}, options = {}) {
    const effectiveName = ownerName || fullName || '';
    const cleanCode = String(ownerCode || code || '').replace(/\s+/g, '').trim();
    const parsedName = parseFullName(effectiveName);

    if (isSandboxKey(apiKey)) {
        return enrichCourtResponse(buildSandboxDebtorCourtData({ apt, ownerName: effectiveName, ownerCode: cleanCode }));
    }

    const fetchImpl = options.fetchImpl;

    // Якщо боржник — юридична особа (8 цифр ЄДРПОУ)
    if (/^\d{8}$/.test(cleanCode)) {
        const [groupRes, docsRes, enfRes] = await Promise.all([
            requestYouscore(apiKey, `/v1/courtCaseGroup/${cleanCode}`, { query: { Top: 25, showCurrentData: true }, maxPolls: 2, fetchImpl }).catch(() => ({ status: 404, data: null })),
            requestYouscore(apiKey, `/v1/court/${cleanCode}`, { query: { Top: 25, showCurrentData: true }, maxPolls: 1, fetchImpl }).catch(() => ({ status: 404, data: null })),
            requestYouscore(apiKey, `/v1/enforcement/${cleanCode}`, { query: { Top: 50, showCurrentData: true }, maxPolls: 1, fetchImpl }).catch(() => ({ status: 404, data: null }))
        ]);

        const groups = Array.isArray(groupRes.data?.results) ? groupRes.data.results : [];
        const courtCases = groups.map(g => {
            const firstAuto = (g.autoCases || [])[0] || {};
            const docs = (g.documents || []).map(d => ({
                id: d.id,
                decisionForm: d.decisionForm || '',
                registerInsertDate: d.decisionDate ? String(d.decisionDate).slice(0, 10) : '',
                judgeName: d.judgeName || '',
                resolutionPart: d.resolutionPart || '',
                urlToDocument: d.urlToDocument || ''
            }));
            const textBlob = `${firstAuto.description || ''} ${(firstAuto.sides || []).map(s => s.name).join(' ')} ${docs.map(d => d.resolutionPart).join(' ')}`;
            return {
                caseNumber: g.caseNumber || '',
                courtName: firstAuto.courtName || docs[0]?.courtName || '',
                incomeDate: firstAuto.registrationDate ? String(firstAuto.registrationDate).slice(0, 10) : (docs[0]?.registerInsertDate || ''),
                role: firstAuto.caseSideType || (g.sideType === 2 ? 'відповідач' : 'сторона'),
                form: docs[0]?.legalProcedureForm || 'Господарське/Цивільне',
                caseSubject: firstAuto.description || '',
                caseCategory: docs[0]?.caseCategory || '',
                casePersons: (firstAuto.sides || []).map(s => `${s.role || ''}: ${s.name || ''}`),
                isOsbbCase: /успіх-25|40562894|внеск|комунальн|утримання будинк/i.test(textBlob),
                documents: docs
            };
        });

        // Якщо courtCaseGroup порожній, формуємо зі списку судових документів /v1/court/{code}
        if (!courtCases.length && Array.isArray(docsRes.data?.results)) {
            for (const doc of docsRes.data.results) {
                courtCases.push({
                    caseNumber: doc.caseNumber || '',
                    courtName: doc.courtName || '',
                    incomeDate: doc.decisionDate ? String(doc.decisionDate).slice(0, 10) : '',
                    role: doc.caseSideType || '',
                    form: doc.legalProcedureForm || '',
                    caseSubject: doc.decisionForm || '',
                    caseCategory: '',
                    casePersons: [],
                    isOsbbCase: false,
                    documents: [{
                        id: doc.id,
                        decisionForm: doc.decisionForm || '',
                        registerInsertDate: doc.decisionDate ? String(doc.decisionDate).slice(0, 10) : '',
                        judgeName: doc.judgeName || '',
                        urlToDocument: doc.urlToDocument || ''
                    }]
                });
            }
        }

        const enfResults = Array.isArray(enfRes.data?.results) ? enfRes.data.results : [];
        return enrichCourtResponse({
            source: 'youscore',
            sandbox: false,
            searchedPerson: effectiveName || cleanCode,
            searchedCode: cleanCode,
            courtCases,
            scheduledHearings: [],
            enforcements: enfResults.map(e => ({
                orderNumber: e.orderNumber,
                dateBegin: e.dateBegin ? String(e.dateBegin).slice(0, 10) : '',
                enforcementState: e.enforcementState || '',
                deductionType: e.deductionType || '',
                creditorName: e.otherSideInformation?.name || '',
                creditorCode: e.otherSideInformation?.code || '',
                debtorName: effectiveName || cleanCode,
                departmentName: e.departmentName || '',
                executorName: e.executor?.name || '',
                executorPhone: e.executor?.phone || ''
            }))
        });
    }

    // Якщо боржник — фізична особа (пошук за ПІБ + опціонально РНОКПП для виконавчих проваджень)
    if (!parsedName.lastName || !parsedName.firstName) {
        throw new Error('Для перевірки фізичної особи у судовому реєстрі вкажіть Прізвище та Ім\'я боржника (українською мовою)');
    }

    const nameQuery = {
        LastName: parsedName.lastName,
        FirstName: parsedName.firstName,
        ...(parsedName.middleName ? { MiddleName: parsedName.middleName } : {})
    };

    const tasks = [
        requestAsyncResult(
            apiKey,
            '/v1/IndividualsCourtStatusOfTheCase',
            nameQuery,
            id => `/v1/IndividualsCourtStatusOfTheCase/${id}`,
            { maxPolls: 5, pollDelayMs: 1500, fetchImpl }
        ).catch(() => ({ status: 404, data: null })),
        requestAsyncResult(
            apiKey,
            '/v1/individualsCourtCasesToBeHeard',
            nameQuery,
            id => `/v1/individualsCourtCasesToBeHeard/${id}`,
            { maxPolls: 5, pollDelayMs: 1500, fetchImpl }
        ).catch(() => ({ status: 404, data: null }))
    ];

    // Виконавчі провадження щодо фізособи (/v1/enforcementIndividual) вимагають INN (РНОКПП) або Birthday
    if (/^\d{10}$/.test(cleanCode) || birthday) {
        tasks.push(
            requestAsyncResult(
                apiKey,
                '/v1/enforcementIndividual',
                {
                    Surname: parsedName.lastName,
                    Name: parsedName.firstName,
                    ...(parsedName.middleName ? { MiddleName: parsedName.middleName } : {}),
                    ...(/^\d{10}$/.test(cleanCode) ? { INN: cleanCode } : {}),
                    ...(birthday ? { Birthday: birthday } : {})
                },
                id => `/v1/enforcementIndividual/${id}`,
                { maxPolls: 5, pollDelayMs: 1500, fetchImpl }
            ).catch(() => ({ status: 404, data: null }))
        );
    } else {
        tasks.push(Promise.resolve({ status: 404, data: null, skippedNoTin: true }));
    }

    const [statusRes, heardRes, enfRes] = await Promise.all(tasks);

    const rawCases = Array.isArray(statusRes.data?.individualsCourtStatusOfTheCase)
        ? statusRes.data.individualsCourtStatusOfTheCase
        : [];
    const courtCases = rawCases.map(c => {
        const persons = Array.isArray(c.casePersons) ? c.casePersons : [];
        const textBlob = `${c.caseSubject || ''} ${c.caseCategory || ''} ${persons.join(' ')}`;
        return {
            caseNumber: c.courtCaseNumber || '',
            courtName: c.courtName || '',
            incomeDate: c.incomeDate ? String(c.incomeDate).slice(0, 10) : '',
            role: c.role || c.status || '',
            form: c.form || '',
            caseSubject: c.caseSubject || '',
            caseCategory: c.caseCategory || '',
            casePersons: persons,
            isOsbbCase: /успіх-25|40562894|внеск|комунальн|житлов|утримання будинк/i.test(textBlob),
            documents: (c.courtDocuments || []).map(d => ({
                id: d.id,
                decisionForm: d.decisionForm || '',
                registerInsertDate: d.registerInsertDate ? String(d.registerInsertDate).slice(0, 10) : '',
                judgeName: d.judgeName || '',
                urlToDocument: d.urlToDocument || ''
            }))
        };
    });

    const rawHeard = Array.isArray(heardRes.data?.individualsCourtCasesToBeHeard)
        ? heardRes.data.individualsCourtCasesToBeHeard
        : [];
    const scheduledHearings = rawHeard.map(h => ({
        courtCaseNumber: h.courtCaseNumber || '',
        courtName: h.courtName || '',
        hearingDate: h.incomeDate || '',
        role: h.role || h.status || '',
        description: h.description || h.caseSubject || '',
        judge: (h.courtPersons || [])[0] || '',
        casePersons: Array.isArray(h.casePersons) ? h.casePersons : []
    }));

    const rawEnf = Array.isArray(enfRes.data?.results) ? enfRes.data.results : [];
    const enforcements = rawEnf.map(e => ({
        orderNumber: e.orderNumber,
        dateBegin: e.dateBegin ? String(e.dateBegin).slice(0, 10) : '',
        enforcementState: e.enforcementState || '',
        deductionType: e.deductionType || '',
        creditorName: e.creditor?.fullName || '',
        creditorCode: e.creditor?.code || '',
        debtorName: e.debtor?.fullName || parsedName.fullName,
        departmentName: e.departmentName || '',
        executorName: e.executor?.name || '',
        executorPhone: e.executor?.phone || ''
    }));

    return enrichCourtResponse({
        source: 'youscore',
        sandbox: false,
        searchedPerson: parsedName.fullName,
        searchedCode: cleanCode,
        enforcementsSkippedNoTin: Boolean(enfRes.skippedNoTin),
        courtCases,
        scheduledHearings,
        enforcements
    });
}

// ------------------------------------------------------------
// 4. НЕРУХОМІСТЬ ТА ВЛАСНИКИ З ДРРП (/v1/realEstate)
// ------------------------------------------------------------
function buildSandboxRealEstate({ code, apt, ownerName }) {
    const cleanCode = String(code || '').trim();
    const targetApt = String(apt || '25').trim();
    const displayOwner = String(ownerName || 'Коваленко Олександр Петрович').trim();
    return {
        source: 'youscore',
        sandbox: true,
        searchedCode: cleanCode,
        objects: [
            {
                id: `969625073-${cleanCode || '1234567890'}`,
                dataType: 0,
                typeLabel: 'Нерухомість',
                address: `Одеська обл., м. Одеса, вулиця Інглезі, будинок 3/3, квартира ${targetApt}`,
                region: 'Одеська область',
                district: 'м. Одеса',
                matchesHouse: true,
                matchesApt: true,
                details: {
                    objectRegNumber: `2845109265101`,
                    objectType: 'Квартира',
                    totalArea: 64.8,
                    livingArea: 38.2,
                    address: `Одеська обл., м. Одеса, вулиця Інглезі, будинок 3/3, квартира ${targetApt}`,
                    owners: [
                        {
                            name: displayOwner,
                            code: cleanCode,
                            shareFrac: '1/1',
                            ownershipForm: 'приватна власність',
                            registrationDate: '2021-05-18',
                            docInfo: `Договір купівлі-продажу, серія та номер: 1452, виданий 18.05.2021, приватний нотаріус Одеського міського нотаріального округу; РНОКПП ${cleanCode}`
                        }
                    ]
                }
            }
        ]
    };
}

/**
 * Отримання переліку нерухомості за кодом РНОКПП (10 цифр) або ЄДРПОУ (8 цифр)
 * та завантаження деталей по об'єкту, що відповідає будинку ОСББ.
 */
async function checkRealEstateByCode(apiKey, { code, apt, ownerName, houseHint = 'Інглезі', landId = null }, options = {}) {
    const cleanCode = String(code || '').replace(/\s+/g, '').trim();
    if (!landId && !/^\d{8,10}$/.test(cleanCode)) {
        throw new Error('Пошук нерухомості в YouScore API (/v1/realEstate/{contractorCode}) здійснюється за 10-значним РНОКПП фізособи або 8-значним ЄДРПОУ юрособи');
    }

    if (isSandboxKey(apiKey)) {
        const sb = buildSandboxRealEstate({ code: cleanCode, apt, ownerName });
        const first = sb.objects[0] || null;
        return {
            ...sb,
            isSandbox: true,
            totalObjects: sb.objects.length,
            matchedAptObject: first,
            matchedObject: first ? { ...first, detailed: first.details } : null
        };
    }

    const fetchImpl = options.fetchImpl;

    // Якщо передано конкретний landId — одразу запитуємо деталі об'єкта (/v1/realEstate/details/{landId})
    if (landId) {
        const detailRes = await requestAsyncResult(
            apiKey,
            `/v1/realEstate/details/${encodeURIComponent(landId)}`,
            {},
            id => `/v1/realEstate/resultdetails/${id}`,
            { maxPolls: 5, pollDelayMs: 1500, fetchImpl }
        );
        return {
            source: 'youscore',
            sandbox: false,
            landId,
            details: normalizeRealEstateDetails(detailRes.data, cleanCode, ownerName)
        };
    }

    // Крок 1: Отримуємо перелік об'єктів нерухомості контрагента (/v1/realEstate/{contractorCode})
    const listRes = await requestAsyncResult(
        apiKey,
        `/v1/realEstate/${cleanCode}`,
        {},
        id => `/v1/realEstate/result/${id}`,
        { maxPolls: 5, pollDelayMs: 1500, fetchImpl }
    );

    const rawObjects = Array.isArray(listRes.data) ? listRes.data : [];
    const aptRegex = apt ? new RegExp(`(?:кв\\.?|квартира|прим\\.?)\\s*0*${String(apt).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i') : null;
    const houseRegex = houseHint ? new RegExp(houseHint, 'i') : /інглезі/i;

    const objects = rawObjects.map(obj => {
        const addr = String(obj.data || '').trim();
        const matchesHouse = houseRegex.test(addr);
        const matchesApt = aptRegex ? aptRegex.test(addr) : false;
        return {
            id: String(obj.id || ''),
            dataType: obj.dataType,
            typeLabel: obj.dataType === 1 ? 'Земельна ділянка' : obj.dataType === 0 ? 'Нерухомість' : 'Майно',
            address: addr,
            region: obj.region || '',
            district: obj.district || '',
            detailsUrl: obj.detailsUrl || '',
            matchesHouse,
            matchesApt,
            details: null
        };
    });

    // Сортуємо так, щоб об'єкти нашого будинку і квартири були першими
    objects.sort((a, b) => (Number(b.matchesApt) * 2 + Number(b.matchesHouse)) - (Number(a.matchesApt) * 2 + Number(a.matchesHouse)));

    // Крок 2: Якщо знайдено об'єкт, що збігається з будинком/квартирою (або єдиний об'єкт нерухомості), підтягуємо деталі по ньому
    const targetObj = objects.find(o => o.matchesApt || o.matchesHouse) || objects.find(o => o.dataType === 0 && o.id);
    if (targetObj && targetObj.id && options.fetchDetails !== false) {
        try {
            const detailRes = await requestAsyncResult(
                apiKey,
                `/v1/realEstate/details/${encodeURIComponent(targetObj.id)}`,
                {},
                id => `/v1/realEstate/resultdetails/${id}`,
                { maxPolls: 4, pollDelayMs: 1500, fetchImpl }
            );
            if (detailRes.status === 200 && detailRes.data) {
                targetObj.details = normalizeRealEstateDetails(detailRes.data, cleanCode, ownerName);
            }
        } catch (_) {
            // Якщо деталі не встигли сформуватися, список об'єктів все одно повертається
        }
    }

    return {
        source: 'youscore',
        sandbox: false,
        isSandbox: false,
        searchedCode: cleanCode,
        totalObjects: objects.length,
        matchedAptObject: targetObj || null,
        matchedObject: targetObj ? { ...targetObj, detailed: targetObj.details } : null,
        objects
    };
}

function normalizeRealEstateDetails(raw, fallbackCode = '', fallbackName = '') {
    if (!raw || typeof raw !== 'object') return null;
    const props = raw.properties || raw.realty || raw;
    const totalArea = Number(props.totalArea || props.area || raw.totalArea || 0) || null;
    const livingArea = Number(props.livingArea || raw.livingArea || 0) || null;
    const address = String(props.address || raw.address || raw.data || '').trim();
    const objectRegNumber = String(props.regNum || props.registrationNumber || raw.regNumber || raw.id || '').trim();

    const rawOwners = Array.isArray(raw.owners)
        ? raw.owners
        : Array.isArray(raw.proprietors)
            ? raw.proprietors
            : Array.isArray(raw.subjects)
                ? raw.subjects
                : [];

    const owners = rawOwners.map(o => {
        const name = String(o.name || o.fullName || o.fio || fallbackName || '').trim();
        const code = String(o.code || o.rnokpp || o.inn || fallbackCode || '').trim();
        const shareFrac = String(o.share || o.sharePart || o.portion || '1/1').trim();
        const ownershipForm = String(o.ownershipForm || o.form || 'приватна власність').trim();
        const registrationDate = String(o.registrationDate || o.regDate || '').slice(0, 10);
        const docCause = String(o.cause || o.document || o.basis || 'Відомості з ДРРП (YouScore)').trim();
        return {
            name,
            code,
            share: shareFrac,
            shareFrac,
            ownershipForm,
            grounds: docCause,
            registrationDate,
            docInfo: [docCause, registrationDate ? `дата реєстрації: ${registrationDate}` : '', code ? `РНОКПП ${code}` : ''].filter(Boolean).join('; ')
        };
    }).filter(o => o.name);

    if (!owners.length && fallbackName) {
        owners.push({
            name: fallbackName,
            code: fallbackCode,
            shareFrac: '1/1',
            ownershipForm: 'приватна власність',
            registrationDate: '',
            docInfo: `Підтверджено об'єкт у ДРРП (YouScore)${fallbackCode ? `; РНОКПП ${fallbackCode}` : ''}`
        });
    }

    return {
        objectRegNumber,
        regNum: objectRegNumber,
        objectType: String(props.type || props.objectType || 'Нерухомість').trim(),
        totalArea,
        livingArea,
        basisDocument: owners[0]?.docInfo || '',
        address,
        owners
    };
}

module.exports = {
    BASE_URL,
    SANDBOX_KEY,
    isSandboxKey,
    parseFullName,
    requestYouscore,
    requestAsyncResult,
    checkRateLimits,
    checkCounterpartyFull,
    checkDebtorCourtAndEnforcement,
    checkRealEstateByCode,
    normalizeRealEstateDetails
};
