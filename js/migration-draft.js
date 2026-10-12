// Accounting files stay in this browser, partitioned by authenticated UID.
const DB='uspih-migration-drafts',STORE='drafts',VERSION=1,TTL=7*86400000;
function database(){return new Promise((resolve,reject)=>{const request=indexedDB.open(DB,1);request.onupgradeneeded=()=>request.result.createObjectStore(STORE);request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(new Error('Браузер не дозволив зберегти чернетку'));});}
async function operation(uid,mode,fn){if(!uid)throw new Error('Сесія втрачена');const db=await database();try{return await new Promise((resolve,reject)=>{const tx=db.transaction(STORE,mode),request=fn(tx.objectStore(STORE));let value;request.onsuccess=()=>{value=request.result;};tx.oncomplete=()=>resolve(value);tx.onerror=()=>reject(new Error('Не вдалося зберегти чернетку: перевірте вільне місце'));tx.onabort=()=>reject(new Error('Збереження чернетки перервано'));});}finally{db.close();}}
export async function loadDraft(uid){const draft=await operation(uid,'readonly',s=>s.get(uid));if(!draft)return null;if(draft.version!==VERSION||draft.updatedAt<Date.now()-TTL){await clearDraft(uid);return null;}return draft;}
export function saveDraft(uid,draft){return operation(uid,'readwrite',s=>s.put({...draft,version:VERSION,updatedAt:Date.now()},uid));}
export function clearDraft(uid){return operation(uid,'readwrite',s=>s.delete(uid));}
