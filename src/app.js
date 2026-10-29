import {readers,categories} from './data.js';
import {getFeed,getArticle} from './service.js';
const main=document.querySelector('main');
const state={readerId:readers[0].id,category:'전체',status:'loading',feed:null,articleId:null,mode:'normal',error:'',request:0};
const escape=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const date=value=>new Intl.DateTimeFormat('ko-KR',{timeZone:'Asia/Seoul',month:'long',day:'numeric',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date(value));
const art=(article,extra='')=>`<div class="art art-${article.art} ${extra}" aria-hidden="true"><span class="orb"></span><span class="shape"></span><span class="art-word">${escape(article.category==='IT·과학'?'DISCOVER':article.category==='스포츠'?'MOVE':'EVERYDAY')}</span><span class="art-caption">SAI ORIGINAL · ILLUSTRATION</span></div>`;
function card(item,index){const a=item.article;return `<a class="card ${index===0?'lead':''}" href="#article/${a.id}" data-article="${a.id}">${art(a)}<div class="card-copy"><div class="eyebrow"><span>${escape(a.category)}</span><span class="fiction">가상 기사</span></div><h3>${escape(a.title)}</h3><p>${escape(a.summary)}</p><div class="article-date">${date(a.publishedAt)}</div><div class="reason"><span>↗</span> ${escape(item.reason)}</div></div></a>`;}
function render(){
  if(state.articleId){renderArticle();return;}
  const reader=readers.find(r=>r.id===state.readerId);
  main.innerHTML=`<section class="intro"><div><div class="overline">YOUR DAILY PERSPECTIVE</div><h1>오늘의 세상,<br><em>나의 관심사</em>로 읽다.</h1><p>새로운 소식과 뜻밖의 발견을 한곳에서 만나보세요.</p></div><div class="intro-aside"><span class="edition">SAI NEWS / FIRST EDITION</span><div class="edition-line"></div><p>하나의 세상,<br>서로 다른 시선.</p><span class="edition">PERSONALIZED READING</span></div></section>
  <section class="reader-panel" aria-label="가상 독자 선택"><div class="avatar">${reader.isNew?'+':escape(reader.name.slice(0,1))}</div><div class="reader-info"><label for="reader">지금 살펴보는 가상 독자</label><select id="reader">${readers.map(r=>`<option value="${r.id}" ${r.id===reader.id?'selected':''}>${escape(r.name)} · ${escape(r.description)}</option>`).join('')}</select></div><div class="interests"><span>공개된 초기 관심사</span><strong>${escape(reader.interests.join(', ')||'아직 없어요')}</strong></div><span class="sample-tag">샘플 피드</span></section>
  ${reader.isNew?'<aside class="new-reader"><strong>처음 오셨군요. 우선 새로운 소식부터 만나보세요.</strong><span>관심사와 이용 이력이 없어 가상 기사를 최신순으로 보여드려요.</span></aside>':''}
  <section class="feed"><div class="feed-heading"><div><span class="overline">FOR YOU</span><h2>${reader.isNew?'새롭게 둘러보는 뉴스':`${escape(reader.name)}님을 위한 뉴스`}</h2></div><button id="refresh" class="refresh">↻ <span>다시 불러오기</span></button></div><div class="feed-meta"><span>미리 구성한 시연 데이터이며 실제 모델의 예측 결과가 아닙니다.</span><span>${state.feed?`목록 생성 · ${date(state.feed.generatedAt)}`:'목록을 준비하고 있어요'}</span></div>
  <nav class="categories" aria-label="기사 카테고리">${categories.map(c=>`<button data-category="${c}" aria-pressed="${state.category===c}" class="${state.category===c?'active':''}">${c}</button>`).join('')}</nav>
  <div id="results" aria-live="polite" aria-busy="${state.status==='loading'}">${results()}</div></section>
  <details class="demo"><summary>팀 검토용 · 화면 상태 시연</summary><p>화면 동작만 전환합니다. 실제 서버 요청이나 모델 실행은 발생하지 않습니다.</p><div>${[['normal','기본 화면'],['loading','느린 로딩'],['empty','기사 없음'],['error','조회 실패']].map(([value,label])=>`<button data-mode="${value}" aria-pressed="${state.mode===value}">${label}</button>`).join('')}</div></details>`;
  main.querySelector('#reader').onchange=e=>{state.readerId=e.target.value;state.feed=null;load();};
  main.querySelector('#refresh').onclick=()=>load();
  main.querySelectorAll('[data-category]').forEach(b=>b.onclick=()=>{state.category=b.dataset.category;load();});
  main.querySelectorAll('[data-mode]').forEach(b=>b.onclick=()=>{state.mode=b.dataset.mode;load();});
  const retry=main.querySelector('#retry');if(retry)retry.onclick=()=>{state.mode='normal';load();};
}
function results(){
  if(state.status==='loading')return '<div class="loading-label" role="status">뉴스를 준비하고 있어요…</div><div class="skeleton-grid">'+Array.from({length:3},()=>'<div class="skeleton"><div></div><span></span><span></span></div>').join('')+'</div>';
  if(state.status==='error')return `<div class="empty"><span class="empty-icon">!</span><h3>잠시 연결이 어려워요</h3><p>${escape(state.error)}</p><button class="primary" id="retry">다시 시도</button></div>`;
  if(!state.feed?.items.length)return '<div class="empty"><span class="empty-icon">○</span><h3>아직 준비된 기사가 없어요</h3><p>다른 카테고리를 선택하거나 시연 메뉴에서 기본 화면으로 돌아가 보세요.</p></div>';
  return `<div class="cards">${state.feed.items.map(card).join('')}</div><div class="end-note">오늘의 발견이 내일의 관심사가 되도록.</div>`;
}
async function load(){const token=++state.request;state.status='loading';render();try{const feed=await getFeed(state.readerId,state.category,state.mode);if(token!==state.request)return;state.feed=feed;state.status='ready';}catch(error){if(token!==state.request)return;state.status='error';state.error=error.message;}render();}
function renderArticle(){const a=getArticle(state.articleId);if(!a){main.innerHTML='<div class="empty"><h1>기사를 찾을 수 없어요</h1><a href="#">뉴스 피드로 돌아가기</a></div>';return;}
  main.innerHTML=`<article class="article-page"><a class="back" href="#">← 뉴스 피드로 돌아가기</a><div class="eyebrow"><span>${escape(a.category)}</span><span class="fiction">가상 기사</span></div><h1>${escape(a.title)}</h1><p class="article-summary">${escape(a.summary)}</p><div class="byline">사이 뉴스 시연 편집부 <span>${date(a.publishedAt)} KST</span></div>${art(a,'article-art')}<p class="illustration-note">기사 내용을 표현한 그래픽 일러스트</p><div class="article-body">${a.body.split('\n\n').map(p=>`<p>${escape(p)}</p>`).join('')}</div><aside class="source-note"><strong>화면 검토용 가상 기사입니다.</strong><p>인물·사건·내용은 창작 예시이며 실제 보도가 아닙니다. 외부 원문과 실제 취재 출처는 없습니다. 클릭과 읽기 시간은 외부로 전송하지 않습니다.</p></aside><a class="back bottom-back" href="#">← 뉴스 피드로 돌아가기</a></article>`;
}
window.addEventListener('hashchange',()=>{state.articleId=location.hash.startsWith('#article/')?decodeURIComponent(location.hash.slice(9)):null;render();main.focus();window.scrollTo(0,0);});
state.articleId=location.hash.startsWith('#article/')?decodeURIComponent(location.hash.slice(9)):null;
load();
