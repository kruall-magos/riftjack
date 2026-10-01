import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Accounts, parseManagerRequest, provision, PublicError } from '../src/accounts.js';
import { loadConfig } from '../src/config.js';
import type { Mode } from '../src/bridge.js';

const config = () => loadConfig({
  MATRIX_HOMESERVER: 'https://matrix.example', MATRIX_OWNER_ID: '@owner:example',
  RIFTJACK_WORKSPACE: process.cwd(), SYNAPSE_ADMIN_TOKEN: 'test-admin',
});

test('manager recognizes creation and listing phrases', () => {
  for (const phrase of ['create another Codex bot named Research', 'Can you please make me a new Codex bot called Research?']) {
    assert.deepEqual(parseManagerRequest(phrase), { action: 'create', kind: 'codex', name: 'Research' });
  }
  assert.deepEqual(parseManagerRequest('create one more codex bot'), { action: 'create', kind: 'codex', name: 'Codex' });
  assert.deepEqual(parseManagerRequest('create a Claude bot called Research'), { action: 'create', kind: 'claude', name: 'Research' });
  assert.deepEqual(parseManagerRequest('create another Claude Code bot'), { action: 'create', kind: 'claude', name: 'Claude' });
  assert.deepEqual(parseManagerRequest('list bots'), { action: 'list' });
  assert.equal(parseManagerRequest('create an admin bot'), null);
  assert.equal(parseManagerRequest('delete all bots'), null);
  assert.equal(parseManagerRequest('create another GPT bot named Research'), null);
  assert.equal(parseManagerRequest('create a codex bot named $(rm -rf /)'), null);
});

test('removed GPT kind cannot be provisioned even through an untyped caller', async () => {
  await assert.rejects(provision(config(), 'gpt' as Mode, 'Chat', undefined,
    (async () => { throw new Error('must not call'); }) as typeof fetch), /supported/);
});

test('Synapse admin provisioning creates a non-admin and obtains a device login', async () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fake = (async (url, init) => {
    calls.push({ url: String(url), init });
    if (String(url).endsWith('/whoami')) return Response.json({ user_id: '@admin:example' });
    if (init?.method === 'GET') return Response.json({}, { status: 404 });
    if (init?.method === 'PUT') return Response.json({}, { status: 201 });
    return Response.json({ user_id: '@new:example', access_token: 'bot-token', device_id: 'DEVICE' });
  }) as typeof fetch;
  const account = await provision(config(), 'codex', 'Builder', undefined, fake);
  assert.equal(account.kind, 'codex'); assert.equal(account.accessToken, 'bot-token');
  const create = calls.find(c => c.init?.method === 'PUT')!;
  assert.equal(JSON.parse(String(create.init!.body)).admin, false);
  assert.match(create.url, /bot_codex_builder_/);
  const login = JSON.parse(String(calls.at(-1)!.init!.body));
  assert.equal(login.type, 'm.login.password');
  assert.ok(login.initial_device_display_name);
  assert.ok(calls.every(c => c.init?.redirect === 'error'));
});

test('existing accounts are never overwritten', async () => {
  let writes = 0;
  const fake = (async (url, init) => {
    if (init?.method !== 'GET') writes++;
    return Response.json(String(url).endsWith('/whoami') ? { user_id: '@admin:example' } : { name: 'existing' });
  }) as typeof fetch;
  await assert.rejects(provision(config(), 'codex', 'Chat', undefined, fake), /already exists/);
  assert.equal(writes, 0);
});

test('SSH admin endpoint is used only for administrative requests', async () => {
  const c = { ...config(), adminUrl: 'http://127.0.0.1:18008' };
  const urls: string[] = [];
  const fake = (async (url, init) => {
    urls.push(String(url));
    if (String(url).endsWith('/whoami')) return Response.json({ user_id: '@admin:example' });
    if (init?.method === 'GET') return Response.json({}, { status: 404 });
    if (init?.method === 'PUT') return Response.json({}, { status: 201 });
    return Response.json({ user_id: '@bot:example', access_token: 'bot-token', device_id: 'DEVICE' });
  }) as typeof fetch;
  await provision(c, 'codex', 'Builder', undefined, fake);
  assert.ok(urls.filter(url => url.includes('/_synapse/admin/')).every(url => url.startsWith(c.adminUrl)));
  assert.ok(urls.filter(url => url.includes('/_matrix/client/')).every(url => url.startsWith(c.homeserver)));
});

