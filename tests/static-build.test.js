import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';

test('배포 결과에는 브라우저 의존성만 있고 모든 모듈과 화면 자원이 존재한다',async()=>{
  const root=new URL('../dist/',import.meta.url);
  assert.deepEqual((await readdir(root)).sort(),['index.html','src']);
  const files=(await readdir(new URL('src/',root))).sort();
  assert.deepEqual(files,['app.js','backend-api.js','image-url.js','likes.js','style.css','types.js']);
  const html=await readFile(new URL('index.html',root),'utf8');
  for(const [,asset] of html.matchAll(/(?:src|href)="\.\/([^"]+)"/g))await readFile(new URL(asset,root));
  for(const file of files.filter(name=>name.endsWith('.js'))) {
    const source=await readFile(new URL('src/'+file,root),'utf8');
    assert.doesNotMatch(source,/node:|visitors\/|\/api\/v1\/visitors|\.sqlite/);
    for(const [,specifier] of source.matchAll(/from\s*['"]([^'"]+)['"]/g)) {
      assert.ok(specifier.startsWith('./'),specifier);
      await readFile(new URL('src/'+specifier.slice(2),root));
    }
  }
});
