import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,readFileSync,existsSync,rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {classifyExposure} from '../exposure-analysis.mjs';

const exposure=(duration,page='list')=>({event_id:crypto.randomUUID(),impression_id:'same-impression',event_type:'exposure',page_type:page,duration_ms:duration});

test('목록 연속 1초 기준은 원본을 유지하고 999ms와 1000ms를 구분한다',()=>{
 const rows=[200,999,1000,2000,600,600].map(duration=>exposure(duration));
 const before=JSON.stringify(rows);
 const results=rows.map(classifyExposure);
 assert.deepEqual(results.map(row=>row.is_valid_list_exposure),[false,false,true,true,false,false]);
 assert.equal(JSON.stringify(rows),before);
 assert.deepEqual(results.map(row=>row.duration_ms),[200,999,1000,2000,600,600]);
});

test('상세 잔여와 빠른 클릭은 목록 유효 노출 필터로 제거하지 않는다',()=>{
 const detail=classifyExposure(exposure(400,'detail'));
 assert.equal(detail.duration_ms,400);assert.equal(detail.is_valid_list_exposure,null);
 const click={event_id:crypto.randomUUID(),event_type:'article_open',page_type:'list',impression_id:'fast-click'};
 assert.equal(classifyExposure(click).event_id,click.event_id);
 assert.equal(classifyExposure(click).is_valid_list_exposure,null);
 assert.throws(()=>classifyExposure(exposure(-1)),/INVALID_EXPOSURE_DURATION/);
});

test('JSONL 분석 명령은 짧은 구간도 남기고 원본·기존 출력 파일을 덮어쓰지 않는다',t=>{
 const dir=mkdtempSync(path.join(os.tmpdir(),'exposure-analysis-'));
 t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const raw=path.join(dir,'actions.jsonl'),output=path.join(dir,'analysis.jsonl');
 const input=[exposure(600),exposure(1000),exposure(400,'detail')].map(JSON.stringify).join('\n')+'\n';
 writeFileSync(raw,input);
 const command=fileURLToPath(new URL('../../../scripts/classify-exposures.mjs',import.meta.url));
 execFileSync(process.execPath,[command,raw,output],{stdio:'pipe'});
 const result=readFileSync(output,'utf8');
 assert.deepEqual(result.trim().split('\n').map(JSON.parse).map(row=>row.is_valid_list_exposure),[false,true,null]);
 assert.equal(readFileSync(raw,'utf8'),input);
 assert.throws(()=>execFileSync(process.execPath,[command,raw,raw],{stdio:'pipe'}));
 assert.throws(()=>execFileSync(process.execPath,[command,raw,output],{stdio:'pipe'}));
 assert.equal(readFileSync(output,'utf8'),result);
 writeFileSync(raw,input+'invalid-json\n');
 const broken=path.join(dir,'broken.jsonl');
 assert.throws(()=>execFileSync(process.execPath,[command,raw,broken],{stdio:'pipe'}));
 assert.equal(existsSync(broken),false);
});
