import type {IncomingMessage,ServerResponse} from 'node:http';

export interface FeedRejection {status:number;error:string}

export function newsReaderCookie(header: string | undefined) {
 return header?.split(';').map(value=>value.trim()).find(value=>value.startsWith('news_reader='));
}

export function createBackendProxy({baseUrl,origin,fetchImpl=fetch,onFeed,onReaderIssued}:{baseUrl?:string;origin:string;fetchImpl?:typeof fetch;onFeed?:(req:IncomingMessage,payload:unknown)=>Promise<boolean|void|FeedRejection>;onReaderIssued?:(req:IncomingMessage,res:ServerResponse,payload:unknown,cookie:string|undefined)=>void}) {
 const target=baseUrl?new URL(baseUrl.endsWith('/')?baseUrl:`${baseUrl}/`):null;
 return async (req:IncomingMessage,res:ServerResponse,pathname:string):Promise<boolean>=>{
  if(!['/api/user/anonymous','/api/category','/api/subcategory','/api/news/feed'].includes(pathname)&&!pathname.startsWith('/api/news/'))return false;
  const reply=(status:number,value:unknown)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'private, no-store'});res.end(JSON.stringify(value));return true;};
  if(!target)return reply(503,{error:'BACKEND_NOT_CONFIGURED'});
  let route:string,method:string|undefined;
  if(pathname==='/api/user/anonymous'){route='/user/anonymous';method='POST';}
  else if(pathname==='/api/category'){route='/category';method='POST';}
  else if(pathname==='/api/subcategory'){route='/subcategory';method='POST';}
  else if(pathname==='/api/news/feed'){route='/news/feed';method='POST';}
  else {
   const match=/^\/api\/news\/([^/]+)\/like$/.exec(pathname);
   if(!match)return reply(404,{error:'NOT_FOUND'});
   let articleId;try{articleId=decodeURIComponent(match[1]);}catch{return reply(400,{error:'INVALID_ARTICLE_ID'});}
   if(!articleId||articleId.includes('/')||articleId.length>128)return reply(400,{error:'INVALID_ARTICLE_ID'});
   route=`/news/${encodeURIComponent(articleId)}/like`;method=req.method ?? '';
   if(!['PUT','DELETE'].includes(method))return reply(405,{error:'METHOD_NOT_ALLOWED'});
  }
  if(req.method!==method)return reply(405,{error:'METHOD_NOT_ALLOWED'});
  if(req.headers.origin!==origin)return reply(403,{error:'ORIGIN_REJECTED'});
  const acceptsJson=route==='/news/feed'||route==='/subcategory';
  if(acceptsJson&&req.headers['content-type']?.split(';')[0]!=='application/json')return reply(415,{error:'JSON_REQUIRED'});
  let size=0;const chunks=[];
  for await(const chunk of req){size+=chunk.length;if(size>262144)return reply(413,{error:'BODY_TOO_LARGE'});chunks.push(chunk);}
  if(!acceptsJson&&size)return reply(400,{error:'BODY_NOT_ALLOWED'});
  const body=Buffer.concat(chunks);
  try{
   const headers=new Headers();
   if(acceptsJson)headers.set('Content-Type','application/json');
   const readerCookie=newsReaderCookie(req.headers.cookie);
   if(readerCookie)headers.set('Cookie',readerCookie);
   const upstream=await fetchImpl(new URL('api'+route,target),{method,headers,...(body.length?{body}:{}),redirect:'manual',signal:AbortSignal.timeout(8000)});
   if(!upstream.headers.get('content-type')?.includes('application/json'))return reply(502,{error:'INVALID_BACKEND_RESPONSE'});
   let payload=await upstream.json();
   if(upstream.ok&&route==='/user/anonymous'){
    const cookies=upstream.headers.getSetCookie().filter(value=>value.startsWith('news_reader='));
    if(cookies.length)res.setHeader('Set-Cookie',cookies);
    onReaderIssued?.(req,res,payload,cookies.length?newsReaderCookie(cookies[0]):readerCookie);
   }
   if(upstream.ok&&route==='/news/feed'&&onFeed){
    let enabled:boolean|void|FeedRejection;
    try{enabled=await onFeed(req,payload);}catch{enabled=false;}
    if(enabled&&typeof enabled==='object')return reply(enabled.status,{error:enabled.error});
    if(typeof enabled==='boolean'&&payload&&typeof payload==='object'&&!Array.isArray(payload))payload={...payload,collection_enabled:enabled};
   }
   return reply(upstream.status,payload);
  }catch{return reply(503,{error:'BACKEND_UNAVAILABLE'});}
 };
}
