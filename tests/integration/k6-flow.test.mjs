// Real k6 + actual Node cookie/proxy code, with strict in-memory HTTP fixtures.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {randomUUID,createHmac} from 'node:crypto';
import {spawn} from 'node:child_process';
import {mkdtemp,writeFile,readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createDevServer} from '../../.local/server/dev-http.js';

for(const mode of ['database','pubsub'])test(`k6 maintains cookies, replays lost ACK, and stops on outage (${mode})`,{skip:!process.env.K6_BIN,timeout:90000},async t=>{
 const root=resolve('.');
 const dir=await mkdtemp(resolve('data/k6-integration-'));
 const patterns=resolve(dir,'patterns.json'),mapping=resolve(dir,'mapping.json');
 await writeFile(patterns,JSON.stringify({metadata:{run_id:'fixture'},sessions:[{session_key:'s',reader_key:'r',offered_article_keys:['a'],clicks:[{article_key:'a'}]}]}));
 await writeFile(mapping,JSON.stringify({run_id:'fixture',readers:[{reader_key:'r'}],articles:[{article_key:'a'}]}));
 const listen=async server=>{server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>new Promise(r=>server.close(r)));return `http://127.0.0.1:${server.address().port}`;};
 const token=randomUUID(),secret=randomUUID();let issued=0,lose=true,unavailable=false,duplicate=0;
 const offered=new Map(),actions=new Map(),feedReaders=[];
 const sign=id=>createHmac('sha256',secret).update(id).digest('hex');
 const decode=req=>{const value=/news_reader=([^;]+)/.exec(req.headers.cookie||'')?.[1];if(!value)return null;const [id,sig]=value.split('.');return sign(id)===sig?id:null;};
 const reply=(res,status,value)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(value));};
 const logging=await listen(createServer(async(req,res)=>{
  assert.equal(req.headers.authorization,'Bearer '+token);
  const chunks=[];for await(const c of req)chunks.push(c);const body=JSON.parse(Buffer.concat(chunks));
  if(req.url==='/internal/served'){
   if(unavailable)return reply(res,503,{});
   for(const row of body.records)offered.set(row.impression_id,row);
   return reply(res,200,{...(mode==='pubsub'?{ack_stage:'pubsub'}:{}),results:body.records.map(r=>({impression_id:r.impression_id,status:'accepted',...(mode==='pubsub'?{served_receipt:sign(r.impression_id)}:{})}))});
  }
  assert.equal(req.url,'/events');assert.equal(req.headers['x-news-source'],'browser');
  const results=body.events.map(e=>{
   assert.equal(offered.get(e.impression_id)?.reader_id,req.headers['x-news-reader']);
   if(mode==='pubsub')assert.equal(e.served_receipt,sign(e.impression_id));
   const old=actions.get(e.event_id);if(old){assert.deepEqual(old,e);duplicate++;}else actions.set(e.event_id,e);
   return {event_id:e.event_id,status:old&&mode==='database'?'duplicate':'accepted'};
  });
  if(lose){lose=false;return reply(res,503,{});} // Stored, but ACK is lost to the client.
  reply(res,200,{results,...(mode==='pubsub'?{ack_stage:'pubsub'}:{})});
 }));
 const backend=await listen(createServer(async(req,res)=>{
  let id=decode(req);
  if(req.url==='/api/v1/user/anonymous'){
   if(!id){id=`019a0000-0000-7000-8000-${String(++issued).padStart(12,'0')}`;res.setHeader('Set-Cookie',`news_reader=${id}.${sign(id)}; Path=/; HttpOnly`);}
   return reply(res,200,{reader_id:id});
  }
  if(!id)return reply(res,401,{});
  assert.equal(req.url,'/api/v1/news/feed');feedReaders.push(id);
  reply(res,200,{request_id:randomUUID(),served_at:new Date().toISOString(),next_cursor:null,items:[{article_id:'fixture-article',impression_id:randomUUID(),position:1}]});
 }));
 const reserve=createServer();reserve.listen(0,'127.0.0.1');await once(reserve,'listening');const port=reserve.address().port;await new Promise(r=>reserve.close(r));
 const base=`http://127.0.0.1:${port}`;
 const web=createDevServer({root,origin:base,backendBaseUrl:backend,logging:{url:logging,token}});
 web.listen(port,'127.0.0.1');await once(web,'listening');t.after(()=>new Promise(r=>web.close(r)));
 const run=async(name,visits,mode='smoke')=>{
  const summary=resolve(dir,name+'.json');
  const child=spawn(process.env.K6_BIN,['run','--quiet','scripts/logging-load/browser-flow.k6.js'],{env:{...process.env,BASE_URL:base,PATTERNS:patterns,MAPPING:mapping,VUS:'2',VISITS:String(visits),MODE:mode,RATE:'2',DURATION_SECONDS:'2',MAX_VUS:'2',SELECTION:'rank',PAUSE_MS:'0',SUMMARY_PATH:summary,AUDIT:'0',K6_NO_USAGE_REPORT:'true'},stdio:['ignore','pipe','pipe']});
  let output='';child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);
  const kill=setTimeout(()=>child.kill(),45000);const [code]=await once(child,'close');clearTimeout(kill);
  const result=await readFile(summary,'utf8').catch(()=>{throw new Error(`k6 exited ${code}: ${output}`);});
  return {code,output,summary:JSON.parse(result)};
 };
 const good=await run('success',2);assert.equal(good.code,0,good.output);
 assert.equal(issued,2);assert.equal(offered.size,4);assert.equal(actions.size,4);assert.equal(duplicate,1);
 assert.equal(new Set(feedReaders).size,2);assert.equal(good.summary.metrics.completed_visits.values.count,4);
 assert.equal(good.summary.metrics.events_duplicate?.values.count??0,mode==='database'?1:0);
 const load=await run('arrival-rate',1,'load');assert.equal(load.code,0,load.output);
 const arrivals=load.summary.metrics.completed_visits.values.count;
 assert(arrivals>=4&&arrivals<=5); // A visit on the duration boundary is scheduler-dependent.
 assert.equal(actions.size,4+arrivals);
 unavailable=true;const before=actions.size;const bad=await run('outage',1);
 assert.notEqual(bad.code,0);assert.equal(actions.size,before);
 assert.equal(bad.summary.database_verified,false);
});
