import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import {createDevServer} from '../.local/server/dev-http.js';

test('partial served commit preserves news, disables actions and keeps fresh retry IDs separate',async t=>{
 const rows=new Map(),reader='019a0000-0000-7000-8000-000000000001';let actionRequests=0;
 const listen=async server=>{server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>new Promise(r=>server.close(r)));return `http://127.0.0.1:${server.address().port}`;};
 const logger=await listen(createServer(async(req,res)=>{
  const chunks=[];for await(const b of req)chunks.push(b);const body=JSON.parse(Buffer.concat(chunks).toString());
  if(req.url==='/events')actionRequests++;
  if(body.records?.length===1){res.writeHead(503,{'Content-Type':'application/json'});res.end('{}');return;}
  const results=body.records.map(r=>{const status=rows.has(r.impression_id)?'duplicate':'accepted';rows.set(r.impression_id,r);return {impression_id:r.impression_id,status};});
  res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({results}));
 }));
 const backend=await listen(createServer((req,res)=>{res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(req.url==='/api/user/anonymous'?{reader_id:reader}:{request_id:randomUUID(),served_at:new Date().toISOString(),next_offset:null,items:Array.from({length:101},(_,i)=>({impression_id:randomUUID(),article_id:'a'+i,position:i+1}))}));}));
 const reserve=createServer();reserve.listen(0,'127.0.0.1');await once(reserve,'listening');const port=reserve.address().port;await new Promise(r=>reserve.close(r));const origin=`http://127.0.0.1:${port}`;
 const web=createDevServer({root:process.cwd(),origin,backendBaseUrl:backend,logging:{url:logger,token:randomUUID()}});web.listen(port,'127.0.0.1');await once(web,'listening');t.after(()=>new Promise(r=>web.close(r)));
 const post=(path,body,cookie='')=>fetch(origin+path,{method:'POST',headers:{Origin:origin,Cookie:cookie,...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});
 const issued=await post('/api/user/anonymous');let cookie=issued.headers.get('set-cookie').split(';')[0];
 const session=await post('/api/behavior/session',{reader_id:reader},cookie);cookie+='; '+session.headers.get('set-cookie').split(';')[0];
 const firstResponse=await post('/api/news/feed',{reader_id:reader,offset:0},cookie);assert.equal(firstResponse.status,200);const first=await firstResponse.json();
 assert.equal(first.collection_enabled,false);assert.equal(first.items.length,101);assert.equal(rows.size,100);assert.equal(actionRequests,0);
 const secondResponse=await post('/api/news/feed',{reader_id:reader,offset:0},cookie);assert.equal(secondResponse.status,200);const second=await secondResponse.json();
 assert.equal(second.collection_enabled,false);assert.notEqual(first.request_id,second.request_id);assert(second.items.every(r=>!first.items.some(old=>old.impression_id===r.impression_id)));assert.equal(rows.size,200);
 const retry=await fetch(logger+'/internal/served',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({records:[...rows.values()].slice(0,100)})});
 assert((await retry.json()).results.every(r=>r.status==='duplicate'));assert.equal(rows.size,200);
});
