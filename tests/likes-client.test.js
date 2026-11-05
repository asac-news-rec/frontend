import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createLikesApi,createMemoryLikesApi,createLikeState} from '../src/likes-client.js';

const record={reader_id:'reader',article_id:'a1',liked_at:'2026-11-03T01:00:00Z'};
test('좋아요 클라이언트는 객체·배열을 검증하고 204 본문은 읽지 않는다',async()=>{
 const calls=[];
 const api=createLikesApi({fetchImpl:async(url,options)=>{
  calls.push({url,...options});
  return {status:options.method==='DELETE'?204:200,json:async()=>{assert.notEqual(options.method,'DELETE');return options.method==='GET'?[record]:record;}};
 }});
 assert.deepEqual(await api.list('reader'),[record]);
 assert.deepEqual(await api.add('reader','a1'),record);
 await api.remove('reader','a1');
 assert.equal(calls[0].url,'/api/v1/likes?reader_id=reader');
 assert.deepEqual(calls.slice(1).map(call=>[call.method,JSON.parse(call.body)]),[['POST',{reader_id:'reader',article_id:'a1'}],['DELETE',{reader_id:'reader',article_id:'a1'}]]);
 for(const data of [{...record,reader_id:'other'},{...record,article_id:'other'},{...record,liked_at:'invalid'},{data:record}]){
  const invalid=createLikesApi({fetchImpl:async()=>({status:200,json:async()=>data})});
  await assert.rejects(invalid.add('reader','a1'),/INVALID_LIKE_RESPONSE/);
 }
});

test('조회·저장 실패는 로그를 만들지 않고 성공 뒤에만 원래 클릭 문맥을 전달한다',async()=>{
 const events=[];let finish,fail=false;
 const memory=createMemoryLikesApi();
 const api={...memory,add:async(...args)=>{await new Promise(resolve=>finish=resolve);if(fail)throw new Error('offline');return memory.add(...args);},remove:async(...args)=>{if(fail)throw new Error('offline');return memory.remove(...args);}};
 const state=createLikeState({api,confirmed:event=>events.push(event)});
 await state.refresh('reader');assert.deepEqual(events,[]);
 const context={impression_id:'original',page_type:'list',event_time:record.liked_at};
 const pending=state.toggle('reader','a1',context);
 assert.equal(state.has('a1'),false);assert.deepEqual(events,[]);
 finish();await pending;
 assert.equal(state.has('a1'),true);assert.deepEqual(events,[{...context,article_id:'a1',liked:true}]);
 fail=true;await assert.rejects(state.toggle('reader','a1',context));assert.equal(state.has('a1'),true);assert.equal(events.length,1);
 fail=false;await state.toggle('reader','a1',context);assert.equal(state.has('a1'),false);assert.equal(events[1].liked,false);
 fail=true;const failed=state.toggle('reader','a1',context);finish();await assert.rejects(failed);assert.equal(state.has('a1'),false);assert.equal(events.length,2);
 await state.refresh('reader');assert.equal(events.length,2);
});

test('독자가 바뀐 뒤 도착한 이전 저장 응답은 상태·로그에 적용하지 않는다',async()=>{
 let finish;const events=[];
 const api={list:async()=>[],add:async()=>{await new Promise(resolve=>finish=resolve);return record;}};
 const state=createLikeState({api,confirmed:event=>events.push(event)});
 await state.refresh('reader');const pending=state.toggle('reader','a1',{});
 state.reset();await state.refresh('other');finish();await pending;
 assert.equal(state.has('a1'),false);assert.deepEqual(events,[]);
});
