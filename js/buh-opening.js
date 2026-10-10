// ============================================================
// Вхідна оборотно-сальдова на 30.09.2026 (у розділі «Проводки»).
//
// Залишки квартир (377) і документів постачальників до початку обліку
// (631) — автоматично; банк, каса, фонди, борги й аванси — рядками.
// Бухгалтер вносить, голова затверджує, коли дебет = кредит. Сервер
// (journalAction: opening, saveOpening, approveOpening) перевіряє все
// ще раз; після першого закритого місяця ОСВ не змінюється.
// ============================================================
import { session } from './firebase.js';
import { escapeHtml, toast, setBusy, confirmDialog } from './ui.js';
import { journalAct, loadOpeningData } from './buh-data.js';
import { fmtKop, toKop } from './charges-core.js';

const PURPOSE = { current: 'поточний', reserve: 'резервний фонд', repair: 'ремонтний фонд', deposit: 'депозит' };
const STATUS = { none: ['не внесено', 'is-review'], draft: ['чекає затвердження голови', 'is-review'], approved: ['затверджено', 'is-payment'] };
const money2 = k => (k ? (k / 100).toFixed(2).replace('.', ',') : '');

let octx = null;
let rows = [];

export async function loadOpening(host) {
    octx = await loadOpeningData();
    rows = octx.lines.map(l => ({ ...l }));
    render(host);
}

/** Рядки з полів форми (щоб додавання рядка не губило введене). */
function sync(host) {
    const out = [];
    for (const tr of host.querySelectorAll('tr[data-row]')) {
        const v = f => tr.querySelector(`[data-f="${f}"]`)?.value.trim() || '';
        const dr = toKop(v('dr')), cr = toKop(v('cr'));
        if ((v('dr') && dr === null) || (v('cr') && cr === null)) throw new Error('Суми вказуйте в гривнях, напр. 12 500,00');
        out.push({ acc: v('acc'), a: v('a'), side: dr ? 'dr' : cr ? 'cr' : '', kop: dr || cr || 0, memo: v('memo') });
    }
    rows = out;
    return out;
}

function totals(list) {
    const t = { ...octx.totals };
    const manual = side => list.filter(l => l.side === side).reduce((s, l) => s + (l.kop || 0), 0);
    t.dr = t.autoDr + manual('dr');
    t.cr = t.autoCr + manual('cr');
    t.diff = t.dr - t.cr;
    return t;
}

function rowHtml(l, i, locked) {
    const dis = locked ? ' disabled' : '';
    return `<tr data-row="${i}">
        <td><select class="field-input field-select" data-f="acc" aria-label="Рахунок"${dis}>${Object.entries(octx.accounts).map(([acc, name]) => `<option value="${acc}"${acc === l.acc ? ' selected' : ''}>${acc} · ${escapeHtml(name)}</option>`).join('')}</select></td>
        <td><input class="field-input" data-f="a" list="obA" value="${escapeHtml(l.a || '')}" placeholder="${escapeHtml(octx.needsA[l.acc] || 'необовʼязково')}" aria-label="Аналітика"${dis}></td>
        <td><input class="field-input ob-sum" data-f="dr" inputmode="decimal" value="${l.side === 'dr' ? money2(l.kop) : ''}" aria-label="Дебет"${dis}></td>
        <td><input class="field-input ob-sum" data-f="cr" inputmode="decimal" value="${l.side === 'cr' ? money2(l.kop) : ''}" aria-label="Кредит"${dis}></td>
        <td><input class="field-input" data-f="memo" maxlength="200" value="${escapeHtml(l.memo || '')}" aria-label="Примітка"${dis}></td>
        <td class="t-act">${locked ? '' : `<button type="button" class="btn-ghost-small" data-ob="remove" data-i="${i}" aria-label="Видалити рядок">✕</button>`}</td>
    </tr>`;
}

function footHtml(t) {
    return `<tr><td colspan="2">Разом з автоматичними</td><td class="t-sum">${fmtKop(t.dr)}</td><td class="t-sum">${fmtKop(t.cr)}</td>
        <td colspan="2" class="${t.diff ? 'is-out' : 'is-in'}">${t.diff ? `різниця ${fmtKop(Math.abs(t.diff))} за ${t.diff > 0 ? 'дебетом' : 'кредитом'}` : 'дебет = кредит'}</td></tr>`;
}

