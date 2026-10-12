import { session } from './firebase.js';
import { escapeHtml, toast, setBusy } from './ui.js';
import { callBackend } from './backend.js';
import { invalidate } from './buh-data.js';
let current;
export async function loadAccountingSettings(host, accounts) {
    current = await callBackend('journalAction', { action:'policy' });
    const disabled = session.role === 'chair' ? '' : ' disabled';
    const option=(value,label,selected)=>`<option value="${value}"${value===selected?' selected':''}>${label}</option>`;
    host.innerHTML = `<section class="buh-card"><div class="buh-card-head"><h2>Початок і правила обліку</h2><span class="buh-tag ${current.status==='approved'?'is-payment':'is-review'}">${current.status==='approved'?'погоджено':'потребує погодження'}</span></div>
        <p class="buh-note">Спочатку перенесіть залишки та потрібну історію, звірте їх із попереднім обліком. Дата змінюється до проведення перших операцій. Для повного річного звіту потрібні також обороти до цієї дати.</p>
        <div class="py-pair"><label class="py-field"><span>Дата початку</span><input id="apStart" class="field-input" type="date" value="${escapeHtml(current.startDate)}"${disabled}></label>
        <label class="py-field"><span>Форма фінзвітності</span><select id="apForm" class="field-input field-select"${disabled}>${[['unspecified','Ще не визначено'],['micro','Мікропідприємство (1-мс, 2-мс)'],['small','Мале підприємство (1-м, 2-м)'],['full','Повні форми']].map(([v,l])=>option(v,l,current.reportingForm)).join('')}</select></label></div>
        <label class="py-field"><span>Призначення коштів (код; назва — по одному на рядок)</span><textarea id="apFunds" class="field-input" rows="3"${disabled}>${escapeHtml(current.funds.map(f=>`${f.id}; ${f.name}`).join('\n'))}</textarea></label>
        <label class="py-field"><span>Основний фонд</span><select id="apDefaultFund" class="field-input field-select"${disabled}>${current.funds.map(f=>option(f.id,escapeHtml(f.name),current.defaultFund)).join('')}</select></label>
        <details><summary>Як обліковувати інші надходження</summary><p class="buh-note">Схему погоджує бухгалтер. За замовчуванням гроші надходять у цільове фінансування; власні доходи можна виділити окремо.</p>
            ${[['rent','Оренда'],['equipment','Використання обладнання'],['interest','Проценти банку'],['grant','Гранти'],['other','Інше']].map(([key,label])=>`<label class="py-field"><span>${label}</span><select class="field-input field-select" data-ap-income="${key}"${disabled}>${[['48','48 — цільове фінансування'],['703','703 — послуги'],['719','719 — операційний дохід'],['733','733 — фінансовий дохід']].map(([v,l])=>option(v,l,current.incomeAccounts[key])).join('')}</select></label>`).join('')}</details>
        ${accounts.length?`<details open><summary>Поточні та депозитні рахунки</summary><p class="buh-note">Переказ на власний депозит і повернення основної суми не є доходом чи витратою. Субрахунок депозиту оберіть за строком і умовами договору; проценти — окреме надходження.</p>
            ${accounts.map(([iban,a])=>`<div class="ap-bank" data-ap-bank="${escapeHtml(iban)}"><b>…${escapeHtml(iban.slice(-4))} · ${a.purpose==='deposit'?'депозит':'рахунок'}</b><label class="py-field"><span>Рахунок бухгалтерського обліку</span><select class="field-input field-select" data-ap-field="acc"${disabled}>${[['311','311 — поточний'],['313','313 — інший рахунок у банку'],['351','351 — короткострокова інвестиція'],['143','143 — довгострокова інвестиція']].map(([v,l])=>option(v,l,current.bankAccounts?.[iban]?.acc || (a.purpose==='deposit'?'313':'311'))).join('')}</select></label>
            <div class="py-pair"><label class="py-field"><span>Договір / умови</span><input class="field-input" data-ap-field="agreement" maxlength="200" value="${escapeHtml(current.bankAccounts?.[iban]?.agreement || '')}"${disabled}></label><label class="py-field"><span>Дата повернення депозиту</span><input class="field-input" type="date" data-ap-field="maturity" value="${escapeHtml(current.bankAccounts?.[iban]?.maturity || '')}"${disabled}></label></div></div>`).join('')}</details>`:''}
        <label class="py-field"><span>Підстава облікової політики (наказ / рішення)</span><input id="apBasis" class="field-input" maxlength="500" value="${escapeHtml(current.basis || '')}" placeholder="Заповніть після погодження схеми з бухгалтером"${disabled}></label>
        ${session.role==='chair'?'<div class="buh-inline-form"><button type="button" class="sv-btn is-soft" data-ap-act="save">Зберегти проєкт</button><button type="button" class="sv-btn" data-ap-act="approve">Погодити параметри</button></div>':'<p class="buh-note">Змінює й погоджує голова.</p>'}
        <p class="buh-note"><a href="docs/accounting/MIGRATION.md" download>Завантажити перелік даних і порядок переходу</a></p></section>`;
    host.onclick=async e=>{
        const btn=e.target.closest('[data-ap-act]'); if(!btn) return;
        const value=id=>host.querySelector(`#${id}`).value;
        try {
            setBusy(btn,true,'Зберігаю…');
            const funds=value('apFunds').split('\n').filter(l=>l.trim()).map(l=>{const [id,...name]=l.split(';');return{id:id.trim(),name:name.join(';').trim()};});
            const bankAccounts={};
            host.querySelectorAll('[data-ap-bank]').forEach(row=>{bankAccounts[row.dataset.apBank]=Object.fromEntries([...row.querySelectorAll('[data-ap-field]')].map(f=>[f.dataset.apField,f.value]));});
            const incomeAccounts={...current.incomeAccounts};host.querySelectorAll('[data-ap-income]').forEach(f=>{incomeAccounts[f.dataset.apIncome]=f.value;});
            await callBackend('journalAction',{action:'savePolicy',startDate:value('apStart'),reportingForm:value('apForm'),funds,defaultFund:value('apDefaultFund'),bankAccounts,incomeAccounts,basis:value('apBasis'),approve:btn.dataset.apAct==='approve'});
            invalidate();toast('Параметри збережено','success');await loadAccountingSettings(host,accounts);
        } catch(err) {toast(err.message,'error');} finally {setBusy(btn,false);}
    };
    host.querySelector('#apFunds').addEventListener('change',()=>{
        const funds=host.querySelector('#apFunds').value.split('\n').map(l=>l.split(';')).filter(parts=>parts[0]?.trim()&&parts[1]?.trim());
        const selected=host.querySelector('#apDefaultFund').value;
        host.querySelector('#apDefaultFund').innerHTML=funds.map(([id,...name])=>option(escapeHtml(id.trim()),escapeHtml(name.join(';').trim()),selected)).join('');
    });
}
