import assert from 'node:assert/strict';
const base=`http://127.0.0.1:${process.env.NEWS_PORT||8080}`;
assert.equal((await fetch(base)).status,200);
assert.equal((await fetch(base+'/src/app.js')).status,200);
for(const file of ['/server.js','/dev-server.js','/server/http.js','/src/app.ts','/data/visitors.sqlite']) {
  assert.equal((await fetch(base+file)).status,404,file);
}
assert.equal((await fetch(base+'/api/health')).status,200,'FastAPI health through /api/ prefix stripping');
console.log('Local Docker static files, server-file isolation and FastAPI forwarding verified');
