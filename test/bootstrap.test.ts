import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const exec = promisify(execFile);

for (const engine of ['codex', 'claude', 'grok']) test(`${engine} bootstrap creates its manager and resumes without duplicate accounts`, async t => {
  const root = mkdtempSync(join(tmpdir(), 'riftjack-bootstrap-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const mock = join(root, 'matrix.mjs');
  // No server or provider account is contacted; unexpected network calls fail.
  writeFileSync(mock, `
    globalThis.fetch = async (url, options) => {
      if (url !== 'https://matrix.test/_synapse/admin/v1/register') throw new Error('Unexpected request');
      if (!options.body) return new Response(JSON.stringify({ nonce: 'test-nonce' }));
      const body = JSON.parse(options.body);
      if (body.admin !== false) throw new Error('Unexpected administrator account');
      return new Response(JSON.stringify({
        user_id: '@' + body.username + ':test', access_token: 'test-token', device_id: 'test-device',
      }));
    };
  `);
  const claude = join(root, 'claude');
  writeFileSync(claude, `#!/usr/bin/env node
    if (process.argv.includes('--help')) {
      console.log('--input-format --output-format --permission-mode --permission-prompt-tool --append-system-prompt --tools --settings --resume');
    } else if (process.argv[2] === 'auth') {
      console.log(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty' }));
    } else { process.exitCode = 1; }
  `, { mode: 0o700 });
  const run = (flag = `--bootstrap-${engine}`) => exec(process.execPath, [
    '--import', import.meta.resolve('tsx'), '--import', pathToFileURL(mock).href,
    fileURLToPath(new URL('../src/main.ts', import.meta.url)),
    flag,
  ], {
    cwd: root, timeout: 10_000,
    env: {
      PATH: process.env.PATH, HOME: root,
      MATRIX_HOMESERVER: 'https://matrix.test', MATRIX_OWNER_ID: '@owner:test',
      SYNAPSE_REGISTRATION_SHARED_SECRET: 'test-secret', RIFTJACK_WORKSPACE: root,
      CODEX_PATH: join(root, 'missing-codex'), WORKER_PORT: '8788',
      CLAUDE_PATH: engine === 'claude' ? claude : join(root, 'missing-claude'),
    },
  });
  await run();
  const accounts = readFileSync(join(root, 'data/accounts.json'), 'utf8');
  assert.deepEqual(JSON.parse(accounts).map((a: { kind: string }) => a.kind), ['manager', engine]);
  await run();
  assert.equal(readFileSync(join(root, 'data/accounts.json'), 'utf8'), accounts);
  if (engine === 'codex') await assert.rejects(run('--bootstrap'), { code: 78 });
});
