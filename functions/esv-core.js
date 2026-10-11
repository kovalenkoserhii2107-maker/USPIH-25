'use strict';
// База ЄСВ розподіляється в межах ОДНІЄЇ максимальної бази місяця:
// зарплата, відпускні, лікарняні; різниця до МЗП — окремо (тип 13).
// Округлення — за кожним рядком Д1. Ті самі копійки йдуть у відомість
// і платіж ЄСВ; XML не перераховує затверджену суму.
function esvParts(row, rate) {
    let left = rate.minWageKop * rate.maxBaseMult;
    const sick = (row.sickKop || 0) + (row.fundSickKop || 0);
    const vacation = row.vacationKop || 0;
    const parts = [];
    for (const [kind, grossKop] of [['regular', row.grossKop - vacation - sick], ['vacation', vacation], ['sick', sick]]) {
        if (kind !== 'regular' && !grossKop) continue;
        const baseKop = Math.min(Math.max(0, grossKop), left);
        left -= baseKop;
        parts.push({ kind, grossKop, baseKop, esvKop: Math.round(baseKop * rate.esv / 10000) });
    }
    const topUpKop = Math.max(0, row.esvBaseKop - parts.reduce((s, r) => s + r.baseKop, 0));
    if (topUpKop) parts.push({ kind: 'topup', grossKop: 0, baseKop: topUpKop, esvKop: Math.round(topUpKop * rate.esv / 10000) });
    return parts;
}
module.exports = { esvParts };
