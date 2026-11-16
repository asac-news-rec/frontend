// News identity is independent of logging settings and collection cookies.
const storageKey='sai-news.backend-reader-id';
const legacyStorageKey='sai-news.backend-user-id';
const uuid7=/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function getBackendReaderId({storage=globalThis.window?.localStorage,fetchImpl=fetch,locks=globalThis.window?.navigator?.locks}={}){
 const readOrCreate=async()=>{
  if(!storage)throw new Error('BACKEND_ID_STORAGE_UNAVAILABLE');
  const existing=storage.getItem(storageKey);
  if(existing!==null){if(!uuid7.test(existing))throw new Error('INVALID_BACKEND_READER_ID');return existing;}
  const legacy=storage.getItem(legacyStorageKey);
  if(legacy!==null){
   if(!uuid7.test(legacy))throw new Error('INVALID_BACKEND_READER_ID');
   storage.setItem(storageKey,legacy);
   if(storage.getItem(storageKey)!==legacy)throw new Error('BACKEND_ID_STORAGE_UNAVAILABLE');
   return legacy;
  }
  const response=await fetchImpl('/api/user/anonymous',{method:'POST',credentials:'same-origin',cache:'no-store'});
  if(!response.ok)throw new Error(`BACKEND_HTTP_${response.status}`);
  const result=await response.json();
  if(!(typeof result?.reader_id==='string'&&uuid7.test(result.reader_id)))throw new Error('INVALID_BACKEND_READER_ID');
  storage.setItem(storageKey,result.reader_id);
  if(storage.getItem(storageKey)!==result.reader_id)throw new Error('BACKEND_ID_STORAGE_UNAVAILABLE');
  return result.reader_id;
 };
 return locks?locks.request('sai-news-backend-reader',readOrCreate):readOrCreate();
}
