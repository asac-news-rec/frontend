import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createLoggingSender} from '../.local/server/logging-client.js';
const audience='https://logging.example.run.app',token='fixture-application-token-only';
const jwt=(aud,exp)=>'header.'+Buffer.from(JSON.stringify({aud,exp})).toString('base64url')+'.signature';
const metadata=value=>new Response(value,{headers:{'Metadata-Flavor':'Google'}});

test('IAM ID 토큰을 합쳐 캐시하고 앱 Bearer와 별도 헤더로 보낸다',async()=>{
 let time=1000000,identities=0;const calls=[];
 const send=createLoggingSender({url:audience,token,audience},{now:()=>time,fetchImpl:async(url,options)=>{
  if(url.hostname==='metadata.google.internal'){
   identities++;assert.equal(url.searchParams.get('audience'),audience);assert.equal(options.headers['Metadata-Flavor'],'Google');assert.equal(options.redirect,'error');
   return metadata(jwt(audience,time/1000+3600));
  }
  calls.push(options);return Response.json({results:[]});
 }});
 await Promise.all([send('/events',{events:[]},'fixture-reader'),send('/internal/served',{records:[]})]);
 assert.equal(identities,1);assert.equal(calls[0].headers.Authorization,`Bearer ${token}`);
 assert.match(calls[0].headers['X-Serverless-Authorization'],/^Bearer header\./);assert.equal(calls[0].headers['x-news-source'],'browser');assert.equal(calls[0].redirect,'error');
 time+=3541000;await send('/events',{});assert.equal(identities,2);
});

test('메타데이터 실패·잘못된 토큰·IAM 거절 후 다음 요청에서 복구한다',async()=>{
 let mode='sync-fail',identities=0;
 const send=createLoggingSender({url:audience,token,audience},{now:()=>1000000,fetchImpl:(url)=>{
  if(url.hostname==='metadata.google.internal'){
   identities++;
   if(mode==='sync-fail')throw new Error('fixture detail must not escape');
   return Promise.resolve(metadata(mode==='wrong-audience'?jwt('other',4600):mode==='expired'?jwt(audience,900):jwt(audience,4600)));
  }
  return Promise.resolve(mode==='forbidden'?new Response('{}',{status:403}):Response.json({results:[]}));
 }});
 for(mode of ['sync-fail','wrong-audience','expired'])await assert.rejects(send('/events',{}),/^Error: LOGGING_IDENTITY_UNAVAILABLE$/);
 mode='forbidden';await assert.rejects(send('/events',{}),/LOGGING_UNAVAILABLE/);assert.equal(identities,4);
 mode='healthy';await send('/events',{});assert.equal(identities,5);
 await assert.rejects(send('https://other.invalid/events',{}),/INVALID_LOGGING_ROUTE/);
});

test('로컬 설정은 메타데이터를 호출하지 않고 만료된 요청을 전송하지 않는다',async()=>{
 let calls=0;
 const send=createLoggingSender({url:'http://127.0.0.1:4195',token},{fetchImpl:async(url,options)=>{calls++;assert.equal(url.hostname,'127.0.0.1');assert.equal(options.headers['X-Serverless-Authorization'],undefined);return Response.json({});}});
 await send('/events',{});assert.equal(calls,1);
 await assert.rejects(send('/events',{},undefined,AbortSignal.abort()));assert.equal(calls,1);
 assert.throws(()=>createLoggingSender({url:'http://logging.invalid',token,audience}),/INVALID_LOGGING_AUDIENCE/);
});
