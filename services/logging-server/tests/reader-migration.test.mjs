import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {openLoggingStore} from '../repository.mjs';
import {createLocalSink} from '../local-sink.mjs';
import {createExporter} from '../exporter.mjs';
import {parseAction} from '../schema.mjs';

const hash=value=>createHash('sha256').update(value).digest('hex');

test('v3 독자·행동·철회 기록을 reader_id로 이전하고 재시도·기존 파일 복구를 유지한다',t=>{
 const dir=mkdtempSync(path.join(os.tmpdir(),'reader-migration-'));
 const database=path.join(dir,'inbox.sqlite');
 let store;
 t.after(()=>{store?.close();rmSync(dir,{recursive:true,force:true});});
 const at=Date.now(),time=new Date(at).toISOString();
 const legacy={request_id:'req-old',impression_id:'imp-old',user_id:'reader-A',article_id:'A',position:1,served_at:time};
 const event={event_id:randomUUID(),event_type:'article_open',event_time:time,impression_id:'imp-old',page_type:'list'};
 const raw=JSON.stringify(legacy),action=JSON.stringify(parseAction(event,at));
 const content=JSON.stringify({...legacy,received_at:time})+'\n';
 const object='served/date=2026-11-03/hour=09/minute=00/part-old-job.jsonl';
 const db=new DatabaseSync(database);
 db.exec(`
  CREATE TABLE served_records(impression_id TEXT PRIMARY KEY,request_id TEXT,user_id TEXT,article_id TEXT,position INTEGER,served_at TEXT,received_at TEXT,canonical_json TEXT,canonical_hash TEXT);
  CREATE INDEX served_user ON served_records(user_id);
  CREATE TABLE action_records(event_id TEXT PRIMARY KEY,impression_id TEXT REFERENCES served_records(impression_id),event_type TEXT,page_type TEXT,event_time TEXT,ended_at TEXT,duration_ms INTEGER,received_at TEXT,canonical_json TEXT,canonical_hash TEXT,source TEXT,schema_version INTEGER,measurement_version TEXT);
  CREATE TABLE export_jobs(job_id TEXT PRIMARY KEY,user_id TEXT,stream TEXT,partition_path TEXT,object_name TEXT UNIQUE,content TEXT,content_hash TEXT,row_count INTEGER,status TEXT DEFAULT 'prepared',attempts INTEGER DEFAULT 0,last_error TEXT,created_at TEXT,next_attempt_at INTEGER DEFAULT 0);
  CREATE TABLE export_members(stream TEXT,record_id TEXT,job_id TEXT REFERENCES export_jobs(job_id),PRIMARY KEY(stream,record_id));
  CREATE TABLE revoked_users(user_id TEXT PRIMARY KEY,revoked_at TEXT);
  PRAGMA user_version=3;
 `);
 db.prepare('INSERT INTO served_records VALUES(?,?,?,?,?,?,?,?,?)').run('imp-old','req-old','reader-A','A',1,time,time,raw,hash(raw));
 db.prepare('INSERT INTO action_records VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(event.event_id,'imp-old','article_open','list',time,null,null,time,action,hash(action),'browser',1,'stationary-visible-v1');
 db.prepare('INSERT INTO revoked_users VALUES(?,?)').run('reader-revoked',time);
 db.prepare('INSERT INTO export_jobs(job_id,user_id,stream,partition_path,object_name,content,content_hash,row_count,created_at) VALUES(?,?,?,?,?,?,?,?,?)')
  .run('old-job','reader-A','served','date=2026-11-03/hour=09/minute=00',object,content,hash(content),1,time);
 db.prepare('INSERT INTO export_members VALUES(?,?,?)').run('served','imp-old','old-job');
 db.close();
 const sink=createLocalSink(path.join(dir,'objects'));
 sink.put(object,content);

 store=openLoggingStore({database,now:()=>at});
 assert.deepEqual(store.counts(),{served:1,actions:1});
 assert.equal(store.getServed('imp-old').reader_id,'reader-A');
 assert.equal('user_id' in store.getServed('imp-old'),false);
 const {user_id,...other}=legacy;
 const served={...other,reader_id:user_id};
 assert.equal(store.intakeServed({internal:true},{records:[served]}).results[0].status,'duplicate');
 assert.equal(store.intakeActions({readerId:'reader-A',collectionEnabled:true},{events:[event]}).results[0].status,'duplicate');
 assert.throws(()=>store.intakeActions({readerId:'reader-revoked',collectionEnabled:true},{events:[event]}),/USER_REVOKED/);
 assert.equal(store.intakeServed({internal:true},{records:[legacy]}).results[0].status,'rejected');
 assert.equal(createExporter({store,sink}).flush(),2);
 assert.equal(readFileSync(path.join(dir,'objects',object),'utf8'),content);
 assert.equal(store.allJobs().find(j=>j.job_id==='old-job').reader_id,'reader-A');

 store.close();store=openLoggingStore({database,now:()=>at});
 assert.equal(store.intakeServed({internal:true},{records:[served]}).results[0].status,'duplicate');
 const inspector=new DatabaseSync(database);
 assert.equal(inspector.prepare('PRAGMA user_version').get().user_version,5);
 for(const table of ['served_records','export_jobs','revoked_users']){
  const columns=inspector.prepare(`PRAGMA table_info(${table})`).all().map(c=>c.name);
  assert.ok(columns.includes('reader_id'));
  assert.ok(!columns.includes('user_id'));
 }
 inspector.close();
});
