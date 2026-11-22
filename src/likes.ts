import {recordBehavior} from './behavior-events.js';
import type {FeedItem} from './types.js';
import {changeBackendLike} from './backend-api.js';
const liked=new Set<string>();
let status='loading';
let pending=false;
let likeRequest=0;
let revision=0;
const changedAt=new Map<string,number>();
export const backendLikeRevision=()=>revision;
const notice=document.createElement('p');
notice.className='like-notice';notice.setAttribute('role','status');document.body.append(notice);
export function likeButton(id: string){const safe=String(id).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c as '&' | '<' | '>' | '"' | "'"]));return `<button class="like-button" data-like="${safe}" aria-label="기사 좋아요" aria-pressed="${liked.has(id)}" ${pending||status==='loading'?'disabled':''}>♡ 좋아요</button>`;}
function update(){document.querySelectorAll<HTMLButtonElement>('[data-like]').forEach(button=>{const active=liked.has(button.dataset.like ?? '');button.setAttribute('aria-pressed',String(active));button.textContent='♡ 좋아요';button.disabled=pending||status==='loading';});}
export function resetBackendLikes(){likeRequest++;revision++;changedAt.clear();liked.clear();pending=false;status='loading';notice.textContent='';update();}
export function seedBackendLikes(items: FeedItem[],reset=false,requestedAt=revision){
 if(reset)for(const id of liked)if((changedAt.get(id)??0)<=requestedAt)liked.delete(id);
 for(const item of items){
  const id=item.article.id;
  if((changedAt.get(id)??0)>requestedAt)continue;
  if(item.isLiked)liked.add(id);else liked.delete(id);
 }
 status='ready';update();
}
document.addEventListener('click',async event=>{
 const button=event.target instanceof Element ? event.target.closest<HTMLButtonElement>('[data-like]') : null;if(!button||pending)return;
 const detail=button.closest<HTMLElement>('.article-page');
 const impression=detail??button.closest('.news-row')?.querySelector<HTMLElement>('.card');
 const context={id:impression?.dataset.impressionId,page:detail?'detail':'list',at:new Date().toISOString()};
 const token=++likeRequest;pending=true;update();notice.textContent='';
 try{const id=button.dataset.like;if(id===undefined)return;const desired=!liked.has(id);const result=await changeBackendLike(id,desired);if(token!==likeRequest)return;if(result.changed&&event.isTrusted)recordBehavior(desired?'like':'unlike',context.id,context.page,{event_time:context.at});if(desired)liked.add(id);else liked.delete(id);changedAt.set(id,++revision);notice.textContent='';window.dispatchEvent(new Event('likes-changed'));}
 catch{if(token===likeRequest)notice.textContent='저장하지 못했어요. 다시 시도해 주세요.';}
 finally{if(token===likeRequest){pending=false;update();}}
});
