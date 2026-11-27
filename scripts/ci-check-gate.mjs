import {fileURLToPath} from 'node:url';

export function checksPassed(env) {
 return env.SCOPE_RESULT === 'success' && env.INTEGRATION_RESULT === 'success' && (
  (env.BROWSER_REQUIRED === 'true' && env.BROWSER_RESULT === 'success') ||
  (env.BROWSER_REQUIRED === 'false' && env.BROWSER_RESULT === 'skipped')
 );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
 if (!checksPassed(process.env)) {
  console.error('Required CI checks did not succeed or scope output was invalid.');
  process.exitCode = 1;
 }
}
