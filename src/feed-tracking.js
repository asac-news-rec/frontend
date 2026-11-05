import {createEventTransport} from './event-transport.js';
import {createSegments} from './exposure-segments.js';
import {createLikeEvent} from './likes-client.js';
import {sendContractEvents,configureMockActions,loggingMode} from './contract-feed.js';
export function connectFeedTracking(main) {
 let enabled=false,scrolling=false,scrollTimer,openingDetail=null,activeDetail=null;
 const visible=new Set(),observed=new Set();
 const panel=document.createElement('details');panel.className='visitor';
 panel.innerHTML='<summary>모의 행동 측정·전송 기록</summary><p>이 탭의 모의 API로만 전송합니다. 새로고침하면 기록이 사라집니다.</p><label><input id="tracking-enabled" type="checkbox"> 모의 측정 시작</label> <label><input id="tracking-offline" type="checkbox"> 전송 장애</label> <label><input id="tracking-delay" type="checkbox"> 응답 3초 지연</label> <button id="tracking-loss">다음 응답 유실</button> <button id="tracking-retry">지금 재시도</button><p role="status"></p><div class="tracking-log"></div>';
 if(loggingMode){panel.querySelector('summary').textContent='로컬 로깅 서버 측정·전송 기록';panel.querySelector('label').lastChild.textContent=' 시험 행동 측정 시작';}
 if(loggingMode)panel.querySelector('p').textContent='시험 행동을 실제 로컬 로깅 서버로 전송합니다. SQLite·로컬 JSONL 저장, GCS 미연결. 아래 장애 스위치는 클라이언트 시뮬레이션입니다.';
 panel.open=true;main.before(panel);const toggle=panel.querySelector('input'),status=panel.querySelector('[role=status]'),log=panel.querySelector('.tracking-log');
 let sent=0,failed=0;
 const transport=createEventTransport({send:sendContractEvents,notify:result=>{
  if(result.type==='sending')sent++;
  if(result.type==='retrying')failed++;
  status.textContent=`전송 시도 ${sent} · 실패/미확인 ${failed} · 대기 ${result.pending} · ${result.type}`;
  if(result.event){const row=document.createElement('pre');row.textContent=JSON.stringify({state:result.type,request:{events:[result.event]},response:result.response,error:result.error},null,2);log.prepend(row);}
  while(log.children.length>60)log.lastChild.remove();
 }});
 function emit(event){if(enabled)transport.enqueue(event);}
 panel.querySelector('#tracking-offline').onchange=event=>{configureMockActions({offline:event.target.checked});if(!event.target.checked)transport.retry();};
 panel.querySelector('#tracking-delay').onchange=event=>configureMockActions({delay:event.target.checked?3000:0});
 panel.querySelector('#tracking-loss').onclick=()=>configureMockActions({loseResponse:true});
 panel.querySelector('#tracking-retry').onclick=()=>transport.retry();
 window.addEventListener('online',()=>transport.retry());
 const segments=createSegments({emit});
 const detailId=()=>main.querySelector('.article-page')?.dataset.impressionId;
 function closeDetail(pageExit=false){
  if(!activeDetail)return;
  const event={event_id:crypto.randomUUID(),event_type:'article_close',event_time:new Date().toISOString(),impression_id:activeDetail,page_type:'detail'};
  if(pageExit&&loggingMode&&navigator.sendBeacon){
   navigator.sendBeacon('/api/v1/logging-demo/events',new Blob([JSON.stringify({events:[event]})],{type:'application/json'}));
  }else emit(event);
  activeDetail=null;
 }
 function resume() {
  if(!enabled||document.hidden)return;
  if(!detailId()&&!scrolling)for(const node of visible)if(node.isConnected)segments.start(node.dataset.impressionId);
 }
 const observer=new IntersectionObserver(entries=>{
  for(const entry of entries){const node=entry.target,id=node.dataset.impressionId;
   if(entry.isIntersecting&&entry.intersectionRatio>=.5){visible.add(node);}else{visible.delete(node);segments.stop(id);}
  }resume();
 },{threshold:[0,.5,1]});
 function observe() {
  if(enabled&&openingDetail&&detailId()===openingDetail)activeDetail=openingDetail;
  openingDetail=null;
  for(const node of main.querySelectorAll('.card[data-impression-id]'))if(!observed.has(node)){observed.add(node);observer.observe(node);}
  resume();
 }
 function beforeRender(){
  const article=main.querySelector('.article-page');
  if(article&&location.hash!==`#article/${encodeURIComponent(article.dataset.articleId)}`)closeDetail();
  segments.stopAll();observer.disconnect();visible.clear();observed.clear();
 }
 function stop(){activeDetail=null;openingDetail=null;enabled=false;toggle.checked=false;segments.clear();transport.stop();}
 toggle.onchange=()=>{enabled=toggle.checked;if(enabled){transport.start();resume();}else stop();};
 window.addEventListener('visitor-reset',stop);window.addEventListener('visitor-changed',stop);
 window.addEventListener('scroll',()=>{
  if(detailId())return;
  if(!scrolling){scrolling=true;segments.stopAll();}
  clearTimeout(scrollTimer);scrollTimer=setTimeout(()=>{scrolling=false;resume();},300);
 },{passive:true});
 document.addEventListener('visibilitychange',()=>{if(document.hidden)segments.stopAll();else resume();});
 window.addEventListener('pagehide',()=>{closeDetail(true);segments.stopAll();transport.stop();});
 window.addEventListener('pageshow',()=>{if(enabled){transport.start();resume();}});
 function open(event){const link=event.target.closest('a[data-article]');if(!link||!enabled)return;
  if(event.type==='auxclick'&&event.button!==1)return;if(event.type==='click'&&event.button!==0)return;
  segments.stopAll();emit({event_id:crypto.randomUUID(),event_type:'article_open',event_time:new Date().toISOString(),impression_id:link.dataset.impressionId,page_type:'list'});
  if(!event.ctrlKey&&!event.metaKey&&!event.shiftKey&&event.type!=='auxclick')openingDetail=link.dataset.impressionId;
  // Modified clicks can leave this page visible, so start a fresh segment here.
  if(event.ctrlKey||event.metaKey||event.shiftKey||event.type==='auxclick')resume();
 }
 main.addEventListener('click',open);main.addEventListener('auxclick',open);
 window.addEventListener('like-confirmed',event=>{
  const action=createLikeEvent(event.detail);if(action)emit(action);
 });
 return {beforeRender,observe};
}
