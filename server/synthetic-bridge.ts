import {randomUUID,timingSafeEqual} from 'node:crypto';
import type {IncomingMessage,ServerResponse} from 'node:http';

export interface SyntheticConfig {agentToken:string;loggingToken:string;loggingUrl:string}
interface Session {expires:number;readerId?:string}
// Local opt-in bridge. Secrets stay on the Node server, never in browser scripts.
export function createSyntheticBridge(origin:string,config?:SyntheticConfig){
 if(config&&(config.agentToken.length<24||config.loggingToken.length<24))throw new Error('SYNTHETIC_TOKENS_MIN_24_CHARS');
 const sessions=new Map<string,Session>();
 const session=(req:IncomingMessage)=>{
  const key=/\bsai_synthetic=([^;]+)/.exec(req.headers.cookie??'')?.[1];
  const value=key?sessions.get(key):undefined;
  if(value&&value.expires>Date.now())return value;
  if(key)sessions.delete(key);
 };
 const send=async(route:string,payload:unknown,readerId?:string)=>{
  const response=await fetch(new URL(route,config!.loggingUrl),{method:'POST',signal:AbortSignal.timeout(8000),headers:{'Content-Type':'application/json',Authorization:`Bearer ${config!.loggingToken}`,...(readerId?{'x-news-reader':readerId,'x-collection-enabled':'true','x-news-source':'simulator'}:{})},body:JSON.stringify(payload)});
  if(!response.ok)throw new Error('LOGGING_UNAVAILABLE');
  const ack=await response.json();
  if(!Array.isArray(ack.results)||ack.results.some((r:{status:string})=>!['accepted','duplicate'].includes(r.status)))throw new Error('LOGGING_REJECTED');
  return ack;
 };
 return {
  async onFeed(req:IncomingMessage,input:unknown,payload:unknown){
   const current=session(req);if(!config||!current)return;
   const body=input as {reader_id:string};
   const feed=payload as {reader_id?:string;request_id:string;served_at:string;items:{article_id:string;impression_id:string;position:number}[]};
   if(typeof body.reader_id!=='string'||(current.readerId&&current.readerId!==body.reader_id)||(feed.reader_id!==undefined&&feed.reader_id!==body.reader_id))throw new Error('SYNTHETIC_READER_MISMATCH');
   current.readerId=body.reader_id;
   const records=feed.items.map(item=>({request_id:feed.request_id,served_at:feed.served_at,reader_id:body.reader_id,article_id:item.article_id,impression_id:item.impression_id,position:item.position}));
   // Served is committed before the browser sees the list, including paginated lists.
   for(let start=0;start<records.length;start+=100)await send('/internal/served',{records:records.slice(start,start+100)});
  },
  async handle(req:IncomingMessage,res:ServerResponse,pathname:string){
   if(!pathname.startsWith('/api/synthetic/'))return false;
   const reply=(status:number,body:unknown)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(body));return true;};
   if(!config)return reply(404,{error:'SYNTHETIC_DISABLED'});
   if(pathname==='/api/synthetic/session'&&req.method==='POST'){
    const token=req.headers['x-synthetic-agent'];
    if(typeof token!=='string'||Buffer.byteLength(token)!==Buffer.byteLength(config.agentToken)||!timingSafeEqual(Buffer.from(token),Buffer.from(config.agentToken)))return reply(401,{error:'UNAUTHORIZED'});
    for(const [key,value] of sessions)if(value.expires<=Date.now())sessions.delete(key);
    if(sessions.size>=1000)return reply(503,{error:'SESSION_CAPACITY'});
    const key=randomUUID();sessions.set(key,{expires:Date.now()+3600000});
    res.setHeader('Set-Cookie',`sai_synthetic=${key}; HttpOnly; SameSite=Strict; Path=/; Max-Age=3600`);
    return reply(200,{enabled:true});
   }
   const current=session(req);
   if(pathname==='/api/synthetic/status'&&req.method==='GET')return reply(200,{enabled:Boolean(current)});
   if(pathname!=='/api/synthetic/events')return reply(404,{error:'NOT_FOUND'});
   if(req.method!=='POST')return reply(405,{error:'METHOD_NOT_ALLOWED'});
   if(req.headers.origin!==origin||!current?.readerId)return reply(403,{error:'SESSION_REQUIRED'});
   if(req.headers['content-type']?.split(';')[0]!=='application/json')return reply(415,{error:'JSON_REQUIRED'});
   const chunks:Buffer[]=[];let size=0;
   for await(const chunk of req){size+=chunk.length;if(size>262144)return reply(413,{error:'BODY_TOO_LARGE'});chunks.push(chunk);}
   let body;try{body=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{return reply(400,{error:'INVALID_JSON'});}
   try{return reply(200,await send('/events',body,current.readerId));}catch{return reply(503,{error:'LOGGING_UNAVAILABLE'});}
  }
 };
}
