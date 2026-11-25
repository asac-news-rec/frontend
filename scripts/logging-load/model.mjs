// Pure data/contract helpers shared by Node tests and k6. No credentials.
export function integer(value, fallback, min, max) {
 const n=value===undefined?fallback:Number(value);
 if(!Number.isSafeInteger(n)||n<min||n>max)throw new Error('INVALID_INTEGER_OPTION');
 return n;
}
export function origin(value) {
 if(typeof value!=='string'||!/^https?:\/\/[^/?#@\s]+\/?$/.test(value))throw new Error('BASE_URL_MUST_BE_ORIGIN');
 const base=value.replace(/\/$/,'');
 if(base.startsWith('http:')&&!/^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(base))throw new Error('REMOTE_HTTPS_REQUIRED');
 return base;
}
export function dataset(patterns,mapping) {
 if(patterns.metadata?.run_id!==mapping.run_id||!patterns.metadata?.run_id)throw new Error('MAPPING_RUN_MISMATCH');
 const readers=mapping.readers,articles=mapping.articles;
 if(!Array.isArray(readers)||!readers.length||!Array.isArray(articles)||!articles.length)throw new Error('EMPTY_MAPPING');
 if(new Set(readers.map(r=>r.reader_key)).size!==readers.length||new Set(articles.map(a=>a.article_key)).size!==articles.length)throw new Error('DUPLICATE_KEY');
 const keys=new Set(articles.map(a=>a.article_key));
 const groups=readers.map(reader=>({reader,sessions:patterns.sessions.filter(s=>s.reader_key===reader.reader_key)}));
 if(groups.reduce((n,g)=>n+g.sessions.length,0)!==patterns.sessions.length)throw new Error('UNKNOWN_READER');
 if(new Set(patterns.sessions.map(s=>s.session_key)).size!==patterns.sessions.length)throw new Error('DUPLICATE_SESSION');
 for(const group of groups){
  if(!group.sessions.length)throw new Error('EMPTY_READER');
  for(const s of group.sessions){
   if(!Array.isArray(s.offered_article_keys)||!s.offered_article_keys.length||s.offered_article_keys.some(k=>!keys.has(k))||new Set(s.offered_article_keys).size!==s.offered_article_keys.length)throw new Error('INVALID_OFFERED');
   if(!Array.isArray(s.clicks)||s.clicks.some(c=>!s.offered_article_keys.includes(c.article_key)))throw new Error('INVALID_CLICK');
  }
 }
 return {groups,articles};
}
export function validFeed(feed,reader) {
 return Boolean(feed&&feed.collection_enabled===true&&(feed.reader_id===undefined||feed.reader_id===reader)
  &&typeof feed.request_id==='string'&&feed.request_id&&Number.isFinite(Date.parse(feed.served_at))
  &&Array.isArray(feed.items)&&feed.items.length>0
  &&feed.items.every(i=>typeof i.article_id==='string'&&i.article_id&&typeof i.impression_id==='string'&&i.impression_id&&Number.isSafeInteger(i.position)&&i.position>0)
  &&new Set(feed.items.map(i=>i.impression_id)).size===feed.items.length);
}
export function selectClicks(session,items,articles,mode) {
 if(!['rank','mapped'].includes(mode))throw new Error('INVALID_SELECTION');
 return session.clicks.map(click=>{
  let item;
  if(mode==='mapped'){
   const mapped=articles.find(a=>a.article_key===click.article_key)?.backend_article_id;
   if(typeof mapped!=='string'||!mapped)throw new Error('BACKEND_ARTICLE_MAPPING_REQUIRED');
   item=items.find(i=>i.article_id===mapped);
  }else{
   item=items[session.offered_article_keys.indexOf(click.article_key)];
  }
  if(!item)throw new Error('SELECTED_ARTICLE_NOT_IN_FEED');
  return item;
 });
}
export function ackState(status,body,eventId) {
 if(status===0||status===408||status===429||status>=500)return 'retry';
 if(status!==200)return 'fatal';
 const rows=body?.results;
 if(!Array.isArray(rows)||rows.length!==1||rows[0]?.event_id!==eventId)return 'retry';
 const state=rows[0].status;
 return state==='accepted'||state==='duplicate'?state:state==='rejected'?'fatal':'retry';
}
