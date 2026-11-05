import {createHash} from 'node:crypto';
export class InputError extends Error { constructor(code){super(code);this.code=code;} }
const bad=code=>{throw new InputError(code);};
const id=(value)=>{if(typeof value!=='string'||!value.trim()||value.length>128)bad('INVALID_ID');return value;};
function shape(input,keys){
 if(!input||typeof input!=='object'||Array.isArray(input))bad('INVALID_OBJECT');
 if(Object.keys(input).some(k=>!keys.includes(k)))bad('UNKNOWN_FIELD');
}
export function timestamp(value){
 if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value))bad('INVALID_TIME');
 const [year,month,day]=value.slice(0,10).split('-').map(Number);
 if(month<1||month>12||day<1||day>new Date(Date.UTC(year,month,0)).getUTCDate())bad('INVALID_TIME');
 const hours=Number(value.slice(11,13)),minutes=Number(value.slice(14,16)),seconds=Number(value.slice(17,19));
 if(hours>23||minutes>59||seconds>59)bad('INVALID_TIME');
 const ms=Date.parse(value);if(!Number.isFinite(ms))bad('INVALID_TIME');return new Date(ms).toISOString();
}
function time(value,now){const iso=timestamp(value),ms=Date.parse(iso);if(ms<now-86400000||ms>now+300000)bad('TIME_OUT_OF_RANGE');return iso;}
export function parseServed(input,now){
 shape(input,['request_id','impression_id','reader_id','article_id','position','served_at']);
 const result={request_id:id(input.request_id),impression_id:id(input.impression_id),reader_id:id(input.reader_id),article_id:id(input.article_id)};
 if(!Number.isSafeInteger(input.position)||input.position<1)bad('INVALID_POSITION');
 return {...result,position:input.position,served_at:time(input.served_at,now)};
}
export function parseAction(input,now){
 shape(input,['event_id','event_type','event_time','impression_id','page_type','duration_ms','ended_at']);
 if(typeof input.event_id!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.event_id))bad('INVALID_EVENT_ID');
 if(!['exposure','article_open','article_close','like','unlike'].includes(input.event_type)||!['list','detail'].includes(input.page_type))bad('INVALID_EVENT');
 const result={event_id:input.event_id.toLowerCase(),event_type:input.event_type,event_time:time(input.event_time,now),impression_id:id(input.impression_id),page_type:input.page_type};
 if(input.event_type==='exposure'){
  if(!Number.isSafeInteger(input.duration_ms)||input.duration_ms<1||input.duration_ms>86400000)bad('INVALID_DURATION');
  result.duration_ms=input.duration_ms;result.ended_at=time(input.ended_at,now);
  if(Date.parse(result.ended_at)<Date.parse(result.event_time))bad('INVALID_INTERVAL');
 }else if('duration_ms' in input||'ended_at' in input||(input.event_type==='article_open'&&input.page_type!=='list')||(input.event_type==='article_close'&&input.page_type!=='detail'))bad('INVALID_EVENT_FIELDS');
 if(input.event_type==='exposure'&&input.page_type!=='list')bad('INVALID_EVENT_FIELDS');
 if(Buffer.byteLength(JSON.stringify(input),'utf8')>4096)bad('EVENT_TOO_LARGE');return result;
}
export function parseEnvelope(body,key){shape(body,[key]);if(!Array.isArray(body[key])||body[key].length<1||body[key].length>100)bad('INVALID_ENVELOPE');return body[key];}
export function canonical(record){const json=JSON.stringify(record);return {json,hash:createHash('sha256').update(json).digest('hex')};}
export function contextReader(context){return id(context?.readerId);}
