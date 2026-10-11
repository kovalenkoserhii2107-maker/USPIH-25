'use strict';
// 4ДФ: ФОП за перевіреним витягом/КВЕД — ознака 157 без утримань.
// Нарахований дохід — основні затверджені документи; виплачений —
// фактичні списання цього місяця. Підтвердний акт до рахунку не дублюється.
const { validRnokpp } = require('./expenses-core');
function fopReport({ period, expenses = [], suppliers = new Map(), bankTx = [] }) {
    const iban = v => String(v || '').replace(/\s+/g, '').toUpperCase();
    const income = new Map(), checks = [];
    const byExpense = new Map(expenses.map(e => [e.id, e]));
    const byTx = new Map(bankTx.map(t => [t.id, t]));
    const identity = (e, tx) => {
        const live = suppliers.get(e?.supplierId);
        if (e?.supplierSnapshot) return { ...e.supplierSnapshot,
            fopChecked: e.supplierSnapshot.fopChecked || Boolean(live?.kind === 'fop' && live.code === e.supplierSnapshot.code && live.fopChecked) };
        if (live) return live;
        const matches = [...suppliers.values()].filter(s => s.kind === 'fop'
            && ((tx?.counterparty?.code && s.code === tx.counterparty.code) || (tx?.counterparty?.account && s.iban && iban(s.iban) === iban(tx.counterparty.account))));
        if (matches.length > 1) checks.push({ level: 'block', text: 'Виплата ФОП має кілька можливих отримувачів — привʼяжіть первинний документ перед 4ДФ' });
        return matches.length === 1 ? matches[0] : null;
    };
    const add = (s, gross, paid, e) => {
        if (s?.kind !== 'fop') return;
        const code = s.code || '';
        const key = code || e?.supplierId || s.id;
        if (!validRnokpp(code)) checks.push({ level: 'block', text: `${s.name}: правильний РНОКПП ФОП потрібен для 4ДФ` });
        if (!s.fopChecked) checks.push({ level: 'block', text: `${s.name}: для ознаки 157 перевірте витяг ФОП і відповідність КВЕД; інакше потрібні утримання` });
        const row = income.get(key) || { personId: `fop:${key}`, name: s.name || e?.supplierName || 'ФОП', rnokpp: code, kind: 'fop', sign: '157',
            grossKop: 0, paidKop: 0, pdfoKop: 0, pdfoPaidKop: 0, vzKop: 0, vzPaidKop: 0, pspCode: '', pspKop: 0 };
        row.grossKop += gross; row.paidKop += paid;
        income.set(key, row);
    };
    for (const e of expenses) if (e.period === period && ['approved', 'paid', 'storno'].includes(e.status)) {
        const s = identity(e);
        if (s?.kind !== 'fop') continue;
        add(s, e.amountKop, 0, e);
        if (!e.supplierSnapshot) checks.push({ level: 'warn', text: `${s.name}: у старому документі немає збережених реквізитів ФОП — звірте код і статус з первинним документом` });
        if (e.status === 'storno') checks.push({ level: 'block', text: `${s.name}: сторно ФОП потребує перевірки періоду коригування 4ДФ в Електронному кабінеті` });
    }
    for (const tx of bankTx) {
        if (tx.period !== period || tx.status !== 'done') continue;
        const returning = tx.direction === 'in' && tx.kind === 'refund';
        const original = returning ? byTx.get(tx.refundOf) : tx;
        if (!original || original.direction !== 'out' || original.kind !== 'expense'
            || ['bank_fee', 'resident_refund', 'salary', 'taxes', 'esv'].includes(original.category)) continue;
        const e = byExpense.get(original.expenseId), s = identity(e, original);
        if (s?.kind !== 'fop') continue;
        if (!Number.isSafeInteger(tx.amountKop) || tx.amountKop <= 0) {
            checks.push({ level: 'block', text: `${s.name}: некоректна сума виплати ФОП у виписці` }); continue;
        }
        if (original.counterparty?.code && original.counterparty.code !== s.code) checks.push({ level: 'block', text: `${s.name}: код отримувача у виписці не збігається з документом ФОП` });
        add(s, 0, returning ? -tx.amountKop : tx.amountKop, e);
        if (returning) checks.push({ level: 'block', text: `${s.name}: повернення виплати ФОП звірте за періодом у 4ДФ в Електронному кабінеті` });
    }
    return { income: [...income.values()].sort((a, b) => a.rnokpp.localeCompare(b.rnokpp)),
        checks: [...new Map(checks.map(c => [c.text, c])).values()] };
}
module.exports = { fopReport };
