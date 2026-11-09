import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';
import {createDevServer} from '../../.local/server/dev-http.js';
import {createLoggingHttp} from '../../services/logging-server/http.mjs';
import {openLoggingStore} from '../../services/logging-server/repository.mjs';
import {runBrowserClick} from '../../scripts/browser-click-agent.mjs';

test('real browser click reaches SQLite once, isolated readers and invalid choices stay separate',async t=>{
 const token=randomUUID(),agentToken=randomUUID(),store=openLoggingStore({database:':memory:'});
 const listen=async server=>{server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>new Promise(resolve=>server.close(resolve)));return `http://127.0.0.1:${server.address().port}`;};
 t.after(()=>store.close());
 const loggingUrl=await listen(createLoggingHttp({store,token,exporter:{state:()=>({})}}));
 const feeds=[],events=[];
 const getAction=store.getAction.bind(store);
 const intake=store.intakeActions.bind(store);
 store.intakeActions=(context,body)=>{const result=intake(context,body);events.push(...body.events);return result;};
 let serial=0;
 const backend=await listen(createServer(async(req,res)=>{
  const chunks=[];for await(const c of req)chunks.push(c);
  const body=chunks.length?JSON.parse(Buffer.concat(chunks).toString()):{};
  let payload;
  if(req.url==='/api/user/anonymous')payload={reader_id:`019a0000-0000-7000-8000-${String(++serial).padStart(12,'0')}`};
  else if(req.url==='/api/category')payload={category_list:['IT·과학','스포츠']};
  else if(req.url==='/api/news/feed'){
   payload={reader_id:body.reader_id,request_id:randomUUID(),served_at:new Date().toISOString(),next_offset:null,items:['AI 산업 소식','스포츠 경기 결과'].map((title,index)=>({article_id:`article-${index}`,impression_id:randomUUID(),position:index+1,title,paragraphs:['브라우저 검증용 가상 기사입니다.'],category:index?'스포츠':'IT·과학',published_at:new Date().toISOString(),is_synthetic:true,is_liked:false}))};feeds.push(payload);
  }else{res.writeHead(404);res.end();return;}
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
 assert.equal(events.length,1);
 const saved=getAction(events[0].event_id);
 assert.equal(saved.source,'simulator');assert.equal(saved.event_type,'article_open');
 const served=store.getServed(saved.impression_id);
 assert.equal(served.article_id,'article-0');assert.equal(served.reader_id,feeds[0].reader_id);
 assert.equal((await run(async()=>({article_id:null}))).status,'skipped');
 await assert.rejects(run(async()=>({article_id:'not-in-screen'})),/INVALID_CHOICE/);
 assert.equal(events.length,1);assert.equal(new Set(feeds.map(f=>f.reader_id)).size,3);
 assert.equal(store.counts().actions,1);
 // Re-delivery of the exact same click remains one SQLite row.
 const duplicate=store.intakeActions({readerId:served.reader_id,collectionEnabled:true,source:'simulator'},{events:[events[0]]});
 assert.equal(duplicate.results[0].status,'duplicate');assert.equal(store.counts().actions,1);
 const before=store.counts();
 const ordinary=await browser.newContext();
 try{
  const page=await ordinary.newPage();await page.goto(url);
  await page.locator('a[data-article]').first().click();
  await page.locator('article.article-page h1').waitFor();
  assert.deepEqual(store.counts(),before);
 }finally{await ordinary.close();}
});
