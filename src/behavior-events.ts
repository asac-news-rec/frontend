import {getBackendReaderId} from './reader-identity.js';
export interface BehaviorEvent {event_id:string;event_type:string;event_time:string;impression_id:string;page_type:string;duration_ms?:number;ended_at?:string}
let readerId:string|null=null;
let collectionEnabled=false;
export const behaviorReader=()=>readerId;
const pending=new Map<string,{event:BehaviorEvent;created:number;attempts:number;inflight:boolean}>();
const key='sai-news.behavior-pending';
let dropped=0,retrying=0,lastError:string|null=null;
let sessionState:'ready'|'recovering'|'blocked'='ready',sessionGeneration=0,nextRecoveryAt=0;
let recovery:Promise<boolean>|null=null;
let notice:HTMLElement|null=null;
function errorCode(body:unknown,fallback:string){const value=(body as {error?:unknown})?.error;return typeof value==='string'&&/^[A-Z_]{1,80}$/.test(value)?value:fallback;}
function drop(id:string,reason:string){if(pending.delete(id)){dropped++;lastError=reason;}}
export function setBehaviorCollection(enabled:boolean){
 collectionEnabled=enabled&&readerId!==null;
 if(!collectionEnabled){if(pending.size){dropped+=pending.size;lastError='COLLECTION_DISABLED';}pending.clear();persist();report();}
}
function persist(){try{sessionStorage.setItem(key,JSON.stringify({readerId,dropped,entries:[...pending.values()].map(({event,created})=>({event,created}))}));}catch{}}
function report(){
 const document=globalThis.document;if(!document)return;
 document.dispatchEvent(new CustomEvent('behavior-queue-changed',{detail:{pending:pending.size,dropped,retrying,lastError,sessionState}}));
 if(!notice){notice=document.createElement('p');notice.className='behavior-notice';notice.setAttribute('role','status');document.body.append(notice);}
 notice.hidden=!lastError&&!dropped;
 notice.textContent=notice.hidden?'':`이용 기록 전송이 지연되거나 일부 기록을 보내지 못했습니다. 대기 ${pending.size}건 · 폐기 ${dropped}건`;
}
async function recoverSession(){
 if(recovery)return recovery;
 if(!collectionEnabled||!readerId||Date.now()<nextRecoveryAt)return false;
 const identity=readerId;
 sessionState='recovering';report();
 recovery=(async()=>{
  try{
   const response=await fetch('/api/behavior/session',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({reader_id:identity}),signal:AbortSignal.timeout(1500)});
   const body=await response.json().catch(()=>null);
   if(!response.ok)throw new Error(errorCode(body,`HTTP_${response.status}`));
   if(body?.reader_id!==identity)throw new Error('LOGGING_READER_MISMATCH');
   if(readerId!==identity||!collectionEnabled)return false;
   sessionGeneration++;sessionState='ready';lastError=null;nextRecoveryAt=0;return true;
  }catch(error){sessionState='blocked';lastError=error instanceof Error?error.message:'SESSION_RECOVERY_FAILED';nextRecoveryAt=Date.now()+30000;return false;}
  finally{report();}
 })();
 try{return await recovery;}finally{recovery=null;}
}
export function retryBehaviorEvents(){nextRecoveryAt=0;for(const entry of pending.values())void attempt(entry);}
async function attempt(entry:{event:BehaviorEvent;created:number;attempts:number;inflight:boolean}){
 if(!collectionEnabled||entry.inflight||pending.get(entry.event.event_id)!==entry)return;
 if(Date.now()-entry.created>=1800000){drop(entry.event.event_id,'EVENT_EXPIRED');persist();report();return;}
 entry.inflight=true;entry.attempts++;
 const generation=sessionGeneration;let immediate=false;
 try{
  const response=await fetch('/api/behavior/events',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({events:[entry.event]}),keepalive:true,signal:AbortSignal.timeout(10000)});
  if(!collectionEnabled||pending.get(entry.event.event_id)!==entry)return;
  if(response.status===401||response.status===403){
   const body=await response.json().catch(()=>null);lastError=errorCode(body,`HTTP_${response.status}`);retrying++;
   if(lastError==='SESSION_REQUIRED')immediate=sessionGeneration!==generation||await recoverSession();
   else sessionState='blocked';
   return;
  }
  if([400,409,413,415].includes(response.status)){drop(entry.event.event_id,`HTTP_${response.status}`);return;}
  if(!response.ok)throw new Error('LOGGING_UNAVAILABLE');
  const ack=(await response.json()).results?.find((r:{event_id:string})=>r.event_id===entry.event.event_id);
  if(ack?.status==='rejected')drop(entry.event.event_id,errorCode({error:ack.code},'EVENT_REJECTED'));
  else if(['accepted','duplicate'].includes(ack?.status)){pending.delete(entry.event.event_id);if(sessionState==='blocked')sessionState='ready';if(!pending.size)lastError=null;}
  else{retrying++;lastError='UNCONFIRMED_ACK';}
 }catch{retrying++;lastError='LOGGING_UNAVAILABLE';}finally{
  entry.inflight=false;persist();report();
  if(pending.get(entry.event.event_id)===entry)setTimeout(()=>void attempt(entry),immediate?0:Math.min(30000,1000*2**Math.min(entry.attempts,5)));
 }
}
export function recordBehavior(kind:string,impressionId:string|undefined,page='list',extra:Partial<BehaviorEvent>={}){
 if(!collectionEnabled||!readerId||!impressionId)return false;
 const event:BehaviorEvent={event_id:crypto.randomUUID(),event_type:kind,event_time:new Date().toISOString(),impression_id:impressionId,page_type:page,...extra};
 if(pending.size>=500)drop(pending.keys().next().value!,'QUEUE_LIMIT');
 while(pending.size&&new TextEncoder().encode(JSON.stringify([...pending.values()].map(e=>e.event))).length>520192)drop(pending.keys().next().value!,'QUEUE_LIMIT');
 const entry={event:JSON.parse(JSON.stringify(event)) as BehaviorEvent,created:Date.now(),attempts:0,inflight:false};
 pending.set(event.event_id,entry);persist();report();void attempt(entry);
 return true;
}
export async function initializeBehavior(onPageExit:()=>void){
 readerId=null;collectionEnabled=false;pending.clear();
 try{
 const response=await fetch('/api/behavior/status',{credentials:'same-origin',signal:AbortSignal.timeout(1500)});
 if(!response.ok||(await response.json()).enabled!==true){setBehaviorCollection(false);return;}
 const existing=await getBackendReaderId();
 const session=await fetch('/api/behavior/session',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({reader_id:existing}),signal:AbortSignal.timeout(1500)});
 if(!session.ok)throw new Error('행동 수집 세션에 연결하지 못했습니다. 다시 불러와 주세요.');
 const identity=(await session.json()).reader_id;
 if(identity!==existing)throw new Error('LOGGING_READER_MISMATCH');
 readerId=identity;collectionEnabled=true;
 try{const saved=JSON.parse(sessionStorage.getItem(key)??'null');if(saved?.readerId===readerId&&Array.isArray(saved.entries))for(const entry of saved.entries.slice(-500)){
  if(entry.event?.event_id&&typeof entry.created==='number'&&Date.now()-entry.created<1800000)pending.set(entry.event.event_id,{event:entry.event,created:entry.created,attempts:0,inflight:false});
 }}catch{}
 persist();for(const entry of pending.values())void attempt(entry);
 window.addEventListener('online',retryBehaviorEvents);
 window.addEventListener('focus',retryBehaviorEvents);
 window.addEventListener('pageshow',retryBehaviorEvents);
 window.addEventListener('pagehide',event=>{
  if(!event.persisted)onPageExit();
  for(const entry of pending.values())navigator.sendBeacon('/api/behavior/events',new Blob([JSON.stringify({events:[entry.event]})],{type:'application/json'}));
 });
 }catch{
  readerId=null;setBehaviorCollection(false);
 }
}

