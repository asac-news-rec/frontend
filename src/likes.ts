import type {FeedItem} from './types.js';
import {changeBackendLike} from './backend-api.js';
const backendMode=new URLSearchParams(location.search).get('feed')!=='sample';
const liked=new Set<string>();
let status='loading';
let pending=false;
let generation=0;
const notice=document.createElement('p');
notice.className='like-notice';notice.setAttribute('role','status');document.body.append(notice);
export function likeButton(id: string){const safe=String(id).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c as '&' | '<' | '>' | '"' | "'"]));return `<button class="like-button" data-like="${safe}" aria-label="기사 좋아요" aria-pressed="${liked.has(id)}" ${pending||status==='loading'?'disabled':''}>♡ 좋아요</button>`;}
function update(){document.querySelectorAll<HTMLButtonElement>('[data-like]').forEach(button=>{const active=liked.has(button.dataset.like ?? '');button.setAttribute('aria-pressed',String(active));button.textContent='♡ 좋아요';button.disabled=pending||status==='loading';});}
export async function refreshLikes(){
 if(backendMode)return;
 const version=++generation;status='loading';update();
 try{const response=await fetch('/api/v1/likes',{cache:'no-store'});if(!response.ok&&response.status!==401)throw new Error();const ids=response.status===401?[]:(await response.json()).data;if(!Array.isArray(ids)||ids.some(id=>typeof id!=='string'))throw new Error();if(version!==generation)return;liked.clear();ids.forEach(id=>liked.add(id));status='ready';}
 catch{if(version!==generation)return;status='error';notice.textContent='좋아요 상태를 불러오지 못했어요. 버튼을 누르면 다시 확인합니다.';}update();
}
export function seedBackendLikes(items: FeedItem[],reset=false){if(!backendMode)return;if(reset)liked.clear();for(const item of items){if(item.isLiked)liked.add(item.article.id);else liked.delete(item.article.id);}status='ready';update();}
window.addEventListener('visitor-reset',()=>{generation++;liked.clear();status='ready';notice.textContent='저장한 좋아요를 삭제했습니다.';update();});
window.addEventListener('focus',()=>{if(!pending)refreshLikes();});
document.addEventListener('click',async event=>{
 const button=event.target instanceof Element ? event.target.closest<HTMLButtonElement>('[data-like]') : null;if(!button||pending)return;
 if(status==='error'){await refreshLikes();return;}
 pending=true;update();notice.textContent='';const version=generation;
 try{if(!backendMode&&!await (await import('./visitor.js')).ensureVisitor())return;if(version!==generation)return;const id=button.dataset.like;if(id===undefined)return;const desired=!liked.has(id);if(backendMode){await changeBackendLike(id,desired);}else{const response=await fetch('/api/v1/likes',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({article_id:id,liked:desired})});if(!response.ok)throw new Error();}if(version!==generation)return;if(desired)liked.add(id);else liked.delete(id);notice.textContent='';window.dispatchEvent(new Event('likes-changed'));}
 catch{notice.textContent='저장하지 못했어요. 다시 시도해 주세요.';}
 finally{pending=false;update();}
});
