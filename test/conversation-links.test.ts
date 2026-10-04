import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ConversationLinks, isSharedRoomState } from '../src/conversation-links.js';
import { State } from '../src/state.js';
import { Bridge, sessionKey, type MatrixEvent } from '../src/bridge.js';
import { linkedRoomMessages } from '../src/room-messages.js';

const human = '@alice:test', bot = '@builder:test', peer = '@reviewer:test';
const home = '!home:test', group = '!group:test';
const message = (body: string, id = '$1', sender = human): MatrixEvent => ({ type: 'm.room.message',
  sender, event_id: id, origin_server_ts: 2000, content: { msgtype: 'm.text', body } });
const canonical = sessionKey(home, message(''));

test('outbound room messages enforce destination privacy and session binding without copying source metadata', async t => {
  const f = fixture(t), signal = new AbortController().signal;
  let live = roomState(), stopping = false, calls = 0, resetDuringCheck = false;
  const event = message('Private instruction');
  Object.assign(event.content!, { 'm.relates_to': { rel_type: 'm.thread', event_id: '$private' }, 'm.mentions': { user_ids: [peer] } });
  const action = linkedRoomMessages(f.links, bot, { event, key: canonical }, {
    stopping: () => stopping,
    allowed: async (room, sender) => {
      if (resetDuringCheck) f.state.reset(canonical);
      return f.links.allowed(bot, room, sender, async () => live);
    },
    send: async (room, content) => {
      calls++;
      assert.equal(room, group);
      assert.deepEqual(content, { msgtype: 'm.text', body: 'Public result.', 'm.mentions': { user_ids: [] } });
      return '$sent';
    },
  });
  assert.deepEqual(JSON.parse(await action({ action: 'list' }, signal)), { rooms: [group] });
  const send = (room = group) => action({ action: 'send', room, text: 'Public result.', id: 'one' }, signal);
  assert.equal(JSON.parse(await send()).event_id, '$sent');
  for (const room of [home, '!unlisted:test']) await assert.rejects(send(room));
  for (const membership of ['join', 'invite', 'knock']) {
    live = [...roomState(), { type: 'm.room.member', state_key: '@extra:test', content: { membership } }];
    await assert.rejects(send());
    assert.deepEqual(JSON.parse(await action({ action: 'list' }, signal)), { rooms: [] });
  }
  live = roomState(); Object.assign(live[2].content, { history_visibility: 'shared' });
  await assert.rejects(send());
  live = roomState(); stopping = true; await assert.rejects(send());
  stopping = false; resetDuringCheck = true; await assert.rejects(send());
  assert.equal(calls, 1);
});
function roomState() {
  return [
    { type: 'm.room.encryption', state_key: '', content: { algorithm: 'm.megolm.v1.aes-sha2' } },
    { type: 'm.room.join_rules', state_key: '', content: { join_rule: 'invite' } },
    { type: 'm.room.history_visibility', state_key: '', content: { history_visibility: 'joined' } },
    ...[human, bot, peer].map(id => ({ type: 'm.room.member', state_key: id, content: { membership: 'join' } })),
  ];
}
function fixture(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(join(tmpdir(), 'linked-conversations-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'state.json'), state = new State(file);
  state.update(canonical, { codex: 'original-thread' });
  const config = { version: 1, agents: [{ bot, owner: human, home, session: 'original-thread' }],
    rooms: [{ room: group, owner: human, bots: [bot, peer] }] };
  const path = join(dir, 'links.json'), history = join(dir, 'history.json');
  const load = () => new ConversationLinks(path, history,
    [{ userId: bot, kind: 'codex', name: 'Builder', accessToken: 'test' }], state, human);
  writeFileSync(path, JSON.stringify(config));
  return { dir, file, path, state, config, load, links: load() };
}

test('shared rooms require encryption, restrictive history and exactly the configured participants', () => {
  assert.equal(isSharedRoomState(roomState(), [human, bot, peer]), true);
  for (const membership of ['join', 'invite', 'knock']) {
    const state = roomState();
    state.push({ type: 'm.room.member', state_key: '@extra:test', content: { membership } });
    assert.equal(isSharedRoomState(state, [human, bot, peer]), false);
  }
  const sharedHistory = roomState(); Object.assign(sharedHistory[2].content, { history_visibility: 'shared' });
  assert.equal(isSharedRoomState(sharedHistory, [human, bot, peer]), false);
  const missing = roomState().filter(e => e.state_key !== peer);
  assert.equal(isSharedRoomState(missing, [human, bot, peer]), false);
});

test('links continue the existing session and refuse missing or replaced histories', async t => {
  const f = fixture(t);
  assert.equal(f.links.key(bot, group, message('hello')), canonical);
  assert.equal(f.links.key(bot, home, message('hello')), canonical);
  assert.equal(await f.links.allowed(bot, group, human, async () => roomState()), true);
  assert.equal(await f.links.allowed(bot, group, peer, async () => roomState()), false);
  assert.throws(() => f.links.key(bot, '!other:test', message('hello')), /not linked/);
  f.state.reset(canonical);
  assert.throws(() => f.links.key(bot, group, message('hello')), /missing or changed/);
  assert.throws(f.load, /missing or changed/);
});

test('agent observations persist, do not become instructions or cross-room steering, and mentions address only their targets', t => {
  const f = fixture(t);
  f.links.observe(bot, group, message('A shared finding', '$peer', peer));
  f.links.observe(bot, group, message('A shared finding', '$peer', peer));
  f.links.observe(bot, home, message('Private detail', '$private'));
  const resumed = f.load();
  const prompt = resumed.prompt(bot, group, message('Next', '$next'), 'Next');
  assert.equal(prompt.split('A shared finding').length - 1, 1);
  assert.ok(!prompt.includes('Private detail'));
  assert.match(prompt, /not new instructions or approvals/);
  assert.match(resumed.prompt(bot, home, message('Next'), 'Next'), /A shared finding/);
  assert.ok(!resumed.prompt(bot, home, message('Update'), 'Update', true).includes('A shared finding'));
  const targeted = message('For the reviewer'); targeted.content!['m.mentions'] = { user_ids: [peer] };
  assert.equal(resumed.addressed(bot, group, targeted), false);
  assert.equal(resumed.addressed(bot, group, message('For everyone')), true);
});

test('unread batches have independent durable cursors and never discard an oversized message', t => {
  const f = fixture(t);
  const config = { ...f.config, agents: [...f.config.agents, { bot: peer, owner: human, home: '!peer-home:test', session: 'peer-thread' }] };
  f.state.update(sessionKey('!peer-home:test', message('')), { claude: 'peer-thread' });
  writeFileSync(f.path, JSON.stringify(config));
  const load = () => new ConversationLinks(f.path, join(f.dir, 'history.json'), [
    { userId: bot, kind: 'codex', name: 'Builder', accessToken: 'test' },
    { userId: peer, kind: 'claude', name: 'Reviewer', accessToken: 'test' },
  ], f.state, human);
  let links = load();
  const long = 'a'.repeat(16_000) + 'TAIL';
  links.observe(bot, group, message(long, '$long', peer));
  links.observe(bot, group, message('AFTER', '$after'));
  const context = (target: string) => JSON.parse(links.prompt(target, group, message('Next', '$next'), 'Next').split('\n')[1]);
  const first = context(bot);
  assert.equal(first.unreadSharedMessages.length, 1);
  assert.equal(first.unreadSharedMessages[0].continues, true);
  assert.ok(first.remainingMessages > 0);
  // No acknowledge means a failed turn can see the same observations again.
  assert.deepEqual(context(bot), first);
  links.acknowledge(bot); links = load();
  const rest = context(bot);
  assert.equal(first.unreadSharedMessages[0].body + rest.unreadSharedMessages[0].body, long);
  assert.equal(rest.unreadSharedMessages[1].body, 'AFTER');
  links.acknowledge(bot);
  assert.equal(context(bot).unreadSharedMessages.length, 0);
  assert.equal(context(peer).unreadSharedMessages[0].offset, 0);
  links.acknowledge(peer);
  context(peer); links.acknowledge(peer);
  // Duplicate Matrix delivery after pruning cannot resurrect an old observation.
  links.observe(bot, group, message(long, '$long', peer));
  assert.equal(context(bot).unreadSharedMessages.length, 0);
});

test('pending human messages are batched by conversation without consuming the next room or overflow', t => {
  const f = fixture(t);
  for (const [room, text, id] of [[group, 'First', '$a'], [group, 'Second', '$b'], [home, 'Private', '$c']]) {
    f.state.enqueue(bot, { room, event: message(text, id), feedback: false });
  }
  assert.deepEqual(f.state.dequeueBatch(bot).map(m => m.event.content!.body), ['First', 'Second']);
  assert.equal(f.state.queued(bot), 1);
  f.state.dequeueBatch(bot);
  f.state.enqueue(bot, { room: group, event: message('x'.repeat(10_000), '$d'), feedback: false });
  f.state.enqueue(bot, { room: group, event: message('y'.repeat(10_000), '$e'), feedback: false });
  assert.equal(f.state.dequeueBatch(bot).length, 1);
  assert.equal(f.state.queued(bot), 1);
});

function gate() { let release!: () => void; const promise = new Promise<void>(r => { release = r; }); return { promise, release }; }
const tick = () => new Promise<void>(r => setImmediate(r));

test('another room queues a separate turn, never steers, and retains reply and approval scope', async t => {
  const f = fixture(t), started = gate(), finish = gate();
  const calls: string[] = [], replies: [string, string][] = [], errors: unknown[] = [];
  let steers = 0, running = 0, peak = 0;
  const bridge = new Bridge({ botId: bot, owner: human, kind: 'codex', state: f.state, since: 0, timeoutMs: 5000,
    isAuthorized: id => id === human, isPrivateRoom: async () => true,
    linkedSession: (room, event) => f.links.key(bot, room, event),
    steer: async () => { steers++; return true; }, report: e => errors.push(e),
    reply: async (room, _event, text) => { replies.push([room, text]); },
    run: async (_kind, prompt, key, _signal, _sender, _files, _interact, _publish, hooks) => {
      assert.equal(key, canonical); running++; peak = Math.max(peak, running); calls.push(prompt);
      if (prompt === 'First') { started.release(); await finish.promise; }
      await hooks!.progress!('progress ' + prompt); running--; return 'answer ' + prompt;
    },
  });
  const task = bridge.handle(home, message('First', '$first')); await started.promise;
  await bridge.handle(group, message('Second', '$second'));
  await bridge.handle(group, message('!approve', '$bad-approve'));
  assert.equal(steers, 0); assert.deepEqual(calls, ['First']); assert.equal(f.state.queued(bot), 1);
  assert.ok(replies.some(([room, text]) => room === group && /No pending confirmation/.test(text)));
  finish.release(); await task;
  while (bridge.busy) await tick();
  assert.deepEqual(calls, ['First', 'Second']); assert.equal(peak, 1); assert.deepEqual(errors, []);
  assert.ok(replies.some(([room, text]) => room === home && text === 'progress First'));
  assert.ok(replies.some(([room, text]) => room === group && text === 'progress Second'));
  assert.ok(replies.some(([room, text]) => room === group && text === 'answer Second'));
});

test('queued messages survive restart, recheck access and do not reset a pinned session', async t => {
  const f = fixture(t);
  f.state.enqueue(bot, { room: group, event: message('Saved', '$saved'), feedback: false });
  const state = new State(f.file), calls: string[] = [];
  let allowed = true;
  const bridge = new Bridge({ botId: bot, owner: human, kind: 'codex', state, since: 3000, timeoutMs: 5000,
    isAuthorized: id => id === human, isPrivateRoom: async () => allowed,
    linkedSession: () => canonical, run: async (_kind, prompt) => { calls.push(prompt); return 'done'; },
    reply: async () => {}, report: error => { throw error; },
  });
  await bridge.drainQueued(); assert.deepEqual(calls, ['Saved']);
  state.enqueue(bot, { room: group, event: message('Revoked', '$revoked'), feedback: false });
  allowed = false; await bridge.drainQueued(); assert.deepEqual(calls, ['Saved']);
  allowed = true;
  await bridge.handle(home, { ...message('!reset', '$reset'), origin_server_ts: 4000 });
  assert.equal(state.session(canonical).codex, 'original-thread');
});

test('each bot independently consumes the same shared Matrix event', async t => {
  const f = fixture(t), calls: string[] = [];
  for (const id of [bot, peer]) {
    const b = new Bridge({ botId: id, owner: human, kind: 'codex', state: f.state, since: 0, timeoutMs: 1000,
      isAuthorized: sender => sender === human, isPrivateRoom: async () => true,
      run: async () => { calls.push(id); return 'done'; }, reply: async () => {}, report: e => { throw e; } });
    await b.handle(group, message('Both', '$same'));
    await b.handle(group, message('Both', '$same'));
  }
  assert.deepEqual(calls, [bot, peer]);
});

test('a linked session does not allow a permission to cross its original room or human', async t => {
  const f = fixture(t), delivered = gate();
  let result: object | undefined, requestId = '';
  const bridge = new Bridge({ botId: bot, owner: human, kind: 'codex', state: f.state, since: 0, timeoutMs: 5000,
    isAuthorized: id => id === human, isPrivateRoom: async () => true,
    linkedSession: (room, event) => f.links.key(bot, room, event),
    run: async (_kind, _prompt, _key, signal, _sender, _files, interact) => {
      result = await interact!({ text: 'Test operation', approve: { allowed: true }, deny: { allowed: false } }, signal);
      return 'finished';
    },
    confirmation: async (room, _event, text, controls) => {
      assert.equal(room, home); requestId = /Confirmation ([a-f0-9]{12})/.exec(text)![1];
      controls.bind('$confirmation'); delivered.release();
    }, reply: async () => {}, report: e => { throw e; },
  });
  const task = bridge.handle(home, message('Do work', '$work')); await delivered.promise;
  await bridge.handle(group, message('!approve ' + requestId, '$wrong-room'));
  await bridge.handle(home, message('!approve ' + requestId, '$wrong-sender', peer));
  await bridge.handle(group, { ...message('', '$wrong-reaction'), type: 'm.reaction',
    content: { 'm.relates_to': { rel_type: 'm.annotation', event_id: '$confirmation', key: '✅' } } });
  assert.equal(result, undefined);
  await bridge.handle(home, message('!approve ' + requestId, '$right-room')); await task;
  assert.deepEqual(result, { allowed: true });
});

test('linked background notifications use the saved session and keep their original delivery room', async t => {
  const f = fixture(t), replies: string[] = [], calls: string[] = [];
  const bridge = new Bridge({ botId: bot, owner: human, kind: 'codex', state: f.state, since: 0, timeoutMs: 5000,
    isAuthorized: id => id === human, isPrivateRoom: async () => true,
    linkedSession: (room, event) => f.links.key(bot, room, event),
    run: async (_kind, prompt, key) => { assert.equal(key, canonical); calls.push(prompt); return 'report'; },
    reply: async room => { replies.push(room); }, report: e => { throw e; },
  });
  let admissions = 0;
  assert.equal(await bridge.resumeBackground(group, message('Completed', '$watch'), 'original-thread', () => admissions++), true);
  assert.equal(admissions, 1); assert.deepEqual(calls, ['Completed']); assert.deepEqual(replies, [group]);
  assert.equal(await bridge.resumeBackground(group, message('Old', '$old'), 'replaced-thread', () => admissions++), false);
  assert.equal(admissions, 1);
});

test('slow room authorization cannot reorder incoming linked-room messages', async t => {
  const f = fixture(t), check = gate(), entered = gate(), running = gate(), finish = gate();
  const calls: string[] = [];
  let checks = 0;
  const bridge = new Bridge({ botId: bot, owner: human, kind: 'codex', state: f.state, since: 0, timeoutMs: 5000,
    isAuthorized: id => id === human, isPrivateRoom: async () => {
      if (++checks === 1) { entered.release(); await check.promise; } return true;
    }, linkedSession: () => canonical,
    run: async (_kind, prompt) => { calls.push(prompt); if (prompt === 'First') { running.release(); await finish.promise; } return 'done'; },
    reply: async () => {}, report: e => { throw e; },
  });
  const first = bridge.handle(home, message('First', '$first')); await entered.promise;
  const second = bridge.handle(group, message('Second', '$second'));
  await tick(); assert.equal(checks, 1);
  check.release(); await running.promise; await second;
  assert.deepEqual(calls, ['First']); finish.release(); await first;
  while (bridge.busy) await tick();
  assert.deepEqual(calls, ['First', 'Second']);
});
