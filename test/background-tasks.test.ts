import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, realpathSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BackgroundTasks, type BackgroundTarget } from '../src/background-tasks.js';
import { Bridge, sessionKey, type MatrixEvent, type BackendHooks } from '../src/bridge.js';
import { State } from '../src/state.js';

const signal = () => new AbortController().signal;
const event: MatrixEvent = { type: 'm.room.message', event_id: '$start', sender: '@alice:test', origin_server_ts: 1,
  content: { msgtype: 'm.text', body: 'Continue the task.', 'm.relates_to': { rel_type: 'm.thread', event_id: '$thread' } } };
const target: BackgroundTarget = { room: '!room:test', sender: '@alice:test', thread: '$thread', key: sessionKey('!room:test', event), session: 'session-1' };
const input = { action: 'watch', label: 'Example build', status_file: 'status.json', field: 'stage', terminal: ['complete', 'failed'] };
function setup(t: { after(fn: () => void): void }) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'riftjack-background-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const status = (stage: string) => writeFileSync(join(root, 'status.json'), JSON.stringify({ stage, ignored: 'do not forward private data' }));
  status('building');
  const file = join(root, 'watches.json');
  return { root, file, status, queue: new BackgroundTasks(file, root) };
}
const report = (error: unknown) => { throw error; };

test('watches survive restart and dispatch a terminal result only once to the bound thread', async t => {
  const f = setup(t);
  const first = JSON.parse(f.queue.action(input, target, signal()));
  assert.equal(JSON.parse(f.queue.action(input, target, signal())).id, first.id);
  assert.throws(() => f.queue.action({ ...input, terminal: ['different'] }, target, signal()), /different terminal states/);
  const queue = new BackgroundTasks(f.file, f.root);
  let count = 0;
  const options = { valid: () => true, report,
    deliver: async (destination: BackgroundTarget, message: MatrixEvent, admit: () => void) => {
      admit(); count++;
      assert.equal(destination.session, target.session);
      assert.equal(sessionKey(destination.room, message), target.key);
      assert.match(message.content!.body!, /"status":"failed"/);
      assert.doesNotMatch(message.content!.body!, /private data/);
      return true;
    } };
  await queue.pump(options); assert.equal(count, 0);
  f.status('failed'); await queue.pump(options); await queue.pump(options);
  await new BackgroundTasks(f.file, f.root).pump(options);
  assert.equal(count, 1);
});

test('busy delivery remains pending, while reset or revoked access cancels it', async t => {
  const f = setup(t); f.queue.action(input, target, signal()); f.status('complete');
  await f.queue.pump({ valid: () => true, report, deliver: async () => false });
  assert.match(f.queue.summary(target.key, target.session), /1 waiting/);
  await f.queue.pump({ valid: () => false, report, deliver: async () => assert.fail('Revoked watch must not deliver') });
  assert.equal(JSON.parse(f.queue.action({ action: 'list' }, target, signal()))[0].state, 'cancelled');
});

test('missing or malformed files expire and a crash during delivery is never replayed', async t => {
  const f = setup(t); f.queue.action(input, target, signal());
  writeFileSync(join(f.root, 'status.json'), '{partial');
  await f.queue.pump({ valid: () => true, report, deliver: async () => assert.fail('Partial write is not completion') });
  let recovered: BackgroundTasks | undefined;
  await f.queue.pump({ valid: () => true, report, deliver: async (_t, message, admit) => {
    assert.match(message.content!.body!, /"status":"watch_expired"/);
    admit(); recovered = new BackgroundTasks(f.file, f.root);
    return true;
  } }, Date.now() + 25 * 3_600_000);
  assert.match(recovered!.summary(target.key, target.session), /1 interrupted/);
  await recovered!.pump({ valid: () => true, report, deliver: async () => assert.fail('Uncertain turn must not replay') });
});

