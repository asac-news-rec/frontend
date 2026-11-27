import {execFileSync} from 'node:child_process';
import {appendFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

// Only proven browser-independent paths may skip E2E. Unknown paths run it.
export function needsBrowser(paths) {
 return paths.some(path => !(
  path.startsWith('docs/') || /^(README|AGENTS|CLAUDE|CONTRIBUTING)\.md$/.test(path) ||
  path.startsWith('services/logging-server/python_tests/') ||
  /^services\/logging-server\/logging_service\/(postgres|postgres_pool)\.(py|sql)$/.test(path)
 ));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
 let browser = true;
 if (process.env.CI_EVENT === 'pull_request') {
  const {CI_BASE: base, CI_HEAD: head} = process.env;
  if (!/^[a-f0-9]{40}$/.test(base ?? '') || !/^[a-f0-9]{40}$/.test(head ?? '')) throw new Error('Invalid comparison SHA');
  const paths = execFileSync('git', ['diff', '--name-only', '--no-renames', '-z', `${base}...${head}`], {encoding:'utf8'}).split('\0').filter(Boolean);
  browser = needsBrowser(paths);
 }
 appendFileSync(process.env.GITHUB_OUTPUT, `browser=${browser}\n`);
 console.log(`Browser regression required: ${browser}`);
}
