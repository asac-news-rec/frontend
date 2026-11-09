import test from 'node:test';
import assert from 'node:assert/strict';
import {createVisitorFeed} from '../.local/server/feed.js';
test('방문자별 좋아요가 추천 순서와 근거를 바꾸며 미래 기사는 제외한다',()=>{
 const tech=createVisitorFeed({readerId:'tech',likedIds:['a1']});
 const sport=createVisitorFeed({readerId:'sport',likedIds:['a3']});
 assert.notEqual(tech.items[0].article.id,sport.items[0].article.id);
 assert.equal(sport.items[0].article.category,'스포츠');
 assert.ok(sport.items[0].reason.includes('스포츠'));
 assert.equal(new Set(tech.items.map(item=>item.article.id)).size,tech.items.length);
 const past=createVisitorFeed({now:Date.parse('2026-10-28T20:30:00Z'),likedIds:['a1']});
 assert.equal(past.strategy,'latest');assert.ok(past.items.every(item=>item.article.publishedAt<=past.generatedAt));
 assert.ok(past.items.every((item,index,all)=>index===0||all[index-1].article.publishedAt>=item.article.publishedAt));
});
