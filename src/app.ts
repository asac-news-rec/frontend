import type {Article, Feed, FeedItem} from './types.js';
import {likeButton,seedBackendLikes} from './likes.js';
import {getBackendPage,getBackendCategories,getBackendSubcategories} from './backend-api.js';
import {initializeSyntheticEvents,recordSyntheticOpen} from './synthetic-events.js';
let pendingOpen:string|null=null;
const backendArticles=new Map<string, Article>();
const main=document.querySelector('main')!;
let feedScrollY=0;
let categories: string[]=[];
let subcategories: string[]=[];
let subcategoryRequest=0;
let observer: IntersectionObserver | undefined;
let nextOffset: number | null=null;
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
    pendingOpen=event.target.closest<HTMLAnchorElement>('a[data-article]')?.dataset.article??null;
  }
  if(!state.articleId&&event.target instanceof Element&&event.target.closest('a[data-article]')&&!event.ctrlKey&&!event.metaKey&&!event.shiftKey&&event.button===0)feedScrollY=window.scrollY;
});
const state={category:'전체',subcategory:'전체',status:'loading',feed:null as Feed | null,articleId:null as string | null,error:'',request:0};
const selectedFilters=()=>({category:state.category==='전체'?null:state.category,subcategory:state.subcategory==='전체'?null:state.subcategory});
const escape=(value: unknown)=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c as '&' | '<' | '>' | '"' | "'"]));
const date=(value: string)=>new Intl.DateTimeFormat('ko-KR',{timeZone:'Asia/Seoul',month:'long',day:'numeric',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date(value));
const art=(article: Article,extra='')=>{let image='';if(article.imageUrl){try{const url=new URL(article.imageUrl,location.href);if(['http:','https:'].includes(url.protocol))image=`<img class="article-photo" src="${escape(url.href)}" alt="" loading="lazy">`;}catch{}}return `<div class="art art-${article.art} ${extra}" aria-hidden="true"><span class="orb"></span><span class="shape"></span><span class="art-word">${escape(article.category==='IT·과학'?'DISCOVER':article.category==='스포츠'?'MOVE':'EVERYDAY')}</span><span class="art-caption">SAI ORIGINAL · ILLUSTRATION</span>${image}</div>`;};
main.addEventListener('error',event=>{if(event.target instanceof Element&&event.target.matches('.article-photo'))event.target.remove();},true);
function card(item: FeedItem){const a=item.article;return `<div class="news-row"><a class="card" href="#article/${encodeURIComponent(a.id)}" data-article="${escape(a.id)}">${art(a)}<div class="card-copy"><div class="eyebrow"><span>${escape(a.category)}</span><span class="fiction">${a.synthetic?'가상 기사':'뉴스 기사'}</span></div><h3>${escape(a.title)}</h3><p>${escape(a.summary)}</p><div class="article-date"><span class="publisher">${escape(a.publisher)}</span> · ${date(a.publishedAt)}</div><div class="reason"><span>↗</span> ${escape(item.reason)}</div></div></a>${likeButton(a.id)}</div>`;}
function render(){
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
  connectMore();
  const retry=main.querySelector<HTMLButtonElement>('#retry');if(retry)retry.onclick=()=>load();
}
function results(){
  if(state.status==='loading')return '<div class="loading-label" role="status">뉴스를 준비하고 있어요…</div><div class="skeleton-grid">'+Array.from({length:3},()=>'<div class="skeleton"><div></div><span></span><span></span></div>').join('')+'</div>';
  if(state.status==='error')return `<div class="empty"><span class="empty-icon">!</span><h3>잠시 연결이 어려워요</h3><p>${escape(state.error)}</p><button class="primary" id="retry">다시 시도</button></div>`;
  if(!state.feed?.items.length)return '<div class="empty"><span class="empty-icon">○</span><h3>아직 준비된 기사가 없어요</h3><p>다른 카테고리를 선택하거나 다시 불러와 주세요.</p></div>';
  return `<div class="cards">${state.feed.items.map(card).join('')}</div><div id="pagination">${pagination()}</div>`;
}
function pagination(){
  if(moreError)return `<p role="alert">${escape(moreError)}</p><button id="more">다시 불러오기</button>`;
  if(nextOffset===null)return '<p class="end-note">모든 기사를 확인했어요.</p>';
  return `<div id="sentinel" role="status">${loadingMore?'기사를 더 불러오고 있어요…':'아래로 내리면 기사가 이어집니다.'}</div><button id="more" ${loadingMore?'disabled':''}>기사 더 보기</button>`;
}
function connectMore(){
  main.querySelector('#more')?.addEventListener('click',loadMore);
  const target=main.querySelector('#sentinel');
  if(target&&nextOffset!==null&&!moreError&&'IntersectionObserver' in window){
    observer=new IntersectionObserver(entries=>{if(entries.some(entry=>entry.isIntersecting))loadMore();},{rootMargin:'0px 0px 240px 0px'});
    observer.observe(target);
  }
}
async function loadMore(){
  if(!state.feed||loadingMore||nextOffset===null||state.articleId||state.status!=='ready')return;
  const token=state.request;
  const offset=nextOffset;
  loadingMore=true;moreError='';
  const panel=main.querySelector('#pagination');
  if(panel)panel.innerHTML=pagination();
  try{
    const page=await getBackendPage(offset,{filters:selectedFilters()});
    if(token!==state.request)return;
    const known=new Set(state.feed.items.map(item=>item.article.id));
    const added=page.items.filter(item=>!known.has(item.article.id));
    state.feed.items.push(...added);nextOffset=page.nextOffset;added.forEach(item=>backendArticles.set(item.article.id,item.article));seedBackendLikes(added);
    if(!state.articleId)main.querySelector('.cards')?.insertAdjacentHTML('beforeend',added.map(card).join(''));
  }catch(error){if(token!==state.request)return;moreError=error instanceof Error ? error.message : String(error);}
  finally{
    if(token===state.request){loadingMore=false;observer?.disconnect();const current=main.querySelector('#pagination');if(current){current.innerHTML=pagination();connectMore();}}
  }
}
async function load(){
  const token=++state.request;state.status='loading';nextOffset=null;loadingMore=false;moreError='';render();
  try{
    const feed=await getBackendPage(0,{filters:selectedFilters()});if(token!==state.request)return;
    state.feed=feed;nextOffset=feed.nextOffset;backendArticles.clear();feed.items.forEach(item=>backendArticles.set(item.article.id,item.article));seedBackendLikes(feed.items,true);state.status='ready';
  }
  catch(error){if(token!==state.request)return;state.status='error';state.error=error instanceof Error ? error.message : String(error);}
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
  await Promise.all([load(),loadCategories()]);
}
async function loadSubcategories(category: string){
 const token=++subcategoryRequest;
 try{const list=await getBackendSubcategories(category);if(token!==subcategoryRequest||state.category!==category)return;subcategories=list;categoryError='';render();}
 catch(error){if(token!==subcategoryRequest||state.category!==category)return;categoryError=error instanceof Error?error.message:String(error);render();}
}
function renderArticle(){if(state.articleId===null)return;const a=backendArticles.get(state.articleId);if(!a){main.innerHTML='<div class="empty"><h1>기사를 찾을 수 없어요</h1><a href="#">뉴스 피드로 돌아가기</a></div>';return;}
  main.innerHTML=`<article class="article-page"><a class="back" href="#">← 뉴스 피드로 돌아가기</a><div class="eyebrow"><span>${escape(a.category)}</span><span class="fiction">${a.synthetic?'가상 기사':'뉴스 기사'}</span></div><h1>${escape(a.title)}</h1><p class="article-summary">${escape(a.summary)}</p>${likeButton(a.id)}<div class="byline">${escape(a.publisher)} <span>${date(a.publishedAt)} KST</span></div>${art(a,'article-art')}<p class="illustration-note">기사 내용을 표현한 그래픽 일러스트</p><div class="article-body">${a.body.split('\n\n').map(p=>`<p>${escape(p)}</p>`).join('')}</div><aside class="source-note"><strong>백엔드 뉴스 API에서 받은 기사입니다.</strong><p>기사의 가상 여부는 상단 표기를 확인해 주세요.</p></aside><a class="back bottom-back" href="#">← 뉴스 피드로 돌아가기</a></article>`;
}
window.addEventListener('hashchange',()=>{
  const articleId=location.hash.startsWith('#article/')?decodeURIComponent(location.hash.slice(9)):null;
  if(articleId===state.articleId)return;
  state.articleId=articleId;
  render();
  main.focus({preventScroll:true});
  if(articleId&&pendingOpen===articleId&&backendArticles.has(articleId))void recordSyntheticOpen(articleId);
  pendingOpen=null;
  requestAnimationFrame(()=>window.scrollTo({top:state.articleId?0:feedScrollY,left:0,behavior:'instant'}));
});
state.articleId=location.hash.startsWith('#article/')?decodeURIComponent(location.hash.slice(9)):null;
void initializeSyntheticEvents().then(initialize);
