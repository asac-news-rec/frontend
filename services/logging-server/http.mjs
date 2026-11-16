import http from 'node:http';
import {timingSafeEqual} from 'node:crypto';
import {InputError} from './schema.mjs';
export function createLoggingHttp({store,exporter,token,maxRecords=100000}){
 if(typeof token!=='string'||token.length<24)throw new Error('LOGGING_TOKEN_MIN_24_CHARS');
 const auth=value=>typeof value==='string'&&Buffer.byteLength(value)===Buffer.byteLength(`Bearer ${token}`)&&timingSafeEqual(Buffer.from(value),Buffer.from(`Bearer ${token}`));
 const response=(res,code,data)=>{res.writeHead(code,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(data));};
 return http.createServer(async(req,res)=>{
  try{
   const route=new URL(req.url,'http://logging').pathname;
   if(req.method==='GET'&&route==='/health')return response(res,200,{status:'alive'});
   if(!auth(req.headers.authorization))return response(res,401,{error:'UNAUTHORIZED'});
   if(req.method==='GET'&&route==='/ready')return response(res,200,{...store.readiness(),exporter:exporter.state()});
   if(req.method!=='POST')return response(res,405,{error:'METHOD_NOT_ALLOWED'});
   if(!['/events','/internal/served','/internal/flush','/internal/delete-user'].includes(route))return response(res,404,{error:'NOT_FOUND'});
   if(req.headers['content-type']?.split(';')[0]!=='application/json')return response(res,415,{error:'JSON_REQUIRED'});
   const chunks=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>262144)return response(res,413,{error:'BODY_TOO_LARGE'});chunks.push(chunk);}
   let input;try{input=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{return response(res,400,{error:'INVALID_JSON'});}
   if(route==='/internal/flush')return response(res,200,{completed:exporter.flush({force:true})});
   if(route==='/internal/delete-user'){if(!input||Object.keys(input).join()!=='reader_id')throw new InputError('INVALID_DELETE');exporter.deleteReader(input.reader_id);return response(res,200,{deleted:true});}
   const counts=store.counts();const candidates=route==='/internal/served'?input?.records:input?.events;const hasNew=!Array.isArray(candidates)||candidates.some(row=>route==='/internal/served'?!store.getServed(row?.impression_id??''):!store.getAction(row?.event_id??''));if(hasNew&&counts.served+counts.actions>=maxRecords){res.setHeader('Retry-After','30');return response(res,503,{error:'INBOX_CAPACITY'});}
   const result=route==='/internal/served'?store.intakeServed({internal:true},input):store.intakeActions({readerId:req.headers['x-news-reader'],collectionEnabled:req.headers['x-collection-enabled']==='true',source:req.headers['x-news-source']??'browser'},input);
   response(res,200,result);if(store.readiness().pendingRecords>=1000)setImmediate(()=>{try{exporter.flush();}catch{}});return;
  }catch(error){if(error instanceof InputError)return response(res,['COLLECTION_DISABLED','USER_REVOKED'].includes(error.code)?403:400,{error:error.code});response(res,503,{error:'STORAGE_UNAVAILABLE'});}
 });
}
