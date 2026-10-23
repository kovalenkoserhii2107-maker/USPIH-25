'use strict';
// ============================================================
// Чисте ядро претензійно-позовної роботи з боржниками для ОСББ.
//
// Нормативна база:
// 1. ЗУ «Про ОСББ» (ст. 15, 16, 17) — обовʼязок сплати внесків.
// 2. ЦПК України:
//    - ст. 161 (п. 3 ч. 1), ст. 163 — наказне провадження (судовий наказ).
//    - ст. 175, 274 — спрощене позовне провадження.
// 3. ЦК України:
//    - ст. 526, 530 — належне виконання грошових зобовʼязань.
//    - ст. 625 — відповідальність за прострочення (3 % річних та інфляційні).
// 4. Законодавство воєнного стану:
//    - Постанова КМУ № 206 від 05.03.2022 (у редакції постанови № 1405 від 29.12.2023):
//      стягнення боргу дозволено (м. Одеса поза зоною бойових дій за Переліком № 309),
//      проте діє заборона нарахування штрафів та пені населенню.
//    - Режим воєнного стану перемикається: у воєнний стан пеня = 0;
//      після припинення/скасування воєнного стану (мирний час) діє повний розрахунок
//      пені за статутом та ст. 625 ЦК України.
// ============================================================

const COURT_DEFAULT_NAME = "Київський районний суд м. Одеси";
const COURT_DEFAULT_ADDRESS = "65080, м. Одеса, вул. Варненська, 3-Б";
const DEFAULT_HOUSE_ADDRESS = "вул. Інглезі, 3/3, м. Одеса";

// Судовий збір за заяву про видачу судового наказу:
// 0,1 розміру прожиткового мінімуму для працездатних осіб (ст. 4 ЗУ «Про судовий збір»)
// 3028 грн * 0,1 = 302,80 грн = 30280 коп.
const COURT_FEE_ORDER_KOP = 30280;

// Судовий збір за позовну заяву майнового характеру:
// 1,5 % ціни позову, але не менше 1 розміру прожиткового мінімуму (3028,00 грн = 302800 коп)
const COURT_FEE_MIN_LAWSUIT_KOP = 302800;

const CLAIM_STAGES = {
    pre_trial: "Досудове врегулювання",
    court_order: "Наказне провадження (ст. 161 ЦПК)",
    lawsuit: "Позовне провадження (ст. 274 ЦПК)",
    enforcement: "Виконавче провадження",
    settled: "Погашено / закрито"
};

const CLAIM_STATUSES = {
    none: "Не розпочато",
    warning: "Попередження (нагадування)",
    claim: "Офіційна досудова вимога (претензія)",
    restructured: "Договір реструктуризації",
    court_order_filed: "Подано заяву про судовий наказ",
    court_order_issued: "Судовий наказ видано",
    court_order_canceled: "Судовий наказ скасовано боржником",
    lawsuit_filed: "Подано позовну заяву",
    lawsuit_satisfied: "Позов задоволено судом",
    enforcement: "На примусовому виконанні (ДВС)",
    settled: "Повністю сплачено"
};

