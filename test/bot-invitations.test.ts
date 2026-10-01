import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { MatrixClient } from '@vector-im/matrix-bot-sdk';
import { BotInvitations } from '../src/bot-invitations.js';

function room(user: string, membership = 'invite', extra?: string) {
  return [
    { type: 'm.room.encryption', state_key: '', content: { algorithm: 'm.megolm.v1.aes-sha2' } },
    { type: 'm.room.join_rules', state_key: '', content: { join_rule: 'invite' } },
    { type: 'm.room.history_visibility', state_key: '', content: { history_visibility: 'joined' } },
    { type: 'm.room.member', state_key: '@bot:test', content: { membership: 'join' } },
    { type: 'm.room.member', state_key: user, content: { membership } },
    ...(extra ? [{ type: 'm.room.member', state_key: extra, content: { membership: 'invite' } }] : []),
  ].map((event, i) => ({ ...event, event_id: '$state' + i, origin_server_ts: 1000, room_id: '!state:test', sender: '@bot:test', unsigned: {} }));
}
function setup(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(join(tmpdir(), 'matrix-invites-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'bot-dms.json'), service = new BotInvitations(file);
  const rooms = new Map<string, ReturnType<typeof room>>();
  const creates: unknown[] = [], invites: string[][] = [];
  const client: Pick<MatrixClient, 'createRoom' | 'getJoinedRooms' | 'getRoomState' | 'inviteUser'> = {
    getJoinedRooms: async () => [...rooms.keys()],
    getRoomState: async id => rooms.get(id)!,
    createRoom: async options => {
      creates.push(options);
      const id = '!new' + creates.length + ':test';
      rooms.set(id, room(options!.invite![0])); return id;
    },
    inviteUser: async (user: string, id: string) => { invites.push([user, id]); rooms.set(id, room(user)); },
  };
  const controller = new AbortController();
  return { file, service, client, rooms, creates, invites, controller,
    ensure: (user = '@alice:test') => service.ensure('@bot:test', user, client, () => true, controller.signal) };
}

test('separate private encrypted DMs are created with one invited user and joined-only history', async t => {
  const f = setup(t);
  assert.equal(await f.ensure(), 'invited'); assert.equal(await f.ensure('@bob:test'), 'invited');
  const a = f.creates[0] as any, b = f.creates[1] as any;
  assert.deepEqual(a.invite, ['@alice:test']); assert.deepEqual(b.invite, ['@bob:test']);
  assert.equal(a.is_direct, true); assert.equal(a.visibility, 'private'); assert.equal(a.preset, 'private_chat');
  assert.ok(a.initial_state.some((s: any) => s.type === 'm.room.encryption' && s.content.algorithm === 'm.megolm.v1.aes-sha2'));
  assert.ok(a.initial_state.some((s: any) => s.type === 'm.room.history_visibility' && s.content.history_visibility === 'joined'));
  assert.equal(a.power_level_content_override.invite, 100);
  assert.equal(statSync(f.file).mode & 0o777, 0o600);
});

test('repeated and concurrent grants reuse a pending invitation across restart', async t => {
  const f = setup(t);
  assert.deepEqual(await Promise.all([f.ensure(), f.ensure()]), ['invited', 'invited']);
  assert.equal(await f.ensure(), 'pending');
  const restored = new BotInvitations(f.file);
  assert.equal(await restored.ensure('@bot:test', '@alice:test', f.client, () => true, f.controller.signal), 'pending');
  assert.equal(f.creates.length, 1); assert.equal(f.invites.length, 0);
  f.rooms.set('!new1:test', room('@alice:test', 'join'));
  assert.equal(await f.ensure(), 'joined');
});

for (const membership of ['join', 'invite']) test(`existing unrecorded ${membership} DM is discovered`, async t => {
  const f = setup(t); f.rooms.set('!existing:test', room('@alice:test', membership));
  assert.equal(await f.ensure(), membership === 'join' ? 'joined' : 'pending');
  assert.equal(f.creates.length, 0);
});

test('a declined invitation reuses the saved private room', async t => {
  const f = setup(t); await f.ensure();
  f.rooms.set('!new1:test', room('@alice:test', 'leave'));
  assert.equal(await f.ensure(), 'invited');
  assert.deepEqual(f.invites, [['@alice:test', '!new1:test']]); assert.equal(f.creates.length, 1);
});

for (const unsafe of ['extra-member', 'plaintext', 'public', 'shared-history']) test(`${unsafe} rooms are not reused or invited into`, async t => {
  const f = setup(t);
  const state = room('@alice:test', 'join', unsafe === 'extra-member' ? '@other:test' : undefined);
  if (unsafe === 'plaintext') state.splice(0, 1);
  if (unsafe === 'public') state[1].content.join_rule = 'public';
  if (unsafe === 'shared-history') state[2].content.history_visibility = 'shared';
  f.rooms.set('!unsafe:test', state);
  assert.equal(await f.ensure(), 'invited');
  assert.equal(f.creates.length, 1); assert.equal(f.invites.length, 0);
});

test('uncertain creation is reconciled from room state after restart without another create', async t => {
  const f = setup(t), original = f.client.createRoom;
  f.client.createRoom = async options => { await original(options); throw new Error('response lost'); };
  await assert.rejects(f.ensure(), /response lost/);
  const restored = new BotInvitations(f.file);
  assert.equal(await restored.ensure('@bot:test', '@alice:test', f.client, () => true, f.controller.signal), 'pending');
  assert.equal(f.creates.length, 1);
});

test('uncertain creation with no visible room is not automatically repeated', async t => {
  const f = setup(t); let writes = 0;
  f.client.createRoom = async () => { writes++; throw new Error('timeout'); };
  await assert.rejects(f.ensure(), /timeout/);
  await assert.rejects(f.ensure(), /unknown/);
  assert.equal(writes, 1);
});

test('revocation or cancellation during discovery prevents invitations', async t => {
  const f = setup(t); let allowed = true;
  f.client.getJoinedRooms = async () => { allowed = false; return []; };
  await assert.rejects(f.service.ensure('@bot:test', '@alice:test', f.client, () => allowed, f.controller.signal), /revoked/);
  f.client.getJoinedRooms = async () => { f.controller.abort(); return []; };
  await assert.rejects(f.ensure());
  assert.equal(f.creates.length, 0); assert.equal(f.invites.length, 0);
});
