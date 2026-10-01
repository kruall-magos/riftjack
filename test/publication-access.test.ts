import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Bridge, type MatrixEvent } from '../src/bridge.js';
import { State } from '../src/state.js';
import { loadConfig } from '../src/config.js';
import { claudeArguments } from '../src/claude-backend.js';
import { routeBackends } from '../src/backends.js';
import type { Backend } from '../src/bridge.js';

for (const kind of ['codex', 'claude'] as const) test(`${kind} publication capability is scoped to the owner and current task`, async t => {
  const root = mkdtempSync(join(tmpdir(), 'publication-access-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let privateRoom = true, calls = 0, saved: Parameters<Backend>[7];
  const bridge = new Bridge({ botId: '@bot:test', kind, owner: '@owner:test', since: 0, timeoutMs: 1000,
    isAuthorized: () => true, isPrivateRoom: async () => privateRoom, state: new State(join(root, 'state.json')),
    reply: async () => {}, report: () => {},
    run: async (_m, _p, _k, _s, sender, _a, _i, publish) => {
      if (sender === '@guest:test') assert.equal(publish, undefined);
      else { saved = publish; assert.ok(publish); privateRoom = false; await assert.rejects(publish({}, new AbortController().signal), /privacy|membership|access/); }
      return 'Done';
    },
    publish: async () => { calls++; return 'Unexpected'; },
  });
  const event = (sender: string): MatrixEvent => ({ type: 'm.room.message', event_id: '$' + sender, sender, origin_server_ts: Date.now(), content: { msgtype: 'm.text', body: 'Review publication' } });
  await bridge.handle('!room:test', event('@guest:test'));
  await bridge.handle('!room:test', event('@owner:test'));
  privateRoom = true;
  await assert.rejects(saved!({}, new AbortController().signal));
  assert.equal(calls, 0);
});

test('Claude publication config allows only its reviewed tool and keeps read-only bots unchanged', t => {
  const root = mkdtempSync(join(tmpdir(), 'publication-config-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const config = loadConfig({ MATRIX_HOMESERVER: 'https://matrix.test', MATRIX_OWNER_ID: '@owner:test', RIFTJACK_WORKSPACE: root });
  const connection = { url: 'http://127.0.0.1:12345/mcp', headers: { Authorization: 'Bearer task-token' } };
  const args = claudeArguments(config, 'session', true, 'Instructions', connection);
  assert.equal(args[args.indexOf('--allowedTools') + 1], 'mcp__riftjack_publish__prepare_publish');
  const server = JSON.parse(args[args.indexOf('--mcp-config') + 1]).mcpServers.riftjack_publish;
  assert.deepEqual(server, { type: 'http', ...connection, timeout: config.timeoutMs });
  assert.ok(args.includes('--permission-prompt-tool'));
  assert.ok(!args.includes('--strict-mcp-config'));
  assert.ok(!claudeArguments({ ...config, sandbox: 'read-only' }, undefined, false, '', connection).includes('--mcp-config'));
});

test('backend routing forwards the task publication capability to both engines', async () => {
  const publish = async () => 'Published';
  const engine = Object.assign<Backend, { steer: () => Promise<boolean> }>(async (_m, _p, _k, _s, _u, _a, _i, capability) => {
    assert.equal(capability, publish); return 'Done';
  }, { steer: async () => false });
  const route = routeBackends({ codex: engine, claude: engine });
  for (const kind of ['codex', 'claude'] as const) await route(kind, '', 'key', new AbortController().signal, '@owner:test', [], undefined, publish);
});