const fmtKop = kop => (Number(kop || 0) / 100).toLocaleString("uk-UA", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/**
 * Перетворює суму в гривнях (число або рядок з крапкою/комою) у копійки.
 */
function grnToKop(v) {
    if (v === null || v === undefined || v === "") return 0;
    const n = typeof v === "number" ? v : parseFloat(String(v).replace(/\s+/g, "").replace(",", "."));
    return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

function formatSigners(headName) {
    const clean = String(headName || "").trim();
    return clean ? `/ ${clean} /` : "/ ________________________ /";
}

function calculateClaimTotals({
    debtKop,
    monthsOverdue = 1,
    isMartialLaw = true,
    include3Percent = false,
    includeInflation = false,
    inflationRate = 0,
    penaltyPerDayKop = 0,
    daysOverdue = 0
}) {
    const principalKop = Math.abs(Math.round(Number(debtKop || 0)));
    const days = Math.max(0, Number(daysOverdue || 0));

    // У період воєнного стану нарахування пені населенню заборонено (Постанова КМУ № 206 / № 1405).
    // Після скасування воєнного стану (мирний час) пеня нараховується за ставкою, але не більше 100% боргу.
    const penaltyKop = isMartialLaw ? 0 : Math.min(principalKop, Math.round(Number(penaltyPerDayKop || 0) * days));

    // 3 % річних за ст. 625 ЦК України
    const threePercentKop = (!isMartialLaw || include3Percent)
        ? Math.round(principalKop * 0.03 * (days / 365))
        : 0;

    // Втрати від інфляції
    const inflationKop = (!isMartialLaw || includeInflation)
        ? Math.round(principalKop * Math.max(0, Number(inflationRate || 0)))
        : 0;

    const courtFeeOrderKop = COURT_FEE_ORDER_KOP;
    const courtFeeLawsuitKop = Math.max(COURT_FEE_MIN_LAWSUIT_KOP, Math.round((principalKop + penaltyKop + threePercentKop + inflationKop) * 0.015));

    const totalClaimKop = principalKop + penaltyKop + threePercentKop + inflationKop;

    return {
        principalKop,
        penaltyKop,
        threePercentKop,
        inflationKop,
        courtFeeOrderKop,
        courtFeeLawsuitKop,
        totalClaimKop,
        isMartialLaw: Boolean(isMartialLaw)
    };
}

function generatePreTrialClaim({
    org,
    apt,
    ownerName,
    personalAccount,
    area,
    docInfo,
    debtKop,
    monthlyKop,
    periodFrom,
    periodTo,
    isMartialLaw = true,
    claimDate = new Date().toISOString().slice(0, 10),
    iban,
    dueDateDays = 10
}) {
    const principalKop = Math.abs(Math.round(Number(debtKop || 0)));
    const orgName = org?.name || "ОСББ «Успіх-25»";
    const edrpou = org?.edrpou || "40562894";
    const address = org?.address || DEFAULT_HOUSE_ADDRESS;
    const bankIban = iban || org?.iban || "UA___________________________";
    const owner = String(ownerName || "").trim() || `Співвласнику квартири № ${apt}`;
    const accLine = personalAccount ? ` (особовий рахунок № ${personalAccount})` : "";
    const areaLine = area ? `, загальною площею ${String(area).replace(".", ",")} м²` : "";
    const docLine = docInfo ? `\nВідомості про право власності: ${docInfo}.` : "";
    const monthlyLine = monthlyKop ? `\nРозмір щомісячного внеску за Вашим приміщенням становить ${fmtKop(monthlyKop)} грн.` : "";

    const legalNotice = isMartialLaw
        ? "Звертаємо Вашу увагу, що відповідно до постанови Кабінету Міністрів України від 29.12.2023 № 1405 (якою внесено зміни до постанови КМУ № 206), мораторій на стягнення заборгованості за житлово-комунальні послуги на територіях, де не ведуться бойові дії (зокрема у м. Одеса), скасовано. ОСББ має повне законне право примусового стягнення боргу через суд."
        : "Згідно зі статтею 625 Цивільного кодексу України, у разі прострочення виконання грошового зобовʼязання боржник також зобовʼязаний сплатити суму боргу з урахуванням індексу інфляції, 3 % річних та пені.";

    const purpose = personalAccount
        ? `Внески на утримання будинку, кв. ${apt}, особовий рахунок ${personalAccount}, ${owner}`
        : `Внески на утримання будинку, кв. ${apt}, ${owner}`;

    return `ВИХ. № ПР-${apt}/${claimDate.slice(0, 4)}
від «${claimDate}» року

Співвласнику: ${owner}
Адреса: ${address}, кв. ${apt}${accLine}

ДОСУДОВА ПРЕТЕНЗІЯ (ВИМОГА)
про погашення заборгованості зі сплати внесків на утримання будинку

Шановний(а) ${owner}!

Ви є співвласником квартири № ${apt}${areaLine} у багатоквартирному будинку за адресою: ${address}${accLine}.${docLine}

Відповідно до частини 1 статті 15 Закону України «Про обʼєднання співвласників багатоквартирного будинку», співвласник зобовʼязаний своєчасно і в повному обсязі сплачувати встановлені загальними зборами обʼєднання внески і платежі. Відповідно до статті 16 та статті 17 зазначеного Закону, рішення загальних зборів обʼєднання є обовʼязковими для всіх співвласників, а обʼєднання має право вимагати своєчасної та повної сплати всіх встановлених платежів.${monthlyLine}

Станом на «${claimDate}» року за Вашим особовим рахунком${personalAccount ? ` № ${personalAccount}` : ""} (кв. № ${apt}) обліковується прострочена заборгованість зі сплати внесків на утримання будинку за період з ${periodFrom || "початку обліку"} по ${periodTo || "поточний місяць"} у розмірі:
${fmtKop(principalKop)} грн.

${legalNotice}

У звʼязку з викладеним, правління ${orgName} вимагає протягом ${dueDateDays} (десяти) календарних днів з дня отримання цієї претензії добровільно погасити зазначену заборгованість шляхом перерахування коштів на поточний банківський рахунок ОСББ:
Отримувач: ${orgName}
Код ЄДРПОУ: ${edrpou}
IBAN: ${bankIban}
Призначення платежу: ${purpose}

Попереджаємо, що у разі непогашення заборгованості у встановлений строк, ${orgName} буде вимушене звернутися до суду із заявою про видачу судового наказу про примусове стягнення заборгованості (статті 161–163 ЦПК України).
У такому випадку на Вас додатково буде покладено відшкодування судового збору (${fmtKop(COURT_FEE_ORDER_KOP)} грн) та витрат на професійну правничу допомогу.

Якщо Ви перебуваєте у складних життєвих обставинах, правління ОСББ готове укласти договір реструктуризації заборгованості з графіком помісячного погашення. Для цього зверніться до правління ОСББ.

З повагою,
Голова правління ${orgName} ______________ ${formatSigners(org?.headName)}
М.П.`;
}

function generateCourtOrderApp({
    org,
    apt,
    ownerName,
    ownerCode,
    personalAccount,
    area,
    docInfo,
    debtKop,
    monthlyKop,
    periodFrom,
    periodTo,
    isMartialLaw = true,
    courtName = COURT_DEFAULT_NAME,
    courtAddress = COURT_DEFAULT_ADDRESS,
    appDate = new Date().toISOString().slice(0, 10),
    courtFeeKop = COURT_FEE_ORDER_KOP
}) {
    const principalKop = Math.abs(Math.round(Number(debtKop || 0)));
    const orgName = org?.name || "ОСББ «Успіх-25»";
    const edrpou = org?.edrpou || "40562894";
    const address = org?.address || DEFAULT_HOUSE_ADDRESS;
    const legalAddress = org?.legalAddress || address;
    const bankIban = org?.iban ? `\nIBAN: ${org.iban}` : "";
    const owner = String(ownerName || "").trim() || `ПІБ співвласника кв. ${apt} (потребує уточнення з Держреєстру речових прав)`;
    const rnokpp = ownerCode ? `РНОКПП / паспортні дані: ${ownerCode}` : "РНОКПП: відомості відсутні (підлягає встановленню судом у порядку ч. 5 ст. 165 ЦПК України)";
    const accText = personalAccount ? ` (особовий рахунок № ${personalAccount})` : "";
    const areaText = area ? ` загальною площею ${String(area).replace(".", ",")} м²` : "";
    const docText = docInfo ? `\nПраво власності підтверджується: ${docInfo}.` : "";
    const monthlyText = monthlyKop ? ` Розмір щомісячного внеску для кв. № ${apt} становить ${fmtKop(monthlyKop)} грн.` : "";

    return `До: ${courtName}
${courtAddress}

Заявник (Стягувач):
${orgName}
Код ЄДРПОУ: ${edrpou}
Місцезнаходження: ${legalAddress}${bankIban}
Електронна пошта: ${org?.email || "не зазначено"}
Телефон: ${org?.phone || "не зазначено"}

Боржник:
${owner}
${rnokpp}
Адреса реєстрації/проживання: ${address}, кв. ${apt}
Засоби звʼязку: відомості відсутні

Судовий збір: ${fmtKop(courtFeeKop)} грн (0,1 розміру прожиткового мінімуму для працездатних осіб)

ЗАЯВА
про видачу судового наказу про стягнення заборгованості за оплату внесків
на утримання багатоквартирного будинку та прибудинкової території

${orgName} (код ЄДРПОУ ${edrpou}) створене відповідно до Закону України «Про обʼєднання співвласників багатоквартирного будинку» та здійснює управління й утримання багатоквартирного житлового будинку за адресою: ${address}.

Боржник — ${owner} — є співвласником (власником) квартири № ${apt}${areaText} у зазначеному житловому будинку за адресою: ${address}, кв. ${apt}${accText}.${docText}

Відповідно до частини 1 статті 15 Закону України «Про обʼєднання співвласників багатоквартирного будинку», співвласник зобовʼязаний своєчасно і в повному обсязі сплачувати встановлені загальними зборами обʼєднання внески і платежі. Відповідно до статті 10 та статті 16 зазначеного Закону, рішення загальних зборів обʼєднання про затвердження кошторису та розміру внесків є обовʼязковими для всіх співвласників.${monthlyText}

Згідно зі статтями 526, 530 Цивільного кодексу України, зобовʼязання має виконуватися належним чином відповідно до вимог закону та у встановлений строк.

Всупереч вимогам закону та рішенням загальних зборів співвласників, Боржник належним чином не виконує свої грошові зобовʼязання щодо оплати внесків на утримання будинку, внаслідок чого за особовим рахунком квартири № ${apt}${personalAccount ? ` (о/р № ${personalAccount})` : ""} за період з ${periodFrom || "початку обліку"} по ${periodTo || "поточний місяць"} утворилася прострочена заборгованість у розмірі ${fmtKop(principalKop)} грн.

Постановою Кабінету Міністрів України від 29.12.2023 № 1405 (якою внесено зміни до постанови КМУ від 05.03.2022 № 206) скасовано мораторій на стягнення заборгованості за житлово-комунальні послуги та внески на управління багатоквартирним будинком на територіях, що не належать до зони активних бойових дій чи тимчасової окупації. Місто Одеса до таких територій не належить. Питання та штрафні санкції (пеня) у період воєнного стану до розрахунку не включалися.

Відповідно до пункту 3 частини 1 статті 161 Цивільного процесуального кодексу України, судовий наказ може бути видано, якщо заявлено вимогу про стягнення заборгованості за оплату житлово-комунальних послуг та внесків на утримання будинку.

На підставі викладеного, керуючись ст. 10, 15, 16, 17 Закону України «Про обʼєднання співвласників багатоквартирного будинку», ст. 526, 530 ЦК України, ст. 160–163, 167, 168 ЦПК України,

ПРОШУ СУД:

1. Видати судовий наказ про стягнення з Боржника — ${owner} (${address}, кв. ${apt}${personalAccount ? `, о/р № ${personalAccount}` : ""}) на користь ${orgName} (код ЄДРПОУ ${edrpou}${org?.iban ? `, IBAN ${org.iban}` : ""}) заборгованості зі сплати внесків на утримання будинку в розмірі ${fmtKop(principalKop)} грн.
2. Стягнути з Боржника на користь ${orgName} судовий збір у розмірі ${fmtKop(courtFeeKop)} грн.

Додатки:
1. Довідка-розрахунок заборгованості за особовим рахунком${personalAccount ? ` № ${personalAccount}` : ""} квартири № ${apt}.
2. Копія витягу з ЄДР та Статуту ${orgName}.
3. Копія протоколу загальних зборів співвласників про затвердження кошторису та розміру внесків.
4. Документ, що підтверджує право власності Боржника на квартиру № ${apt}.
5. Документ про сплату судового збору (${fmtKop(courtFeeKop)} грн).

«${appDate}» року

Голова правління ${orgName} ______________ ${formatSigners(org?.headName)}`;
}

function generateLawsuitApp({
    org,
    apt,
    ownerName,
    ownerCode,
    personalAccount,
    area,
    docInfo,
    debtKop,
    monthlyKop,
    periodFrom,
    periodTo,
    isMartialLaw = true,
    courtName = COURT_DEFAULT_NAME,
    courtAddress = COURT_DEFAULT_ADDRESS,
    appDate = new Date().toISOString().slice(0, 10),
    courtFeeKop,
    include3Percent = false,
    includeInflation = false,
    penaltyKop = 0,
    threePercentKop = 0,
    inflationKop = 0
}) {
    const principalKop = Math.abs(Math.round(Number(debtKop || 0)));
    const extraPenKop = isMartialLaw ? 0 : Math.round(Number(penaltyKop || 0));
    const extra3Kop = (!isMartialLaw || include3Percent) ? Math.round(Number(threePercentKop || 0)) : 0;
    const extraInfKop = (!isMartialLaw || includeInflation) ? Math.round(Number(inflationKop || 0)) : 0;
    const totalClaimKop = principalKop + extraPenKop + extra3Kop + extraInfKop;
    const feeKop = courtFeeKop !== undefined ? Number(courtFeeKop) : Math.max(COURT_FEE_MIN_LAWSUIT_KOP, Math.round(totalClaimKop * 0.015));

    const orgName = org?.name || "ОСББ «Успіх-25»";
    const edrpou = org?.edrpou || "40562894";
    const address = org?.address || DEFAULT_HOUSE_ADDRESS;
    const legalAddress = org?.legalAddress || address;
    const bankIban = org?.iban ? `\nIBAN: ${org.iban}` : "";
    const owner = String(ownerName || "").trim() || `Відповідач (співвласник кв. ${apt})`;
    const rnokpp = ownerCode ? `РНОКПП / паспортні дані: ${ownerCode}` : "РНОКПП: відомості відсутні";
    const accText = personalAccount ? ` (особовий рахунок № ${personalAccount})` : "";
    const areaText = area ? ` загальною площею ${String(area).replace(".", ",")} м²` : "";
    const docText = docInfo ? `\nВідомості про право власності: ${docInfo}.` : "";

    const extraSection = (extraPenKop > 0 || extra3Kop > 0 || extraInfKop > 0)
        ? `\nКрім основного боргу, відповідно до ст. 625 ЦК України та Статуту ОСББ нараховано:\n` +
          (extraPenKop > 0 ? `- пеня за прострочення платежів: ${fmtKop(extraPenKop)} грн;\n` : "") +
          (extra3Kop > 0 ? `- 3 % річних від простроченої суми: ${fmtKop(extra3Kop)} грн;\n` : "") +
          (extraInfKop > 0 ? `- інфляційні втрати за час прострочення: ${fmtKop(extraInfKop)} грн.\n` : "") +
          `Загальна ціна позову становить: ${fmtKop(totalClaimKop)} грн.\n`
        : "";

    return `До: ${courtName}
${courtAddress}

Позивач:
${orgName}
Код ЄДРПОУ: ${edrpou}
Місцезнаходження: ${legalAddress}${bankIban}
Електронна пошта: ${org?.email || "не зазначено"}
Телефон: ${org?.phone || "не зазначено"}

Відповідач:
${owner}
${rnokpp}
Адреса реєстрації/проживання: ${address}, кв. ${apt}

Ціна позову: ${fmtKop(totalClaimKop)} грн
Судовий збір: ${fmtKop(feeKop)} грн

ПОЗОВНА ЗАЯВА
про стягнення заборгованості зі сплати внесків на утримання будинку
(у порядку спрощеного позовного провадження)

${orgName} забезпечує експлуатацію та утримання спільного неподільного майна багатоквартирного будинку за адресою: ${address}.
Відповідач — ${owner} — є співвласником квартири № ${apt}${areaText} у зазначеному будинку${accText}.${docText}

Згідно зі ст. 15 Закону України «Про обʼєднання співвласників багатоквартирного будинку» співвласники зобовʼязані брати участь у витратах на управління багатоквартирним будинком шляхом своєчасного внесення встановлених загальними зборами внесків і платежів. Відповідно до ст. 10 Закону рішення загальних зборів ОСББ є обовʼязковими для виконання всіма співвласниками.${monthlyKop ? ` Щомісячний внесок за квартирою № ${apt} становить ${fmtKop(monthlyKop)} грн.` : ""}

Відповідач систематично ухиляється від виконання обовʼязку щодо оплати внесків, внаслідок чого за період з ${periodFrom || "початку обліку"} по ${periodTo || "поточний місяць"} за особовим рахунком квартири № ${apt}${personalAccount ? ` (о/р № ${personalAccount})` : ""} утворилася прострочена заборгованість у розмірі ${fmtKop(principalKop)} грн.${extraSection}

Постановою КМУ від 29.12.2023 № 1405 скасовано мораторій на примусове стягнення заборгованості за житлово-комунальні послуги та внески ОСББ у населених пунктах поза зоною активних бойових дій (зокрема у м. Одеса).

Справа є малозначною у розумінні п. 1 ч. 6 ст. 19 ЦПК України, тому відповідно до ст. 274 ЦПК України підлягає розгляду в порядку спрощеного позовного провадження без повідомлення (виклику) сторін (ч. 5 ст. 279 ЦПК України).

На підставі викладеного, керуючись ст. 10, 15, 16, 17 ЗУ «Про ОСББ», ст. 526, 530, 625 ЦК України, ст. 19, 175, 177, 274–279 ЦПК України,

ПРОШУ СУД:

1. Прийняти позовну заяву до розгляду та відкрити провадження у справі в порядку спрощеного позовного провадження.
2. Стягнути з Відповідача — ${owner} (${address}, кв. ${apt}${personalAccount ? `, о/р № ${personalAccount}` : ""}) на користь ${orgName} (код ЄДРПОУ ${edrpou}${org?.iban ? `, IBAN ${org.iban}` : ""}) заборгованість зі сплати внесків на утримання будинку в загальному розмірі ${fmtKop(totalClaimKop)} грн.
3. Стягнути з Відповідача на користь ${orgName} судові витрати зі сплати судового збору в розмірі ${fmtKop(feeKop)} грн.

Додатки:
1. Довідка-розрахунок заборгованості за особовим рахунком${personalAccount ? ` № ${personalAccount}` : ""} квартири № ${apt}.
2. Копія протоколу загальних зборів про затвердження кошторису та тарифів.
3. Копія витягу з ЄДР та Статуту ${orgName}.
4. Копія досудової претензії (вимоги) або ухвали про скасування судового наказу (за наявності).
5. Документ про сплату судового збору (${fmtKop(feeKop)} грн).
6. Докази надіслання копії позовної заяви з додатками Відповідачу.

«${appDate}» року

Голова правління ${orgName} ______________ ${formatSigners(org?.headName)}`;
}

function generateRestructureAgreement({
    org,
    apt,
    ownerName,
    ownerCode,
    personalAccount,
    area,
    debtKop,
    monthlyKop,
    monthsCount = 6,
    startDate = new Date().toISOString().slice(0, 10),
    agreementDate = new Date().toISOString().slice(0, 10)
}) {
    const principalKop = Math.abs(Math.round(Number(debtKop || 0)));
    const months = Math.max(1, Number(monthsCount || 6));
    const installmentKop = Math.round(principalKop / months);
    const orgName = org?.name || "ОСББ «Успіх-25»";
    const address = org?.address || DEFAULT_HOUSE_ADDRESS;
    const owner = String(ownerName || "").trim() || `Співвласник квартири № ${apt}`;
    const accText = personalAccount ? ` (особовий рахунок № ${personalAccount})` : "";

    let scheduleText = "";
    let rem = principalKop;
    const startYr = Number(startDate.slice(0, 4)) || new Date().getFullYear();
    const startMo = Number(startDate.slice(5, 7)) || (new Date().getMonth() + 1);

    for (let i = 0; i < months; i++) {
        const d = new Date(Date.UTC(startYr, startMo - 1 + i, 1));
        const moName = d.toLocaleDateString("uk-UA", { month: "long", year: "numeric" });
        const curKop = (i === months - 1) ? rem : installmentKop;
        rem -= curKop;
        scheduleText += `  ${i + 1}. ${moName} — ${fmtKop(curKop)} грн;\n`;
    }

    return `ДОГОВІР № РБ-${apt}
про реструктуризацію заборгованості зі сплати внесків на утримання будинку

м. Одеса                                                    «${agreementDate}» року

${orgName} (код ЄДРПОУ ${org?.edrpou || "40562894"}), в особі Голови правління ${org?.headName || "____________________"}, що діє на підставі Статуту (надалі — «ОСББ»), з однієї сторони,
та Співвласник квартири № ${apt}${area ? ` (площа ${String(area).replace(".", ",")} м²)` : ""} — ${owner}${ownerCode ? ` (РНОКПП ${ownerCode})` : ""} (надалі — «Співвласник»), з іншої сторони,
уклали цей Договір про наступне:

1. ПРЕДМЕТ ДОГОВОРУ
1.1. Співвласник визнає наявність простроченої заборгованості перед ОСББ зі сплати внесків на утримання будинку за адресою: ${address}, кв. ${apt}${accText} станом на «${agreementDate}» року у загальній сумі ${fmtKop(principalKop)} грн.
1.2. ОСББ надає Співвласнику розстрочення виплати зазначеної заборгованості на ${months} місяців.

2. ГРАФІК ПОГАШЕННЯ ЗАБОРГОВАНОСТІ
2.1. Співвласник зобовʼязується щомісяця до 20-го числа вносити платіж у рахунок погашення реструктуризованого боргу згідно з графіком:
${scheduleText}
3. ОБОВʼЯЗКИ СТОРІН
3.1. Співвласник зобовʼязується одночасно з погашенням реструктуризованої заборгованості своєчасно і в повному обсязі сплачувати щомісячні поточні внески на утримання будинку${monthlyKop ? ` (поточний розмір — ${fmtKop(monthlyKop)} грн/міс.)` : ""}.
3.2. ОСББ зобовʼязується не звертатися до суду із заявою про видачу судового наказу чи позовом про стягнення заборгованості за умови належного виконання Співвласником умов цього Договору.

4. ВІДПОВІДАЛЬНІСТЬ СТОРІН
4.1. У разі порушення Співвласником графіка платежів або несплати поточного внеску більше ніж на 10 календарних днів, ОСББ має право в односторонньому порядку розірвати цей Договір та звернутися до суду для примусового стягнення всієї непогашеної суми заборгованості з покладанням на Співвласника судового збору та витрат на правничу допомогу.

5. РЕКВІЗИТИ ТА ПІДПИСИ СТОРІН

ОСББ:                                     СПІВВЛАСНИК:
${orgName}                                ${owner}
Код ЄДРПОУ: ${org?.edrpou || "40562894"}  Адреса: ${address}, кв. ${apt}
Адреса: ${address}                        ${personalAccount ? `Особовий рахунок: ${personalAccount}` : ""}
IBAN: ${org?.iban || "UA___________________________"}

Голова правління                          Співвласник
____________ ${formatSigners(org?.headName)}       ____________ / ${owner} /
М.П.`;
}

/**
 * Довідка-розрахунок заборгованості за особовим рахунком (Додаток № 1 до заяви у суд).
 * Формується автоматично з записів ledger квартири або підсумкового сальдо.
 */
function generateDebtCalculation({
    org,
    apt,
    ownerName,
    ownerCode,
    personalAccount,
    area,
    debtKop,
    monthlyKop,
    periodFrom,
    periodTo,
    ledgerEntries = [],
    calcDate = new Date().toISOString().slice(0, 10)
}) {
    const principalKop = Math.abs(Math.round(Number(debtKop || 0)));
    const orgName = org?.name || "ОСББ «Успіх-25»";
    const edrpou = org?.edrpou || "40562894";
    const address = org?.address || DEFAULT_HOUSE_ADDRESS;
    const owner = String(ownerName || "").trim() || `Співвласник кв. № ${apt}`;

    const sorted = [...(ledgerEntries || [])]
        .filter(e => e && (e.kind === "opening" || e.kind === "charge" || e.kind === "payment" || e.kind === "refund"))
        .sort((a, b) => {
            const ta = a.at instanceof Date ? a.at.getTime() : (a.at ? new Date(a.at).getTime() : 0);
            const tb = b.at instanceof Date ? b.at.getTime() : (b.at ? new Date(b.at).getTime() : 0);
            return ta - tb;
        });

    let tableLines = "";
    let openingKop = 0;
    let totalChargedKop = 0;
    let totalPaidKop = 0;
    let runningBalanceKop = 0;

    if (sorted.length > 0) {
        tableLines += "--------------------------------------------------------------------------------\n";
        tableLines += "Дата       | Період  | Операція             | Нараховано | Сплачено   | Сальдо\n";
        tableLines += "--------------------------------------------------------------------------------\n";
        for (const e of sorted) {
            const dt = e.at instanceof Date ? e.at : (e.at ? new Date(e.at) : null);
            const dateStr = dt && !Number.isNaN(dt.getTime())
                ? dt.toLocaleDateString("uk-UA", { day: "2-digit", month: "2-digit", year: "numeric" })
                : "—         ";
            const periodStr = String(e.period || "—").padEnd(7, " ");
            const amtKop = e.amountKop !== undefined ? Math.round(Number(e.amountKop)) : grnToKop(e.amount);

            let opLabel = "";
            let chgStr = "0,00";
            let payStr = "0,00";

            if (e.kind === "opening") {
                runningBalanceKop = amtKop;
                openingKop = amtKop;
                opLabel = "Вхідний залишок";
                if (amtKop < 0) chgStr = fmtKop(Math.abs(amtKop));
                else payStr = fmtKop(amtKop);
            } else if (e.kind === "charge") {
                const c = Math.abs(amtKop);
                runningBalanceKop -= c;
                totalChargedKop += c;
                opLabel = "Нараховано внесок";
                chgStr = fmtKop(c);
            } else if (e.kind === "refund") {
                const r = Math.abs(amtKop);
                runningBalanceKop -= r;
                totalChargedKop += r;
                opLabel = "Повернення переплати";
                chgStr = fmtKop(r);
            } else if (e.kind === "payment") {
                const p = Math.abs(amtKop);
                runningBalanceKop += p;
                totalPaidKop += p;
                opLabel = "Оплата внеску";
                payStr = fmtKop(p);
            }

            const balStr = `${runningBalanceKop < 0 ? "-" : ""}${fmtKop(Math.abs(runningBalanceKop))}`;
            tableLines += `${dateStr.padEnd(10, " ")} | ${periodStr} | ${opLabel.padEnd(20, " ")} | ${chgStr.padStart(10, " ")} | ${payStr.padStart(10, " ")} | ${balStr.padStart(10, " ")}\n`;
        }
        tableLines += "--------------------------------------------------------------------------------\n";
        tableLines += `Вхідний залишок: ${openingKop < 0 ? "борг " : ""}${fmtKop(Math.abs(openingKop))} грн\n`;
        tableLines += `Всього нараховано за період: ${fmtKop(totalChargedKop)} грн\n`;
        tableLines += `Всього сплачено за період:   ${fmtKop(totalPaidKop)} грн\n`;
    } else {
        tableLines += `(Детальна помісячна історія операцій наведена за особовим рахунком № ${personalAccount || apt})\n`;
        if (monthlyKop) {
            tableLines += `Діючий розмір щомісячного внеску: ${fmtKop(monthlyKop)} грн/міс.\n`;
        }
    }

    return `${orgName}
Код ЄДРПОУ ${edrpou} · ${address}
${org?.iban ? `Поточний рахунок IBAN: ${org.iban}` : ""}

ДОВІДКА-РОЗРАХУНОК ЗАБОРГОВАНОСТІ
за особовим рахунком № ${personalAccount || apt} (квартира № ${apt})
станом на «${calcDate}» року

1. Адреса приміщення: ${address}, кв. № ${apt}
2. Особовий рахунок: ${personalAccount || "не присвоєно"}
3. Загальна площа: ${area ? `${String(area).replace(".", ",")} м²` : "згідно з техпаспортом"}
4. Співвласник (Боржник): ${owner}${ownerCode ? ` (РНОКПП ${ownerCode})` : ""}
5. Розрахунковий період: з ${periodFrom || "початку обліку"} по ${periodTo || calcDate.slice(0, 7)}

РОЗРАХУНОК НАРАХУВАНЬ ТА ОПЛАТ (грн):
${tableLines}
ЗАГАЛЬНА СУМА ЗАБОРГОВАНОСТІ ДО СТЯГНЕННЯ: ${fmtKop(principalKop)} грн.
(Штрафні санкції та пеня у період дії воєнного стану відповідно до Постанови КМУ № 206 / № 1405 не нараховувалися — 0,00 грн).

Довідку видано для подання до суду (${COURT_DEFAULT_NAME}).

Голова правління ${orgName} ______________ ${formatSigners(org?.headName)}
М.П.`;
}

// ============================================================
// ХІД СПРАВИ: кроки, наступна дія, графік реструктуризації.
// Одна логіка для сервера (етап із статусу) і кабінету (підказки).
// ============================================================

/** Кроки, якими правління бачить справу. Статус — точніший стан усередині кроку. */
const CLAIM_STEPS = {
    start: "Без дій",
    pretrial: "Претензія",
    court: "Суд",
    enforce: "Виконання",
    agreement: "Реструктуризація",
    closed: "Закрито"
};

const STATUS_STEP = {
    none: "start",
    warning: "pretrial",
    claim: "pretrial",
    restructured: "agreement",
    court_order_filed: "court",
    court_order_issued: "court",
    court_order_canceled: "court",
    lawsuit_filed: "court",
    lawsuit_satisfied: "court",
    enforcement: "enforce",
    settled: "closed"
};

const STATUS_STAGE = {
    none: "pre_trial",
    warning: "pre_trial",
    claim: "pre_trial",
    restructured: "pre_trial",
    court_order_filed: "court_order",
    court_order_issued: "court_order",
    court_order_canceled: "court_order",
    lawsuit_filed: "lawsuit",
    lawsuit_satisfied: "lawsuit",
    enforcement: "enforcement",
    settled: "settled"
};

/** Скільки чекати оплату після претензії: 10 днів у тексті вимоги + доставка листа. */
const PRETRIAL_WAIT_DAYS = 14;
/** Через скільки днів після подання до суду варто перевірити, чи є рішення. */
const COURT_CHECK_DAYS = 30;

const claimStep = status => STATUS_STEP[status] || "start";
const stageForStatus = status => STATUS_STAGE[status] || "pre_trial";

function addDays(iso, days) {
    const m = String(iso || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return "";
    const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3] + days));
    return d.toISOString().slice(0, 10);
}

