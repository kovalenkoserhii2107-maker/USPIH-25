'use strict';
// Calculation worksheets, not an electronic filing format. Row layouts need
// verification against the currently applicable N(P)SBO 25 / DPS schemas.
const {ACCOUNTS}=require('./journal-core');
const roundUnits=(kop,unitKop=10000)=>{const n=Math.floor((Math.abs(kop)+unitKop/2)/unitKop);return n?Math.sign(kop)*n:0;};
const CATEGORIES={contributions:'Внески співвласників',passive:'Проценти / пасивні доходи',rent:'Оренда / послуги',budget:'Бюджетні кошти',grants:'Гранти',charity:'Благодійна допомога',other:'Інші доходи',maintenance:'Утримання будинку',payroll:'Оплата праці та ЄСВ',projects:'Цільові проєкти',otherCosts:'Інші витрати'};
const INCOME=['contributions','passive','rent','budget','grants','charity','other'],COST=['maintenance','payroll','projects','otherCosts'];
function groups(report){
 const out=new Map();
 report.entries.forEach((e,index)=>{
  for(const acc of ['703','719','733','92']){
   const income=acc!=='92',side=income?'cr':'dr',reverse=income?'dr':'cr';
   if(e[side]!==acc&&e[reverse]!==acc)continue;
   const opposite=e[e[side]===acc?reverse:side];if(opposite==='79'||opposite==='00')continue;
   const normal=e[side]===acc,analytic=side==='dr'?(normal?e.dA:e.cA):(normal?e.cA:e.dA);
   const oppositeSide=normal?reverse:side,oppositeAnalytic=oppositeSide==='dr'?e.dA:e.cA;
   const origin=opposite==='48'?'fund-'+(oppositeAnalytic||'main'):acc==='92'?(analytic||'other'):'other';
   const id=(income?'income':'cost')+':'+acc+':'+origin;
   if(!out.has(id))out.set(id,{id,kind:income?'income':'cost',acc,origin,label:ACCOUNTS[acc]+' · '+origin,kop:0,entryIndexes:[]});
   const g=out.get(id);g.kop+=(e[side]===acc?1:-1)*e.kop;g.entryIndexes.push(index);
  }
 });
 return [...out.values()].sort((a,b)=>a.id.localeCompare(b.id));
}
function build(report,settings={}){
 const checks=[],block=text=>checks.push({level:'block',text}),warn=text=>checks.push({level:'warn',text});
 const form=report.reportingForm,small=form==='small',supported=['micro','small'].includes(form);
 if(!supported)block('Автоматичні розрахункові рядки є для 1-мс / 2-мс та 1-м / 2-м. Повна форма потребує окремої схеми');
 if(!report.complete)block('Річний журнал неповний або не погоджений');
 for(const r of report.osv){if(!ACCOUNTS[r.acc])block('Немає відповідності для рахунку '+r.acc);if(['00','703','719','733','79','92'].includes(r.acc)&&(r.closeDr||r.closeCr))block('Не закритий рахунок '+r.acc);}
 const has=a=>report.osv.some(r=>r.acc===a&&(r.openDr||r.openCr||r.closeDr||r.closeCr));
 if(has('48')&&!['long','current'].includes(settings.financingTerm))block('Вкажіть строк залишку цільового фінансування: довгостроковий або поточний');
 if(has('351')&&!['investment','cashEquivalent'].includes(settings.deposit351))block('Визначте, чи 351 є поточною інвестицією або грошовим еквівалентом');
 if(has('313')&&!['cash','otherCurrent'].includes(settings.cash313))block('Уточніть доступність коштів на рахунку 313');
 const balance=[];
 const add=(code,label,terms=[],children=[],subset=false)=>{
  const value=at=>children.length?children.reduce((s,c)=>s+balance.find(r=>r.code===c)[at],0):terms.reduce((s,[acc,side,sign=1])=>s+sign*(report.osv.find(r=>r.acc===acc)?.[(at==='startKop'?'open':'close')+(side==='dr'?'Dr':'Cr')]||0),0);
  const r={code,label,startKop:value('startKop'),endKop:value('endKop'),sources:terms.map(([acc,side,sign=1])=>({acc,side,sign})),children,subset};
  r.startUnits=roundUnits(r.startKop);r.endUnits=roundUnits(r.endKop);balance.push(r);return r;
 };
 const dr=(...accounts)=>accounts.map(a=>[a,'dr']),cr=(...accounts)=>accounts.map(a=>[a,'cr']);
 add('1010','Основні засоби (залишкова вартість)',[...dr('10','11'),['131','cr',-1],['132','cr',-1]]);
 add('1011','Первісна вартість',dr('10','11'),[],true);add('1012','Знос',cr('131','132'),[],true);
 if(small){add('1030','Довгострокові фінансові інвестиції',dr('143'));add('1090','Інші необоротні активи');}
 else add('1090','Інші необоротні активи',dr('143'));
 add('1095','Усього необоротних активів',[],small?['1010','1030','1090']:['1010','1090']);
 add('1100','Запаси',dr('20','22'));
 if(small){add('1125','Дебіторська заборгованість за товари, роботи, послуги',dr('361'));add('1135','Дебіторська заборгованість за розрахунками з бюджетом',dr('641'));}
 add('1155','Інша поточна дебіторська заборгованість',dr(...(small?['371','372','377','378']:['361','371','372','377','378','641'])));
 const investments=settings.deposit351!=='cashEquivalent';
 if(small)add('1160','Поточні фінансові інвестиції',investments?dr('351'):[]);
 add('1165','Гроші та їх еквіваленти',dr('301','311',...(settings.cash313==='cash'?['313']:[]),...(!investments?['351']:[])));
 add('1190','Інші оборотні активи',dr('631','651','661','685',...(settings.cash313!=='cash'?['313']:[]),...(!small&&investments?['351']:[])));
 add('1195','Усього оборотних активів',[],['1100',...(small?['1125','1135','1160']:[]),'1155','1165','1190']);
 add('1300','Баланс (актив)',[],['1095','1195']);
 add('1400','Зареєстрований капітал',cr('40'));add('1420','Нерозподілений прибуток (непокритий збиток)',[...cr('44'),['44','dr',-1]]);
 add('1495','Усього власного капіталу',[],['1400','1420']);
 add('1595','Довгострокові зобовʼязання та цільове фінансування',settings.financingTerm!=='current'?cr('48'):[]);
 add('1615','Постачальники',cr('631'));add('1620','Розрахунки з бюджетом',cr('641'));add('1625','Розрахунки зі страхування',cr('651'));add('1630','Оплата праці',cr('661'));
 add('1690','Інші поточні зобовʼязання',cr('361','371','372','377','378','685','301','311','313','351',...(settings.financingTerm==='current'?['48']:[])));
 add('1695','Усього поточних зобовʼязань',[],['1615','1620','1625','1630','1690']);add('1900','Баланс (пасив)',[],['1495','1595','1695']);
 // Every occupied side must have exactly one destination among leaf terms.
 const leaf=balance.filter(r=>!r.children.length&&!r.subset),mapped=new Map();
 leaf.forEach(r=>r.sources.forEach(s=>{const key=s.acc+':'+s.side;mapped.set(key,(mapped.get(key)||0)+1);}));
 for(const r of report.osv)for(const [side,start,end]of[['dr','openDr','closeDr'],['cr','openCr','closeCr']])if((r[start]||r[end])&&mapped.get(r.acc+':'+side)!==1)block('Залишок '+r.acc+' '+side+' не має однозначного рядка балансу');
 if(balance.find(r=>r.code==='1010').endKop<0||balance.find(r=>r.code==='1010').startKop<0)block('Знос перевищує первісну вартість активів');
 const assets=balance.find(r=>r.code==='1300'),liabilities=balance.find(r=>r.code==='1900');
 if(assets.startKop!==liabilities.startKop||assets.endKop!==liabilities.endKop)block('Актив і пасив не збігаються у копійках');
 for(const at of ['startUnits','endUnits'])if(assets[at]!==liabilities[at])warn('Після округлення є різниця між активом і пасивом; потрібна перевірка округлення у формі');
 for(const r of balance.filter(r=>r.children.length))for(const at of ['startUnits','endUnits'])if(r[at]!==r.children.reduce((s,c)=>s+balance.find(x=>x.code===c)[at],0))warn('Округлення рядка '+r.code+' відрізняється від суми округлених складових');
 const prior=settings.comparatives||{},priorValid=['salesKop','operatingKop','otherKop','costOfSalesKop','otherOperatingCostKop','otherCostKop'].every(k=>Number.isSafeInteger(prior[k])&&prior[k]>=0)
  &&prior.salesKop+prior.operatingKop+prior.otherKop===report.previousIncome?.incomeKop&&prior.costOfSalesKop+prior.otherOperatingCostKop+prior.otherCostKop===report.previousIncome?.costKop;
 if(!priorValid)block('Розшифруйте порівняльні доходи й витрати з прийнятого звіту; загальних підсумків недостатньо');
 const income=a=>report.income.find(r=>r.acc===a)?.kop||0,results=[];
 const result=(code,label,kop,previousKop,accounts=[],children=[])=>results.push({code,label,kop,previousKop:previousKop??null,units:roundUnits(kop),previousUnits:previousKop==null?null:roundUnits(previousKop),accounts,children});
 result('2000','Чистий дохід від реалізації',income('703'),priorValid?prior.salesKop:null,['703']);
 if(small){result('2120','Інші операційні доходи',income('719'),priorValid?prior.operatingKop:null,['719']);result('2240','Інші доходи',income('733'),priorValid?prior.otherKop:null,['733']);}
 else result('2160','Інші доходи',income('719')+income('733'),priorValid?prior.operatingKop+prior.otherKop:null,['719','733']);
 result('2280','Разом доходи',report.summary.incomeKop,report.previousIncome?.incomeKop,[],small?['2000','2120','2240']:['2000','2160']);
 result('2050','Собівартість реалізації',0,priorValid?prior.costOfSalesKop:null,[]);
 result(small?'2180':'2165',small?'Інші операційні витрати':'Інші витрати',report.summary.costKop,priorValid?(small?prior.otherOperatingCostKop:prior.otherOperatingCostKop+prior.otherCostKop):null,['92']);
 if(small)result('2270','Інші витрати',0,priorValid?prior.otherCostKop:null,[]);
 result('2285','Разом витрати',report.summary.costKop,report.previousIncome?.costKop,[],small?['2050','2180','2270']:['2050','2165']);
 result('2290','Фінансовий результат до оподаткування',report.summary.resultKop,report.previousIncome?report.previousIncome.incomeKop-report.previousIncome.costKop:null,[],['2280','2285']);
 result('2300','Податок на прибуток',0,priorValid?0:null,[]);
 result('2350','Чистий прибуток (збиток)',report.summary.resultKop,report.previousIncome?report.previousIncome.incomeKop-report.previousIncome.costKop:null,[],['2290','2300']);
 for(const code of ['2280','2285']){const r=results.find(x=>x.code===code);if(r.units!==r.children.reduce((sum,id)=>sum+results.find(x=>x.code===id).units,0))warn('Округлення фінрезультатів: рядок '+code+' відрізняється від суми складових');}
 // Prior tax is not derivable from the former aggregate incomes/expenses.
 if(settings.noIncomeTax!==true)block('Підтвердьте відсутність податку на прибуток за обидва роки; випадки оподаткування потребують окремого обліку');
 const sourceGroups=groups(report),assignments=settings.assignments||{},npo=new Map();
 for(const g of sourceGroups){const a=assignments[g.id];const allowed=g.kind==='income'?INCOME:COST;
  if(!a||!allowed.includes(a.category)||!new RegExp('^'+(g.kind==='income'?'1':'2')+'\\.\\d{1,2}(\\.\\d{1,2})?$').test(a.row||'')){block('Визначте категорію та рядок звіту неприбуткової організації: '+g.label);continue;}
  const k=g.kind+':'+a.row;if(!npo.has(k))npo.set(k,{kind:g.kind,code:a.row,categories:[],kop:0,sourceIds:[]});const r=npo.get(k);if(!r.categories.includes(a.category))r.categories.push(a.category);r.kop+=g.kop;r.sourceIds.push(g.id);
 }
 const incomeTotal=sourceGroups.filter(g=>g.kind==='income').reduce((s,g)=>s+g.kop,0),costTotal=sourceGroups.filter(g=>g.kind==='cost').reduce((s,g)=>s+g.kop,0);
 if(incomeTotal!==report.summary.incomeKop||costTotal!==report.summary.costKop)block('Розшифровка доходів / витрат не збігається з річним журналом');
 for(const kind of ['income','cost']){const codes=[...npo.values()].filter(r=>r.kind===kind).map(r=>r.code);if(codes.some(a=>codes.some(b=>b.startsWith(a+'.'))))block('Рядки неприбуткового звіту не можуть одночасно містити підсумок і його підрядок');}
 if(settings.noViolation!==true)block('Підтвердьте відсутність нецільового використання / розподілу доходу. Частина II потребує окремого розрахунку');
 const npoRows=[...npo.values()].sort((a,b)=>a.code.localeCompare(b.code,undefined,{numeric:true})).map(r=>({...r,label:r.categories.map(c=>CATEGORIES[c]).join('; '),grn:r.kop/100}));
 checks.push({level:'info',text:'Це розрахункові таблиці: фінансові суми — тис. грн з одним десятковим знаком, неприбутковий звіт — грн. Повернення депозиту не є доходом, переказ на нього не є витратами. Рядки й електронну схему звірте з чинними формами.'});
 return{layoutVersion:'annual-calculation-v1',form,balanceName:supported?(small?'1-м':'1-мс'):'Баланс (розшифровка)',resultsName:supported?(small?'2-м':'2-мс'):'Фінрезультат (розшифровка)',unitKop:10000,balance,results,sourceGroups,npoRows,npoTotals:{incomeKop:incomeTotal,costKop:costTotal},checks,reviewReady:!checks.some(c=>c.level==='block'),filingReady:false,xmlAvailable:false};
}
module.exports={build,groups,roundUnits,CATEGORIES,INCOME,COST};
