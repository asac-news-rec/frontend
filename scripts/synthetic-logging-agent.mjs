import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';

export function makeRecords(context, choice, now=new Date()) {
 const articles=context.articles;
 if(!Array.isArray(articles)||!articles.length||!articles.every(a=>typeof a.article_id==='string'&&Number.isSafeInteger(a.position)&&a.position>0&&typeof a.title==='string'))throw new Error('INVALID_ARTICLES');
 if(typeof context.reader_id!=='string'||!context.reader_id||typeof context.persona!=='string'||!context.persona)throw new Error('INVALID_CONTEXT');
 if(choice.article_id!==null&&!articles.some(a=>a.article_id===choice.article_id))throw new Error('INVALID_CHOICE');
 const served_at=now.toISOString(),request_id=randomUUID();
 const records=articles.map(a=>({request_id,impression_id:randomUUID(),reader_id:context.reader_id,article_id:a.article_id,position:a.position,served_at}));
 const selected=records.find(r=>r.article_id===choice.article_id);
 const events=selected?[{event_id:randomUUID(),event_type:'article_open',event_time:served_at,impression_id:selected.impression_id,page_type:'list'}]:[];
 return {records,events};
}

export async function decide(context, apiKey, model) {
 const response=await fetch('https://openrouter.ai/api/v1/chat/completions',{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${apiKey}`},body:JSON.stringify({model,response_format:{type:'json_object'},messages:[{role:'user',content:JSON.stringify({persona:context.persona,articles:context.articles.map(({article_id,title})=>({article_id,title})),instruction:'Return JSON {"article_id": string or null}. Choose only a supplied article_id if this reader would click. Otherwise return null.'})}]})});
 if(!response.ok)throw new Error(`OPENROUTER_HTTP_${response.status}`);
 const body=await response.json();
 const choice=JSON.parse(body.choices[0].message.content);
 if(!choice||typeof choice!=='object'||!('article_id' in choice))throw new Error('INVALID_MODEL_RESPONSE');
 return choice;
}

export async function send(base,token,readerId,route,payload,source) {
 const response=await fetch(new URL(route,base),{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`,...(source?{'x-news-reader':readerId,'x-collection-enabled':'true','x-news-source':'simulator'}:{})},body:JSON.stringify(payload)});
 if(!response.ok)throw new Error(`LOGGING_HTTP_${response.status}`);
 const body=await response.json();
 if(body.results?.some(r=>r.status!=='accepted'&&r.status!=='duplicate'))throw new Error(`LOGGING_REJECTED ${JSON.stringify(body.results)}`);
 return body;
}

async function main() {
 const args=process.argv.slice(2),file=args[args.indexOf('--contexts')+1],once=args.includes('--once'),dryRun=args.includes('--dry-run');
 if(!file||file.startsWith('--'))throw new Error('Use --contexts <JSON file>');
 const contexts=JSON.parse(readFileSync(file,'utf8'));
 if(!Array.isArray(contexts)||!contexts.length)throw new Error('contexts must be a nonempty array');
 const apiKey=process.env.OPENROUTER_API_KEY,token=process.env.LOGGING_TOKEN;
 if(!apiKey||(!dryRun&&!token))throw new Error('OPENROUTER_API_KEY and LOGGING_TOKEN are required for sending');
 const base=process.env.LOGGING_URL??'http://127.0.0.1:4195',model=process.env.OPENROUTER_MODEL??'deepseek/deepseek-v4.1-flash-1017';
 let index=0;
 do {
  const context=contexts[index++%contexts.length],choice=await decide(context,apiKey,model),{records,events}=makeRecords(context,choice);
  if(dryRun)console.log(JSON.stringify({records,events}));
  else {console.log(JSON.stringify({served:await send(base,token,context.reader_id,'/internal/served',{records})}));if(events.length)console.log(JSON.stringify({actions:await send(base,token,context.reader_id,'/events',{events},true)}));}
  if(!once)await new Promise(resolve=>setTimeout(resolve,10000));
 }while(!once);
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main().catch(error=>{console.error(error.message);process.exitCode=1;});
