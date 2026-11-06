import test from 'node:test';
import assert from 'node:assert/strict';
import {createSampleFeed,getFeed} from '../dist/src/service.js';
test('독자별 첫 기사와 추천 근거가 다르다',()=>{
  const tech=createSampleFeed('reader-tech'),sport=createSampleFeed('reader-sport');
  assert.notEqual(tech.items[0].article.id,sport.items[0].article.id);
  assert.match(tech.items[0].reason,/IT·과학/);assert.match(sport.items[0].reason,/스포츠/);
});
test('신규 독자는 최신순 기본 피드이며 기사와 순위가 중복되지 않는다',()=>{
  const feed=createSampleFeed('reader-new');assert.equal(feed.strategy,'latest');
  assert.equal(new Set(feed.items.map(x=>x.article.id)).size,feed.items.length);
  assert.ok(feed.items.every((x,i,a)=>i===0||a[i-1].article.publishedAt>=x.article.publishedAt));
});
test('카테고리 필터가 다른 주제 기사를 제외한다',()=>{
  const feed=createSampleFeed('reader-tech','스포츠');assert.equal(feed.items.length,2);assert.ok(feed.items.every(x=>x.article.category==='스포츠'));
});
test('시연 오류는 거절되고 빈 결과와 복구는 구분된다',async()=>{
  await assert.rejects(getFeed('reader-tech','전체','error'));
  assert.equal((await getFeed('reader-tech','전체','empty')).items.length,0);
  assert.ok((await getFeed('reader-tech','전체','normal')).items.length>0);
});

import {getFeedPage} from '../dist/src/service.js';
test('페이지를 끝까지 읽으면 전체 기사가 중복 없이 표시되고 종료된다',async()=>{
  const ids=[];let offset=0;
  do {const page=await getFeedPage('reader-tech','전체','normal',offset);ids.push(...page.items.map(item=>item.article.id));offset=page.nextOffset;}while(offset!==null);
  assert.equal(ids.length,8);assert.equal(new Set(ids).size,8);
});
