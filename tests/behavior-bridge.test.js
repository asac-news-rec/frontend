import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import {Readable} from 'node:stream';
import {createDevServer} from '../.local/server/dev-http.js';

test('same-origin bridge binds signed reader and replaces forged source headers',async t=>{
 const token=randomUUID(),reader='019a0000-0000-7000-8000-000000000001',seen=[];
 const listen=async server=>{server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>new Promise(resolve=>server.close(resolve)));return `http://127.0.0.1:${server.address().port}`;};
 const logging=await listen(createServer(async(req,res)=>{const chunks=[];for await(const b of req)chunks.push(b);const body=JSON.parse(Buffer.concat(chunks).toString());seen.push({headers:req.headers,body});res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({results:(body.records??body.events).map(r=>({...(r.event_id?{event_id:r.event_id}:{impression_id:r.impression_id}),status:'accepted'}))}));}));
 const asOf='2026-01-01T00:00:00.123456Z';
 const backend=await listen(createServer((req,res)=>{
  if(req.url==='/api/user/anonymous')res.setHeader('Set-Cookie','news_reader=backend-proof; Path=/; HttpOnly');
  res.writeHead(200,{'Content-Type':'application/json'});
  res.end(JSON.stringify(req.url==='/api/user/anonymous'?{reader_id:reader}:{
   request_id:'req',served_at:new Date().toISOString(),model_version:'ctr-v3',features_as_of:asOf,
   items:[{article_id:'a',impression_id:'imp',position:1,score:0.42},
    {article_id:'b',impression_id:'fallback',position:2,score:null,model_version:null,features_as_of:null}]
  }));
 }));
 const reservation=createServer();reservation.listen(0,'127.0.0.1');await once(reservation,'listening');const port=reservation.address().port;await new Promise(r=>reservation.close(r));
 const origin=`http://127.0.0.1:${port}`;
 const server=createDevServer({root:process.cwd(),origin,backendBaseUrl:backend,logging:{url:logging,token}});server.listen(port,'127.0.0.1');await once(server,'listening');t.after(()=>new Promise(resolve=>server.close(resolve)));
 const post=(path,body,cookie='',extra={})=>fetch(origin+path,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json',Cookie:cookie,...extra},...(body?{body:JSON.stringify(body)}:{})});
 const issued=await post('/api/user/anonymous');const proof=issued.headers.getSetCookie().map(value=>value.split(';')[0]).join('; ');
 const missing=await post('/api/behavior/session',{reader_id:reader});assert.equal(missing.status,403);
 const mismatch=await post('/api/behavior/session',{reader_id:'019a0000-0000-7000-8000-000000000002'},proof);assert.equal(mismatch.status,403);
 const session=await post('/api/behavior/session',{reader_id:reader},proof);assert.equal(session.status,200);const cookie=proof+'; '+session.headers.get('set-cookie').split(';')[0];assert.match(session.headers.get('set-cookie'),/HttpOnly/);assert.equal((await session.json()).reader_id,reader);
 assert.equal((await post('/api/news/feed',{},cookie)).status,200);
 assert.equal(seen[0].body.records[0].reader_id,reader);
 const metadata=seen[0].body.records.map(({score,model_version,features_as_of})=>({score,model_version,features_as_of}));
 assert.deepEqual(metadata,[{score:0.42,model_version:'ctr-v3',features_as_of:asOf},
  {score:null,model_version:null,features_as_of:null}]);
 const action={event_id:randomUUID(),event_type:'article_open',event_time:new Date().toISOString(),impression_id:'imp',page_type:'list'};
 assert.equal((await post('/api/behavior/events',{events:[action]},cookie,{'x-news-reader':'attacker','x-news-source':'simulator'})).status,200);
 assert.equal(seen[1].headers['x-news-reader'],reader);assert.equal(seen[1].headers['x-news-source'],'browser');assert.equal(seen[1].headers.authorization,`Bearer ${token}`);
 assert.equal((await post('/api/behavior/events',{events:[action]},cookie+'tampered')).status,403);
 assert.equal((await post('/api/behavior/events',{events:[action]},cookie,{Origin:'https://other.invalid'})).status,403);
 const unbound=await post('/api/news/feed',{},cookie.replace('news_reader=backend-proof','news_reader=another-proof'));
 assert.equal(unbound.status,200);assert.equal((await unbound.json()).collection_enabled,false);
 assert.equal(seen.length,2);
 // A fresh bridge instance accepts the same signed cookie, without in-memory state.
 const {createBehaviorBridge}=await import('../.local/server/behavior-bridge.js');
 const bridge=createBehaviorBridge(origin,backend,{url:logging,token});
 const headers={};let responseBody;
 const req=Readable.from([Buffer.from(JSON.stringify({reader_id:reader}))]);req.method='POST';req.headers={origin,cookie,'content-type':'application/json'};
 await bridge.handle(req,{writeHead(){},setHeader(k,v){headers[k]=v;},end(value){responseBody=JSON.parse(value);}},'/api/behavior/session');
 assert.equal(responseBody.reader_id,reader);assert.equal(headers['Set-Cookie'],undefined);
});
