import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ackState,selectClicks,validFeed,dataset,origin,integer} from '../scripts/logging-load/model.mjs';
test('k6 ACK rejects unrelated IDs, partial and rejected responses',()=>{
 const ack=status=>({results:[{event_id:'id',status}]});
 assert.equal(ackState(200,ack('accepted'),'id'),'accepted');
 assert.equal(ackState(200,ack('duplicate'),'id'),'duplicate');
 assert.equal(ackState(200,ack('accepted'),'other'),'retry');
 assert.equal(ackState(200,ack('rejected'),'id'),'fatal');
 assert.equal(ackState(200,{results:[]},'id'),'retry');
 assert.equal(ackState(403,null,'id'),'fatal');
 assert.equal(ackState(503,null,'id'),'retry');
});
test('rank and explicit article mapping never fabricate an impression',()=>{
 const s={offered_article_keys:['a','b'],clicks:[{article_key:'b'}]};
 const items=[{article_id:'real-b',impression_id:'i1'},{article_id:'real-a',impression_id:'i2'}];
 assert.equal(selectClicks(s,items,[],'rank')[0],items[1]);
 assert.equal(selectClicks(s,items,[{article_key:'b',backend_article_id:'real-b'}],'mapped')[0],items[0]);
 assert.throws(()=>selectClicks(s,items,[],'mapped'),/MAPPING_REQUIRED/);
 assert.throws(()=>selectClicks(s,items.slice(0,1),[],'rank'),/NOT_IN_FEED/);
});
test('feed success requires enabled collection and valid unique impressions',()=>{
 const f={collection_enabled:true,request_id:'r',served_at:new Date().toISOString(),items:[{article_id:'a',impression_id:'i',position:1}]};
 assert(validFeed(f,'reader'));assert(!validFeed({...f,collection_enabled:false},'reader'));
 assert(!validFeed({...f,reader_id:'other'},'reader'));
 assert(!validFeed({...f,items:[...f.items,...f.items]},'reader'));
});
test('input ownership, target origin and bounds are validated',()=>{
 const p={metadata:{run_id:'r'},sessions:[{session_key:'s',reader_key:'reader',offered_article_keys:['a'],clicks:[]}]};
 const m={run_id:'r',readers:[{reader_key:'reader'}],articles:[{article_key:'a'}]};
 assert.equal(dataset(p,m).groups.length,1);
 assert.throws(()=>dataset(p,{...m,run_id:'different'}),/MISMATCH/);
 assert.throws(()=>dataset(p,{...m,readers:[{reader_key:'other'}]}),/UNKNOWN_READER/);
 assert.equal(origin('http://127.0.0.1:4173/'),'http://127.0.0.1:4173');
 assert.throws(()=>origin('https://user:secret@example.com'),/ORIGIN/);
 assert.throws(()=>origin('http://example.com'),/HTTPS/);
 assert.throws(()=>integer('NaN',1,1,10));
});

test('remote targets require explicit opt-in even for smoke runs',()=>{
 for(const host of ['localhost','127.0.0.1','[::1]']){
  assert.equal(origin('http://'+host+':4173'),'http://'+host+':4173');
  assert.equal(origin('https://'+host),'https://'+host);
 }
 for(const host of ['example.com','localhost.example.com','127.0.0.1.example.com']){
  for(const flag of [undefined,'0','true',1])assert.throws(()=>origin('https://'+host,flag),/ALLOW_REMOTE_LOAD/);
  assert.equal(origin('https://'+host+'/', '1'),'https://'+host);
 }
 assert.throws(()=>origin('http://example.com','1'),/HTTPS/);
 assert.throws(()=>origin('https://user:secret@example.com','1'),/ORIGIN/);
});
