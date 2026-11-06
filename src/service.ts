import type {Feed, FeedMode} from './types.js';
import {articles,readers,sampleOrders} from './data.js';
export function createSampleFeed(readerId: string, category: string='전체', now=new Date()) {
  const reader=readers.find(item=>item.id===readerId);
  if(!reader) throw new Error('독자를 찾을 수 없습니다.');
  return {
    id:`sample-${readerId}-${now.getTime()}`,readerId,generatedAt:now.toISOString(),strategy:reader.isNew?'latest':'sample_interest',
    items:sampleOrders[readerId].map((id,index)=>{
      const article=articles.find(item=>item.id===id);
      if (!article) throw new Error('UNKNOWN_SAMPLE_ARTICLE');
      return {article,rank:index+1,reason:reader.isNew?'관심사 설정 전, 최신순으로 둘러보세요':reader.interests.includes(article.category)?`공개된 ${article.category} 관심사에 맞춘 샘플 추천`:'다양한 주제를 둘러보는 샘플 추천'};
    }).filter(item=>category==='전체'||item.article.category===category)
  };
}
export async function getFeed(readerId: string,category: string,mode: FeedMode='normal') {
  await new Promise(resolve=>setTimeout(resolve,mode==='loading'?1800:350));
  if(mode==='error') throw new Error('뉴스를 불러오지 못했어요. 잠시 후 다시 시도해 주세요.');
  const feed=createSampleFeed(readerId,category);
  return mode==='empty'?{...feed,items:[]}:feed;
}
export function getArticle(id: string) {return articles.find(article=>article.id===id)??null;}

export async function getCategories(): Promise<string[]> {
  const response = await fetch('/api/v1/categories', {cache:'no-store'});
  if (!response.ok) throw new Error('카테고리를 불러오지 못했어요. 다시 시도해 주세요.');
  const payload = await response.json();
  if (!Array.isArray(payload.data) || !payload.data.length || payload.data.some((value: unknown) => typeof value !== 'string' || !value.trim())) throw new Error('카테고리 응답 형식이 올바르지 않습니다.');
  return [...new Set<string>(payload.data)];
}
export async function getFeedPage(readerId: string, category: string, mode: FeedMode='normal', offset=0, limit=3) {
  const feed = await getFeed(readerId, category, mode);
  const items = feed.items.slice(offset, offset + limit);
  return {...feed, items, nextOffset:offset + items.length < feed.items.length ? offset + items.length : null};
}

export async function getVisitorFeed(): Promise<Feed> {
 const response=await fetch('/api/v1/feed',{cache:'no-store',credentials:'same-origin'});
 if(!response.ok)throw new Error('피드를 불러오지 못했어요. 다시 시도해 주세요.');
 const {data}=await response.json();
 if(!data||!['latest','liked_categories'].includes(data.strategy)||!Array.isArray(data.items)||data.items.some((item: {article?: {id?: unknown; title?: unknown}; reason?: unknown})=>!item.article||typeof item.article.id!=='string'||typeof item.article.title!=='string'||typeof item.reason!=='string'))throw new Error('피드 응답 형식이 올바르지 않습니다.');
 return data;
}
