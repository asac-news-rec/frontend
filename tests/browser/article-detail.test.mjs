import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';
import {createDevServer} from '../../.local/server/dev-http.js';

test('본문 없는 v1 피드와 상세 직접 진입·경합·오류·좋아요를 실제 프록시로 검증한다',async t=>{
 // Close clients before the FIFO server/process teardown hooks.
 let browser;t.after(async()=>{await browser?.close();});
 let releaseA,releaseLike,releaseDetail,releaseFeed; t.after(()=>{releaseA?.();releaseLike?.();releaseDetail?.();releaseFeed?.();});
 const listen=async server=>{server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>new Promise(r=>server.close(r)));return `http://127.0.0.1:${server.address().port}`;};
 const articles=Array.from({length:12},(_,i)=>({article_id:'a'+i,title:'상세 검증 기사 '+i,summary:'가상 테스트 기사',category:'사회',published_at:'2026-11-20T00:00:00Z',is_synthetic:true,is_liked:false}));
 const requests=[];let detailStatus=200,holdA=null,likeGate=null,detailGate=null,detailStarted,feedGate=null,feedStarted;
 const backend=await listen(createServer(async(req,res)=>{
  requests.push({url:req.url,cookie:req.headers.cookie});let payload;
  if(req.url==='/api/v1/user/anonymous'){res.setHeader('Set-Cookie','news_reader=test-only; Path=/; HttpOnly');payload={reader_id:'019a0000-0000-7000-8000-000000000001'};}
  else if(req.url==='/api/v1/category')payload={category_list:['사회']};
  else if(req.url==='/api/v1/subcategory')payload={sub_category_list:['교육']};
  else if(req.url==='/api/v1/news/feed'){payload={request_id:'feed-request',served_at:'2026-11-20T00:00:00Z',items:articles.map((a,i)=>({...a,impression_id:'feed-impression-'+i,position:i+1})),next_cursor:null};if(feedGate){feedStarted();await feedGate;}}
  else {
   const match=/^\/api\/v1\/news\/([^/]+)(\/like)?$/.exec(req.url??'');const a=articles.find(a=>a.article_id===match?.[1]);
   if(!a||(!match?.[2]&&detailStatus!==200)){res.writeHead(a?detailStatus:404,{'Content-Type':'application/json'});res.end('{}');return;}
   if(match[2]){if(likeGate)await likeGate;a.is_liked=req.method==='PUT';payload={article_id:a.article_id,is_liked:a.is_liked,changed:true};}
   else {
    if(a.article_id==='a0'&&holdA)await holdA;
    payload={request_id:'detail-request',served_at:'2026-11-20T01:00:00Z',content:{...a,paragraphs:['상세 API의 본문 '+a.article_id,'<script>가상 문자열</script>']}};
    if(a.article_id==='a5'&&detailGate){detailStarted();await detailGate;}
   }
  }
  res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(payload));
 }));
 const reserve=createServer();reserve.listen(0,'127.0.0.1');await once(reserve,'listening');const port=reserve.address().port;await new Promise(r=>reserve.close(r));
 const origin=`http://127.0.0.1:${port}`;
 const web=createDevServer({root:fileURLToPath(new URL('../../',import.meta.url)),origin,backendBaseUrl:backend});
 web.listen(port,'127.0.0.1');await once(web,'listening');t.after(()=>new Promise(r=>web.close(r)));
 browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHANNEL?{channel:process.env.PLAYWRIGHT_CHANNEL}:{})});
 const page=await browser.newPage();page.setDefaultTimeout(7000);const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(origin);await page.locator('a.card').first().waitFor();
 await page.getByRole('button',{name:'사회',exact:true}).click();await page.locator('#subcategory').selectOption({label:'교육'});await page.locator('a.card').first().waitFor();
 await page.locator('a.card[data-article="a8"]').scrollIntoViewIfNeeded();
 const listY=await page.evaluate(()=>window.scrollY);
 await page.locator('a.card[data-article="a8"]').click();await page.locator('.article-body').waitFor();
 assert.match(await page.locator('.article-body').innerText(),/상세 API의 본문 a8/);
 assert.match(await page.locator('.article-body').innerText(),/<script>가상 문자열<\/script>/);
 assert.equal(await page.locator('article').getAttribute('data-impression-id'),'feed-impression-8');
 await page.locator('article .like-button').click();await page.waitForFunction(()=>document.querySelector('article .like-button')?.getAttribute('aria-pressed')==='true');
 await page.locator('article .back').first().click();await page.locator('a.card').first().waitFor();
 assert.equal(await page.locator('[data-like="a8"]').getAttribute('aria-pressed'),'true');
 assert.equal(await page.locator('#subcategory').inputValue(),'교육');
 await page.waitForFunction(y=>Math.abs(window.scrollY-y)<5,listY);
 assert(requests.filter(r=>r.url.includes('/news/a8')).every(r=>r.cookie==='news_reader=test-only'));
 
 // A late detail snapshot cannot revert a successful like from the list.
 likeGate=new Promise(r=>releaseLike=r);detailGate=new Promise(r=>releaseDetail=r);
 const started=new Promise(r=>detailStarted=r);
 await page.evaluate(()=>{window.likeChanges=0;window.addEventListener('likes-changed',()=>window.likeChanges++);});
 await page.locator('[data-like="a5"]').click();await page.locator('a.card[data-article="a5"]').click();await started;
 releaseLike();await page.waitForFunction(()=>window.likeChanges===1);releaseDetail();
 await page.locator('.article-body').waitFor();assert.equal(await page.locator('article .like-button').getAttribute('aria-pressed'),'true');
 likeGate=null;detailGate=null;
 // A feed completed while detail is open must still seed other articles.
 articles[10].is_liked=true;
 feedGate=new Promise(r=>releaseFeed=r);const feedArrived=new Promise(r=>feedStarted=r);
 await page.locator('article .back').first().click();await page.locator('#refresh').click();await feedArrived;
 await page.evaluate(()=>location.hash='#article/a8');await page.locator('.article-body').waitFor();
 releaseFeed();feedGate=null;
 await page.getByRole('link',{name:'← 뉴스 피드로 돌아가기',exact:true}).first().click();
 await page.locator('a.card').first().waitFor();
 assert.equal(await page.locator('[data-like="a10"]').getAttribute('aria-pressed'),'true');
 assert.equal(await page.locator('[data-like="a8"]').getAttribute('aria-pressed'),'true');
 assert.equal(await page.locator('[data-like="a10"]').isEnabled(),true);
 // Direct entry and reload fetch detail without requiring that article in a feed.
 const direct=await browser.newPage();await direct.goto(origin+'/#article/a9');await direct.locator('.article-body').waitFor();
 assert.equal(await direct.locator('article').getAttribute('data-impression-id'),'');
 await direct.reload();await direct.locator('.article-body').waitFor();assert.match(await direct.locator('.article-body').innerText(),/a9/);
 
 // A slow previous article must never replace the current route.
 holdA=new Promise(r=>releaseA=r);
 const oldResponse=direct.waitForResponse(r=>r.url().endsWith('/api/v1/news/a0'));
 await direct.goto(origin+'/#article/a0');await direct.getByText('기사 본문을 불러오고 있어요…').waitFor();
 await direct.evaluate(()=>location.hash='#article/a1');await direct.locator('.article-body').waitFor();releaseA();holdA=null;
 await (await oldResponse).finished();await direct.evaluate(()=>new Promise(requestAnimationFrame));assert.match(await direct.locator('.article-body').innerText(),/a1/);
 await direct.goto(origin+'/#article/missing');await direct.getByRole('heading',{name:'기사를 찾을 수 없어요'}).waitFor();
 detailStatus=503;await direct.goto(origin+'/#article/a2');await direct.getByRole('heading',{name:'기사 본문을 불러오지 못했어요'}).waitFor();
 detailStatus=200;await direct.getByRole('button',{name:'다시 시도',exact:true}).click();await direct.locator('.article-body').waitFor();assert.match(await direct.locator('.article-body').innerText(),/a2/);
 assert.deepEqual(errors,[]);
});
