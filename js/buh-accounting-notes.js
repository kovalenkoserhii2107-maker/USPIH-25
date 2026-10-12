import { session } from './firebase.js';
import { escapeHtml, toast, setBusy } from './ui.js';
import { callBackend } from './backend.js';
import { journalAct } from './buh-data.js';
import { fmtKop,toKop } from './charges-core.js';
export async function loadNotes(host,period,funds) {
    const data=await callBackend('journalAction',{action:'notes'});
    const options=list=>list.map(([id,name])=>`<option value="${escapeHtml(id)}">${escapeHtml(name)}</option>`).join('');
    const fundOptions=options(funds.map(f=>[f.id,f.name]));
    host.innerHTML=`<details class="buh-card"><summary><b>Бухгалтерські довідки та додаткові операції</b></summary><p class="buh-note">Окрема підстава й погодження головою потрібні для переносу між фондами, амортизації, списання запасів та інших нарахувань. Зарплата, податки і розрахунки з постачальниками ведуться у своїх розділах.</p>
        ${data.notes.map(n=>`<p class="buh-note"><b>${escapeHtml(data.types[n.type])} · ${escapeHtml(n.date)} · ${fmtKop(n.amountKop)} грн</b><br>${escapeHtml(n.note)} · ${n.status==='approved'?'погоджено':'чекає голову'}
            ${n.status==='draft'&&session.role==='chair'?`<button type="button" class="btn-ghost-small" data-note-approve="${escapeHtml(n.id)}">Погодити</button>`:''}</p>`).join('')}
        <div class="py-pair"><label class="py-field"><span>Вид</span><select id="anType" class="field-input field-select">${options(Object.entries(data.types))}</select></label><label class="py-field"><span>Дата</span><input id="anDate" class="field-input" type="date" value="${period}-01"></label></div>
        <label class="py-field"><span>Сума, грн</span><input id="anAmount" class="field-input" inputmode="decimal"></label>
        <div data-note-fields="fundTransfer" class="py-pair"><label class="py-field"><span>З фонду</span><select id="anFrom" class="field-input field-select">${fundOptions}</select></label><label class="py-field"><span>До фонду</span><select id="anTo" class="field-input field-select">${fundOptions}</select></label></div>
        <div data-note-fields="depreciation inventory rentAccrual accrual" hidden><label class="py-field"><span>Інвентарний код / покупець / кредитор</span><input id="anAnalytic" class="field-input" maxlength="200"></label></div>
        <div data-note-fields="depreciation inventory" hidden><label class="py-field"><span>Рахунок активу</span><select id="anAcc" class="field-input field-select">${options([['10','10 — основний засіб'],['11','11 — інший необоротний актив'],['20','20 — запаси'],['22','22 — малоцінні предмети']])}</select></label></div>
        <div data-note-fields="reverse" hidden><label class="py-field"><span>Яку довідку сторнувати</span><select id="anReverse" class="field-input field-select">${options(data.notes.filter(n=>n.status==='approved'&&!n.reversedBy).map(n=>[n.id,`${n.date} · ${n.note} · ${fmtKop(n.amountKop)} грн`]))}</select></label></div>
        <label class="py-field"><span>Підстава (документ, акт, договір)</span><input id="anSource" class="field-input" maxlength="300"></label><label class="py-field"><span>Зміст і причина</span><input id="anNote" class="field-input" maxlength="300"></label><button type="button" class="sv-btn is-soft" data-note-save>Підготувати довідку</button></details>`;
    const value=id=>host.querySelector(`#${id}`).value;
    host.querySelector('#anType').onchange=e=>host.querySelectorAll('[data-note-fields]').forEach(div=>{div.hidden=!div.dataset.noteFields.split(' ').includes(e.target.value);});
    host.onclick=async e=>{
        const btn=e.target.closest('[data-note-save],[data-note-approve]');if(!btn)return;
        try{
            setBusy(btn,true,'Зберігаю…');
            if(btn.dataset.noteApprove)await journalAct({action:'approveNote',id:btn.dataset.noteApprove});
            else await journalAct({action:'saveNote',type:value('anType'),date:value('anDate'),amountKop:toKop(value('anAmount')),analytic:value('anAnalytic'),fromFund:value('anFrom'),toFund:value('anTo'),assetAcc:value('anAcc'),reverseOf:value('anReverse'),source:value('anSource'),note:value('anNote')});
            toast(btn.dataset.noteApprove?'Довідку проведено':'Довідка чекає погодження головою','success');await loadNotes(host,period,funds);
        }catch(err){toast(err.message,'error');}finally{if(btn.isConnected)setBusy(btn,false);}
    };
}
