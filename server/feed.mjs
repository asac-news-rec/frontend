import {articles} from '../src/data.js';
export function createVisitorFeed({readerId=null,likedIds=[],now=Date.now()}) {
  const cutoff=new Date(now).toISOString();
  const available=articles.filter(article=>article.publishedAt<=cutoff);
  const preferences=new Map();
  const liked=new Set(likedIds);
  for(const article of available)if(liked.has(article.id))preferences.set(article.category,(preferences.get(article.category)||0)+1);
  const strategy=preferences.size?'liked_categories':'latest';
  const sorted=[...available].sort((a,b)=>(preferences.get(b.category)||0)-(preferences.get(a.category)||0)||b.publishedAt.localeCompare(a.publishedAt)||a.id.localeCompare(b.id));
  return {readerId,generatedAt:cutoff,strategy,contentOrigin:'synthetic',items:sorted.map((article,index)=>({article,rank:index+1,reason:preferences.has(article.category)?`좋아요한 ${article.category} 기사를 참고했어요`:'최근 발행된 기사예요'}))};
}
