import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {spawn,execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';
import {createDevServer} from '../../.local/server/dev-http.js';

const enabled=Boolean(process.env.TEST_POSTGRES_URL&&process.env.STORAGE_EMULATOR_HOST);
test('ordinary screen exposure/open/like travels through proxy, PostgreSQL and GCS worker',{skip:!enabled},async t=>{
 const python=process.env.LOGGING_PYTHON||'python',service=fileURLToPath(new URL('../../services/logging-server/',import.meta.url));
 const token=randomUUID(),prefix='browser-'+randomUUID();
 const listen=async server=>{server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>new Promise(resolve=>server.close(resolve)));return `http://127.0.0.1:${server.address().port}`;};
 const reserve=async()=>{const s=createServer();s.listen(0,'127.0.0.1');await once(s,'listening');const p=s.address().port;await new Promise(r=>s.close(r));return p;};
 const intervalStart=new Date().toISOString();
 const port=await reserve(),loggingUrl=`http://127.0.0.1:${port}`;
 const env={...process.env,LOGGING_STORE:'postgres',LOGGING_TOKEN:token,LOGGING_DATABASE_URL:process.env.TEST_POSTGRES_URL,LOGGING_PORT:String(port),GCS_BUCKET:prefix,GOOGLE_CLOUD_PROJECT:'local-integration',GCS_PREFIX:prefix};
 // A fresh emulator/job must not depend on a preceding Python test's bucket.
 execFileSync(python,['-c',"import os;from logging_service.gcs import GCSSink;s=GCSSink(os.environ['GCS_BUCKET'],os.environ['GOOGLE_CLOUD_PROJECT']);s.client.create_bucket(s.bucket)"],{cwd:service,env,timeout:15000});
 const child=spawn(python,['-m','logging_service'],{cwd:service,env,stdio:['ignore','ignore','pipe']});let log='';child.stderr.on('data',b=>log+=b.toString());
 t.after(async()=>{if(child.exitCode===null){child.kill();await once(child,'exit');}});
 for(let i=0;;i++){try{if((await fetch(loggingUrl+'/health')).ok)break;}catch{}if(i===100)throw new Error(log);await new Promise(r=>setTimeout(r,50));}
 // Real FastAPI emits six fractional digits; exercise that wire format in the feed.
 let serial=0;const readerIds=[],likes=new Set();
 const backend=await listen(createServer(async(req,res)=>{
  req.url=req.url?.replace('/api/v1/','/api/');
  const chunks=[];for await(const b of req)chunks.push(b);const input=chunks.length?JSON.parse(Buffer.concat(chunks).toString()):{};let result;
  if(req.url==='/api/user/anonymous'){serial++;const id=`019a0000-0000-7000-8000-${randomUUID().replaceAll('-','').slice(-12)}`;readerIds.push(id);result={reader_id:id};}
  else if(req.url==='/api/category')result={category_list:['IT·과학']};
  else if(req.url==='/api/news/feed')result={request_id:randomUUID(),served_at:new Date().toISOString().replace('Z','456+00:00'),next_cursor:null,items:[0,1].map(i=>({article_id:`browser-a${i}`,impression_id:randomUUID(),position:i+1,title:`브라우저 가상 기사 ${i}`,paragraphs:['실제 사용자의 선호가 아닌 검증 데이터입니다.'],category:'IT·과학',published_at:new Date().toISOString(),is_synthetic:true,is_liked:likes.has(`browser-a${i}`)}))};
  else if(req.method==='GET'&&req.url?.startsWith('/api/news/'))result={request_id:randomUUID(),served_at:new Date().toISOString(),content:{article_id:req.url.split('/')[3],title:'상세 기사',paragraphs:['검증용 가상 기사'],category:'IT·과학',published_at:new Date().toISOString(),is_synthetic:true,is_liked:likes.has(req.url.split('/')[3])}};
  else if(req.url?.endsWith('/like')){const id=decodeURIComponent(req.url.split('/')[3]),desired=req.method==='PUT',changed=likes.has(id)!==desired;if(desired)likes.add(id);else likes.delete(id);result={article_id:id,is_liked:desired,changed};}
  else{res.writeHead(404);res.end();return;}
  if(req.url==='/api/user/anonymous')res.setHeader('Set-Cookie',`news_reader=${result.reader_id}; Path=/; HttpOnly`);
  res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(result));
 }));
 const webPort=await reserve(),url=`http://127.0.0.1:${webPort}`;
 const web=createDevServer({root:fileURLToPath(new URL('../../',import.meta.url)),origin:url,backendBaseUrl:backend,logging:{url:loggingUrl,token}});
 web.listen(webPort,'127.0.0.1');await once(web,'listening');t.after(()=>new Promise(resolve=>web.close(resolve)));
 const browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHANNEL?{channel:process.env.PLAYWRIGHT_CHANNEL}:{})});t.after(()=>browser.close());
 const page=await browser.newPage();let lost=false;
 await page.route('**/api/behavior/events',async route=>{const body=route.request().postDataJSON();if(!lost&&body.events?.[0]?.event_type==='article_open'){lost=true;await route.fetch();await route.abort();}else await route.continue();});
 await page.goto(url);const card=page.locator('a.card').first();await card.waitFor();await card.scrollIntoViewIfNeeded();await page.waitForTimeout(750);
 await card.click();await page.locator('article.article-page').waitFor();
 const button=page.locator('article .like-button');await button.click();await page.waitForFunction(()=>document.querySelector('article .like-button')?.getAttribute('aria-pressed')==='true');
 await button.click();await page.waitForFunction(()=>document.querySelector('article .like-button')?.getAttribute('aria-pressed')==='false');
 const query=()=>JSON.parse(execFileSync(python,['-c',"import os,json;from logging_service.postgres import PostgresStore;s=PostgresStore(os.environ['LOGGING_DATABASE_URL']);print(json.dumps([dict(r) for r in s.db.execute(\"SELECT a.* FROM action_records a JOIN served_records s USING(impression_id) WHERE s.reader_id=%s\",(os.environ['FIXTURE_READER'],)).fetchall()]));s.close()"],{cwd:service,env:{...env,FIXTURE_READER:readerIds[0]},encoding:'utf8'}));
 let rows;
 for(let i=0;i<40;i++){rows=query();if(['exposure','article_open','like','unlike'].every(kind=>rows.some(r=>r.event_type===kind))&&await page.evaluate(()=>JSON.parse(sessionStorage.getItem('sai-news.behavior-pending')??'{}').entries?.length===0))break;await page.waitForTimeout(250);}
 assert(lost);assert(rows.some(r=>r.event_type==='exposure'&&r.duration_ms>0));assert.equal(rows.filter(r=>r.event_type==='article_open').length,1);assert.equal(rows.filter(r=>r.event_type==='like').length,1);assert.equal(rows.filter(r=>r.event_type==='unlike').length,1);assert(rows.every(r=>r.source==='browser'));
 // Forged reader/source headers cannot change the cookie-bound identity.
 const attacker=await browser.newContext();const response=await attacker.request.post(url+'/api/behavior/events',{headers:{Origin:url,'x-news-reader':readerIds[0]},data:{events:[JSON.parse(rows[0].canonical_json)]}});assert.equal(response.status(),403);await attacker.close();
 execFileSync(python,['-c','import sys;from datetime import datetime;from logging_service.interval_export import export_interval;export_interval(*(datetime.fromisoformat(t) for t in sys.argv[1:]))',intervalStart,new Date(Date.now()+1000).toISOString()],{cwd:service,env});
 const exported=JSON.parse(execFileSync(python,['-c',"import os,json,gzip;from logging_service.gcs import GCSSink;s=GCSSink(os.environ['GCS_BUCKET'],os.environ['GOOGLE_CLOUD_PROJECT'],os.environ['GCS_PREFIX']);files=[b for b in s.client.list_blobs(s.bucket,prefix=s.prefix) if b.name.endswith('.jsonl.gz')];print(json.dumps({'files':[b.name for b in files],'events':[json.loads(line)['event_id'] for b in files if '/actions/' in b.name for line in gzip.decompress(b.download_as_bytes()).splitlines()]}))"],{cwd:service,env,encoding:'utf8'}));
 assert(exported.files.every(name=>/interval_start=.*\/interval_end=.*\//.test(name)));for(const row of rows)assert(exported.events.includes(row.event_id));
});
