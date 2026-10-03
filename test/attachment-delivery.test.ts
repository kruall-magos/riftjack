import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, writeFileSync, rmSync, symlinkSync, linkSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { attachmentDelivery, type SendAttachments } from '../src/attachment-delivery.js';
import { Bridge, type BackendHooks, type MatrixEvent } from '../src/bridge.js';
import { outgoingAttachments, readOutgoing, mediaInstructions } from '../src/media.js';
import { State } from '../src/state.js';

const signal = () => new AbortController().signal;
const input = (...paths: string[]) => ({ files: paths.map(path => ({ path })) });
function fixture(t: { after(fn: () => void): void }) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'attachment-delivery-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const name of ['one.txt', 'two.txt', 'three.txt']) writeFileSync(join(root, name), name);
  return root;
}

test('immediate delivery returns receipts, deduplicates paths, and excludes them from the final reply', async t => {
  const root = fixture(t), sent: string[] = [];
  const delivery = attachmentDelivery(root, 100, async files => { sent.push((await readOutgoing(files[0], 100)).toString()); });
  const first = JSON.parse(await delivery.action(input('one.txt', './one.txt', 'two.txt'), signal()));
  assert.deepEqual(first.files.map((f: any) => f.status), ['sent', 'sent', 'sent']);
  assert.deepEqual(sent, ['one.txt', 'two.txt']);
  writeFileSync(join(root, 'one.txt'), 'changed');
  await delivery.action({ files: [{ path: 'one.txt', name: 'renamed.txt' }] }, signal());
  assert.equal(sent.length, 2);
  assert.deepEqual(delivery.final({ text: 'Done', attachments: outgoingAttachments(input('one.txt', 'three.txt'), root) }),
    { text: 'Done', attachments: outgoingAttachments(input('three.txt'), root) });
});

test('invalid batches do not send a valid first file: limits, traversal, symlinks, hard links and foreign destinations', async t => {
  const root = fixture(t); let count = 0;
  symlinkSync(join(root, 'one.txt'), join(root, 'symlink.txt'));
  linkSync(join(root, 'two.txt'), join(root, 'hardlink.txt'));
  mkdirSync(join(root, 'folder'));
  writeFileSync(join(root, 'large.txt'), 'x'.repeat(101));
  const delivery = attachmentDelivery(root, 100, async () => { count++; });
  for (const bad of [
    ...['../outside.txt', '/absolute.txt', 'symlink.txt', 'hardlink.txt', 'folder', 'large.txt', 'missing.txt'].map(p => input('one.txt', p)),
    input(), input(...Array(11).fill('one.txt')), { ...input('one.txt'), room: '!elsewhere:test' },
    { files: [{ path: 'one.txt', root: '/' }] },
  ]) await assert.rejects(delivery.action(bad, signal()));
  assert.equal(count, 0);
});

test('partial and uncertain delivery is reported without replay; unattempted files can still be sent', async t => {
  const root = fixture(t), attempted: string[] = [];
  const delivery = attachmentDelivery(root, 100, async files => {
    attempted.push(files[0].path);
    if (files[0].path.endsWith('two.txt')) throw new Error('private transport data');
  });
  const result = JSON.parse(await delivery.action(input('one.txt', 'two.txt', 'three.txt'), signal()));
  assert.deepEqual(result.files.map((f: any) => f.status), ['sent', 'uncertain', 'not_sent']);
  assert.doesNotMatch(JSON.stringify(result), /private transport data/);
  const retry = JSON.parse(await delivery.action(input('two.txt', 'three.txt'), signal()));
  assert.deepEqual(retry.files.map((f: any) => f.status), ['uncertain', 'sent']);
  assert.equal(attempted.filter(p => p.endsWith('two.txt')).length, 1);
  assert.deepEqual(delivery.final({ text: '', attachments: outgoingAttachments(input('two.txt'), root) }), { text: '', attachments: [] });
});

test('cancellation stops a batch and concurrent deliveries are rejected', async t => {
  const root = fixture(t), controller = new AbortController();
  let started!: () => void, release!: () => void, calls = 0;
  const ready = new Promise<void>(yes => { started = yes; }), gate = new Promise<void>(yes => { release = yes; });
  const delivery = attachmentDelivery(root, 100, async (_files, callSignal) => { calls++; started(); await gate; callSignal.throwIfAborted(); });
  const work = delivery.action(input('one.txt', 'two.txt'), controller.signal);
  await ready;
  await assert.rejects(delivery.action(input('three.txt'), signal()), /pending/);
  controller.abort(); release();
  assert.deepEqual(JSON.parse(await work).files.map((f: any) => f.status), ['uncertain', 'not_sent']);
  assert.equal(calls, 1);
  await assert.rejects(delivery.action(input('three.txt'), controller.signal));
});

test('Bridge pins immediate attachments to the invoking room/thread, rechecks privacy, and expires the hook', async t => {
  const root = fixture(t), files = outgoingAttachments(input('one.txt'), root);
  let privateRoom = true, allowed = true, saved: SendAttachments | undefined;
  const delivered: { room: string; event: MatrixEvent }[] = [];
  const event: MatrixEvent = { type: 'm.room.message', sender: '@alice:test', event_id: '$request', origin_server_ts: Date.now(),
    content: { msgtype: 'm.text', body: 'Send a file', 'm.relates_to': { rel_type: 'm.thread', event_id: '$thread' } } };
  const bridge = new Bridge({ botId: '@bot:test', kind: 'codex', since: 0, timeoutMs: 5000, state: new State(join(root, 'state.json')),
    isAuthorized: () => allowed, isPrivateRoom: async () => privateRoom, linkedSession: () => 'pinned-home-session',
    reply: async () => {}, report: () => {}, sendAttachments: async (room, event) => { delivered.push({ room, event }); },
    run: async (_mode, _prompt, key, _signal, _sender, _attachments, _interact, _publish, hooks?: BackendHooks) => {
      assert.equal(key, 'pinned-home-session'); saved = hooks!.sendAttachments!;
      await saved(files, signal());
      privateRoom = false;
      await assert.rejects(saved(files, signal()));
      privateRoom = true;
      allowed = false;
      await assert.rejects(saved(files, signal()));
      allowed = true;
      return 'Done';
    },
  });
  await bridge.handle('!shared:test', event);
  assert.deepEqual(delivered, [{ room: '!shared:test', event }]);
  await assert.rejects(saved!(files, signal()));
  assert.equal(delivered.length, 1);
});

test('instructions expose immediate delivery only when its tool is configured', () => {
  assert.doesNotMatch(mediaInstructions('/outbox', 100), /send_attachments/);
  assert.match(mediaInstructions('/outbox', 100, true), /send_attachments/);
});
