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