test('empty admin proxy responses stop provisioning before account creation', async () => {
  let writes = 0;
  const fake = (async (url, init) => {
    if (init?.method !== 'GET') writes++;
    if (String(url).endsWith('/whoami')) return Response.json({ user_id: '@admin:example' });
    return new Response(null, { status: 200 });
  }) as typeof fetch;
  await assert.rejects(provision(config(), 'codex', 'Builder', undefined, fake), /Synapse Admin API.*reverse proxy routing/);
  assert.equal(writes, 0);
});

test('admin network errors include the failing step, cause and tunnel hint without secrets', async () => {
  const c = { ...config(), adminUrl: 'http://127.0.0.1:18008/private-path' };
  let writes = 0;
  const fake = (async (url, init) => {
    if (init?.method !== 'GET') writes++;
    if (String(url).endsWith('/whoami')) return Response.json({ user_id: '@admin:example' });
    throw new TypeError('test-admin secret-password', {
      cause: new AggregateError([Object.assign(new Error('secret-token'), { code: 'ECONNREFUSED' })]),
    });
  }) as typeof fetch;
  await assert.rejects(provision(c, 'codex', 'Builder', undefined, fake), error => {
    assert.ok(error instanceof PublicError);
    assert.match(error.message, /check account availability.*Synapse Admin API.*127.0.0.1:18008.*ECONNREFUSED.*SSH tunnel/);
    assert.doesNotMatch(error.message, /test-admin|secret|private-path|may already exist/);
    return true;
  });
  assert.equal(writes, 0);
});

test('public client DNS failure identifies the client endpoint without blaming the SSH tunnel', async () => {
  const fake = (async () => { throw new TypeError('private', { cause: { code: 'ENOTFOUND' } }); }) as typeof fetch;
  await assert.rejects(provision(config(), 'codex', 'Builder', undefined, fake), error => {
    assert.ok(error instanceof PublicError);
    assert.match(error.message, /verify admin identity.*Matrix Client API.*ENOTFOUND.*DNS/);
    assert.doesNotMatch(error.message, /SSH tunnel|private/);
    return true;
  });
});

test('HTTP failures expose status and known Matrix code, never server error text', async () => {
  const fake = (async () => Response.json({ errcode: 'M_FORBIDDEN', error: 'test-admin secret-password' }, { status: 403 })) as typeof fetch;
  await assert.rejects(provision(config(), 'codex', 'Builder', undefined, fake), error => {
    assert.ok(error instanceof PublicError);
    assert.match(error.message, /verify admin identity.*HTTP 403, M_FORBIDDEN.*credentials/);
    assert.doesNotMatch(error.message, /test-admin|secret-password/);
    return true;
  });
});

test('login failure warns about the already-created account without exposing the generated password', async () => {
  let password = '';
  const fake = (async (url, init) => {
    if (String(url).endsWith('/whoami')) return Response.json({ user_id: '@admin:example' });
    if (init?.method === 'GET') return Response.json({}, { status: 404 });
    if (init?.method === 'PUT') {
      password = JSON.parse(String(init.body)).password;
      return Response.json({}, { status: 201 });
    }
    return Response.json({ errcode: 'M_FORBIDDEN', error: password }, { status: 403 });
  }) as typeof fetch;
  await assert.rejects(provision(config(), 'codex', 'Builder', undefined, fake), error => {
    assert.ok(error instanceof PublicError);
    assert.match(error.message, /log in new bot.*HTTP 403.*may already exist.*not saved/);
    assert.ok(password && !error.message.includes(password));
    return true;
  });
});

test('registration timeout reports its step and warns about uncertain account creation', async () => {
  const fake = (async (_url, init) => {
    if (init?.method === 'GET') return Response.json({ nonce: 'abc' });
    throw new DOMException('private', 'TimeoutError');
  }) as typeof fetch;
  await assert.rejects(provision({ ...config(), registrationSecret: 'secret' }, 'codex', 'Builder', undefined, fake),
    /register account.*TimeoutError.*timed out.*may already exist/);
});

