import {test} from 'node:test';
import assert from 'node:assert/strict';
import {checksPassed} from '../scripts/ci-check-gate.mjs';

test('gate accepts only successful required checks or explicit browser skip', () => {
 for (const scope of ['success','failure','cancelled','skipped',''])
 for (const integration of ['success','failure','cancelled','skipped',''])
 for (const required of ['true','false','','unexpected'])
 for (const browser of ['success','failure','cancelled','skipped','']) {
  const expected = scope === 'success' && integration === 'success' &&
   ((required === 'true' && browser === 'success') || (required === 'false' && browser === 'skipped'));
  assert.equal(checksPassed({SCOPE_RESULT:scope,INTEGRATION_RESULT:integration,BROWSER_REQUIRED:required,BROWSER_RESULT:browser}), expected,
   JSON.stringify({scope,integration,required,browser}));
 }
});