test('watch input is scoped, bounded, cancellable, and cannot read outside the workspace', async t => {
  const f = setup(t);
  const other = realpathSync(mkdtempSync(join(tmpdir(), 'outside-watch-')));
  t.after(() => rmSync(other, { recursive: true, force: true }));
  writeFileSync(join(other, 'outside.json'), '{"stage":"complete"}');
  symlinkSync(join(other, 'outside.json'), join(f.root, 'link.json'));
  for (const value of [{ ...input, status_file: join(other, 'outside.json') }, { ...input, status_file: 'link.json' },
    { ...input, room: '!other:test' }, { ...input, terminal: [] }, { ...input, timeout_hours: 0 }]) {
    assert.throws(() => f.queue.action(value, target, signal()));
  }
  const { id } = JSON.parse(f.queue.action(input, target, signal()));
  const otherTarget = { ...target, key: 'another-conversation' };
  assert.equal(f.queue.action({ action: 'list' }, otherTarget, signal()), '[]');
  assert.throws(() => f.queue.action({ action: 'cancel', id }, otherTarget, signal()));
  f.queue.action({ action: 'cancel', id }, target, signal());
  f.status('complete'); await f.queue.pump({ valid: () => true, report, deliver: async () => assert.fail('Cancelled') });
  const controller = new AbortController(); controller.abort();
  assert.throws(() => f.queue.action(input, target, controller.signal));
});

test('a substituted status symlink is revalidated on every poll', async t => {
  const f = setup(t); f.queue.action(input, target, signal());
  const outside = realpathSync(mkdtempSync(join(tmpdir(), 'outside-watch-')));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  writeFileSync(join(outside, 'status.json'), '{"stage":"complete"}');
  rmSync(join(f.root, 'status.json')); symlinkSync(join(outside, 'status.json'), join(f.root, 'status.json'));
  await f.queue.pump({ valid: () => true, report, deliver: async () => assert.fail('Outside file') });
});

for (const kind of ['codex', 'claude'] as const) test(`${kind} resumes only an idle unchanged session, and callbacks expire with the turn`, async t => {
  const f = setup(t), state = new State(join(f.root, 'sessions.json'));
  state.update(target.key, { [kind]: target.session });
  let release!: () => void;
  let entered!: () => void;
  const enteredPromise = new Promise<void>(r => entered = r);
  const wait = new Promise<void>(r => release = r);
  let hooks: BackendHooks | undefined, registered = 0, admitted = 0, turns = 0;
  const replies: string[] = [];
  const bridge = new Bridge({ botId: '@bot:test', kind, since: 0, timeoutMs: 10_000, state,
    isAuthorized: sender => sender === target.sender, isPrivateRoom: async () => true,
    reply: async (_r, _e, text) => { replies.push(text); }, report,
    background: async (_input, context) => { assert.equal(context.key, target.key); registered++; return 'registered'; },
    run: async (_m, _p, key, _s, _u, _a, _i, _pub, callbacks) => {
      turns++; hooks = callbacks; assert.equal(key, target.key); entered(); await wait; return 'Finished.';
    },
  });
  const task = bridge.resumeBackground(target.room, event, target.session, () => admitted++);
  await enteredPromise;
  assert.equal(await bridge.resumeBackground(target.room, { ...event, event_id: '$other' }, target.session, () => admitted++), false);
  await hooks!.progress!('Inspecting saved results.');
  assert.deepEqual(replies, ['Inspecting saved results.']);
  await hooks!.background!({}, signal()); assert.equal(registered, 1);
  release(); assert.equal(await task, true); assert.equal(turns, 1); assert.equal(admitted, 1);
  await assert.rejects(hooks!.background!({}, signal()));
  await assert.rejects(hooks!.progress!('Too late'));
  state.reset(target.key);
  assert.equal(await bridge.resumeBackground(target.room, event, target.session, () => admitted++), false);
});

test('a user turn admitted during the privacy check defers the background turn', async t => {
  const f = setup(t), state = new State(join(f.root, 'sessions.json'));
  state.update(target.key, { codex: target.session });
  let unblock!: () => void, finish!: () => void;
  const privacy = new Promise<void>(r => unblock = r), running = new Promise<void>(r => finish = r);
  let checks = 0, turns = 0;
  const bridge = new Bridge({ botId: '@bot:test', kind: 'codex', since: 0, timeoutMs: 10_000, state,
    isAuthorized: () => true, isPrivateRoom: async () => { if (++checks === 1) await privacy; return true; },
    reply: async () => {}, report, run: async () => { turns++; await running; return 'Done'; } });
  const background = bridge.resumeBackground(target.room, event, target.session, () => assert.fail('Must defer'));
  const user = bridge.handle(target.room, { ...event, event_id: '$human' });
  await new Promise(r => setImmediate(r));
  unblock(); assert.equal(await background, false);
  finish(); await user; assert.equal(turns, 1);
});

