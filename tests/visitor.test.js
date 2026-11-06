import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {createNewsServer} from '../dist/server/http.js';
import {openVisitors, lifetimeSeconds} from '../dist/server/visitors.js';

test('익명 방문자의 HTTP 쿠키·서버 저장·재방문·삭제·만료', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'news-visitors-'));
  const database = path.join(dir, 'visitors.sqlite');
  const root = fileURLToPath(new URL('..', import.meta.url));
  const origin = 'http://127.0.0.1:4173';
  let time = Date.now();
  let app;
  let base;
  async function start() {
    app = createNewsServer({root, origin, database, now:() => time});
    await new Promise((resolve, reject) => {app.server.once('error', reject); app.server.listen(0, '127.0.0.1', resolve);});
    base = `http://127.0.0.1:${app.server.address().port}`;
  }
  async function stop() {await new Promise(resolve => app.server.close(resolve)); app.close(); app = null;}
  async function request(action, {cookie, body, originHeader = origin} = {}) {
    return fetch(`${base}/api/v1/visitors/${action}`, {method:body === undefined ? 'GET' : 'POST',
      headers:{...(cookie ? {Cookie:cookie} : {}), ...(body === undefined ? {} : {'Content-Type':'application/json', Origin:originHeader})},
      body:body === undefined ? undefined : JSON.stringify(body)});
  }
  try {
    await start();
    assert.equal((await request('me')).status, 401);
    const first = await request('bootstrap', {body:{}});
    assert.equal(first.status, 201);
    const header = first.headers.get('set-cookie');
    assert.match(header, /HttpOnly; SameSite=Lax/);
    assert.match(header, /Max-Age=2592000/);
    const cookieA = header.split(';')[0];
    const token = cookieA.split('=')[1];
    const reader = (await first.json()).data;
    assert.equal(reader.reader_type, 'anonymous');
    assert.ok(!JSON.stringify(reader).includes(token));
    const db = new DatabaseSync(database);
    const saved = db.prepare('SELECT * FROM visitors WHERE reader_id = ?').get(reader.reader_id);
    assert.ok(!Object.hasOwn(saved, 'interests'));
    assert.ok(!Object.hasOwn(reader, 'initial_interests'));
    assert.notEqual(saved.token_hash, token);
    assert.equal(saved.token_hash.length, 64);
    db.close();
    time += 10000;
    const returning = await request('bootstrap', {cookie:cookieA, body:{}});
    assert.equal(returning.status, 200);
    assert.equal((await returning.json()).data.reader_id, reader.reader_id);
    assert.match(returning.headers.get('set-cookie'), /Max-Age=2591990/);
    await stop();
    await start();
    const restored = (await (await request('me', {cookie:cookieA})).json()).data;
    assert.equal(restored.reader_id, reader.reader_id);
    assert.ok(!Object.hasOwn(restored, 'initial_interests'));
    const second = await request('bootstrap', {body:{}});
    const cookieB = second.headers.get('set-cookie').split(';')[0];
    const readerB = (await second.json()).data;
    assert.notEqual(readerB.reader_id, reader.reader_id);
    assert.equal((await request('bootstrap', {cookie:cookieB, body:{reader_id:reader.reader_id}})).status, 400);
    assert.equal((await request('interests', {cookie:cookieA, body:{initial_interests:['문화']}})).status, 404);
    assert.equal((await request('reset', {cookie:cookieA, body:{}, originHeader:'https://attacker.example'})).status, 403);
    for (const resource of ['/data/visitors.sqlite', '/server/http.ts', '/server/http.js', '/server.js', '/tests/visitor.test.js', '/package.json']) assert.equal((await fetch(base + resource)).status, 404);
    assert.equal((await fetch(base + '/')).status, 200);
    const reset = await request('reset', {cookie:cookieA, body:{}});
    assert.equal(reset.status, 200);
    assert.match(reset.headers.get('set-cookie'), /Max-Age=0/);
    assert.equal((await request('me', {cookie:cookieA})).status, 401);
    const afterReset = await request('bootstrap', {cookie:cookieA, body:{}});
    assert.notEqual((await afterReset.json()).data.reader_id, reader.reader_id);
    time += lifetimeSeconds * 1000 + 1;
    assert.equal((await request('me', {cookie:cookieB})).status, 401);
    const expired = await request('bootstrap', {cookie:cookieB, body:{}});
    assert.equal(expired.status, 201);
    assert.notEqual((await expired.json()).data.reader_id, readerB.reader_id);
  } finally {
    if (app) await stop();
    await rm(dir, {recursive:true, force:true});
  }
});

test('HTTPS 설정은 Secure와 __Host 쿠키를 발급한다', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'news-secure-'));
  const app = createNewsServer({root:dir, origin:'https://news.example.com', database:path.join(dir, 'test.sqlite')});
  try {
    await new Promise((resolve, reject) => {app.server.once('error', reject); app.server.listen(0, '127.0.0.1', resolve);});
    const result = await fetch(`http://127.0.0.1:${app.server.address().port}/api/v1/visitors/bootstrap`, {method:'POST', headers:{Origin:'https://news.example.com', 'Content-Type':'application/json'}, body:'{}'});
    assert.match(result.headers.get('set-cookie'), /^__Host-news_visitor=.*; Secure$/);
    assert.ok(!result.headers.get('set-cookie').includes('Domain='));
  } finally {
    await new Promise(resolve => app.server.close(resolve)); app.close();
    await rm(dir, {recursive:true, force:true});
  }
});


test('기존 DB의 관심사만 제거하고 방문자 연결은 유지한다', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'news-migration-'));
  const database = path.join(dir, 'visitors.sqlite');
  let store = openVisitors(database);
  const original = store.bootstrap(null);
  store.close();
  const old = new DatabaseSync(database);
  old.exec("ALTER TABLE visitors ADD COLUMN interests TEXT NOT NULL DEFAULT '[]'");
  old.close();
  store = openVisitors(database);
  try {
    assert.equal(store.find('A'.repeat(43)), null);
    assert.equal(store.bootstrap(original.token).data.reader_id, original.data.reader_id);
    const db = new DatabaseSync(database);
    assert.ok(!db.prepare('PRAGMA table_info(visitors)').all().some(column => column.name === 'interests'));
    db.close();
  } finally {store.close(); await rm(dir, {recursive:true, force:true});}
});
