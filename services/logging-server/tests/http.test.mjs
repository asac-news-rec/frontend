import {test} from 'node:test';import assert from 'node:assert/strict';import {once} from 'node:events';import {mkdtempSync,rmSync} from 'node:fs';import os from 'node:os';import path from 'node:path';import {randomUUID} from 'node:crypto';
import {openLoggingStore} from '../repository.mjs';import {createLocalSink} from '../local-sink.mjs';import {createExporter} from '../exporter.mjs';import {createLoggingHttp} from '../http.mjs';
test('독립 HTTP 인증·커밋 ACK·중복·주기 FLUSH를 검증한다',async t=>{
 const dir=mkdtempSync(path.join(os.tmpdir(),'logging-http-')),token='test-only-logging-token-32chars';const store=openLoggingStore({database:path.join(dir,'db.sqlite')});const exporter=createExporter({store,sink:createLocalSink(path.join(dir,'objects'))});const server=createLoggingHttp({store,exporter,token});server.listen(0,'127.0.0.1');await once(server,'listening');const base=`http://127.0.0.1:${server.address().port}`;let timer;t.after(async()=>{clearInterval(timer);await new Promise(r=>server.close(r));store.close();rmSync(dir,{recursive:true,force:true});});
 const post=(route,body,headers={})=>fetch(base+route,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json',...headers},body:JSON.stringify(body)});
 assert.equal((await fetch(base+'/ready')).status,401);assert.equal((await fetch(base+'/health')).status,200);
 const id=randomUUID(),time=new Date().toISOString();let r=await post('/internal/served',{records:[{request_id:'req',impression_id:id,reader_id:'u1',article_id:'a1',position:1,served_at:time}]});assert.equal((await r.json()).results[0].status,'accepted');
 const body={events:[{event_id:randomUUID(),event_type:'article_open',event_time:time,impression_id:id,page_type:'list'}]},headers={'x-news-reader':'u1','x-collection-enabled':'true'};
 r=await post('/events',body,headers);assert.equal((await r.json()).results[0].status,'accepted');r=await post('/events',body,headers);assert.equal((await r.json()).results[0].status,'duplicate');assert.equal(store.counts().actions,1);
 timer=setInterval(()=>exporter.flush(),20);await new Promise(resolve=>setTimeout(resolve,80));assert.equal(store.exportJobs().length,0);assert.equal(store.allJobs().length,2);
 assert.equal((await post('/events',body)).status,400);
});
