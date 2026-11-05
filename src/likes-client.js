function validateRecord(record,readerId,articleId) {
 if(!record||record.reader_id!==readerId||typeof record.article_id!=='string'||!record.article_id||
    (articleId!==undefined&&record.article_id!==articleId)||typeof record.liked_at!=='string'||
    !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(record.liked_at)||!Number.isFinite(Date.parse(record.liked_at)))throw new Error('INVALID_LIKE_RESPONSE');
 return record;
}

export function createLikesApi({base='/api/v1/likes',fetchImpl=globalThis.fetch}={}) {
 async function request(method,readerId,articleId) {
  const response=await fetchImpl(base+(method==='GET'?'?reader_id='+encodeURIComponent(readerId):''),{
   method,credentials:'same-origin',cache:'no-store',
   ...(method==='GET'?{}:{headers:{'Content-Type':'application/json'},body:JSON.stringify({reader_id:readerId,article_id:articleId})})
  });
  if(response.status!==(method==='DELETE'?204:200)){const error=new Error('LIKE_REQUEST_FAILED');error.status=response.status;throw error;}
  if(method==='DELETE')return;
  const data=await response.json();
  if(method==='POST')return validateRecord(data,readerId,articleId);
  if(!Array.isArray(data))throw new Error('INVALID_LIKE_RESPONSE');
  return data.map(record=>validateRecord(record,readerId));
 }
 return {list:reader=>request('GET',reader),add:(reader,article)=>request('POST',reader,article),remove:(reader,article)=>request('DELETE',reader,article)};
}

export function createMemoryLikesApi({now=()=>new Date().toISOString()}={}) {
 const readers=new Map();
 const records=reader=>{if(!readers.has(reader))readers.set(reader,new Map());return readers.get(reader);};
 return {
  async list(reader){return [...records(reader).values()].map(record=>({...record}));},
  async add(reader,article){const map=records(reader);if(!map.has(article))map.set(article,{reader_id:reader,article_id:article,liked_at:now()});return {...map.get(article)};},
  async remove(reader,article){records(reader).delete(article);}
 };
}

export function createLikeState({api,confirmed=()=>{}}) {
 let reader=null,records=new Map(),generation=0;
 return {
  has:article=>records.has(article),
  reset(){generation++;reader=null;records.clear();},
  async refresh(readerId){
   const version=++generation;
   const result=readerId?await api.list(readerId):[];
   if(version!==generation)return;
   reader=readerId;records=new Map(result.map(record=>[record.article_id,record]));
  },
  async toggle(readerId,articleId,context){
   if(reader!==readerId)await this.refresh(readerId);
   if(reader!==readerId)return false;
   const version=generation,desired=!records.has(articleId);
   const record=desired?await api.add(readerId,articleId):await api.remove(readerId,articleId);
   if(version!==generation)return false;
   if(desired)records.set(articleId,record);else records.delete(articleId);
   confirmed({...context,article_id:articleId,liked:desired});
   return true;
  }
 };
}

export function createLikeEvent(action) {
 if(!action.impression_id)return null;
 return {event_id:crypto.randomUUID(),event_type:action.liked?'like':'unlike',event_time:action.event_time,impression_id:action.impression_id,page_type:action.page_type};
}

export function createBackendLikeState({change}) {
 const known=new Map();let generation=0;
 return {
  has:article=>known.get(article)===true,
  seed(items,replace=false){if(replace){generation++;known.clear();}for(const item of items)known.set(item.article.id,item.isLiked);},
  reset(){generation++;known.clear();},
  async refresh(){},
  async toggle(_readerId,articleId){
   if(!known.has(articleId))throw new Error('LIKE_STATE_UNAVAILABLE');
   const version=generation,desired=!known.get(articleId);
   const result=await change(articleId,desired);
   if(version!==generation)return false;
   known.set(articleId,result.is_liked);
   return result.changed;
  }
 };
}
