// Mapping is deliberately independent of the export's sheet names/order.
const col=(name,type='text',aliases=[],fallback)=>({name,type,aliases:[name,...aliases],fallback});
export const sections=[
 {id:'accounts',label:'Особові рахунки та залишки',required:true,columns:[col('Особовий рахунок','id',['Лицевой счет','Лицевой счёт']),col('Приміщення','id',['Квартира','Номер квартири']),col('Тип приміщення','text',[],'Житлове'),col('Підʼїзд','text',['Парадна','Подъезд'],''),col('Загальна площа, м²','decimal',['Загальна площа','Площа','Площа, м²','Площадь']),col('Кількість проживаючих','integer',['Проживаючі','Жильцы'],'0'),col('Сальдо Дт, грн','money',['Дебет']),col('Сальдо Кт, грн','money',['Кредит']),col('Дата залишків','date',['Станом на'],'cutoff')]},
 {id:'opening',label:'ОСВ на дату переходу',required:true,columns:balanceColumns()},
 {id:'owners',label:'Реєстр співвласників',columns:[col('Приміщення','id',['Квартира']),col('ПІБ співвласника','text',['Власник','ФИО','ПІБ']),col('Частка','fraction',['Доля']),col('Документ про право власності','text',['Документ'],'')]},
 {id:'ledger',label:'Історія особових рахунків',columns:[col('Особовий рахунок','id'),col('Приміщення','id',['Квартира']),col('Дата','date'),col('Операція'),col('Сума, грн','money',['Сумма']),col('Документ')]},
 {id:'january',label:'ОСВ на 1 січня',columns:balanceColumns()},
 {id:'journal',label:'Журнал до переходу',columns:[col('Дата','date'),col('Рахунок Дт','id',['Счет Дт']),col('Субконто Дт','id'),col('Рахунок Кт','id',['Счет Кт']),col('Субконто Кт','id'),col('Сума, грн','money',['Сумма']),col('Документ'),col('Зміст','text',['Содержание'],'')]},
 {id:'suppliers',label:'Довідник контрагентів',columns:[col('Код контрагента','id',['ЄДРПОУ']),col('Назва контрагента','text',['Назва','Наименование']),col('IBAN','id')]},
 {id:'legacyExpenses',label:'Незакриті документи постачальників',columns:[col('Код контрагента','id',['ЄДРПОУ']),col('Дата документа','date',['Дата']),col('Період'),col('Номер документа','id',['Документ']),col('Сума документа, грн','money',['Сумма']),col('Сплачено, грн','money',['Сплачено'])]}
];
function balanceColumns(){return [col('Рахунок','id',['Счет']),col('Субконто','id',['Аналітика']),col('Сальдо Дт, грн','money',['Дебет']),col('Сальдо Кт, грн','money',['Кредит'])];}
export const normalize=s=>String(s??'').normalize('NFKC').toLowerCase().replace(/[ʼ’'.,²³()]/g,'').replace(/\s+/g,' ').trim();
export function decimalString(value){
 const s=String(value??'').trim();const m=/^([+-]?)(\d+)(?:\.(\d*))?[eE]([+-]?\d+)$/.exec(s);if(!m)return s;
 const exponent=Number(m[4]);if(Math.abs(exponent)>30)throw new Error('Число завелике');const digits=m[2]+(m[3]||''),point=m[2].length+exponent;
 return m[1]+(point<=0?'0.'+'0'.repeat(-point)+digits:point>=digits.length?digits+'0'.repeat(point-digits.length):digits.slice(0,point)+'.'+digits.slice(point));
}
export function textValue(v){return v instanceof Date?v.toISOString().slice(0,10):decimalString(v);}
export function parseDelimited(text){
 text=text.replace(/^\uFEFF/,'');let quoted=false,counts={';':0,',':0,'\t':0};const samples=[];for(let i=0;i<text.length;i++){const c=text[i];if(c==='"'){if(quoted&&text[i+1]==='"')i++;else quoted=!quoted;}else if(!quoted&&c==='\n'){samples.push(counts);counts={';':0,',':0,'\t':0};if(samples.length>=30)break;}else if(!quoted&&Object.hasOwn(counts,c))counts[c]++;}samples.push(counts);
 const score=delimiter=>{const modes=new Map();for(const row of samples)if(row[delimiter])modes.set(row[delimiter],(modes.get(row[delimiter])||0)+1);return Math.max(0,...[...modes].map(([columns,n])=>n*1000+Math.min(columns,999)));};
 const separator=Object.keys(counts).sort((a,b)=>score(b)-score(a))[0];const rows=[],sourceRows=[];let row=[],cell='',line=1,rowLine=1;quoted=false;
 const push=()=>{row.push(cell.trim());rows.push(row);sourceRows.push(rowLine);row=[];cell='';};
 for(let i=0;i<text.length;i++){const c=text[i];if(c==='"'){if(quoted&&text[i+1]==='"'){cell+='"';i++;}else quoted=!quoted;}else if(!quoted&&c===separator){row.push(cell.trim());cell='';}else if(c==='\n'){if(quoted)cell+='\n';else{push();rowLine=line+1;}line++;}else if(c!=='\r')cell+=c;}
 if(quoted)throw new Error('CSV: незакриті лапки');if(cell||row.length)push();if(rows.length>30000)throw new Error('До 30 000 рядків у файлі');if(rows.some(r=>r.length>150))throw new Error('До 150 колонок у файлі');return {rows,sourceRows};
}
export function suggestMapping(section,source,header=0){const names=(source.rows[header]||[]).map(normalize);return section.columns.map(c=>{const hits=names.flatMap((n,i)=>c.aliases.map(normalize).includes(n)?[i]:[]);return hits.length===1?hits[0]:-1;});}
export function suggestAssignments(sources){
 const result={};const used=new Set();for(const section of sections){let best=null;
  for(const source of sources){if(used.has(source.id))continue;if(section.id==='opening'&&/січ|январ|january/i.test(source.name))continue;for(let h=0;h<Math.min(15,source.rows.length);h++){const mapping=suggestMapping(section,source,h);const required=section.columns.filter(c=>c.fallback===undefined).length;const hits=mapping.filter(i=>i>=0).length;const needed=section.columns.reduce((n,c,i)=>n+(c.fallback===undefined&&mapping[i]>=0),0);if(needed!==required)continue;
   const nameBonus=(normalize(source.name).includes(normalize(section.label).slice(0,8))?2:0)+(section.id==='january'&&/січ|январ|january/i.test(source.name)?4:0);const score=hits+nameBonus;if(!best||score>best.score)best={source:source.id,header:h,end:source.rows.length,mapping,score};}}
  if(best){delete best.score;result[section.id]=best;used.add(best.source);}
 }return result;
}
const quote=s=>'"'+String(s).replace(/"/g,'""')+'"';
const issue=(section,source,row,column,message)=>({file:section.id,sheet:source?.name||section.label,row,column,message});
export function compileImport(sources,assignments,startDate){
 const files={},issues=[],warnings=new Set();let issueCount=0;const report=item=>{issueCount++;if(issues.length<100)issues.push(item);};const date=new Date(startDate+'T12:00:00Z');if(Number.isNaN(+date)||date.toISOString().slice(0,10)!==startDate)throw new Error('Оберіть дату початку');const cutoff=new Date(+date-86400000).toISOString().slice(0,10);
 for(const section of sections){const a=assignments[section.id];const source=sources.find(s=>s.id===a?.source);if(!source){if(section.required)report(issue(section,null,null,'','Оберіть лист або CSV'));continue;}
  if(!Number.isInteger(a.header)||a.header<0||a.header>=source.rows.length||!Number.isInteger(a.end)||a.end<=a.header+1||a.end>source.rows.length){report(issue(section,source,null,'','Перевірте рядок заголовків і останній рядок даних'));continue;}
  const mapping=a.mapping||[],headers=source.rows[a.header],headerRow=source.sourceRows?.[a.header]||a.header+1,selected=mapping.filter(i=>i>=0);if(new Set(selected).size!==selected.length){report(issue(section,source,headerRow,'','Одна колонка призначена кільком полям'));continue;}
  let missing=false;section.columns.forEach((c,i)=>{if(mapping[i]>=headers.length||!Number.isInteger(mapping[i])||mapping[i]<0&&c.fallback===undefined){report(issue(section,source,headerRow,c.name,'Призначте колонку'));missing=true;}});if(missing)continue;
  const csv=[section.columns.map(c=>quote(c.name)).concat('__source_row').join(';')];let count=0;
  for(let r=a.header+1;r<a.end;r++){const raw=source.rows[r]||[];if(!raw.some(v=>v!==null&&v!==undefined&&String(v).trim()!==''))continue;count++;const actualRow=source.sourceRows?.[r]||r+1;
   const values=section.columns.map((c,i)=>{const index=mapping[i];const value=index>=0?textValue(raw[index]??''):c.fallback==='cutoff'?cutoff:c.fallback;const meta=source.cells?.[`${r}:${index}`];
    if(meta?.error)report(issue(section,source,actualRow,c.name,'Помилка або формула без обчисленого значення. Виправте та збережіть Excel'));
    if(c.type==='id'&&meta?.numeric&&(meta.unsafeId||!meta.padded&&/^\d{16,}$/.test(value)))report(issue(section,source,actualRow,c.name,'Числовий ідентифікатор має понад 15 цифр. Відновіть його з оригіналу як текст'));
    if(c.type==='id'&&meta?.numeric&&!meta.padded)warnings.add(`${source.name}: «${c.name}» збережено як число. Звірте початкові нулі з оригіналом`);
    if(['money','decimal'].includes(c.type)&&value!==''&&!/^-?\d+(?:[.,]\d{1,2})?$/.test(value.replace(/[ \u00a0\u202f]/g,'')))report(issue(section,source,actualRow,c.name,'Потрібне число з максимум двома знаками після коми'));
    if(c.type==='integer'&&!/^\d+$/.test(value))report(issue(section,source,actualRow,c.name,'Потрібне ціле невідʼємне число'));
    if(c.type==='date'&&!/^(?:20\d{2}-\d{2}-\d{2}|\d{2}\.\d{2}\.20\d{2})$/.test(value))report(issue(section,source,actualRow,c.name,'Дата у форматі РРРР-ММ-ДД або ДД.ММ.РРРР'));
    return value??'';});csv.push(values.map(quote).concat(actualRow).join(';'));
  }if(!count)report(issue(section,source,null,'','Немає рядків даних'));const text=csv.join('\n');if(text.length>6000000)report(issue(section,source,null,'','Завеликий обсяг: до 6 МБ на розділ'));files[section.id]=text;
 }
 if(Boolean(files.january)!==Boolean(files.journal))report({message:'Історія року потребує ОСВ на 1 січня та журналу разом'});
 if(Object.values(files).reduce((n,s)=>n+s.length,0)>12000000)report({message:'Загальний обсяг даних перевищує 12 МБ'});
 return {files,issues:issues.slice(0,100),issueCount,warnings:[...warnings]};
}
