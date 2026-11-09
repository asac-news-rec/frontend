import assert from 'node:assert/strict';
const base=`http://127.0.0.1:${process.env.NEWS_PORT||4181}`;
assert.equal((await fetch(base)).status,200);
assert.equal((await fetch(base+'/src/app.js')).status,200);
for(const file of ['/server.js','/dev-server.js','/server/http.js','/src/app.ts','/data/visitors.sqlite','/api/v1/visitors/me']) {
  assert.equal((await fetch(base+file)).status,404,file);
}
console.log('Local Docker static files and server-file isolation verified');
