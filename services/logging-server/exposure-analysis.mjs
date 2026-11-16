export const exposurePolicyVersion='list-continuous-1s-v1';

// Input is one stored action record. Derived fields are written only to analysis output.
export function classifyExposure(record){
 if(!record||typeof record!=='object'||Array.isArray(record)||typeof record.event_id!=='string'||!record.event_id||
  !['exposure','article_open','article_close','like','unlike'].includes(record.event_type)||!['list','detail'].includes(record.page_type)){
  throw new Error('INVALID_ACTION_RECORD');
 }
 if(record.event_type==='exposure'&&(!Number.isSafeInteger(record.duration_ms)||record.duration_ms<1)){
  throw new Error('INVALID_EXPOSURE_DURATION');
 }
 const valid=record.event_type==='exposure'&&record.page_type==='list'?record.duration_ms>=1000:null;
 return {...record,is_valid_list_exposure:valid,exposure_policy_version:exposurePolicyVersion};
}
