import {randomUUID} from 'node:crypto';
import {partitionPath,digest} from './partition.mjs';
import {DatabaseSync} from 'node:sqlite';
import {mkdirSync} from 'node:fs';
import path from 'node:path';
import {InputError,parseServed,parseAction,parseEnvelope,canonical,contextReader} from './schema.mjs';
const reject=(id,code,status='rejected')=>({event_id:id,status,code});
export function openLoggingStore({database,now=Date.now}) {
 if(database!==':memory:')mkdirSync(path.dirname(database),{recursive:true});
 const db=new DatabaseSync(database);
 try{
  db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;');
  const version=db.prepare('PRAGMA user_version').get().user_version;
  if(version>5)throw new Error('UNSUPPORTED_SCHEMA_VERSION');
  if(version===0){
   db.exec('BEGIN IMMEDIATE');
   try{db.exec(`
    CREATE TABLE served_records (
     impression_id TEXT PRIMARY KEY,request_id TEXT NOT NULL,user_id TEXT NOT NULL,
     article_id TEXT NOT NULL,position INTEGER NOT NULL CHECK(position>0),served_at TEXT NOT NULL,
     received_at TEXT NOT NULL,canonical_json TEXT NOT NULL,canonical_hash TEXT NOT NULL
    ) STRICT;
    CREATE INDEX served_user ON served_records(user_id);
    CREATE TABLE action_records (
     event_id TEXT PRIMARY KEY,impression_id TEXT NOT NULL REFERENCES served_records(impression_id),
     event_type TEXT NOT NULL CHECK(event_type IN ('exposure','article_open','like','unlike')),
     page_type TEXT NOT NULL CHECK(page_type IN ('list','detail')),event_time TEXT NOT NULL,
     ended_at TEXT,duration_ms INTEGER,received_at TEXT NOT NULL,canonical_json TEXT NOT NULL,
     canonical_hash TEXT NOT NULL,source TEXT NOT NULL CHECK(source IN ('browser','simulator')),
     schema_version INTEGER NOT NULL,measurement_version TEXT NOT NULL,
     CHECK ((event_type='exposure' AND ended_at IS NOT NULL AND duration_ms>0) OR
      (event_type!='exposure' AND ended_at IS NULL AND duration_ms IS NULL))
    ) STRICT;
    CREATE INDEX actions_impression ON action_records(impression_id);
    PRAGMA user_version=1;
   `);db.exec('COMMIT');}catch(error){db.exec('ROLLBACK');throw error;}
  }
  if(version<2){db.exec('BEGIN IMMEDIATE');try{db.exec(`
   CREATE TABLE export_jobs(job_id TEXT PRIMARY KEY,user_id TEXT NOT NULL,stream TEXT NOT NULL,partition_path TEXT NOT NULL,object_name TEXT NOT NULL UNIQUE,content TEXT NOT NULL,content_hash TEXT NOT NULL,row_count INTEGER NOT NULL,status TEXT NOT NULL DEFAULT 'prepared',attempts INTEGER NOT NULL DEFAULT 0,last_error TEXT,created_at TEXT NOT NULL);
   CREATE TABLE export_members(stream TEXT NOT NULL,record_id TEXT NOT NULL,job_id TEXT NOT NULL REFERENCES export_jobs(job_id),PRIMARY KEY(stream,record_id));
   CREATE TABLE revoked_users(user_id TEXT PRIMARY KEY,revoked_at TEXT NOT NULL);
   PRAGMA user_version=2;
  `);db.exec('COMMIT');}catch(error){db.exec('ROLLBACK');throw error;}}
  if(version<3)db.exec('ALTER TABLE export_jobs ADD COLUMN next_attempt_at INTEGER NOT NULL DEFAULT 0; PRAGMA user_version=3;');
  if(version<4){
   db.exec('BEGIN IMMEDIATE');
   try{
    db.exec(`
     ALTER TABLE served_records RENAME COLUMN user_id TO reader_id;
     ALTER TABLE export_jobs RENAME COLUMN user_id TO reader_id;
     ALTER TABLE revoked_users RENAME COLUMN user_id TO reader_id;
     DROP INDEX served_user;
     CREATE INDEX served_reader ON served_records(reader_id);
    `);
    const update=db.prepare('UPDATE served_records SET canonical_json=?,canonical_hash=? WHERE impression_id=?');
    for(const row of db.prepare('SELECT impression_id,canonical_json FROM served_records').all()){
     const old=JSON.parse(row.canonical_json);
     const record=canonical({request_id:old.request_id,impression_id:old.impression_id,
      reader_id:old.user_id,article_id:old.article_id,position:old.position,served_at:old.served_at});
     update.run(record.json,record.hash,row.impression_id);
    }
    db.exec('PRAGMA user_version=4; COMMIT');
   }catch(error){db.exec('ROLLBACK');throw error;}
  }
  if(version<5){
   db.exec('BEGIN IMMEDIATE');
   try{db.exec(`
    CREATE TABLE action_records_v5 (
     event_id TEXT PRIMARY KEY,impression_id TEXT NOT NULL REFERENCES served_records(impression_id),
     event_type TEXT NOT NULL CHECK(event_type IN ('exposure','article_open','article_close','like','unlike')),
     page_type TEXT NOT NULL CHECK(page_type IN ('list','detail')),event_time TEXT NOT NULL,
     ended_at TEXT,duration_ms INTEGER,received_at TEXT NOT NULL,canonical_json TEXT NOT NULL,
     canonical_hash TEXT NOT NULL,source TEXT NOT NULL CHECK(source IN ('browser','simulator')),
     schema_version INTEGER NOT NULL,measurement_version TEXT NOT NULL,
     CHECK ((event_type='exposure' AND ended_at IS NOT NULL AND duration_ms>0) OR
      (event_type!='exposure' AND ended_at IS NULL AND duration_ms IS NULL))
    ) STRICT;
    INSERT INTO action_records_v5 SELECT * FROM action_records;
    DROP TABLE action_records;
    ALTER TABLE action_records_v5 RENAME TO action_records;
    CREATE INDEX actions_impression ON action_records(impression_id);
    PRAGMA user_version=5;
   `);db.exec('COMMIT');}catch(error){db.exec('ROLLBACK');throw error;}
  }
 }catch(error){db.close();throw error;}
 const transaction=action=>{db.exec('BEGIN IMMEDIATE');try{const value=action();db.exec('COMMIT');return value;}catch(error){db.exec('ROLLBACK');throw error;}};
 return {
  intakeServed(context,body){
   if(context?.internal!==true)throw new InputError('INTERNAL_CONTEXT_REQUIRED');
   const rows=parseEnvelope(body,'records'),at=now();
   return transaction(()=>({results:rows.map(input=>{
    try{
     const r=parseServed(input,at);if(db.prepare('SELECT 1 FROM revoked_users WHERE reader_id=?').get(r.reader_id))throw new InputError('USER_REVOKED');
     const c=canonical(r),existing=db.prepare('SELECT canonical_hash FROM served_records WHERE impression_id=?').get(r.impression_id);
     if(existing)return {impression_id:r.impression_id,status:existing.canonical_hash===c.hash?'duplicate':'rejected',...(existing.canonical_hash===c.hash?{}:{code:'IMPRESSION_ID_CONFLICT'})};
     db.prepare('INSERT INTO served_records VALUES(?,?,?,?,?,?,?,?,?)').run(r.impression_id,r.request_id,r.reader_id,r.article_id,r.position,r.served_at,new Date(at).toISOString(),c.json,c.hash);
     return {impression_id:r.impression_id,status:'accepted'};
    }catch(error){if(!(error instanceof InputError))throw error;return {impression_id:typeof input?.impression_id==='string'?input.impression_id.slice(0,128):null,status:'rejected',code:error.code};}
   })}));
  },
  intakeActions(context,body){
   const user=contextReader(context);
   if(context.collectionEnabled!==true)throw new InputError('COLLECTION_DISABLED');
   const source=context.source??'browser',measurement=context.measurementVersion??'stationary-visible-v1';
   if(!['browser','simulator'].includes(source)||typeof measurement!=='string'||!measurement||measurement.length>128)throw new InputError('INVALID_CONTEXT');
   if(db.prepare('SELECT 1 FROM revoked_users WHERE reader_id=?').get(user))throw new InputError('USER_REVOKED');
   const rows=parseEnvelope(body,'events'),at=now();
   return transaction(()=>({results:rows.map(input=>{
    try{
     const r=parseAction(input,at),served=db.prepare('SELECT reader_id FROM served_records WHERE impression_id=?').get(r.impression_id);
     if(!served)return reject(r.event_id,'IMPRESSION_NOT_READY','retryable');
     if(served.reader_id!==user)return reject(r.event_id,'IMPRESSION_FORBIDDEN');
     const c=canonical(r),old=db.prepare('SELECT canonical_hash,source,measurement_version FROM action_records WHERE event_id=?').get(r.event_id);
     if(old)return old.canonical_hash===c.hash&&old.source===source&&old.measurement_version===measurement?{event_id:r.event_id,status:'duplicate'}:reject(r.event_id,'EVENT_ID_CONFLICT');
     db.prepare('INSERT INTO action_records VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(r.event_id,r.impression_id,r.event_type,r.page_type,r.event_time,r.ended_at??null,r.duration_ms??null,new Date(at).toISOString(),c.json,c.hash,source,1,measurement);
     return {event_id:r.event_id,status:'accepted'};
    }catch(error){if(!(error instanceof InputError))throw error;return reject(typeof input?.event_id==='string'?input.event_id.slice(0,128):null,error.code);}
   })}));
  },
  prepareExports(){return transaction(()=>{
   const groups=new Map();
   const rows=[...db.prepare(`SELECT s.*, 'served' AS stream,impression_id AS record_id,served_at AS time FROM served_records s WHERE NOT EXISTS(SELECT 1 FROM export_members m WHERE m.stream='served' AND m.record_id=s.impression_id) ORDER BY impression_id`).all(),
    ...db.prepare(`SELECT a.*,s.reader_id,'actions' AS stream,event_id AS record_id,event_time AS time FROM action_records a JOIN served_records s USING(impression_id) WHERE NOT EXISTS(SELECT 1 FROM export_members m WHERE m.stream='actions' AND m.record_id=a.event_id) ORDER BY event_id`).all()];
   for(const row of rows){if(db.prepare('SELECT 1 FROM revoked_users WHERE reader_id=?').get(row.reader_id))continue;const partition=partitionPath(row.time);const key=JSON.stringify([row.stream,row.reader_id,partition]);if(!groups.has(key))groups.set(key,[]);groups.get(key).push(row);}
   for(const records of groups.values())for(let i=0;i<records.length;i+=1000){
    const chunk=records.slice(i,i+1000),first=chunk[0],job=randomUUID(),partition=partitionPath(first.time);
    const content=chunk.map(row=>JSON.stringify({...JSON.parse(row.canonical_json),received_at:row.received_at,...(row.stream==='actions'?{source:row.source,schema_version:row.schema_version,measurement_version:row.measurement_version}:{})})).join('\n')+'\n';
    const object=`${first.stream}/${partition}/part-${job}.jsonl`;
    db.prepare('INSERT INTO export_jobs(job_id,reader_id,stream,partition_path,object_name,content,content_hash,row_count,created_at) VALUES(?,?,?,?,?,?,?,?,?)').run(job,first.reader_id,first.stream,partition,object,content,digest(content),chunk.length,new Date(now()).toISOString());
    for(const row of chunk)db.prepare('INSERT INTO export_members VALUES(?,?,?)').run(row.stream,row.record_id,job);
   }
   return rows.length;
  });},
  exportJobs(force=false){return db.prepare("SELECT j.* FROM export_jobs j WHERE status!='uploaded' AND NOT EXISTS(SELECT 1 FROM revoked_users r WHERE r.reader_id=j.reader_id) AND (? OR next_attempt_at<=?) ORDER BY created_at,job_id").all(force?1:0,now());},
  allJobs(){return db.prepare('SELECT * FROM export_jobs ORDER BY created_at,job_id').all();},
  markExported(id){db.prepare("UPDATE export_jobs SET status='uploaded',last_error=NULL,attempts=attempts+1 WHERE job_id=?").run(id);},
  markExportFailed(id,error){const job=db.prepare('SELECT attempts FROM export_jobs WHERE job_id=?').get(id);db.prepare('UPDATE export_jobs SET attempts=attempts+1,last_error=?,next_attempt_at=? WHERE job_id=?').run(String(error).slice(0,300),now()+Math.min(1800000,1000*2**Math.min(job.attempts,11)),id);},
  revoke(user){contextReader({readerId:user});db.prepare('INSERT OR IGNORE INTO revoked_users VALUES(?,?)').run(user,new Date(now()).toISOString());return db.prepare('SELECT * FROM export_jobs WHERE reader_id=?').all(user);},
  finishDeletion(user){return transaction(()=>{const ids=db.prepare('SELECT job_id FROM export_jobs WHERE reader_id=?').all(user);for(const {job_id} of ids)db.prepare('DELETE FROM export_members WHERE job_id=?').run(job_id);db.prepare('DELETE FROM export_jobs WHERE reader_id=?').run(user);db.prepare('DELETE FROM action_records WHERE impression_id IN (SELECT impression_id FROM served_records WHERE reader_id=?)').run(user);db.prepare('DELETE FROM served_records WHERE reader_id=?').run(user);});},
  readiness(){db.prepare('SELECT 1').get();return {pendingRecords:db.prepare("SELECT (SELECT count(*) FROM served_records s WHERE NOT EXISTS(SELECT 1 FROM export_members m WHERE m.stream='served' AND m.record_id=s.impression_id))+(SELECT count(*) FROM action_records a WHERE NOT EXISTS(SELECT 1 FROM export_members m WHERE m.stream='actions' AND m.record_id=a.event_id)) AS n").get().n,pendingJobs:this.exportJobs(true).length,...this.counts()};},
  counts(){return {served:db.prepare('SELECT count(*) AS n FROM served_records').get().n,actions:db.prepare('SELECT count(*) AS n FROM action_records').get().n};},
  getServed(id){return db.prepare('SELECT * FROM served_records WHERE impression_id=?').get(id)??null;},
  getAction(id){return db.prepare('SELECT * FROM action_records WHERE event_id=?').get(id)??null;},
  close(){db.close();}
 };
}
