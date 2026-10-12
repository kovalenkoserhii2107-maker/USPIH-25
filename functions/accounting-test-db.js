'use strict';
// Server-only adapter. Root collections belong to one Auth UID; collection
// groups have distinct names, so production ledger/owners queries cannot see them.
module.exports=function scopedDatabase(database,uid){
 if(!/^[A-Za-z0-9_-]{1,128}$/.test(uid))throw new Error('Непідтримуваний ідентифікатор входу');
 const prefix=`sandbox~${uid}~`,child='sandbox_',marker='_sandboxUid';
 const refs=new WeakMap(),cache=new WeakMap();
 const physical=path=>{const parts=String(path).split('/');if(parts.some(p=>!p||p==='.'||p==='..')||parts.some((p,i)=>i%2===0&&p.startsWith('sandbox')))throw new Error('Некоректний тестовий шлях');return parts.map((p,i)=>i%2===0?(i===0?prefix:child)+p:p).join('/');};
 const logical=path=>String(path).split('/').map((p,i)=>i%2===0?p.slice((i===0?prefix:child).length):p).join('/');
 const unwrap=ref=>{const raw=refs.get(ref);if(!raw)throw new Error('Посилання поза тестовою базою');return raw;};
 const stamp=data=>({...data,[marker]:uid});
 function snapshot(s){if(s.docs){const docs=s.docs.map(snapshot);return {docs,empty:s.empty,size:s.size,readTime:s.readTime,forEach:fn=>docs.forEach(fn)};}if(!s.ref)return {data:()=>s.data(),readTime:s.readTime};return {id:s.id,exists:s.exists,ref:wrap(s.ref),createTime:s.createTime,updateTime:s.updateTime,readTime:s.readTime,data:()=>{const d=s.data();if(!d)return d;const copy={...d};delete copy[marker];return copy;},get:field=>s.get(field)};}
 function wrap(raw){if(raw===null)return null;if(raw.path&&!raw.path.split('/')[0].startsWith(prefix))throw new Error('Дані поза тестовою базою');if(cache.has(raw))return cache.get(raw);
  const proxy=new Proxy(raw,{get(target,key){
   if(key==='path')return logical(target.path);if(key==='id')return target.path?logical(target.path).split('/').at(-1):target.id;
   if(key==='parent')return target.parent?wrap(target.parent):null;if(key==='firestore')return db;
   if(key==='get')return async(...args)=>snapshot(await target.get(...args));
   if(key==='doc')return id=>{if(id!==undefined&&(!String(id)||String(id).includes('/')||['.','..'].includes(String(id))))throw new Error('Некоректний тестовий ID');return wrap(id===undefined?target.doc():target.doc(String(id)));};
   if(key==='collection')return name=>{if(!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(name))throw new Error('Некоректна тестова колекція');return wrap(target.collection(child+name));};
   if(key==='add')return async data=>wrap(await target.add(stamp(data)));
   if(key==='set'||key==='update'||key==='create')return (data,...args)=>target[key](stamp(data),...args);
   if(key==='delete')return (...args)=>target.delete(...args);
   if(key==='listCollections'||key==='listDocuments')return async(...args)=>(await target[key](...args)).map(wrap);
   if(key==='isEqual')return other=>target.isEqual(unwrap(other));
   if(['where','orderBy','limit','limitToLast','offset','select','count','sum','average','aggregate'].includes(key))return (...args)=>wrap(target[key](...args));
   if(['startAt','startAfter','endAt','endBefore'].includes(key))return (...args)=>wrap(target[key](...args.map(v=>refs.has(v)?unwrap(v):v)));
   // No raw Firestore handle or undocumented method can escape the adapter.
   if(key==='then'||typeof key==='symbol')return undefined;
   throw new Error('Непідтримувана тестова властивість '+String(key));
  }});refs.set(proxy,raw);cache.set(raw,proxy);return proxy;
 }
 function writes(raw,transaction=false){const out={};
  for(const name of ['set','update','create'])out[name]=(ref,data,...args)=>{raw[name](unwrap(ref),stamp(data),...args);return out;};out.delete=(ref,...args)=>{raw.delete(unwrap(ref),...args);return out;};
  if(transaction){out.get=async ref=>snapshot(await raw.get(unwrap(ref)));out.getAll=async(...list)=>(await raw.getAll(...list.map(unwrap))).map(snapshot);}
  else out.commit=()=>raw.commit();return out;
 }
 const db={
  doc:path=>wrap(database.doc(physical(path))),collection:path=>wrap(database.collection(physical(path))),
  collectionGroup:name=>wrap(database.collectionGroup(child+name).where(marker,'==',uid)),
  batch:()=>writes(database.batch()),runTransaction:(fn,options)=>database.runTransaction(t=>fn(writes(t,true)),options),
  getAll:async(...list)=>(await database.getAll(...list.map(unwrap))).map(snapshot),
  listCollections:async()=>(await database.listCollections()).filter(c=>c.id.startsWith(prefix)).map(wrap),
  recursiveDelete:ref=>database.recursiveDelete(unwrap(ref))
 };
 return db;
};
