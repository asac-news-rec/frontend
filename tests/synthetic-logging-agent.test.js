import {test} from 'node:test';
import assert from 'node:assert/strict';
import {makeRecords} from '../scripts/synthetic-logging-agent.mjs';
import {parseServed,parseAction} from '../services/logging-server/schema.mjs';
import {openLoggingStore} from '../services/logging-server/repository.mjs';
import {mkdtempSync,rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('agent output follows logging contract and links click to served article',()=>{
 const now=new Date('2026-11-05T00:00:00Z');
 const context={reader_id:'synthetic-reader-1',persona:'반도체에 관심',articles:[{article_id:'semiconductor-1',position:1,title:'반도체 소식'},{article_id:'rates-1',position:2,title:'금리 소식'}]};
 const {records,events}=makeRecords(context,{article_id:'rates-1'},now);
 assert.equal(records.length,2);assert.equal(events.length,1);
 records.forEach(r=>assert.equal(parseServed(r,now.getTime()).reader_id,context.reader_id));
 assert.equal(parseAction(events[0],now.getTime()).impression_id,records[1].impression_id);
 assert.deepEqual(makeRecords(context,{article_id:null},now).events,[]);
 assert.throws(()=>makeRecords(context,{article_id:'outside'},now),/INVALID_CHOICE/);
});

test('synthetic click is stored with simulator source',t=>{
 const dir=mkdtempSync(path.join(os.tmpdir(),'synthetic-logging-'));
 const store=openLoggingStore({database:path.join(dir,'inbox.sqlite')});
 t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
 const {records,events}=makeRecords({reader_id:'synthetic-reader-1',persona:'반도체에 관심',articles:[{article_id:'semiconductor-1',position:1,title:'반도체 소식'}]},{article_id:'semiconductor-1'});
 assert.equal(store.intakeServed({internal:true},{records}).results[0].status,'accepted');
 assert.equal(store.intakeActions({readerId:'synthetic-reader-1',collectionEnabled:true,source:'simulator'},{events}).results[0].status,'accepted');
 assert.equal(store.getAction(events[0].event_id).source,'simulator');
});
