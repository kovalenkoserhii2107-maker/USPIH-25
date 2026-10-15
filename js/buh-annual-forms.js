import {escapeHtml as esc,toast,setBusy} from './ui.js';
import {reportsQuery,reportsAct} from './buh-data.js';
import {fmtKop,toKop} from './charges-core.js';
import {zip,saveBlob} from './xlsx-write.js';

const categories={contributions:'Внески співвласників',passive:'Проценти / пасивні доходи',rent:'Оренда / послуги',budget:'Бюджетні кошти',grants:'Гранти',charity:'Благодійна допомога',other:'Інші доходи',maintenance:'Утримання будинку',payroll:'Оплата праці та ЄСВ',projects:'Цільові проєкти',otherCosts:'Інші витрати'};
const income=['contributions','passive','rent','budget','grants','charity','other'],cost=['maintenance','payroll','projects','otherCosts'];
const priorFields={salesKop:'Чистий дохід від реалізації',operatingKop:'Інші операційні доходи',otherKop:'Інші доходи (проценти тощо)',costOfSalesKop:'Собівартість реалізації',otherOperatingCostKop:'Інші операційні витрати',otherCostKop:'Інші витрати (крім операційних)'};
const units=n=>n==null?'не перенесено':(n/10).toLocaleString('uk-UA',{minimumFractionDigits:1,maximumFractionDigits:1});
const select=(name,value,choices)=>`<select class="field-input field-select" name="${name}"><option value="">Оберіть</option>${choices.map(([id,label])=>`<option value="${esc(id)}"${id===value?' selected':''}>${esc(label)}</option>`).join('')}</select>`;
const table=(heads,rows)=>`<div class="jr-scroll" tabindex="0"><table class="buh-table is-compact annual-forms-table"><thead><tr>${heads.map(h=>`<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows.map(row=>`<tr>${row.map(cell=>`<td>${cell}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;

export async function mountAnnualForms(host,year,onDownload){
 const prepared=await reportsQuery({action:'annualForms',year});if(!host.isConnected)return;
 const c=prepared.calculation,s=prepared.settings;
 host.innerHTML=`<details class="buh-card"><summary><b>Розрахунок річних форм</b></summary><p class="buh-note">${esc(c.balanceName)} / ${esc(c.resultsName)} та розшифровка неприбуткового звіту. Після звірки збережіть версію або сформуйте офіційний пакет XML для ДПС (J0101912 + J0901206). Таблиці можна прокручувати горизонтально.</p>
 <div class="buh-tag ${c.reviewReady?'is-payment':'is-review'}">${c.reviewReady?'розшифровку погоджено · готово до XML ДПС':'потрібна перевірка'}</div>
 <ul class="pr-notes">${c.checks.map(x=>`<li${x.level==='block'?' class="is-bad"':''}>${esc(x.text)}</li>`).join('')}</ul>
 <details><summary>Баланс · тис. грн</summary>${table(['Рядок','Показник','На початок','На кінець','Джерело'],c.balance.map(r=>[esc(r.code),esc(r.label),units(r.startUnits),units(r.endUnits),esc(r.sources.map(t=>`${t.sign<0?'−':''}${t.acc} ${t.side==='dr'?'Дт':'Кт'}`).join(', ')||r.children.join(' + '))]))}</details>
 <details><summary>Фінансові результати · тис. грн</summary>${table(['Рядок','Показник',String(Number(year)-1),year],c.results.map(r=>[esc(r.code),esc(r.label),units(r.previousUnits),units(r.units)]))}</details>
 <details><summary>Неприбутковий звіт · грн</summary><p>Доходи: <b>${fmtKop(c.npoTotals.incomeKop)}</b> · витрати: <b>${fmtKop(c.npoTotals.costKop)}</b></p>${table(['Рядок','Категорія','Сума'],c.npoRows.map(r=>[esc(r.code),esc(r.label),fmtKop(r.kop)]))}</details>
 <form class="annual-forms-review" onsubmit="return false"><h3 class="rp-h">Перевірка бухгалтером</h3><p class="buh-note">Власний депозит — актив ОСББ. Визначте його строк і доступність за договором; призначення грошей обліковується окремо.</p>
 <label class="py-field"><span>Залишок цільового фінансування (48)</span>${select('financingTerm',s.financingTerm,[['long','Довгостроковий'],['current','Поточний']])}</label>
 <label class="py-field"><span>Короткостроковий депозит (351)</span>${select('deposit351',s.deposit351,[['investment','Поточна фінансова інвестиція'],['cashEquivalent','Грошовий еквівалент (за договором)']])}</label>
 <label class="py-field"><span>Інші банківські рахунки (313)</span>${select('cash313',s.cash313,[['cash','Доступні гроші'],['otherCurrent','Інші оборотні активи']])}</label>
 <details><summary>Розшифровка прийнятого звіту ${Number(year)-1} року</summary><p class="buh-note">Суми у гривнях. Внесіть нулі, якщо відповідних доходів / витрат не було. Підсумки мають збігтись із погодженими порівняльними даними.</p>${Object.entries(priorFields).map(([key,label])=>`<label class="py-field"><span>${label}</span><input class="field-input" name="${key}" inputmode="decimal" value="${s.comparatives?.[key]===undefined?'':(s.comparatives[key]/100).toFixed(2)}"></label>`).join('')}</details>
 <details open><summary>Рядки неприбуткового звіту</summary><p class="buh-note">Виберіть категорію й код рядка з чинного бланка. Внески не прирівнюються до банківських надходжень: тут визнані доходи та витрати, включно зі сторно.</p>${c.sourceGroups.map((g,i)=>`<fieldset data-source-id="${esc(g.id)}"><legend>${esc(g.label)} · ${fmtKop(g.kop)} грн</legend><div class="py-pair"><label class="py-field"><span>Категорія</span>${select('category-'+i,s.assignments?.[g.id]?.category,(g.kind==='income'?income:cost).map(k=>[k,categories[k]]))}</label><label class="py-field"><span>Код рядка (${g.kind==='income'?'1.x':'2.x'})</span><input class="field-input" name="row-${i}" maxlength="10" value="${esc(s.assignments?.[g.id]?.row||'')}"></label></div><small>${g.entryIndexes.length} проводок у річному журналі</small></fieldset>`).join('')}</details>
 <label><input type="checkbox" name="noIncomeTax"${s.noIncomeTax?' checked':''}> Податку на прибуток за обидва роки не було</label><br><label><input type="checkbox" name="noViolation"${s.noViolation?' checked':''}> Нецільового використання та розподілу доходів не було</label>
 <label class="py-field"><span>Джерело / підстава перевірки</span><input class="field-input" name="basis" maxlength="500" value="${esc(s.basis||'')}" placeholder="Прийнятий звіт, кошторис, договір депозиту"></label><button class="sv-btn is-soft" type="button" data-form-act="review">Зберегти перевірку</button></form>
 <form class="annual-forms-xml" onsubmit="return false"><h3 class="rp-h">Офіційний XML-пакет для ДПС (J0101912 + J0901206)</h3>
 <p class="buh-note">Формує файли Звіту неприбуткової організації (J0101912) та Фінансової звітності 1-мс / 2-мс (J0901206) у windows-1251 зі взаємним звʼязком для імпорту в Електронний кабінет ДПС або M.E.Doc.</p>
 <div class="py-pair">
 <label class="py-field"><span>Стан</span>${select('xmlStan','1',[['1','Звітний (1)'],['2','Новий звітний (2)'],['3','Уточнюючий (3)']])}</label>
 <label class="py-field"><span>Номер у періоді</span><input class="field-input" name="xmlNum" type="number" min="1" max="99" value="1"></label>
 </div>
 <button class="sv-btn" type="button" data-form-act="xml"${c.reviewReady?'':' disabled'}>Сформувати та завантажити XML для ДПС</button>
 <div class="annual-xml-result" id="annualXmlResult"></div></form>
 <form class="annual-forms-export" onsubmit="return false"><h3 class="rp-h">Версія розрахунку (Excel)</h3><label class="py-field"><span>Вид</span>${select('submissionKind','initial',[['initial','Первинний розрахунок'],['replacement','Повторний розрахунок'],['correction','Виправлення']])}</label><label class="py-field"><span>Попередня версія для виправлення</span>${select('previousPackageId','',(prepared.versions||[]).map(p=>[p.id,'Версія '+p.version+(p.basis?' · '+p.basis:'' )]))}</label><label class="py-field"><span>Підстава / опис виправлення</span><input class="field-input" name="basis" maxlength="500"></label><button class="sv-btn is-soft" type="button" data-form-act="archive"${c.reviewReady?'':' disabled'}>Зберегти версію та завантажити Excel</button></form></details>`;

 host.onclick=async e=>{
  const dlBtn=e.target.closest('[data-xml-dl]');
  if(dlBtn){
   const idx=Number(dlBtn.dataset.xmlDl);
   const f=host._annualXmlFiles?.[idx];
   if(f){
    const fileBytes=Uint8Array.from(atob(f.data),ch=>ch.charCodeAt(0));
    saveBlob(new Blob([fileBytes],{type:'application/xml'}),f.name);
   }
   return;
  }
  const btn=e.target.closest('[data-form-act]');if(!btn)return;const form=btn.closest('form'),v=name=>form.elements[name]?.value||'';
  try{setBusy(btn,true,'Опрацьовую…');
   if(btn.dataset.formAct==='review'){
    const settings={financingTerm:v('financingTerm'),deposit351:v('deposit351'),cash313:v('cash313'),noViolation:form.elements.noViolation.checked,noIncomeTax:form.elements.noIncomeTax.checked,comparatives:{},assignments:{}};
    for(const key of Object.keys(priorFields)){if(!v(key).trim())throw new Error('Заповніть усі порівняльні суми, включно з нулями');settings.comparatives[key]=toKop(v(key));}
    c.sourceGroups.forEach((g,i)=>settings.assignments[g.id]={category:v('category-'+i),row:v('row-'+i).trim()});
    await reportsAct({action:'saveAnnualForms',year,sourceHash:prepared.sourceHash,basis:v('basis'),settings});toast('Розшифровку погоджено','success');await mountAnnualForms(host,year,onDownload);
   }else if(btn.dataset.formAct==='xml'){
    const stan=Number(v('xmlStan'))||1;
    const num=Number(v('xmlNum'))||1;
    const out=await reportsAct({action:'annualXml',year,stan,num});
    if(out.problems&&out.problems.length)throw new Error(out.problems.join('; '));
    const fileBytes=f=>Uint8Array.from(atob(f.data),ch=>ch.charCodeAt(0));
    const zipData=zip(out.files.map(f=>({name:f.name,data:fileBytes(f)})),'application/zip');
    saveBlob(zipData,`annual-dps-xml-${year}-v${out.version}.zip`);
    const resBox=host.querySelector('#annualXmlResult');
    if(resBox){
     host._annualXmlFiles=out.files;
     resBox.innerHTML=`<div class="buh-tag is-payment" style="margin-top:12px;">Пакет версії ${out.version} сформовано</div>
     <p class="buh-note">Архів <code>annual-dps-xml-${year}-v${out.version}.zip</code> завантажено. В Електронному кабінеті ДПС («Введення звітності») завантажте обидва XML одночасно.</p>
     <ul class="pr-notes" style="margin-top:8px;">
     ${out.files.map((f,i)=>`<li><b>${esc(f.name)}</b> — ${esc(f.title||f.name)} <button type="button" class="sv-btn is-soft btn-compact" data-xml-dl="${i}">Завантажити файл</button></li>`).join('')}
     </ul>`;
    }
    toast(`XML-пакет версії ${out.version} готовий`,'success');
   }else{
    const p=await reportsAct({action:'annualSnapshot',year,withForms:true,submissionKind:v('submissionKind'),previousPackageId:v('previousPackageId').trim(),basis:v('basis')});await onDownload(p.id);toast(`Збережено розрахункову версію ${p.version}`,'success');
   }
  }catch(err){toast(err.message,'error');}finally{if(btn.isConnected)setBusy(btn,false);}
 };
}
