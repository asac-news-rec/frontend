import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';
import {createDevServer} from '../../.local/server/dev-http.js';

test('logging failures disable collection while feed, detail, pagination and likes remain usable',async t=>{
 const listen=async server=>{server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>new Promise(resolve=>server.close(resolve)));return `http://127.0.0.1:${server.address().port}`;};
 let mode='',eventRequests=0,reader=0;const feeds=[],likes=[];
 const logging=await listen(createServer(async(req,res)=>{
  const chunks=[];for await(const c of req)chunks.push(c);const body=JSON.parse(Buffer.concat(chunks).toString());
  if(req.url==='/events')eventRequests++;
  if(req.url==='/internal/served'&&mode==='served-timeout')return;
  if(req.url==='/internal/served'&&mode==='served-503'){res.writeHead(503,{'Content-Type':'application/json'});res.end('{}');return;}
  if(req.url==='/internal/served'&&mode==='served-connection-lost'){req.socket.destroy();return;}
  res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({results:(body.records??body.events).map(r=>({...('event_id' in r?{event_id:r.event_id}:{impression_id:r.impression_id}),status:'accepted'}))}));
 }));
 const backend=await listen(createServer(async(req,res)=>{
  const chunks=[];for await(const c of req)chunks.push(c);const body=chunks.length?JSON.parse(Buffer.concat(chunks).toString()):{};let payload;
  if(req.url==='/api/user/anonymous')payload={reader_id:`019a0000-0000-7000-8000-${String(++reader).padStart(12,'0')}`};
  else if(req.url==='/api/category')payload={category_list:['IT·과학']};
  else if(req.url==='/api/news/feed'){
   feeds.push(body);const offset=body.offset;
   payload={request_id:randomUUID(),served_at:new Date().toISOString(),next_offset:offset===0?1:null,items:[{article_id:`a${offset}`,impression_id:randomUUID(),position:offset+1,title:`장애 중에도 읽는 기사 ${offset}`,paragraphs:['정상 뉴스 본문'],category:'IT·과학',published_at:new Date().toISOString(),is_synthetic:false,is_liked:false}]};
  }else if(req.url?.endsWith('/like')){likes.push(body);payload={article_id:req.url.split('/')[3],is_liked:req.method==='PUT',changed:true};}
  else{res.writeHead(404);res.end();return;}
  res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(payload));
 }));
 const reservation=createServer();reservation.listen(0,'127.0.0.1');await once(reservation,'listening');const port=reservation.address().port;await new Promise(resolve=>reservation.close(resolve));
 const url=`http://127.0.0.1:${port}`;const web=createDevServer({root:fileURLToPath(new URL('../../',import.meta.url)),origin:url,backendBaseUrl:backend,logging:{url:logging,token:randomUUID()}});
 web.listen(port,'127.0.0.1');await once(web,'listening');t.after(()=>new Promise(resolve=>web.close(resolve)));
 const browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHANNEL?{channel:process.env.PLAYWRIGHT_CHANNEL}:{})});t.after(()=>browser.close());
 for(const failure of ['status-503','status-network','session-503','session-invalid','served-503','served-connection-lost','served-timeout'])await t.test(failure,async()=>{
  mode=failure;const beforeEvents=eventRequests,firstFeed=feeds.length,firstLike=likes.length;
  const context=await browser.newContext();try{
   await context.addInitScript(()=>sessionStorage.setItem('sai-news.behavior-pending',JSON.stringify({readerId:'previous-reader',entries:[{created:Date.now(),event:{event_id:'previous-event'}}]})));
   const page=await context.newPage();
   if(failure.startsWith('status-'))await page.route('**/api/behavior/status',r=>failure==='status-network'?r.abort():r.fulfill({status:503,contentType:'application/json',body:'{}'}));
   if(failure.startsWith('session-'))await page.route('**/api/behavior/session',r=>r.fulfill({status:failure==='session-503'?503:200,contentType:'application/json',body:failure==='session-invalid'?'{"reader_id":{}}':'{}'}));
   await page.goto(url);await page.locator('a.card[data-article="a0"]').waitFor();
   assert.equal(await page.locator('.empty').count(),0);
   await page.locator('a.card[data-article="a0"]').click();await page.locator('article.article-page h1').waitFor();
   await page.locator('article .like-button').click();await page.waitForFunction(()=>document.querySelector('article .like-button')?.getAttribute('aria-pressed')==='true');
   assert.equal(likes.length,firstLike+1);assert.equal(likes.at(-1).reader_id,feeds[firstFeed].reader_id);
   await page.locator('article .back').first().click();await page.locator('a.card[data-article="a1"]').waitFor();
   assert(feeds.slice(firstFeed).some(body=>body.offset===1));
   assert(feeds.slice(firstFeed).every(body=>body.reader_id===feeds[firstFeed].reader_id));
   assert.equal(eventRequests,beforeEvents);
   assert.equal(await page.evaluate(()=>JSON.parse(sessionStorage.getItem('sai-news.behavior-pending')??'{"entries":[]}').entries.length),0);
   const identity=await page.evaluate(()=>import('/src/behavior-events.js').then(m=>m.behaviorReader()));
   if(failure.startsWith('status-')||failure.startsWith('session-'))assert.equal(identity,null);
   else assert.equal(identity,feeds[firstFeed].reader_id);
  }finally{await context.close();}
 });
 await t.test('served recovery resumes collection with the same reader',async()=>{
  mode='served-503';const start=feeds.length,before=eventRequests;
  const context=await browser.newContext();try{
   const page=await context.newPage();await page.goto(url);await page.locator('a.card[data-article="a0"]').waitFor();
   const identity=feeds[start].reader_id;assert.equal(eventRequests,before);
   mode='healthy';await page.locator('#refresh').click();await page.locator('a.card[data-article="a0"]').waitFor();
   await page.locator('a.card[data-article="a0"]').click();await page.locator('article.article-page').waitFor();
   await page.waitForFunction(()=>JSON.parse(sessionStorage.getItem('sai-news.behavior-pending')??'{"entries":[]}').entries.length===0);
   assert(eventRequests>before);assert.equal(await page.evaluate(()=>import('/src/behavior-events.js').then(m=>m.behaviorReader())),identity);
   assert(feeds.slice(start).every(body=>body.reader_id===identity));
  }finally{await context.close();}
 });
});
