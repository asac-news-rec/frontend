import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {createHmac,randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';
import {createDevServer} from '../../.local/server/dev-http.js';

test('event auth failures recover the same session or retain and report the queue',async t=>{
 const token=randomUUID(),received=[];let issued=0;
 const listen=async server=>{server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>new Promise(r=>server.close(r)));return `http://127.0.0.1:${server.address().port}`;};
 const logging=await listen(createServer(async(req,res)=>{const chunks=[];for await(const b of req)chunks.push(b);const body=JSON.parse(Buffer.concat(chunks).toString());if(body.events)received.push(...body.events);res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({results:(body.records??body.events).map(r=>({...('event_id' in r?{event_id:r.event_id}:{impression_id:r.impression_id}),status:'accepted'}))}));}));
 const backend=await listen(createServer((req,res)=>{let payload;if(req.url==='/api/user/anonymous')payload={reader_id:`019a0000-0000-7000-8000-${String(++issued).padStart(12,'0')}`};else if(req.url==='/api/category')payload={category_list:[]};else payload={request_id:randomUUID(),served_at:new Date().toISOString(),next_offset:null,items:[{article_id:'a',impression_id:randomUUID(),position:1,title:'세션 복구 시험 기사',paragraphs:['가상 기사'],category:'사회',published_at:new Date().toISOString(),is_synthetic:true,is_liked:false}]};res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(payload));}));
 const reserve=createServer();reserve.listen(0,'127.0.0.1');await once(reserve,'listening');const port=reserve.address().port;await new Promise(r=>reserve.close(r));const url=`http://127.0.0.1:${port}`;
 const web=createDevServer({root:fileURLToPath(new URL('../../',import.meta.url)),origin:url,backendBaseUrl:backend,logging:{url:logging,token}});web.listen(port,'127.0.0.1');await once(web,'listening');t.after(()=>new Promise(r=>web.close(r)));
 const browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHANNEL?{channel:process.env.PLAYWRIGHT_CHANNEL}:{})});t.after(()=>browser.close());
 async function fixture(){const context=await browser.newContext();const page=await context.newPage();const sent=[];let sessions=0;
  await page.addInitScript(()=>{globalThis.reports=[];document.addEventListener('behavior-queue-changed',event=>globalThis.reports.push(event.detail));});
  page.on('request',req=>{if(req.url().endsWith('/api/behavior/session'))sessions++;if(req.url().endsWith('/api/behavior/events')){const body=req.postDataJSON();sent.push(...body.events.filter(e=>e.event_type==='article_open'));}});
  await page.goto(url);await page.locator('a.card').waitFor();const identity=await page.evaluate(()=>localStorage.getItem('sai-news.backend-reader-id'));
  return {context,page,sent,identity,sessions:()=>sessions};
 }
 async function emit(page,count=1){await page.evaluate(async n=>{const m=await import('/src/behavior-events.js');const id=document.querySelector('a.card').dataset.impressionId;for(let i=0;i<n;i++)m.recordBehavior('article_open',id);},count);}
 const drained=page=>page.waitForFunction(()=>JSON.parse(sessionStorage.getItem('sai-news.behavior-pending')??'{}').entries?.length===0);
 for(const kind of ['deleted','expired','parallel'])await t.test(kind,async()=>{
  const f=await fixture(),before=issued;try{
   if(kind==='expired'){const payload=Buffer.from(JSON.stringify({readerId:f.identity,expires:Date.now()-1000})).toString('base64url');const signature=createHmac('sha256',token).update('news_behavior\0'+payload).digest('base64url');await f.context.addCookies([{name:'news_behavior',value:payload+'.'+signature,url,httpOnly:true}]);}
   else await f.context.clearCookies({name:'news_behavior'});
   await emit(f.page,kind==='parallel'?3:1);await drained(f.page);
   const groups=Map.groupBy(f.sent,e=>e.event_id);assert.equal(groups.size,kind==='parallel'?3:1);
   assert(f.sent.length>groups.size);
   for(const [id,attempts] of groups){if(kind!=='parallel')assert(attempts.length>=2);assert(attempts.every(e=>JSON.stringify(e)===JSON.stringify(attempts[0])));assert.equal(received.filter(e=>e.event_id===id).length,1);}
   assert.equal(f.sessions(),2);assert.equal(issued,before);assert.equal(await f.page.evaluate(()=>localStorage.getItem('sai-news.backend-reader-id')),f.identity);
  }finally{await f.context.close();}
 });
 await t.test('missing reader proof retains events and reports failure without issuing an identity',async()=>{
  const f=await fixture(),before=issued;try{await f.context.clearCookies();await emit(f.page);
   await f.page.waitForFunction(()=>globalThis.reports.some(r=>r.lastError==='READER_PROOF_REQUIRED'));
   const saved=await f.page.evaluate(()=>JSON.parse(sessionStorage.getItem('sai-news.behavior-pending')));assert.equal(saved.entries.length,1);assert.equal(saved.dropped,0);assert.equal(issued,before);assert.equal(f.sessions(),2);
   assert.equal(await f.page.locator('.behavior-notice').isVisible(),true);
   // Retained events expire visibly instead of silently disappearing.
   await f.page.evaluate(async()=>{const now=Date.now;Date.now=()=>now()+1800001;(await import('/src/behavior-events.js')).retryBehaviorEvents();});
   await f.page.waitForFunction(()=>globalThis.reports.some(r=>r.lastError==='EVENT_EXPIRED'&&r.dropped===1));
  }finally{await f.context.close();}
 });
 for(const status of [401,403])await t.test(`configuration ${status} is held and retries after correction`,async()=>{
  const f=await fixture();let broken=true;try{
   await f.page.route('**/api/behavior/events',r=>broken?r.fulfill({status,contentType:'application/json',body:JSON.stringify({error:status===403?'ORIGIN_REJECTED':'UNAUTHORIZED'})}):r.continue());
   await emit(f.page);await f.page.waitForFunction(()=>globalThis.reports.some(r=>r.sessionState==='blocked'&&r.pending===1));
   assert.equal(f.sessions(),1);assert.equal((await f.page.evaluate(()=>JSON.parse(sessionStorage.getItem('sai-news.behavior-pending')))).dropped,0);
   broken=false;await f.page.evaluate(async()=>(await import('/src/behavior-events.js')).retryBehaviorEvents());await drained(f.page);
   assert.equal(new Set(f.sent.map(e=>e.event_id)).size,1);assert(f.sent.length>=2);
  }finally{await f.context.close();}
 });
 await t.test('permanent invalid input is counted and shown',async()=>{
  const f=await fixture();try{await f.page.route('**/api/behavior/events',r=>r.fulfill({status:400,contentType:'application/json',body:'{"error":"INVALID_EVENT"}'}));await emit(f.page);await drained(f.page);
   const last=await f.page.evaluate(()=>globalThis.reports.at(-1));assert.equal(last.dropped,1);assert.equal(last.lastError,'HTTP_400');assert.match(await f.page.locator('.behavior-notice').textContent(),/폐기 1건/);
  }finally{await f.context.close();}
 });
});