test('timers wait until due, survive restart and deliver once as a reminder or a room message', async t => {
  const f = setup(t), posts: string[] = [], reminders: string[] = [];
  const remind = (deliver: string, extra: object) => JSON.parse(f.queue.action({ action: 'remind', label: 'Check', message: 'Line one\nline two', deliver, ...extra }, target, signal()));
  const room = remind('room', { delay_minutes: 5 });
  const agent = remind('agent', { at: new Date(Date.now() + 10 * 60_000).toISOString() });
  const options = { valid: () => true, report,
    post: async (_t: BackgroundTarget, text: string, admit: () => void) => { admit(); posts.push(text); return true; },
    deliver: async (destination: BackgroundTarget, message: MatrixEvent, admit: () => void) => {
      admit(); reminders.push(message.content!.body!);
      assert.equal(sessionKey(destination.room, message), target.key);
      return true;
    } };
  const queue = new BackgroundTasks(f.file, f.root);
  await queue.pump(options);
  assert.deepEqual([posts.length, reminders.length], [0, 0]);
  await queue.pump(options, Date.now() + 6 * 60_000);
  assert.deepEqual(posts, ['Line one\nline two']);
  assert.equal(reminders.length, 0);
  await queue.pump(options, Date.now() + 11 * 60_000);
  await new BackgroundTasks(f.file, f.root).pump(options, Date.now() + 12 * 60_000);
  assert.equal(posts.length, 1); assert.equal(reminders.length, 1);
  assert.match(reminders[0], /not a new human instruction[^]*"label":"Check"/);
  const states = JSON.parse(queue.action({ action: 'list' }, target, signal()));
  assert.deepEqual(states.map((s: { id: string; state: string }) => [s.id, s.state]), [[room.id, 'delivered'], [agent.id, 'delivered']]);
  assert.match(queue.summary(target.key, target.session), /0 timers pending/);
});

test('timer input is bounded, cancellable, and an undeliverable timer is dropped rather than sent late', async t => {
  const f = setup(t);
  const base = { action: 'remind', label: 'Later', message: 'Hello', deliver: 'room' };
  for (const bad of [{ ...base }, { ...base, delay_minutes: 0 }, { ...base, delay_minutes: 10081 }, { ...base, delay_minutes: 5, at: new Date().toISOString() },
    { ...base, at: '2026-10-04 10:00' }, { ...base, at: new Date(Date.now() - 60_000).toISOString() }, { ...base, deliver: 'everyone', delay_minutes: 5 },
    { ...base, message: '', delay_minutes: 5 }, { ...base, delay_minutes: 5, extra: true }]) {
    assert.throws(() => f.queue.action(bad, target, signal()), /Use remind/);
  }
  const cancelled = JSON.parse(f.queue.action({ ...base, delay_minutes: 5 }, target, signal()));
  assert.equal(JSON.parse(f.queue.action({ action: 'cancel', id: cancelled.id }, target, signal())).state, 'cancelled');
  JSON.parse(f.queue.action({ ...base, delay_minutes: 5 }, target, signal()));
  // A busy or private-room refusal keeps it pending; a day later it is dropped.
  await f.queue.pump({ valid: () => true, report, deliver: async () => false, post: async () => false }, Date.now() + 6 * 60_000);
  assert.match(f.queue.summary(target.key, target.session), /1 timers pending/);
  await f.queue.pump({ valid: () => true, report, deliver: async () => false, post: async () => assert.fail('Late timer must not be sent') }, Date.now() + 25 * 3_600_000);
  assert.match(f.queue.summary(target.key, target.session), /0 timers pending/);
});
