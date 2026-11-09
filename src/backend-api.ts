import {backendImageUrl} from './image-url.js';
import {rememberSyntheticImpressions} from './synthetic-events.js';
interface BackendArticle {
  article_id: string;
  impression_id: string;
  position: number;
  title: string;
  paragraphs: string[];
  category: string;
  subcategory?: string | null;
  published_at: string;
  is_synthetic: boolean;
  is_liked: boolean;
  summary?: string | null;
  publisher?: string | null;
  image_url?: string | null;
  image_caption?: string | null;
}

export interface BackendFilters { category?: string | null; subcategory?: string | null }

function readList(value: unknown, key: 'category_list' | 'sub_category_list'): string[] {
 if(!value || typeof value !== 'object' || !(key in value))throw new Error('INVALID_BACKEND_CATEGORIES');
 const list=(value as Record<string, unknown>)[key];
 if(!Array.isArray(list) || list.some(item=>typeof item!=='string'))throw new Error('INVALID_BACKEND_CATEGORIES');
 return list;
}

export async function getBackendCategories({fetchImpl=fetch}={}) {
 return readList(await request('/category',undefined,'POST',fetchImpl),'category_list');
}

export async function getBackendSubcategories(category: string,{fetchImpl=fetch}={}) {
 if(!category)throw new Error('INVALID_CATEGORY');
 return readList(await request('/subcategory',{category},'POST',fetchImpl),'sub_category_list');
}

const storageKey='sai-news.backend-reader-id';
const legacyStorageKey='sai-news.backend-user-id';
const uuid7=/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function request(route: string,body: object | undefined,method='POST',fetchImpl=fetch){
 const response=await fetchImpl('/api'+route,{method,credentials:'same-origin',cache:'no-store',
  ...(body===undefined?{}:{headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})});
 if(!response.ok)throw new Error(`BACKEND_HTTP_${response.status}`);
 return response.json();
}

export async function getBackendReaderId({storage=globalThis.window?.localStorage,fetchImpl=fetch,locks=globalThis.window?.navigator?.locks}={}){
 const readOrCreate=async()=>{
  if(!storage)throw new Error('BACKEND_ID_STORAGE_UNAVAILABLE');
  const existing=storage.getItem(storageKey);
  if(existing!==null){if(!uuid7.test(existing))throw new Error('INVALID_BACKEND_READER_ID');return existing;}
  const legacy=storage.getItem(legacyStorageKey);
  if(legacy!==null){
   if(!uuid7.test(legacy))throw new Error('INVALID_BACKEND_READER_ID');
   storage.setItem(storageKey,legacy);
   if(storage.getItem(storageKey)!==legacy)throw new Error('BACKEND_ID_STORAGE_UNAVAILABLE');
   return legacy;
  }
  const result=await request('/user/anonymous',undefined,'POST',fetchImpl);
  if(!(typeof result?.reader_id==='string'&&uuid7.test(result.reader_id)))throw new Error('INVALID_BACKEND_READER_ID');
  storage.setItem(storageKey,result.reader_id);
  if(storage.getItem(storageKey)!==result.reader_id)throw new Error('BACKEND_ID_STORAGE_UNAVAILABLE');
  return result.reader_id;
 };
 return locks?locks.request('sai-news-backend-reader',readOrCreate):readOrCreate();
}

export async function getBackendPage(offset=0,{fetchImpl=fetch,getReaderId=getBackendReaderId,filters={}}: {fetchImpl?: typeof fetch; getReaderId?: typeof getBackendReaderId; filters?: BackendFilters}={}){
 const readerId=await getReaderId();
 const response: {reader_id?: string; request_id: string; served_at: string; items: BackendArticle[]; next_offset: number | null}=await request('/news/feed',{reader_id:readerId,offset,...(filters.category?{category:filters.category}:{}),...(filters.subcategory?{subcategory:filters.subcategory}:{})},'POST',fetchImpl);
 if(!response||(response.reader_id!==undefined&&response.reader_id!==readerId)||typeof response.request_id!=='string'||!Number.isFinite(Date.parse(response.served_at))||
  !Array.isArray(response.items)||!(response.next_offset===null||typeof response.next_offset==='number'&&Number.isSafeInteger(response.next_offset)&&response.next_offset>=0))throw new Error('INVALID_BACKEND_FEED');
 const items=response.items.map((item: BackendArticle)=>{
  if(!item||typeof item.article_id!=='string'||typeof item.impression_id!=='string'||
   !Number.isSafeInteger(item.position)||item.position<1||typeof item.title!=='string'||
   !Array.isArray(item.paragraphs)||item.paragraphs.some((value: unknown)=>typeof value!=='string')||
   typeof item.category!=='string'||!Number.isFinite(Date.parse(item.published_at))||
   typeof item.is_synthetic!=='boolean'||typeof item.is_liked!=='boolean')throw new Error('INVALID_BACKEND_ARTICLE');
  const article={id:item.article_id,title:item.title,summary:item.summary??'',paragraphs:item.paragraphs,
   body:item.paragraphs.join('\n\n'),category:item.category,publisher:item.publisher??'언론사 미제공',
   subcategory:item.subcategory??null,publishedAt:item.published_at,imageUrl:backendImageUrl(item.image_url),imageCaption:item.image_caption??null,
   synthetic:item.is_synthetic,impressionId:item.impression_id,requestId:response.request_id,art:'library'};
  return {article,rank:item.position,reason:'',impressionId:item.impression_id,isLiked:item.is_liked};
 });
 rememberSyntheticImpressions(response.items);
 return {generatedAt:response.served_at,strategy:'backend_latest',requestId:response.request_id,
  items,nextOffset:response.next_offset};
}

export async function changeBackendLike(articleId: string,liked: boolean,{fetchImpl=fetch,getReaderId=getBackendReaderId}={}){
 const readerId=await getReaderId();
 const result=await request(`/news/${encodeURIComponent(articleId)}/like`,{reader_id:readerId},liked?'PUT':'DELETE',fetchImpl);
 if(!result||result.article_id!==articleId||result.is_liked!==liked||typeof result.changed!=='boolean')throw new Error('INVALID_BACKEND_LIKE');
 return result;
}
