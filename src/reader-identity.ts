const uuid7=/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function issueReader(fetchImpl: typeof fetch) {
 const response=await fetchImpl('/api/v1/user/anonymous',{method:'POST',credentials:'same-origin',cache:'no-store'});
 if(!response.ok)throw new Error(`BACKEND_HTTP_${response.status}`);
 const result=await response.json();
 if(typeof result?.reader_id!=='string'||!uuid7.test(result.reader_id))throw new Error('INVALID_BACKEND_READER_ID');
 return result.reader_id as string;
}

let reader: Promise<string> | undefined;
export function getBackendReaderId({fetchImpl=fetch}={}) {
 const locks=globalThis.navigator?.locks;
 const issue=()=>issueReader(fetchImpl);
 return reader??=Promise.resolve(locks?locks.request('sai-news-backend-reader',issue):issue())
  .catch(error=>{reader=undefined;throw error;});
}
