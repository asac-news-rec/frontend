import {test} from 'node:test';
import assert from 'node:assert/strict';
import {needsBrowser} from '../scripts/ci-browser-scope.mjs';

test('DB internals and their Python tests skip browser regression', () => {
 assert.equal(needsBrowser(['services/logging-server/logging_service/postgres_pool.py','services/logging-server/python_tests/test_postgres_pool.py','docs/logging-server/postgres-concurrency.md']), false);
});
test('HTTP contracts, shared store and dependencies keep browser coverage', () => {
 for (const path of ['services/logging-server/logging_service/app.py','services/logging-server/logging_service/store.py','services/logging-server/requirements.txt','src/app.ts','server/proxy.ts','tests/helpers/fastapi-logging.mjs','scripts/build.mjs','package-lock.json','.github/workflows/logging-fastapi.yml','unknown-new-file']) {
  assert.equal(needsBrowser(['docs/example.md', path]), true, path);
 }
});
test('deleted browser files and mixed changes still require browser coverage', () => {
 assert.equal(needsBrowser(['services/logging-server/logging_service/postgres.py','tests/browser/deleted.test.mjs']), true);
 assert.equal(needsBrowser(['README.md']), false);
});
