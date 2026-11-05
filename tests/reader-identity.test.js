import {test} from 'node:test';
import assert from 'node:assert/strict';
import {getPersistentReaderId,readerStorageKey} from '../src/reader-identity.js';

const first='550e8400-e29b-41d4-a716-446655440001';
function storage(){const values=new Map();return {getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,value),clear:()=>values.clear()};}

test('독자 ID는 처음 한 번 저장하고 새로고침·다른 탭에서도 저장된 값을 재사용한다',async()=>{
 const saved=storage();let generated=0;
 assert.equal(await getPersistentReaderId({storage:saved,generate:()=>{generated++;return first;}}),first);
 assert.equal(await getPersistentReaderId({storage:saved,generate:()=>{throw new Error('must not generate');}}),first);
 assert.equal(await getPersistentReaderId({storage:saved,generate:()=>{throw new Error('must not generate');}}),first);
 assert.equal(generated,1);
 assert.equal(saved.getItem(readerStorageKey),first);
});

test('동시 첫 접속은 브라우저 잠금 안에서 같은 독자를 읽는다',async()=>{
 const saved=storage();let tail=Promise.resolve(),generated=0;
 const locks={request:(_name,action)=>{const result=tail.then(action);tail=result.catch(()=>{});return result;}};
 const create=()=>getPersistentReaderId({storage:saved,locks,generate:()=>{generated++;return first;}});
 assert.deepEqual(await Promise.all([create(),create()]),[first,first]);assert.equal(generated,1);
});

test('저장 차단·실패·손상된 ID에서는 임시 독자를 만들지 않고 오류를 알린다',async()=>{
 for(const saved of [
  {getItem:()=>{throw new Error('blocked');}},
  {getItem:()=>null,setItem:()=>{throw new Error('quota');}},
  {getItem:()=>null,setItem:()=>{}},
  {getItem:()=> 'invalid',setItem:()=>{throw new Error('must not overwrite');}}
 ])await assert.rejects(getPersistentReaderId({storage:saved,generate:()=>first}),/독자 정보를 유지할 수 없습니다/);
});

test('사이트 데이터를 삭제한 뒤에는 새 독자를 생성한다',async()=>{
 const saved=storage();await getPersistentReaderId({storage:saved,generate:()=>first});saved.clear();
 const next='550e8400-e29b-41d4-a716-446655440002';
 assert.equal(await getPersistentReaderId({storage:saved,generate:()=>next}),next);
});
