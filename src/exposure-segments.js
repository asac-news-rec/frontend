export function createSegments({emit, now=()=>performance.now(), timestamp=()=>new Date().toISOString(),
 uuid=()=>crypto.randomUUID()}) {
 const active=new Map();
 const elapsed=segment=>Math.max(0,Math.round(now()-segment.mono));
 return {
  start(id){
   if(!id||active.has(id))return;
   active.set(id,{mono:now(),wall:Date.parse(timestamp())});
  },
  stop(id){
   const segment=active.get(id);if(!segment)return;
   active.delete(id);const duration=elapsed(segment);if(duration<=0)return;
   emit({event_id:uuid(),event_type:'exposure',event_time:new Date(segment.wall).toISOString(),
    ended_at:new Date(segment.wall+duration).toISOString(),impression_id:id,page_type:'list',duration_ms:duration});
  },
  stopAll(){for(const id of [...active.keys()])this.stop(id);},
  clear(){active.clear();}
 };
}