/**
 * Що робити далі зі справою. urgent — дія вже на часі (потрапляє в «Потребують дії»);
 * doc — документ, який треба сформувати; mark — у який статус перевести справу
 * після надсилання й яку дату записати; check — що перевірити в реєстрах.
 */
function nextClaimAction({ status = "none", months = 0, claimDate = "", courtOrderDate = "", lawsuitDate = "", today = new Date().toISOString().slice(0, 10) } = {}) {
    const overdue = Number(months || 0) >= 3;
    switch (status) {
        case "none":
            return overdue
                ? { key: "claim", title: "Надіслати досудову претензію", hint: "Борг понад 3 місяці. Претензія — перший офіційний крок і доказ для суду.", doc: "claim", mark: { status: "claim", dateField: "claimDate" }, urgent: true }
                : { key: "warning", title: "Нагадати про борг", hint: "Борг до 3 місяців — достатньо нагадування. Претензію готують з 3-го місяця прострочення.", mark: { status: "warning", dateField: "claimDate" }, urgent: false };
        case "warning":
            return overdue
                ? { key: "claim", title: "Надіслати досудову претензію", hint: "Нагадування не допомогло, борг понад 3 місяці.", doc: "claim", mark: { status: "claim", dateField: "claimDate" }, urgent: true }
                : { key: "wait", title: "Чекаємо оплату після нагадування", hint: "Якщо борг досягне 3 місяців — готуйте претензію.", urgent: false };
        case "claim": {
            const due = addDays(claimDate, PRETRIAL_WAIT_DAYS);
            if (due && today < due) {
                return { key: "wait", title: `Чекаємо оплату до ${due.split("-").reverse().join(".")}`, hint: "Строк добровільної сплати за претензією ще не минув.", waitUntil: due, urgent: false };
            }
            return { key: "court_order", title: "Подати заяву про судовий наказ", hint: "Строк претензії минув. До заяви додайте довідку-розрахунок боргу; судовий збір — 0,1 прожиткового мінімуму.", doc: "court_order", mark: { status: "court_order_filed", dateField: "courtOrderDate" }, urgent: true };
        }
        case "court_order_filed": {
            const late = courtOrderDate && today >= addDays(courtOrderDate, COURT_CHECK_DAYS);
            return { key: "court_wait", title: late ? "Перевірити, чи видано судовий наказ" : "Суд розглядає заяву", hint: "Наказ видають протягом 5 днів (ст. 167 ЦПК). Стан справи видно в судовому реєстрі.", check: "court", urgent: Boolean(late) };
        }
        case "court_order_issued":
            return { key: "enforce", title: "Передати судовий наказ до виконавчої служби", hint: "Якщо боржник за 15 днів не подав заяву про скасування (ст. 170 ЦПК), наказ набирає сили — пред'явіть його до ДВС.", mark: { status: "enforcement", dateField: "enforcementDate" }, urgent: true };
        case "court_order_canceled":
            return { key: "lawsuit", title: "Подати позовну заяву", hint: "Наказ скасовано — стягнення продовжується в позовному провадженні (ст. 171 ЦПК).", doc: "lawsuit", mark: { status: "lawsuit_filed", dateField: "lawsuitDate" }, urgent: true };
        case "lawsuit_filed": {
            const late = lawsuitDate && today >= addDays(lawsuitDate, COURT_CHECK_DAYS * 2);
            return { key: "court_wait", title: late ? "Перевірити хід розгляду позову" : "Суд розглядає позов", hint: "Дати засідань і рішення — у судовому реєстрі.", check: "court", urgent: Boolean(late) };
        }
        case "lawsuit_satisfied":
            return { key: "enforce", title: "Передати рішення до виконавчої служби", hint: "Отримайте виконавчий лист і пред'явіть його до ДВС або приватного виконавця.", mark: { status: "enforcement", dateField: "enforcementDate" }, urgent: true };
        case "enforcement":
            return { key: "enforce_wait", title: "Контроль виконавчого провадження", hint: "Перевіряйте стан провадження в АСВП і надходження оплат.", check: "court", urgent: false };
        case "restructured":
            return { key: "schedule", title: "Контроль графіка погашення", hint: "Якщо платежі за графіком припиняться — повертайтеся до претензії або суду.", doc: "restructure", urgent: false };
        case "settled":
            return { key: "done", title: "Справу закрито", hint: "Борг погашено.", urgent: false };
        default:
            return { key: "none", title: "Оберіть стан справи", hint: "", urgent: false };
    }
}

