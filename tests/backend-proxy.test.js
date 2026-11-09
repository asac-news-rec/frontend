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
  res.end(JSON.stringify(req.url==='/user/anonymous'?{reader_id:'issued'}:req.url==='/news/feed'?{items:[],next_offset:null}:{article_id:'a1',is_liked:req.method==='PUT',changed:true}));
 });
 upstream.listen(0,'127.0.0.1');await once(upstream,'listening');
 const origin='http://127.0.0.1:4173';
 const proxy=createBackendProxy({baseUrl:`http://127.0.0.1:${upstream.address().port}`,origin});
 const web=createServer(async(req,res)=>{if(!await proxy(req,res,new URL(req.url,origin).pathname)){res.writeHead(404);res.end();}});
 web.listen(0,'127.0.0.1');await once(web,'listening');
 t.after(async()=>{await new Promise(resolve=>web.close(resolve));await new Promise(resolve=>upstream.close(resolve));});
 const base=`http://127.0.0.1:${web.address().port}`;
 const post=(route,method,body,requestOrigin=origin)=>fetch(base+route,{method,headers:{Origin:requestOrigin,...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});
 assert.equal((await post('/user/anonymous','POST')).status,200);
 assert.equal((await post('/category','POST')).status,200);
 assert.equal((await post('/subcategory','POST',{category:'정치'})).status,200);
 assert.equal((await post('/news/feed','POST',{reader_id:'reader',offset:20})).status,200);
 assert.equal((await post('/news/a1/like','PUT',{reader_id:'reader'})).status,200);
 assert.equal((await post('/news/a1/like','DELETE',{reader_id:'reader'})).status,200);
 assert.deepEqual(received.map(({method,url})=>[method,url]),[
  ['POST','/user/anonymous'],['POST','/category'],['POST','/subcategory'],['POST','/news/feed'],['PUT','/news/a1/like'],['DELETE','/news/a1/like']]);
 assert.equal(received[1].body,'');
 assert.deepEqual(JSON.parse(received[2].body),{category:'정치'});
 assert.equal(JSON.parse(received[3].body).offset,20);
 assert.deepEqual(JSON.parse(received[4].body),{reader_id:'reader'});
 assert.equal((await post('/news/feed','POST',{reader_id:'reader',offset:0},'http://evil.test')).status,403);
 assert.equal(received.length,6);
 const prefixed=createBackendProxy({baseUrl:`http://127.0.0.1:${upstream.address().port}/api`,origin});
 const nginxWeb=createServer(async(req,res)=>{if(!await prefixed(req,res,new URL(req.url,origin).pathname)){res.writeHead(404);res.end();}});
 nginxWeb.listen(0,'127.0.0.1');await once(nginxWeb,'listening');
 t.after(()=>new Promise(resolve=>nginxWeb.close(resolve)));
 const nginxResponse=await fetch(`http://127.0.0.1:${nginxWeb.address().port}/news/feed`,{
  method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({reader_id:'reader',offset:0})});
 assert.equal(nginxResponse.status,200);
 assert.equal(received.at(-1).url,'/api/news/feed');
});
