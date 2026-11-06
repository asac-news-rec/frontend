import {test} from 'node:test';
import assert from 'node:assert/strict';
import {getBackendReaderId,getBackendPage,changeBackendLike} from '../src/backend-api.js';

const readerId='019a4c00-0000-7000-8000-000000000001';
const article=(position,id)=>({article_id:id,impression_id:`imp-${position}`,position,title:`기사 ${position}`,
 paragraphs:['본문'],category:'사회',published_at:'2026-11-04T01:30:00+00:00',is_synthetic:true,is_liked:position===1});

test('기존 브라우저 UUID7은 새 reader_id 저장 키로 옮겨 재사용한다',async()=>{
 const values=new Map([['sai-news.backend-user-id',readerId]]);
 const storage={getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,value)};
 const fetchImpl=async()=>{throw new Error('ID 재발급 금지');};
 assert.equal(await getBackendReaderId({storage,fetchImpl}),readerId);
 assert.equal(values.get('sai-news.backend-reader-id'),readerId);
});

test('백엔드 ID를 한 번 발급받고 다음 목록에 숫자 offset을 보낸다',async()=>{
 const values=new Map(),calls=[];
 const storage={getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,value)};
 const fetchImpl=async(url,options)=>{
  calls.push({url,method:options.method,body:options.body&&JSON.parse(options.body)});
  if(url.endsWith('/user/anonymous'))return {ok:true,json:async()=>({reader_id:readerId})};
  const offset=JSON.parse(options.body).offset;
  return {ok:true,json:async()=>({request_id:`req-${offset}`,served_at:'2026-11-04T01:30:00Z',
   items:offset===0?[article(1,'a1'),article(2,'a2')]:[article(3,'a3')],next_offset:offset===0?2:null})};
 };
 const getReaderId=()=>getBackendReaderId({storage,fetchImpl});
 const first=await getBackendPage(0,{fetchImpl,getReaderId});
 const second=await getBackendPage(first.nextOffset,{fetchImpl,getReaderId});
 assert.equal(await getReaderId(),readerId);
 assert.deepEqual(calls.map(call=>[call.url,call.body]),[
  ['/api/v1/backend/user/anonymous',undefined],
  ['/api/v1/backend/news/feed',{reader_id:readerId,offset:0}],
  ['/api/v1/backend/news/feed',{reader_id:readerId,offset:2}]]);
 assert.deepEqual([...first.items,...second.items].map(item=>item.rank),[1,2,3]);
 assert.deepEqual(first.items.map(item=>item.isLiked),[true,false]);
 assert.equal(second.nextOffset,null);
});

test('좋아요는 PUT·DELETE 본문에 reader_id만 보낸다',async()=>{
 const calls=[];
 const fetchImpl=async(url,options)=>{calls.push({url,method:options.method,body:JSON.parse(options.body)});
  return {ok:true,json:async()=>({article_id:'a1',is_liked:options.method==='PUT',changed:true})};};
 const change=(article,liked)=>changeBackendLike(article,liked,{fetchImpl,getReaderId:async()=>readerId});
 assert.deepEqual(await change('a1',true),{article_id:'a1',is_liked:true,changed:true});
 assert.deepEqual(await change('a1',false),{article_id:'a1',is_liked:false,changed:true});
 assert.deepEqual(calls,[
  {url:'/api/v1/backend/news/a1/like',method:'PUT',body:{reader_id:readerId}},
  {url:'/api/v1/backend/news/a1/like',method:'DELETE',body:{reader_id:readerId}}]);
});

test('잘못된 기사 응답과 좋아요 응답을 적용하지 않는다',async()=>{
 const feed=async()=>({ok:true,json:async()=>({request_id:'r',served_at:'2026-11-04T01:30:00Z',items:[{...article(1,'a1'),is_liked:null}],next_offset:null})});
 await assert.rejects(getBackendPage(0,{fetchImpl:feed,getReaderId:async()=>readerId}),/INVALID_BACKEND_ARTICLE/);
 const like=async()=>({ok:true,json:async()=>({article_id:'a1',is_liked:true})});
 await assert.rejects(changeBackendLike('a1',true,{fetchImpl:like,getReaderId:async()=>readerId}),/INVALID_BACKEND_LIKE/);
});

test('피드 응답에 reader_id가 있으면 요청 독자와 일치해야 한다',async()=>{
 const feed=async()=>({ok:true,json:async()=>({reader_id:'other-reader',request_id:'r',served_at:'2026-11-04T01:30:00Z',items:[],next_offset:null})});
 await assert.rejects(getBackendPage(0,{fetchImpl:feed,getReaderId:async()=>readerId}),/INVALID_BACKEND_FEED/);
});
