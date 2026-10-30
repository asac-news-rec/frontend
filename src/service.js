import {articles,readers,sampleOrders} from './data.js';
/** @typedef {{id:string,readerId:string,generatedAt:string,strategy:string,items:{article:import('./data.js').Article,rank:number,reason:string}[]}} Recommendation */
export function createSampleFeed(readerId, category='전체', now=new Date()) {
  const reader=readers.find(item=>item.id===readerId);
  if(!reader) throw new Error('독자를 찾을 수 없습니다.');
  return {
    id:`sample-${readerId}-${now.getTime()}`,readerId,generatedAt:now.toISOString(),strategy:reader.isNew?'latest':'sample_interest',
    items:sampleOrders[readerId].map((id,index)=>{
      const article=articles.find(item=>item.id===id);
      return {article,rank:index+1,reason:reader.isNew?'관심사 설정 전, 최신순으로 둘러보세요':reader.interests.includes(article.category)?`공개된 ${article.category} 관심사에 맞춘 샘플 추천`:'다양한 주제를 둘러보는 샘플 추천'};
    }).filter(item=>category==='전체'||item.article.category===category)
  };
}
export async function getFeed(readerId,category,mode='normal') {
  await new Promise(resolve=>setTimeout(resolve,mode==='loading'?1800:350));
  if(mode==='error') throw new Error('뉴스를 불러오지 못했어요. 잠시 후 다시 시도해 주세요.');
  const feed=createSampleFeed(readerId,category);
  return mode==='empty'?{...feed,items:[]}:feed;
}
export function getArticle(id) {return articles.find(article=>article.id===id)??null;}

export async function getCategories() {
  const response = await fetch('/api/v1/categories', {cache:'no-store'});
  if (!response.ok) throw new Error('카테고리를 불러오지 못했어요. 다시 시도해 주세요.');
  const payload = await response.json();
  if (!Array.isArray(payload.data) || !payload.data.length || payload.data.some(value => typeof value !== 'string' || !value.trim())) throw new Error('카테고리 응답 형식이 올바르지 않습니다.');
  return [...new Set(payload.data)];
}
export async function getFeedPage(readerId, category, mode='normal', offset=0, limit=3) {
  const feed = await getFeed(readerId, category, mode);
  const items = feed.items.slice(offset, offset + limit);
  return {...feed, items, nextOffset:offset + items.length < feed.items.length ? offset + items.length : null};
}
