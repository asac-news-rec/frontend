import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {decide} from './synthetic-logging-agent.mjs';

export async function runBrowserClick({browser,url,persona,agentToken,choose,timeout=15000}){
 const context=await browser.newContext();
 try{
  const base=new URL(url);
  if(!['127.0.0.1','localhost','[::1]'].includes(base.hostname))throw new Error('LOCAL_URL_REQUIRED');
  const session=await context.request.post(new URL('/api/synthetic/session',base).href,{headers:{'x-synthetic-agent':agentToken}});
  if(!session.ok())throw new Error(`SESSION_HTTP_${session.status()}`);
  const page=await context.newPage();page.setDefaultTimeout(timeout);
  await page.goto(base.href);
  await page.locator('a[data-article]').first().waitFor();
  const articles=await page.locator('a[data-article]').evaluateAll(links=>links.map((link,index)=>({article_id:link.getAttribute('data-article'),title:link.querySelector('h3')?.textContent??'',position:index+1})));
  if(!articles.length||articles.some(a=>!a.article_id||!a.title)||new Set(articles.map(a=>a.article_id)).size!==articles.length)throw new Error('INVALID_SCREEN_ARTICLES');
  const choice=await choose({persona:persona.persona,reader_id:persona.reader_id,articles});
  if(!choice||!Object.hasOwn(choice,'article_id'))throw new Error('INVALID_CHOICE');
  if(choice.article_id===null)return {status:'skipped',candidates:articles.length};
  const index=articles.findIndex(a=>a.article_id===choice.article_id);
  if(index<0)throw new Error('INVALID_CHOICE');
  const ackPromise=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/synthetic/events'&&r.request().method()==='POST');
  // Attach failure handling before clicking so a timeout cannot become unhandled.
  const action=async()=>{
   await page.locator('a[data-article]').nth(index).click();
   await page.locator('article.article-page h1').waitFor();
   if(decodeURIComponent(new URL(page.url()).hash.slice(9))!==choice.article_id)throw new Error('WRONG_DETAIL_PAGE');
  };
  const [ack]=await Promise.all([ackPromise,action()]);
  if(!ack.ok())throw new Error(`EVENT_HTTP_${ack.status()}`);
  const result=await ack.json();
  if(result.results?.length!==1||!['accepted','duplicate'].includes(result.results[0].status))throw new Error('EVENT_NOT_ACCEPTED');
  return {status:'clicked',candidates:articles.length,accepted:true};
 }finally{await context.close();}
}

async function main(){
 const args=process.argv.slice(2);
 const value=(name,fallback)=>{const index=args.indexOf(name);return index<0?fallback:args[index+1];};
 const personas=JSON.parse(readFileSync(value('--personas','examples/synthetic-personas.json'),'utf8'));
 const persona=personas[Number(value('--index','0'))];
 if(!persona||typeof persona.reader_id!=='string'||typeof persona.persona!=='string')throw new Error('INVALID_PERSONA');
 const apiKey=process.env.OPENROUTER_API_KEY,agentToken=process.env.SYNTHETIC_AGENT_TOKEN;
 if(!apiKey||!agentToken)throw new Error('OPENROUTER_API_KEY_AND_SYNTHETIC_AGENT_TOKEN_REQUIRED');
 const {chromium}=await import('playwright');
 const browser=await chromium.launch({headless:!args.includes('--headed'),...(process.env.PLAYWRIGHT_CHANNEL?{channel:process.env.PLAYWRIGHT_CHANNEL}:{})});
 try{console.log(JSON.stringify(await runBrowserClick({browser,url:value('--url','http://127.0.0.1:4173/'),persona,agentToken,choose:context=>decide(context,apiKey,process.env.OPENROUTER_MODEL??'deepseek/deepseek-v4.1-flash-1017')})));}
 finally{await browser.close();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main().catch(()=>{console.error('Browser agent failed. Check local servers, credentials, model response and browser installation.');process.exitCode=1;});
