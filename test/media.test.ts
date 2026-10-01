import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync, symlinkSync, linkSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Attachment, EncryptedAttachment } from '@matrix-org/matrix-sdk-crypto-nodejs';
import type { EncryptedFile } from '@vector-im/matrix-bot-sdk';
import { MatrixMedia, mediaDirectory, mediaInstructions, outboxDirectory, parseMediaReply, readOutgoing, readLimited, safeName } from '../src/media.js';
import { loadConfig } from '../src/config.js';

const signal = () => new AbortController().signal;
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');

function setup(t: { after(fn: () => void): void }, maxBytes = 1024) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'matrix-media-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const uploads: Buffer[] = [], messages: Record<string, any>[] = [];
  let download: Buffer = Buffer.alloc(0);
  let fetches = 0;
  const media = new MatrixMedia({
    mxcToHttp: async () => 'https://matrix.test/_matrix/client/v1/media/download/matrix.test/id',
    uploadContent: async (data, type, name) => {
      assert.equal(type, 'application/octet-stream'); assert.equal(name, undefined);
      uploads.push(data); return 'mxc://matrix.test/id';
    },
    sendMessage: async (room, content) => { assert.equal(room, '!dm:test'); messages.push(content); return '$sent'; },
  }, { workspace: dir, homeserver: 'https://matrix.test', accessToken: 'test-token', maxBytes, scope: '@bot:test' }, async (_url, options) => {
    fetches++;
    assert.equal(options?.redirect, 'error');
    assert.equal((options?.headers as Record<string, string>).Authorization, 'Bearer test-token');
    return new Response(new Uint8Array(download));
  });
  function encrypted(data: Buffer): EncryptedFile {
    const result = Attachment.encrypt(data);
    download = Buffer.from(result.encryptedData);
    return { ...JSON.parse(result.mediaEncryptionInfo!), url: 'mxc://matrix.test/id' };
  }
  return { dir, media, uploads, messages, encrypted, fetches: () => fetches,
    corrupt: () => { download[0] ^= 1; } };
}

test('image, audio and document replies upload ciphertext and retain reply/thread relations', async t => {
  const f = setup(t);
  const root = await mediaDirectory(f.dir, 'outgoing', 'conversation');
  const relation = { rel_type: 'm.thread', event_id: '$root', 'm.in_reply_to': { event_id: '$prompt' } };
  for (const [name, data, msgtype, mimetype] of [
    ['picture.png', png, 'm.image', 'image/png'],
    ['sound.wav', Buffer.from('RIFF sound data'), 'm.audio', 'audio/wav'],
    ['report.pdf', Buffer.from('%PDF-1.4 example'), 'm.file', 'application/pdf'],
  ] as const) {
    const path = join(root, name); writeFileSync(path, data);
    await f.media.send('!dm:test', [{ root, path }], relation, signal(), async () => {});
    const message = f.messages.at(-1)!;
    assert.equal(message.msgtype, msgtype);
    assert.equal(message.info.mimetype, mimetype);
    assert.equal(message.info.size, data.length);
    assert.deepEqual(message['m.relates_to'], relation);
    assert.equal(message.url, undefined);
    assert.notDeepEqual(f.uploads.at(-1), data);
    const decrypted = Attachment.decrypt(new EncryptedAttachment(f.uploads.at(-1)!, JSON.stringify(message.file)));
    assert.deepEqual(Buffer.from(decrypted), data);
  }
});

test('incoming encrypted image round-trips, preserves bytes and is stored privately', async t => {
  const f = setup(t);
  const file = f.encrypted(png);
  const received = await f.media.receive({ msgtype: 'm.image', filename: '../../AGENTS.md', body: 'Describe this', file }, 'conversation', signal());
  assert.equal(received.name, 'AGENTS.md');
  assert.ok(received.path.endsWith('/attachment-AGENTS.md'));
  assert.equal(received.image, true);
  assert.equal(received.mimetype, 'image/png');
  assert.deepEqual(readFileSync(received.path), png);
  assert.equal(statSync(received.path).mode & 0o777, 0o600);
  const second = await f.media.receive({ msgtype: 'm.file', file, body: 'AGENTS.md' }, 'different conversation', signal());
  assert.notEqual(second.path, received.path);
});

test('incoming audio remains a local attachment and retains its declared audio type', async t => {
  const f = setup(t);
  const data = Buffer.from('voice recording');
  const received = await f.media.receive({ msgtype: 'm.audio', body: 'Voice message', file: f.encrypted(data), info: { mimetype: 'audio/ogg' } }, 'conversation', signal());
  assert.equal(received.image, false); assert.equal(received.mimetype, 'audio/ogg');
  assert.deepEqual(readFileSync(received.path), data);
});

test('tampering, plaintext attachments, unsafe URLs and excessive declared sizes fail', async t => {
  const f = setup(t);
  const file = f.encrypted(png); f.corrupt();
  await assert.rejects(f.media.receive({ file }, 'key', signal()), /decrypt or verify/);
  await assert.rejects(f.media.receive({ url: 'https://example.test/file' }, 'key', signal()), /file encryption/);
  await assert.rejects(f.media.receive({ file: { ...file, url: 'https://example.test/file' } }, 'key', signal()), /media URL/);
  await assert.rejects(f.media.receive({ file, info: { size: 1025 } }, 'key', signal()), /limit/);
  assert.equal(f.fetches(), 1);
});

