import http from 'k6/http';
import {check,sleep} from 'k6';
import execution from 'k6/execution';
import crypto from 'k6/crypto';
import {Counter,Rate} from 'k6/metrics';
import {dataset,integer,origin,validFeed,selectClicks,ackState} from './model.mjs';

const base=origin(__ENV.BASE_URL,__ENV.ALLOW_REMOTE_LOAD);
if(!__ENV.PATTERNS||!__ENV.MAPPING)throw new Error('PATTERNS_AND_MAPPING_REQUIRED');
const input=dataset(JSON.parse(open(__ENV.PATTERNS)),JSON.parse(open(__ENV.MAPPING)));
const mode=__ENV.MODE||'smoke',selection=__ENV.SELECTION||'rank';
if(!['smoke','load'].includes(mode)||!['rank','mapped'].includes(selection))throw new Error('INVALID_MODE');
const vus=integer(__ENV.VUS,1,1,500),visits=integer(__ENV.VISITS,1,1,10000);
const rate=integer(__ENV.RATE,1,1,1000),duration=integer(__ENV.DURATION_SECONDS,30,1,3600);
const maxVus=integer(__ENV.MAX_VUS,Math.max(vus,10),vus,500);
const pause=integer(__ENV.PAUSE_MS,200,0,60000);
const summaryPath=__ENV.SUMMARY_PATH||'data/k6-summary.json';
const audit=__ENV.AUDIT==='1';
export const options={
 noCookiesReset:true, // Each VU is one reader, across repeated visits.
 maxRedirects:0,
 systemTags:['status','method','name','scenario','expected_response'],
 scenarios:{readers:mode==='smoke'
  ?{executor:'per-vu-iterations',vus,iterations:visits,maxDuration:'10m',gracefulStop:'20s'}
  :{executor:'constant-arrival-rate',rate,timeUnit:'1s',duration:`${duration}s`,preAllocatedVUs:vus,maxVUs:maxVus,gracefulStop:'30s'}},
 thresholds:{checks:['rate==1'],flow_failed:['rate==0'],
  http_req_duration:['p(95)<5000'],completed_visits:['count>0'],
  ...(mode==='load'?{dropped_iterations:['count==0']}:{completed_visits:[`count==${vus*visits}`]})}
};
const flowFailed=new Rate('flow_failed'),completed=new Counter('completed_visits');
const accepted=new Counter('events_accepted'),duplicates=new Counter('events_duplicate'),unconfirmed=new Counter('events_unconfirmed');
const offered=new Counter('offered_records'),retries=new Counter('event_retries');
let readerId=null;
function body(response){try{return response.json();}catch{return null;}}
function params(name){return {headers:{Origin:base,'Content-Type':'application/json'},tags:{name},timeout:'10s',redirects:0};}
function ensure(ok,name){
 check(ok,{[name]:v=>Boolean(v)});
 if(!ok){flowFailed.add(true);execution.test.abort(name);}
}
function auditRow(row){if(audit)console.log(JSON.stringify(row));}
function session(){
 const r=http.post(base+'/api/behavior/session',JSON.stringify({reader_id:readerId}),params('behavior/session'));
 ensure(r.status===200&&body(r)?.reader_id===readerId,'collection_session_ready');
}
function uuid(){
 const b=new Uint8Array(crypto.randomBytes(16));b[6]=(b[6]&15)|64;b[8]=(b[8]&63)|128;
 const h=Array.from(b,x=>x.toString(16).padStart(2,'0')).join('');
 return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
}
export function setup(){
 const r=http.get(base+'/api/behavior/status',params('behavior/status'));
 ensure(r.status===200&&body(r)?.enabled===true,'collection_enabled_preflight');
 return {run_id:uuid()};
}
function sendEvent(event,context){
 const payload=JSON.stringify({events:[event]}); // Freeze ID, time and body across attempts.
 let recovered=false;
 const {served_receipt:receipt,...auditableEvent}=event;
 auditRow({...context,kind:'event_intent',event:auditableEvent}); // Never persist signed receipts.
 for(let attempt=0;attempt<3;attempt++){
  const r=http.post(base+'/api/behavior/events',payload,params('behavior/events'));
  const result=body(r),state=ackState(r.status,result,event.event_id);
  if(state==='accepted'||state==='duplicate'){
   (state==='accepted'?accepted:duplicates).add(1);
   check(true,{event_ack_verified:v=>v});
   auditRow({...context,kind:'event_ack',event_id:event.event_id,status:state,ack_stage:result.ack_stage??'database'});return;
  }
  if(r.status===403&&result?.error==='SESSION_REQUIRED'&&!recovered){session();recovered=true;}
  else if(state==='fatal')break;
  if(attempt<2){
   const raw=r.headers['Retry-After'];
   const backoff=raw===undefined?0:(/^\d+$/.test(raw)?Number(raw):(Date.parse(raw)-Date.now())/1000);
   if(Number.isFinite(backoff)&&backoff>30)break;
   retries.add(1);sleep(Math.max(2**attempt,Number.isFinite(backoff)?backoff:0));
  }
 }
 unconfirmed.add(1);auditRow({...context,kind:'event_unconfirmed',event_id:event.event_id});
 ensure(false,'event_ack_verified');
}
export default function(data){
 const group=input.groups[(execution.vu.idInTest-1)%input.groups.length];
 // VU-local in both executors; scenario.iterationInTest would be global.
 const visit=execution.vu.iterationInScenario;
 const pattern=group.sessions[visit%group.sessions.length];
 // Repeat anonymous issuance with the existing jar to verify reader continuity.
 const response=http.post(base+'/api/v1/user/anonymous',null,params('user/anonymous'));
 const id=body(response)?.reader_id;
 ensure(response.status===200&&typeof id==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id),'backend_reader_issued');
 ensure(readerId===null||readerId===id,'same_reader_across_visits');
 readerId=id;session();
 const context={run_id:data.run_id,vu:execution.vu.idInTest,visit,reader_key:group.reader.reader_key,reader_id:readerId};
 auditRow({...context,kind:'reader_binding'});
 const feedResponse=http.post(base+'/api/v1/news/feed','{}',params('news/feed'));
 const feed=body(feedResponse);
 ensure(feedResponse.status===200&&validFeed(feed,readerId),'feed_and_served_ack_verified');
 offered.add(feed.items.length);
 auditRow({...context,kind:'feed',ack_stage:feed.collection_ack_stage??'database',request_id:feed.request_id,served_at:feed.served_at,items:feed.items.map(i=>({article_id:i.article_id,impression_id:i.impression_id,position:i.position}))});
 let clicks;
 try{clicks=selectClicks(pattern,feed.items,input.articles,selection);}catch{ensure(false,'article_mapping_valid');return;}
 for(const item of clicks){
  sleep(pause/1000);
  sendEvent({event_id:uuid(),event_type:'article_open',event_time:new Date().toISOString(),impression_id:item.impression_id,page_type:'list',...(item.served_receipt?{served_receipt:item.served_receipt}:{})},
   {...context,article_id:item.article_id});
 }
 completed.add(1);flowFailed.add(false);
 sleep(pause/1000);
}
export function handleSummary(data){
 const result={mode,selection,source_on_server:'browser',inference_verified:false,database_verified:false,gcs_verified:false,
  notes:'HTTP API simulation; no actual browser exposure. rank mode transfers click positions/counts, not article semantics.',metrics:data.metrics};
 return {[summaryPath]:JSON.stringify(result,null,2),stdout:JSON.stringify({summary:summaryPath,completed_visits:data.metrics.completed_visits?.values?.count||0,accepted:data.metrics.events_accepted?.values?.count||0,duplicates:data.metrics.events_duplicate?.values?.count||0})+'\n'};
}
