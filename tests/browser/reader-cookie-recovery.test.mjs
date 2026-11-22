import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';
import {createDevServer} from '../../.local/server/dev-http.js';

test('쿠키 삭제 뒤 동시 401을 한 번 복구하고 이전 독자 응답·좋아요·행동 큐를 폐기한다',async t=>{
 const listen=async server=>{server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>new Promise(r=>{server.closeAllConnections();server.close(r);}));return `http://127.0.0.1:${server.address().port}`;};
 let issued=0,failIssue=false,rejectProtected=false,releaseOld;const feeds=[],likes=[],events=[],validReaders=new Set();
 t.after(()=>releaseOld?.());
 const logging=await listen(createServer(async(req,res)=>{const chunks=[];for await(const b of req)chunks.push(b);const body=JSON.parse(Buffer.concat(chunks).toString());
  if(body.events)events.push({reader:req.headers['x-news-reader'],events:body.events});
  res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({results:(body.events??body.records).map(r=>({status:'accepted',...(r.event_id?{event_id:r.event_id}:{impression_id:r.impression_id})}))}));
 }));
 let holdFeed=false,oldRequested;const oldRequest=new Promise(r=>oldRequested=r);
 const backend=await listen(createServer(async(req,res)=>{
  const reader=req.headers.cookie?.split('=')[1];let payload;
  const chunks=[];for await(const b of req)chunks.push(b);const body=chunks.length?JSON.parse(Buffer.concat(chunks).toString()):{};
  if(req.url==='/api/v1/user/anonymous'){
   if(failIssue){res.writeHead(503,{'Content-Type':'application/json'});res.end('{}');return;}
   if(validReaders.has(reader))payload={reader_id:reader};else{const id=`019a0000-0000-7000-8000-${String(++issued).padStart(12,'0')}`;validReaders.add(id);payload={reader_id:id};res.setHeader('Set-Cookie',`news_reader=${id}; Path=/; HttpOnly`);}
  }else if(req.url==='/api/v1/category')payload={category_list:['사회']};
  else if(req.url==='/api/v1/subcategory')payload={sub_category_list:['교육']};
  else {
   if(req.url?.endsWith('/like'))likes.push({reader,method:req.method});
   if(rejectProtected||!validReaders.has(reader)){res.writeHead(401,{'Content-Type':'application/json'});res.end('{}');return;}
   if(req.url==='/api/v1/news/feed'){
    feeds.push({reader,...body});
    payload={request_id:randomUUID(),served_at:new Date().toISOString(),items:[{article_id:'a',title:reader,category:'사회',published_at:new Date().toISOString(),is_synthetic:true,is_liked:reader.endsWith('1'),position:1,impression_id:randomUUID()}],next_cursor:null};
    if(holdFeed){holdFeed=false;oldRequested();await new Promise(r=>releaseOld=r);}
   }else if(req.url==='/api/v1/news/a/like')payload={article_id:'a',is_liked:req.method==='PUT',changed:true};
   else payload={request_id:randomUUID(),served_at:new Date().toISOString(),content:{article_id:'a',title:'상세',category:'사회',published_at:new Date().toISOString(),is_synthetic:true,is_liked:false,paragraphs:['본문']}};
  }
  res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(payload));
 }));
 const reserve=createServer();reserve.listen(0,'127.0.0.1');await once(reserve,'listening');const port=reserve.address().port;await new Promise(r=>reserve.close(r));const url=`http://127.0.0.1:${port}`;
 const web=createDevServer({root:fileURLToPath(new URL('../../',import.meta.url)),origin:url,backendBaseUrl:backend,logging:{url:logging,token:randomUUID()}});
 web.listen(port,'127.0.0.1');await once(web,'listening');t.after(()=>new Promise(r=>{web.closeAllConnections();web.close(r);}));
 const browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHANNEL?{channel:process.env.PLAYWRIGHT_CHANNEL}:{})});t.after(()=>browser.close());
 const context=await browser.newContext();const page=await context.newPage();page.setDefaultTimeout(7000);
 await page.addInitScript(()=>{window.recoveryCount=0;window.addEventListener('backend-reader-recovering',()=>window.recoveryCount++);});
 await page.goto(url);await page.locator('a.card').waitFor();
 await page.getByRole('button',{name:'사회',exact:true}).click();await page.locator('#subcategory').selectOption({label:'교육'});await page.locator('a.card').waitFor();
 const old=feeds.at(-1).reader;assert.equal(issued,1);
 // Keep a successful old-reader response in flight across recovery.
 holdFeed=true;await page.evaluate(()=>{window.staleFeed=import('/src/backend-api.js').then(m=>m.getBackendPage()).then(()=>false,e=>e.message);});await oldRequest;
 await page.route('**/api/behavior/events',r=>r.fulfill({status:503,contentType:'application/json',body:'{}'}));
 await page.evaluate(async()=>{const m=await import('/src/behavior-events.js');m.recordBehavior('article_open',document.querySelector('a.card').dataset.impressionId);});
 await page.waitForFunction(()=>JSON.parse(sessionStorage.getItem('sai-news.behavior-pending')).entries.length>0);
 await context.clearCookies({name:'news_reader'});
 const before=feeds.length;
 await page.evaluate(async()=>{const m=await import('/src/backend-api.js');await Promise.allSettled([m.getBackendPage(),m.changeBackendLike('a',false),m.getBackendPage()]);});
 await page.waitForFunction(previous=>{const title=document.querySelector('a.card h3')?.textContent;return Boolean(title&&title!==previous);},old);
 await page.locator('#subcategory').waitFor();assert.equal(await page.locator('#subcategory').inputValue(),'교육');
 const current=feeds.at(-1).reader;assert.notEqual(current,old);assert.equal(issued,2);assert.equal(await page.evaluate(()=>window.recoveryCount),1);
 assert.equal(feeds.length,before+1);assert.deepEqual(feeds.at(-1),{reader:current,category:'사회',subcategory:'교육'});
 assert.match(await page.locator('.like-notice').innerText(),/좋아요는 복구 후 다시 눌러 주세요/);
 assert.equal(await page.locator('.like-button').getAttribute('aria-pressed'),'false');assert.equal(likes.length,1);assert.equal(likes[0].reader,undefined);
 releaseOld();assert.equal(await page.evaluate(()=>window.staleFeed),'BACKEND_SESSION_CHANGED');
 assert.equal(await page.locator('a.card h3').textContent(),current);
 const saved=await page.evaluate(()=>JSON.parse(sessionStorage.getItem('sai-news.behavior-pending')));assert.equal(saved.readerId,current);assert.equal(saved.entries.length,0);
 assert.equal(await page.evaluate(()=>import('/src/behavior-events.js').then(m=>m.behaviorReader())),current);
 await page.unroute('**/api/behavior/events');assert(!events.some(e=>e.reader===current&&e.events.some(event=>event.event_type==='article_open')));
 // A failed anonymous reissue is visible and can be retried without replaying likes.
 await context.clearCookies({name:'news_reader'});failIssue=true;await page.locator('#refresh').click();await page.getByRole('button',{name:'다시 시도',exact:true}).waitFor();
 assert.match(await page.locator('.empty').innerText(),/독자 연결을 복구하지 못했습니다/);
 failIssue=false;await page.getByRole('button',{name:'다시 시도',exact:true}).click();await page.locator('a.card').waitFor();assert.equal(issued,3);assert.equal(likes.length,1);
 // Persistent 401 after reissue must stop instead of creating an identity loop.
 rejectProtected=true;await page.locator('#refresh').click();await page.getByRole('button',{name:'다시 시도',exact:true}).waitFor();
 const recoveryCount=await page.evaluate(()=>window.recoveryCount);await page.waitForTimeout(200);
 assert.equal(await page.evaluate(()=>window.recoveryCount),recoveryCount);
 rejectProtected=false;await page.getByRole('button',{name:'다시 시도',exact:true}).click();await page.locator('a.card').waitFor();

});