/** Графік реструктуризації: рівні щомісячні платежі, залишок копійок — в останньому. */
function restructureSchedule({ debtKop = 0, months = 6, start = "" } = {}) {
    const total = Math.abs(Math.round(Number(debtKop || 0)));
    const n = Math.min(36, Math.max(1, Math.round(Number(months || 1))));
    const base = Math.floor(total / n);
    const m = String(start || "").match(/^(\d{4})-(\d{2})/);
    const y0 = m ? +m[1] : new Date().getFullYear();
    const mo0 = m ? +m[2] - 1 : new Date().getMonth();
    return Array.from({ length: n }, (_, i) => {
        const d = new Date(Date.UTC(y0, mo0 + i, 1));
        return { n: i + 1, period: d.toISOString().slice(0, 7), amountKop: i === n - 1 ? total - base * (n - 1) : base };
    });
}

export {
    CLAIM_STEPS,
    PRETRIAL_WAIT_DAYS,
    COURT_CHECK_DAYS,
    claimStep,
    stageForStatus,
    nextClaimAction,
    restructureSchedule,
    COURT_DEFAULT_NAME,
    COURT_DEFAULT_ADDRESS,
    DEFAULT_HOUSE_ADDRESS,
    COURT_FEE_ORDER_KOP,
    COURT_FEE_MIN_LAWSUIT_KOP,
    CLAIM_STAGES,
    CLAIM_STATUSES,
    grnToKop,
    calculateClaimTotals,
    generatePreTrialClaim,
    generateCourtOrderApp,
    generateLawsuitApp,
    generateRestructureAgreement,
    generateDebtCalculation,
    fmtKop
};
