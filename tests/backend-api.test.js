import {test} from 'node:test';
import assert from 'node:assert/strict';
import {getBackendArticle,getBackendReaderId,getBackendPage,getBackendCategories,getBackendSubcategories,changeBackendLike} from '../.local/src/backend-api.js';

const readerId='019a4c00-0000-7000-8000-000000000001';
const article=(position,id)=>({article_id:id,impression_id:`imp-${position}`,position,title:`기사 ${position}`,
 category:'사회',published_at:'2026-11-04T01:30:00+00:00',is_synthetic:true,is_liked:position===1});

const cursor={published_at:'2026-11-04T01:30:00Z',article_id:'a2',returned_count:2};

test('first feed bootstraps once and passes the backend cursor back unchanged',async()=>{
 const calls=[];
 const fetchImpl=async(url,options)=>{
  const body=options.body&&JSON.parse(options.body);
  calls.push([url,body]);
  if(url.endsWith('/api/v1/user/anonymous'))return Response.json({reader_id:readerId});
  return Response.json({request_id:'req',served_at:cursor.published_at,
   items:body.cursor?[article(3,'a3')]:[article(1,'a1'),article(2,'a2')],
   next_cursor:body.cursor?null:cursor});
 };
 const getReaderId=()=>getBackendReaderId({fetchImpl});
 const first=await getBackendPage(null,{fetchImpl,getReaderId});
 const second=await getBackendPage(first.nextCursor,{fetchImpl,getReaderId});
 assert.deepEqual(calls,[['/api/v1/user/anonymous',undefined],['/api/v1/news/feed',{}],['/api/v1/news/feed',{cursor}]]);
 assert.deepEqual([...first.items,...second.items].map(item=>item.rank),[1,2,3]);
 assert.deepEqual(first.items.map(item=>item.isLiked),[true,false]);
 assert.equal(second.nextCursor,null);
});

test('카테고리·소분류와 동일 필터의 다음 페이지를 요청한다',async()=>{
 const calls=[];
 const fetchImpl=async(url,options)=>{
  calls.push({url,body:options.body&&JSON.parse(options.body)});
  const payload=url.endsWith('/api/v1/category')?{category_list:['정치']}:url.endsWith('/api/v1/subcategory')?{sub_category_list:['국회']}:
   {request_id:'req',served_at:'2026-11-04T01:30:00Z',items:[article(1,'a1')],next_cursor:cursor};
  return {ok:true,json:async()=>payload};
 };
 assert.deepEqual(await getBackendCategories({fetchImpl}),['정치']);
 assert.deepEqual(await getBackendSubcategories('정치',{fetchImpl}),['국회']);
 const filters={category:'정치',subcategory:'국회'};
 const first=await getBackendPage(null,{fetchImpl,getReaderId:async()=>readerId,filters});
 await getBackendPage(first.nextCursor,{fetchImpl,getReaderId:async()=>readerId,filters});
 assert.deepEqual(calls.map(({url,body})=>[url,body]),[
  ['/api/v1/category',undefined],
  ['/api/v1/subcategory',{category:'정치'}],
  ['/api/v1/news/feed',filters],
  ['/api/v1/news/feed',{cursor,...filters}]]);
});

test('좋아요는 PUT·DELETE 요청 본문을 생략한다',async()=>{
 const calls=[];
 const fetchImpl=async(url,options)=>{calls.push({url,method:options.method,body:options.body});
  return {ok:true,json:async()=>({article_id:'a1',is_liked:options.method==='PUT',changed:true})};};
 const change=(article,liked)=>changeBackendLike(article,liked,{fetchImpl,getReaderId:async()=>readerId});
 assert.deepEqual(await change('a1',true),{article_id:'a1',is_liked:true,changed:true});
 assert.deepEqual(await change('a1',false),{article_id:'a1',is_liked:false,changed:true});
 assert.deepEqual(calls,[
  {url:'/api/v1/news/a1/like',method:'PUT',body:undefined},
  {url:'/api/v1/news/a1/like',method:'DELETE',body:undefined}]);
});

test('잘못된 기사 응답과 좋아요 응답을 적용하지 않는다',async()=>{
 const feed=async()=>({ok:true,json:async()=>({request_id:'r',served_at:'2026-11-04T01:30:00Z',items:[{...article(1,'a1'),is_liked:null}],next_cursor:null})});
 await assert.rejects(getBackendPage(null,{fetchImpl:feed,getReaderId:async()=>readerId}),/INVALID_BACKEND_ARTICLE/);
 const like=async()=>({ok:true,json:async()=>({article_id:'a1',is_liked:true})});
 await assert.rejects(changeBackendLike('a1',true,{fetchImpl:like,getReaderId:async()=>readerId}),/INVALID_BACKEND_LIKE/);
});

test('피드 응답에 reader_id가 있으면 요청 독자와 일치해야 한다',async()=>{
 const feed=async()=>({ok:true,json:async()=>({reader_id:'other-reader',request_id:'r',served_at:'2026-11-04T01:30:00Z',items:[],next_cursor:null})});
 await assert.rejects(getBackendPage(null,{fetchImpl:feed,getReaderId:async()=>readerId}),/INVALID_BACKEND_FEED/);
});

test('상세는 GET으로 본문을 조회하고 목록 노출 식별자를 만들지 않는다',async()=>{
 const calls=[];const content={...article(1,'a/1'),paragraphs:['첫 문단','둘째 문단']};
 const result=await getBackendArticle('a/1',{getReaderId:async()=>readerId,fetchImpl:async(url,options)=>{
  calls.push({url,...options});return Response.json({request_id:'detail-request',served_at:cursor.published_at,content});
 }});
 assert.equal(result.article.body,'첫 문단\n\n둘째 문단');
 assert.equal(result.article.impressionId,undefined);
 assert.equal(result.isLiked,true);
 assert.equal(calls[0].url,'/api/v1/news/a%2F1');
 assert.equal(calls[0].method,'GET');assert.equal(calls[0].body,undefined);
 assert.equal(calls[0].credentials,'same-origin');
});

test('상세의 잘못된 기사 ID·본문과 HTTP 오류를 거절한다',async()=>{
 const load=content=>getBackendArticle('a1',{getReaderId:async()=>readerId,fetchImpl:async()=>Response.json({request_id:'detail',served_at:cursor.published_at,content})});
 await assert.rejects(load({...article(1,'other'),paragraphs:['본문']}),/INVALID_BACKEND_DETAIL/);
 await assert.rejects(load({...article(1,'a1'),paragraphs:[null]}),/INVALID_BACKEND_DETAIL/);
 for(const status of [401,404,503])await assert.rejects(getBackendArticle('a1',{getReaderId:async()=>readerId,fetchImpl:async()=>new Response('{}',{status})}),new RegExp(`BACKEND_HTTP_${status}`));
});