function render(host) {
    const chair = session.role === 'chair';
    const locked = octx.locked;
    const [label, cls] = STATUS[octx.status] || STATUS.none;
    const t = totals(rows);
    const banks = octx.banks.map(b => `<li><span><b>…${escapeHtml(b.iban.slice(-4))}</b> ${escapeHtml(PURPOSE[b.purpose] || b.purpose)}${b.name ? ` · ${escapeHtml(b.name)}` : ''}<small>${b.balanceKop === null ? 'залишку з банку ще немає' : `банк: ${fmtKop(b.balanceKop)}${b.balanceAt ? ` на ${new Date(b.balanceAt).toLocaleDateString('uk-UA')}` : ''} · рух з 01.10.2026: ${fmtKop(b.turnoverKop)} · <b>на 30.09 ≈ ${fmtKop(b.suggestKop)}</b>`}</small></span>
        ${!locked && b.suggestKop !== null ? `<button type="button" class="btn-ghost-small" data-ob="bank" data-iban="${escapeHtml(b.iban)}">Підставити</button>` : ''}</li>`).join('');
    host.innerHTML = `<section class="buh-card ob-card">
        <div class="buh-card-head"><h2>Вхідна оборотно-сальдова на ${escapeHtml(octx.date.split('-').reverse().join('.'))}</h2><span class="buh-tag ${cls}">${label}</span></div>
        <p class="buh-note">Залишки всіх рахунків на кінець вересня — з балансу й ОСВ сервісу бухгалтера. Квартири (377) і документи постачальників до жовтня (631) внесено автоматично. Різницю зазвичай закриває залишок цільового фінансування (48) за фондами.${locked ? ' <b>Уже є закритий місяць — ОСВ не змінюється.</b>' : ''}${octx.approvedAt ? ` Затверджено ${escapeHtml(new Date(octx.approvedAt).toLocaleDateString('uk-UA'))}.` : ''}</p>
        ${banks ? `<h3 class="rp-h">Рахунки в банку (311)</h3><ul class="ob-banks">${banks}</ul>` : ''}
        <div class="jr-scroll"><table class="buh-table is-compact ob-table">
            <thead><tr><th>Рахунок</th><th>Аналітика</th><th class="t-sum">Дебет</th><th class="t-sum">Кредит</th><th>Примітка</th><th></th></tr></thead>
            <tbody>${octx.auto.map(l => `<tr class="t-muted"><td>${escapeHtml(l.acc)} <span class="buh-tag is-muted">авто</span></td><td>${escapeHtml(l.a || '')}</td>
                <td class="t-sum">${l.side === 'dr' ? fmtKop(l.kop) : ''}</td><td class="t-sum">${l.side === 'cr' ? fmtKop(l.kop) : ''}</td><td>${escapeHtml(l.memo || '')}</td><td></td></tr>`).join('')}
                ${rows.map((l, i) => rowHtml(l, i, locked)).join('')}</tbody>
            <tfoot id="obFoot">${footHtml(t)}</tfoot>
        </table></div>
        <datalist id="obA">${[...octx.banks.map(b => b.iban), ...octx.suppliers].map(v => `<option value="${escapeHtml(v)}">`).join('')}</datalist>
        ${locked ? '' : `<div class="rp-actions">
            <button type="button" class="btn-soft btn-compact" data-ob="add">+ Рядок</button>
            <button type="button" class="btn-soft btn-compact" data-ob="fund" title="Додати різницю на 48 «Цільове фінансування»">Різниця → 48</button>
            <button type="button" class="btn-primary btn-compact" data-ob="save">Зберегти</button>
            ${chair && octx.status === 'draft' && !octx.totals.diff ? '<button type="button" class="btn-primary btn-compact" data-ob="approve">Затвердити</button>' : ''}
        </div>`}
    </section>`;
}

/** Дія з кнопки data-ob у розділі «Проводки». Повертає true, якщо треба перечитати проводки. */
export async function openingAction(btn, host) {
    const a = btn.dataset.ob;
    try {
        if (a === 'add') { sync(host); rows.push({ acc: '311', side: 'dr', kop: 0 }); render(host); host.querySelector('tr[data-row]:last-child [data-f="acc"]')?.focus(); return false; }
        if (a === 'remove') { sync(host); rows.splice(Number(btn.dataset.i), 1); render(host); return false; }
        if (a === 'bank') {
            sync(host);
            const b = octx.banks.find(x => x.iban === btn.dataset.iban);
            const row = rows.find(l => l.acc === '311' && l.a === b.iban);
            const side = b.suggestKop >= 0 ? 'dr' : 'cr';
            if (row) Object.assign(row, { side, kop: Math.abs(b.suggestKop) });
            else rows.push({ acc: '311', a: b.iban, side, kop: Math.abs(b.suggestKop), memo: `Залишок за випискою …${b.iban.slice(-4)}` });
            render(host);
            return false;
        }
        if (a === 'fund') {
            const t = totals(sync(host));
            if (!t.diff) { toast('Дебет уже дорівнює кредиту'); return false; }
            const row = rows.find(l => l.acc === '48' && !l.a);
            const signed = (row ? (row.side === 'cr' ? row.kop : -row.kop) : 0) + t.diff;
            if (row) Object.assign(row, { side: signed >= 0 ? 'cr' : 'dr', kop: Math.abs(signed) });
            else rows.push({ acc: '48', a: '', side: t.diff > 0 ? 'cr' : 'dr', kop: Math.abs(t.diff), memo: 'Залишок цільового фінансування' });
            render(host);
            return false;
        }
        if (a === 'save') {
            const list = sync(host).filter(l => l.kop);
            setBusy(btn, true, 'Зберігаю…');
            await journalAct({ action: 'saveOpening', lines: list });
            toast(totals(list).diff ? 'Збережено. Дебет ще не дорівнює кредиту — голова не зможе затвердити' : 'Збережено й передано голові на затвердження', totals(list).diff ? 'info' : 'success');
            return true;
        }
        if (a === 'approve') {
            if (!await confirmDialog('Затвердити вхідну оборотно-сальдову?', `Дебет = кредит = ${fmtKop(octx.totals.dr)} грн. Залишки потраплять у проводки на 30.09.2026; після першого закритого місяця їх не змінити.`, 'Затвердити')) return false;
            setBusy(btn, true, 'Затверджую…');
            await journalAct({ action: 'approveOpening' });
            toast('Вхідну ОСВ затверджено', 'success');
            return true;
        }
    } catch (e) { toast(e.message, 'error'); }
    finally { if (btn.isConnected) setBusy(btn, false); }
    return false;
}

/** Живі підсумки під час введення сум. */
export function openingInput(host) {
    try { document.getElementById('obFoot').innerHTML = footHtml(totals(sync(host))); } catch { /* сума ще вводиться */ }
}
