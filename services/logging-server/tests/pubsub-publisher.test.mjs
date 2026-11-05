import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createPubSubPublisher} from '../pubsub-publisher.mjs';

test('발행 완료를 기다리고 이벤트 ID를 메시지에 보존한다',async()=>{
 const sent=[];
 const publisher=createPubSubPublisher({async publishMessage(message){sent.push(message);return 'message-1';}});
 const id='a964bf1d-4c32-48be-98b8-5fa4606b10c9';
 assert.equal(await publisher.publish({event_id:id,event_type:'like'}),'message-1');
 assert.equal(sent[0].attributes.event_id,id);
 assert.deepEqual(JSON.parse(sent[0].data.toString('utf8')),{event_id:id,event_type:'like'});
});

test('발행 실패를 성공으로 바꾸지 않는다',async()=>{
 const publisher=createPubSubPublisher({async publishMessage(){throw new Error('unavailable');}});
 await assert.rejects(publisher.publish({event_id:'x'}),/unavailable/);
});
