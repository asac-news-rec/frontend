let enabled=false;
const impressions=new Map<string,string>();
export async function initializeSyntheticEvents(){
 try{const response=await fetch('/api/synthetic/status',{credentials:'same-origin'});if(response.ok)enabled=(await response.json()).enabled===true;}catch{enabled=false;}
}
export function rememberSyntheticImpressions(items:{article_id:string;impression_id:string}[]){
 for(const item of items)impressions.set(item.article_id,item.impression_id);
}
export async function recordSyntheticOpen(articleId:string){
 const impressionId=impressions.get(articleId);
 if(!enabled||!impressionId)return;
 const event={event_id:crypto.randomUUID(),event_type:'article_open',event_time:new Date().toISOString(),impression_id:impressionId,page_type:'list'};
 // One event per actual list click. Failures are visible to the browser runner.
 try{
  const response=await fetch('/api/synthetic/events',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({events:[event]})});
  if(!response.ok)throw new Error('SYNTHETIC_EVENT_FAILED');
  const ack=await response.json();
  if(ack.results?.length!==1||!['accepted','duplicate'].includes(ack.results[0].status))throw new Error('SYNTHETIC_EVENT_REJECTED');
 }catch{document.dispatchEvent(new CustomEvent('synthetic-logging-error'));}
}
