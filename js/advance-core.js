'use strict';
// ============================================================
// Авансові звіти та розрахунки з підзвітними особами (Рахунок 372)
// для ОСББ: придбання господарських товарів, палива для генератора,
// дрібних запчастин та інструменту за власні кошти або аванс.
//
// НОРМАТИВНА БАЗА УКРАЇНИ:
//   1. Наказ Мінфіну України № 841 (у редакції наказу № 289):
//      Типова форма «Звіт про використання коштів / електронних грошей,
//      виданих на відрядження або під звіт» та Порядок його складання.
//   2. пп. 170.9.1–170.9.4 Податкового кодексу України (ПКУ):
//      Підтвердні документи (фіскальні чеки РРО/ПРРО, товарні чеки,
//      квитанції, акти), строки подання звіту, оподаткування неповернутого
//      авансу (ПДФО 18 %, військовий збір 5 %).
//   3. Інструкція про застосування Плану рахунків № 291:
//      Рахунок 372 «Розрахунки з підзвітними особами».
//      • Кредит 372: затвердження витрат за авансовим звітом:
//        - Дт 92 Кт 372: поточні витрати на утримання будинку
//          (канцтовари, вивіз сміття, пошта, дрібні послуги);
//        - Дт 20 Кт 372: оприбуткування виробничих запасів (паливо
//          для генератора, фарба, лампи, сантехнічні запчастини);
//        - Дт 22 Кт 372: оприбуткування МШП (лопати, ключі, інвентар);
//        - Дт 11 Кт 372: придбання МНМА (подовжувачі, дрібний інструмент).
//      • Дебет 372: видача авансу або виплата компенсації перевитрати:
//        - Дт 372 Кт 311: перерахування коштів з рахунку ОСББ на картку;
//      • Повернення невикористаного залишку:
//        - Дт 311 Кт 372: внесення залишку на рахунок ОСББ.
//      • Синхронно за НП(С)БО 15 (п. 18): усі визнані витрати Дт 92
//        закриваються на дохід цільового фінансування Дт 48 Кт 719,
//        що забезпечує нульовий фінансовий результат ОСББ.
// ============================================================

export const MAX_KOP = 100_000_000_000;

export const ADVANCE_DOC_TYPES = {
    fiscal_receipt: 'Фіскальний чек РРО/ПРРО',
    sales_receipt: 'Товарний чек / розрахункова квитанція',
    waybill: 'Видаткова накладна',
    act: 'Акт виконаних робіт / послуг',
    ticket: 'Квитанція / проїзний документ',
    other: 'Інший підтвердний документ'
};

export const ADVANCE_STATUS_LABELS = {
    draft: ['Чернетка', ''],
    pending: ['Чекає затвердження', 'is-review'],
    approved: ['Затверджено (до виплати)', 'is-income'],
    settled: ['Розраховано (виплачено)', 'is-done'],
    rejected: ['Відхилено', 'is-error']
};

export const POSTING_ACCOUNTS = {
    92: '92 · Витрати на утримання будинку (послуги, дрібні витрати)',
    20: '20 · Виробничі запаси (паливо, будматеріали, запчастини)',
    22: '22 · Малоцінні та швидкозношувані предмети (МШП, інвентар)',
    11: '11 · Малоцінні необоротні матеріальні активи (МНМА)'
};

export const validDate = d => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(d || ''))) return false;
    const dt = new Date(`${d}T00:00:00Z`);
    return !Number.isNaN(dt.getTime()) && dt.toISOString().slice(0, 10) === d;
};

export const validPeriod = p => /^\d{4}-(0[1-9]|1[0-2])$/.test(String(p || ''));

export function calculateReportTotals(report) {
    const lines = Array.isArray(report?.lines) ? report.lines : [];
    const spentKop = lines.reduce((sum, l) => sum + Math.max(0, Number(l?.amountKop || 0)), 0);
    const advanceKop = Math.max(0, Number(report?.advanceKop || 0));
    const balanceKop = spentKop - advanceKop;
    const reimburseKop = Math.max(0, balanceKop);
    const returnKop = Math.max(0, -balanceKop);
    const reimbursedKop = Math.max(0, Number(report?.reimbursedKop || 0));
    const returnedKop = Math.max(0, Number(report?.returnedKop || 0));
    const pendingReimburseKop = Math.max(0, reimburseKop - reimbursedKop);
    const pendingReturnKop = Math.max(0, returnKop - returnedKop);

    return {
        linesCount: lines.length,
        spentKop,
        advanceKop,
        balanceKop,
        reimburseKop,
        returnKop,
        reimbursedKop,
        returnedKop,
        pendingReimburseKop,
        pendingReturnKop,
        isFullySettled: pendingReimburseKop === 0 && pendingReturnKop === 0
    };
}

