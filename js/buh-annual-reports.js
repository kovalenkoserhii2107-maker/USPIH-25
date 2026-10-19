import { escapeHtml, toast, setBusy } from './ui.js';
import { reportsQuery, reportsAct, reportFileUrl } from './buh-data.js';
import { fmtKop } from './charges-core.js';
import { buildXlsx, zip, saveBlob } from './xlsx-write.js';
let report=null, selectedYear=null;
const grn=kop=>`${fmtKop(kop)} грн`;
const table=list=>`<table class="buh-table is-compact"><tbody>${list.filter(r=>r.kop).map(r=>`<tr><td>${escapeHtml(r.name)}</td><td class="t-sum">${grn(r.kop)}</td></tr>`).join('')}</tbody></table>`;
function sheets(r) {
    const rows=[
        ['ОСВ',[['Рахунок','Назва','Дт на початок, грн','Кт на початок, грн','Оборот Дт, грн','Оборот Кт, грн','Дт на кінець, грн','Кт на кінець, грн'],...r.osv.map(x=>[x.acc,x.name,...['openDr','openCr','dr','cr','closeDr','closeCr'].map(k=>x[k]/100)])]],
        ['Фінрезультати',[['Показник',String(Number(r.year)-1),r.year],['Доходи',r.previousIncome?.incomeKop===undefined?'не перенесено':r.previousIncome.incomeKop/100,r.summary.incomeKop/100],['Витрати',r.previousIncome?.costKop===undefined?'не перенесено':r.previousIncome.costKop/100,r.summary.costKop/100],['Результат','',r.summary.resultKop/100],...r.income.map(x=>[x.name,'',x.kop/100])]],
        ['Баланс',[['Рахунок','Назва','Початковий залишок Дт−Кт, грн','Кінцевий залишок Дт−Кт, грн'],...r.financialRows.map(x=>[x.acc,x.name,x.atStartKop/100,x.atEndKop/100])]],
        ['Фонди',[['Призначення','На початок, грн','Нараховано фінансування, грн','Використано, грн','На кінець, грн'],...r.funds.map(x=>[x.name,x.openKop/100,x.receivedKop/100,x.usedKop/100,x.closeKop/100])]],
        ['Проводки',[['Дата','Дебет','Аналітика Дт','Кредит','Аналітика Кт','Сума, грн','Документ','Зміст'],...r.entries.map(x=>[x.date,x.dr,x.dA||'',x.cr,x.cA||'',x.kop/100,x.ref,x.memo])]],
        ['Контроль',[['Період',r.year],['Дата переходу',r.startDate],['Повнота',r.complete?'погоджені річні дані':'неповні / попередні дані'],['Надійшло (без власних переказів)',r.summary.receiptsKop/100],['Сплачено (без власних переказів)',r.summary.payoutsKop/100],...r.checks.map(c=>[c.level,c.text])]]
    ];
    if(r.forms){const c=r.forms;rows.push(
        [c.balanceName,[['Розрахункові дані — звірте з чинною формою'],['Рядок','Показник','На початок, тис. грн','На кінець, тис. грн','Джерело'],...c.balance.map(x=>[x.code,x.label,x.startUnits/10,x.endUnits/10,x.sources.map(s=>`${s.sign} × ${s.acc} ${s.side}`).join('; ')||x.children.join(' + ')])]],
        [c.resultsName,[['Розрахункові дані — звірте з чинною формою'],['Рядок','Показник',Number(r.year)-1,r.year],...c.results.map(x=>[x.code,x.label,x.previousUnits==null?'не перенесено':x.previousUnits/10,x.units/10])]],
        ['Неприбутковий',[['Розшифровка для переносу у чинну форму'],['Рядок','Показник','Сума, грн','Групи джерел'],...c.npoRows.map(x=>[x.code,x.label,x.kop/100,x.sourceIds.join('; ')]),['1','Разом доходи',c.npoTotals.incomeKop/100],['2','Разом витрати',c.npoTotals.costKop/100]]],
        ['Джерела форм',[['Група','Рахунок','Сума, грн','Проводки річного журналу (рядки від 1)'],...c.sourceGroups.map(x=>[x.id,x.acc,x.kop/100,x.entryIndexes.map(i=>i+1).join(', ')]),...c.checks.map(x=>[x.level,x.text])]]
    );}
    return rows;
}
async function save(r,suffix='') {
    const files=[];
    for(const [name,rows] of sheets(r)) files.push({name:`${name}.xlsx`,data:new Uint8Array(await buildXlsx(name,rows).arrayBuffer())});
    files.push({name:'data.json',data:new TextEncoder().encode(JSON.stringify(r,null,2))});
    saveBlob(zip(files,'application/zip'),`annual-${r.year}${suffix}.zip`);
}
export async function downloadAnnualPackage(id) {
    const meta=await reportsQuery({action:'package',id});
    if(meta.type==='annual-external-filing'){
        const files=[];
        for(const f of meta.files){const response=await fetch(await reportFileUrl(f.path));if(!response.ok)throw new Error('Не вдалося завантажити файл звіту');const bytes=new Uint8Array(await response.arrayBuffer());const hash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(v=>v.toString(16).padStart(2,'0')).join('');if(hash!==f.sha256)throw new Error('Файл не збігається зі збереженою версією');files.push({name:f.name,data:bytes});}
        saveBlob(zip(files,'application/zip'),`${meta.key}-v${meta.version}.zip`);return;
    }
    const p=await reportsQuery({action:'annualPackage',id});
    await save(p.report,`-v${p.version}`);
}
export async function loadAnnualReports(host,start,year) {
    if(year)selectedYear=String(year);
    selectedYear ||= String(new Date().getFullYear());
    const requestedYear=selectedYear,loaded=await reportsQuery({action:'annual',year:requestedYear});
    if(!host.isConnected||selectedYear!==requestedYear)return;
    report=loaded;
    const years=Array.from({length:Math.max(1,new Date().getFullYear()-Number(start.slice(0,4))+2)},(_,i)=>Number(start.slice(0,4))+i).reverse();
    if(!years.includes(Number(selectedYear)))years.push(Number(selectedYear));
    const priorInfo = report.previousIncome?.incomeKop !== undefined
        ? `Порівняльні дані ${Number(selectedYear)-1} р.: доходи ${grn(report.previousIncome.incomeKop)}, витрати ${grn(report.previousIncome.costKop)}`
        : `Порівняльні дані ${Number(selectedYear)-1} р. ще не внесено`;
    host.innerHTML=`<details class="buh-card" open><summary><b>Річний облік і дані для звітності</b></summary>
        <div class="buh-toolbar"><label class="py-field"><span>Рік</span><select class="field-input field-select" id="annualYear">${years.map(y=>`<option value="${y}"${String(y)===selectedYear?' selected':''}>${y}</option>`).join('')}</select></label><span class="buh-tag ${report.complete?'is-payment':'is-review'}">${report.complete?'річні дані погоджені':'попередні / неповні дані'}</span></div>
        <div class="kpi-grid"><div class="kpi"><span>Визнані доходи</span><b>${grn(report.summary.incomeKop)}</b></div><div class="kpi"><span>Витрати</span><b>${grn(report.summary.costKop)}</b></div><div class="kpi"><span>Фінансовий результат</span><b>${grn(report.summary.resultKop)}</b></div></div>
        <p class="buh-note">Переведення грошей на власний депозит не збільшує витрати, його повернення не збільшує доходи. Проценти обліковуються окремо за погодженою схемою.</p>
        <details><summary>Перевірки й повнота переносу</summary><ul class="pr-notes">${report.checks.map(c=>`<li${c.level==='block'?' class="is-bad"':''}>${escapeHtml(c.text)}</li>`).join('')}</ul></details>
        <details><summary>Гроші, борги та фонди</summary><h3 class="rp-h">Банк і депозит</h3>${table(report.cashAccounts)}<h3 class="rp-h">Дебіторська заборгованість</h3>${table(report.receivables)}<h3 class="rp-h">Зобовʼязання й фінансування</h3>${table(report.liabilities)}<table class="buh-table is-compact"><tbody>${report.funds.map(f=>`<tr><td>${escapeHtml(f.name)}<small>використано ${grn(f.usedKop)}</small></td><td class="t-sum">${grn(f.closeKop)}</td></tr>`).join('')}</tbody></table></details>
        <div class="buh-inline-form"><button type="button" class="sv-btn" data-annual-act="download">Завантажити річний комплект</button><button type="button" class="sv-btn is-soft" data-annual-act="snapshot">Зберегти версію в архіві</button></div>
        <p class="buh-note">Excel і вихідні дані призначені для заповнення офіційних форм. Подання та квитанції зберігайте у відповідному строку звіту.</p><div id="annualFormsHost"></div>
        <div class="buh-toolbar" style="margin-top:12px">
            <span class="buh-note">${escapeHtml(priorInfo)}${report.coverage?.needsHistory ? ' · Потрібен перенос обліку до дати переходу' : ''}</span>
            <button type="button" class="btn-soft btn-compact" data-go="settings" data-settings-tab="startup">Порівняльні дані та перенос історії у «Налаштуваннях» ›</button>
        </div></details>`;
    const formsHost=host.querySelector('#annualFormsHost');import('./buh-annual-forms.js').then(({mountAnnualForms})=>mountAnnualForms(formsHost,requestedYear,downloadAnnualPackage)).catch(err=>{if(formsHost.isConnected)formsHost.textContent=err.message;});
    host.querySelector('#annualYear').onchange=async e=>{selectedYear=e.target.value;try{await loadAnnualReports(host,start);}catch(err){toast(err.message,'error');}};
    host.onclick=async e=>{
        const btn=e.target.closest('[data-annual-act]');if(!btn)return;
        try {
            setBusy(btn,true,'Готую…');
            if(btn.dataset.annualAct==='download')await save(report);
            if(btn.dataset.annualAct==='snapshot'){const r=await reportsAct({action:'annualSnapshot',year:selectedYear});toast(`Збережено версію ${r.version}${r.complete?'':' (попередні дані)'}`,'success');}
        }catch(err){toast(err.message,'error');}finally{if(btn.isConnected)setBusy(btn,false);}
    };
}
