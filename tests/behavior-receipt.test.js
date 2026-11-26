import {test} from 'node:test';
import assert from 'node:assert/strict';
import {initializeBehavior,recordBehavior} from '../.local/src/behavior-events.js';
import {getBackendPage} from '../.local/src/backend-api.js';

test('feed receipt is carried by browser event and retained in its retry payload',async t=>{
 const reader='019a0000-0000-7000-8000-000000000001',requests=[],storage=new Map();
 t.mock.method(globalThis,'fetch',async(url,options)=>{
  if(url==='/api/behavior/status')return Response.json({enabled:true});
  if(url==='/api/v1/user/anonymous'||url==='/api/behavior/session')return Response.json({reader_id:reader});
  if(url==='/api/behavior/events'){
   const body=JSON.parse(options.body);requests.push(body);
   return Response.json({ack_stage:'pubsub',results:body.events.map(e=>({event_id:e.event_id,status:'accepted'}))});
  }
  throw new Error('unexpected route');
 });
 const previousWindow=globalThis.window,previousStorage=globalThis.sessionStorage;
 globalThis.window={addEventListener(){}};
 globalThis.sessionStorage={getItem:k=>storage.get(k)??null,setItem:(k,v)=>storage.set(k,v)};
 t.after(()=>{globalThis.window=previousWindow;globalThis.sessionStorage=previousStorage;});
 await initializeBehavior(()=>{});
 const payload={collection_enabled:true,collection_ack_stage:'pubsub',request_id:'req-test',served_at:new Date().toISOString(),next_cursor:null,
  items:[{article_id:'article-test',impression_id:'imp-test',position:1,title:'test',category:'test',published_at:new Date().toISOString(),is_synthetic:true,is_liked:false,served_receipt:'signed-fixture'}]};
 await getBackendPage(null,{getReaderId:async()=>reader,fetchImpl:async()=>Response.json(payload)});
 assert.equal(recordBehavior('article_open','imp-test'),true);
 const queued=JSON.parse(storage.get('sai-news.behavior-pending'));
 assert.equal(queued.entries[0].event.served_receipt,'signed-fixture');
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal(requests[0].events[0].served_receipt,'signed-fixture');
 assert.equal(JSON.parse(storage.get('sai-news.behavior-pending')).entries.length,0);
 delete payload.items[0].served_receipt;
 await assert.rejects(()=>getBackendPage(null,{getReaderId:async()=>reader,fetchImpl:async()=>Response.json(payload)}),/INVALID_SERVED_RECEIPT/);
});
