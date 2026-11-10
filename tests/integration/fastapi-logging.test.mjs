import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {startFastApiLogging} from '../helpers/fastapi-logging.mjs';
import {makeRecords} from '../../scripts/synthetic-logging-agent.mjs';

test('합성 에이전트의 기존 JSON 계약이 FastAPI·SQLite·JSONL까지 연결된다',async t=>{
 const token=randomUUID();const {url,store}=await startFastApiLogging(t,token);
 const {records,events}=makeRecords({reader_id:'fixture-reader',persona:'AI',articles:[{article_id:'fixture-article',position:1,title:'가상 기사'}]},{article_id:'fixture-article'});
 const response=await fetch(url+'/internal/served',{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({records})});
 assert.equal((await response.json()).results[0].status,'accepted');
 const context={readerId:'fixture-reader',collectionEnabled:true,source:'simulator'};
 assert.equal((await store.intakeActions(context,{events})).results[0].status,'accepted');
 assert.equal((await store.intakeActions(context,{events})).results[0].status,'duplicate');
 assert.equal(store.getAction(events[0].event_id).source,'simulator');
 assert.equal(store.counts().actions,1);
 const flush=await fetch(url+'/internal/flush',{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:'{}'});
 assert.equal((await flush.json()).completed,2);
});
