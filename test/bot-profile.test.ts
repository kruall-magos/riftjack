import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Accounts } from '../src/accounts.js';
import { canManageProfile, parseProfileRequest, updateBotProfile } from '../src/bot-profile.js';
import type { IncomingAttachment } from '../src/media.js';

function fixture(t: { after(fn: () => void): void }) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'matrix-profile-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = join(root, 'accounts.json');
  const accounts = new Accounts(file);
  accounts.add({ userId: '@bot:test', accessToken: 'test-token', name: 'Old', kind: 'codex', inviteUserId: '@creator:test', workspace: root, roomId: '!dm:test' });
  const calls: unknown[][] = [];
  const client = {
    setDisplayName: async (name: string) => { calls.push(['name', name]); },
    setAvatarUrl: async (url: string) => { calls.push(['avatar', url]); },
    uploadContent: async (data: Buffer, mime?: string) => { calls.push(['upload', data, mime]); return 'mxc://test/avatar'; },
  };
  const options = { accounts, owner: '@owner:test', sender: '@creator:test', signal: new AbortController().signal,
    maxBytes: 1024, attachments: [] as IncomingAttachment[], client: (userId: string) => { assert.equal(userId, '@bot:test'); return client; } };
  return { root, file, accounts, calls, client, options };
}

test('profile commands accept Matrix IDs and Unicode names, rejecting malformed input', () => {
  for (const name of ['Helper 🦊', 'Помощник', '案内役', 'مساعد', 'Cafe\u0301']) {
    for (const id of ['@bot:test', '@bot', 'bot']) {
      assert.deepEqual(parseProfileRequest(`rename bot ${id} to ${name}`), { action: 'rename', userId: id, name });
    }
  }
  assert.deepEqual(parseProfileRequest('set avatar @bot:test'), { action: 'avatar', userId: '@bot:test' });
  assert.deepEqual(parseProfileRequest('remove avatar @bot:test'), { action: 'remove-avatar', userId: '@bot:test' });
  for (const command of ['set', 'remove']) for (const target of ['Riftjack Codex', 'Helper Bot', '@bot', 'bot_codex_codex', '"Riftjack Codex"']) {
    assert.deepEqual(parseProfileRequest(`${command} avatar ${target}`), {
      action: command === 'set' ? 'avatar' : 'remove-avatar', userId: target.replace(/"/g, ''),
    });
  }
  for (const bad of ['rename bot @bot: to Foo', 'rename bot @ to Foo', 'rename bot @bot:test to ', 'rename bot @bot:test to a\nb',
    'rename bot @bot:test to ' + 'x'.repeat(101), 'set avatar @bot:test https://example.test/pic', 'remove avatar']) {
    assert.equal(parseProfileRequest(bad), null);
  }
});

test('short IDs resolve registered bots without changing authorization or guessing the server', async t => {
  const f = fixture(t);
  for (const id of ['@bot', 'bot']) {
    await updateBotProfile(parseProfileRequest(`rename bot ${id} to New`)!, f.options);
    await assert.rejects(updateBotProfile(parseProfileRequest(`rename bot ${id} to Forbidden`)!,
      { ...f.options, sender: '@other:test' }), /Only the connector owner/);
  }
  assert.deepEqual(f.calls, [['name', 'New'], ['name', 'New']]);
  await assert.rejects(updateBotProfile(parseProfileRequest('rename bot unknown to New')!, f.options), /No bot found/);
  f.accounts.add({ ...f.accounts.list()[0], userId: '@bot:other', inviteUserId: '@other:test' });
  await assert.rejects(updateBotProfile(parseProfileRequest('rename bot bot to Wrong')!, f.options), /Several bots.*full Matrix ID/);
  assert.equal(f.calls.length, 2);
  await updateBotProfile(parseProfileRequest('rename bot @bot:test to Exact')!, f.options);
  assert.equal(f.accounts.list().find(a => a.userId === '@bot:other')!.name, 'New');
  assert.deepEqual(f.calls.at(-1), ['name', 'Exact']);
});

test('creator can rename and persistence preserves ID, room and workspace; remote failure keeps old name', async t => {
  const f = fixture(t);
  const before = f.accounts.list()[0];
  await updateBotProfile({ action: 'rename', userId: before.userId, name: 'New name' }, f.options);
  assert.deepEqual(new Accounts(f.file).list()[0], { ...before, name: 'New name' });
  assert.deepEqual(f.calls, [['name', 'New name']]);
  f.client.setDisplayName = async () => { throw new Error('offline'); };
  await assert.rejects(updateBotProfile({ action: 'rename', userId: before.userId, name: 'Failed' }, f.options), /offline/);
  assert.equal(f.accounts.list()[0].name, 'New name');
});

for (const target of ['Codex', 'codex', 'bot_codex_codex', '@bot_codex_codex']) test(`screenshot rename works using ${target}`, async t => {
  const f = fixture(t);
  const account = { ...f.accounts.list()[0], name: 'Codex', userId: '@bot_codex_codex_72af84bf4fa6:test' };
  f.accounts.add(account);
  await updateBotProfile(parseProfileRequest(`Rename bot ${target} to Riftjack Codex`)!, {
    ...f.options, client: id => { assert.equal(id, account.userId); return f.client; },
  });
  assert.deepEqual(new Accounts(f.file).list().find(a => a.userId === account.userId), { ...account, name: 'Riftjack Codex' });
  assert.equal(f.accounts.list()[0].name, 'Old');
  assert.deepEqual(f.calls, [['name', 'Riftjack Codex']]);
});

test('renaming matches names regardless of case and accepts quoted multiword names', async t => {
  const f = fixture(t);
  f.accounts.setName('@bot:test', 'Riftjack Codex');
  await updateBotProfile(parseProfileRequest('rename bot riftjack codex to Assistant 🦊')!, f.options);
  await updateBotProfile(parseProfileRequest('rename bot ASSISTANT 🦊 to Ready to help')!, f.options);
  await updateBotProfile(parseProfileRequest('rename bot "Ready to help" to Helper')!, f.options);
  await assert.rejects(updateBotProfile(parseProfileRequest('rename bot Old to Wrong')!, f.options), /No bot found/);
  assert.equal(f.accounts.list()[0].name, 'Helper');
  assert.equal(f.calls.length, 3);
  for (const command of ['rename bot "" to Name', 'rename bot "Ready to help to Name', 'rename bot Old\nName to New']) {
    assert.equal(parseProfileRequest(command), null);
  }
});

test('duplicate names, generated aliases and name/ID collisions require an explicit full ID', async t => {
  const f = fixture(t);
  const original = f.accounts.list()[0];
  f.accounts.add({ ...original, userId: '@bot_codex_codex_123456abcdef:test', name: 'CodeX' });
  f.accounts.add({ ...original, userId: '@bot_codex_codex_abcdef123456:other', name: 'codex', inviteUserId: '@other:test' });
  f.accounts.add({ ...original, userId: '@different:test', name: 'bot' });
  for (const target of ['Codex', 'bot_codex_codex', '@bot_codex_codex', 'bot']) {
    await assert.rejects(updateBotProfile(parseProfileRequest(`rename bot ${target} to Wrong`)!, f.options), /Several bots.*full Matrix ID/);
  }
  assert.deepEqual(f.calls, []);
  // Full IDs never fall back to a display name, or to another accessible bot.
  f.accounts.setName('@different:test', '@bot:test');
  await updateBotProfile(parseProfileRequest('rename bot @bot:test to Exact')!, f.options);
  assert.equal(f.accounts.list().find(a => a.userId === '@different:test')!.name, '@bot:test');
});

test('names and aliases preserve permission checks and do not match arbitrary ID prefixes', async t => {
  const f = fixture(t);
  f.accounts.add({ ...f.accounts.list()[0], userId: '@bot_codex_codex_123456abcdef:test', name: 'Codex', inviteUserId: '@other:test' });
  for (const target of ['Codex', 'bot_codex_codex']) {
    await assert.rejects(updateBotProfile(parseProfileRequest(`rename bot ${target} to Wrong`)!, f.options), /Only the connector owner/);
  }
  for (const target of ['Code', 'bot_codex', 'bot_codex_codex_1234', '@missing:test']) {
    await assert.rejects(updateBotProfile(parseProfileRequest(`rename bot ${target} to Wrong`)!, f.options), /No bot found/);
  }
  f.accounts.add({ ...f.accounts.list()[0], userId: '@manager:test', kind: 'manager', name: 'Bot Manager' });
  await assert.rejects(updateBotProfile(parseProfileRequest('rename bot Bot Manager to Wrong')!, f.options), /Only the connector owner/);
  assert.deepEqual(f.calls, []);
});

test('profile permissions protect other bots and legacy bots, and only owner controls manager', async t => {
  const f = fixture(t);
  const account = f.accounts.list()[0];
  assert.equal(canManageProfile(account, '@owner:test', '@owner:test'), true);
  assert.equal(canManageProfile({ ...account, inviteUserId: undefined }, '@creator:test', '@owner:test'), false);
  assert.equal(canManageProfile({ ...account, kind: 'manager' }, '@creator:test', '@owner:test'), false);
  for (const action of ['rename', 'avatar', 'remove-avatar'] as const) {
    await assert.rejects(updateBotProfile({ action, userId: '@bot:test', name: 'No' }, { ...f.options, sender: '@other:test' }), /Only the connector owner/);
  }
  await assert.rejects(updateBotProfile({ action: 'rename', userId: '@unknown:test', name: 'No' }, f.options), /No bot found/);
  await assert.rejects(updateBotProfile({ action: 'rename', userId: '@bot:test', name: 'No' }, { ...f.options, client: () => undefined }), /disconnected/);
  assert.deepEqual(f.calls, []);
});

for (const target of ['@bot:test', '@bot', 'bot', 'Riftjack Codex', 'riftjack codex', '"Riftjack Codex"']) test(`avatar uses resolved bot ${target} for upload and removal`, async t => {
  const f = fixture(t);
  f.accounts.setName('@bot:test', 'Riftjack Codex');
  const path = join(f.root, 'avatar.png');
  const data = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j5xoAAAAASUVORK5CYII=', 'base64');
  writeFileSync(path, data);
  f.options.attachments = [{ path, name: 'avatar.png', mimetype: 'text/plain', image: false, size: data.length }];
  await updateBotProfile(parseProfileRequest(`set avatar ${target}`)!, f.options);
  assert.deepEqual(f.calls, [['upload', data, 'image/png'], ['avatar', 'mxc://test/avatar']]);
  f.options.attachments = [];
  await updateBotProfile(parseProfileRequest(`remove avatar ${target}`)!, f.options);
  assert.deepEqual(f.calls.at(-1), ['avatar', '']);
});

test('avatar names reject ambiguous, missing and unauthorized targets before using a client', async t => {
  const f = fixture(t);
  const options = { ...f.options, client: () => { assert.fail('Must not access a client'); } };
  for (const verb of ['set', 'remove']) {
    await assert.rejects(updateBotProfile(parseProfileRequest(`${verb} avatar Old`)!, { ...options, sender: '@other:test' }), /Only the connector owner/);
    await assert.rejects(updateBotProfile(parseProfileRequest(`${verb} avatar Missing`)!, options), /No bot found/);
  }
  f.accounts.add({ ...f.accounts.list()[0], userId: '@other:test', name: 'OLD' });
  for (const verb of ['set', 'remove']) {
    await assert.rejects(updateBotProfile(parseProfileRequest(`${verb} avatar Old`)!, options), /Several bots/);
  }
});

test('missing, invalid, oversized and cancelled avatar requests never upload', async t => {
  const f = fixture(t);
  const request = { action: 'avatar' as const, userId: '@bot:test' };
  await assert.rejects(updateBotProfile(request, f.options), /Attach one image/);
  const path = join(f.root, 'fake.png'); writeFileSync(path, '<svg>not a bitmap</svg>');
  f.options.attachments = [{ path, name: 'fake.png', mimetype: 'image/png', image: true, size: 1 }];
  await assert.rejects(updateBotProfile(request, f.options), /must be PNG/);
  await assert.rejects(updateBotProfile(request, { ...f.options, maxBytes: 1 }), /exceeds/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(updateBotProfile(request, { ...f.options, signal: controller.signal }), /abort/i);
  await assert.rejects(updateBotProfile({ action: 'rename', userId: '@bot:test', name: 'No' }, f.options), /does not need an attachment/);
  assert.deepEqual(f.calls, []);
});
