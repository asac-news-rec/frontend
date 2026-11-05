import {test} from 'node:test';
import assert from 'node:assert/strict';
import {getContractPage,acceptContractItems,getContractArticle} from '../src/contract-feed.js';
test('피드 어댑터는 문단과 추천 문맥을 유지하고 cursor로 다음 기사를 반환한다',async t=>{
 const values=new Map();
 const previous=Object.getOwnPropertyDescriptor(globalThis,'window');
 Object.defineProperty(globalThis,'window',{configurable:true,value:{localStorage:{getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,value)}}});
 t.after(()=>{if(previous)Object.defineProperty(globalThis,'window',previous);else delete globalThis.window;});
 const first=await getContractPage();acceptContractItems(first.items);
 const a=getContractArticle(first.items[0].article.id);
 assert.deepEqual(a.paragraphs,['화면 검증용 첫 번째 문단입니다.','실제 보도가 아닌 가상 본문입니다.']);
 assert.equal(a.impressionId,first.items[0].impressionId);assert.equal(a.requestId,first.requestId);
 assert.equal(a.imageUrl,null);assert.equal(a.publisher,'시연 편집부');
 const second=await getContractPage(first.nextOffset);assert.equal(second.nextOffset,null);
 assert.equal(new Set([...first.items,...second.items].map(i=>i.article.id)).size,6);
 assert.equal(getContractArticle('missing'),null);
});
