import {test} from 'node:test';
import assert from 'node:assert/strict';
import {runExperiment} from '../scripts/run-synthetic-experiment.mjs';

test('JSON experiment links synthetic clicks, preserves no-click and rejects an outside choice',async()=>{
 const contexts=['one','two'].map(reader_id=>({reader_id,persona:'AI 관심',articles:[{article_id:'a1',position:1,title:'AI 소식'}]}));
 const snapshots=[];
 const report=await runExperiment({contexts,model:'test-model',choose:async c=>({article_id:c.reader_id==='one'?'a1':null}),save:r=>snapshots.push(JSON.parse(JSON.stringify(r)))});
 assert.equal(report.completed,true);assert.equal(report.browser_used,false);assert.equal(report.logging_server_used,false);
 assert.equal(report.results[0].synthetic_events[0].impression_id,report.results[0].served_records[0].impression_id);
 assert.deepEqual(report.results[1].synthetic_events,[]);
 assert.equal(snapshots[0].completed,false);assert.equal(snapshots.at(-1).completed,true);
 await assert.rejects(runExperiment({contexts,model:'test',choose:async()=>({article_id:'outside'})}),/INVALID_CHOICE/);
});
