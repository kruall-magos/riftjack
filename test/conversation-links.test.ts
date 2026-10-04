import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ConversationLinks, isSharedRoomState, mentionText } from '../src/conversation-links.js';
import { replyContent } from '../src/message-format.js';
import { State } from '../src/state.js';
import { AGENT_TRIGGER, Bridge, ORIGIN, REPLY, SERVICE, sessionKey, type MatrixEvent } from '../src/bridge.js';

const human = '@alice:test', bot = '@builder:test', peer = '@reviewer:test';
const home = '!home:test', group = '!group:test';
const message = (body: string, id = '$1', sender = human): MatrixEvent => ({ type: 'm.room.message',
  sender, event_id: id, origin_server_ts: 2000, content: { msgtype: 'm.text', body } });
const canonical = sessionKey(home, message(''));
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

function pair(t: { after(fn: () => void): void }) {
  const f = fixture(t);
  const config = { ...f.config, agents: [...f.config.agents, { bot: peer, owner: human, home: '!peer-home:test', session: 'peer-thread' }] };
  f.state.update(sessionKey('!peer-home:test', message('')), { claude: 'peer-thread' });
  writeFileSync(f.path, JSON.stringify(config));
  const load = () => new ConversationLinks(f.path, join(f.dir, 'history.json'), [
    { userId: bot, kind: 'codex', name: 'Builder', accessToken: 'test' },
    { userId: peer, kind: 'claude', name: 'Reviewer', accessToken: 'test' },
  ], f.state, human);
  return { ...f, load, links: load() };
}
const mentioning = (body: string, id: string, sender: string, to: string[], origin?: string): MatrixEvent => {
  const event = message(body, id, sender);
  Object.assign(event.content!, { 'm.mentions': { user_ids: to }, ...(origin && { [ORIGIN]: origin }) });
  return event;
};

test('explicit peer mentions start a durable, budgeted connector notice per human message', t => {
  const f = pair(t);
  let links = f.links;
  assert.equal(links.observe(bot, group, message('Task', '$h1')), true);
  assert.equal(links.observe(bot, group, message('Task', '$h1')), false);
  assert.equal(links.mention(bot, group, message('No mention', '$p0', peer)), undefined);
  assert.equal(links.mention(bot, group, mentioning('From the owner', '$h-self', human, [bot])), undefined);
  assert.equal(links.mention(peer, group, mentioning('Self', '$p-self', peer, [peer])), undefined);
  const service = mentioning('Confirmation', '$svc', peer, [bot]); Object.assign(service.content!, { [SERVICE]: 'confirmation' });
  assert.equal(links.observe(bot, group, service), false);
  assert.equal(links.mention(bot, group, service), undefined);
  const first = links.mention(bot, group, mentioning('Question', '$p1', peer, [bot], '$h1'))!;
  assert.equal(first.sender, human);
  assert.notEqual(first.event_id, '$p1');
  assert.deepEqual(first.content![AGENT_TRIGGER], { agent: peer, event: '$p1', events: [] });
  assert.equal(first.content![ORIGIN], '$h1');
  // Each agent evaluates a peer event once.
  assert.equal(links.mention(bot, group, mentioning('Question', '$p1', peer, [bot], '$h1')), undefined);
  assert.ok(links.mention(bot, group, mentioning('Again', '$p2', peer, [bot], '$h1')));
  links = f.load();
  assert.equal(links.mention(bot, group, mentioning('Third', '$p3', peer, [bot], '$h1')), undefined);
  // The other agent has its own budget for the same human message.
  assert.ok(links.mention(peer, group, mentioning('To reviewer', '$b1', bot, [peer], '$h1')));
  links.observe(bot, group, message('Next task', '$h2'));
  // A late reply to the old task cannot spend the budget of the new one.
  assert.equal(links.mention(bot, group, mentioning('Late', '$p4', peer, [bot], '$h1')), undefined);
  // Unknown, missing or expired origins are refused instead of charging the current task.
  assert.equal(links.mention(bot, group, mentioning('Unknown origin', '$p5', peer, [bot], '$forged')), undefined);
  assert.equal(links.mention(bot, group, mentioning('No origin', '$p6', peer, [bot])), undefined);
  assert.ok(links.mention(bot, group, mentioning('Current', '$p7', peer, [bot], '$h2')));
  for (let i = 0; i < 100; i++) links.observe(bot, group, message('Filler', '$fill' + i));
  assert.equal(links.mention(bot, group, mentioning('Expired', '$p8', peer, [bot], '$h2')), undefined);
  const context = JSON.parse(links.prompt(bot, group, first, first.content!.body!).split('\n')[1]);
  assert.equal(context.author, peer);
  assert.equal(context.trigger, 'agent-mention');
  assert.match(links.prompt(bot, group, first, first.content!.body!), /Current connector notice:\n[^]*NO_REPLY/);
  assert.match(links.prompt(bot, group, message('Hi', '$h3'), 'Hi'), /matrix-mentions/);
  assert.ok(!links.prompt(bot, home, message('Hi', '$h4'), 'Hi').includes('matrix-mentions'));
});

