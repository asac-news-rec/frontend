import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {createBackendProxy} from '../.local/server/backend-proxy.js';

test('같은 출처 프록시는 태원님 API의 경로·method·본문을 유지한다',async t=>{
 const received=[];
 const upstream=createServer(async(req,res)=>{
  const chunks=[];for await(const chunk of req)chunks.push(chunk);
  received.push({method:req.method,url:req.url,body:Buffer.concat(chunks).toString(),cookie:req.headers.cookie});
  if(req.url==='/api/user/anonymous')res.setHeader('Set-Cookie','news_reader=test-proof; Path=/; HttpOnly');
  res.writeHead(200,{'Content-Type':'application/json'});
  res.end(JSON.stringify(req.url==='/api/user/anonymous'?{reader_id:'issued'}:req.url==='/api/news/feed'?{items:[],next_cursor:null}:{article_id:'a1',is_liked:req.method==='PUT',changed:true}));
 });
 upstream.listen(0,'127.0.0.1');await once(upstream,'listening');
 const origin='http://127.0.0.1:4173';
 const proxy=createBackendProxy({baseUrl:`http://127.0.0.1:${upstream.address().port}`,origin});
 const web=createServer(async(req,res)=>{if(!await proxy(req,res,new URL(req.url,origin).pathname)){res.writeHead(404);res.end();}});
 web.listen(0,'127.0.0.1');await once(web,'listening');
 t.after(async()=>{await new Promise(resolve=>web.close(resolve));await new Promise(resolve=>upstream.close(resolve));});
 const base=`http://127.0.0.1:${web.address().port}`;
 const post=(route,method,body,requestOrigin=origin)=>fetch(base+route,{method,headers:{Origin:requestOrigin,Cookie:'news_reader=test-proof; news_behavior=local-only',...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});
 const issued=await post('/api/user/anonymous','POST');
 assert.equal(issued.status,200);
 assert.deepEqual(issued.headers.getSetCookie(),['news_reader=test-proof; Path=/; HttpOnly']);
 assert.equal((await post('/api/category','POST')).status,200);
 assert.equal((await post('/api/subcategory','POST',{category:'정치'})).status,200);
 assert.equal((await post('/api/news/feed','POST',{category:'정치'})).status,200);
 assert.equal((await post('/api/news/a1/like','PUT')).status,200);
 assert.equal((await post('/api/news/a1/like','DELETE')).status,200);
 assert.deepEqual(received.map(({method,url})=>[method,url]),[
  ['POST','/api/user/anonymous'],['POST','/api/category'],['POST','/api/subcategory'],['POST','/api/news/feed'],['PUT','/api/news/a1/like'],['DELETE','/api/news/a1/like']]);
 assert.equal(received[1].body,'');
 assert.deepEqual(JSON.parse(received[2].body),{category:'정치'});
 assert.deepEqual(JSON.parse(received[3].body),{category:'정치'});
 assert.equal(received[4].body,'');
 assert.equal(received[5].body,'');
 assert(received.every(request=>request.cookie==='news_reader=test-proof'));
 assert.equal((await post('/api/news/a1/like','PUT',{reader_id:'reader'})).status,400);
 assert.equal((await post('/api/news/feed','POST',{},'http://evil.test')).status,403);
 assert.equal(received.length,6);
 assert.equal((await post('/news/feed','POST',{})).status,404);
 assert.equal((await post('/api/v1/backend/news/feed','POST',{})).status,404);
 assert.equal(received.length,6);
});

test('served hook failure preserves news response while real backend failure stays an error',async t=>{
 const origin='http://127.0.0.1:4173';let mode='logging-error',hooks=0;
 const proxy=createBackendProxy({baseUrl:'http://fixture.invalid/',origin,fetchImpl:async()=>{
  if(mode==='backend-network')throw new Error('backend offline');
  return new Response(JSON.stringify(mode==='backend-http'?{error:'NEWS_UNAVAILABLE'}:{items:[],next_cursor:null}),{status:mode==='backend-http'?503:200,headers:{'Content-Type':'application/json'}});
 },onFeed:async()=>{hooks++;throw new Error('PostgreSQL unavailable');}});
 const server=createServer(async(req,res)=>{await proxy(req,res,new URL(req.url,origin).pathname);});server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>new Promise(resolve=>server.close(resolve)));
 const request=()=>fetch(`http://127.0.0.1:${server.address().port}/api/news/feed`,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({})});
 let response=await request();assert.equal(response.status,200);assert.deepEqual(await response.json(),{items:[],next_cursor:null,collection_enabled:false});assert.equal(hooks,1);
 mode='backend-network';response=await request();assert.equal(response.status,503);assert.deepEqual(await response.json(),{error:'BACKEND_UNAVAILABLE'});
 mode='backend-http';response=await request();assert.equal(response.status,503);assert.deepEqual(await response.json(),{error:'NEWS_UNAVAILABLE'});assert.equal(hooks,1);
});

