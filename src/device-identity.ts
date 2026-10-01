import { readFileSync, writeFileSync, renameSync, lstatSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { SecretStorageKey } from '@matrix-org/matrix-sdk-crypto-nodejs';
import type { MatrixClient } from '@vector-im/matrix-bot-sdk';
import type { RustEngine } from '@vector-im/matrix-bot-sdk/lib/e2ee/RustEngine.js';
import { PublicError } from './errors.js';

type Key = { user_id: string; keys: Record<string, string> };
type Saved = { version: 1; userId: string; recoveryKey: string; keyId: string; keyInfo: object; master: Key; complete: boolean };

function sameKey(a: Key, b: Key): boolean {
  return a.user_id === b.user_id && JSON.stringify(Object.entries(a.keys).sort()) === JSON.stringify(Object.entries(b.keys).sort());
}

function validKey(value: unknown, userId: string): value is Key {
  const key = value as Key | undefined;
  return !!key && key.user_id === userId && !!key.keys && Object.keys(key.keys).length === 1 &&
    Object.entries(key.keys).every(([id, value]) => id.startsWith('ed25519:') && typeof value === 'string' && !!value);
}

// Uses the Rust engine already opened by the pinned Matrix SDK. Never opens a second
// OlmMachine on a live database. bootstrap(false) reuses keys across interrupted uploads.
export async function ensureDeviceIdentity(client: MatrixClient, userId: string, file: string): Promise<void> {
  const engine = (client.crypto as unknown as { engine?: RustEngine }).engine;
  if (!client.crypto.isReady || !engine?.machine?.bootstrapCrossSigning) throw new PublicError('Device verification requires the supported Matrix crypto engine to be ready.');
  const machine = engine.machine;
  let saved: Saved | undefined;
  try {
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o077)) throw new PublicError('Device recovery file must be a private regular file (mode 600).');
    saved = JSON.parse(readFileSync(file, 'utf8'));
    if (!saved || saved.version !== 1 || saved.userId !== userId || typeof saved.recoveryKey !== 'string' ||
      typeof saved.keyId !== 'string' || typeof saved.complete !== 'boolean' || !validKey(saved.master, userId)) {
      throw new PublicError('Invalid device recovery file; existing identity was not reset.');
    }
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const save = () => {
    const temp = `${file}.${randomUUID()}.tmp`;
    writeFileSync(temp, JSON.stringify(saved), { mode: 0o600, flag: 'wx' });
    try { renameSync(temp, file); } finally { try { unlinkSync(temp); } catch {} }
  };
  const defaultKey = async (): Promise<string | undefined> => {
    try {
      const value = await client.getAccountData<{ key?: unknown }>('m.secret_storage.default_key');
      if (typeof value?.key !== 'string' || !value.key) throw new PublicError('Unrecognized secret storage configuration; it was not changed.');
      return value.key;
    } catch (error) {
      if ((error as { errcode?: string }).errcode === 'M_NOT_FOUND') return;
      throw error;
    }
  };

  const query = await client.doRequest('POST', '/_matrix/client/v3/keys/query', null, { device_keys: { [userId]: [] } });
  if (!query || typeof query !== 'object' || !query.device_keys || Object.keys(query.failures || {}).length) {
    throw new PublicError('Could not reliably read existing cross-signing keys; identity was not changed.');
  }
  const master: unknown = query.master_keys?.[userId];
  if (master !== undefined && !validKey(master, userId)) throw new PublicError('Unrecognized existing identity; refusing to replace it.');
  if (master && saved && !sameKey(master as Key, saved.master)) throw new PublicError('The server identity differs from the saved bot identity. Restore the matching recovery keys; no identity reset was attempted.');

  const refresh = async () => {
    await engine.processOutgoingRequests([machine.queryKeysForUsers([machine.userId])]);
    return (await machine.getDevice(machine.userId, machine.deviceId))?.isCrossSignedByOwner() === true;
  };
  // Load the server's device record before bootstrapping so Rust can sign it too.
  const signed = await refresh();
  if (master && signed && (!saved || saved.complete)) return;
  if (master && !saved) throw new PublicError('This bot already has a cross-signing identity, but its recovery key is not managed by this connector. Recover its existing identity; it was not reset.');

  const currentDefault = await defaultKey();
  if (currentDefault && currentDefault !== saved?.keyId) throw new PublicError('This bot has different secret storage keys. Existing recovery settings were not overwritten.');
  if (master) {
    const status = await machine.crossSigningStatus();
    if (!status.hasMaster || !status.hasSelfSigning || !status.hasUserSigning) {
      // Recover a replacement local device without replacing the account's identity.
      await client.crypto.confirmIdentityWithRecoveryKey(saved!.recoveryKey);
      if (!(await refresh())) throw new PublicError('Recovered keys did not verify the current bot device.');
      saved!.complete = true; save();
      return;
    }
  }
  const requests = await machine.bootstrapCrossSigning(false);
  const signing = JSON.parse(requests.uploadSigningKeysReq);
  if (!validKey(signing.master_key, userId) || (saved && !sameKey(signing.master_key, saved.master)) ||
    (master && !sameKey(signing.master_key, master as Key))) {
    throw new PublicError('Local signing keys do not match the saved/server identity. No replacement identity was uploaded.');
  }
  let recovery: SecretStorageKey;
  if (saved) {
    recovery = SecretStorageKey.fromAccountData(saved.recoveryKey, 'm.secret_storage.key.' + saved.keyId, JSON.stringify(saved.keyInfo));
  } else {
    recovery = SecretStorageKey.createRandomKey();
    saved = { version: 1, userId, recoveryKey: recovery.toBase58(), keyId: recovery.keyId(),
      keyInfo: JSON.parse(recovery.accountDataContent()), master: signing.master_key, complete: false };
    // Persist the recovery key and pinned master BEFORE publishing anything.
    save();
  }
  if (requests.uploadKeysReq) await engine.processOutgoingRequests([requests.uploadKeysReq]);
  if (!master) await client.doRequest('POST', '/_matrix/client/v3/keys/device_signing/upload', null, signing);
  await engine.processOutgoingRequests([requests.uploadSignaturesReq]);
  const secrets = await machine.exportSecretsForSecretStorage(recovery);
  await client.setAccountData(recovery.eventType(), saved.keyInfo);
  await client.setAccountData('m.cross_signing.master', JSON.parse(secrets.masterKey));
  await client.setAccountData('m.cross_signing.self_signing', JSON.parse(secrets.selfSigningKey));
  await client.setAccountData('m.cross_signing.user_signing', JSON.parse(secrets.userSigningKey));
  // Expose the default recovery key only after its encrypted secrets are available.
  await client.setAccountData('m.secret_storage.default_key', { key: saved.keyId });
  if (!(await refresh())) throw new PublicError('Cross-signing was uploaded but the current device is not yet verified. The next startup will retry with the same keys.');
  saved.complete = true; save();
}