export function checkAdvanceReport(rep) {
    if (!rep) return 'Немає даних звіту';
    const name = String(rep.personName || '').trim();
    if (name.length < 2 || name.length > 200) return 'Вкажіть ПІБ підзвітної особи';
    if (!validDate(rep.date)) return 'Вкажіть дату складання авансового звіту (РРРР-ММ-ДД)';
    if (!validPeriod(rep.period)) return 'Вкажіть звітний місяць (РРРР-ММ)';
    const purpose = String(rep.purpose || '').trim();
    if (purpose.length < 3 || purpose.length > 300) return 'Вкажіть призначення підзвітних коштів (напр. «Закупівля палива для генератора та замків»)';

    const advance = Number(rep.advanceKop || 0);
    if (!Number.isInteger(advance) || advance < 0 || advance > MAX_KOP) {
        return 'Сума отриманого авансу має бути невідʼємним цілим числом у копійках';
    }

    const lines = Array.isArray(rep.lines) ? rep.lines : [];
    if (!lines.length) return 'Додайте хоча б один підтвердний документ (чек, квитанцію або накладну)';
    if (lines.length > 100) return 'У звіті не може бути більше 100 позицій';

    for (let i = 0; i < lines.length; i++) {
        const l = lines[i];
        const num = i + 1;
        if (!ADVANCE_DOC_TYPES[l.docType]) return `Рядок ${num}: оберіть вид підтвердного документа`;
        if (!String(l.number || '').trim()) return `Рядок ${num}: вкажіть номер документа / чека`;
        if (!validDate(l.date)) return `Рядок ${num}: вкажіть коректну дату документа`;
        if (l.date > rep.date) return `Рядок ${num}: дата чека (${l.date}) не може бути пізнішою за дату звіту (${rep.date})`;
        const amount = Number(l.amountKop);
        if (!Number.isInteger(amount) || amount <= 0 || amount > MAX_KOP) {
            return `Рядок ${num}: сума за чеком має бути більшою за нуль`;
        }
        const acc = String(l.postingAcc || '92');
        if (!POSTING_ACCOUNTS[acc]) return `Рядок ${num}: оберіть коректний рахунок обліку (92, 20, 22 або 11)`;
        if (acc !== '92' && !String(l.assetId || '').trim()) {
            return `Рядок ${num}: для оприбуткування ТМЦ/МШП вкажіть інвентарний або номенклатурний код`;
        }
    }
    return null;
}

export function suggestReportNumber(period, existingList = []) {
    const p = String(period || '').slice(0, 7);
    const prefix = `АЗ-${p}/`;
    let maxNum = 0;
    for (const r of existingList || []) {
        const numStr = String(r.number || r.id || '');
        if (numStr.startsWith(prefix)) {
            const n = Number(numStr.slice(prefix.length).replace(/\D+/g, ''));
            if (Number.isInteger(n) && n > maxNum) maxNum = n;
        }
    }
    return `${prefix}${String(maxNum + 1).padStart(2, '0')}`;
}

export function buildAdvanceEntries(report, defaultFund = 'main') {
    if (!report || report.status !== 'approved' && report.status !== 'settled') return [];
    const lines = Array.isArray(report.lines) ? report.lines : [];
    const fund = report.fundId || defaultFund;
    const person = String(report.personName || 'Підзвітна особа').trim();
    const date = report.date;
    const period = report.period || date.slice(0, 7);
    const ref = report.id;

    return lines.map((l, idx) => {
        const acc = l.postingAcc || '92';
        const dA = (acc !== '92' && l.assetId) ? l.assetId : (l.item || 'office');
        const memo = `Авансовий звіт № ${report.number || ref} (${person}): ${l.desc || l.supplier || ADVANCE_DOC_TYPES[l.docType] || 'витрати'}`;
        return {
            date,
            period,
            dr: acc,
            cr: '372',
            dA,
            cA: person,
            kop: Number(l.amountKop),
            fund,
            src: 'advance_report',
            ref,
            lineIndex: idx,
            memo: memo.slice(0, 300)
        };
    });
}

export function reimbursementPurpose(report) {
    const person = String(report.personName || '').trim();
    const num = report.number || report.id;
    const date = report.date ? report.date.split('-').reverse().join('.') : '';
    const purp = report.purpose ? `, ${report.purpose}` : '';
    return `Відшкодування витрат за авансовим звітом № ${num} від ${date}${purp}, без ПДВ`.replace(/\s+/g, ' ').slice(0, 380);
}

