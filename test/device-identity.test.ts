import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MatrixClient, SimpleFsStorageProvider, RustSdkCryptoStorageProvider, LogService, LogLevel } from '@vector-im/matrix-bot-sdk';
import { StoreType, OlmMachine, UserId, DeviceId, SecretStorageKey } from '@matrix-org/matrix-sdk-crypto-nodejs';
import { RustEngine } from '@vector-im/matrix-bot-sdk/lib/e2ee/RustEngine.js';
import { ensureDeviceIdentity } from '../src/device-identity.js';

LogService.setLevel(LogLevel.ERROR);
const user = '@bot:example.org';
type Json = Record<string, any>;
function fixture(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(join(tmpdir(), 'matrix-identity-'));
  const devices: Json = {};
  const keys: Json = {};
  const accountData = new Map<string, object>();
  const uploads: Json[] = [];
  const machines: OlmMachine[] = [];
  let failSigning = false;
  let failSecrets = false;
  t.after(() => { machines.forEach(machine => machine.close()); rmSync(dir, { recursive: true, force: true }); });
  const makeClient = async (device: string) => {
    const client = new MatrixClient('https://matrix.example.org', 'mock-token',
      new SimpleFsStorageProvider(join(dir, device + '.json')),
      new RustSdkCryptoStorageProvider(join(dir, device), StoreType.Sqlite));
    client.getWhoAmI = async () => ({ user_id: user, device_id: device });
    client.doRequest = (async (_method: string, endpoint: string, _query: unknown, body: Json) => {
      if (endpoint.endsWith('/keys/upload')) {
        if (body.device_keys) devices[body.device_keys.device_id] = body.device_keys;
        return { one_time_key_counts: { signed_curve25519: 50 } };
      }
      if (endpoint.endsWith('/keys/query')) return {
        device_keys: { [user]: devices }, master_keys: keys.master_key ? { [user]: keys.master_key } : {},
        self_signing_keys: keys.self_signing_key ? { [user]: keys.self_signing_key } : {},
        user_signing_keys: keys.user_signing_key ? { [user]: keys.user_signing_key } : {}, failures: {},
      };
      if (endpoint.endsWith('/keys/device_signing/upload')) {
        assert.ok(existsSync(join(dir, 'recovery.json')), 'recovery must be saved before identity publication');
        uploads.push(structuredClone(body));
        if (failSigning) throw { statusCode: 401, errcode: 'M_UNAUTHORIZED' };
        Object.assign(keys, structuredClone(body));
        return {};
      }
      if (endpoint.endsWith('/keys/signatures/upload')) {
        for (const [id, value] of Object.entries(body[user] || {})) {
          const target = devices[id] || (keys.master_key?.keys['ed25519:' + id] ? keys.master_key : undefined);
          if (target) {
            for (const [signer, signatures] of Object.entries((value as Json).signatures || {})) {
              target.signatures[signer] = { ...target.signatures[signer], ...(signatures as Json) };
            }
          }
        }
        return { failures: {} };
      }
      throw new Error('Unexpected API endpoint: ' + endpoint);
    }) as typeof client.doRequest;
    client.getAccountData = (async (type: string) => {
      if (!accountData.has(type)) throw { errcode: 'M_NOT_FOUND', statusCode: 404 };
      return structuredClone(accountData.get(type));
    }) as typeof client.getAccountData;
    client.setAccountData = async (type: string, content: object) => {
      if (failSecrets && type === 'm.cross_signing.self_signing') throw new Error('connection lost');
      accountData.set(type, structuredClone(content));
    };
    // Real native crypto in memory avoids SQLite background tasks during test teardown.
    const machine = await OlmMachine.initialize(new UserId(user), new DeviceId(device));
    const engine = new RustEngine(machine, client);
    Object.assign(client.crypto, { engine, ready: true });
    await engine.run();
    machines.push(machine);
    return client;
  };
  return { dir, file: join(dir, 'recovery.json'), keys, devices, accountData, uploads, makeClient,
    failSigning: (value: boolean) => { failSigning = value; }, failSecrets: (value: boolean) => { failSecrets = value; } };
}

