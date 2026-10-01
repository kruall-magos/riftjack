import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Access, parseAccessRequest } from '../src/access.js';
import { Bridge, sessionKey, type MatrixEvent } from '../src/bridge.js';
import { State } from '../src/state.js';

function setup(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(join(tmpdir(), 'matrix-access-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'allowed-users.json');
  return { dir, file, access: new Access(file, '@owner:test') };
}

test('manager owner can persistently add and revoke device accounts', t => {
  const { file, access } = setup(t);
  access.change('manager', '@owner:test', 'allow', '@phone:other');
  assert.equal(new Access(file, '@owner:test').has('@phone:other'), true);
  access.change('manager', '@owner:test', 'remove', '@phone:other');
  assert.equal(new Access(file, '@owner:test').has('@phone:other'), false);
  assert.throws(() => access.change('manager', '@owner:test', 'remove', '@owner:test'), /cannot be removed/);
});

test('Codex and non-owner accounts cannot modify permissions', t => {
  const { access } = setup(t);
  for (const kind of ['codex', 'claude'] as const) {
    assert.throws(() => access.change(kind, '@owner:test', 'allow', '@phone:other'), /Only the initial owner/);
  }
  access.change('manager', '@owner:test', 'allow', '@phone:other');
  assert.throws(() => access.change('manager', '@phone:other', 'allow', '@stranger:test'), /Only the initial owner/);
  assert.equal(access.has('@stranger:test'), false);
});

test('account management phrases use full IDs', () => {
  assert.deepEqual(parseAccessRequest('allow @phone:other'), { action: 'allow', userId: '@phone:other' });
  assert.deepEqual(parseAccessRequest('add my account @tablet:test'), { action: 'allow', userId: '@tablet:test' });
  assert.deepEqual(parseAccessRequest('remove account @tablet:test'), { action: 'remove', userId: '@tablet:test' });
  assert.deepEqual(parseAccessRequest('list accounts'), { action: 'users' });
  assert.equal(parseAccessRequest('allow everyone'), null);
});

test('authorization changes apply immediately, without restarting bots', async t => {
  const { dir, access } = setup(t);
  let calls = 0;
  const bridge = new Bridge({
    botId: '@bot:test', kind: 'codex', since: 1000, timeoutMs: 1000,
    isAuthorized: user => access.has(user), isPrivateRoom: async () => true,
    state: new State(join(dir, 'sessions.json')),
    run: async () => { calls++; return 'reply'; }, reply: async () => {}, report: () => {},
  });
  const event: MatrixEvent = { event_id: '$1', sender: '@phone:other', type: 'm.room.message', origin_server_ts: 2000, content: { msgtype: 'm.text', body: 'hello' } };
  await bridge.handle('!dm:test', event);
  assert.equal(calls, 0);
  access.change('manager', '@owner:test', 'allow', '@phone:other');
  await bridge.handle('!dm:test', { ...event, event_id: '$2' });
  assert.equal(calls, 1);
  access.change('manager', '@owner:test', 'remove', '@phone:other');
  await bridge.handle('!dm:test', { ...event, event_id: '$3' });
  assert.equal(calls, 1);
  assert.notEqual(sessionKey('!dm:test', event), sessionKey('!dm:test', { ...event, sender: '@owner:test' }));
});

test('per-bot lists survive restart without granting global or other-bot access', t => {
  const { file, access } = setup(t);
  access.changeBot('manager', '@owner:test', 'allow', '@a:test', ['@alice:test', '@bob:other']);
  const restored = new Access(file, '@owner:test');
  assert.equal(restored.has('@alice:test', '@a:test'), true);
  assert.equal(restored.has('@alice:test', '@b:test'), false);
  assert.equal(restored.has('@alice:test'), false);
  assert.deepEqual(restored.listBot('@a:test'), ['@alice:test', '@bob:other']);
  assert.equal(restored.has('@owner:test', '@b:test'), true);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  restored.changeBot('manager', '@owner:test', 'remove', '@a:test', ['@alice:test']);
  assert.equal(new Access(file, '@owner:test').has('@alice:test', '@a:test'), false);
});

test('old global grants migrate intact and global removal clears every scoped grant', t => {
  const { file } = setup(t);
  writeFileSync(file, JSON.stringify(['@legacy:test']));
  const access = new Access(file, '@owner:test');
  access.changeBot('manager', '@owner:test', 'allow', '@a:test', ['@legacy:test', '@scoped:test']);
  access.changeBot('manager', '@owner:test', 'allow', '@b:test', ['@scoped:test']);
  assert.equal(new Access(file, '@owner:test').has('@legacy:test', '@anything:test'), true);
  assert.throws(() => access.changeBot('manager', '@owner:test', 'remove', '@a:test', ['@scoped:test', '@legacy:test']), /shared access/);
  assert.equal(access.has('@scoped:test', '@a:test'), true);
  access.change('manager', '@owner:test', 'remove', '@scoped:test');
  const restored = new Access(file, '@owner:test');
  assert.equal(restored.has('@scoped:test', '@a:test'), false);
  assert.equal(restored.has('@scoped:test', '@b:test'), false);
  access.change('manager', '@owner:test', 'remove', '@legacy:test');
  assert.equal(access.has('@legacy:test', '@a:test'), false);
});

test('scoped mutations validate the entire list and retain old grants on persistence failure', t => {
  const { access, file } = setup(t);
  for (const kind of ['codex', 'claude'] as const) assert.throws(() => access.changeBot(kind, '@owner:test', 'allow', '@a:test', ['@x:test']), /Only the initial/);
  assert.throws(() => access.changeBot('manager', '@other:test', 'allow', '@a:test', ['@x:test']), /Only the initial/);
  assert.throws(() => access.changeBot('manager', '@owner:test', 'allow', '@a:test', ['@x:test', 'invalid']), /Matrix ID/);
  assert.equal(access.has('@x:test', '@a:test'), false);
  assert.throws(() => access.changeBot('manager', '@owner:test', 'remove', '@a:test', ['@owner:test']), /owner/);
  mkdirSync(file + '.tmp');
  assert.throws(() => access.changeBot('manager', '@owner:test', 'allow', '@a:test', ['@x:test']));
  assert.equal(access.has('@x:test', '@a:test'), false);
});

test('corrupt scoped permission files fail closed', t => {
  const { file } = setup(t);
  for (const data of [null, {}, { version: 2, users: [], bots: {} }, { version: 1, users: [], bots: { '@bot:test': ['invalid'] } }, { version: 1, users: [], bots: [] }]) {
    writeFileSync(file, JSON.stringify(data));
    assert.throws(() => new Access(file, '@owner:test'), /Invalid/);
  }
});

test('a scoped user can run only the granted bot and loses active confirmations on revocation', async t => {
  const { dir, access } = setup(t);
  access.changeBot('manager', '@owner:test', 'allow', '@a:test', ['@scoped:test']);
  let ready!: () => void, accepted = false, otherCalls = 0;
  const waiting = new Promise<void>(resolve => { ready = resolve; });
  const common = { since: 1000, timeoutMs: 1000, isPrivateRoom: async () => true,
    state: new State(join(dir, 'sessions.json')), reply: async () => {}, report: () => {} };
  const a = new Bridge({ ...common, botId: '@a:test', kind: 'codex', isAuthorized: user => access.has(user, '@a:test'),
    confirmation: async (_room, _event, _text, controls) => { controls.bind('$confirm'); ready(); },
    run: async (_mode, _prompt, _key, signal, _sender, _files, interact) => {
      await interact!({ text: 'Run?', approve: {}, deny: {} }, signal); accepted = true; return 'done';
    },
  });
  const b = new Bridge({ ...common, botId: '@b:test', kind: 'claude', isAuthorized: user => access.has(user, '@b:test'), run: async () => { otherCalls++; return 'done'; } });
  const manager = new Bridge({ ...common, botId: '@manager:test', kind: 'manager', isAuthorized: user => access.has(user), run: async () => { otherCalls++; return 'done'; } });
  const event: MatrixEvent = { type: 'm.room.message', event_id: '$start', sender: '@scoped:test', origin_server_ts: 2000, content: { msgtype: 'm.text', body: 'hello' } };
  await b.handle('!dm:test', event); await manager.handle('!dm:test', event);
  assert.equal(otherCalls, 0);
  const task = a.handle('!dm:test', event); await waiting;
  access.changeBot('manager', '@owner:test', 'remove', '@a:test', ['@scoped:test']); a.revoke('@scoped:test');
  await a.handle('!dm:test', { ...event, type: 'm.reaction', event_id: '$reaction', content: { 'm.relates_to': { rel_type: 'm.annotation', event_id: '$confirm', key: '✅' } } });
  await task; assert.equal(accepted, false);
});
