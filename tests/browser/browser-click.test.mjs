import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';
import {createDevServer} from '../../.local/server/dev-http.js';
import {startFastApiLogging} from '../helpers/fastapi-logging.mjs';
import {runBrowserClick} from '../../scripts/browser-click-agent.mjs';

test('real browser click reaches SQLite once, isolated readers and invalid choices stay separate',async t=>{
 const token=randomUUID(),agentToken=randomUUID();
 const {url:fastApiUrl,store}=await startFastApiLogging(t,token);
 const listen=async server=>{server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>new Promise(resolve=>server.close(resolve)));return `http://127.0.0.1:${server.address().port}`;};
 let failSecondBatch=false;
 const loggingUrl=await listen(createServer(async(req,res)=>{
  const chunks=[];for await(const chunk of req)chunks.push(chunk);
  const body=Buffer.concat(chunks);
  if(failSecondBatch&&req.url==='/internal/served'&&JSON.parse(body).records[0].position===101){
   res.writeHead(503,{'Content-Type':'application/json'});
   res.end(JSON.stringify({error:'INBOX_CAPACITY'}));
   return;
  }
  const headers=Object.fromEntries(Object.entries(req.headers).filter(([name])=>name==='authorization'||name==='content-type'||name.startsWith('x-')));
  const response=await fetch(fastApiUrl+req.url,{method:req.method,headers,body});
  res.writeHead(response.status,{'Content-Type':'application/json'});
  res.end(await response.text());
 }));
 const feeds=[];
 let serial=0, paginate=false, largeFeed=false;
 const backend=await listen(createServer(async(req,res)=>{
  const readerId=req.headers.cookie?.split('=')[1];
  let payload;
  if(req.url==='/api/user/anonymous')payload={reader_id:`019a0000-0000-7000-8000-${String(++serial).padStart(12,'0')}`};
  else if(req.url==='/api/category')payload={category_list:['IT·과학','스포츠']};
  else if(req.url==='/api/news/feed'){
   const titles=largeFeed?Array.from({length:101},(_,index)=>`기사 ${index+1}`):['AI 산업 소식','스포츠 경기 결과'];
   const chunks=[];
   for await(const chunk of req)chunks.push(chunk);
   const {cursor}=JSON.parse(Buffer.concat(chunks).toString('utf8'));
   const next_cursor=paginate&&!cursor?{article_id:'article-1',published_at:new Date().toISOString(),returned_count:2}:null;
   payload={reader_id:readerId,request_id:randomUUID(),served_at:new Date().toISOString(),next_cursor,items:titles.map((title,index)=>({article_id:`article-${index}`,impression_id:randomUUID(),position:(cursor?.returned_count??0)+index+1,title,paragraphs:['브라우저 검증용 가상 기사입니다.'],category:index?'스포츠':'IT·과학',published_at:new Date().toISOString(),is_synthetic:true,is_liked:false}))};feeds.push(payload);
  }else{res.writeHead(404);res.end();return;}
  if(req.url==='/api/user/anonymous')res.setHeader('Set-Cookie',`news_reader=${payload.reader_id}; Path=/; HttpOnly`);
  res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(payload));
 }));
 // Reserve the port before creating the server's origin-bound routes.
 const reservation=createServer();reservation.listen(0,'127.0.0.1');await once(reservation,'listening');
 const port=reservation.address().port;await new Promise(resolve=>reservation.close(resolve));
 const url=`http://127.0.0.1:${port}`;
 const web=createDevServer({root:fileURLToPath(new URL('../../',import.meta.url)),origin:url,backendBaseUrl:backend,synthetic:{agentToken,loggingToken:token,loggingUrl}});
 web.listen(port,'127.0.0.1');await once(web,'listening');t.after(()=>new Promise(resolve=>web.close(resolve)));
 const browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHANNEL?{channel:process.env.PLAYWRIGHT_CHANNEL}:{})});t.after(()=>browser.close());
 const persona={reader_id:'fixture-persona',persona:'AI에 관심'};
 const run=choose=>runBrowserClick({browser,url,persona,agentToken,choose});
 assert.equal((await fetch(url+'/api/synthetic/session',{method:'POST'})).status,401);
 assert.equal((await fetch(url+'/api/synthetic/events',{method:'POST',headers:{Origin:url,'Content-Type':'application/json'},body:'{}'})).status,403);
 assert.deepEqual(await run(async context=>{assert.equal(context.articles[0].title,'AI 산업 소식');return {article_id:context.articles[0].article_id};}),{status:'clicked',candidates:2,accepted:true});
 const actions=store.actions();
 assert.equal(actions.length,1);
 const saved=actions[0];
 const event=JSON.parse(saved.canonical_json);
 assert.equal(saved.source,'simulator');assert.equal(saved.event_type,'article_open');
 const served=store.getServed(saved.impression_id);
 assert.equal(served.article_id,'article-0');assert.equal(served.reader_id,feeds[0].reader_id);
 assert.equal((await run(async()=>({article_id:null}))).status,'skipped');
 await assert.rejects(run(async()=>({article_id:'not-in-screen'})),/INVALID_CHOICE/);
 assert.equal(store.actions().length,1);assert.equal(new Set(feeds.map(f=>f.reader_id)).size,3);
 assert.equal(store.counts().actions,1);
 // Re-delivery of the exact same click remains one SQLite row.
 const duplicate=await store.intakeActions({readerId:served.reader_id,collectionEnabled:true,source:'simulator'},{events:[event]});
 assert.equal(duplicate.results[0].status,'duplicate');assert.equal(store.counts().actions,1);
 const before=store.counts();
 const ordinary=await browser.newContext();
 try{
  const page=await ordinary.newPage();await page.goto(url);
  await page.locator('a[data-article]').first().click();
  await page.locator('article.article-page h1').waitFor();
  assert.deepEqual(store.counts(),before);
 }finally{await ordinary.close();}

 paginate=true;
 const context=await browser.newContext();
 try{
  await context.request.post(url+'/api/synthetic/session',{headers:{'x-synthetic-agent':agentToken}});
  const page=await context.newPage();
  // Keep observer construction available while driving pagination manually.
  await page.addInitScript(()=>{
   window.IntersectionObserver=class {
    observe(){}
    disconnect(){}
   };
  });
  await page.goto(url);
  await page.locator('a[data-article]').first().waitFor();
  const firstFeed=feeds.at(-1);
  await page.locator('#more').click();
  await page.getByText('모든 기사를 확인했어요.').waitFor();
  const nextFeed=feeds.at(-1);
  assert.notEqual(firstFeed.items[0].impression_id,nextFeed.items[0].impression_id);
  const ack=page.waitForResponse(response=>response.url().endsWith('/api/synthetic/events'));
  await page.locator('a[data-article="article-0"]').click();
  assert.equal((await ack).status(),200);
  assert.equal(store.actions().find(row=>row.event_id!==saved.event_id)?.impression_id,firstFeed.items[0].impression_id);

  const requestFeed=cookie=>context.request.post(url+'/api/news/feed',{
   headers:{Origin:url,...(cookie?{Cookie:cookie}:{})},data:{}
  });
  const session=(await context.cookies(url)).find(cookie=>cookie.name==='sai_synthetic');
  assert.ok(session);
  const mismatch=await requestFeed(`sai_synthetic=${session.value}; news_reader=${feeds[0].reader_id}`);
  assert.equal(mismatch.status(),409);
  assert.deepEqual(await mismatch.json(),{error:'SYNTHETIC_READER_MISMATCH'});
  assert.equal(store.getServed(feeds.at(-1).items[0].impression_id),undefined);

  paginate=false;largeFeed=true;
  failSecondBatch=true;
  const failed=await requestFeed();
  assert.equal(failed.status(),503);
  assert.deepEqual(await failed.json(),{error:'SYNTHETIC_LOGGING_UNAVAILABLE'});
  const failedFeed=feeds.at(-1);
  assert.ok(failedFeed.items.slice(0,100).every(item=>store.getServed(item.impression_id)));
  assert.equal(store.getServed(failedFeed.items[100].impression_id),undefined);

  failSecondBatch=false;
  assert.equal((await requestFeed()).status(),200);
  const retriedFeed=feeds.at(-1);
  assert.notEqual(retriedFeed.items[0].impression_id,failedFeed.items[0].impression_id);
  assert.ok(store.getServed(failedFeed.items[0].impression_id));
  assert.ok(retriedFeed.items.every(item=>store.getServed(item.impression_id)));
 }finally{await context.close();}
});
