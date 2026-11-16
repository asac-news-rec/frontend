import {readFileSync,mkdirSync,writeFileSync,renameSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {pathToFileURL} from 'node:url';
import {randomUUID} from 'node:crypto';
import {decide,makeRecords} from './synthetic-logging-agent.mjs';

export async function runExperiment({contexts,model,choose,save=()=>{}}){
 if(!Array.isArray(contexts)||!contexts.length)throw new Error('EMPTY_CONTEXTS');
 for(const context of contexts)makeRecords(context,{article_id:null});
 const report={run_id:randomUUID(),source:'simulator',mode:'model-selection-only',browser_used:false,logging_server_used:false,model,started_at:new Date().toISOString(),completed:false,candidate_data:'frontend-fictional-samples',results:[]};
 save(report);
 for(const context of contexts){
  const choice=await choose(context);
  const {records,events}=makeRecords(context,choice);
  report.results.push({reader_id:context.reader_id,persona:context.persona,candidates:context.articles,selected_article_id:choice.article_id,served_records:records,synthetic_events:events});
  save(report);
 }
 report.completed=true;report.finished_at=new Date().toISOString();save(report);
 return report;
}

async function main(){
 const args=process.argv.slice(2);
 const value=(name,fallback)=>{const index=args.indexOf(name);if(index<0)return fallback;if(!args[index+1]||args[index+1].startsWith('--'))throw new Error(`MISSING_${name}`);return args[index+1];};
 if(!process.env.OPENROUTER_API_KEY?.trim())throw new Error('OPENROUTER_API_KEY_REQUIRED');
 const {articles}=await import('../.local/src/data.js');
 const personas=JSON.parse(readFileSync(value('--personas','examples/synthetic-personas.json'),'utf8'));
 const candidates=articles.map((article,index)=>({article_id:article.id,position:index+1,title:article.title}));
 const contexts=personas.map(({reader_id,persona})=>({reader_id,persona,articles:candidates}));
 const model=process.env.OPENROUTER_MODEL??'deepseek/deepseek-v4.1-flash-1017';
 const output=resolve(value('--output',`data/synthetic-experiment-${new Date().toISOString().replace(/[:.]/g,'-')}.json`));
 mkdirSync(dirname(output),{recursive:true});
 // Refuse to overwrite a previous result, including user-supplied files.
 writeFileSync(output,'{}\n',{flag:'wx'});
 const save=report=>{const temporary=output+'.tmp';writeFileSync(temporary,JSON.stringify(report,null,2)+'\n');renameSync(temporary,output);};
 const report=await runExperiment({contexts,model,choose:context=>decide(context,process.env.OPENROUTER_API_KEY,model),save:report=>{save(report);if(!report.completed&&report.results.length)console.log(`Completed ${report.results.length}/${contexts.length} persona decisions`);}});
 console.log(JSON.stringify({output,model,readers:report.results.length,click_choices:report.results.filter(r=>r.selected_article_id!==null).length,browser_used:false}));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main().catch(error=>{console.error(error.message);process.exitCode=1;});