test('v1 피드 훅·익명 쿠키와 Origin 없는 상세 GET을 지원하고 외부 Origin을 거절한다',async t=>{
 const origin='http://127.0.0.1:4173',calls=[];let issued=0,feeds=0;
 const proxy=createBackendProxy({baseUrl:'http://fixture.invalid',origin,fetchImpl:async(url,options)=>{
  calls.push([String(url),options]);return Response.json({reader_id:'issued',items:[],next_cursor:null},{headers:{'Set-Cookie':'news_reader=proof; Path=/; HttpOnly'}});
 },onReaderIssued(){issued++;},onFeed:async()=>{feeds++;return true;}});
 const server=createServer(async(req,res)=>{if(!await proxy(req,res,new URL(req.url,origin).pathname)){res.writeHead(404);res.end();}});
 server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>new Promise(resolve=>server.close(resolve)));
 const base=`http://127.0.0.1:${server.address().port}`;
 const headers={Origin:origin,'Content-Type':'application/json',Cookie:'news_reader=proof; news_behavior=private'};
 assert.equal((await fetch(base+'/api/v1/user/anonymous',{method:'POST',headers})).status,200);
 assert.equal((await (await fetch(base+'/api/v1/news/feed',{method:'POST',headers,body:'{}'})).json()).collection_enabled,true);
 assert.equal((await fetch(base+'/api/v1/news/a1',{headers:{Cookie:headers.Cookie}})).status,200);
 assert.deepEqual(calls.map(([url])=>url),['http://fixture.invalid/api/v1/user/anonymous','http://fixture.invalid/api/v1/news/feed','http://fixture.invalid/api/v1/news/a1']);
 assert.equal(calls[2][1].method,'GET');assert.equal(calls[2][1].body,undefined);
 assert.equal(calls[2][1].headers.get('Cookie'),'news_reader=proof');assert.equal(issued,1);assert.equal(feeds,1);
 assert.equal((await fetch(base+'/api/v1/news/a1',{headers:{Origin:'https://evil.test'}})).status,403);
 assert.equal((await fetch(base+'/api/v1/news/a1',{method:'POST',headers})).status,405);
 assert.equal((await fetch(base+'/api/v1/news/a%2Fb')).status,400);
 assert.equal((await fetch(base+'/api/v1/news/a1',{headers:{'Sec-Fetch-Site':'cross-site'}})).status,403);
 assert.equal(calls.length,3);
 assert.equal((await fetch(base+'/api/v1/news/feed')).status,200);
 assert.equal(calls.at(-1)[1].method,'GET');assert.equal(feeds,1);
});

test('sidecar는 FastAPI를 직접 호출해 Nginx 순환을 피하고 정적 파일을 제공하지 않는다',async t=>{
 const {createDevServer}=await import('../.local/server/dev-http.js');const calls=[];
 const upstream=createServer((req,res)=>{calls.push(req.url);res.writeHead(200,{'Content-Type':'application/json'});res.end('{}');});upstream.listen(0,'127.0.0.1');await once(upstream,'listening');
 const origin='https://news.example';
 const gateway=createDevServer({root:'.',origin,backendBaseUrl:`http://127.0.0.1:${upstream.address().port}`,backendApiPrefix:'',gatewayOnly:true});
 gateway.listen(0,'127.0.0.1');await once(gateway,'listening');t.after(async()=>{await new Promise(r=>gateway.close(r));await new Promise(r=>upstream.close(r));});
 const base=`http://127.0.0.1:${gateway.address().port}`;
 assert.equal((await fetch(base+'/health')).status,200);
 assert.equal((await fetch(base+'/')).status,404);
 assert.equal((await fetch(base+'/api/v1/news/a')).status,200);
 assert.deepEqual(calls,['/v1/news/a']);
});