export function connectBehavior(main:HTMLElement){
 const active=new Map<Element,{id:string;wall:number;mono:number}>(),visible=new Set<Element>();
 let scrolling=false,timer:ReturnType<typeof setTimeout>;
 function stop(node:Element){const segment=active.get(node);if(!segment)return;active.delete(node);const duration=Math.round(performance.now()-segment.mono);if(duration>0)recordBehavior('exposure',segment.id,'list',{event_time:new Date(segment.wall).toISOString(),ended_at:new Date(segment.wall+duration).toISOString(),duration_ms:Math.min(duration,86400000)});}
 function stopAll(){for(const node of active.keys())stop(node);}
 function resume(){if(!collectionEnabled||!readerId||scrolling||document.hidden)return;for(const node of visible){const id=(node as HTMLElement).dataset.impressionId;if(id&&node.isConnected&&!active.has(node))active.set(node,{id,wall:Date.now(),mono:performance.now()});}}
 const observer=new IntersectionObserver(entries=>{for(const entry of entries){if(entry.isIntersecting&&entry.intersectionRatio>=.5)visible.add(entry.target);else{visible.delete(entry.target);stop(entry.target);}}resume();},{threshold:[0,.5,1]});
 window.addEventListener('scroll',()=>{scrolling=true;stopAll();clearTimeout(timer);timer=setTimeout(()=>{scrolling=false;resume();},300);},{passive:true});
 document.addEventListener('visibilitychange',()=>{if(document.hidden)stopAll();else resume();});
 window.addEventListener('pagehide',stopAll);
 window.addEventListener('pageshow',resume);
 function recordOpen(impressionId:string|undefined){
  stopAll();
  const recorded=recordBehavior('article_open',impressionId);
  resume();
  return recorded;
 }
 main.addEventListener('auxclick',event=>{
  const link=event.target instanceof Element?event.target.closest<HTMLAnchorElement>('a.card[data-impression-id]'):null;
  if(link&&event.isTrusted&&event.button===1)recordOpen(link.dataset.impressionId);
 });
 return {recordOpen,beforeRender(){stopAll();observer.disconnect();visible.clear();},observe(){for(const node of main.querySelectorAll('.card[data-impression-id]'))observer.observe(node);}};
}
