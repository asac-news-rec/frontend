import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createNewsServer} from '../server/http.mjs';

test('화면 서버가 백엔드 발급·피드·좋아요를 같은 출처에서 제공한다',async t=>{
 const calls=[];
 const upstream=createServer(async(req,res)=>{
  let body='';for await(const part of req)body+=part;
  calls.push({path:req.url,method:req.method,body:body&&JSON.parse(body)});
  const value=req.url==='/user/anonymous'?{reader_id:'019a4c00-0000-7000-8000-000000000001'}:
   req.url==='/news/feed'?{request_id:'request-1',served_at:'2026-11-05T00:00:00Z',items:[{article_id:'article-1',impression_id:'impression-1',position:1,title:'백엔드 기사',summary:'요약',paragraphs:['본문'],category:'사회',published_at:'2026-11-05T00:00:00Z',is_synthetic:true,is_liked:false}],next_offset:null}:
   {article_id:'article-1',is_liked:true,changed:true};
  res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(value));
 });
 upstream.listen(0,'127.0.0.1');await once(upstream,'listening');
 const directory=await mkdtemp(path.join(tmpdir(),'news-backend-live-'));
 const origin='http://127.0.0.1:4173';
 const root=fileURLToPath(new URL('../',import.meta.url));
 const {server,close}=createNewsServer({root,origin,database:path.join(directory,'visitors.sqlite'),backendBaseUrl:`http://127.0.0.1:${upstream.address().port}/`});
 server.listen(0,'127.0.0.1');await once(server,'listening');
 t.after(async()=>{await new Promise(resolve=>server.close(resolve));close();await new Promise(resolve=>upstream.close(resolve));await rm(directory,{recursive:true,force:true});});
 const base=`http://127.0.0.1:${server.address().port}`;
 const request=(route,method,body)=>fetch(base+route,{method,headers:{Origin:origin,...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});
 assert.match(await (await fetch(base+'/?feed=backend')).text(),/src\/app.js/);
 assert.equal((await request('/api/v1/backend/user/anonymous','POST')).status,200);
 const feed=await (await request('/api/v1/backend/news/feed','POST',{reader_id:'reader-1',offset:0})).json();
 assert.equal(feed.items[0].title,'백엔드 기사');
 assert.equal((await request('/api/v1/backend/news/article-1/like','PUT',{reader_id:'reader-1'})).status,200);
 assert.deepEqual(calls.map(call=>call.path),['/user/anonymous','/news/feed','/news/article-1/like']);
 assert.deepEqual(calls[1].body,{reader_id:'reader-1',offset:0});
});
