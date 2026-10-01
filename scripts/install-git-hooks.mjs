import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = realpathSync(fileURLToPath(new URL('..', import.meta.url)));
try {
  const top = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  if (realpathSync(top) !== root) throw new Error('Initialize a Git repository in riftjack first; parent repositories are not modified.');
  let current = '';
  try { current = execFileSync('git', ['config', '--get', 'core.hooksPath'], { cwd: root, encoding: 'utf8' }).trim(); }
  catch (error) { if (error.status !== 1) throw error; }
  if (current && current !== '.githooks') throw new Error('An existing hooksPath is configured. Integrate the commit policy into those hooks manually.');
  const hooks = execFileSync('git', ['rev-parse', '--git-path', 'hooks'], { cwd: root, encoding: 'utf8' }).trim();
  if (!current && ['commit-msg', 'pre-commit', 'pre-push', 'prepare-commit-msg'].some(name => existsSync(resolve(root, hooks, name)))) throw new Error('Existing hooks found. Integrate the policy manually; no hooks were replaced.');
  chmodSync(resolve(root, '.githooks/commit-msg'), 0o755);
  execFileSync('git', ['config', '--local', 'core.hooksPath', '.githooks'], { cwd: root });
  console.log('Installed repository-local commit-message policy. Other repositories are unchanged.');
} catch (error) {
  console.error(error.message?.startsWith('Command failed') ? 'No Git repository in riftjack yet. Run git init there, then npm run hooks:install.' : error.message);
  process.exitCode = 1;
}
