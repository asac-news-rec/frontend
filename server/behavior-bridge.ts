import {createHmac,timingSafeEqual} from 'node:crypto';
import type {IncomingMessage,ServerResponse} from 'node:http';

export interface LoggingConfig {url:string;token:string}
interface Session {readerId:string;expires:number}
export function createBehaviorBridge(origin:string,backendUrl:string|undefined,config?:LoggingConfig){
 if(config&&config.token.length<24)throw new Error('LOGGING_TOKEN_MIN_24_CHARS');
 const sign=(payload:string)=>createHmac('sha256',config!.token).update(payload).digest('base64url');
 const current=(req:IncomingMessage)=>{
  if(!config)return;
  const cookie=/\bnews_behavior=([^;]+)/.exec(req.headers.cookie??'')?.[1];
  if(!cookie||cookie.length>1024)return;
  const [payload,signature,...extra]=cookie.split('.');if(!payload||!signature||extra.length)return;
  const expected=sign(payload);if(Buffer.byteLength(signature)!==Buffer.byteLength(expected)||!timingSafeEqual(Buffer.from(signature),Buffer.from(expected)))return;
  try{const session=JSON.parse(Buffer.from(payload,'base64url').toString('utf8')) as Session;
   if(typeof session.readerId==='string'&&session.readerId.length<=128&&typeof session.expires==='number'&&session.expires>Date.now())return session;
  }catch{}
 };
 const send=async(route:string,body:unknown,readerId?:string,signal=AbortSignal.timeout(8000))=>{
  const response=await fetch(new URL(route,config!.url),{method:'POST',signal,headers:{'Content-Type':'application/json',Authorization:`Bearer ${config!.token}`,...(readerId?{'x-news-reader':readerId,'x-collection-enabled':'true','x-news-source':'browser'}:{})},body:JSON.stringify(body)});
  if(!response.ok)throw new Error('LOGGING_UNAVAILABLE');
  return response.json();
 };
 return {
  async onFeed(req:IncomingMessage,input:unknown,payload:unknown){
   if(!config)return;
   const session=current(req),body=input as {reader_id?:string};
   if(!session||body.reader_id!==session.readerId)return false;
   const feed=payload as {request_id:string;served_at:string;reader_id?:string;items:{article_id:string;impression_id:string;position:number}[]};
   if(feed.reader_id!==undefined&&feed.reader_id!==session.readerId)return false;
   const records=feed.items.map(item=>({request_id:feed.request_id,served_at:feed.served_at,reader_id:session.readerId,article_id:item.article_id,impression_id:item.impression_id,position:item.position}));
   const deadline=AbortSignal.timeout(1500);
   for(let start=0;start<records.length;start+=100){
    const part=records.slice(start,start+100),ack=await send('/internal/served',{records:part},undefined,deadline);
    if(!Array.isArray(ack.results)||ack.results.length!==part.length||ack.results.some((r:{status:string;impression_id:string},i:number)=>!['accepted','duplicate'].includes(r.status)||r.impression_id!==part[i].impression_id))throw new Error('SERVED_NOT_COMMITTED');
   }
   return true;
  },
  async handle(req:IncomingMessage,res:ServerResponse,pathname:string){
   if(!pathname.startsWith('/api/behavior/'))return false;
   const reply=(code:number,body:unknown)=>{res.writeHead(code,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(body));return true;};
   if(pathname==='/api/behavior/status'&&req.method==='GET')return reply(200,{enabled:Boolean(config)});
   if(!config)return reply(404,{error:'LOGGING_DISABLED'});
   if(req.method!=='POST')return reply(405,{error:'METHOD_NOT_ALLOWED'});
   if(req.headers.origin!==origin)return reply(403,{error:'ORIGIN_REJECTED'});
   if(pathname==='/api/behavior/session'){
    const old=current(req);if(old)return reply(200,{reader_id:old.readerId});
    if(!backendUrl)return reply(503,{error:'BACKEND_NOT_CONFIGURED'});
    try{
     const response=await fetch(new URL('api/user/anonymous',backendUrl.endsWith('/')?backendUrl:backendUrl+'/'),{method:'POST',signal:AbortSignal.timeout(8000)});
     const body=await response.json();
     if(!response.ok||typeof body.reader_id!=='string'||!body.reader_id||body.reader_id.length>128)throw new Error('INVALID_READER');
     const payload=Buffer.from(JSON.stringify({readerId:body.reader_id,expires:Date.now()+30*86400000})).toString('base64url');
     res.setHeader('Set-Cookie',`news_behavior=${payload}.${sign(payload)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000${new URL(origin).protocol==='https:'?'; Secure':''}`);
     return reply(200,{reader_id:body.reader_id});
    }catch{return reply(503,{error:'SESSION_UNAVAILABLE'});}
   }
   if(pathname!=='/api/behavior/events')return reply(404,{error:'NOT_FOUND'});
   const session=current(req);if(!session)return reply(403,{error:'SESSION_REQUIRED'});
   if(req.headers['content-type']?.split(';')[0]!=='application/json')return reply(415,{error:'JSON_REQUIRED'});
   const chunks:Buffer[]=[];let size=0;
   for await(const chunk of req){size+=chunk.length;if(size>262144)return reply(413,{error:'BODY_TOO_LARGE'});chunks.push(chunk);}
   let body;try{body=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{return reply(400,{error:'INVALID_JSON'});}
   try{return reply(200,await send('/events',body,session.readerId));}catch{return reply(503,{error:'LOGGING_UNAVAILABLE'});}
  }
 };
}