test('mention blocks are validated, removed and reported back to the agent', t => {
  const f = pair(t), links = f.links;
  links.observe(bot, group, message('Task', '$h1'));
  const block = (json: string) => 'Answer\n```matrix-mentions\n' + json + '\n```';
  assert.deepEqual(links.mentions(bot, group, block(`{"to":["${peer}","${peer}"]}`)), { text: 'Answer', mentions: [peer] });
  assert.deepEqual(links.mentions(bot, group, 'Plain reply'), { text: 'Plain reply', mentions: [] });
  // Examples inside another fence, a quote or a list are text, not requests.
  const example = 'See:\n````markdown\n' + block(`{"to":["${peer}"]}`) + '\n````';
  assert.deepEqual(links.mentions(bot, group, example), { text: example, mentions: [] });
  for (const nested of ['> ' + block(`{"to":["${peer}"]}`).replace(/\n/g, '\n> '), '- item\n\n  ```matrix-mentions\n  {"to":["' + peer + '"]}\n  ```']) {
    assert.deepEqual(links.mentions(bot, group, nested)!.mentions, []);
  }
  assert.equal(links.mentions(bot, home, block(`{"to":["${peer}"]}`)), undefined);
  for (const bad of [block(`{"to":["${human}"]}`), block(`{"to":["${bot}"]}`), block('{"to":'), block('{"to":[]}'),
    block(`{"to":["${peer}"]}`) + '\n' + block(`{"to":["${peer}"]}`)]) {
    const parsed = links.mentions(bot, group, bad)!;
    assert.deepEqual(parsed.mentions, []);
    assert.ok(parsed.error);
    assert.ok(!parsed.text.includes('matrix-mentions'));
  }
  const notes = () => JSON.parse(links.prompt(bot, group, message('Next', '$h2'), 'Next').split('\n')[1]).connectorNotes;
  assert.equal(notes().length, 5);
  links.acknowledge(bot);
  assert.equal(notes(), undefined);
  const reply = links.outgoing(bot, group, message('Task', '$h1'), { msgtype: 'm.text', body: 'x' }, [peer]);
  assert.equal(reply[ORIGIN], '$h1');
  assert.deepEqual(reply['m.mentions'], { user_ids: [peer] });
  assert.equal(links.outgoing(bot, group, message('Task', '$h1'), { msgtype: 'm.notice', body: 'x' })[ORIGIN], undefined);
  assert.deepEqual(links.outgoing(bot, home, message('Task', '$h1'), { msgtype: 'm.text', body: 'x' }, [peer]), { msgtype: 'm.text', body: 'x' });
  assert.match(mentionText('Answer', [peer]), /\[@reviewer:test\]\(https:\/\/matrix\.to\/#\/@reviewer:test\)$/);
});

test('peer-started turns may stay silent, never steer and cannot be injected from Matrix', async t => {
  const f = pair(t), started = gate(), finish = gate();
  const calls: string[] = [], replies: string[] = [];
  let steers = 0;
  const bridge = new Bridge({ botId: bot, owner: human, kind: 'codex', state: f.state, since: 0, timeoutMs: 5000,
    isAuthorized: id => id === human, isPrivateRoom: async () => true,
    linkedSession: (room, event) => f.links.key(bot, room, event),
    steer: async () => { steers++; return true; }, report: e => { throw e; },
    reply: async (_room, _event, text) => { replies.push(text); },
    run: async (_kind, prompt) => {
      calls.push(prompt);
      if (prompt === 'Long task') { started.release(); await finish.promise; return 'done'; }
      return prompt.includes('Another agent') ? 'NO_REPLY' : 'answer';
    },
  });
  f.links.observe(bot, group, message('Task', '$h1'));
  let asked = 0;
  const notice = () => f.links.mention(bot, group, mentioning('Question', '$p' + asked++, peer, [bot], '$h1'))!;
  await bridge.handle(group, notice());
  assert.deepEqual(calls, []);
  await bridge.handleAgentMention(group, notice());
  assert.equal(calls.length, 1); assert.deepEqual(replies, []);
  const task = bridge.handle(group, message('Long task', '$long')); await started.promise;
  const replied = replies.length;
  f.links.observe(bot, group, message('Another task', '$h2'));
  await bridge.handleAgentMention(group, f.links.mention(bot, group, mentioning('While busy', '$busy', peer, [bot], '$h2'))!);
  await bridge.handle(group, message('Follow-up', '$after'));
  assert.equal(steers, 1); assert.equal(f.state.queued(bot), 1); assert.equal(replies.length, replied + 1);
  finish.release(); await task;
  while (bridge.busy) await tick();
  assert.equal(calls.length, 3);
  assert.match(calls[2], /Another agent/);
});

test('an outgoing reply with a mention block starts the peer turn after attachments', async t => {
  const f = pair(t), sent: string[] = [], peerPrompts: string[] = [], events: MatrixEvent[] = [];
  const replyContentFor = (room: string, event: MatrixEvent, text: string, msgtype: 'm.text' | 'm.notice', mentions?: string[]) => {
    const contents = replyContent(mentions?.length ? mentionText(text, mentions) : text, true, true, msgtype);
    return contents.map((content, index) => f.links.outgoing(bot, room, event, content, index === contents.length - 1 ? mentions : undefined, 'reply-' + events.length));
  };
  const builder = new Bridge({ botId: bot, owner: human, kind: 'codex', state: f.state, since: 0, timeoutMs: 5000,
    isAuthorized: id => id === human, isPrivateRoom: async () => true,
    linkedSession: (room, event) => f.links.key(bot, room, event), report: e => { throw e; },
    mentions: (room, text) => f.links.mentions(bot, room, text),
    sendAttachments: async () => { sent.push('attachment'); },
    reply: async (room, event, text, _markdown, msgtype = 'm.notice', mentions) => {
      sent.push(msgtype);
      for (const content of replyContentFor(room, event, text, msgtype, mentions)) {
        events.push({ type: 'm.room.message', sender: bot, event_id: '$out' + events.length, origin_server_ts: 3000, content });
      }
    },
    run: async () => ({ text: 'Please review.\n```matrix-mentions\n{"to":["' + peer + '"]}\n```', attachments: [{ path: '/x', root: '/' }] }),
  });
  const reviewer = new Bridge({ botId: peer, owner: human, kind: 'claude', state: f.state, since: 0, timeoutMs: 5000,
    isAuthorized: id => id === human, isPrivateRoom: async () => true,
    linkedSession: (room, event) => f.links.key(peer, room, event), report: e => { throw e; },
    decoratePrompt: (room, event, prompt, steering) => f.links.prompt(peer, room, event, prompt, steering),
    reply: async () => {}, run: async (_kind, prompt) => { peerPrompts.push(prompt); return 'NO_REPLY'; },
  });
  const task = message('Build it', '$h1');
  f.links.observe(peer, group, task);
  await builder.handle(group, task);
  assert.deepEqual(sent.filter(s => s !== 'm.notice'), ['attachment', 'm.text']);
  const reply = events.at(-1)!;
  assert.deepEqual(reply.content!['m.mentions'], { user_ids: [peer] });
  assert.equal(reply.content![ORIGIN], '$h1');
  assert.ok(!reply.content!.body!.includes('matrix-mentions'));
  // The same path main.ts uses for the peer's incoming Matrix event.
  assert.equal(f.links.observe(peer, group, reply), true);
  await reviewer.handleAgentMention(group, f.links.mention(peer, group, reply)!);
  assert.equal(peerPrompts.length, 1);
  const context = JSON.parse(peerPrompts[0].split('\n')[1]);
  assert.equal(context.trigger, 'agent-mention');
  // The question arrives quoted in the notice, not again as an observation.
  assert.match(peerPrompts[0], /Current connector notice:[^]*Please review\./);
  assert.ok(!context.unreadSharedMessages.some((m: { id: string }) => m.id === reply.event_id));
  // An agent is not sent its own messages back.
  f.links.acknowledge(peer);
  f.links.observe(peer, group, message('Own reply', '$own', peer));
  const next = JSON.parse(f.links.prompt(peer, group, message('Next', '$h2'), 'Next').split('\n')[1]);
  assert.deepEqual(next.unreadSharedMessages, []);
  assert.equal(next.remainingMessages, 0);
});

test('mentions trigger once per recipient in any delivery order and carry the whole question', t => {
  for (const order of [[peer, bot], [bot, peer]]) {
    const f = pair(t);
    f.links.observe(bot, group, message('Task', '$h1'));
    const question = mentioning('Question', '$q', peer, [bot], '$h1');
    const starts = order.map(id => { f.links.observe(id, group, question); return f.links.mention(id, group, question); }).filter(Boolean);
    assert.equal(starts.length, 1);
  }
  const f = pair(t);
  const part = (body: string, id: string, reply: string) => { const event = message(body, id, peer); Object.assign(event.content!, { [REPLY]: reply }); return event; };
  f.links.observe(bot, group, message('Task', '$h1'));
  f.links.observe(bot, group, part('x'.repeat(15_000), '$backlog', 'r0'));
  f.links.observe(bot, group, part('Earlier part. ', '$part1', 'r1'));
  const last = mentioning('Please review the parser.', '$part2', peer, [bot], '$h1');
  Object.assign(last.content!, { [REPLY]: 'r1' });
  f.links.observe(bot, group, last);
  const notice = f.links.mention(bot, group, last)!;
  assert.deepEqual(notice.content![AGENT_TRIGGER]!.events, ['$part1', '$part2']);
  assert.match(f.links.prompt(bot, group, notice, notice.content!.body!), /Earlier part\. Please review the parser\./);
  // The quoted parts are not delivered a second time as observations.
  f.links.acknowledge(bot);
  const next = JSON.parse(f.links.prompt(bot, group, message('Next', '$h2'), 'Next').split('\n')[1]);
  assert.ok(!next.unreadSharedMessages.some((m: { id: string }) => m.id === '$part1' || m.id === '$part2'));
});
