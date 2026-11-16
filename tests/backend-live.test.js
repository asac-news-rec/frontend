import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {fileURLToPath} from 'node:url';
import {createDevServer} from '../.local/server/dev-http.js';

test('화면 서버가 백엔드 발급·피드·좋아요를 같은 출처에서 제공한다',async t=>{
 const calls=[];
 const upstream=createServer(async(req,res)=>{
  if(req.url.startsWith('/images/')) {
   res.writeHead(req.url.includes('missing')?404:200,{'Content-Type':'image/png'});
   res.end(req.method==='HEAD'?undefined:Buffer.from([137,80,78,71]));return;
  }
  let body='';for await(const part of req)body+=part;
  calls.push({path:req.url,method:req.method,body:body&&JSON.parse(body)});
  const value=req.url==='/api/user/anonymous'?{reader_id:'019a4c00-0000-7000-8000-000000000001'}:
   req.url==='/api/news/feed'?{request_id:'request-1',served_at:'2026-11-05T00:00:00Z',items:[{article_id:'article-1',impression_id:'impression-1',position:1,title:'백엔드 기사',summary:'요약',paragraphs:['본문'],category:'사회',published_at:'2026-11-05T00:00:00Z',is_synthetic:true,is_liked:false}],next_cursor:null}:
   {article_id:'article-1',is_liked:true,changed:true};
  res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(value));
 });
 upstream.listen(0,'127.0.0.1');await once(upstream,'listening');
 const origin='http://127.0.0.1:4173';
 const root=fileURLToPath(new URL('../',import.meta.url));
 const server=createDevServer({root,origin,backendBaseUrl:`http://127.0.0.1:${upstream.address().port}/`});
 server.listen(0,'127.0.0.1');await once(server,'listening');
 t.after(async()=>{await new Promise(resolve=>server.close(resolve));await new Promise(resolve=>upstream.close(resolve));});
 const base=`http://127.0.0.1:${server.address().port}`;
 const request=(route,method,body)=>fetch(base+route,{method,headers:{Origin:origin,...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});
 assert.match(await (await fetch(base+'/')).text(),/src\/app.js/);
 const browserApp=await fetch(base+'/src/app.js');
 assert.equal(browserApp.status,200);
 assert.match(browserApp.headers.get('content-type'),/text\/javascript/);
 for(const route of ['/src/app.ts','/server.js','/dev-server.js','/package.json','/data/visitors.sqlite','/api/v1/visitors/me'])assert.equal((await fetch(base+route)).status,404,route);
 assert.equal((await fetch(base+'/',{method:'HEAD'})).status,200);
 assert.equal((await fetch(base+'/',{method:'POST'})).status,405);
 assert.equal((await request('/api/user/anonymous','POST')).status,200);
 const feed=await (await request('/api/news/feed','POST',{})).json();
 assert.equal(feed.items[0].title,'백엔드 기사');
 assert.equal((await request('/api/news/article-1/like','PUT')).status,200);
 assert.deepEqual(calls.map(call=>call.path),['/api/user/anonymous','/api/news/feed','/api/news/article-1/like']);
 assert.deepEqual(calls[1].body,{});
 const image=await fetch(base+'/images/news/a.png?v=1');
 assert.equal(image.status,200);
 assert.equal(image.headers.get('content-type'),'image/png');
 assert.deepEqual(Buffer.from(await image.arrayBuffer()),Buffer.from([137,80,78,71]));
 assert.equal((await fetch(base+'/images/news/a.png',{method:'HEAD'})).status,200);
 assert.equal((await fetch(base+'/images/missing.png')).status,404);
 assert.equal((await fetch(base+'/images/news/a.png',{method:'POST'})).status,405);
});
