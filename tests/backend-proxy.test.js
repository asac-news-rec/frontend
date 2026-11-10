import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {createBackendProxy} from '../.local/server/backend-proxy.js';

test('같은 출처 프록시는 태원님 API의 경로·method·본문을 유지한다',async t=>{
 const received=[];
 const upstream=createServer(async(req,res)=>{
  const chunks=[];for await(const chunk of req)chunks.push(chunk);
  received.push({method:req.method,url:req.url,body:Buffer.concat(chunks).toString()});
  res.writeHead(200,{'Content-Type':'application/json'});
  res.end(JSON.stringify(req.url==='/api/user/anonymous'?{reader_id:'issued'}:req.url==='/api/news/feed'?{items:[],next_offset:null}:{article_id:'a1',is_liked:req.method==='PUT',changed:true}));
 });
 upstream.listen(0,'127.0.0.1');await once(upstream,'listening');
 const origin='http://127.0.0.1:4173';
 const proxy=createBackendProxy({baseUrl:`http://127.0.0.1:${upstream.address().port}`,origin});
 const web=createServer(async(req,res)=>{if(!await proxy(req,res,new URL(req.url,origin).pathname)){res.writeHead(404);res.end();}});
 web.listen(0,'127.0.0.1');await once(web,'listening');
 t.after(async()=>{await new Promise(resolve=>web.close(resolve));await new Promise(resolve=>upstream.close(resolve));});
 const base=`http://127.0.0.1:${web.address().port}`;
 const post=(route,method,body,requestOrigin=origin)=>fetch(base+route,{method,headers:{Origin:requestOrigin,...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});
 assert.equal((await post('/api/user/anonymous','POST')).status,200);
 assert.equal((await post('/api/category','POST')).status,200);
 assert.equal((await post('/api/subcategory','POST',{category:'정치'})).status,200);
 assert.equal((await post('/api/news/feed','POST',{reader_id:'reader',offset:20})).status,200);
 assert.equal((await post('/api/news/a1/like','PUT',{reader_id:'reader'})).status,200);
 assert.equal((await post('/api/news/a1/like','DELETE',{reader_id:'reader'})).status,200);
 assert.deepEqual(received.map(({method,url})=>[method,url]),[
  ['POST','/api/user/anonymous'],['POST','/api/category'],['POST','/api/subcategory'],['POST','/api/news/feed'],['PUT','/api/news/a1/like'],['DELETE','/api/news/a1/like']]);
 assert.equal(received[1].body,'');
 assert.deepEqual(JSON.parse(received[2].body),{category:'정치'});
 assert.equal(JSON.parse(received[3].body).offset,20);
 assert.deepEqual(JSON.parse(received[4].body),{reader_id:'reader'});
 assert.equal((await post('/api/news/feed','POST',{reader_id:'reader',offset:0},'http://evil.test')).status,403);
 assert.equal(received.length,6);
 assert.equal((await post('/news/feed','POST',{reader_id:'reader',offset:0})).status,404);
 assert.equal((await post('/api/v1/backend/news/feed','POST',{reader_id:'reader',offset:0})).status,404);
 assert.equal(received.length,6);
});

test('served hook failure preserves news response while real backend failure stays an error',async t=>{
 const origin='http://127.0.0.1:4173';let mode='logging-error',hooks=0;
 const proxy=createBackendProxy({baseUrl:'http://fixture.invalid/',origin,fetchImpl:async()=>{
  if(mode==='backend-network')throw new Error('backend offline');
  return new Response(JSON.stringify(mode==='backend-http'?{error:'NEWS_UNAVAILABLE'}:{items:[],next_offset:null}),{status:mode==='backend-http'?503:200,headers:{'Content-Type':'application/json'}});
 },onFeed:async()=>{hooks++;throw new Error('PostgreSQL unavailable');}});
 const server=createServer(async(req,res)=>{await proxy(req,res,new URL(req.url,origin).pathname);});server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>new Promise(resolve=>server.close(resolve)));
 const request=()=>fetch(`http://127.0.0.1:${server.address().port}/api/news/feed`,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({reader_id:'fixture-reader',offset:0})});
 let response=await request();assert.equal(response.status,200);assert.deepEqual(await response.json(),{items:[],next_offset:null,collection_enabled:false});assert.equal(hooks,1);
 mode='backend-network';response=await request();assert.equal(response.status,503);assert.deepEqual(await response.json(),{error:'BACKEND_UNAVAILABLE'});
 mode='backend-http';response=await request();assert.equal(response.status,503);assert.deepEqual(await response.json(),{error:'NEWS_UNAVAILABLE'});assert.equal(hooks,1);
});
