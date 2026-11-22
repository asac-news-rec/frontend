import {backendReaderEpoch,recoverBackendReader} from './reader-identity.js';
import type {Article, ArticleSummary, Feed, FeedItem} from './types.js';
import {likeButton,seedBackendLikes,backendLikeRevision,resetBackendLikes} from './likes.js';
import {getBackendArticle,getBackendPage,getBackendCategories,getBackendSubcategories,type FeedCursor} from './backend-api.js';
import {initializeSyntheticEvents,recordSyntheticOpen} from './synthetic-events.js';
import {initializeBehavior,connectBehavior,resetBehaviorIdentity} from './behavior-events.js';
let pendingOpen:{articleId:string;impressionId:string}|null=null;
const backendArticles=new Map<string, ArticleSummary>();
const main=document.querySelector('main')!;
const behavior=connectBehavior(main);
let feedScrollY=0;
let detail:Article|null=null;
let detailStatus='loading';
let detailError='';
let detailRequest=0;
let readerRecoveryFailed=false;
let categories: string[]=[];
let subcategories: string[]=[];
let subcategoryRequest=0;
let observer: IntersectionObserver | undefined;
let nextCursor: FeedCursor | null=null;
let loadingMore=false;
let moreError='';
let categoryError='';
history.scrollRestoration='manual';
window.addEventListener('scroll',()=>{
  if(!state.articleId&&!location.hash.startsWith('#article/'))feedScrollY=window.scrollY;
},{passive:true});
main.addEventListener('click',event=>{
  pendingOpen=null;
  if(event.isTrusted&&event.target instanceof Element&&!state.articleId&&event.button===0&&!event.ctrlKey&&!event.metaKey&&!event.shiftKey){
    const link=event.target.closest<HTMLAnchorElement>('a[data-article]');
    const articleId=link?.dataset.article,impressionId=link?.dataset.impressionId;
    if(articleId&&impressionId)pendingOpen={articleId,impressionId};
  }
  if(!state.articleId&&event.target instanceof Element&&event.target.closest('a[data-article]')&&!event.ctrlKey&&!event.metaKey&&!event.shiftKey&&event.button===0)feedScrollY=window.scrollY;
});
const state={category:'전체',subcategory:'전체',status:'loading',feed:null as Feed | null,articleId:null as string | null,error:'',request:0};
const selectedFilters=()=>({category:state.category==='전체'?null:state.category,subcategory:state.subcategory==='전체'?null:state.subcategory});
const escape=(value: unknown)=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c as '&' | '<' | '>' | '"' | "'"]));
const date=(value: string)=>new Intl.DateTimeFormat('ko-KR',{timeZone:'Asia/Seoul',month:'long',day:'numeric',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date(value));
const art=(article: ArticleSummary,extra='')=>{let image='';if(article.imageUrl){try{const url=new URL(article.imageUrl,location.href);if(['http:','https:'].includes(url.protocol))image=`<img class="article-photo" src="${escape(url.href)}" alt="" loading="lazy">`;}catch{}}return `<div class="art art-${article.art} ${extra}" aria-hidden="true"><span class="orb"></span><span class="shape"></span><span class="art-word">${escape(article.category==='IT·과학'?'DISCOVER':article.category==='스포츠'?'MOVE':'EVERYDAY')}</span><span class="art-caption">SAI ORIGINAL · ILLUSTRATION</span>${image}</div>`;};
main.addEventListener('error',event=>{if(event.target instanceof Element&&event.target.matches('.article-photo'))event.target.remove();},true);
function card(item: FeedItem){const a=item.article;return `<div class="news-row"><a class="card" href="#article/${encodeURIComponent(a.id)}" data-article="${escape(a.id)}" data-impression-id="${escape(a.impressionId??'')}">${art(a)}<div class="card-copy"><div class="eyebrow"><span>${escape(a.category)}</span><span class="fiction">${a.synthetic?'가상 기사':'뉴스 기사'}</span></div><h3>${escape(a.title)}</h3><p>${escape(a.summary)}</p><div class="article-date"><span class="publisher">${escape(a.publisher)}</span> · ${date(a.publishedAt)}</div><div class="reason"><span>↗</span> ${escape(item.reason)}</div></div></a>${likeButton(a.id)}</div>`;}
function render(){
  behavior.beforeRender();
  observer?.disconnect();
  if(state.articleId){renderArticle();return;}
  const restoreSubcategoryFocus=document.activeElement?.id==='subcategory';
  main.innerHTML=`<section class="intro"><div><div class="overline">YOUR DAILY PERSPECTIVE</div><h1>오늘의 세상,<br><em>나의 관심사</em>로 읽다.</h1><p>새로운 소식과 뜻밖의 발견을 한곳에서 만나보세요.</p></div><div class="intro-aside"><span class="edition">SAI NEWS / FIRST EDITION</span><div class="edition-line"></div><p>하나의 세상,<br>서로 다른 시선.</p><span class="edition">PERSONALIZED READING</span></div></section>
  <section class="feed"><div class="feed-heading"><div><span class="overline">FOR YOU</span><h2>최신 뉴스</h2></div><button id="refresh" class="refresh">↻ <span>다시 불러오기</span></button></div><div class="feed-meta"><span>${state.feed?`목록 생성 · ${date(state.feed.generatedAt)}`:'목록을 준비하고 있어요'}</span></div>
  <nav class="categories" aria-label="기사 카테고리">${categories.map(c=>`<button data-category="${escape(c)}" aria-pressed="${state.category===c}" class="${state.category===c?'active':''}">${escape(c)}</button>`).join('')}</nav>
  ${state.category!=='전체'?`<div class="subcategory-filter"><label for="subcategory">소분류</label><select id="subcategory"><option value="전체">전체</option>${subcategories.map(c=>`<option value="${escape(c)}" ${state.subcategory===c?'selected':''}>${escape(c)}</option>`).join('')}</select></div>`:''}
  ${categoryError?`<p role="alert">${escape(categoryError)} <button id="category-retry">다시 시도</button></p>`:''}<div id="results" aria-live="polite" aria-busy="${state.status==='loading'}">${results()}</div></section>`;
  main.querySelector<HTMLButtonElement>('#refresh')!.onclick=()=>load();
  main.querySelectorAll<HTMLButtonElement>('[data-category]').forEach(b=>b.onclick=()=>{state.category=b.dataset.category ?? state.category;state.subcategory='전체';subcategories=[];load();if(state.category!=='전체')loadSubcategories(state.category);});
  main.querySelector<HTMLSelectElement>('#subcategory')?.addEventListener('change',event=>{state.subcategory=(event.target as HTMLSelectElement).value;load();});
  main.querySelector('#category-retry')?.addEventListener('click',()=>{if(state.category==='전체')loadCategories();else loadSubcategories(state.category);});
  if(restoreSubcategoryFocus)main.querySelector<HTMLSelectElement>('#subcategory')?.focus({preventScroll:true});
  connectMore();behavior.observe();
  const retry=main.querySelector<HTMLButtonElement>('#retry');if(retry)retry.onclick=()=>{if(readerRecoveryFailed)void recoverBackendReader(backendReaderEpoch(),{force:true}).catch(()=>{});else void load();};
}
function results(){
  if(state.status==='loading')return '<div class="loading-label" role="status">뉴스를 준비하고 있어요…</div><div class="skeleton-grid">'+Array.from({length:3},()=>'<div class="skeleton"><div></div><span></span><span></span></div>').join('')+'</div>';
  if(state.status==='error')return `<div class="empty"><span class="empty-icon">!</span><h3>잠시 연결이 어려워요</h3><p>${escape(state.error)}</p><button class="primary" id="retry">다시 시도</button></div>`;
  if(!state.feed?.items.length)return '<div class="empty"><span class="empty-icon">○</span><h3>아직 준비된 기사가 없어요</h3><p>다른 카테고리를 선택하거나 다시 불러와 주세요.</p></div>';
  return `<div class="cards">${state.feed.items.map(card).join('')}</div><div id="pagination">${pagination()}</div>`;
}
function pagination(){
  if(moreError)return `<p role="alert">${escape(moreError)}</p><button id="more">다시 불러오기</button>`;
  if(nextCursor===null)return '<p class="end-note">모든 기사를 확인했어요.</p>';
  return `<div id="sentinel" role="status">${loadingMore?'기사를 더 불러오고 있어요…':'아래로 내리면 기사가 이어집니다.'}</div><button id="more" ${loadingMore?'disabled':''}>기사 더 보기</button>`;
}
function connectMore(){
  main.querySelector('#more')?.addEventListener('click',loadMore);
  const target=main.querySelector('#sentinel');
  if(target&&nextCursor!==null&&!moreError&&'IntersectionObserver' in window){
    observer=new IntersectionObserver(entries=>{if(entries.some(entry=>entry.isIntersecting))loadMore();},{rootMargin:'0px 0px 240px 0px'});
    observer.observe(target);
  }
}
async function loadMore(){
  if(!state.feed||loadingMore||nextCursor===null||state.articleId||state.status!=='ready')return;
  const token=state.request,likesAtStart=backendLikeRevision();
  const cursor=nextCursor;
  loadingMore=true;moreError='';
  const panel=main.querySelector('#pagination');
  if(panel)panel.innerHTML=pagination();
  try{
    const page=await getBackendPage(cursor,{filters:selectedFilters()});
    if(token!==state.request)return;
    const known=new Set(state.feed.items.map(item=>item.article.id));
    const added=page.items.filter(item=>!known.has(item.article.id));
    state.feed.items.push(...added);nextCursor=page.nextCursor;added.forEach(item=>backendArticles.set(item.article.id,item.article));seedBackendLikes(added,false,likesAtStart);
    if(!state.articleId)main.querySelector('.cards')?.insertAdjacentHTML('beforeend',added.map(card).join(''));behavior.observe();
  }catch(error){if(token!==state.request)return;moreError=error instanceof Error ? error.message : String(error);}
  finally{
    if(token===state.request){loadingMore=false;observer?.disconnect();const current=main.querySelector('#pagination');if(current){current.innerHTML=pagination();connectMore();}}
  }
}
async function load(){
  const token=++state.request,likesAtStart=backendLikeRevision();state.status='loading';nextCursor=null;loadingMore=false;moreError='';render();
  try{
    const feed=await getBackendPage(null,{filters:selectedFilters()});if(token!==state.request)return;
    state.feed=feed;nextCursor=feed.nextCursor;backendArticles.clear();feed.items.forEach(item=>backendArticles.set(item.article.id,item.article));seedBackendLikes(feed.items,true,likesAtStart);state.status='ready';
  }
  catch(error){if(token!==state.request)return;state.status='error';state.error=error instanceof Error ? error.message : String(error);if(state.error==='BACKEND_HTTP_401')readerRecoveryFailed=true;}
  render();
}
async function loadCategories(){
  try{
    categories=['전체',...await getBackendCategories()];
    categoryError='';
  }catch(error){
    categoryError='카테고리를 불러오지 못했습니다.';
  }
  render();
}
async function initialize(){
  categories=['전체'];
  await Promise.all([state.articleId?loadArticle():load(),loadCategories()]);
}
async function loadSubcategories(category: string){
 const token=++subcategoryRequest;
 try{const list=await getBackendSubcategories(category);if(token!==subcategoryRequest||state.category!==category)return;subcategories=list;categoryError='';render();}
 catch(error){if(token!==subcategoryRequest||state.category!==category)return;categoryError=error instanceof Error?error.message:String(error);render();}
}
async function loadArticle(){
 const id=state.articleId;if(id===null)return;
 const token=++detailRequest,likesAtStart=backendLikeRevision();detail=null;detailStatus='loading';detailError='';render();
 try{
  const result=await getBackendArticle(id);
  if(token!==detailRequest||state.articleId!==id)return;
  detail=result.article;detailStatus='ready';
  // A detail response started before a like completed must not undo that mutation.
  seedBackendLikes([{article:detail,rank:0,reason:'',isLiked:result.isLiked}],false,likesAtStart);
 }catch(error){
  if(token!==detailRequest||state.articleId!==id)return;
  detailStatus='error';detailError=error instanceof Error?error.message:String(error);
 }
 render();
}
function renderArticle(){
 if(state.articleId===null)return;
 if(detailStatus==='loading'){main.innerHTML='<div class="empty" role="status"><p>기사 본문을 불러오고 있어요…</p><a class="back" href="#">뉴스 피드로 돌아가기</a></div>';return;}
 if(detailStatus==='error'||!detail){
  const missing=detailError==='BACKEND_HTTP_404';
  main.innerHTML=`<div class="empty" role="alert"><h1>${missing?'기사를 찾을 수 없어요':'기사 본문을 불러오지 못했어요'}</h1><p>${missing?'삭제되었거나 존재하지 않는 기사입니다.':'잠시 후 다시 시도해 주세요.'}</p><button id="detail-retry" class="primary">다시 시도</button><a class="back" href="#">뉴스 피드로 돌아가기</a></div>`;
  main.querySelector('#detail-retry')?.addEventListener('click',()=>void loadArticle());return;
 }
 const a=detail;
  main.innerHTML=`<article class="article-page" data-impression-id="${escape(backendArticles.get(a.id)?.impressionId??'')}"><a class="back" href="#">← 뉴스 피드로 돌아가기</a><div class="eyebrow"><span>${escape(a.category)}</span><span class="fiction">${a.synthetic?'가상 기사':'뉴스 기사'}</span></div><h1>${escape(a.title)}</h1><p class="article-summary">${escape(a.summary)}</p>${likeButton(a.id)}<div class="byline">${escape(a.publisher)} <span>${date(a.publishedAt)} KST</span></div>${art(a,'article-art')}<p class="illustration-note">기사 내용을 표현한 그래픽 일러스트</p><div class="article-body">${a.body.split('\n\n').map(p=>`<p>${escape(p)}</p>`).join('')}</div><aside class="source-note"><strong>백엔드 뉴스 API에서 받은 기사입니다.</strong><p>기사의 가상 여부는 상단 표기를 확인해 주세요.</p></aside><a class="back bottom-back" href="#">← 뉴스 피드로 돌아가기</a></article>`;
}
window.addEventListener('hashchange',()=>{
  const articleId=articleFromHash();
  if(articleId===state.articleId)return;
  state.articleId=articleId;++detailRequest;
  if(articleId)void loadArticle();
  else if(!state.feed)void load();
  else render();
  main.focus({preventScroll:true});
  if(articleId&&pendingOpen?.articleId===articleId&&backendArticles.has(articleId))void recordSyntheticOpen(pendingOpen.impressionId);
  pendingOpen=null;
  requestAnimationFrame(()=>window.scrollTo({top:state.articleId?0:feedScrollY,left:0,behavior:'instant'}));
});
function articleFromHash(){try{return location.hash.startsWith('#article/')?decodeURIComponent(location.hash.slice(9)):null;}catch{return null;}}
state.articleId=articleFromHash();
void Promise.all([initializeSyntheticEvents(),initializeBehavior()]).then(initialize).catch(error=>{state.status='error';state.error=error instanceof Error?error.message:String(error);render();});

window.addEventListener('backend-reader-recovering',()=>{
 readerRecoveryFailed=false;++state.request;++detailRequest;
 resetBehaviorIdentity();resetBackendLikes();
 state.feed=null;backendArticles.clear();nextCursor=null;loadingMore=false;moreError='';
 state.articleId=null;pendingOpen=null;feedScrollY=0;detail=null;detailStatus='loading';state.status='loading';
 history.replaceState(null,'',location.pathname+location.search);render();
});
window.addEventListener('backend-reader-recovered',()=>{
 const epoch=backendReaderEpoch();
 void initializeBehavior().then(()=>{if(epoch===backendReaderEpoch())void load();});
});
window.addEventListener('backend-reader-recovery-failed',()=>{
 readerRecoveryFailed=true;
 state.status='error';state.error='독자 연결을 복구하지 못했습니다. 다시 시도해 주세요.';render();
});
