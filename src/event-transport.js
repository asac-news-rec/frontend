export function createEventTransport({send, notify=()=>{}, now=Date.now, schedule=setTimeout, cancel=clearTimeout, retryDelay=attempt=>Math.min(30000,1000*2**Math.min(attempt-1,5))*(.8+Math.random()*.4), timeout=10000, ttl=1800000, limit=500, byteLimit=524288}) {
 const pending=new Map();let active=false,generation=0;
 const report=(type,entry,extra={})=>notify({type,event:entry?.event,pending:pending.size,...extra});
 function remove(entry){cancel(entry.timer);cancel(entry.deadline);pending.delete(entry.event.event_id);}
 function stop(){active=false;generation++;for(const entry of pending.values())remove(entry);report('stopped');}
 function attempt(entry){
  if(!active||entry.inflight||!pending.has(entry.event.event_id))return;
  cancel(entry.timer);
  if(now()-entry.created>=ttl){remove(entry);report('expired',entry);return;}
  const version=generation;entry.inflight=true;entry.attempts++;report('sending',entry);
  let settled=false;
  // A timed-out underlying request may still complete; retries retain the same ID.
  function finish(error,response){
   if(settled)return;settled=true;cancel(entry.deadline);
   if(version!==generation||!active||pending.get(entry.event.event_id)!==entry)return;
   entry.inflight=false;
   const ack=response?.results?.find(result=>result.event_id===entry.event.event_id);
   if(!error&&['accepted','duplicate'].includes(ack?.status)){remove(entry);report(ack.status,entry,{response});return;}
   if(!error&&ack?.status==='rejected'){remove(entry);report('rejected',entry,{response});return;}
   report('retrying',entry,{error:error?.message||'UNCONFIRMED_ACK'});
   entry.timer=schedule(()=>attempt(entry),Math.min(retryDelay(entry.attempts),Math.max(0,ttl-(now()-entry.created))));
  }
  entry.deadline=schedule(()=>finish(new Error('TIMEOUT')),timeout);
  try{Promise.resolve(send({events:[entry.event]})).then(response=>finish(null,response),error=>finish(error));}catch(error){finish(error);}
 }
 return {
  start(){active=true;}, stop,
  enqueue(event){
   if(!active)return;
   const fixed=JSON.parse(JSON.stringify(event)),id=fixed.event_id;
   if(pending.has(id))return;
   const bytes=new TextEncoder().encode(JSON.stringify(fixed)).length;
   if(bytes>byteLimit){report('dropped',{event:fixed});return;}
   let total=[...pending.values()].reduce((sum,e)=>sum+e.bytes,0);
   while(pending.size>=limit||total+bytes>byteLimit){const oldest=pending.values().next().value;total-=oldest.bytes;remove(oldest);report('dropped',oldest);}
   const entry={event:fixed,bytes,created:now(),attempts:0,inflight:false};pending.set(id,entry);attempt(entry);
  },
  retry(){for(const entry of pending.values())attempt(entry);},
  get pendingCount(){return pending.size;}
 };
}
