import {test} from 'node:test';
import assert from 'node:assert/strict';
import {backendImageUrl} from '../.local/src/image-url.js';

test('백엔드의 기존 로컬 이미지 주소만 Nginx images 경로로 연결한다',()=>{
  assert.equal(backendImageUrl('http://localhost:8001/topic/a.png?v=1'),'/images/topic/a.png?v=1');
  assert.equal(backendImageUrl('http://127.0.0.1:8001/a.png'),'/images/a.png');
  assert.equal(backendImageUrl('/images/a.png'),'/images/a.png');
  assert.equal(backendImageUrl('https://cdn.example.com/a.png'),'https://cdn.example.com/a.png');
  assert.equal(backendImageUrl('http://localhost:9000/a.png'),'http://localhost:9000/a.png');
  for(const value of [null,undefined,'','javascript:alert(1)','data:image/png;base64,abc'])assert.equal(backendImageUrl(value),null);
});
