import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isPrivateRoom, isPrivateRoomState } from '../src/private-room.js';

const bot = '@bot:test', owner = '@owner:test';
function state() {
  return [
    { type: 'm.room.encryption', state_key: '', content: { algorithm: 'm.megolm.v1.aes-sha2' } },
    { type: 'm.room.join_rules', state_key: '', content: { join_rule: 'invite' } },
    { type: 'm.room.history_visibility', state_key: '', content: { history_visibility: 'joined' } },
    ...[bot, owner].map(id => ({ type: 'm.room.member', state_key: id, content: { membership: 'join' } })),
  ];
}

test('private rooms require exactly the bot and sender, with no other joined, invited or knocking members', () => {
  assert.equal(isPrivateRoomState(state(), bot, owner), true);
  for (const membership of ['join', 'invite', 'knock']) {
    const events = [...state(), { type: 'm.room.member', state_key: '@third:test', content: { membership } }];
    assert.equal(isPrivateRoomState(events, bot, owner), false, membership);
    events.find(e => e.type === 'm.room.history_visibility')!.content = { history_visibility: 'shared' };
    assert.equal(isPrivateRoomState(events, bot, owner), false);
  }
  for (const membership of ['leave', 'ban']) {
    assert.equal(isPrivateRoomState([...state(), { type: 'm.room.member', state_key: '@third:test', content: { membership } }], bot, owner), true);
  }
  for (const id of [bot, owner]) {
    assert.equal(isPrivateRoomState(state().filter(e => e.state_key !== id), bot, owner), false);
    const events = state(); events.find(e => e.state_key === id)!.content = { membership: 'invite' };
    assert.equal(isPrivateRoomState(events, bot, owner), false);
  }
});

test('missing or unsafe encryption, history visibility and join rules fail closed', () => {
  for (const [type, content] of [
    ['m.room.encryption', { algorithm: 'unknown' }],
    ...['shared', 'invited', 'world_readable'].map(history_visibility => ['m.room.history_visibility', { history_visibility }]),
    ...['public', 'knock', 'restricted'].map(join_rule => ['m.room.join_rules', { join_rule }]),
  ] as [string, Record<string, string>][]) {
    const events = state().filter(e => e.type !== type);
    assert.equal(isPrivateRoomState(events, bot, owner), false);
    assert.equal(isPrivateRoomState([...events, { type, state_key: '', content }], bot, owner), false);
  }
});

test('privacy is rechecked on every operation and authorization is rechecked after the state request', async () => {
  let events = state(), allowed = true, calls = 0;
  const client = { getRoomState: async () => { calls++; return events; } };
  const check = () => isPrivateRoom(client, '!room:test', bot, owner, () => allowed);
  assert.equal(await check(), true);
  events.push({ type: 'm.room.member', state_key: '@third:test', content: { membership: 'invite' } });
  assert.equal(await check(), false);
  assert.equal(calls, 2);
  events = state();
  assert.equal(await isPrivateRoom({ getRoomState: async () => { allowed = false; return events; } }, '!room:test', bot, owner, () => allowed), false);
  assert.equal(await check(), false); assert.equal(calls, 2);
  await assert.rejects(isPrivateRoom({ getRoomState: async () => { throw new Error('offline'); } }, '!room:test', bot, owner, () => true), /offline/);
});
