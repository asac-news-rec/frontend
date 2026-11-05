import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createEventTransport} from '../src/event-transport.js';
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const event=()=>({event_id:crypto.randomUUID(),event_type:'like',impression_id:'mock',page_type:'list',event_time:new Date().toISOString()});
function setup(send,extra={}){const tasks=new Map();let id=0;const states=[];
 const t=createEventTransport({send,notify:s=>states.push(s),schedule:(fn,ms)=>{tasks.set(++id,{fn,ms});return id;},cancel:id=>tasks.delete(id),retryDelay:()=>1,...extra});t.start();return {t,tasks,states};}
test('즉시 전송하고 응답 유실 시 같은 ID·내용으로 재전송해 중복 수락을 확인한다',async()=>{
 const calls=[],stored=new Set();const {t}=setup(async body=>{calls.push(body);const id=body.events[0].event_id;if(!stored.has(id)){stored.add(id);throw new Error('response lost');}return {results:[{event_id:id,status:'duplicate'}]};});
 const e=event();t.enqueue(e);assert.equal(calls.length,1);e.event_type='unlike';await tick();assert.equal(t.pendingCount,1);t.retry();await tick();assert.equal(t.pendingCount,0);assert.deepEqual(calls[0],calls[1]);assert.equal(stored.size,1);t.stop();
});
test('중단 전 응답은 재시작한 큐에 영향이 없고 같은 ID 동시 전송을 막는다',async()=>{
 let release;let calls=0;const {t}=setup(body=>{calls++;return new Promise(resolve=>{release=()=>resolve({results:[{event_id:body.events[0].event_id,status:'accepted'}]});});});
 t.enqueue(event());t.retry();assert.equal(calls,1);const late=release;t.stop();t.start();t.enqueue(event());late();await tick();assert.equal(t.pendingCount,1);release();await tick();assert.equal(t.pendingCount,0);t.stop();
});
test('ACK 누락은 재시도, 영구 거절은 제거, 만료와 보관 한도를 지킨다',async()=>{
 let now=0;const {t,states}=setup(async()=>({results:[]}),{now:()=>now,ttl:10,limit:1});
 t.enqueue(event());await tick();assert.equal(t.pendingCount,1);t.enqueue(event());await tick();assert.ok(states.some(s=>s.type==='dropped'));now=11;t.retry();assert.equal(t.pendingCount,0);assert.ok(states.some(s=>s.type==='expired'));t.stop();
 const rejected=setup(async body=>({results:[{event_id:body.events[0].event_id,status:'rejected'}]}));rejected.t.enqueue(event());await tick();assert.equal(rejected.t.pendingCount,0);rejected.t.stop();
});

test('timeout 뒤 늦은 ACK는 무시하고 동일 이벤트 재시도를 수락한다',async()=>{
 const releases=[];const {t,tasks}=setup(body=>new Promise(resolve=>releases.push(()=>resolve({results:[{event_id:body.events[0].event_id,status:'accepted'}]}))));
 t.enqueue(event());const deadline=[...tasks.values()].find(v=>v.ms===10000);deadline.fn();t.retry();releases[0]();await tick();assert.equal(t.pendingCount,1);releases[1]();await tick();assert.equal(t.pendingCount,0);t.stop();
});
