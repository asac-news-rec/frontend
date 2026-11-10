import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {createHmac,randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';
import {createDevServer} from '../../.local/server/dev-http.js';

test('logging activation and cookie lifecycle preserve the canonical reader and existing likes',async t=>{
 const token=randomUUID(),legacy='019a0000-0000-7000-8000-000000000001',other='019a0000-0000-7000-8000-000000000002';
 const listen=async server=>{server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>new Promise(resolve=>server.close(resolve)));return `http://127.0.0.1:${server.address().port}`;};
 let issued=0,eventCount=0;const feeds=[],likeOwners=[],liked=new Set([legacy]);
 const logging=await listen(createServer(async(req,res)=>{const chunks=[];for await(const b of req)chunks.push(b);const body=JSON.parse(Buffer.concat(chunks).toString());if(req.url==='/events')eventCount++;res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({results:(body.records??body.events).map(r=>({...('event_id' in r?{event_id:r.event_id}:{impression_id:r.impression_id}),status:'accepted'}))}));}));
 const backend=await listen(createServer(async(req,res)=>{
  const chunks=[];for await(const b of req)chunks.push(b);const body=chunks.length?JSON.parse(Buffer.concat(chunks).toString()):{};let payload;
  if(req.url==='/api/user/anonymous'){issued++;payload={reader_id:`019a0000-0000-7000-8000-${String(issued+10).padStart(12,'0')}`};}
  else if(req.url==='/api/category')payload={category_list:['사회']};
  else if(req.url==='/api/news/feed'){feeds.push(body.reader_id);payload={request_id:randomUUID(),served_at:new Date().toISOString(),next_offset:null,items:[{article_id:'a1',impression_id:randomUUID(),position:1,title:'독자 이력 확인 기사',paragraphs:['검증용 가상 기사'],category:'사회',published_at:new Date().toISOString(),is_synthetic:true,is_liked:liked.has(body.reader_id)}]};}
  else if(req.url==='/api/news/a1/like'){likeOwners.push(body.reader_id);const desired=req.method==='PUT',changed=liked.has(body.reader_id)!==desired;if(desired)liked.add(body.reader_id);else liked.delete(body.reader_id);payload={article_id:'a1',is_liked:desired,changed};}
  else{res.writeHead(404);res.end();return;}
  res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(payload));
 }));
 const reserve=createServer();reserve.listen(0,'127.0.0.1');await once(reserve,'listening');const port=reserve.address().port;await new Promise(r=>reserve.close(r));const url=`http://127.0.0.1:${port}`;
 const web=createDevServer({root:fileURLToPath(new URL('../../',import.meta.url)),origin:url,backendBaseUrl:backend,logging:{url:logging,token}});web.listen(port,'127.0.0.1');await once(web,'listening');t.after(()=>new Promise(r=>web.close(r)));
 const browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHANNEL?{channel:process.env.PLAYWRIGHT_CHANNEL}:{})});t.after(()=>browser.close());
 const cookie=(readerId,expires)=>{const body=Buffer.from(JSON.stringify({readerId,expires})).toString('base64url');return body+'.'+createHmac('sha256',token).update('news_behavior\0'+body).digest('base64url');};
 const idOnPage=page=>page.evaluate(()=>localStorage.getItem('sai-news.backend-reader-id'));
 const ready=async page=>{await page.locator('a.card').waitFor();await page.waitForFunction(()=>!document.querySelector('.like-button')?.disabled);};
 await t.test('existing localStorage identity wins over a different collection cookie',async()=>{
  const context=await browser.newContext();try{
   await context.addInitScript(id=>{if(!localStorage.getItem('sai-news.backend-reader-id'))localStorage.setItem('sai-news.backend-reader-id',id);},legacy);
   const page=await context.newPage();await context.addCookies([{name:'news_behavior',value:cookie(other,Date.now()+86400000),url,httpOnly:true}]);
   let enabled=false;await page.route('**/api/behavior/status',route=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({enabled})}));
   await page.goto(url);await ready(page);assert.equal(await idOnPage(page),legacy);assert.equal(await page.locator('.like-button').getAttribute('aria-pressed'),'true');
   const before=issued;enabled=true;await page.reload();await ready(page);
   assert.equal(await idOnPage(page),legacy);assert.equal(feeds.at(-1),legacy);assert.equal(issued,before);assert.equal(await page.locator('.like-button').getAttribute('aria-pressed'),'true');
   assert.equal(await page.evaluate(()=>import('/src/behavior-events.js').then(m=>m.behaviorReader())),null);
   await page.locator('.like-button').click();await page.waitForFunction(()=>document.querySelector('.like-button')?.getAttribute('aria-pressed')==='false');assert.equal(likeOwners.at(-1),legacy);
  }finally{await context.close();}
 });
 await t.test('new identity is issued once and survives collection cookie deletion, expiry and disablement',async()=>{
  const context=await browser.newContext();try{
   const page=await context.newPage();const before=issued;await page.goto(url);await ready(page);
   const identity=await idOnPage(page);assert.equal(issued,before+1);assert.equal(feeds.at(-1),identity);
   await page.locator('.like-button').click();await page.waitForFunction(()=>document.querySelector('.like-button')?.getAttribute('aria-pressed')==='true');
   await context.clearCookies({name:'news_behavior'});await page.reload();await ready(page);
   assert.equal(await idOnPage(page),identity);assert.equal(issued,before+1);assert.equal(await page.locator('.like-button').getAttribute('aria-pressed'),'true');
   assert.equal(await page.evaluate(()=>import('/src/behavior-events.js').then(m=>m.behaviorReader())),identity);
   await context.addCookies([{name:'news_behavior',value:cookie(identity,Date.now()-1000),url,httpOnly:true}]);await page.reload();await ready(page);
   assert.equal(await idOnPage(page),identity);assert.equal(issued,before+1);assert.equal(await page.locator('.like-button').getAttribute('aria-pressed'),'true');
   assert.equal(await page.evaluate(()=>import('/src/behavior-events.js').then(m=>m.behaviorReader())),identity);
   await context.clearCookies();await page.reload();await ready(page);
   assert.equal(await idOnPage(page),identity);assert.equal(issued,before+1);assert.equal(await page.locator('.like-button').getAttribute('aria-pressed'),'true');
   assert.equal(await page.evaluate(()=>import('/src/behavior-events.js').then(m=>m.behaviorReader())),null);
   await page.route('**/api/behavior/status',r=>r.fulfill({status:200,contentType:'application/json',body:'{"enabled":false}'}));await page.reload();await ready(page);
   assert.equal(await idOnPage(page),identity);assert.equal(issued,before+1);assert.equal(feeds.at(-1),identity);assert.equal(await page.locator('.like-button').getAttribute('aria-pressed'),'true');
  }finally{await context.close();}
 });
});
