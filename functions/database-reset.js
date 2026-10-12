'use strict';
const {onCall,HttpsError}=require('firebase-functions/v2/https');
const {randomUUID,createHash}=require('node:crypto');const {gzipSync,gunzipSync}=require('node:zlib');
const guard=require('./call-guard');
const PHRASE='ВИДАЛИТИ ВСЮ БАЗУ';const WAIT_MS=600000;
function encode(v){if(typeof v==='number'&&!Number.isFinite(v))return{_type:'number',value:String(v)};if(v===null||typeof v!=='object')return v;if(Buffer.isBuffer(v))return{_type:'bytes',base64:v.toString('base64')};if(v instanceof Date)return{_type:'date',iso:v.toISOString()};if(typeof v.toDate==='function'&&typeof v.seconds==='number')return{_type:'timestamp',seconds:v.seconds,nanoseconds:v.nanoseconds};if(v.path&&typeof v.get==='function'&&typeof v.collection==='function')return{_type:'reference',path:v.path};if(typeof v.latitude==='number'&&typeof v.longitude==='number')return{_type:'geopoint',latitude:v.latitude,longitude:v.longitude};if(Array.isArray(v))return v.map(encode);const fields=Object.fromEntries(Object.entries(v).map(([k,x])=>[k,encode(x)]));return Object.hasOwn(v,'_type')?{_type:'map',fields}:fields;}
module.exports=function({db,FieldValue,requireAdmin,staffRole,bucket,auth,clock=()=>Date.now(),projectId}){
 const ref=db.doc('_maintenance/reset'),fail=message=>{throw new HttpsError('failed-precondition',message);};
 const parts=id=>ref.collection('parts').where('jobId','==',id),queue=id=>ref.collection('queue').where('jobId','==',id);
 const record=s=>({path:s.ref.path,data:encode(Object.fromEntries(Object.entries(s.data()).filter(([key])=>key!=='_resetBlocked'||s.ref.path.split('/').length!==2||!['apartments','staff'].includes(s.ref.parent.id)))),version:encode(s.updateTime)});
 const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
 const same=(a,b)=>JSON.stringify(canonical(a))===JSON.stringify(canonical(b));
 const protectedPath=(path,actor)=>path===`apartments/${actor}`||path===`staff/${actor}`;
 const check=async()=>{const secret=(await db.doc('bank_secrets/privat').get()).data();if(secret?.token)fail('Спочатку відключіть ПриватБанк: синхронізація не повинна повторно створити видалені проводки');const pending=await db.collection('payments').where('status','in',['sending','unknown','sent','canceling']).get();if(pending.docs.some(d=>d.data().source!=='demo'))fail('Спочатку звірте відправлені / невизначені платежі з банком. Видалення не скасовує платіж у Приват24');};
 function status(job){return{projectId,counts:job?.initialCounts||[],job:job?{id:job.id,phase:job.phase,active:job.active,actor:job.actor,readyAt:job.readyAt,documents:job.documents||0,files:job.files||0,error:job.error||''}:null,phrase:PHRASE};}
 async function context(){const job=(await ref.get()).data();const roots=await db.listCollections();const counts=[];for(const col of roots.filter(c=>c.id!=='_maintenance'))counts.push({collection:col.id,count:(await col.count().get()).data().count});return{projectId,counts,job:job?{id:job.id,phase:job.phase,active:job.active,actor:job.actor,readyAt:job.readyAt,documents:job.documents||0,files:job.files||0,error:job.error||''}:null,phrase:PHRASE};}
 function confirmation(data){if(data.phrase!==PHRASE||data.project!==projectId||data.understood!==true)fail('Підтвердіть повне видалення та вкажіть ідентифікатор проекту');}
 async function begin(actor,data,uid){if(!uid)fail('Потрібен службовий вхід');confirmation(data);await check();const rootNames=(await db.listCollections()).map(c=>c.id).filter(c=>c!=='_maintenance');const id=randomUUID(),initialCounts=(await context()).counts;
  // Test required permissions before pausing or deleting anything.
  const user=await auth.getUser(uid);if(user.disabled||user.email?.split('@')[0]!==actor)fail('Потрібен активний вхід саме цього голови');
  await auth.updateUser(uid,{displayName:user.displayName||null});
  const probe=bucket.file(`system-backups/${id}/readiness-probe`);
  try{await bucket.getFiles({autoPaginate:false,maxResults:1});await probe.save(Buffer.from('readiness'),{resumable:false});await probe.download();await probe.delete();}catch(error){try{await probe.delete({ignoreNotFound:true});}catch{}throw error;}

  await db.runTransaction(async t=>{const old=(await t.get(ref)).data();if(old?.active)fail('Очищення вже почато — продовжіть або скасуйте підготовку');t.set(ref,{id,actor,keeperUid:uid,authCutoff:Math.floor(clock()/1000),active:true,phase:'blocking',readyAt:clock()+WAIT_MS,documents:0,files:0,sequence:0,initialCounts,roots:rootNames,createdAt:FieldValue.serverTimestamp(),busyUntil:0});for(const path of rootNames)t.set(ref.collection('queue').doc(createHash('sha256').update(id+path).digest('hex')),{jobId:id,path,cursor:'',done:false});});return context();
 }
 async function savePart(job,kind,records){
  const groups=[];let group=[],size=0;for(const r of records){const n=Buffer.byteLength(JSON.stringify(r));if(group.length&&size+n>1800000){groups.push(group);group=[];size=0;}group.push(r);size+=n;}if(group.length||!records.length)groups.push(group);
  for(const rows of groups){const n=await db.runTransaction(async t=>{const j=(await t.get(ref)).data();const n=j.sequence||0;t.update(ref,{sequence:n+1});return n;});job.sequence=n+1;
   const path=`system-backups/${job.id}/${String(n).padStart(6,'0')}-${kind}.json.gz`,data=gzipSync(Buffer.from(JSON.stringify({format:'uspih-backup-v1',jobId:job.id,kind,records:rows}))),hash=createHash('sha256').update(data).digest('hex');
   if(data.length>5500000)fail('Частина копії завелика для безпечного завантаження');await bucket.file(path).save(data,{resumable:false,metadata:{contentType:'application/gzip'}});
   await ref.collection('parts').doc(`${job.id}-${n}`).set({jobId:job.id,index:n,path,kind,hash,size:data.length,...(['firestore','access'].includes(kind)?{paths:rows.map(r=>r.path)}:{})});
  }
 }
 async function step(actor,data){let job;const token=randomUUID();
  await db.runTransaction(async t=>{const snap=await t.get(ref);job=snap.data();if(!job||job.id!==data.id||job.actor!==actor)fail('Очищення не знайдено або його почав інший голова');if(!job.active)return;if(job.busyUntil>clock())throw new HttpsError('aborted','Операція вже виконується; зачекайте');t.update(ref,{busyUntil:clock()+600000,lease:token,error:''});});
  if(!job.active)return status(job);
  try{
   if(job.phase==='blocking'){for(const name of ['apartments','staff']){const docs=(await db.collection(name).get()).docs;for(let i=0;i<docs.length;i+=400){const b=db.batch();for(const d of docs.slice(i,i+400))b.update(d.ref,{_resetBlocked:true});await b.commit();}}job.readyAt=clock()+WAIT_MS;job.phase='wait';}
   else if(job.phase==='wait'){if(clock()>=job.readyAt){await check();const roots=(await db.listCollections()).filter(c=>c.id!=='_maintenance');job.roots=roots.map(c=>c.id);const b=db.batch();for(const col of roots)b.set(ref.collection('queue').doc(createHash('sha256').update(job.id+col.path).digest('hex')),{jobId:job.id,path:col.path,cursor:'',done:false});await b.commit();job.phase='backup';}}
   else if(job.phase==='backup'){
    const todo=await queue(job.id).where('done','==',false).limit(1).get();
    if(todo.empty)job.phase='filesBackup';else{
     const node=todo.docs[0],state=node.data(),col=db.collection(state.path);
     // listDocuments includes missing ancestors: orphaned owner/ledger documents
     // must be backed up before recursive deletion as well.
     const refs=(await col.listDocuments()).filter(r=>r.id>state.cursor).sort((a,b)=>a.id<b.id?-1:1).slice(0,100);
     const snapshots=refs.length?await db.getAll(...refs):[];const records=snapshots.filter(s=>s.exists).map(record);
     const children=[];for(let i=0;i<refs.length;i+=10)for(const list of await Promise.all(refs.slice(i,i+10).map(r=>r.listCollections())))children.push(...list);
     if(records.length)await savePart(job,'firestore',records);
     const batch=db.batch();for(const child of children)batch.set(ref.collection('queue').doc(createHash('sha256').update(job.id+child.path).digest('hex')),{jobId:job.id,path:child.path,cursor:'',done:false});batch.update(node.ref,{cursor:refs.at(-1)?.id||state.cursor,done:refs.length<100});await batch.commit();job.documents+=records.length;
    }
   }else if(job.phase==='filesBackup'){
    const [files,next]=await bucket.getFiles({autoPaginate:false,maxResults:50,...(job.fileToken?{pageToken:job.fileToken}:{})});const records=[];
    for(const file of files.filter(f=>!f.name.startsWith('system-backups/'))){const dest=`system-backups/${job.id}/files/${Buffer.from(file.name).toString('base64url')}`;const [meta]=await file.getMetadata();await bucket.file(file.name,{generation:meta.generation}).copy(bucket.file(dest),{metadata:{...(meta.metadata||{}),firebaseStorageDownloadTokens:null}});records.push({name:file.name,backup:dest,generation:meta.generation,metadata:meta});}
    if(records.length)await savePart(job,'storage',records);job.files+=records.length;job.fileToken=next?.pageToken||null;if(!job.fileToken)job.phase='authBackup';
   }else if(job.phase==='authBackup'){
    const result=await auth.listUsers(100,job.authToken||undefined);await savePart(job,'auth',result.users.map(u=>({uid:u.uid,email:u.email||null,disabled:u.disabled===true,displayName:u.displayName||null,customClaims:u.customClaims||null})));
    job.authToken=result.pageToken||null;if(!job.authToken){const all=await parts(job.id).get();job.documents=new Set(all.docs.flatMap(d=>d.data().paths||[])).size;const manifest={format:'uspih-backup-v1',projectId,jobId:job.id,actor,documents:job.documents,files:job.files,parts:all.docs.map(d=>d.data()).sort((a,b)=>a.index-b.index),authentication:'Existing Auth identities retained; other users disabled by reset. Secrets and files are stored in private backup.'};await bucket.file(`system-backups/${job.id}/manifest.json`).save(JSON.stringify(manifest),{resumable:false,metadata:{contentType:'application/json'}});job.phase='confirm';}
   }else if(job.phase==='deleteFirestore'){
    // Delete only records represented in the backup, with a last-update
    // precondition. Capture late changes before deleting their new version.
    const stored=(await parts(job.id).where('kind','==','firestore').get()).docs.map(d=>d.data()).sort((a,b)=>a.index-b.index);
    const position=job.deletePart||0;
    if(position<stored.length){
     const p=stored[position],[bytes]=await bucket.file(p.path).download();if(createHash('sha256').update(bytes).digest('hex')!==p.hash)fail('Резервна копія пошкоджена — видалення зупинено');
     const records=JSON.parse(gunzipSync(bytes)).records.filter(r=>!protectedPath(r.path,actor));
     const live=records.length?await db.getAll(...records.map(r=>db.doc(r.path))):[];
     const changed=live.filter((s,i)=>s.exists&&!same(record(s).data,records[i].data));if(changed.length)await savePart(job,'firestore',changed.map(record));
     const b=db.batch();for(const s of live.filter(s=>s.exists))b.delete(s.ref,{lastUpdateTime:s.updateTime});if(live.some(s=>s.exists))await b.commit();job.deletePart=position+1;
    }else{
     const remaining=[];const pending=(await db.listCollections()).filter(c=>c.id!=='_maintenance');
     while(pending.length&&remaining.length<100){const col=pending.shift(),refs=await col.listDocuments();for(let i=0;i<refs.length&&remaining.length<100;i+=100){const chunk=refs.slice(i,i+100);for(const s of await db.getAll(...chunk))if(s.exists&&!protectedPath(s.ref.path,actor)&&remaining.length<100)remaining.push(record(s));for(const cs of await Promise.all(chunk.map(r=>r.listCollections())))pending.push(...cs);}}
     if(remaining.length)await savePart(job,'firestore',remaining);else{
      const keep=[db.doc(`staff/${actor}`),db.doc(`apartments/${actor}`)],old=await db.getAll(...keep);await savePart(job,'access',old.filter(s=>s.exists).map(record));
      await db.runTransaction(async t=>{const fresh=await Promise.all(keep.map(r=>t.get(r)));if(fresh.some((s,i)=>s.exists!==old[i].exists||s.exists&&!s.updateTime.isEqual(old[i].updateTime)))fail('Службові записи змінилися — повторіть продовження');
       t.set(keep[0],{role:'chair',active:true,name:'Голова',resetId:job.id,_resetBlocked:true});t.set(keep[1],{isAdmin:true,passwordChanged:true,resetId:job.id,_resetBlocked:true,authAfter:job.authCutoff,authKeeperUid:job.keeperUid});});
      job.phase='deleteFiles';
     }
    }
   }else if(job.phase==='deleteFiles'){
    const [files,next]=await bucket.getFiles({autoPaginate:false,maxResults:100,...(job.deleteToken?{pageToken:job.deleteToken}:{})});const captured=[];for(const file of files.filter(f=>!f.name.startsWith('system-backups/'))){const [meta]=await file.getMetadata(),path=`system-backups/${job.id}/files/${Buffer.from(file.name).toString('base64url')}-${meta.generation}`;await bucket.file(file.name,{generation:meta.generation}).copy(bucket.file(path),{metadata:{...(meta.metadata||{}),firebaseStorageDownloadTokens:null}});captured.push({name:file.name,backup:path,generation:meta.generation,metadata:meta});}if(captured.length)await savePart(job,'storage',captured);for(const original of captured)await bucket.file(original.name,{generation:original.generation}).delete({ignoreNotFound:true});job.deleteToken=next?.pageToken||null;if(!job.deleteToken){let page,more;let leftovers=false;do{[page,more]=await bucket.getFiles({autoPaginate:false,maxResults:100,...(more?.pageToken?{pageToken:more.pageToken}:{})});if(page.some(f=>!f.name.startsWith('system-backups/'))){leftovers=true;break;}}while(more?.pageToken);if(!leftovers)job.phase='disableUsers';}
   }else if(job.phase==='disableUsers'){
    const result=await auth.listUsers(100,job.disableToken||undefined);for(const u of result.users)if(u.uid!==job.keeperUid){await auth.updateUser(u.uid,{disabled:true});await auth.revokeRefreshTokens(u.uid);}job.disableToken=result.pageToken||null;if(!job.disableToken){job.authCutoff=Math.floor(clock()/1000);job.phase='done';job.active=false;await db.doc(`staff/${actor}`).update({_resetBlocked:false});await db.doc(`apartments/${actor}`).update({_resetBlocked:false,authAfter:job.authCutoff});const saved=await parts(job.id).get();job.documents=new Set(saved.docs.flatMap(d=>d.data().paths||[])).size;job.completedAt=FieldValue.serverTimestamp();}
   }
   const patch={...job,busyUntil:0,lease:FieldValue.delete()};await ref.update(patch);return status(job);
  }catch(e){await ref.update({busyUntil:0,lease:FieldValue.delete(),error:String(e.message).slice(0,300)});throw e;}
 }
 async function confirm(actor,data){confirmation(data);await check();await db.runTransaction(async t=>{const j=(await t.get(ref)).data();if(!j||j.id!==data.id||j.actor!==actor||j.phase!=='confirm'||j.busyUntil>clock())fail('Спочатку дочекайтесь завершення резервного копіювання');if(data.backupAcknowledged!==true)fail('Підтвердіть наявність резервної копії');t.update(ref,{phase:'deleteFirestore',confirmedAt:FieldValue.serverTimestamp(),confirmedBy:actor});});return context();}
 async function cancel(actor,data){await db.runTransaction(async t=>{const j=(await t.get(ref)).data();if(j?.actor!==actor||j?.id!==data.id||!['blocking','wait','backup','filesBackup','authBackup','confirm'].includes(j.phase)||j.busyUntil>clock())fail('Скасувати можна лише підготовку до видалення');t.update(ref,{active:false,phase:'canceled',authCutoff:FieldValue.delete()});});for(const name of ['apartments','staff']){const docs=(await db.collection(name).get()).docs;for(let i=0;i<docs.length;i+=400){const b=db.batch();for(const d of docs.slice(i,i+400))b.update(d.ref,{_resetBlocked:FieldValue.delete()});await b.commit();}}return context();}
 async function archive(actor,data){const j=(await ref.get()).data();if(j?.actor!==actor||j?.id!==data.id||!['confirm','deleteFirestore','deleteFiles','disableUsers','done'].includes(j.phase))fail('Копія ще не готова');const rows=(await parts(j.id).get()).docs.map(d=>d.data()).sort((a,b)=>a.index-b.index);if(data.part===undefined)return{jobId:j.id,projectId,parts:rows.map(({paths,...p})=>p),filesStoredPrivately:j.files};const p=rows.find(p=>p.index===data.part);if(!p)fail('Частину копії не знайдено');const [bytes]=await bucket.file(p.path).download();if(createHash('sha256').update(bytes).digest('hex')!==p.hash)fail('Контрольна сума резервної копії не збігається');return{name:p.path.split('/').at(-1),base64:bytes.toString('base64'),hash:p.hash};}
 const databaseReset=onCall({region:'europe-central2',maxInstances:1,timeoutSeconds:540,memory:'512MiB'},guard('databaseReset',async request=>{if(!request.auth?.uid||!request.auth.token?.email?.endsWith('@uspih-25.com'))throw new HttpsError('permission-denied','Потрібен службовий вхід у цей застосунок');const actor=await requireAdmin(request,['chair'],{allowDuringReset:true});if(await staffRole(actor)!=='chair')throw new HttpsError('permission-denied','Очищення — лише для голови');const d=request.data||{};switch(d.action){case'context':return context();case'begin':return begin(actor,d,request.auth.uid);case'step':return step(actor,d);case'confirm':return confirm(actor,d);case'cancel':return cancel(actor,d);case'archive':return archive(actor,d);default:throw new HttpsError('invalid-argument','Невідома дія');}}));
 return{databaseReset,actions:{context,begin,step,confirm,cancel,archive},encode};
};
module.exports.encode=encode;
