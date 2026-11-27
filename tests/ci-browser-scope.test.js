import {test} from 'node:test';
import assert from 'node:assert/strict';
import {needsBrowser} from '../scripts/ci-browser-scope.mjs';
import {spawnSync} from 'node:child_process';
import {mkdtempSync, existsSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

test('Only documentation and Python tests skip browser regression', () => {
 assert.equal(needsBrowser(['services/logging-server/python_tests/test_postgres_pool.py','docs/logging-server/postgres-concurrency.md']), false);
});
test('HTTP contracts, shared store and dependencies keep browser coverage', () => {
 for (const path of ['services/logging-server/logging_service/postgres.py','services/logging-server/logging_service/postgres_pool.py','services/logging-server/logging_service/postgres.sql','services/logging-server/logging_service/migration_001.sql','services/logging-server/logging_service/app.py','services/logging-server/logging_service/store.py','services/logging-server/requirements.txt','src/app.ts','server/proxy.ts','tests/helpers/fastapi-logging.mjs','scripts/build.mjs','package-lock.json','.github/workflows/logging-fastapi.yml','unknown-new-file']) {
  assert.equal(needsBrowser(['docs/example.md', path]), true, path);
 }
});
test('deleted browser files and mixed changes still require browser coverage', () => {
 assert.equal(needsBrowser(['services/logging-server/logging_service/postgres.py','tests/browser/deleted.test.mjs']), true);
 assert.equal(needsBrowser(['README.md']), false);
});

test('invalid or missing Git history fails without publishing a skip output', t => {
 const dir = mkdtempSync(join(tmpdir(),'ci-scope-'));
 t.after(()=>rmSync(dir,{recursive:true,force:true}));
 for (const sha of ['invalid', '0'.repeat(40)]) {
  const output = join(dir,sha);
  const result = spawnSync(process.execPath,['scripts/ci-browser-scope.mjs'],{
   env:{...process.env,CI_EVENT:'pull_request',CI_BASE:sha,CI_HEAD:sha,GITHUB_OUTPUT:output}
  });
  assert.notEqual(result.status,0);
  assert.equal(existsSync(output),false);
 }
 for (const event of ['push','workflow_dispatch']) {
  const output = join(dir,event);
  const result = spawnSync(process.execPath,['scripts/ci-browser-scope.mjs'],{
   env:{...process.env,CI_EVENT:event,GITHUB_OUTPUT:output}
  });
  assert.equal(result.status,0);
  assert.equal(readFileSync(output,'utf8'),'browser=true\n');
 }
});
