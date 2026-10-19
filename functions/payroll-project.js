'use strict';
const { HttpsError } = require('firebase-functions/v2/https');
const { randomUUID, createHash } = require('node:crypto');
const api = require('./privat-payroll-api');
const core = require('./payroll-core');
const { payable } = require('./bank-accounts');
const identity = require('./payroll-payment-core');
const fail = (code, message) => { throw new HttpsError(code, message); };
const safe = value => String(value || '').replace(/[^\w-]/g, '').slice(0, 120);
module.exports = function projectFunctions({ db, FieldValue, lock }) {
    async function token() {
        const value = (await db.doc('bank_secrets/privat').get()).data()?.token;
        if (!value) fail('failed-precondition', 'Підключіть Автоклієнт ПриватБанку');
        return value;
    }
    async function context({ group }) {
        const secret = await token();
        const groups = await api.groups(secret);
        if (!Array.isArray(groups)) fail('unavailable', 'Банк повернув некоректний список проектів');
        const available = groups.filter(g => ['SALARY','STUDENT'].includes(g.type)).map(g => ({ type:g.type, name:String(g.name || ''), rko:g.rko ?? null }));
        if (!group) return { groups:available, receivers:[] };
        if (!available.some(g => g.type === group)) fail('invalid-argument', 'Оберіть доступний зарплатний проект');
        const rows = await api.receivers(secret, group);
        const receivers = rows.map(r => ({ id:String(r.id), group:String(r.group), inn:String(r.inn || ''), fio:String(r.fio || ''), tabn:String(r.tabn || ''),
            pan:String(r.pan || '').replace(/\d(?=.{4})/g, '*') }));
        await db.doc(`payroll_project_receivers/${group}`).set({ rows:receivers, at:FieldValue.serverTimestamp() });
        return { groups:available, receivers };
    }
    async function linkReceiver(actor, role, { personId, group, receiverId }) {
        if (!['SALARY','STUDENT'].includes(group)) fail('invalid-argument', 'Невідомий проект');
        const ref = db.doc(`payroll_people/${safe(personId)}`);
        await db.runTransaction(async t => {
            const [person, list] = await Promise.all([t.get(ref), t.get(db.doc(`payroll_project_receivers/${group}`))]);
            const receiver = list.data()?.rows?.find(r => r.id === receiverId && r.group === group);
            if (person.data()?.kind !== 'employee' || !receiver || !receiver.tabn || receiver.inn !== person.data().rnokpp) fail('failed-precondition', 'РНОКПП працівника й отримувача банку мають збігатись; потрібен табельний номер');
            t.update(ref, { salaryProject:{ group, receiverId, tabn:receiver.tabn }, updatedAt:FieldValue.serverTimestamp() });
            t.create(db.collection('audit_log').doc(), { actor,role,action:'payroll.project.receiver',target:ref.path,
                summary:'Працівника звʼязано з отримувачем зарплатного проекту',details:{group},at:FieldValue.serverTimestamp() });
        });
        return { ok:true };
    }
    async function find({period,stage}) {
        if(!/^\d{4}-(0[1-9]|1[0-2])$/.test(String(period))||!['advance','final'].includes(stage))fail('invalid-argument','Оберіть відомість та етап');
        const stored=(await db.doc(`payroll_runs/${period}`).get()).data(),project=stored?.stages?.[stage]?.project;
        if(!project)fail('failed-precondition','Відомість проекту не підготовлена');
        const secret=await token();
        const [drafts,signing]=await Promise.all([api.packets(secret,'V'),api.packets(secret,'A')]);
        return [...new Map([...drafts,...signing].filter(p=>p.system==='maspay'&&p.packetName===project.packetName).map(p=>[p.reference,p])).values()]
            .map(p=>({reference:String(p.reference),status:p.status,recordCount:p.recordCount||0,revision:p.revision||0}));
    }
    async function status({period,stage}) {
        if(!/^\d{4}-(0[1-9]|1[0-2])$/.test(String(period))||!['advance','final'].includes(stage))fail('invalid-argument','Оберіть відомість та етап');
        const ref=db.doc(`payroll_runs/${period}`),stored=(await ref.get()).data(),project=stored?.stages?.[stage]?.project;
        if(!project?.reference)fail('failed-precondition','Банк ще не підтвердив референс; спочатку звірте невідомий результат');
        const secret=await token(),[header,rows]=await Promise.all([api.header(secret,project.reference),api.content(secret,project.reference)]);
        if(header.group!==project.group||header.system&&header.system!=='maspay'||header.packetName!==project.packetName)fail('failed-precondition','Це інша відомість банку');
        return{reference:project.reference,status:String(header.status),substatus:header.substatus||'',revision:header.revision||0,error:header.errText||'',
            rows:rows.map(r=>({name:String(r.fio||''),amountKop:api.amountKop(r),status:String(r.status),error:String(r.errorCode||'')}))};
    }
    async function prepare(actor, role, { period, stage, group, reference }) {
        if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(String(period)) || !['advance','final'].includes(stage) || !['SALARY','STUDENT'].includes(group)) fail('invalid-argument', 'Оберіть місяць, етап та проект');
        if (reference && role !== 'chair') fail('permission-denied', 'Невідомий результат звіряє голова');
        const secret = await token(), runRef=db.doc(`payroll_runs/${period}`), attempt=randomUUID();
        let work = await db.runTransaction(async t => {
            const [snap, settings, finance, bank, people, payments, bankSecret] = await Promise.all([t.get(runRef),t.get(db.doc('payroll_settings/main')),t.get(db.doc('osbb_settings/finance')),
                t.get(db.doc('bank/settings')),t.get(db.collection('payroll_people')),t.get(db.collection('payments').where('payroll.period','==',period)),t.get(db.doc('bank_secrets/privat'))]);
            if(bankSecret.data()?.token!==secret)fail('aborted','Підключення банку змінилося; оновіть отримувачів перед підготовкою');
            const stored=snap.data(), old=stored?.stages?.[stage];
            await lock?.assertOpen(period,'Зарплатний проект',t);
            if (stored?.status!=='approved' || stored.canceling || old?.external || (stored.sending && Date.now()-Date.parse(stored.sending.at)<600000)) fail('failed-precondition','Потрібна затверджена відомість без іншої відправки');
            const bad=stored.run.rows.filter(r=>r.netKop>0&&r.problems?.length);
            if(bad.length) fail('failed-precondition',bad.map(r=>`${r.name}: ${r.problems.join('; ')}`).join('; '));
            if (stage==='advance'&&stored.stages?.final || stage==='final'&&stored.stages?.advance?.complete===false) fail('failed-precondition','Завершіть попередній етап');
            if (old?.plan && !old.project) fail('failed-precondition','Цей етап уже готується переказами по IBAN');
            if (old?.project?.group && old.project.group!==group) fail('failed-precondition','Не можна змінити проект підготовленого етапу');
            const account=old?.account || Object.entries(bank.data()?.accounts || {}).find(([,a])=>payable(a)&&(a.purpose||'current')==='current')?.[0];
            if (!account || !payable(bank.data()?.accounts?.[account])) fail('failed-precondition','Потрібен доступний гривневий поточний рахунок');
            const plan=old?.plan || core.stagePayments(core.paymentRun(stored),stage,{code:finance.data()?.edrpou,taxes:settings.data()?.taxes});
            const errors=core.paymentProblems(plan,account);
            if(errors.length) fail('failed-precondition',errors.join('; '));
            const map=new Map(people.docs.map(d=>[d.id,d.data()]));
            const wages=plan.filter(p=>p.kind==='salary').map(row=>{
                const person=stored.run.rows.find(r=>r.personId===row.personId), link=map.get(row.personId)?.salaryProject;
                if(person?.kind!=='employee'||link?.group!==group||!link.receiverId||!link.tabn) fail('failed-precondition',`${row.recipient.name}: звʼяжіть працівника з отримувачем проекту. ЦПД виплачується по IBAN`);
                return {...row,receiverId:link.receiverId,tabn:link.tabn};
            });
            if(!wages.length) fail('failed-precondition','Немає зарплатних отримувачів');
            if(payments.docs.some(d=>d.data().payroll.stage===stage&&d.data().source!=='salaryProject'&&['sending','unknown','sent','paid'].includes(d.data().status))) fail('failed-precondition','Етап уже має платежі іншого способу');
            const project={packetName:`ОСББ ${finance.data()?.edrpou} ${period} ${stage} ${createHash('sha256').update(runRef.path+stage).digest('hex').slice(0,8)}`,
                group,system:'maspay',added:{},...old?.project};
            if(project.status==='unknown'&&!reference) fail('failed-precondition','Результат запиту невідомий. Голова має звірити відомість у Приват24 та ввести її референс');
            if(reference) project.reference=String(reference).trim();
            t.update(runRef,{sending:{attempt,at:new Date().toISOString()},[`stages.${stage}`]:{...old,plan,account,complete:false,project},
                ...(stage==='advance'?{paidAdvance:Object.fromEntries(stored.run.rows.map(r=>[r.personId,r.advance]))}:{})});
            return {project,wages,plan,account,old};
        });
        let changed=false;
        try {
            const currentReceivers=await api.receivers(secret,group);
            if(work.wages.some(w=>!currentReceivers.some(r=>String(r.id)===w.receiverId&&String(r.inn)===w.recipient.code&&String(r.tabn)===w.tabn)))fail('failed-precondition','Дані отримувачів змінилися в банку. Оновіть список і звʼязки працівників');
            if(!work.project.reference) {
                changed=true;
                const header=await api.create(secret,group,work.project.packetName);
                if(!header.reference || header.system && header.system!=='maspay') throw new Error('Банк не підтвердив референс maspay');
                work.project.reference=String(header.reference);
                await runRef.update({[`stages.${stage}.project`]:work.project});
                changed=false;
            }
            const header=await api.header(secret,work.project.reference);
            if(header.system&&header.system!=='maspay'||header.group!==group||header.packetName!==work.project.packetName) fail('failed-precondition','Це інша відомість або інша підсистема банку');
            const rows=await api.content(secret,work.project.reference);
            const added={};
            for(const r of rows) {
                const matches=work.wages.filter(w=>w.tabn===String(r.tabNo)&&w.recipient.code===String(r.inn)&&w.amountKop===api.amountKop(r)&&w.purpose===r.comment);
                if(matches.length!==1||added[matches[0].key]) fail('failed-precondition','Відомість банку містить зайві, змінені або дубльовані виплати. Звірте її вручну');
                added[matches[0].key]=String(r.ref);
            }
            work.project.added=added;
            const remaining=work.wages.filter(w=>!added[w.key]);
            if(remaining.length&&!['N','W'].includes(header.status)) fail('failed-precondition','Відомість банку вже на підписі чи в обробці; склад змінювати не можна');
            for(const wage of remaining.slice(0,10)) {
                changed=true;
                const result=await api.add(secret,work.project.reference,wage.receiverId,wage.purpose,wage.amountKop);
                if(!result.ref) throw new Error('Банк не підтвердив додавання отримувача');
                work.project.added[wage.key]=String(result.ref);
                await runRef.update({[`stages.${stage}.project`]:work.project});
                changed=false;
            }
            const prepared=work.wages.every(w=>work.project.added[w.key]);
            if(prepared&&header.status==='N') { changed=true;await api.validate(secret,work.project.reference);changed=false; }
            work.project.status=prepared?'prepared':'building';
            work.project.bankStatus=header.status;
            work.project.revision=header.revision||null;
            // Чернетка є в банку: запис у платежах лише очікує фактичного списання з виписки.
            const batch=db.batch();
            const completed={...(work.old?.completed||{})}, paymentIds=[...(work.old?.payments||[])];
            for(const w of work.wages.filter(w=>work.project.added[w.key])) {
                const proposalKey=`payroll:${period}:${w.key}`, id=`project-${createHash('sha256').update(proposalKey).digest('hex').slice(0,32)}`;
                const ref=db.doc(`payments/${id}`), old=(await ref.get()).data();
                if(!old) batch.create(ref,{kind:'salary',recipient:w.recipient,account:work.account,amountKop:w.amountKop,purpose:w.purpose,proposalKey,
                    payroll:{period,stage,...identity.planRecipient(w)},status:'sent',source:'salaryProject',projectRef:work.project.reference,projectRowRef:work.project.added[w.key],
                    bankRef:null,sentAt:FieldValue.serverTimestamp(),createdAt:FieldValue.serverTimestamp(),createdBy:actor});
                completed[w.key]=id;if(!paymentIds.includes(id))paymentIds.push(id);
            }
            batch.update(runRef,{[`stages.${stage}.project`]:work.project,[`stages.${stage}.completed`]:completed,[`stages.${stage}.payments`]:paymentIds,sending:FieldValue.delete()});
            await batch.commit();
            await db.collection('audit_log').add({actor,role,action:'payroll.project.prepare',target:runRef.path,
                summary:'Чернетка зарплатного проекту підготовлена; підписання у Приват24',details:{stage,group,reference:work.project.reference,prepared},at:FieldValue.serverTimestamp()});
            return {ok:true,prepared,reference:work.project.reference,added:Object.keys(work.project.added).length,total:work.wages.length};
        } catch(e) {
            await runRef.update({[`stages.${stage}.project`]:{...work.project,status:changed&&e.bankRejected!==true?'unknown':'building',error:String(e.message).slice(0,300)},sending:FieldValue.delete()});
            throw e;
        }
    }
    return {context,linkReceiver,prepare,find,status};
};
