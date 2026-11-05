import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {openLoggingStore} from '../repository.mjs';
const now=()=>Date.parse('2026-11-02T00:10:00Z');
const served=(id='imp-1',user='u1')=>({impression_id:id,request_id:'req-1',reader_id:user,article_id:'a1',position:1,served_at:'2026-11-02T09:00:00+09:00'});
const event=(extra={})=>({event_id:randomUUID(),event_type:'article_open',event_time:'2026-11-02T00:00:03Z',impression_id:'imp-1',page_type:'list',...extra});
const context={readerId:'u1',collectionEnabled:true};
function fixture(t){const dir=mkdtempSync(path.join(os.tmpdir(),'news-logging-'));const database=path.join(dir,'inbox.sqlite');let store=openLoggingStore({database,now});t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});return {get store(){return store;},database,reopen(){store.close();store=openLoggingStore({database,now});return store;}};}
function seed(store){assert.equal(store.intakeServed({internal:true},{records:[served()]}).results[0].status,'accepted');}
test('영속 수신함은 재시작 후 유지되고 시간대·키 순서 차이는 중복으로 판정한다',t=>{
 const f=fixture(t);seed(f.store);const e=event();assert.equal(f.store.intakeActions(context,{events:[e]}).results[0].status,'accepted');
 f.reopen();assert.deepEqual(f.store.counts(),{served:1,actions:1});
 const reordered=Object.fromEntries(Object.entries({...e,event_time:'2026-11-02T09:00:03+09:00'}).reverse());
 assert.equal(f.store.intakeActions(context,{events:[reordered]}).results[0].status,'duplicate');
 assert.equal(f.store.getAction(e.event_id).received_at,'2026-11-02T00:10:00.000Z');
 assert.equal(f.store.intakeServed({internal:true},{records:[served()]}).results[0].status,'duplicate');
});
test('같은 ID의 다른 내용·배치 내 중복을 구분하고 다른 사용자를 거절한다',t=>{
 const {store}=fixture(t);seed(store);const e=event();
 assert.deepEqual(store.intakeActions(context,{events:[e,e,{...e,event_type:'like'}]}).results.map(r=>r.status),['accepted','duplicate','rejected']);
 assert.equal(store.intakeActions({...context,readerId:'u2'},{events:[e]}).results[0].code,'IMPRESSION_FORBIDDEN');
 assert.equal(store.intakeServed({internal:true},{records:[{...served(),article_id:'a2'}]}).results[0].code,'IMPRESSION_ID_CONFLICT');
 assert.deepEqual(store.counts(),{served:1,actions:1});
});
test('형식·시간·구간·허용 상태·내부 권한을 검사하고 미등록 추천 건은 재시도 가능하다',t=>{
 const {store}=fixture(t);seed(store);
 assert.throws(()=>store.intakeServed({}, {records:[served()]}),/INTERNAL_CONTEXT/);
 assert.throws(()=>store.intakeActions({...context,collectionEnabled:false},{events:[event()]}),/COLLECTION_DISABLED/);
 assert.throws(()=>store.intakeActions(context,{events:[]}),/INVALID_ENVELOPE/);
 const inputs=[event({event_id:'001'}),event({action:'article_open'}),event({event_time:'2026-02-30T00:00:00Z'}),event({event_time:'2026-11-02T10:00:00Z'}),event({event_time:'2026-11-02T00:00:00'}),event({event_type:'exposure',duration_ms:-1,ended_at:'2026-11-02T00:00:04Z'}),event({event_type:'exposure',duration_ms:1,ended_at:'2026-11-02T00:00:01Z'})];
 assert.ok(store.intakeActions(context,{events:inputs}).results.every(r=>r.status==='rejected'));
 const missing=event({impression_id:'missing'});assert.equal(store.intakeActions(context,{events:[missing]}).results[0].status,'retryable');
 store.intakeServed({internal:true},{records:[served('missing')]});assert.equal(store.intakeActions(context,{events:[missing]}).results[0].status,'accepted');
});
test('exposure는 정규화된 구간·분리된 서버 메타데이터로 저장된다',t=>{
 const {store}=fixture(t);seed(store);const e=event({event_type:'exposure',page_type:'list',duration_ms:3000,ended_at:'2026-11-02T09:00:06+09:00'});
 assert.equal(store.intakeActions(context,{events:[e]}).results[0].status,'accepted');
 const row=store.getAction(e.event_id);assert.equal(row.duration_ms,3000);assert.equal(row.ended_at,'2026-11-02T00:00:06.000Z');assert.equal(row.source,'browser');assert.equal(row.schema_version,1);
 assert.equal(JSON.parse(row.canonical_json).received_at,undefined);
 const close=event({event_id:randomUUID(),event_type:'article_close',page_type:'detail'});
 assert.equal(store.intakeActions(context,{events:[close]}).results[0].status,'accepted');
 assert.equal(store.getAction(close.event_id).duration_ms,null);
});
test('저장 오류는 배치 전체를 rollback하고 성공 결과를 반환하지 않는다',t=>{
 const {store,database}=fixture(t);seed(store);const broken=event();
 const db=new DatabaseSync(database);db.exec(`CREATE TRIGGER reject_test BEFORE INSERT ON action_records WHEN NEW.event_id='${broken.event_id}' BEGIN SELECT RAISE(ABORT,'forced storage failure'); END;`);db.close();
 assert.throws(()=>store.intakeActions(context,{events:[event(),broken]}),/forced storage failure/);assert.equal(store.counts().actions,0);
});
test('알 수 없는 미래 스키마를 자동 덮어쓰지 않는다',t=>{
 const dir=mkdtempSync(path.join(os.tmpdir(),'news-log-version-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));const database=path.join(dir,'future.sqlite');const db=new DatabaseSync(database);db.exec('PRAGMA user_version=99');db.close();
 assert.throws(()=>openLoggingStore({database,now}),/UNSUPPORTED_SCHEMA_VERSION/);
});
