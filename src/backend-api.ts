import {setBehaviorCollection} from './behavior-events.js';
import {getBackendReaderId,backendReaderEpoch,recoverBackendReader,confirmBackendReader} from './reader-identity.js';
export {getBackendReaderId} from './reader-identity.js';
import type {ArticleSummary} from './types.js';
import {backendImageUrl} from './image-url.js';
interface BackendArticle {
  article_id: string;
  title: string;
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

async function request(route: string,body: object | undefined,method='POST',fetchImpl=fetch){
 const epoch=backendReaderEpoch();
 const response=await fetchImpl('/api/v1'+route,{method,credentials:'same-origin',cache:'no-store',
  ...(body===undefined?{}:{headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})});
 if(epoch!==backendReaderEpoch())throw new Error('BACKEND_SESSION_CHANGED');
 if(response.status===401&&route.startsWith('/news/')){
  await recoverBackendReader(epoch,{fetchImpl});
  throw new Error('BACKEND_SESSION_CHANGED');
 }
 if(!response.ok)throw new Error(`BACKEND_HTTP_${response.status}`);
 const payload=await response.json();
 if(epoch!==backendReaderEpoch())throw new Error('BACKEND_SESSION_CHANGED');
 if(route.startsWith('/news/'))confirmBackendReader(epoch);
 return payload;
}

export interface FeedCursor { published_at: string; article_id: string; returned_count: number }

function isFeedCursor(value: FeedCursor | null): boolean {
 return value===null||Boolean(value&&typeof value.published_at==='string'&&Number.isFinite(Date.parse(value.published_at))&&
  typeof value.article_id==='string'&&value.article_id.length&&Number.isSafeInteger(value.returned_count)&&value.returned_count>0);
}

export async function getBackendPage(cursor: FeedCursor | null=null,{fetchImpl=fetch,getReaderId=getBackendReaderId,filters={}}: {fetchImpl?: typeof fetch; getReaderId?: typeof getBackendReaderId; filters?: BackendFilters}={}){
 const readerId=await getReaderId();
 const response: {collection_enabled?:boolean; reader_id?: string; request_id: string; served_at: string; items: (BackendArticle & {impression_id:string;position:number})[]; next_cursor: FeedCursor | null}=await request('/news/feed',{...(cursor===null?{}:{cursor}),...(filters.category?{category:filters.category}:{}),...(filters.subcategory?{subcategory:filters.subcategory}:{})},'POST',fetchImpl);
 if(!response||(response.reader_id!==undefined&&response.reader_id!==readerId)||typeof response.request_id!=='string'||!Number.isFinite(Date.parse(response.served_at))||
  !Array.isArray(response.items)||!isFeedCursor(response.next_cursor))throw new Error('INVALID_BACKEND_FEED');
 const items=response.items.map(item=>{
  const article=readArticle(item);
  if(typeof item.impression_id!=='string'||!Number.isSafeInteger(item.position)||item.position<1)throw new Error('INVALID_BACKEND_ARTICLE');
  article.impressionId=item.impression_id;
  return {article,rank:item.position,reason:'',impressionId:item.impression_id,isLiked:item.is_liked};
 });
 if(typeof response.collection_enabled==='boolean')setBehaviorCollection(response.collection_enabled);
 return {generatedAt:response.served_at,strategy:'backend_latest',requestId:response.request_id,
  items,nextCursor:response.next_cursor};
}

export async function changeBackendLike(articleId: string,liked: boolean,{fetchImpl=fetch}={}){
 const result=await request(`/news/${encodeURIComponent(articleId)}/like`,undefined,liked?'PUT':'DELETE',fetchImpl);
 if(!result||result.article_id!==articleId||result.is_liked!==liked||typeof result.changed!=='boolean')throw new Error('INVALID_BACKEND_LIKE');
 return result;
}

function readArticle(value: unknown): ArticleSummary {
 const item=value as BackendArticle;
 if(!item||typeof item.article_id!=='string'||!item.article_id||typeof item.title!=='string'||
  typeof item.category!=='string'||!Number.isFinite(Date.parse(item.published_at))||
  typeof item.is_synthetic!=='boolean'||typeof item.is_liked!=='boolean'||
  (item.summary!=null&&typeof item.summary!=='string')||(item.publisher!=null&&typeof item.publisher!=='string'))throw new Error('INVALID_BACKEND_ARTICLE');
 return {id:item.article_id,title:item.title,summary:item.summary??'',category:item.category,
  publisher:item.publisher??'언론사 미제공',subcategory:item.subcategory??null,publishedAt:item.published_at,
  imageUrl:backendImageUrl(item.image_url),synthetic:item.is_synthetic,art:'library'};
}

export async function getBackendArticle(articleId: string,{fetchImpl=fetch,getReaderId=getBackendReaderId}: {fetchImpl?:typeof fetch;getReaderId?:typeof getBackendReaderId}={}) {
 await getReaderId();
 const response=await request(`/news/${encodeURIComponent(articleId)}`,undefined,'GET',fetchImpl);
 if(!response||typeof response.request_id!=='string'||!Number.isFinite(Date.parse(response.served_at)))throw new Error('INVALID_BACKEND_DETAIL');
 const article=readArticle(response.content);
 if(article.id!==articleId||!Array.isArray(response.content.paragraphs)||response.content.paragraphs.some((p:unknown)=>typeof p!=='string'))throw new Error('INVALID_BACKEND_DETAIL');
 // Detail requests have their own request_id and do not create a feed impression.
 return {article:{...article,body:response.content.paragraphs.join('\n\n')},isLiked:response.content.is_liked as boolean};
}