test('cancellation remains cancellation instead of becoming a connection failure', async () => {
  const controller = new AbortController();
  const fake = (async () => { controller.abort(); throw controller.signal.reason; }) as typeof fetch;
  await assert.rejects(provision(config(), 'codex', 'Builder', controller.signal, fake), error => error === controller.signal.reason);
});

test('connection loss while reading JSON is diagnosed separately from invalid JSON', async () => {
  const fake = (async () => {
    const response = Response.json({});
    response.json = async () => { throw new TypeError('private', { cause: { code: 'ECONNRESET' } }); };
    return response;
  }) as typeof fetch;
  await assert.rejects(provision(config(), 'codex', 'Builder', undefined, fake), /verify admin identity.*Response could not be read.*ECONNRESET/);
});

test('shared-secret provisioning signs a non-admin registration', async () => {
  const c = { ...config(), registrationSecret: 'test-secret' };
  const fake = (async (_url, init) => {
    if (init?.method === 'GET') return Response.json({ nonce: 'abc' });
    const body = JSON.parse(String(init?.body));
    assert.equal(body.admin, false);
    assert.equal(body.mac, createHmac('sha1', 'test-secret').update(['abc', body.username, body.password, 'notadmin'].join('\0')).digest('hex'));
    return Response.json({ user_id: '@new:example', access_token: 'bot-token', device_id: 'DEVICE' });
  }) as typeof fetch;
  assert.equal((await provision(c, 'codex', 'Chat', undefined, fake)).kind, 'codex');
});

test('missing provisioning credentials fail without network requests', async () => {
  await assert.rejects(provision({ ...config(), adminToken: undefined }, 'codex', 'Chat', undefined,
    (async () => { throw new Error('must not call'); }) as typeof fetch), /not configured/);
});

test('bot credentials and DM locations survive restart with private permissions', t => {
  const dir = mkdtempSync(join(tmpdir(), 'matrix-accounts-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'accounts.json');
  const accounts = new Accounts(file);
  accounts.add({ userId: '@bot:example', accessToken: 'secret', kind: 'codex', name: 'Chat' });
  accounts.add({ userId: '@claude:example', accessToken: 'claude-secret', kind: 'claude', name: 'Claude' });
  accounts.setRoom('@bot:example', '!dm:example');
  assert.equal(new Accounts(file).list()[0].roomId, '!dm:example');
  assert.equal(new Accounts(file).list()[1].kind, 'claude');
  assert.equal(statSync(file).mode & 0o777, 0o600);
});

test('configuration rejects insecure homeservers and unrestricted Codex sandboxes', () => {
  const env = { MATRIX_HOMESERVER: 'https://matrix.example', MATRIX_OWNER_ID: '@owner:example', RIFTJACK_WORKSPACE: process.cwd() };
  assert.throws(() => loadConfig({ ...env, MATRIX_HOMESERVER: 'http://matrix.example' }), /HTTPS/);
  assert.throws(() => loadConfig({ ...env, CODEX_SANDBOX: 'danger-full-access' }), /CODEX_SANDBOX/);
  assert.throws(() => loadConfig({ ...env, SYNAPSE_ADMIN_URL: 'http://matrix.example' }), /SYNAPSE_ADMIN_URL/);
  assert.equal(loadConfig({ ...env, SYNAPSE_ADMIN_URL: 'http://127.0.0.1:18008' }).adminUrl, 'http://127.0.0.1:18008');
});


test('task timeout defaults to 24 hours and validates the supported range', () => {
  const env = { MATRIX_HOMESERVER: 'https://matrix.example', MATRIX_OWNER_ID: '@owner:example', RIFTJACK_WORKSPACE: process.cwd() };
  assert.equal(loadConfig(env).timeoutMs, 86_400_000);
  for (const seconds of ['1', '600', '86400']) {
    assert.equal(loadConfig({ ...env, TASK_TIMEOUT_SECONDS: seconds }).timeoutMs, Number(seconds) * 1000);
  }
  for (const seconds of ['0', '-1', '86401', 'Infinity', 'invalid']) {
    assert.throws(() => loadConfig({ ...env, TASK_TIMEOUT_SECONDS: seconds }), /TASK_TIMEOUT_SECONDS/);
  }
});
