// Демо-будинок: контрольний сценарій тестової бухгалтерії
// (functions/accounting-test-fixture.json), переписаний «по-живому».
// Структура будинку й нарахування — ті самі, але:
//  • співвласники й платники мають правдоподібні ПІБ, документи — витяги з ДРРП;
//  • не всі платять вчасно: є хронічні боржники, пропуски й оплата за два місяці;
//  • виписка містить оплати постачальникам за документами, оренду, плату
//    провайдера за обладнання й комісію банку.
// Дати у файлі на рік уперед — тестова бухгалтерія зсуває їх на рік назад.
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { ownerNames, ownershipDoc, hash, monthDocs, supplierOf, PERIODS, PEOPLE, TENANT, PROVIDER, BANK, MONTH_NAMES } from './data.mjs';

const SOURCE = fileURLToPath(new URL('../../functions/accounting-test-fixture.json', import.meta.url));
const plusYear = date => `${Number(date.slice(0, 4)) + 1}${date.slice(4)}`;          // 2025-10-28 → 2026-10-28
const human = date => `${date.slice(8, 10)}.${date.slice(5, 7)}.${date.slice(0, 4)}`;
const money = kop => `${Math.floor(kop / 100)},${String(kop % 100).padStart(2, '0')}`;
const monthWord = period => `${MONTH_NAMES[Number(period.slice(5, 7)) - 1]} ${period.slice(0, 4)}`;
const DOC_GEN = { invoice: 'рахунком', act: 'актом', waybill: 'накладною' };

/** Квартири, що не платять зовсім (для претензійної роботи), і власна квартира демо-мешканця. */
export const DEBTORS = ['13', '58', '141', '199', '233', '287'];

export async function demoFixture() {
    const fixture = JSON.parse(await readFile(SOURCE, 'utf8'));
    const files = fixture.files;
    const { byAlias, firstOwner } = ownerNames(files.owners);

    files.owners = files.owners
        .replace(/Тестовий співвласник (TEST-\d+)/g, (_, alias) => byAlias.get(alias))
        .replace(/Синтетичний витяг № TEST-(\w+)-(\d+)/g, (_, premise, n) => ownershipDoc(premise, n));

    const SUPPLIER_NAME = 'ТОВ «Аудит-Консалт Плюс»';
    files.suppliers = files.suppliers.replace('ТОВ «Синтетичний постачальник»', SUPPLIER_NAME);
    files.legacyExpenses = files.legacyExpenses.replace(/LEGACY-/g, 'АКП-');
    fixture.services = fixture.services.replace(/SERVICE-/g, 'АКП-');
    fixture.employee = fixture.employee.replace('TEST-1', '001').replace('Працівник Тестовий', PEOPLE.accountant.name).replace(/2026-01-01\s*$/, '2026-10-01');

    // Особовий рахунок → приміщення.
    const premiseOf = new Map(files.accounts.replace(/^﻿/, '').split(/\r?\n/).slice(1).filter(Boolean).map(l => { const [acc, p] = l.split(';'); return [acc, p]; }));
    const eol = fixture.bank.includes('\r\n') ? '\r\n' : '\n';
    const [head, ...rows] = fixture.bank.replace(/^﻿/, '').split(/\r?\n/).filter(Boolean);
    const out = [];
    const skipped = new Set();
    for (const line of rows) {
        const c = line.split(';');
        c[1] = c[1].replace(/^TEST-/, 'PB-');
        c[5] = c[5].replace('ТОВ «Синтетичний постачальник»', SUPPLIER_NAME);
        c[8] = c[8].replace(/SERVICE-|LEGACY-/g, 'АКП-');
        const payer = c[5].match(/^Тестовий платник (\d+)$/);
        if (payer) {
            const account = (c[8].match(/о\/р (\d+)/) || [])[1];
            const premise = premiseOf.get(account) || payer[1];
            const month = c[0].slice(0, 7);
            c[5] = firstOwner.get(premise) || c[5];
            if (DEBTORS.includes(premise)) continue;
            // Хтось пропускає місяць (у грудні половина з них платить за два).
            const h = hash(`${premise}:${month}`) % 100;
            if (premise !== '7' && h < 6) { skipped.add(premise); continue; }
            if (month.endsWith('-12') && skipped.has(premise) && h % 2 === 0) {
                const kop = Math.round(Number(c[4].replace(',', '.')) * 100) * 2;
                c[4] = money(kop);
                c[8] = c[8].replace(/, 2026-12$/, ', 2026-11, 2026-12');
            }
        }
        out.push(c.join(';'));
    }

    // Оплати постачальникам за документами (наступного місяця; разові — одразу).
    const add = (date, ref, debitKop, creditKop, name, iban, code, purpose) =>
        out.push([plusYear(date), ref, ACCOUNT, debitKop ? money(debitKop) : '0', creditKop ? money(creditKop) : '0', name, iban, code, purpose].join(';'));
    const ACCOUNT = fixture.controls.bank;
    for (const period of PERIODS) {
        for (const d of monthDocs(period)) {
            if (!PERIODS.includes(d.payDate.slice(0, 7))) continue;
            const s = supplierOf(d.supplier);
            add(d.payDate, `PB-PAY-${d.supplier}-${d.period}`, d.amountKop, 0, s.name, s.iban, s.code,
                `Оплата за ${DOC_GEN[d.docType]} № ${d.number} від ${human(plusYear(d.date))}, ${d.description}, без ПДВ`);
        }
        add(`${period}-10`, `PB-RENT-${period}`, 0, 450000, TENANT.name, TENANT.iban, TENANT.code, `Оренда нежитлового приміщення згідно з договором № 12/24 за ${monthWord(period)}`);
        add(`${period}-15`, `PB-EQ-${period}`, 0, 180000, PROVIDER.name, PROVIDER.iban, PROVIDER.code, `Плата за розміщення обладнання зв’язку на даху будинку за ${monthWord(period)}`);
        add(`${period}-${period.endsWith('-11') ? '29' : '30'}`, `PB-FEE-${period}`, 22500, 0, BANK.name, '', BANK.code, `Комісія за розрахунково-касове обслуговування рахунку за ${monthWord(period)}`);
    }
    fixture.bank = `﻿${[head, ...out].join(eol)}`;
    return fixture;
}
