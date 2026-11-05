import './contract-mock-api.js';
import {getPersistentReaderId} from './reader-identity.js';
import {getBackendPage} from './backend-api.js';
export const backendMode=typeof location!=='undefined'&&new URLSearchParams(location.search).get('feed')==='backend';
export const contractMode = typeof location !== 'undefined' && ['mock','logging','backend'].includes(new URLSearchParams(location.search).get('feed'));
export const loggingMode=typeof location!=='undefined'&&new URLSearchParams(location.search).get('feed')==='logging';
async function postDemo(route,body){const response=await fetch('/api/v1/logging-demo/'+route,{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});const result=await response.json();if(!response.ok){const error=new Error(result.error||'HTTP_ERROR');error.status=response.status;throw error;}return result;}
const api = globalThis.NewsContractMock.createMockApi();
const cache = new Map();
export async function getContractPage(cursor = null) {
  if(backendMode)return getBackendPage(cursor??0);
  const readerId = await getPersistentReaderId();
  const response = await (loggingMode?postDemo('feed',{reader_id:readerId,cursor}):api.getFeed({reader_id: readerId, cursor}));
  const items = response.items.map(item => {
    const article = {id:item.article_id, title:item.title, summary:item.summary ?? '',
      paragraphs:item.paragraphs, body:item.paragraphs.join('\n\n'), category:item.category,
      publisher:item.publisher ?? '언론사 미제공', publishedAt:item.published_at,
      imageUrl:item.image_url, imageCaption:item.image_caption, synthetic:item.is_synthetic,
      impressionId:item.impression_id, requestId:response.request_id, art:'library'};
    return {article, rank:item.position, reason:'', impressionId:item.impression_id};
  });
  return {generatedAt:response.served_at, strategy:'mock_contract', requestId:response.request_id,
    items, nextOffset:response.next_cursor};
}
export function acceptContractItems(items) { for (const item of items) cache.set(item.article.id,item.article); }
export function getContractArticle(id) { return cache.get(id) ?? null; }

let actionOffline=false, loseNextResponse=false, actionDelay=0;
export function configureMockActions({offline,loseResponse,delay}={}) {
 if(offline!==undefined)actionOffline=offline;
 if(loseResponse!==undefined)loseNextResponse=loseResponse;
 if(delay!==undefined)actionDelay=delay;
}
export async function sendContractEvents(body) {
 const lose=loseNextResponse;loseNextResponse=false;
 const delay=actionDelay;
 if(delay)await new Promise(resolve=>setTimeout(resolve,delay));
 if(actionOffline)throw new Error('MOCK_OFFLINE');
 let response;try{response=loggingMode?await postDemo('events',body):await api.send(body);}catch(error){if([400,401,403,409,413,415].includes(error.status))return {results:body.events.map(e=>({event_id:e.event_id,status:'rejected',code:error.message}))};throw error;}
 if(lose)throw new Error('MOCK_RESPONSE_LOST_AFTER_STORE');
 return response;
}
