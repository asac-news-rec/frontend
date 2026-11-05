import {createReadStream,openSync,writeFileSync,closeSync,unlinkSync} from 'node:fs';
import {createInterface} from 'node:readline';
import path from 'node:path';
import {classifyExposure} from '../services/logging-server/exposure-analysis.mjs';

const [input,output,...extra]=process.argv.slice(2);
if(!input||!output||extra.length)throw new Error('Usage: node scripts/classify-exposures.mjs <actions.jsonl> <analysis.jsonl>');
if(path.resolve(input)===path.resolve(output))throw new Error('ANALYSIS_MUST_NOT_OVERWRITE_RAW');
const fd=openSync(output,'wx');
const lines=createInterface({input:createReadStream(input,{encoding:'utf8'}),crlfDelay:Infinity});
let lineNumber=0,count=0;
try{
 for await(const line of lines){
  lineNumber++;
  const value=lineNumber===1?line.replace(/^\uFEFF/,''):line;
  if(!value.trim())continue;
  writeFileSync(fd,JSON.stringify(classifyExposure(JSON.parse(value)))+'\n');
  count++;
 }
 closeSync(fd);
 console.log(JSON.stringify({records:count,output}));
}catch(error){
 lines.close();closeSync(fd);unlinkSync(output);
 throw new Error(`Exposure analysis failed at line ${lineNumber}: ${error.message}`);
}