test('actual download size is bounded even with absent or false size metadata', async t => {
  const f = setup(t, 4);
  const file = f.encrypted(Buffer.from('oversized'));
  await assert.rejects(f.media.receive({ file, info: { size: 1 } }, 'key', signal()), /limit/);
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new Uint8Array(3)); controller.enqueue(new Uint8Array(3)); },
    cancel() { cancelled = true; },
  });
  await assert.rejects(readLimited(new Response(body), 4, signal()), /limit/);
  assert.equal(cancelled, true);
});

test('cancelling a pending download releases the stream and sends no attachment', async t => {
  const f = setup(t);
  const abort = new AbortController();
  const pending = readLimited(new Response(new ReadableStream()), 10, abort.signal);
  abort.abort();
  await assert.rejects(pending, /abort/i);
  await assert.rejects(f.media.send('!dm:test', [{ path: '/unused', root: '/unused' }], {}, abort.signal, async () => {}), /abort/i);
  assert.equal(f.uploads.length, 0);
});

test('authorization is checked again after upload before delivering encryption keys', async t => {
  const f = setup(t);
  const root = await mediaDirectory(f.dir, 'outgoing', 'key');
  const path = join(root, 'hello.txt'); writeFileSync(path, 'hello');
  let checks = 0;
  await assert.rejects(f.media.send('!dm:test', [{ path, root }], {}, signal(), async () => {
    if (++checks === 3) throw new Error('Access revoked');
  }), /Access revoked/);
  assert.equal(f.uploads.length, 1); assert.equal(f.messages.length, 0);
});

test('cancellation while rechecking authorization prevents attachment delivery', async t => {
  const f = setup(t);
  const root = await mediaDirectory(f.dir, 'outgoing', 'key');
  const path = join(root, 'hello.txt'); writeFileSync(path, 'hello');
  const controller = new AbortController();
  let checks = 0;
  await assert.rejects(f.media.send('!dm:test', [{ path, root }], {}, controller.signal, async () => {
    if (++checks === 3) controller.abort();
  }), /abort/i);
  assert.equal(f.messages.length, 0);
});

test('Unicode filenames fit the filesystem byte limit and cannot contain path separators', () => {
  const name = safeName('../' + '😀'.repeat(200) + '.png');
  assert.ok(Buffer.byteLength(name) <= 200);
  assert.ok(!name.includes('/'));
  assert.equal(safeName('..\\folder\\report.txt'), 'report.txt');
});

test('only explicit manifests create attachments; ordinary paths stay text', () => {
  const root = '/workspace/outbox';
  assert.equal(parseMediaReply('See [file](/tmp/file.txt)', root), 'See [file](/tmp/file.txt)');
  assert.deepEqual(parseMediaReply('Here you go.\n```matrix-attachments\n{"files":[{"path":"hello.txt"}]}\n```', root), {
    text: 'Here you go.', attachments: [{ root, path: root + '/hello.txt', name: undefined }],
  });
  for (const path of ['../secret', '/etc/passwd', '..']) {
    assert.throws(() => parseMediaReply('```matrix-attachments\n' + JSON.stringify({ files: [{ path }] }) + '\n```', root));
  }
  assert.throws(() => parseMediaReply('```matrix-attachments\nnot JSON\n```', root), /invalid/);
  assert.throws(() => parseMediaReply('```matrix-attachments\n' + JSON.stringify({ files: Array(11).fill({ path: 'a' }) }) + '\n```', root), /at most 10/);
});

test('each conversation has one stable outbox that is emptied at the start of every turn', async t => {
  const f = setup(t);
  const first = await outboxDirectory(f.dir, 'conversation');
  writeFileSync(join(first, 'old.txt'), 'previous turn');
  const second = await outboxDirectory(f.dir, 'conversation');
  assert.equal(second, first);
  assert.deepEqual(readdirSync(second), []);
  assert.notEqual(await outboxDirectory(f.dir, 'other conversation'), first);
  assert.match(mediaInstructions(first, 1024), new RegExp(`outbox: ${JSON.stringify(first).replace(/[\\^$.*+?()[\]{}|/]/g, '\\$&')}`));
  assert.doesNotMatch(mediaInstructions(first, 1024), /User message follows/);
});

test('outbox refuses symlinks, hard links, directories, traversal and oversized files', async t => {
  const f = setup(t);
  const root = await mediaDirectory(f.dir, 'outgoing', 'key');
  const secret = join(f.dir, 'secret'); writeFileSync(secret, 'secret');
  symlinkSync(secret, join(root, 'symlink'));
  linkSync(secret, join(root, 'hardlink'));
  writeFileSync(join(root, 'big'), Buffer.alloc(11));
  for (const path of [secret, join(root, 'symlink'), join(root, 'hardlink'), root, join(root, 'big')]) {
    await assert.rejects(readOutgoing({ root, path }, 10));
  }
  const path = join(root, 'ok'); writeFileSync(path, '12345');
  assert.equal((await readOutgoing({ root, path }, 5)).toString(), '12345');
});

test('media root symlinks cannot redirect incoming or outgoing files', async t => {
  const f = setup(t);
  symlinkSync(tmpdir(), join(f.dir, '.matrix-media'));
  await assert.rejects(mediaDirectory(f.dir, 'incoming', 'key'), /symlinks/);
});

test('attachment size configuration is bounded', async t => {
  const f = setup(t);
  const env = { MATRIX_HOMESERVER: 'https://matrix.test', MATRIX_OWNER_ID: '@owner:test', RIFTJACK_WORKSPACE: f.dir };
  assert.equal(loadConfig(env).maxMediaBytes, 20 * 1024 * 1024);
  for (const value of ['-1', '0', 'NaN', '1.5', '104857601']) {
    assert.throws(() => loadConfig({ ...env, MAX_MEDIA_BYTES: value }), /MAX_MEDIA_BYTES/);
  }
});
