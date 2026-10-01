import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Accounts } from '../src/accounts.js';
import { Access } from '../src/access.js';
import { parseBotAccessRequest, manageBotAccess } from '../src/bot-access.js';

function setup(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(join(tmpdir(), 'bot-access-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const accounts = new Accounts(join(dir, 'accounts.json'));
  accounts.add({ userId: '@bot_codex_test_123456abcdef:test', name: 'Riftjack Codex', kind: 'codex', accessToken: 'secret' });
  accounts.add({ userId: '@manager:test', name: 'Bot Manager', kind: 'manager', accessToken: 'secret' });
  const access = new Access(join(dir, 'access.json'), '@owner:test'), revoked: string[][] = [];
  const options = { accounts, access, sender: access.owner, revoke: (bot: string, user: string) => { revoked.push([bot, user]); } };
  return { options, access, accounts, revoked };
}

test('commands accept bot names and full user lists, rejecting malformed batches', () => {
  assert.deepEqual(parseBotAccessRequest('allow bot Riftjack Codex for @alice:test, @bob:elsewhere @alice:test'), { action: 'allow', target: 'Riftjack Codex', users: ['@alice:test', '@bob:elsewhere'] });
  assert.deepEqual(parseBotAccessRequest('remove bot "Ready for work" for @alice:test'), { action: 'remove', target: 'Ready for work', users: ['@alice:test'] });
  assert.deepEqual(parseBotAccessRequest('list access bot Riftjack Codex'), { action: 'list', target: 'Riftjack Codex' });
  for (const bad of ['allow bot Bot for everyone', 'remove bot Bot for', 'allow bot Bot for @alice:test invalid', 'list access bot']) assert.throws(() => parseBotAccessRequest(bad), /Use /);
  assert.equal(parseBotAccessRequest('allow @alice:test'), null);
});

test('named bot grants persist across renames and removal revokes only that bot', async t => {
  const f = setup(t), id = f.accounts.list()[0].userId;
  const result = await manageBotAccess(parseBotAccessRequest('allow bot riftjack codex for @alice:test @bob:test')!, f.options);
  assert.equal(f.access.has('@alice:test', id), true); assert.equal(f.access.has('@alice:test'), false);
  assert.match(result, /This bot’s access list/); assert.match(result, /Shared access/);
  f.accounts.setName(id, 'New Name');
  assert.match(await manageBotAccess(parseBotAccessRequest('list access bot New Name')!, f.options), /alice/);
  await manageBotAccess(parseBotAccessRequest('remove bot New Name for @alice:test')!, f.options);
  assert.deepEqual(f.revoked, [[id, '@alice:test']]);
  assert.equal(f.access.has('@bob:test', id), true);
});

test('only the owner manages lists, and bots, manager targets or ambiguous names cannot be granted', async t => {
  const f = setup(t);
  const command = parseBotAccessRequest('allow bot Riftjack Codex for @alice:test')!;
  await assert.rejects(manageBotAccess(command, { ...f.options, sender: '@other:test' }), /Only the initial owner/);
  await assert.rejects(manageBotAccess(parseBotAccessRequest('allow bot Bot Manager for @alice:test')!, f.options), /Manager access/);
  await assert.rejects(manageBotAccess(parseBotAccessRequest('allow bot Riftjack Codex for @alice:test @manager:test')!, f.options), /Bot accounts/);
  assert.equal(f.access.has('@alice:test', f.accounts.list()[0].userId), false);
  f.accounts.add({ ...f.accounts.list()[0], userId: '@other:test' });
  await assert.rejects(manageBotAccess(command, f.options), /Several bots/);
});

test('allow invites the batch after granting access, reports partial failure, and remove/list never invite', async t => {
  const f = setup(t), invited: string[][] = [];
  const options = { ...f.options, invite: async (bot: string, user: string) => {
    assert.equal(f.access.has(user, bot), true);
    invited.push([bot, user]);
    if (user === '@bob:test') throw new Error('secret-token');
    return 'invited' as const;
  } };
  const result = await manageBotAccess(parseBotAccessRequest('allow bot Riftjack Codex for @alice:test @bob:test @charlie:test')!, options);
  assert.equal(invited.length, 3);
  assert.match(result, /invitation sent/);
  assert.match(result, /access granted, invitation unconfirmed/);
  assert.doesNotMatch(result, /secret-token/);
  assert.equal(f.access.has('@bob:test', invited[0][0]), true);
  await manageBotAccess(parseBotAccessRequest('list access bot Riftjack Codex')!, options);
  await manageBotAccess(parseBotAccessRequest('remove bot Riftjack Codex for @alice:test')!, options);
  assert.equal(invited.length, 3);
});