test('real Rust crypto signs the bot device and saves usable recovery secrets without rotating on restart', async t => {
  const f = fixture(t);
  const client = await f.makeClient('FIRST');
  await ensureDeviceIdentity(client, user, f.file);
  const saved = JSON.parse(readFileSync(f.file, 'utf8'));
  assert.equal(saved.complete, true);
  assert.equal(statSync(f.file).mode & 0o777, 0o600);
  assert.ok(f.devices.FIRST.signatures[user][Object.keys(f.keys.self_signing_key.keys)[0]]);
  const recovery = SecretStorageKey.fromAccountData(saved.recoveryKey, 'm.secret_storage.key.' + saved.keyId, JSON.stringify(saved.keyInfo));
  assert.ok(recovery.decrypt(JSON.stringify(f.accountData.get('m.cross_signing.master')), 'm.cross_signing.master'));
  await ensureDeviceIdentity(client, user, f.file);
  assert.equal(f.uploads.length, 1);
  assert.equal(readFileSync(f.file, 'utf8'), JSON.stringify(saved));
});

test('interrupted initial signing upload retries the same identity and recovery key', async t => {
  const f = fixture(t);
  const client = await f.makeClient('FIRST');
  f.failSigning(true);
  await assert.rejects(ensureDeviceIdentity(client, user, f.file));
  const before = JSON.parse(readFileSync(f.file, 'utf8'));
  f.failSigning(false);
  await ensureDeviceIdentity(client, user, f.file);
  assert.deepEqual(f.uploads[0].master_key.keys, f.uploads[1].master_key.keys);
  assert.equal(JSON.parse(readFileSync(f.file, 'utf8')).recoveryKey, before.recoveryKey);
});

test('partial secret storage upload resumes without resetting published keys', async t => {
  const f = fixture(t);
  const client = await f.makeClient('FIRST');
  f.failSecrets(true);
  await assert.rejects(ensureDeviceIdentity(client, user, f.file), /connection lost/);
  assert.equal(JSON.parse(readFileSync(f.file, 'utf8')).complete, false);
  f.failSecrets(false);
  await ensureDeviceIdentity(client, user, f.file);
  assert.equal(f.uploads.length, 1);
  assert.equal(JSON.parse(readFileSync(f.file, 'utf8')).complete, true);
});

test('replacement device can recover its existing identity using local recovery material', async t => {
  const f = fixture(t);
  const first = await f.makeClient('FIRST');
  await ensureDeviceIdentity(first, user, f.file);
  const second = await f.makeClient('SECOND');
  await ensureDeviceIdentity(second, user, f.file);
  assert.ok(f.devices.SECOND.signatures[user][Object.keys(f.keys.self_signing_key.keys)[0]]);
  assert.equal(f.uploads.length, 1);
});

test('external identity and recovery configuration are never silently replaced', async t => {
  const f = fixture(t);
  const first = await f.makeClient('FIRST');
  await ensureDeviceIdentity(first, user, f.file);
  const second = await f.makeClient('SECOND');
  await assert.rejects(ensureDeviceIdentity(second, user, join(f.dir, 'missing.json')), /already has a cross-signing identity/);
  f.keys.master_key = { user_id: user, keys: { 'ed25519:different': 'different' } };
  await assert.rejects(ensureDeviceIdentity(first, user, f.file), /differs from the saved/);
  assert.equal(f.uploads.length, 1);
});

test('existing secret storage blocks automatic bootstrap before any identity upload', async t => {
  const f = fixture(t);
  const client = await f.makeClient('FIRST');
  f.accountData.set('m.secret_storage.default_key', { key: 'external' });
  await assert.rejects(ensureDeviceIdentity(client, user, f.file), /not overwritten/);
  assert.equal(f.uploads.length, 0);
  assert.equal(existsSync(f.file), false);
});
