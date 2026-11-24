import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';
import {createDevServer} from '../../.local/server/dev-http.js';
import {startFastApiLogging} from '../helpers/fastapi-logging.mjs';

test('page lifecycle preserves delivery and closes each tracked article once',async t=>{
 const token=randomUUID(),logging=await startFastApiLogging(t,token);
 const article={article_id:'a',title:'페이지 수명주기 시험',paragraphs:['가상 기사'],category:'사회',published_at:new Date().toISOString(),is_synthetic:true,is_liked:false};
 const backend=createServer((req,res)=>{
  const path=req.url?.replace('/api/v1/','/api/');
  if(path==='/api/user/anonymous')res.setHeader('Set-Cookie','news_reader=fixture; Path=/; HttpOnly');
  res.writeHead(200,{'Content-Type':'application/json'});
  if(path==='/api/user/anonymous')res.end(JSON.stringify({reader_id:'019a0000-0000-7000-8000-000000000001'}));
  else if(path==='/api/category')res.end(JSON.stringify({category_list:[]}));
  else if(path==='/api/news/a')res.end(JSON.stringify({request_id:randomUUID(),served_at:new Date().toISOString(),content:article}));
  else res.end(JSON.stringify({request_id:randomUUID(),served_at:new Date().toISOString(),next_cursor:null,items:[{...article,impression_id:randomUUID(),position:1}]}));
 });
 backend.listen(0,'127.0.0.1');await once(backend,'listening');t.after(()=>new Promise(r=>backend.close(r)));
 const reserve=createServer();reserve.listen(0,'127.0.0.1');await once(reserve,'listening');const port=reserve.address().port;await new Promise(r=>reserve.close(r));const url=`http://127.0.0.1:${port}`;
 const web=createDevServer({root:fileURLToPath(new URL('../../',import.meta.url)),origin:url,backendBaseUrl:`http://127.0.0.1:${backend.address().port}`,logging:{url:logging.url,token}});web.listen(port,'127.0.0.1');await once(web,'listening');t.after(()=>new Promise(r=>web.close(r)));
 const browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHANNEL?{channel:process.env.PLAYWRIGHT_CHANNEL}:{})});t.after(()=>browser.close());const page=await browser.newPage();
 const deliveries=[];let release,held=false;const gate=new Promise(r=>release=r);t.after(()=>release());
 await page.route('**/api/behavior/events',async route=>{
  const event=route.request().postDataJSON().events[0];const response=await route.fetch();deliveries.push({event,ack:(await response.json()).results[0]});
  if(event.event_type==='article_open'&&!held){held=true;await gate;await route.abort();}else await route.fulfill({response});
 });
 await page.goto(url);await page.locator('a.card').waitFor();await page.locator('a.card').scrollIntoViewIfNeeded();await page.waitForTimeout(600);
 await page.evaluate(async()=>{const m=await import('/src/behavior-events.js');m.recordBehavior('article_open',document.querySelector('a.card').dataset.impressionId);});
 await page.waitForFunction(()=>JSON.parse(sessionStorage.getItem('sai-news.behavior-pending')).entries.some(e=>e.event.event_type==='article_open'));
 for(let i=0;!held&&i<100;i++)await page.waitForTimeout(20);assert(held);
 // Explicit lifecycle dispatch makes the persisted-page contract deterministic;
 // this does not assert that this browser chooses to admit a real page to BFCache.
 const hiddenAt=await page.evaluate(()=>{window.dispatchEvent(new PageTransitionEvent('pagehide',{persisted:true}));return Date.now();});
 for(let i=0;deliveries.filter(d=>d.event.event_type==='article_open').length<2&&i<100;i++)await page.waitForTimeout(20);
 const open=deliveries.filter(d=>d.event.event_type==='article_open');assert.equal(open.length,2);assert.deepEqual(open.map(d=>d.ack.status),['accepted','duplicate']);assert.deepEqual(open[0].event,open[1].event);
 assert.equal(await page.evaluate(()=>JSON.parse(sessionStorage.getItem('sai-news.behavior-pending')).entries.filter(e=>e.event.event_type==='article_open').length),1);
 await page.waitForTimeout(500);release();await page.waitForTimeout(50);
 const resumedAt=await page.evaluate(()=>{window.dispatchEvent(new PageTransitionEvent('pageshow',{persisted:true}));return Date.now();});
 await page.waitForFunction(()=>JSON.parse(sessionStorage.getItem('sai-news.behavior-pending')).entries.length===0);
 await page.waitForTimeout(350);await page.evaluate(()=>window.dispatchEvent(new PageTransitionEvent('pagehide',{persisted:true})));
 await page.waitForFunction(()=>JSON.parse(sessionStorage.getItem('sai-news.behavior-pending')).entries.length===0);
 const rows=logging.store.actions();assert.equal(rows.filter(r=>r.event_type==='article_open').length,1);
 const exposures=rows.filter(r=>r.event_type==='exposure').map(r=>JSON.parse(r.canonical_json));assert(exposures.length>=2);
 assert(exposures.some(e=>Date.parse(e.ended_at)<=hiddenAt+5));assert(exposures.some(e=>Date.parse(e.event_time)>=resumedAt-5));
 assert(exposures.every(e=>Date.parse(e.ended_at)<=hiddenAt+5||Date.parse(e.event_time)>=resumedAt-5));
 assert.equal(new Set(exposures.map(e=>e.event_id)).size,exposures.length);

 const card=page.locator('a.card');
 const impressionId=await card.getAttribute('data-impression-id');
 const closeRows=()=>logging.store.actions().filter(row=>row.event_type==='article_close');
 const drain=()=>page.waitForFunction(()=>JSON.parse(sessionStorage.getItem('sai-news.behavior-pending')).entries.length===0);
 await card.click();
 await page.locator('article.article-page .back').first().click();
 await card.waitFor();
 await drain();
 assert.deepEqual(closeRows().map(row=>[row.impression_id,row.page_type]),[[impressionId,'detail']]);

 await card.click();
 await page.locator('article.article-page').waitFor();
 await page.goBack();
 await card.waitFor();
 await drain();
 assert.equal(closeRows().length,2);

 await card.click();
 await page.locator('article.article-page').waitFor();
 await page.evaluate(()=>window.dispatchEvent(new PageTransitionEvent('pagehide')));
 await drain();
 await page.goBack();
 await card.waitFor();
 await drain();
 assert.deepEqual(closeRows().map(row=>row.impression_id),[impressionId,impressionId,impressionId]);
 assert.equal(logging.store.actions().filter(row=>row.event_type==='article_open'&&row.impression_id===impressionId).length,4);

 const direct=await browser.newPage();
 await direct.goto(`${url}/#article/a`);
 await direct.locator('article.article-page .back').first().click();
 await direct.locator('a.card').waitFor();
 await direct.waitForFunction(()=>JSON.parse(sessionStorage.getItem('sai-news.behavior-pending')).entries.length===0);
 await direct.close();
 assert.equal(closeRows().length,3);
});
