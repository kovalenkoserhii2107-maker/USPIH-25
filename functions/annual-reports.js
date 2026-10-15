'use strict';
const { HttpsError }=require('firebase-functions/v2/https');
const { createHash,randomUUID }=require('node:crypto');
const core=require('./annual-report-core');
const policyCore=require('./accounting-policy');
const jcore=require('./journal-core');
const formsCore=require('./annual-forms-core');
const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
const reportHash=report=>createHash('sha256').update(JSON.stringify(canonical(report))).digest('hex');
module.exports=function annualReports({db,FieldValue,journal}) {
    const valid=year=>/^20\d{2}$/.test(String(year));
    const fail=message=>{throw new HttpsError('failed-precondition',message);};
    async function history(year,transaction) {
        const get=ref=>transaction?transaction.get(ref):ref.get();
        const pointer=(await get(db.doc(`annual_history/${year}`))).data();
        if(!pointer)return null;
        const version=pointer.approvedId || pointer.draftId;
        const [meta,parts]=await Promise.all([get(db.doc(`annual_history_versions/${version}`)),get(db.collection('annual_history_parts').where('version','==',version))]);
        if(!meta.exists)fail('Архів перенесення неповний');
        const chunks=parts.docs.sort((a,b)=>a.data().index-b.data().index);
        if(chunks.length!==meta.data().parts||chunks.some((d,i)=>d.data().index!==i||!Array.isArray(d.data().entries)))fail('Відсутня частина перенесених проводок');
        return {...meta.data(),id:version,status:pointer.approvedId===version?'approved':'draft',entries:chunks.flatMap(d=>d.data().entries)};
    }
    async function data({year},transaction) {
        if(!valid(year))fail('Оберіть рік');
        const [source,old,comparative]=await Promise.all([journal.load(transaction),history(year,transaction),transaction?transaction.get(db.doc(`annual_comparatives/${year}`)):db.doc(`annual_comparatives/${year}`).get()]);
        const result=core.annual({year:String(year),input:source.input,closed:source.closed,history:old,previousIncome:comparative.data()?.status==='approved'?comparative.data():null,policy:source.policy,openingStatus:source.opening?.status,
            today:new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Kyiv'}).format(new Date())});
        const missing=source.closed.filter(p=>p.startsWith(String(year))&&!source.input.closedSnapshots.has(p));
        if(missing.length){result.checks.push({level:'block',text:`У старих закритих місяцях немає повного архіву проводок: ${missing.join(', ')}. Потрібна звірка вихідного журналу`});result.complete=false;}
        return result;
    }
    async function importHistory(actor,role,{year,openingLines,entries,previousIncome,basis}) {
        if(!valid(year)||String(basis||'').trim().length<5)fail('Оберіть рік і вкажіть джерело перенесення');
        const settings=await journal.actions.policy();
        if(settings.startDate.slice(0,4)!==String(year))fail('Переносять історію року переходу до дати початку обліку');
        const clean={openingLines:openingLines?.map(l=>({acc:String(l.acc),a:String(l.a||'').trim().slice(0,200),side:l.side,kop:Number(l.kop)})),
            entries:entries?.map(e=>({date:String(e.date),dr:String(e.dr),cr:String(e.cr),kop:Number(e.kop),dA:String(e.dA||'').trim().slice(0,200),cA:String(e.cA||'').trim().slice(0,200),memo:String(e.memo||'').slice(0,300)})),
            ...(previousIncome?{previousIncome:{incomeKop:Number(previousIncome.incomeKop),costKop:Number(previousIncome.costKop)}}:{})};
        const problem=core.historyProblem(clean,String(year),settings.startDate);
        if(problem)fail(problem);
        const id=`${year}-${randomUUID()}`,parts=Math.ceil(clean.entries.length/250);
        await db.runTransaction(async t=>{
            const current=await journal.actions.policy(t);
            if(current.startDate!==settings.startDate)fail('Дата переходу змінилася; перевірте файл знову');
            t.set(db.doc(`annual_history_versions/${id}`),{year:String(year),startDate:settings.startDate,openingLines:clean.openingLines,
                ...(clean.previousIncome?{previousIncome:clean.previousIncome}:{}),parts,basis:String(basis).trim().slice(0,500),by:actor,at:FieldValue.serverTimestamp()});
            for(let i=0;i<parts;i++)t.create(db.doc(`annual_history_parts/${id}-${i}`),{version:id,index:i,entries:clean.entries.slice(i*250,(i+1)*250)});
            t.set(db.doc(`annual_history/${year}`),{draftId:id},{merge:true});
            t.create(db.collection('audit_log').doc(),{actor,role,action:'annual.import',target:`annual_history/${year}`,summary:'Історію року перенесено для погодження',details:{id,entries:clean.entries.length},at:FieldValue.serverTimestamp()});
        });
        return {ok:true,id};
    }
    async function saveComparative(actor,role,{year,incomeKop,costKop,basis}) {
        if(role!=='chair')throw new HttpsError('permission-denied','Порівняльні дані з прийнятого звіту погоджує голова');
        if(!valid(year)||[incomeKop,costKop].some(k=>!Number.isSafeInteger(k)||k<0||k>100000000000)||String(basis||'').trim().length<5)fail('Укажіть доходи, витрати та джерело попереднього року');
        const batch=db.batch();
        batch.set(db.doc(`annual_comparatives/${year}`),{year:String(year),incomeKop,costKop,basis:String(basis).trim().slice(0,500),status:'approved',by:actor,at:FieldValue.serverTimestamp()});
        batch.create(db.collection('audit_log').doc(),{actor,role,action:'annual.comparative',target:`annual_comparatives/${year}`,summary:'Збережено погоджені порівняльні дані попереднього року',details:{year,incomeKop,costKop},at:FieldValue.serverTimestamp()});
        await batch.commit();return{ok:true};
    }
    async function forms({year},transaction) {
        if(!valid(year))fail('Оберіть рік');
        const versionsQuery=db.collection('report_packages').where('key','==',`npo-${year}`).select('version','type','basis');
        const [report,snap,versions]=await Promise.all([data({year},transaction),transaction?transaction.get(db.doc(`annual_form_settings/${year}`)):db.doc(`annual_form_settings/${year}`).get(),transaction?transaction.get(versionsQuery):versionsQuery.get()]);
        const settings=snap.data()||{},sourceHash=reportHash(report),calculation=formsCore.build(report,settings);
        const reviewed=settings.sourceHash===sourceHash;
        if(!reviewed){calculation.checks.push({level:'block',text:'Погодьте розшифровку для поточного журналу. Після зміни джерел потрібна повторна перевірка'});calculation.reviewReady=false;}
        return {year:String(year),report,sourceHash,reviewed,settings,calculation,versions:versions.docs.filter(d=>['annual-working-data','annual-calculation-forms','annual-dps-xml'].includes(d.data().type)).map(d=>({id:d.id,version:d.data().version,type:d.data().type,basis:d.data().basis||''})).sort((a,b)=>b.version-a.version)};
    }
    async function saveForms(actor,role,payload) {
        const {year,sourceHash}=payload;
        if(!valid(year)||String(payload.basis||'').trim().length<5)fail('Укажіть рік та джерело / підставу перевірки форм');
        const p=payload.settings||{},settings={financingTerm:p.financingTerm||'',deposit351:p.deposit351||'',cash313:p.cash313||'',
            noViolation:p.noViolation===true,noIncomeTax:p.noIncomeTax===true,comparatives:p.comparatives||{},assignments:p.assignments||{}};
        if(Object.keys(settings.assignments).length>200||JSON.stringify(settings).length>60000)fail('Завелика розшифровка форм');
        const report=await data({year});
        if(sourceHash!==reportHash(report))throw new HttpsError('aborted','Річні джерела змінилися. Оновіть розрахунок перед погодженням');
        const calculation=formsCore.build(report,settings);
        const errors=calculation.checks.filter(c=>c.level==='block');
        if(errors.length)fail(errors.map(c=>c.text).join('; '));
        return db.runTransaction(async t=>{
            t.set(db.doc(`annual_form_settings/${year}`),{...settings,sourceHash,basis:String(payload.basis).trim().slice(0,500),by:actor,role,at:FieldValue.serverTimestamp()});
            t.create(db.collection('audit_log').doc(),{actor,role,action:'annual.forms.review',target:`annual_form_settings/${year}`,summary:'Перевірено рядки річних розрахункових форм',details:{sourceHash,layoutVersion:calculation.layoutVersion},at:FieldValue.serverTimestamp()});
            return {ok:true};
        });
    }
    async function approveHistory(actor,role,{year}) {
        if(role!=='chair')throw new HttpsError('permission-denied','Перенос обліку погоджує голова');
        if(!valid(year))fail('Оберіть рік');
        const source=await journal.load();
        if(source.opening?.status!=='approved')fail('Спочатку погодьте вхідну ОСВ на дату переходу');
        const expected=core.bookBalances(jcore.buildEntries(source.input).filter(e=>e.src==='opening'));
        await db.runTransaction(async t=>{
            const [pointer,openingSnap,policy]=await Promise.all([t.get(db.doc(`annual_history/${year}`)),t.get(db.doc('journal_opening/main')),journal.actions.policy(t)]);
            const version=pointer.data()?.draftId;
            if(!version)fail('Спочатку завантажте історію року');
            if(openingSnap.data()?.status!=='approved')fail('Спочатку погодьте вхідну ОСВ на дату переходу');
            const [meta,parts]=await Promise.all([t.get(db.doc(`annual_history_versions/${version}`)),t.get(db.collection('annual_history_parts').where('version','==',version))]);
            const entries=parts.docs.sort((a,b)=>a.data().index-b.data().index).flatMap(d=>d.data().entries);
            if(parts.size!==meta.data().parts||parts.docs.sort((a,b)=>a.data().index-b.data().index).some((d,i)=>d.data().index!==i)||meta.data().startDate!==policy.startDate)fail('Перенесення неповне або дата переходу змінилася');
            const actual=core.bookBalances(core.historyEntries({...meta.data(),entries},String(year)));
            const off=[...new Set([...expected.keys(),...actual.keys()])].filter(k=>(expected.get(k)||0)!==(actual.get(k)||0));
            if(off.length)fail(`Перенесений журнал не дає погоджену вхідну ОСВ: ${off.slice(0,8).join(', ')}. Виправте перенос, не підганяйте баланс`);
            t.update(pointer.ref,{approvedId:version,approvedBy:actor,approvedAt:FieldValue.serverTimestamp()});
            t.create(db.collection('audit_log').doc(),{actor,role,action:'annual.import.approve',target:pointer.ref.path,summary:'Обороти попереднього обліку звірено із вхідною ОСВ',details:{year,version},at:FieldValue.serverTimestamp()});
        });
        return {ok:true};
    }
    async function snapshot(actor,role,{year,withForms=false,submissionKind='initial',previousPackageId='',basis=''}) {
        if(!valid(year))fail('Оберіть рік');
        const [report,prepared]=await Promise.all([data({year}),withForms?forms({year}):null]);
        if(withForms){
            if(!prepared.calculation.reviewReady)fail('Спочатку погодьте повну розшифровку річних форм');
            if(prepared.sourceHash!==reportHash(report))fail('Джерела розрахунку змінилися');
            if(!['initial','replacement','correction'].includes(submissionKind)||String(basis).trim().length<5)fail('Оберіть вид версії й підставу формування');
            report.forms=prepared.calculation;
        }
        const parts=Math.ceil(report.entries.length/250),tables={...report};delete tables.entries;
        const hash=reportHash(report);
        return db.runTransaction(async t=>{
            const [packages,financialPackages,formSettingsSnap]=await Promise.all([
                t.get(db.collection('report_packages').where('key','==',`npo-${year}`)),
                t.get(db.collection('report_packages').where('key','==',`fs-stat-${year}`)),
                withForms?t.get(db.doc(`annual_form_settings/${year}`)):null
            ]);
            if(withForms){
                if(formSettingsSnap?.data()?.sourceHash!==prepared.sourceHash)fail('Джерела розрахунку змінилися');
                if(submissionKind!=='initial'&&!packages.docs.some(d=>d.id===previousPackageId))fail('Оберіть попередню версію цього року для виправлення');
                if(submissionKind==='initial'&&previousPackageId)fail('Для первинного розрахунку попередня версія не потрібна');
            }
            const version=Math.max(0,...[...packages.docs,...financialPackages.docs].map(d=>Number(d.data().version)||0))+1;
            const id=`npo-${year}--${version}`;
            for(let i=0;i<parts;i++)t.create(db.doc(`annual_package_parts/${id}-${i}`),{packageId:id,index:i,entries:report.entries.slice(i*250,(i+1)*250)});
            for(const key of [`npo-${year}`,`fs-stat-${year}`])t.create(db.doc(`report_packages/${key}--${version}`),{key,version,type:withForms?'annual-calculation-forms':'annual-working-data',archiveId:id,hash,hashFormat:'canonical-json-v1',tables,parts,
                filingReady:false,submissionKind:withForms?submissionKind:null,previousPackageId:withForms?previousPackageId:null,basis:withForms?String(basis).trim().slice(0,500):'',
                files:[],by:actor,at:FieldValue.serverTimestamp(),complete:report.complete});
            t.create(db.collection('audit_log').doc(),{actor,role,action:'annual.snapshot',target:`report_packages/${id}`,summary:'Збережено незмінну версію річних робочих даних',details:{year,version,hash,complete:report.complete},at:FieldValue.serverTimestamp()});
            return {ok:true,id,version,complete:report.complete};
        });
    }
    async function packageData({id}) {
        if(!/^(npo|fs-stat)-20\d{2}--\d+$/.test(String(id)))fail('Невідомий річний пакет');
        const pack=(await db.doc(`report_packages/${id}`).get()).data();
        if(!['annual-working-data','annual-calculation-forms'].includes(pack?.type))fail('Річний пакет не знайдено');
        const parts=(await db.collection('annual_package_parts').where('packageId','==',pack.archiveId).get()).docs.sort((a,b)=>a.data().index-b.data().index);
        if(parts.length!==pack.parts||parts.some((d,i)=>d.data().index!==i||!Array.isArray(d.data().entries)))fail('Архів річного пакета неповний');
        const report={...pack.tables,entries:parts.flatMap(d=>d.data().entries)};
        if(pack.hashFormat==='canonical-json-v1'&&reportHash(report)!==pack.hash)fail('Контрольна сума річного архіву не збігається; звірте резервну копію');
        return {type:pack.type,id,version:pack.version,hash:pack.hash,submissionKind:pack.submissionKind||null,previousPackageId:pack.previousPackageId||null,basis:pack.basis||'',report};
    }
    return {data,importHistory,approveHistory,snapshot,packageData,saveComparative,forms,saveForms};
};
