import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createSegments} from '../src/exposure-segments.js';

test('목록 노출은 종료 시 한 번 기록하고 반복 노출은 새 이벤트를 쓴다',()=>{
 let time=0,id=0;const events=[];
 const segments=createSegments({emit:event=>events.push(event),now:()=>time,
  timestamp:()=>new Date(time).toISOString(),uuid:()=>String(++id)});
 segments.start('imp');time=200;segments.stop('imp');segments.stop('imp');
 segments.start('imp');time=800;segments.stopAll();
 assert.deepEqual(events.map(event=>event.duration_ms),[200,600]);
 assert.deepEqual(events.map(event=>event.page_type),['list','list']);
 assert.notEqual(events[0].event_id,events[1].event_id);
});

test('활성 목록 노출은 시간이 지나도 주기적으로 전송하지 않는다',()=>{
 let time=0;const events=[];
 const segments=createSegments({emit:event=>events.push(event),now:()=>time,
  timestamp:()=>new Date(time).toISOString(),uuid:()=>crypto.randomUUID()});
 segments.start('imp');time=30000;assert.equal(events.length,0);
 segments.stopAll();assert.equal(events.length,1);
 assert.equal(events[0].duration_ms,30000);
});
