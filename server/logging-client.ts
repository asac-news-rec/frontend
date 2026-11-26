import {CollectionError} from './collection-error.js';
export interface LoggingConfig {url:string;token:string;audience?:string}

// Server-only client. Cloud Run IAM and application Bearer authentication use
// separate headers; neither token is accepted from or returned to a browser.
export function createLoggingSender(config:LoggingConfig,{fetchImpl=fetch,now=Date.now}={}){
 const target=new URL(config.url);
 if(!['http:','https:'].includes(target.protocol)||target.username||target.password)throw new Error('INVALID_LOGGING_URL');
 if(config.token.length<24)throw new Error('LOGGING_TOKEN_MIN_24_CHARS');
 const audience=config.audience;
 if(audience){
  const url=new URL(audience);
  if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash||target.protocol!=='https:')throw new Error('INVALID_LOGGING_AUDIENCE');
 }
 let cached:{token:string;expires:number}|undefined,pending:Promise<string>|undefined;
 const identity=()=>{
  if(cached&&cached.expires>now()+60000)return Promise.resolve(cached.token);
  if(pending)return pending;
  pending=Promise.resolve().then(async()=>{
   try{
    const url=new URL('http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity');
    url.searchParams.set('audience',audience!);
    const response=await fetchImpl(url,{headers:{'Metadata-Flavor':'Google'},redirect:'error',signal:AbortSignal.timeout(1000)});
    if(!response.ok||response.headers.get('Metadata-Flavor')!=='Google')throw new Error();
    const token=await response.text();
    if(token.length>16384||!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token))throw new Error();
    // The token comes only from the trusted metadata endpoint. Decode claims to
    // bound caching; the receiving Cloud Run service verifies the signature.
    const claims=JSON.parse(Buffer.from(token.split('.')[1],'base64url').toString());
    if(claims.aud!==audience||!Number.isFinite(claims.exp)||claims.exp*1000<=now()+5000)throw new Error();
    cached={token,expires:claims.exp*1000};return token;
   }catch{throw new CollectionError('LOGGING_IDENTITY_UNAVAILABLE');}
  }).finally(()=>{pending=undefined;});
  return pending;
 };
 return async(route:string,body:unknown,readerId?:string,signal=AbortSignal.timeout(8000))=>{
  const idToken=audience?await identity():undefined;
  signal.throwIfAborted();
  const destination=new URL(route,target);
  if(destination.origin!==target.origin)throw new Error('INVALID_LOGGING_ROUTE');
  const response=await fetchImpl(destination,{method:'POST',redirect:'error',signal,
   headers:{'Content-Type':'application/json',Authorization:`Bearer ${config.token}`,
    ...(idToken?{'X-Serverless-Authorization':`Bearer ${idToken}`} : {}),
    ...(readerId?{'x-news-reader':readerId,'x-collection-enabled':'true','x-news-source':'browser'}:{})},body:JSON.stringify(body)});
  if(!response.ok){if(response.status===401||response.status===403)cached=undefined;throw new CollectionError('LOGGING_UNAVAILABLE');}
  return response.json();
 };
}
