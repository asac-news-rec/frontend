const uuid7=/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function issueReader(fetchImpl: typeof fetch) {
 const response=await fetchImpl('/api/v1/user/anonymous',{method:'POST',credentials:'same-origin',cache:'no-store'});
 if(!response.ok)throw new Error(`BACKEND_HTTP_${response.status}`);
 const result=await response.json();
 if(typeof result?.reader_id!=='string'||!uuid7.test(result.reader_id))throw new Error('INVALID_BACKEND_READER_ID');
 return result.reader_id as string;
}

let reader: Promise<string> | undefined;
let recovery: Promise<string> | undefined;
let epoch=0,awaitingConfirmation=false;
export const backendReaderEpoch=()=>epoch;
export function confirmBackendReader(expectedEpoch:number){if(expectedEpoch===epoch)awaitingConfirmation=false;}
function announce(name:string){globalThis.window?.dispatchEvent(new Event(name));}
function issueWithLock(fetchImpl:typeof fetch){
 const locks=globalThis.navigator?.locks;
 const issue=()=>issueReader(fetchImpl);
 return Promise.resolve(locks?locks.request('sai-news-backend-reader',issue):issue());
}
export function getBackendReaderId({fetchImpl=fetch}={}) {
 return reader??=issueWithLock(fetchImpl)
  .catch(error=>{reader=undefined;throw error;});
}

// Every protected request captures the epoch at send time. Late 401s join the
// same recovery, and successful responses from the previous identity are stale.
export function recoverBackendReader(expectedEpoch:number,{fetchImpl=fetch,force=false}={}) {
 if(expectedEpoch!==epoch)return reader??Promise.reject(new Error('BACKEND_SESSION_CHANGED'));
 if(recovery)return recovery;
 if(awaitingConfirmation&&!force)return Promise.reject(new Error('BACKEND_HTTP_401'));
 awaitingConfirmation=true;epoch++;
 recovery=Promise.resolve().then(()=>issueWithLock(fetchImpl)).then(id=>{
  announce('backend-reader-recovered');return id;
 }).catch(error=>{
  reader=undefined;announce('backend-reader-recovery-failed');throw error;
 }).finally(()=>{recovery=undefined;});
 reader=recovery;
 announce('backend-reader-recovering');
 return recovery;
}
