export interface BehaviorEvent {event_id:string;event_type:string;event_time:string;impression_id:string;page_type:string;duration_ms?:number;ended_at?:string}
let readerId:string|null=null;
export const behaviorReader=()=>readerId;
const pending=new Map<string,{event:BehaviorEvent;created:number;attempts:number;inflight:boolean}>();
const key='sai-news.behavior-pending';
function persist(){try{sessionStorage.setItem(key,JSON.stringify({readerId,entries:[...pending.values()].map(({event,created})=>({event,created}))}));}catch{}}
function report(){document.dispatchEvent(new CustomEvent('behavior-queue-changed',{detail:{pending:pending.size}}));}
async function attempt(entry:{event:BehaviorEvent;created:number;attempts:number;inflight:boolean}){
 if(entry.inflight||!pending.has(entry.event.event_id))return;
 if(Date.now()-entry.created>=1800000){pending.delete(entry.event.event_id);persist();report();return;}
 entry.inflight=true;entry.attempts++;
 try{
  const response=await fetch('/api/behavior/events',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({events:[entry.event]}),keepalive:true,signal:AbortSignal.timeout(10000)});
  if([400,401,403,409,413,415].includes(response.status)){pending.delete(entry.event.event_id);return;}
  if(!response.ok)throw new Error('LOGGING_UNAVAILABLE');
  const ack=(await response.json()).results?.find((r:{event_id:string})=>r.event_id===entry.event.event_id);
  if(['accepted','duplicate','rejected'].includes(ack?.status))pending.delete(entry.event.event_id);
 }catch{}finally{
  entry.inflight=false;persist();report();
  if(pending.has(entry.event.event_id))setTimeout(()=>void attempt(entry),Math.min(30000,1000*2**Math.min(entry.attempts,5)));
 }
}
export function recordBehavior(kind:string,impressionId:string|undefined,page='list',extra:Partial<BehaviorEvent>={}){
 if(!readerId||!impressionId)return;
 const event:BehaviorEvent={event_id:crypto.randomUUID(),event_type:kind,event_time:new Date().toISOString(),impression_id:impressionId,page_type:page,...extra};
 if(pending.size>=500)pending.delete(pending.keys().next().value!);
 while(pending.size&&new TextEncoder().encode(JSON.stringify([...pending.values()].map(e=>e.event))).length>520192)pending.delete(pending.keys().next().value!);
 const entry={event:JSON.parse(JSON.stringify(event)) as BehaviorEvent,created:Date.now(),attempts:0,inflight:false};
 pending.set(event.event_id,entry);persist();report();void attempt(entry);
}
export async function initializeBehavior(){
 const response=await fetch('/api/behavior/status',{credentials:'same-origin'});
 if(!response.ok||(await response.json()).enabled!==true)return;
 const session=await fetch('/api/behavior/session',{method:'POST',credentials:'same-origin'});
 if(!session.ok)throw new Error('행동 수집 세션에 연결하지 못했습니다. 다시 불러와 주세요.');
 readerId=(await session.json()).reader_id;
 if(typeof readerId!=='string'||!readerId)throw new Error('INVALID_LOGGING_READER');
 try{const saved=JSON.parse(sessionStorage.getItem(key)??'null');if(saved?.readerId===readerId&&Array.isArray(saved.entries))for(const entry of saved.entries.slice(-500)){
  if(entry.event?.event_id&&typeof entry.created==='number'&&Date.now()-entry.created<1800000)pending.set(entry.event.event_id,{event:entry.event,created:entry.created,attempts:0,inflight:false});
 }}catch{}
 persist();for(const entry of pending.values())void attempt(entry);
 window.addEventListener('online',()=>{for(const entry of pending.values())void attempt(entry);});
 window.addEventListener('pagehide',()=>{for(const entry of pending.values())navigator.sendBeacon('/api/behavior/events',new Blob([JSON.stringify({events:[entry.event]})],{type:'application/json'}));});
}

export function connectBehavior(main:HTMLElement){
 const active=new Map<Element,{id:string;wall:number;mono:number}>(),visible=new Set<Element>();
 let scrolling=false,timer:ReturnType<typeof setTimeout>;
 function stop(node:Element){const segment=active.get(node);if(!segment)return;active.delete(node);const duration=Math.round(performance.now()-segment.mono);if(duration>0)recordBehavior('exposure',segment.id,'list',{event_time:new Date(segment.wall).toISOString(),ended_at:new Date(segment.wall+duration).toISOString(),duration_ms:Math.min(duration,86400000)});}
 function stopAll(){for(const node of active.keys())stop(node);}
 function resume(){if(!readerId||scrolling||document.hidden)return;for(const node of visible){const id=(node as HTMLElement).dataset.impressionId;if(id&&node.isConnected&&!active.has(node))active.set(node,{id,wall:Date.now(),mono:performance.now()});}}
 const observer=new IntersectionObserver(entries=>{for(const entry of entries){if(entry.isIntersecting&&entry.intersectionRatio>=.5)visible.add(entry.target);else{visible.delete(entry.target);stop(entry.target);}}resume();},{threshold:[0,.5,1]});
 window.addEventListener('scroll',()=>{scrolling=true;stopAll();clearTimeout(timer);timer=setTimeout(()=>{scrolling=false;resume();},300);},{passive:true});
 document.addEventListener('visibilitychange',()=>{if(document.hidden)stopAll();else resume();});
 window.addEventListener('pagehide',stopAll);
 window.addEventListener('pageshow',resume);
 function open(event:MouseEvent){const node=event.target instanceof Element?event.target.closest<HTMLElement>('a.card[data-impression-id]'):null;if(!node||!event.isTrusted||(event.type==='click'?event.button!==0:event.button!==1))return;stopAll();recordBehavior('article_open',node.dataset.impressionId);resume();}
 main.addEventListener('click',open);main.addEventListener('auxclick',open);
 return {beforeRender(){stopAll();observer.disconnect();visible.clear();},observe(){for(const node of main.querySelectorAll('.card[data-impression-id]'))observer.observe(node);}};
}
