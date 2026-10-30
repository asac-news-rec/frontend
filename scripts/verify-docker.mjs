import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
const base = `http://127.0.0.1:${process.env.NEWS_PORT || 4181}`;
const headers = {'Content-Type':'application/json', Origin:base};
const first = await fetch(`${base}/api/v1/visitors/bootstrap`, {method:'POST', headers, body:'{}'});
assert.equal(first.status, 201);
const cookie = first.headers.get('set-cookie').split(';')[0];
const reader = (await first.json()).data.reader_id;
try {
  assert.equal((await fetch(base)).status, 200);
  const restart = spawnSync('docker', ['compose', 'restart', 'web'], {stdio:'inherit'});
  assert.equal(restart.status, 0);
  const ready = spawnSync('docker', ['compose', 'up', '-d', '--wait', '--wait-timeout', '60'], {stdio:'inherit'});
  assert.equal(ready.status, 0);
  const restored = await fetch(`${base}/api/v1/visitors/me`, {headers:{Cookie:cookie}});
  assert.equal(restored.status, 200);
  assert.equal((await restored.json()).data.reader_id, reader);
  assert.equal((await fetch(`${base}/data/visitors.sqlite`)).status, 404);
  console.log('Docker HTTP, cookie identity and restart persistence verified');
} finally {
  await fetch(`${base}/api/v1/visitors/reset`, {method:'POST', headers:{...headers, Cookie:cookie}, body:'{}'});
}
