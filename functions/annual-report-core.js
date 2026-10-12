'use strict';
const journal = require('./journal-core');
const { previousDay } = require('./accounting-policy');
const { validDate } = require('./expenses-core');
const amount = (entries, acc, side, opposite) => entries.filter(e=>e[side]===acc && (!opposite || e[side==='dr'?'cr':'dr']!==opposite)).reduce((s,e)=>s+e.kop,0);
const net = (entries,acc) => amount(entries,acc,'cr','79')-amount(entries,acc,'dr','79');
const bookBalances = entries => {
    const map=new Map();
    for(const e of entries) for(const side of ['dr','cr']) {
        if(e[side]==='00')continue;
        const a=e[side==='dr'?'dA':'cA']||'',key=`${e[side]}|${a}`;
        map.set(key,(map.get(key)||0)+(side==='dr'?e.kop:-e.kop));
    }
    return map;
};
function historyProblem(data,year,startDate) {
    if(!Array.isArray(data.openingLines)||!Array.isArray(data.entries)||data.entries.length>20000) return 'Потрібні залишки на 1 січня й проводки до дати початку; до 20 000 рядків';
    for(const l of data.openingLines) if(!journal.ACCOUNTS[l.acc]||l.acc==='00'||!['dr','cr'].includes(l.side)||!Number.isSafeInteger(l.kop)||l.kop<=0||l.kop>100000000000) return 'Некоректний рядок залишків на 1 січня';
    if(data.openingLines.reduce((s,l)=>s+(l.side==='dr'?l.kop:-l.kop),0)) return 'Вхідні залишки на 1 січня не збалансовані';
    for(const e of data.entries) if(!validDate(e.date)||e.date<`${year}-01-01`||e.date>=startDate||!journal.ACCOUNTS[e.dr]||!journal.ACCOUNTS[e.cr]||e.dr==='00'||e.cr==='00'||!Number.isSafeInteger(e.kop)||e.kop<=0||e.kop>100000000000) return 'У проводках помилка дати, рахунку або суми; потрібні всі операції, включно із закриттям';
    if(data.previousIncome && ['incomeKop','costKop'].some(k=>!Number.isSafeInteger(data.previousIncome[k])||data.previousIncome[k]<0)) return 'Перевірте доходи й витрати попереднього року';
    return null;
}
function historyEntries(history,year) {
    return [...journal.openingEntries(history.openingLines,`${year}-01`),...history.entries.map((e,i)=>({...e,period:e.date.slice(0,7),src:'migration',ref:`migration-${year}-${i}`,memo:e.memo||''}))];
}
function annual({year,input,closed=[],history=null,previousIncome=null,policy,openingStatus,today}) {
    const first=`${year}-01`,last=`${year}-12`,from=`${year}-01-01`,to=`${year}-12-31`;
    const cutDate=policy.startDate;
    const start=cutDate.slice(0,7);
    const checks=[];
    if(input.bankTx?.some(t=>t.bankConflict && t.period<=last))checks.push({level:'block',text:'Виписка має невирішені зміни / сторно банку; річні дані потребують звірки'});
    const cutOpening=journal.buildEntries({...input,until:last}).filter(e=>e.src==='opening');
    let entries=journal.journal(input,last);
    const needsHistory=cutDate>from;
    if(needsHistory) {
        if(!history || history.status!=='approved') checks.push({level:'block',text:`Не перенесено й не погоджено облік з 1 січня до ${previousDay(cutDate)}. Річні підсумки неповні`});
        if(history) {
            const old=historyEntries(history,year);
            const expected=bookBalances(cutOpening),actual=bookBalances(old);
            const keys=new Set([...expected.keys(),...actual.keys()]);
            const mismatch=[...keys].filter(k=>(expected.get(k)||0)!==(actual.get(k)||0));
            if(mismatch.length) checks.push({level:'block',text:`Перенесені обороти не дають вхідну ОСВ на дату переходу: ${mismatch.length} рахунків / аналітик`,details:mismatch.slice(0,20)});
            entries=[...old,...entries.filter(e=>e.src!=='opening')];
        }
    }
    if(cutDate>to) checks.push({level:'block',text:'Цей рік повністю передує початку обліку; потрібна повна архівна бухгалтерська база'});
    if(openingStatus!=='approved') checks.push({level:'block',text:'Вхідну ОСВ на дату переходу не погоджено'});
    if(policy.status!=='approved') checks.push({level:'block',text:'Облікову політику не погоджено'});
    if(policy.reportingForm==='unspecified') checks.push({level:'block',text:'Не обрано форму фінансової звітності (мікро, мала або повна)'});
    const months=journal.periodsUpTo(last, start>first?start:first);
    const unclosed=months.filter(p=>!closed.includes(p));
    if(unclosed.length) checks.push({level:'block',text:`Місяці року ще не закрито: ${unclosed.join(', ')}`});
    if(today<=to) checks.push({level:'block',text:'Рік ще не завершено; доступні попередні підсумки'});
    const before=entries.filter(e=>e.date<from),inYear=entries.filter(e=>e.date>=from&&e.date<=to);
    const balances=journal.trialBalance(entries.filter(e=>e.date<=to),last);
    const opening=journal.trialBalance(before,`${Number(year)-1}-12`);
    const turnovers=new Map();
    for(const e of inYear) for(const side of ['dr','cr']) {
        const acc=e[side];if(acc==='00')continue;
        if(!turnovers.has(acc)) turnovers.set(acc,{acc,dr:0,cr:0});
        turnovers.get(acc)[side]+=e.kop;
    }
    const osv=balances.rows.filter(r=>r.acc!=='00').map(r=>({acc:r.acc,name:journal.ACCOUNTS[r.acc],openDr:opening.rows.find(x=>x.acc===r.acc)?.closeDr||0,
        openCr:opening.rows.find(x=>x.acc===r.acc)?.closeCr||0,dr:turnovers.get(r.acc)?.dr||0,cr:turnovers.get(r.acc)?.cr||0,closeDr:r.closeDr,closeCr:r.closeCr,
        byA:r.byA.map(a=>{
            const o=opening.rows.find(x=>x.acc===r.acc)?.byA.find(x=>x.a===a.a);
            const dr=inYear.filter(e=>e.dr===r.acc&&(e.dA||'')===a.a).reduce((s,e)=>s+e.kop,0),cr=inYear.filter(e=>e.cr===r.acc&&(e.cA||'')===a.a).reduce((s,e)=>s+e.kop,0);
            return {...a,openDr:o?.closeDr||0,openCr:o?.closeCr||0,dr,cr};
        })}));
    const balanceDiff=osv.reduce((s,r)=>s+r.closeDr-r.closeCr,0);
    if(balanceDiff) checks.push({level:'block',text:'Річний баланс не збалансований'});
    const income= ['703','719','733'].map(acc=>({acc,name:journal.ACCOUNTS[acc],kop:net(inYear,acc)}));
    const costs=amount(inYear,'92','dr','79')-amount(inYear,'92','cr','79');
    const incomeKop=income.reduce((s,r)=>s+r.kop,0),costKop=costs;
    const actualResult=amount(inYear,'44','cr','00')-amount(inYear,'44','dr','00');
    if(incomeKop-costKop!==actualResult) checks.push({level:'block',text:'Доходи мінус витрати не збігаються з перенесеним фінансовим результатом; перевірте закриття та коригування капіталу'});
    const receivables=['361','371','372','377','378'].map(acc=>({acc,name:journal.ACCOUNTS[acc],kop:osv.find(r=>r.acc===acc)?.closeDr||0}));
    const liabilities=['631','641','651','661','685','48'].map(acc=>({acc,name:journal.ACCOUNTS[acc],kop:osv.find(r=>r.acc===acc)?.closeCr||0}));
    const cashAccounts=['301','311','313','351','143'].map(acc=>({acc,name:journal.ACCOUNTS[acc],kop:(osv.find(r=>r.acc===acc)?.closeDr||0)-(osv.find(r=>r.acc===acc)?.closeCr||0)}));
    const funds=policy.funds.map(f=>{
        const openingBalance=before.filter(e=>e.cr==='48'&&e.cA===f.id).reduce((s,e)=>s+e.kop,0)-before.filter(e=>e.dr==='48'&&e.dA===f.id).reduce((s,e)=>s+e.kop,0);
        const received=inYear.filter(e=>e.cr==='48'&&e.cA===f.id).reduce((s,e)=>s+e.kop,0);
        const used=inYear.filter(e=>e.dr==='48'&&e.dA===f.id).reduce((s,e)=>s+e.kop,0);
        return {...f,openKop:openingBalance,receivedKop:received,usedKop:used,closeKop:openingBalance+received-used};
    });
    const movements=inYear.filter(e=>['bank','migration'].includes(e.src)&&['311','313','351','143'].some(a=>e.dr===a||e.cr===a));
    const externalCash=movements.filter(e=>!(['311','313','351','143'].includes(e.dr)&&['311','313','351','143'].includes(e.cr)));
    const receiptsKop=externalCash.filter(e=>['311','313','351','143'].includes(e.dr)).reduce((s,e)=>s+e.kop,0);
    const payoutsKop=externalCash.filter(e=>['311','313','351','143'].includes(e.cr)).reduce((s,e)=>s+e.kop,0);
    const priorYear=String(Number(year)-1),priorEntries=entries.filter(e=>e.date>=`${priorYear}-01-01`&&e.date<=`${priorYear}-12-31`);
    const priorClosed=journal.periodsUpTo(`${priorYear}-12`,`${priorYear}-01`).every(p=>closed.includes(p));
    const previous=previousIncome || history?.previousIncome || (policy.startDate<=`${priorYear}-01-01`&&priorClosed?{incomeKop:['703','719','733'].reduce((s,a)=>s+net(priorEntries,a),0),costKop:amount(priorEntries,'92','dr','79')-amount(priorEntries,'92','cr','79')}:null);
    if(!previous) checks.push({level:'block',text:'Для порівняльної колонки фінрезультатів потрібні доходи та витрати попереднього року з прийнятого звіту'});
    const financialRows=osv.map(r=>({acc:r.acc,name:r.name,atStartKop:r.openDr-r.openCr,atEndKop:r.closeDr-r.closeCr}));
    if(funds.some(f=>f.closeKop<0)) checks.push({level:'warn',text:'За фондом витрачено більше, ніж нараховано фінансування; звірте джерело покриття'});
    checks.push({level:'info',text:'Це робочі дані для фінзвітності та звіту неприбуткової організації. Офіційні форми, їх версії та податкові рядки перевіряє бухгалтер перед підписанням і поданням'});
    return {year,from,to,startDate:cutDate,coverage:{needsHistory,historyApproved:history?.status==='approved',unclosed},complete:!checks.some(c=>c.level==='block'),
        checks,osv,entries:inYear,financialRows,income,receivables,liabilities,cashAccounts,funds,previousIncome:previous,
        summary:{incomeKop,costKop,resultKop:incomeKop-costKop,receiptsKop,payoutsKop,balanceDiff},policyVersion:policy.version,reportingForm:policy.reportingForm};
}
module.exports={annual,historyProblem,historyEntries,bookBalances};
