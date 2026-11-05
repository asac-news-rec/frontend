export function createBackendProxy({baseUrl,origin,fetchImpl=fetch}) {
 const target=baseUrl?new URL(baseUrl.endsWith('/')?baseUrl:`${baseUrl}/`):null;
 return async (req,res,pathname)=>{
  if(!pathname.startsWith('/api/v1/backend/'))return false;
  const reply=(status,value)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'private, no-store'});res.end(JSON.stringify(value));return true;};
  if(!target)return reply(503,{error:'BACKEND_NOT_CONFIGURED'});
  let route,method;
  if(pathname==='/api/v1/backend/user/anonymous'){route='/user/anonymous';method='POST';}
  else if(pathname==='/api/v1/backend/news/feed'){route='/news/feed';method='POST';}
  else {
   const match=/^\/api\/v1\/backend\/news\/([^/]+)\/like$/.exec(pathname);
   if(!match)return reply(404,{error:'NOT_FOUND'});
   let articleId;try{articleId=decodeURIComponent(match[1]);}catch{return reply(400,{error:'INVALID_ARTICLE_ID'});}
   if(!articleId||articleId.includes('/')||articleId.length>128)return reply(400,{error:'INVALID_ARTICLE_ID'});
   route=`/news/${encodeURIComponent(articleId)}/like`;method=req.method;
   if(!['PUT','DELETE'].includes(method))return reply(405,{error:'METHOD_NOT_ALLOWED'});
  }
  if(req.method!==method)return reply(405,{error:'METHOD_NOT_ALLOWED'});
  if(req.headers.origin!==origin)return reply(403,{error:'ORIGIN_REJECTED'});
  if(route!=='/user/anonymous'&&req.headers['content-type']?.split(';')[0]!=='application/json')return reply(415,{error:'JSON_REQUIRED'});
  let size=0;const chunks=[];
  for await(const chunk of req){size+=chunk.length;if(size>262144)return reply(413,{error:'BODY_TOO_LARGE'});chunks.push(chunk);}
  if(route==='/user/anonymous'&&size)return reply(400,{error:'BODY_NOT_ALLOWED'});
  const body=Buffer.concat(chunks);
  try{
   const upstream=await fetchImpl(new URL(route.slice(1),target),{method,headers:route==='/user/anonymous'?{}:{'Content-Type':'application/json'},...(body.length?{body}:{}),signal:AbortSignal.timeout(8000)});
   if(!upstream.headers.get('content-type')?.includes('application/json'))return reply(502,{error:'INVALID_BACKEND_RESPONSE'});
   const payload=await upstream.json();
   return reply(upstream.status,payload);
  }catch{return reply(503,{error:'BACKEND_UNAVAILABLE'});}
 };
}
